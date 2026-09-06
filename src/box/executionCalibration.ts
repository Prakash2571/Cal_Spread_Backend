/**
 * EXECUTION CALIBRATION STORE — rolling, bounded, per-dimension distributions of REAL
 * observed live execution latency, plus the honesty machinery that decides whether paper is
 * allowed to use them.
 *
 * WHY (audit divergences D3, D19)
 *
 * Paper's arrival timing was a single constant, `BOX_SIMULATED_LATENCY_MS=250`, forever.
 * A constant is wrong in a specific and damaging way: it has no tail. Real broker latency has
 * a long right tail, and the tail is exactly where a four-leg arbitrage dies — the leg that
 * arrives 900 ms late is the one that finds the book gone. A simulator with no tail
 * systematically overstates fill rates.
 *
 * The fix is not to invent a tail. It is to MEASURE one and feed it back. This store is where
 * measured live samples accumulate, and the thing it is most careful about is refusing to be
 * used before it has earned it.
 *
 * DIMENSIONS, AND WHY EACH ONE IS SEPARATE
 *
 *   broker   — Zerodha and Dhan are different companies, different networks, different
 *              matching-engine gateways. Pooling them describes neither. NEVER mixed.
 *   region   — a deployment in ap-south-1 and one in us-east-1 have different physical RTTs.
 *              Held per store, and a store never merges samples from another region.
 *   kind     — ENTRY / EXIT / UNWIND / CANCEL / MODIFY. Cancel latency is not entry latency.
 *   profile  — MARKETABLE_LIMIT vs PASSIVE_LIMIT. See latencyModel: passive behaviour depends
 *              on unknowable queue position, so its statistics must never contaminate the
 *              marketable ones the strategy actually relies on.
 *   bucket   — OPEN / NORMAL / CLOSE. Used ONLY when the bucket has enough samples of its own.
 *   stage    — the eight separately-measurable spans of one order's life.
 *
 * FRESHNESS AND SESSIONS (Phase 24)
 *
 * Yesterday's latency is not today's. Samples carry an IST session key, and
 * {@link ExecutionCalibrationStore.resolve} counts only samples from sessions inside the
 * configured freshness window when deciding what paper may use. Older samples are RETAINED —
 * they are useful for analytics and for spotting drift — but they are excluded from active
 * calibration rather than silently ageing into it.
 *
 * THE HONESTY CONTRACT
 *
 * {@link ResolvedCalibration.measured} is the single most important field in this module. It is
 * false whenever the returned numbers are a configured fallback rather than live observations.
 * Nothing downstream may present `measured: false` figures as measured latency, and
 * `confidence` is forced to LOW in that case. A fallback is always explained in `note`.
 *
 * PERFORMANCE
 *
 *  - `record()` is O(1): one map lookup and one ring-buffer write. No allocation beyond the
 *    first sample for a key, no sorting, no I/O. It is safe to call per broker operation.
 *  - `resolve()` and `snapshot()` sort copies to compute percentiles and are COLD PATH ONLY.
 *  - Every distribution is a fixed-capacity ring; memory is constant regardless of uptime.
 *  - Keys are bounded by construction: brokers × kinds × profiles × buckets × stages.
 *
 * FAIL-OPEN. `record()` never throws. Calibration is observability; it may degrade, but it may
 * never interfere with an order.
 */

import { RingBuffer } from "./metrics.js";
import {
  BROKER_IDS,
  DEFAULT_CALIBRATION_THRESHOLDS,
  DEFAULT_CONFIDENCE_THRESHOLDS,
  LATENCY_OPERATION_KINDS,
  LATENCY_PROFILES,
  TIME_OF_DAY_BUCKETS,
  classifyCalibration,
  classifyConfidence,
  classifyTimeOfDayBucket,
  istMinutesOfDayFor,
  istSessionKey,
  type BrokerId,
  type CalibrationConfidence,
  type CalibrationStatus,
  type CalibrationThresholds,
  type ConfidenceThresholds,
  type LatencyOperationKind,
  type LatencyProfile,
  type TimeBucketBoundaries,
  type TimeOfDayBucket,
} from "./latencyModel.js";

/**
 * The separately-measurable stages of one broker operation, exactly as the brief enumerates
 * them. Each is a span between two OBSERVABLE events — none requires exchange-internal
 * knowledge.
 */
