/**
 * EXECUTION ENVIRONMENT DIAGNOSTICS — event-loop delay, and just enough process pressure to
 * EXPLAIN a latency outlier.
 *
 * WHY (audit divergence D9)
 *
 * Every latency number this system records is measured in a single-threaded JavaScript
 * runtime. "POST → ACK took 900 ms" has at least two completely different explanations:
 *
 *   a) the broker really took 900 ms, or
 *   b) the broker replied in 90 ms and our event loop was blocked for 810 ms, so we did not
 *      run the continuation that observed the reply until much later.
 *
 * Those demand opposite responses, and without event-loop instrumentation they are
 * indistinguishable. Worse, feeding (b) into a broker latency distribution actively corrupts
 * the calibration: paper would then simulate broker slowness that never happened, and would
 * still be wrong on the real problem, because a paper run has no equivalent stall.
 *
 * So: measure the loop. When an execution decision happened during a significant stall,
 * ANNOTATE it, so the sample can be interpreted (or excluded) rather than silently trusted.
 *
 * WHAT THIS IS NOT
 *
 * Not a profiler. There is no CPU sampling, no heap snapshotting, no flamegraph, no
 * per-function accounting. The whole module is one histogram maintained in C++, one
 * low-frequency timer, and two counters read on demand. Its only job is to make a latency
 * outlier explicable.
 *
 * HARD RULES
 *
 *  1. FAIL-OPEN, ABSOLUTELY. Every public method is wrapped so that a diagnostics failure
 *     — an unavailable `perf_hooks`, a throwing observer, anything — can never propagate
 *     into the trading path. A monitor that cannot start reports `enabled: false` and the
 *     system carries on. No diagnostic failure may affect execution.
 *  2. NO COST ON THE HOT PATH. `monitorEventLoopDelay` is maintained natively with no JS
 *     callback per loop turn. The only JS timer runs at `sampleIntervalMs` (default 500 ms)
 *     and is `unref()`ed so it can never hold the process open. `process.memoryUsage()` and
 *     `process.cpuUsage()` are called ONLY from {@link snapshot}, which is a cold
 *     admin/diagnostics path — never per tick and never per order.
 *  3. BOUNDED. Fixed-capacity ring buffers throughout; memory is constant regardless of
 *     uptime.
 *  4. HONEST. Percentiles are reported as null until samples exist. A monitor that could not
 *     attach says so rather than reporting zeros that look like a healthy loop.
 */

import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";

import { RingBuffer } from "./metrics.js";
import type { ExecutionClock } from "./executionClock.js";

/** Nanoseconds → milliseconds, rounded to 2dp. `monitorEventLoopDelay` reports ns. */
function nsToMs(ns: number | null | undefined): number | null {
  if (ns == null || !Number.isFinite(ns) || ns < 0) return null;
  return Math.round((ns / 1e6) * 100) / 100;
}

/** The subset of Node's `IntervalHistogram` this module uses. Injectable for tests. */
export interface EventLoopDelayHistogram {
  readonly max: number;
  readonly mean: number;
  readonly count: number;
  percentile(p: number): number;
  reset(): void;
  enable(): boolean;
  disable(): boolean;
}

export interface EventLoopLagSnapshot {
  /** False when no monotonic loop-delay source could be attached. Percentiles are then null. */
  enabled: boolean;
  /** Loop-delay percentiles in ms, from the native histogram. Null until samples exist. */
  p50: number | null;
  p95: number | null;
  p99: number | null;
  mean: number | null;
  max: number | null;
  /** Histogram sample count. */
  samples: number;
}

export interface StallEvent {
  /** Observed loop delay in ms. */
  readonly lag_ms: number;
  /** Monotonic ms at which the stall was observed. For correlating with order timings. */
  readonly at_mono: number;
  /** Wall-clock ms, for the audit trail. */
  readonly at_wall: number;
}

export interface ExecutionEnvironmentSnapshot {
  event_loop: EventLoopLagSnapshot;
  /** Timer-drift stalls above the configured threshold. */
  stalls: {
    threshold_ms: number;
    /** Total stalls observed since start. */
    count: number;
    /** The worst stall observed, in ms. */
    worst_ms: number | null;
    /** The most recent stalls, bounded, newest last. */
    recent: StallEvent[];
  };
  /**
   * Heap/RSS at the moment of the snapshot, in bytes. Null when unavailable. Read on the
   * cold path only.
   */
  memory: {
    rss: number;
    heap_used: number;
    heap_total: number;
    external: number;
  } | null;
  /**
   * Process CPU utilisation since the previous snapshot, as a fraction of one core
   * (0.5 = half a core, 1.0 = one core saturated). Null on the first snapshot, because a
   * rate needs two readings — never guessed from one.
   */
  cpu: {
    utilisation: number;
    window_ms: number;
  } | null;
  /**
   * Garbage-collection pause distribution in ms, when GC observation is available and
   * enabled. Null when not observed — never zero-filled.
   */
  gc: {
    samples: number;
    p50: number | null;
    p95: number | null;
    p99: number | null;
    max: number | null;
    total_pause_ms: number;
  } | null;
}

