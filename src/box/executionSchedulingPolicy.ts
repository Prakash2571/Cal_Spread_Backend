/**
 * THE SINGLE SOURCE OF TRUTH for Box broker-operation scheduling policy.
 *
 * WHY THIS MODULE EXISTS
 *
 * The live `BoxOrderManager` is the authoritative scheduler: it decides the order in
 * which broker operations run (priority), how many may be in flight at once
 * (concurrency), and how closely successive transport calls may be spaced (the broker
 * min-interval). Paper `live_parity` must reproduce that scheduling EXACTLY, not merely
 * with "similar" numbers. If the priority map or the concurrency/pacing semantics lived
 * in two places they would drift.
 *
 * So the policy is defined ONCE here, as pure read-only data + pure functions, and is
 * consumed by BOTH:
 *
 *   - the live `BoxOrderManager` (imports {@link BOX_ORDER_PRIORITY}), and
 *   - the paper `PaperExecutionScheduler` (imports the whole policy).
 *
 * NOTHING in this file performs I/O, holds mutable state, reads the clock, or touches a
 * broker. It is a description of policy, and both the live and paper schedulers apply it.
 * Extracting it here does NOT change live behaviour: `BOX_ORDER_PRIORITY` is the exact
 * same map the manager used inline, with the same values.
 *
 * DETERMINISM: every function here is pure and total. A Go port that mirrors these three
 * values + the priority map reproduces the same scheduling decisions.
 */

import type { BoxOrderPurpose } from "./types.js";

/**
 * Priority of each broker-operation purpose. LOWER NUMBER = HIGHER PRIORITY, i.e. it is
 * dequeued (and thus reaches the broker) ahead of higher numbers. Ties break FIFO by the
 * sequence in which operations were enqueued.
 *
 * This is the exact ordering the live `BoxOrderManager` enforces:
 *
 *   EMERGENCY_RESIDUAL (0)  — flatten a dangerous residual leg; must jump every queue
 *   PROTECTIVE_CANCEL  (1)  — pull a working order before it can do harm
 *   EXIT               (2)  — close an established box
 *   ENTRY              (3)  — open a new box; yields to everything protective
 *
 * A protective/emergency operation therefore always claims the next free broker slot
 * ahead of any queued ENTRY, exactly as live does. In-flight operations are never
 * pre-empted (neither live nor paper interrupts a call already at the broker); priority
 * only orders what is WAITING.
 */
export const BOX_ORDER_PRIORITY: Readonly<Record<BoxOrderPurpose, number>> = Object.freeze({
  EMERGENCY_RESIDUAL: 0,
  PROTECTIVE_CANCEL: 1,
  EXIT: 2,
  ENTRY: 3,
});

/** The purpose a bare cancel queue-action carries in the live manager. */
export const CANCEL_PRIORITY = BOX_ORDER_PRIORITY.PROTECTIVE_CANCEL;

/** Priority number for a purpose. Pure lookup; the caller owns tie-breaking by sequence. */
export function priorityFor(purpose: BoxOrderPurpose): number {
  return BOX_ORDER_PRIORITY[purpose];
}

/**
 * Compare two queued operations the way the live manager sorts its queue: by priority
 * first (lower number first), then FIFO by enqueue sequence. Returns <0 if `a` should run
 * before `b`. Stable and total.
 */
export function compareScheduling(
  a: { priority: number; sequence: number },
  b: { priority: number; sequence: number },
): number {
  return a.priority - b.priority || a.sequence - b.sequence;
}

/**
 * The three knobs that fully describe how broker operations are scheduled. Live sources
 * these from `BOX_LIVE_*`; paper `live_parity` sources the SAME values so its scheduler
 * is policy-identical, not merely similarly configured.
 */
export interface ExecutionSchedulingPolicy {
  /**
   * Maximum broker operations whose lifecycle may overlap. Live holds a slot for the
   * ENTIRE order lifecycle (submit → terminal resolution), so `1` serialises whole
   * lifecycles, not just the HTTP POSTs.
   */
  readonly maxConcurrentOperations: number;
  /**
   * Minimum wall-clock gap (ms) the live adapter enforces between successive transport
   * calls on its shared `call()` throttle — covering place, modify, cancel, order-status
   * polls and positions reads alike.
   */
  readonly minBrokerIntervalMs: number;
  /** Priority for a purpose; lower = sooner. */
  priorityFor(purpose: BoxOrderPurpose): number;
}

