/**
 * CALIBRATED LATENCY SOURCE — paper's arrival timing, driven by REAL measured live latency
 * when there is enough of it, and by an honestly-labelled constant when there is not.
 *
 * THE PROBLEM IT SOLVES (audit divergence D19)
 *
 * Paper `live_parity` drew its broker-side spans from `BOX_SIMULATED_LATENCY_MS = 250`,
 * forever, with no path for measured data to get in. A constant is not merely imprecise — it
 * is wrong in a specific, results-flattering direction, because it has NO TAIL. Real
 * server→broker→exchange latency is heavy-tailed, and for a four-leg box the tail is the whole
 * story: the leg that arrives 900 ms late is the leg that finds the book gone and turns a
 * clean 4/4 entry into a partial fill and an emergency unwind. Simulate with a constant and
 * you systematically over-predict fill rates and under-predict residual exposure.
 *
 * HOW IT REPRODUCES A DISTRIBUTION WITHOUT RANDOMNESS
 *
 * It consumes the ACTUAL measured samples, in a fixed rotation, via the existing
 * {@link ../latencySource} `recorded_samples` mechanism. That inherits the real distribution
 * — including its tail — while staying byte-for-byte reproducible: same samples, same order,
 * same schedule, every run. There is no `Math.random()` here, and no synthetic jitter. A Go
 * port fed the same sample array in the same order produces the same timings.
 *
 * A percentile summary is deliberately NOT what gets consumed. Rebuilding a distribution from
 * five percentiles would smooth away exactly the outliers that matter.
 *
 * THE HONESTY CONTRACT
 *
 * This is the module most able to tell a comforting lie, so it is the most explicit:
 *
 *  - {@link CalibratedLatencyStatus.measured} is true ONLY when both broker-side stages came
 *    from live observations. A constant fallback is never reported as measured latency.
 *  - Confidence is the WEAKER of the two stages' confidences, never the better one.
 *  - The fallback constant is named in `note` whenever it is in use, so a reader of a parity
 *    report can never mistake `250` for something that was observed.
 *  - When calibration is UNCALIBRATED, PARTIALLY_CALIBRATED or STALE, the source falls back
 *    safely and says so. A stale set is not quietly reused because it is "better than nothing":
 *    yesterday's tail is not today's, and pretending otherwise is how a simulator drifts.
 *
 * PERFORMANCE
 *
 * `next()` is O(1) in the steady state: two array reads and two cursor bumps. Resolution
 * (which sorts, and is therefore not free) happens only when the time-of-day bucket changes or
 * after `refreshEveryDraws` draws — never per draw, and never per tick.
 */

import type { ExecutionCalibrationStore, CalibrationDimensions, ResolvedCalibration } from "./executionCalibration.js";
import { createLatencySource, type LatencyMode, type LatencySource } from "./latencySource.js";
import type {
  BrokerLatencyDraw,
  CalibrationConfidence,
  CalibrationStatus,
  StructuredLatencySource,
} from "./latencyModel.js";

/**
 * With no measured ACK→terminal samples we approximate the post-ACK working span as a
 * fraction of the single constant, so an uncalibrated run still SEPARATES "time to reach the
 * exchange" from "time working at the exchange" rather than collapsing both into one number.
 *
 * Matches the fraction the previous uncalibrated structured source used, so switching to this
 * implementation changes nothing for an uncalibrated deployment.
 */
export const UNCALIBRATED_ACK_TO_TERMINAL_FRACTION = 0.4;

/** Why a stage is using a constant instead of measurements. */
export type LatencyFallbackReason =
  | "no_samples"
  | "insufficient_samples"
  | "stale_samples"
  | "not_applicable";

export interface CalibratedStageStatus {
  /** The full resolution from the calibration store, for diagnostics. */
  readonly resolution: ResolvedCalibration;
  /** True when this stage's draws come from measured live samples. */
  readonly measured: boolean;
  /** The constant used when `measured` is false. Null when measurements are in use. */
  readonly fallbackConstantMs: number | null;
  readonly fallbackReason: LatencyFallbackReason;
}

export interface CalibratedLatencyStatus {
  readonly dimensions: CalibrationDimensions;
  readonly region: string | null;
  readonly postToAck: CalibratedStageStatus;
  readonly ackToTerminal: CalibratedStageStatus;
  /** True ONLY when BOTH broker-side stages are measured. Never optimistic. */
  readonly measured: boolean;
  /** The WEAKER of the two stages' confidences. */
  readonly confidence: CalibrationConfidence;
  /** The weaker of the two stages' statuses. */
  readonly status: CalibrationStatus;
  /** Total measured samples backing the draws. Zero when running on constants. */
  readonly samples: number;
  /** Age of the newest backing sample, ms. Null when running on constants. */
  readonly freshnessMs: number | null;
  readonly newestSession: string | null;
  /** Plain-language summary, always naming the constant when one is in use. */
  readonly note: string;
}

