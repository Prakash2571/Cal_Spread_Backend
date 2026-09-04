/**
 * LIVE EXECUTION OBSERVABILITY — bounded, fail-open, per-broker latency measurement.
 *
 * PURPOSE
 *
 * To calibrate paper from what the account ACTUALLY experienced, we must first measure it.
 * This store collects high-resolution timing of live Box broker operations and exposes:
 *
 *   - rolling p50/p95/p99 distributions per broker, per operation kind (Phase 10),
 *   - a bounded recent timeline of raw {@link BoxBrokerTiming} records (Phase 11),
 *   - execution-outcome rates (Phase 23),
 *   - a deterministic calibration dataset export to feed back into paper (Phase 12),
 *   - a calibration status per broker (Phase 34).
 *
 * HARD RULES
 *
 *  1. FAIL-OPEN. Every public mutator is wrapped so a metrics failure — full buffer,
 *     serialisation error, anything — can NEVER throw into, block, or alter the trading
 *     path. Observability fails open; trading safety stays fail-closed elsewhere.
 *  2. BOUNDED. Every distribution is a fixed-size {@link RingBuffer}; the timeline is a
 *     fixed-size object ring. Memory is constant regardless of uptime. No unbounded arrays.
 *  3. NO I/O ON THE HOT PATH. Recording is O(1) in-memory. Persistence/export is a cold
 *     path a caller invokes explicitly; this module never touches Mongo or the network.
 *  4. MONOTONIC INPUTS. Timestamps are expected to come from a monotonic clock
 *     (performance.now()); the store only ever subtracts them to form durations.
 *  5. PER-BROKER ISOLATION. Zerodha and Dhan distributions never mix.
 */

import { RingBuffer } from "./metrics.js";
import type { BoxLegRole, BoxOrderPurpose } from "./types.js";
import {
  BROKER_IDS,
  classifyCalibration,
  DEFAULT_CALIBRATION_THRESHOLDS,
  LATENCY_OPERATION_KINDS,
  type BrokerId,
  type CalibrationStatus,
  type CalibrationThresholds,
  type LatencyOperationKind,
} from "./latencyModel.js";

/**
 * One broker operation's raw timeline. Monotonic ms timestamps; any stage that did not
 * happen (e.g. no fill on a rejected order) is null — never fabricated.
 */
export interface BoxBrokerTiming {
  broker: BrokerId;
  trade_id: string | null;
  attempt_id: string;
  role: BoxLegRole;
  purpose: BoxOrderPurpose;
  kind: LatencyOperationKind;

  detected_at: number | null;
  queued_at: number | null;
  dequeued_at: number | null;
  post_started_at: number | null;
  post_returned_at: number | null;
  acknowledged_at: number | null;
  first_fill_at: number | null;
  last_fill_at: number | null;
  terminal_at: number | null;
  cancel_requested_at: number | null;
  cancel_confirmed_at: number | null;
}

/** The mutually-exclusive outcome of a Box execution attempt (Phase 23). */
export type BoxExecutionOutcome =
  | "filled_4_of_4"
  | "partial"
  | "no_fill"
  | "timeout"
  | "cancel_race"
  | "broker_reject"
  | "abort_after_fill"
  | "clean_unwind"
  | "failed_unwind"
  | "residual";

export const BOX_EXECUTION_OUTCOMES: readonly BoxExecutionOutcome[] = [
  "filled_4_of_4",
  "partial",
  "no_fill",
  "timeout",
  "cancel_race",
  "broker_reject",
  "abort_after_fill",
  "clean_unwind",
  "failed_unwind",
  "residual",
] as const;

/** Box-level (across the four legs) timing recorded per attempt. */
export interface BoxOutcomeTiming {
  broker: BrokerId;
  outcome: BoxExecutionOutcome;
  detection_to_first_submit_ms?: number | null;
  detection_to_last_submit_ms?: number | null;
  detection_to_first_fill_ms?: number | null;
  detection_to_all_four_filled_ms?: number | null;
  first_fill_to_last_fill_ms?: number | null;
  unhedged_exposure_duration_ms?: number | null;
  unwind_duration_ms?: number | null;
}