export const CALIBRATION_STAGES = [
  /** Enqueued in our scheduler → a concurrency slot was acquired. Our own queueing. */
  "scheduler_wait_ms",
  /** Slot acquired → transport pacing permitted the call. Our own rate limiting. */
  "transport_wait_ms",
  /** POST left the wire → HTTP response returned. Pure transport + broker front end. */
  "post_to_http_response_ms",
  /** POST left the wire → the broker reported the order accepted/live. */
  "post_to_ack_ms",
  /** ACK → the first quantity was reported filled. */
  "ack_to_first_fill_ms",
  /** ACK → the order reached a terminal state. How long a concurrency slot is held. */
  "ack_to_terminal_ms",
  /** First partial fill → terminal. How long a partially-filled order lingers. */
  "partial_to_terminal_ms",
  /** Cancel request left the wire → terminal confirmation. THE cancel-race window. */
  "cancel_request_to_terminal_ms",
] as const;
export type CalibrationStage = (typeof CALIBRATION_STAGES)[number];

/** The dimensions a sample is filed under. All five are required; none is ever pooled away. */
export interface CalibrationDimensions {
  readonly broker: BrokerId;
  readonly kind: LatencyOperationKind;
  readonly profile: LatencyProfile;
  readonly bucket: TimeOfDayBucket;
}

export interface CalibrationSample extends CalibrationDimensions {
  readonly stage: CalibrationStage;
  /** The measured span in ms. Must come from a MONOTONIC subtraction. */
  readonly valueMs: number;
  /** Wall-clock ms of the observation. Used only for freshness and audit. */
  readonly atWall: number;
  /** IST session key (`YYYY-MM-DD`). Derived from `atWall` when omitted. */
  readonly session?: string;
}

export interface CalibrationPercentiles {
  readonly p50: number | null;
  readonly p75: number | null;
  readonly p90: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
}

/** Why a resolution used dimensions other than the ones asked for. */
export type CalibrationFallback =
  /** The exact requested dimensions had enough fresh samples. */
  | "none"
  /** The time bucket was too thin; samples were pooled across buckets for that profile+kind. */
  | "bucket_pooled"
  /** The operation kind was too thin; samples were pooled across kinds for that profile. */
  | "kind_pooled"
  /** Nothing measured is usable. The caller must use its documented constant fallback. */
  | "unavailable";

/**
 * The answer to "what latency should paper use for this operation, and may it be trusted?"
 *
 * Read `measured` before reading the numbers.
 */
export interface ResolvedCalibration {
  readonly stage: CalibrationStage;
  readonly requested: CalibrationDimensions;
  /** The dimensions the samples actually came from. Differs from `requested` on a fallback. */
  readonly used: CalibrationDimensions | null;
  readonly fallback: CalibrationFallback;
  readonly status: CalibrationStatus;
  readonly confidence: CalibrationConfidence;
  /** Fresh samples backing the figures. */
  readonly samples: number;
  /** Age of the newest backing sample, ms. Null when there are none. */
  readonly freshnessMs: number | null;
  /** IST session key of the newest backing sample. */
  readonly newestSession: string | null;
  readonly percentiles: CalibrationPercentiles;
  /**
   * The raw backing samples, in ring order.
   *
   * Exposed because a simulator that wants to reproduce a measured distribution should
   * consume the ACTUAL observations — that is the only way to inherit the real right-hand
   * tail, which is precisely the part a percentile summary flattens and a constant erases.
   *
   * Empty when `measured` is false. Bounded by the ring capacity times the pooled dimensions.
   * COLD PATH: admin surfaces should omit this field; it is for consumption, not display.
   */
  readonly values: readonly number[];
  /**
   * TRUE only when the percentiles come from measured live observations.
   *
   * When false the percentiles are all null and the caller MUST fall back to its own
   * documented constant — and must never describe the result as measured.
   */
  readonly measured: boolean;
  /** Plain-language explanation of the status/fallback, for admin diagnostics. */
  readonly note: string;
}

export interface CalibrationStoreOptions {
  /** Ring capacity per (dimension, stage) distribution. Default 500. */
  window?: number;
  /**
   * Explicitly-configured deployment region. NEVER auto-detected, and never merged across
   * regions — a store labelled ap-south-1 contains only ap-south-1 observations.
   */
  region?: string | null;
  /** Minimum fresh samples before a set may be used at all. Default 30. */
  minSamples?: number;
  /**
   * Minimum fresh samples before a TIME BUCKET is used in preference to the pooled set.
   * Deliberately higher than `minSamples`: activating a narrow bucket on a handful of
   * observations is the definition of overfitting. Default 60.
   */
  bucketMinSamples?: number;
  /** Samples from sessions older than this are excluded from ACTIVE calibration. Default 3 days. */
  maxAgeMs?: number;
  thresholds?: CalibrationThresholds;
  confidence?: ConfidenceThresholds;
  timeBuckets?: TimeBucketBoundaries;
  /** Wall clock, for freshness only. Injected so tests control staleness exactly. */
  nowWall?: () => number;
}

