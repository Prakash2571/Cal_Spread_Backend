/**
 * ONE-SHOT / BOUNDED-CYCLE TRADING SESSION.
 *
 * `BOX_SESSION_MAX_COMPLETED_TRADES` bounds how many COMPLETE BOX LIFECYCLES an armed
 * trading session may run:
 *
 *     0 = unlimited (the default, so existing deployments are unaffected)
 *     1 = one-shot
 *     N = N cycles
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * WHAT "ONE TRADE" MEANS
 * ────────────────────────────────────────────────────────────────────────────────────────
 *
 * ONE COMPLETE LIFECYCLE:  ENTRY → HOLD/MONITOR → EXIT → FLAT.
 *
 * It does NOT mean "one broker order", and it emphatically does not mean "stop the engine
 * after the entry". After the single entry the engine must keep doing everything that
 * reduces or accounts for the exposure it just took on: monitoring, auto-exit, partial-exit
 * cleanup, residual flattening, reconciliation and recovery all continue untouched. Only NEW
 * ENTRY is disabled.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * THE TWO COUNTERS, AND WHY THERE ARE TWO
 * ────────────────────────────────────────────────────────────────────────────────────────
 *
 * A single "completed" counter cannot express one-shot correctly. With max=1, the moment the
 * first Box opens its lifecycle is not yet complete, so a completed-count of 0 would still
 * permit a second entry — the exact bug the feature exists to prevent. So the session tracks
 * two append-only, idempotent sets of trade ids:
 *
 *   ESTABLISHED — a full four-leg Box was opened. A cycle is CONSUMED here.
 *                 This is what gates new entry: `consumed >= max` ⇒ no more entries, ever,
 *                 for this session.
 *
 *   COMPLETED   — that same Box later became fully FLAT. This is what makes the session
 *                 report `COMPLETED`.
 *
 * `consumed` is therefore always >= `completed`, and the gap is "cycles currently in flight".
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * WHAT MUST **NOT** CONSUME A CYCLE
 * ────────────────────────────────────────────────────────────────────────────────────────
 *
 * A rejected, refused, partially-filled-then-unwound, or `abort_after_fill` entry NEVER
 * establishes a Box, so it never consumes a cycle. Burning an operator's single permitted
 * trade on an attempt that ended with no position would be indefensible. Aborted attempts
 * are counted separately, for visibility only, in {@link BoxSessionRecord.aborted_attempts}.
 *
 * Note the ordering consequence this creates and which the engine must honour: a cycle is
 * recorded as established only from the SUCCESSFUL-OPEN path, after the four-leg Box is a
 * real persisted position — never from the entry-attempt path.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * RESTART SAFETY
 * ────────────────────────────────────────────────────────────────────────────────────────
 *
 * The record is DURABLE. A Node restart must never look like a reset, because "restart the
 * process to get another trade" would make the whole control decorative. Two mechanisms:
 *
 *   1. Boot LOADS the existing session; it never auto-arms and never zeroes a counter.
 *   2. {@link reconcileCompletions} closes cycles that went flat while the process was down,
 *      by re-reading durable trade state for every established-but-not-completed id. So a
 *      completion cannot be lost either.
 *
 * A counter is only ever reset by an explicit operator arm/reset, and {@link canArm} refuses
 * even that while a consumed cycle still has live exposure — otherwise re-arming would be a
 * one-click bypass of the very limit that was configured.
 *
 * This module is PURE. It owns no I/O and no clock; the caller supplies `now` and persists
 * the record through its own store.
 */

/** Explicit, reportable session lifecycle state. */
export type BoxSessionState =
  /** Never armed, or deliberately disarmed. No entry permitted. */
  | "IDLE"
  /** Armed and permitted to enter. */
  | "ARMED"
  /** An entry pipeline is running right now. */
  | "ENTRY_IN_PROGRESS"
  /** At least one established Box is open and being monitored. */
  | "POSITION_OPEN"
  /** An exit is in flight for an established Box. */
  | "EXIT_IN_PROGRESS"
  /** Every permitted cycle has been consumed AND is fully flat. Terminal for the session. */
  | "COMPLETED"
  /** Armed, but something is blocking new entry (limit reached, gate closed, …). */
  | "BLOCKED"
  /** Exposure is quarantined pending reconciliation. Entry is closed; reduction is not. */
  | "RECOVERY";

