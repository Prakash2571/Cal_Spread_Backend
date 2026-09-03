/**
 * Dhan live order transport, implementing the EXISTING `BrokerAdapter` interface.
 *
 * Deliberately a sibling of `kiteBrokerAdapter.ts`, not a new strategy: the same
 * `BoxOrderManager`, the same durable intents, the same bounded marketable-LIMIT
 * envelope, the same reconciliation state machine. Only the transport changes.
 *
 * FOUR THINGS THIS FILE IS RESPONSIBLE FOR GETTING RIGHT
 *
 *  1. NEVER an unrestricted MARKET order. Every request carries a bounded LIMIT
 *     envelope and `assertBoundedLimit` is enforced before anything is sent. Dhan
 *     supports MARKET orders; a four-leg box must not use them.
 *
 *  2. NEVER a blind re-submit. If POST /orders fails ambiguously (timeout, 5xx,
 *     429) the order may be live. The adapter reconciles by CORRELATION ID before
 *     concluding anything, because a second POST is how a box grows a fifth leg.
 *
 *  3. FAIL CLOSED on static IP. Dhan requires the caller's public IP to be
 *     whitelisted for order placement. When that is not satisfied the adapter
 *     refuses locally rather than discovering it mid-box.
 *
 *  4. HONEST STATE. Anything the adapter cannot prove is terminal becomes
 *     RECONCILIATION_REQUIRED, never a guessed COMPLETE or CANCELLED.
 *
 * PRODUCT TYPE is `MARGIN` — Dhan's F&O carry-forward product, the analogue of
 * Kite's `NRML`. `INTRADAY` would expose the box to auto-square-off.
 */

import {
  assertBoundedLimit,
  BrokerAmbiguousSubmitError,
  BrokerDisabledError,
  BrokerOrderRejectedError,
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
import type { IBoxOrderIntent } from "./types.js";
import {
  DhanAuthError,
  DhanError,
  DhanNetworkError,
  DhanRateLimitError,
  DhanTradingBlockedError,
} from "../brokers/dhan/errors.js";
import {
  dhanCorrelationId,
  isValidDhanCorrelationId,
} from "../brokers/dhan/correlation.js";
import type {
  DhanClient,
  DhanOrder,
  DhanOrderStatus,
  DhanPosition,
  DhanTrade,
} from "../brokers/dhan/client.js";
import type { DhanExchangeSegment } from "../brokers/dhan/segments.js";

export interface DhanAdapterConfig {
  /** Live only when the execution mode is live AND the deployment kill switch is on. */
  executionMode: BoxConfig["executionMode"];
  enabled: boolean;
  /**
   * Whether Dhan's static-IP requirement is satisfied.
   *
   * A FUNCTION, not a boolean: readiness can change while the process runs, and a
   * value captured at construction would let a box start after the check went bad.
   */
  staticIpReady: () => boolean;
  ackTimeoutMs: number;
  workingTimeoutMs: number;
  partialTimeoutMs: number;
  cancelTimeoutMs: number;
  brokerMinIntervalMs: number;
  maxModifications: number;
  maxChaseTicks: number;
  dhanClientId: () => string;
  /** Internal token → Dhan (segment, securityId). */
  identify: (token: number) => { segment: DhanExchangeSegment; securityId: number } | null;
}

export function dhanAdapterConfigFromBoxConfig(
  cfg: BoxConfig,
  deps: {
    staticIpReady: () => boolean;
    dhanClientId: () => string;
    identify: (token: number) => { segment: DhanExchangeSegment; securityId: number } | null;
  },
): DhanAdapterConfig {
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
    ...deps,
  };
}

/**
 * Map Dhan's order status onto Calspread's `BrokerOrderState`.
 *
 * `filled`/`quantity` are consulted because Dhan reports `TRADED` for a fully
 * executed order but a partially filled one can appear as `PENDING` with a non-zero
 * filled quantity — trusting the label alone would treat a half-filled leg as
 * merely working, and the box's exposure accounting would be wrong.
 *
 * An UNRECOGNISED status becomes UNKNOWN, never a guess: the order manager knows how
 * to reconcile UNKNOWN, and inventing COMPLETE would fabricate a fill.
 */
