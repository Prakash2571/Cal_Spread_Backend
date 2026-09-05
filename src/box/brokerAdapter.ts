import type { LegExecutor } from "./legExecutor.js";
import type {
  BoxLegRole,
  BoxOptionInstrument,
  BoxOrderIntentState,
  BoxOrderPhase,
  BoxOrderPurpose,
  IBoxOrderIntent,
  OrderSide,
  PaperLegExecution,
  ResidualLegExposure,
} from "./types.js";

export type BrokerAdapterMode = "paper" | "live";
export type BrokerOrderState = BoxOrderIntentState;

export const BROKER_ORDER_STATES: readonly BrokerOrderState[] = [
  "CREATED",
  "SUBMITTING",
  "ACKNOWLEDGED",
  "OPEN",
  "PARTIALLY_FILLED",
  "COMPLETE",
  "CANCEL_REQUESTED",
  "CANCELLED",
  "REJECTED",
  "UNKNOWN",
  "RECONCILIATION_REQUIRED",
] as const;

export type BrokerRejectFamily =
  | "margin"
  | "price_band"
  | "instrument_unavailable"
  | "market_closed"
  | "rate_limit"
  | "rms"
  | "quantity_freeze"
  | "auth"
  | "generic";

export interface BrokerFill {
  /** Stable broker trade id, or a deterministic synthetic identity for paper. */
  fill_id: string;
  quantity: number;
  price: number;
  at: number;
}

export interface BrokerLimitPricing {
  order_type: "LIMIT";
  reference_price: number;
  tick_size: number;
  max_chase_ticks: number;
  limit_price: number;
}

/** Broker-neutral, LIMIT-only order request. */
export interface BrokerOrderRequest {
  /** Stable across retries/restarts, e.g. BOX:<trade>:ENTRY:k1_ce:attempt-1. */
  client_order_id: string;
  role: BoxLegRole;
  trade_id: string | null;
  attempt_id: string;
  purpose: BoxOrderPurpose;
  phase: BoxOrderPhase;
  exchange: string;
  tradingsymbol: string;
  token: number;
  side: OrderSide;
  quantity: number;
  /** Explicit bounded marketable-LIMIT envelope; market orders are not representable. */
  pricing: BrokerLimitPricing;
  /** Optional broker tag. Live adapters should derive a bounded stable tag if absent. */
  tag?: string;
  /** Paper-only deterministic execution evidence. Ignored by live adapters. */
  paper?: {
    instrument: BoxOptionInstrument;
    detected_price: number | null;
    detected_qty: number;
    submit_at: number;
    latency_ms?: number;
  };
}

export interface BrokerOrder {
  client_order_id: string;
  broker_order_id: string | null;
  tag: string | null;
  role: BoxLegRole;
  trade_id: string | null;
  attempt_id: string;
  purpose: BoxOrderPurpose;
  phase: BoxOrderPhase;
  exchange: string;
  tradingsymbol: string;
  token: number;
  side: OrderSide;
  quantity: number;
  pricing: BrokerLimitPricing;
  limit_price: number;
  state: BrokerOrderState;
  filled_quantity: number;
  pending_quantity: number;
  average_price: number | null;
  fills: BrokerFill[];
  reject_family: BrokerRejectFamily | null;
  reject_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface BrokerPosition {
  token: number;
  exchange: string;
  tradingsymbol: string;
  /** Positive = long, negative = short. */
  net_quantity: number;
  average_price: number;
}

export interface BrokerMargin {
  available: number | null;
  utilised: number | null;
}

export interface BrokerHealth {
  ok: boolean;
  transport: "up" | "down" | "disabled" | "unknown";
  authenticated: boolean;
  message: string | null;
  checked_at: number;
}

export interface BrokerModifyRequest {
  limit_price: number;
  quantity?: number;
}

/** Async broker boundary: all remote-capable reads are promises. */
export interface BrokerAdapter {
  readonly mode: BrokerAdapterMode;
  /** Pure preparation hook (for example stable bounded broker tags); no transport calls. */
  prepareOrder?(req: BrokerOrderRequest): BrokerOrderRequest;
  submitOrder(req: BrokerOrderRequest): Promise<BrokerOrder>;
  cancelOrder(clientOrderId: string): Promise<BrokerOrder | undefined>;
  modifyOrder?(clientOrderId: string, request: BrokerModifyRequest): Promise<BrokerOrder>;
  getOrder(clientOrderId: string): Promise<BrokerOrder | undefined>;
  listOrders(): Promise<BrokerOrder[]>;
  listPositions(): Promise<BrokerPosition[]>;
  /** Hydrate session-local client↔broker identity after durable restart reconciliation. */
  adoptOrder?(
    intent: IBoxOrderIntent,
    snapshot: BrokerOrder,
  ): Promise<BrokerOrder>;
  margins?(): Promise<BrokerMargin | null>;
  health?(): Promise<BrokerHealth>;
}

export class BrokerAmbiguousSubmitError extends Error {
  readonly clientOrderId: string;
  readonly causeValue: unknown;
  readonly order: BrokerOrder | undefined;