/** The durable session record. */
export interface BoxSessionRecord {
  /** Unique per ARM. A new arm is a new session, which is what makes reset deliberate. */
  readonly session_id: string;
  readonly armed_at: number | null;
  /** Admin actor label that armed it. Never a token; a role/name only. */
  readonly armed_by: string | null;
  /**
   * The limit SNAPSHOT taken at arm time.
   *
   * Snapshotted, not re-read from config, so that changing the env var and restarting
   * cannot retroactively widen a session an operator already armed under a tighter limit.
   */
  readonly max_completed_trades: number;
  /** Trade ids that established a full four-leg Box. Append-only, deduplicated. */
  readonly established_trade_ids: readonly string[];
  /** Trade ids from `established_trade_ids` that later became fully FLAT. */
  readonly completed_trade_ids: readonly string[];
  /** Entry attempts that ended with no Box. Visibility only; never gates anything. */
  readonly aborted_attempts: number;
  /** How many times an operator has explicitly re-armed. Monotonic; audit aid. */
  readonly arm_count: number;
  readonly updated_at: number;
}

/** A fresh, unarmed session record. */
export function idleSessionRecord(now: number): BoxSessionRecord {
  return {
    session_id: "",
    armed_at: null,
    armed_by: null,
    max_completed_trades: 0,
    established_trade_ids: [],
    completed_trade_ids: [],
    aborted_attempts: 0,
    arm_count: 0,
    updated_at: now,
  };
}

/** Is this record armed? An empty `session_id` is the canonical unarmed marker. */
export function isArmed(record: BoxSessionRecord): boolean {
  return record.session_id !== "" && record.armed_at !== null;
}

/** Cycles consumed: a Box was established. This is the number that gates new entry. */
export function consumedCycles(record: BoxSessionRecord): number {
  return record.established_trade_ids.length;
}

/** Cycles finished: an established Box reached FLAT. */
export function completedCycles(record: BoxSessionRecord): number {
  return record.completed_trade_ids.length;
}

/**
 * Cycles still permitted.
 *
 * `null` means UNLIMITED (`max_completed_trades === 0`) and is deliberately not `Infinity`
 * so it serialises to JSON honestly for the status endpoint.
 */
export function remainingCycles(record: BoxSessionRecord): number | null {
  if (record.max_completed_trades <= 0) return null;
  return Math.max(0, record.max_completed_trades - consumedCycles(record));
}

/** True when the session's cycle budget is exhausted. Unlimited sessions are never exhausted. */
export function isBudgetExhausted(record: BoxSessionRecord): boolean {
  if (record.max_completed_trades <= 0) return false;
  return consumedCycles(record) >= record.max_completed_trades;
}

/** The reason new entry is refused by the session layer, or null when it permits entry. */
export type BoxSessionBlockReason =
  | "session_not_armed"
  | "session_budget_exhausted"
  | "session_recovery";

/**
 * The session layer's ENTRY verdict.
 *
 * ENTRY ONLY. This is never consulted for an exit, a protective cancel, a residual flatten
 * or a reconciliation-driven reduction — a consumed session budget must never be a reason an
 * already-owned position cannot be closed.
 */
export function evaluateSessionEntry(args: {
  readonly record: BoxSessionRecord;
  readonly recoveryActive: boolean;
}): { readonly allowed: boolean; readonly reason: BoxSessionBlockReason | null; readonly detail: string | null } {
  if (args.recoveryActive) {
    return {
      allowed: false,
      reason: "session_recovery",
      detail: "exposure is quarantined pending reconciliation; new entry is closed while reduction stays open",
    };
  }
  if (!isArmed(args.record)) {
    return {
      allowed: false,
      reason: "session_not_armed",
      detail: "no trading session is armed; arm a session before new entry is permitted",
    };
  }
  if (isBudgetExhausted(args.record)) {
    const max = args.record.max_completed_trades;
    return {
      allowed: false,
      reason: "session_budget_exhausted",
      detail:
        `BOX_SESSION_MAX_COMPLETED_TRADES=${max} and ${consumedCycles(args.record)} cycle(s) have been ` +
        "consumed by this session. Monitoring, exit, residual flattening and reconciliation continue; " +
        "only new entry is refused.",
    };
  }
  return { allowed: true, reason: null, detail: null };
}

