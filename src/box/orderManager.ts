import {
  BrokerAmbiguousSubmitError,
  BrokerOrderRejectedError,
  BrokerPreSubmitRefusedError,
  isBrokerOrderTerminal,
  type BrokerAdapter,
  type BrokerOrder,
  type BrokerOrderRequest,
  type BrokerOrderState,
} from "./brokerAdapter.js";
import { BoundedTtlCache } from "../boundedCache.js";
import type { BoxConfig } from "./config.js";
import { CumulativeFillLedger } from "./orderLifecycle.js";
import type { ExecutionTimingRecorder } from "./executionTiming.js";
import { kindForPurpose } from "./executionTiming.js";
import type { BrokerId } from "./latencyModel.js";
import {
  admitBoxOperation,
  BOX_ORDER_PRIORITY,
  type BoxSchedulingOccupancy,
  type BoxSchedulingSlot,
  clampEntrySubmitConcurrency,
} from "./executionSchedulingPolicy.js";
import type {
  BoxOrderIntentAudit,
  BoxOrderIntentPatch,
  BoxOrderIntentState,
  BoxOrderPurpose,
  BoxLegRole,
  IBoxOrderIntent,
  ResidualLegExposure,
} from "./types.js";

/**
 * The outcome of one guarded durable update — the TRANSITION, not merely the resulting document.
 *
 * `previous_filled_quantity` / `current_filled_quantity` are what make position attribution safe.
 * See `durableFillDelta` and `repository.updateBoxOrderIntent` for the double-count this exists
 * to prevent. A persistence implementation that cannot report the transition must leave them
 * null; the manager then attributes nothing and raises an invariant rather than guessing.
 */
export interface OrderIntentUpdateResult {
  intent: IBoxOrderIntent | null;
  applied: boolean;
  previous_filled_quantity?: number | null;
  current_filled_quantity?: number | null;
}

export interface CheckedFeedStamp {
  /** Token whose exact executable snapshot was checked. */
  readonly token: number;
  readonly feed_generation: number;
  readonly quote_version: number;
  readonly quote_at: number;
  readonly checked_at: number;
}

