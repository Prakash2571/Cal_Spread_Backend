/**
 * The box scanner: the event-driven discovery and entry path.
 *
 *   Kite WebSocket → quote map → affected candidates → fast LOCAL calculation
 *   → net-profit qualification → centralized execution gateway → durable trade
 *
 * Nothing on the qualification path touches MongoDB, and nothing waits on the
 * frontend OR on Zerodha. Charges are computed synchronously by the local
 * calculator; Zerodha is consulted only afterwards, to reconcile. A tick affects
 * only the candidates that reference the token that moved.
 *
 * The scanner never calls Kite order APIs directly. Qualified candidates are
 * handed to a narrow execution gateway: paper modes delegate to the deterministic
 * simulator, while explicit live mode uses durable bounded-LIMIT coordination.
 */

import type { BoxConfig } from "./config.js";
import { configSnapshot, prefilterGrossThreshold, requiredNetProfit } from "./config.js";
import {
  BoxChargeEstimator,
  buildEntryChargeLegs,
  type BoxChargeLeg,
} from "./charges.js";
import type { BoxExecutionGateway } from "./executionGateway.js";
import { LocalChargeCalculator } from "./localCharges.js";
import type { BoxMetrics } from "./metrics.js";
import {
  evaluateCandidate,
  evaluateCandidateIndicative,
  evaluateEntryDecision,
  passesGrossPrefilter,
  round2,
} from "./math.js";
import type { BoxQuoteStore } from "./quotes.js";
import type { BoxPositionBook } from "./positions.js";
import {
  BOX_LEG_ROLES,
  directionOf,
  type BoxCandidate,
  type BoxChargeOrigin,
  type BoxEntryDecision,
  type BoxEvaluation,
  type BoxExecutionFailureReason,
  type BoxExecutionRecord,
  type BoxOpportunity,
  type PaperLeggingExecutionRecord,
} from "./types.js";

/** What the scanner needs from the outside world. */
export interface BoxScannerDeps {
  cfg: BoxConfig;
  quotes: BoxQuoteStore;
  /** Zerodha estimator — used ONLY for asynchronous reconciliation now. */
  charges: BoxChargeEstimator;
  /** The synchronous, deterministic charge calculator for the hot path. */
  localCharges: LocalChargeCalculator;
  /** Central mode-neutral execution gateway. */
  executionSim: BoxExecutionGateway;
  positions: BoxPositionBook;
  metrics?: BoxMetrics;
  /** Opens the paper trade. Returns the trade id, or null when it did not open. */
  openPaperTrade: (args: {
    candidate: BoxCandidate;
    /** The EXECUTION snapshot (with depth) the fill was taken from. */
    evaluation: BoxEvaluation;
    entryLegs: BoxChargeLeg[];
    entryChargesTotal: number | null;
    estimatedExitChargesTotal: number | null;
    chargeOrigin: BoxChargeOrigin;
    decision: BoxEntryDecision;
    execution: BoxExecutionRecord | null;
    /** Present when the fill came from the paper_legging model (4/4 filled). */
    legging?: PaperLeggingExecutionRecord | null;
  }) => Promise<string | null>;
  /**
   * paper_legging only: a fill attempt that did NOT open a box (some legs filled
   * and were unwound, or none filled). Persisted so failed-execution losses are
   * not invisible in the strategy's analytics.
   */
  onExecutionAttempt?: (
    candidate: BoxCandidate,
    legging: PaperLeggingExecutionRecord,
    reason: BoxExecutionFailureReason,
    detail: string,
  ) => void;
  /** Ledger hook for rejections and detections. */
  onEvent: (
    event:
      | "DETECTED"
      | "ENTRY_REJECTED_STALE"
      | "ENTRY_REJECTED_LIQUIDITY"
      | "ENTRY_REJECTED_FEES"
      | "ENTRY_REJECTED_DUPLICATE"
      | "ENTRY_REJECTED_NET_PROFIT"
      | "ENTRY_REJECTED_EXECUTION",
    candidate: BoxCandidate,
    evaluation: BoxEvaluation,
    detail?: string,
  ) => void;
}