/** One distribution's exported form — enough to restore it after a restart. */
export interface CalibrationExportEntry extends CalibrationDimensions {
  readonly stage: CalibrationStage;
  readonly values: number[];
  readonly newestAtWall: number;
  readonly newestSession: string;
  readonly totalObserved: number;
}

export interface CalibrationExport {
  readonly region: string | null;
  readonly generated_at_wall: number;
  readonly entries: CalibrationExportEntry[];
}

/** A bucket of samples for one (dimensions, stage) key. */
interface Distribution {
  readonly values: RingBuffer;
  newestAtWall: number;
  newestSession: string;
  /** Every sample ever recorded, including evicted ones. */
  totalObserved: number;
}

const DEFAULT_WINDOW = 500;
const DEFAULT_MIN_SAMPLES = 30;
const DEFAULT_BUCKET_MIN_SAMPLES = 60;
const DEFAULT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

function distributionKey(d: CalibrationDimensions, stage: CalibrationStage): string {
  return `${d.broker}|${d.kind}|${d.profile}|${d.bucket}|${stage}`;
}

export class ExecutionCalibrationStore {
  private readonly window: number;
  private readonly minSamples: number;
  private readonly bucketMinSamples: number;
  private readonly maxAgeMs: number;
  private readonly thresholds: CalibrationThresholds;
  private readonly confidenceThresholds: ConfidenceThresholds;
  private readonly timeBuckets: TimeBucketBoundaries | undefined;
  private readonly nowWall: () => number;
  private readonly distributions = new Map<string, Distribution>();
  /** Per-broker sample totals and newest observation, for the top-line status. */
  private readonly brokerTotals = new Map<BrokerId, number>();
  private readonly brokerNewest = new Map<BrokerId, number>();
  private droppedSamples = 0;

  constructor(opts: CalibrationStoreOptions = {}) {
    this.window = Math.max(1, Math.floor(opts.window ?? DEFAULT_WINDOW));
    this.region = opts.region ?? null;
    this.minSamples = Math.max(1, Math.floor(opts.minSamples ?? DEFAULT_MIN_SAMPLES));
    this.bucketMinSamples = Math.max(
      this.minSamples,
      Math.floor(opts.bucketMinSamples ?? DEFAULT_BUCKET_MIN_SAMPLES),
    );
    this.maxAgeMs = Math.max(0, Math.floor(opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS));
    this.thresholds = opts.thresholds ?? DEFAULT_CALIBRATION_THRESHOLDS;
    this.confidenceThresholds = opts.confidence ?? DEFAULT_CONFIDENCE_THRESHOLDS;
    this.timeBuckets = opts.timeBuckets;
    this.nowWall = opts.nowWall ?? (() => Date.now());
  }

  /** The configured deployment region these samples belong to. Never inferred. */
  readonly region: string | null;

  /** Samples rejected as malformed. Surfaced so silent data loss is visible. */
  get dropped(): number {
    return this.droppedSamples;
  }

  /**
   * Record one measured stage span. O(1), allocation-free after the first sample for a key.
   *
   * FAIL-OPEN: never throws. A malformed sample is counted in {@link dropped} and discarded —
   * it is emphatically NOT coerced into a plausible-looking number, because a fabricated
   * sample is worse than a missing one.
   */
  record(sample: CalibrationSample): void {
    try {
      const value = sample.valueMs;
      // A negative span means the caller subtracted a wall clock, or subtracted backwards.
      // Either way it is not evidence, and rounding it to zero would bias the distribution.
      if (!Number.isFinite(value) || value < 0) {
        this.droppedSamples++;
        return;
      }
      if (!Number.isFinite(sample.atWall)) {
        this.droppedSamples++;
        return;
      }
      const session = sample.session ?? istSessionKey(sample.atWall);
      const key = distributionKey(sample, sample.stage);
      let dist = this.distributions.get(key);
      if (!dist) {
        dist = {
          values: new RingBuffer(this.window),
          newestAtWall: sample.atWall,
          newestSession: session,
          totalObserved: 0,
        };
        this.distributions.set(key, dist);
      }
      dist.values.push(value);
      dist.totalObserved++;
      if (sample.atWall >= dist.newestAtWall) {
        dist.newestAtWall = sample.atWall;
        dist.newestSession = session;
      }
      this.brokerTotals.set(sample.broker, (this.brokerTotals.get(sample.broker) ?? 0) + 1);
      const newest = this.brokerNewest.get(sample.broker);
      if (newest === undefined || sample.atWall > newest) {
        this.brokerNewest.set(sample.broker, sample.atWall);
      }
    } catch {
      /* observability must never affect execution */
      this.droppedSamples++;
    }
  }

