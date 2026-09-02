/**
 * The in-memory book of open box positions.
 *
 * Two jobs:
 *
 *  1. Keep the open positions out of the hot path. The monitor re-prices every
 *     open box several times a second; doing that from Mongo would be absurd, so
 *     the authoritative live view lives here and the database is written only on
 *     entry, on exit, and on a slow periodic snapshot.
 *
 *  2. Enforce ONE OPEN BOX PER EXACT STRIKE PAIR. `reserve()` is synchronous, so
 *     two ticks arriving in the same turn of the event loop cannot both begin an
 *     entry for the same box — the second gets `false` before any await happens.
 *     The unique partial index in Mongo backs this up across processes.
 */

import {
  BOX_LEG_ROLES,
  type BoxChargeOrigin,
  type BoxDirection,
  type BoxExecutionRecord,
  type BoxExitMetrics,
  type BoxLegRole,
  type BoxOptionInstrument,
  type BoxPositionState,
  type BoxScannerConfigSnapshot,
  type IBoxExitAttempt,
} from "./types.js";

/** One live box position, as the monitor sees it. */
export interface BoxOpenPosition {
  id: string;
  /** underlying|expiry|K1|K2|DIRECTION */
  key: string;
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  /**
   * Which way the box was traded.
   *
   * Optional so a position adopted from a document written before short boxes
   * existed still loads; every reader resolves an absent value to LONG_BOX.
   */
  direction?: BoxDirection;
  lower_strike: number;
  upper_strike: number;
  box_width: number;
  lot_size: number;
  quantity: number;

  /**
   * The signed net debit per unit the four legs were actually filled at:
   * positive for a long box (money paid), negative for a short box (credit taken).
   */
  entry_box_cost_per_unit: number;
  entry_gross_edge: number;
  entry_net_edge: number;
  entry_charges_total: number | null;
  estimated_exit_charges_total: number | null;
  safety_buffer: number;
  /** The decisive entry figure: expected net profit after every cost. */
  expected_net_profit?: number | null;
  /** Execution/slippage cost carried into that decision (₹). */
  entry_execution_cost?: number | null;
  /** Whether the entry charge numbers are local or Zerodha-verified. */
  charge_origin?: BoxChargeOrigin;
  /** The detection → execution audit record of the entry. */
  entry_execution?: BoxExecutionRecord | null;
  /** Net basket margin the four legs block, captured at entry (₹), or null. */
  margin: number | null;

  opened_at: number;

  legs: Record<BoxLegRole, BoxOptionInstrument>;
  entry_prices: Record<BoxLegRole, number>;

  /**
   * EXACT open quantity per role — the authoritative record of what is still on
   * our book. At entry every role = `quantity`; a partial exit decrements only the
   * roles it closed. Every exit/flatten request is sized from this, so a leg that
   * is already flat is never traded again.
   */
  remaining_qty_by_role: Record<BoxLegRole, number>;
  /** "BOX" while all four roles are whole; "PARTIALLY_EXITED" once any is reduced. */
  position_state: BoxPositionState;
  /** Running total of exit-side charges across every exit attempt so far (₹). */
  cumulative_exit_charges: number;
  /** Append-only per-attempt exit audit (kept in memory, mirrored to Mongo). */
  exit_attempts: IBoxExitAttempt[];
  /** Instant the last exit attempt ran, for the partial-flatten retry throttle. */
  last_exit_attempt_at?: number;

  /** Newest exit arithmetic, refreshed by the monitor. */
  metrics: BoxExitMetrics | null;
  /** Latest captured-edge figures, refreshed by the monitor for persistence. */
  current_captured_edge?: number | null;
  current_captured_pct?: number | null;
  /** Set when an automatic exit was wanted but the touch could not fill it. */
  exit_blocked_reason: string | null;
  expiry_safety: boolean;
  /** Guards against a manual close racing the monitor's automatic close. */
  closing: boolean;
  last_persist_at: number;

  config: BoxScannerConfigSnapshot;
}

export class BoxPositionBook {
  private byId = new Map<string, BoxOpenPosition>();
  private byKey = new Map<string, string>();
  /** Strike pairs with an entry in progress (reserved but not yet inserted). */
  private reserved = new Set<string>();

  get size(): number {
    return this.byId.size;
  }

  list(): BoxOpenPosition[] {
    return [...this.byId.values()];
  }

  get(id: string): BoxOpenPosition | undefined {
    return this.byId.get(id);
  }

  getByKey(key: string): BoxOpenPosition | undefined {
    const id = this.byKey.get(key);
    return id ? this.byId.get(id) : undefined;
  }

  /** True when this exact strike pair is already open OR being opened. */
  isTaken(key: string): boolean {
    return this.byKey.has(key) || this.reserved.has(key);
  }

  /**
   * Claim a strike pair for an entry attempt.
   *
   * Synchronous and atomic with respect to the event loop: the caller must hold
   * the reservation across the (asynchronous) charge call and release it if the
   * entry does not happen.
   */
  reserve(key: string): boolean {
    if (this.isTaken(key)) return false;
    this.reserved.add(key);
    return true;
  }

  release(key: string): void {
    this.reserved.delete(key);
  }

  /** Adopt a position into the live book (also clears its reservation). */
  add(pos: BoxOpenPosition): void {
    this.byId.set(pos.id, pos);
    this.byKey.set(pos.key, pos.id);
    this.reserved.delete(pos.key);
  }

  remove(id: string): BoxOpenPosition | undefined {
    const pos = this.byId.get(id);
    if (!pos) return undefined;
    this.byId.delete(id);
    if (this.byKey.get(pos.key) === id) this.byKey.delete(pos.key);
    this.reserved.delete(pos.key);
    return pos;
  }

  /** Every option token of every open position — always kept subscribed. */
  tokens(): number[] {
    const out: number[] = [];
    for (const pos of this.byId.values()) {
      for (const inst of Object.values(pos.legs)) out.push(inst.token);
    }
    return out;
  }

  /** The strike-pair keys currently open (used to mark opportunities as OPEN). */
  openKeys(): Set<string> {
    return new Set(this.byKey.keys());
  }

  clear(): void {
    this.byId.clear();
    this.byKey.clear();
    this.reserved.clear();
  }
}

/** Every role holding a full lot — the state a freshly entered box starts in. */
export function fullLotByRole(quantity: number): Record<BoxLegRole, number> {
  const out = {} as Record<BoxLegRole, number>;
  for (const role of BOX_LEG_ROLES) out[role] = quantity;
  return out;
}

/**
 * A box is CLOSED only when every role is flat.
 *
 * The single source of truth for "is this position done": a 1/4, 2/4 or 3/4 exit
 * is NOT a closed box, and the trade document must stay `open` until this returns
 * true. Reading a per-role map (rather than counting filled exit legs) is what
 * makes the answer correct across several partial attempts.
 */
export function isBoxPositionFlat(pos: Pick<BoxOpenPosition, "remaining_qty_by_role">): boolean {
  return BOX_LEG_ROLES.every((role) => (pos.remaining_qty_by_role[role] ?? 0) <= 0);
}

/** Roles that still carry outstanding quantity, with that quantity. */
export function outstandingRoles(
  pos: Pick<BoxOpenPosition, "remaining_qty_by_role">,
): { role: BoxLegRole; quantity: number }[] {
  const out: { role: BoxLegRole; quantity: number }[] = [];
  for (const role of BOX_LEG_ROLES) {
    const q = pos.remaining_qty_by_role[role] ?? 0;
    if (q > 0) out.push({ role, quantity: q });
  }
  return out;
}
