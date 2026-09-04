import {
  BrokerAmbiguousSubmitError,
  BrokerOrderRejectedError,
  isBrokerOrderTerminal,
  type BrokerAdapter,
  type BrokerOrder,
  type BrokerOrderRequest,
  type BrokerOrderState,
} from "./brokerAdapter.js";
import type { BoxConfig } from "./config.js";
import { BOX_ORDER_PRIORITY } from "./executionSchedulingPolicy.js";
import type {
  BoxOrderIntentAudit,
  BoxOrderIntentPatch,
  BoxOrderIntentState,
  BoxOrderPurpose,
  BoxLegRole,
  IBoxOrderIntent,
  ResidualLegExposure,
} from "./types.js";

export interface OrderIntentUpdateResult {
  intent: IBoxOrderIntent | null;
  applied: boolean;
}

export interface OrderIntentPersistence {
  create(intent: IBoxOrderIntent): Promise<IBoxOrderIntent>;
  update(
    clientOrderId: string,
    patch: BoxOrderIntentPatch,
    audit: BoxOrderIntentAudit,
  ): Promise<OrderIntentUpdateResult>;
  loadNonterminal(): Promise<IBoxOrderIntent[]>;
  loadOwned?(): Promise<IBoxOrderIntent[]>;
  findByClientId(clientOrderId: string): Promise<IBoxOrderIntent | null>;
  findByBrokerId(brokerOrderId: string): Promise<IBoxOrderIntent | null>;
}

/**
 * The broker owns this fill, but Mongo could not accept its terminal snapshot.
 * Carrying the broker snapshot prevents callers from accidentally treating the
 * rejected promise as an unfilled order and dropping irreversible exposure.
 */
export class OrderPersistenceAfterFillError extends Error {
  constructor(
    readonly order: BrokerOrder,
    readonly causeValue: unknown,
  ) {
    super(`Persistence failed after confirmed fill ${order.client_order_id}.`);
    this.name = "OrderPersistenceAfterFillError";
  }
}

export interface OrderManagerControls {
  entryEnabled: boolean;
  liveOrderEnabled: boolean;
  emergencyFlatten: boolean;
}

export interface OrderManagerHealth {
  persistence: "healthy" | "unhealthy" | "unknown";
  daily_risk_seed: "healthy" | "seeding" | "failed" | "unknown";
  broker_auth: "healthy" | "unhealthy" | "disabled" | "unknown";
  broker_orders_api: "healthy" | "unhealthy" | "disabled" | "unknown";
  broker_positions_api: "healthy" | "unhealthy" | "disabled" | "unknown";
  reconciliation: "idle" | "running" | "failed";
  reconciliation_complete: boolean;
  feed: "healthy" | "warming" | "unhealthy" | "unknown";
  circuit: "closed" | "open";
}

export interface OrderManagerStatus {
  controls: OrderManagerControls;
  health: OrderManagerHealth;
  circuitBreaker: { tripped: boolean; reason: string | null; at: number | null };
  inFlight: number;
  queued: number;
  reservedEntryQuantity: number;
  reservedReductionQuantity: number;
  unknownOrders: number;
  recoveryActive: boolean;
  safeAttributedReductionReady: boolean;
  tradingDay: string;
  rejects: number;
  consecutiveFailures: number;
  realisedPnlToday: number;
  residualLegs: number;
  openBoxes: number;
  orphanOrders: BrokerOrder[];
  lastReconciledAt: number | null;
}

export interface OrderManagerLimits {
  maxOpenBoxes: number;
  maxConcurrentExecutions: number;
  maxResidualLegs: number;
  dailyLossLimit: number;
  rejectLimit: number;
  consecutiveFailureLimit: number;
  maxOpenLegQuantity: number;
  maxGrossOpenLegQuantity: number;
  reconcileIntervalMs: number;
  feedReconnectWarmupMs: number;
}

export function orderManagerLimitsFromConfig(cfg: BoxConfig): OrderManagerLimits {
  return {
    maxOpenBoxes: cfg.liveMaxOpenBoxes,
    maxConcurrentExecutions: cfg.liveMaxConcurrentExecutions,
    maxResidualLegs: cfg.liveMaxResidualLegs,
    dailyLossLimit: cfg.liveDailyLossLimit,
    rejectLimit: cfg.liveRejectLimit,
    consecutiveFailureLimit: cfg.liveConsecutiveFailureLimit,
    maxOpenLegQuantity: cfg.liveMaxOpenLegQuantity,
    maxGrossOpenLegQuantity: cfg.liveMaxGrossOpenLegQuantity,
    reconcileIntervalMs: cfg.liveReconcileIntervalMs,
    feedReconnectWarmupMs: cfg.liveFeedReconnectWarmupMs,
  };
}

export interface OrderManagerReconcileReport {
  matched: number;
  missingAtBroker: string[];
  orphanOrders: BrokerOrder[];
  positions: Awaited<ReturnType<BrokerAdapter["listPositions"]>>;
  positionMismatches: Array<{ symbol: string; expected: number; actual: number }>;
  affectedTradeIds: string[];
  remainingByTrade: Record<string, Partial<Record<BoxLegRole, number>>>;
}

interface SubmitQueueAction {
  kind: "submit";
  request: BrokerOrderRequest;
  resolve: (order: BrokerOrder) => void;
  reject: (error: unknown) => void;
  sequence: number;
}

interface CancelQueueAction {
  kind: "cancel";
  intent: IBoxOrderIntent;
  resolve: (order: BrokerOrder | undefined) => void;
  reject: (error: unknown) => void;
  sequence: number;
}

type QueueAction = SubmitQueueAction | CancelQueueAction;

// The scheduling priority is defined once, in executionSchedulingPolicy, and shared with
// the paper live_parity scheduler so the two can never drift. Same values, same ordering
// the manager has always used — this is a source move, not a behaviour change.
const PRIORITY = BOX_ORDER_PRIORITY;

