import { createHash } from "node:crypto";
import { DEFAULT_IV_CONFIG } from "./iv.js";
import { DEFAULT_QUOTE_POLICY } from "./quotes.js";
import { DEFAULT_FORWARD_CONFIG } from "./forward.js";
import { validateCurve } from "./curve.js";
import { utcTimestamp, validateExpiryPolicy } from "./metadata.js";
import type { FairValueConfig, SmileConfig } from "./types.js";

export const MODEL_VERSION = "black-act365f-raw-svi-price-huber-v1";
export const DEFAULT_SMILE_CONFIG: SmileConfig = {
  model: "svi", min_svi_strikes: 9, min_k_span: 0.10, min_each_wing: 3,
  atm_band: 0.01, min_interpolation_strikes: 3, max_interpolation_gap: 0.15,
  huber_delta: 1.5, regularization: 0.001, max_normalized_rmse: 4,
  optimizer_iterations: 700, optimizer_starts: 5, optimizer_tolerance: 1e-7,
  butterfly_tolerance: 1e-8, variance_floor: 1e-12, max_wing_slope: 1.999,
  diagnostic_points: 161, adaptive_depth: 4, strike_extrapolation_k: 0.10,
  calendar_tolerance: 1e-8, price_tolerance_ticks: 0.02,
};

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): FairValueConfig {
  const config: FairValueConfig = {
    enabled: env.FAIR_VALUE_ENABLED === "true", refresh_ms: 5_000, surface_max_age_ms: 60_000,
    max_underlyings: 3, max_tokens: 600, max_expiries: 4,
    universe_refresh_ms: 60_000, recenter_log_distance: .02, workers: 1,
    worker_timeout_ms: 8_000, max_queue: 8, history_limit: 100, history_interval_ms: 60_000,
    history_retention_days: 7, history_memory_max_bytes: 16 * 1024 * 1024,
    independent_cache_limit: 64, independent_cache_ttl_ms: 60_000,
    research_enabled: false, maturity_extrapolation: "none", max_maturity_extrapolation_days: 30,
    forward_interpolation: "unavailable", proportional_calendar_assumption: false,
    sensitivity_rate_bump: 0.0025,
    quote: { ...DEFAULT_QUOTE_POLICY }, iv: { ...DEFAULT_IV_CONFIG },
    forward: { ...DEFAULT_FORWARD_CONFIG }, smile: { ...DEFAULT_SMILE_CONFIG },
    curve: { source: "unconfigured discount curve", as_of: new Date().toISOString(),
      version: "unconfigured-v1", convention: "continuous_zero_act365f", nodes: [],
      flat_rate: null, allow_flat_fallback: false },
    expiry_policy: null, carry: {},
  };
  if (env.FAIR_VALUE_CONFIG_JSON?.trim()) {
    return mergeConfig(config, JSON.parse(env.FAIR_VALUE_CONFIG_JSON));
  }
  validateConfig(config);
  return config;
}

export function configVersion(config: FairValueConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 20);
}

