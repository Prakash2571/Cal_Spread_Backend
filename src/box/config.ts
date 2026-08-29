/**
 * Box-scanner configuration.
 *
 * Everything the trading rules depend on is here and overridable by env var, so
 * the thresholds can be tuned without touching the engine. The DEFAULTS are the
 * V1 specification:
 *
 *   MIN_BOX_NET_EDGE      ₹1,200 of NET expected profit (not gross difference)
 *   BOX_SAFETY_BUFFER     ₹150 per complete box round trip
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

export interface BoxConfig {
  // ---- Entry qualification ----
  /** Minimum PROJECTED NET edge (₹) to auto-open a paper box. */
  minNetEdge: number;
  /** Conservative slippage/safety allowance (₹) per complete round trip. */
  safetyBuffer: number;
  /**
   * A deliberate LOWER bound on what a round trip can cost in charges (₹), used
   * ONLY by the fast local prefilter. It must under-estimate: the prefilter's
   * job is to skip candidates that cannot possibly qualify, so a value larger
   * than the true minimum charge would discard genuine opportunities. Eight
   * option orders at ₹20 brokerage plus GST is already ≈ ₹189, so ₹160 is safe.
   */
  prefilterChargeAllowance: number;

  // ---- Market-data quality ----
  /** Maximum age (ms) of each of the four option books at a decision. */
  quoteMaxAgeMs: number;
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
    minNetEdge: num("MIN_BOX_NET_EDGE", 1200),
    safetyBuffer: num("BOX_SAFETY_BUFFER", 150),
    prefilterChargeAllowance: num("BOX_PREFILTER_CHARGE_ALLOWANCE", 160),

    quoteMaxAgeMs: num("BOX_QUOTE_MAX_AGE_MS", 1500),
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
    maxSubscribedTokens: num("BOX_MAX_SUBSCRIBED_TOKENS", 2200),
    maxUnderlyings: num("BOX_MAX_UNDERLYINGS", 0),
    chargeCacheTtlMs: num("BOX_CHARGE_CACHE_TTL_MS", 30_000),
    chargeConcurrency: num("BOX_CHARGE_CONCURRENCY", 3),
    maxPublishedOpportunities: num("BOX_MAX_PUBLISHED_OPPORTUNITIES", 60),
  };
}

/**
 * The gross edge (₹) a candidate must clear before it is worth spending a
 * charge-estimation call on. This is the FAST LOCAL PREFILTER: it uses a lower
 * bound of the charges so it can never discard a candidate that would have
 * qualified once real charges came back.
 */
export function prefilterGrossThreshold(cfg: BoxConfig): number {
  return cfg.minNetEdge + cfg.safetyBuffer + cfg.prefilterChargeAllowance;
}

/** The immutable settings frozen onto every trade document. */
export function configSnapshot(cfg: BoxConfig): BoxScannerConfigSnapshot {
  return {
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
