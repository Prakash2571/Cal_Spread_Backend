/**
 * LIVE EXECUTION TIMING — the instrumentation that turns real broker operations into
 * calibration evidence.
 *
 * WHY (audit divergence D1)
 *
 * `brokerTimingStore.ts` was already written, already tested, and already documented as wired.
 * It was not wired: nothing in `src/` ever constructed it or called `recordLegTiming`. Not one
 * of the eleven timestamps it wants was captured anywhere on the live path. So the whole
 * calibration story — paper learning from what the account actually experienced — had no
 * source of truth at its root.
 *
 * This module is that source. It sits between the live order path and the two sinks
 * ({@link BrokerTimingStore} for rolling per-broker distributions, and
 * {@link ExecutionCalibrationStore} for the dimensioned distributions paper consumes), and it
 * collects one {@link OrderTimingTrace} per order.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * THE ONE RULE THAT OVERRIDES EVERYTHING ELSE: FAIL-OPEN
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 * This code runs inside the live order path, including inside the protective-cancel and
 * emergency-unwind paths. If it can throw, it can prevent a cancel. If it can block, it can
 * delay one. Either would turn an observability feature into a way to lose money.
 *
 * Therefore:
 *
 *  - EVERY public method is individually wrapped. Nothing here can propagate an exception, not
 *    even an out-of-memory-adjacent failure in a sink.
 *  - Nothing here awaits, performs I/O, or touches Mongo/Redis/the network. Marks are two
 *    numbers written into a small object.
 *  - Failures are COUNTED and exposed ({@link ExecutionTimingRecorder.diagnostics}), never
 *    silently swallowed and never papered over with a substitute sample. A missing measurement
 *    is reported as missing; a fabricated one would corrupt the calibration it feeds.
 *  - The trace map is bounded, so a leak in the caller cannot become a leak here.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * MONOTONIC FOR MEASUREMENT, WALL CLOCK FOR AUDIT
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 * Every mark captures both (see {@link ../executionClock}). Spans are computed exclusively from
 * the monotonic readings; the wall clock is used only for the audit trail, for freshness and
 * for time-of-day bucketing. They are never mixed in one subtraction.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * ISOLATION
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 * A trace carries its broker, operation kind, purpose and order profile, and the sinks file it
 * under exactly those dimensions. Zerodha and Dhan samples cannot meet; ENTRY and
 * PROTECTIVE_CANCEL samples cannot meet; marketable and passive samples cannot meet. Nothing in
 * this module pools anything.
 */

import { BoundedTtlCache } from "../boundedCache.js";
import type { BoxBrokerTiming, BrokerTimingStore } from "./brokerTimingStore.js";
import type { ExecutionCalibrationStore, CalibrationStage } from "./executionCalibration.js";
import type { ExecutionClock, ExecutionInstant } from "./executionClock.js";
import { monoSpan } from "./executionClock.js";
import type { EnvironmentAnnotation, ExecutionEnvironmentMonitor } from "./executionEnvironment.js";
import {
  classifyTimeOfDayBucket,
  istMinutesOfDayFor,
  type BrokerId,
  type LatencyOperationKind,
  type LatencyProfile,
  type TimeBucketBoundaries,
} from "./latencyModel.js";
import type { BoxLegRole, BoxOrderPurpose } from "./types.js";

/**
 * The observable instants of one broker operation, exactly as the brief enumerates them.
 *
 * Each is a real event we can witness with a retail broker API. Any that does not occur for a
 * given order (a rejected order has no first fill; an uncancelled order has no cancel ACK) is
 * simply absent — never back-filled.
 */
export const TIMING_STAGES = [
  /** The strategy first saw the opportunity. */
  "detected",
  /** Qualification finished and the decision to trade was made. */
  "qualified",
  /** Handed to the OrderManager's priority queue. */
  "scheduler_enqueued",
  /** A concurrency slot was acquired and the operation left the queue. */
  "scheduler_dequeued",
  /** The adapter began the transport call, including its pacing wait. */
  "transport_started",
  /** The HTTP request actually left the wire (after pacing). */
  "http_request_started",
  /** The HTTP response came back — success or failure. */
  "http_response",
  /** A broker order id was received. Proves the order exists; proves nothing about fills. */
  "broker_order_id",
  /** The broker reported the order accepted / OPEN. STILL NOT A FILL. */
  "acknowledged",
  /** The first non-zero cumulative filled quantity was observed. */
  "first_fill",
  /** The most recent cumulative quantity increase was observed. */
  "last_fill",
  /** Cumulative filled quantity reached the requested quantity. */
  "full_fill",
  /** A cancel request left the wire. */
  "cancel_requested",
  /** The broker acknowledged the cancel request (not the same as terminal). */
  "cancel_acknowledged",
  /** A genuinely terminal broker state was established. */
  "terminal",
  /** The durable reconciler resolved a previously-uncertain order. */
  "reconciled",
] as const;
export type TimingStage = (typeof TIMING_STAGES)[number];

