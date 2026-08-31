/**
 * Bounded observability primitives for the box module.
 *
 * Two rules:
 *
 *   1. NOTHING here grows without limit. Every distribution is a fixed-size ring
 *      buffer that overwrites its oldest sample, so a process that runs for weeks
 *      uses exactly the same memory as one that just started. An unbounded array
 *      of latency samples is a memory leak with a graph attached.
 *   2. Recording is O(1) and allocation-free. These calls sit on the hot path, so
 *      a sample must never allocate, sort or grow anything.
 *
 * Percentiles are computed only when somebody ASKS (i.e. /api/box/status), where
 * one sort of a few hundred numbers is free.
 */

/** A fixed-size ring of numeric samples with lazily computed percentiles. */
export class RingBuffer {
  private readonly buf: Float64Array;
  private cursor = 0;
  private filled = 0;
  private total = 0;

  constructor(readonly capacity: number) {
    this.buf = new Float64Array(Math.max(1, Math.floor(capacity)));
  }

  /** O(1), no allocation. */
  push(v: number): void {
    if (!Number.isFinite(v)) return;
    this.buf[this.cursor] = v;
    this.cursor = (this.cursor + 1) % this.buf.length;
    if (this.filled < this.buf.length) this.filled++;
    this.total++;
  }

  get size(): number {
    return this.filled;
  }

  /** Every sample ever pushed, including the ones already overwritten. */
  get count(): number {
    return this.total;
  }

  /** The most recent sample, or null when nothing has been recorded. */
  get last(): number | null {
    if (this.filled === 0) return null;
    const idx = (this.cursor - 1 + this.buf.length) % this.buf.length;
    return this.buf[idx]!;
  }

  get mean(): number | null {
    if (this.filled === 0) return null;
    let sum = 0;
    for (let i = 0; i < this.filled; i++) sum += this.buf[i]!;
    return sum / this.filled;
  }

  get max(): number | null {
    if (this.filled === 0) return null;
    let m = this.buf[0]!;
    for (let i = 1; i < this.filled; i++) if (this.buf[i]! > m) m = this.buf[i]!;
    return m;
  }

  /** Nearest-rank percentile (0..1). Sorts a copy — call from cold paths only. */
  percentile(p: number): number | null {
    if (this.filled === 0) return null;
    const sorted = Array.prototype.slice.call(this.buf, 0, this.filled) as number[];
    sorted.sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
    return sorted[idx]!;
  }

  /** The standard summary published by the status endpoint. */
  summary(): {
    samples: number;
    count: number;
    last: number | null;
    mean: number | null;
    p50: number | null;
    p95: number | null;
    p99: number | null;
    max: number | null;
  } | null {
    if (this.filled === 0) return null;
    const round = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);
    return {
      samples: this.filled,
      count: this.total,
      last: round(this.last),
      mean: round(this.mean),
      p50: round(this.percentile(0.5)),
      p95: round(this.percentile(0.95)),
      p99: round(this.percentile(0.99)),
      max: round(this.max),
    };
  }

  reset(): void {
    this.cursor = 0;
    this.filled = 0;
    this.total = 0;
  }
}

/**
 * A per-second rate meter over a rolling window of one-second buckets.
 *
 * Bounded by construction: `windowSeconds` buckets, reused forever.
 */
export class RateMeter {
  private readonly buckets: Float64Array;
  private readonly stamps: Float64Array;
  private total = 0;

  constructor(private readonly windowSeconds = 60) {
    const n = Math.max(1, Math.floor(windowSeconds));
    this.buckets = new Float64Array(n);
    this.stamps = new Float64Array(n);
  }

  mark(n = 1, at = Date.now()): void {
    const second = Math.floor(at / 1000);
    const idx = second % this.buckets.length;
    if (this.stamps[idx] !== second) {
      this.stamps[idx] = second;
      this.buckets[idx] = 0;
    }
    this.buckets[idx]! += n;
    this.total += n;
  }

  /** Events per second averaged over the live buckets. */
  perSecond(at = Date.now()): number {
    const nowSecond = Math.floor(at / 1000);
    const oldest = nowSecond - this.buckets.length + 1;
    let sum = 0;
    let seen = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      if (this.stamps[i]! >= oldest && this.stamps[i]! <= nowSecond) {
        sum += this.buckets[i]!;
        seen++;
      }
    }
    if (seen === 0) return 0;
    return Math.round((sum / seen) * 100) / 100;
  }

  get count(): number {
    return this.total;
  }
}

/**
 * Event-loop lag: how long a zero-delay timer is actually late by.
 *
 * A rising figure means the process is CPU-bound, which is the one thing that
 * would make the scanner react late without any market-data problem at all — so it
 * belongs next to the market-data latencies rather than in a separate tool.
 */
export class EventLoopLagMonitor {
  private timer: NodeJS.Timeout | null = null;
  readonly samples: RingBuffer;

