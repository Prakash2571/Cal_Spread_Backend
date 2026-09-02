/**
 * Persistence for box trades and the box event ledger.
 *
 * Mongo is deliberately kept OUT of the hot path: the scanner and the position
 * monitor work from an in-memory view of the open positions (see engine.ts), and
 * this module is called only when something actually happens — an entry, an
 * exit, a periodic snapshot flush, or a ledger append.
 */

import mongoose from "mongoose";
import { isBoxConnectionReady } from "../db.js";
import {
  BoxDailyPnl,
  BoxExecutionAttempt,
  BoxOrderIntent,
  BoxSetting,
  BoxTrade,
  BoxTradeEvent,
  isBoxEventLedgerEnabled,
  type BoxDailyPnlRecord,
  type BoxExecutionAttemptRecord,
  type BoxOrderIntentRecord,
  type BoxTradeRecord,
  type IBoxDailyPnl,
  type IBoxSetting,
} from "./model.js";
import type {
  BoxChargeReconciliation,
  BoxDirection,
  BoxEventLeg,
  BoxEventType,
  BoxExecutionRecord,
  BoxOrderIntentAudit,
  BoxOrderIntentPatch,
  BoxOrderIntentState,
  BoxPositionState,
  ExecutionMode,
  IBoxExecutionAttempt,
  IBoxOrderIntent,
  IBoxTrade,
  IBoxTradeEvent,
} from "./types.js";

/** Mongo duplicate-key error code. */
const DUPLICATE_KEY = 11000;

export function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: number }).code === DUPLICATE_KEY
  );
}

/**
 * True when box persistence is available — the dedicated BOX_MONGODB_URI
 * connection when one is configured, otherwise the main MONGODB_URI one.
 */
export function isBoxDbEnabled(): boolean {
  return isBoxConnectionReady();
}

export function isValidBoxId(id: string): boolean {
  return mongoose.isValidObjectId(id);
}

/* ------------------------------ serialization -----------------------------
 * The wire format lives in serialize.ts (pure, unit-tested); re-exported here so
 * callers have one import for "everything about stored box trades".
 */
export {
  serializeBoxTrade,
  toEventLegs,
  tradeKey,
  type SerializedBoxTrade,
} from "./serialize.js";

/* -------------------------------- queries -------------------------------- */

export async function loadOpenBoxTrades(): Promise<BoxTradeRecord[]> {
  if (!isBoxDbEnabled()) return [];
  return BoxTrade.find({ status: "open" })
    .sort({ opened_at: -1 })
    .lean<BoxTradeRecord[]>();
}

export async function loadBoxTrades(limit = 300): Promise<BoxTradeRecord[]> {
  if (!isBoxDbEnabled()) return [];
  return BoxTrade.find()
    .sort({ opened_at: -1 })
    .limit(limit)
    .lean<BoxTradeRecord[]>();
}

/**
 * The non-open statuses, listed explicitly rather than as `{$ne: "open"}`.
 *
 * This is what lets the `{status: 1, closed_at: -1}` index actually SERVE the
 * `closed_at` sort. A `$ne` expands to two open-ended ranges, so the planner
 * cannot produce sorted output from the index and falls back to a blocking
 * in-memory sort — which is what made this query fail outright (Mongo's 32 MB sort
 * limit) once the closed book grew, surfacing as an EMPTY Closed-trades tab.
 * Equality points let the planner walk one interval per status and merge them in
 * sorted order, so the sort is index-driven and cannot blow up.
 *
 * Equivalent to `$ne: "open"`: the schema's status enum is exactly
 * open | closed | error, and the field is defaulted, so every document has one.
 */
const CLOSED_STATUSES = ["closed", "error"] as const;

/**
 * Fields excluded from LIST queries: the execution-audit blobs.
 *
 * `entry_execution`, `entry_legging` and `exit_execution` are Mixed audit records
 * holding per-leg depth snapshots, and every leg carries its own entry/exit depth
 * ladder on top. They are the bulk of a document — tens of KB each against ~2 KB
 * of actual trade — and NO list view renders any of them (the frontend's `BoxTrade`
 * type does not even declare them).
 *
 * Dragging them along made the full history response tens of megabytes, which is
 * slow to fetch, slow to serialize and slow to parse: enough to trip a gateway
 * timeout (observed as HTTP 504) and leave earlier days permanently unreachable.
 * The full documents remain in Mongo for any audit that needs them.
 */
