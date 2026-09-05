/**
 * IMPLEMENTATION SHORTFALL — where the detected edge actually went.
 *
 * WHY (audit divergences D24, D10)
 *
 * A box is entered because a THEORETICAL edge was detected. What is realised is always less, and
 * the difference is not one number — it is a chain of separately-attributable losses:
 *
 *   detected edge
 *     − edge decay          the market moved between detection and submission (our own latency)
 *     − slippage            fills landed worse than the prices the decision was made on
 *     − brokerage
 *     − taxes & fees
 *     − unwind cost         legs we had to reverse because the box never completed
 *     ─────────────────
 *     = realised net result
 *
 * Without this decomposition, a disappointing result is just disappointing. With it, the cause is
 * identifiable and actionable: edge decay says get faster, slippage says price differently, unwind
 * cost says the legging model is wrong.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * THE SCHEMA IS SHARED BY PAPER AND LIVE, DELIBERATELY
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 * The same {@link ExecutionShortfall} is produced for a paper attempt and for a live one, from the
 * same function. That is what makes them comparable at all — a paper-only metric cannot be
 * validated against reality. It is also why every component is signed the same way: POSITIVE means
 * it COST us edge, always, whichever side or direction the box was.
 *
 * NOTHING FAILED IS HIDDEN. An aborted or partially-filled attempt produces a shortfall record
 * too, with the unwind cost it incurred. Statistics that quietly exclude failures are the reason
 * strategies look profitable on paper and are not.
 *
 * PURE. No clock, no I/O, no randomness. Given the same attempt it returns the same attribution.
 */

import type { BoxLegRole, OrderSide } from "./types.js";

/** Per-leg attribution. Signed so positive is always "this cost us money". */
export interface LegShortfall {
  readonly role: BoxLegRole;
  readonly side: OrderSide;
  /** The touch this leg's decision was based on. */
  readonly detectedPrice: number | null;
  /** The touch visible at submission — the reference for edge decay. */
  readonly submitPrice: number | null;
  /** Quantity-weighted average price actually achieved. */
  readonly filledPrice: number | null;
  readonly requestedQty: number;
  readonly filledQty: number;
  /**
   * Edge lost because the market moved between DETECTION and SUBMISSION, over filled quantity.
   *
   * This is OUR latency's cost, and it is the component paper calibration most directly improves:
   * a simulator with a realistic latency tail predicts this, a constant-latency one does not.
   */
  readonly edgeDecay: number | null;
  /**
   * Edge lost between SUBMISSION and the achieved fill price, over filled quantity — the cost of
   * crossing the book and of arriving when we did.
   */
  readonly slippage: number | null;
  /** Total per-leg cost against the detection reference, over filled quantity. */
  readonly totalShortfall: number | null;
}

export interface ExecutionShortfall {
  /** The edge the strategy believed it had detected (₹, over the whole box). */
  readonly theoreticalDetectedEdge: number;
  /** The gross edge actually achieved by the fills, before any cost (₹). */
  readonly executedGrossEdge: number | null;
  /** Sum of per-leg edge decay (₹). Positive costs us. */
  readonly edgeDecay: number | null;
  /** Sum of per-leg slippage (₹). Positive costs us. */
  readonly slippage: number;
  readonly brokerage: number;
  readonly taxesAndFees: number;
  /** Cost of reversing legs of an incomplete box (₹). Positive costs us. */
  readonly unwindCost: number;
  /** What actually landed (₹). Negative is a loss. */
  readonly realisedNetResult: number;
  /** Per-leg attribution, so a single bad leg is identifiable. */
  readonly legs: readonly LegShortfall[];
  /** True when the box never reached 4/4 — the attempt is still counted. */
  readonly incomplete: boolean;
  /** How the attempt ended, for grouping statistics. */
  readonly outcome: ShortfallOutcome;
  /**
   * Residual reconciliation term (₹).
   *
   * `detected − (decay + slippage + brokerage + fees + unwind) − realised`. It should be ~0; a
   * non-zero value means the attribution does not fully explain the result, and it is SURFACED
   * rather than absorbed into another bucket, because a silently-balanced attribution is worthless.
   */
  readonly unexplained: number;
}