/** Full validation for persisted and HTTP configuration, fail closed on unknown settings. */
export function mergeConfig(current: FairValueConfig, patch: unknown): FairValueConfig {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Configuration must be an object.");
  const entries = patch as Record<string, unknown>;
  for (const key of Object.keys(entries)) if (!Object.hasOwn(current, key)) throw new Error(`Unknown Fair Value setting: ${key}.`);
  const next = structuredClone(current);
  for (const [key, value] of Object.entries(entries)) {
    if (["quote", "iv", "forward", "smile", "curve"].includes(key)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${key} configuration.`);
      const previous = current[key as "quote" | "iv" | "forward" | "smile" | "curve"];
      for (const subkey of Object.keys(value)) if (!Object.hasOwn(previous, subkey)) throw new Error(`Unknown ${key}.${subkey} setting.`);
      (next as unknown as Record<string, unknown>)[key] = { ...previous, ...value };
    } else (next as unknown as Record<string, unknown>)[key] = value;
  }
  validateConfig(next);
  normalizeTimestamps(next);
  return next;
}

function normalizeTimestamps(config: FairValueConfig): void {
  config.curve.as_of = utcTimestamp(config.curve.as_of)!;
  if (config.expiry_policy) {
    config.expiry_policy.as_of = utcTimestamp(config.expiry_policy.as_of)!;
    for (const [symbol, timestamp] of Object.entries(config.expiry_policy.overrides)) {
      config.expiry_policy.overrides[symbol] = utcTimestamp(timestamp)!;
    }
  }
  for (const carry of Object.values(config.carry)) {
    carry.as_of = utcTimestamp(carry.as_of)!;
    for (const event of carry.dividends) event.timestamp = utcTimestamp(event.timestamp)!;
    carry.corporate_actions = carry.corporate_actions.map((time) => utcTimestamp(time)!);
  }
}

export function validateConfig(c: FairValueConfig): void {
  const range = (name: string, value: unknown, low: number, high: number, integer = false) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high ||
        (integer && !Number.isSafeInteger(value))) throw new Error(`${name} requires ${integer ? "integer " : ""}${low}..${high}.`);
  };
  for (const key of ["enabled", "research_enabled", "proportional_calendar_assumption"] as const) {
    if (typeof c[key] !== "boolean") throw new Error(`${key} must be boolean.`);
  }
  range("refresh_ms", c.refresh_ms, 2_000, 300_000, true);
  range("surface_max_age_ms", c.surface_max_age_ms, 5_000, 600_000, true);
  range("max_underlyings", c.max_underlyings, 1, 5, true);
  range("max_tokens", c.max_tokens, 20, 1000, true);
  range("max_expiries", c.max_expiries, 1, 12, true);
  range("universe_refresh_ms", c.universe_refresh_ms, 15_000, 300_000, true);
  range("recenter_log_distance", c.recenter_log_distance, .001, .20);
  range("workers", c.workers, 1, 2, true);
  range("worker_timeout_ms", c.worker_timeout_ms, 100, 30_000, true);
  range("max_queue", c.max_queue, 1, 16, true);
  range("history_limit", c.history_limit, 1, 500, true);
  range("history_interval_ms", c.history_interval_ms, 10_000, 3_600_000, true);
  range("history_retention_days", c.history_retention_days, 1, 30, true);
  range("history_memory_max_bytes", c.history_memory_max_bytes, 1048576, 67108864, true);
  range("independent_cache_limit", c.independent_cache_limit, 1, 128, true);
  range("independent_cache_ttl_ms", c.independent_cache_ttl_ms, 1_000, 600_000, true);
  range("max_maturity_extrapolation_days", c.max_maturity_extrapolation_days, 0, 90);
  range("sensitivity_rate_bump", c.sensitivity_rate_bump, 0, 0.05);
  if (!["none", "constant_short_end_and_forward_variance"].includes(c.maturity_extrapolation)) throw new Error("Unknown maturity extrapolation policy.");
  if (!["unavailable", "log_carry_assumption"].includes(c.forward_interpolation)) throw new Error("Unknown forward interpolation policy.");
  const q = c.quote;
  range("quote.max_age_ms", q.max_age_ms, 500, 300_000);
  range("quote.max_relative_spread", q.max_relative_spread, .001, 2);
  range("quote.max_absolute_spread", q.max_absolute_spread, .01, 10000);
  for (const key of ["min_depth", "depth_target"] as const) range(`quote.${key}`, q[key], 1, 1e8);
  for (const key of ["premium_floor", "tick_floor"] as const) range(`quote.${key}`, q[key], 1e-8, 1000);
  range("quote.freshness_tau_ms", q.freshness_tau_ms, 1, 300_000);
  for (const key of ["max_pair_dispersion_ms", "max_snapshot_dispersion_ms", "future_timestamp_tolerance_ms"] as const) range(`quote.${key}`, q[key], 0, 300_000);
  if (!["exclude", "diagnostic_only"].includes(q.zero_bid_policy)) throw new Error("Unknown zero bid policy.");
  const f = c.forward;
  range("forward.min_pairs", f.min_pairs, 2, 50, true);
  range("forward.huber_delta", f.huber_delta, .1, 10);
  if (typeof f.refine !== "boolean") throw new Error("forward.refine must be boolean.");
  range("forward.refinement_iterations", f.refinement_iterations, 1, 100, true);
  range("forward.outlier_scale", f.outlier_scale, 1, 20);
  range("forward.max_pair_dispersion_ms", f.max_pair_dispersion_ms, 0, 300_000);
  range("forward.tick_floor", f.tick_floor, 1e-8, 1000);
  range("forward.max_relative_dispersion", f.max_relative_dispersion, 1e-8, .1);
  const iv = c.iv;
  range("iv.initial_high", iv.initial_high, .01, 10);
  range("iv.max_volatility", iv.max_volatility, .1, 10);
  range("iv.max_expansions", iv.max_expansions, 0, 16, true);
  range("iv.max_iterations", iv.max_iterations, 10, 300, true);
  for (const key of ["price_tolerance", "volatility_tolerance", "low_vega_threshold"] as const) range(`iv.${key}`, iv[key], 1e-14, .1);
  range("iv.tick_tolerance_fraction", iv.tick_tolerance_fraction, 0, .5);
  range("iv.max_iv_uncertainty", iv.max_iv_uncertainty, .001, 1);
  const s = c.smile;
  if (s.model !== "svi" && s.model !== "interpolation") throw new Error("Unknown smile model.");
  range("smile.min_svi_strikes", s.min_svi_strikes, 7, 100, true);
  range("smile.min_interpolation_strikes", s.min_interpolation_strikes, 3, 100, true);
  range("smile.min_each_wing", s.min_each_wing, 2, 20, true);
  for (const key of ["min_k_span", "max_interpolation_gap"] as const) range(`smile.${key}`, s[key], .001, 2);
  range("smile.atm_band", s.atm_band, 0, .05);
  range("smile.huber_delta", s.huber_delta, .1, 10);
  range("smile.regularization", s.regularization, 0, 10);
  range("smile.max_normalized_rmse", s.max_normalized_rmse, .1, 20);
  range("smile.optimizer_iterations", s.optimizer_iterations, 20, 2000, true);
  range("smile.optimizer_starts", s.optimizer_starts, 2, 8, true);
  range("smile.optimizer_tolerance", s.optimizer_tolerance, 1e-12, .01);
  range("smile.butterfly_tolerance", s.butterfly_tolerance, 0, 1e-4);
  range("smile.variance_floor", s.variance_floor, 1e-14, 1e-4);
  range("smile.max_wing_slope", s.max_wing_slope, .01, 1.99999);
  range("smile.diagnostic_points", s.diagnostic_points, 51, 501, true);
  range("smile.adaptive_depth", s.adaptive_depth, 1, 6, true);
  range("smile.strike_extrapolation_k", s.strike_extrapolation_k, 0, .5);
  range("smile.calendar_tolerance", s.calendar_tolerance, 0, 1e-5);
  range("smile.price_tolerance_ticks", s.price_tolerance_ticks, 0, .5);
  validateCurve(c.curve);
  if (typeof c.curve.allow_flat_fallback !== "boolean") throw new Error("curve.allow_flat_fallback must be boolean.");
  validateExpiryPolicy(c.expiry_policy);
  if (!c.carry || typeof c.carry !== "object" || Array.isArray(c.carry) || Object.keys(c.carry).length > 100) throw new Error("Invalid carry map.");
  for (const [underlying, carry] of Object.entries(c.carry)) {
    if (!underlying || !carry || !carry.source?.trim() || !carry.version?.trim() || !utcTimestamp(carry.as_of) ||
        typeof carry.verified !== "boolean" || typeof carry.proportional !== "boolean" || !carry.convention?.trim() ||
        !Array.isArray(carry.dividends) || carry.dividends.length > 100 || !Array.isArray(carry.corporate_actions) || carry.corporate_actions.length > 100) throw new Error(`Invalid verified carry for ${underlying}.`);
    if (carry.dividend_yield !== null) range("dividend_yield", carry.dividend_yield, -.5, 2);
    if (carry.dividends.length > 0 && carry.dividend_yield !== null && carry.dividend_yield !== 0) {
      throw new Error("Choose continuous proportional dividends or known discrete dividends; their combined carry model is unsupported.");
    }
    for (const event of carry.dividends) {
      if (!utcTimestamp(event.timestamp)) throw new Error("Dividend requires exact UTC/offset timestamp.");
      range("dividend amount", event.amount, 0, 1e8);
    }
    for (const action of carry.corporate_actions) if (!utcTimestamp(action)) throw new Error("Corporate action requires exact timestamp.");
  }
}
