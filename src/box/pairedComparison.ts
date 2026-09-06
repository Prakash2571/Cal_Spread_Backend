/**
 * PAIRED LIVE-VS-PAPER COMPARISON — the only honest way to answer "how realistic is the simulator?"
 *
 * WHY PAIRED, AND WHY NOT AVERAGES (audit divergence D13)
 *
 * Comparing aggregate distributions (live p50 vs paper p50) tells you whether the two populations
 * look similar. It does NOT tell you whether the simulator predicts a SPECIFIC trade — and those
 * are different questions. A simulator can match the aggregate distribution perfectly while being
 * wrong on every individual case, if its errors happen to cancel.
 *
 * So this module pairs them: for the SAME candidate, what did paper predict, and what actually
 * happened? The error is then a real per-trade error, and its distribution is the answer.
 *
 * AND NOT JUST THE MEAN. A mean absolute error of 40 ms sounds excellent and is nearly useless: it
 * says nothing about the tail, and the tail is what kills a four-leg arbitrage. So the report is
 * p50/p95/p99 of the ABSOLUTE error, plus signed bias — because "paper is 200 ms optimistic at the
 * p95" is actionable and "paper is 12 ms off on average" is not.
 *
 * MICRO-SIZE ONLY, BY INTENT. This is fed by deliberately tiny real executions whose purpose is
 * validation, not profit. That is what makes it ethical to run at all, and it is why sample counts
 * will be small for a long time — which is exactly why every output carries a confidence and why
 * {@link buildPairedComparison} refuses to imply significance it does not have.
 *
 * PURE. No clock, no I/O, no randomness.
 */

import type { BrokerId, CalibrationConfidence, LatencyProfile } from "./latencyModel.js";
import { classifyConfidence } from "./latencyModel.js";
import type { BoxLegRole } from "./types.js";

/** What paper PREDICTED for one candidate. */
export interface PaperPrediction {
  readonly candidateId: string;
  readonly broker: BrokerId;
  readonly profile: LatencyProfile;
  readonly legs: readonly BoxLegRole[];
  readonly detectedEdge: number;
  /** Predicted arrival (ACK) time relative to detection, ms. */
  readonly predictedArrivalMs: number | null;
  /** Predicted time to first fill relative to detection, ms. */
  readonly predictedFillMs: number | null;
  readonly predictedFilledQty: number;
  readonly predictedSlippage: number | null;
  readonly predictedCharges: number | null;
  readonly predictedOutcome: string;
  readonly predictedNetResult: number | null;
}

/** What ACTUALLY happened for the same candidate. */
export interface LiveObservation {
  readonly candidateId: string;
  readonly broker: BrokerId;
  readonly profile: LatencyProfile;
  /** Observed ACK time relative to detection, ms. */
  readonly observedAckMs: number | null;
  /** Observed time to first fill relative to detection, ms. */
  readonly observedFillMs: number | null;
  readonly observedFilledQty: number;
  readonly observedSlippage: number | null;
  /** Reconciled charges where available, else the estimate. */
  readonly observedCharges: number | null;
  readonly observedOutcome: string;
  readonly observedNetResult: number | null;
}

/** One paired row, exactly the schema the brief asks for. */
export interface PairedRow {
  readonly candidate_id: string;
  readonly broker: BrokerId;
  readonly profile: LatencyProfile;
  readonly instrument_legs: readonly BoxLegRole[];
  readonly detected_edge: number;
  readonly paper_predicted_arrival_ms: number | null;
  readonly live_observed_ack_ms: number | null;
  readonly paper_predicted_fill_ms: number | null;
  readonly live_fill_ms: number | null;
  readonly paper_filled_qty: number;
  readonly live_filled_qty: number;
  readonly paper_slippage: number | null;
  readonly live_slippage: number | null;
  readonly paper_charges: number | null;
  readonly live_charges: number | null;
  readonly paper_outcome: string;
  readonly live_outcome: string;
  readonly paper_net_result: number | null;
  readonly live_net_result: number | null;
  /** live − paper for each comparable quantity. Null when either side is missing. */
  readonly arrival_error_ms: number | null;
  readonly fill_error_ms: number | null;
  readonly filled_qty_error: number;
  readonly slippage_error: number | null;
  readonly net_result_error: number | null;
  /** True when paper and live agreed on the outcome class. */
  readonly outcome_agreed: boolean;
}