export type ShortfallOutcome =
  | "filled_4_of_4"
  | "partial_unwound"
  | "partial_residual"
  | "no_fill"
  | "aborted_after_fill";

/** Signed cost of a price difference for a side: positive always means worse for us. */
function costPerUnit(side: OrderSide, reference: number | null, achieved: number | null): number | null {
  if (reference === null || achieved === null) return null;
  if (!Number.isFinite(reference) || !Number.isFinite(achieved)) return null;
  // Paying MORE than reference on a BUY costs us; receiving LESS than reference on a SELL costs us.
  return side === "BUY" ? achieved - reference : reference - achieved;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** One leg's observable price history and outcome. */
export interface LegShortfallInput {
  readonly role: BoxLegRole;
  readonly side: OrderSide;
  readonly detectedPrice: number | null;
  /** The touch visible at submission. Null when it was not captured. */
  readonly submitPrice: number | null;
  readonly filledPrice: number | null;
  readonly requestedQty: number;
  readonly filledQty: number;
}

/**
 * Attribute one box attempt's shortfall.
 *
 * `theoreticalDetectedEdge` is taken as given — this function deliberately does NOT recompute box
 * economics. Strategy mathematics live in `math.ts` and are not duplicated here; duplicating them
 * would create two sources of truth for the number the whole strategy turns on.
 */
export function computeExecutionShortfall(args: {
  theoreticalDetectedEdge: number;
  executedGrossEdge: number | null;
  brokerage: number;
  taxesAndFees: number;
  unwindCost: number;
  realisedNetResult: number;
  legs: readonly LegShortfallInput[];
  outcome: ShortfallOutcome;
}): ExecutionShortfall {
  const legs: LegShortfall[] = args.legs.map((leg) => {
    const decayPerUnit = costPerUnit(leg.side, leg.detectedPrice, leg.submitPrice);
    const slipPerUnit = costPerUnit(leg.side, leg.submitPrice ?? leg.detectedPrice, leg.filledPrice);
    const totalPerUnit = costPerUnit(leg.side, leg.detectedPrice, leg.filledPrice);
    const qty = Math.max(0, leg.filledQty);
    return {
      role: leg.role,
      side: leg.side,
      detectedPrice: leg.detectedPrice,
      submitPrice: leg.submitPrice,
      filledPrice: leg.filledPrice,
      requestedQty: leg.requestedQty,
      filledQty: leg.filledQty,
      // Attribution is over FILLED quantity: quantity that never filled cost us no slippage. Its
      // cost shows up as a missing leg and, if the box was incomplete, as unwind cost.
      edgeDecay: decayPerUnit === null ? null : round2(decayPerUnit * qty),
      slippage: slipPerUnit === null ? null : round2(slipPerUnit * qty),
      totalShortfall: totalPerUnit === null ? null : round2(totalPerUnit * qty),
    };
  });

  const sum = (pick: (l: LegShortfall) => number | null): number | null => {
    let total = 0;
    let any = false;
    for (const leg of legs) {
      const v = pick(leg);
      if (v === null) continue;
      total += v;
      any = true;
    }
    return any ? round2(total) : null;
  };

  const edgeDecay = sum((l) => l.edgeDecay);
  const slippage = sum((l) => l.slippage) ?? 0;
  const incomplete = args.outcome !== "filled_4_of_4";

  const explained = (edgeDecay ?? 0) + slippage + args.brokerage + args.taxesAndFees + args.unwindCost;
  const unexplained = round2(args.theoreticalDetectedEdge - explained - args.realisedNetResult);

  return {
    theoreticalDetectedEdge: round2(args.theoreticalDetectedEdge),
    executedGrossEdge: args.executedGrossEdge === null ? null : round2(args.executedGrossEdge),
    edgeDecay,
    slippage,
    brokerage: round2(args.brokerage),
    taxesAndFees: round2(args.taxesAndFees),
    unwindCost: round2(args.unwindCost),
    realisedNetResult: round2(args.realisedNetResult),
    legs,
    incomplete,
    outcome: args.outcome,
    unexplained,
  };
}

/* ───────────────────────── adverse selection ───────────────────────── */

/**
 * ADVERSE-SELECTION DIAGNOSTICS (Phase 17).
 *
 * The question: does the price systematically move AGAINST us immediately after we detect or
 * submit? If it does, the edge we are detecting is partly an artefact of being slightly late to a
 * move that is already happening — and the correct response is a strategy change, not an execution
 * change.
 *
 * OBSERVABILITY ONLY. This module computes and reports; it does not adjust a single threshold.
 * Automatically retuning entry thresholds from these numbers is explicitly out of scope, because a
 * feedback loop between measurement and the thing being measured needs its own design and its own
 * safety review.
 */
export interface AdverseSelectionSample {
  readonly role: BoxLegRole;
  readonly side: OrderSide;
  /** Touch at detection. */
  readonly touchAtDetection: number | null;
  /** Touch at submission. */
  readonly touchAtSubmit: number | null;
  /** Touch at ACK. */
  readonly touchAtAck: number | null;
  /** Touch a configurable short horizon AFTER the fill, when it was captured. */
  readonly touchAfterFill: number | null;
  /** The horizon those post-fill observations were taken over (ms). */
  readonly horizonMs: number | null;
  readonly filledPrice: number | null;
}

export interface AdverseSelectionMetrics {
  readonly role: BoxLegRole;
  /** Cost of the move between detection and submission, per unit. Positive is against us. */
  readonly detectionToSubmit: number | null;
  /** Cost of the move between submission and ACK, per unit. */
  readonly submitToAck: number | null;
  /**
   * Post-fill movement, per unit, signed so POSITIVE means the price moved against the position we
   * just took — i.e. we were adversely selected.
   */
  readonly postFillAdverseMove: number | null;
  readonly horizonMs: number | null;
}

export function computeAdverseSelection(sample: AdverseSelectionSample): AdverseSelectionMetrics {
  const detectionToSubmit = costPerUnit(sample.side, sample.touchAtDetection, sample.touchAtSubmit);
  const submitToAck = costPerUnit(sample.side, sample.touchAtSubmit, sample.touchAtAck);

  // Post-fill: we are long after a BUY, so a price FALL is adverse; short after a SELL, so a RISE
  // is adverse. costPerUnit already encodes exactly that asymmetry when the reference is our fill.
  const postFill =
    sample.filledPrice === null || sample.touchAfterFill === null
      ? null
      : sample.side === "BUY"
        ? sample.filledPrice - sample.touchAfterFill
        : sample.touchAfterFill - sample.filledPrice;

  const r = (v: number | null): number | null => (v === null ? null : Math.round(v * 100) / 100);
  return {
    role: sample.role,
    detectionToSubmit: r(detectionToSubmit),
    submitToAck: r(submitToAck),
    postFillAdverseMove: r(postFill),
    horizonMs: sample.horizonMs,
  };
}

/** Render a shortfall as the explicit subtraction chain, for an execution audit. */
export function formatShortfall(s: ExecutionShortfall): string {
  const line = (label: string, value: number | null): string =>
    `  ${label.padEnd(28)} ${value === null ? "—" : value.toFixed(2).padStart(12)}`;
  return [
    `IMPLEMENTATION SHORTFALL (${s.outcome}${s.incomplete ? ", INCOMPLETE" : ""})`,
    line("THEORETICAL_DETECTED_EDGE", s.theoreticalDetectedEdge),
    line("− EDGE_DECAY", s.edgeDecay),
    line("− SLIPPAGE", s.slippage),
    line("− BROKERAGE", s.brokerage),
    line("− TAXES_AND_FEES", s.taxesAndFees),
    line("− UNWIND_COST", s.unwindCost),
    "  " + "-".repeat(41),
    line("REALISED_NET_RESULT", s.realisedNetResult),
    line("unexplained residual", s.unexplained),
    ...(s.executedGrossEdge !== null ? [line("(executed gross edge)", s.executedGrossEdge)] : []),
  ].join("\n");
}