/** Live activity flags the state derivation needs. Supplied by the engine. */
export interface BoxSessionActivity {
  readonly entryInProgress: boolean;
  readonly openBoxes: number;
  readonly exitInProgress: boolean;
  readonly recoveryActive: boolean;
  /** Any non-session reason entry is currently refused (gate closed, circuit open, …). */
  readonly entryBlockedExternally: boolean;
}

/**
 * Derive the reportable session state.
 *
 * Ordering is deliberate and safety-first: RECOVERY outranks everything, then genuine
 * activity (which must remain visible even after the budget is spent, because the operator
 * needs to see that a position is still open), then COMPLETED, then BLOCKED, then ARMED.
 *
 * `COMPLETED` is asserted only when the budget is exhausted AND every consumed cycle is
 * flat, so a session can never look finished while it still owns exposure.
 */
export function deriveSessionState(record: BoxSessionRecord, activity: BoxSessionActivity): BoxSessionState {
  if (activity.recoveryActive) return "RECOVERY";
  if (!isArmed(record)) return "IDLE";
  if (activity.exitInProgress) return "EXIT_IN_PROGRESS";
  if (activity.openBoxes > 0) return "POSITION_OPEN";
  if (activity.entryInProgress) return "ENTRY_IN_PROGRESS";
  if (isBudgetExhausted(record) && completedCycles(record) >= consumedCycles(record)) return "COMPLETED";
  if (activity.entryBlockedExternally) return "BLOCKED";
  return "ARMED";
}

/**
 * May an operator arm (or re-arm) right now?
 *
 * Re-arming resets the cycle counters, so it is the one legitimate way to clear a consumed
 * one-shot budget — and therefore the most attractive bypass. It is refused while any
 * consumed cycle still has live exposure: otherwise "arm again" would be a one-click way to
 * run a second Box while the first is still open, defeating the limit entirely.
 *
 * A session whose cycles are ALL flat may be re-armed freely: that is a deliberate operator
 * decision to trade again, made with the previous cycle fully accounted for.
 */
export function canArm(args: {
  readonly record: BoxSessionRecord;
  readonly openBoxes: number;
  readonly residualLegs: number;
  readonly recoveryActive: boolean;
}): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (args.recoveryActive) {
    return { ok: false, reason: "exposure is quarantined pending reconciliation; resolve recovery before arming" };
  }
  if (args.openBoxes > 0) {
    return { ok: false, reason: `${args.openBoxes} Box position(s) are still open; arming now would bypass the cycle limit` };
  }
  if (args.residualLegs > 0) {
    return { ok: false, reason: `${args.residualLegs} residual leg(s) are unresolved; flatten them before arming` };
  }
  const inFlight = consumedCycles(args.record) - completedCycles(args.record);
  if (inFlight > 0) {
    return { ok: false, reason: `${inFlight} consumed cycle(s) have not reached FLAT; arming now would bypass the cycle limit` };
  }
  return { ok: true };
}

/** Arm a new session. The caller must have checked {@link canArm} first. */
export function armSession(args: {
  readonly sessionId: string;
  readonly maxCompletedTrades: number;
  readonly armedBy: string | null;
  readonly previous: BoxSessionRecord;
  readonly now: number;
}): BoxSessionRecord {
  const max = Number.isFinite(args.maxCompletedTrades) ? Math.max(0, Math.floor(args.maxCompletedTrades)) : 0;
  return {
    session_id: args.sessionId,
    armed_at: args.now,
    armed_by: args.armedBy,
    max_completed_trades: max,
    established_trade_ids: [],
    completed_trade_ids: [],
    aborted_attempts: 0,
    arm_count: args.previous.arm_count + 1,
    updated_at: args.now,
  };
}

/**
 * Disarm. Counters are PRESERVED, not cleared.
 *
 * Disarming is "stop entering", not "forget what happened". Clearing the counters here would
 * make disarm-then-arm a silent reset that skipped {@link canArm}'s exposure guard.
 */