export function dhanOrderState(
  status: DhanOrderStatus | string,
  filled: number,
  quantity: number,
): BrokerOrderState {
  const value = String(status ?? "").trim().toUpperCase();
  switch (value) {
    case "TRANSIT":
      // Accepted by Dhan, not yet acknowledged by the exchange.
      return "ACKNOWLEDGED";
    case "PENDING":
      // Working at the exchange — but a partial fill can also present as PENDING.
      return filled > 0 && filled < quantity ? "PARTIALLY_FILLED" : "OPEN";
    case "PART_TRADED":
      // Explicitly partial. If it has since completed, report COMPLETE.
      return filled >= quantity && quantity > 0 ? "COMPLETE" : "PARTIALLY_FILLED";
    case "TRADED":
      // Fully executed. Guard against a TRADED label with a short fill.
      return quantity > 0 && filled > 0 && filled < quantity ? "PARTIALLY_FILLED" : "COMPLETE";
    case "CANCELLED":
    case "CLOSED":
      return "CANCELLED";
    case "REJECTED":
      return "REJECTED";
    case "EXPIRED":
      // Validity lapsed without full execution. A partial fill still stands, so the
      // remainder is effectively cancelled rather than rejected.
      return filled > 0 && filled < quantity ? "PARTIALLY_FILLED" : "CANCELLED";
    default:
      return "UNKNOWN";
  }
}

/**
 * Classify a Dhan rejection into the existing reject families.
 *
 * Prefers Dhan's `omsErrorCode` and falls back to the description, because a code is
 * stable while free text is not. The families drive risk decisions (a margin
 * rejection means stop; a price-band rejection means re-price), so `generic` is the
 * honest answer when nothing matches rather than a plausible-sounding guess.
 */
export function classifyDhanReject(code: string | null, description: string | null): BrokerRejectFamily {
  const text = `${code ?? ""} ${description ?? ""}`.toLowerCase();
  if (/margin|insufficient|fund|balance/.test(text)) return "margin";
  if (/price band|circuit|dpr|price range|freeze price/.test(text)) return "price_band";
  if (/quantity freeze|freeze quantity|max.*quantity|qty freeze/.test(text)) return "quantity_freeze";
  if (/not permitted|not allowed|rms|risk/.test(text)) return "rms";
  if (/market clos|outside market|trading session|not open/.test(text)) return "market_closed";
  if (/instrument|security|symbol|contract.*not|invalid securityid/.test(text)) return "instrument_unavailable";
  if (/rate limit|too many/.test(text)) return "rate_limit";
  if (/token|unauthor|forbidden|session|invalid.*access/.test(text)) return "auth";
  return "generic";
}

/** Epoch ms from a Dhan timestamp string, or a fallback. */
function parseDhanTime(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback;
  // Dhan sends local IST timestamps without a zone; assume IST rather than UTC,
  // otherwise every order looks 5h30m old.
  const direct = Date.parse(value);
  if (Number.isFinite(direct)) return direct;
  const withZone = Date.parse(`${value.replace(" ", "T")}+05:30`);
  return Number.isFinite(withZone) ? withZone : fallback;
}

export class DhanBrokerAdapter implements BrokerAdapter {
  readonly mode = "live" as const;
  /** Session-local identity maps, exactly as the Kite adapter keeps. */
  private readonly orders = new Map<string, BrokerOrder>();
  private readonly clientByBroker = new Map<string, string>();
  private readonly clientByCorrelation = new Map<string, string>();
  private readonly modifications = new Map<string, number>();
  private transportTail: Promise<unknown> = Promise.resolve();
  private lastTransportAt = 0;

  constructor(
    private readonly client: DhanClient,
    private readonly cfg: DhanAdapterConfig,
  ) {}

  /** The correlation id for a client order id (also usable by callers/tests). */
  correlationFor(clientOrderId: string): string {
    return dhanCorrelationId(clientOrderId);
  }

  /**
   * Both gates, exactly like the Kite adapter: a disabled instance makes ZERO
   * broker calls, including reads.
   */
  private isEnabled(): boolean {
    return this.cfg.executionMode === "live" && this.cfg.enabled;
  }