/**
 * An execution-time annotation describing the loop conditions an order was worked under.
 *
 * Attached to a timing sample so a 900 ms "broker latency" that coincided with an 800 ms
 * stall is interpretable. Deliberately small and cheap to produce — this IS called per
 * order.
 */
export interface EnvironmentAnnotation {
  /** Loop delay p99 in ms at the time of the operation, or null when unmeasured. */
  readonly loop_p99_ms: number | null;
  /** Stalls above the threshold observed since the reference monotonic instant. */
  readonly stalls_during: number;
  /** The worst stall in ms observed since the reference instant, or null. */
  readonly worst_stall_ms: number | null;
  /** True when a significant stall overlapped the operation — read this before trusting it. */
  readonly stalled: boolean;
}

export interface ExecutionEnvironmentOptions {
  /** Master switch. When false the monitor attaches nothing and reports `enabled: false`. */
  enabled: boolean;
  clock: ExecutionClock;
  /** Loop delay above this (ms) counts as a stall worth recording. Default 50. */
  stallThresholdMs?: number;
  /** Timer-drift sampling interval (ms). Default 500. The ONLY JS timer in this module. */
  sampleIntervalMs?: number;
  /** Bounded recent-stall capacity. Default 50. */
  stallHistory?: number;
  /** Histogram resolution (ms) passed to `monitorEventLoopDelay`. Default 20. */
  resolutionMs?: number;
  /** Observe GC pauses. Off by default: it is the only part with measurable overhead. */
  gcObservation?: boolean;
  /** Injectable for tests. Return null to simulate an unavailable histogram. */
  histogramFactory?: (resolutionMs: number) => EventLoopDelayHistogram | null;
}

export class ExecutionEnvironmentMonitor {
  private readonly clock: ExecutionClock;
  private readonly stallThresholdMs: number;
  private readonly sampleIntervalMs: number;
  private readonly resolutionMs: number;
  private readonly gcObservation: boolean;
  private readonly histogramFactory: (resolutionMs: number) => EventLoopDelayHistogram | null;

  private histogram: EventLoopDelayHistogram | null = null;
  private timer: NodeJS.Timeout | null = null;
  private gcObserver: { disconnect(): void } | null = null;

  private readonly stallRing: StallEvent[] = [];
  private readonly stallHistory: number;
  private stallCount = 0;
  private worstStallMs: number | null = null;
  /** Stalls indexed by monotonic time, so an annotation can ask "since instant X". */
  private readonly gcPauses: RingBuffer;
  private gcTotalPauseMs = 0;

  private lastCpu: { usage: { user: number; system: number }; atMono: number } | null = null;
  private started = false;
  /** Set when attaching failed; makes the failure visible instead of silently reporting zeros. */
  private attachError: string | null = null;

  constructor(private readonly opts: ExecutionEnvironmentOptions) {
    this.clock = opts.clock;
    this.stallThresholdMs = Math.max(1, Math.floor(opts.stallThresholdMs ?? 50));
    this.sampleIntervalMs = Math.max(50, Math.floor(opts.sampleIntervalMs ?? 500));
    this.resolutionMs = Math.max(1, Math.floor(opts.resolutionMs ?? 20));
    this.stallHistory = Math.max(1, Math.floor(opts.stallHistory ?? 50));
    this.gcObservation = opts.gcObservation === true;
    this.histogramFactory = opts.histogramFactory ?? defaultHistogramFactory;
    this.gcPauses = new RingBuffer(200);
  }

  get enabled(): boolean {
    return this.opts.enabled && this.histogram !== null;
  }

  /** The reason attaching failed, for diagnostics. Null when there was none. */
  get attachFailure(): string | null {
    return this.attachError;
  }