const RECONCILE_STATES: ReadonlySet<BrokerOrderState> = new Set([
  "UNKNOWN",
  "RECONCILIATION_REQUIRED",
]);

function queuePriority(action: QueueAction): number {
  return action.kind === "cancel" ? PRIORITY.PROTECTIVE_CANCEL : PRIORITY[action.request.purpose];
}

/**
 * Durable, broker-neutral order coordinator. It intentionally knows no strategy
 * arithmetic: the engine integration can supply qualified requests later while
 * this layer owns identity, persistence-before-submit, safety controls and
 * reconciliation.
 */
export class BoxOrderManager {
  private controls: OrderManagerControls;
  private health: OrderManagerHealth = {
    persistence: "unknown",
    daily_risk_seed: "unknown",
    broker_auth: "unknown",
    broker_orders_api: "unknown",
    broker_positions_api: "unknown",
    reconciliation: "idle",
    reconciliation_complete: false,
    feed: "unknown",
    circuit: "closed",
  };
  private readonly queue: QueueAction[] = [];
  private readonly fillIdentities = new Set<string>();
  private readonly activeClientIds = new Set<string>();
  private readonly knownIntents = new Map<string, IBoxOrderIntent>();
  private orphanOrders: BrokerOrder[] = [];
  private sequence = 0;
  private inFlight = 0;
  private rejects = 0;
  private consecutiveFailures = 0;
  private realisedPnlToday = 0;
  private residualLegs = 0;
  private openBoxes = 0;
  private grossOpenLegQuantity = 0;
  private reservedEntryQuantity = 0;
  private reservedReductionQuantity = 0;
  private readonly reservations = new Map<string, number>();
  private readonly reductionReservations = new Map<string, { symbol: string; quantity: number }>();
  private readonly reservedReductionsBySymbol = new Map<string, number>();
  private unknownOrders = 0;
  private recoveryActive = false;
  private safeAttributedReductionReady = false;
  private tradingDay: string;
  private readonly attributedBoxPositions = new Map<string, number>();
  private feedHealthy = false;
  private feedWarmUntil = Number.POSITIVE_INFINITY;
  private breakerReason: string | null = null;
  private breakerAt: number | null = null;
  private reconcilePromise: Promise<OrderManagerReconcileReport> | null = null;
  private dailyRiskSeedPromise: Promise<void> | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private lastReconciledAt: number | null = null;

  constructor(
    private readonly deps: {
      adapter: BrokerAdapter;
      persistence: OrderIntentPersistence;
      limits: OrderManagerLimits;
      controls?: Partial<OrderManagerControls>;
      clock?: { now: () => number };
      istDayKey?: (at: number) => string;
      onPersistenceLossAfterFill?: (order: BrokerOrder, error: unknown) => void;
      onReconciliationIssue?: (report: OrderManagerReconcileReport) => void | Promise<void>;
      loadDailyRiskSeed?: (tradingDay: string) => Promise<{ realisedPnl: number; rejects: number; consecutiveFailures: number }>;
      onCircuitTrip?: (reason: string) => void;
    },
  ) {
    this.tradingDay = this.dayKey();
    this.controls = {
      entryEnabled: deps.controls?.entryEnabled ?? false,
      liveOrderEnabled: deps.controls?.liveOrderEnabled ?? false,
      emergencyFlatten: deps.controls?.emergencyFlatten ?? false,
    };
  }

  /** Reconcile immediately at startup and keep retrying at a low-frequency cadence. */
  async start(): Promise<OrderManagerReconcileReport> {
    // Arm the retry loop before the first pass: a transient startup failure must
    // not silently disable reconciliation for the rest of the process lifetime.
    if (!this.disposed && this.reconcileTimer === null) {
      this.reconcileTimer = setInterval(() => {
        void this.reconcile().catch(() => undefined);
      }, Math.max(5_000, this.deps.limits.reconcileIntervalMs));
      this.reconcileTimer.unref?.();
    }
    return this.reconcile();
  }

  setControls(patch: Partial<OrderManagerControls>): void {
    this.controls = { ...this.controls, ...patch };
  }

  /** Seed durable/reconciled counters before entry is allowed. */
  seedLimits(args: {
    tradingDay: string;
    realisedPnlToday?: number;
    rejects?: number;
    consecutiveFailures?: number;
    openBoxes?: number;
    residualLegs?: number;
  }): void {
    this.tradingDay = args.tradingDay;
    this.realisedPnlToday = Number.isFinite(args.realisedPnlToday) ? args.realisedPnlToday! : 0;
    this.rejects = Math.max(0, Math.floor(args.rejects ?? 0));
    this.consecutiveFailures = Math.max(0, Math.floor(args.consecutiveFailures ?? 0));
    this.openBoxes = Math.max(0, Math.floor(args.openBoxes ?? 0));
    this.residualLegs = Math.max(0, Math.floor(args.residualLegs ?? 0));
    this.health.daily_risk_seed = "healthy";
    this.evaluateLimits();
  }

  invariantViolation(reason: string): void {
    this.recoveryActive = true;
    this.trip(`execution invariant violation: ${reason}`);
    void this.reconcile().catch(() => undefined);
  }

  setExposure(args: {
    openBoxes?: number;
    residualLegs?: number;
    grossOpenLegQuantity?: number;
  }): void {
    if (args.openBoxes !== undefined) this.openBoxes = Math.max(0, Math.floor(args.openBoxes));
    if (args.residualLegs !== undefined) this.residualLegs = Math.max(0, Math.floor(args.residualLegs));
    if (args.grossOpenLegQuantity !== undefined) {
      this.grossOpenLegQuantity = Math.max(0, Math.floor(args.grossOpenLegQuantity));
    }
    this.evaluateLimits();
  }

