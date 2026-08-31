/**
 * Box-scanner configuration.
 *
 * Everything the trading rules depend on is here and overridable by env var, so
 * the thresholds can be tuned without touching the engine. The DEFAULTS are:
 *
 *   MIN_BOX_GROSS_EDGE    ₹1,200 from the SPREAD alone — the entry gate
 *   MIN_BOX_NET_EDGE      0 = no additional net floor (fees are managed by hand)
 *   BOX_SAFETY_BUFFER     ₹150, reported in the net figure, NOT part of the gate
 *   BOX_QUOTE_MAX_AGE_MS  1,500 ms — no paper trade on a stale book
 *   strikes each side     3  (ATM ± 3 → at most 7 strikes → at most 21 pairs)
 */

import type { BoxScannerConfigSnapshot } from "./types.js";

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

export interface BoxConfig {
  // ---- Entry qualification ----
  /**
   * THE ENTRY GATE: minimum GROSS edge (₹) from the spread alone.
   *
   *   grossEdge = ((K2 - K1) - entryBoxCostPerUnit) x lotSize
   *
   * This is the arbitrage the executable prices actually show, before any
   * charges or buffer are considered. Fees are still estimated, stored and
   * displayed — they are just not deducted before deciding to enter.
   */
  minGrossEdge: number;
  /**
   * OPTIONAL extra floor (₹) on the projected NET edge
   * (gross - entryFees - estExitFees - safetyBuffer).
   *
   * 0 (the default) disables it, so the gate is the gross spread alone. Set it to
   * a positive number to additionally require a net cushion.
   */
  minNetEdge: number;
  /**
   * Conservative slippage/safety allowance (₹) per complete round trip.
   *
   * Reported in the projected NET edge so the after-cost picture is visible, and
   * used by the optional net floor above — but NOT part of the gross entry gate.
   */
  safetyBuffer: number;
  /**
   * A deliberate LOWER bound on what a round trip can cost in charges (₹), used
   * ONLY by the prefilter when an optional net floor is configured. It must
   * under-estimate: the prefilter's job is to skip candidates that cannot
   * possibly qualify, so a value larger than the true minimum charge would
   * discard genuine opportunities. Eight option orders at ₹20 brokerage plus GST
   * is already ≈ ₹189, so ₹160 is safe.
   */
  prefilterChargeAllowance: number;
  /**
   * Whether a box may be auto-entered when Zerodha could not price its charges.
   *
   * Default true. This is NOT about the threshold (which is gross-only): the
   * exit rules are computed net of charges, so a position with no charge figures
   * cannot have its net P&L evaluated and would never auto-exit. Set it to false
   * only if you intend to manage such positions by hand.
   */
  requirePricedCharges: boolean;

  // ---- Market-data quality ----
  /**
   * How long an UNCHANGED order book is still trusted (ms).
   *
   * A depth feed only sends a message when the book actually changes, so silence
   * is not staleness: a resting book nobody has touched for ten seconds is still
   * the current, executable book. Illiquid F&O strikes are quiet for long
   * stretches, so a sub-second limit here does not make the system safer — it
   * simply makes it unable to trade anything but the most active names.
   *
   * The protection against a genuinely dead feed is `feedMaxAgeMs` below, which is
   * the check that actually catches "we are holding old data and do not know it".
   */
  quoteMaxAgeMs: number;
  /**
   * FEED LIVENESS: maximum age (ms) of the newest tick across the WHOLE box
   * universe.
   *
   * With hundreds of instruments subscribed, something is always trading during
   * market hours, so this going quiet means the connection is broken rather than
   * the market being calm. When it trips, no entry and no automatic exit happens
   * at all — that is the real "do not trade stale books" guard.
   */
  feedMaxAgeMs: number;
  /** Maximum age (ms) of the underlying value used to place the ATM window. */
  underlyingMaxAgeMs: number;

  // ---- Strike window ----
  /** Strikes each side of ATM. V1 is fixed at 3 and is NOT env-tunable. */
  readonly strikesEachSide: 3;
  /**
   * Extra fraction of a strike step the spot must travel PAST the midpoint
   * before the ATM is re-centred. Stops a price oscillating on a strike
   * boundary from resubscribing the window on every tick.
   */
  atmHysteresis: number;
  /** Minimum gap (ms) between two window rebuilds for one underlying. */
  windowMinIntervalMs: number;

  // ---- Exit rules ----
  /** Floor of the convergence threshold (₹). */
  convergenceFloor: number;
  /** Fraction of the original entry net edge used as the threshold. */
  convergencePct: number;
  /** Minimum simulated NET profit (₹) for a normal convergence exit. */
  minExitNetPnl: number;
  /** Fraction of the original net edge that alone justifies taking profit. */
  profitCapturePct: number;

