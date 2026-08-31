/**
 * The paper EXECUTION SIMULATOR.
 *
 * WHY IT EXISTS
 *
 * `paper_touch` records a fill at the touch that was visible in the DETECTION
 * snapshot. That is useful — it isolates the strategy's edge from execution
 * quality — but it is optimistic in a specific, knowable way: it assumes the book
 * is unchanged between spotting a four-leg mispricing and an order reaching the
 * exchange. For a mispricing that exists precisely because someone is about to
 * correct it, that assumption is the whole question.
 *
 * `paper_latency` answers it with evidence instead of a fudge factor:
 *
 *   detection snapshot
 *     → simulated decision/processing delay      (BOX_SIMULATED_DECISION_MS)
 *     → simulated order-send timestamp
 *     → simulated exchange arrival               (BOX_SIMULATED_LATENCY_MS)
 *     → wait for the FIRST WebSocket book each leg publishes at/after arrival
 *     → evaluate the four legs on the books that actually existed then
 *     → measure slippage per leg against the detected touch
 *     → re-qualify on those executed prices
 *     → fill, or refuse with a specific reason
 *
 * There is NO invented slippage percentage anywhere in this module. Every price it
 * records was published by the exchange after the simulated order could have
 * arrived. Correspondingly, if a leg publishes nothing in the wait window there is
 * no evidence of what it would have filled at, so nothing is filled — recorded as
 * `missing_book` rather than quietly reusing the stale detection price.
 *
 * DESIGN CONSTRAINTS
 *
 *   - The hot detection path must stay fast. Only candidates that already cleared
 *     qualification enter this pipeline, and each one runs at most once at a time.
 *   - The clock and the sleep are INJECTED, so the whole pipeline is
 *     deterministically testable without real timers.
 *   - Full five-level depth is captured only here (at the fill) and never per
 *     candidate per tick.
 */

import type { BoxConfig } from "./config.js";
import type { BoxMetrics } from "./metrics.js";
import { cloneDepth, evaluateCandidate, evaluateExitLegs, exitSideFor, round2 } from "./math.js";
import type { BoxOpenPosition } from "./positions.js";
import type { BoxQuoteStore } from "./quotes.js";
import {
  BOX_LEG_ROLES,
  type BoxCandidate,
  type BoxEntryDecision,
  type BoxEvaluation,
  type BoxExecutionFailureReason,
  type BoxExecutionLeg,
  type BoxExecutionRecord,
  type BoxLegEvaluation,
  type BoxLegRole,
  type BoxQuote,
  type ExecutionMode,
  type OrderSide,
} from "./types.js";

export interface BoxExecutionSimulatorDeps {
  cfg: BoxConfig;
  quotes: BoxQuoteStore;
  isMarketOpen: () => boolean;
  isFeedHealthy: () => boolean;
  metrics?: BoxMetrics;
  /** Injected clock — real time in production, a fake clock in tests. */
  now?: () => number;
  /** Injected sleep. Tests advance their clock (and push ticks) inside it. */
  wait?: (ms: number) => Promise<void>;
}

/** A successful simulated entry: the snapshot that filled and how it compares. */
export interface BoxEntryExecution {
  ok: true;
  /** The evaluation the fill was taken from (with five-level depth captured). */
  evaluation: BoxEvaluation;
  record: BoxExecutionRecord;
  decision: BoxEntryDecision;
}

export interface BoxExecutionRefusal {
  ok: false;
  record: BoxExecutionRecord;
  reason: BoxExecutionFailureReason;
  detail: string;
}

export type BoxEntryExecutionResult = BoxEntryExecution | BoxExecutionRefusal;

/** A successful simulated exit. */
export interface BoxExitExecution {
  ok: true;
  legs: BoxLegEvaluation[];
  record: BoxExecutionRecord;
}

export type BoxExitExecutionResult = BoxExitExecution | BoxExecutionRefusal;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    (t as { unref?: () => void }).unref?.();
  });

