/**
 * EXECUTION-PARITY REPORT — compares LIVE observed timing against PAPER live_parity replay.
 *
 * The whole point of the calibration work is answerable in one question: for the same
 * policy and configuration, does the simulator produce timing distributions reasonably
 * close to real live observations? This module answers it as a pure comparison of two
 * {@link BrokerLatencySnapshot}s (one from the live broker-timing store, one from a paper
 * store), per broker, per metric:
 *
 *   live p50/p95/p99   vs   paper p50/p95/p99   →   percentage error
 *
 * plus a comparison of execution-outcome RATES (4/4 filled, partial, no-fill, …).
 *
 * HONESTY RULES
 *
 *  - Sample counts are surfaced on every comparison and prominently at the top. A metric
 *    where either side has fewer than the confidence threshold is flagged `low_confidence`
 *    — the report never implies statistical confidence it does not have.
 *  - A metric absent on either side is reported as such, never zero-filled.
 *  - Pure and deterministic: no clock, no I/O. Diagnostics only; never touches trading.
 */

import type { BrokerLatencySnapshot } from "./brokerTimingStore.js";
import { BOX_EXECUTION_OUTCOMES, type BoxExecutionOutcome } from "./brokerTimingStore.js";
import type { BrokerId } from "./latencyModel.js";

type Summary = NonNullable<ReturnType<import("./metrics.js").RingBuffer["summary"]>>;

/** The metrics compared, in report order. Pulled from box-level first, then ENTRY by-kind. */
const COMPARED_METRICS = [
  "detection_to_first_fill_ms",
  "detection_to_last_submit_ms",
  "detection_to_all_four_filled_ms",
  "unhedged_exposure_duration_ms",
  "unwind_duration_ms",
  "submit_to_ack_ms",
  "submit_to_first_fill_ms",
  "submit_to_terminal_ms",
] as const;