/** Counters exposed by GET /api/box/status. */
export interface BoxScannerStats {
  ticksApplied: number;
  evaluations: number;
  prefilterPasses: number;
  qualifyAttempts: number;
  executionsAttempted: number;
  entriesOpened: number;
  rejectedStale: number;
  rejectedLiquidity: number;
  rejectedNetProfit: number;
  rejectedExecution: number;
  rejectedDuplicate: number;
  lastEvaluationAt: number | null;
}

/**
 * Rejection events are only worth writing once per candidate per cooldown —
 * otherwise a single thin book would produce thousands of identical ledger rows.
 */
const REJECT_LOG_COOLDOWN_MS = 60_000;

export class BoxScanner {
  private candidates = new Map<string, BoxCandidate>();
  /** token → candidate keys that reference it. The dependency index. */
  private tokenIndex = new Map<number, Set<string>>();
  /** The newest published view of each candidate. */
  private opportunities = new Map<string, BoxOpportunity>();
  /** Candidates with an entry pipeline in flight. */
  private entryInFlight = new Set<string>();
  private lastRejectLogAt = new Map<string, number>();

  private discovering = false;
  private marketOpen = true;
  private feedHealthy = true;

  private stats: BoxScannerStats = {
    ticksApplied: 0,
    evaluations: 0,
    prefilterPasses: 0,
    qualifyAttempts: 0,
    executionsAttempted: 0,
    entriesOpened: 0,
    rejectedStale: 0,
    rejectedLiquidity: 0,
    rejectedNetProfit: 0,
    rejectedExecution: 0,
    rejectedDuplicate: 0,
    lastEvaluationAt: null,
  };

  constructor(private deps: BoxScannerDeps) {}

  /* ------------------------------ lifecycle ------------------------------ */

  setDiscovering(on: boolean): void {
    this.discovering = on;
  }

  isDiscovering(): boolean {
    return this.discovering;
  }

  setMarketOpen(open: boolean): void {
    this.marketOpen = open;
  }

  isMarketOpen(): boolean {
    return this.marketOpen;
  }

  setFeedHealthy(healthy: boolean): void {
    this.feedHealthy = healthy;
  }

  isFeedHealthy(): boolean {
    return this.feedHealthy;
  }

  getStats(): BoxScannerStats {
    return { ...this.stats };
  }

  /* ------------------------------ candidates ----------------------------- */

  setCandidatesForUnderlying(underlying: string, next: BoxCandidate[]): void {
    for (const [key, cand] of this.candidates) {
      if (cand.underlying !== underlying) continue;
      this.candidates.delete(key);
      this.opportunities.delete(key);
      for (const role of BOX_LEG_ROLES) {
        const set = this.tokenIndex.get(cand.legs[role].token);
        if (!set) continue;
        set.delete(key);
        if (set.size === 0) this.tokenIndex.delete(cand.legs[role].token);
      }
    }
    for (const cand of next) {
      this.candidates.set(cand.key, cand);
      for (const role of BOX_LEG_ROLES) {
        const token = cand.legs[role].token;
        let set = this.tokenIndex.get(token);
        if (!set) {
          set = new Set();
          this.tokenIndex.set(token, set);
        }
        set.add(cand.key);
      }
    }
  }

  removeUnderlying(underlying: string): void {
    this.setCandidatesForUnderlying(underlying, []);
  }

  get candidateCount(): number {
    return this.candidates.size;
  }

  get monitoredTokenCount(): number {
    return this.tokenIndex.size;
  }

  getCandidate(key: string): BoxCandidate | undefined {
    return this.candidates.get(key);
  }

  candidatesFor(underlying: string): BoxCandidate[] {
    return [...this.candidates.values()].filter((c) => c.underlying === underlying);
  }

  /* ------------------------------- hot path ------------------------------ */