/** One observed partial fill, for the "every partial fill" requirement. */
export interface PartialFillMark {
  readonly cumulativeQty: number;
  readonly atMono: number;
  readonly atWall: number;
}

export interface OrderTimingIdentity {
  readonly clientOrderId: string;
  readonly broker: BrokerId;
  readonly purpose: BoxOrderPurpose;
  readonly role: BoxLegRole;
  readonly tradeId: string | null;
  readonly attemptId: string;
  /** Requested quantity, so a partial can be distinguished from a completion. */
  readonly requestedQty: number;
}

/** The final shape published to the sinks. Useful for tests and for the audit trail. */
export interface PublishedTiming {
  readonly identity: OrderTimingIdentity;
  readonly kind: LatencyOperationKind;
  readonly profile: LatencyProfile;
  readonly spans: Partial<Record<CalibrationStage, number>>;
  readonly partialFills: readonly PartialFillMark[];
  readonly environment: EnvironmentAnnotation | null;
  /** Wall clock of the terminal (or last recorded) instant, for freshness bucketing. */
  readonly atWall: number;
}

/**
 * One order's timing trace.
 *
 * Created by {@link ExecutionTimingRecorder} and mutated by whichever layer witnesses each
 * event: the OrderManager marks the queue stages, the broker adapter marks the transport, ACK,
 * fill and cancel stages. They share the trace by client order id, so no stage timestamp has to
 * be threaded through a call signature.
 */
export class OrderTimingTrace {
  private readonly marks = new Map<TimingStage, ExecutionInstant>();
  private readonly partials: PartialFillMark[] = [];
  private profileValue: LatencyProfile = "MARKETABLE_LIMIT";
  private kindValue: LatencyOperationKind;
  private published = false;
  /** Highest cumulative quantity seen, so a partial mark is only taken on a real increase. */
  private highestCumulative = 0;

  constructor(
    readonly identity: OrderTimingIdentity,
    private readonly clock: ExecutionClock,
    /** Cap on retained partial-fill marks, so a pathological order cannot grow unbounded. */
    private readonly maxPartials = 64,
  ) {
    this.kindValue = kindForPurpose(identity.purpose);
  }

  get kind(): LatencyOperationKind {
    return this.kindValue;
  }

  get profile(): LatencyProfile {
    return this.profileValue;
  }

  get isPublished(): boolean {
    return this.published;
  }

  /**
   * Latch the trace as published. Called by the recorder BEFORE it touches any sink, so that a
   * sink failure can never lead to a second publish and a double-counted sample.
   */
  markPublished(): void {
    this.published = true;
  }

  /**
   * Record the marketable/passive classification. Set by whoever priced the order against an
   * observed book; defaults to marketable, which is what the strategy submits by construction.
   */
  setProfile(profile: LatencyProfile): void {
    try {
      this.profileValue = profile;
    } catch {
      /* fail-open */
    }
  }

  /** Override the operation kind (e.g. a cancel issued against an entry order). */
  setKind(kind: LatencyOperationKind): void {
    try {
      this.kindValue = kind;
    } catch {
      /* fail-open */
    }
  }

  /**
   * Mark a stage as happening now.
   *
   * FIRST WRITE WINS for stages that can only happen once (`first_fill`, `acknowledged`, …), so
   * a retry loop that re-observes the same broker state cannot move an already-recorded instant
   * later and shrink a measured span. `last_fill` and `reconciled` deliberately overwrite,
   * because their meaning is "the most recent one".
   */
  mark(stage: TimingStage, at?: ExecutionInstant): void {
    try {
      const instant = at ?? this.clock.stamp();
      if (OVERWRITABLE_STAGES.has(stage) || !this.marks.has(stage)) {
        this.marks.set(stage, instant);
      }
    } catch {
      /* fail-open */
    }
  }

  /** Read a recorded instant. Null when the stage did not happen. */
  at(stage: TimingStage): ExecutionInstant | null {
    return this.marks.get(stage) ?? null;
  }