const LIST_EXCLUDE_AUDIT = {
  entry_execution: 0,
  entry_legging: 0,
  exit_execution: 0,
  // The independent-order exit audit is the same kind of fat Mixed blob as the
  // others and no list view renders it, so it is projected out here too.
  exit_legging: 0,
  // Per-attempt exit audit can accumulate several attempts' worth of per-leg data;
  // no list view renders it, so keep it out of bulk queries too. The small scalar
  // fields (remaining_qty_by_role, position_state, cumulative_exit_charges) are
  // left in — they are cheap and useful for a partial-position row.
  exit_attempts: 0,
  "legs.entry_depth": 0,
  "legs.exit_depth": 0,
} as const;

/**
 * Closed (and errored) trades, newest-closed first, WITHOUT the audit blobs.
 *
 * `sinceMs` narrows to trades closed at or after that instant (used for the
 * "today only" view).
 */
export async function loadClosedBoxTrades(
  limit = 300,
  sinceMs?: number,
): Promise<BoxTradeRecord[]> {
  if (!isBoxDbEnabled()) return [];
  const filter: Record<string, unknown> = { status: { $in: CLOSED_STATUSES } };
  if (sinceMs !== undefined) filter.closed_at = { $gte: new Date(sinceMs) };
  return BoxTrade.find(filter)
    .select(LIST_EXCLUDE_AUDIT)
    .sort({ closed_at: -1, opened_at: -1 })
    .limit(limit)
    .lean<BoxTradeRecord[]>();
}

export async function findBoxTradeById(id: string): Promise<BoxTradeRecord | null> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return null;
  return BoxTrade.findById(id).lean<BoxTradeRecord>();
}

/**
 * Insert a new open box.
 *
 * Returns null when the unique partial index rejects the insert, which is
 * exactly the duplicate case: another tick already opened this strike pair. The
 * caller treats that as "already open", not as an error.
 */
/** Allocate the final Mongo identity before any live order intent is submitted. */
export function allocateBoxTradeId(): string {
  return new mongoose.Types.ObjectId().toString();
}

export async function insertBoxTrade(
  payload: IBoxTrade,
  preallocatedId?: string,
): Promise<BoxTradeRecord | null> {
  try {
    const insert = preallocatedId
      ? ({ ...payload, _id: new mongoose.Types.ObjectId(preallocatedId) } as unknown as IBoxTrade)
      : payload;
    const doc = await BoxTrade.create(insert);
    return doc.toObject() as BoxTradeRecord;
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      if (preallocatedId && mongoose.isValidObjectId(preallocatedId)) {
        const existing = await BoxTrade.findById(preallocatedId).lean<BoxTradeRecord>();
        if (existing) return existing;
      }
      return null;
    }
    throw err;
  }
}

/** Patch the basket margin onto a trade once it has been fetched off the hot path. */
export async function setBoxTradeMargin(id: string, margin: number): Promise<void> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return;
  try {
    await BoxTrade.updateOne({ _id: id }, { $set: { margin } });
  } catch (err) {
    console.warn("[Box] margin update failed for", id, err);
  }
}

/** Persist the live convergence figure for an open trade (periodic, not hot). */
export async function updateBoxTradeLive(
  id: string,
  fields: {
    current_remaining_edge: number | null;
    current_captured_edge?: number | null;
    current_captured_pct?: number | null;
    exit_blocked_reason?: string | null;
    expiry_safety?: boolean;
  },
): Promise<void> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return;
  try {
    await BoxTrade.updateOne({ _id: id }, { $set: fields });
  } catch (err) {
    console.warn("[Box] live update failed for", id, err);
  }
}

/**
 * Store the verdict of an asynchronous charge reconciliation.
 *
 * Written well after the fill. When Zerodha agreed, the charge record's
 * `computed_by` is promoted to "local_verified" so the UI can show the number was
 * confirmed; the totals themselves are never rewritten.
 */