  /**
   * Seed signed positions that the caller has already attributed to durable BOX
   * trades/intents. Raw account positions must never be passed here.
   */
  setAttributedBoxPositions(
    positions: Awaited<ReturnType<BrokerAdapter["listPositions"]>>,
  ): void {
    this.attributedBoxPositions.clear();
    for (const position of positions) {
      this.attributedBoxPositions.set(
        `${position.exchange}:${position.tradingsymbol}`,
        position.net_quantity,
      );
    }
    this.recalculateGrossAttributedQuantity();
  }

  /**
   * Exact net exposure attributable to durable BOX intents/open projections.
   * Callers may use this for recovery flattening only after reconciliation; raw
   * account positions and tag-only orphans are intentionally absent.
   */
  attributedRecoveryExposure(): ResidualLegExposure[] {
    const out: ResidualLegExposure[] = [];
    for (const [symbol, net] of this.attributedBoxPositions) {
      if (net === 0) continue;
      const intent = [...this.knownIntents.values()].find(
        (candidate) => `${candidate.exchange}:${candidate.tradingsymbol}` === symbol,
      );
      if (!intent) continue;
      out.push({
        token: intent.token,
        tradingsymbol: intent.tradingsymbol,
        exchange: intent.exchange,
        role: intent.role,
        side: net > 0 ? "BUY" : "SELL",
        quantity: Math.abs(net),
        average_price: intent.average_price ?? intent.reference_price,
        source: "partial_entry",
        created_at: intent.updated_at.getTime(),
      });
    }
    return out;
  }

  setFeedHealthy(healthy: boolean): void {
    const now = this.now();
    if (healthy && !this.feedHealthy) this.feedWarmUntil = now + this.deps.limits.feedReconnectWarmupMs;
    if (!healthy) this.feedWarmUntil = Number.POSITIVE_INFINITY;
    this.feedHealthy = healthy;
    this.health.feed = !healthy ? "unhealthy" : now < this.feedWarmUntil ? "warming" : "healthy";
  }

  recordRealisedPnl(delta: number): void {
    if (!Number.isFinite(delta)) return;
    this.realisedPnlToday += delta;
    this.evaluateLimits();
  }

  canEnter(request?: BrokerOrderRequest): boolean {
    this.rollTradingDay();
    this.refreshFeedHealth();
    if (this.disposed || this.breakerReason !== null) return false;
    if (!this.controls.entryEnabled || !this.controls.liveOrderEnabled) return false;
    if (this.health.persistence !== "healthy" || this.health.daily_risk_seed !== "healthy" || !this.health.reconciliation_complete) return false;
    if (this.health.broker_auth !== "healthy" ||
        this.health.broker_orders_api !== "healthy" ||
        this.health.broker_positions_api !== "healthy") return false;
    if (this.unknownOrders > 0 || this.recoveryActive) return false;
    if (!this.feedHealthy || this.now() < this.feedWarmUntil) return false;
    if (this.openBoxes >= this.deps.limits.maxOpenBoxes) return false;
    if (this.residualLegs > this.deps.limits.maxResidualLegs) return false;
    if (request && !this.withinQuantityLimits(request)) return false;
    // Concurrency is enforced by the priority queue's pump. Do not reject the
    // remaining role-orders of the SAME Box pipeline merely because its first
    // role is currently at the broker; those requests must queue so one live Box
    // can submit all four bounded orders under a max-concurrency value of one.
    return true;
  }

  canManageExposure(): boolean {
    return !this.disposed && this.controls.liveOrderEnabled;
  }

  canSafelyReduceAttributedExposure(): boolean {
    return this.canManageExposure() && this.safeAttributedReductionReady;
  }

  submit(request: BrokerOrderRequest): Promise<BrokerOrder> {
    if (request.purpose === "ENTRY" && !this.canEnter(request)) {
      return Promise.reject(new Error("OrderManager entry controls or limits are closed."));
    }
    if (request.purpose !== "ENTRY" && !this.canManageExposure()) {
      return Promise.reject(new Error("OrderManager exposure management is disabled."));
    }
    if (!this.withinQuantityLimits(request)) {
      return Promise.reject(new Error("Order exceeds configured live leg quantity limits."));
    }
    if (this.activeClientIds.has(request.client_order_id)) {
      return Promise.reject(new Error(`Order ${request.client_order_id} is already queued or active.`));
    }
    this.activeClientIds.add(request.client_order_id);
    if (request.purpose === "ENTRY") {
      this.reservations.set(request.client_order_id, request.quantity);
      this.reservedEntryQuantity += request.quantity;
    } else if (request.purpose !== "PROTECTIVE_CANCEL") {
      const symbol = `${request.exchange}:${request.tradingsymbol}`;
      this.reductionReservations.set(request.client_order_id, { symbol, quantity: request.quantity });
      this.reservedReductionsBySymbol.set(symbol, (this.reservedReductionsBySymbol.get(symbol) ?? 0) + request.quantity);
      this.reservedReductionQuantity += request.quantity;
    }
    return new Promise<BrokerOrder>((resolve, reject) => {
      this.queue.push({ kind: "submit", request, resolve, reject, sequence: this.sequence++ });
      this.sortQueue();
      this.pump();
    });
  }

  async cancelWorkingBoxOrders(): Promise<BrokerOrder[]> {
    if (!this.canManageExposure()) return [];
    const intents = await this.deps.persistence.loadNonterminal();
    const cancelled: BrokerOrder[] = [];
    for (const intent of intents) {
      // Only durable BOX intents are eligible. Never cancel arbitrary broker orders.
      if (!intent.client_order_id.startsWith("BOX:")) continue;
      const order = await this.enqueueCancel(intent);
      if (order) cancelled.push(order);
    }
    return cancelled;
  }

  reconcile(): Promise<OrderManagerReconcileReport> {
    this.rollTradingDay();
    if (this.health.daily_risk_seed !== "healthy") this.refreshDailyRiskSeed();
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = this.performReconcile().finally(() => {
      this.reconcilePromise = null;
    });
    return this.reconcilePromise;
  }