  /**
   * Record an observed cumulative filled quantity.
   *
   * Takes CUMULATIVE quantity, not a delta, matching what both brokers report and what
   * {@link ../orderLifecycle.CumulativeFillLedger} enforces. A repeated or lower cumulative is
   * ignored, so re-polling the same state does not manufacture extra "partial fill" events.
   */
  markFill(cumulativeQty: number, at?: ExecutionInstant): void {
    try {
      if (!Number.isFinite(cumulativeQty) || cumulativeQty <= this.highestCumulative) return;
      this.highestCumulative = cumulativeQty;
      const instant = at ?? this.clock.stamp();
      this.mark("first_fill", instant);
      this.mark("last_fill", instant);
      if (this.partials.length < this.maxPartials) {
        this.partials.push({ cumulativeQty, atMono: instant.mono, atWall: instant.wall });
      }
      if (this.identity.requestedQty > 0 && cumulativeQty >= this.identity.requestedQty) {
        this.mark("full_fill", instant);
      }
    } catch {
      /* fail-open */
    }
  }

  /** Highest cumulative quantity witnessed. Diagnostic only; the ledger remains authoritative. */
  get observedCumulative(): number {
    return this.highestCumulative;
  }

  get partialFills(): readonly PartialFillMark[] {
    return this.partials;
  }

  /**
   * Derive the calibration spans from the recorded marks.
   *
   * Every span is a monotonic subtraction via {@link monoSpan}, which returns null for a missing
   * or inverted pair — so an absent stage yields an absent span rather than a zero or a
   * negative number that would bias the distribution.
   */
  spans(): Partial<Record<CalibrationStage, number>> {
    const out: Partial<Record<CalibrationStage, number>> = {};
    try {
      const mono = (stage: TimingStage): number | null => this.marks.get(stage)?.mono ?? null;
      const put = (stage: CalibrationStage, value: number | null): void => {
        if (value !== null) out[stage] = value;
      };

      const enqueued = mono("scheduler_enqueued");
      const dequeued = mono("scheduler_dequeued");
      const transport = mono("transport_started");
      const httpStart = mono("http_request_started");
      const httpEnd = mono("http_response");
      const ack = mono("acknowledged") ?? mono("broker_order_id");
      const firstFill = mono("first_fill");
      const terminal = mono("terminal");
      const cancelRequested = mono("cancel_requested");

      put("scheduler_wait_ms", monoSpan(enqueued, dequeued));
      put("transport_wait_ms", monoSpan(dequeued, transport ?? httpStart));
      put("post_to_http_response_ms", monoSpan(httpStart, httpEnd));
      put("post_to_ack_ms", monoSpan(httpStart, ack));
      put("ack_to_first_fill_ms", monoSpan(ack, firstFill));
      put("ack_to_terminal_ms", monoSpan(ack, terminal));

      // "partial → terminal" is only meaningful for an order that was genuinely partial at some
      // point: it filled something, and that something was less than the whole order. An order
      // that filled completely in one go never rested partially filled, and counting it here
      // would drag the distribution toward zero.
      const wasPartial =
        firstFill !== null &&
        this.partials.length > 0 &&
        (this.partials[0]?.cumulativeQty ?? 0) < this.identity.requestedQty;
      if (wasPartial) put("partial_to_terminal_ms", monoSpan(firstFill, terminal));

      put("cancel_request_to_terminal_ms", monoSpan(cancelRequested, terminal));
    } catch {
      /* fail-open: return whatever was derived before the failure */
    }
    return out;
  }
}

/** Stages whose meaning is "the latest one", so a later mark replaces an earlier one. */
const OVERWRITABLE_STAGES: ReadonlySet<TimingStage> = new Set<TimingStage>([
  "last_fill",
  "reconciled",
  "terminal",
]);

/**
 * Map an order purpose onto the latency operation kind it is calibrated under.
 *
 * `PROTECTIVE_CANCEL` maps to `CANCEL` specifically so cancel latency — the span that sizes
 * paper's cancel-vs-fill race window — is never contaminated by entry latency.
 */
export function kindForPurpose(purpose: BoxOrderPurpose): LatencyOperationKind {
  switch (purpose) {
    case "ENTRY":
      return "ENTRY";
    case "EXIT":
      return "EXIT";
    case "EMERGENCY_RESIDUAL":
      return "UNWIND";
    case "PROTECTIVE_CANCEL":
      return "CANCEL";
  }
}

export interface ExecutionTimingRecorderOptions {
  /** Master switch. When false every method is a no-op and no memory is used per order. */
  enabled: boolean;
  clock: ExecutionClock;
  /** Rolling per-broker distributions and the recent raw timeline. */
  timingStore?: BrokerTimingStore | undefined;
  /** The dimensioned store paper consumes. */
  calibration?: ExecutionCalibrationStore | undefined;
  /** Annotates a sample with the loop conditions it was measured under. */
  environment?: ExecutionEnvironmentMonitor | undefined;
  timeBuckets?: TimeBucketBoundaries | undefined;
  /** Cap on concurrently-tracked orders. Default 512. */
  maxTraces?: number;
  /** How long an unpublished trace is retained before eviction (ms). Default 10 minutes. */
  traceTtlMs?: number;
  /** Called with each published timing. The seam for paired live-vs-paper comparison. */
  onPublish?: ((timing: PublishedTiming) => void) | undefined;
}

