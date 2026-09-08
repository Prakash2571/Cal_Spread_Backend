import type { BrokerOrder, BrokerOrderRequest } from "./brokerAdapter.js";
import {
  BrokerAmbiguousSubmitError,
  BrokerOrderRejectedError,
  BrokerPreSubmitRefusedError,
  boxClientOrderId,
} from "./brokerAdapter.js";
import {
  planPartialEntryRecovery,
  verifyQuantityConservation,
  type EntryLegOutcome,
  type PartialEntryPlan,
} from "./partialEntryRecovery.js";
import {
  boxCapitalSummary,
  evaluateBoxCapitalAdmission,
  grossEntryOrderNotional,
  type BoxCapitalReport,
} from "./boxCapital.js";
import { entrySubmissionOrder } from "./entrySubmissionOrder.js";
import { evaluateLiveEntryGuard, stillWantedSafely } from "./liveEntryGuard.js";
import {
  OrderPersistenceAfterFillError,
  type BoxOrderManager,
  type CheckedFeedStamp,
  type EntryCapitalStamp,
} from "./orderManager.js";
import {
  carryResidualForward,
  classifyResidualFlattenErrorMessage,
  classifyResidualOrder,
  dispositionForFailure,
  residualFailureIsInvariant,
  residualFailurePhrase,
  residualFlattenAttempt,
  residualFlattenAttemptId,
  FIRST_RESIDUAL_FLATTEN_ATTEMPT,
  MAX_RESIDUAL_FLATTEN_ATTEMPT_PROBE,
  type ResidualFlattenFailureKind,
  type ResidualFlattenPass,
} from "./residualFlatten.js";
import type { BoxConfig } from "./config.js";
import type {
  BoxEntryExecutionResult,
  BoxExitExecutionResult,
  BoxLeggingResult,
  BoxExecutionSimulator,
} from "./executionSimulator.js";
import { entrySideFor, exitSideFor, round2 } from "./math.js";
import { buildOrderPricing, touchPrice, walkDepth } from "./orderPricing.js";
import { outstandingRoles, type BoxOpenPosition } from "./positions.js";
import { singleLotCandidateViolation } from "./singleLotInvariant.js";
import type { BoxQuoteStore } from "./quotes.js";
import {
  BOX_LEG_ROLES,
  directionSign,
  type BoxCandidate,
  type BoxEntryDecision,
  type BoxEvaluation,
  type BoxExecutionFailureReason,
  type BoxLegEvaluation,
  type BoxLegRole,
  type BoxOptionInstrument,
  type IBoxOrderIntent,
  type OrderSide,
  type PaperLegExecution,
  type PaperLeggingExecutionRecord,
  type ResidualLegExposure,
} from "./types.js";

/** Narrow strategy-facing execution seam shared by scanner, monitor and recovery. */
export interface BoxExecutionGateway {
  readonly mode: BoxConfig["executionMode"];
  hasCapacity(): boolean;
  simulateEntry(args: Parameters<BoxExecutionSimulator["simulateEntry"]>[0]): Promise<BoxEntryExecutionResult>;
  simulateLeggingEntry(args: Parameters<BoxExecutionSimulator["simulateLeggingEntry"]>[0]): Promise<BoxLeggingResult>;
  simulateExit(args: Parameters<BoxExecutionSimulator["simulateExit"]>[0]): Promise<BoxExitExecutionResult>;
  simulateLeggingExit(args: Parameters<BoxExecutionSimulator["simulateLeggingExit"]>[0]): ReturnType<BoxExecutionSimulator["simulateLeggingExit"]>;
  estimateExecutableExit(position: BoxOpenPosition, now?: number): ReturnType<BoxExecutionSimulator["estimateExecutableExit"]>;
  flattenResidual(args: Parameters<BoxExecutionSimulator["flattenResidual"]>[0]): ReturnType<BoxExecutionSimulator["flattenResidual"]>;
  invariantViolation(reason: string): void;
}

/**
 * Re-check a gateway admission stamp against the newest book in the SAME socket
 * generation. A newer book may proceed only when it still executes the immutable
 * quantity within the immutable bounded LIMIT; generation changes always refuse.
 */
export function checkedFeedBlockReason(args: {
  request: BrokerOrderRequest;
  stamp: CheckedFeedStamp | undefined;
  currentGeneration: number;
  tokenCurrent: boolean;
  quote: ReturnType<BoxQuoteStore["get"]>;
  now: number;
  quoteMaxAgeMs: number;
  queueModel: BoxConfig["queueModel"];
  queueLiquidityHaircutPct: number;
}): string | null {
  const { request, stamp, quote } = args;
  if (!stamp) return "checked executable-feed evidence is missing";
  if (stamp.token !== request.token) return "checked executable-feed token does not match request";
  if (stamp.feed_generation !== args.currentGeneration) return "feed generation changed while order was queued";
  if (!args.tokenCurrent) return "token has no executable book in the current feed generation";
  if (!quote) return "current executable book is absent";
  if (!Number.isSafeInteger(stamp.quote_version) || quote.version < stamp.quote_version || quote.at < stamp.quote_at) {
    return "executable book identity regressed after bounded-depth admission";
  }
  const age = args.now - quote.at;
  if (!Number.isFinite(stamp.checked_at) || stamp.checked_at < stamp.quote_at || stamp.checked_at > args.now ||
      !Number.isFinite(age) || age < 0 || age > args.quoteMaxAgeMs) {
    return "checked executable book is stale or has invalid timing";
  }
  const walk = walkDepth({
    side: request.side,
    levels: request.side === "BUY" ? quote.asks : quote.bids,
    remainingQty: request.quantity,
    limitPrice: request.pricing.limit_price,
    queueModel: args.queueModel,
    haircutPct: args.queueLiquidityHaircutPct,
    at: quote.at,
    quoteVersion: quote.version,
  });
  return walk.executable_within_limit >= request.quantity
    ? null
    : "current executable book no longer covers bounded order quantity";
}

/**
 * Central execution facade. Paper modes delegate byte-for-byte to the existing
 * deterministic simulator; live mode emits bounded LIMIT intents through the
 * durable BoxOrderManager and trusts broker cumulative fills only.
 */
export class CentralBoxExecutionGateway implements BoxExecutionGateway {
  readonly mode: BoxConfig["executionMode"];
  /** The most recent per-Box capital decision, for status. Never a correctness input. */
  private lastCapitalReport: BoxCapitalReport | null = null;

  constructor(private readonly deps: {
    cfg: BoxConfig;
    simulator: BoxExecutionSimulator;
    quotes: BoxQuoteStore;
    manager?: BoxOrderManager;
    /** The active broker, for attributing a capital refusal. Diagnostics only. */
    broker?: () => string;
    /** Allocates the Mongo identity before any live intent is created. */
    allocateTradeId?: () => string;
    isTokenWarm?: (token: number) => boolean;
    /** Current socket generation, captured with each checked executable book. */
    feedGeneration?: () => number;
    now?: () => number;
    /**
     * Total charges (₹) for a set of orders, from the LOCAL fee calculator.
     *
     * Needed so LIVE residual flattening bills its own brokerage/taxes. Previously the live branch
     * returned a hard `flatten_charges: 0`, which meant the fees on real EMERGENCY_RESIDUAL orders
     * were never even estimated — a genuine cost silently absent from the trade's accounting.
     */
    chargeTotal?: (orders: { side: OrderSide; tradingsymbol: string; quantity: number; price: number }[]) => number;
  }) {
    this.mode = deps.cfg.executionMode;
  }

  hasCapacity(): boolean {
    if (this.mode !== "live") return this.deps.simulator.hasCapacity();
    if (!this.deps.manager) return false;
    const status = this.deps.manager.status();
    // One Box pipeline owns all queued role-orders. Counting only the currently
    // active role creates a micro-window between roles where a second candidate
    // can enter; require both the active slot and priority queue to be empty.
    return status.inFlight === 0 && status.queued === 0;
  }

  simulateEntry(args: Parameters<BoxExecutionSimulator["simulateEntry"]>[0]): Promise<BoxEntryExecutionResult> {
    return this.deps.simulator.simulateEntry(args);
  }

