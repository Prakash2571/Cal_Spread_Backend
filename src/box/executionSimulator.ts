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
import { LegExecutor, fillTiming } from "./legExecutor.js";
import {
  cloneDepth,
  entrySideFor,
  evaluateCandidate,
  evaluateExitLegs,
  exitSideFor,
  round2,
  slippagePerUnit,
} from "./math.js";
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
  type PaperLegExecution,
  type PaperLeggingExecutionRecord,
} from "./types.js";

export interface BoxExecutionSimulatorDeps {
  cfg: BoxConfig;
  quotes: BoxQuoteStore;
  isMarketOpen: () => boolean;
  isFeedHealthy: () => boolean;
  metrics?: BoxMetrics;
  /**
   * Total charges (₹) for a set of paper orders, from the LOCAL calculator.
   * Injected so the legging model can price partial-entry and unwind charges
   * without importing the calculator; absent in tests defaults to 0.
   */
  chargeTotal?: (orders: { side: OrderSide; tradingsymbol: string; quantity: number; price: number }[]) => number;
  /** Injected clock — real time in production, a fake clock in tests. */
  now?: () => number;
  /** Injected sleep. Tests advance their clock (and push ticks) inside it. */
  wait?: (ms: number) => Promise<void>;
}

/** The result of a paper_legging entry attempt. */
export type BoxLeggingResult =
  | {
      ok: true;
      /** All four legs filled — the engine opens a box from `evaluation`. */
      evaluation: BoxEvaluation;
      decision: BoxEntryDecision;
      legging: PaperLeggingExecutionRecord;
    }
  | {
      ok: false;
      /** Some or none filled — no box opened. `legging` carries the abort cost. */
      legging: PaperLeggingExecutionRecord;
      reason: BoxExecutionFailureReason;
      detail: string;
    };

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

export class BoxExecutionSimulator {
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  /** Candidate/position keys with a pipeline in flight — the dedupe guard. */
  private inFlight = new Set<string>();
  private active = 0;

  /** Independent per-leg order lifecycles (paper_legging). */
  private readonly legExecutor: LegExecutor;

  constructor(private deps: BoxExecutionSimulatorDeps) {
    this.now = deps.now ?? Date.now;
    this.wait = deps.wait ?? sleep;
    this.legExecutor = new LegExecutor({
      cfg: deps.cfg,
      quotes: deps.quotes,
      now: this.now,
      wait: this.wait,
      // One definition of the touch/liquidity rules, shared with every other path.
      evaluate: (a) => this.legFromQuote(a),
      // Orders still working are abandoned if the world changes underneath them.
      abortReason: () => {
        if (!this.deps.isMarketOpen()) {
          return { reason: "market_closed" as const, detail: "the market closed while orders were working" };
        }
        if (!this.deps.isFeedHealthy()) {
          return { reason: "feed_unhealthy" as const, detail: "the WebSocket feed went unhealthy while orders were working" };
        }
        if (this.leggingStillWanted && !this.leggingStillWanted()) {
          return { reason: "discovery_stopped" as const, detail: "the candidate was no longer wanted while orders were working" };
        }
        return null;
      },
    });
  }

  /** `stillWanted` for the legging run in flight, consulted by the executor. */
  private leggingStillWanted: (() => boolean) | null = null;