  // ---- Expiry safety ----
  /** Minutes before the close on expiry day to start forcing an exit. */
  expirySafetyMinutesBeforeClose: number;

  // ---- Scheduling / capacity ----
  /** Open-position monitor cadence (ms). */
  monitorIntervalMs: number;
  /** How often (ms) open-trade live fields are flushed to Mongo. */
  persistIntervalMs: number;
  /** SSE publish cadence (ms) — the UI never needs every exchange tick. */
  publishIntervalMs: number;
  /** How often (ms) the universe/expiry/window set is refreshed. */
  universeRefreshMs: number;
  /**
   * How often (ms) the last-close view is rebuilt while the market is shut.
   *
   * One REST /quote call per 500 instruments, so a minute is comfortable — the
   * numbers cannot change while the exchange is closed anyway.
   */
  indicativeRefreshMs: number;
  /**
   * Cap on simultaneously subscribed box option tokens. Zerodha allows ~3,000
   * instruments per WebSocket connection and the calendar board already uses
   * part of that budget on the same shared socket.
   */
  maxSubscribedTokens: number;
  /** Cap on underlyings scanned (0 = no cap beyond the token budget). */
  maxUnderlyings: number;
  /** TTL (ms) of a cached charge estimate for one candidate at given prices. */
  chargeCacheTtlMs: number;
  /** Max concurrent charge estimations in flight. */
  chargeConcurrency: number;
  /** Opportunities published to the UI. */
  maxPublishedOpportunities: number;
}

export function loadBoxConfig(): BoxConfig {
  return {
    // ₹1,200 from the spread alone.
    minGrossEdge: num("MIN_BOX_GROSS_EDGE", 1200),
    // No net floor by default — fees are managed by hand.
    minNetEdge: num("MIN_BOX_NET_EDGE", 0),
    safetyBuffer: num("BOX_SAFETY_BUFFER", 150),
    prefilterChargeAllowance: num("BOX_PREFILTER_CHARGE_ALLOWANCE", 160),
    requirePricedCharges: bool("BOX_REQUIRE_PRICED_CHARGES", true),

    quoteMaxAgeMs: num("BOX_QUOTE_MAX_AGE_MS", 15_000),
    feedMaxAgeMs: num("BOX_FEED_MAX_AGE_MS", 5_000),
    underlyingMaxAgeMs: num("BOX_UNDERLYING_MAX_AGE_MS", 10_000),

    strikesEachSide: 3,
    atmHysteresis: num("BOX_ATM_HYSTERESIS", 0.15),
    windowMinIntervalMs: num("BOX_WINDOW_MIN_INTERVAL_MS", 15_000),

    convergenceFloor: num("BOX_CONVERGENCE_FLOOR", 200),
    convergencePct: num("BOX_CONVERGENCE_PCT", 0.2),
    minExitNetPnl: num("BOX_MIN_EXIT_NET_PNL", 600),
    profitCapturePct: num("BOX_PROFIT_CAPTURE_PCT", 0.75),

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
  };
}

/**
 * The gross edge (₹) a candidate must clear before it is worth spending a
 * charge-estimation call on — the FAST LOCAL PREFILTER.
 *
 * With the default gross-only gate this is simply the gross requirement. When an
 * optional net floor is configured it also has to cover that floor plus the
 * buffer and a deliberate LOWER bound on charges, so the prefilter can never
 * discard a candidate that would have qualified once real charges came back.
 */
export function prefilterGrossThreshold(cfg: BoxConfig): number {
  const netDerived =
    cfg.minNetEdge > 0
      ? cfg.minNetEdge + cfg.safetyBuffer + cfg.prefilterChargeAllowance
      : 0;
  return Math.max(cfg.minGrossEdge, netDerived);
}

/** The immutable settings frozen onto every trade document. */
export function configSnapshot(cfg: BoxConfig): BoxScannerConfigSnapshot {
  return {
    min_gross_edge: cfg.minGrossEdge,
    min_net_edge: cfg.minNetEdge,
    safety_buffer: cfg.safetyBuffer,
    quote_max_age_ms: cfg.quoteMaxAgeMs,
    strikes_each_side: cfg.strikesEachSide,
    convergence_floor: cfg.convergenceFloor,
    convergence_pct: cfg.convergencePct,
    min_exit_net_pnl: cfg.minExitNetPnl,
    profit_capture_pct: cfg.profitCapturePct,
    execution_mode: "paper_touch",
  };
}