  async simulateLeggingEntry(args: Parameters<BoxExecutionSimulator["simulateLeggingEntry"]>[0]): Promise<BoxLeggingResult> {
    if (this.mode !== "live") return this.deps.simulator.simulateLeggingEntry(args);
    const manager = this.requireManager();
    const quantityViolation = singleLotCandidateViolation(args.candidate);
    if (quantityViolation) {
      manager.invariantViolation(`live entry ${args.candidate.key} violated single-lot invariant: ${quantityViolation}`);
      return liveEntryFailure(
        args.candidate,
        args.detection.at,
        this.now(),
        [],
        "insufficient_quantity",
        `single-lot entry invariant refused execution: ${quantityViolation}`,
        this.deps.cfg,
        null,
      );
    }
    const attemptId = stableAttemptId(args.candidate.key, args.detection.at, "ENTRY");
    const tradeId = this.deps.allocateTradeId?.();
    if (!tradeId) {
      manager.invariantViolation(`live entry ${attemptId} has no preallocated durable trade identity`);
      return liveEntryFailure(args.candidate, args.detection.at, this.now(), [], "legging_incomplete", "durable trade identity allocation failed; entry blocked", this.deps.cfg, null);
    }
    // ── CHECKPOINT 1 of 5: BEFORE BUILDING ANYTHING ──────────────────────────────────────
    //
    // `args.stillWanted` is the predicate the COORDINATOR composed: the caller's own condition
    // folded together with "do we still hold the reservation lease" (see
    // executionCoordinator.ownershipGuard). Until this fix the live path never called it — only
    // the paper simulator did — so a Box whose lease had been lost still POSTed all four legs.
    //
    // Cheapest possible refusal: no requests, no durable rows, no exposure.
    const submittedAt = this.now();
    const wantedAtBuild = this.entryGuardRefusal(args.stillWanted, "pre_build");
    if (wantedAtBuild) return this.refusedBeforeSubmit(args, submittedAt, tradeId, wantedAtBuild);

    const requests: BrokerOrderRequest[] = [];
    let checkedFeed = new Map<string, CheckedFeedStamp>();
    // HEDGE-FIRST TRANSPORT ORDER (see entrySubmissionOrder.ts). Requests are built — and
    // therefore enqueued, and therefore POSTed — BUY hedges first. Under the canonical role order
    // a SHORT_BOX sent its naked SELL first and hedged it second; this makes that impossible.
    // Role identities, sides, quantities and the four-leg economics are untouched: only the
    // sequence changes, and every downstream figure is keyed by role, never by position.
    const submissionOrder = entrySubmissionOrder(args.candidate.direction);
    const hedgeCount = submissionOrder.filter((slot) => slot.hedge).length;
    try {
      for (const slot of submissionOrder) {
        const leg = args.detection.legs.find((item) => item.role === slot.role);
        if (!leg || leg.price === null) throw new Error(`No executable reference price for ${slot.role}.`);
        requests.push(this.request({
          role: slot.role,
          inst: args.candidate.legs[slot.role],
          side: entrySideFor(slot.role, args.candidate.direction),
          quantity: args.candidate.lot_size,
          referencePrice: leg.price,
          tradeId,
          attemptId,
          purpose: "ENTRY",
          phase: "entry",
        }));
      }
      checkedFeed = this.precheck(requests);
    } catch (error) {
      return liveEntryFailure(args.candidate, args.detection.at, submittedAt, [], "insufficient_quantity", errorMessage(error), this.deps.cfg, tradeId);
    }

    // ── MAXIMUM ₹ PER BOX: the authoritative pre-trade gate ────────────────────────────────
    //
    // Evaluated HERE, from the four IMMUTABLE bounded LIMIT requests that would be
    // transmitted, and BEFORE the first `manager.submit`. Two properties matter:
    //
    //   1. It uses the actual order LIMIT prices, never an LTP or a mid. A cap checked against
    //      a stale last-traded price is not a cap on what the orders can transact.
    //   2. Nothing has reached the broker yet, so a refusal here is a genuine PRE-TRADE
    //      refusal with no exposure to unwind.
    //
    // A quantity/price change between detection and here is therefore already accounted for:
    // the requests were rebuilt from the current book a few lines above.
    const capital = this.evaluateEntryCapital(requests, args.candidate, "pre_submit");
    this.lastCapitalReport = capital;
    if (!capital.allowed) {
      return liveEntryFailure(
        args.candidate,
        args.detection.at,
        submittedAt,
        [],
        "box_capital_limit",
        capital.detail ?? "per-Box capital limit refused entry",
        this.deps.cfg,
        tradeId,
      );
    }

    // The Box-level decision is stamped onto every leg so the manager can RE-VERIFY it at
    // dequeue, the last safe moment before a broker mutation. A per-leg check could not: the
    // cap is a property of the whole four-leg set, which no single leg can see.
    const capitalStamp: EntryCapitalStamp = {
      candidate_key: args.candidate.key,
      box_notional_paise: capital.metrics.gross_entry_order_notional_paise,
      configured_max_rupees: capital.configured_max_rupees,
      checked_at: capital.at,
    };

    // ── CHECKPOINT 2 of 5: IMMEDIATELY BEFORE ENQUEUE ────────────────────────────────────
    // Everything above — building four requests, the depth precheck, the capital evaluation — took
    // real time. Still nothing has been transmitted, so this remains a free refusal.
    const wantedAtEnqueue = this.entryGuardRefusal(args.stillWanted, "pre_enqueue");
    if (wantedAtEnqueue) return this.refusedBeforeSubmit(args, submittedAt, tradeId, wantedAtEnqueue);

    // The guard travels WITH each leg, alongside its hedge-first rank, so the manager can
    // re-evaluate it at dequeue, after durable persistence, and at the final pre-POST boundary.
    // It is passed for ENTRY legs ONLY; exits and reductions never receive one and so can never be
    // refused by it.
    const rankByRole = new Map(submissionOrder.map((slot) => [slot.role, slot]));
    const settled = await Promise.allSettled(
      requests.map((request) => {
        const slot = rankByRole.get(request.role);
        return manager.submit(request, checkedFeed.get(request.client_order_id), capitalStamp, {
          stillWanted: () => (args.stillWanted ? args.stillWanted() : true),
          transportRank: slot?.rank ?? 0,
          hedge: slot?.hedge ?? false,
          hedgeCount,
        });
      }),
    );
    // Canonical role order for OUTPUT/accounting; the POSTs above were hedge-first.
    const orders = canonicalRoleOrder(ordersFromSettled(settled));
    const uncertain = settled.some((item) => item.status === "rejected" &&
      (item.reason instanceof OrderPersistenceAfterFillError ||
        /unknown|ambiguous|reconcil/i.test(errorMessage(item.reason)))) ||
      orders.some((order) => order.state === "UNKNOWN" || order.state === "RECONCILIATION_REQUIRED");
    if (uncertain) {
      manager.invariantViolation(`live entry ${attemptId} has uncertain broker terminal quantity`);
      return liveEntryFailure(args.candidate, args.detection.at, submittedAt, orders, "legging_incomplete", "broker terminal quantity is uncertain; entry quarantined", this.deps.cfg, tradeId);
    }

    // `>=`, not `===`. A broker reporting MORE filled than requested is an anomaly, but it is an
    // anomaly in which the four-leg box is unambiguously ON — the requested quantity is covered.
    // Under `===` an overfill read as "not fully filled" and sent a complete, hedged box straight
    // into a four-leg protective unwind, paying a full round trip plus charges to reverse a
    // position that was actually correct. Overfill is detected and quarantined by the cumulative
    // fill ledger, which is where that belongs; it must not also be mistaken for underfill here.
    const fullyFilled =
      orders.length === requests.length && orders.every((order) => order.filled_quantity >= order.quantity);
    if (!fullyFilled) {
      // ── PARTIAL ENTRY: the explicit, ordered recovery sequence ───────────────────────
      //
      // The RULE is unchanged: if all four legs did not reach their requested quantity there is
      // no valid Box, and the trade record is never opened as one. What is new is that the
      // recovery is now DECIDED by a pure, testable plan rather than implied by control flow.
      //
      // Steps 1-3 of the sequence are already guaranteed upstream and are asserted here rather
      // than re-implemented: `adapter.submitOrder` polls to a terminal state (protectively
      // cancelling on timeout), and the `uncertain` check above has already quarantined anything
      // whose terminal quantity is unprovable. So every order in hand is terminal with a
      // broker-confirmed cumulative quantity, which is the only basis on which an unwind may be
      // sized — a cancel can race a fill, so a pre-terminal snapshot would strand the raced part.
      const plan = planPartialEntryRecovery({
        legs: entryLegOutcomes(requests, orders),
        expectedRoles: BOX_LEG_ROLES,
      });

      // DEFENCE IN DEPTH. Unreachable given the guarantees above, but if a future change ever
      // lets a non-terminal or unprovable leg reach here, quarantine — never unwind. Unwinding an
      // unproven quantity would create opposite naked exposure, which is strictly worse than the
      // exposure it was trying to remove.
      if (plan.action === "quarantine_unknown" || plan.action === "await_terminal") {
        manager.invariantViolation(
          `live entry ${attemptId} reached partial-entry recovery with a non-terminal or unprovable leg ` +
            `(${plan.action}); quarantined instead of unwinding`,
        );
        const quarantined = liveEntryFailure(args.candidate, args.detection.at, submittedAt, orders, "legging_incomplete", `entry quarantined: ${plan.detail}`, this.deps.cfg, tradeId);
        quarantined.legging.outcome_class = "QUARANTINED_UNKNOWN";
        return quarantined;
      }

      // Steps 4-6: unwind EXACTLY the confirmed exposure, per role, at the reversed side. Skipped
      // entirely when nothing filled — there is no exposure, so there is nothing to reverse and
      // no charges to pay.
      const unwindOrders = plan.action === "no_exposure"
        ? []
        : await this.unwindConfirmed(orders, args.candidate.legs, tradeId, `${attemptId}:unwind`);

      // Steps 7-8: whatever the unwind did not cover becomes durable residual exposure, which the
      // flatten loop works and which blocks new entry under the existing rules.
      const residual = residualAfterUnwind(orders, unwindOrders);
      this.verifyEntryConservation(plan, orders, unwindOrders, attemptId, "partial_entry");

      const failed = liveEntryFailure(args.candidate, args.detection.at, submittedAt, orders, "legging_incomplete", plan.action === "no_exposure" ? "entry did not fill; no exposure to unwind" : "entry incomplete; confirmed fills were protectively unwound", this.deps.cfg, tradeId, residual, unwindOrders);
      failed.legging.outcome_class = plan.action === "no_exposure"
        ? "NO_FILL"
        : residual.length > 0
          ? "PARTIAL_ENTRY_RESIDUAL"
          : "PARTIAL_ENTRY_UNWOUND";
      return failed;
    }

    const evaluation = evaluationFromFills(args.detection, orders);
    const measured = slippageFromFills(args.detection.legs, orders);
    const decision = args.qualify(evaluation, measured);
    if (!decision.qualifies) {
      // ── 4/4 FILLED, THEN ECONOMICS FAILED ────────────────────────────────────────────
      //
      // A complete hedged Box genuinely existed. There was no legging RISK, but there IS a real
      // cost: the round-trip spread and charges on all four legs. Reversed immediately, and
      // labelled distinctly so it is never rendered as an ordinary rejected candidate.
      const unwindOrders = await this.unwindConfirmed(orders, args.candidate.legs, tradeId, `${attemptId}:economics-unwind`);
      const residual = residualAfterUnwind(orders, unwindOrders);
      this.verifyEntryConservation(
        planPartialEntryRecovery({ legs: entryLegOutcomes(requests, orders), expectedRoles: BOX_LEG_ROLES }),
        orders,
        unwindOrders,
        attemptId,
        "economics_abort",
      );
      const failed = liveEntryFailure(args.candidate, args.detection.at, submittedAt, orders, "abort_after_fill", "executed prices failed final economics; confirmed box was unwound", this.deps.cfg, tradeId, residual, unwindOrders);
      failed.legging.abort_after_fill = true;
      failed.legging.outcome_class = "FILLED_THEN_ECONOMICS_ABORT";
      failed.legging.final_expected_net_profit = decision.expected_net_profit;
      failed.legging.required_expected_net_profit = decision.min_expected_net_profit;
      return failed;
    }

    const opened = liveRecord(args.detection.at, submittedAt, orders, true, this.deps.cfg, undefined, tradeId);
    opened.outcome_class = "OPENED";
    return { ok: true, evaluation, decision, legging: opened };
  }

