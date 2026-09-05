import {
  BrokerAmbiguousSubmitError,
  BrokerDisabledError,
  BrokerOrderRejectedError,
  assertBoundedLimit,
  isBrokerOrderTerminal,
  type BrokerAdapter,
  type BrokerHealth,
  type BrokerMargin,
  type BrokerModifyRequest,
  type BrokerOrder,
  type BrokerOrderRequest,
  type BrokerOrderState,
  type BrokerPosition,
  type BrokerRejectFamily,
} from "./brokerAdapter.js";
import type { BoxConfig } from "./config.js";
import type { ExecutionTimingRecorder } from "./executionTiming.js";
import type { ExecutionMode, IBoxOrderIntent, OrderSide } from "./types.js";

export interface KiteTransportOrder {
  order_id: string;
  status: string;
  exchange: string;
  tradingsymbol: string;
  transaction_type: OrderSide;
  quantity: number;
  filled_quantity: number;
  pending_quantity: number;
  average_price: number;
  price: number;
  tag: string | null;
  status_message: string | null;
  order_timestamp: string | null;
  exchange_update_timestamp: string | null;
}

export interface KiteTransportPosition {
  instrument_token?: number;
  exchange: string;
  tradingsymbol: string;
  quantity: number;
  average_price: number;
}

export interface KitePlaceOrderRequest {
  exchange: string;
  tradingsymbol: string;
  transaction_type: OrderSide;
  quantity: number;
  order_type: "LIMIT";
  product: "NRML";
  validity: "DAY";
  price: number;
  tag: string;
}

export interface KiteBrokerTransport {
  placeOrder(request: KitePlaceOrderRequest): Promise<{ order_id: string }>;
  cancelOrder(orderId: string): Promise<void>;
  modifyOrder(orderId: string, request: { quantity?: number; price: number }): Promise<void>;
  getOrder(orderId: string): Promise<KiteTransportOrder | null>;
  listOrders(): Promise<KiteTransportOrder[]>;
  listPositions(): Promise<KiteTransportPosition[]>;
  margins?(): Promise<BrokerMargin | null>;
  health?(): Promise<BrokerHealth>;
}

export type KiteAccessTokenProvider = () => string | Promise<string>;

export class KiteHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "KiteHttpError";
  }
}

/**
 * Minimal bounded-timeout Kite Connect HTTP transport for regular NRML LIMIT
 * orders. It deliberately has no market-order API.
 */
export class KiteHttpTransport implements KiteBrokerTransport {
  constructor(
    private readonly config: {
      apiKey: string;
      accessToken: KiteAccessTokenProvider;
      timeoutMs: number;
      baseUrl?: string;
      fetchImpl?: typeof fetch;
      now?: () => number;
    },
  ) {}

