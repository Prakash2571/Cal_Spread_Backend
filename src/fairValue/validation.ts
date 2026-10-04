import { blackPrice, priceBounds } from "./black.js";
import type { Diagnostic, SmileConfig } from "./types.js";

/** Actual strike spacing, both CE/PE monotonicity/convexity, parity and bounds. */
export function validatePriceGrid(args: {
  f: number; d: number; strikes: number[]; variance: (k: number) => number | null; tick: number; config: SmileConfig;
}): { valid: boolean; diagnostics: Diagnostic[]; prices: { strike: number; call: number; put: number }[] } {
  const diagnostics: Diagnostic[] = [];
  const prices: { strike: number; call: number; put: number }[] = [];
  const { f, d, tick, config } = args;
  const strikes = [...new Set(args.strikes)].sort((a, b) => a - b);
  if (strikes.length === 0) return { valid: false, diagnostics: [{ code: "empty_price_validation_grid", severity: "error", message: "No supported strikes for price validation." }], prices: [] };
  if (![f, d, tick].every(Number.isFinite) || f <= 0 || d <= 0 || tick <= 0) return { valid: false,
    diagnostics: [{ code: "invalid_price_validation_inputs", severity: "error", message: "Finite positive forward, discount and tick are required." }], prices: [] };
  const priceTolerance = Math.max(tick * config.price_tolerance_ticks, 64 * Number.EPSILON * d * f);
  for (const strike of strikes) {
    if (!Number.isFinite(strike) || strike <= 0) {
      diagnostics.push({ code: "invalid_validation_strike", severity: "error", message: "Validation strike must be positive finite." });
      continue;
    }
    const w = args.variance(Math.log(strike) - Math.log(f));
    if (w === null || !Number.isFinite(w) || w < 0) {
      diagnostics.push({ code: "variance_unavailable", severity: "error", message: "Variance unavailable at validation strike.", strike });
      continue;
    }
    const call = blackPrice({ f, k: strike, d, w, side: "CE" });
    const put = blackPrice({ f, k: strike, d, w, side: "PE" });
    prices.push({ strike, call, put });
    const parity = call - put - d * (f - strike);
    if (Math.abs(parity) > priceTolerance) diagnostics.push({ code: "parity_violation", severity: "error", message: "Model put-call parity failed.", strike, value: parity });
    for (const side of ["CE", "PE"] as const) {
      const bounds = priceBounds(f, strike, d, side);
      const price = side === "CE" ? call : put;
      if (price < bounds.lower - priceTolerance || price > bounds.upper + priceTolerance) diagnostics.push({ code: "price_bounds_violation", severity: "error", message: `${side} outside European bounds.`, strike, value: price });
    }
  }
  let previous: { call: number; put: number; tolerance: number } | null = null;
  for (let i = 0; i < prices.length - 1; i++) {
    const a = prices[i]!;
    const b = prices[i + 1]!;
    const spacing = b.strike - a.strike;
    const callSlope = (b.call - a.call) / spacing;
    const putSlope = (b.put - a.put) / spacing;
    const tolerance = 2 * priceTolerance / spacing + 1e-10;
    if (callSlope < -d - tolerance || callSlope > tolerance) diagnostics.push({ code: "call_slope_violation", severity: "error", message: "CE slope outside [-D,0].", strike: a.strike, value: callSlope });
    if (putSlope < -tolerance || putSlope > d + tolerance) diagnostics.push({ code: "put_slope_violation", severity: "error", message: "PE slope outside [0,D].", strike: a.strike, value: putSlope });
    if (previous && callSlope < previous.call - tolerance - previous.tolerance) diagnostics.push({ code: "call_convexity_violation", severity: "error", message: "CE slopes decrease across actual strike spacing.", strike: a.strike, value: callSlope - previous.call });
    if (previous && putSlope < previous.put - tolerance - previous.tolerance) diagnostics.push({ code: "put_convexity_violation", severity: "error", message: "PE slopes decrease across actual strike spacing.", strike: a.strike, value: putSlope - previous.put });
    previous = { call: callSlope, put: putSlope, tolerance };
  }
  return { valid: diagnostics.length === 0, diagnostics, prices };
}

export function intermediateStrikes(strikes: number[], subdivisions = 4): number[] {
  const sorted = [...new Set(strikes)].sort((a, b) => a - b);
  const all = [...sorted];
  for (let i = 0; i < sorted.length - 1; i++) for (let j = 1; j < subdivisions; j++) {
    all.push(sorted[i]! + (sorted[i + 1]! - sorted[i]!) * j / subdivisions);
  }
  return all.sort((a, b) => a - b);
}