export async function setBoxChargeReconciliation(
  id: string,
  phase: "entry" | "exit",
  verdict: BoxChargeReconciliation,
): Promise<void> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return;
  const set: Record<string, unknown> = {
    [`${phase}_charge_reconciliation`]: verdict,
  };
  if (verdict.status === "verified") {
    const chargeField = phase === "entry" ? "entry_charges" : "exit_charges";
    set[`${chargeField}.computed_by`] = "local_verified";
    if (phase === "entry") set["charge_origin"] = "local_verified";
  }
  try {
    await BoxTrade.updateOne({ _id: id }, { $set: set });
  } catch (err) {
    console.warn("[Box] reconciliation update failed for", id, err);
  }
}

/**
 * Close a box trade, but ONLY if it is still open.
 *
 * The `status: "open"` filter makes the close atomic: a manual close racing the
 * monitor's automatic close cannot double-close a position or overwrite the
 * fills of whichever got there first.
 */
export async function closeBoxTrade(
  id: string,
  fields: Partial<IBoxTrade>,
  idempotencyKey?: string,
): Promise<BoxTradeRecord | null> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return null;
  const updated = await BoxTrade.findOneAndUpdate(
    { _id: id, status: "open" },
    { $set: fields },
    { new: true },
  ).lean<BoxTradeRecord>();
  if (updated) return updated;
  if (!idempotencyKey) return null;
  const existing = await BoxTrade.findOne({
    _id: id,
    status: "closed",
    close_idempotency_key: idempotencyKey,
  }).lean<BoxTradeRecord>();
  return existing ?? null;
}

/**
 * Durably record a PARTIAL exit in ONE atomic document update.
 *
 * A partial exit is a real, irreversible execution event: some quantity closed,
 * some remains. It must be persisted BEFORE the monitor treats the execution as
 * clean, so a crash cannot resurrect the already-closed quantity. This is a single
 * `$set` (never several independent writes that could leave the position
 * half-updated), guarded on `status: "open"` so it cannot race a close.
 *
 * The trade stays OPEN — a partial exit is not a closed box; only `remaining_qty_
 * by_role` all-zero closes it (see closeBoxTrade / the monitor).
 */
export async function applyBoxPartialExit(
  id: string,
  patch: {
    remaining_qty_by_role: Record<string, number>;
    position_state: BoxPositionState;
    cumulative_exit_charges: number;
    /** The full append-only attempt array (set whole, so no $push-onto-null). */
    exit_attempts: unknown[];
    /** Outstanding residual exposure after this attempt, or null when none. */
    residual_exposure: unknown[] | null;
    /** Latest per-leg exit legging audit (Mixed). */
    exit_legging: unknown | null;
    current_remaining_edge?: number | null;
  },
): Promise<boolean> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return false;
  const res = await BoxTrade.updateOne(
    { _id: id, status: "open" },
    {
      $set: {
        remaining_qty_by_role: patch.remaining_qty_by_role,
        position_state: patch.position_state,
        cumulative_exit_charges: patch.cumulative_exit_charges,
        exit_attempts: patch.exit_attempts,
        residual_exposure: patch.residual_exposure,
        exit_legging: patch.exit_legging,
        ...(patch.current_remaining_edge !== undefined
          ? { current_remaining_edge: patch.current_remaining_edge }
          : {}),
      },
    },
  );
  return (res.matchedCount ?? 0) > 0;
}

export async function applyBoxReconciledProjection(
  id: string,
  remaining: Record<string, number>,
  state: BoxPositionState,
): Promise<boolean> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return false;
  const result = await BoxTrade.updateOne(
    { _id: id, status: "open" },
    { $set: { remaining_qty_by_role: remaining, position_state: state } },
  );
  return (result.matchedCount ?? 0) > 0;
}

export async function markBoxTradeRecovery(id: string, message: string): Promise<void> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return;
  await BoxTrade.updateOne(
    { _id: id, status: "open" },
    { $set: { position_state: "RECOVERY", error: message, exit_blocked_reason: message } },
  );
}

/** Mark a trade as errored without closing it (kept visible for the operator). */
export async function markBoxTradeError(id: string, message: string): Promise<void> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return;
  try {
    await BoxTrade.updateOne({ _id: id }, { $set: { error: message } });
  } catch {
    /* best-effort */
  }
}