/**
 * Build the policy from the two authoritative numeric knobs. Deliberately takes plain
 * numbers (not the whole `BoxConfig`) so it stays trivially testable and so a caller can
 * feed either the live pair (`liveMaxConcurrentExecutions`, `liveBrokerMinIntervalMs`) or
 * the paper live_parity pair (`paperMaxConcurrentExecutions`, `liveBrokerMinIntervalMs`).
 *
 * Values are sanitised to safe floors so a bad config can never produce a zero/negative
 * cap (which would deadlock) or a negative interval (which would disable pacing).
 */
export function createSchedulingPolicy(args: {
  maxConcurrentOperations: number;
  minBrokerIntervalMs: number;
}): ExecutionSchedulingPolicy {
  const cap = Number.isFinite(args.maxConcurrentOperations)
    ? Math.max(1, Math.floor(args.maxConcurrentOperations))
    : 1;
  const interval = Number.isFinite(args.minBrokerIntervalMs)
    ? Math.max(0, Math.floor(args.minBrokerIntervalMs))
    : 0;
  return {
    maxConcurrentOperations: cap,
    minBrokerIntervalMs: interval,
    priorityFor,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// BOX ENTRY BURST POLICY
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * THE PROBLEM THIS SOLVES.
 *
 * A live concurrency slot is held for an order's ENTIRE LIFECYCLE — submit, then poll to a
 * terminal state. With `BOX_LIVE_MAX_CONCURRENT_EXECUTIONS = 1` (the default) that means the
 * four legs of one Box are not merely paced apart: leg 2 is not even PERSISTED, let alone
 * transmitted, until leg 1 has fully resolved at the broker. First-to-last submit is therefore
 * bounded below by three complete order lifecycles, which for a working order can be seconds.
 *
 * For a four-leg arbitrage that is the dominant risk: between leg 1 filling and leg 4 reaching
 * the broker, the position is UNHEDGED. Shrinking that window is the single most valuable
 * latency improvement available, and — unlike removing a safety gate — it costs nothing.
 *
 * WHAT THE BURST IS, PRECISELY.
 *
 * `BOX_LIVE_ENTRY_SUBMIT_CONCURRENCY` bounds how many independent Box ENTRY role submissions
 * may be IN TRANSPORT simultaneously. It is NOT a global concurrency increase:
 *
 *   - It applies ONLY to `purpose === "ENTRY"`.
 *   - All burst slots must belong to THE SAME `attempt_id`, i.e. one Box pipeline. Two
 *     overlapping candidate Boxes can therefore never use it to run concurrently, so it cannot
 *     be used to bypass contract reservations.
 *   - It never opens a burst slot while any non-ENTRY operation is in flight.
 *
 * WHY IT CANNOT DELAY PROTECTIVE WORK.
 *
 * Burst slots are INVISIBLE to emergency, cancel and exit admission: those purposes are
 * admitted against BASE occupancy only ({@link admitBoxOperation}). So an entry burst never
 * consumes capacity that a protective operation would otherwise have had — and when the base
 * slot frees, the priority queue hands it to the queued EMERGENCY_RESIDUAL / PROTECTIVE_CANCEL
 * / EXIT ahead of any remaining ENTRY, exactly as {@link BOX_ORDER_PRIORITY} requires. The
 * result is strictly better than the pre-burst behaviour, in which all four entry legs
 * contended for the same single base slot that protective work needed.
 *
 * WHY THIS DOES NOT BREACH BROKER RATE LIMITS.
 *
 * Lifecycle concurrency and wire pacing are different mechanisms. Rate limiting is enforced
 * independently by the adapter's shared `call()` throttle (see `brokerPacing.ts`), which paces
 * order mutations at the broker's published limit no matter how many lifecycles overlap. The
 * burst lets four legs be *ready* to transmit; the throttle still spaces them.
 */

/** The bounds `BOX_LIVE_ENTRY_SUBMIT_CONCURRENCY` is clamped into. A Box has four legs. */
export const ENTRY_SUBMIT_CONCURRENCY_MIN = 1;
export const ENTRY_SUBMIT_CONCURRENCY_MAX = 4;

/** Sanitise an entry-burst width into `[1, 4]`. Garbage collapses to the safe value, 1. */
export function clampEntrySubmitConcurrency(value: number): number {
  if (!Number.isFinite(value)) return ENTRY_SUBMIT_CONCURRENCY_MIN;
  const floored = Math.floor(value);
  if (floored < ENTRY_SUBMIT_CONCURRENCY_MIN) return ENTRY_SUBMIT_CONCURRENCY_MIN;
  if (floored > ENTRY_SUBMIT_CONCURRENCY_MAX) return ENTRY_SUBMIT_CONCURRENCY_MAX;
  return floored;
}

/** Which kind of slot an admitted operation occupies. */
export type BoxSchedulingSlot = "base" | "entry_burst";

/** Live occupancy, as the manager tracks it. */
export interface BoxSchedulingOccupancy {
  /** Operations holding a BASE slot. */
  readonly baseInFlight: number;
  /** Operations holding an ENTRY BURST slot. */
  readonly burstInFlight: number;
  /**
   * The `attempt_id` of the Box pipeline that owns EVERY in-flight ENTRY operation, base slot
   * included, or null when no ENTRY is in flight.
   *
   * Deliberately covers base slots too, not just burst slots. Otherwise a second candidate's
   * ENTRY could take a freed base slot while the first candidate's legs were still in flight on
   * burst slots — two overlapping Box pipelines, which is exactly what must never happen.
   */
  readonly entryAttemptId: string | null;
  /** In-flight operations whose purpose is not ENTRY. */
  readonly nonEntryInFlight: number;
}

/** The operation seeking admission. */
export interface BoxSchedulingRequest {
  readonly purpose: BoxOrderPurpose;
  /** The Box pipeline this operation belongs to. Burst slots are scoped to it. */
  readonly attemptId: string;
}

export type BoxAdmissionVerdict =
  | { readonly admit: true; readonly slot: BoxSchedulingSlot }
  | { readonly admit: false; readonly reason: string };

/**
 * Decide whether an operation may start now, and on which slot.
 *
 * PURE and TOTAL, so the admission rule is testable in isolation from the manager's queue,
 * its persistence and its broker. The manager owns the occupancy counters and applies the
 * verdict; this function owns the policy.
 *
 * `baseConcurrency` is `BOX_LIVE_MAX_CONCURRENT_EXECUTIONS`; `entrySubmitConcurrency` is
 * `BOX_LIVE_ENTRY_SUBMIT_CONCURRENCY`. When the latter is <= the former the burst is
 * unnecessary and never engages — an operator who raised the base cap loses nothing.
 */
export function admitBoxOperation(args: {
  readonly request: BoxSchedulingRequest;
  readonly occupancy: BoxSchedulingOccupancy;
  readonly baseConcurrency: number;
  readonly entrySubmitConcurrency: number;
}): BoxAdmissionVerdict {
  const base = Number.isFinite(args.baseConcurrency) ? Math.max(1, Math.floor(args.baseConcurrency)) : 1;
  const burstWidth = clampEntrySubmitConcurrency(args.entrySubmitConcurrency);
  const { occupancy, request } = args;

  const isEntry = request.purpose === "ENTRY";

  if (!isEntry) {
    // PROTECTIVE / EXIT ADMISSION. Counts BASE occupancy only, so entry-burst slots are
    // invisible to it and an entry burst can never make protective work wait longer than it
    // would have without the burst.
    if (occupancy.baseInFlight < base) return { admit: true, slot: "base" };
    return {
      admit: false,
      reason: `base concurrency ${base} is fully occupied by ${occupancy.baseInFlight} operation(s)`,
    };
  }

  // ENTRY ADMISSION.
  //
  // ONE BOX PIPELINE AT A TIME, unconditionally. Checked before any slot arithmetic so it holds
  // for base slots as well as burst slots: a second candidate Box may never have an ENTRY in
  // flight alongside the first, whatever the concurrency numbers say.
  if (occupancy.entryAttemptId !== null && occupancy.entryAttemptId !== request.attemptId) {
    return {
      admit: false,
      reason:
        `attempt ${occupancy.entryAttemptId} already has ENTRY operations in flight; a second Box pipeline ` +
        "may never overlap it, so contract reservations cannot be bypassed",
    };
  }

  const totalInFlight = occupancy.baseInFlight + occupancy.burstInFlight;
  if (occupancy.baseInFlight < base) return { admit: true, slot: "base" };

  if (burstWidth <= base) {
    return {
      admit: false,
      reason:
        `base concurrency ${base} is fully occupied and BOX_LIVE_ENTRY_SUBMIT_CONCURRENCY=${burstWidth} ` +
        "adds no headroom",
    };
  }
  if (occupancy.nonEntryInFlight > 0) {
    return {
      admit: false,
      reason:
        `${occupancy.nonEntryInFlight} non-ENTRY operation(s) are in flight; the entry burst never opens ` +
        "alongside protective or exit work",
    };
  }
  if (totalInFlight >= burstWidth) {
    return {
      admit: false,
      reason: `entry burst width ${burstWidth} is fully occupied by ${totalInFlight} submission(s)`,
    };
  }
  return { admit: true, slot: "entry_burst" };
}