  /** Close the unhedged-exposure window and derive its duration. */
  private closeExposure(record: PaperLeggingExecutionRecord, at: number): void {
    if (record.exposure_started_at === null) return;
    record.exposure_ended_at = at;
    record.exposure_duration_ms = round2(at - record.exposure_started_at);
    this.deps.metrics?.recordExposureDuration(record.exposure_duration_ms);
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
          execution.reject === "insufficient_qty"
            ? "insufficient_quantity"
            : execution.reject === "stale_quote" || execution.reject === "no_quote"
              ? "missing_book"
              : "price_moved";
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

  /* -------------------------------- legging ------------------------------- */

  /**
   * paper_legging — simulate FOUR INDEPENDENT option orders rather than one
   * atomic box.
   *
   * Real four-leg execution is not atomic: some legs fill and others do not,
   * leaving temporary exposure that costs money to unwind. This models that:
   *
   *   detect → decision delay → submit (parallel, or sequential) → per-leg
   *   arrival → each leg fills from its own current book, or fails → if all four
   *   fill, open the box → if some fill and others fail, emergency-unwind the
   *   filled legs at the current opposite touch and book the legging loss.
   *
   * Every price is an observed executable touch — never invented, no random
   * slippage. The same recorded ticks always reproduce the same result.
   */
  async simulateLeggingEntry(args: {
    candidate: BoxCandidate;
    detection: BoxEvaluation;
    qualify: (execution: BoxEvaluation, measuredSlippage: number) => BoxEntryDecision;
    stillWanted?: () => boolean;
  }): Promise<BoxLeggingResult> {
    const { candidate, detection } = args;
    const key = candidate.key;
    const direction = candidate.direction ?? "LONG_BOX";
    const lotSize = candidate.lot_size;
    const legMode = this.deps.cfg.legExecutionMode;
    const detByRole = new Map(detection.legs.map((l) => [l.role, l]));

    const baseRecord = (): PaperLeggingExecutionRecord => ({
      mode: "paper_legging",
      leg_execution_mode: legMode,
      detected_at: detection.at,
      order_sent_at: detection.at + Math.max(0, this.deps.cfg.simulatedDecisionMs),
      filled_leg_count: 0,
      opened: false,
      failed_legs: [],
      legs: [],
      first_to_last_fill_ms: null,
      decision_to_first_fill_ms: null,
      decision_to_last_fill_ms: null,
      timed_out_legs: [],
      exposure_started_at: null,
      exposure_ended_at: null,
      exposure_duration_ms: null,
      decision_to_complete_ms: null,
      total_entry_slippage: 0,
      emergency_unwind: false,
      partial_entry_charges: null,
      unwind_charges: null,
      legging_gross_loss: null,
      legging_net_loss: null,
      abort_after_fill: false,
      final_expected_net_profit: null,
      required_expected_net_profit: null,
      failure_reason: null,
      failure_detail: null,
    });

    if (this.inFlight.has(key)) {
      return { ok: false, legging: baseRecord(), reason: "duplicate", detail: "a legging pipeline is already running for this candidate" };
    }
    this.inFlight.add(key);
    this.active++;
    this.deps.metrics?.recordExecutionAttempt();
    this.deps.metrics?.recordLeggingAttempt();
    this.leggingStillWanted = args.stillWanted ?? null;

    try {
      const sentAt = detection.at + Math.max(0, this.deps.cfg.simulatedDecisionMs);
      const tokens = BOX_LEG_ROLES.map((role) => candidate.legs[role].token);

      /**
       * FOUR INDEPENDENT ORDERS.
       *
       * Each one travels, arrives, and then either fills from the latest valid
       * resting book or rests as PENDING until a later depth update fills it — or
       * until its own arrival-relative deadline expires. No common snapshot, so
       * legs genuinely land at different instants (or not at all).
       */
      const run = await this.legExecutor.run({
        requests: BOX_LEG_ROLES.map((role) => {
          const det = detByRole.get(role);
          return {
            role,
            side: entrySideFor(role, direction),
            inst: candidate.legs[role],
            detected_price: det?.price ?? null,
            detected_qty: det?.qty_at_touch ?? 0,
            quantity: lotSize,
          };
        }),
        submitAt: sentAt,
        lotSize,
      });

      const legs = run.legs;
      const filledRoles = legs.filter((l) => l.status === "FILLED").map((l) => l.role);
      const filledCount = filledRoles.length;
      const failedLegs = BOX_LEG_ROLES.filter((r) => !filledRoles.includes(r));
      const timedOutLegs = legs.filter((l) => l.status === "TIMED_OUT").map((l) => l.role);
      const totalEntrySlippage = round2(
        legs.reduce((s, l) => s + (l.status === "FILLED" && l.slippage !== null ? l.slippage : 0), 0),
      );
      const timing = fillTiming(legs, detection.at);
      for (const _ of timedOutLegs) this.deps.metrics?.recordLegTimeout();

      const record: PaperLeggingExecutionRecord = {
        ...baseRecord(),
        filled_leg_count: filledCount,
        failed_legs: failedLegs,
        timed_out_legs: timedOutLegs,
        legs,
        first_to_last_fill_ms: timing.first_to_last_fill_ms,
        decision_to_first_fill_ms: timing.decision_to_first_fill_ms,
        decision_to_last_fill_ms: timing.decision_to_last_fill_ms,
        // Exposure starts the moment the FIRST leg fills. It ends when the box is
        // complete (4/4) or when the unwind finishes — set on those paths below.
        exposure_started_at: timing.first_fill_at,
        exposure_ended_at: filledCount === 4 ? timing.last_fill_at : null,
        exposure_duration_ms:
          filledCount === 4 && timing.first_fill_at !== null && timing.last_fill_at !== null
            ? round2(timing.last_fill_at - timing.first_fill_at)
            : null,
        decision_to_complete_ms: round2(this.now() - detection.at),
        total_entry_slippage: totalEntrySlippage,
      };

      // The run was cut short (feed died / market shut / discovery stopped). Legs
      // that had already filled are still real, so fall through to the abort
      // accounting below rather than pretending nothing happened.
      if (run.aborted && filledCount === 0) {
        return this.leggingRefuse(record, run.aborted.reason, run.aborted.detail);
      }

      if (timing.first_fill_at !== null) {
        this.deps.metrics?.recordFirstFillLatency(timing.decision_to_first_fill_ms ?? 0);
        this.deps.metrics?.recordLastFillLatency(timing.decision_to_last_fill_ms ?? 0);
      }

      // ---- All four filled. Re-qualify on the ACTUAL FILL PRICES. ----
      if (filledCount === 4) {
        // The four legs filled at four different instants, so the store's CURRENT
        // books are not what we traded. Qualification must price the books each leg
        // actually filled from — otherwise a box could be accepted or rejected on
        // prices that never touched this position.
        const completedAt = timing.last_fill_at ?? this.now();
        const execution = this.evaluateFromCaptured(candidate, run.booksAtFill, completedAt);
        const decision = args.qualify(execution, totalEntrySlippage);
        record.final_expected_net_profit = decision.expected_net_profit;
        record.required_expected_net_profit = decision.min_expected_net_profit;

        /**
         * ABORT AFTER FILL.
         *
         * The four orders have ALREADY filled, so we cannot pretend nothing
         * happened and simply refuse the entry — that would silently discard a
         * position the simulated market really gave us, and flatter the strategy
         * by hiding the cost of a dislocation that decayed in flight.
         *
         * Instead: reverse all four legs immediately at the current opposite
         * touch, book the true round-trip cost (adverse spread + charges both
         * ways), and open NO box.
         */
        if (!decision.qualifies) {
          record.abort_after_fill = true;
          record.emergency_unwind = true;
          await this.wait(Math.max(0, this.deps.cfg.legUnwindLatencyMs));
          const unwind = this.unwindFilledLegs(candidate, legs, lotSize);
          record.partial_entry_charges = unwind.partial_entry_charges;
          record.unwind_charges = unwind.unwind_charges;
          record.legging_gross_loss = unwind.legging_gross_loss;
          record.legging_net_loss = unwind.legging_net_loss;
          // The box was complete and hedged, then reversed: exposure ends with the
          // unwind, not with the fourth fill.
          this.closeExposure(record, this.now());
          record.decision_to_complete_ms = round2(this.now() - detection.at);
          // A failed unwind is the more serious condition, so it wins the label.
          record.failure_reason = unwind.unwindFailed ? "unwind_failed" : "abort_after_fill";
          record.failure_detail =
            `4/4 filled, but the executed economics no longer qualify: expected net ` +
            `₹${decision.expected_net_profit ?? "?"} < required ₹${decision.min_expected_net_profit}` +
            (unwind.unwindFailed ? " (one or more legs could not be unwound)" : "");
          // Counted as an ABORT, never as a 4/4 fill — no box was opened.
          this.deps.metrics?.recordLeggingAbortAfterFill();
          this.deps.metrics?.recordExecutionFailed(record.failure_reason);
          this.deps.metrics?.recordLeggingLoss(unwind.legging_net_loss);
          if (record.first_to_last_fill_ms !== null) {
            this.deps.metrics?.recordFirstToLastFill(record.first_to_last_fill_ms);
          }
          return { ok: false, legging: record, reason: record.failure_reason, detail: record.failure_detail };
        }

        record.opened = true;
        this.deps.metrics?.recordLeggingOutcome(4, 0);
        // Detection → the box actually being complete (the LAST leg's fill).
        this.deps.metrics?.recordExecutionFilled(totalEntrySlippage, round2(completedAt - detection.at));
        if (record.first_to_last_fill_ms !== null) {
          this.deps.metrics?.recordFirstToLastFill(record.first_to_last_fill_ms);
        }
        return { ok: true, evaluation: execution, decision, legging: record };
      }

      // ---- Partial (1-3) or nothing filled. ----
      this.deps.metrics?.recordLeggingOutcome(filledCount, filledCount);
      for (const r of failedLegs) this.deps.metrics?.recordLeggingFailedRole(r);

      if (filledCount === 0) {
        // No exposure was ever taken on, so no legging cost.
        record.failure_reason = "legging_incomplete";
        record.failure_detail = "no leg filled at arrival";
        this.deps.metrics?.recordExecutionFailed("legging_incomplete");
        return { ok: false, legging: record, reason: "legging_incomplete", detail: record.failure_detail };
      }

      // Emergency unwind the filled legs at the current opposite touch.
      await this.wait(Math.max(0, this.deps.cfg.legUnwindLatencyMs));
      record.emergency_unwind = true;
      const unwind = this.unwindFilledLegs(candidate, legs, lotSize);
      record.partial_entry_charges = unwind.partial_entry_charges;
      record.unwind_charges = unwind.unwind_charges;
      record.legging_gross_loss = unwind.legging_gross_loss;
      record.legging_net_loss = unwind.legging_net_loss;
      // Directional exposure ran from the first fill until the unwind completed.
      this.closeExposure(record, this.now());
      record.decision_to_complete_ms = round2(this.now() - detection.at);
      record.failure_reason = unwind.unwindFailed ? "unwind_failed" : "legging_incomplete";
      record.failure_detail = `${filledCount}/4 filled, failed legs: ${failedLegs.join(", ")}${unwind.unwindFailed ? " (one or more could not be unwound)" : ""}`;

      this.deps.metrics?.recordExecutionFailed(record.failure_reason);
      this.deps.metrics?.recordLeggingLoss(unwind.legging_net_loss);

      return { ok: false, legging: record, reason: record.failure_reason, detail: record.failure_detail };
    } finally {
      this.active--;
      this.inFlight.delete(key);
    }
  }

  /**
   * Emergency-reverse every FILLED leg at the CURRENT opposite touch, and price
   * the whole episode.
   *
   * Shared by both abort paths — a partial fill (1-3 legs, real directional
   * exposure) and an abort after a complete 4/4 fill (economics failed). In both
   * cases the money already spent is real, so the cost is computed from observed
   * touches only: never an invented price, never a random slippage figure.
   *
   * Mutates each leg's status/unwind fields so the per-leg audit trail shows what
   * happened, and marks a leg UNWIND_FAILED when no opposite touch existed — that
   * leaves simulated exposure outstanding, which must stay visible.
   */
  private unwindFilledLegs(
    candidate: BoxCandidate,
    legs: PaperLegExecution[],
    lotSize: number,
  ): {
    unwindFailed: boolean;
    partial_entry_charges: number;
    unwind_charges: number;
    legging_gross_loss: number;
    legging_net_loss: number;
  } {
    const unwindAt = this.now();
    let unwindFailed = false;
    let grossLoss = 0;
    const filledEntryOrders: { side: OrderSide; tradingsymbol: string; quantity: number; price: number }[] = [];
    const unwindOrders: { side: OrderSide; tradingsymbol: string; quantity: number; price: number }[] = [];

    for (const legExec of legs) {
      if (legExec.status !== "FILLED" || legExec.fill_price === null) continue;
      filledEntryOrders.push({
        side: legExec.side,
        tradingsymbol: legExec.tradingsymbol,
        quantity: lotSize,
        price: legExec.fill_price,
      });
      const inst = candidate.legs[legExec.role];
      const unwindSide: OrderSide = legExec.side === "BUY" ? "SELL" : "BUY";
      const q = this.deps.quotes.get(inst.token);
      const uEval = q
        ? this.legFromQuote({
            role: legExec.role,
            side: unwindSide,
            inst,
            quote: q,
            lotSize,
            now: unwindAt,
            maxAgeMs: this.deps.cfg.quoteMaxAgeMs,
          })
        : null;
      if (!uEval || !uEval.executable || !uEval.fresh || uEval.price === null) {
        unwindFailed = true;
        legExec.status = "UNWIND_FAILED";
        legExec.fail_reason = "could not unwind — no opposite touch";
        continue;
      }
      legExec.status = "UNWOUND";
      legExec.unwind_price = uEval.price;
      // Round-trip loss for this leg (positive = money lost).
      const roundTripCost =
        legExec.side === "BUY"
          ? round2((legExec.fill_price - uEval.price) * lotSize) // paid ask, sold bid
          : round2((uEval.price - legExec.fill_price) * lotSize); // sold bid, bought ask
      legExec.unwind_slippage = roundTripCost;
      grossLoss += roundTripCost;
      unwindOrders.push({
        side: unwindSide,
        tradingsymbol: legExec.tradingsymbol,
        quantity: lotSize,
        price: uEval.price,
      });
    }

    const charge = this.deps.chargeTotal ?? (() => 0);
    const partial_entry_charges = round2(charge(filledEntryOrders));
    const unwind_charges = round2(charge(unwindOrders));
    const legging_gross_loss = round2(-grossLoss); // as a P&L (≤ 0)
    const legging_net_loss = round2(legging_gross_loss - partial_entry_charges - unwind_charges);
    return { unwindFailed, partial_entry_charges, unwind_charges, legging_gross_loss, legging_net_loss };
  }

  private leggingRefuse(
    record: PaperLeggingExecutionRecord,
    reason: BoxExecutionFailureReason,
    detail: string,
  ): BoxLeggingResult {
    record.failure_reason = reason;
    record.failure_detail = detail;
    this.deps.metrics?.recordExecutionFailed(reason);
    return { ok: false, legging: record, reason, detail };
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
   * The LATEST VALID book for each token AT the simulated arrival time.
   *
   * TASK 2 — this deliberately models "the current market state at arrival",
   * NOT "the first tick published after arrival". A resting order book does not
   * stop being valid just because no new tick arrived after our order reached the
   * exchange: an option quoted `Ask ₹100 × 500` at 10:00:00.000 with no update is
   * still `Ask ₹100 × 500` at 10:00:00.250. Requiring a fresh post-arrival tick
   * falsely rejected quiet-but-valid books.
   *
   * So: wait until arrival (we cannot act before the order lands), then read the
   * store's current book per token. Any tick that landed DURING the latency is
   * naturally the current book by then, so an adverse or favourable in-flight move
   * is used automatically. A book that is simply old is judged by the downstream
   * freshness check (age at executedAt vs `quoteMaxAgeMs`), and a token with no
   * book at all is `missing_book`.
   *
   * `paper_touch` keeps its definition: the detection-instant book, no delay.
   */
  private async awaitBooks(
    tokens: number[],
    arrivalAt: number,
  ): Promise<Map<number, BoxQuote>> {
    const wanted = new Set(tokens);
    const captured = new Map<number, BoxQuote>();

    const takeCurrent = () => {
      captured.clear();
      for (const token of wanted) {
        const q = this.deps.quotes.get(token);
        // The store replaces quote objects rather than mutating them, so holding
        // this reference is a permanent record of exactly this packet.
        if (q) captured.set(token, q);
      }
    };

    if (this.deps.cfg.executionMode === "paper_touch") {
      takeCurrent();
      return captured;
    }

    // Wait until the simulated arrival instant, in bounded steps, so any ticks
    // published during the latency window land in the store first. In live
    // operation this is a real sleep; in tests the injected clock advances and
    // fires scheduled ticks. We never wait for a NEW tick — only until arrival.
    const poll = Math.max(1, this.deps.cfg.executionPollMs);
    let guard = 0;
    while (this.now() < arrivalAt) {
      const remaining = arrivalAt - this.now();
      await this.wait(Math.min(remaining, poll));
      if (++guard > 100_000) break; // never spin forever on a stuck clock
    }

    // Read the latest current book for every leg. Freshness/existence/quantity
    // are validated by the caller against `executedAt`.
    takeCurrent();
    return captured;
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
      const detVer = det?.quote_version ?? null;
      const execVer = exec.quote_version ?? null;
      return {
        role: exec.role,
        side: exec.side,
        token: exec.token,
        tradingsymbol: exec.tradingsymbol,
        detected_price: det?.price ?? null,
        detected_qty: det?.qty_at_touch ?? 0,
        detected_quote_version: detVer,
        detected_quote_at: det?.quote_at ?? null,
        executed_price: exec.price,
        executed_qty: exec.qty_at_touch,
        executed_quote_version: execVer,
        executed_quote_at: exec.quote_at,
        slippage_per_unit: perUnit,
        slippage: slip,
        executed_book_age_ms: exec.age_ms,
        // A newer book arrived during the latency when the version advanced.
        book_changed: detVer !== null && execVer !== null && execVer !== detVer,
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
