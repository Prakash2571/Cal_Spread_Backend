/**
 * Configuration for the futures-vs-synthetic arbitrage scanner.
 *
 * Every value is read from the environment once, at construction, through the same
 * typed-helper style Box uses. Nothing here can send a real order: positions are
 * PAPER fills at the observed touch. These settings control what is watched, when
 * a mispricing is ELIGIBLE, and when a paper position is opened and closed.
 *
 * CHARGES
 * A conversion/reversal has two OPTION legs and one FUTURE leg. They are taxed
 * differently, so there are two rate cards:
 *   - options: the Box rate card (`loadBoxChargeRates`), unchanged, so an option
 *     leg here costs exactly what it costs in Box;
 *   - futures: the same brokerage/SEBI/GST heads, but with futures STT, exchange
 *     transaction charge, stamp duty and IPFT, each overridable below.
 */

import { loadBoxChargeRates, type BoxChargeRates } from "../box/localCharges.js";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return fallback;
}

/** The synthetic is only ever built from ATM, ATM±1, ATM±2 or ATM±3. */
export type SynthStrikeLevel = 1 | 2 | 3;

export function clampSynthStrikeLevel(v: unknown): SynthStrikeLevel | null {
  const n = Number(v);
  return n === 1 || n === 2 || n === 3 ? n : null;
}

export interface SynthConfig {
  /** Strikes each side of ATM at startup (1, 2 or 3). Changeable at runtime. */
  strikeLevel: SynthStrikeLevel;
  /** How long an UNCHANGED order book is still trusted for pricing (ms). */
  quoteMaxAgeMs: number;
  /** Newest tick across the watched set older than this = feed reported stale (ms). */
  feedMaxAgeMs: number;
  /** Extra fraction of a strike step the future must drift before the window moves. */
  atmHysteresis: number;
  /** Minimum time between two re-centres of one underlying's window (ms). */
  windowMinIntervalMs: number;
  /** How often every opportunity is re-priced (ms). */
  evalIntervalMs: number;
  /** How often the SSE snapshot is pushed (ms). */
  publishIntervalMs: number;
  /** How often the universe (expiry/strikes) is rebuilt while running (ms). */
  universeRefreshMs: number;
  /** Tokens this scanner may add to the Box market-data lane while Box is RUNNING. */
  maxTokens: number;
  /**
   * While the Box scanner is STOPPED, also use the part of Box's own token budget
   * (`BOX_MAX_SUBSCRIBED_TOKENS`) that Box is not holding for open positions. Box
   * always has priority: the moment it starts, this scanner shrinks back first.
   */
  shareBoxBudget: boolean;
  /** Hard ceiling for the whole Box lane socket (Kite allows 3000 per connection). */
  laneTokenLimit: number;
  /** Upper bound on underlyings watched; 0 = only the token budget binds. */
  maxUnderlyings: number;
  /** Cap on opportunity rows pushed to the browser per snapshot (all are evaluated). */
  maxPublishedOpportunities: number;
  /** ELIGIBLE threshold: minimum expected net profit per lot, after every cost (₹). */
  minExpectedNetProfit: number;
  /** Risk allowance carried inside the expected-net figure (₹). */
  safetyBuffer: number;
  /** Expected slippage for the round trip, all three legs, entry + exit (₹). */
  expectedSlippage: number;
  /** Include the financing (carry) of the net option premium to expiry. */
  includeCarry: boolean;
  /** Fallback risk-free rate (%) when the admin has not set one. */
  defaultRfPct: number;
  /** Which directions are evaluated. */
  enableConversion: boolean;
  enableReversal: boolean;
  /** Skip underlyings whose matched expiry is today (settlement-day risk). */
  skipExpiryDay: boolean;

  /* ---------------------------- paper trading ----------------------------- */

  /** Open a PAPER position automatically when an opportunity is ELIGIBLE. */
  paperTrading: boolean;
  /** Open paper positions at most (one per underlying on top of this). */
  maxOpenPositions: number;
  /**
   * Consecutive evaluations a signal must hold before it is acted on — entries and
   * rule-based exits alike — so one flickering book cannot open or close a position.
   */
  signalConfirmations: number;
  /** After a position on an underlying closes, wait this long before re-entering it. */
  reentryCooldownMs: number;

  /* ------------------------ exit rules (Box semantics) --------------------- */

  /** EDGE_CONVERGED when remaining edge <= max(floor, pct × entry net edge). */
  convergenceFloor: number;
  convergencePct: number;
  /** Never close early for less than this net P&L, after every charge (₹). */
  minExitNetPnl: number;
  /** PROFIT_CAPTURE when net >= this fraction of the entry net edge... */
  profitCapturePct: number;
  /** ...or when this fraction of the entry edge has been captured gross. */
  minCapturedPct: number;
  /** On expiry day, close at the touch from this many minutes before 15:30 IST. */
  expirySafetyMinutes: number;