  constructor(
    clientOrderId: string,
    message: string,
    causeValue?: unknown,
    order?: BrokerOrder,
  ) {
    super(message);
    this.name = "BrokerAmbiguousSubmitError";
    this.clientOrderId = clientOrderId;
    this.causeValue = causeValue;
    this.order = order;
  }
}

export class BrokerOrderRejectedError extends Error {
  constructor(
    readonly order: BrokerOrder,
    readonly causeValue?: unknown,
  ) {
    super(order.reject_reason ?? "Broker rejected order.");
    this.name = "BrokerOrderRejectedError";
  }
}

export class BrokerDisabledError extends Error {
  constructor(message = "Live broker adapter is disabled.") {
    super(message);
    this.name = "BrokerDisabledError";
  }
}

export function isBrokerOrderTerminal(state: BrokerOrderState): boolean {
  return state === "COMPLETE" || state === "CANCELLED" || state === "REJECTED";
}

export function assertBoundedLimit(req: BrokerOrderRequest, configuredMaxChaseTicks?: number): void {
  if (!Number.isInteger(req.quantity) || req.quantity <= 0) {
    throw new Error(`Invalid order quantity ${req.quantity}.`);
  }
  const pricing = req.pricing;
  if (
    pricing.order_type !== "LIMIT" ||
    !Number.isFinite(pricing.reference_price) || pricing.reference_price <= 0 ||
    !Number.isFinite(pricing.tick_size) || pricing.tick_size <= 0 ||
    !Number.isInteger(pricing.max_chase_ticks) || pricing.max_chase_ticks < 0 ||
    (configuredMaxChaseTicks !== undefined && pricing.max_chase_ticks > configuredMaxChaseTicks) ||
    !Number.isFinite(pricing.limit_price) || pricing.limit_price <= 0 || pricing.limit_price > 10_000_000
  ) {
    throw new Error("Invalid bounded LIMIT pricing envelope.");
  }
  const ticks = pricing.limit_price / pricing.tick_size;
  if (Math.abs(ticks - Math.round(ticks)) > 1e-7) {
    throw new Error(`LIMIT ${pricing.limit_price} is not aligned to tick size ${pricing.tick_size}.`);
  }
  const band = pricing.tick_size * pricing.max_chase_ticks;
  const tolerance = Math.max(1e-8, pricing.tick_size / 10_000);
  const lower = pricing.reference_price - band - tolerance;
  const upper = pricing.reference_price + band + tolerance;
  const correctlyDirected = req.side === "BUY"
    ? pricing.limit_price >= pricing.reference_price - tolerance && pricing.limit_price <= upper
    : pricing.limit_price <= pricing.reference_price + tolerance && pricing.limit_price >= lower;
  if (!correctlyDirected) {
    throw new Error(`LIMIT ${pricing.limit_price} exceeds the configured chase band.`);
  }
}

/** Stable strategy identity used by OrderManager and durable intents. */
export function boxClientOrderId(args: {
  tradeId: string;
  purpose: BoxOrderPurpose;
  role: BoxLegRole;
  attempt: number | string;
}): string {
  const attempt = typeof args.attempt === "number" ? `attempt-${args.attempt}` : String(args.attempt);
  return `BOX:${args.tradeId}:${args.purpose}:${args.role}:${attempt}`;
}

function paperState(status: PaperLegExecution["status"]): BrokerOrderState {
  switch (status) {
    case "CREATED": return "CREATED";
    case "SUBMITTED":
    case "IN_FLIGHT":
    // The broker has the order; nothing has executed. ACK IS NOT FILL.
    case "ACKNOWLEDGED": return "ACKNOWLEDGED";
    case "PENDING": return "OPEN";
    case "PARTIALLY_FILLED": return "PARTIALLY_FILLED";
    // A cancel is in flight but unconfirmed, so the order may still fill. The durable
    // vocabulary already permits CANCEL_REQUESTED -> COMPLETE for exactly this reason.
    case "CANCEL_REQUESTED": return "CANCEL_REQUESTED";
    case "FILLED":
    case "UNWOUND": return "COMPLETE";
    case "CANCELLED": return "CANCELLED";
    case "TIMED_OUT": return "CANCELLED";
    case "FAILED":
    case "UNWIND_FAILED": return "REJECTED";
    case "UNWINDING": return "OPEN";
  }
}

/**
 * Deterministic paper adapter. It executes exactly one request through the
 * existing LegExecutor, preserving its arrival, depth-walk, queue and timeout
 * semantics while presenting a broker-neutral async contract.
 */
export class PaperBrokerAdapter implements BrokerAdapter {
  readonly mode = "paper" as const;
  private readonly orders = new Map<string, BrokerOrder>();
  private readonly cancelled = new Set<string>();