/* ------------------------------- event ledger ----------------------------- */

export interface BoxEventInput {
  event: BoxEventType;
  candidate_key: string;
  underlying: string;
  expiry: string;
  direction?: BoxDirection;
  lower_strike: number;
  upper_strike: number;
  lot_size: number;
  quantity: number;
  trade_id?: string | null;
  box_width?: number | null;
  box_cost?: number | null;
  gross_edge?: number | null;
  entry_charges_total?: number | null;
  exit_charges_total?: number | null;
  safety_buffer?: number | null;
  net_edge?: number | null;
  expected_net_profit?: number | null;
  execution_cost?: number | null;
  gross_pnl?: number | null;
  net_pnl?: number | null;
  remaining_edge?: number | null;
  captured_edge?: number | null;
  captured_pct?: number | null;
  execution?: BoxExecutionRecord | null;
  execution_mode?: ExecutionMode;
  legs?: BoxEventLeg[];
  reason?: string | null;
  detail?: string | null;
}

/**
 * Append one immutable decision snapshot to the box ledger.
 *
 * Best-effort by design, exactly like the calendar ledger: the ledger is a
 * record OF a decision, never a precondition for making one, so a write failure
 * is logged and swallowed. The trade document keeps changing over time; these
 * rows preserve what the book looked like when each decision was taken.
 */
export async function appendBoxEvent(input: BoxEventInput): Promise<void> {
  if (!isBoxEventLedgerEnabled()) return;
  const entry: IBoxTradeEvent = {
    event: input.event,
    at: new Date(),
    trade_id: input.trade_id ?? null,
    candidate_key: input.candidate_key,
    underlying: input.underlying,
    expiry: input.expiry,
    direction: input.direction ?? "LONG_BOX",
    lower_strike: input.lower_strike,
    upper_strike: input.upper_strike,
    lot_size: input.lot_size,
    quantity: input.quantity,
    execution_mode: input.execution_mode ?? "paper_touch",
    box_width: input.box_width ?? null,
    box_cost: input.box_cost ?? null,
    gross_edge: input.gross_edge ?? null,
    entry_charges_total: input.entry_charges_total ?? null,
    exit_charges_total: input.exit_charges_total ?? null,
    safety_buffer: input.safety_buffer ?? null,
    net_edge: input.net_edge ?? null,
    expected_net_profit: input.expected_net_profit ?? null,
    execution_cost: input.execution_cost ?? null,
    gross_pnl: input.gross_pnl ?? null,
    net_pnl: input.net_pnl ?? null,
    remaining_edge: input.remaining_edge ?? null,
    captured_edge: input.captured_edge ?? null,
    captured_pct: input.captured_pct ?? null,
    execution: input.execution ?? null,
    legs: input.legs ?? [],
    reason: input.reason ?? null,
    detail: input.detail ?? null,
  };
  try {
    await BoxTradeEvent.create(entry);
  } catch (err) {
    console.warn("[Box] failed to append", input.event, "event:", err);
  }
}

/* ----------------------------- order intents ------------------------------ */

const NONTERMINAL_ORDER_STATES: readonly BoxOrderIntentState[] = [
  "CREATED",
  "SUBMITTING",
  "ACKNOWLEDGED",
  "OPEN",
  "PARTIALLY_FILLED",
  "CANCEL_REQUESTED",
  "UNKNOWN",
  "RECONCILIATION_REQUIRED",
];

/**
 * Create the durable intent before transport submission. Repeating the same
 * client id returns the original row and never creates a second broker intent.
 */
export async function createBoxOrderIntent(
  intent: IBoxOrderIntent,
): Promise<BoxOrderIntentRecord> {
  if (!isBoxDbEnabled()) {
    throw new Error("Box persistence is unavailable; live order intent was not created.");
  }
  const row = await BoxOrderIntent.findOneAndUpdate(
    { client_order_id: intent.client_order_id },
    { $setOnInsert: intent },
    { upsert: true, new: true },
  ).lean<BoxOrderIntentRecord>();
  if (!row) throw new Error(`Failed to create order intent ${intent.client_order_id}.`);
  assertIntentImmutableMatch(row, intent);
  return row;
}

