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
import { LEGACY_BROKER, type BrokerId } from "../brokers/types.js";
import {
  BoxPnlDayProofBuilder,
  SUMMARY_FIELD,
  boxPnlDayProofsEqual,
  boxPnlSummariesEqual,
  boxPnlSummaryMatchesRows,
  buildBoxPnlDayProof,
  type BoxPnlDayProof,
} from "./pnlSnapshot.js";
import {
  BoxCalibrationSample,
  BoxDailyPnl,
  BoxExecutionAttempt,
  BoxOrderIntent,
  BoxPnlDayState,
  BoxPnlDeletion,
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
 * Return the subset of ids that still exist in the source trade collection.
 *
 * The nightly P&L archiver uses this one projected batch query before trusting
 * cached rows. It intentionally does not catch query failures: treating an
 * unavailable source as "nothing exists" would silently erase a valid day.
 */
const PNL_QUERY_CHUNK = 200;
const PNL_SCAN_PAGE = 200;
const MAX_DELETION_CANDIDATE_DAYS = 64;

function chunks<T>(items: readonly T[], size = PNL_QUERY_CHUNK): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

export async function filterExistingBoxTradeIds(ids: string[]): Promise<string[]> {
  if (!isBoxDbEnabled()) throw new Error("Box persistence is not available.");
  const validIds = [...new Set(ids.filter((id) => mongoose.isValidObjectId(id)))];
  const existing: string[] = [];
  for (const batch of chunks(validIds)) {
    const rows = await BoxTrade.find(
      { _id: { $in: batch } },
      { _id: 1 },
    ).lean<{ _id: unknown }[]>();
    existing.push(...rows.map((row) => String(row._id)));
  }
  return existing;
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

/**
 * PERMANENTLY delete a box trade — paper trades only, never a live one.
 *
 * The safety rule is enforced IN THE QUERY, exactly like `closeBoxTrade`'s
 * `status: "open"` guard, rather than by reading the document first and deciding
 * in application code. A read-then-delete has a window in which a paper trade
 * could be adopted, or a mode could change, between the two operations; a guarded
 * filter cannot be raced.
 *
 * `execution_mode: { $ne: "live" }` is the whole protection: a live box may have
 * REAL broker exposure attached to it, so deleting its record would orphan that
 * exposure — the position would still exist at the broker with nothing in our
 * database pointing at it. `deletedCount === 0` therefore means "not found OR
 * refused", and the caller must distinguish the two with a prior read purely to
 * choose the right HTTP status (404 vs 409), never to decide whether to delete.
 *
 * Returns the number of documents removed (0 or 1).
 */
export async function deleteBoxTrade(id: string): Promise<number> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return 0;
  const res = await BoxTrade.deleteOne({ _id: id, execution_mode: { $ne: "live" } });
  return res.deletedCount ?? 0;
}

/**
 * Install the durable reporting-cleanup fence before removing the source trade.
 * The record is intentionally retained after completion so a late writer in a
 * different process can still observe the deletion.
 */
export async function prepareBoxPnlDeletion(
  tradeId: string,
  candidateDays: string[] = [],
): Promise<void> {
  if (!isBoxDbEnabled()) throw new Error("Box persistence is not available.");
  const now = new Date();
  await BoxPnlDeletion.updateOne(
    { _id: tradeId },
    {
      $setOnInsert: {
        status: "pending",
        attempts: 0,
        created_at: now,
        completed_at: null,
        candidate_days: [],
      },
      $set: { updated_at: now, last_error: null },
    },
    { upsert: true },
  );
  const candidates = [...new Set(
    candidateDays.slice(-MAX_DELETION_CANDIDATE_DAYS).filter(Boolean),
  )].sort();
  if (candidates.length > 0) {
    await BoxPnlDeletion.updateOne(
      { _id: tradeId },
      [{
        $set: {
          candidate_days: {
            $slice: [
              { $setUnion: [{ $ifNull: ["$candidate_days", []] }, candidates] },
              -MAX_DELETION_CANDIDATE_DAYS,
            ],
          },
        },
      }],
    );
  }
}

/** Remove a prepared fence only when the guarded source delete did not happen. */
export async function cancelBoxPnlDeletion(tradeId: string): Promise<void> {
  if (!isBoxDbEnabled()) return;
  await BoxPnlDeletion.deleteOne({ _id: tradeId, status: "pending" });
}

/**
 * Identify archive ids that are no longer legal at the durable boundary.
 * A retained deletion fence covers a writer that raced the source delete; the
 * source existence check also repairs legacy/crash orphans that predate fences.
 */
/** Pending preparation alone never invalidates a row while its source exists. */
export function isArchivedPnlRowInvalid(
  sourceExists: boolean,
  fenceStatus: "pending" | "complete" | null,
): boolean {
  return !sourceExists || fenceStatus === "complete";
}

async function invalidArchivedTradeIds(ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids.filter((id) => id !== SUMMARY_FIELD))];
  const invalid: string[] = [];
  for (const batch of chunks(unique)) {
    const validIds = batch.filter((id) => mongoose.isValidObjectId(id));
    const sources = validIds.length > 0
      ? await BoxTrade.find({ _id: { $in: validIds } }, { _id: 1 })
          .lean<{ _id: unknown }[]>()
      : [];
    const completedFences = await BoxPnlDeletion.find(
      { _id: { $in: batch }, status: "complete" },
      { _id: 1, status: 1 },
    ).lean<{ _id: string; status: "complete" }[]>();
    const existing = new Set(sources.map((row) => String(row._id)));
    const completed = new Set(completedFences.map((row) => String(row._id)));
    invalid.push(...batch.filter((id) =>
      isArchivedPnlRowInvalid(existing.has(id), completed.has(id) ? "complete" : null)));
  }
  return invalid;
}

export async function runBoxPnlDayMutation<T>(args: {
  invalidate: () => Promise<void>;
  mutate: () => Promise<T>;
}): Promise<T> {
  await args.invalidate();
  let result: T | undefined;
  let mutationError: unknown;
  try {
    result = await args.mutate();
  } catch (err) {
    mutationError = err;
  }
  try {
    await args.invalidate();
  } catch (invalidationError) {
    if (mutationError !== undefined) {
      throw new AggregateError(
        [mutationError, invalidationError],
        "Box P&L mutation and post-invalidation both failed",
      );
    }
    throw invalidationError;
  }
  if (mutationError !== undefined) throw mutationError;
  return result as T;
}