  /**
   * Convenience recorder that derives the time bucket and session from the observation's wall
   * clock, so callers do not each reimplement the IST arithmetic.
   */
  recordSpan(args: {
    broker: BrokerId;
    kind: LatencyOperationKind;
    profile: LatencyProfile;
    stage: CalibrationStage;
    valueMs: number;
    atWall: number;
  }): void {
    const bucket = classifyTimeOfDayBucket(istMinutesOfDayFor(args.atWall), this.timeBuckets);
    this.record({ ...args, bucket });
  }

  /**
   * Resolve what paper may use for one (dimensions, stage), applying the fallback ladder and
   * reporting exactly what happened.
   *
   * THE FALLBACK LADDER, narrowest first:
   *
   *   1. the exact requested bucket — used only with `bucketMinSamples` fresh samples, so a
   *      thin bucket never overfits;
   *   2. all buckets pooled for that broker+kind+profile;
   *   3. all kinds pooled for that broker+profile — still never crossing broker or profile;
   *   4. nothing. `measured: false`, and the caller uses its own documented constant.
   *
   * Steps 1–3 never cross a broker boundary and never cross the marketable/passive boundary.
   * Those two are hard walls, because pooling across them would produce a number that
   * describes no real population.
   */
  resolve(dimensions: CalibrationDimensions, stage: CalibrationStage): ResolvedCalibration {
    const now = this.nowWall();

    // 1 ─ the exact bucket, if it has earned the right to be used on its own.
    const exact = this.freshDistribution(dimensions, stage, now);
    if (exact && exact.samples >= this.bucketMinSamples) {
      return this.describe(stage, dimensions, dimensions, "none", exact, now, [
        `bucket ${dimensions.bucket} has ${exact.samples} fresh samples (>= ${this.bucketMinSamples}).`,
      ]);
    }

    const notes: string[] = [];
    if (exact) {
      notes.push(
        `bucket ${dimensions.bucket} had only ${exact.samples} fresh samples (needs ${this.bucketMinSamples}); pooled across buckets to avoid overfitting.`,
      );
    } else {
      notes.push(`bucket ${dimensions.bucket} has no fresh samples; pooled across buckets.`);
    }

    // 2 ─ pool the buckets. Same broker, kind and profile.
    const pooledBuckets = this.pool(
      TIME_OF_DAY_BUCKETS.map((bucket) => ({ ...dimensions, bucket })),
      stage,
      now,
    );
    if (pooledBuckets.samples >= this.minSamples) {
      return this.describe(stage, dimensions, { ...dimensions }, "bucket_pooled", pooledBuckets, now, notes);
    }

    notes.push(
      `broker+kind+profile pooled to ${pooledBuckets.samples} fresh samples (needs ${this.minSamples}); pooling across operation kinds.`,
    );

    // 3 ─ pool the kinds too. Still same broker and same profile — never crossed.
    const pooledKinds = this.pool(
      LATENCY_OPERATION_KINDS.flatMap((kind) =>
        TIME_OF_DAY_BUCKETS.map((bucket) => ({ ...dimensions, kind, bucket })),
      ),
      stage,
      now,
    );
    if (pooledKinds.samples >= this.minSamples) {
      return this.describe(stage, dimensions, { ...dimensions }, "kind_pooled", pooledKinds, now, notes);
    }

    // 4 ─ nothing usable. Say so plainly.
    const total = pooledKinds.samples;
    return {
      stage,
      requested: dimensions,
      used: null,
      fallback: "unavailable",
      status: total > 0 ? "PARTIALLY_CALIBRATED" : "UNCALIBRATED",
      confidence: "LOW",
      samples: total,
      freshnessMs: pooledKinds.newestAtWall === null ? null : Math.max(0, now - pooledKinds.newestAtWall),
      newestSession: pooledKinds.newestSession,
      percentiles: { p50: null, p75: null, p90: null, p95: null, p99: null },
      values: [],
      measured: false,
      note:
        total > 0
          ? `Only ${total} fresh ${dimensions.broker}/${dimensions.profile} samples for ${stage} (needs ${this.minSamples}). NOT calibrated — the caller's constant fallback is in use.`
          : `No fresh ${dimensions.broker}/${dimensions.profile} samples for ${stage}. NOT calibrated — the caller's constant fallback is in use.`,
    };
  }