  /**
   * The composed entry-guard refusal reason at a gateway-side checkpoint, or null to proceed.
   *
   * The gateway can only see `stillWanted` — the manager owns entry arming, the breaker and full
   * admission — so it supplies `true` for the facts it cannot observe and lets the manager assert
   * them at its own three checkpoints. The DECISION itself still comes from the one pure function,
   * so the reason text is identical wherever the refusal is taken.
   */
  private entryGuardRefusal(
    stillWanted: (() => boolean) | undefined,
    stage: "pre_build" | "pre_enqueue",
  ): string | null {
    const decision = evaluateLiveEntryGuard({
      stage,
      stillWanted: stillWantedSafely(stillWanted),
      entryEnabled: true,
      liveOrderEntryEnabled: true,
      circuitClosed: true,
      entryAdmissible: true,
      attemptAborted: null,
      hedgeFailure: null,
    });
    return decision.allowed ? null : decision.reason;
  }

  /**
   * A proven ZERO-POST entry refusal taken before the manager was ever called.
   *
   * `REFUSED_BEFORE_SUBMIT` is the existing outcome class for exactly this: nothing reached the
   * broker, so there is no exposure, no charge and nothing to unwind. It is emphatically NOT a
   * broker rejection and NOT ambiguous — no durable intent was even created, because the refusal
   * happened before the first `manager.submit`.
   */
  private refusedBeforeSubmit(
    args: Parameters<BoxExecutionSimulator["simulateLeggingEntry"]>[0],
    submittedAt: number,
    tradeId: string | null,
    detail: string,
  ): Extract<BoxLeggingResult, { ok: false }> {
    const refused = liveEntryFailure(
      args.candidate,
      args.detection.at,
      submittedAt,
      [],
      "discovery_stopped",
      detail,
      this.deps.cfg,
      tradeId,
    );
    refused.legging.outcome_class = "REFUSED_BEFORE_SUBMIT";
    return refused;
  }

  /**
   * Assert EXACT per-role quantity conservation across an entry and its unwind.
   *
   * THE INVARIANT: for every role, `residual = confirmed_entry_fill - confirmed_unwind_fill`, and
   * that residual is never negative. A negative residual means we sold something we never bought
   * — brand-new naked exposure created by the very code meant to remove some. An overfill means
   * broker truth has proven our quantity model wrong, so every downstream exposure number is
   * suspect.
   *
   * Either way the response is RECOVERY, not a clamp and a shrug: `invariantViolation` sets
   * `recoveryActive`, trips the breaker and kicks reconciliation. Verification itself never
   * throws, because a bookkeeping check must not be able to abort a recovery already in progress.
   */
  private verifyEntryConservation(
    plan: PartialEntryPlan,
    entryOrders: BrokerOrder[],
    unwindOrders: BrokerOrder[],
    attemptId: string,
    phase: "partial_entry" | "economics_abort",
  ): void {
    const violation = this.conservationViolation(plan, entryOrders, unwindOrders, attemptId, phase);
    // RAISED OUTSIDE the guarded block. Wrapping the reporting call in the same try/catch as the
    // arithmetic meant a throw from `invariantViolation` — the very thing that triggers RECOVERY —
    // silently discarded the violation it was reporting.
    if (violation !== null) this.deps.manager?.invariantViolation(violation);
  }

  /** The conservation failure message, or null when exact conservation holds. Never throws. */
  private conservationViolation(
    plan: PartialEntryPlan,
    entryOrders: BrokerOrder[],
    unwindOrders: BrokerOrder[],
    attemptId: string,
    phase: "partial_entry" | "economics_abort",
  ): string | null {
    try {
      const unwoundByRole: Partial<Record<BoxLegRole, number>> = {};
      for (const order of unwindOrders) {
        unwoundByRole[order.role] = (unwoundByRole[order.role] ?? 0) + order.filled_quantity;
      }
      const result = verifyQuantityConservation({
        entry: entryOrders.map((order) => ({
          role: order.role,
          side: order.side,
          requested: order.quantity,
          confirmedFilled: order.filled_quantity,
          terminal: true,
          submitted: true,
          brokerStateKnown: true,
        })),
        unwoundByRole,
      });
      if (result.conserved) return null;
      return (
        `live entry ${attemptId} (${phase}) violated quantity conservation: ` +
        result.violations
          .map((violation) => `${violation.role}:${violation.kind}(${violation.detail})`)
          .join("; ") +
        `. Planned unwind was ${plan.unwind.length} leg(s).`
      );
    } catch {
      // Only the ARITHMETIC is guarded. A throw here means the check itself failed, which must not
      // abort the recovery in progress — but it must also not be silently indistinguishable from
      // "conserved", so it is reported as its own violation below.
      return `live entry ${attemptId} (${phase}) quantity-conservation check itself failed`;
    }
  }

