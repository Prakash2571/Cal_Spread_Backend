/**
 * PAPER LEG TIMELINE INVARIANTS.
 *
 * One rule, and it is not negotiable:
 *
 *   AN ORDER CANNOT FILL BEFORE IT ARRIVES AT THE EXCHANGE.
 *
 * The `live_parity` profile models a cancel as a REQUEST rather than an outcome: a cancelled
 * order stays eligible to fill until its confirmation lands, because that is what really happens.
 * The abort path, however, moved EVERY unresolved leg into `CANCEL_REQUESTED` without asking
 * whether it had arrived, and the quote subscriber deliberately treats `CANCEL_REQUESTED` as
 * fillable while skipping the timeout guard. A leg still in transport — or, in sequential mode,
 * never submitted at all, with `submit_at`/`arrival_at` both still 0 — could therefore fill.
 *
 * That is physically impossible, and it is not a harmless cosmetic error. It invents exposure
 * that then drives an emergency unwind, and it corrupts precisely the statistics the module
 * exists to measure: fill rate, residual rate, unwind frequency, parity timing, implementation
 * shortfall and exposure duration.
 *
 * These checks are the runtime assertion of that rule. After the fix they should never fire —
 * every fillable status is now reachable only through arrival — so they exist to catch a FUTURE
 * scheduling change that reintroduces the hole, rather than to paper over the current one.
 *
 * Pure: no clock, no I/O. Safe to call on a finished leg and in tests.
 */

import type { PaperLegExecution } from "./types.js";

/**
 * Where an order was in its lifecycle when a cancel was requested.
 *
 * An enum rather than a boolean because the three cases have different physics, and only ONE of
 * them can race a fill:
 *
 *   pre_submission — no order ever existed (sequential mode, a leg ahead failed first).
 *   in_transport   — submitted, but not yet live at the exchange. Cancelling it removes it
 *                    before it can ever match. It is NOT exchange-fillable.
 *   at_exchange    — genuinely resting on the book. This is the only stage in which the
 *                    cancel-vs-fill race is real, and modelling that race is the whole point.
 */
export type PaperLegCancelStage = "pre_submission" | "in_transport" | "at_exchange";

/**
 * Did this order actually become live at the simulated exchange?
 *
 * `pending_since` is written once, on the `IN_FLIGHT -> PENDING` edge, and only after
 * `arrival_at <= now`. It is therefore the single authoritative "this order reached the
 * exchange" marker — stronger than any status test, because statuses can be reached from
 * several directions.
 */
export function hasReachedExchange(leg: PaperLegExecution): boolean {
  return leg.pending_since !== null;
}

/** Was this order ever submitted at all? Never-submitted legs keep `submit_at`/`arrival_at` 0. */
function wasSubmitted(leg: PaperLegExecution): boolean {
  return leg.submit_at > 0 || leg.arrival_at > 0;
}

/**
 * Every way this leg's recorded timeline could be physically impossible, as human-readable
 * strings. Empty means the timeline is coherent.
 */
export function paperLegTimelineViolations(leg: PaperLegExecution): string[] {
  const out: string[] = [];

  if (wasSubmitted(leg) && leg.arrival_at < leg.submit_at) {
    out.push(`arrival_at ${leg.arrival_at} precedes submit_at ${leg.submit_at}`);
  }

  // pending_since >= arrival_at — an order cannot be resting on the book before it got there.
  if (leg.pending_since !== null && leg.pending_since < leg.arrival_at) {
    out.push(`pending_since ${leg.pending_since} precedes arrival_at ${leg.arrival_at}`);
  }

  // fill_at >= arrival_at — the headline invariant.
  if (leg.fill_at !== null && leg.fill_at < leg.arrival_at) {
    out.push(`fill_at ${leg.fill_at} precedes arrival_at ${leg.arrival_at}`);
  }

  // Every individual slice, which is what catches a PARTIAL fill. `fill_at` is written only when
  // an order COMPLETES, so a partially filled leg has `fill_at === null` and the slice
  // timestamps are the only evidence of when quantity was actually taken.
  for (const [i, slice] of leg.fills.entries()) {
    if (slice.at < leg.arrival_at) {
      out.push(`fill slice ${i} at ${slice.at} precedes arrival_at ${leg.arrival_at}`);
    }
  }

  // Any quantity at all implies the order was live at the exchange.
  if (leg.fill_qty > 0 && !hasReachedExchange(leg)) {
    out.push(`filled ${leg.fill_qty} without ever reaching the exchange (pending_since is null)`);
  }

  // A cancel that raced a fill must have been racing an order that was actually working.
  if (leg.raced_fill_qty > 0) {
    if (!hasReachedExchange(leg)) {
      out.push(`raced_fill_qty ${leg.raced_fill_qty} on an order that never reached the exchange`);
    }
    if (leg.cancel_requested_at === null) {
      out.push(`raced_fill_qty ${leg.raced_fill_qty} without a cancel request`);
    }
  }

  // The cancel stage must agree with the arrival record.
  if (leg.cancel_stage === "at_exchange" && !hasReachedExchange(leg)) {
    out.push("cancel_stage is at_exchange but the order never reached the exchange");
  }
  if (leg.cancel_stage === "pre_submission" && wasSubmitted(leg)) {
    out.push("cancel_stage is pre_submission but the order was submitted");
  }
  if (leg.cancel_stage !== null && leg.cancel_stage !== "at_exchange" && leg.fill_qty > 0) {
    out.push(`cancel_stage ${leg.cancel_stage} carries a fill of ${leg.fill_qty}`);
  }

  return out;
}

/** Convenience: violations across a whole run, prefixed by role. */
export function paperRunTimelineViolations(legs: readonly PaperLegExecution[]): string[] {
  const out: string[] = [];
  for (const leg of legs) {
    for (const violation of paperLegTimelineViolations(leg)) out.push(`${leg.role}: ${violation}`);
  }
  return out;
}