async function mutateDurablePnlDay<T>(day: string, mutate: () => Promise<T>): Promise<T> {
  return runBoxPnlDayMutation({
    invalidate: () => markBoxDailyPnlIncomplete(day, true),
    mutate,
  });
}

async function scanDurablePnlDay(day: string): Promise<{
  proof: BoxPnlDayProof;
  summary: ReturnType<BoxPnlDayProofBuilder["finish"]>["summary"];
  invalidTradeIds: string[];
}> {
  const builder = new BoxPnlDayProofBuilder(day);
  let afterTradeId = "";
  const invalidTradeIds = new Set<string>();
  while (true) {
    const rows = await BoxDailyPnl.find({
      day,
      trade_id: afterTradeId
        ? { $ne: SUMMARY_FIELD, $gt: afterTradeId }
        : { $ne: SUMMARY_FIELD },
    })
      .sort({ trade_id: 1 })
      .limit(PNL_SCAN_PAGE)
      .lean<BoxDailyPnlRecord[]>();
    if (rows.length === 0) break;
    afterTradeId = rows.at(-1)!.trade_id;
    const invalid = await invalidArchivedTradeIds(rows.map((row) => row.trade_id));
    invalid.forEach((tradeId) => invalidTradeIds.add(tradeId));
    const invalidSet = new Set(invalid);
    for (const row of rows) {
      if (!invalidSet.has(row.trade_id)) builder.add(row);
    }
    if (rows.length < PNL_SCAN_PAGE) break;
  }
  return { ...builder.finish(new Date().toISOString()), invalidTradeIds: [...invalidTradeIds] };
}

/** Rewrite and validate a day summary with fixed-size page residency. */
export async function rewriteBoxDailyPnlSummary(day: string): Promise<BoxPnlDayProof> {
  if (!isBoxDbEnabled()) throw new Error("Box persistence is not available.");
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = await scanDurablePnlDay(day);
    if (before.invalidTradeIds.length > 0) {
      throw new Error(`box_daily_pnl day ${day} contained an invalid source row`);
    }
    await mutateDurablePnlDay(day, async () => {
      await BoxDailyPnl.updateOne(
        { day, trade_id: SUMMARY_FIELD },
        {
          $set: {
            day,
            trade_id: SUMMARY_FIELD,
            status: "summary",
            summary: before.summary,
            updated_at: before.summary.updated_at,
            archived_at: new Date(),
          },
        },
        { upsert: true },
      );
    });
    const after = await scanDurablePnlDay(day);
    if (after.invalidTradeIds.length === 0 && boxPnlDayProofsEqual(before.proof, after.proof)) {
      return after.proof;
    }
  }
  throw new Error(`box_daily_pnl summary for ${day} did not settle after concurrent mutations`);
}

export function shouldReproveBoxPnlDay(state: {
  complete?: boolean;
  needs_reproof?: boolean;
} | null): boolean {
  return state?.complete === true || state?.needs_reproof === true;
}

async function recordBoxPnlDeletionFailure(tradeId: string, err: unknown): Promise<void> {
  await BoxPnlDeletion.updateOne(
    { _id: tradeId, status: "pending" },
    {
      $set: {
        updated_at: new Date(),
        last_error: err instanceof Error ? err.message : String(err),
      },
      $inc: { attempts: 1 },
    },
  ).catch(() => undefined);
}

export interface BoxPnlIndependentRepairResult {
  repaired: number;
  failureCount: number;
  /** Bounded samples; failureCount remains exact when more failures occur. */
  errors: Error[];
}

/** Run unrelated reconciliation work to completion without one poison item starving later work. */
export async function runIndependentBoxPnlRepairs<T>(args: {
  scope: string;
  items: readonly T[];
  identify: (item: T) => string;
  repair: (item: T) => Promise<number>;
  maxErrorSamples?: number;
}): Promise<BoxPnlIndependentRepairResult> {
  let repaired = 0;
  let failureCount = 0;
  const errors: Error[] = [];
  const maxErrorSamples = Math.max(1, args.maxErrorSamples ?? 20);
  for (const item of args.items) {
    try {
      repaired += await args.repair(item);
    } catch (err) {
      failureCount++;
      if (errors.length < maxErrorSamples) {
        const cause = err instanceof Error ? err : new Error(String(err));
        errors.push(new Error(`${args.scope} ${args.identify(item)} failed: ${cause.message}`, {
          cause,
        }));
      }
    }
  }
  return { repaired, failureCount, errors };
}

async function markBoxDailyPnlRetryIfProof(
  day: string,
  proof: BoxPnlDayProof,
): Promise<void> {
  await BoxPnlDayState.updateOne(
    { _id: day, ...proof },
    { $set: { complete: false, needs_reproof: true, updated_at: new Date() } },
  );
}

async function reproveBoxDailyPnlFromDurable(
  day: string,
  expectedRowCount?: number,
): Promise<void> {
  const state = await BoxPnlDayState.findById(day)
    .select({ snapshot_version: 1, row_count: 1, content_sha256: 1 })
    .lean<{ snapshot_version?: number; row_count?: number; content_sha256?: string }>();
  const lastExactProof = state ? boxPnlDayProofFromState(state) : null;
  if (!lastExactProof) {
    await markBoxDailyPnlIncomplete(day, true);
    throw new Error(`box_daily_pnl day ${day} has no last exact v2 proof`);
  }

  let retryProof = lastExactProof;
  await runBoxPnlDayProofRepair({
    lastExactProof,
    expectedRowCount: expectedRowCount ?? lastExactProof.row_count,
    settle: async () => { await rewriteBoxDailyPnlSummary(day); },
    load: () => loadBoxDailyPnlSnapshot(day),
    validate: async (docs) => {
      const ids = docs
        .filter((doc) => doc.trade_id !== SUMMARY_FIELD)
        .map((doc) => doc.trade_id);
      if ((await invalidArchivedTradeIds(ids)).length > 0) {
        throw new Error(`box_daily_pnl day ${day} contained an invalid source row`);
      }
    },
    publish: async (priorProof, nextProof) => {
      const result = await BoxPnlDayState.updateOne(
        { _id: day, ...priorProof },
        {
          $set: { complete: true, needs_reproof: false, ...nextProof, updated_at: new Date() },
          $unset: { expected_trade_ids: 1 },
        },
      );
      if ((result.matchedCount ?? 0) !== 1) {
        throw new Error(`box_daily_pnl day ${day} changed before re-proof publication`);
      }
      retryProof = nextProof;
    },
    markRetry: () => markBoxDailyPnlRetryIfProof(day, retryProof),
  });
}