  constructor(
    private readonly deps: {
      executor: LegExecutor;
      now: () => number;
      defaultLatencyMs?: number;
    },
  ) {}

  async submitOrder(req: BrokerOrderRequest): Promise<BrokerOrder> {
    assertBoundedLimit(req);
    if (!req.paper) throw new Error("PaperBrokerAdapter requires deterministic paper evidence.");
    const existing = this.orders.get(req.client_order_id);
    if (existing) return cloneOrder(existing);

    const created = fromRequest(req, this.deps.now());
    created.state = "SUBMITTING";
    this.orders.set(req.client_order_id, created);

    const paper = req.paper;
    const latencyMs = paper.latency_ms ?? this.deps.defaultLatencyMs;
    const result = await this.deps.executor.run({
      requests: [{
        role: req.role,
        side: req.side,
        inst: paper.instrument,
        detected_price: paper.detected_price,
        detected_qty: paper.detected_qty,
        quantity: req.quantity,
        pricing: {
          order_type: "MARKETABLE_LIMIT",
          side: req.side,
          quantity: req.quantity,
          reference_price: req.pricing.reference_price,
          tick_size: req.pricing.tick_size,
          max_chase_ticks: req.pricing.max_chase_ticks,
          limit_price: req.pricing.limit_price,
        },
      }],
      submitAt: paper.submit_at,
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      phase: req.phase === "unwind" ? "unwind" : "entry",
      // LegExecutor appends the role to its internal paper order id. The broker-
      // neutral client id remains exactly `req.client_order_id` in our projection.
      orderIdPrefix: req.client_order_id,
      abortReason: () => this.cancelled.has(req.client_order_id)
        ? { reason: "discovery_stopped", detail: "paper order cancelled by client" }
        : null,
    });
    const leg = result.legs[0];
    if (!leg) throw new Error(`LegExecutor returned no result for ${req.client_order_id}.`);
    const order = paperLegToBroker(req, leg, this.deps.now());
    this.orders.set(req.client_order_id, order);
    return cloneOrder(order);
  }

  async cancelOrder(clientOrderId: string): Promise<BrokerOrder | undefined> {
    const current = this.orders.get(clientOrderId);
    if (!current) return undefined;
    if (!isBrokerOrderTerminal(current.state)) {
      this.cancelled.add(clientOrderId);
      current.state = "CANCEL_REQUESTED";
      current.updated_at = this.deps.now();
    }
    return cloneOrder(current);
  }

  async getOrder(clientOrderId: string): Promise<BrokerOrder | undefined> {
    const value = this.orders.get(clientOrderId);
    return value ? cloneOrder(value) : undefined;
  }

  async listOrders(): Promise<BrokerOrder[]> {
    return [...this.orders.values()].map(cloneOrder);
  }