/** Cost of a price move, per unit: positive always means "worse for us". */
function slippagePerUnit(
  side: OrderSide,
  detected: number | null,
  executed: number | null,
): number | null {
  if (detected === null || executed === null) return null;
  // Paying more on a BUY and receiving less on a SELL are both adverse.
  return round2(side === "BUY" ? executed - detected : detected - executed);
}

export class BoxExecutionSimulator {
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  /** Candidate/position keys with a pipeline in flight — the dedupe guard. */
  private inFlight = new Set<string>();
  private active = 0;

  constructor(private deps: BoxExecutionSimulatorDeps) {
    this.now = deps.now ?? Date.now;
    this.wait = deps.wait ?? sleep;
  }

  get mode(): ExecutionMode {
    return this.deps.cfg.executionMode;
  }

  get activeCount(): number {
    return this.active;
  }

  /** True when another pipeline may start right now. */
  hasCapacity(): boolean {
    return this.active < this.deps.cfg.maxConcurrentExecutions;
  }

  /** True when this exact candidate/position already has a pipeline running. */
  isRunning(key: string): boolean {
    return this.inFlight.has(key);
  }

  /* --------------------------------- entry -------------------------------- */

  /**
   * Simulate the execution of a detected box.
   *
   * `qualify` is applied to the EXECUTED snapshot, not the detected one — the final
   * entry decision is therefore a statement about prices that existed after the
   * order could have arrived, with the measured slippage already deducted.
   */
  async simulateEntry(args: {
    candidate: BoxCandidate;
    detection: BoxEvaluation;
    qualify: (execution: BoxEvaluation, measuredSlippage: number) => BoxEntryDecision;
    /** Re-checked after the delay: discovery may have stopped, the pair been taken. */
    stillWanted?: () => boolean;
  }): Promise<BoxEntryExecutionResult> {
    const { candidate, detection } = args;
    const key = candidate.key;

    if (this.inFlight.has(key)) {
      return this.refuse(detection, "duplicate", "an execution pipeline is already running for this candidate");
    }
    this.inFlight.add(key);
    this.active++;
    this.deps.metrics?.recordExecutionAttempt();
    const startedAt = this.now();

    try {
      const timing = this.timingFor(detection.at);
      const tokens = BOX_LEG_ROLES.map((role) => candidate.legs[role].token);

      const captured = await this.awaitBooks(tokens, timing.arrivalAt);

      if (args.stillWanted && !args.stillWanted()) {
        return this.refuse(detection, "discovery_stopped", "the candidate was no longer wanted after the simulated delay", timing);
      }
      if (!this.deps.isMarketOpen()) {
        return this.refuse(detection, "market_closed", "the market closed during the simulated delay", timing);
      }
      if (!this.deps.isFeedHealthy()) {
        return this.refuse(detection, "feed_unhealthy", "the WebSocket feed went unhealthy during the simulated delay", timing);
      }

      const missing = tokens.filter((t) => !captured.has(t));
      if (missing.length > 0) {
        return this.refuse(
          detection,
          "missing_book",
          `no WebSocket book published at or after the simulated arrival for ${missing.length} leg(s)`,
          timing,
          captured,
        );
      }

      // The books arrived at or after the simulated arrival, but the real fill
      // instant is now — stamp it so leg ages are measured against the moment the
      // fill was decided, not the theoretical arrival (which would make a book
      // that landed a few ms later look like it came from the future).
      timing.executedAt = Math.max(timing.arrivalAt, this.now());

      // Evaluate the four legs on the EXACT captured books.
      const execution = this.evaluateFromCaptured(candidate, captured, timing.executedAt);
      const record = this.buildRecord({
        mode: this.mode,
        timing,
        detection,
        execution,
        lotSize: candidate.lot_size,
        captured,
      });

      if (!execution.tradable || execution.gross_edge === null) {
        const reason: BoxExecutionFailureReason =
          execution.reject === "insufficient_qty" ? "insufficient_quantity" : "price_moved";
        return this.fail(record, reason, `execution snapshot rejected: ${execution.reject ?? "not tradable"}`);
      }
      if (execution.gross_edge <= 0) {
        return this.fail(record, "edge_disappeared", "the gross edge was gone by the time the order arrived");
      }

      const decision = args.qualify(execution, record.total_slippage);
      if (!decision.qualifies) {
        const reason: BoxExecutionFailureReason =
          decision.reject === "below_expected_net_profit"
            ? "below_expected_net_profit"
            : decision.reject === "below_gross_prefilter"
              ? "edge_disappeared"
              : "below_expected_net_profit";
        return this.fail(
          record,
          reason,
          `expected net ₹${decision.expected_net_profit ?? "?"} < required ₹${decision.min_expected_net_profit}`,
        );
      }

      record.filled = true;
      this.deps.metrics?.recordExecutionFilled(record.total_slippage, record.decision_to_fill_ms);
      this.deps.metrics?.qualificationToFill.push(this.now() - startedAt);
      return { ok: true, evaluation: execution, record, decision };
    } finally {
      this.active--;
      this.inFlight.delete(key);
    }
  }

