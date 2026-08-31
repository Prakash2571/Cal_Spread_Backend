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
  BoxExecutionAttempt,
  BoxTrade,
  BoxTradeEvent,
  isBoxEventLedgerEnabled,
  type BoxExecutionAttemptRecord,
  type BoxTradeRecord,
} from "./model.js";
import type {
  BoxChargeReconciliation,
  BoxDirection,
  BoxEventLeg,
  BoxEventType,
  BoxExecutionRecord,
  ExecutionMode,
  IBoxExecutionAttempt,
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

export async function loadClosedBoxTrades(limit = 300): Promise<BoxTradeRecord[]> {
  if (!isBoxDbEnabled()) return [];
  return BoxTrade.find({ status: { $ne: "open" } })
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
export async function insertBoxTrade(
  payload: IBoxTrade,
): Promise<BoxTradeRecord | null> {
  try {
    const doc = await BoxTrade.create(payload);
    return doc.toObject() as BoxTradeRecord;
  } catch (err) {
    if (isDuplicateKeyError(err)) return null;
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
): Promise<BoxTradeRecord | null> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return null;
  const updated = await BoxTrade.findOneAndUpdate(
    { _id: id, status: "open" },
    { $set: fields },
    { new: true },
  ).lean<BoxTradeRecord>();
  return updated ?? null;
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

/* --------------------------- execution attempts --------------------------- */

/**
 * Persist a paper_legging execution attempt that did not open a box.
 *
 * Best-effort like the ledger: a failed write is logged, never thrown, because
 * the attempt has already resolved in memory and this is a record of it.
 */
export async function insertBoxExecutionAttempt(
  attempt: IBoxExecutionAttempt,
): Promise<void> {
  if (!isBoxDbEnabled()) return;
  try {
    await BoxExecutionAttempt.create(attempt);
  } catch (err) {
    console.warn("[Box] failed to persist execution attempt:", err);
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