  async listPositions(): Promise<BrokerPosition[]> {
    const positions = new Map<string, BrokerPosition>();
    const fills = [...this.orders.values()]
      .flatMap((order) => order.fills.map((fill) => ({ order, fill })))
      .sort((a, b) => a.fill.at - b.fill.at || a.fill.fill_id.localeCompare(b.fill.fill_id));

    for (const { order, fill } of fills) {
      const key = `${order.exchange}:${order.tradingsymbol}`;
      const delta = (order.side === "BUY" ? 1 : -1) * fill.quantity;
      const current = positions.get(key) ?? {
        token: order.token,
        exchange: order.exchange,
        tradingsymbol: order.tradingsymbol,
        net_quantity: 0,
        average_price: 0,
      };
      const prior = current.net_quantity;
      if (prior === 0 || Math.sign(prior) === Math.sign(delta)) {
        const total = Math.abs(prior) + Math.abs(delta);
        current.average_price = total === 0
          ? 0
          : ((Math.abs(prior) * current.average_price) + (Math.abs(delta) * fill.price)) / total;
        current.net_quantity = prior + delta;
      } else if (Math.abs(delta) < Math.abs(prior)) {
        // A partial close realises P&L but does not rewrite the remaining lot's basis.
        current.net_quantity = prior + delta;
      } else if (Math.abs(delta) === Math.abs(prior)) {
        current.net_quantity = 0;
        current.average_price = 0;
      } else {
        // The close crossed through flat and opened exposure in the opposite direction.
        current.net_quantity = prior + delta;
        current.average_price = fill.price;
      }
      positions.set(key, current);
    }
    return [...positions.values()].filter((position) => position.net_quantity !== 0);
  }

  async health(): Promise<BrokerHealth> {
    return {
      ok: true,
      transport: "up",
      authenticated: true,
      message: null,
      checked_at: this.deps.now(),
    };
  }
}

function fromRequest(req: BrokerOrderRequest, now: number): BrokerOrder {
  return {
    client_order_id: req.client_order_id,
    broker_order_id: null,
    tag: req.tag ?? null,
    role: req.role,
    trade_id: req.trade_id,
    attempt_id: req.attempt_id,
    purpose: req.purpose,
    phase: req.phase,
    exchange: req.exchange,
    tradingsymbol: req.tradingsymbol,
    token: req.token,
    side: req.side,
    quantity: req.quantity,
    pricing: { ...req.pricing },
    limit_price: req.pricing.limit_price,
    state: "CREATED",
    filled_quantity: 0,
    pending_quantity: req.quantity,
    average_price: null,
    fills: [],
    reject_family: null,
    reject_reason: null,
    created_at: now,
    updated_at: now,
  };
}

function paperLegToBroker(req: BrokerOrderRequest, leg: PaperLegExecution, now: number): BrokerOrder {
  const order = fromRequest(req, leg.submit_at || now);
  order.broker_order_id = leg.order_id;
  order.state = paperState(leg.status);
  order.filled_quantity = leg.fill_qty;
  order.pending_quantity = leg.remaining_qty;
  order.average_price = leg.average_fill_price;
  order.fills = leg.fills.map((fill, index) => ({
    fill_id: `paper:${leg.client_order_id}:${fill.quote_version ?? "na"}:${fill.at}:${index}`,
    quantity: fill.qty,
    price: fill.price,
    at: fill.at,
  }));
  order.reject_reason = leg.fail_reason;
  order.reject_family = leg.fail_reason ? "generic" : null;
  order.updated_at = leg.resolved_at ?? now;
  return order;
}

function cloneOrder(order: BrokerOrder): BrokerOrder {
  return {
    ...order,
    pricing: { ...order.pricing },
    fills: order.fills.map((fill) => ({ ...fill })),
  };
}

/**
 * Compatibility helper retained for existing simulator callers/tests.
 * Outstanding paper fill quantity remains computed exactly as before.
 */
export function residualFromLegs(legs: PaperLegExecution[], now: number): ResidualLegExposure[] {
  const out: ResidualLegExposure[] = [];
  for (const leg of legs) {
    const outstanding = leg.fill_qty - leg.unwound_qty;
    if (outstanding <= 0) continue;
    out.push({
      token: leg.token,
      tradingsymbol: leg.tradingsymbol,
      role: leg.role,
      side: leg.side,
      quantity: outstanding,
      average_price: leg.average_fill_price ?? leg.fill_price ?? 0,
      source: "partial_entry",
      created_at: now,
    });
  }
  return out;
}