export async function findBoxOrderIntentByClientId(
  clientOrderId: string,
): Promise<BoxOrderIntentRecord | null> {
  if (!isBoxDbEnabled()) return null;
  return BoxOrderIntent.findOne({ client_order_id: clientOrderId }).lean<BoxOrderIntentRecord>();
}

export async function findBoxOrderIntentByBrokerId(
  brokerOrderId: string,
): Promise<BoxOrderIntentRecord | null> {
  if (!isBoxDbEnabled()) return null;
  return BoxOrderIntent.findOne({ broker_order_id: brokerOrderId }).lean<BoxOrderIntentRecord>();
}

export async function loadNonterminalBoxOrderIntents(
  limit = 500,
): Promise<BoxOrderIntentRecord[]> {
  if (!isBoxDbEnabled()) return [];
  return BoxOrderIntent.find({ state: { $in: NONTERMINAL_ORDER_STATES } })
    .sort({ updated_at: 1 })
    .limit(limit)
    .lean<BoxOrderIntentRecord[]>();
}

export async function loadOwnedBoxOrderIntents(): Promise<BoxOrderIntentRecord[]> {
  if (!isBoxDbEnabled()) return [];
  // Never truncate one side of an entry/exit history: crash-recovery net exposure
  // must be derived from the complete durable BOX-intent ledger.
  return BoxOrderIntent.find({ broker_mode: "live" })
    .sort({ created_at: -1 })
    .lean<BoxOrderIntentRecord[]>();
}

const INTENT_STATE_PREDECESSORS: Readonly<Record<BoxOrderIntentState, readonly BoxOrderIntentState[]>> = {
  CREATED: ["CREATED"],
  SUBMITTING: ["CREATED", "SUBMITTING"],
  ACKNOWLEDGED: [
    "SUBMITTING", "ACKNOWLEDGED", "UNKNOWN", "RECONCILIATION_REQUIRED",
  ],
  OPEN: [
    "SUBMITTING", "ACKNOWLEDGED", "OPEN", "UNKNOWN", "RECONCILIATION_REQUIRED",
  ],
  PARTIALLY_FILLED: [
    "ACKNOWLEDGED", "OPEN", "PARTIALLY_FILLED", "UNKNOWN", "RECONCILIATION_REQUIRED",
  ],
  COMPLETE: [
    "SUBMITTING", "ACKNOWLEDGED", "OPEN", "PARTIALLY_FILLED", "CANCEL_REQUESTED",
    "CANCELLED", "UNKNOWN", "RECONCILIATION_REQUIRED", "COMPLETE",
  ],
  CANCEL_REQUESTED: [
    "ACKNOWLEDGED", "OPEN", "PARTIALLY_FILLED", "CANCEL_REQUESTED", "UNKNOWN",
    "RECONCILIATION_REQUIRED",
  ],
  CANCELLED: [
    "ACKNOWLEDGED", "OPEN", "PARTIALLY_FILLED", "CANCEL_REQUESTED", "UNKNOWN",
    "RECONCILIATION_REQUIRED", "CANCELLED",
  ],
  REJECTED: ["CREATED", "SUBMITTING", "ACKNOWLEDGED", "OPEN", "REJECTED"],
  UNKNOWN: [
    "CREATED", "SUBMITTING", "ACKNOWLEDGED", "OPEN", "PARTIALLY_FILLED",
    "CANCEL_REQUESTED", "UNKNOWN", "RECONCILIATION_REQUIRED",
  ],
  RECONCILIATION_REQUIRED: [
    "CREATED", "SUBMITTING", "ACKNOWLEDGED", "OPEN", "PARTIALLY_FILLED",
    "CANCEL_REQUESTED", "UNKNOWN", "RECONCILIATION_REQUIRED",
  ],
};

/**
 * Apply a monotonic state/fill snapshot and append one audit event exactly once.
 * Stale OPEN/lower-fill snapshots cannot regress a terminal or newer document.
 */
export interface BoxOrderIntentUpdateResult {
  intent: BoxOrderIntentRecord | null;
  applied: boolean;
}