/**
 * Drop a trade's rows from the daily-P&L archive and rebuild affected summaries.
 * The durable intent remains pending on any error and is retried at startup.
 */
export async function deleteBoxDailyPnlForTrade(
  tradeId: string,
  cacheDays: string[] = [],
): Promise<number> {
  if (!isBoxDbEnabled()) throw new Error("Box persistence is not available.");
  await prepareBoxPnlDeletion(tradeId, cacheDays);
  let deleted = 0;
  try {
    const intent = await BoxPnlDeletion.findById(tradeId).lean<{
      candidate_days?: string[];
    }>();
    const candidateDays = [...new Set([
      ...cacheDays.slice(-MAX_DELETION_CANDIDATE_DAYS),
      ...(intent?.candidate_days ?? []).slice(-MAX_DELETION_CANDIDATE_DAYS),
    ].filter(Boolean))].sort().slice(-MAX_DELETION_CANDIDATE_DAYS);
    const cleanDay = async (day: string): Promise<void> => {
      const state = await BoxPnlDayState.findById(day)
        .select({
          complete: 1,
          needs_reproof: 1,
          snapshot_version: 1,
          row_count: 1,
          content_sha256: 1,
          expected_trade_ids: 1,
        })
        .lean<{
          complete?: boolean;
          needs_reproof?: boolean;
          snapshot_version?: number;
          row_count?: number;
          content_sha256?: string;
          expected_trade_ids?: string[];
        }>();
      // The source/fence scan excludes invalid rows from this count, so deletion
      // cleanup establishes the only membership reduction we may safely certify.
      const survivors = await scanDurablePnlDay(day);
      const result = await mutateDurablePnlDay(day, () =>
        BoxDailyPnl.deleteOne({ day, trade_id: tradeId }));
      deleted += result.deletedCount ?? 0;
      if (Array.isArray(state?.expected_trade_ids)) {
        const migrated = await migrateLegacyBoxDailyPnlState(day, state.expected_trade_ids);
        if (!migrated) {
          throw new Error(`box_daily_pnl legacy day ${day} could not be migrated after cleanup`);
        }
      } else if (shouldReproveBoxPnlDay(state)) {
        await reproveBoxDailyPnlFromDurable(day, survivors.proof.row_count);
      } else {
        await rewriteBoxDailyPnlSummary(day);
      }
    };

    for (const day of candidateDays) await cleanDay(day);

    // Query/delete in pages instead of materializing every historical day. Since
    // each processed row is removed, repeatedly taking the first page converges.
    while (true) {
      const rows = await BoxDailyPnl.find({ trade_id: tradeId })
        .select({ day: 1 })
        .limit(PNL_SCAN_PAGE)
        .lean<{ day: string }[]>();
      if (rows.length === 0) break;
      for (const day of [...new Set(rows.map((row) => row.day))]) {
        // A row can reappear in an already-processed candidate day after a stale
        // writer races cleanup. Re-run the full fenced day cleanup; never delete
        // it without summary repair and proof invalidation.
        await cleanDay(day);
      }
    }

    const now = new Date();
    await BoxPnlDeletion.updateOne(
      { _id: tradeId },
      {
        $set: {
          status: "complete",
          candidate_days: candidateDays,
          updated_at: now,
          completed_at: now,
          last_error: null,
        },
        $inc: { attempts: 1 },
      },
    );
    return deleted;
  } catch (err) {
    await BoxPnlDeletion.updateOne(
      { _id: tradeId },
      {
        $set: {
          status: "pending",
          updated_at: new Date(),
          last_error: err instanceof Error ? err.message : String(err),
        },
        $inc: { attempts: 1 },
      },
    ).catch(() => undefined);
    throw err;
  }
}

/**
 * Validate or repair one v2 day selected by the bounded periodic scan. Complete
 * states are deliberately inspected too: a process can crash after its row write
 * but before the post-write invalidation, leaving the previous proof complete.
 */
async function repairBoxDailyPnlV2Day(day: string): Promise<number> {
  let repaired = 0;
  let scanned = await scanDurablePnlDay(day);
  if (scanned.invalidTradeIds.length > 0) {
    for (const tradeId of scanned.invalidTradeIds) {
      // The durable intent is installed by deletion cleanup before any row is
      // removed, making the resulting membership reduction explicit and retryable.
      repaired += await deleteBoxDailyPnlForTrade(tradeId);
    }
    scanned = await scanDurablePnlDay(day);
    if (scanned.invalidTradeIds.length > 0) {
      throw new Error(`box_daily_pnl day ${day} retained invalid source rows after cleanup`);
    }
  }

  const state = await BoxPnlDayState.findById(day)
    .select({
      complete: 1,
      needs_reproof: 1,
      snapshot_version: 1,
      row_count: 1,
      content_sha256: 1,
    })
    .lean<{
      complete?: boolean;
      needs_reproof?: boolean;
      snapshot_version?: number;
      row_count?: number;
      content_sha256?: string;
    }>();
  const lastExactProof = state ? boxPnlDayProofFromState(state) : null;
  if (!lastExactProof) {
    await markBoxDailyPnlIncomplete(day, true);
    throw new Error(`box_daily_pnl day ${day} has no safe v2 proof to repair from`);
  }

  const stored = await BoxDailyPnl.findOne({ day, trade_id: SUMMARY_FIELD })
    .select({ summary: 1 })
    .lean<{ summary?: ReturnType<BoxPnlDayProofBuilder["finish"]>["summary"] }>();
  const contentMatches = boxPnlDayProofsEqual(lastExactProof, scanned.proof);
  const summaryMatches = Boolean(
    stored?.summary && boxPnlSummariesEqual(stored.summary, scanned.summary),
  );
  if (state?.complete === true && state.needs_reproof !== true &&
      contentMatches && summaryMatches) {
    return repaired;
  }

  // Same-count content replacement (the late same-ID writer case) is safe to
  // reproof. Different cardinality is a potentially partial crashed generation
  // and remains fail-closed with the last exact proof retained as retry evidence.
  await reproveBoxDailyPnlFromDurable(day, lastExactProof.row_count);
  return repaired + 1;
}

/**
 * Restart repair: finish pending intents, then page through legacy/crash archive
 * rows. Completed fences are intentionally permanent; see the model retention
 * note for the bounded-storage-vs-safety tradeoff.
 */
