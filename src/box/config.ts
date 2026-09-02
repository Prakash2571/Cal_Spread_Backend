/**
 * Box-scanner configuration.
 *
 * Everything the trading rules depend on is here and overridable by env var, so
 * the thresholds can be tuned without touching the engine. The headline
 * DEFAULTS are:
 *
 *   BOX_MIN_EXPECTED_NET_PROFIT  ₹1,200 — THE ENTRY GATE, after every cost
 *   MIN_BOX_GROSS_EDGE           ₹1,200 — a cheap prefilter only
 *   BOX_SAFETY_BUFFER            ₹150   — risk allowance inside the net figure
 *   BOX_EXECUTION_MODE           paper_latency
 *   BOX_SIMULATED_LATENCY_MS     250 ms — decision → exchange arrival
 *   BOX_QUOTE_MAX_AGE_MS         15,000 ms — how long an UNCHANGED book is valid
 *   strikes each side            3  (ATM ± 3 → at most 7 strikes → 21 pairs)
 */

import type { BoxQueueModel, BoxScannerConfigSnapshot, ExecutionMode } from "./types.js";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return fallback;
}

/** Parse a comma-separated list of IST hours (0-23), de-duplicated and sorted. */
function hours(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 23);
  if (parsed.length === 0) return fallback;
  return [...new Set(parsed)].sort((a, b) => a - b);
}

/** Clamp any input to a valid hour-of-day (0-23). */
function clampHour(v: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  const n = Math.round(v);
  if (n < 0 || n > 23) return fallback;
  return n;
}

/** Clamp any input to a valid strikes-each-side level: 1, 2 or 3. */
export function clampStrikeLevel(v: number): 1 | 2 | 3 {
  const n = Math.round(v);
  if (n <= 1) return 1;
  if (n >= 3) return 3;
  return 2;
}

/**
 * Clamp an integer to [min, max] with a fallback for garbage input.
 *
 * Used for the new execution-realism knobs (chase ticks, dispersion), so a typo
 * in an env var can never widen the price band without bound or turn a delay
 * negative.
 */
function clampInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/** Clamp a percentage to [0, 100]. */
function clampPct(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(100, Math.max(0, v));
}

function queueModel(name: string, fallback: BoxQueueModel): BoxQueueModel {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "none") return "none";
  if (v === "haircut") return "haircut";
  console.warn(`[Box] ignoring unknown ${name}="${raw}" — using ${fallback}.`);
  return fallback;
}

function executionMode(name: string, fallback: ExecutionMode): ExecutionMode {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (
    value === "paper_touch" ||
    value === "paper_latency" ||
    value === "paper_legging" ||
    value === "live"
  ) {
    return value;
  }
  // Execution selection is safety-critical. A misspelling must stop startup,
  // never silently switch the process to a different execution model.
  throw new Error(
    `[Box] invalid ${name}="${raw}"; expected paper_touch, paper_latency, paper_legging, or live.`,
  );
}

export interface BoxConfig {
  // ---- Execution model ----
  /**
   * How a paper fill is simulated.
   *
   * "paper_latency" (default) waits a simulated decision + send delay and then
   * fills from the first WebSocket book published at or after that moment, so a
   * recorded fill is always a price the market actually showed AFTER the order
   * could have arrived. "paper_touch" fills at the detection touch and is kept
   * for comparison.
   */
  executionMode: ExecutionMode;
  /** Simulated internal decision/processing time before an order is "sent" (ms). */
  simulatedDecisionMs: number;
  /** Simulated order-send → exchange arrival latency (ms). */
  simulatedLatencyMs: number;
  /**
   * How long the simulator waits for a post-arrival book on every leg (ms).
   *
   * If a leg publishes nothing in that window there is no evidence of what it
   * would have filled at, so NO fill is invented — the attempt is recorded as
   * `missing_book`.
   */
  executionMaxWaitMs: number;
  /** How often the simulator re-checks for post-arrival books (ms). */
  executionPollMs: number;
  /** Cap on simultaneous simulated execution pipelines. */
  maxConcurrentExecutions: number;