  private ensureEnabled(): void {
    if (!this.isEnabled()) {
      throw new BrokerDisabledError("Dhan live broker adapter is disabled.");
    }
  }

  /**
   * FAIL CLOSED on the static-IP requirement, for MUTATIONS only.
   *
   * Dhan refuses order placement/modification/cancellation from a non-whitelisted
   * IP. Checking locally means the box never gets half-built before discovering it,
   * and the operator sees the real reason instead of a generic broker error.
   *
   * Reads are deliberately NOT gated: market data and order lookups work without it,
   * and blocking them would prevent the very reconciliation needed to recover.
   */
  private ensureTradingReady(): void {
    this.ensureEnabled();
    if (!this.cfg.staticIpReady()) {
      throw new DhanTradingBlockedError(
        "Dhan live execution blocked: the server's static public IP is not whitelisted for order placement. " +
          "Whitelist it in the Dhan API dashboard, or set DHAN_STATIC_IP_EXPECTED to confirm it is configured.",
      );
    }
  }

  /** Serialized, self-paced transport (one broker call at a time). */
  private async call<T>(op: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const gap = this.cfg.brokerMinIntervalMs - (Date.now() - this.lastTransportAt);
      if (gap > 0) await sleep(gap);
      this.lastTransportAt = Date.now();
      return op();
    };
    const scheduled = this.transportTail.then(run, run);
    this.transportTail = scheduled.catch(() => undefined);
    return scheduled;
  }

  /** Attach the deterministic correlation id. Pure — no transport. */
  prepareOrder(req: BrokerOrderRequest): BrokerOrderRequest {
    const correlation = this.correlationFor(req.client_order_id);
    if (!isValidDhanCorrelationId(correlation)) {
      // Refuse rather than send something Dhan will mangle: a truncated correlation
      // id would break reconciliation, which is the one thing that must not fail.
      throw new Error(`Derived Dhan correlationId "${correlation}" is invalid for ${req.client_order_id}.`);
    }
    return { ...req, tag: correlation };
  }

  async submitOrder(req: BrokerOrderRequest): Promise<BrokerOrder> {
    this.ensureTradingReady();
    // Bounded LIMIT, always. This is what stops Box from ever placing a MARKET order.
    assertBoundedLimit(req, this.cfg.maxChaseTicks);

    // In-session idempotency: an already-known client id returns its current state
    // rather than producing a second order.
    const existing = this.orders.get(req.client_order_id);
    if (existing) return cloneOrder(existing);

    const identity = this.cfg.identify(req.token);
    if (!identity) {
      throw new Error(`No Dhan security id for token ${req.token} (${req.tradingsymbol}).`);
    }
    const correlationId = this.correlationFor(req.client_order_id);
    const order = fromRequest(req, Date.now(), correlationId);
    order.state = "SUBMITTING";
    this.orders.set(req.client_order_id, order);
    this.clientByCorrelation.set(correlationId, req.client_order_id);

    let placed: { orderId: string; orderStatus: DhanOrderStatus } | null = null;
    try {
      placed = await this.call(() =>
        this.client.placeOrder({
          dhanClientId: this.cfg.dhanClientId(),
          correlationId,
          transactionType: req.side,
          exchangeSegment: identity.segment,
          // F&O carry-forward. NOT INTRADAY, which would be auto-squared-off.
          productType: "MARGIN",
          orderType: "LIMIT",
          validity: "DAY",
          securityId: String(identity.securityId),
          quantity: req.quantity,
          price: req.pricing.limit_price,
        }),
      );
    } catch (err) {
      // A DEFINITIVE 4xx (not 429) means Dhan understood and refused.
      if (err instanceof DhanError && err.isDefinitive && !(err instanceof DhanRateLimitError)) {
        order.state = "REJECTED";
        order.reject_family = err instanceof DhanAuthError ? "auth" : classifyDhanReject(err.code, err.message);
        order.reject_reason = err.message;
        order.updated_at = Date.now();
        this.orders.set(req.client_order_id, order);
        throw new BrokerOrderRejectedError(cloneOrder(order), err);
      }

      // AMBIGUOUS. The order may be live. Reconcile by correlation id — never
      // re-POST. This is the single most important branch in this file.
      const reconciled = await this.reconcileByCorrelation(req, correlationId).catch(() => null);
      if (reconciled) {
        this.orders.set(req.client_order_id, reconciled);
        if (reconciled.broker_order_id) {
          this.clientByBroker.set(reconciled.broker_order_id, req.client_order_id);
        }
        // The order DOES exist; carry on with its real state.
        return this.waitForResolution(req.client_order_id, reconciled);
      }
      // Could not prove either way: quarantine for the durable reconciler.
      order.state = "RECONCILIATION_REQUIRED";
      order.reject_reason = err instanceof Error ? err.message : String(err);
      order.updated_at = Date.now();
      this.orders.set(req.client_order_id, order);
      throw new BrokerAmbiguousSubmitError(
        req.client_order_id,
        `Dhan order submission outcome is unknown and correlation lookup did not resolve it: ${order.reject_reason}`,
        err,
        cloneOrder(order),
      );
    }

    if (!placed?.orderId) {
      // A 200 with no order id is ambiguous too, and gets the same treatment.
      const reconciled = await this.reconcileByCorrelation(req, correlationId).catch(() => null);
      if (reconciled) {
        this.orders.set(req.client_order_id, reconciled);
        return this.waitForResolution(req.client_order_id, reconciled);
      }
      order.state = "RECONCILIATION_REQUIRED";
      order.reject_reason = "Dhan accepted the request but returned no orderId.";
      this.orders.set(req.client_order_id, order);
      throw new BrokerAmbiguousSubmitError(req.client_order_id, order.reject_reason, placed, cloneOrder(order));
    }

    order.broker_order_id = placed.orderId;
    order.state = dhanOrderState(placed.orderStatus, 0, req.quantity);
    order.updated_at = Date.now();
    this.clientByBroker.set(placed.orderId, req.client_order_id);
    this.orders.set(req.client_order_id, order);

    if (order.state === "REJECTED") {
      order.reject_family = "generic";
      order.reject_reason = `Dhan rejected the order at submission (status ${placed.orderStatus}).`;
      throw new BrokerOrderRejectedError(cloneOrder(order), placed);
    }
    return this.waitForResolution(req.client_order_id, order);
  }

  /**
   * Ask Dhan whether our correlation id exists — the anti-duplicate primitive.
   *
   * Returns the projected order when Dhan knows it, or null when Dhan reports no
   * such order (meaning the submission genuinely never landed).
   */
  private async reconcileByCorrelation(
    req: BrokerOrderRequest,
    correlationId: string,
  ): Promise<BrokerOrder | null> {
    const found = await this.call(() => this.client.getOrderByCorrelationId(correlationId));
    if (!found) return null;
    const fills = await this.fetchFills(found.orderId);
    return this.project(req, found, correlationId, fills);
  }

  /** Poll until terminal, then protectively cancel if the deadline passes. */
  private async waitForResolution(clientOrderId: string, initial: BrokerOrder): Promise<BrokerOrder> {
    let current = initial;
    const startedAt = Date.now();
    let firstPartialAt: number | null = current.filled_quantity > 0 ? startedAt : null;

    // Hard iteration cap in addition to the wall-clock deadlines. A broker that keeps
    // answering "still working" without the clock advancing as expected must not be
    // able to spin this loop indefinitely and wedge the order path.
    const maxPolls = Math.max(
      10,
      Math.ceil((this.cfg.workingTimeoutMs + this.cfg.partialTimeoutMs) / Math.max(1, this.cfg.brokerMinIntervalMs)) + 10,
    );
    let polls = 0;

    while (!isBrokerOrderTerminal(current.state)) {
      if (++polls > maxPolls) {
        // Out of budget without a terminal answer: quarantine rather than guess.
        return this.protectiveCancelAndConfirm(clientOrderId, current);
      }
      const elapsed = Date.now() - startedAt;
      const ackDeadlineHit = current.state === "ACKNOWLEDGED" && elapsed > this.cfg.ackTimeoutMs;
      const workingDeadlineHit = elapsed > this.cfg.workingTimeoutMs;
      const partialDeadlineHit =
        firstPartialAt !== null && Date.now() - firstPartialAt > this.cfg.partialTimeoutMs;

      if (ackDeadlineHit || workingDeadlineHit || partialDeadlineHit) {
        return this.protectiveCancelAndConfirm(clientOrderId, current);
      }
      await sleep(this.cfg.brokerMinIntervalMs);
      const refreshed = await this.refresh(clientOrderId);
      if (!refreshed) break;
      current = refreshed;
      if (current.filled_quantity > 0 && firstPartialAt === null) firstPartialAt = Date.now();
    }
    return cloneOrder(current);
  }

  /**
   * Cancel, then CONFIRM the terminal state.
   *
   * A cancel request is not a cancellation: the order can fill in the same instant.
   * So the state is only accepted once Dhan reports something terminal; otherwise the
   * order is quarantined as RECONCILIATION_REQUIRED rather than assumed cancelled.
   */
  private async protectiveCancelAndConfirm(
    clientOrderId: string,
    current: BrokerOrder,
  ): Promise<BrokerOrder> {
    const order = this.orders.get(clientOrderId) ?? current;
    if (order.broker_order_id) {
      order.state = "CANCEL_REQUESTED";
      order.updated_at = Date.now();
      this.orders.set(clientOrderId, order);
      try {
        await this.call(() => this.client.cancelOrder(order.broker_order_id!));
      } catch (err) {
        // A cancel that fails does not make the order gone; keep confirming.
        console.warn(`[Dhan] protective cancel failed for ${clientOrderId}:`, err);
      }
    }
    const deadline = Date.now() + this.cfg.cancelTimeoutMs;
    const maxConfirmPolls = Math.max(
      5,
      Math.ceil(this.cfg.cancelTimeoutMs / Math.max(1, this.cfg.brokerMinIntervalMs)) + 5,
    );
    let confirmPolls = 0;
    while (Date.now() < deadline && confirmPolls < maxConfirmPolls) {
      confirmPolls++;
      await sleep(this.cfg.brokerMinIntervalMs);
      const refreshed = await this.refresh(clientOrderId);
      if (refreshed && isBrokerOrderTerminal(refreshed.state)) return cloneOrder(refreshed);
    }
    const quarantined = this.orders.get(clientOrderId) ?? order;
    quarantined.state = "RECONCILIATION_REQUIRED";
    quarantined.reject_reason =
      "Dhan did not confirm a terminal state after a protective cancel within the deadline.";
    quarantined.updated_at = Date.now();
    this.orders.set(clientOrderId, quarantined);
    return cloneOrder(quarantined);
  }

  /** Re-read one order and update the session projection. */
  private async refresh(clientOrderId: string): Promise<BrokerOrder | undefined> {
    const known = this.orders.get(clientOrderId);
    if (!known) return undefined;
    try {
      const remote = known.broker_order_id
        ? await this.call(() => this.client.getOrder(known.broker_order_id!))
        : await this.call(() => this.client.getOrderByCorrelationId(this.correlationFor(clientOrderId)));
      if (!remote) return known;
      const fills = await this.fetchFills(remote.orderId);
      const projected = this.project(known, remote, known.tag ?? this.correlationFor(clientOrderId), fills);
      this.orders.set(clientOrderId, projected);
      if (projected.broker_order_id) this.clientByBroker.set(projected.broker_order_id, clientOrderId);
      return projected;
    } catch (err) {
      if (err instanceof DhanAuthError) throw err;
      // A transient read failure must not rewrite state.
      return known;
    }
  }

  /**
   * Per-fill detail from the trade book.
   *
   * Best-effort: an order's aggregate quantity/average price is already authoritative
   * for exposure, so a trade-book hiccup degrades fill granularity rather than
   * blocking the order. Returns [] on failure.
   */
  private async fetchFills(orderId: string): Promise<DhanTrade[]> {
    try {
      return await this.call(() => this.client.getTradesForOrder(orderId));
    } catch {
      return [];
    }
  }

  /** Project a Dhan order (+ fills) onto the broker-neutral shape. */
  private project(
    template: Pick<
      BrokerOrder | BrokerOrderRequest,
      "client_order_id" | "role" | "trade_id" | "attempt_id" | "purpose" | "phase" | "exchange" | "tradingsymbol" | "token" | "side" | "quantity" | "pricing"
    >,
    remote: DhanOrder,
    correlationId: string,
    fills: DhanTrade[],
  ): BrokerOrder {
    const now = Date.now();
    const quantity = template.quantity;
    const filled = numberOr(remote.filledQty, 0);
    const remaining = remote.remainingQuantity !== undefined
      ? numberOr(remote.remainingQuantity, Math.max(0, quantity - filled))
      : Math.max(0, quantity - filled);
    const state = dhanOrderState(remote.orderStatus, filled, quantity);
    const rejected = state === "REJECTED";

    return {
      client_order_id: template.client_order_id,
      broker_order_id: remote.orderId ?? null,
      tag: correlationId,
      role: template.role,
      trade_id: template.trade_id,
      attempt_id: template.attempt_id,
      purpose: template.purpose,
      phase: template.phase,
      exchange: template.exchange,
      tradingsymbol: remote.tradingSymbol || template.tradingsymbol,
      token: template.token,
      side: template.side,
      quantity,
      pricing: { ...template.pricing },
      limit_price: template.pricing.limit_price,
      state,
      filled_quantity: filled,
      pending_quantity: remaining,
      average_price: numberOrNull(remote.averageTradedPrice),
      fills: fills.length > 0
        ? fills.map((t, index) => ({
            fill_id: t.exchangeTradeId
              ? `dhan:${t.exchangeTradeId}`
              : `dhan:${remote.orderId}:${index}:${t.tradedQuantity}:${t.tradedPrice}`,
            quantity: numberOr(t.tradedQuantity, 0),
            price: numberOr(t.tradedPrice, 0),
            at: parseDhanTime(t.exchangeTime ?? t.updateTime ?? t.createTime, now),
          }))
        // No trade-book detail: synthesize ONE aggregate fill so exposure is still
        // exact, matching how the Kite adapter behaves.
        : filled > 0
          ? [{
              fill_id: `dhan:${remote.orderId}:${filled}:${numberOr(remote.averageTradedPrice, 0)}`,
              quantity: filled,
              price: numberOr(remote.averageTradedPrice, 0),
              at: parseDhanTime(remote.exchangeTime ?? remote.updateTime, now),
            }]
          : [],
      reject_family: rejected
        ? classifyDhanReject(remote.omsErrorCode ?? null, remote.omsErrorDescription ?? null)
        : null,
      reject_reason: rejected
        ? remote.omsErrorDescription ?? remote.omsErrorCode ?? "Dhan rejected the order."
        : null,
      created_at: parseDhanTime(remote.createTime, now),
      updated_at: parseDhanTime(remote.updateTime ?? remote.exchangeTime, now),
    };
  }

  async cancelOrder(clientOrderId: string): Promise<BrokerOrder | undefined> {
    this.ensureTradingReady();
    const known = this.orders.get(clientOrderId);
    if (!known) return undefined;
    if (isBrokerOrderTerminal(known.state)) return cloneOrder(known);
    return this.protectiveCancelAndConfirm(clientOrderId, known);
  }

  async modifyOrder(clientOrderId: string, request: BrokerModifyRequest): Promise<BrokerOrder> {
    this.ensureTradingReady();
    const known = this.orders.get(clientOrderId);
    if (!known) throw new Error(`Unknown Dhan order ${clientOrderId}.`);
    if (!known.broker_order_id) throw new Error(`Dhan order ${clientOrderId} has no broker id yet.`);

    // The modification cap is a safety limit on chasing, not a suggestion.
    const used = this.modifications.get(clientOrderId) ?? 0;
    if (used >= this.cfg.maxModifications) {
      throw new Error(
        `Dhan order ${clientOrderId} has reached its modification cap (${this.cfg.maxModifications}).`,
      );
    }
    // Re-validate the new price inside the ORIGINAL bounded envelope, so a
    // modification cannot walk the limit outside the configured chase band.
    assertBoundedLimit(
      {
        ...known,
        pricing: { ...known.pricing, limit_price: request.limit_price },
        quantity: request.quantity ?? known.quantity,
      } as BrokerOrderRequest,
      this.cfg.maxChaseTicks,
    );

    this.modifications.set(clientOrderId, used + 1);
    await this.call(() =>
      this.client.modifyOrder({
        dhanClientId: this.cfg.dhanClientId(),
        orderId: known.broker_order_id!,
        orderType: "LIMIT",
        price: request.limit_price,
        ...(request.quantity !== undefined ? { quantity: request.quantity } : {}),
        validity: "DAY",
      }),
    );
    known.pricing = { ...known.pricing, limit_price: request.limit_price };
    known.limit_price = request.limit_price;
    known.updated_at = Date.now();
    this.orders.set(clientOrderId, known);
    const refreshed = await this.refresh(clientOrderId);
    return cloneOrder(refreshed ?? known);
  }

  async getOrder(clientOrderId: string): Promise<BrokerOrder | undefined> {
    this.ensureEnabled();
    const refreshed = await this.refresh(clientOrderId);
    return refreshed ? cloneOrder(refreshed) : undefined;
  }

  async listOrders(): Promise<BrokerOrder[]> {
    this.ensureEnabled();
    const remote = await this.call(() => this.client.listOrders());
    const out: BrokerOrder[] = [];
    for (const order of remote) {
      const clientId =
        (order.correlationId && this.clientByCorrelation.get(order.correlationId)) ??
        this.clientByBroker.get(order.orderId);
      const known = clientId ? this.orders.get(clientId) : undefined;
      if (known) {
        const projected = this.project(known, order, known.tag ?? "", []);
        this.orders.set(known.client_order_id, projected);
        out.push(cloneOrder(projected));
        continue;
      }
      // An order this session did not create. Surfaced with an explicit ORPHAN
      // identity so reconciliation can see it rather than silently ignoring
      // exposure that might be ours from a previous process.
      out.push(orphanOrder(order));
    }
    return out;
  }

  async listPositions(): Promise<BrokerPosition[]> {
    this.ensureEnabled();
    const remote = await this.call(() => this.client.listPositions());
    return remote
      .map((p) => normalizePosition(p, this.cfg.identify))
      .filter((p): p is BrokerPosition => p !== null && p.net_quantity !== 0);
  }

  /**
   * Adopt an order after a restart, re-binding durable identity to this session.
   *
   * Refuses on any immutable mismatch, exactly like the Kite adapter: adopting an
   * order that is not the one the intent describes would attribute someone else's
   * fills to this box.
   */
  async adoptOrder(intent: IBoxOrderIntent, snapshot: BrokerOrder): Promise<BrokerOrder> {
    this.ensureEnabled();
    if (intent.broker_order_id && snapshot.broker_order_id && intent.broker_order_id !== snapshot.broker_order_id) {
      throw new Error(
        `Refusing to adopt ${intent.client_order_id}: broker id ${snapshot.broker_order_id} does not match the durable intent's ${intent.broker_order_id}.`,
      );
    }
    if (
      snapshot.exchange !== intent.exchange ||
      snapshot.tradingsymbol !== intent.tradingsymbol ||
      snapshot.side !== intent.side ||
      snapshot.quantity !== intent.quantity
    ) {
      throw new Error(
        `Refusing to adopt ${intent.client_order_id}: the broker order does not match the durable intent.`,
      );
    }
    if (snapshot.broker_order_id) {
      const attributed = this.clientByBroker.get(snapshot.broker_order_id);
      if (attributed && attributed !== intent.client_order_id) {
        throw new Error(
          `Refusing to adopt ${intent.client_order_id}: broker order ${snapshot.broker_order_id} is already attributed to ${attributed}.`,
        );
      }
    }
    const correlation = intent.broker_correlation_id ?? this.correlationFor(intent.client_order_id);
    const adopted: BrokerOrder = {
      ...snapshot,
      client_order_id: intent.client_order_id,
      tag: correlation,
      pricing: {
        order_type: "LIMIT",
        reference_price: intent.reference_price,
        tick_size: intent.tick_size,
        max_chase_ticks: intent.max_chase_ticks,
        limit_price: intent.limit_price,
      },
      limit_price: intent.limit_price,
    };
    this.orders.set(intent.client_order_id, adopted);
    if (adopted.broker_order_id) this.clientByBroker.set(adopted.broker_order_id, intent.client_order_id);
    this.clientByCorrelation.set(correlation, intent.client_order_id);
    return cloneOrder(adopted);
  }

  async margins(): Promise<BrokerMargin | null> {
    this.ensureEnabled();
    try {
      const funds = await this.call(() => this.client.getFundLimit());
      return {
        available: numberOrNull(funds.availabelBalance),
        utilised: numberOrNull(funds.utilizedAmount),
      };
    } catch {
      return null;
    }
  }

  async health(): Promise<BrokerHealth> {
    const checkedAt = Date.now();
    if (!this.isEnabled()) {
      return { ok: false, transport: "disabled", authenticated: false, message: "Dhan live adapter is disabled.", checked_at: checkedAt };
    }
    try {
      await this.call(() => this.client.getProfile());
      // Authenticated, but trading is a SEPARATE readiness question.
      const staticIpReady = this.cfg.staticIpReady();
      return {
        ok: staticIpReady,
        transport: "up",
        authenticated: true,
        message: staticIpReady
          ? null
          : "Dhan session is live but the static public IP is not whitelisted, so order placement is blocked.",
        checked_at: checkedAt,
      };
    } catch (err) {
      const authFailed = err instanceof DhanAuthError;
      return {
        ok: false,
        transport: err instanceof DhanNetworkError ? "down" : "unknown",
        authenticated: !authFailed,
        message: err instanceof Error ? err.message : String(err),
        checked_at: checkedAt,
      };
    }
  }
}

