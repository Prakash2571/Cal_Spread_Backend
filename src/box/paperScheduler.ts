/**
 * DETERMINISTIC PAPER SCHEDULER — reproduces the live BoxOrderManager scheduling.
 *
 * WHY
 *
 * Under `live` mode the four leg orders of a Box are all handed to `BoxOrderManager`
 * at once (`Promise.allSettled(requests.map(manager.submit))`), but the manager does NOT
 * run them in parallel. It admits them through a priority queue, one per free concurrency
 * slot, and — because a live adapter holds its slot across the ENTIRE order lifecycle
 * (submit → broker ACK → poll-to-terminal) — a `maxConcurrentExecutions = 1` deployment
 * serialises whole lifecycles, not just the HTTP POSTs. On top of that every transport
 * call is paced by `BOX_LIVE_BROKER_MIN_INTERVAL_MS` on the adapter's shared throttle.
 *
 * The previous paper `live_parity` released all four legs at the same instant (each with
 * its own latency draw) and only capped whole *pipelines*. That is the single biggest
 * remaining scheduling-parity gap. This module closes it by computing, from the SAME
 * policy the live manager uses ({@link ExecutionSchedulingPolicy}), the exact order and
 * timing in which each operation would acquire a slot, be paced onto the wire, be
 * acknowledged, and free its slot.
 *
 * WHAT IT IS
 *
 * A pure planner: given a set of operations (each with a purpose → priority, a FIFO
 * sequence, a ready time, and its per-stage latency components) and the policy, it
 * returns a fully-resolved timeline per operation. No clock, no I/O, no randomness — the
 * same inputs always produce the same schedule, which is what lets the golden fixtures
 * pin it and a Go port reproduce it byte-for-byte.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 *  - It does not decide FILLS. Whether/when a resting LIMIT order fills is decided later,
 *    from actual observed WebSocket books, by the leg executor. This planner only decides
 *    WHEN the order is live at the exchange (its ACK) and how long its slot is held.
 *  - It does not model each individual poll GET's pacing during the rest window. The POST
 *    is the pacing-relevant transport event that gates other operations; polls happen
 *    inside an operation's own already-held slot. This is a documented simplification, not
 *    an invented behaviour.
 */

import type { BoxOrderPurpose } from "./types.js";
import { compareScheduling, type ExecutionSchedulingPolicy } from "./executionSchedulingPolicy.js";

/**
 * One broker operation to schedule. Latency components are supplied by the caller (from
 * the calibration model in integration, or fixed numbers in tests) — never invented here.
 */
export interface SchedulableOperation {
  /** Stable identity for correlating the result (e.g. a leg role or client order id). */
  readonly id: string;
  readonly purpose: BoxOrderPurpose;
  /**
   * FIFO tie-break within a priority band — the order in which the operation was handed to
   * the scheduler. Live uses a monotonically increasing sequence for exactly this.
   */
  readonly sequence: number;
  /**
   * When the operation becomes queueable (ms, monotonic). For the four entry legs this is
   * typically the same instant (they are all submitted together); an unwind/exit becomes
   * ready when its trigger fires.
   */
  readonly readyAt: number;
  /** POST leaves the wire → broker ACK (ms). The order is "live at the exchange" at ACK. */
  readonly postToAckMs: number;
  /**
   * ACK → terminal resolution (ms) — how long the slot is held after acknowledgement while
   * the order works/fills/cancels. Live holds the concurrency slot for this whole span.
   */
  readonly ackToTerminalMs: number;
}

/** A fully-resolved operation timeline. Every field is an absolute ms timestamp unless named `_ms`. */
export interface ScheduledOperation {
  readonly id: string;
  readonly purpose: BoxOrderPurpose;
  readonly priority: number;
  readonly sequence: number;
  /** Slot index (0..cap-1) the operation ran on — useful for reasoning about cap>1. */
  readonly slot: number;

  /** Enqueued (== readyAt). */
  readonly queued_at: number;
  /** A concurrency slot was acquired (inFlight++). */
  readonly dequeued_at: number;
  /** The shared transport throttle permitted the POST (>= dequeued_at). */
  readonly transport_allowed_at: number;
  /** POST left the wire (== transport_allowed_at). */
  readonly post_started_at: number;
  /** Broker acknowledged — the order is now live/working at the exchange. */
  readonly ack_at: number;
  /** Terminal resolution; the slot is released here (inFlight--). */
  readonly terminal_at: number;

  /** dequeued_at − queued_at: time spent waiting for a free, higher-priority-clear slot. */
  readonly queue_wait_ms: number;
  /** post_started_at − dequeued_at: extra wait imposed purely by transport pacing. */
  readonly transport_wait_ms: number;
}

