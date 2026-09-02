import type { BrokerOrder, BrokerOrderRequest } from "./brokerAdapter.js";
import { BrokerAmbiguousSubmitError, boxClientOrderId } from "./brokerAdapter.js";
import { OrderPersistenceAfterFillError, type BoxOrderManager } from "./orderManager.js";
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
 * Central execution facade. Paper modes delegate byte-for-byte to the existing
 * deterministic simulator; live mode emits bounded LIMIT intents through the
 * durable BoxOrderManager and trusts broker cumulative fills only.
 */
export class CentralBoxExecutionGateway implements BoxExecutionGateway {
  readonly mode: BoxConfig["executionMode"];

  constructor(private readonly deps: {
    cfg: BoxConfig;
    simulator: BoxExecutionSimulator;
    quotes: BoxQuoteStore;
    manager?: BoxOrderManager;
    /** Allocates the Mongo identity before any live intent is created. */
    allocateTradeId?: () => string;
    isTokenWarm?: (token: number) => boolean;
    now?: () => number;
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
    const attemptId = stableAttemptId(args.candidate.key, args.detection.at, "ENTRY");
    const tradeId = this.deps.allocateTradeId?.();
    if (!tradeId) {
      manager.invariantViolation(`live entry ${attemptId} has no preallocated durable trade identity`);
      return liveEntryFailure(args.candidate, args.detection.at, this.now(), [], "legging_incomplete", "durable trade identity allocation failed; entry blocked", this.deps.cfg, null);
    }
    const submittedAt = this.now();
    const requests: BrokerOrderRequest[] = [];
    try {
      for (const role of BOX_LEG_ROLES) {
        const leg = args.detection.legs.find((item) => item.role === role);
        if (!leg || leg.price === null) throw new Error(`No executable reference price for ${role}.`);
        requests.push(this.request({
          role,
          inst: args.candidate.legs[role],
          side: entrySideFor(role, args.candidate.direction),
          quantity: args.candidate.lot_size,
          referencePrice: leg.price,
          tradeId,
          attemptId,
          purpose: "ENTRY",
          phase: "entry",
        }));
      }
      this.precheck(requests);
    } catch (error) {
      return liveEntryFailure(args.candidate, args.detection.at, submittedAt, [], "insufficient_quantity", errorMessage(error), this.deps.cfg, tradeId);
    }

    const settled = await Promise.allSettled(requests.map((request) => manager.submit(request)));
    const orders = ordersFromSettled(settled);
    const uncertain = settled.some((item) => item.status === "rejected" &&
      (item.reason instanceof OrderPersistenceAfterFillError ||
        /unknown|ambiguous|reconcil/i.test(errorMessage(item.reason)))) ||
      orders.some((order) => order.state === "UNKNOWN" || order.state === "RECONCILIATION_REQUIRED");
    if (uncertain) {
      manager.invariantViolation(`live entry ${attemptId} has uncertain broker terminal quantity`);
      return liveEntryFailure(args.candidate, args.detection.at, submittedAt, orders, "legging_incomplete", "broker terminal quantity is uncertain; entry quarantined", this.deps.cfg, tradeId);
    }

    const fullyFilled = orders.length === requests.length && orders.every((order) => order.filled_quantity === order.quantity);
    if (!fullyFilled) {
      const unwindOrders = await this.unwindConfirmed(orders, args.candidate.legs, tradeId, `${attemptId}:unwind`);
      const residual = residualAfterUnwind(orders, unwindOrders);
      return liveEntryFailure(args.candidate, args.detection.at, submittedAt, orders, "legging_incomplete", "entry incomplete; confirmed fills were protectively unwound", this.deps.cfg, tradeId, residual, unwindOrders);
    }

    const evaluation = evaluationFromFills(args.detection, orders);
    const measured = slippageFromFills(args.detection.legs, orders);
    const decision = args.qualify(evaluation, measured);
    if (!decision.qualifies) {
      const unwindOrders = await this.unwindConfirmed(orders, args.candidate.legs, tradeId, `${attemptId}:economics-unwind`);
      const failed = liveEntryFailure(args.candidate, args.detection.at, submittedAt, orders, "abort_after_fill", "executed prices failed final economics; confirmed box was unwound", this.deps.cfg, tradeId, residualAfterUnwind(orders, unwindOrders), unwindOrders);
      failed.legging.abort_after_fill = true;
      failed.legging.final_expected_net_profit = decision.expected_net_profit;
      failed.legging.required_expected_net_profit = decision.min_expected_net_profit;
      return failed;
    }

    return {
      ok: true,
      evaluation,
      decision,
      legging: liveRecord(args.detection.at, submittedAt, orders, true, this.deps.cfg, undefined, tradeId),
    };
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
    try {
      this.precheck(requests);
    } catch (error) {
      const record = liveRecord(args.detectedAt, this.now(), [], false, this.deps.cfg, requests.length, args.position.id);
      return { ok: false, record, reason: "insufficient_quantity", detail: errorMessage(error) };
    }
    const settled = await Promise.allSettled(requests.map((request) => manager.submit(request)));
    const orders = ordersFromSettled(settled);
    const uncertain = settled.some((item) => item.status === "rejected") || orders.some((order) => order.state === "UNKNOWN" || order.state === "RECONCILIATION_REQUIRED");
    if (uncertain) manager.invariantViolation(`live exit ${attemptId} has uncertain broker terminal quantity`);
    const record = liveRecord(args.detectedAt, this.now(), orders, false, this.deps.cfg, requests.length, args.position.id);
    const legs = legsFromOrders(orders, args.position.legs, this.deps.quotes, this.now());
    const clean = !uncertain && orders.length === requests.length && orders.every((order) => order.filled_quantity === order.quantity);
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

  async flattenResidual(args: Parameters<BoxExecutionSimulator["flattenResidual"]>[0]): ReturnType<BoxExecutionSimulator["flattenResidual"]> {
    if (this.mode !== "live") return this.deps.simulator.flattenResidual(args);
    const manager = this.requireManager();
    const orders: BrokerOrder[] = [];
    for (const residual of args.residual) {
      const quote = this.deps.quotes.get(residual.token);
      const side: OrderSide = residual.side === "BUY" ? "SELL" : "BUY";
      const reference = quote ? touchPrice(side, quote.bids, quote.asks) : null;
      if (!reference) continue;
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
        orders.push(await manager.submit(this.request({
          role: residual.role,
          inst,
          side,
          quantity: residual.quantity,
          referencePrice: reference,
          tradeId: args.keyPrefix,
          attemptId: stableAttemptId(args.keyPrefix, residual.created_at, `RESIDUAL-${residual.role}`),
          purpose: "EMERGENCY_RESIDUAL",
          phase: "unwind",
        })));
      } catch (error) {
        if (error instanceof OrderPersistenceAfterFillError) {
          orders.push(error.order);
          manager.invariantViolation(`residual ${args.keyPrefix} filled but its durable snapshot failed`);
        } else if (/unknown|ambiguous|reconcil/i.test(errorMessage(error))) {
          manager.invariantViolation(`residual ${args.keyPrefix} uncertain`);
        }
      }
    }
    const flattened: Partial<Record<BoxLegRole, number>> = {};
    const remaining: ResidualLegExposure[] = [];
    for (const residual of args.residual) {
      const order = orders.find((item) => item.role === residual.role);
      const quantity = order?.filled_quantity ?? 0;
      flattened[residual.role] = quantity;
      if (quantity < residual.quantity) remaining.push({ ...residual, quantity: residual.quantity - quantity });
    }
    return {
      flattened_by_role: flattened,
      flatten_charges: 0,
      remaining,
      legs: orders.map((order) => paperLeg(order)),
    };
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

  private precheck(requests: BrokerOrderRequest[]): void {
    for (const request of requests) {
      if (this.mode === "live" && this.deps.isTokenWarm && !this.deps.isTokenWarm(request.token)) {
        throw new Error(`${request.tradingsymbol} has not received a WebSocket tick in the current feed generation.`);
      }
      const quote = this.deps.quotes.get(request.token);
      if (!quote) throw new Error(`${request.tradingsymbol} has no live depth.`);
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
    }
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
        unwinds.push(await manager.submit(this.request({
          role: order.role,
          inst: instruments[order.role],
          side,
          quantity: order.filled_quantity,
          referencePrice: reference,
          tradeId,
          attemptId,
          purpose: "EMERGENCY_RESIDUAL",
          phase: "unwind",
        })));
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
  const fully = orders.filter((order) => order.filled_quantity === order.quantity).length;
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
    pending_since: null,
    timeout_at: null,
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