export async function reconcileBoxDailyPnlOrphans(): Promise<number> {
  if (!isBoxDbEnabled()) return 0;
  let repaired = 0;
  let failureCount = 0;
  const errors: Error[] = [];
  const record = (result: BoxPnlIndependentRepairResult): void => {
    repaired += result.repaired;
    failureCount += result.failureCount;
    const available = Math.max(0, 20 - errors.length);
    errors.push(...result.errors.slice(0, available));
  };

  let pendingAfter = "";
  while (true) {
    const pending = await BoxPnlDeletion.find({
      status: "pending",
      ...(pendingAfter ? { _id: { $gt: pendingAfter } } : {}),
    })
      .select({ _id: 1, candidate_days: 1 })
      .sort({ _id: 1 })
      .limit(PNL_SCAN_PAGE)
      .lean<{ _id: string; candidate_days?: string[] }[]>();
    if (pending.length === 0) break;
    pendingAfter = String(pending.at(-1)!._id);
    record(await runIndependentBoxPnlRepairs({
      scope: "pending P&L deletion",
      items: pending,
      identify: (intent) => String(intent._id),
      repair: async (intent) => {
        const tradeId = String(intent._id);
        let sourceStillExists: Awaited<ReturnType<typeof BoxTrade.exists>>;
        try {
          sourceStillExists = mongoose.isValidObjectId(tradeId)
            ? await BoxTrade.exists({ _id: tradeId })
            : null;
        } catch (err) {
          await recordBoxPnlDeletionFailure(tradeId, err);
          throw err;
        }
        if (sourceStillExists) {
          try {
            await cancelBoxPnlDeletion(tradeId);
          } catch (err) {
            await recordBoxPnlDeletionFailure(tradeId, err);
            throw err;
          }
          return 0;
        }
        return deleteBoxDailyPnlForTrade(
          tradeId,
          (intent.candidate_days ?? []).slice(-MAX_DELETION_CANDIDATE_DAYS),
        );
      },
    }));
    if (pending.length < PNL_SCAN_PAGE) break;
  }

  let archiveAfter: mongoose.Types.ObjectId | null = null;
  while (true) {
    const rows: { _id: mongoose.Types.ObjectId; trade_id: string }[] = await BoxDailyPnl.find({
      trade_id: { $ne: SUMMARY_FIELD },
      ...(archiveAfter ? { _id: { $gt: archiveAfter } } : {}),
    })
      .select({ _id: 1, trade_id: 1 })
      .sort({ _id: 1 })
      .limit(PNL_SCAN_PAGE)
      .lean<{ _id: mongoose.Types.ObjectId; trade_id: string }[]>();
    if (rows.length === 0) break;
    archiveAfter = rows.at(-1)!._id;
    const invalid = [...new Set(await invalidArchivedTradeIds(rows.map((row) => row.trade_id)))];
    record(await runIndependentBoxPnlRepairs({
      scope: "orphan P&L archive trade",
      items: invalid,
      identify: (tradeId) => tradeId,
      repair: async (tradeId) => {
        await prepareBoxPnlDeletion(tradeId);
        return deleteBoxDailyPnlForTrade(tradeId);
      },
    }));
    if (rows.length < PNL_SCAN_PAGE) break;
  }

  let v2After = "";
  while (true) {
    const states = await BoxPnlDayState.find({
      expected_trade_ids: { $exists: false },
      snapshot_version: 2,
      $or: [{ complete: true }, { needs_reproof: true }],
      ...(v2After ? { _id: { $gt: v2After } } : {}),
    })
      .select({ _id: 1 })
      .sort({ _id: 1 })
      .limit(PNL_SCAN_PAGE)
      .lean<{ _id: string }[]>();
    if (states.length === 0) break;
    v2After = String(states.at(-1)!._id);
    record(await runIndependentBoxPnlRepairs({
      scope: "v2 P&L day repair",
      items: states,
      identify: (state) => String(state._id),
      repair: (state) => repairBoxDailyPnlV2Day(String(state._id)),
    }));
    if (states.length < PNL_SCAN_PAGE) break;
  }

  let legacyAfter = "";
  while (true) {
    const states = await BoxPnlDayState.find({
      expected_trade_ids: { $exists: true },
      $or: [{ complete: true }, { needs_reproof: true }],
      ...(legacyAfter ? { _id: { $gt: legacyAfter } } : {}),
    })
      .select({ _id: 1, expected_trade_ids: 1 })
      .sort({ _id: 1 })
      .limit(PNL_SCAN_PAGE)
      .lean<{ _id: string; expected_trade_ids?: string[] }[]>();
    if (states.length === 0) break;
    legacyAfter = String(states.at(-1)!._id);
    record(await runIndependentBoxPnlRepairs({
      scope: "legacy P&L day migration",
      items: states,
      identify: (state) => String(state._id),
      repair: async (state) => {
        const migrated = await migrateLegacyBoxDailyPnlState(
          String(state._id),
          state.expected_trade_ids,
        );
        if (!migrated) throw new Error("durable rows did not safely match the legacy manifest");
        return 1;
      },
    }));
    if (states.length < PNL_SCAN_PAGE) break;
  }

  if (failureCount > 0) {
    throw new AggregateError(
      errors,
      `Box P&L reconciliation completed independent work with ${failureCount} failure(s) and ${repaired} repair(s)`,
    );
  }
  return repaired;
}

/** Delete exact extra day rows before verify rewrites the aggregate. */
export async function deleteBoxDailyPnlRows(day: string, tradeIds: string[]): Promise<number> {
  if (!isBoxDbEnabled() || tradeIds.length === 0) return 0;
  let deleted = 0;
  for (const batch of chunks([...new Set(tradeIds)])) {
    const result = await mutateDurablePnlDay(day, () =>
      BoxDailyPnl.deleteMany({ day, trade_id: { $in: batch } }));
    deleted += result.deletedCount ?? 0;
  }
  return deleted;
}

/**
 * Every trade closed on a given IST day, for a full statistics rebuild.
 *
 * Distinct from `loadBoxTradesClosedSince` in intent: that one feeds the running
 * day tally, this one is the authoritative re-read used after a deletion, when the
 * in-memory tallies must be discarded and recomputed from what actually remains.
 */
export async function loadBoxTradesClosedBetween(
  fromMs: number,
  toMs: number,
): Promise<BoxTradeRecord[]> {
  if (!isBoxDbEnabled()) return [];
  return BoxTrade.find({
    status: { $in: CLOSED_STATUSES },
    closed_at: { $gte: new Date(fromMs), $lt: new Date(toMs) },
  })
    .select(LIST_EXCLUDE_AUDIT)
    .sort({ closed_at: -1, opened_at: -1 })
    .lean<BoxTradeRecord[]>();
}