  /**
   * Handle a batch of updated tokens.
   *
   * THE hot path. Synchronous, allocation-light, and only ever looks at
   * candidates that reference one of the tokens that changed.
   */
  onTokensUpdated(tokens: number[], receivedAt?: number): void {
    if (tokens.length === 0) return;
    this.stats.ticksApplied += tokens.length;

    let affected: Set<string> | null = null;
    for (const token of tokens) {
      const keys = this.tokenIndex.get(token);
      if (!keys) continue;
      if (!affected) affected = new Set();
      for (const k of keys) affected.add(k);
    }
    if (!affected) return;

    const now = Date.now();
    for (const key of affected) {
      const cand = this.candidates.get(key);
      if (!cand) continue;
      this.evaluateAndMaybeEnter(cand, now, receivedAt);
    }
  }

  refreshAll(): void {
    const now = Date.now();
    for (const cand of this.candidates.values()) {
      this.evaluateAndMaybeEnter(cand, now);
    }
  }

  private evaluateAndMaybeEnter(cand: BoxCandidate, now: number, receivedAt?: number): void {
    this.stats.evaluations++;
    this.stats.lastEvaluationAt = now;
    this.deps.metrics?.evaluations.mark(1, now);

    // Hot path: NO depth cloning. Only the touch view is built.
    const evaluation = evaluateCandidate({
      candidate: cand,
      quotes: this.deps.quotes.view(),
      now,
      maxAgeMs: this.deps.cfg.quoteMaxAgeMs,
      captureDepth: false,
    });

    if (receivedAt !== undefined) {
      this.deps.metrics?.receiveToEvaluation.push(Math.max(0, now - receivedAt));
    }

    const openKeyTaken = this.deps.positions.getByKey(cand.key) !== undefined;
    const threshold = prefilterGrossThreshold(this.deps.cfg);
    const passedPrefilter = passesGrossPrefilter(evaluation.gross_edge, threshold);
    if (passedPrefilter) this.stats.prefilterPasses++;

    this.publish(evaluation, {
      openKeyTaken,
      passedPrefilter,
      decision: this.localDecisionFor(evaluation, this.deps.cfg.expectedEntrySlippage),
    });

    if (!this.discovering) return;
    if (!this.marketOpen) return;
    if (!this.feedHealthy) return;
    if (openKeyTaken) return;
    if (!evaluation.tradable) {
      this.noteRejection(cand, evaluation);
      return;
    }
    if (!passedPrefilter) return;
    if (this.entryInFlight.has(cand.key)) return;
    if (!this.deps.executionSim.hasCapacity()) return;

    // Only candidates that clear the fast local net-profit projection are worth
    // spending an execution pipeline on. This keeps the hot path cheap.
    const localDecision = this.localDecisionFor(evaluation, this.deps.cfg.expectedEntrySlippage);
    if (!localDecision || !localDecision.qualifies) {
      if (localDecision && localDecision.reject === "below_expected_net_profit") {
        this.noteNetProfitRejection(cand, evaluation, localDecision);
      }
      return;
    }

    // This is the rare transition from discovery into a real order pipeline, so
    // take one immutable four-book snapshot with depth. Hot tick evaluation stays
    // allocation-light; subsequent ticks cannot mutate this audit record.
    const executionDetection = evaluateCandidate({
      candidate: cand,
      quotes: this.deps.quotes.view(),
      now,
      maxAgeMs: this.deps.cfg.quoteMaxAgeMs,
      captureDepth: true,
    });
    void this.attemptEntry(cand, executionDetection);
  }

  /**
   * The projected expected-net-profit decision from the LOCAL calculator.
   *
   * Synchronous and allocation-cheap: the calculator does a few dozen float ops
   * and never touches the network. Used both to publish the opportunity's cost
   * breakdown and to decide whether a candidate is worth executing.
   */
  private localDecisionFor(
    evaluation: BoxEvaluation,
    entrySlippageAllowance: number,
  ): BoxEntryDecision | null {
    if (evaluation.gross_edge === null) return null;
    const legs = buildEntryChargeLegs(evaluation.candidate, evaluation.legs);
    if (!legs) return null;
    const totals = this.deps.localCharges.totals(
      legs.map((l) => ({
        side: l.side,
        tradingsymbol: l.tradingsymbol,
        quantity: l.quantity,
        price: l.price,
      })),
    );
    return evaluateEntryDecision({
      grossEdge: evaluation.gross_edge,
      entryCharges: totals.entry,
      estimatedExitCharges: totals.exit,
      // PRE-EXECUTION PROJECTION: this is the DETECTION gross edge, so an expected
      // entry-slippage allowance is deducted alongside the future exit allowance.
      entrySlippageAllowance,
      futureExitSlippageAllowance: this.deps.cfg.expectedExitSlippage,
      cfg: this.deps.cfg,
    });
  }