export async function updateBoxOrderIntent(
  clientOrderId: string,
  patch: BoxOrderIntentPatch,
  audit: BoxOrderIntentAudit,
): Promise<BoxOrderIntentUpdateResult> {
  if (!isBoxDbEnabled()) {
    throw new Error("Box persistence is unavailable while updating a live order intent.");
  }
  const guards: Record<string, unknown>[] = [];
  if (patch.state) guards.push({ state: { $in: INTENT_STATE_PREDECESSORS[patch.state] } });
  if (patch.filled_quantity !== undefined) {
    guards.push({ filled_quantity: { $lte: patch.filled_quantity } });
  }
  const brokerGuard = patch.broker_order_id
    ? { $or: [{ broker_order_id: null }, { broker_order_id: patch.broker_order_id }] }
    : {};
  const setPatch = Object.fromEntries(
    Object.entries(patch).map(([key, value]) => [key, { $literal: value }]),
  );
  const row = await BoxOrderIntent.findOneAndUpdate(
    {
      client_order_id: clientOrderId,
      ...brokerGuard,
      ...(guards.length > 0 ? { $and: guards } : {}),
    },
    [{
      $set: {
        ...setPatch,
        audit: {
          $cond: [
            { $in: [audit.audit_id, { $ifNull: ["$audit.audit_id", []] }] },
            { $ifNull: ["$audit", []] },
            { $concatArrays: [{ $ifNull: ["$audit", []] }, [{ $literal: audit }]] },
          ],
        },
      },
    }] as unknown as Record<string, unknown>,
    { new: true },
  ).lean<BoxOrderIntentRecord>();
  if (!row) {
    return { intent: await findBoxOrderIntentByClientId(clientOrderId), applied: false };
  }
  return { intent: row, applied: true };
}

/** Ready-to-inject durable persistence contract for OrderManager. */
export const boxOrderIntentPersistence = {
  create: createBoxOrderIntent,
  update: updateBoxOrderIntent,
  loadNonterminal: loadNonterminalBoxOrderIntents,
  loadOwned: loadOwnedBoxOrderIntents,
  findByClientId: findBoxOrderIntentByClientId,
  findByBrokerId: findBoxOrderIntentByBrokerId,
};

const IMMUTABLE_INTENT_FIELDS = [
  "broker_mode", "trade_id", "attempt_id", "role", "purpose", "phase", "exchange",
  "tradingsymbol", "token", "side", "quantity", "reference_price", "tick_size",
  "max_chase_ticks", "limit_price",
] as const;

function assertIntentImmutableMatch(existing: IBoxOrderIntent, proposed: IBoxOrderIntent): void {
  for (const field of IMMUTABLE_INTENT_FIELDS) {
    if (existing[field] !== proposed[field]) {
      throw new Error(
        `Client order id ${proposed.client_order_id} was reused with different immutable field ${field}.`,
      );
    }
  }
}

/* --------------------------- execution attempts --------------------------- */

/**
 * Persist a paper_legging execution attempt that did not open a box.
 *
 * Best-effort like the ledger: a failed write is logged, never thrown, because
 * the attempt has already resolved in memory and this is a record of it.
 */
export async function insertBoxExecutionAttempt(
  attempt: IBoxExecutionAttempt,
): Promise<string | null> {
  if (!isBoxDbEnabled()) return null;
  try {
    const doc = await BoxExecutionAttempt.create(attempt);
    return doc._id.toString();
  } catch (err) {
    console.warn("[Box] failed to persist execution attempt:", err);
    return null;
  }
}

/** Recent aborted-execution attempts, newest first. */
export async function loadBoxExecutionAttempts(
  limit = 200,
): Promise<BoxExecutionAttemptRecord[]> {
  if (!isBoxDbEnabled()) return [];
  try {
    return await BoxExecutionAttempt.find()
      .sort({ resolved_at: -1 })
      .limit(limit)
      .lean<BoxExecutionAttemptRecord[]>();
  } catch {
    return [];
  }
}

/**
 * Attempts that still hold RESIDUAL exposure (resolved:false), newest first.
 *
 * The startup-reconciliation query: outstanding simulated contracts an execution
 * could not flatten must be re-adopted and worked again after a restart, whether
 * or not anyone presses RUN. Legacy documents have no `resolved` field; they are
 * all fully-resolved aborts, so `resolved: false` correctly excludes them.
 */