export interface ErrorDistribution {
  readonly samples: number;
  /** Percentiles of the ABSOLUTE error — what actually matters for a tail. */
  readonly abs_p50: number | null;
  readonly abs_p95: number | null;
  readonly abs_p99: number | null;
  /** Mean SIGNED error: positive means live was larger than paper predicted. */
  readonly signed_mean: number | null;
  readonly worst: number | null;
}

export interface PairedComparisonReport {
  readonly broker: BrokerId;
  readonly profile: LatencyProfile;
  readonly pairs: number;
  readonly confidence: CalibrationConfidence;
  readonly rows: readonly PairedRow[];
  /** Absolute-error distributions for the latency predictions. */
  readonly arrival_error: ErrorDistribution;
  readonly fill_error: ErrorDistribution;
  readonly slippage_error: ErrorDistribution;
  readonly net_result_error: ErrorDistribution;
  /** live rate − paper rate, as fractions. Positive means live filled more often than paper said. */
  readonly fill_rate_difference: number | null;
  readonly partial_fill_rate_difference: number | null;
  /** Fraction of pairs where the outcome class agreed. */
  readonly outcome_agreement_rate: number | null;
  readonly note: string;
}

function absPercentiles(values: readonly number[]): ErrorDistribution {
  if (values.length === 0) {
    return { samples: 0, abs_p50: null, abs_p95: null, abs_p99: null, signed_mean: null, worst: null };
  }
  const abs = values.map((v) => Math.abs(v)).sort((a, b) => a - b);
  const at = (p: number): number => {
    const idx = Math.min(abs.length - 1, Math.max(0, Math.floor(p * abs.length)));
    return round2(abs[idx]!);
  };
  const signedMean = values.reduce((s, v) => s + v, 0) / values.length;
  return {
    samples: values.length,
    abs_p50: at(0.5),
    abs_p95: at(0.95),
    abs_p99: at(0.99),
    signed_mean: round2(signedMean),
    worst: round2(abs[abs.length - 1]!),
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function diff(live: number | null, paper: number | null): number | null {
  if (live === null || paper === null) return null;
  if (!Number.isFinite(live) || !Number.isFinite(paper)) return null;
  return round2(live - paper);
}

/**
 * Pair predictions with observations by candidate id, and summarise the errors.
 *
 * Pairs are only formed when the broker AND the profile match on both sides. A paper prediction for
 * a marketable order compared against a live passive one would be a meaningless comparison dressed
 * up as a measurement.
 *
 * `confidenceThresholds` is applied through the same {@link classifyConfidence} the rest of the
 * system uses, so "HIGH confidence" means the same thing here as it does on a calibration report.
 */
export function buildPairedComparison(args: {
  broker: BrokerId;
  profile: LatencyProfile;
  predictions: readonly PaperPrediction[];
  observations: readonly LiveObservation[];
  /** Required to report anything above LOW confidence. Default 30. */
  mediumMinSamples?: number;
  highMinSamples?: number;
}): PairedComparisonReport {
  const byCandidate = new Map<string, LiveObservation>();
  for (const observation of args.observations) {
    if (observation.broker !== args.broker || observation.profile !== args.profile) continue;
    byCandidate.set(observation.candidateId, observation);
  }

  const rows: PairedRow[] = [];
  for (const prediction of args.predictions) {
    if (prediction.broker !== args.broker || prediction.profile !== args.profile) continue;
    const live = byCandidate.get(prediction.candidateId);
    // A prediction with no matching real execution is NOT a pair. It is not silently treated as a
    // zero error, which would flatter the report enormously.
    if (!live) continue;
    rows.push({
      candidate_id: prediction.candidateId,
      broker: args.broker,
      profile: args.profile,
      instrument_legs: prediction.legs,
      detected_edge: prediction.detectedEdge,
      paper_predicted_arrival_ms: prediction.predictedArrivalMs,
      live_observed_ack_ms: live.observedAckMs,
      paper_predicted_fill_ms: prediction.predictedFillMs,
      live_fill_ms: live.observedFillMs,
      paper_filled_qty: prediction.predictedFilledQty,
      live_filled_qty: live.observedFilledQty,
      paper_slippage: prediction.predictedSlippage,
      live_slippage: live.observedSlippage,
      paper_charges: prediction.predictedCharges,
      live_charges: live.observedCharges,
      paper_outcome: prediction.predictedOutcome,
      live_outcome: live.observedOutcome,
      paper_net_result: prediction.predictedNetResult,
      live_net_result: live.observedNetResult,
      arrival_error_ms: diff(live.observedAckMs, prediction.predictedArrivalMs),
      fill_error_ms: diff(live.observedFillMs, prediction.predictedFillMs),
      filled_qty_error: live.observedFilledQty - prediction.predictedFilledQty,
      slippage_error: diff(live.observedSlippage, prediction.predictedSlippage),
      net_result_error: diff(live.observedNetResult, prediction.predictedNetResult),
      outcome_agreed: prediction.predictedOutcome === live.observedOutcome,
    });
  }

  const collect = (pick: (r: PairedRow) => number | null): number[] =>
    rows.map(pick).filter((v): v is number => v !== null);

  const paperFilled = rows.filter((r) => r.paper_filled_qty > 0).length;
  const liveFilled = rows.filter((r) => r.live_filled_qty > 0).length;
  const paperPartial = rows.filter((r) => r.paper_outcome === "partial").length;
  const livePartial = rows.filter((r) => r.live_outcome === "partial").length;
  const agreed = rows.filter((r) => r.outcome_agreed).length;

  const confidence = classifyConfidence({
    status: rows.length > 0 ? "PARTIALLY_CALIBRATED" : "UNCALIBRATED",
    sampleCount: rows.length,
    measured: rows.length > 0,
    thresholds: {
      mediumMinSamples: args.mediumMinSamples ?? 30,
      highMinSamples: args.highMinSamples ?? 200,
    },
  });

  const rate = (count: number): number | null => (rows.length > 0 ? count / rows.length : null);
  const rateDiff = (liveCount: number, paperCount: number): number | null => {
    const l = rate(liveCount);
    const p = rate(paperCount);
    return l === null || p === null ? null : Math.round((l - p) * 1000) / 1000;
  };

  return {
    broker: args.broker,
    profile: args.profile,
    pairs: rows.length,
    confidence,
    rows,
    arrival_error: absPercentiles(collect((r) => r.arrival_error_ms)),
    fill_error: absPercentiles(collect((r) => r.fill_error_ms)),
    slippage_error: absPercentiles(collect((r) => r.slippage_error)),
    net_result_error: absPercentiles(collect((r) => r.net_result_error)),
    fill_rate_difference: rateDiff(liveFilled, paperFilled),
    partial_fill_rate_difference: rateDiff(livePartial, paperPartial),
    outcome_agreement_rate: rate(agreed),
    note:
      rows.length === 0
        ? `No paired ${args.broker}/${args.profile} executions yet. NOTHING can be concluded about simulator realism from zero pairs.`
        : `${rows.length} paired ${args.broker}/${args.profile} executions. Confidence ${confidence}. ` +
          `Errors are reported as absolute p50/p95/p99 plus signed bias — a mean alone would hide the tail, ` +
          `and the tail is what decides whether a four-leg entry completes.`,
  };
}

/** Render a paired report for an admin diagnostics view. */
export function formatPairedComparison(report: PairedComparisonReport): string {
  const lines: string[] = [
    `PAIRED LIVE-VS-PAPER — ${report.broker} / ${report.profile}`,
    `pairs: ${report.pairs}   confidence: ${report.confidence}`,
  ];
  if (report.pairs === 0) {
    lines.push(report.note);
    return lines.join("\n");
  }
  const dist = (label: string, d: ErrorDistribution): string =>
    `  ${label.padEnd(20)} p50 ${fmt(d.abs_p50)}  p95 ${fmt(d.abs_p95)}  p99 ${fmt(d.abs_p99)}  bias ${fmt(d.signed_mean)}  (n=${d.samples})`;
  lines.push("absolute error distributions (live − paper):");
  lines.push(dist("arrival/ACK ms", report.arrival_error));
  lines.push(dist("first fill ms", report.fill_error));
  lines.push(dist("slippage", report.slippage_error));
  lines.push(dist("net result", report.net_result_error));
  lines.push(`fill-rate difference:         ${fmt(report.fill_rate_difference)}`);
  lines.push(`partial-fill-rate difference: ${fmt(report.partial_fill_rate_difference)}`);
  lines.push(`outcome agreement rate:       ${fmt(report.outcome_agreement_rate)}`);
  lines.push(report.note);
  return lines.join("\n");
}

function fmt(v: number | null): string {
  return v === null ? "—" : String(v);
}