/**
 * Open/closed trade intervals for a peak-concurrent-margin REPLAY.
 *
 * Only the four fields the replay needs, so this stays cheap enough to run on
 * every deletion. `margin` is nullable and the replay must treat null as
 * "unknown", never as zero.
 */
export async function loadBoxMarginIntervalsSince(sinceMs: number): Promise<
  { id: string; opened_at: Date; closed_at: Date | null; margin: number | null }[]
> {
  if (!isBoxDbEnabled()) return [];
  const rows = await BoxTrade.find(
    {
      $or: [
        { status: "open" },
        { closed_at: { $gte: new Date(sinceMs) } },
      ],
    },
    { opened_at: 1, closed_at: 1, margin: 1 },
  ).lean<{ _id: unknown; opened_at: Date; closed_at: Date | null; margin: number | null }[]>();
  return rows.map((r) => ({
    id: String(r._id),
    opened_at: r.opened_at,
    closed_at: r.closed_at ?? null,
    margin: r.margin ?? null,
  }));
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
  /** The broker the decision was taken against. Absent ⇒ the legacy default. */
  broker?: BrokerId;
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
    // Zerodha for anything that does not say otherwise — the same legacy rule the
    // trade documents follow, applied in exactly one place.
    broker: input.broker ?? LEGACY_BROKER,
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

export async function loadNonterminalBoxOrderIntents(): Promise<BoxOrderIntentRecord[]> {
  if (!isBoxDbEnabled()) {
    throw new Error("Box persistence is unavailable while loading nonterminal live order intents.");
  }
  // Safety-critical reconciliation must never silently omit an unresolved row.
  return BoxOrderIntent.find({ state: { $in: NONTERMINAL_ORDER_STATES } })
    .sort({ updated_at: 1 })
    .lean<BoxOrderIntentRecord[]>();
}

/**
 * Count unresolved LIVE order intents belonging to ONE broker.
 *
 * BROKER-SCOPED ON PURPOSE. Dhan order ids and Zerodha order ids are unrelated
 * identifier spaces, so an intent can only ever be reconciled through the broker that
 * created it. A cross-broker lookup would either 404 (and be misread as "the order
 * never existed", losing real exposure) or — far worse — collide with an unrelated
 * real order at the other broker.
 *
 * The broker-switch guard uses this to refuse leaving a broker that still has
 * unresolved intents, because after the switch its adapter no longer exists.
 *
 * Legacy intents have no `broker` field and are Zerodha's, so a "zerodha" query must
 * also match documents where the field is absent.
 */
export async function countUnresolvedBoxOrderIntentsForBroker(broker: string): Promise<number> {
  if (!isBoxDbEnabled()) return 0;
  const brokerFilter =
    broker === "zerodha"
      ? { $or: [{ broker: "zerodha" }, { broker: { $exists: false } }, { broker: null }] }
      : { broker };
  return BoxOrderIntent.countDocuments({
    broker_mode: "live",
    state: { $in: NONTERMINAL_ORDER_STATES },
    ...brokerFilter,
  });
}

export async function loadOwnedBoxOrderIntents(): Promise<BoxOrderIntentRecord[]> {
  if (!isBoxDbEnabled()) {
    throw new Error("Box persistence is unavailable while loading owned live order intents.");
  }
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
 *
 * THE RESULT IS THE AUTHORITATIVE TRANSITION, not just the resulting document.
 *
 * Callers attribute broker fills to internal positions. If they derive the delta from their own
 * in-memory snapshot they double-count, because two async contexts routinely hold the SAME stale
 * snapshot for one order (the live submit path and a concurrent reconcile pass), so both compute
 * `post - 0` for a single 40-lot fill and attribute 80. The `$lte` fill guard does not save them:
 * it is deliberately NON-strict, so re-writing the same cumulative quantity matches and reports
 * `applied: true`.
 *
 * So the write reports what it actually established:
 *
 *   delta = current_filled_quantity - previous_filled_quantity      (and 0 when applied is false)
 *
 * which is 0 for a duplicate replay and exactly the real increment for whichever caller won.
 */
export interface BoxOrderIntentUpdateResult {
  intent: BoxOrderIntentRecord | null;
  applied: boolean;
  /** Cumulative filled quantity this document held before this update. Null when unknowable. */
  previous_filled_quantity: number | null;
  /** Cumulative filled quantity this document holds after this update. Null when unknowable. */
  current_filled_quantity: number | null;
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
        // THE PRE-IMAGE, captured by the same atomic write. Every expression in an aggregation
        // `$set` stage is evaluated against the INPUT document, so `$filled_quantity` here is the
        // value before `setPatch` replaces it — even though both are set in one stage. This is
        // what makes the reported delta a property of the durable transition rather than of
        // whatever the caller happened to have in memory.
        previous_filled_quantity: { $ifNull: ["$filled_quantity", 0] },
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
    // The guard refused (stale state, regressing fill, or a conflicting broker id). Nothing was
    // written, so the transition this call established is EMPTY: report an explicit zero-width
    // transition rather than a null the caller might read as "unknown, guess from my snapshot".
    const fresh = await findBoxOrderIntentByClientId(clientOrderId);
    const current = typeof fresh?.filled_quantity === "number" ? fresh.filled_quantity : null;
    return {
      intent: fresh,
      applied: false,
      previous_filled_quantity: current,
      current_filled_quantity: current,
    };
  }
  return {
    intent: row,
    applied: true,
    previous_filled_quantity: typeof row.previous_filled_quantity === "number"
      ? row.previous_filled_quantity
      : null,
    current_filled_quantity: typeof row.filled_quantity === "number" ? row.filled_quantity : null,
  };
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
export async function resolveBoxExecutionAttempt(
  id: string,
  /** Charges incurred by the final flatten pass (a delta). Applied atomically with resolution. */
  flattenChargeDelta?: number,
): Promise<boolean> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return false;
  const update: Record<string, unknown> = { $set: { resolved: true, residual_exposure: [] } };
  if (flattenChargeDelta !== undefined && flattenChargeDelta > 0) {
    update.$inc = { flatten_charges: round2Repo(flattenChargeDelta) };
  }
  const result = await BoxExecutionAttempt.updateOne({ _id: id }, update);
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
  /**
   * Charges incurred by THIS flatten pass (a delta, not a running total).
   *
   * Applied with `$inc` in the SAME update as the residual projection, so the cost and the quantity
   * it paid for are recorded atomically: a pass can never leave one written without the other, and
   * retrying an unacknowledged update cannot double-charge because it applied wholly or not at all.
   */
  flattenChargeDelta?: number,
): Promise<boolean> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return false;
  const resolved = residual.length === 0;
  const update: Record<string, unknown> = {
    $set: { residual_exposure: resolved ? [] : residual, resolved },
  };
  if (flattenChargeDelta !== undefined && flattenChargeDelta > 0) {
    update.$inc = { flatten_charges: round2Repo(flattenChargeDelta) };
  }
  const result = await BoxExecutionAttempt.updateOne({ _id: id }, update);
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
  if (!isBoxDbEnabled()) {
    throw new Error("Box persistence is unavailable while loading the live daily-risk seed.");
  }
  const [trades, attempts, rejectedCount, recentIntents] = await Promise.all([
    BoxTrade.find({ closed_at: { $gte: new Date(sinceMs) } })
      .select({ realised_net_pnl: 1, net_pnl: 1 })
      .lean<Array<{ realised_net_pnl?: number | null; net_pnl?: number | null }>>(),
    BoxExecutionAttempt.find({ resolved_at: { $gte: new Date(sinceMs) } })
      .select({ net_abort_pnl: 1, flatten_charges: 1 })
      .lean<Array<{ net_abort_pnl?: number | null; flatten_charges?: number | null }>>(),
    BoxOrderIntent.countDocuments({ state: "REJECTED", updated_at: { $gte: new Date(sinceMs) } }),
    BoxOrderIntent.find({ updated_at: { $gte: new Date(sinceMs) } })
      .select({ state: 1 })
      .sort({ updated_at: -1 })
      .lean<Array<{ state: BoxOrderIntentState }>>(),
  ]);
  const tradePnl = trades.reduce((sum, trade) => sum + (trade.realised_net_pnl ?? trade.net_pnl ?? 0), 0);
  // `net_abort_pnl` deliberately EXCLUDES the cost of flattening residual exposure, which is
  // accumulated separately in `flatten_charges`. In-session the engine charges those against the
  // daily loss limit as they are paid (`noteFlattenCharges` → `recordRealisedPnl(-charges)`), so
  // omitting them here made the restart seed strictly more optimistic than the live counter it
  // replaces: after a restart the day looked BETTER by the whole sum of flatten charges, and live
  // entry could stay enabled with the true realised loss already past the limit. A risk seed that
  // errs generous is the one direction it must never err in.
  const abortPnl = attempts.reduce(
    (sum, attempt) => sum + (attempt.net_abort_pnl ?? 0) - Math.max(0, attempt.flatten_charges ?? 0),
    0,
  );
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
 * Generic pre/write/post handshake used by the production Mongo writer and race
 * tests. The second permission check closes the cleanup-before-write ordering.
 */
export async function runSourceSafePnlRowUpsert(args: {
  allowed: () => Promise<boolean>;
  write: () => Promise<void>;
  remove: () => Promise<void>;
  rewriteSummary: () => Promise<void>;
}): Promise<"skipped" | "written" | "self_cleaned"> {
  if (!(await args.allowed())) return "skipped";
  await args.write();
  if (await args.allowed()) return "written";
  await args.remove();
  await args.rewriteSummary();
  return "self_cleaned";
}

/**
 * Invalidate completeness without erasing the last exact proof. Retaining v2
 * metadata is what lets periodic repair distinguish a same-membership late write
 * from an uncertifiable partial generation after a crash.
 */
export async function markBoxDailyPnlIncomplete(
  day: string,
  needsReproof = true,
): Promise<void> {
  if (!isBoxDbEnabled()) throw new Error("Box persistence is not available.");
  await BoxPnlDayState.updateOne(
    { _id: day },
    {
      $set: { complete: false, needs_reproof: needsReproof, updated_at: new Date() },
      $setOnInsert: { _id: day },
    },
    { upsert: true },
  );
}

export function boxPnlDayProofFromState(state: {
  snapshot_version?: number;
  row_count?: number;
  content_sha256?: string;
}): BoxPnlDayProof | null {
  return state.snapshot_version === 2 && Number.isInteger(state.row_count) &&
    (state.row_count ?? -1) >= 0 && /^[a-f0-9]{64}$/.test(state.content_sha256 ?? "")
    ? {
        snapshot_version: 2,
        row_count: state.row_count!,
        content_sha256: state.content_sha256!,
      }
    : null;
}

/**
 * Testable pre/publish/post protocol. Both reads compare full canonical content,
 * so an update to an existing trade id cannot be hidden by unchanged membership.
 */
export async function runBoxPnlDayProofCommit(args: {
  expected: IBoxDailyPnl[];
  settle: () => Promise<void>;
  load: () => Promise<IBoxDailyPnl[]>;
  publish: (proof: BoxPnlDayProof) => Promise<void>;
  invalidate: () => Promise<void>;
}): Promise<BoxPnlDayProof> {
  const expectedProof = buildBoxPnlDayProof(args.expected);
  const matches = (docs: IBoxDailyPnl[]) =>
    boxPnlSummaryMatchesRows(docs) &&
    boxPnlDayProofsEqual(expectedProof, buildBoxPnlDayProof(docs));
  try {
    await args.settle();
    if (!matches(await args.load())) {
      throw new Error("day content changed before completion proof publication");
    }
    await args.publish(expectedProof);
    if (!matches(await args.load())) {
      throw new Error("day content changed while publishing completion proof");
    }
    return expectedProof;
  } catch (err) {
    await args.invalidate();
    throw err;
  }
}

/**
 * Re-proof durable content only when its row cardinality is still the exact
 * membership count authorized by the prior proof (or by explicit deletion
 * cleanup). Content may change for the same IDs; partial generations may not be
 * promoted merely because their rows and summary are internally consistent.
 */
export async function runBoxPnlDayProofRepair(args: {
  lastExactProof: BoxPnlDayProof;
  expectedRowCount: number;
  settle: () => Promise<void>;
  load: () => Promise<IBoxDailyPnl[]>;
  validate: (docs: IBoxDailyPnl[]) => Promise<void>;
  publish: (lastExactProof: BoxPnlDayProof, nextProof: BoxPnlDayProof) => Promise<void>;
  markRetry: () => Promise<void>;
}): Promise<BoxPnlDayProof> {
  const loadValid = async (requireSummary: boolean): Promise<{
    docs: IBoxDailyPnl[];
    proof: BoxPnlDayProof;
  }> => {
    const docs = await args.load();
    await args.validate(docs);
    const proof = buildBoxPnlDayProof(docs);
    if (proof.row_count !== args.expectedRowCount) {
      throw new Error(
        `day membership count ${proof.row_count} differs from last exact row_count ` +
        `${args.expectedRowCount}`,
      );
    }
    if (requireSummary && !boxPnlSummaryMatchesRows(docs)) {
      throw new Error("day summary does not match rows during re-proof");
    }
    return { docs, proof };
  };

  try {
    await loadValid(false);
    await args.settle();
    const before = await loadValid(true);
    await args.publish(args.lastExactProof, before.proof);
    const after = await loadValid(true);
    if (!boxPnlDayProofsEqual(before.proof, after.proof)) {
      throw new Error("day content changed while publishing repaired proof");
    }
    return after.proof;
  } catch (err) {
    await args.markRetry();
    throw err;
  }
}

/**
 * Safely upgrade a legacy ID-only manifest. The old manifest is evidence of the
 * expected generation, never proof by itself: durable rows are settled, source-
 * validated, compared exactly, then reloaded after v2 proof publication.
 */
export async function runLegacyBoxPnlDayMigration(args: {
  expectedTradeIds: unknown;
  settleAndLoad: () => Promise<IBoxDailyPnl[]>;
  filterSourceValidExpectedIds: (ids: string[]) => Promise<string[]>;
  publishV2: (docs: IBoxDailyPnl[]) => Promise<void>;
  loadPublished: () => Promise<{
    docs: IBoxDailyPnl[];
    state: { snapshot_version?: number; row_count?: number; content_sha256?: string } | null;
  }>;
  finalizeV2: (proof: BoxPnlDayProof) => Promise<void>;
  markRetry: () => Promise<void>;
}): Promise<boolean> {
  try {
    if (!Array.isArray(args.expectedTradeIds) ||
        args.expectedTradeIds.some((id) =>
          typeof id !== "string" || id.length === 0 || id === SUMMARY_FIELD) ||
        new Set(args.expectedTradeIds).size !== args.expectedTradeIds.length) {
      throw new Error("legacy day manifest contains invalid or duplicate trade ids");
    }
    const expectedIds = args.expectedTradeIds as string[];
    const sourceValidExpected = [...new Set(
      await args.filterSourceValidExpectedIds(expectedIds),
    )].sort();
    const settled = await args.settleAndLoad();
    const settledIds = settled
      .filter((doc) => doc.trade_id !== SUMMARY_FIELD)
      .map((doc) => doc.trade_id)
      .sort();
    if (new Set(settledIds).size !== settledIds.length ||
        settledIds.length !== sourceValidExpected.length ||
        settledIds.some((id, index) => id !== sourceValidExpected[index]) ||
        !boxPnlSummaryMatchesRows(settled)) {
      throw new Error("source-valid durable rows do not match the legacy day manifest");
    }

    await args.publishV2(settled);
    const published = await args.loadPublished();
    const proof = published.state ? boxPnlDayProofFromState(published.state) : null;
    if (proof === null || !boxPnlSummaryMatchesRows(published.docs) ||
        !boxPnlDayProofsEqual(proof, buildBoxPnlDayProof(published.docs))) {
      throw new Error("v2 day proof did not remain stable after publication");
    }
    await args.finalizeV2(proof);
    return true;
  } catch {
    await args.markRetry();
    return false;
  }
}

async function migrateLegacyBoxDailyPnlState(
  day: string,
  expectedTradeIds: unknown,
): Promise<boolean> {
  return runLegacyBoxPnlDayMigration({
    expectedTradeIds,
    filterSourceValidExpectedIds: async (ids) => {
      const invalid = new Set(await invalidArchivedTradeIds(ids));
      return ids.filter((id) => !invalid.has(id));
    },
    settleAndLoad: async () => {
      await rewriteBoxDailyPnlSummary(day);
      return loadBoxDailyPnlSnapshot(day);
    },
    publishV2: async (docs) => {
      const ids = docs
        .filter((doc) => doc.trade_id !== SUMMARY_FIELD)
        .map((doc) => doc.trade_id);
      if ((await invalidArchivedTradeIds(ids)).length > 0) {
        throw new Error(`box_daily_pnl legacy day ${day} changed during source validation`);
      }
      const proof = buildBoxPnlDayProof(docs);
      await BoxPnlDayState.updateOne(
        { _id: day, expected_trade_ids: { $exists: true } },
        {
          $set: { complete: true, needs_reproof: false, ...proof, updated_at: new Date() },
        },
      );
    },
    loadPublished: async () => ({
      docs: await loadBoxDailyPnlSnapshot(day),
      state: await BoxPnlDayState.findById(day)
        .select({ snapshot_version: 1, row_count: 1, content_sha256: 1 })
        .lean<{ snapshot_version?: number; row_count?: number; content_sha256?: string }>(),
    }),
    finalizeV2: async (proof) => {
      const result = await BoxPnlDayState.updateOne(
        { _id: day, ...proof, expected_trade_ids: { $exists: true } },
        { $unset: { expected_trade_ids: 1 } },
      );
      if ((result.matchedCount ?? 0) !== 1) {
        throw new Error(`box_daily_pnl legacy day ${day} changed before migration finalization`);
      }
    },
    // Preserve the v1 manifest so transient failures can retry safely. It is
    // removed only by the successful v2 publication.
    markRetry: async () => {
      await BoxPnlDayState.updateOne(
        { _id: day, expected_trade_ids: { $exists: true } },
        { $set: { needs_reproof: true, updated_at: new Date() } },
      );
    },
  });
}

/** Commit a fixed-size exact-content proof after rows and summary settle. */
export async function markBoxDailyPnlComplete(
  day: string,
  expectedDocs: IBoxDailyPnl[],
): Promise<void> {
  if (!isBoxDbEnabled()) throw new Error("Box persistence is not available.");
  const expectedIds = expectedDocs
    .filter((doc) => doc.trade_id !== SUMMARY_FIELD)
    .map((doc) => doc.trade_id);
  if ((await invalidArchivedTradeIds(expectedIds)).length > 0) {
    await markBoxDailyPnlIncomplete(day, true);
    throw new Error(`box_daily_pnl day ${day} contains a deleted source row`);
  }

  await runBoxPnlDayProofCommit({
    expected: expectedDocs,
    settle: async () => { await rewriteBoxDailyPnlSummary(day); },
    load: async () => {
      const docs = await loadBoxDailyPnlSnapshot(day);
      const ids = docs
        .filter((doc) => doc.trade_id !== SUMMARY_FIELD)
        .map((doc) => doc.trade_id);
      if ((await invalidArchivedTradeIds(ids)).length > 0) {
        throw new Error(`box_daily_pnl day ${day} changed during source validation`);
      }
      return docs;
    },
    publish: async (proof) => {
      await BoxPnlDayState.updateOne(
        { _id: day },
        {
          $set: { complete: true, needs_reproof: false, ...proof, updated_at: new Date() },
          $unset: { expected_trade_ids: 1 },
          $setOnInsert: { _id: day },
        },
        { upsert: true },
      );
    },
    invalidate: () => markBoxDailyPnlIncomplete(day, true),
  });
}

/** Validate a durable day generation, migrating a complete legacy manifest safely. */
export async function isBoxDailyPnlSnapshotComplete(
  day: string,
  docs: IBoxDailyPnl[],
): Promise<boolean> {
  if (!isBoxDbEnabled()) return false;
  const state = await BoxPnlDayState.findById(day).lean<{
    complete?: boolean;
    snapshot_version?: number;
    row_count?: number;
    content_sha256?: string;
    expected_trade_ids?: string[];
  }>();
  if (!state?.complete) return false;
  const proof = boxPnlDayProofFromState(state);
  if (!proof) {
    if (Array.isArray(state.expected_trade_ids)) {
      // Never trust the v1 membership list directly. Migration settles and
      // source-validates Mongo, regenerates the summary, and publishes v2.
      return migrateLegacyBoxDailyPnlState(day, state.expected_trade_ids);
    }
    await markBoxDailyPnlIncomplete(day);
    return false;
  }
  const matches = boxPnlSummaryMatchesRows(docs) &&
    boxPnlDayProofsEqual(proof, buildBoxPnlDayProof(docs));
  if (!matches) await markBoxDailyPnlRetryIfProof(day, proof);
  return matches;
}

/**
 * Upsert one archived P&L row with a durable source-existence handshake.
 *
 * A trade row is admitted only when its source exists and no deletion fence is
 * present, then checked again after the write. Thus cleanup wins when it runs
 * after us, while writer self-cleanup wins when cleanup ran between our checks.
 * A crash between write and post-check is repaired by startup orphan scanning.
 * Summary payloads are never trusted directly; they are regenerated from settled
 * durable survivor rows.
 */
export async function upsertBoxDailyPnl(doc: IBoxDailyPnl): Promise<void> {
  if (!isBoxDbEnabled()) throw new Error("Box persistence is not available.");
  if (doc.trade_id === SUMMARY_FIELD) {
    await rewriteBoxDailyPnlSummary(doc.day);
    return;
  }

  const allowed = async () => (await invalidArchivedTradeIds([doc.trade_id])).length === 0;
  await runSourceSafePnlRowUpsert({
    allowed,
    write: async () => {
      await mutateDurablePnlDay(doc.day, async () => {
        await BoxDailyPnl.updateOne(
          { day: doc.day, trade_id: doc.trade_id },
          { $set: { ...doc, archived_at: new Date() } },
          { upsert: true },
        );
      });
    },
    remove: async () => {
      await mutateDurablePnlDay(doc.day, async () => {
        await BoxDailyPnl.deleteOne({ day: doc.day, trade_id: doc.trade_id });
      });
    },
    rewriteSummary: async () => { await rewriteBoxDailyPnlSummary(doc.day); },
  });
}

/** The persisted documents for an exact day. Errors deliberately propagate. */
export async function loadBoxDailyPnlSnapshot(day: string): Promise<BoxDailyPnlRecord[]> {
  if (!isBoxDbEnabled()) throw new Error("Box persistence is not available.");
  return BoxDailyPnl.find({ day }).lean<BoxDailyPnlRecord[]>();
}

/** The trade ids already archived for a day (compatibility helper). */
export async function loadBoxDailyPnlTradeIds(day: string): Promise<string[]> {
  const rows = await loadBoxDailyPnlSnapshot(day);
  return rows.map((row) => row.trade_id);
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

/* ------------------- execution-latency calibration samples ------------------- */

/**
 * Persist a BATCH of measured execution-latency observations.
 *
 * Called only from the bounded async buffer ({@link ./calibrationPersistence}), never from the
 * order path — the whole point of that buffer is that no order ever waits on this write.
 *
 * `insertMany` with `ordered: false` so one malformed row cannot discard the rest of the batch.
 * Contains only latency numbers and dimension labels; no credentials or position data.
 */
export async function persistBoxCalibrationSamples(
  batch: readonly {
    broker: string;
    kind: string;
    profile: string;
    bucket: string;
    stage: string;
    valueMs: number;
    session?: string | undefined;
    atWall: number;
  }[],
  region: string | null,
): Promise<void> {
  if (!isBoxDbEnabled() || batch.length === 0) return;
  await BoxCalibrationSample.insertMany(
    batch.map((sample) => ({
      broker: sample.broker,
      kind: sample.kind,
      profile: sample.profile,
      bucket: sample.bucket,
      stage: sample.stage,
      value_ms: round2Repo(sample.valueMs),
      session: sample.session ?? "",
      region,
      observed_at: new Date(sample.atWall),
    })),
    { ordered: false },
  );
}

/**
 * Load recent persisted observations so calibration survives a restart.
 *
 * Region-scoped, because two deployments have different physical round-trip times to the broker and
 * a merged distribution would describe neither. Bounded by both age and a hard row cap, so startup
 * cost stays predictable however long the collection has been accumulating.
 */
export async function loadBoxCalibrationSamples(args: {
  region: string | null;
  maxAgeMs: number;
  limit?: number;
}): Promise<Array<{
  broker: string;
  kind: string;
  profile: string;
  bucket: string;
  stage: string;
  valueMs: number;
  session: string;
  atWall: number;
}>> {
  if (!isBoxDbEnabled()) return [];
  const cutoff = new Date(Date.now() - Math.max(0, args.maxAgeMs));
  const rows = await BoxCalibrationSample.find({
    region: args.region,
    observed_at: { $gte: cutoff },
  })
    .sort({ observed_at: 1 })
    .limit(Math.max(1, Math.floor(args.limit ?? 50_000)))
    .lean<Array<Record<string, unknown>>>();
  return rows.map((row) => ({
    broker: String(row.broker),
    kind: String(row.kind),
    profile: String(row.profile),
    bucket: String(row.bucket),
    stage: String(row.stage),
    valueMs: Number(row.value_ms),
    session: String(row.session ?? ""),
    atWall: row.observed_at instanceof Date ? row.observed_at.getTime() : Number(row.observed_at),
  }));
}