  /**
   * Every recorded distribution, for admin diagnostics. Cold path.
   *
   * Includes stale sets, flagged as such — they are retained for analytics precisely so drift
   * is visible, and excluding them from the view would hide it.
   */
  snapshot(): Array<
    CalibrationDimensions & {
      stage: CalibrationStage;
      samples: number;
      total_observed: number;
      newest_session: string;
      age_ms: number;
      fresh: boolean;
      status: CalibrationStatus;
      percentiles: CalibrationPercentiles;
    }
  > {
    const now = this.nowWall();
    const out: ReturnType<ExecutionCalibrationStore["snapshot"]> = [];
    for (const [key, dist] of this.distributions) {
      const parts = key.split("|");
      const [broker, kind, profile, bucket, stage] = parts as [
        BrokerId,
        LatencyOperationKind,
        LatencyProfile,
        TimeOfDayBucket,
        CalibrationStage,
      ];
      const age = Math.max(0, now - dist.newestAtWall);
      out.push({
        broker,
        kind,
        profile,
        bucket,
        stage,
        samples: dist.values.size,
        total_observed: dist.totalObserved,
        newest_session: dist.newestSession,
        age_ms: age,
        fresh: age <= this.maxAgeMs,
        status: classifyCalibration(dist.values.size, age, this.thresholds),
        percentiles: percentilesOf(dist.values.values()),
      });
    }
    out.sort((a, b) =>
      a.broker.localeCompare(b.broker) ||
      a.profile.localeCompare(b.profile) ||
      a.kind.localeCompare(b.kind) ||
      a.bucket.localeCompare(b.bucket) ||
      a.stage.localeCompare(b.stage),
    );
    return out;
  }

  /** Top-line per-broker calibration status, for the parity-report header. */
  brokerStatus(broker: BrokerId): {
    broker: BrokerId;
    region: string | null;
    samples: number;
    newest_session: string | null;
    age_ms: number | null;
    status: CalibrationStatus;
  } {
    const samples = this.brokerTotals.get(broker) ?? 0;
    const newest = this.brokerNewest.get(broker);
    const age = newest === undefined ? null : Math.max(0, this.nowWall() - newest);
    return {
      broker,
      region: this.region,
      samples,
      newest_session: newest === undefined ? null : istSessionKey(newest),
      age_ms: age,
      status: classifyCalibration(samples, age, this.thresholds),
    };
  }

  allBrokerStatus(): ReturnType<ExecutionCalibrationStore["brokerStatus"]>[] {
    return BROKER_IDS.map((b) => this.brokerStatus(b));
  }

  /**
   * Export every distribution so calibration survives a restart. Cold path.
   *
   * Contains only anonymised latency numbers, dimension labels and the explicitly-configured
   * region. NO credentials, NO tokens, NO instrument or position data.
   */
  export(): CalibrationExport {
    const entries: CalibrationExportEntry[] = [];
    for (const [key, dist] of this.distributions) {
      const [broker, kind, profile, bucket, stage] = key.split("|") as [
        BrokerId,
        LatencyOperationKind,
        LatencyProfile,
        TimeOfDayBucket,
        CalibrationStage,
      ];
      entries.push({
        broker,
        kind,
        profile,
        bucket,
        stage,
        values: dist.values.values(),
        newestAtWall: dist.newestAtWall,
        newestSession: dist.newestSession,
        totalObserved: dist.totalObserved,
      });
    }
    return { region: this.region, generated_at_wall: this.nowWall(), entries };
  }