  constructor(window: number, private readonly intervalMs = 500) {
    this.samples = new RingBuffer(window);
  }

  start(): void {
    if (this.timer) return;
    let expected = Date.now() + this.intervalMs;
    this.timer = setInterval(() => {
      const now = Date.now();
      this.samples.push(Math.max(0, now - expected));
      expected = now + this.intervalMs;
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * Every rolling measurement the box module publishes.
 *
 * Grouped in one object so the status endpoint has a single source and so a new
 * measurement cannot accidentally be added as an unbounded array somewhere else.
 */
export class BoxMetrics {
  /** WS receive → candidate evaluated (ms). */
  readonly receiveToEvaluation: RingBuffer;
  /** Candidate qualified → simulated fill decided (ms). */
  readonly qualificationToFill: RingBuffer;
  /** Detection → fill for entries that actually filled (ms). */
  readonly decisionToFill: RingBuffer;
  /** Simulated entry slippage (₹, positive = worse than detected). */
  readonly entrySlippage: RingBuffer;
  /** Simulated exit slippage (₹). */
  readonly exitSlippage: RingBuffer;
  /** |local - Zerodha| charge discrepancy (₹). */
  readonly chargeDiscrepancy: RingBuffer;
  /** Charge discrepancy as a percentage of the Zerodha total. */
  readonly chargeDiscrepancyPct: RingBuffer;
  /** Event-loop lag (ms). */
  readonly eventLoopLag: EventLoopLagMonitor;
  /** paper_legging: net loss (₹, ≤ 0) of an aborted, partially-filled box. */
  readonly leggingLoss: RingBuffer;
  /** paper_legging: detection → last leg resolution (ms). */
  readonly firstToLastFill: RingBuffer;
  /** Expected net at entry minus the eventual realised net of the closed trade (₹). */
  readonly expectedVsRealised: RingBuffer;

  readonly evaluations = new RateMeter(60);
  readonly wsUpdates = new RateMeter(60);
  readonly ticks = new RateMeter(60);

  private counters = {
    executions_attempted: 0,
    executions_filled: 0,
    executions_failed: 0,
    reconciliations: 0,
    reconciliation_failures: 0,
    reconciliation_warnings: 0,
    // paper_legging fill-count histogram.
    legging_4_of_4: 0,
    legging_3_of_4: 0,
    legging_2_of_4: 0,
    legging_1_of_4: 0,
    legging_0_of_4: 0,
    legging_aborts: 0,
    legging_abort_after_fill: 0,
  };
  /** Failure reason → count. A small, fixed key space, so this cannot grow. */
  private failures = new Map<string, number>();
  /** Which leg role most often fails to fill under legging. Fixed 4-key space. */
  private leggingFailedRoles = new Map<string, number>();

  constructor(window = 500) {
    this.receiveToEvaluation = new RingBuffer(window);
    this.qualificationToFill = new RingBuffer(window);
    this.decisionToFill = new RingBuffer(window);
    this.entrySlippage = new RingBuffer(window);
    this.exitSlippage = new RingBuffer(window);
    this.chargeDiscrepancy = new RingBuffer(window);
    this.chargeDiscrepancyPct = new RingBuffer(window);
    this.eventLoopLag = new EventLoopLagMonitor(window);
    this.leggingLoss = new RingBuffer(window);
    this.firstToLastFill = new RingBuffer(window);
    this.expectedVsRealised = new RingBuffer(window);
  }

  startSampling(): void {
    this.eventLoopLag.start();
  }

  stopSampling(): void {
    this.eventLoopLag.stop();
  }

  recordExecutionAttempt(): void {
    this.counters.executions_attempted++;
  }

  recordExecutionFilled(slippage: number, decisionToFillMs: number | null): void {
    this.counters.executions_filled++;
    this.entrySlippage.push(slippage);
    if (decisionToFillMs !== null) this.decisionToFill.push(decisionToFillMs);
  }

  recordExecutionFailed(reason: string): void {
    this.counters.executions_failed++;
    this.failures.set(reason, (this.failures.get(reason) ?? 0) + 1);
  }

  recordExitSlippage(slippage: number): void {
    this.exitSlippage.push(slippage);
  }

  recordReconciliation(absDiff: number, pctDiff: number, warned: boolean): void {
    this.counters.reconciliations++;
    this.chargeDiscrepancy.push(absDiff);
    this.chargeDiscrepancyPct.push(pctDiff);
    if (warned) this.counters.reconciliation_warnings++;
  }

  recordReconciliationFailure(): void {
    this.counters.reconciliation_failures++;
  }

  /** Record a paper_legging outcome by how many of the four legs filled. */
  recordLeggingOutcome(filledCount: number, _failedCount: number): void {
    if (filledCount >= 4) this.counters.legging_4_of_4++;
    else if (filledCount === 3) this.counters.legging_3_of_4++;
    else if (filledCount === 2) this.counters.legging_2_of_4++;
    else if (filledCount === 1) this.counters.legging_1_of_4++;
    else this.counters.legging_0_of_4++;
    if (filledCount > 0 && filledCount < 4) this.counters.legging_aborts++;
  }

  /**
   * A 4/4 fill that was immediately reversed because the executed economics no
   * longer qualified.
   *
   * Deliberately NOT counted as `legging_4_of_4`: that counter feeds
   * `fill_rate_4_of_4`, which must mean "a box was actually opened". An aborted
   * 4/4 is an abort, and is counted as one.
   */
  recordLeggingAbortAfterFill(): void {
    this.counters.legging_abort_after_fill++;
    this.counters.legging_aborts++;
  }

  recordLeggingFailedRole(role: string): void {
    this.leggingFailedRoles.set(role, (this.leggingFailedRoles.get(role) ?? 0) + 1);
  }

  recordLeggingLoss(netLoss: number): void {
    this.leggingLoss.push(netLoss);
  }

  recordFirstToLastFill(ms: number): void {
    this.firstToLastFill.push(ms);
  }

  /** Expected net at entry minus the realised net of the closed trade (₹). */
  recordRealisedVsExpected(diff: number): void {
    this.expectedVsRealised.push(diff);
  }

  /** The role that fails to fill most often under legging, for the health panel. */
  private mostFrequentFailingRole(): { role: string; count: number } | null {
    let best: { role: string; count: number } | null = null;
    for (const [role, count] of this.leggingFailedRoles) {
      if (!best || count > best.count) best = { role, count };
    }
    return best;
  }

  /** The whole published view. Cold path: percentiles are computed here. */
  snapshot(at = Date.now()) {
    const attempted = this.counters.executions_attempted;
    const failed = this.counters.executions_failed;
    const c = this.counters;
    const leggingTotal =
      c.legging_4_of_4 + c.legging_3_of_4 + c.legging_2_of_4 + c.legging_1_of_4 + c.legging_0_of_4;
    const rate = (n: number) => (leggingTotal > 0 ? Math.round((n / leggingTotal) * 10000) / 10000 : 0);
    return {
      execution: {
        attempted,
        filled: this.counters.executions_filled,
        failed,
        failure_rate: attempted > 0 ? Math.round((failed / attempted) * 10000) / 10000 : 0,
        failures_by_reason: Object.fromEntries(this.failures),
        /** ₹ of slippage versus the detected touch, entry side. */
        entry_slippage: this.entrySlippage.summary(),
        exit_slippage: this.exitSlippage.summary(),
        /** Detection → simulated fill, in ms. */
        decision_to_fill_ms: this.decisionToFill.summary(),
        qualification_to_fill_ms: this.qualificationToFill.summary(),
      },
      legging: {
        outcomes: {
          "4_of_4": c.legging_4_of_4,
          "3_of_4": c.legging_3_of_4,
          "2_of_4": c.legging_2_of_4,
          "1_of_4": c.legging_1_of_4,
          "0_of_4": c.legging_0_of_4,
          total: leggingTotal,
          aborts: c.legging_aborts,
          /** 4/4 filled but reversed immediately on failed executed economics. */
          abort_after_fill: c.legging_abort_after_fill,
        },
        fill_rate_4_of_4: rate(c.legging_4_of_4),
        failure_rate_3_of_4: rate(c.legging_3_of_4),
        failure_rate_2_of_4: rate(c.legging_2_of_4),
        failure_rate_1_of_4: rate(c.legging_1_of_4),
        legging_net_loss: this.leggingLoss.summary(),
        first_to_last_fill_ms: this.firstToLastFill.summary(),
        most_failing_role: this.mostFrequentFailingRole(),
        failing_roles: Object.fromEntries(this.leggingFailedRoles),
        expected_vs_realised_net: this.expectedVsRealised.summary(),
      },
      latency: {
        receive_to_evaluation_ms: this.receiveToEvaluation.summary(),
        event_loop_lag_ms: this.eventLoopLag.samples.summary(),
      },
      throughput: {
        evaluations_per_sec: this.evaluations.perSecond(at),
        ws_updates_per_sec: this.wsUpdates.perSecond(at),
        ticks_per_sec: this.ticks.perSecond(at),
        evaluations_total: this.evaluations.count,
        ws_updates_total: this.wsUpdates.count,
      },
      charges: {
        reconciliations: this.counters.reconciliations,
        failed_reconciliations: this.counters.reconciliation_failures,
        warnings: this.counters.reconciliation_warnings,
        discrepancy_rupees: this.chargeDiscrepancy.summary(),
        discrepancy_pct: this.chargeDiscrepancyPct.summary(),
      },
    };
  }
}

export type BoxMetricsSnapshot = ReturnType<BoxMetrics["snapshot"]>;