  simulateExit(args: Parameters<BoxExecutionSimulator["simulateExit"]>[0]): Promise<BoxExitExecutionResult> {
    return this.deps.simulator.simulateExit(args);
  }

  async simulateLeggingExit(args: Parameters<BoxExecutionSimulator["simulateLeggingExit"]>[0]): ReturnType<BoxExecutionSimulator["simulateLeggingExit"]> {
    if (this.mode !== "live") return this.deps.simulator.simulateLeggingExit(args);
    const manager = this.requireManager();
    const attemptId = stableAttemptId(args.position.id, args.detectedAt, "EXIT");
    const detByRole = new Map(args.detectionLegs.map((leg) => [leg.role, leg]));
    const requests = outstandingRoles(args.position).map(({ role, quantity }) => this.request({
      role,
      inst: args.position.legs[role],
      side: exitSideFor(role, args.position.direction ?? "LONG_BOX"),
      quantity,
      referencePrice: detByRole.get(role)?.price ?? 0,
      tradeId: args.position.id,
      attemptId,
      purpose: "EXIT",
      phase: "exit",
    }));
    if (requests.length === 0) {
      const record = liveRecord(args.detectedAt, this.now(), [], false, this.deps.cfg, undefined, args.position.id);
      return { ok: false, record, reason: "legging_incomplete", detail: "position already flat" };
    }
    let checkedFeed: Map<string, CheckedFeedStamp>;
    try {
      checkedFeed = this.precheck(requests);
    } catch (error) {
      const record = liveRecord(args.detectedAt, this.now(), [], false, this.deps.cfg, requests.length, args.position.id);
      return { ok: false, record, reason: "insufficient_quantity", detail: errorMessage(error) };
    }
    const settled = await Promise.allSettled(
      requests.map((request) => manager.submit(request, checkedFeed.get(request.client_order_id))),
    );
    const orders = ordersFromSettled(settled);
    const uncertain = settled.some((item) => item.status === "rejected" &&
      !(item.reason instanceof BrokerPreSubmitRefusedError)) ||
      orders.some((order) => order.state === "UNKNOWN" || order.state === "RECONCILIATION_REQUIRED");
    if (uncertain) manager.invariantViolation(`live exit ${attemptId} has uncertain broker terminal quantity`);
    const record = liveRecord(args.detectedAt, this.now(), orders, false, this.deps.cfg, requests.length, args.position.id);
    const legs = legsFromOrders(orders, args.position.legs, this.deps.quotes, this.now());
    // `>=` for the same reason as the entry path: the requested exit quantity is covered, so the
    // close is complete. Reading an overfilled exit as incomplete would leave the monitor believing
    // roles are still outstanding and re-submitting closes against already-flat legs.
    const clean =
      !uncertain && orders.length === requests.length && orders.every((order) => order.filled_quantity >= order.quantity);
    if (clean) return { ok: true, legs, record, booksAtFill: new Map() };
    return {
      ok: false,
      record,
      reason: "legging_incomplete",
      detail: uncertain ? "exit terminal quantity uncertain; position moved to recovery" : "live exit partially filled",
      legs,
      booksAtFill: new Map(),
    };
  }

  estimateExecutableExit(position: BoxOpenPosition, now?: number): ReturnType<BoxExecutionSimulator["estimateExecutableExit"]> {
    return this.deps.simulator.estimateExecutableExit(position, now);
  }

  /**
   * LIVE RESIDUAL FLATTENING — a genuine retry loop.
   *
   * Every logically new attempt on still-outstanding quantity gets a NEW durable identity
   * (`…:attempt-N`); a retry or reconciliation of the SAME broker submission keeps the old one.
   * See `residualFlatten.ts` for the state machine and the crash-safety argument.
   *
   * Nothing here is allowed to swallow an error. Each leg's outcome is classified into a fixed
   * disposition that decides ONE thing: may the next pass reuse this identity? A terminal
   * durable outcome spends it only when the broker is terminal or a local guard proves no POST.
   */
  async flattenResidual(args: Parameters<BoxExecutionSimulator["flattenResidual"]>[0]): ReturnType<BoxExecutionSimulator["flattenResidual"]> {
    if (this.mode !== "live") return this.deps.simulator.flattenResidual(args);
    const manager = this.requireManager();
    const passes: ResidualFlattenPass[] = [];
    for (const residual of args.residual) {
      passes.push(await this.flattenOneResidual(manager, args.keyPrefix, residual));
    }

    const orders: BrokerOrder[] = [];
    const flattened: Partial<Record<BoxLegRole, number>> = {};
    const remaining: ResidualLegExposure[] = [];
    let flattenCharges = 0;
    for (const pass of passes) {
      // Attribute the order to the residual that produced it. Matching by role was wrong the
      // moment two residual entries shared a role: the second silently inherited the first's
      // fill and its own exposure vanished from the books.
      if (pass.order) orders.push(pass.order);

      const sameGeneration = pass.attempt === residualFlattenAttempt(pass.residual);
      const rawFilledWatermark = sameGeneration ? pass.residual.flatten_accounted_filled : undefined;
      const rawChargeWatermark = sameGeneration ? pass.residual.flatten_accounted_charges : undefined;
      const legacyWatermarks = rawFilledWatermark === undefined && rawChargeWatermark === undefined;
      const watermarksValid = legacyWatermarks || (
        typeof rawFilledWatermark === "number" && Number.isFinite(rawFilledWatermark) && rawFilledWatermark >= 0 &&
        typeof rawChargeWatermark === "number" && Number.isFinite(rawChargeWatermark) && rawChargeWatermark >= 0
      );
      let accountedFilled = watermarksValid && !legacyWatermarks ? rawFilledWatermark! : 0;
      let accountedCharges = watermarksValid && !legacyWatermarks ? round2(rawChargeWatermark!) : 0;
      let disposition = pass.disposition;
      let fillDelta = 0;
      let chargeDelta = 0;
      // `undefined` means "this pass observed no broker order", so the residual keeps whatever it
      // already carried — including ABSENT on a pre-watermark row, whose already-projected fill can
      // only ever be derived from a durable intent snapshot.
      let cumulativeFilled: number | undefined = watermarksValid && !legacyWatermarks ? accountedFilled : undefined;
      let cumulativeCharges: number | undefined = watermarksValid && !legacyWatermarks ? accountedCharges : undefined;

      if (!watermarksValid) {
        manager.invariantViolation(
          `residual ${args.keyPrefix} ${pass.residual.role} attempt-${pass.attempt} has inconsistent cumulative accounting watermarks`,
        );
        disposition = "adopt_attempt";
        // Normalise the pair so the identity stops being ambiguous next pass instead of tripping the
        // invariant forever: keep the highest readable fill watermark (never re-credit it) and read
        // an unreadable one as zero, exactly as before this accounting existed.
        cumulativeFilled = typeof rawFilledWatermark === "number" && Number.isFinite(rawFilledWatermark) &&
          rawFilledWatermark > 0 ? rawFilledWatermark : 0;
        cumulativeCharges = typeof rawChargeWatermark === "number" && Number.isFinite(rawChargeWatermark) &&
          rawChargeWatermark > 0 ? round2(rawChargeWatermark) : 0;
      } else if (pass.order) {
        const brokerFilled = pass.order.filled_quantity;
        if (legacyWatermarks) {
          // A residual persisted before cumulative watermarks existed carries no accounting at all.
          // Reading that as "nothing projected yet" replays the partial fill this identity ALREADY
          // credited and re-bills its fee on the first post-upgrade terminal pass, understating the
          // exposure that is still naked. `order.quantity` is immutable on the durable intent and
          // equals the residual quantity at the moment this identity was created, so the difference
          // is exactly what was already projected under it — and 0 for a genuinely fresh residual.
          // Clamped: a snapshot whose quantity is somehow below the residual must never manufacture
          // a negative watermark (which would re-credit even more than defaulting to zero).
          accountedFilled = Math.max(0, pass.order.quantity - pass.residual.quantity);
          accountedCharges = this.residualCumulativeCharges(pass.order, accountedFilled, 0);
        }
        const brokerCumulativeCharges = this.residualCumulativeCharges(pass.order, brokerFilled, accountedCharges);
        // Only the FILL stream is a trustworthiness test. The charge figure is re-estimated from
        // the current rate card on every pass rather than recorded, so it can legitimately fall
        // (rate-card version change, corrected average price) while the fill is unchanged. Treating
        // that as corruption forced `adopt_attempt` on every later pass, so the residual could
        // never retire or flatten and every interval tripped the invariant/breaker — a permanently
        // stranded naked leg. Real turnover is monotonic, so this branch catches nothing the fill
        // check does not; a cheaper estimate is absorbed by the zero-clamp on `chargeDelta` below.
        const regression = !Number.isFinite(brokerFilled) || brokerFilled < accountedFilled ||
          brokerFilled < 0 || brokerFilled > pass.order.quantity;
        const candidateFillDelta = regression ? 0 : brokerFilled - accountedFilled;
        if (regression || candidateFillDelta > pass.residual.quantity) {
          manager.invariantViolation(
            `residual ${args.keyPrefix} ${pass.residual.role} attempt-${pass.attempt} cumulative accounting regressed or exceeded exposure ` +
              `(fill ${accountedFilled} -> ${brokerFilled}, charge ${accountedCharges} -> ${brokerCumulativeCharges}, residual ${pass.residual.quantity})`,
          );
          // Quarantine this identity. Never turn a negative/regressed cumulative snapshot into a
          // fill and never retire past an identity whose accounting cannot be trusted. The
          // watermarks are still persisted so the quarantined identity stops being ambiguous.
          disposition = "adopt_attempt";
          cumulativeFilled = accountedFilled;
          cumulativeCharges = accountedCharges;
        } else {
          fillDelta = candidateFillDelta;
          chargeDelta = round2(Math.max(0, brokerCumulativeCharges - accountedCharges));
          cumulativeFilled = brokerFilled;
          // Keep the charge watermark monotonic: a cheaper re-estimate must not lower the bar and
          // let the next pass bill the same turnover again when the estimate recovers.
          cumulativeCharges = Math.max(accountedCharges, brokerCumulativeCharges);
        }
      }

      flattened[pass.residual.role] = (flattened[pass.residual.role] ?? 0) + fillDelta;
      flattenCharges = round2(flattenCharges + chargeDelta);
      const outstanding = pass.residual.quantity - fillDelta;
      if (outstanding > 0) {
        remaining.push(carryResidualForward(
          pass.residual,
          outstanding,
          pass.attempt,
          disposition,
          { cumulativeFilled, cumulativeCharges },
        ));
      }
    }

    return {
      flattened_by_role: flattened,
      flatten_charges: flattenCharges,
      remaining,
      legs: orders.map((order) => paperLeg(order)),
    };
  }