  /* ---------------------------------- exit -------------------------------- */

  /**
   * Simulate the execution of an exit.
   *
   * The same discipline as an entry: after the simulated delay the unwind is priced
   * from books the market actually published, and `validate` gets the final say on
   * those prices. An exit that only looked profitable at detection is refused
   * rather than recorded at prices that were never available.
   */
  async simulateExit(args: {
    position: BoxOpenPosition;
    detectionLegs: BoxLegEvaluation[];
    detectedAt: number;
    /** Final say on the executed prices. Return a reason to refuse. */
    validate?: (
      legs: BoxLegEvaluation[],
      measuredSlippage: number,
    ) => { ok: true } | { ok: false; reason: BoxExecutionFailureReason; detail: string };
    stillWanted?: () => boolean;
  }): Promise<BoxExitExecutionResult> {
    const { position, detectionLegs } = args;
    const key = `exit:${position.id}`;
    const direction = position.direction ?? "LONG_BOX";

    if (this.inFlight.has(key)) {
      return this.refuseLegs(detectionLegs, args.detectedAt, "duplicate", "an exit pipeline is already running for this position");
    }
    this.inFlight.add(key);
    this.active++;

    try {
      const timing = this.timingFor(args.detectedAt);
      const tokens = BOX_LEG_ROLES.map((role) => position.legs[role].token);
      const captured = await this.awaitBooks(tokens, timing.arrivalAt);

      if (args.stillWanted && !args.stillWanted()) {
        return this.refuseLegs(detectionLegs, args.detectedAt, "discovery_stopped", "the position was no longer closable after the simulated delay", timing);
      }
      if (!this.deps.isMarketOpen()) {
        return this.refuseLegs(detectionLegs, args.detectedAt, "market_closed", "the market closed during the simulated exit delay", timing);
      }
      if (!this.deps.isFeedHealthy()) {
        return this.refuseLegs(detectionLegs, args.detectedAt, "feed_unhealthy", "the WebSocket feed went unhealthy during the simulated exit delay", timing);
      }

      const missing = tokens.filter((t) => !captured.has(t));
      if (missing.length > 0) {
        return this.refuseLegs(
          detectionLegs,
          args.detectedAt,
          "missing_book",
          `no WebSocket book published at or after the simulated arrival for ${missing.length} exit leg(s)`,
          timing,
        );
      }

      timing.executedAt = Math.max(timing.arrivalAt, this.now());

      const legs: BoxLegEvaluation[] = BOX_LEG_ROLES.map((role) => {
        const inst = position.legs[role];
        const quote = captured.get(inst.token)!;
        return this.legFromQuote({
          role,
          side: exitSideFor(role, direction),
          inst,
          quote,
          lotSize: position.lot_size,
          now: timing.executedAt,
          maxAgeMs: this.deps.cfg.quoteMaxAgeMs,
        });
      });

      const record = this.buildRecordFromLegs({
        timing,
        detectionLegs,
        executionLegs: legs,
        lotSize: position.lot_size,
        captured,
      });

      const notExecutable = legs.find((l) => !l.executable || !l.fresh);
      if (notExecutable) {
        const reason: BoxExecutionFailureReason =
          notExecutable.price === null || !(notExecutable.price > 0)
            ? "price_moved"
            : "insufficient_quantity";
        return this.fail(record, reason, `${notExecutable.tradingsymbol} could not fill one lot at the executed touch`);
      }

      if (args.validate) {
        const verdict = args.validate(legs, record.total_slippage);
        if (!verdict.ok) return this.fail(record, verdict.reason, verdict.detail);
      }

      record.filled = true;
      this.deps.metrics?.recordExitSlippage(record.total_slippage);
      return { ok: true, legs, record };
    } finally {
      this.active--;
      this.inFlight.delete(key);
    }
  }