/** Per-order component metrics derived from a {@link BoxBrokerTiming}. */
const LEG_COMPONENTS = [
  "queue_wait_ms",
  "transport_wait_ms",
  "broker_post_duration_ms",
  "submit_to_ack_ms",
  "submit_to_first_fill_ms",
  "submit_to_terminal_ms",
  "ack_to_first_fill_ms",
  "ack_to_terminal_ms",
  "first_fill_to_last_fill_ms",
  "first_fill_to_terminal_ms",
  "cancel_confirmation_ms",
] as const;
type LegComponent = (typeof LEG_COMPONENTS)[number];

const BOX_COMPONENTS = [
  "detection_to_first_submit_ms",
  "detection_to_last_submit_ms",
  "detection_to_first_fill_ms",
  "detection_to_all_four_filled_ms",
  "first_fill_to_last_fill_ms",
  "unhedged_exposure_duration_ms",
  "unwind_duration_ms",
] as const;
type BoxComponent = (typeof BOX_COMPONENTS)[number];

/** later − earlier, or null if either endpoint is missing or the order is inverted. */
function span(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from == null || to == null) return null;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const d = to - from;
  return d >= 0 ? d : null;
}

/** Derive the per-order component durations. "submit" is the POST leaving the wire. */
export function deriveLegComponents(t: BoxBrokerTiming): Partial<Record<LegComponent, number>> {
  const out: Partial<Record<LegComponent, number>> = {};
  const put = (k: LegComponent, v: number | null) => {
    if (v !== null) out[k] = v;
  };
  put("queue_wait_ms", span(t.queued_at, t.dequeued_at));
  put("transport_wait_ms", span(t.dequeued_at, t.post_started_at));
  put("broker_post_duration_ms", span(t.post_started_at, t.post_returned_at));
  put("submit_to_ack_ms", span(t.post_started_at, t.acknowledged_at));
  put("submit_to_first_fill_ms", span(t.post_started_at, t.first_fill_at));
  put("submit_to_terminal_ms", span(t.post_started_at, t.terminal_at));
  put("ack_to_first_fill_ms", span(t.acknowledged_at, t.first_fill_at));
  put("ack_to_terminal_ms", span(t.acknowledged_at, t.terminal_at));
  put("first_fill_to_last_fill_ms", span(t.first_fill_at, t.last_fill_at));
  put("first_fill_to_terminal_ms", span(t.first_fill_at, t.terminal_at));
  put("cancel_confirmation_ms", span(t.cancel_requested_at, t.cancel_confirmed_at));
  return out;
}

/** A fixed-size object ring for the recent raw timeline. Bounded; overwrites oldest. */
class ObjectRing<T> {
  private readonly buf: (T | undefined)[];
  private cursor = 0;
  private filled = 0;
  constructor(readonly capacity: number) {
    this.buf = new Array(Math.max(1, Math.floor(capacity)));
  }
  push(v: T): void {
    this.buf[this.cursor] = v;
    this.cursor = (this.cursor + 1) % this.buf.length;
    if (this.filled < this.buf.length) this.filled++;
  }
  values(): T[] {
    const out: T[] = [];
    const start = this.filled === this.buf.length ? this.cursor : 0;
    for (let i = 0; i < this.filled; i++) {
      const v = this.buf[(start + i) % this.buf.length];
      if (v !== undefined) out.push(v);
    }
    return out;
  }
  get size(): number {
    return this.filled;
  }
}

export interface BrokerTimingStoreOptions {
  /** RingBuffer capacity per distribution. Default 500 (matches BoxMetrics). */
  window?: number;
  /** Recent raw-timeline capacity. Default 200. */
  timelineSize?: number;
  /** Explicitly-configured deployment region label (Phase 25). Never auto-detected. */
  region?: string | null;
  thresholds?: CalibrationThresholds;
  /** Monotonic-ish wall clock for sample-age/staleness only (NOT for durations). */
  now?: () => number;
}

