/**
 * QUEUE-MODEL CALIBRATION — improving the conservative haircut with live evidence, WITHOUT
 * pretending to know NSE queue position.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHAT WE CANNOT KNOW, STATED FIRST
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 * A retail level-2 feed shows aggregate displayed quantity per price level. It does NOT show:
 *
 *   - our position in the queue at a price level,
 *   - how much of a displayed level is a single large order versus fifty small ones,
 *   - hidden or iceberg quantity,
 *   - the matching engine's sequence, or any other participant's intentions.
 *
 * NOTHING in this module reconstructs any of that, and nothing in it should ever be described as
 * doing so. The existing 30 % haircut in `orderPricing.effectiveQty` is a deliberate, transparent
 * stand-in for that ignorance, and it stays.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHAT WE CAN KNOW
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 * For every LIVE limit order we CAN observe, after the fact:
 *
 *   - the displayed depth at submission, and how much of it was within our limit,
 *   - how much we requested,
 *   - how far our limit sat from the touch, and whether it was immediately marketable,
 *   - how much actually filled, and how long it took.
 *
 * The ratio of those last two to the first is a REALISATION RATIO: of the executable quantity we
 * could see, what fraction did we actually get? That is a directly measurable quantity, and it is
 * exactly what the haircut is trying to approximate. So the honest improvement is not to model
 * the queue — it is to measure the realisation ratio and let it recommend a haircut.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * OFFLINE / COLD PATH BY DESIGN (audit divergence D11)
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 * {@link QueueCalibrationEstimator} RECOMMENDS. It never mutates production fills, and nothing
 * reads its output to change how an order is simulated. Two reasons, both deliberate:
 *
 *  1. A handful of one-lot observations cannot justify moving a parameter that governs every
 *     simulated fill. Dynamically steering production from a tiny sample is how a simulator
 *     starts confidently reporting whatever its last few trades happened to do.
 *  2. A haircut change alters the meaning of every historical paper result. That should be a
 *     deliberate, reviewed, logged decision, not an emergent one.
 *
 * So the output is a recommendation with an explicit confidence, and a human applies it via
 * `BOX_QUEUE_LIQUIDITY_HAIRCUT_PCT`.
 *
 * Marketable and passive observations are kept STRICTLY separate: a passive order's realisation
 * ratio is dominated by unobservable queue position, so pooling it with marketable evidence would
 * corrupt the one number we can actually measure well.
 */

import { RingBuffer } from "./metrics.js";
import type { BrokerId, LatencyProfile } from "./latencyModel.js";
import type { OrderSide } from "./types.js";

/**
 * Everything observable about one live LIMIT order's interaction with the book.
 *
 * Captured at submission (the depth fields) and completed at resolution (the outcome fields), so
 * a single record describes what we could see versus what we got.
 */
export interface QueueObservation {
  readonly broker: BrokerId;
  readonly profile: LatencyProfile;
  readonly side: OrderSide;
  readonly tradingsymbol: string;
  /** Total quantity displayed on our side of the book at submission, across all levels. */
  readonly displayedQtyAtSubmit: number;
  /**
   * Displayed quantity within our LIMIT at submission, BEFORE the haircut.
   *
   * This is the denominator of the realisation ratio: the quantity we could actually see and were
   * willing to pay for.
   */
  readonly executableWithinLimitAtSubmit: number;
  readonly requestedQty: number;
  /** Signed ticks from the touch; positive means through the touch (more aggressive). */
  readonly limitOffsetTicks: number | null;
  /** Whether the limit was at or through the opposite touch when submitted. */
  readonly immediatelyMarketable: boolean;
  /** Cumulative quantity that eventually filled. Authoritative. */
  readonly filledQty: number;
  /** Monotonic ms from ACK to the first fill, when there was one. */
  readonly fillLatencyMs: number | null;
  /** True when the order ended partially filled. */
  readonly partial: boolean;
  /** How many new book versions arrived while the order was working, when counted. */
  readonly bookUpdatesWhileWorking: number | null;
  /** Wall clock of the observation, for freshness. */
  readonly atWall: number;
}

/** Liquidity class, so a thin weekly strike is not calibrated against a fat index option. */
export type LiquidityClass = "THIN" | "NORMAL" | "DEEP";