  /**
   * Cumulative charge for one cumulative filled quantity on one durable identity.
   *
   * The SAME estimator is used for a legacy-derived watermark and for the current snapshot, so a
   * derived watermark and the figure it is compared against cannot disagree by construction — an
   * unchanged cumulative fill therefore bills exactly zero. `fallback` is what an unpriceable or
   * zero-fill snapshot means: no charge information, so the existing watermark stands.
   */
  private residualCumulativeCharges(order: BrokerOrder, filled: number, fallback: number): number {
    if (!(filled > 0) || order.average_price === null) return fallback;
    return round2(this.deps.chargeTotal?.([{
      side: order.side,
      tradingsymbol: order.tradingsymbol,
      quantity: filled,
      price: order.average_price,
    }]) ?? 0);
  }

  /**
   * One residual leg, one flatten attempt.
   *
   * The generation comes from the residual itself when it has one (the runtime loop persists it),
   * and otherwise from the DURABLE intent journal — never from an in-memory counter, a clock or a
   * random value. Crash-recovery exposure derived from the journal has no persisted generation,
   * so the journal itself is probed for the first identity that is absent or still adoptable.
   */
  private async flattenOneResidual(
    manager: BoxOrderManager,
    keyPrefix: string,
    residual: ResidualLegExposure,
  ): Promise<ResidualFlattenPass> {
    const base = stableAttemptId(keyPrefix, residual.created_at, `RESIDUAL-${residual.role}`);
    const selected = await this.firstAdoptableResidualAttempt(
      manager,
      keyPrefix,
      residual,
      base,
      residualFlattenAttempt(residual),
    );
    const attempt = selected.attempt;

    const fail = (kind: ResidualFlattenFailureKind, detail: string, order: BrokerOrder | null = null): ResidualFlattenPass => {
      if (residualFailureIsInvariant(kind)) {
        manager.invariantViolation(
          `residual ${keyPrefix} ${residual.role} attempt-${attempt} [${kind}]: ` +
            `${residualFailurePhrase(kind)} — ${detail}`,
        );
      }
      return { residual, attempt, order, disposition: dispositionForFailure(kind), failure: kind, detail };
    };

    if (selected.terminalIntent) {
      const order = brokerOrderFromDurableIntent(selected.terminalIntent);
      if (order.state === "REJECTED") {
        return fail("broker_rejected", order.reject_reason ?? "durable broker rejection", order);
      }
      const disposition = classifyResidualOrder(order, residual.quantity);
      return { residual, attempt, order, disposition, failure: null, detail: null };
    }

    const side: OrderSide = residual.side === "BUY" ? "SELL" : "BUY";
    const quote = this.deps.quotes.get(residual.token);
    const reference = quote ? touchPrice(side, quote.bids, quote.asks) : null;
    const enforceCurrentGeneration = this.deps.isTokenWarm !== undefined;
    if (!reference || (this.deps.isTokenWarm && !this.deps.isTokenWarm(residual.token)) ||
        !quote || (enforceCurrentGeneration && this.now() - quote.at > this.deps.cfg.quoteMaxAgeMs)) {
      // Nothing was sent, so the identity is still unused and MUST be reused next pass.
      return fail("no_executable_book", `no current executable ${side} touch for ${residual.tradingsymbol}`);
    }

    const inst: BoxOptionInstrument = {
      token: residual.token,
      tradingsymbol: residual.tradingsymbol,
      exchange: residual.exchange ?? "NFO",
      strike: 0,
      instrument_type: residual.role.endsWith("_ce") ? "CE" : "PE",
      expiry: "",
      lot_size: residual.quantity,
    };

    try {
      const request = this.request({
        role: residual.role,
        inst,
        side,
        quantity: residual.quantity,
        referencePrice: reference,
        tradeId: keyPrefix,
        attemptId: residualFlattenAttemptId(base, attempt),
        purpose: "EMERGENCY_RESIDUAL",
        phase: "unwind",
      });
      // Residual reduction bypasses entry discovery/warmup, but never bounded
      // quantity, freshness, relevant-side depth, or generation checks.
      let checkedFeed: Map<string, CheckedFeedStamp>;
      try {
        checkedFeed = this.precheck([request]);
      } catch (error) {
        return fail("no_executable_book", errorMessage(error));
      }
      const order = await manager.submit(request, checkedFeed.get(request.client_order_id));
      const disposition = classifyResidualOrder(order, residual.quantity);
      if (disposition === "adopt_attempt") {
        // A working or unknown order still owns this identity. Keep it and reconcile.
        return fail("broker_state_unknown", `order state ${order.state} is not terminal`, order);
      }
      return { residual, attempt, order, disposition, failure: null, detail: null };
    } catch (error) {
      // The broker owns a fill we could not record. Broker truth wins: carry the snapshot so the
      // quantity is credited, and trip the invariant.
      if (error instanceof OrderPersistenceAfterFillError) {
        return fail("persistence_after_fill", errorMessage(error), error.order);
      }
      // A durable local refusal proves no broker POST and terminally spends this
      // identity, so the still-outstanding quantity must advance to attempt N+1.
      if (error instanceof BrokerPreSubmitRefusedError) {
        return fail("local_pre_submit_refused", errorMessage(error));
      }
      // A KNOWN broker refusal. It is terminal broker truth, but policy retains this durable
      // identity rather than manufacturing a fresh reduction order automatically.
      if (error instanceof BrokerOrderRejectedError) {
        return fail("broker_rejected", errorMessage(error), error.order);
      }
      // An ambiguous submission may or may not exist at the broker. NEVER resubmit it under a
      // new identity; keep this one so the durable journal adopts whatever is really there.
      if (error instanceof BrokerAmbiguousSubmitError) {
        return fail("broker_state_unknown", errorMessage(error), error.order ?? null);
      }
      return fail(classifyResidualFlattenErrorMessage(errorMessage(error)), errorMessage(error));
    }
  }