  /* -------------------------------- internals ----------------------------- */

  private timingFor(detectedAt: number): {
    detectedAt: number;
    sentAt: number;
    arrivalAt: number;
    executedAt: number;
  } {
    const cfg = this.deps.cfg;
    if (cfg.executionMode === "paper_touch") {
      // No delay is modelled: the fill is taken from the detection instant.
      return { detectedAt, sentAt: detectedAt, arrivalAt: detectedAt, executedAt: detectedAt };
    }
    const sentAt = detectedAt + Math.max(0, cfg.simulatedDecisionMs);
    const arrivalAt = sentAt + Math.max(0, cfg.simulatedLatencyMs);
    return { detectedAt, sentAt, arrivalAt, executedAt: arrivalAt };
  }

  /**
   * Wait for, and capture, the first book each token publishes at or after
   * `arrivalAt`.
   *
   * In `paper_touch` mode the current books are taken as they stand, which is the
   * mode's definition. Otherwise the store is OBSERVED (so an intermediate packet
   * cannot be skipped) while the injected clock/sleep drives the timeout.
   */
  private async awaitBooks(
    tokens: number[],
    arrivalAt: number,
  ): Promise<Map<number, BoxQuote>> {
    const wanted = new Set(tokens);
    const captured = new Map<number, BoxQuote>();

    const takeCurrent = (requireAfterArrival: boolean) => {
      for (const token of wanted) {
        if (captured.has(token)) continue;
        const q = this.deps.quotes.get(token);
        if (!q) continue;
        if (requireAfterArrival && q.at < arrivalAt) continue;
        captured.set(token, q);
      }
    };

    if (this.deps.cfg.executionMode === "paper_touch") {
      takeCurrent(false);
      return captured;
    }

    // Observe first, so nothing published while we sleep is missed.
    const unsubscribe = this.deps.quotes.subscribe((changed, at) => {
      if (at < arrivalAt) return;
      for (const token of changed) {
        if (!wanted.has(token) || captured.has(token)) continue;
        const q = this.deps.quotes.get(token);
        // The store replaces quote objects rather than mutating them, so holding
        // this reference is a permanent record of exactly this packet.
        if (q && q.at >= arrivalAt) captured.set(token, q);
      }
    });

    try {
      // A book may already have arrived (a leg that ticked while we were deciding).
      takeCurrent(true);

      const deadline = arrivalAt + Math.max(0, this.deps.cfg.executionMaxWaitMs);
      const poll = Math.max(1, this.deps.cfg.executionPollMs);
      while (captured.size < wanted.size) {
        const now = this.now();
        if (now >= deadline) break;
        // Sleep until arrival in one hop, then poll in small steps.
        const untilArrival = arrivalAt - now;
        await this.wait(untilArrival > 0 ? Math.min(untilArrival, deadline - now) : poll);
        takeCurrent(true);
      }
      return captured;
    } finally {
      unsubscribe();
    }
  }