export interface OrderIntentPersistence {
  create(intent: IBoxOrderIntent): Promise<IBoxOrderIntent>;
  update(
    clientOrderId: string,
    patch: BoxOrderIntentPatch,
    audit: BoxOrderIntentAudit,
    /** Optional compare-and-set guard for safety-critical local transitions. */
    expectedStates?: readonly BoxOrderIntentState[],
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

export interface DailyRiskSeed {
  realisedPnl: number;
  rejects: number;
  consecutiveFailures: number;
  /** Authoritative charge total for this seed's trading day, keyed by execution attempt. */
  flattenChargeBaselinesForDay?: Record<string, number>;
  /**
   * The loader could not prove it read every contributing row. An understated loss must never
   * present itself as an authoritative seed, so this keeps `daily_risk_seed` unhealthy — and
   * therefore entry closed — while still installing the counters for observability.
   */
  incomplete?: boolean;
}

/** Generation captured immediately before an asynchronous daily-risk load begins. */
export interface DailyRiskSeedToken {
  readonly tradingDay: string;
  readonly mutationGeneration: number;
  /** Unique loader/token generation; late completions are accepted only while this is active. */
  readonly loadGeneration: number;
}

export interface DailyRiskSeedTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface FlattenChargeMutation {
  readonly generation: number;
  readonly attemptId: string;
  readonly previousChargesForDay: number;
  readonly chargesForDay: number;
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
  /** Matching crash-only exposure exists but its unique durable recovery boundary is unavailable. */
  crashRecoveryEntryQuarantined: boolean;
  tradingDay: string;
  riskBookkeeping: {
    activeSeedTokens: number;
    activeLoadGeneration: number | null;
    retainedMutationCount: number;
    retainedMutationDayBuckets: number;
  };
  rejects: number;
  consecutiveFailures: number;
  realisedPnlToday: number;
  residualLegs: number;
  openBoxes: number;
  orphanOrders: BrokerOrder[];
  lastReconciledAt: number | null;
  /**
   * How many durable state transitions the intent state machine REFUSED this session.
   *
   * A bounded counter, not a label: a refused transition used to be indistinguishable from a
   * successful one because the guarded write returns the unchanged document either way.
   */
  durableTransitionRefusals: number;
}

export interface OrderManagerLimits {
  maxOpenBoxes: number;
  maxConcurrentExecutions: number;
  /**
   * How many ENTRY role submissions of ONE Box pipeline may be in transport at once (1..4).
   *
   * See the BOX ENTRY BURST POLICY section of executionSchedulingPolicy.ts. `1` reproduces the
   * pre-burst behaviour exactly.
   */
  entrySubmitConcurrency: number;
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
    entrySubmitConcurrency: cfg.liveEntrySubmitConcurrency,
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
  /** Ephemeral evidence only; never copied into the durable intent or broker payload. */
  checkedFeed?: CheckedFeedStamp;
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
  /**
   * Per-order cumulative-fill ledgers (audit divergence D5).
   *
   * REPLACES a dead `fillIdentities` set whose `continue` skipped nothing and which nothing ever
   * read. Every observed broker snapshot for an order is now routed through a ledger that
   * enforces the invariants the brief requires: a duplicate broker event contributes no
   * quantity, an out-of-order snapshot cannot rewind the cumulative total, and an overfill is
   * surfaced rather than silently clamped.
   *
   * The authoritative position arithmetic remains the Mongo-guarded path below; this ledger is
   * the verification layer that turns a violated invariant into a tripped breaker instead of a
   * quiet accounting error. Bounded by TTL and count, so a long session cannot leak.
   */
  private readonly fillLedgers: BoundedTtlCache<CumulativeFillLedger>;
  private readonly activeClientIds = new Set<string>();
  private readonly knownIntents = new Map<string, IBoxOrderIntent>();
  private orphanOrders: BrokerOrder[] = [];
  private sequence = 0;
  /**
   * TOTAL in-flight operations. Retained as the reported number (`status().inFlight`) so every
   * existing consumer — health, capacity checks, diagnostics — keeps its meaning.
   */
  private inFlight = 0;
  /** In-flight operations holding a BASE concurrency slot. */
  private baseInFlight = 0;
  /** In-flight ENTRY operations holding an entry-burst slot. */
  private burstInFlight = 0;
  /** In-flight operations whose purpose is not ENTRY. */
  private nonEntryInFlight = 0;
  /** The single Box pipeline owning every in-flight ENTRY operation, or null. */
  private entryAttemptInFlight: string | null = null;
  /** In-flight ENTRY operations, used to clear {@link entryAttemptInFlight} at zero. */
  private entryInFlight = 0;
  /** Peak simultaneous ENTRY submissions observed, for diagnostics. */
  private peakEntryBurstWidth = 0;
  /** How many times the entry burst granted an extra slot. Diagnostics only. */
  private entryBurstGrants = 0;
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
  private dailyRiskLoadGeneration = 0;
  private activeDailyRiskLoad: {
    generation: number;
    day: string;
    token: DailyRiskSeedToken;
    timeout: unknown;
  } | null = null;
  private readonly activeDailyRiskSeedTokens = new Map<number, DailyRiskSeedToken>();
  private crashOnlyAttributedExposure = false;
  /**
   * Local flatten observations are generation-stamped per day. A seed loader captures the
   * generation before issuing any query, then installation merges only ranges absent from the
   * loader's authoritative per-attempt day buckets. This is the serialization boundary between
   * Mongo reconstruction and in-process risk mutation.
   */
  private flattenChargeMutationGeneration = 0;
  private readonly flattenChargeMutationsByDay = new Map<string, FlattenChargeMutation[]>();
  private reconcileTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private lastReconciledAt: number | null = null;
  /** Guarded durable transitions the intent state machine refused. Bounded counter. */
  private durableTransitionRefusals = 0;

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
      loadDailyRiskSeed?: (tradingDay: string) => Promise<DailyRiskSeed>;
      /** Logical cancellation bound for a seed query that the database driver cannot abort. */
      dailyRiskSeedTimeoutMs?: number;
      /** Injectable deterministic timer used by seed timeout tests. */
      dailyRiskSeedTimer?: DailyRiskSeedTimer;
      /** Process/connection/index-scoped readiness; read at every entry decision. */
      isCrashRecoveryPersistenceReady?: () => boolean;
      onCircuitTrip?: (reason: string) => void;
      /**
       * LIVE TIMING INSTRUMENTATION (Phase 2). Optional and FAIL-OPEN: when absent the manager
       * behaves exactly as before, and when present no failure inside it can affect an order.
       * The manager owns the SCHEDULER stages (enqueue/dequeue) because it is the only layer
       * that witnesses them; the adapter marks the transport, ACK, fill and cancel stages on
       * the same trace, keyed by client order id.
       */
      timing?: ExecutionTimingRecorder;
      /**
       * Called for every REAL broker rejection, so reject-family statistics are measured rather
       * than modelled (Phase 19). Fail-open: a diagnostics failure here must not change how a
       * rejection is handled.
       */
      onBrokerReject?: (order: BrokerOrder | null, reason: string) => void;
      /**
       * Re-check the exact executable quote admitted by the gateway. Production
       * installs this fail-closed authority; optionality preserves isolated manager
       * use where no market-data source exists.
       */
      revalidateQueuedRequest?: (
        request: BrokerOrderRequest,
        stamp: CheckedFeedStamp | undefined,
      ) => string | null;
      /**
       * Which broker these samples belong to. Required for timing to be recorded at all,
       * because a sample that cannot be attributed to a broker must never be filed — pooling
       * Zerodha and Dhan latency would describe neither.
       */
      broker?: () => BrokerId;
    },
  ) {
    this.tradingDay = this.dayKey();
    // Bounded: one ledger per in-flight order, expiring well after any order's lifetime. Sized
    // generously relative to the concurrency cap so nothing in a normal session is evicted while
    // still live, and hard-capped so nothing can leak.
    this.fillLedgers = new BoundedTtlCache<CumulativeFillLedger>({
      maxEntries: 512,
      ttlMs: 60 * 60_000,
      now: () => this.now(),
    });
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

  /** Capture and register the local mutation boundary immediately before a daily-risk load starts. */
  beginDailyRiskSeed(tradingDay: string): DailyRiskSeedToken {
    const token: DailyRiskSeedToken = {
      tradingDay,
      mutationGeneration: this.flattenChargeMutationGeneration,
      loadGeneration: ++this.dailyRiskLoadGeneration,
    };
    this.activeDailyRiskSeedTokens.set(token.loadGeneration, token);
    return token;
  }

  /**
   * Release a daily-risk seed token whose load will never install anything.
   *
   * `seedLimits` settles the token on the installing path; every other exit needs this one, or the
   * token stays "active" forever and `compactFlattenChargeMutations` must retain the whole day's
   * merge journal — the unbounded growth the generation bound exists to close, re-opened once per
   * failed boot. Idempotent (an already-settled token is not registered) and it never discards a
   * merge a genuinely active loader still needs: compaction keeps the suffix above the oldest
   * REMAINING active generation for the day.
   */
  abandonDailyRiskSeed(token: DailyRiskSeedToken): void {
    if (!this.activeDailyRiskSeedTokens.has(token.loadGeneration)) return;
    this.settleDailyRiskSeedToken(token);
  }

  /**
   * Reconciliation/engine seam for crash-only exposure not represented by projected trades.
   * Entry reads persistence readiness dynamically; ordinary exits never consult this flag.
   */
  setCrashOnlyAttributedExposure(exists: boolean): void {
    this.crashOnlyAttributedExposure = exists;
  }

  /**
   * Record one authoritative per-attempt/day bucket advance. Lifetime bookkeeping lives in the
   * engine; this manager owns only the trading-day debit and the seed-install merge journal.
   */
  recordFlattenCharge(args: {
    attemptId: string;
    chargeDay: string;
    previousChargesForDay: number;
    chargesForDay: number;
  }): void {
    if (!args.chargeDay || !Number.isFinite(args.previousChargesForDay) ||
        !Number.isFinite(args.chargesForDay)) return;
    const previous = Math.round(Math.max(0, args.previousChargesForDay) * 100) / 100;
    const current = Math.round(Math.max(0, args.chargesForDay) * 100) / 100;
    if (current <= previous || args.chargeDay !== this.tradingDay) return;
    const generation = ++this.flattenChargeMutationGeneration;
    const activeLoaderCanNeedMutation = [...this.activeDailyRiskSeedTokens.values()].some(
      (token) => token.tradingDay === args.chargeDay && token.mutationGeneration < generation,
    );
    if (activeLoaderCanNeedMutation) {
      const mutation: FlattenChargeMutation = {
        generation,
        attemptId: args.attemptId,
        previousChargesForDay: previous,
        chargesForDay: current,
      };
      const mutations = this.flattenChargeMutationsByDay.get(args.chargeDay) ?? [];
      mutations.push(mutation);
      this.flattenChargeMutationsByDay.set(args.chargeDay, mutations);
    }
    if (args.chargeDay === this.tradingDay) {
      this.realisedPnlToday = Math.round((this.realisedPnlToday - (current - previous)) * 100) / 100;
      this.evaluateLimits();
    }
  }

  /** Seed durable/reconciled counters before entry is allowed. */
  seedLimits(args: {
    tradingDay: string;
    realisedPnlToday?: number;
    rejects?: number;
    consecutiveFailures?: number;
    openBoxes?: number;
    residualLegs?: number;
    seedToken?: DailyRiskSeedToken | undefined;
    flattenChargeBaselinesForDay?: Record<string, number> | undefined;
    /** The reconstruction may be missing loss rows; see `DailyRiskSeed.incomplete`. */
    incomplete?: boolean | undefined;
  }): void {
    if (args.seedToken && !this.activeDailyRiskSeedTokens.has(args.seedToken.loadGeneration)) {
      // Timed-out/rolled-over loader completion. Its scalar and baselines are no longer allowed to
      // mutate current risk, and its mutation range has already been compacted.
      return;
    }
    this.tradingDay = args.tradingDay;
    const seedPnl = Number.isFinite(args.realisedPnlToday) ? args.realisedPnlToday! : 0;
    this.realisedPnlToday = this.mergePostLoadFlattenCharges(
      args.tradingDay,
      seedPnl,
      args.seedToken,
      args.flattenChargeBaselinesForDay,
    );
    this.rejects = Math.max(0, Math.floor(args.rejects ?? 0));
    this.consecutiveFailures = Math.max(0, Math.floor(args.consecutiveFailures ?? 0));
    this.openBoxes = Math.max(0, Math.floor(args.openBoxes ?? 0));
    this.residualLegs = Math.max(0, Math.floor(args.residualLegs ?? 0));
    // A truncated reconstruction can only understate a loss, which would LOOSEN the daily-loss
    // gate. Counters are still installed so an operator can see them, but the seed is not called
    // healthy, and `canEnter()` already treats anything other than healthy as closed.
    this.health.daily_risk_seed = args.incomplete === true ? "failed" : "healthy";
    if (args.seedToken) this.settleDailyRiskSeedToken(args.seedToken);
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

  /**
   * Read one durable order intent by client id.
   *
   * Exposed so residual flattening can resolve its DURABLE attempt generation from the intent
   * journal rather than from an in-memory counter. Read-only, and it never creates an intent.
   */
  findDurableIntent(clientOrderId: string): Promise<IBoxOrderIntent | null> {
    return this.deps.persistence.findByClientId(clientOrderId);
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
    if (this.isCrashRecoveryEntryQuarantined()) return false;
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

  submit(request: BrokerOrderRequest, checkedFeed?: CheckedFeedStamp): Promise<BrokerOrder> {
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
    // SCHEDULER ENQUEUE. Recorded here, before the queue push, so `scheduler_wait_ms` measures
    // the real wait rather than starting from whenever the pump happened to look. Fail-open by
    // construction: `beginTrace` swallows everything.
    this.beginTrace(request);
    return new Promise<BrokerOrder>((resolve, reject) => {
      this.queue.push({
        kind: "submit",
        request,
        ...(checkedFeed ? { checkedFeed } : {}),
        resolve,
        reject,
        sequence: this.sequence++,
      });
      this.sortQueue();
      this.pump();
    });
  }

  /**
   * Open a timing trace for a request and mark the enqueue instant.
   *
   * NEVER THROWS and never affects the return path. Telemetry is not permitted to change whether
   * an order is submitted.
   */
  private beginTrace(request: BrokerOrderRequest): void {
    try {
      const timing = this.deps.timing;
      const broker = this.deps.broker?.();
      // No broker attribution ⇒ no sample. Better to lose a measurement than to file it under
      // the wrong broker and corrupt both distributions.
      if (!timing || !broker) return;
      const trace = timing.trace(request.client_order_id, {
        broker,
        purpose: request.purpose,
        role: request.role,
        tradeId: request.trade_id,
        attemptId: request.attempt_id,
        requestedQty: request.quantity,
      });
      trace?.setKind(kindForPurpose(request.purpose));
      trace?.mark("scheduler_enqueued");
    } catch {
      /* telemetry must never affect execution */
    }
  }

  /**
   * Route an observed broker snapshot through this order's cumulative-fill ledger.
   *
   * THE INVARIANTS THIS ENFORCES (Phase 6 / Phase 29):
   *
   *  - a duplicate broker event contributes zero quantity (identity dedupe);
   *  - an out-of-order or re-polled snapshot cannot reduce the cumulative total;
   *  - an overfill — the broker reporting more filled than we asked for — TRIPS THE BREAKER
   *    rather than being clamped away, because it means our own quantity model is wrong and
   *    every downstream exposure number is suspect.
   *
   * Fail-open with respect to the ledger itself: a bookkeeping failure must not block
   * persistence of a real fill. It is emphatically NOT fail-open with respect to the overfill
   * finding, which is a safety signal.
   */
  private rememberFillIdentities(order: BrokerOrder): void {
    let overfill: { cumulative: number; requested: number } | null = null;
    try {
      let ledger = this.fillLedgers.get(order.client_order_id);
      if (!ledger) {
        ledger = new CumulativeFillLedger(order.client_order_id, order.quantity);
        this.fillLedgers.set(order.client_order_id, ledger);
      }
      const result = ledger.apply({
        cumulativeQty: order.filled_quantity,
        averagePrice: order.average_price,
        // The newest fill identity the adapter surfaced. Kite synthesises one per distinct
        // cumulative quantity and Dhan supplies the exchange trade id; either way a repeated
        // poll of an unchanged order yields the same identity and is correctly ignored.
        eventId: order.fills.at(-1)?.fill_id ?? null,
        observedAtWall: order.updated_at,
        source: "rest_poll",
      });
      if (result.outcome === "applied_overfill") {
        overfill = { cumulative: result.cumulative, requested: ledger.requestedQty };
      }
    } catch {
      /* bookkeeping must not block persistence of a confirmed fill */
    }
    if (overfill) {
      this.trip(
        `broker reported ${overfill.cumulative} filled for ${order.client_order_id}, exceeding the ${overfill.requested} requested`,
      );
    }
  }

  /** Report a real broker rejection for statistics. Fail-open. */
  private noteBrokerReject(order: BrokerOrder | null, reason: string): void {
    try {
      this.deps.onBrokerReject?.(order, reason);
    } catch {
      /* diagnostics must never change rejection handling */
    }
  }

  /** Mark a stage on a request's trace. Fail-open; a no-op when instrumentation is off. */
  private markTiming(clientOrderId: string, stage: Parameters<ExecutionTimingRecorder["mark"]>[1]): void {
    try {
      this.deps.timing?.mark(clientOrderId, stage);
    } catch {
      /* telemetry must never affect execution */
    }
  }

  /**
   * Publish an order's timing once it is terminal.
   *
   * Called from the terminal paths only. Idempotent in the recorder, so an order whose terminal
   * state is witnessed by both the adapter and the reconciler contributes exactly one sample.
   */
  private publishTiming(clientOrderId: string): void {
    try {
      this.deps.timing?.publish(clientOrderId);
    } catch {
      /* telemetry must never affect execution */
    }
  }

  async cancelWorkingBoxOrders(): Promise<BrokerOrder[]> {
    if (!this.canManageExposure()) return [];
    const intents = await this.deps.persistence.loadNonterminal();
    const cancelled: BrokerOrder[] = [];
    const failures: string[] = [];
    for (const intent of intents) {
      // Only durable BOX intents are eligible. Never cancel arbitrary broker orders.
      if (!intent.client_order_id.startsWith("BOX:")) continue;
      // One leg's cancel MUST NOT abandon the others. `enqueueCancel` rejects on any adapter
      // error, and an ambiguous or slow cancel is exactly the situation in which this method is
      // called — so letting the rejection escape the loop meant the first troublesome leg
      // prevented legs 2-4 from ever being enqueued, leaving them working at the broker while the
      // operator's panic button reported a flat failure. Every eligible intent now gets its own
      // attempt, and the failures are surfaced after all of them have been tried.
      try {
        const order = await this.enqueueCancel(intent);
        if (order) cancelled.push(order);
      } catch (error) {
        failures.push(`${intent.client_order_id}: ${errorMessage(error)}`);
      }
    }
    if (failures.length > 0) {
      // Loud, and not thrown: the caller needs the list of what WAS cancelled far more than it
      // needs an exception, and a half-completed cancel sweep must never look like a clean one.
      this.invariantViolation(
        `cancel-working sweep left ${failures.length} order(s) uncancelled: ${failures.join("; ")}`,
      );
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
      crashRecoveryEntryQuarantined: this.isCrashRecoveryEntryQuarantined(),
      tradingDay: this.tradingDay,
      riskBookkeeping: {
        activeSeedTokens: this.activeDailyRiskSeedTokens.size,
        activeLoadGeneration: this.activeDailyRiskLoad?.generation ?? null,
        retainedMutationCount: [...this.flattenChargeMutationsByDay.values()]
          .reduce((sum, mutations) => sum + mutations.length, 0),
        retainedMutationDayBuckets: this.flattenChargeMutationsByDay.size,
      },
      rejects: this.rejects,
      consecutiveFailures: this.consecutiveFailures,
      realisedPnlToday: this.realisedPnlToday,
      residualLegs: this.residualLegs,
      openBoxes: this.openBoxes,
      orphanOrders: this.orphanOrders.map(cloneOrder),
      lastReconciledAt: this.lastReconciledAt,
      durableTransitionRefusals: this.durableTransitionRefusals,
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    if (this.activeDailyRiskLoad) {
      this.seedTimer().clearTimeout(this.activeDailyRiskLoad.timeout);
      this.activeDailyRiskLoad = null;
    }
    this.activeDailyRiskSeedTokens.clear();
    this.flattenChargeMutationsByDay.clear();
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

  /** The purpose an action is scheduled under. A bare cancel is a PROTECTIVE_CANCEL. */
  private static purposeOf(action: QueueAction): BoxOrderPurpose {
    return action.kind === "cancel" ? "PROTECTIVE_CANCEL" : action.request.purpose;
  }

  /** The Box pipeline an action belongs to. */
  private static attemptOf(action: QueueAction): string {
    return action.kind === "cancel" ? action.intent.attempt_id : action.request.attempt_id;
  }

  /** Current slot occupancy, in the shape the shared admission policy expects. */
  private occupancy(): BoxSchedulingOccupancy {
    return {
      baseInFlight: this.baseInFlight,
      burstInFlight: this.burstInFlight,
      entryAttemptId: this.entryAttemptInFlight,
      nonEntryInFlight: this.nonEntryInFlight,
    };
  }

  private pump(): void {
    while (!this.disposed && this.queue.length > 0) {
      // PEEK, never shift-then-requeue. The queue is priority-sorted, so if the head cannot be
      // admitted we must STOP rather than look further down: admitting a lower-priority ENTRY
      // ahead of a blocked EMERGENCY_RESIDUAL would invert BOX_ORDER_PRIORITY.
      const action = this.queue[0];
      if (!action) return;
      const verdict = admitBoxOperation({
        request: {
          purpose: BoxOrderManager.purposeOf(action),
          attemptId: BoxOrderManager.attemptOf(action),
        },
        occupancy: this.occupancy(),
        baseConcurrency: this.deps.limits.maxConcurrentExecutions,
        entrySubmitConcurrency: clampEntrySubmitConcurrency(this.deps.limits.entrySubmitConcurrency),
      });
      if (!verdict.admit) return;
      this.queue.shift();

      const blocked = this.queuedActionBlockReason(action);
      if (blocked) {
        if (action.kind === "submit") {
          this.activeClientIds.delete(action.request.client_order_id);
          this.releaseReservation(action.request.client_order_id);
        }
        action.reject(new Error(blocked));
        continue;
      }
      // SCHEDULER DEQUEUE. A concurrency slot has been acquired and the operation is about to
      // reach the broker, so this closes `scheduler_wait_ms` and opens `transport_wait_ms`.
      this.markTiming(
        action.kind === "submit" ? action.request.client_order_id : action.intent.client_order_id,
        "scheduler_dequeued",
      );
      this.occupySlot(action, verdict.slot);
      const execution = action.kind === "submit"
        ? this.execute(action)
        : this.executeCancel(action);
      void execution.finally(() => {
        this.releaseSlot(action, verdict.slot);
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

  /** Take a scheduling slot. Paired with {@link releaseSlot} in the execution's `finally`. */
  private occupySlot(action: QueueAction, slot: BoxSchedulingSlot): void {
    this.inFlight++;
    if (slot === "base") this.baseInFlight++;
    else {
      this.burstInFlight++;
      this.entryBurstGrants++;
    }
    if (BoxOrderManager.purposeOf(action) === "ENTRY") {
      this.entryInFlight++;
      this.entryAttemptInFlight = BoxOrderManager.attemptOf(action);
      if (this.entryInFlight > this.peakEntryBurstWidth) this.peakEntryBurstWidth = this.entryInFlight;
    } else {
      this.nonEntryInFlight++;
    }
  }

  /** Give a scheduling slot back. Clamped at zero so a double release cannot corrupt admission. */
  private releaseSlot(action: QueueAction, slot: BoxSchedulingSlot): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (slot === "base") this.baseInFlight = Math.max(0, this.baseInFlight - 1);
    else this.burstInFlight = Math.max(0, this.burstInFlight - 1);
    if (BoxOrderManager.purposeOf(action) === "ENTRY") {
      this.entryInFlight = Math.max(0, this.entryInFlight - 1);
      // The pipeline owns the ENTRY slot set only while at least one of its legs is in flight.
      // Clearing at zero is what lets the NEXT candidate start once this Box is fully settled.
      if (this.entryInFlight === 0) this.entryAttemptInFlight = null;
    } else {
      this.nonEntryInFlight = Math.max(0, this.nonEntryInFlight - 1);
    }
  }

  /** Entry-burst observations for diagnostics. Bounded, low-cardinality. */
  entryBurstDiagnostics(): {
    configured_entry_submit_concurrency: number;
    base_concurrency: number;
    peak_entry_submissions_in_flight: number;
    burst_slot_grants: number;
    base_in_flight: number;
    burst_in_flight: number;
    entry_attempt_in_flight: string | null;
  } {
    return {
      configured_entry_submit_concurrency: clampEntrySubmitConcurrency(this.deps.limits.entrySubmitConcurrency),
      base_concurrency: this.deps.limits.maxConcurrentExecutions,
      peak_entry_submissions_in_flight: this.peakEntryBurstWidth,
      burst_slot_grants: this.entryBurstGrants,
      base_in_flight: this.baseInFlight,
      burst_in_flight: this.burstInFlight,
      entry_attempt_in_flight: this.entryAttemptInFlight,
    };
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
        // A prior submission exists. Reconcile it; never let current feed state
        // hide or rewrite an identity that may already exist at the broker.
        const reconciled = await this.deps.adapter.getOrder(request.client_order_id);
        if (!reconciled) throw new Error("Existing durable intent requires reconciliation before resubmit.");
        await this.persistOrder(intent, reconciled, "existing intent reconciled before resubmit");
        action.resolve(reconciled);
        return;
      }

      const dequeueReason = this.checkedFeedBlockReason(request, action.checkedFeed);
      if (dequeueReason) {
        const refusal = new BrokerPreSubmitRefusedError(
          request.client_order_id,
          "dequeue",
          true,
          dequeueReason,
        );
        const terminalized = await this.persistLocalPreSubmitRefusal(intent, refusal);
        if (!terminalized) {
          await this.resolveConcurrentSubmissionOwner(action, this.knownIntents.get(intent.client_order_id) ?? intent);
          return;
        }
        action.reject(refusal);
        return;
      }

      const submitting = await this.transitionResult(
        intent,
        "SUBMITTING",
        null,
        "transport submission starting",
        ["CREATED"],
      );
      if (!submitting.applied) {
        // Another process won the deterministic identity. Never POST from this
        // process; adopt a known snapshot or leave the identity to reconciliation.
        await this.resolveConcurrentSubmissionOwner(action, submitting.intent);
        return;
      }
      intent = submitting.intent;
      if (intent.state !== "SUBMITTING") {
        throw new Error(`Order intent ${intent.client_order_id} did not durably enter SUBMITTING; broker POST blocked.`);
      }
      // DURABLE PERSISTENCE COMPLETE. Both Mongo writes are done and the order may now be
      // transmitted, so this closes `persistence_wait_ms` and opens `transport_wait_ms`. Recorded
      // here rather than being left inside the pacing span, because a database round trip reported
      // as rate limiting is exactly the kind of mislabelled measurement that corrupts calibration.
      this.markTiming(intent.client_order_id, "intent_persisted");

      let order: BrokerOrder;
      try {
        order = await this.deps.adapter.submitOrder(persistedRequest, () => {
          const reason = this.checkedFeedBlockReason(request, action.checkedFeed);
          if (reason) {
            throw new BrokerPreSubmitRefusedError(
              request.client_order_id,
              "pre_post",
              true,
              reason,
            );
          }
        });
      } catch (error) {
        if (error instanceof BrokerPreSubmitRefusedError) {
          const terminalized = await this.persistLocalPreSubmitRefusal(intent, error);
          if (!terminalized) {
            await this.resolveConcurrentSubmissionOwner(
              action,
              this.knownIntents.get(intent.client_order_id) ?? intent,
            );
            return;
          }
          action.reject(error);
          return;
        }
        if (error instanceof BrokerOrderRejectedError) {
          await this.persistOrder(intent, error.order, "broker rejected order");
          this.rejects++;
          this.noteBrokerReject(error.order, errorMessage(error));
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
        this.noteBrokerReject(null, errorMessage(error));
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
          this.noteBrokerReject(order, order.reject_reason ?? "broker rejected order");
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

  /** Current-feed authority for one queued request. A validator fault fails closed. */
  private checkedFeedBlockReason(
    request: BrokerOrderRequest,
    stamp: CheckedFeedStamp | undefined,
  ): string | null {
    const validate = this.deps.revalidateQueuedRequest;
    if (!validate) return null;
    try {
      return validate(request, stamp);
    } catch {
      return "current executable-feed validation failed closed";
    }
  }

  /**
   * Terminalize a proven local no-POST outcome without counting it as a broker
   * rejection or uncertainty. The expected-state CAS prevents this process from
   * overwriting a concurrent actor that advanced the identity toward the broker.
   */
  private async persistLocalPreSubmitRefusal(
    intent: IBoxOrderIntent,
    refusal: BrokerPreSubmitRefusedError,
  ): Promise<boolean> {
    const result = await this.transitionResult(
      intent,
      "REJECTED",
      null,
      `local pre-submit refusal; no broker POST attempted (${refusal.stage}): ${refusal.reason}`,
      [intent.state],
      {
        origin: "local_pre_submit_refusal",
        no_broker_post: true,
        stage: refusal.stage,
        reason: refusal.reason,
      },
    );
    // Provenance matters: an already-REJECTED fresh row may be a real broker
    // rejection written by another actor. Only THIS applied CAS proves no POST.
    return result.applied && result.intent.state === "REJECTED";
  }

  /** Adopt another process's winner when possible; otherwise quarantine locally without POST. */
  private async resolveConcurrentSubmissionOwner(
    action: SubmitQueueAction,
    current: IBoxOrderIntent,
  ): Promise<void> {
    this.knownIntents.set(current.client_order_id, current);
    const reconciled = await this.deps.adapter.getOrder(current.client_order_id);
    if (reconciled) {
      await this.persistOrder(current, reconciled, "concurrent durable submission owner reconciled");
      action.resolve(reconciled);
      return;
    }
    if (!isBrokerOrderTerminal(current.state)) this.unknownOrders++;
    action.reject(new BrokerAmbiguousSubmitError(
      current.client_order_id,
      `Another process advanced durable intent ${current.client_order_id} to ${current.state}; ` +
        "this process attempted no broker POST and reconciliation is required.",
    ));
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
    // TIMING: record the broker's CUMULATIVE quantity for this snapshot, and — if the order has
    // reached a terminal state — close and publish the trace. Both are fail-open no-ops when
    // instrumentation is off, and neither can throw into the persistence path below.
    try {
      this.deps.timing?.markFill(order.client_order_id, order.filled_quantity);
      if (isBrokerOrderTerminal(order.state)) {
        this.markTiming(order.client_order_id, "terminal");
      }
    } catch {
      /* telemetry must never affect execution */
    }
    this.rememberFillIdentities(order);
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
      // ATTRIBUTION FOLLOWS THE DURABLE WRITE, NEVER THE CALLER'S SNAPSHOT.
      // `intent` here is whatever this async context loaded before its awaits, and a concurrent
      // reconcile pass legitimately holds the same stale copy. Attributing
      // `updated.filled_quantity - intent.filled_quantity` therefore credited one broker fill
      // twice, inflating `attributedBoxPositions` — the permission boundary for reduction and
      // recovery orders — so the manager could authorise reducing more than is actually held.
      const delta = this.durableFillDelta(result, intent);
      if (delta > 0) {
        const key = `${updated.exchange}:${updated.tradingsymbol}`;
        const prior = this.attributedBoxPositions.get(key) ?? 0;
        this.attributedBoxPositions.set(key, prior + (updated.side === "BUY" ? delta : -delta));
        this.recalculateGrossAttributedQuantity();
      }
      this.knownIntents.set(updated.client_order_id, updated);
      if (isBrokerOrderTerminal(order.state)) {
        this.releaseReservation(updated.client_order_id);
        // TIMING: publish only once the terminal snapshot is DURABLY recorded, so a sample can
        // never describe an outcome the system does not actually believe in. A trace whose
        // persistence failed is left to expire and is reported as lost measurement rather than
        // being published against an uncertain outcome.
        this.publishTiming(updated.client_order_id);
      }
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
    expectedStates?: readonly BoxOrderIntentState[],
  ): Promise<IBoxOrderIntent> {
    return (await this.transitionResult(intent, state, brokerOrderId, message, expectedStates)).intent;
  }

  /** Same transition, retaining whether THIS atomic compare-and-set won. */
  private async transitionResult(
    intent: IBoxOrderIntent,
    state: BoxOrderIntentState,
    brokerOrderId: string | null,
    message: string,
    expectedStates?: readonly BoxOrderIntentState[],
    payload?: Record<string, unknown> | null,
  ): Promise<OrderIntentUpdateResult & { intent: IBoxOrderIntent }> {
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
      auditFor(intent, state, brokerOrderId, message, null, at, payload),
      expectedStates,
    );
    const updated = result.intent;
    if (!updated) throw new Error(`Order intent ${intent.client_order_id} disappeared.`);
    if (!result.applied) {
      // The intent state machine REFUSED this transition. Returning the unchanged document made
      // that indistinguishable from success, so a caller could believe it had quarantined an
      // order that is still working.
      this.durableTransitionRefusals++;
      console.warn(
        `[Box] durable state transition ${intent.state} -> ${state} for ` +
          `${intent.client_order_id} was refused; the document is still ${updated.state}.`,
      );
      if (state === "RECONCILIATION_REQUIRED" && !RECONCILE_STATES.has(updated.state)) {
        // A refused quarantine is not survivable silently: uncertain broker state would look
        // resolved. Trip directly rather than via invariantViolation, which would recurse into
        // reconcile from inside a persistence path.
        this.trip(`quarantine transition refused for ${intent.client_order_id}`);
      }
    }
    this.knownIntents.set(updated.client_order_id, updated);
    return { ...result, intent: updated };
  }

  /**
   * The fill quantity THIS caller's durable write actually established.
   *
   * The only safe source is the guarded write's own pre-image/post-image pair:
   *
   *   applied === false            => 0. The write was refused, so this caller advanced nothing.
   *   applied === true             => current - previous, as recorded by the atomic update.
   *
   * Worked example of the race this closes — two callers holding `filled_quantity: 0` for one
   * order the broker filled 40:
   *
   *   A persists 40  ->  applied, pre 0,  post 40  ->  delta 40
   *   B persists 40  ->  applied, pre 40, post 40  ->  delta  0     (the `$lte` guard is
   *                                                                  deliberately non-strict, so
   *                                                                  B's write matches and is
   *                                                                  reported applied — but it
   *                                                                  advanced nothing)
   *
   * Total attributed 40, which is the truth. The old stale-snapshot arithmetic gave 80.
   *
   * A persistence layer that cannot report the transition gets NOTHING attributed and trips the
   * invariant. That direction is deliberate: under-attribution blocks reductions (safe), while
   * over-attribution authorises reducing more than is held (not safe). Reconciliation rebuilds
   * the map absolutely from the journal, so a missed increment is repaired rather than compounded.
   */
  private durableFillDelta(result: OrderIntentUpdateResult, intent: IBoxOrderIntent): number {
    if (!result.applied) return 0;
    const previous = result.previous_filled_quantity;
    const current = result.current_filled_quantity;
    if (typeof previous !== "number" || typeof current !== "number") {
      this.invariantViolation(
        `durable persistence did not report the fill transition for ${intent.client_order_id}; ` +
          `no exposure was attributed`,
      );
      return 0;
    }
    const delta = current - previous;
    if (delta < 0) {
      // The monotonic `$lte` guard forbids this. If it ever happens the durable quantity moved
      // backwards, which is a corruption, not a reduction — never feed it into exposure.
      this.invariantViolation(
        `durable filled quantity for ${intent.client_order_id} regressed ${previous} -> ${current}`,
      );
      return 0;
    }
    return delta;
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

  private mergePostLoadFlattenCharges(
    day: string,
    seedPnl: number,
    token: DailyRiskSeedToken | undefined,
    baselines: Record<string, number> | undefined,
  ): number {
    if (!token || token.tradingDay !== day) return seedPnl;
    let unseededCharges = 0;
    for (const mutation of this.flattenChargeMutationsByDay.get(day) ?? []) {
      if (mutation.generation <= token.mutationGeneration) continue;
      const seedBaselineValue = baselines?.[mutation.attemptId];
      const seedBaseline = Number.isFinite(seedBaselineValue)
        ? Math.round(Math.max(0, seedBaselineValue!) * 100) / 100
        : 0;
      // A loader may have observed none, part, or all of this local range. Add exactly the suffix
      // above both the mutation's prior watermark and the authoritative seed bucket.
      const representedThrough = Math.max(mutation.previousChargesForDay, seedBaseline);
      if (mutation.chargesForDay > representedThrough) {
        unseededCharges += mutation.chargesForDay - representedThrough;
      }
    }
    return Math.round((seedPnl - unseededCharges) * 100) / 100;
  }

  private settleDailyRiskSeedToken(token: DailyRiskSeedToken): void {
    this.activeDailyRiskSeedTokens.delete(token.loadGeneration);
    this.compactFlattenChargeMutations(token.tradingDay);
  }

  /** Retain exactly the mutation suffix an active loader can still need. */
  private compactFlattenChargeMutations(day: string): void {
    const active = [...this.activeDailyRiskSeedTokens.values()]
      .filter((token) => token.tradingDay === day);
    if (active.length === 0) {
      this.flattenChargeMutationsByDay.delete(day);
      return;
    }
    const oldestBoundary = Math.min(...active.map((token) => token.mutationGeneration));
    const retained = (this.flattenChargeMutationsByDay.get(day) ?? [])
      .filter((mutation) => mutation.generation > oldestBoundary);
    if (retained.length === 0) this.flattenChargeMutationsByDay.delete(day);
    else this.flattenChargeMutationsByDay.set(day, retained);
  }

  private rollTradingDay(): void {
    const next = this.dayKey();
    if (next === this.tradingDay) return;
    this.tradingDay = next;
    // No prior-day loader may pin memory or occupy the one current-day slot. Logical cancellation
    // is enough even when the database operation itself cannot be aborted: generation checks make
    // every eventual completion inert.
    if (this.activeDailyRiskLoad && this.activeDailyRiskLoad.day !== next) {
      this.seedTimer().clearTimeout(this.activeDailyRiskLoad.timeout);
      this.settleDailyRiskSeedToken(this.activeDailyRiskLoad.token);
      this.activeDailyRiskLoad = null;
    }
    for (const token of [...this.activeDailyRiskSeedTokens.values()]) {
      if (token.tradingDay !== next) this.settleDailyRiskSeedToken(token);
    }
    for (const day of [...this.flattenChargeMutationsByDay.keys()]) {
      if (day !== next) this.flattenChargeMutationsByDay.delete(day);
    }
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
    if (this.activeDailyRiskLoad || this.disposed) return;
    const day = this.tradingDay;
    const loader = this.deps.loadDailyRiskSeed;
    if (!loader) {
      this.health.daily_risk_seed = "failed";
      return;
    }
    const token = this.beginDailyRiskSeed(day);
    const generation = token.loadGeneration;
    this.health.daily_risk_seed = "seeding";
    const timeout = this.seedTimer().setTimeout(() => {
      const active = this.activeDailyRiskLoad;
      if (!active || active.generation !== generation) return;
      this.activeDailyRiskLoad = null;
      this.settleDailyRiskSeedToken(token);
      if (day === this.tradingDay) this.health.daily_risk_seed = "failed";
      // Release the slot and immediately request the newest day. The timed-out promise may settle
      // later, but it no longer owns a generation and therefore cannot install anything.
      if (!this.disposed) {
        this.rollTradingDay();
        this.refreshDailyRiskSeed();
      }
    }, Math.max(1, this.deps.dailyRiskSeedTimeoutMs ?? 30_000));
    this.activeDailyRiskLoad = { generation, day, token, timeout };

    void Promise.resolve()
      .then(() => loader(day))
      .then((seed) => {
        const active = this.activeDailyRiskLoad;
        if (!active || active.generation !== generation || day !== this.tradingDay ||
            !this.activeDailyRiskSeedTokens.has(token.loadGeneration)) return;
        this.seedTimer().clearTimeout(active.timeout);
        this.activeDailyRiskLoad = null;
        this.seedLimits({
          tradingDay: day,
          realisedPnlToday: Number.isFinite(seed.realisedPnl) ? seed.realisedPnl : 0,
          rejects: seed.rejects,
          consecutiveFailures: seed.consecutiveFailures,
          seedToken: token,
          flattenChargeBaselinesForDay: seed.flattenChargeBaselinesForDay,
          incomplete: seed.incomplete,
        });
        // Reconciliation owns the final entry-ready flag. Defer so the load slot is visibly free.
        const deferred = setTimeout(() => void this.reconcile().catch(() => undefined), 0);
        deferred.unref?.();
      })
      .catch(() => {
        const active = this.activeDailyRiskLoad;
        if (!active || active.generation !== generation) return;
        this.seedTimer().clearTimeout(active.timeout);
        this.activeDailyRiskLoad = null;
        this.settleDailyRiskSeedToken(token);
        if (day === this.tradingDay) this.health.daily_risk_seed = "failed";
      });
  }

  private seedTimer(): DailyRiskSeedTimer {
    if (this.deps.dailyRiskSeedTimer) return this.deps.dailyRiskSeedTimer;
    return {
      setTimeout: (callback, delayMs) => {
        const handle = setTimeout(callback, delayMs);
        handle.unref?.();
        return handle;
      },
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    };
  }

  private isCrashRecoveryEntryQuarantined(): boolean {
    if (!this.crashOnlyAttributedExposure) return false;
    try {
      return !(this.deps.isCrashRecoveryPersistenceReady?.() ?? false);
    } catch {
      return true;
    }
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
  payload: Record<string, unknown> | null = null,
): BoxOrderIntentAudit {
  return {
    audit_id: `${intent.client_order_id}:${intent.state}->${state}:${brokerOrderId ?? "none"}:${fillIdentity ?? "none"}`,
    at: new Date(now),
    from_state: intent.state,
    to_state: state,
    broker_order_id: brokerOrderId,
    message,
    fill_identity: fillIdentity,
    payload,
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