  /**
   * First flatten generation whose durable intent is absent or still adoptable.
   *
   * Every residual is reconciled, including one that already persisted a generation. This repairs
   * the crash window where a local no-POST refusal committed REJECTED but generation N+1 did not.
   * Only an unambiguous structured local-no-POST rejection with zero fill and no broker order is
   * advanced here. Broker rejection and every working/ambiguous state retain their identity.
   */
  private async firstAdoptableResidualAttempt(
    manager: BoxOrderManager,
    keyPrefix: string,
    residual: ResidualLegExposure,
    base: string,
    firstAttempt = FIRST_RESIDUAL_FLATTEN_ATTEMPT,
  ): Promise<{ attempt: number; terminalIntent: IBoxOrderIntent | null }> {
    const probe = manager.findDurableIntent?.bind(manager);
    if (!probe) return { attempt: firstAttempt, terminalIntent: null };
    const lastAttempt = firstAttempt + MAX_RESIDUAL_FLATTEN_ATTEMPT_PROBE - 1;
    for (let attempt = firstAttempt; attempt <= lastAttempt; attempt++) {
      const clientOrderId = boxClientOrderId({
        tradeId: keyPrefix,
        purpose: "EMERGENCY_RESIDUAL",
        role: residual.role,
        attempt: residualFlattenAttemptId(base, attempt),
      });
      let existing: Awaited<ReturnType<NonNullable<BoxOrderManager["findDurableIntent"]>>>;
      try {
        existing = await probe(clientOrderId);
      } catch {
        // The journal is unreadable. Reusing the current identity is the safe answer: the upsert
        // adopts an existing submission and only POSTs when the intent is still CREATED.
        return { attempt, terminalIntent: null };
      }
      if (!existing) return { attempt, terminalIntent: null };
      if (existing.state === "REJECTED") {
        if (hasDurableLocalNoPostProvenance(existing)) continue;
        return { attempt, terminalIntent: existing };
      }
      // COMPLETE/CANCELLED broker truth is projected directly from the durable snapshot before
      // any later generation is allowed to POST. Working and ambiguous states retain the identity
      // and flow through OrderManager reconciliation. Only proven local no-POST refusal is skipped.
      if (existing.state === "COMPLETE" || existing.state === "CANCELLED") {
        return { attempt, terminalIntent: existing };
      }
      return { attempt, terminalIntent: null };
    }
    return { attempt: lastAttempt + 1, terminalIntent: null };
  }

  invariantViolation(reason: string): void {
    this.deps.manager?.invariantViolation(reason);
  }

  private request(args: {
    role: BoxLegRole;
    inst: BoxOptionInstrument;
    side: OrderSide;
    quantity: number;
    referencePrice: number;
    tradeId: string;
    attemptId: string;
    purpose: "ENTRY" | "EXIT" | "EMERGENCY_RESIDUAL";
    phase: "entry" | "exit" | "unwind";
  }): BrokerOrderRequest {
    const pricing = buildOrderPricing({
      side: args.side,
      quantity: args.quantity,
      referencePrice: args.referencePrice,
      tickSize: args.inst.tick_size ?? this.deps.cfg.defaultTickSize,
      maxChaseTicks: Math.min(this.deps.cfg.liveMaxChaseTicks, args.phase === "unwind" ? this.deps.cfg.unwindMaxChaseTicks : this.deps.cfg.legMaxChaseTicks),
    });
    return {
      client_order_id: boxClientOrderId({ tradeId: args.tradeId, purpose: args.purpose, role: args.role, attempt: args.attemptId }),
      role: args.role,
      trade_id: args.tradeId,
      attempt_id: args.attemptId,
      purpose: args.purpose,
      phase: args.phase,
      exchange: args.inst.exchange,
      tradingsymbol: args.inst.tradingsymbol,
      token: args.inst.token,
      side: args.side,
      quantity: args.quantity,
      pricing: {
        order_type: "LIMIT",
        reference_price: pricing.reference_price,
        tick_size: pricing.tick_size,
        max_chase_ticks: pricing.max_chase_ticks,
        limit_price: pricing.limit_price,
      },
    };
  }

  /**
   * The per-Box ₹ cap in force for the CURRENT execution mode.
   *
   * LIVE is the authoritative safety gate. Paper has its own optional mirror so a
   * `live_parity` run can exercise the identical admission arithmetic without a real account;
   * a paper cap can never relax the live one because they are different config keys and only
   * the live one is consulted in live mode.
   */
  private capitalLimitRupees(): number {
    return this.mode === "live"
      ? this.deps.cfg.liveMaxBoxCapitalRupees
      : this.deps.cfg.paperMaxBoxCapitalRupees;
  }

  /** Compute and judge the gross entry-order notional for a built request set. */
  private evaluateEntryCapital(
    requests: readonly BrokerOrderRequest[],
    candidate: BoxCandidate,
    stage: BoxCapitalReport["stage"],
  ): BoxCapitalReport {
    return evaluateBoxCapitalAdmission({
      metrics: grossEntryOrderNotional(requests, BOX_LEG_ROLES.length),
      limitRupees: this.capitalLimitRupees(),
      broker: this.deps.broker?.() ?? "unknown",
      candidateKey: candidate.key,
      at: this.now(),
      stage,
    });
  }

  /** The last capital decision, for status/diagnostics. Bounded, low-cardinality. */
  capitalDiagnostics(): ReturnType<typeof boxCapitalSummary> & { limit_source: "live" | "paper" } {
    return {
      ...boxCapitalSummary(this.lastCapitalReport),
      limit_source: this.mode === "live" ? "live" : "paper",
    };
  }

  private precheck(requests: BrokerOrderRequest[]): Map<string, CheckedFeedStamp> {
    const checked = new Map<string, CheckedFeedStamp>();
    const checkedAt = this.now();
    const feedGeneration = this.deps.feedGeneration?.() ?? 0;
    for (const request of requests) {
      if (this.mode === "live" && this.deps.isTokenWarm && !this.deps.isTokenWarm(request.token)) {
        throw new Error(`${request.tradingsymbol} has not received a WebSocket tick in the current feed generation.`);
      }
      const quote = this.deps.quotes.get(request.token);
      if (!quote) throw new Error(`${request.tradingsymbol} has no live depth.`);
      const age = checkedAt - quote.at;
      if (this.deps.isTokenWarm && (!Number.isFinite(age) || age < 0 || age > this.deps.cfg.quoteMaxAgeMs)) {
        throw new Error(`${request.tradingsymbol} has no current executable depth.`);
      }
      const walk = walkDepth({
        side: request.side,
        levels: request.side === "BUY" ? quote.asks : quote.bids,
        remainingQty: request.quantity,
        limitPrice: request.pricing.limit_price,
        queueModel: this.deps.cfg.queueModel,
        haircutPct: this.deps.cfg.queueLiquidityHaircutPct,
        at: quote.at,
        quoteVersion: quote.version,
      });
      if (walk.executable_within_limit < request.quantity) {
        throw new Error(`${request.tradingsymbol} has ${walk.executable_within_limit} safe quantity within bounded limit; needs ${request.quantity}.`);
      }
      checked.set(request.client_order_id, {
        token: request.token,
        feed_generation: feedGeneration,
        quote_version: quote.version,
        quote_at: quote.at,
        checked_at: checkedAt,
      });
    }
    return checked;
  }