/**
 * Classify an instrument's liquidity from the depth we could see within the limit, relative to
 * what we wanted.
 *
 * Coarse on purpose — three classes, from one observable ratio. A finer taxonomy would need
 * instrument metadata we would then have to keep in step with the exchange's, for no measurable
 * gain in the recommendation.
 */
export function classifyLiquidity(executableWithinLimit: number, requestedQty: number): LiquidityClass {
  if (!(requestedQty > 0)) return "NORMAL";
  const ratio = executableWithinLimit / requestedQty;
  if (ratio < 1) return "THIN";
  if (ratio >= 5) return "DEEP";
  return "NORMAL";
}

export type RecommendationConfidence = "LOW" | "MEDIUM" | "HIGH";

export interface HaircutRecommendation {
  readonly broker: BrokerId;
  readonly profile: LatencyProfile;
  readonly liquidityClass: LiquidityClass;
  readonly samples: number;
  /**
   * Observed marketable-limit realisation ratio: filled ÷ executable-within-limit, at the
   * percentile named below. This is a MEASUREMENT, not a model.
   */
  readonly realisationRatioP50: number | null;
  readonly realisationRatioP25: number | null;
  readonly realisationRatioP10: number | null;
  /**
   * The recommended CONSERVATIVE haircut percentage.
   *
   * Derived from a pessimistic percentile of the realisation ratio, not the median: the haircut
   * exists to stop paper over-filling, so it should reflect a bad-but-plausible outcome rather
   * than a typical one. Null when there is not enough evidence to recommend anything.
   */
  readonly recommendedHaircutPct: number | null;
  /** The haircut currently configured, for comparison. */
  readonly currentHaircutPct: number;
  readonly confidence: RecommendationConfidence;
  /** Observed partial-fill rate, as a fraction. */
  readonly partialFillRate: number | null;
  /** Fraction of observations where requested quantity exceeded visible executable depth. */
  readonly sizeExceededVisibleDepthRate: number | null;
  /** Plain-language explanation, including what it explicitly does NOT claim. */
  readonly note: string;
}

export interface QueueCalibrationOptions {
  /** Ring capacity per (broker, profile, liquidity class). Default 500. */
  window?: number;
  /** Minimum observations before any recommendation is produced. Default 30. */
  minSamples?: number;
  /** At/above this many observations a recommendation is HIGH confidence. Default 200. */
  highConfidenceSamples?: number;
  /** The currently configured haircut, for comparison in the recommendation. */
  currentHaircutPct: number;
}

interface Bucket {
  readonly realisation: RingBuffer;
  readonly fillLatency: RingBuffer;
  readonly sizeVsDepth: RingBuffer;
  observations: number;
  partials: number;
  sizeExceededDepth: number;
  newestAtWall: number;
}

const DEFAULT_WINDOW = 500;
const DEFAULT_MIN_SAMPLES = 30;
const DEFAULT_HIGH_SAMPLES = 200;

function bucketKey(broker: BrokerId, profile: LatencyProfile, liquidity: LiquidityClass): string {
  return `${broker}|${profile}|${liquidity}`;
}

export class QueueCalibrationEstimator {
  private readonly window: number;
  private readonly minSamples: number;
  private readonly highConfidenceSamples: number;
  private readonly currentHaircutPct: number;
  private readonly buckets = new Map<string, Bucket>();
  private droppedObservations = 0;

  constructor(opts: QueueCalibrationOptions) {
    this.window = Math.max(1, Math.floor(opts.window ?? DEFAULT_WINDOW));
    this.minSamples = Math.max(1, Math.floor(opts.minSamples ?? DEFAULT_MIN_SAMPLES));
    this.highConfidenceSamples = Math.max(
      this.minSamples,
      Math.floor(opts.highConfidenceSamples ?? DEFAULT_HIGH_SAMPLES),
    );
    this.currentHaircutPct = Math.min(100, Math.max(0, opts.currentHaircutPct));
  }

  get dropped(): number {
    return this.droppedObservations;
  }