  // ---- Live execution safety envelope (env-only, fail-closed) ----
  /** Deployment kill switch. `executionMode=live` is invalid unless this is true. */
  liveTradingEnabled: boolean;
  /** Low-frequency broker reconciliation cadence. */
  liveReconcileIntervalMs: number;
  /** Quiet period after a feed reconnect before a new entry may be submitted. */
  liveFeedReconnectWarmupMs: number;
  liveMaxOpenBoxes: number;
  liveMaxConcurrentExecutions: number;
  liveMaxResidualLegs: number;
  liveDailyLossLimit: number;
  liveRejectLimit: number;
  liveConsecutiveFailureLimit: number;
  /** Maximum quantity in one live leg and across all absolute open leg quantities. */
  liveMaxOpenLegQuantity: number;
  liveMaxGrossOpenLegQuantity: number;
  /** Distinct bounded deadlines for transport and broker lifecycle phases. */
  liveHttpTimeoutMs: number;
  liveAckTimeoutMs: number;
  liveWorkingTimeoutMs: number;
  livePartialTimeoutMs: number;
  liveCancelTimeoutMs: number;
  liveMaxModifications: number;
  liveMaxChaseTicks: number;
  /** Minimum interval between broker transport calls. */
  liveBrokerMinIntervalMs: number;

  // ---- paper_legging: four independent orders ----
  /** How the four legs are submitted: "parallel" (default) or "sequential". */
  legExecutionMode: "parallel" | "sequential";
  /** How long a leg may rest before it is deemed unfilled and the box aborts (ms). */
  legTimeoutMs: number;
  /** Simulated latency for the emergency unwind of partial fills (ms). */
  legUnwindLatencyMs: number;

  // ---- paper_legging: executable order pricing (marketable-limit) ----
  /**
   * How many ticks past the reference touch an ENTRY marketable-limit order may
   * chase. The limit price is `reference ± maxChaseTicks × tickSize` (up for a
   * BUY, down for a SELL). A depth level worse than the limit is never filled —
   * this is what stops a simulated order behaving like an unrestricted market
   * order that consumes whatever the book shows on arrival.
   */
  legMaxChaseTicks: number;
  /**
   * Chase band for an EMERGENCY UNWIND, which may deliberately tolerate a wider
   * price band than a normal entry because flattening exposure is more urgent
   * than getting a good price. Defaults higher than `legMaxChaseTicks`.
   */
  unwindMaxChaseTicks: number;
  /**
   * Fallback tick size (₹) when an instrument's real tick size is unavailable.
   * The real tick size from the instrument dump is preferred wherever present.
   */
  defaultTickSize: number;

  // ---- paper_legging: conservative queue-position approximation ----
  /**
   * How displayed depth is treated as executable for our simulated order.
   *
   *   "none"    — the full displayed quantity at each level is assumed available.
   *   "haircut" — only a fraction of the displayed quantity is treated as safely
   *               executable, a transparent stand-in for the queue ahead of us
   *               that we cannot observe from level-2 data.
   *
   * This is NOT a reconstruction of true NSE order-level queue priority (which is
   * not derivable from level-2 depth); it is a deterministic, configurable
   * approximation that lets a paper run compare raw vs conservative liquidity.
   */
  queueModel: BoxQueueModel;
  /**
   * Percentage of displayed quantity assumed to be QUEUED AHEAD of our order and
   * therefore not available to us, when `queueModel === "haircut"`. Effective
   * quantity at a level is `floor(displayed × (1 − pct/100))`. Deterministic; no
   * randomness.
   */
  queueLiquidityHaircutPct: number;

  // ---- paper_legging: four-leg temporal coherence ----
  /**
   * Maximum spread (ms) between the newest and oldest leg EXCHANGE timestamps a
   * candidate may show and still auto-enter. When all four legs carry valid
   * exchange timestamps and the dispersion exceeds this, the candidate is rejected
   * as `cross_leg_time_skew` rather than traded on books that are not a coherent
   * cross-sectional snapshot. 0 disables the check. When any leg lacks an exchange
   * timestamp the check is skipped and the existing receive-time logic stands.
   */
  maxCrossLegExchangeDispersionMs: number;