  /* ------------------------------ entry path ----------------------------- */

  /**
   * The paper-entry pipeline.
   *
   *   1. reserve the strike pair (synchronous, atomic)
   *   2. hand the DETECTION snapshot to the execution simulator
   *   3. the simulator waits the decision + latency delay and fills from the
   *      first post-arrival WebSocket book — re-qualifying on the EXECUTED prices
   *      with the MEASURED slippage
   *   4. only a qualified, filled execution creates the paper trade
   *
   * There is no charge network call anywhere on this path; the local calculator
   * prices both the projection and the final qualification.
   */
  private async attemptEntry(cand: BoxCandidate, detection: BoxEvaluation): Promise<void> {
    if (!this.deps.positions.reserve(cand.key)) {
      this.stats.rejectedDuplicate++;
      this.logRejection("ENTRY_REJECTED_DUPLICATE", cand, detection, "strike pair already taken");
      return;
    }
    this.entryInFlight.add(cand.key);
    this.stats.qualifyAttempts++;
    this.stats.executionsAttempted++;
    // This parent id represents ONE strategy decision. Four leg orders, recovery
    // work and retries remain child events and cannot change this denominator.
    const attemptId = `entry:${cand.key}:${detection.at}`;
    this.deps.metrics?.beginLogicalAttempt(attemptId);
    const detectionDecision = this.localDecisionFor(
      detection,
      this.deps.cfg.expectedEntrySlippage,
    );
    const finish = (
      outcome: "SUCCESS" | "FAILED" | "PARTIAL_RECOVERED" | "PARTIAL_UNRESOLVED" | "ABORTED",
      reason: string | null,
      realisedExpectedNet: number | null,
      decisionToFillMs: number | null,
      arrivalExecutionSlippage: number | null,
    ) => this.deps.metrics?.finishLogicalAttempt(attemptId, outcome, reason, {
      decisionDeterioration:
        detectionDecision && detectionDecision.expected_net_profit !== null && realisedExpectedNet !== null
          ? round2(detectionDecision.expected_net_profit - realisedExpectedNet)
          : null,
      // Atomic paper fills are priced exactly from their captured arrival book, so
      // zero is an honest measurement. Modes without an arrival reference stay null.
      arrivalExecutionSlippage,
      detectionToDecisionMs: 0,
      decisionToOrderSendMs: 0,
      orderLatencyMs: decisionToFillMs,
      decisionToFillMs,
    });

    const stillWanted = () =>
      this.discovering &&
      this.marketOpen &&
      this.feedHealthy &&
      this.deps.positions.getByKey(cand.key) === undefined;

    try {
      // Independent role orders in paper_legging and live modes.
      if (this.deps.cfg.executionMode === "paper_legging" || this.deps.cfg.executionMode === "live") {
        const legging = await this.deps.executionSim.simulateLeggingEntry({
          candidate: cand,
          detection,
          stillWanted,
          qualify: (execution, measuredSlippage) => this.finalQualify(execution, measuredSlippage),
        });
        if (!legging.ok) {
          // Some legs may have filled and been unwound: persist the attempt so the
          // legging loss is not invisible, then release.
          if (legging.legging.filled_leg_count > 0 || legging.legging.emergency_unwind) {
            this.deps.onExecutionAttempt?.(cand, legging.legging, legging.reason, legging.detail);
          }
          this.recordExecutionFailure(cand, detection, legging.reason, legging.detail);
          finish(
            // Residual exposure outstanding is the most severe state, whatever
            // else is true. Otherwise: a clean abort-after-fill (4/4 filled, then
            // fully reversed because the executed economics failed re-qualification)
            // is ABORTED, never "recovered" — it must be checked BEFORE the generic
            // filled_leg_count>0 case, since an abort-after-fill always has
            // filled_leg_count===4 and would otherwise be misclassified as a partial
            // recovery. A partial fill (1-3 legs) that was cleanly unwound with no
            // residual is the actual PARTIAL_RECOVERED case.
            legging.legging.residual_exposure.length > 0
              ? "PARTIAL_UNRESOLVED"
              : legging.legging.abort_after_fill
                ? "ABORTED"
                : legging.legging.filled_leg_count > 0
                  ? "PARTIAL_RECOVERED"
                  : "FAILED",
            legging.reason,
            legging.legging.final_expected_net_profit,
            legging.legging.decision_to_last_fill_ms,
            null,
          );
          this.deps.positions.release(cand.key);
          return;
        }
        /**
         * EXECUTION OWNERSHIP — do not re-check discovery state here.
         *
         * Four simulated orders have FILLED and the box qualified on those fill
         * prices. Those fills happened: releasing the reservation and returning
         * would delete a complete, hedged position from existence, with no unwind
         * and no entry in the P&L — the single worst thing a paper simulator can do,
         * because it silently flatters every result.
         *
         * A candidate is freely CANCELLABLE only BEFORE its first fill (the
         * executor's own abort predicate handles that, and does so per run). From
         * the first fill onward the execution owns the outcome, so the completed box
         * is persisted and handed to the monitor — which runs regardless of RUN/STOP,
         * market hours or feed health, and will exit it when it can.
         */
        const opened = await this.finalizeOpen(cand, legging.evaluation, legging.decision, null, legging.legging);
        finish(
          opened ? "SUCCESS" : "PARTIAL_UNRESOLVED",
          opened ? null : "persistence_unavailable",
          legging.decision.expected_net_profit,
          legging.legging.decision_to_last_fill_ms,
          null,
        );
        return;
      }

      const result = await this.deps.executionSim.simulateEntry({
        candidate: cand,
        detection,
        stillWanted,
        // The final gate: expected NET profit on the EXECUTED snapshot, with the
        // measured entry slippage RECORDED but never deducted again.
        qualify: (execution, measuredSlippage) => this.finalQualify(execution, measuredSlippage),
      });

      if (!result.ok) {
        this.recordExecutionFailure(cand, detection, result.reason, result.detail);
        finish(
          "FAILED",
          result.reason,
          null,
          result.record.decision_to_fill_ms,
          result.record.executed_at === null ? null : 0,
        );
        this.deps.positions.release(cand.key);
        return;
      }

      /**
       * EXECUTION OWNERSHIP (same rule as the legging path above).
       *
       * This used to re-check discovery/market/feed state and abandon the entry.
       * But the simulator has already produced a FILL at observed executable prices
       * — the four legs are on. Dropping it here erased that position silently, so a
       * STOP, a feed blip or the closing bell landing in the same turn made a real
       * simulated fill vanish from the book and from the P&L.
       *
       * The simulator's own pre-fill checks are what cancel an entry safely; once
       * filled, the position is persisted and the (always-on) monitor owns it.
       */
      const opened = await this.finalizeOpen(cand, result.evaluation, result.decision, result.record, null);
      finish(
        opened ? "SUCCESS" : "PARTIAL_UNRESOLVED",
        opened ? null : "persistence_unavailable",
        result.decision.expected_net_profit,
        result.record.decision_to_fill_ms,
        // Atomic paper fills are the captured arrival-book touch by construction.
        0,
      );
    } catch (err) {
      console.warn("[Box] entry attempt failed for", cand.key, err);
      finish("FAILED", "internal_error", null, null, null);
      this.deps.positions.release(cand.key);
    } finally {
      this.entryInFlight.delete(cand.key);
    }
  }