  /**
   * Attach the histogram, the drift sampler and (optionally) the GC observer.
   *
   * FAIL-OPEN: any failure is captured, the monitor stays disabled, and the caller is never
   * told about it by an exception. Idempotent.
   */
  start(): void {
    if (this.started || !this.opts.enabled) return;
    this.started = true;
    try {
      this.histogram = this.histogramFactory(this.resolutionMs);
      this.histogram?.enable();
    } catch (error) {
      this.histogram = null;
      this.attachError = error instanceof Error ? error.message : String(error);
    }

    // Timer-drift sampler: the direct way to notice "the loop was blocked". Cheap — one
    // timer, one subtraction. unref()'d so it can never keep the process alive.
    try {
      let expected = this.clock.mono() + this.sampleIntervalMs;
      const tick = (): void => {
        try {
          const now = this.clock.mono();
          const drift = now - expected;
          if (drift >= this.stallThresholdMs) this.recordStall(drift, now);
          expected = now + this.sampleIntervalMs;
        } catch {
          /* fail-open */
        }
      };
      const handle = setInterval(tick, this.sampleIntervalMs);
      (handle as { unref?: () => void }).unref?.();
      this.timer = handle;
    } catch (error) {
      this.attachError ??= error instanceof Error ? error.message : String(error);
    }

    if (this.gcObservation) this.attachGcObserver();
  }

  /** Detach everything. Idempotent, and safe to call from a shutdown hook. */
  stop(): void {
    this.started = false;
    try {
      if (this.timer) clearInterval(this.timer);
    } catch {
      /* fail-open */
    }
    this.timer = null;
    try {
      this.histogram?.disable();
    } catch {
      /* fail-open */
    }
    try {
      this.gcObserver?.disconnect();
    } catch {
      /* fail-open */
    }
    this.gcObserver = null;
  }

  /**
   * Record a stall directly. Exposed so tests (and a replay harness) can drive the monitor
   * without real timers.
   */
  recordStall(lagMs: number, atMono?: number): void {
    try {
      if (!Number.isFinite(lagMs) || lagMs < this.stallThresholdMs) return;
      const lag = Math.round(lagMs * 100) / 100;
      const mono = atMono ?? this.clock.mono();
      this.stallCount++;
      if (this.worstStallMs === null || lag > this.worstStallMs) this.worstStallMs = lag;
      this.stallRing.push({ lag_ms: lag, at_mono: mono, at_wall: this.clock.wall() });
      while (this.stallRing.length > this.stallHistory) this.stallRing.shift();
    } catch {
      /* fail-open */
    }
  }

  /**
   * Loop conditions observed since a monotonic reference instant — typically the moment an
   * opportunity was detected or an order was submitted.
   *
   * Called per order, so it stays O(recent stalls) with a small bounded ring, and allocates
   * one small object.
   */
  annotate(sinceMono: number | null): EnvironmentAnnotation {
    try {
      const p99 = this.histogram ? nsToMs(this.histogram.percentile(99)) : null;
      if (sinceMono === null || !Number.isFinite(sinceMono)) {
        return { loop_p99_ms: p99, stalls_during: 0, worst_stall_ms: null, stalled: false };
      }
      let count = 0;
      let worst: number | null = null;
      for (const stall of this.stallRing) {
        if (stall.at_mono < sinceMono) continue;
        count++;
        if (worst === null || stall.lag_ms > worst) worst = stall.lag_ms;
      }
      return { loop_p99_ms: p99, stalls_during: count, worst_stall_ms: worst, stalled: count > 0 };
    } catch {
      return { loop_p99_ms: null, stalls_during: 0, worst_stall_ms: null, stalled: false };
    }
  }

  /**
   * Full diagnostics. COLD PATH ONLY — this is the one place that calls
   * `process.memoryUsage()` and `process.cpuUsage()`.
   */
  snapshot(): ExecutionEnvironmentSnapshot {
    const eventLoop = this.eventLoopSnapshot();
    return {
      event_loop: eventLoop,
      stalls: {
        threshold_ms: this.stallThresholdMs,
        count: this.stallCount,
        worst_ms: this.worstStallMs,
        recent: [...this.stallRing],
      },
      memory: this.memorySnapshot(),
      cpu: this.cpuSnapshot(),
      gc: this.gcSnapshot(),
    };
  }

  /** Reset the loop-delay histogram, e.g. to look at a fresh window. Fail-open. */
  resetHistogram(): void {
    try {
      this.histogram?.reset();
    } catch {
      /* fail-open */
    }
  }

  /* ------------------------------- internals ------------------------------- */