  // ---- Entry qualification ----
  /**
   * THE ENTRY GATE: minimum EXPECTED NET PROFIT (₹).
   *
   *   expectedNet = grossEdge
   *               - entryCharges
   *               - estimatedExitCharges
   *               - executionCost (measured entry slippage + exit allowance)
   *               - safetyBuffer
   *
   * Evaluated on the EXECUTION snapshot, not merely on detection.
   */
  minExpectedNetProfit: number;
  /**
   * A cheap gross PREFILTER (₹) — performance only, never the decision.
   *
   * It must UNDER-state the true requirement, because its only job is to skip
   * candidates that cannot possibly qualify. Since the net gate above always
   * needs more gross than this, it can never discard a qualifying box.
   */
  minGrossEdge: number;
  /**
   * Legacy extra floor (₹) on the projected net edge. When set above 0 it raises
   * the effective requirement to max(minExpectedNetProfit, minNetEdge), so an
   * existing MIN_BOX_NET_EDGE deployment keeps its stricter behaviour.
   */
  minNetEdge: number;
  /** Risk/safety allowance (₹) deducted inside the expected-net figure. */
  safetyBuffer: number;
  /**
   * Expected ENTRY execution cost (₹) used before a real measurement exists —
   * i.e. in the published opportunity projection. Once the execution simulator
   * has run, the MEASURED slippage replaces it.
   */
  expectedEntrySlippage: number;
  /**
   * Expected EXIT execution cost (₹). Always an estimate: the unwind has not
   * happened yet, so its slippage cannot be measured at entry time.
   */
  expectedExitSlippage: number;
  /**
   * A deliberate LOWER bound on what a round trip can cost in charges (₹), used
   * only by the prefilter. Eight option orders at ₹20 brokerage plus GST is
   * already ≈ ₹189, so ₹160 is safe.
   */
  prefilterChargeAllowance: number;
  /**
   * Whether a box may be auto-entered when its charges could not be determined.
   *
   * With the local calculator this is virtually always possible, so it now only
   * guards genuinely pathological input (a zero-price leg).
   */
  requirePricedCharges: boolean;

  // ---- Charges ----
  /** Verify local charge maths against Zerodha asynchronously after a fill. */
  reconcileCharges: boolean;
  /** Warn when |local - Zerodha| exceeds this percentage of the Zerodha total. */
  chargeReconcileWarnPct: number;
  /** Max concurrent reconciliation calls (Zerodha must not be hammered). */
  chargeReconcileConcurrency: number;
  /**
   * How many times one verification may be tried before the charges are recorded
   * as unverified. Bounded so a broker outage can never become a hot retry loop.
   */
  chargeReconcileMaxAttempts: number;
  /** Linear backoff base (ms): attempt N waits N × this. */
  chargeReconcileRetryBaseMs: number;

  // ---- Market-data quality ----
  /**
   * How long an UNCHANGED order book is still trusted (ms).
   *
   * A depth feed only sends a message when the book actually changes, so silence
   * is not staleness: a resting book nobody has touched for ten seconds is still
   * the current, executable book. The protection against a genuinely dead feed is
   * `feedMaxAgeMs`.
   */
  quoteMaxAgeMs: number;
  /**
   * FEED LIVENESS: maximum age (ms) of the newest tick across the WHOLE box
   * universe. When it trips, no entry and no automatic exit happens at all.
   */
  feedMaxAgeMs: number;
  /** Maximum age (ms) of the underlying value used to place the ATM window. */
  underlyingMaxAgeMs: number;

  // ---- Strike window ----
  /**
   * The MAXIMUM strikes each side of ATM the module ever builds. Fixed at 3.
   *
   * The ACTIVE level (1, 2 or 3) is a separate runtime control the admin sets —
   * see `defaultStrikeLevel` and BoxEngine.setStrikeLevel. This cap never rises,
   * so an admin can only ever narrow the window, never widen it past ATM ±3.
   */
  readonly strikesEachSide: 3;
  /**
   * The active strikes-each-side level at boot: 1, 2 or 3 (default 3).
   *
   * Admin-adjustable at runtime. Narrowing it only affects which NEW boxes are
   * discovered; positions already open are never touched by a change.
   */
  defaultStrikeLevel: 1 | 2 | 3;
  /**
   * Extra fraction of a strike step the spot must travel PAST the midpoint
   * before the ATM is re-centred.
   */
  atmHysteresis: number;
  /** Minimum gap (ms) between two window rebuilds for one underlying. */
  windowMinIntervalMs: number;
  /** Evaluate SHORT boxes as well as LONG boxes. */
  enableShortBox: boolean;

  // ---- Exit rules ----
  /** Floor of the convergence threshold (₹). */
  convergenceFloor: number;
  /** Fraction of the original entry net edge used as the threshold. */
  convergencePct: number;
  /** Minimum realisable NET profit (₹) for any normal (non-emergency) exit. */
  minExitNetPnl: number;
  /**
   * Whether a normal auto-exit's profit floor is judged on REALISABLE net
   * (touch net − expected exit-slippage allowance) rather than raw touch net.
   * Once the exit actually executes, the check re-runs on the actual price with
   * no allowance. Default true.
   */
  exitUseRealisableNet: boolean;
  /** Net profit that alone justifies taking profit, as a fraction of net edge. */
  profitCapturePct: number;
  /** Fraction of the ORIGINAL edge captured that alone justifies an exit. */
  minCapturedPct: number;