  /**
   * THE FINAL entry qualification on an EXECUTED snapshot.
   *
   * `execution.gross_edge` already reflects any adverse entry movement, so the
   * measured entry slippage is RECORDED (analytics) but never deducted again —
   * only the future exit-slippage allowance is a forward cost here. This is the
   * fix for entry-slippage double counting (Task 1), shared by every mode.
   */
  private finalQualify(execution: BoxEvaluation, measuredSlippage: number): BoxEntryDecision {
    const legs = buildEntryChargeLegs(execution.candidate, execution.legs);
    if (!legs) {
      return {
        gross_edge: execution.gross_edge,
        entry_charges: null,
        estimated_exit_charges: null,
        execution_cost: 0,
        entry_slippage_allowance: 0,
        future_exit_slippage_allowance: 0,
        measured_entry_slippage: null,
        safety_buffer: this.deps.cfg.safetyBuffer,
        expected_net_profit: null,
        min_expected_net_profit: requiredNetProfit(this.deps.cfg),
        passes_gross_prefilter: false,
        qualifies: false,
        reject: "unpriced_charges",
      };
    }
    const totals = this.deps.localCharges.totals(
      legs.map((l) => ({
        side: l.side,
        tradingsymbol: l.tradingsymbol,
        quantity: l.quantity,
        price: l.price,
      })),
    );
    return evaluateEntryDecision({
      grossEdge: execution.gross_edge,
      entryCharges: totals.entry,
      estimatedExitCharges: totals.exit,
      entrySlippageAllowance: 0,
      futureExitSlippageAllowance: this.deps.cfg.expectedExitSlippage,
      measuredEntrySlippage: measuredSlippage,
      cfg: this.deps.cfg,
    });
  }