  status(): OrderManagerStatus {
    this.rollTradingDay();
    this.refreshFeedHealth();
    return {
      controls: { ...this.controls },
      health: { ...this.health },
      circuitBreaker: {
        tripped: this.breakerReason !== null,
        reason: this.breakerReason,
        at: this.breakerAt,
      },
      inFlight: this.inFlight,
      queued: this.queue.length,
      reservedEntryQuantity: this.reservedEntryQuantity,
      reservedReductionQuantity: this.reservedReductionQuantity,
      unknownOrders: this.unknownOrders,
      recoveryActive: this.recoveryActive,
      safeAttributedReductionReady: this.safeAttributedReductionReady,
      tradingDay: this.tradingDay,
      rejects: this.rejects,
      consecutiveFailures: this.consecutiveFailures,
      realisedPnlToday: this.realisedPnlToday,
      residualLegs: this.residualLegs,
      openBoxes: this.openBoxes,
      orphanOrders: this.orphanOrders.map(cloneOrder),
      lastReconciledAt: this.lastReconciledAt,
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    for (const action of this.queue.splice(0)) {
      if (action.kind === "submit") {
        this.activeClientIds.delete(action.request.client_order_id);
        this.releaseReservation(action.request.client_order_id);
      }
      action.reject(new Error("OrderManager disposed before broker action."));
    }
  }

  private enqueueCancel(intent: IBoxOrderIntent): Promise<BrokerOrder | undefined> {
    return new Promise((resolve, reject) => {
      this.queue.push({ kind: "cancel", intent, resolve, reject, sequence: this.sequence++ });
      this.sortQueue();
      this.pump();
    });
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => queuePriority(a) - queuePriority(b) || a.sequence - b.sequence);
  }

  private pump(): void {
    while (
      !this.disposed &&
      this.queue.length > 0 &&
      this.inFlight < this.deps.limits.maxConcurrentExecutions
    ) {
      const action = this.queue.shift();
      if (!action) return;
      const blocked = this.queuedActionBlockReason(action);
      if (blocked) {
        if (action.kind === "submit") {
          this.activeClientIds.delete(action.request.client_order_id);
          this.releaseReservation(action.request.client_order_id);
        }
        action.reject(new Error(blocked));
        continue;
      }
      this.inFlight++;
      const execution = action.kind === "submit"
        ? this.execute(action)
        : this.executeCancel(action);
      void execution.finally(() => {
        this.inFlight--;
        if (action.kind === "submit") {
          const known = this.knownIntents.get(action.request.client_order_id);
          if (!known || !RECONCILE_STATES.has(known.state)) {
            this.releaseReservation(action.request.client_order_id);
          }
          this.activeClientIds.delete(action.request.client_order_id);
        }
        this.pump();
      });
    }
  }

  /** Re-check mutable gates at the last safe point before any broker mutation. */
  private queuedActionBlockReason(action: QueueAction): string | null {
    if (action.kind === "cancel") {
      return this.canManageExposure() ? null : "OrderManager exposure management was disabled while cancellation was queued.";
    }
    const { request } = action;
    if (request.purpose === "ENTRY") {
      if (!this.canEnter()) return "OrderManager entry controls or limits closed while order was queued.";
      if (request.quantity > this.deps.limits.maxOpenLegQuantity ||
          this.grossOpenLegQuantity + this.reservedEntryQuantity > this.deps.limits.maxGrossOpenLegQuantity) {
        return "Order exceeded live quantity limits while queued.";
      }
      return null;
    }
    if (!this.canManageExposure()) {
      return "OrderManager exposure management was disabled while order was queued.";
    }
    if (request.purpose === "PROTECTIVE_CANCEL") return null;
    const symbol = `${request.exchange}:${request.tradingsymbol}`;
    const net = this.attributedBoxPositions.get(symbol) ?? 0;
    const correctSide = (net > 0 && request.side === "SELL") || (net < 0 && request.side === "BUY");
    const reserved = this.reservedReductionsBySymbol.get(symbol) ?? 0;
    return request.quantity <= this.deps.limits.maxOpenLegQuantity && correctSide && reserved <= Math.abs(net)
      ? null
      : "Attributed exposure changed while reduction was queued.";
  }

  private async executeCancel(action: CancelQueueAction): Promise<void> {
    try {
      const order = await this.deps.adapter.cancelOrder(action.intent.client_order_id);
      if (order) await this.persistOrder(action.intent, order, "protective cancel reconciliation");
      action.resolve(order);
    } catch (error) {
      action.reject(error);
    }
  }