  /**
   * Restore exported distributions.
   *
   * REFUSES a payload from a different region: merging regions would silently blend two
   * different physical RTTs into one distribution that describes neither deployment. Returns
   * the number of entries imported, so a refusal is visible rather than mysterious.
   */
  import(payload: CalibrationExport): { imported: number; skipped: number; reason: string | null } {
    if ((payload.region ?? null) !== this.region) {
      return {
        imported: 0,
        skipped: payload.entries.length,
        reason: `region mismatch: payload is ${payload.region ?? "unlabelled"}, store is ${this.region ?? "unlabelled"}`,
      };
    }
    let imported = 0;
    let skipped = 0;
    for (const entry of payload.entries) {
      if (!isKnownDimensions(entry) || !CALIBRATION_STAGES.includes(entry.stage)) {
        skipped++;
        continue;
      }
      for (const value of entry.values) {
        this.record({
          broker: entry.broker,
          kind: entry.kind,
          profile: entry.profile,
          bucket: entry.bucket,
          stage: entry.stage,
          valueMs: value,
          atWall: entry.newestAtWall,
          session: entry.newestSession,
        });
      }
      imported++;
    }
    return { imported, skipped, reason: null };
  }

  /* ------------------------------- internals ------------------------------- */

  /** A single distribution, or null when it does not exist or is entirely stale. */
  private freshDistribution(
    dimensions: CalibrationDimensions,
    stage: CalibrationStage,
    now: number,
  ): PooledSamples | null {
    const dist = this.distributions.get(distributionKey(dimensions, stage));
    if (!dist || dist.values.size === 0) return null;
    if (now - dist.newestAtWall > this.maxAgeMs) return null;
    return {
      values: dist.values.values(),
      samples: dist.values.size,
      newestAtWall: dist.newestAtWall,
      newestSession: dist.newestSession,
    };
  }

  /**
   * Pool several distributions.
   *
   * A distribution whose newest sample is outside the freshness window contributes NOTHING —
   * it is not merged in with a discount. This is the Phase-24 rule: yesterday's samples are
   * kept for analytics but excluded from active calibration.
   */
  private pool(
    dimensionsList: readonly CalibrationDimensions[],
    stage: CalibrationStage,
    now: number,
  ): PooledSamples {
    const values: number[] = [];
    let newestAtWall: number | null = null;
    let newestSession: string | null = null;
    for (const dimensions of dimensionsList) {
      const dist = this.distributions.get(distributionKey(dimensions, stage));
      if (!dist || dist.values.size === 0) continue;
      if (now - dist.newestAtWall > this.maxAgeMs) continue;
      for (const v of dist.values.values()) values.push(v);
      if (newestAtWall === null || dist.newestAtWall > newestAtWall) {
        newestAtWall = dist.newestAtWall;
        newestSession = dist.newestSession;
      }
    }
    return { values, samples: values.length, newestAtWall, newestSession };
  }

  private describe(
    stage: CalibrationStage,
    requested: CalibrationDimensions,
    used: CalibrationDimensions,
    fallback: CalibrationFallback,
    pooled: PooledSamples,
    now: number,
    notes: string[],
  ): ResolvedCalibration {
    const age = pooled.newestAtWall === null ? null : Math.max(0, now - pooled.newestAtWall);
    const status = classifyCalibration(pooled.samples, age, this.thresholds);
    const fellBack = fallback !== "none";
    const confidence = classifyConfidence({
      status,
      sampleCount: pooled.samples,
      measured: true,
      fellBack,
      thresholds: this.confidenceThresholds,
    });
    return {
      stage,
      requested,
      used,
      fallback,
      status,
      confidence,
      samples: pooled.samples,
      freshnessMs: age,
      newestSession: pooled.newestSession,
      percentiles: percentilesOf(pooled.values),
      values: pooled.values,
      measured: true,
      note: notes.join(" "),
    };
  }
}

interface PooledSamples {
  values: number[];
  samples: number;
  newestAtWall: number | null;
  newestSession: string | null;
}

/** Nearest-rank percentiles over a sample array. Sorts a copy — cold path only. */
export function percentilesOf(values: readonly number[]): CalibrationPercentiles {
  if (values.length === 0) return { p50: null, p75: null, p90: null, p95: null, p99: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number): number => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
    return Math.round(sorted[idx]! * 100) / 100;
  };
  return { p50: at(0.5), p75: at(0.75), p90: at(0.9), p95: at(0.95), p99: at(0.99) };
}

function isKnownDimensions(d: CalibrationDimensions): boolean {
  return (
    BROKER_IDS.includes(d.broker) &&
    LATENCY_OPERATION_KINDS.includes(d.kind) &&
    LATENCY_PROFILES.includes(d.profile) &&
    TIME_OF_DAY_BUCKETS.includes(d.bucket)
  );
}