  /** Build the final charge legs and hand the fill to the engine to persist. */
  private async finalizeOpen(
    cand: BoxCandidate,
    evaluation: BoxEvaluation,
    decision: BoxEntryDecision,
    execution: BoxExecutionRecord | null,
    legging: PaperLeggingExecutionRecord | null,
  ): Promise<boolean> {
    const legs = buildEntryChargeLegs(evaluation.candidate, evaluation.legs);
    if (!legs) {
      // Should be unreachable: a filled evaluation always has four priced legs. But
      // we are PAST the fill here, so if it ever happens the position exists and we
      // failed to record it — that must never be silent.
      console.error(
        `[Box] LOST FILL: ${cand.key} filled but its charge legs could not be built, ` +
          `so no position was recorded. This is an accounting hole — investigate.`,
      );
      this.deps.positions.release(cand.key);
      return false;
    }
    const orders = legs.map((l) => ({
      side: l.side,
      tradingsymbol: l.tradingsymbol,
      quantity: l.quantity,
      price: l.price,
    }));
    const local = this.deps.localCharges.roundTrip(orders);

    const id = await this.deps.openPaperTrade({
      candidate: cand,
      evaluation,
      entryLegs: legs,
      entryChargesTotal: local.entry_total,
      estimatedExitChargesTotal: local.estimated_exit_total,
      chargeOrigin: "local",
      decision,
      execution,
      legging,
    });

    if (id) {
      this.stats.entriesOpened++;
      this.markStatus(cand.key, this.deps.cfg.executionMode === "live" ? "LIVE_OPENED" : "PAPER_OPENED");
    } else {
      // The legs FILLED but nothing was persisted — either the unique index says this
      // box is already open, or the write failed. Either way simulated exposure was
      // taken on and is now unrecorded, so the P&L is understated. Loud by design:
      // durable retry / residual-exposure adoption for this path is not built yet.
      console.error(
        `[Box] LOST FILL: ${cand.key} filled but no position was persisted ` +
          `(duplicate open box, or the insert failed). Simulated exposure is unrecorded — ` +
          `treat today's P&L as incomplete until this is reconciled.`,
      );
      this.deps.positions.release(cand.key);
    }
    return id !== null;
  }

  private recordExecutionFailure(
    cand: BoxCandidate,
    detection: BoxEvaluation,
    reason: string,
    detail: string,
  ): void {
    if (reason === "below_expected_net_profit") {
      this.stats.rejectedNetProfit++;
      this.logRejection("ENTRY_REJECTED_NET_PROFIT", cand, detection, detail);
      return;
    }
    if (reason === "insufficient_quantity" || reason === "missing_book" || reason === "price_moved") {
      this.stats.rejectedLiquidity++;
      this.logRejection("ENTRY_REJECTED_EXECUTION", cand, detection, `${reason}: ${detail}`);
      return;
    }
    // duplicate / discovery_stopped / market_closed / feed_unhealthy /
    // edge_disappeared — expected transients, counted but not spammed to the ledger.
    this.stats.rejectedExecution++;
    this.logRejection("ENTRY_REJECTED_EXECUTION", cand, detection, `${reason}: ${detail}`);
  }

