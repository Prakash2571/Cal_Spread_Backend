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