  /**
   * Record one live order's observable interaction with the book. O(1) and FAIL-OPEN.
   *
   * An observation with no visible executable depth is DROPPED rather than counted as a zero
   * realisation: dividing by zero visible quantity says nothing about the queue, and treating it
   * as a total failure to realise would bias the recommendation toward an ever-larger haircut.
   */
  record(observation: QueueObservation): void {
    try {
      const visible = observation.executableWithinLimitAtSubmit;
      if (!Number.isFinite(visible) || visible <= 0) {
        this.droppedObservations++;
        return;
      }
      if (!Number.isFinite(observation.filledQty) || observation.filledQty < 0) {
        this.droppedObservations++;
        return;
      }

      const liquidity = classifyLiquidity(visible, observation.requestedQty);
      const key = bucketKey(observation.broker, observation.profile, liquidity);
      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = {
          realisation: new RingBuffer(this.window),
          fillLatency: new RingBuffer(this.window),
          sizeVsDepth: new RingBuffer(this.window),
          observations: 0,
          partials: 0,
          sizeExceededDepth: 0,
          newestAtWall: observation.atWall,
        };
        this.buckets.set(key, bucket);
      }

      // The realisation ratio is capped at 1: filling MORE than the visible executable quantity
      // means the book replenished while we worked, which is information about replenishment, not
      // about our share of the original level. Letting it exceed 1 would make the recommended
      // haircut negative.
      const wanted = Math.min(observation.requestedQty, visible);
      const realised = wanted > 0 ? Math.min(1, observation.filledQty / wanted) : 0;
      bucket.realisation.push(realised);
      if (observation.fillLatencyMs !== null) bucket.fillLatency.push(observation.fillLatencyMs);

      // MARKET-IMPACT HONESTY (Phase 26). We do not model impact — we EXPOSE size relative to
      // visible executable depth, so a simulated order that is large against the book is flagged
      // rather than silently assumed to be free.
      const sizeRatio = observation.requestedQty / visible;
      bucket.sizeVsDepth.push(sizeRatio);
      if (sizeRatio > 1) bucket.sizeExceededDepth++;