/** The status endpoint's per-broker latency summary shape. */
export interface BrokerLatencySnapshot {
  broker: BrokerId;
  region: string | null;
  calibration_status: CalibrationStatus;
  sample_count: number;
  last_sample_age_ms: number | null;
  by_kind: Record<string, Record<string, ReturnType<RingBuffer["summary"]>>>;
  box: Record<string, ReturnType<RingBuffer["summary"]>>;
  outcomes: Record<string, number>;
}

/** A deterministic, feed-back-ready calibration dataset (Phase 12). */
export interface BoxLatencyCalibrationDataset {
  broker: BrokerId;
  region: string | null;
  generated_at: string;
  sample_count: number;
  calibration_status: CalibrationStatus;
  entry: {
    post_to_ack_ms: number[];
    ack_to_terminal_ms: number[];
    submit_to_first_fill_ms: number[];
    submit_to_terminal_ms: number[];
  };
}

export class BrokerTimingStore {
  private readonly window: number;
  private readonly region: string | null;
  private readonly thresholds: CalibrationThresholds;
  private readonly now: () => number;

  // key: `${broker}|${kind}|${component}` → RingBuffer
  private readonly legBuckets = new Map<string, RingBuffer>();
  // key: `${broker}|${component}` → RingBuffer  (box-level)
  private readonly boxBuckets = new Map<string, RingBuffer>();
  // key: `${broker}|${outcome}` → count
  private readonly outcomes = new Map<string, number>();
  private readonly timeline: ObjectRing<BoxBrokerTiming>;
  // Per broker: how many leg samples recorded, and the wall-clock of the newest.
  private readonly sampleCount = new Map<BrokerId, number>();
  private readonly lastSampleAt = new Map<BrokerId, number>();

  constructor(opts: BrokerTimingStoreOptions = {}) {
    this.window = Math.max(1, Math.floor(opts.window ?? 500));
    this.region = opts.region ?? null;
    this.thresholds = opts.thresholds ?? DEFAULT_CALIBRATION_THRESHOLDS;
    this.now = opts.now ?? (() => Date.now());
    this.timeline = new ObjectRing<BoxBrokerTiming>(opts.timelineSize ?? 200);
  }

  private bucket(map: Map<string, RingBuffer>, key: string): RingBuffer {
    let b = map.get(key);
    if (!b) {
      b = new RingBuffer(this.window);
      map.set(key, b);
    }
    return b;
  }

  /**
   * Record one live broker operation's timeline. FAIL-OPEN: never throws. O(1) per
   * component. Appends to the recent timeline and updates the per-broker calibration
   * bookkeeping.
   */
  recordLegTiming(t: BoxBrokerTiming): void {
    try {
      const components = deriveLegComponents(t);
      let recorded = false;
      for (const [component, value] of Object.entries(components)) {
        this.bucket(this.legBuckets, `${t.broker}|${t.kind}|${component}`).push(value);
        recorded = true;
      }
      this.timeline.push(t);
      if (recorded) {
        this.sampleCount.set(t.broker, (this.sampleCount.get(t.broker) ?? 0) + 1);
        this.lastSampleAt.set(t.broker, this.now());
      }
    } catch {
      /* observability must never affect execution */
    }
  }