  /** One leg evaluated from one exact captured book, with its depth recorded. */
  private legFromQuote(args: {
    role: BoxLegRole;
    side: OrderSide;
    inst: { token: number; tradingsymbol: string; strike: number; instrument_type: "CE" | "PE" };
    quote: BoxQuote;
    lotSize: number;
    now: number;
    maxAgeMs: number;
  }): BoxLegEvaluation {
    const { role, side, inst, quote, lotSize, now, maxAgeMs } = args;
    const isBuy = side === "BUY";
    const levels = isBuy ? quote.asks : quote.bids;
    let price: number | null = null;
    for (const lv of levels) {
      if (!(lv.price > 0)) continue;
      if (price === null) price = lv.price;
      else price = isBuy ? Math.min(price, lv.price) : Math.max(price, lv.price);
    }
    if (price === null) {
      const scalar = isBuy ? quote.ask : quote.bid;
      price = scalar > 0 ? scalar : null;
    }
    let qty = 0;
    if (price !== null) {
      for (const lv of levels) if (lv.price === price && lv.qty > 0) qty += lv.qty;
      if (qty === 0) {
        const scalarPrice = isBuy ? quote.ask : quote.bid;
        if (scalarPrice === price) qty = isBuy ? quote.ask_qty : quote.bid_qty;
      }
    }
    const age = now - quote.at;
    return {
      role,
      side,
      token: inst.token,
      tradingsymbol: inst.tradingsymbol,
      strike: inst.strike,
      instrument_type: inst.instrument_type,
      price,
      qty_at_touch: qty,
      bid: quote.bid,
      bid_qty: quote.bid_qty,
      ask: quote.ask,
      ask_qty: quote.ask_qty,
      quote_at: quote.at,
      quote_version: quote.version,
      // The fill's audit record: captured here and nowhere on the hot path.
      depth: cloneDepth(quote),
      age_ms: age,
      fresh: age >= 0 ? age <= maxAgeMs : false,
      executable: price !== null && price > 0 && qty >= lotSize,
    };
  }

  /** A full candidate evaluation built from the captured books. */
  private evaluateFromCaptured(
    candidate: BoxCandidate,
    captured: Map<number, BoxQuote>,
    at: number,
  ): BoxEvaluation {
    // Reuse the single source of truth for the arithmetic, feeding it exactly the
    // captured books rather than whatever the store holds now.
    return evaluateCandidate({
      candidate,
      quotes: captured,
      now: at,
      maxAgeMs: this.deps.cfg.quoteMaxAgeMs,
      captureDepth: true,
    });
  }

  private buildRecord(args: {
    mode: ExecutionMode;
    timing: { detectedAt: number; sentAt: number; arrivalAt: number; executedAt: number };
    detection: BoxEvaluation;
    execution: BoxEvaluation;
    lotSize: number;
    captured: Map<number, BoxQuote>;
  }): BoxExecutionRecord {
    const { timing, detection, execution, lotSize } = args;
    const detByRole = new Map(detection.legs.map((l) => [l.role, l]));

    let totalSlippage = 0;
    const legs: BoxExecutionLeg[] = execution.legs.map((exec) => {
      const det = detByRole.get(exec.role);
      const perUnit = slippagePerUnit(exec.side, det?.price ?? null, exec.price);
      const slip = perUnit === null ? null : round2(perUnit * lotSize);
      if (slip !== null) totalSlippage += slip;
      return {
        role: exec.role,
        side: exec.side,
        token: exec.token,
        tradingsymbol: exec.tradingsymbol,
        detected_price: det?.price ?? null,
        detected_qty: det?.qty_at_touch ?? 0,
        detected_quote_version: det?.quote_version ?? null,
        detected_quote_at: det?.quote_at ?? null,
        executed_price: exec.price,
        executed_qty: exec.qty_at_touch,
        executed_quote_version: exec.quote_version ?? null,
        executed_quote_at: exec.quote_at,
        slippage_per_unit: perUnit,
        slippage: slip,
        executed_depth: exec.depth ?? null,
      };
    });

    return {
      mode: args.mode,
      detected_at: timing.detectedAt,
      order_sent_at: timing.sentAt,
      executed_at: timing.executedAt,
      decision_to_fill_ms: Math.max(0, timing.executedAt - timing.detectedAt),
      simulated_decision_ms: timing.sentAt - timing.detectedAt,
      simulated_latency_ms: timing.arrivalAt - timing.sentAt,
      detection_quote_version: detection.quote_version,
      execution_quote_version: execution.quote_version,
      detected_net_debit_per_unit: detection.entry_net_debit_per_unit,
      executed_net_debit_per_unit: execution.entry_net_debit_per_unit,
      detected_gross_edge: detection.gross_edge,
      executed_gross_edge: execution.gross_edge,
      total_slippage: round2(totalSlippage),
      legs,
      filled: false,
      failure_reason: null,
      failure_detail: null,
    };
  }