  private async unwindConfirmed(orders: BrokerOrder[], instruments: Record<BoxLegRole, BoxOptionInstrument>, tradeId: string, attemptId: string): Promise<BrokerOrder[]> {
    const manager = this.requireManager();
    const unwinds: BrokerOrder[] = [];
    for (const order of orders) {
      if (order.filled_quantity <= 0) continue;
      const quote = this.deps.quotes.get(order.token);
      const side: OrderSide = order.side === "BUY" ? "SELL" : "BUY";
      const reference = quote ? touchPrice(side, quote.bids, quote.asks) : null;
      if (!reference) {
        manager.invariantViolation(`cannot price protective unwind for ${order.client_order_id}`);
        continue;
      }
      try {
        const request = this.request({
          role: order.role,
          inst: instruments[order.role],
          side,
          quantity: order.filled_quantity,
          referencePrice: reference,
          tradeId,
          attemptId,
          purpose: "EMERGENCY_RESIDUAL",
          phase: "unwind",
        });
        const checkedFeed = this.precheck([request]);
        unwinds.push(await manager.submit(request, checkedFeed.get(request.client_order_id)));
      } catch (error) {
        if (error instanceof OrderPersistenceAfterFillError) {
          unwinds.push(error.order);
        }
        manager.invariantViolation(`protective unwind failed for ${order.client_order_id}: ${errorMessage(error)}`);
      }
    }
    return unwinds;
  }