  /** Record a Box-level execution outcome + its detection-relative timings. FAIL-OPEN. */
  recordBoxOutcome(t: BoxOutcomeTiming): void {
    try {
      this.outcomes.set(`${t.broker}|${t.outcome}`, (this.outcomes.get(`${t.broker}|${t.outcome}`) ?? 0) + 1);
      const push = (component: BoxComponent, v: number | null | undefined) => {
        if (v != null && Number.isFinite(v)) this.bucket(this.boxBuckets, `${t.broker}|${component}`).push(v);
      };
      push("detection_to_first_submit_ms", t.detection_to_first_submit_ms);
      push("detection_to_last_submit_ms", t.detection_to_last_submit_ms);
      push("detection_to_first_fill_ms", t.detection_to_first_fill_ms);
      push("detection_to_all_four_filled_ms", t.detection_to_all_four_filled_ms);
      push("first_fill_to_last_fill_ms", t.first_fill_to_last_fill_ms);
      push("unhedged_exposure_duration_ms", t.unhedged_exposure_duration_ms);
      push("unwind_duration_ms", t.unwind_duration_ms);
    } catch {
      /* fail-open */
    }
  }

  private lastAgeMs(broker: BrokerId): number | null {
    const at = this.lastSampleAt.get(broker);
    return at === undefined ? null : Math.max(0, this.now() - at);
  }

  calibrationStatus(broker: BrokerId): CalibrationStatus {
    return classifyCalibration(this.sampleCount.get(broker) ?? 0, this.lastAgeMs(broker), this.thresholds);
  }

  /** Per-broker rolling summary for the status endpoint. Cold path. */
  snapshot(): BrokerLatencySnapshot[] {
    return BROKER_IDS.map((broker) => {
      const byKind: Record<string, Record<string, ReturnType<RingBuffer["summary"]>>> = {};
      for (const kind of LATENCY_OPERATION_KINDS) {
        const perComponent: Record<string, ReturnType<RingBuffer["summary"]>> = {};
        for (const component of LEG_COMPONENTS) {
          const b = this.legBuckets.get(`${broker}|${kind}|${component}`);
          if (b && b.size > 0) perComponent[component] = b.summary();
        }
        if (Object.keys(perComponent).length > 0) byKind[kind] = perComponent;
      }
      const box: Record<string, ReturnType<RingBuffer["summary"]>> = {};
      for (const component of BOX_COMPONENTS) {
        const b = this.boxBuckets.get(`${broker}|${component}`);
        if (b && b.size > 0) box[component] = b.summary();
      }
      const outcomes: Record<string, number> = {};
      for (const outcome of BOX_EXECUTION_OUTCOMES) {
        const c = this.outcomes.get(`${broker}|${outcome}`);
        if (c) outcomes[outcome] = c;
      }
      return {
        broker,
        region: this.region,
        calibration_status: this.calibrationStatus(broker),
        sample_count: this.sampleCount.get(broker) ?? 0,
        last_sample_age_ms: this.lastAgeMs(broker),
        by_kind: byKind,
        box,
        outcomes,
      };
    });
  }

  /** The recent raw timeline (bounded), newest last. Cold path / diagnostics. */
  recentTimeline(): BoxBrokerTiming[] {
    return this.timeline.values();
  }

  /**
   * Export a deterministic calibration dataset for one broker's ENTRY operations, ready to
   * feed back into paper as recorded samples. Cold path. Never includes secrets/credentials
   * — only anonymised latency numbers and explicitly-configured region metadata.
   */
  calibrationDataset(broker: BrokerId): BoxLatencyCalibrationDataset {
    const entryValues = (component: LegComponent): number[] => {
      const b = this.legBuckets.get(`${broker}|ENTRY|${component}`);
      return b ? b.values() : [];
    };
    return {
      broker,
      region: this.region,
      generated_at: new Date(this.now()).toISOString(),
      sample_count: this.sampleCount.get(broker) ?? 0,
      calibration_status: this.calibrationStatus(broker),
      entry: {
        post_to_ack_ms: entryValues("submit_to_ack_ms"),
        ack_to_terminal_ms: entryValues("ack_to_terminal_ms"),
        submit_to_first_fill_ms: entryValues("submit_to_first_fill_ms"),
        submit_to_terminal_ms: entryValues("submit_to_terminal_ms"),
      },
    };
  }
}