  optionRates: BoxChargeRates;
  futuresRates: BoxChargeRates;
}

/** Futures rate card: Box's brokerage/SEBI/GST, with futures-specific statutory heads. */
export function loadFuturesChargeRates(base: BoxChargeRates = loadBoxChargeRates()): BoxChargeRates {
  return {
    ...base,
    // Futures STT: sell side, percent of NOTIONAL (0.05% since 1 April 2026).
    sttSellPct: num("SYNTH_FUT_STT_SELL_PCT", 0.05),
    // NSE equity futures transaction charge, percent of notional.
    exchangeTxnPct: num("SYNTH_FUT_EXCHANGE_TXN_PCT", 0.00173),
    // NSE IPFT on futures, ₹ per crore of notional.
    ipftPerCrore: num("SYNTH_FUT_IPFT_PER_CRORE", 10),
    ipftPct: 0,
    // Stamp duty on futures purchases, percent of notional.
    stampDutyBuyPct: num("SYNTH_FUT_STAMP_DUTY_BUY_PCT", 0.002),
    rateVersion:
      process.env.SYNTH_FUT_CHARGE_RATE_VERSION?.trim() || "nse-futures-2026-04-01",
  };
}

export function loadSynthConfig(): SynthConfig {
  const optionRates = loadBoxChargeRates();
  return {
    strikeLevel: clampSynthStrikeLevel(num("SYNTH_STRIKE_LEVEL", 3)) ?? 3,
    quoteMaxAgeMs: num("SYNTH_QUOTE_MAX_AGE_MS", 15_000),
    feedMaxAgeMs: num("SYNTH_FEED_MAX_AGE_MS", 10_000),
    atmHysteresis: num("SYNTH_ATM_HYSTERESIS", 0.15),
    windowMinIntervalMs: num("SYNTH_WINDOW_MIN_INTERVAL_MS", 15_000),
    evalIntervalMs: Math.max(100, num("SYNTH_EVAL_INTERVAL_MS", 500)),
    publishIntervalMs: Math.max(200, num("SYNTH_PUBLISH_INTERVAL_MS", 1000)),
    universeRefreshMs: Math.max(60_000, num("SYNTH_UNIVERSE_REFRESH_MS", 15 * 60_000)),
    maxTokens: num("SYNTH_MAX_TOKENS", 750),
    shareBoxBudget: bool("SYNTH_SHARE_BOX_BUDGET", true),
    laneTokenLimit: num("SYNTH_LANE_TOKEN_LIMIT", 3000),
    maxUnderlyings: num("SYNTH_MAX_UNDERLYINGS", 0),
    maxPublishedOpportunities: Math.max(10, num("SYNTH_MAX_PUBLISHED_OPPORTUNITIES", 150)),
    minExpectedNetProfit: num("SYNTH_MIN_EXPECTED_NET_PROFIT", 500),
    safetyBuffer: num("SYNTH_SAFETY_BUFFER", 100),
    expectedSlippage: num("SYNTH_EXPECTED_SLIPPAGE", 0),
    includeCarry: bool("SYNTH_INCLUDE_CARRY", true),
    defaultRfPct: num("SYNTH_DEFAULT_RF_PCT", 0),
    enableConversion: bool("SYNTH_ENABLE_CONVERSION", true),
    enableReversal: bool("SYNTH_ENABLE_REVERSAL", true),
    skipExpiryDay: bool("SYNTH_SKIP_EXPIRY_DAY", false),
    paperTrading: bool("SYNTH_PAPER_TRADING", true),
    maxOpenPositions: num("SYNTH_MAX_OPEN_POSITIONS", 10),
    signalConfirmations: Math.max(1, Math.floor(num("SYNTH_SIGNAL_CONFIRMATIONS", 2))),
    reentryCooldownMs: num("SYNTH_REENTRY_COOLDOWN_MS", 60_000),
    // Scaled from Box's defaults to this scanner's smaller ₹500 entry gate.
    convergenceFloor: num("SYNTH_CONVERGENCE_FLOOR", 100),
    convergencePct: num("SYNTH_CONVERGENCE_PCT", 0.2),
    minExitNetPnl: num("SYNTH_MIN_EXIT_NET_PNL", 250),
    profitCapturePct: num("SYNTH_PROFIT_CAPTURE_PCT", 0.75),
    minCapturedPct: num("SYNTH_MIN_CAPTURED_PCT", 0.75),
    expirySafetyMinutes: num("SYNTH_EXPIRY_SAFETY_MINUTES", 45),
    optionRates,
    futuresRates: loadFuturesChargeRates(optionRates),
  };
}

/** Bounds for the two thresholds an admin may change from the UI. */
export const SYNTH_TUNING_LIMITS = {
  min_expected_net_profit: { min: 0, max: 100_000 },
  safety_buffer: { min: 0, max: 50_000 },
} as const;