export interface CalibratedLatencySourceOptions {
  store: ExecutionCalibrationStore;
  /**
   * The dimensions to calibrate for, re-read on each resolution so the time-of-day bucket
   * follows the session. A function, not a value, precisely so an OPEN-bucket draw at 09:20
   * and a NORMAL-bucket draw at 12:00 use different measured sets when both are populated.
   */
  dimensions: () => CalibrationDimensions;
  /** The documented fallback constant (typically `BOX_SIMULATED_LATENCY_MS`). */
  fallbackConstantMs: number;
  /** Deterministic starting offset into the sample rotation. Never randomness. */
  seed?: number;
  /**
   * Re-resolve calibration after this many draws, so a long-running process picks up newly
   * measured samples without paying for a sort on every draw. Default 200.
   */
  refreshEveryDraws?: number;
  /** Fraction of the constant used for ACK→terminal when that stage is uncalibrated. */
  uncalibratedAckToTerminalFraction?: number;
}

/** The weaker of two confidences. */
function weakerConfidence(a: CalibrationConfidence, b: CalibrationConfidence): CalibrationConfidence {
  const rank: Record<CalibrationConfidence, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  return rank[a] <= rank[b] ? a : b;
}

/** The weaker of two calibration statuses, worst-first. */
function weakerStatus(a: CalibrationStatus, b: CalibrationStatus): CalibrationStatus {
  const rank: Record<CalibrationStatus, number> = {
    UNCALIBRATED: 0,
    STALE: 1,
    PARTIALLY_CALIBRATED: 2,
    CALIBRATED: 3,
  };
  return rank[a] <= rank[b] ? a : b;
}

function fallbackReasonFor(resolution: ResolvedCalibration): LatencyFallbackReason {
  if (resolution.samples === 0) return "no_samples";
  if (resolution.status === "STALE") return "stale_samples";
  return "insufficient_samples";
}

/** One resolved, ready-to-draw stage. */
interface StageDraw {
  readonly source: LatencySource;
  readonly status: CalibratedStageStatus;
}

/**
 * A {@link StructuredLatencySource} backed by the live calibration store.
 *
 * Drop-in compatible with the previous uncalibrated implementation, so
 * `executionSimulator`'s scheduler wiring is unchanged — but it now reports what it is
 * actually running on.
 */
export class CalibratedStructuredLatencySource implements StructuredLatencySource {
  private readonly fallbackConstantMs: number;
  private readonly ackFraction: number;
  private readonly refreshEveryDraws: number;
  private readonly seed: number;

  private cacheKey: string | null = null;
  private postToAck: StageDraw | null = null;
  private ackToTerminal: StageDraw | null = null;
  private drawsSinceResolve = 0;

  constructor(private readonly opts: CalibratedLatencySourceOptions) {
    const constant = Number.isFinite(opts.fallbackConstantMs) ? Math.max(0, opts.fallbackConstantMs) : 0;
    this.fallbackConstantMs = Math.round(constant);
    this.ackFraction = opts.uncalibratedAckToTerminalFraction ?? UNCALIBRATED_ACK_TO_TERMINAL_FRACTION;
    this.refreshEveryDraws = Math.max(1, Math.floor(opts.refreshEveryDraws ?? 200));
    this.seed = Math.trunc(opts.seed ?? 0);
  }

  /**
   * `recorded_samples` when either broker-side stage is measured, else `constant`.
   *
   * Reported honestly: a caller inspecting `mode` learns whether measurements are in play
   * without having to interpret sample counts.
   */
  get mode(): LatencyMode {
    this.ensureResolved();
    return this.postToAck?.status.measured || this.ackToTerminal?.status.measured
      ? "recorded_samples"
      : "constant";
  }

  /** True when at least one broker-side stage is backed by measured live samples. */
  get calibrated(): boolean {
    this.ensureResolved();
    return (this.postToAck?.status.measured ?? false) || (this.ackToTerminal?.status.measured ?? false);
  }

  /** True only when BOTH stages are measured — the strict reading, used by reports. */
  get fullyCalibrated(): boolean {
    this.ensureResolved();
    return (this.postToAck?.status.measured ?? false) && (this.ackToTerminal?.status.measured ?? false);
  }

  next(): BrokerLatencyDraw {
    this.ensureResolved();
    this.drawsSinceResolve++;
    return {
      postToAckMs: Math.max(0, this.postToAck?.source.next() ?? this.fallbackConstantMs),
      ackToTerminalMs: Math.max(0, this.ackToTerminal?.source.next() ?? this.constantAckToTerminal()),
    };
  }

  /** Restart the rotations so a fresh run reproduces the same draws. */
  reset(): void {
    this.postToAck?.source.reset();
    this.ackToTerminal?.source.reset();
  }

  /**
   * Force the next draw to re-read calibration. Called when new samples have landed, or by an
   * admin refresh. Cheap: it only invalidates the cache.
   */
  invalidate(): void {
    this.cacheKey = null;
  }