export async function loadUnresolvedBoxExecutionAttempts(
  limit = 200,
): Promise<BoxExecutionAttemptRecord[]> {
  if (!isBoxDbEnabled()) return [];
  try {
    return await BoxExecutionAttempt.find({ resolved: false })
      .sort({ resolved_at: -1 })
      .limit(limit)
      .lean<BoxExecutionAttemptRecord[]>();
  } catch {
    return [];
  }
}

/** Mark an execution attempt's residual exposure as flattened (best-effort). */
export async function resolveBoxExecutionAttempt(id: string): Promise<boolean> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return false;
  const result = await BoxExecutionAttempt.updateOne(
    { _id: id },
    { $set: { resolved: true, residual_exposure: [] } },
  );
  return (result.matchedCount ?? 0) > 0;
}

/**
 * Persist the STILL-OUTSTANDING residual after a partial flatten, idempotently.
 *
 * When `residual` is empty the attempt is resolved; otherwise the remaining
 * exposure is written back so a later flatten (or a restart) works only what is
 * left — never the quantity already flattened.
 */
export async function updateBoxExecutionAttemptResidual(
  id: string,
  residual: unknown[],
  cumulativeUnwindCharges?: number,
): Promise<boolean> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return false;
  const resolved = residual.length === 0;
  const set: Record<string, unknown> = {
    residual_exposure: resolved ? [] : residual,
    resolved,
  };
  if (cumulativeUnwindCharges !== undefined) set.unwind_charges = round2Repo(cumulativeUnwindCharges);
  const result = await BoxExecutionAttempt.updateOne({ _id: id }, { $set: set });
  return (result.matchedCount ?? 0) > 0;
}

function round2Repo(v: number): number {
  return Math.round(v * 100) / 100;
}

export async function loadBoxLiveRiskSeed(sinceMs: number): Promise<{
  realisedPnl: number;
  rejects: number;
  consecutiveFailures: number;
}> {
  if (!isBoxDbEnabled()) return { realisedPnl: 0, rejects: 0, consecutiveFailures: 0 };
  const [trades, attempts, rejectedCount, recentIntents] = await Promise.all([
    BoxTrade.find({ closed_at: { $gte: new Date(sinceMs) } })
      .select({ realised_net_pnl: 1, net_pnl: 1 })
      .lean<Array<{ realised_net_pnl?: number | null; net_pnl?: number | null }>>(),
    BoxExecutionAttempt.find({ resolved_at: { $gte: new Date(sinceMs) } })
      .select({ net_abort_pnl: 1 })
      .lean<Array<{ net_abort_pnl?: number | null }>>(),
    BoxOrderIntent.countDocuments({ state: "REJECTED", updated_at: { $gte: new Date(sinceMs) } }),
    BoxOrderIntent.find({ updated_at: { $gte: new Date(sinceMs) } })
      .select({ state: 1 })
      .sort({ updated_at: -1 })
      .lean<Array<{ state: BoxOrderIntentState }>>(),
  ]);
  const tradePnl = trades.reduce((sum, trade) => sum + (trade.realised_net_pnl ?? trade.net_pnl ?? 0), 0);
  const abortPnl = attempts.reduce((sum, attempt) => sum + (attempt.net_abort_pnl ?? 0), 0);
  let consecutiveFailures = 0;
  for (const intent of recentIntents) {
    if (intent.state === "COMPLETE") break;
    if (intent.state === "REJECTED" || intent.state === "UNKNOWN" || intent.state === "RECONCILIATION_REQUIRED") {
      consecutiveFailures++;
    }
  }
  return { realisedPnl: tradePnl + abortPnl, rejects: rejectedCount, consecutiveFailures };
}

/* ----------------------------- daily P&L archive -------------------------- */

/**
 * Trades closed at or after `sinceMs` — the "closed today" set used to build the
 * running day-P&L snapshot. Filtered on `closed_at`, which is what makes it a
 * TODAY query rather than a full history scan.
 */