      bucket.observations++;
      if (observation.partial) bucket.partials++;
      if (observation.atWall > bucket.newestAtWall) bucket.newestAtWall = observation.atWall;
    } catch {
      this.droppedObservations++;
    }
  }

  /**
   * Recommend a conservative haircut for one (broker, profile, liquidity class). COLD PATH.
   *
   * The recommendation is derived from the 25th percentile of the realisation ratio, deliberately
   * pessimistic: the haircut's job is to stop paper over-filling, so it should encode a
   * bad-but-plausible realisation, not a typical one. A median-derived haircut would let paper
   * over-fill half the time.
   */
  recommend(broker: BrokerId, profile: LatencyProfile, liquidity: LiquidityClass): HaircutRecommendation {
    const bucket = this.buckets.get(bucketKey(broker, profile, liquidity));
    const samples = bucket?.realisation.size ?? 0;
    const base = {
      broker,
      profile,
      liquidityClass: liquidity,
      samples,
      currentHaircutPct: this.currentHaircutPct,
    };

    if (!bucket || samples < this.minSamples) {
      return {
        ...base,
        realisationRatioP50: null,
        realisationRatioP25: null,
        realisationRatioP10: null,
        recommendedHaircutPct: null,
        confidence: "LOW",
        partialFillRate: null,
        sizeExceededVisibleDepthRate: null,
        note:
          `Only ${samples} observations for ${broker}/${profile}/${liquidity} (needs ${this.minSamples}). ` +
          `NO recommendation — the configured ${this.currentHaircutPct}% haircut stands. ` +
          `This estimator measures realised fill against VISIBLE depth; it does not and cannot reconstruct NSE queue position.`,
      };
    }

    const p50 = round3(bucket.realisation.percentile(0.5));
    const p25 = round3(bucket.realisation.percentile(0.25));
    const p10 = round3(bucket.realisation.percentile(0.1));
    // Conservative: haircut = 1 − pessimistic realisation.
    const recommended = p25 === null ? null : Math.round(Math.min(100, Math.max(0, (1 - p25) * 100)));
    const confidence: RecommendationConfidence =
      samples >= this.highConfidenceSamples ? "HIGH" : samples >= this.minSamples * 2 ? "MEDIUM" : "LOW";

    const partialRate = bucket.observations > 0 ? round3(bucket.partials / bucket.observations) : null;
    const oversizeRate =
      bucket.observations > 0 ? round3(bucket.sizeExceededDepth / bucket.observations) : null;

    return {
      ...base,
      realisationRatioP50: p50,
      realisationRatioP25: p25,
      realisationRatioP10: p10,
      recommendedHaircutPct: recommended,
      confidence,
      partialFillRate: partialRate,
      sizeExceededVisibleDepthRate: oversizeRate,
      note:
        `Observed ${profile} realisation ratio p50=${p50}, p25=${p25}, p10=${p10} over ${samples} ${broker}/${liquidity} orders. ` +
        `Recommended CONSERVATIVE haircut ${recommended}% (from the p25 realisation, not the median, so paper does not over-fill half the time); ` +
        `currently configured ${this.currentHaircutPct}%. Confidence ${confidence}. ` +
        `This is a measurement of realised fill against VISIBLE executable depth. It does NOT reconstruct NSE queue position, ` +
        `hidden liquidity or matching sequence, and it is NOT applied automatically — a human applies it via BOX_QUEUE_LIQUIDITY_HAIRCUT_PCT.`,
    };
  }

  /** Every populated bucket's recommendation. COLD PATH; for admin diagnostics. */
  recommendAll(): HaircutRecommendation[] {
    const out: HaircutRecommendation[] = [];
    for (const key of this.buckets.keys()) {
      const [broker, profile, liquidity] = key.split("|") as [BrokerId, LatencyProfile, LiquidityClass];
      out.push(this.recommend(broker, profile, liquidity));
    }
    return out.sort((a, b) =>
      a.broker.localeCompare(b.broker) ||
      a.profile.localeCompare(b.profile) ||
      a.liquidityClass.localeCompare(b.liquidityClass),
    );
  }

  /**
   * Size-versus-depth exposure for one bucket (Phase 26).
   *
   * Reported so a simulated size that is large relative to visible depth is VISIBLE, rather than
   * being silently assumed to have zero market impact. We deliberately do not convert this into a
   * price-impact model: no observed live data here supports one, and inventing a coefficient would
   * be exactly the kind of fabrication this work exists to avoid.
   */
  sizeVsDepth(
    broker: BrokerId,
    profile: LatencyProfile,
    liquidity: LiquidityClass,
  ): { samples: number; p50: number | null; p95: number | null; max: number | null; exceeded_rate: number | null } {
    const bucket = this.buckets.get(bucketKey(broker, profile, liquidity));
    if (!bucket || bucket.sizeVsDepth.size === 0) {
      return { samples: 0, p50: null, p95: null, max: null, exceeded_rate: null };
    }
    return {
      samples: bucket.sizeVsDepth.size,
      p50: round3(bucket.sizeVsDepth.percentile(0.5)),
      p95: round3(bucket.sizeVsDepth.percentile(0.95)),
      max: round3(bucket.sizeVsDepth.max),
      exceeded_rate: bucket.observations > 0 ? round3(bucket.sizeExceededDepth / bucket.observations) : null,
    };
  }
}

function round3(v: number | null): number | null {
  return v === null ? null : Math.round(v * 1000) / 1000;
}

/** Render a recommendation for an admin diagnostics view. */
export function formatHaircutRecommendation(r: HaircutRecommendation): string {
  const lines = [
    `QUEUE CALIBRATION — ${r.broker} / ${r.profile} / ${r.liquidityClass}`,
    `observations: ${r.samples}`,
  ];
  if (r.realisationRatioP50 === null) {
    lines.push(`recommendation: none (insufficient evidence)`);
    lines.push(`configured haircut: ${r.currentHaircutPct}%`);
    lines.push(`confidence: ${r.confidence}`);
  } else {
    lines.push(`observed realisation ratio: p50 ${r.realisationRatioP50}  p25 ${r.realisationRatioP25}  p10 ${r.realisationRatioP10}`);
    lines.push(`recommended conservative haircut: ${r.recommendedHaircutPct}%`);
    lines.push(`configured haircut: ${r.currentHaircutPct}%`);
    lines.push(`partial-fill rate: ${r.partialFillRate}`);
    lines.push(`size exceeded visible depth: ${r.sizeExceededVisibleDepthRate}`);
    lines.push(`confidence: ${r.confidence}`);
  }
  lines.push("NOT a reconstruction of NSE queue position. Advisory only; never applied automatically.");
  return lines.join("\n");
}