  private async execute(action: SubmitQueueAction): Promise<void> {
    const request = this.deps.adapter.prepareOrder?.(action.request) ?? action.request;
    let intent = intentFromRequest(request, this.deps.adapter.mode, this.now());
    try {
      intent = await this.deps.persistence.create(intent);
      const persistedRequest = requestFromIntent(intent);
      this.knownIntents.set(intent.client_order_id, intent);
      this.health.persistence = "healthy";
      if (intent.state !== "CREATED") {
        // A prior submission exists. Reconcile it; never blindly resubmit.
        const reconciled = await this.deps.adapter.getOrder(request.client_order_id);
        if (!reconciled) throw new Error("Existing durable intent requires reconciliation before resubmit.");
        await this.persistOrder(intent, reconciled, "existing intent reconciled before resubmit");
        action.resolve(reconciled);
        return;
      }
      intent = await this.transition(intent, "SUBMITTING", null, "transport submission starting");

      let order: BrokerOrder;
      try {
        order = await this.deps.adapter.submitOrder(persistedRequest);
      } catch (error) {
        if (error instanceof BrokerOrderRejectedError) {
          await this.persistOrder(intent, error.order, "broker rejected order");
          this.rejects++;
          this.noteFailure("broker rejected order");
          this.evaluateLimits();
          action.reject(error);
          return;
        }
        if (error instanceof BrokerAmbiguousSubmitError || isTimeoutLike(error) || !(error instanceof BrokerOrderRejectedError)) {
          if (error instanceof BrokerAmbiguousSubmitError && error.order) {
            await this.persistOrder(intent, error.order, error.message);
          } else {
            await this.transition(
              intent,
              "RECONCILIATION_REQUIRED",
              null,
              errorMessage(error),
            );
          }
          this.unknownOrders++;
          this.noteFailure("ambiguous broker submission");
          action.reject(error);
          return;
        }
        const rejected = await this.transition(intent, "REJECTED", null, errorMessage(error));
        this.knownIntents.set(rejected.client_order_id, rejected);
        this.rejects++;
        this.noteFailure("broker rejected order");
        this.evaluateLimits();
        action.reject(error);
        return;
      }

      if (RECONCILE_STATES.has(order.state)) {
        await this.persistOrder(intent, order, "adapter returned uncertain state; no retry");
        this.noteFailure("adapter returned uncertain order state");
      } else {
        await this.persistOrder(intent, order, "adapter order snapshot");
        if (order.state === "REJECTED") {
          this.rejects++;
          this.noteFailure("broker rejected order");
        } else if (order.state === "COMPLETE") {
          this.consecutiveFailures = 0;
        }
      }
      this.evaluateLimits();
      action.resolve(order);
    } catch (error) {
      this.health.persistence = "unhealthy";
      this.noteFailure("order intent persistence failure");
      action.reject(error);
    }
  }