  async placeOrder(request: KitePlaceOrderRequest): Promise<{ order_id: string }> {
    try {
      const data = await this.request<{ order_id: string }>("POST", "/orders/regular", {
        exchange: request.exchange,
        tradingsymbol: request.tradingsymbol,
        transaction_type: request.transaction_type,
        quantity: request.quantity,
        order_type: request.order_type,
        product: request.product,
        validity: request.validity,
        price: request.price,
        tag: request.tag,
      }, true);
      if (!data?.order_id) {
        throw new BrokerAmbiguousSubmitError(
          "transport-pending",
          "Kite place-order response omitted order_id; placement is ambiguous and requires reconciliation.",
        );
      }
      return data;
    } catch (error) {
      if (error instanceof BrokerAmbiguousSubmitError || isDefinitivePlacementRejection(error)) throw error;
      throw new BrokerAmbiguousSubmitError(
        "transport-pending",
        "Kite placement outcome is unknown; reconciliation is required before retry.",
        error,
      );
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.request("DELETE", `/orders/regular/${encodeURIComponent(orderId)}`);
  }

  async modifyOrder(orderId: string, request: { quantity?: number; price: number }): Promise<void> {
    await this.request("PUT", `/orders/regular/${encodeURIComponent(orderId)}`, {
      order_type: "LIMIT",
      price: request.price,
      ...(request.quantity !== undefined ? { quantity: request.quantity } : {}),
    });
  }

  async getOrder(orderId: string): Promise<KiteTransportOrder | null> {
    const history = await this.request<KiteTransportOrder[]>(
      "GET",
      `/orders/${encodeURIComponent(orderId)}`,
    );
    return history.at(-1) ?? null;
  }

  async listOrders(): Promise<KiteTransportOrder[]> {
    return this.request<KiteTransportOrder[]>("GET", "/orders");
  }

  async listPositions(): Promise<KiteTransportPosition[]> {
    const data = await this.request<{ net?: KiteTransportPosition[] }>("GET", "/portfolio/positions");
    return data.net ?? [];
  }

  async margins(): Promise<BrokerMargin | null> {
    const data = await this.request<Record<string, unknown>>("GET", "/user/margins/equity");
    const available = numericPath(data, "available", "live_balance");
    const utilised = numericPath(data, "utilised", "debits");
    return { available, utilised };
  }

  async health(): Promise<BrokerHealth> {
    try {
      await this.request("GET", "/user/profile");
      return {
        ok: true,
        transport: "up",
        authenticated: true,
        message: null,
        checked_at: (this.config.now ?? Date.now)(),
      };
    } catch (error) {
      return {
        ok: false,
        transport: "down",
        authenticated: !(error instanceof KiteHttpError && (error.status === 401 || error.status === 403)),
        message: errorMessage(error),
        checked_at: (this.config.now ?? Date.now)(),
      };
    }
  }

  private async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: Record<string, string | number>,
    ambiguousSubmit = false,
  ): Promise<T> {
    const token = await this.config.accessToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(250, this.config.timeoutMs));
    const fetchImpl = this.config.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(`${this.config.baseUrl ?? "https://api.kite.trade"}${path}`, {
        method,
        headers: {
          "X-Kite-Version": "3",
          Authorization: `token ${this.config.apiKey}:${token}`,
          ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(body ? { body: new URLSearchParams(stringValues(body)).toString() } : {}),
        signal: controller.signal,
      });
      const payload = await response.json() as { data?: T; message?: string; error_type?: string };
      if (!response.ok) {
        throw new KiteHttpError(
          response.status,
          payload.message ?? payload.error_type ?? `Kite HTTP ${response.status}`,
          payload,
        );
      }
      return payload.data as T;
    } catch (error) {
      if (ambiguousSubmit && !isDefinitivePlacementRejection(error)) {
        throw new BrokerAmbiguousSubmitError(
          "transport-pending",
          "Kite placement did not produce a definitive typed 4xx rejection; reconciliation is required.",
          error,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface KiteBrokerAdapterConfig {
  executionMode: ExecutionMode;
  enabled: boolean;
  /**
   * LIVE TIMING INSTRUMENTATION (Phase 2). Optional and FAIL-OPEN.
   *
   * The adapter marks the stages only IT can witness: transport start, the HTTP request leaving
   * the wire, the response, the broker order id, the ACK, each cumulative fill, and the cancel
   * request/acknowledgement. The OrderManager owns the queue stages and the terminal publish, and
   * both write to the same trace, keyed by client order id.
   *
   * The adapter never CREATES a trace: without the strategy identity a sample cannot be filed
   * under the right dimensions, so a mark for an unknown order is dropped rather than guessed at.
   */
  timing?: ExecutionTimingRecorder;
  ackTimeoutMs: number;
  workingTimeoutMs: number;
  partialTimeoutMs: number;
  cancelTimeoutMs: number;
  brokerMinIntervalMs: number;
  maxModifications: number;
  maxChaseTicks: number;
}

export function kiteAdapterConfigFromBoxConfig(cfg: BoxConfig): KiteBrokerAdapterConfig {
  return {
    executionMode: cfg.executionMode,
    enabled: cfg.liveTradingEnabled,
    ackTimeoutMs: cfg.liveAckTimeoutMs,
    workingTimeoutMs: cfg.liveWorkingTimeoutMs,
    partialTimeoutMs: cfg.livePartialTimeoutMs,
    cancelTimeoutMs: cfg.liveCancelTimeoutMs,
    brokerMinIntervalMs: cfg.liveBrokerMinIntervalMs,
    maxModifications: cfg.liveMaxModifications,
    maxChaseTicks: cfg.liveMaxChaseTicks,
  };
}

/**
 * Live adapter with a double deployment gate. Every method checks the gate before
 * touching the injected transport, so disabled instances make exactly zero broker
 * calls (including reads, cancellation, modification, margins and health).
 */
export class KiteBrokerAdapter implements BrokerAdapter {
  readonly mode = "live" as const;
  private readonly orders = new Map<string, BrokerOrder>();
  private readonly clientByBroker = new Map<string, string>();
  private readonly modifications = new Map<string, number>();
  private lastTransportAt = Number.NEGATIVE_INFINITY;
  private transportTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly transport: KiteBrokerTransport,
    private readonly config: KiteBrokerAdapterConfig,
    private readonly clock: {
      now: () => number;
      wait: (ms: number) => Promise<void>;
    } = {
      now: Date.now,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  ) {}

  prepareOrder(req: BrokerOrderRequest): BrokerOrderRequest {
    return {
      ...req,
      pricing: { ...req.pricing },
      tag: stableKiteTag(req.client_order_id, req.tag),
    };
  }

  async submitOrder(req: BrokerOrderRequest): Promise<BrokerOrder> {
    this.ensureEnabled();
    const prepared = this.prepareOrder(req);
    assertBoundedLimit(prepared, this.config.maxChaseTicks);
    req = prepared;
    const existing = this.orders.get(req.client_order_id);
    if (existing) return clone(existing);

    const order = requestOrder(req, this.clock.now());
    order.state = "SUBMITTING";
    order.tag = stableKiteTag(req.client_order_id, req.tag);
    this.orders.set(req.client_order_id, order);

    // TRANSPORT START: before `call()`, so the pacing wait is attributed to transport_wait_ms
    // rather than being hidden inside the POST duration.
    this.mark(req.client_order_id, "transport_started");
    let placed: { order_id: string };
    try {
      placed = await this.call(() => {
        // HTTP REQUEST START: inside the paced callback, so post_to_http_response_ms measures
        // the network and the broker, NOT our own rate limiter.
        this.mark(req.client_order_id, "http_request_started");
        return this.transport.placeOrder({
          exchange: req.exchange,
          tradingsymbol: req.tradingsymbol,
          transaction_type: req.side,
          quantity: req.quantity,
          order_type: "LIMIT",
          product: "NRML",
          validity: "DAY",
          price: req.pricing.limit_price,
          tag: order.tag as string,
        });
      });
      this.mark(req.client_order_id, "http_response");
    } catch (error) {
      // The response is an observable event whether it succeeded or failed. Recording it on the
      // failure path is what makes a timeout's duration measurable instead of invisible.
      this.mark(req.client_order_id, "http_response");
      if (error instanceof BrokerAmbiguousSubmitError || !isDefinitivePlacementRejection(error)) {
        order.state = "RECONCILIATION_REQUIRED";
        order.updated_at = this.clock.now();
        throw new BrokerAmbiguousSubmitError(
          req.client_order_id,
          errorMessage(error),
          error,
          clone(order),
        );
      }
      order.state = "REJECTED";
      order.reject_family = classifyKiteReject(error);
      order.reject_reason = errorMessage(error);
      order.updated_at = this.clock.now();
      throw new BrokerOrderRejectedError(clone(order), error);
    }

    order.broker_order_id = placed.order_id;
    order.state = "ACKNOWLEDGED";
    order.updated_at = this.clock.now();
    // BROKER ORDER ID + ACK. Two marks because they are two different facts: the id proves an
    // order EXISTS, and the ACK proves the broker ACCEPTED it. Neither proves any quantity
    // executed — see orderLifecycle.stageProvesExecution.
    this.mark(req.client_order_id, "broker_order_id");
    this.mark(req.client_order_id, "acknowledged");
    this.clientByBroker.set(placed.order_id, req.client_order_id);
    try {
      return await this.waitForResolution(order);
    } catch (error) {
      order.state = "RECONCILIATION_REQUIRED";
      order.updated_at = this.clock.now();
      throw new BrokerAmbiguousSubmitError(
        req.client_order_id,
        `Kite order ${placed.order_id} became uncertain while awaiting broker state; reconciliation is required.`,
        error,
        clone(order),
      );
    }
  }

  async cancelOrder(clientOrderId: string): Promise<BrokerOrder | undefined> {
    this.ensureEnabled();
    const order = this.orders.get(clientOrderId);
    if (!order) return undefined;
    if (isBrokerOrderTerminal(order.state)) return clone(order);
    if (!order.broker_order_id) {
      order.state = "RECONCILIATION_REQUIRED";
      return clone(order);
    }
    order.state = "CANCEL_REQUESTED";
    order.updated_at = this.clock.now();
    // CANCEL REQUESTED. This opens cancel_request_to_terminal_ms — the measured span that sizes
    // paper's cancel-vs-fill race window. It is deliberately marked BEFORE the DELETE is sent,
    // because the race starts the moment we commit to cancelling.
    this.mark(clientOrderId, "cancel_requested");
    await withDeadline(
      this.call(() => this.transport.cancelOrder(order.broker_order_id as string)),
      this.config.cancelTimeoutMs,
      "Kite cancellation timed out; reconciliation is required.",
    ).catch((error) => {
      order.state = "RECONCILIATION_REQUIRED";
      throw error;
    });
    // The broker accepted the cancel REQUEST. It is not yet a cancellation: the order may still
    // be filling right now, which is why confirmTerminalAfterCancel re-reads until terminal.
    this.mark(clientOrderId, "cancel_acknowledged");
    return clone(await this.confirmTerminalAfterCancel(order));
  }

  async modifyOrder(clientOrderId: string, request: BrokerModifyRequest): Promise<BrokerOrder> {
    this.ensureEnabled();
    const order = this.orders.get(clientOrderId);
    if (!order?.broker_order_id) throw new Error(`Unknown broker order ${clientOrderId}.`);
    const quantity = request.quantity ?? order.quantity;
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > order.quantity) {
      throw new Error("Kite modification quantity must be a positive integer no larger than the original order.");
    }
    assertBoundedLimit({
      client_order_id: order.client_order_id,
      role: order.role,
      trade_id: order.trade_id,
      attempt_id: order.attempt_id,
      purpose: order.purpose,
      phase: order.phase,
      exchange: order.exchange,
      tradingsymbol: order.tradingsymbol,
      token: order.token,
      side: order.side,
      quantity,
      pricing: { ...order.pricing, limit_price: request.limit_price },
      ...(order.tag ? { tag: order.tag } : {}),
    }, this.config.maxChaseTicks);
    const count = this.modifications.get(clientOrderId) ?? 0;
    if (count >= this.config.maxModifications) throw new Error("Live order modification limit reached.");
    await this.call(() => this.transport.modifyOrder(order.broker_order_id as string, {
      price: request.limit_price,
      ...(request.quantity !== undefined ? { quantity: request.quantity } : {}),
    }));
    this.modifications.set(clientOrderId, count + 1);
    order.limit_price = request.limit_price;
    order.pricing = { ...order.pricing, limit_price: request.limit_price };
    order.quantity = quantity;
    order.pending_quantity = Math.max(0, quantity - order.filled_quantity);
    order.updated_at = this.clock.now();
    return clone(await this.refresh(order));
  }

  async getOrder(clientOrderId: string): Promise<BrokerOrder | undefined> {
    this.ensureEnabled();
    const order = this.orders.get(clientOrderId);
    if (!order) return undefined;
    return clone(await this.refresh(order));
  }

  async listOrders(): Promise<BrokerOrder[]> {
    this.ensureEnabled();
    const raw = await this.call(() => this.transport.listOrders());
    return raw.map((item) => {
      const clientId = this.clientByBroker.get(item.order_id) ?? `KITE_ORPHAN:${item.order_id}`;
      const known = this.orders.get(clientId);
      const normalized = normalizeKiteOrder(item, known, this.clock.now());
      if (known) this.orders.set(clientId, normalized);
      return clone(normalized);
    });
  }

  async adoptOrder(intent: IBoxOrderIntent, snapshot: BrokerOrder): Promise<BrokerOrder> {
    this.ensureEnabled();
    if (!snapshot.broker_order_id ||
      (intent.broker_order_id !== null && snapshot.broker_order_id !== intent.broker_order_id)) {
      throw new Error("Cannot adopt a broker order without matching durable broker identity.");
    }
    const immutableMatches =
      snapshot.exchange === intent.exchange &&
      snapshot.tradingsymbol === intent.tradingsymbol &&
      snapshot.side === intent.side &&
      snapshot.quantity === intent.quantity &&
      (!intent.broker_tag || !snapshot.tag || snapshot.tag === intent.broker_tag) &&
      snapshot.limit_price === intent.limit_price;
    if (!immutableMatches) {
      throw new Error(`Broker order ${snapshot.broker_order_id} does not match durable immutable intent fields.`);
    }
    const alreadyOwned = this.clientByBroker.get(snapshot.broker_order_id);
    if (alreadyOwned && alreadyOwned !== intent.client_order_id) {
      throw new Error(`Broker order ${snapshot.broker_order_id} is already attributed to ${alreadyOwned}.`);
    }
    const brokerOrderId = snapshot.broker_order_id;
    const adopted: BrokerOrder = {
      ...snapshot,
      client_order_id: intent.client_order_id,
      broker_order_id: brokerOrderId,
      tag: intent.broker_tag ?? snapshot.tag,
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
      fills: snapshot.fills.map((fill) => ({ ...fill })),
    };
    this.orders.set(intent.client_order_id, adopted);
    this.clientByBroker.set(brokerOrderId, intent.client_order_id);
    return clone(adopted);
  }

  async listPositions(): Promise<BrokerPosition[]> {
    this.ensureEnabled();
    const positions = await this.call(() => this.transport.listPositions());
    return positions.map((position) => ({
      token: position.instrument_token ?? 0,
      exchange: position.exchange,
      tradingsymbol: position.tradingsymbol,
      net_quantity: position.quantity,
      average_price: position.average_price,
    }));
  }

  async margins(): Promise<BrokerMargin | null> {
    this.ensureEnabled();
    return this.transport.margins ? this.call(() => this.transport.margins!()) : null;
  }

  async health(): Promise<BrokerHealth> {
    if (!this.isEnabled()) {
      return {
        ok: false,
        transport: "disabled",
        authenticated: false,
        message: "Kite live adapter is disabled by execution mode or kill switch.",
        checked_at: this.clock.now(),
      };
    }
    return this.transport.health
      ? this.call(() => this.transport.health!())
      : {
          ok: true,
          transport: "unknown",
          authenticated: true,
          message: null,
          checked_at: this.clock.now(),
        };
  }

  private async waitForResolution(order: BrokerOrder): Promise<BrokerOrder> {
    const started = this.clock.now();
    let partialAt: number | null = null;
    while (!isBrokerOrderTerminal(order.state)) {
      const elapsed = this.clock.now() - started;
      const deadline = order.state === "ACKNOWLEDGED"
        ? this.config.ackTimeoutMs
        : this.config.workingTimeoutMs;
      if (elapsed >= deadline || (partialAt !== null && this.clock.now() - partialAt >= this.config.partialTimeoutMs)) {
        return clone(await this.protectiveCancelAndConfirm(order));
      }
      await this.clock.wait(Math.max(1, this.config.brokerMinIntervalMs));
      order = await this.refresh(order);
      if (order.state === "PARTIALLY_FILLED" && partialAt === null) partialAt = this.clock.now();
    }
    return clone(order);
  }

  private async protectiveCancelAndConfirm(order: BrokerOrder): Promise<BrokerOrder> {
    if (!order.broker_order_id || isBrokerOrderTerminal(order.state)) return order;
    order.state = "CANCEL_REQUESTED";
    order.updated_at = this.clock.now();
    this.mark(order.client_order_id, "cancel_requested");
    try {
      await withDeadline(
        this.call(() => this.transport.cancelOrder(order.broker_order_id as string)),
        this.config.cancelTimeoutMs,
        "Protective cancellation timed out.",
      );
      this.mark(order.client_order_id, "cancel_acknowledged");
      return await this.confirmTerminalAfterCancel(order);
    } catch (error) {
      order.state = "RECONCILIATION_REQUIRED";
      order.updated_at = this.clock.now();
      throw new BrokerAmbiguousSubmitError(
        order.client_order_id,
        "Protective cancellation could not establish terminal cumulative quantity; order is quarantined.",
        error,
        clone(order),
      );
    }
  }

  private async confirmTerminalAfterCancel(order: BrokerOrder): Promise<BrokerOrder> {
    const deadline = this.clock.now() + this.config.cancelTimeoutMs;
    while (this.clock.now() <= deadline) {
      order = await this.refresh(order);
      if (isBrokerOrderTerminal(order.state)) return order;
      await this.clock.wait(Math.max(1, this.config.brokerMinIntervalMs));
    }
    order.state = "RECONCILIATION_REQUIRED";
    order.updated_at = this.clock.now();
    throw new BrokerAmbiguousSubmitError(
      order.client_order_id,
      "Cancellation was acknowledged locally but broker terminal quantity remains uncertain.",
      undefined,
      clone(order),
    );
  }

  private async refresh(order: BrokerOrder): Promise<BrokerOrder> {
    if (!order.broker_order_id) return order;
    const raw = await this.call(() => this.transport.getOrder(order.broker_order_id as string));
    if (!raw) {
      order.state = "UNKNOWN";
      order.updated_at = this.clock.now();
      return order;
    }
    const normalized = normalizeKiteOrder(raw, order, this.clock.now());
    // TIMING: the broker's CUMULATIVE quantity. The recorder ignores anything that is not an
    // increase, so re-polling an unchanged order does not manufacture extra "fill" events.
    this.markFill(order.client_order_id, normalized.filled_quantity);
    this.orders.set(order.client_order_id, normalized);
    return normalized;
  }

  /**
   * Mark a timing stage. FAIL-OPEN and silent when instrumentation is off or the order has no
   * trace — a metrics failure must never be able to interfere with an order, least of all a
   * cancel.
   */
  private mark(clientOrderId: string, stage: Parameters<ExecutionTimingRecorder["mark"]>[1]): void {
    try {
      this.config.timing?.mark(clientOrderId, stage);
    } catch {
      /* telemetry must never affect execution */
    }
  }

  /** Record an observed cumulative filled quantity. Fail-open. */
  private markFill(clientOrderId: string, cumulativeQty: number): void {
    try {
      this.config.timing?.markFill(clientOrderId, cumulativeQty);
    } catch {
      /* telemetry must never affect execution */
    }
  }

  private isEnabled(): boolean {
    return this.config.executionMode === "live" && this.config.enabled === true;
  }

  private ensureEnabled(): void {
    if (!this.isEnabled()) throw new BrokerDisabledError();
  }

  private call<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.transportTail.then(async () => {
      const wait = this.config.brokerMinIntervalMs - (this.clock.now() - this.lastTransportAt);
      if (wait > 0) await this.clock.wait(wait);
      this.lastTransportAt = this.clock.now();
      return operation();
    });
    // Keep the pacing chain alive after failures without hiding the caller's error.
    this.transportTail = run.then(() => undefined, () => undefined);
    return run;
  }
}

export function stableKiteTag(clientOrderId: string, requested?: string): string {
  const safe = requested?.replace(/[^A-Za-z0-9]/g, "").slice(0, 20);
  if (safe) return safe;
  let hash = 0x811c9dc5;
  for (const char of clientOrderId) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return `BOX${(hash >>> 0).toString(36).toUpperCase()}`.slice(0, 20);
}

export function classifyKiteReject(error: unknown): BrokerRejectFamily {
  const message = errorMessage(error).toLowerCase();
  if (/margin|funds|cash/.test(message)) return "margin";
  if (/price.*band|circuit|range/.test(message)) return "price_band";
  if (/instrument|contract|token|scrip.*not/.test(message)) return "instrument_unavailable";
  if (/market.*clos|exchange.*clos|outside.*hour/.test(message)) return "market_closed";
  if (/rate.*limit|too many|429/.test(message)) return "rate_limit";
  if (/\brms\b|risk management/.test(message)) return "rms";
  if (/quantity|freeze|lot size/.test(message)) return "quantity_freeze";
  if (/auth|token|permission|401|403/.test(message)) return "auth";
  return "generic";
}

function normalizeKiteOrder(raw: KiteTransportOrder, known: BrokerOrder | undefined, now: number): BrokerOrder {
  const state = kiteState(raw.status, raw.filled_quantity, raw.quantity);
  const base = known ?? {
    client_order_id: `KITE_ORPHAN:${raw.order_id}`,
    broker_order_id: raw.order_id,
    tag: raw.tag,
    role: "k1_ce" as const,
    trade_id: null,
    attempt_id: "orphan",
    purpose: "PROTECTIVE_CANCEL" as const,
    phase: "unwind" as const,
    exchange: raw.exchange,
    tradingsymbol: raw.tradingsymbol,
    token: 0,
    side: raw.transaction_type,
    quantity: raw.quantity,
    pricing: {
      order_type: "LIMIT" as const,
      reference_price: raw.price > 0 ? raw.price : 0.05,
      tick_size: 0.05,
      max_chase_ticks: 0,
      limit_price: raw.price > 0 ? raw.price : 0.05,
    },
    limit_price: raw.price,
    state,
    filled_quantity: 0,
    pending_quantity: raw.quantity,
    average_price: null,
    fills: [],
    reject_family: null,
    reject_reason: null,
    created_at: parseTime(raw.order_timestamp) ?? now,
    updated_at: now,
  };
  return {
    ...base,
    broker_order_id: raw.order_id,
    tag: raw.tag ?? base.tag,
    state,
    quantity: raw.quantity,
    pricing: { ...base.pricing, limit_price: raw.price },
    limit_price: raw.price,
    filled_quantity: raw.filled_quantity,
    pending_quantity: raw.pending_quantity,
    average_price: raw.filled_quantity > 0 ? raw.average_price : null,
    fills: raw.filled_quantity > 0 ? [{
      fill_id: `kite:${raw.order_id}:${raw.filled_quantity}:${raw.average_price}`,
      quantity: raw.filled_quantity,
      price: raw.average_price,
      at: parseTime(raw.exchange_update_timestamp) ?? now,
    }] : [],
    reject_family: state === "REJECTED" ? classifyKiteReject(raw.status_message ?? raw.status) : null,
    reject_reason: state === "REJECTED" ? raw.status_message ?? raw.status : null,
    updated_at: parseTime(raw.exchange_update_timestamp) ?? now,
  };
}

function kiteState(status: string, filled: number, quantity: number): BrokerOrderState {
  const value = status.trim().toUpperCase();
  if (value === "COMPLETE") return "COMPLETE";
  if (value.includes("CANCEL")) return "CANCELLED";
  if (value.includes("REJECT")) return "REJECTED";
  if (filled > 0 && filled < quantity) return "PARTIALLY_FILLED";
  if (value === "OPEN" || value.includes("TRIGGER PENDING")) return "OPEN";
  if (value.includes("VALIDATION") || value.includes("PUT ORDER")) return "ACKNOWLEDGED";
  return "UNKNOWN";
}

function requestOrder(req: BrokerOrderRequest, now: number): BrokerOrder {
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

function clone(order: BrokerOrder): BrokerOrder {
  return {
    ...order,
    pricing: { ...order.pricing },
    fills: order.fills.map((fill) => ({ ...fill })),
  };
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stringValues(input: Record<string, string | number>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, String(value)]));
}

function numericPath(input: Record<string, unknown>, parent: string, child: string): number | null {
  const nested = input[parent];
  if (!nested || typeof nested !== "object") return null;
  const value = (nested as Record<string, unknown>)[child];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseTime(value: string | null): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDefinitivePlacementRejection(error: unknown): boolean {
  return error instanceof KiteHttpError && error.status >= 400 && error.status < 500 && error.status !== 429;
}

function isTimeoutLike(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /timeout|timed out/i.test(error.message));
}