export interface ParityPercentiles {
  samples: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface ParityMetricComparison {
  metric: string;
  live: ParityPercentiles | null;
  paper: ParityPercentiles | null;
  /** (paper − live) / live × 100 per percentile; null when live is missing or zero. */
  error_pct: { p50: number | null; p95: number | null; p99: number | null } | null;
  /** True when either side has fewer than the confidence threshold of samples. */
  low_confidence: boolean;
}

export interface BrokerParityReport {
  broker: BrokerId;
  live_samples: number;
  paper_samples: number;
  live_calibration_status: string;
  paper_calibration_status: string;
  confidence_threshold: number;
  overall_low_confidence: boolean;
  metrics: ParityMetricComparison[];
  outcomes: Array<{ outcome: BoxExecutionOutcome; live: number; paper: number }>;
}

function findSummary(snap: BrokerLatencySnapshot, metric: string): Summary | null {
  const box = snap.box[metric];
  if (box) return box;
  const entry = snap.by_kind.ENTRY?.[metric];
  return entry ?? null;
}

function toPct(summary: Summary | null): ParityPercentiles | null {
  if (!summary) return null;
  return { samples: summary.samples, p50: summary.p50, p95: summary.p95, p99: summary.p99 };
}

function errorPct(live: number | null, paper: number | null): number | null {
  if (live === null || paper === null || live === 0) return null;
  return Math.round(((paper - live) / live) * 1000) / 10; // one decimal place
}

/**
 * Build a per-broker parity report from a live snapshot and a paper snapshot.
 *
 * `confidenceThreshold` — a metric where either side has fewer than this many samples is
 * flagged low-confidence (default 30). The report is diagnostic; it makes no claim of
 * statistical significance below this.
 */
export function buildParityReport(
  live: BrokerLatencySnapshot,
  paper: BrokerLatencySnapshot,
  confidenceThreshold = 30,
): BrokerParityReport {
  const metrics: ParityMetricComparison[] = COMPARED_METRICS.map((metric) => {
    const liveS = findSummary(live, metric);
    const paperS = findSummary(paper, metric);
    const livePct = toPct(liveS);
    const paperPct = toPct(paperS);
    const low =
      (livePct?.samples ?? 0) < confidenceThreshold || (paperPct?.samples ?? 0) < confidenceThreshold;
    const error =
      livePct && paperPct
        ? {
            p50: errorPct(livePct.p50, paperPct.p50),
            p95: errorPct(livePct.p95, paperPct.p95),
            p99: errorPct(livePct.p99, paperPct.p99),
          }
        : null;
    return { metric, live: livePct, paper: paperPct, error_pct: error, low_confidence: low };
  }).filter((m) => m.live !== null || m.paper !== null);

  const outcomes = BOX_EXECUTION_OUTCOMES.map((outcome) => ({
    outcome,
    live: live.outcomes[outcome] ?? 0,
    paper: paper.outcomes[outcome] ?? 0,
  })).filter((o) => o.live > 0 || o.paper > 0);

  return {
    broker: live.broker,
    live_samples: live.sample_count,
    paper_samples: paper.sample_count,
    live_calibration_status: live.calibration_status,
    paper_calibration_status: paper.calibration_status,
    confidence_threshold: confidenceThreshold,
    overall_low_confidence: live.sample_count < confidenceThreshold || paper.sample_count < confidenceThreshold,
    metrics,
    outcomes,
  };
}

/** Build a report for every broker from paired snapshot lists (matched by broker). */
export function buildParityReports(
  liveSnaps: BrokerLatencySnapshot[],
  paperSnaps: BrokerLatencySnapshot[],
  confidenceThreshold = 30,
): BrokerParityReport[] {
  const paperByBroker = new Map(paperSnaps.map((s) => [s.broker, s]));
  const out: BrokerParityReport[] = [];
  for (const live of liveSnaps) {
    const paper = paperByBroker.get(live.broker);
    if (paper) out.push(buildParityReport(live, paper, confidenceThreshold));
  }
  return out;
}

/** Render a report as human-readable text for an admin diagnostics view (Phase 22). */
export function formatParityReport(report: BrokerParityReport): string {
  const lines: string[] = [];
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  lines.push(`Broker: ${cap(report.broker)}`);
  lines.push("");
  lines.push("Samples");
  lines.push("-------");
  lines.push(`Live:  ${report.live_samples}  (${report.live_calibration_status})`);
  lines.push(`Paper: ${report.paper_samples}  (${report.paper_calibration_status})`);
  if (report.overall_low_confidence) {
    lines.push(`⚠ LOW CONFIDENCE — under ${report.confidence_threshold} samples on at least one side.`);
  }
  lines.push("");
  for (const m of report.metrics) {
    lines.push(m.metric + (m.low_confidence ? "  (low confidence)" : ""));
    const fmt = (p: number | null): string => (p === null ? "   —" : `${p}`);
    if (m.live) lines.push(`  live  p50 ${fmt(m.live.p50)}  p95 ${fmt(m.live.p95)}  p99 ${fmt(m.live.p99)}  (n=${m.live.samples})`);
    if (m.paper) lines.push(`  paper p50 ${fmt(m.paper.p50)}  p95 ${fmt(m.paper.p95)}  p99 ${fmt(m.paper.p99)}  (n=${m.paper.samples})`);
    if (m.error_pct) {
      const e = (v: number | null): string => (v === null ? "—" : `${v > 0 ? "+" : ""}${v}%`);
      lines.push(`  error p50 ${e(m.error_pct.p50)}  p95 ${e(m.error_pct.p95)}  p99 ${e(m.error_pct.p99)}`);
    }
    lines.push("");
  }
  if (report.outcomes.length > 0) {
    lines.push("Outcomes (live vs paper)");
    lines.push("------------------------");
    for (const o of report.outcomes) lines.push(`  ${o.outcome}: ${o.live} vs ${o.paper}`);
  }
  return lines.join("\n");
}