export interface TimingDiagnostics {
  enabled: boolean;
  /** Traces created since start. */
  traces_started: number;
  /** Traces published to the sinks. */
  traces_published: number;
  /** Traces evicted before they published — measurement lost, and reported as such. */
  traces_evicted_unpublished: number;
  /** Internal failures that were swallowed to keep the trading path safe. */
  recording_failures: number;
  /** Currently tracked traces. */
  live_traces: number;
}

/**
 * Creates and owns per-order timing traces, and publishes them to the sinks.
 *
 * One instance per process, injected into the OrderManager and the broker adapters. Traces are
 * looked up by client order id so the two layers can share one trace without threading it
 * through every call signature.
 */
export class ExecutionTimingRecorder {
  private readonly traces: BoundedTtlCache<OrderTimingTrace>;
  private readonly enabled: boolean;
  private startedCount = 0;
  private publishedCount = 0;
  private failureCount = 0;

  constructor(private readonly opts: ExecutionTimingRecorderOptions) {
    this.enabled = opts.enabled === true;
    this.traces = new BoundedTtlCache<OrderTimingTrace>({
      maxEntries: Math.max(1, Math.floor(opts.maxTraces ?? 512)),
      ttlMs: Math.max(1_000, Math.floor(opts.traceTtlMs ?? 10 * 60_000)),
      // The cache's own expiry bookkeeping is wall-clock work, deliberately kept separate from
      // the monotonic readings used for measurement.
      now: () => opts.clock.wall(),
    });
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Get or create the trace for one order.
   *
   * Returns null when disabled, so a call site can skip work entirely — but every trace method
   * is also individually safe, so `recorder.trace(id)?.mark(...)` is the intended idiom and
   * needs no other guard.
   */
  trace(clientOrderId: string, identity?: Omit<OrderTimingIdentity, "clientOrderId">): OrderTimingTrace | null {
    if (!this.enabled) return null;
    try {
      const existing = this.traces.get(clientOrderId);
      if (existing) return existing;
      if (!identity) return null; // cannot create without the dimensions to file it under
      const created = new OrderTimingTrace({ clientOrderId, ...identity }, this.opts.clock);
      this.traces.set(clientOrderId, created);
      this.startedCount++;
      return created;
    } catch {
      this.failureCount++;
      return null;
    }
  }

  /** Mark a stage on an order's trace, if one exists. Convenience for terse call sites. */
  mark(clientOrderId: string, stage: TimingStage): void {
    if (!this.enabled) return;
    try {
      this.traces.get(clientOrderId)?.mark(stage);
    } catch {
      this.failureCount++;
    }
  }

  /** Record an observed cumulative filled quantity on an order's trace, if one exists. */
  markFill(clientOrderId: string, cumulativeQty: number): void {
    if (!this.enabled) return;
    try {
      this.traces.get(clientOrderId)?.markFill(cumulativeQty);
    } catch {
      this.failureCount++;
    }
  }

  /**
   * Publish an order's trace to the sinks and stop tracking it.
   *
   * Idempotent: a second publish for the same order is ignored, so a terminal state observed by
   * both the adapter and the reconciler cannot double-count samples.
   *
   * NEVER THROWS. This is called from terminal paths that include protective cancels; a sink
   * failure here must not be able to interfere with unwinding real exposure.
   */
  publish(clientOrderId: string): PublishedTiming | null {
    if (!this.enabled) return null;
    try {
      const trace = this.traces.get(clientOrderId);
      if (!trace || trace.isPublished) return null;

      const spans = trace.spans();
      const terminal = trace.at("terminal") ?? trace.at("last_fill") ?? trace.at("http_response");
      const atWall = terminal?.wall ?? this.opts.clock.wall();
      const environment = this.annotate(trace);

      const published: PublishedTiming = {
        identity: trace.identity,
        kind: trace.kind,
        profile: trace.profile,
        spans,
        partialFills: trace.partialFills,
        environment,
        atWall,
      };

      // Mark published BEFORE touching the sinks, so a sink failure cannot cause a retry that
      // double-counts.
      trace.markPublished();
      this.traces.delete(clientOrderId);
      this.publishedCount++;

      this.publishToCalibration(published);
      this.publishToTimingStore(trace, published);
      try {
        this.opts.onPublish?.(published);
      } catch {
        this.failureCount++;
      }
      return published;
    } catch {
      this.failureCount++;
      return null;
    }
  }

  /** Discard a trace without publishing — e.g. an order that was never actually submitted. */
  discard(clientOrderId: string): void {
    if (!this.enabled) return;
    try {
      this.traces.delete(clientOrderId);
    } catch {
      this.failureCount++;
    }
  }

  diagnostics(): TimingDiagnostics {
    let live = 0;
    try {
      live = this.traces.size;
    } catch {
      /* fail-open */
    }
    return {
      enabled: this.enabled,
      traces_started: this.startedCount,
      traces_published: this.publishedCount,
      // A trace that fell out of the bounded cache without publishing is LOST measurement. It
      // is reported rather than hidden, because silent sample loss looks exactly like a broker
      // that got faster.
      traces_evicted_unpublished: Math.max(0, this.startedCount - this.publishedCount - live),
      recording_failures: this.failureCount,
      live_traces: live,
    };
  }

  /* ------------------------------- internals ------------------------------- */

  private annotate(trace: OrderTimingTrace): EnvironmentAnnotation | null {
    try {
      const monitor = this.opts.environment;
      if (!monitor) return null;
      const since =
        trace.at("scheduler_enqueued")?.mono ??
        trace.at("detected")?.mono ??
        trace.at("http_request_started")?.mono ??
        null;
      return monitor.annotate(since);
    } catch {
      this.failureCount++;
      return null;
    }
  }

  private publishToCalibration(published: PublishedTiming): void {
    try {
      const store = this.opts.calibration;
      if (!store) return;
      const bucket = classifyTimeOfDayBucket(istMinutesOfDayFor(published.atWall), this.opts.timeBuckets);

      // A sample measured during a significant event-loop stall is NOT evidence about broker
      // latency — it is evidence about our own process. Recording it would teach paper to
      // simulate broker slowness that never happened. It is dropped from calibration and left
      // visible in the raw timeline, where it can still explain an outlier.
      if (published.environment?.stalled === true) return;

      for (const [stage, valueMs] of Object.entries(published.spans) as [CalibrationStage, number][]) {
        // The cancellation span is filed under CANCEL, not under the order's own kind.
        //
        // A protective cancel shares the client order id (and therefore the trace) of the order
        // it is pulling, so without this the cancel-confirmation latency would land in the ENTRY
        // bucket. It must not: paper sizes its cancel-vs-fill race window from measured CANCEL
        // latency, and entry ACK latency is a completely different distribution.
        const kind: LatencyOperationKind =
          stage === "cancel_request_to_terminal_ms" ? "CANCEL" : published.kind;
        store.record({
          broker: published.identity.broker,
          kind,
          profile: published.profile,
          bucket,
          stage,
          valueMs,
          atWall: published.atWall,
        });
      }
    } catch {
      this.failureCount++;
    }
  }

  private publishToTimingStore(trace: OrderTimingTrace, published: PublishedTiming): void {
    try {
      const store = this.opts.timingStore;
      if (!store) return;
      const mono = (stage: TimingStage): number | null => trace.at(stage)?.mono ?? null;
      const timing: BoxBrokerTiming = {
        broker: published.identity.broker,
        trade_id: published.identity.tradeId,
        attempt_id: published.identity.attemptId,
        role: published.identity.role,
        purpose: published.identity.purpose,
        kind: published.kind,
        detected_at: mono("detected"),
        queued_at: mono("scheduler_enqueued"),
        dequeued_at: mono("scheduler_dequeued"),
        post_started_at: mono("http_request_started") ?? mono("transport_started"),
        post_returned_at: mono("http_response"),
        acknowledged_at: mono("acknowledged") ?? mono("broker_order_id"),
        first_fill_at: mono("first_fill"),
        last_fill_at: mono("last_fill"),
        terminal_at: mono("terminal"),
        cancel_requested_at: mono("cancel_requested"),
        cancel_confirmed_at: mono("cancel_acknowledged") ?? mono("terminal"),
      };
      store.recordLegTiming(timing);
    } catch {
      this.failureCount++;
    }
  }
}

/**
 * A recorder that does nothing.
 *
 * Used wherever a recorder is structurally required but instrumentation is switched off, so no
 * call site needs a null check and the disabled path allocates nothing per order.
 */
export function createDisabledTimingRecorder(clock: ExecutionClock): ExecutionTimingRecorder {
  return new ExecutionTimingRecorder({ enabled: false, clock });
}