  private requireManager(): BoxOrderManager {
    if (!this.deps.manager) throw new Error("Live execution manager is unavailable; live execution is blocked.");
    return this.deps.manager;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

function brokerOrderFromDurableIntent(intent: IBoxOrderIntent): BrokerOrder {
  return {
    client_order_id: intent.client_order_id,
    broker_order_id: intent.broker_order_id,
    tag: intent.broker_tag,
    role: intent.role,
    trade_id: intent.trade_id,
    attempt_id: intent.attempt_id,
    purpose: intent.purpose,
    phase: intent.phase,
    exchange: intent.exchange,
    tradingsymbol: intent.tradingsymbol,
    token: intent.token,
    side: intent.side,
    quantity: intent.quantity,
    pricing: {
      order_type: "LIMIT",
      reference_price: intent.reference_price,
      tick_size: intent.tick_size,
      max_chase_ticks: intent.max_chase_ticks,
      limit_price: intent.limit_price,
    },
    limit_price: intent.limit_price,
    state: intent.state,
    filled_quantity: intent.filled_quantity,
    pending_quantity: Math.max(0, intent.quantity - intent.filled_quantity),
    average_price: intent.average_price,
    fills: [],
    reject_family: intent.reject_family as BrokerOrder["reject_family"],
    reject_reason: intent.reject_reason,
    created_at: intent.created_at.getTime(),
    updated_at: intent.updated_at.getTime(),
  };
}

export function hasDurableLocalNoPostProvenance(intent: IBoxOrderIntent): boolean {
  if (intent.state !== "REJECTED" || intent.filled_quantity !== 0 || intent.broker_order_id !== null) {
    return false;
  }
  return intent.audit.some((event) => {
    const payload = event.payload;
    return event.to_state === "REJECTED" &&
      payload?.origin === "local_pre_submit_refusal" &&
      payload.no_broker_post === true &&
      (payload.stage === "dequeue" ||
        payload.stage === "post_persist" ||
        payload.stage === "pre_post");
  });
}

function stableAttemptId(scope: string, at: number, purpose: string): string {
  return `${purpose.toLowerCase()}-${stableHash(`${scope}:${at}:${purpose}`)}`;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function evaluationFromFills(detection: BoxEvaluation, orders: BrokerOrder[]): BoxEvaluation {
  const byRole = new Map(orders.map((order) => [order.role, order]));
  const legs = detection.legs.map((leg) => {
    const order = byRole.get(leg.role);
    return order ? { ...leg, price: order.average_price, qty_at_touch: order.filled_quantity, executable: order.filled_quantity > 0 } : leg;
  });
  const netPerUnit = legs.reduce((sum, leg) => sum + (leg.side === "BUY" ? 1 : -1) * (leg.price ?? 0), 0);
  const gross = round2((directionSign(detection.candidate.direction) * detection.candidate.box_width - netPerUnit) * detection.candidate.lot_size);
  return { ...detection, at: Math.max(...orders.map((order) => order.updated_at)), legs, entry_net_debit_per_unit: netPerUnit, entry_box_cost_per_unit: netPerUnit, gross_edge_per_unit: gross / detection.candidate.lot_size, gross_edge: gross, tradable: true, depth_ok: true, reject: null };
}

function slippageFromFills(detection: BoxLegEvaluation[], orders: BrokerOrder[]): number {
  const byRole = new Map(detection.map((leg) => [leg.role, leg]));
  return round2(orders.reduce((sum, order) => {
    const detected = byRole.get(order.role)?.price ?? order.average_price ?? 0;
    const fill = order.average_price ?? detected;
    return sum + (order.side === "BUY" ? fill - detected : detected - fill) * order.filled_quantity;
  }, 0));
}

function liveEntryFailure(candidate: BoxCandidate, detectedAt: number, submittedAt: number, orders: BrokerOrder[], reason: BoxExecutionFailureReason, detail: string, cfg: BoxConfig, tradeId: string | null, residualOverride?: ResidualLegExposure[], unwindOrders: BrokerOrder[] = []): Extract<BoxLeggingResult, { ok: false }> {
  const record = liveRecord(detectedAt, submittedAt, orders, false, cfg, BOX_LEG_ROLES.length, tradeId);
  const unwindByRole = new Map(unwindOrders.map((order) => [order.role, order]));
  for (const leg of record.legs) {
    const unwind = unwindByRole.get(leg.role);
    if (!unwind || unwind.filled_quantity <= 0) continue;
    leg.unwound_qty = unwind.filled_quantity;
    leg.unwind_price = unwind.average_price;
    leg.unwind_slippage = unwind.average_price === null
      ? null
      : leg.side === "BUY"
        ? round2((leg.fill_price ?? 0) - unwind.average_price)
        : round2(unwind.average_price - (leg.fill_price ?? 0));
  }
  record.failure_reason = reason;
  record.failure_detail = detail;
  record.residual_exposure = residualOverride ?? orders.filter((order) => order.filled_quantity > 0).map((order) => ({
    token: order.token,
    tradingsymbol: order.tradingsymbol,
    role: order.role,
    side: order.side,
    quantity: order.filled_quantity,
    average_price: order.average_price ?? 0,
    source: "partial_entry",
    created_at: order.updated_at,
  }));
  return { ok: false, legging: record, reason, detail };
}

function liveRecord(detectedAt: number, submittedAt: number, orders: BrokerOrder[], opened: boolean, cfg: BoxConfig, requestedCount = orders.length, tradeId: string | null = null): PaperLeggingExecutionRecord {
  const legs = orders.map(paperLeg);
  const fully = orders.filter((order) => order.filled_quantity >= order.quantity).length;
  const fills: Partial<Record<BoxLegRole, number>> = {};
  for (const order of orders) fills[order.role] = order.filled_quantity;
  const fillTimes = orders.filter((order) => order.filled_quantity > 0).map((order) => order.updated_at);
  return {
    mode: "live",
    trade_id: tradeId,
    leg_execution_mode: cfg.legExecutionMode,
    detected_at: detectedAt,
    order_sent_at: submittedAt,
    filled_leg_count: fully,
    opened,
    failed_legs: orders.filter((order) => order.filled_quantity < order.quantity).map((order) => order.role),
    legs,
    first_to_last_fill_ms: fillTimes.length ? Math.max(...fillTimes) - Math.min(...fillTimes) : null,
    decision_to_first_fill_ms: fillTimes.length ? Math.min(...fillTimes) - detectedAt : null,
    decision_to_last_fill_ms: fillTimes.length ? Math.max(...fillTimes) - detectedAt : null,
    timed_out_legs: [],
    partial_fill_legs: orders.filter((order) => order.filled_quantity > 0 && order.filled_quantity < order.quantity).map((order) => order.role),
    exposure_started_at: fillTimes.length ? Math.min(...fillTimes) : null,
    exposure_ended_at: opened && fillTimes.length ? Math.max(...fillTimes) : null,
    exposure_duration_ms: opened && fillTimes.length ? Math.max(...fillTimes) - Math.min(...fillTimes) : null,
    decision_to_complete_ms: fillTimes.length ? Math.max(...fillTimes) - detectedAt : null,
    total_entry_slippage: 0,
    emergency_unwind: !opened && orders.some((order) => order.filled_quantity > 0),
    partial_entry_charges: null,
    unwind_charges: null,
    legging_gross_loss: null,
    legging_net_loss: null,
    abort_after_fill: false,
    final_expected_net_profit: null,
    required_expected_net_profit: null,
    temporal: null,
    residual_exposure: [],
    submitted_leg_count: requestedCount,
    fully_closed_role_count: fully,
    remaining_role_count: Math.max(0, requestedCount - fully),
    fills_by_role: fills,
    failure_reason: null,
    failure_detail: null,
  };
}

function paperLeg(order: BrokerOrder): PaperLegExecution {
  const filled = order.filled_quantity;
  return {
    role: order.role,
    side: order.side,
    token: order.token,
    tradingsymbol: order.tradingsymbol,
    order_id: order.broker_order_id ?? order.client_order_id,
    client_order_id: order.client_order_id,
    pricing: { order_type: "MARKETABLE_LIMIT", side: order.side, quantity: order.quantity, reference_price: order.pricing.reference_price, tick_size: order.pricing.tick_size, max_chase_ticks: order.pricing.max_chase_ticks, limit_price: order.limit_price },
    detected_price: order.pricing.reference_price,
    detected_qty: order.quantity,
    submit_at: order.created_at,
    arrival_at: order.created_at,
    // This projection describes a LIVE order rendered in the paper shape for reporting. The
    // live path records its own stage timings through the timing recorder, so these
    // paper-only race fields stay null rather than being back-filled with a guess.
    ack_at: null,
    pending_since: null,
    timeout_at: null,
    cancel_requested_at: null,
    cancel_confirmed_at: null,
    fill_qty_at_cancel_request: null,
    raced_fill_qty: 0,
    // Live orders carry no simulated cancel stage: the broker, not the simulator, decided.
    cancel_stage: null,
    // A live order is filled by the exchange, not by walking a book, so there is no
    // "executable within limit" observation to report. Left null rather than back-filled.
    executable_within_limit_at_arrival: null,
    displayed_qty_at_arrival: null,
    limit_offset_ticks: null,
    fill_at: filled > 0 ? order.updated_at : null,
    resolved_at: order.updated_at,
    fill_price: order.average_price,
    average_fill_price: order.average_price,
    quantity: order.quantity,
    requested_qty: order.quantity,
    fill_qty: filled,
    remaining_qty: order.quantity - filled,
    fills: order.fills.map((fill) => ({ price: fill.price, qty: fill.quantity, displayed_qty: fill.quantity, effective_qty: fill.quantity, at: fill.at, quote_version: null })),
    quote_version: null,
    book_at: order.updated_at,
    book_exchange_at: null,
    book_age_ms: null,
    slippage: null,
    status: order.state === "COMPLETE" ? "FILLED" : order.state === "CANCELLED" ? (filled > 0 ? "PARTIALLY_FILLED" : "CANCELLED") : order.state === "REJECTED" ? "FAILED" : "PENDING",
    unwind_price: null,
    unwind_slippage: null,
    unwound_qty: 0,
    fail_reason: order.reject_reason,
  };
}

function legsFromOrders(orders: BrokerOrder[], instruments: Record<BoxLegRole, BoxOptionInstrument>, quotes: BoxQuoteStore, now: number): BoxLegEvaluation[] {
  return orders.filter((order) => order.filled_quantity > 0).map((order) => {
    const inst = instruments[order.role];
    const quote = quotes.get(order.token);
    return {
      role: order.role,
      side: order.side,
      token: order.token,
      tradingsymbol: order.tradingsymbol,
      strike: inst.strike,
      instrument_type: inst.instrument_type,
      price: order.average_price,
      qty_at_touch: order.filled_quantity,
      bid: quote?.bid ?? 0,
      bid_qty: quote?.bid_qty ?? 0,
      ask: quote?.ask ?? 0,
      ask_qty: quote?.ask_qty ?? 0,
      quote_at: quote?.at ?? null,
      quote_version: quote?.version ?? null,
      depth: quote ? { bids: quote.bids.map((level) => ({ ...level })), asks: quote.asks.map((level) => ({ ...level })) } : null,
      age_ms: quote ? now - quote.at : null,
      fresh: true,
      executable: order.average_price !== null && order.average_price > 0,
    };
  });
}

/**
 * Project the settled entry into the authoritative per-role outcomes the recovery plan needs.
 *
 * A role with NO order snapshot was not submitted, or was refused before any POST. That is safe
 * to report as `submitted: false` — and NOT as unknown — only because the caller has already
 * quarantined every ambiguous case: `ordersFromSettled` surfaces an order for an ambiguous submit
 * and for a persistence-after-fill, and the `uncertain` check refuses to continue when any such
 * order is present. So by construction, a missing snapshot here means "no exposure was created",
 * while a present one is terminal with a broker-confirmed cumulative quantity.
 *
 * ON TERMINALITY, and why it is NOT `isBrokerOrderTerminal(order.state)`.
 *
 * By the time `manager.submit` resolves, the adapter has already driven the order to a settled
 * outcome — polling to a terminal state and, on timeout, protectively cancelling and CONFIRMING
 * the final cumulative quantity. An order it could not settle surfaces as `UNKNOWN` or
 * `RECONCILIATION_REQUIRED`, which the caller has already quarantined.
 *
 * So a `PARTIALLY_FILLED` snapshot arriving here is not "still working": it is a settled partial
 * whose `filled_quantity` is the authoritative final quantity. Gating the unwind on the lifecycle
 * enum instead of on PROVABILITY would refuse to reverse exactly those confirmed partial fills and
 * strand them as naked exposure. Both fields are therefore derived from the single question that
 * actually matters — is the quantity provable? — which is what the pre-existing code trusted.
 */
function entryLegOutcomes(
  requests: readonly BrokerOrderRequest[],
  orders: readonly BrokerOrder[],
): EntryLegOutcome[] {
  const byRole = new Map(orders.map((order) => [order.role, order]));
  return requests.map((request) => {
    const order = byRole.get(request.role);
    if (!order) {
      return {
        role: request.role,
        side: request.side,
        requested: request.quantity,
        confirmedFilled: 0,
        terminal: true,
        submitted: false,
        brokerStateKnown: true,
      };
    }
    const provable = order.state !== "UNKNOWN" && order.state !== "RECONCILIATION_REQUIRED";
    return {
      role: order.role,
      side: order.side,
      requested: order.quantity,
      // BROKER CUMULATIVE FILLED QUANTITY — the only fill authority.
      confirmedFilled: order.filled_quantity,
      terminal: provable,
      submitted: true,
      brokerStateKnown: provable,
    };
  });
}

function residualAfterUnwind(entries: BrokerOrder[], unwinds: BrokerOrder[]): ResidualLegExposure[] {
  const unwindByRole = new Map(unwinds.map((order) => [order.role, order.filled_quantity]));
  return entries.flatMap((entry) => {
    const remaining = entry.filled_quantity - (unwindByRole.get(entry.role) ?? 0);
    if (remaining <= 0) return [];
    return [{
      token: entry.token,
      tradingsymbol: entry.tradingsymbol,
      exchange: entry.exchange,
      role: entry.role,
      side: entry.side,
      quantity: remaining,
      average_price: entry.average_price ?? 0,
      source: "partial_entry" as const,
      created_at: entry.updated_at,
    }];
  });
}

/**
 * Re-sort broker orders into CANONICAL role order.
 *
 * Entry requests are now built and transmitted HEDGE-FIRST, so the settled results arrive in
 * transport order. Every consumer downstream pairs BY ROLE, but the execution RECORD builds its
 * `legs` array positionally — so without this the persisted and API-visible leg order would have
 * silently changed from `[k1_ce, k2_ce, k2_pe, k1_pe]` to the transport permutation.
 *
 * Transport order is an execution-safety decision; leg-array order is an output contract. This
 * keeps them independent, which is exactly what "preserve accounting by role rather than array
 * position" requires.
 */
function canonicalRoleOrder(orders: BrokerOrder[]): BrokerOrder[] {
  const rank = new Map(BOX_LEG_ROLES.map((role, index) => [role, index]));
  return [...orders].sort(
    (a, b) => (rank.get(a.role) ?? BOX_LEG_ROLES.length) - (rank.get(b.role) ?? BOX_LEG_ROLES.length),
  );
}

function ordersFromSettled(results: PromiseSettledResult<BrokerOrder>[]): BrokerOrder[] {
  return results.flatMap((result) => {
    if (result.status === "fulfilled") return [result.value];
    if (result.reason instanceof BrokerAmbiguousSubmitError && result.reason.order) {
      return [result.reason.order];
    }
    return result.reason instanceof OrderPersistenceAfterFillError
      ? [result.reason.order]
      : [];
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
