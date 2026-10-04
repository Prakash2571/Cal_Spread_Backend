import { erf, normalCdf, normalPdf } from "./normal.js";
import type { BlackGreeks, BlackInput, ExpiryPayoff, OptionSide } from "./types.js";
import { utcTimestamp } from "./metadata.js";

export const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
export const DAY_COUNT = "ACT/365F: exact UTC seconds / (365 × 24 × 60 × 60)";

export function yearFraction(expiry: string | number, valuation: string | number): number {
  const e = typeof expiry === "number" ? expiry : Date.parse(utcTimestamp(expiry) ?? "");
  const v = typeof valuation === "number" ? valuation : Date.parse(utcTimestamp(valuation) ?? "");
  if (!Number.isFinite(e) || !Number.isFinite(v)) throw new Error("Invalid UTC valuation/expiry timestamp.");
  return (e - v) / YEAR_MS;
}

export function validateBlackInput(input: BlackInput): void {
  const { f, k, d, w, side } = input;
  if (![f, k, d, w].every(Number.isFinite) || f <= 0 || k <= 0 || d <= 0 || w < 0) {
    throw new Error("Black requires finite F>0, K>0, D>0 and total variance w>=0.");
  }
  if (side !== "CE" && side !== "PE") throw new Error("Unsupported option side/style; European CE/PE only.");
  if (!Number.isFinite(d * Math.max(f, k))) throw new Error("Discounted notional exceeds numeric range.");
}

export function priceBounds(f: number, k: number, d: number, side: OptionSide): { lower: number; upper: number } {
  validateBlackInput({ f, k, d, w: 0, side });
  return side === "CE"
    ? { lower: d * Math.max(f - k, 0), upper: d * f }
    : { lower: d * Math.max(k - f, 0), upper: d * k };
}

/** Stable OTM evaluation, then put-call parity for ITM. All final prices use w, never an interpolated IV. */
export function blackPrice(input: BlackInput): number {
  validateBlackInput(input);
  const { f, k, d, w, side } = input;
  if (w === 0) return d * Math.max(side === "CE" ? f - k : k - f, 0);
  const root = Math.sqrt(w);
  const logMoneyness = Math.log(k) - Math.log(f);
  const d1 = -logMoneyness / root + 0.5 * root;
  const d2 = d1 - root;
  if (logMoneyness === 0) {
    // ATM reduces to D F erf(sqrt(w)/(2sqrt(2))) without subtracting nearly
    // equal CDF values, even when the remaining variance is tiny.
    return d * f * erf(root / (2 * Math.SQRT2));
  }
  // Scaling by the larger notional prevents avoidable overflow/cancellation.
  let call: number;
  let put: number;
  if (f <= k) {
    call = d * k * Math.max(0, (f / k) * normalCdf(d1) - normalCdf(d2));
    put = call + d * (k - f);
  } else {
    put = d * f * Math.max(0, (k / f) * normalCdf(-d2) - normalCdf(-d1));
    call = put + d * (f - k);
  }
  return side === "CE" ? call : put;
}

export function blackFromIv(f: number, k: number, t: number, d: number, iv: number, side: OptionSide): number {
  if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(iv) || iv < 0) {
    throw new Error("IV pricing requires T>0 and finite decimal IV>=0; use settlementPayoff at expiry.");
  }
  return blackPrice({ f, k, d, w: iv * iv * t, side });
}

export function settlementPayoff(args: {
  strike: number; side: OptionSide; lot: number;
  settlement: number | null; indicative: number | null; settlementUnderlying: string;
}): ExpiryPayoff {
  const { strike, side, lot, settlement, indicative, settlementUnderlying } = args;
  if (!Number.isFinite(strike) || strike <= 0 || !Number.isSafeInteger(lot) || lot <= 0 ||
      (side !== "CE" && side !== "PE")) throw new Error("Invalid expiry contract inputs.");
  for (const value of [settlement, indicative]) {
    if (value !== null && (!Number.isFinite(value) || value < 0)) throw new Error("Invalid settlement underlying.");
  }
  const underlying = settlement ?? indicative;
  const value = underlying === null ? null : Math.max(side === "CE" ? underlying - strike : strike - underlying, 0);
  return {
    value,
    value_per_lot: value === null ? null : lot * value,
    status: settlement !== null ? "final_settlement" : indicative !== null ? "indicative_payoff" : "settlement_unknown",
    reason: settlement !== null ? `Final payoff using verified ${settlementUnderlying}.`
      : indicative !== null ? `Indicative payoff only; official ${settlementUnderlying} is unknown.`
        : `Official ${settlementUnderlying} and an indicative underlying are unavailable.`,
  };
}

export function frozenBlackGreeks(args: BlackInput & {
  t: number; spot: number | null; proportionalCarry: boolean;
}): BlackGreeks {
  validateBlackInput(args);
  const { f, k, d, w, side, t, spot, proportionalCarry } = args;
  if (!Number.isFinite(t) || t <= 0) throw new Error("Greeks unavailable for expired contracts.");
  if (spot !== null && (!Number.isFinite(spot) || spot <= 0)) throw new Error("Invalid spot for Greeks.");
  const value = blackPrice(args);
  const r = -Math.log(d) / t;
  const convention = "Frozen-volatility Black; forward delta/gamma; vega per 1 IV percentage point; " +
    "theta per calendar day at fixed F, r, IV (ACT/365F); rho per 1 rate percentage point at fixed F. " +
    "Spot transforms require proportional carry and do not move the surface.";
  if (w === 0) {
    const callDelta = d * (f > k ? 1 : f < k ? 0 : 0.5);
    const delta = side === "CE" ? callDelta : callDelta - d;
    return {
      forward_delta: delta, forward_gamma: f === k ? null : 0,
      vega_1pct: f === k ? d * f * normalPdf(0) * Math.sqrt(t) / 100 : 0,
      spot_delta: proportionalCarry && spot !== null ? delta * f / spot : null,
      spot_gamma: proportionalCarry && spot !== null && f !== k ? 0 : null,
      theta_calendar_day: f === k ? null : r * value / 365,
      rho_1pct: -t * value / 100, convention,
    };
  }
  const root = Math.sqrt(w);
  const d1 = (Math.log(f) - Math.log(k)) / root + root / 2;
  const density = normalPdf(d1);
  const delta = d * (normalCdf(d1) - (side === "PE" ? 1 : 0));
  const gamma = d * density / (f * root);
  const iv = Math.sqrt(w / t);
  return {
    forward_delta: delta, forward_gamma: gamma,
    vega_1pct: d * f * density * Math.sqrt(t) / 100,
    spot_delta: proportionalCarry && spot !== null ? delta * f / spot : null,
    spot_gamma: proportionalCarry && spot !== null ? gamma * (f / spot) ** 2 : null,
    theta_calendar_day: (r * value - d * f * density * iv / (2 * Math.sqrt(t))) / 365,
    rho_1pct: -t * value / 100, convention,
  };
}