  private eventLoopSnapshot(): EventLoopLagSnapshot {
    const empty: EventLoopLagSnapshot = {
      enabled: false,
      p50: null,
      p95: null,
      p99: null,
      mean: null,
      max: null,
      samples: 0,
    };
    try {
      const h = this.histogram;
      if (!h) return empty;
      const samples = Number.isFinite(h.count) ? h.count : 0;
      if (samples <= 0) return { ...empty, enabled: true };
      return {
        enabled: true,
        p50: nsToMs(h.percentile(50)),
        p95: nsToMs(h.percentile(95)),
        p99: nsToMs(h.percentile(99)),
        mean: nsToMs(h.mean),
        max: nsToMs(h.max),
        samples,
      };
    } catch {
      return empty;
    }
  }

  private memorySnapshot(): ExecutionEnvironmentSnapshot["memory"] {
    try {
      const m = process.memoryUsage();
      return { rss: m.rss, heap_used: m.heapUsed, heap_total: m.heapTotal, external: m.external };
    } catch {
      return null;
    }
  }

  private cpuSnapshot(): ExecutionEnvironmentSnapshot["cpu"] {
    try {
      const usage = process.cpuUsage();
      const atMono = this.clock.mono();
      const previous = this.lastCpu;
      this.lastCpu = { usage, atMono };
      // A rate needs two readings. The first snapshot honestly reports null rather than
      // dividing by process uptime and calling the result "current" utilisation.
      if (!previous) return null;
      const windowMs = atMono - previous.atMono;
      if (!(windowMs > 0)) return null;
      const cpuMicros = usage.user - previous.usage.user + (usage.system - previous.usage.system);
      const utilisation = cpuMicros / 1000 / windowMs;
      return {
        utilisation: Math.round(Math.max(0, utilisation) * 1000) / 1000,
        window_ms: Math.round(windowMs),
      };
    } catch {
      return null;
    }
  }

  private gcSnapshot(): ExecutionEnvironmentSnapshot["gc"] {
    try {
      if (!this.gcObservation || this.gcPauses.size === 0) return null;
      const round = (v: number | null): number | null => (v === null ? null : Math.round(v * 100) / 100);
      return {
        samples: this.gcPauses.size,
        p50: round(this.gcPauses.percentile(0.5)),
        p95: round(this.gcPauses.percentile(0.95)),
        p99: round(this.gcPauses.percentile(0.99)),
        max: round(this.gcPauses.max),
        total_pause_ms: Math.round(this.gcTotalPauseMs * 100) / 100,
      };
    } catch {
      return null;
    }
  }

  private attachGcObserver(): void {
    try {
      // Imported lazily and defensively: GC entry observation is the only optional part, and
      // an environment without it must still get event-loop metrics.
      const hooks = gcObserverFactory();
      if (!hooks) return;
      this.gcObserver = hooks((durationMs) => {
        try {
          if (!Number.isFinite(durationMs) || durationMs < 0) return;
          this.gcPauses.push(durationMs);
          this.gcTotalPauseMs += durationMs;
        } catch {
          /* fail-open */
        }
      });
    } catch (error) {
      this.attachError ??= error instanceof Error ? error.message : String(error);
    }
  }
}

/**
 * The real `monitorEventLoopDelay` histogram.
 *
 * Returns null rather than throwing if the runtime cannot supply one, so the monitor
 * degrades to stall-only diagnostics instead of failing. `monitorEventLoopDelay` maintains
 * its histogram natively — there is no JS callback per loop turn, which is why this is the
 * cheapest available way to measure loop delay.
 */
function defaultHistogramFactory(resolutionMs: number): EventLoopDelayHistogram | null {
  try {
    if (typeof monitorEventLoopDelay !== "function") return null;
    return monitorEventLoopDelay({ resolution: resolutionMs });
  } catch {
    return null;
  }
}

/**
 * Attach a GC-pause observer, returning a disconnect handle, or null when unavailable.
 * Intentionally best-effort: this is diagnostics, not instrumentation anything depends on.
 */
function gcObserverFactory(): ((onPause: (durationMs: number) => void) => { disconnect(): void }) | null {
  try {
    if (typeof PerformanceObserver !== "function") return null;
    return (onPause) => {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as { duration: number }[]) onPause(entry.duration);
      });
      observer.observe({ entryTypes: ["gc"] });
      return observer;
    };
  } catch {
    return null;
  }
}

/**
 * A monitor that is switched off. Used wherever a monitor is structurally required but
 * diagnostics are disabled, so no call site needs a null check.
 */
export function createDisabledEnvironmentMonitor(clock: ExecutionClock): ExecutionEnvironmentMonitor {
  return new ExecutionEnvironmentMonitor({ enabled: false, clock, histogramFactory: () => null });
}
