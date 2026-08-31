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

import type { BoxScannerConfigSnapshot, ExecutionMode } from "./types.js";

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

function executionMode(name: string, fallback: ExecutionMode): ExecutionMode {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "paper_touch") return "paper_touch";
  if (v === "paper_latency") return "paper_latency";
  // paper_legging MUST be accepted here: it is a first-class execution model, and
  // silently falling back to paper_latency made the whole four-independent-order
  // simulation unreachable from configuration (and reported the wrong mode).
  if (v === "paper_legging") return "paper_legging";
  console.warn(`[Box] ignoring unknown ${name}="${raw}" — using ${fallback}.`);
  return fallback;
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

  // ---- paper_legging: four independent orders ----
  /** How the four legs are submitted: "parallel" (default) or "sequential". */
  legExecutionMode: "parallel" | "sequential";
  /** How long a leg may rest before it is deemed unfilled and the box aborts (ms). */
  legTimeoutMs: number;
  /** Simulated latency for the emergency unwind of partial fills (ms). */
  legUnwindLatencyMs: number;

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
}

export function loadBoxConfig(): BoxConfig {
  return {
    executionMode: executionMode("BOX_EXECUTION_MODE", "paper_latency"),
    simulatedDecisionMs: num("BOX_SIMULATED_DECISION_MS", 40),
    simulatedLatencyMs: num("BOX_SIMULATED_LATENCY_MS", 250),
    executionMaxWaitMs: num("BOX_EXECUTION_MAX_WAIT_MS", 1500),
    executionPollMs: num("BOX_EXECUTION_POLL_MS", 20),
    maxConcurrentExecutions: num("BOX_MAX_CONCURRENT_EXECUTIONS", 8),

    legExecutionMode:
      (process.env.BOX_LEG_EXECUTION_MODE?.trim().toLowerCase() === "sequential"
        ? "sequential"
        : "parallel"),
    legTimeoutMs: num("BOX_LEG_TIMEOUT_MS", 500),
    legUnwindLatencyMs: num("BOX_LEG_UNWIND_LATENCY_MS", 150),

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
  };
}