  // ---- Expiry safety ----
  /** Minutes before the close on expiry day to start forcing an exit. */
  expirySafetyMinutesBeforeClose: number;

  // ---- Scheduling / capacity ----
  /** Watchdog cadence (ms); WS depth ticks drive normal exit evaluation. */
  monitorIntervalMs: number;
  /** How often (ms) open-trade live fields are flushed to Mongo. */
  persistIntervalMs: number;
  /** SSE publish cadence (ms) — the UI never needs every exchange tick. */
  publishIntervalMs: number;
  /** How often (ms) the universe/expiry/window set is refreshed. */
  universeRefreshMs: number;
  /** How often (ms) the last-close view is rebuilt while the market is shut. */
  indicativeRefreshMs: number;
  /**
   * Whether the last-close view is built for the WHOLE universe while the market
   * is shut and the scanner is stopped.
   *
   * With the exchange closed there is nothing to execute and no tick feed to pay
   * for, so the strike windows can be built and priced from REST /quote purely to
   * be looked at — which is the only way to see which boxes were mispriced at the
   * close without pressing RUN. It subscribes NOTHING: indicative windows never
   * cost a feed subscription, so this cannot affect live trading capacity.
   */
  indicativeDiscovery: boolean;
  /**
   * Cap on underlyings given an indicative-only window (0 = no cap).
   *
   * Indicative windows cost no feed subscription, so `maxSubscribedTokens` does not
   * bound them — without a separate cap a stopped engine would hold a window and a
   * full candidate set for every F&O underlying and re-quote all of it every
   * `indicativeRefreshMs`, all night. The board is priority-ordered, so the cap
   * keeps the most liquid names.
   */
  indicativeMaxUnderlyings: number;
  /** Cap on simultaneously subscribed box option tokens. */
  maxSubscribedTokens: number;
  /** Cap on underlyings scanned (0 = no cap beyond the token budget). */
  maxUnderlyings: number;
  /** TTL (ms) of a cached charge estimate for one candidate at given prices. */
  chargeCacheTtlMs: number;
  /** Max concurrent Zerodha charge estimations in flight. */
  chargeConcurrency: number;
  /** Opportunities published to the UI. */
  maxPublishedOpportunities: number;
  /** Samples kept in each rolling metrics ring buffer. */
  metricsWindow: number;

  // ---- Daily P&L cache + nightly archive ----
  /**
   * Master switch for the live P&L cache and its nightly archive.
   *
   * When on (and Upstash Redis is configured), the running net P&L of the day's
   * box trades — open positions AND trades closed today — is mirrored to Redis on
   * a slow cadence, then drained into the `box_daily_pnl` Mongo collection once a
   * night. OFF by default: with it unset the module behaves exactly as before and
   * touches neither Redis nor the new collection.
   */
  pnlCacheEnabled: boolean;
  /** How often (ms) the running day-P&L snapshot is mirrored to Redis. */
  pnlCacheIntervalMs: number;
  /** TTL (seconds) on a day's cached P&L hash — long enough to outlive verify. */
  pnlCacheTtlSec: number;
  /** IST hour (0-23) at which the day's cached P&L is drained to Mongo. */
  pnlArchiveHour: number;
  /**
   * IST hours (0-23) at which the archive is re-checked and completed if the 9 PM
   * drain did not finish (e.g. Redis or Mongo was briefly unavailable).
   */
  pnlVerifyHours: number[];
  /** Delay (ms) between each document while streaming the archive into Mongo. */
  pnlArchiveDrainDelayMs: number;

  // ---- Today's closed trades: Redis read-path cache ----
  /**
   * Mirror TODAY's closed trades to Redis so the Closed-trades tab loads without
   * a full-book Mongo query. ON by default (unlike the P&L cache): it is a pure
   * read accelerator, and with no Upstash configured it is inert and every read
   * falls back to Mongo. See closedCache.ts.
   */
  closedCacheEnabled: boolean;
  /** TTL (seconds) on a day's cached closed-trade hash. */
  closedCacheTtlSec: number;
}

/* ------------------------------ live tuning ------------------------------- */

