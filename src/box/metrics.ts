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
  /** Detection → first / last leg fill, and the unhedged exposure window. */
  readonly firstFillLatency: RingBuffer;
  readonly lastFillLatency: RingBuffer;
  readonly exposureDuration: RingBuffer;
  /** Expected net at entry minus the eventual realised net of the closed trade (₹). */
  readonly expectedVsRealised: RingBuffer;
  /** Detection expected net minus the realised entry net at actual fill prices (₹). */
  readonly decisionDeterioration: RingBuffer;
  /** Arrival-book execution slippage (₹): BUY fill−arrival, SELL arrival−fill, × filled qty. */
  readonly arrivalExecutionSlippage: RingBuffer;
  /** Detection → decision, decision → order send, and transport/fill components (ms). */
  readonly detectionToDecision: RingBuffer;
  readonly decisionToOrderSend: RingBuffer;
  readonly orderLatency: RingBuffer;
  readonly orderSendToAck: RingBuffer;
  readonly ackToFill: RingBuffer;

  readonly evaluations = new RateMeter(60);
  readonly wsUpdates = new RateMeter(60);
  readonly ticks = new RateMeter(60);

  private counters = {
    // Legacy simulator/event counters. Kept for the detailed legging diagnostics
    // below, but never used as the execution-health denominator.
    executions_attempted: 0,
    executions_filled: 0,
    executions_failed: 0,
    // Mutually exclusive parent ENTRY attempt lifecycle.
    logical_attempted: 0,
    logical_success: 0,
    logical_partial_recovered: 0,
    logical_partial_unresolved: 0,
    logical_failed: 0,
    logical_aborted: 0,
    logical_retries: 0,
    logical_terminal_conflicts: 0,
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
    legging_attempts: 0,
    legging_leg_timeouts: 0,
    // Depth-walking / queue realism.
    partial_fills: 0,
    unwind_success: 0,
    unwind_failure: 0,
    residual_exposures: 0,
    cross_leg_skew_rejects: 0,
    queue_haircut_rejects: 0,
    limit_price_rejects: 0,
    // Partial-exit / residual-flatten lifecycle.
    partial_exit_attempts: 0,
    partial_exit_filled_qty: 0,
    partial_exit_retries: 0,
    residual_flatten_attempts: 0,
    residual_flatten_partial: 0,
    residual_flatten_success: 0,
    residual_flatten_failure: 0,
    manual_legging_exits: 0,
    invariant_failures: 0,
  };
  /** Highest partial-exit remaining-role count seen (bounded gauge, not a sum). */
  private partialExitRemainingRoles = 0;
  /** Filled-position fills owned but not yet durably persisted (gauge). */
  private pendingUnpersistedFills = 0;
  /** Failure reason → count. A small, fixed key space, so this cannot grow. */
  private failures = new Map<string, number>();
  /** Which leg role most often fails to fill under legging. Fixed 4-key space. */
  private leggingFailedRoles = new Map<string, number>();
  /** Active parent attempts. Removed on terminal outcome, so this map stays bounded. */
  private logicalAttempts = new Map<string, true>();
  /** Fixed taxonomy only; parent terminal rejections never include exit diagnostics. */
  private logicalRejections = new Map<string, number>();

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
    this.firstFillLatency = new RingBuffer(window);
    this.lastFillLatency = new RingBuffer(window);
    this.exposureDuration = new RingBuffer(window);
    this.expectedVsRealised = new RingBuffer(window);
    this.decisionDeterioration = new RingBuffer(window);
    this.arrivalExecutionSlippage = new RingBuffer(window);
    this.detectionToDecision = new RingBuffer(window);
    this.decisionToOrderSend = new RingBuffer(window);
    this.orderLatency = new RingBuffer(window);
    this.orderSendToAck = new RingBuffer(window);
    this.ackToFill = new RingBuffer(window);
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

  /** Start exactly one parent ENTRY attempt. Repeated starts/retries never inflate it. */
  beginLogicalAttempt(attemptId: string): boolean {
    if (this.logicalAttempts.has(attemptId)) return false;
    this.logicalAttempts.set(attemptId, true);
    this.counters.logical_attempted++;
    return true;
  }

  /** An internal leg/order retry; explicitly not a new strategy attempt. */
  recordLogicalRetry(): void {
    this.counters.logical_retries++;
  }

  /**
   * Finish a parent ENTRY attempt once. Conflicting duplicate terminals are ignored
   * and exposed as a diagnostic rather than corrupting the visible denominator.
   */
  finishLogicalAttempt(
    attemptId: string,
    outcome: "SUCCESS" | "FAILED" | "PARTIAL_RECOVERED" | "PARTIAL_UNRESOLVED" | "ABORTED",
    reason?: string | null,
    observations?: {
      decisionDeterioration?: number | null;
      arrivalExecutionSlippage?: number | null;
      detectionToDecisionMs?: number | null;
      decisionToOrderSendMs?: number | null;
      orderLatencyMs?: number | null;
      orderSendToAckMs?: number | null;
      ackToFillMs?: number | null;
      decisionToFillMs?: number | null;
    },
  ): boolean {
    if (!this.logicalAttempts.delete(attemptId)) {
      this.counters.logical_terminal_conflicts++;
      return false;
    }
    switch (outcome) {
      case "SUCCESS": this.counters.logical_success++; break;
      case "FAILED": this.counters.logical_failed++; break;
      case "PARTIAL_RECOVERED": this.counters.logical_partial_recovered++; break;
      case "PARTIAL_UNRESOLVED": this.counters.logical_partial_unresolved++; break;
      case "ABORTED": this.counters.logical_aborted++; break;
    }
    if (reason) this.logicalRejections.set(reason, (this.logicalRejections.get(reason) ?? 0) + 1);
    if (observations) {
      this.decisionDeterioration.push(observations.decisionDeterioration ?? Number.NaN);
      this.arrivalExecutionSlippage.push(observations.arrivalExecutionSlippage ?? Number.NaN);
      this.detectionToDecision.push(observations.detectionToDecisionMs ?? Number.NaN);
      this.decisionToOrderSend.push(observations.decisionToOrderSendMs ?? Number.NaN);
      this.orderLatency.push(observations.orderLatencyMs ?? Number.NaN);
      this.orderSendToAck.push(observations.orderSendToAckMs ?? Number.NaN);
      this.ackToFill.push(observations.ackToFillMs ?? Number.NaN);
      this.decisionToFill.push(observations.decisionToFillMs ?? Number.NaN);
    }
    return true;
  }

  recordExecutionFilled(slippage: number, _decisionToFillMs: number | null): void {
    this.counters.executions_filled++;
    this.entrySlippage.push(slippage);
    // decisionToFill is now written EXCLUSIVELY by finishLogicalAttempt (the
    // parent-attempt terminal call scanner.ts always makes) — pushing it here too
    // would double-count every successful fill into the same ring buffer, since
    // every call site of recordExecutionFilled is already wrapped by exactly one
    // finishLogicalAttempt call in production.
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

  /** One paper_legging attempt began (its own denominator, not the entry one). */
  recordLeggingAttempt(): void {
    this.counters.legging_attempts++;
  }

  /** One order arrived and was still unfilled at its deadline. */
  recordLegTimeout(): void {
    this.counters.legging_leg_timeouts++;
  }

  recordFirstFillLatency(ms: number): void {
    this.firstFillLatency.push(ms);
  }

  recordLastFillLatency(ms: number): void {
    this.lastFillLatency.push(ms);
  }

  /** How long the position was one-sided (first fill → complete box or unwind). */
  recordExposureDuration(ms: number): void {
    this.exposureDuration.push(ms);
  }

  /** One order filled some, but not all, of its requested quantity. */
  recordPartialFill(): void {
    this.counters.partial_fills++;
  }

  /** An emergency unwind fully flattened the exposure it worked. */
  recordUnwindSuccess(): void {
    this.counters.unwind_success++;
  }

  /** An emergency unwind could not fully flatten — residual exposure remains. */
  recordUnwindFailure(): void {
    this.counters.unwind_failure++;
  }

  /** N residual legs were left outstanding by an execution. */
  recordResidualExposure(count: number): void {
    this.counters.residual_exposures += Math.max(0, Math.round(count));
  }

  /** A candidate was refused because the four legs' exchange times were too skewed. */
  recordCrossLegSkewReject(): void {
    this.counters.cross_leg_skew_rejects++;
  }

  /** An order could not fill because the queue haircut left no executable quantity. */
  recordQueueHaircutReject(): void {
    this.counters.queue_haircut_rejects++;
  }

  /** An order could not fill because the book was entirely past its limit price. */
  recordLimitPriceReject(): void {
    this.counters.limit_price_rejects++;
  }

  /* ---- partial-exit / residual-flatten lifecycle ---- */
  recordPartialExitAttempt(): void {
    this.counters.partial_exit_attempts++;
  }
  recordPartialExitFilledQty(qty: number): void {
    if (qty > 0) this.counters.partial_exit_filled_qty += Math.round(qty);
  }
  recordPartialExitRetry(): void {
    this.counters.partial_exit_retries++;
  }
  recordPartialExitRemainingRoles(count: number): void {
    if (count > this.partialExitRemainingRoles) this.partialExitRemainingRoles = count;
  }
  recordResidualFlattenAttempt(): void {
    this.counters.residual_flatten_attempts++;
  }
  recordResidualFlattenPartial(): void {
    this.counters.residual_flatten_partial++;
  }
  recordResidualFlattenSuccess(): void {
    this.counters.residual_flatten_success++;
  }
  recordResidualFlattenFailure(): void {
    this.counters.residual_flatten_failure++;
  }
  recordManualLeggingExit(): void {
    this.counters.manual_legging_exits++;
  }
  /** An impossible state (e.g. attempted over-close) was caught and prevented. */
  recordInvariantFailure(): void {
    this.counters.invariant_failures++;
  }
  /** Set the current count of owned-but-unpersisted fills (a gauge, not a counter). */
  setPendingUnpersistedFills(n: number): void {
    this.pendingUnpersistedFills = Math.max(0, Math.round(n));
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
    const attempted = this.counters.logical_attempted;
    const successful = this.counters.logical_success;
    const failed = this.counters.logical_failed;
    const partialRecovered = this.counters.logical_partial_recovered;
    const partialUnresolved = this.counters.logical_partial_unresolved;
    const aborted = this.counters.logical_aborted;
    const completed = successful + failed + partialRecovered + partialUnresolved + aborted;
    const c = this.counters;
    const leggingTotal =
      c.legging_4_of_4 + c.legging_3_of_4 + c.legging_2_of_4 + c.legging_1_of_4 + c.legging_0_of_4;
    const rate = (n: number) => (leggingTotal > 0 ? Math.round((n / leggingTotal) * 10000) / 10000 : 0);
    return {
      execution: {
        /** Parent strategy attempts. Internal order/leg retries are excluded. */
        attempted,
        completed,
        successful,
        partial_recovered: partialRecovered,
        partial_unresolved: partialUnresolved,
        failed,
        aborted,
        retries: c.logical_retries,
        /** Compatibility alias: successful full-box opens. */
        filled: successful,
        /** Failures that left material exposure unresolved, over completed attempts. */
        failure_rate: completed > 0 ? Math.round(((failed + partialUnresolved) / completed) * 10000) / 10000 : 0,
        success_rate: completed > 0 ? Math.round((successful / completed) * 10000) / 10000 : 0,
        rejection_categories: Object.fromEntries(this.logicalRejections),
        /** Compatibility alias; now contains only parent-entry rejection categories. */
        failures_by_reason: Object.fromEntries(this.logicalRejections),
        /** Detection expected net − realised entry net at fill prices; positive is worse. */
        decision_deterioration: this.decisionDeterioration.summary(),
        /** Arrival-book fill cost; zero is valid when fills match the arrival book. */
        execution_slippage: this.arrivalExecutionSlippage.summary(),
        /** Legacy detection-touch comparison retained for historical dashboards. */
        entry_slippage: this.entrySlippage.summary(),
        exit_slippage: this.exitSlippage.summary(),
        /** Detection → actual fill. */
        decision_to_fill_ms: this.decisionToFill.summary(),
        qualification_to_fill_ms: this.qualificationToFill.summary(),
        latency: {
          detection_to_decision_ms: this.detectionToDecision.summary(),
          decision_to_order_send_ms: this.decisionToOrderSend.summary(),
          simulated_or_real_order_latency_ms: this.orderLatency.summary(),
          order_send_to_ack_ms: this.orderSendToAck.summary(),
          ack_to_fill_ms: this.ackToFill.summary(),
          detection_to_fill_ms: this.decisionToFill.summary(),
        },
        terminal_conflicts: c.logical_terminal_conflicts,
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
        /** Attempts, with their OWN denominator — never the entry attempt count. */
        attempts: c.legging_attempts,
        /** Orders that arrived and expired unfilled at BOX_LEG_TIMEOUT_MS. */
        leg_timeouts: c.legging_leg_timeouts,
        /** Orders that filled some, but not all, of the requested quantity. */
        partial_fills: c.partial_fills,
        /** Emergency-unwind outcomes and outstanding residual legs. */
        unwind_success: c.unwind_success,
        unwind_failure: c.unwind_failure,
        residual_exposures: c.residual_exposures,
        /** Candidates refused for four-leg exchange-timestamp skew. */
        cross_leg_skew_rejects: c.cross_leg_skew_rejects,
        /** Orders that could not fill within the limit / after the queue haircut. */
        limit_price_rejects: c.limit_price_rejects,
        queue_haircut_rejects: c.queue_haircut_rejects,
        /** Partial-exit / residual-flatten lifecycle. */
        partial_exit_attempts: c.partial_exit_attempts,
        partial_exit_filled_qty: c.partial_exit_filled_qty,
        partial_exit_retries: c.partial_exit_retries,
        partial_exit_max_remaining_roles: this.partialExitRemainingRoles,
        residual_flatten_attempts: c.residual_flatten_attempts,
        residual_flatten_partial: c.residual_flatten_partial,
        residual_flatten_success: c.residual_flatten_success,
        residual_flatten_failure: c.residual_flatten_failure,
        manual_legging_exits: c.manual_legging_exits,
        invariant_failures: c.invariant_failures,
        pending_unpersisted_fills: this.pendingUnpersistedFills,
        /** Dispersion of the fills: max(fill_at) − min(fill_at). */
        first_to_last_fill_ms: this.firstToLastFill.summary(),
        /** Detection → first fill, and detection → last fill. */
        first_fill_latency_ms: this.firstFillLatency.summary(),
        last_fill_latency_ms: this.lastFillLatency.summary(),
        /** How long the position was one-sided. */
        exposure_duration_ms: this.exposureDuration.summary(),
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