export async function loadBoxTradesClosedSince(sinceMs: number): Promise<BoxTradeRecord[]> {
  if (!isBoxDbEnabled()) return [];
  return BoxTrade.find({
    // Equality points, not $ne — see CLOSED_STATUSES: this is what lets the
    // {status, closed_at} index serve the sort instead of a blocking in-memory one.
    status: { $in: CLOSED_STATUSES },
    closed_at: { $gte: new Date(sinceMs) },
  })
    // Every caller (the day tally, the P&L archive inputs, today's trade list)
    // reads only scalar fields, so the audit blobs are pure weight here too.
    .select(LIST_EXCLUDE_AUDIT)
    .sort({ closed_at: -1 })
    .lean<BoxTradeRecord[]>();
}

/**
 * Upsert one archived P&L row (per-trade OR the day summary), keyed on
 * (day, trade_id). Idempotent by design: the nightly drain and the later verify
 * passes both call this, and re-writing an already-archived row is harmless.
 */
export async function upsertBoxDailyPnl(doc: IBoxDailyPnl): Promise<void> {
  if (!isBoxDbEnabled()) return;
  await BoxDailyPnl.updateOne(
    { day: doc.day, trade_id: doc.trade_id },
    { $set: { ...doc, archived_at: new Date() } },
    { upsert: true },
  );
}

/** The trade ids already archived for a day (used to compute what verify must still drain). */
export async function loadBoxDailyPnlTradeIds(day: string): Promise<string[]> {
  if (!isBoxDbEnabled()) return [];
  try {
    const rows = await BoxDailyPnl.find({ day }).lean<BoxDailyPnlRecord[]>();
    return rows.map((r) => r.trade_id);
  } catch {
    return [];
  }
}

/** All archived P&L rows for a day, newest-updated first (for a reporting view). */
export async function loadBoxDailyPnl(day: string): Promise<BoxDailyPnlRecord[]> {
  if (!isBoxDbEnabled()) return [];
  try {
    return await BoxDailyPnl.find({ day }).lean<BoxDailyPnlRecord[]>();
  } catch {
    return [];
  }
}

/** Recent ledger rows, newest first (for the audit view). */
export async function loadBoxEvents(limit = 200): Promise<IBoxTradeEvent[]> {
  if (!isBoxEventLedgerEnabled()) return [];
  try {
    return await BoxTradeEvent.find()
      .sort({ at: -1 })
      .limit(limit)
      .lean<IBoxTradeEvent[]>();
  } catch {
    return [];
  }
}

/* ------------------------------ box settings ------------------------------ */

/**
 * Every persisted admin threshold, as `key -> value`.
 *
 * Read once at boot. Returns an empty map when the box database is unavailable so
 * the engine simply keeps its env-configured defaults — a settings store that is
 * briefly unreachable must not stop the module from booting.
 */
export async function loadBoxSettings(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!isBoxDbEnabled()) return out;
  try {
    const rows = await BoxSetting.find().lean<IBoxSetting[]>();
    for (const row of rows) {
      if (typeof row.value === "number" && Number.isFinite(row.value)) {
        out.set(row._id, row.value);
      }
    }
  } catch (err) {
    console.warn("[Box] failed to load persisted settings:", err);
  }
  return out;
}

/**
 * Upsert admin thresholds.
 *
 * Throws on failure — unlike most writes here this one is NOT best-effort: the
 * admin is told the value was saved, so a silent failure would have the UI showing
 * a threshold that reverts on the next restart.
 *
 * One `bulkWrite`, not N independent upserts under `Promise.all`. With separate
 * writes a partial failure rejects the caller (which rolls the live values back)
 * while leaving Mongo holding half the change — which the next boot would then load
 * as though it had been intended. A single batched command keeps "what was saved"
 * and "what is running" from diverging across a restart.
 */
export async function saveBoxSettings(entries: Map<string, number>): Promise<void> {
  if (!isBoxDbEnabled()) {
    throw new Error("Box persistence is not configured, so settings cannot be saved.");
  }
  if (entries.size === 0) return;
  const now = new Date();
  await BoxSetting.bulkWrite(
    [...entries].map(([key, value]) => ({
      updateOne: {
        filter: { _id: key },
        update: { $set: { value, updated_at: now } },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}