  private async performReconcile(): Promise<OrderManagerReconcileReport> {
    this.health.reconciliation = "running";
    this.safeAttributedReductionReady = false;
    try {
      let loadedNonterminalIntents: IBoxOrderIntent[];
      let loadedOwnedIntents: IBoxOrderIntent[];
      try {
        loadedNonterminalIntents = await this.deps.persistence.loadNonterminal();
        loadedOwnedIntents = this.deps.persistence.loadOwned
          ? await this.deps.persistence.loadOwned()
          : loadedNonterminalIntents;
        this.health.persistence = "healthy";
      } catch (error) {
        this.health.persistence = "unhealthy";
        throw error;
      }
      const nonterminalByClient = new Map(
        loadedNonterminalIntents.map((intent) => [intent.client_order_id, intent]),
      );
      const ownedByClient = new Map(
        loadedOwnedIntents.map((intent) => [intent.client_order_id, intent]),
      );
      for (const intent of loadedOwnedIntents) this.knownIntents.set(intent.client_order_id, intent);
      const brokerHealth = await (this.deps.adapter.health?.() ?? Promise.resolve(null));
      this.health.broker_auth = brokerHealth === null || brokerHealth.authenticated ? "healthy" : "unhealthy";
      let brokerOrders: BrokerOrder[];
      try {
        brokerOrders = await this.deps.adapter.listOrders();
        this.health.broker_orders_api = "healthy";
      } catch (error) {
        this.health.broker_orders_api = "unhealthy";
        throw error;
      }
      let positions: Awaited<ReturnType<BrokerAdapter["listPositions"]>>;
      try {
        positions = await this.deps.adapter.listPositions();
        this.health.broker_positions_api = "healthy";
      } catch (error) {
        this.health.broker_positions_api = "unhealthy";
        throw error;
      }
      const byClient = ownedByClient;
      const byBroker = new Map(
        loadedOwnedIntents
          .filter((intent): intent is IBoxOrderIntent & { broker_order_id: string } => Boolean(intent.broker_order_id))
          .map((intent) => [intent.broker_order_id, intent]),
      );
      // A tag is attribution-safe only when exactly one durable intent owns it.
      const byTag = new Map<string, IBoxOrderIntent | null>();
      for (const intent of loadedOwnedIntents) {
        if (!intent.broker_tag) continue;
        byTag.set(intent.broker_tag, byTag.has(intent.broker_tag) ? null : intent);
      }
      const matchedClients = new Set<string>();
      const matchCounts = new Map<string, number>();
      const affectedTradeIds = new Set<string>();
      const identityMismatchSymbols = new Set<string>();
      const orphans: BrokerOrder[] = [];
      const ownedLookingOrphans: BrokerOrder[] = [];
      let matched = 0;

      for (const order of brokerOrders) {
        // Attribution is safe only through durable client/broker identity. A BOX tag
        // alone can classify an orphan, but never authorises flattening/cancellation.
        const intent = byClient.get(order.client_order_id) ??
          (order.broker_order_id ? byBroker.get(order.broker_order_id) : undefined) ??
          (order.tag ? byTag.get(order.tag) ?? undefined : undefined);
        if (!intent) {
          orphans.push(order);
          if (order.client_order_id.startsWith("BOX:") || order.tag?.startsWith("BOX")) {
            ownedLookingOrphans.push(order);
            this.recoveryActive = true;
            this.trip(`unattributed BOX-looking broker order ${order.broker_order_id ?? order.client_order_id}`);
          }
          continue;
        }
        const count = (matchCounts.get(intent.client_order_id) ?? 0) + 1;
        matchCounts.set(intent.client_order_id, count);
        if (count > 1) {
          if (intent.trade_id) affectedTradeIds.add(intent.trade_id);
          this.recoveryActive = true;
          this.trip(`multiple broker orders matched durable intent ${intent.client_order_id}`);
          continue;
        }
        matchedClients.add(intent.client_order_id);
        matched++;
        try {
          const attributed = this.deps.adapter.adoptOrder
            ? await this.deps.adapter.adoptOrder(intent, order)
            : { ...order, client_order_id: intent.client_order_id };
          const updated = await this.persistOrder(intent, attributed, "broker reconciliation snapshot");
          ownedByClient.set(updated.client_order_id, updated);
          if (isBrokerOrderTerminal(updated.state)) nonterminalByClient.delete(updated.client_order_id);
          else nonterminalByClient.set(updated.client_order_id, updated);
        } catch (error) {
          if (intent.trade_id) affectedTradeIds.add(intent.trade_id);
          identityMismatchSymbols.add(`${intent.exchange}:${intent.tradingsymbol}`);
          this.recoveryActive = true;
          this.trip(`broker identity/attribute mismatch for ${intent.client_order_id}: ${errorMessage(error)}`);
        }
      }

      const missingAtBroker: string[] = [];
      for (const intent of loadedNonterminalIntents) {
        if (matchedClients.has(intent.client_order_id)) continue;
        missingAtBroker.push(intent.client_order_id);
        if (intent.trade_id) affectedTradeIds.add(intent.trade_id);
        if (intent.state !== "CREATED") {
          const updated = await this.transition(
            intent,
            "RECONCILIATION_REQUIRED",
            intent.broker_order_id,
            "durable nonterminal intent not found in broker order list; no resubmit",
          );
          nonterminalByClient.set(updated.client_order_id, updated);
          ownedByClient.set(updated.client_order_id, updated);
        }
        this.recoveryActive = true;
        this.trip(`durable nonterminal intent missing at broker: ${intent.client_order_id}`);
      }

      const reconciledNonterminalIntents = [...nonterminalByClient.values()];
      const reconciledOwnedIntents = [...ownedByClient.values()];
      if (this.lastReconciledAt === null) {
        this.reservations.clear();
        this.reservedEntryQuantity = 0;
        this.reductionReservations.clear();
        this.reservedReductionsBySymbol.clear();
        this.reservedReductionQuantity = 0;
        for (const intent of reconciledNonterminalIntents) {
          const remaining = Math.max(0, intent.quantity - intent.filled_quantity);
          if (remaining === 0) continue;
          if (intent.purpose === "ENTRY") {
            this.reservations.set(intent.client_order_id, remaining);
            this.reservedEntryQuantity += remaining;
          } else if (intent.purpose !== "PROTECTIVE_CANCEL") {
            const symbol = `${intent.exchange}:${intent.tradingsymbol}`;
            this.reductionReservations.set(intent.client_order_id, { symbol, quantity: remaining });
            this.reservedReductionsBySymbol.set(symbol, (this.reservedReductionsBySymbol.get(symbol) ?? 0) + remaining);
            this.reservedReductionQuantity += remaining;
          }
        }
      }

      const intentNetBySymbol = new Map<string, number>();
      const tradeRoleNet = new Map<string, number>();
      const ownedSymbols = new Set<string>();
      for (const intent of reconciledOwnedIntents) {
        const symbol = `${intent.exchange}:${intent.tradingsymbol}`;
        ownedSymbols.add(symbol);
        if (intent.filled_quantity <= 0) continue;
        const delta = (intent.side === "BUY" ? 1 : -1) * intent.filled_quantity;
        intentNetBySymbol.set(symbol, (intentNetBySymbol.get(symbol) ?? 0) + delta);
        if (intent.trade_id) {
          const tradeRole = `${intent.trade_id}:${intent.role}`;
          tradeRoleNet.set(tradeRole, (tradeRoleNet.get(tradeRole) ?? 0) + delta);
        }
      }
      const remainingByTrade: Record<string, Partial<Record<BoxLegRole, number>>> = {};
      for (const intent of reconciledOwnedIntents) {
        if (!intent.trade_id) continue;
        const roles = remainingByTrade[intent.trade_id] ?? {};
        roles[intent.role] = Math.abs(tradeRoleNet.get(`${intent.trade_id}:${intent.role}`) ?? 0);
        remainingByTrade[intent.trade_id] = roles;
      }
      // The complete live-intent journal is authoritative for every symbol it has
      // ever owned, including an exact zero. Open trade docs remain the authority
      // only for legacy/projected symbols with no live intent history.
      for (const symbol of ownedSymbols) {
        this.attributedBoxPositions.set(symbol, intentNetBySymbol.get(symbol) ?? 0);
      }
      this.recalculateGrossAttributedQuantity();
      const positionMismatches: Array<{ symbol: string; expected: number; actual: number }> = [];
      for (const symbol of identityMismatchSymbols) {
        positionMismatches.push({
          symbol,
          expected: this.attributedBoxPositions.get(symbol) ?? 0,
          actual: Number.NaN,
        });
      }
      const brokerBySymbol = new Map(
        positions.map((position) => [`${position.exchange}:${position.tradingsymbol}`, position.net_quantity]),
      );
      const allSymbols = new Set([...this.attributedBoxPositions.keys(), ...brokerBySymbol.keys()]);
      for (const symbol of allSymbols) {
        const expected = this.attributedBoxPositions.get(symbol) ?? 0;
        const actual = brokerBySymbol.get(symbol) ?? 0;
        if (expected !== actual && (expected !== 0 || ownedSymbols.has(symbol))) {
          positionMismatches.push({ symbol, expected, actual });
          for (const intent of reconciledOwnedIntents) {
            if (`${intent.exchange}:${intent.tradingsymbol}` === symbol && intent.trade_id) affectedTradeIds.add(intent.trade_id);
          }
          this.recoveryActive = true;
          this.trip(`broker-position mismatch for attributed Box symbol ${symbol}: expected ${expected}, actual ${actual}`);
        }
      }
      this.unknownOrders = reconciledNonterminalIntents.filter((intent) => RECONCILE_STATES.has(intent.state)).length;
      for (const intent of reconciledNonterminalIntents) {
        if (RECONCILE_STATES.has(intent.state) && intent.trade_id) affectedTradeIds.add(intent.trade_id);
      }
      this.orphanOrders = orphans.map(cloneOrder);
      this.safeAttributedReductionReady = missingAtBroker.length === 0 &&
        ownedLookingOrphans.length === 0 && this.unknownOrders === 0 &&
        positionMismatches.every((item) => Number.isFinite(item.actual) && item.expected !== 0 &&
          Math.sign(item.expected) === Math.sign(item.actual) && Math.abs(item.actual) >= Math.abs(item.expected));
      this.lastReconciledAt = this.now();
      this.health.reconciliation = "idle";
      this.health.reconciliation_complete = this.health.daily_risk_seed === "healthy" &&
        missingAtBroker.length === 0 && positionMismatches.length === 0 &&
        ownedLookingOrphans.length === 0 && this.unknownOrders === 0;
      const report = {
        matched,
        missingAtBroker,
        orphanOrders: orphans,
        positions,
        positionMismatches,
        affectedTradeIds: [...affectedTradeIds],
        remainingByTrade,
      };
      await this.deps.onReconciliationIssue?.(report);
      return report;
    } catch (error) {
      this.health.reconciliation = "failed";
      this.health.reconciliation_complete = false;
      if (this.deps.adapter.mode === "live") {
        if (this.health.broker_orders_api === "unknown") this.health.broker_orders_api = "unhealthy";
        if (this.health.broker_positions_api === "unknown") this.health.broker_positions_api = "unhealthy";
      }
      this.trip(`reconciliation failed: ${errorMessage(error)}`);
      throw error;
    }
  }