  /* -------------------------------- events -------------------------------- */

  private noteRejection(
    cand: BoxCandidate,
    evaluation: BoxEvaluation,
    detail?: string,
  ): void {
    const reason = evaluation.reject;
    if (reason === "stale_quote" || reason === "no_quote") {
      this.stats.rejectedStale++;
      this.logRejection("ENTRY_REJECTED_STALE", cand, evaluation, detail);
      return;
    }
    if (
      reason === "insufficient_qty" ||
      reason === "missing_bid" ||
      reason === "missing_ask"
    ) {
      this.stats.rejectedLiquidity++;
      this.logRejection("ENTRY_REJECTED_LIQUIDITY", cand, evaluation, detail);
    }
  }

  private noteNetProfitRejection(
    cand: BoxCandidate,
    evaluation: BoxEvaluation,
    decision: BoxEntryDecision,
  ): void {
    this.stats.rejectedNetProfit++;
    this.logRejection(
      "ENTRY_REJECTED_NET_PROFIT",
      cand,
      evaluation,
      `expected net ₹${decision.expected_net_profit ?? "?"} < required ₹${decision.min_expected_net_profit}`,
    );
  }

  private logRejection(
    event:
      | "ENTRY_REJECTED_STALE"
      | "ENTRY_REJECTED_LIQUIDITY"
      | "ENTRY_REJECTED_FEES"
      | "ENTRY_REJECTED_DUPLICATE"
      | "ENTRY_REJECTED_NET_PROFIT"
      | "ENTRY_REJECTED_EXECUTION",
    cand: BoxCandidate,
    evaluation: BoxEvaluation,
    detail?: string,
  ): void {
    if (!passesGrossPrefilter(evaluation.gross_edge, prefilterGrossThreshold(this.deps.cfg))) {
      return;
    }
    const logKey = `${event}|${cand.key}`;
    const last = this.lastRejectLogAt.get(logKey) ?? 0;
    const now = Date.now();
    if (now - last < REJECT_LOG_COOLDOWN_MS) return;
    this.lastRejectLogAt.set(logKey, now);
    this.deps.onEvent(event, cand, evaluation, detail);
  }

  /* ----------------------------- publication ----------------------------- */

  private markStatus(key: string, status: BoxOpportunity["status"]): void {
    const opp = this.opportunities.get(key);
    if (opp) this.opportunities.set(key, { ...opp, status, updated_at: Date.now() });
  }

