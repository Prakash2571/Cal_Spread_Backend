import { blackFromIv, priceBounds } from "./black.js";
import { normalPdf } from "./normal.js";
import type { IvConfig, IvResult, OptionSide } from "./types.js";

export const DEFAULT_IV_CONFIG: IvConfig = {
  initial_high: 0.5, max_volatility: 5, max_expansions: 8, max_iterations: 120,
  price_tolerance: 1e-9, tick_tolerance_fraction: 0.01, volatility_tolerance: 1e-9,
  low_vega_threshold: 1e-6, max_iv_uncertainty: 0.10,
};

/** Bisection with a maintained bracket. Ill-conditioning is returned with the computed IV, not hidden. */
export function invertIv(args: {
  f: number; k: number; t: number; d: number; price: number; side: OptionSide;
  tick: number; uncertainty?: number; config?: IvConfig;
}): IvResult {
  const { f, k, t, d, price, side, tick } = args;
  const cfg = args.config ?? DEFAULT_IV_CONFIG;
  const result = (status: IvResult["status"], reason: string, iv: number | null = null,
    iterations = 0, residual: number | null = null, vega: number | null = null): IvResult =>
    ({ status, reason, iv, iterations, residual, vega });
  if (![f, k, t, d, price, tick].every(Number.isFinite) || f <= 0 || k <= 0 || d <= 0 || price < 0 || tick <= 0 ||
      (side !== "CE" && side !== "PE") || !Number.isFinite(f * d) || !Number.isFinite(k * d) ||
      (args.uncertainty !== undefined && (!Number.isFinite(args.uncertainty) || args.uncertainty < 0))) {
    return result("invalid_input", "Finite positive F, K, D, tick and nonnegative premium are required.");
  }
  if (t <= 0) return result("expired", "Expired contract: use its settlement underlying, not implied volatility.");
  if (!Number.isFinite(t * cfg.max_volatility * cfg.max_volatility)) return result("invalid_input", "IV total variance exceeds numeric range.");
  if (Object.values(cfg).some((v) => !Number.isFinite(v) || v < 0) || cfg.initial_high <= 0 ||
      cfg.max_volatility <= 0 || cfg.max_iterations < 1 || cfg.volatility_tolerance <= 0) {
    return result("invalid_input", "Invalid IV solver configuration.");
  }
  const bounds = priceBounds(f, k, d, side);
  const tolerance = Math.max(cfg.price_tolerance, tick * cfg.tick_tolerance_fraction,
    32 * Number.EPSILON * bounds.upper);
  if (price < bounds.lower - tolerance || price > bounds.upper + tolerance) {
    return result("outside_bounds", `Premium outside European bounds [${bounds.lower}, ${bounds.upper}].`);
  }
  if (price <= bounds.lower + tolerance) {
    return result("zero_volatility", "Premium at the tick-aware lower bound; IV is zero/undetermined below tick resolution.", 0,
      0, bounds.lower - price, 0);
  }
  // The upper bound is approached only as sigma -> infinity, not a finite IV.
  if (price >= bounds.upper - tolerance) {
    return result("no_finite_solution", "Premium at the upper bound has no finite-volatility solution.");
  }
  let low = 0;
  let high = Math.min(cfg.initial_high, cfg.max_volatility);
  let highError = blackFromIv(f, k, t, d, high, side) - price;
  let expansions = 0;
  while (highError < 0 && high < cfg.max_volatility && expansions < cfg.max_expansions) {
    high = Math.min(high * 2, cfg.max_volatility);
    highError = blackFromIv(f, k, t, d, high, side) - price;
    expansions++;
  }
  if (highError < 0) return result("bracket_failure", `No root bracket within maximum decimal IV ${cfg.max_volatility}.`);
  const finish = (iv: number, iteration: number, error: number): IvResult => {
    const root = iv * Math.sqrt(t);
    const d1 = (Math.log(f) - Math.log(k)) / root + root / 2;
    const vega = d * f * normalPdf(d1) * Math.sqrt(t);
    const uncertainty = Math.max(args.uncertainty ?? tolerance, tolerance);
    const illConditioned = vega < cfg.low_vega_threshold || uncertainty / vega > cfg.max_iv_uncertainty;
    return result(illConditioned ? "low_vega" : "valid", illConditioned
      ? "Computed IV is ill-conditioned: quote/tick uncertainty is large relative to vega."
      : "Bracketed IV inversion converged.", iv, iteration, error, vega);
  };
  for (let iteration = 1; iteration <= cfg.max_iterations; iteration++) {
    const iv = (low + high) / 2;
    const error = blackFromIv(f, k, t, d, iv, side) - price;
    // Numerical price tolerance is tighter than tick-aware bound classification;
    // retaining a tight bracket gives meaningful round trips on well-conditioned quotes.
    // Price-only termination can stop far from the root on a low-vega plateau.
    // Shrink the volatility bracket as well, even when the premium already rounds
    // to the target; finish() separately reports the price/vega condition number.
    if (high - low <= cfg.volatility_tolerance &&
        Math.abs(error) <= Math.max(tolerance, cfg.price_tolerance)) return finish(iv, iteration, error);
    if (error > 0) high = iv;
    else low = iv;
  }
  return result("iteration_failure", "IV inversion exceeded its iteration budget.", null, cfg.max_iterations);
}