  /** The same record shape for an exit, where there is no candidate evaluation. */
  private buildRecordFromLegs(args: {
    timing: { detectedAt: number; sentAt: number; arrivalAt: number; executedAt: number };
    detectionLegs: BoxLegEvaluation[];
    executionLegs: BoxLegEvaluation[];
    lotSize: number;
    captured: Map<number, BoxQuote>;
  }): BoxExecutionRecord {
    const { timing, detectionLegs, executionLegs, lotSize } = args;
    const detByRole = new Map(detectionLegs.map((l) => [l.role, l]));
    let totalSlippage = 0;
    let detVersion: number | null = null;
    let execVersion: number | null = null;

    const legs: BoxExecutionLeg[] = executionLegs.map((exec) => {
      const det = detByRole.get(exec.role);
      const perUnit = slippagePerUnit(exec.side, det?.price ?? null, exec.price);
      const slip = perUnit === null ? null : round2(perUnit * lotSize);
      if (slip !== null) totalSlippage += slip;
      if (det?.quote_version != null && (detVersion === null || det.quote_version > detVersion)) {
        detVersion = det.quote_version;
      }
      if (exec.quote_version != null && (execVersion === null || exec.quote_version > execVersion)) {
        execVersion = exec.quote_version;
      }
      return {
        role: exec.role,
        side: exec.side,
        token: exec.token,
        tradingsymbol: exec.tradingsymbol,
        detected_price: det?.price ?? null,
        detected_qty: det?.qty_at_touch ?? 0,
        detected_quote_version: det?.quote_version ?? null,
        detected_quote_at: det?.quote_at ?? null,
        executed_price: exec.price,
        executed_qty: exec.qty_at_touch,
        executed_quote_version: exec.quote_version ?? null,
        executed_quote_at: exec.quote_at,
        slippage_per_unit: perUnit,
        slippage: slip,
        executed_depth: exec.depth ?? null,
      };
    });

    return {
      mode: this.mode,
      detected_at: timing.detectedAt,
      order_sent_at: timing.sentAt,
      executed_at: timing.executedAt,
      decision_to_fill_ms: Math.max(0, timing.executedAt - timing.detectedAt),
      simulated_decision_ms: timing.sentAt - timing.detectedAt,
      simulated_latency_ms: timing.arrivalAt - timing.sentAt,
      detection_quote_version: detVersion,
      execution_quote_version: execVersion,
      detected_net_debit_per_unit: null,
      executed_net_debit_per_unit: null,
      detected_gross_edge: null,
      executed_gross_edge: null,
      total_slippage: round2(totalSlippage),
      legs,
      filled: false,
      failure_reason: null,
      failure_detail: null,
    };
  }

  /** Mark an already-built record as failed and count it. */
  private fail(
    record: BoxExecutionRecord,
    reason: BoxExecutionFailureReason,
    detail: string,
  ): BoxExecutionRefusal {
    record.filled = false;
    record.failure_reason = reason;
    record.failure_detail = detail;
    this.deps.metrics?.recordExecutionFailed(reason);
    return { ok: false, record, reason, detail };
  }