  private async persistOrder(
    intent: IBoxOrderIntent,
    order: BrokerOrder,
    message: string,
  ): Promise<IBoxOrderIntent> {
    for (const fill of order.fills) {
      if (this.fillIdentities.has(fill.fill_id)) continue;
      this.fillIdentities.add(fill.fill_id);
    }
    try {
      const result = await this.deps.persistence.update(
        intent.client_order_id,
        {
          broker_order_id: order.broker_order_id,
          state: order.state,
          filled_quantity: order.filled_quantity,
          average_price: order.average_price,
          broker_tag: order.tag,
          reject_family: order.reject_family,
          reject_reason: order.reject_reason,
          updated_at: new Date(order.updated_at),
          terminal_at: isBrokerOrderTerminal(order.state) ? new Date(order.updated_at) : null,
        },
        auditFor(intent, order.state, order.broker_order_id, message, order.fills.at(-1)?.fill_id ?? null, this.now()),
      );
      const updated = result.intent;
      if (!updated) throw new Error(`Order intent ${intent.client_order_id} disappeared.`);
      const delta = updated.filled_quantity - intent.filled_quantity;
      if (delta > 0) {
        const key = `${updated.exchange}:${updated.tradingsymbol}`;
        const prior = this.attributedBoxPositions.get(key) ?? 0;
        this.attributedBoxPositions.set(key, prior + (updated.side === "BUY" ? delta : -delta));
        this.recalculateGrossAttributedQuantity();
      }
      this.knownIntents.set(updated.client_order_id, updated);
      if (isBrokerOrderTerminal(order.state)) this.releaseReservation(updated.client_order_id);
      this.health.persistence = "healthy";
      return updated;
    } catch (error) {
      this.health.persistence = "unhealthy";
      if (order.filled_quantity > 0) {
        this.trip(`persistence lost after confirmed fill ${order.client_order_id}`);
        this.deps.onPersistenceLossAfterFill?.(order, error);
        throw new OrderPersistenceAfterFillError(order, error);
      }
      throw error;
    }
  }

  private async transition(
    intent: IBoxOrderIntent,
    state: BoxOrderIntentState,
    brokerOrderId: string | null,
    message: string,
  ): Promise<IBoxOrderIntent> {
    const at = this.now();
    const result = await this.deps.persistence.update(
      intent.client_order_id,
      {
        state,
        broker_order_id: brokerOrderId,
        updated_at: new Date(at),
        terminal_at: state === "COMPLETE" || state === "CANCELLED" || state === "REJECTED"
          ? new Date(at)
          : null,
      },
      auditFor(intent, state, brokerOrderId, message, null, at),
    );
    const updated = result.intent;
    if (!updated) throw new Error(`Order intent ${intent.client_order_id} disappeared.`);
    this.knownIntents.set(updated.client_order_id, updated);
    return updated;
  }

  private recalculateGrossAttributedQuantity(): void {
    this.grossOpenLegQuantity = [...this.attributedBoxPositions.values()]
      .reduce((sum, quantity) => sum + Math.abs(quantity), 0);
  }

  private withinQuantityLimits(request: BrokerOrderRequest): boolean {
    if (request.quantity > this.deps.limits.maxOpenLegQuantity) return false;
    if (request.purpose === "ENTRY") {
      return this.grossOpenLegQuantity + this.reservedEntryQuantity + request.quantity <=
        this.deps.limits.maxGrossOpenLegQuantity;
    }

    if (request.purpose === "PROTECTIVE_CANCEL") return true;
    const symbol = `${request.exchange}:${request.tradingsymbol}`;
    const net = this.attributedBoxPositions.get(symbol) ?? 0;
    const correctSide = (net > 0 && request.side === "SELL") || (net < 0 && request.side === "BUY");
    const alreadyReserved = this.reservedReductionsBySymbol.get(symbol) ?? 0;
    return correctSide && request.quantity + alreadyReserved <= Math.abs(net);
  }

  private releaseReservation(clientOrderId: string): void {
    const quantity = this.reservations.get(clientOrderId) ?? 0;
    if (quantity > 0) this.reservedEntryQuantity = Math.max(0, this.reservedEntryQuantity - quantity);
    this.reservations.delete(clientOrderId);
    const reduction = this.reductionReservations.get(clientOrderId);
    if (reduction) {
      const remaining = Math.max(0, (this.reservedReductionsBySymbol.get(reduction.symbol) ?? 0) - reduction.quantity);
      if (remaining === 0) this.reservedReductionsBySymbol.delete(reduction.symbol);
      else this.reservedReductionsBySymbol.set(reduction.symbol, remaining);
      this.reservedReductionQuantity = Math.max(0, this.reservedReductionQuantity - reduction.quantity);
      this.reductionReservations.delete(clientOrderId);
    }
  }

