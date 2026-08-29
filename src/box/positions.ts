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

import type {
  BoxExitMetrics,
  BoxLegRole,
  BoxOptionInstrument,
  BoxScannerConfigSnapshot,
} from "./types.js";

/** One live box position, as the monitor sees it. */
export interface BoxOpenPosition {
  id: string;
  /** underlying|expiry|K1|K2 */
  key: string;
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  lower_strike: number;
  upper_strike: number;
  box_width: number;
  lot_size: number;
  quantity: number;

  /** The per-unit cost the four legs were actually filled at. */
  entry_box_cost_per_unit: number;
  entry_gross_edge: number;
  entry_net_edge: number;
  entry_charges_total: number | null;
  estimated_exit_charges_total: number | null;
  safety_buffer: number;

  opened_at: number;

  legs: Record<BoxLegRole, BoxOptionInstrument>;
  entry_prices: Record<BoxLegRole, number>;

  /** Newest exit arithmetic, refreshed by the monitor. */
  metrics: BoxExitMetrics | null;
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