  /** A refusal that happened before an execution snapshot could be built. */
  private refuse(
    detection: BoxEvaluation,
    reason: BoxExecutionFailureReason,
    detail: string,
    timing?: { detectedAt: number; sentAt: number; arrivalAt: number; executedAt: number },
    captured?: Map<number, BoxQuote>,
  ): BoxExecutionRefusal {
    const t = timing ?? this.timingFor(detection.at);
    const record: BoxExecutionRecord = {
      mode: this.mode,
      detected_at: t.detectedAt,
      order_sent_at: t.sentAt,
      executed_at: null,
      decision_to_fill_ms: null,
      simulated_decision_ms: t.sentAt - t.detectedAt,
      simulated_latency_ms: t.arrivalAt - t.sentAt,
      detection_quote_version: detection.quote_version,
      execution_quote_version: null,
      detected_net_debit_per_unit: detection.entry_net_debit_per_unit,
      executed_net_debit_per_unit: null,
      detected_gross_edge: detection.gross_edge,
      executed_gross_edge: null,
      total_slippage: 0,
      legs: detection.legs.map((det) => ({
        role: det.role,
        side: det.side,
        token: det.token,
        tradingsymbol: det.tradingsymbol,
        detected_price: det.price,
        detected_qty: det.qty_at_touch,
        detected_quote_version: det.quote_version ?? null,
        detected_quote_at: det.quote_at,
        executed_price: null,
        executed_qty: 0,
        executed_quote_version: captured?.get(det.token)?.version ?? null,
        executed_quote_at: captured?.get(det.token)?.at ?? null,
        slippage_per_unit: null,
        slippage: null,
        executed_depth: null,
      })),
      filled: false,
      failure_reason: reason,
      failure_detail: detail,
    };
    this.deps.metrics?.recordExecutionFailed(reason);
    return { ok: false, record, reason, detail };
  }

  /** The same, for an exit refusal where only leg evaluations exist. */
  private refuseLegs(
    detectionLegs: BoxLegEvaluation[],
    detectedAt: number,
    reason: BoxExecutionFailureReason,
    detail: string,
    timing?: { detectedAt: number; sentAt: number; arrivalAt: number; executedAt: number },
  ): BoxExecutionRefusal {
    const t = timing ?? this.timingFor(detectedAt);
    const record: BoxExecutionRecord = {
      mode: this.mode,
      detected_at: t.detectedAt,
      order_sent_at: t.sentAt,
      executed_at: null,
      decision_to_fill_ms: null,
      simulated_decision_ms: t.sentAt - t.detectedAt,
      simulated_latency_ms: t.arrivalAt - t.sentAt,
      detection_quote_version: null,
      execution_quote_version: null,
      detected_net_debit_per_unit: null,
      executed_net_debit_per_unit: null,
      detected_gross_edge: null,
      executed_gross_edge: null,
      total_slippage: 0,
      legs: detectionLegs.map((det) => ({
        role: det.role,
        side: det.side,
        token: det.token,
        tradingsymbol: det.tradingsymbol,
        detected_price: det.price,
        detected_qty: det.qty_at_touch,
        detected_quote_version: det.quote_version ?? null,
        detected_quote_at: det.quote_at,
        executed_price: null,
        executed_qty: 0,
        executed_quote_version: null,
        executed_quote_at: null,
        slippage_per_unit: null,
        slippage: null,
        executed_depth: null,
      })),
      filled: false,
      failure_reason: reason,
      failure_detail: detail,
    };
    this.deps.metrics?.recordExecutionFailed(reason);
    return { ok: false, record, reason, detail };
  }
}

/**
 * A convenience re-export so callers can build the detection-side exit legs with
 * the same helper the monitor uses.
 */
export { evaluateExitLegs };