  /** Everything a parity report needs to state what paper is running on. Cold path. */
  status(): CalibratedLatencyStatus {
    this.ensureResolved();
    const dimensions = this.opts.dimensions();
    const post = this.postToAck!.status;
    const ack = this.ackToTerminal!.status;
    const measured = post.measured && ack.measured;

    const samples = (post.measured ? post.resolution.samples : 0) + (ack.measured ? ack.resolution.samples : 0);
    const freshCandidates = [
      post.measured ? post.resolution.freshnessMs : null,
      ack.measured ? ack.resolution.freshnessMs : null,
    ].filter((v): v is number => v !== null);
    const sessions = [
      post.measured ? post.resolution.newestSession : null,
      ack.measured ? ack.resolution.newestSession : null,
    ].filter((v): v is string => v !== null);

    const notes: string[] = [];
    if (post.measured) {
      notes.push(`POST→ACK: ${post.resolution.samples} measured samples (${post.resolution.fallback}).`);
    } else {
      notes.push(
        `POST→ACK: NOT MEASURED — using the configured constant ${post.fallbackConstantMs}ms (${post.fallbackReason}).`,
      );
    }
    if (ack.measured) {
      notes.push(`ACK→terminal: ${ack.resolution.samples} measured samples (${ack.resolution.fallback}).`);
    } else {
      notes.push(
        `ACK→terminal: NOT MEASURED — using ${ack.fallbackConstantMs}ms, derived from the constant (${ack.fallbackReason}).`,
      );
    }

    return {
      dimensions,
      region: this.opts.store.region,
      postToAck: post,
      ackToTerminal: ack,
      measured,
      confidence: weakerConfidence(post.resolution.confidence, ack.resolution.confidence),
      status: weakerStatus(post.resolution.status, ack.resolution.status),
      samples,
      freshnessMs: freshCandidates.length > 0 ? Math.min(...freshCandidates) : null,
      newestSession: sessions.length > 0 ? sessions.sort().at(-1)! : null,
      note: notes.join(" "),
    };
  }

  /* ------------------------------- internals ------------------------------- */

  private constantAckToTerminal(): number {
    return Math.max(0, Math.round(this.fallbackConstantMs * this.ackFraction));
  }

  /**
   * Resolve calibration if the dimensions changed or the refresh interval elapsed.
   *
   * Deliberately lazy and cached: `resolve()` sorts sample arrays to compute percentiles, so
   * calling it per draw would put a sort on the paper hot path.
   */
  private ensureResolved(): void {
    const dimensions = this.opts.dimensions();
    const key = `${dimensions.broker}|${dimensions.kind}|${dimensions.profile}|${dimensions.bucket}`;
    if (this.cacheKey === key && this.drawsSinceResolve < this.refreshEveryDraws) return;

    this.cacheKey = key;
    this.drawsSinceResolve = 0;
    this.postToAck = this.buildStage(dimensions, "post_to_ack_ms", this.fallbackConstantMs);
    this.ackToTerminal = this.buildStage(dimensions, "ack_to_terminal_ms", this.constantAckToTerminal());
  }

  private buildStage(
    dimensions: CalibrationDimensions,
    stage: "post_to_ack_ms" | "ack_to_terminal_ms",
    constantMs: number,
  ): StageDraw {
    const resolution = this.opts.store.resolve(dimensions, stage);

    // A resolution is usable only when the store says it is MEASURED and there are values to
    // rotate through. Anything else — uncalibrated, too thin, stale — falls back to the
    // constant, and the status records why.
    const usable = resolution.measured && resolution.values.length > 0;
    if (!usable) {
      return {
        source: createLatencySource({ mode: "constant", constantMs }),
        status: {
          resolution,
          measured: false,
          fallbackConstantMs: constantMs,
          fallbackReason: fallbackReasonFor(resolution),
        },
      };
    }
    return {
      source: createLatencySource({
        mode: "recorded_samples",
        constantMs,
        samples: [...resolution.values],
        seed: this.seed,
      }),
      status: { resolution, measured: true, fallbackConstantMs: null, fallbackReason: "not_applicable" },
    };
  }
}

/**
 * Render the calibration header that every parity report and admin diagnostic must show.
 *
 * The point of this block is that a reader can never be left with a bare realism percentage.
 * Sample count, freshness, profile and confidence appear together, so "HIGH confidence" is
 * always accompanied by the evidence for it — and LOW confidence is always accompanied by the
 * reason.
 */
export function formatCalibrationBlock(status: CalibratedLatencyStatus): string {
  const freshness =
    status.freshnessMs === null
      ? "n/a (no measured samples)"
      : status.freshnessMs < 60_000
        ? `${Math.round(status.freshnessMs / 1000)} sec`
        : `${Math.round(status.freshnessMs / 60_000)} min`;
  const lines = [
    "CALIBRATION:",
    `broker: ${status.dimensions.broker}`,
    `region: ${status.region ?? "unlabelled"}`,
    `sample count: ${status.samples}`,
    `freshness: ${freshness}`,
    `profile: ${status.dimensions.profile}`,
    `operation: ${status.dimensions.kind}`,
    `time bucket: ${status.dimensions.bucket}`,
    `status: ${status.status}`,
    `confidence: ${status.confidence}`,
    `measured: ${status.measured ? "yes" : "NO — a configured constant is in use"}`,
  ];
  if (!status.measured) lines.push(`note: ${status.note}`);
  return lines.join("\n");
}