/**
 * The thresholds an admin may change at RUNTIME from the UI.
 *
 * Deliberately just these two. They are the numbers an operator tunes while
 * watching the market — the entry gate and the risk allowance inside it — and
 * both are pure decision inputs: changing one alters which NEW boxes qualify and
 * nothing else. Positions already open are never re-judged, and every trade keeps
 * the `scanner_config_snapshot` of the settings it was actually taken under, so
 * history stays interpretable after a change.
 *
 * Everything else in BoxConfig stays env-only on purpose: latencies, feed
 * freshness and capacity limits describe the execution model, not an operator
 * preference, and letting them drift at runtime would make paper fills
 * incomparable across a session.
 */
export interface BoxTuning {
  /** THE ENTRY GATE: minimum expected NET profit (₹). */
  minExpectedNetProfit: number;
  /** Risk/safety allowance (₹) deducted inside the expected-net figure. */
  safetyBuffer: number;
}

/** Hard bounds on a tunable, so a typo cannot disable the gate or wedge it shut. */
export const BOX_TUNING_LIMITS: Record<keyof BoxTuning, { min: number; max: number }> = {
  // A zero gate is legitimate (take every box that is net-positive at all), but a
  // negative one would mean "enter at a known loss", which is never intended.
  minExpectedNetProfit: { min: 0, max: 1_000_000 },
  safetyBuffer: { min: 0, max: 1_000_000 },
};

/** The current live values of the tunables. */
export function readTuning(cfg: BoxConfig): BoxTuning {
  return {
    minExpectedNetProfit: cfg.minExpectedNetProfit,
    safetyBuffer: cfg.safetyBuffer,
  };
}

/**
 * Validate a partial tuning patch.
 *
 * Returns the accepted (rounded, in-range) values, or an error message naming the
 * offending field. Rejects rather than clamps: silently accepting ₹99,999,999 as
 * an entry gate would look like it worked and then never trade again.
 */