export function disarmSession(record: BoxSessionRecord, now: number): BoxSessionRecord {
  return { ...record, armed_at: null, updated_at: now };
}

/**
 * Record that a full four-leg Box was established. CONSUMES a cycle.
 *
 * Idempotent by trade id: replaying the same establishment (a retry, a reconciliation, a
 * double broadcast) must not consume two cycles.
 */
export function recordEstablishedBox(record: BoxSessionRecord, tradeId: string, now: number): BoxSessionRecord {
  if (!tradeId) return record;
  if (record.established_trade_ids.includes(tradeId)) return record;
  return {
    ...record,
    established_trade_ids: [...record.established_trade_ids, tradeId],
    updated_at: now,
  };
}

/**
 * Record that an established Box became fully FLAT. COMPLETES a cycle.
 *
 * Refuses to complete a trade id that was never established: that would let an unrelated
 * closed trade (a manual close of an adopted position from a previous session, say) count
 * towards this session's budget. Idempotent by trade id.
 */
export function recordCompletedBox(record: BoxSessionRecord, tradeId: string, now: number): BoxSessionRecord {
  if (!tradeId) return record;
  if (!record.established_trade_ids.includes(tradeId)) return record;
  if (record.completed_trade_ids.includes(tradeId)) return record;
  return {
    ...record,
    completed_trade_ids: [...record.completed_trade_ids, tradeId],
    updated_at: now,
  };
}

/** Record an entry attempt that ended with no Box. Visibility only; consumes nothing. */
export function recordAbortedAttempt(record: BoxSessionRecord, now: number): BoxSessionRecord {
  return { ...record, aborted_attempts: record.aborted_attempts + 1, updated_at: now };
}

/**
 * Close out cycles that reached FLAT while this process was not running.
 *
 * Called at boot with the durable status of every established-but-not-completed trade id.
 * Without this, a Box that was exited during a deploy would stay "in flight" forever and the
 * session would never report COMPLETED — and {@link canArm} would refuse to arm again on the
 * strength of exposure that no longer exists.
 *
 * `flatTradeIds` must be derived from the same authoritative predicate the engine uses for
 * flatness, not from a heuristic.
 */
export function reconcileCompletions(
  record: BoxSessionRecord,
  flatTradeIds: readonly string[],
  now: number,
): BoxSessionRecord {
  let next = record;
  for (const tradeId of flatTradeIds) next = recordCompletedBox(next, tradeId, now);
  return next;
}

/** Established cycles that have not yet reached FLAT. */
export function inFlightCycleIds(record: BoxSessionRecord): readonly string[] {
  const completed = new Set(record.completed_trade_ids);
  return record.established_trade_ids.filter((id) => !completed.has(id));
}

/** The status projection. No secrets, bounded size, stable key names. */
export function sessionStatus(
  record: BoxSessionRecord,
  activity: BoxSessionActivity,
  blockReason: BoxSessionBlockReason | string | null,
): {
  state: BoxSessionState;
  session_id: string | null;
  armed: boolean;
  armed_at: number | null;
  armed_by: string | null;
  max_completed_trades: number;
  completed_trades: number;
  consumed_cycles: number;
  remaining_trades: number | null;
  current_trade_id: string | null;
  in_flight_trade_ids: readonly string[];
  aborted_attempts: number;
  arm_count: number;
  block_reason: string | null;
} {
  const inFlight = inFlightCycleIds(record);
  return {
    state: deriveSessionState(record, activity),
    session_id: record.session_id === "" ? null : record.session_id,
    armed: isArmed(record),
    armed_at: record.armed_at,
    armed_by: record.armed_by,
    max_completed_trades: record.max_completed_trades,
    completed_trades: completedCycles(record),
    consumed_cycles: consumedCycles(record),
    remaining_trades: remainingCycles(record),
    // The cycle currently being worked, if exactly one is in flight. With several open Boxes
    // there is no single "current" trade, so report null rather than an arbitrary pick.
    current_trade_id: inFlight.length === 1 ? (inFlight[0] as string) : null,
    in_flight_trade_ids: inFlight,
    aborted_attempts: record.aborted_attempts,
    arm_count: record.arm_count,
    block_reason: blockReason,
  };
}