  private publish(
    evaluation: BoxEvaluation,
    ctx: {
      openKeyTaken: boolean;
      passedPrefilter: boolean;
      decision: BoxEntryDecision | null;
      priceSource?: "touch" | "last_close";
    },
  ): void {
    const cand = evaluation.candidate;
    const previous = this.opportunities.get(cand.key);
    const cfg = this.deps.cfg;
    const direction = cand.direction ?? "LONG_BOX";

    const indicative = ctx.priceSource === "last_close";
    const decision = ctx.decision;
    const expectedNet = decision ? decision.expected_net_profit : null;

    let status: BoxOpportunity["status"];
    if (ctx.openKeyTaken) status = "OPEN";
    else if ((previous?.status === "PAPER_OPENED" || previous?.status === "LIVE_OPENED") && !ctx.openKeyTaken) status = previous.status;
    else if (indicative) status = "INDICATIVE";
    else if (!evaluation.tradable) status = ctx.passedPrefilter ? "REJECTED" : "WATCHING";
    else if (decision && decision.qualifies) status = "ELIGIBLE";
    else status = "WATCHING";

    this.opportunities.set(cand.key, {
      key: cand.key,
      underlying: cand.underlying,
      name: cand.name,
      is_index: cand.is_index,
      expiry: cand.expiry,
      direction,
      lower_strike: cand.lower_strike,
      upper_strike: cand.upper_strike,
      box_width: cand.box_width,
      lot_size: cand.lot_size,
      quantity: cand.lot_size,
      entry_box_cost:
        evaluation.entry_net_debit_per_unit === null
          ? null
          : round2(evaluation.entry_net_debit_per_unit * cand.lot_size),
      gross_edge: evaluation.gross_edge,
      entry_charges: decision ? decision.entry_charges : null,
      estimated_exit_charges: decision ? decision.estimated_exit_charges : null,
      execution_cost: decision ? decision.execution_cost : cfg.expectedEntrySlippage + cfg.expectedExitSlippage,
      safety_buffer: cfg.safetyBuffer,
      projected_net_edge: expectedNet,
      expected_net_profit: expectedNet,
      min_expected_net_profit: requiredNetProfit(cfg),
      charge_origin: "local",
      entry_sides: evaluation.legs.map((l) => ({
        role: l.role,
        side: l.side,
        tradingsymbol: l.tradingsymbol,
      })),
      liquidity_ok: evaluation.tradable,
      depth_ok: evaluation.depth_ok,
      worst_age_ms: evaluation.worst_age_ms,
      price_source: ctx.priceSource ?? "touch",
      status,
      reject: evaluation.reject,
      // Depth/version are internal fill-audit data. The opportunity stream keeps
      // its compact per-leg API shape.
      legs: evaluation.legs.map(({ depth: _depth, quote_version: _version, ...leg }) => leg),
      updated_at: evaluation.at,
    });
  }

  /**
   * Publish an INDICATIVE view of every candidate from last traded / closing
   * prices, for when the market is shut.
   */
  publishIndicative(lastPrices: Map<number, number>): number {
    const now = Date.now();
    const openKeys = this.deps.positions.openKeys();
    let priced = 0;
    for (const cand of this.candidates.values()) {
      const evaluation = evaluateCandidateIndicative({ candidate: cand, lastPrices, now });
      if (evaluation.gross_edge !== null) priced++;
      this.publish(evaluation, {
        openKeyTaken: openKeys.has(cand.key),
        passedPrefilter: passesGrossPrefilter(
          evaluation.gross_edge,
          prefilterGrossThreshold(this.deps.cfg),
        ),
        decision: null,
        priceSource: "last_close",
      });
    }
    this.stats.lastEvaluationAt = now;
    return priced;
  }

  /**
   * Opportunities worth showing: anything tradable-and-interesting, anything that
   * cleared the gross prefilter, and anything already open.
   */
  listOpportunities(limit: number): BoxOpportunity[] {
    const threshold = prefilterGrossThreshold(this.deps.cfg);
    const rows: BoxOpportunity[] = [];
    for (const opp of this.opportunities.values()) {
      const interesting =
        opp.status === "OPEN" ||
        opp.status === "PAPER_OPENED" ||
        opp.status === "LIVE_OPENED" ||
        opp.status === "ELIGIBLE" ||
        opp.status === "UNPRICED" ||
        opp.status === "INDICATIVE" ||
        (opp.gross_edge !== null && opp.gross_edge >= Math.min(threshold, 0)) ||
        (opp.expected_net_profit !== null && opp.expected_net_profit >= 0);
      if (!interesting) continue;
      if (
        opp.status !== "OPEN" &&
        opp.status !== "PAPER_OPENED" &&
        opp.status !== "LIVE_OPENED" &&
        (opp.gross_edge === null || opp.gross_edge <= 0)
      ) {
        continue;
      }
      rows.push(opp);
    }
    rows.sort((a, b) => {
      const an = a.expected_net_profit ?? a.gross_edge ?? Number.NEGATIVE_INFINITY;
      const bn = b.expected_net_profit ?? b.gross_edge ?? Number.NEGATIVE_INFINITY;
      return bn - an;
    });
    return rows.slice(0, limit);
  }

  opportunitiesFor(underlying: string): BoxOpportunity[] {
    return [...this.opportunities.values()].filter((o) => o.underlying === underlying);
  }

  clearOpportunities(): void {
    this.opportunities.clear();
  }
}