/** Net position, normalized. Dhan reports buy/sell legs plus a signed net. */
export function normalizePosition(
  p: DhanPosition,
  identify: (token: number) => { segment: DhanExchangeSegment; securityId: number } | null,
): BrokerPosition | null {
  const securityId = Number(p.securityId);
  if (!Number.isFinite(securityId)) return null;
  const net = numberOr(p.netQty, 0);
  // Dhan's average is side-specific; use the side that is actually open.
  const average = net > 0 ? numberOr(p.buyAvg, 0) : net < 0 ? numberOr(p.sellAvg, 0) : 0;
  // The internal token is recovered from Dhan's own identifiers so it matches what
  // the instrument store produced. `identify` is accepted for symmetry/testing.
  void identify;
  return {
    token: securityId,
    exchange: p.exchangeSegment === "NSE_FNO" ? "NFO" : p.exchangeSegment,
    tradingsymbol: p.tradingSymbol,
    net_quantity: net,
    average_price: average,
  };
}

function fromRequest(req: BrokerOrderRequest, now: number, correlationId: string): BrokerOrder {
  return {
    client_order_id: req.client_order_id,
    broker_order_id: null,
    tag: correlationId,
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

function orphanOrder(order: DhanOrder): BrokerOrder {
  const now = Date.now();
  const quantity = numberOr(order.quantity, 0);
  const filled = numberOr(order.filledQty, 0);
  return {
    client_order_id: `DHAN_ORPHAN:${order.orderId}`,
    broker_order_id: order.orderId,
    tag: order.correlationId ?? null,
    role: "k1_ce",
    trade_id: null,
    attempt_id: `dhan-orphan-${order.orderId}`,
    purpose: "PROTECTIVE_CANCEL",
    phase: "entry",
    exchange: order.exchangeSegment === "NSE_FNO" ? "NFO" : order.exchangeSegment,
    tradingsymbol: order.tradingSymbol,
    token: Number(order.securityId) || 0,
    side: order.transactionType,
    quantity,
    pricing: {
      order_type: "LIMIT",
      reference_price: numberOr(order.price, 0) || 0.05,
      tick_size: 0.05,
      max_chase_ticks: 0,
      limit_price: numberOr(order.price, 0) || 0.05,
    },
    limit_price: numberOr(order.price, 0),
    state: dhanOrderState(order.orderStatus, filled, quantity),
    filled_quantity: filled,
    pending_quantity: Math.max(0, quantity - filled),
    average_price: numberOrNull(order.averageTradedPrice),
    fills: [],
    reject_family: null,
    reject_reason: null,
    created_at: parseDhanTime(order.createTime, now),
    updated_at: parseDhanTime(order.updateTime, now),
  };
}

function cloneOrder(order: BrokerOrder): BrokerOrder {
  return { ...order, pricing: { ...order.pricing }, fills: order.fills.map((f) => ({ ...f })) };
}

function numberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