  private rollTradingDay(): void {
    const next = this.dayKey();
    if (next === this.tradingDay) return;
    this.tradingDay = next;
    // Never reopen on a process-local zero at midnight. Entry remains blocked
    // until the new IST day's durable closes, aborts, and rejects are reloaded.
    this.realisedPnlToday = 0;
    this.rejects = 0;
    this.consecutiveFailures = 0;
    this.health.daily_risk_seed = "seeding";
    this.health.reconciliation_complete = false;
    this.refreshDailyRiskSeed();
    // A day roll never clears a sticky safety breaker or operator controls.
  }

  private refreshDailyRiskSeed(): void {
    if (this.dailyRiskSeedPromise || this.disposed) return;
    const day = this.tradingDay;
    const loader = this.deps.loadDailyRiskSeed;
    if (!loader) {
      this.health.daily_risk_seed = "failed";
      return;
    }
    this.health.daily_risk_seed = "seeding";
    this.dailyRiskSeedPromise = loader(day)
      .then((seed) => {
        // Ignore a slow prior-day response that crossed another IST rollover.
        if (day !== this.tradingDay) return;
        this.realisedPnlToday = Number.isFinite(seed.realisedPnl) ? seed.realisedPnl : 0;
        this.rejects = Math.max(0, Math.floor(seed.rejects));
        this.consecutiveFailures = Math.max(0, Math.floor(seed.consecutiveFailures));
        this.health.daily_risk_seed = "healthy";
        this.evaluateLimits();
        // Reconciliation owns the final entry-ready flag. Defer so this promise is
        // cleared before reconcile can request another seed.
        setTimeout(() => void this.reconcile().catch(() => undefined), 0).unref?.();
      })
      .catch(() => {
        if (day === this.tradingDay) this.health.daily_risk_seed = "failed";
      })
      .finally(() => {
        this.dailyRiskSeedPromise = null;
      });
  }

  private dayKey(): string {
    if (this.deps.istDayKey) return this.deps.istDayKey(this.now());
    return new Date(this.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  private noteFailure(reason: string): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.deps.limits.consecutiveFailureLimit) {
      this.trip(`${reason}: consecutive failure limit reached`);
    }
  }

  private evaluateLimits(): void {
    if (this.deps.limits.dailyLossLimit > 0 && this.realisedPnlToday <= -this.deps.limits.dailyLossLimit) {
      this.trip("daily loss limit reached");
    }
    if (this.rejects >= this.deps.limits.rejectLimit) this.trip("broker reject limit reached");
    if (this.residualLegs > this.deps.limits.maxResidualLegs) this.trip("residual leg limit exceeded");
    if (this.openBoxes > this.deps.limits.maxOpenBoxes) this.trip("open box limit exceeded");
    if (this.grossOpenLegQuantity > this.deps.limits.maxGrossOpenLegQuantity) {
      this.trip("gross open leg quantity limit exceeded");
    }
  }

  private trip(reason: string): void {
    if (this.breakerReason !== null) return;
    this.breakerReason = reason;
    this.breakerAt = this.now();
    this.health.circuit = "open";
    this.controls.entryEnabled = false;
    this.deps.onCircuitTrip?.(reason);
  }

  private refreshFeedHealth(): void {
    if (this.feedHealthy) {
      this.health.feed = this.now() < this.feedWarmUntil ? "warming" : "healthy";
    }
  }

  private now(): number {
    return this.deps.clock?.now() ?? Date.now();
  }
}

/** Compatibility alias for existing imports while the public name is explicit. */
export { BoxOrderManager as OrderManager };

function requestFromIntent(intent: IBoxOrderIntent): BrokerOrderRequest {
  return {
    client_order_id: intent.client_order_id,
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
    ...(intent.broker_tag ? { tag: intent.broker_tag } : {}),
  };
}

function intentFromRequest(
  request: BrokerOrderRequest,
  mode: "paper" | "live",
  now: number,
): IBoxOrderIntent {
  const at = new Date(now);
  return {
    client_order_id: request.client_order_id,
    broker_order_id: null,
    broker_mode: mode,
    trade_id: request.trade_id,
    attempt_id: request.attempt_id,
    role: request.role,
    purpose: request.purpose,
    phase: request.phase,
    exchange: request.exchange,
    tradingsymbol: request.tradingsymbol,
    token: request.token,
    side: request.side,
    quantity: request.quantity,
    reference_price: request.pricing.reference_price,
    tick_size: request.pricing.tick_size,
    max_chase_ticks: request.pricing.max_chase_ticks,
    limit_price: request.pricing.limit_price,
    state: "CREATED",
    filled_quantity: 0,
    average_price: null,
    broker_tag: request.tag ?? null,
    reject_family: null,
    reject_reason: null,
    created_at: at,
    updated_at: at,
    terminal_at: null,
    audit: [{
      audit_id: `${request.client_order_id}:CREATED`,
      at,
      from_state: null,
      to_state: "CREATED",
      broker_order_id: null,
      message: "durable order intent created before submission",
      fill_identity: null,
    }],
  };
}

function auditFor(
  intent: IBoxOrderIntent,
  state: BoxOrderIntentState,
  brokerOrderId: string | null,
  message: string,
  fillIdentity: string | null,
  now: number,
): BoxOrderIntentAudit {
  return {
    audit_id: `${intent.client_order_id}:${intent.state}->${state}:${brokerOrderId ?? "none"}:${fillIdentity ?? "none"}`,
    at: new Date(now),
    from_state: intent.state,
    to_state: state,
    broker_order_id: brokerOrderId,
    message,
    fill_identity: fillIdentity,
  };
}

function cloneOrder(order: BrokerOrder): BrokerOrder {
  return {
    ...order,
    pricing: { ...order.pricing },
    fills: order.fills.map((fill) => ({ ...fill })),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTimeoutLike(error: unknown): boolean {
  return error instanceof Error && /timeout|timed out|unknown/i.test(error.message);
}