export function validateTuning(
  patch: Partial<Record<keyof BoxTuning, unknown>>,
): { ok: true; values: Partial<BoxTuning> } | { ok: false; error: string } {
  const values: Partial<BoxTuning> = {};
  for (const key of Object.keys(BOX_TUNING_LIMITS) as (keyof BoxTuning)[]) {
    const raw = patch[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const v = Number(raw);
    const { min, max } = BOX_TUNING_LIMITS[key];
    if (!Number.isFinite(v)) {
      return { ok: false, error: `${key} must be a number.` };
    }
    if (v < min || v > max) {
      return { ok: false, error: `${key} must be between ₹${min} and ₹${max}.` };
    }
    values[key] = Math.round(v);
  }
  if (Object.keys(values).length === 0) {
    return { ok: false, error: "Nothing to update — send minExpectedNetProfit and/or safetyBuffer." };
  }
  return { ok: true, values };
}

/**
 * The Mongo `box_settings` key each tunable is persisted under.
 *
 * Stable strings, not the TS field names, so renaming a config field later cannot
 * silently orphan a saved value.
 */
export const BOX_TUNING_KEYS: Record<keyof BoxTuning, string> = {
  minExpectedNetProfit: "min_expected_net_profit",
  safetyBuffer: "safety_buffer",
};

export function loadBoxConfig(): BoxConfig {
  const mode = executionMode("BOX_EXECUTION_MODE", "paper_latency");
  const liveTradingEnabled = bool("BOX_LIVE_TRADING_ENABLED", false);
  if (mode === "live" && !liveTradingEnabled) {
    throw new Error(
      "[Box] BOX_EXECUTION_MODE=live requires BOX_LIVE_TRADING_ENABLED=true; refusing to start live execution.",
    );
  }

  return {
    executionMode: mode,
    simulatedDecisionMs: num("BOX_SIMULATED_DECISION_MS", 40),
    simulatedLatencyMs: num("BOX_SIMULATED_LATENCY_MS", 250),
    executionMaxWaitMs: num("BOX_EXECUTION_MAX_WAIT_MS", 1500),
    executionPollMs: num("BOX_EXECUTION_POLL_MS", 20),
    maxConcurrentExecutions: num("BOX_MAX_CONCURRENT_EXECUTIONS", 8),

    liveTradingEnabled,
    liveReconcileIntervalMs: clampInt("BOX_LIVE_RECONCILE_INTERVAL_MS", 60_000, 5_000, 15 * 60_000),
    liveFeedReconnectWarmupMs: clampInt("BOX_LIVE_FEED_RECONNECT_WARMUP_MS", 5_000, 0, 5 * 60_000),
    liveMaxOpenBoxes: clampInt("BOX_LIVE_MAX_OPEN_BOXES", 1, 0, 20),
    liveMaxConcurrentExecutions: clampInt("BOX_LIVE_MAX_CONCURRENT_EXECUTIONS", 1, 1, 4),
    liveMaxResidualLegs: clampInt("BOX_LIVE_MAX_RESIDUAL_LEGS", 1, 0, 4),
    liveDailyLossLimit: clampInt("BOX_LIVE_DAILY_LOSS_LIMIT", 5_000, 0, 10_000_000),
    liveRejectLimit: clampInt("BOX_LIVE_REJECT_LIMIT", 3, 1, 100),
    liveConsecutiveFailureLimit: clampInt("BOX_LIVE_CONSECUTIVE_FAILURE_LIMIT", 3, 1, 100),
    liveMaxOpenLegQuantity: clampInt("BOX_LIVE_MAX_OPEN_LEG_QUANTITY", 100, 1, 1_000_000),
    liveMaxGrossOpenLegQuantity: clampInt("BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY", 400, 1, 4_000_000),
    liveHttpTimeoutMs: clampInt("BOX_LIVE_HTTP_TIMEOUT_MS", 5_000, 250, 30_000),
    liveAckTimeoutMs: clampInt("BOX_LIVE_ACK_TIMEOUT_MS", 3_000, 250, 30_000),
    liveWorkingTimeoutMs: clampInt("BOX_LIVE_WORKING_TIMEOUT_MS", 30_000, 1_000, 10 * 60_000),
    livePartialTimeoutMs: clampInt("BOX_LIVE_PARTIAL_TIMEOUT_MS", 10_000, 500, 5 * 60_000),
    liveCancelTimeoutMs: clampInt("BOX_LIVE_CANCEL_TIMEOUT_MS", 5_000, 250, 60_000),
    liveMaxModifications: clampInt("BOX_LIVE_MAX_MODIFICATIONS", 2, 0, 10),
    liveMaxChaseTicks: clampInt("BOX_LIVE_MAX_CHASE_TICKS", 2, 0, 20),
    liveBrokerMinIntervalMs: clampInt("BOX_LIVE_BROKER_MIN_INTERVAL_MS", 250, 50, 5_000),

    legExecutionMode:
      (process.env.BOX_LEG_EXECUTION_MODE?.trim().toLowerCase() === "sequential"
        ? "sequential"
        : "parallel"),
    legTimeoutMs: num("BOX_LEG_TIMEOUT_MS", 500),
    legUnwindLatencyMs: num("BOX_LEG_UNWIND_LATENCY_MS", 150),

    // Executable order pricing. 2 ticks (₹0.10 at a ₹0.05 tick) of chase on entry
    // is a marketable limit that tolerates a small in-flight move but refuses a
    // runaway one; unwinds get a wider band because flattening matters more.
    legMaxChaseTicks: clampInt("BOX_LEG_MAX_CHASE_TICKS", 2, 0, 100),
    unwindMaxChaseTicks: clampInt("BOX_UNWIND_MAX_CHASE_TICKS", 5, 0, 200),
    defaultTickSize: (() => {
      const v = num("BOX_DEFAULT_TICK_SIZE", 0.05);
      return v > 0 ? v : 0.05;
    })(),

    // Conservative queue approximation, on by default: treat 30% of displayed
    // depth as queued ahead of us. Set BOX_QUEUE_MODEL=none for raw displayed
    // liquidity (the optimistic comparison baseline).
    queueModel: queueModel("BOX_QUEUE_MODEL", "haircut"),
    queueLiquidityHaircutPct: clampPct("BOX_QUEUE_LIQUIDITY_HAIRCUT_PCT", 30),

    // Four-leg exchange-timestamp coherence. 250ms is generous for a genuine
    // cross-sectional snapshot yet rejects legs that are visibly out of step.
    maxCrossLegExchangeDispersionMs: clampInt("BOX_MAX_CROSS_LEG_EXCHANGE_DISPERSION_MS", 250, 0, 60_000),

    // THE gate: ₹1,200 of expected net profit after every cost.
    minExpectedNetProfit: num("BOX_MIN_EXPECTED_NET_PROFIT", 1200),
    // Prefilter only.
    minGrossEdge: num("MIN_BOX_GROSS_EDGE", 1200),
    minNetEdge: num("MIN_BOX_NET_EDGE", 0),
    safetyBuffer: num("BOX_SAFETY_BUFFER", 150),
    expectedEntrySlippage: num("BOX_EXPECTED_ENTRY_SLIPPAGE", 250),
    expectedExitSlippage: num("BOX_EXPECTED_EXIT_SLIPPAGE", 250),
    prefilterChargeAllowance: num("BOX_PREFILTER_CHARGE_ALLOWANCE", 160),
    requirePricedCharges: bool("BOX_REQUIRE_PRICED_CHARGES", true),

    reconcileCharges: bool("BOX_RECONCILE_CHARGES", true),
    chargeReconcileWarnPct: num("BOX_CHARGE_RECONCILE_WARN_PCT", 5),
    chargeReconcileConcurrency: num("BOX_CHARGE_RECONCILE_CONCURRENCY", 2),
    chargeReconcileMaxAttempts: num("BOX_CHARGE_RECONCILE_MAX_ATTEMPTS", 3),
    chargeReconcileRetryBaseMs: num("BOX_CHARGE_RECONCILE_RETRY_BASE_MS", 5_000),

    quoteMaxAgeMs: num("BOX_QUOTE_MAX_AGE_MS", 15_000),
    feedMaxAgeMs: num("BOX_FEED_MAX_AGE_MS", 5_000),
    underlyingMaxAgeMs: num("BOX_UNDERLYING_MAX_AGE_MS", 10_000),

    strikesEachSide: 3,
    defaultStrikeLevel: clampStrikeLevel(num("BOX_STRIKE_LEVEL", 3)),
    atmHysteresis: num("BOX_ATM_HYSTERESIS", 0.15),
    windowMinIntervalMs: num("BOX_WINDOW_MIN_INTERVAL_MS", 15_000),
    enableShortBox: bool("BOX_ENABLE_SHORT_BOX", true),

    convergenceFloor: num("BOX_CONVERGENCE_FLOOR", 200),
    convergencePct: num("BOX_CONVERGENCE_PCT", 0.2),
    minExitNetPnl: num("BOX_MIN_EXIT_NET_PNL", 600),
    exitUseRealisableNet: bool("BOX_EXIT_USE_REALISABLE", true),
    profitCapturePct: num("BOX_PROFIT_CAPTURE_PCT", 0.75),
    minCapturedPct: num("BOX_MIN_CAPTURED_PCT", 0.75),

    expirySafetyMinutesBeforeClose: num("BOX_EXPIRY_SAFETY_MINUTES", 45),

    monitorIntervalMs: num("BOX_MONITOR_INTERVAL_MS", 1000),
    persistIntervalMs: num("BOX_PERSIST_INTERVAL_MS", 30_000),
    publishIntervalMs: num("BOX_PUBLISH_INTERVAL_MS", 500),
    universeRefreshMs: num("BOX_UNIVERSE_REFRESH_MS", 60_000),
    indicativeRefreshMs: num("BOX_INDICATIVE_REFRESH_MS", 60_000),
    indicativeDiscovery: bool("BOX_INDICATIVE_DISCOVERY", true),
    // ~150 underlyings × 14 legs ≈ 2,100 tokens ≈ 5 chunked /quote requests a
    // minute, comparable to what a running scanner already costs.
    indicativeMaxUnderlyings: num("BOX_INDICATIVE_MAX_UNDERLYINGS", 150),
    maxSubscribedTokens: num("BOX_MAX_SUBSCRIBED_TOKENS", 2200),
    maxUnderlyings: num("BOX_MAX_UNDERLYINGS", 0),
    chargeCacheTtlMs: num("BOX_CHARGE_CACHE_TTL_MS", 30_000),
    chargeConcurrency: num("BOX_CHARGE_CONCURRENCY", 3),
    maxPublishedOpportunities: num("BOX_MAX_PUBLISHED_OPPORTUNITIES", 60),
    metricsWindow: num("BOX_METRICS_WINDOW", 500),

    pnlCacheEnabled: bool("BOX_PNL_CACHE_ENABLED", false),
    pnlCacheIntervalMs: num("BOX_PNL_CACHE_INTERVAL_MS", 30_000),
    pnlCacheTtlSec: num("BOX_PNL_CACHE_TTL_SEC", 3 * 24 * 60 * 60),
    pnlArchiveHour: clampHour(num("BOX_PNL_ARCHIVE_HOUR", 21), 21),
    pnlVerifyHours: hours("BOX_PNL_VERIFY_HOURS", [22, 23]),
    pnlArchiveDrainDelayMs: num("BOX_PNL_ARCHIVE_DRAIN_DELAY_MS", 50),

    closedCacheEnabled: bool("BOX_CLOSED_CACHE_ENABLED", true),
    closedCacheTtlSec: num("BOX_CLOSED_CACHE_TTL_SEC", 3 * 24 * 60 * 60),
  };
}

/**
 * The minimum expected NET profit a box must show to be entered.
 *
 * One number, one decision path: the new gate, raised by the legacy
 * MIN_BOX_NET_EDGE floor if somebody has deliberately configured a stricter one.
 */
export function requiredNetProfit(
  cfg: Pick<BoxConfig, "minExpectedNetProfit" | "minNetEdge">,
): number {
  return Math.max(cfg.minExpectedNetProfit, cfg.minNetEdge > 0 ? cfg.minNetEdge : 0);
}

/**
 * The gross edge (₹) a candidate must clear before it is worth running the full
 * qualification and execution pipeline on it — the FAST LOCAL PREFILTER.
 *
 * Deliberately a LOWER bound. The real gate needs
 * `requiredNetProfit + charges + executionCost + buffer` of gross, which is
 * strictly more than this, so the prefilter cannot discard a box that would have
 * qualified.
 */
export function prefilterGrossThreshold(cfg: BoxConfig): number {
  return Math.max(0, cfg.minGrossEdge);
}

/** The immutable settings frozen onto every trade document. */
export function configSnapshot(cfg: BoxConfig): BoxScannerConfigSnapshot {
  return {
    min_gross_edge: cfg.minGrossEdge,
    min_net_edge: cfg.minNetEdge,
    min_expected_net_profit: requiredNetProfit(cfg),
    safety_buffer: cfg.safetyBuffer,
    expected_entry_slippage: cfg.expectedEntrySlippage,
    expected_exit_slippage: cfg.expectedExitSlippage,
    quote_max_age_ms: cfg.quoteMaxAgeMs,
    strikes_each_side: cfg.strikesEachSide,
    convergence_floor: cfg.convergenceFloor,
    convergence_pct: cfg.convergencePct,
    min_exit_net_pnl: cfg.minExitNetPnl,
    profit_capture_pct: cfg.profitCapturePct,
    min_captured_pct: cfg.minCapturedPct,
    execution_mode: cfg.executionMode,
    simulated_decision_ms: cfg.simulatedDecisionMs,
    simulated_latency_ms: cfg.simulatedLatencyMs,
    live_trading_enabled: cfg.liveTradingEnabled,
    live_reconcile_interval_ms: cfg.liveReconcileIntervalMs,
    live_feed_reconnect_warmup_ms: cfg.liveFeedReconnectWarmupMs,
    live_max_open_boxes: cfg.liveMaxOpenBoxes,
    live_max_concurrent_executions: cfg.liveMaxConcurrentExecutions,
    live_max_residual_legs: cfg.liveMaxResidualLegs,
    live_daily_loss_limit: cfg.liveDailyLossLimit,
    live_reject_limit: cfg.liveRejectLimit,
    live_consecutive_failure_limit: cfg.liveConsecutiveFailureLimit,
    live_max_open_leg_quantity: cfg.liveMaxOpenLegQuantity,
    live_max_gross_open_leg_quantity: cfg.liveMaxGrossOpenLegQuantity,
    live_http_timeout_ms: cfg.liveHttpTimeoutMs,
    live_ack_timeout_ms: cfg.liveAckTimeoutMs,
    live_working_timeout_ms: cfg.liveWorkingTimeoutMs,
    live_partial_timeout_ms: cfg.livePartialTimeoutMs,
    live_cancel_timeout_ms: cfg.liveCancelTimeoutMs,
    live_max_modifications: cfg.liveMaxModifications,
    live_max_chase_ticks: cfg.liveMaxChaseTicks,
    live_broker_min_interval_ms: cfg.liveBrokerMinIntervalMs,
    // Executable-order-pricing knobs, frozen so a paper_legging fill stays
    // interpretable after the defaults are retuned.
    leg_max_chase_ticks: cfg.legMaxChaseTicks,
    unwind_max_chase_ticks: cfg.unwindMaxChaseTicks,
    queue_model: cfg.queueModel,
    queue_liquidity_haircut_pct: cfg.queueLiquidityHaircutPct,
    max_cross_leg_exchange_dispersion_ms: cfg.maxCrossLegExchangeDispersionMs,
  };
}