const EPS = 1e-6;

/**
 * Plan the full schedule for a batch of operations under the given policy.
 *
 * The algorithm is a faithful discrete-event model of the live manager:
 *
 *   - Up to `maxConcurrentOperations` slots may be occupied at once. A slot is occupied
 *     from an operation's `dequeued_at` until its `terminal_at` (whole lifecycle), because
 *     the live adapter's `submitOrder` does not resolve until the order is terminal.
 *   - Whenever a slot is free, the WAITING operation with the best (lowest) priority, then
 *     the lowest sequence, is admitted — exactly the manager's `sortQueue` order. This is
 *     re-evaluated at every slot-free event, so a higher-priority operation that became
 *     ready while a slot was busy correctly jumps ahead of an already-queued lower one.
 *   - The POST is paced by `minBrokerIntervalMs` on a single shared transport channel, so
 *     even when two slots run concurrently their POSTs are spaced apart, just as the
 *     adapter's shared `call()` throttle enforces.
 *
 * Returns one {@link ScheduledOperation} per input, in input order.
 */
export function planPaperSchedule(
  operations: readonly SchedulableOperation[],
  policy: ExecutionSchedulingPolicy,
): ScheduledOperation[] {
  const cap = Math.max(1, Math.floor(policy.maxConcurrentOperations));
  const minInterval = Math.max(0, policy.minBrokerIntervalMs);

  // Operations annotated with their resolved priority, in input order.
  const pending = operations.map((op) => ({ op, priority: policy.priorityFor(op.purpose) }));
  const scheduled = new Array<boolean>(pending.length).fill(false);

  // When each slot next becomes free. −∞ ⇒ free from the start of time.
  const slotFreeAt = new Array<number>(cap).fill(Number.NEGATIVE_INFINITY);
  // When the shared transport channel may carry the next POST.
  let transportFreeAt = Number.NEGATIVE_INFINITY;

  const results: ScheduledOperation[] = new Array(operations.length);
  let dequeuedCount = 0;

  while (dequeuedCount < pending.length) {
    // The earliest a slot could take work, and which slot it is.
    let slot = 0;
    for (let i = 1; i < cap; i++) {
      if (slotFreeAt[i]! < slotFreeAt[slot]!) slot = i;
    }
    const slotAvailableAt = slotFreeAt[slot]!;

    // Among not-yet-scheduled ops, the manager admits by priority then sequence — but only
    // from those already READY when the slot frees. If none is ready yet, the slot idles
    // until the earliest one becomes ready (exactly as a live idle manager would wait).
    let chosen = -1;
    let earliestReady = Number.POSITIVE_INFINITY;
    for (let i = 0; i < pending.length; i++) {
      if (scheduled[i]) continue;
      const entry = pending[i]!;
      if (entry.op.readyAt < earliestReady) earliestReady = entry.op.readyAt;
      if (entry.op.readyAt > slotAvailableAt + EPS) continue; // not ready when slot frees
      if (
        chosen === -1 ||
        compareScheduling(
          { priority: entry.priority, sequence: entry.op.sequence },
          { priority: pending[chosen]!.priority, sequence: pending[chosen]!.op.sequence },
        ) < 0
      ) {
        chosen = i;
      }
    }

    if (chosen === -1) {
      slotFreeAt[slot] = earliestReady;
      continue;
    }

    const { op, priority } = pending[chosen]!;
    const queued_at = op.readyAt;
    const dequeued_at = Math.max(slotAvailableAt, op.readyAt);
    const transport_allowed_at = Math.max(dequeued_at, transportFreeAt);
    const post_started_at = transport_allowed_at;
    const ack_at = post_started_at + Math.max(0, op.postToAckMs);
    const terminal_at = ack_at + Math.max(0, op.ackToTerminalMs);

    // The POST occupies the shared transport channel; the next POST must wait minInterval.
    transportFreeAt = post_started_at + minInterval;
    // The slot is held for the whole lifecycle (submit → terminal).
    slotFreeAt[slot] = terminal_at;

    results[chosen] = {
      id: op.id,
      purpose: op.purpose,
      priority,
      sequence: op.sequence,
      slot,
      queued_at,
      dequeued_at,
      transport_allowed_at,
      post_started_at,
      ack_at,
      terminal_at,
      queue_wait_ms: dequeued_at - queued_at,
      transport_wait_ms: post_started_at - dequeued_at,
    };
    scheduled[chosen] = true;
    dequeuedCount++;
  }

  return results;
}
