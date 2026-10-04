import { blackPrice } from "./black.js";
import type { SensitivityRange } from "./types.js";

/** Transparent scenario repricing, not a sampling distribution/statistical interval. */
export function modelSensitivity(args: {
  f: number; strike: number; t: number; d: number; iv: number; side: "CE" | "PE";
  forwardDispersion: number | null; rateBump: number; quoteIvBid: number | null; quoteIvAsk: number | null;
  alternativePrice?: { iv: number; forward: number; label: string };
}): SensitivityRange {
  const { f, strike, t, d, iv, side } = args;
  const scenarios: SensitivityRange["scenarios"] = [];
  const reasons: string[] = [];
  const add = (name: string, forward: number, discount: number, volatility: number, assumption: string) => {
    if (![forward, discount, volatility].every(Number.isFinite) || forward <= 0 || discount <= 0 || volatility < 0) { reasons.push(`${name}_invalid_scenario_omitted`); return; }
    scenarios.push({ name, forward, discount, iv: volatility,
      price: blackPrice({ f: forward, k: strike, d: discount, w: volatility * volatility * t, side }), assumption });
  };
  add("baseline", f, d, iv, "Frozen requested local surface IV, forward and curve.");
  if (args.forwardDispersion !== null && args.forwardDispersion > 0) {
    add("forward_minus_dispersion", f - args.forwardDispersion, d, iv,
      "Forward minus weighted median absolute parity-forward dispersion; diagnostic scenario, not a probability quantile.");
    add("forward_plus_dispersion", f + args.forwardDispersion, d, iv,
      "Forward plus weighted median absolute parity-forward dispersion; local IV held fixed.");
  } else reasons.push("forward_uncertainty_not_identified_by_dispersion");
  if (args.quoteIvBid !== null) add("quote_bid_iv", f, d, args.quoteIvBid, "Valid target quote bid-IV at fixed forward/discount; quote-implied range only.");
  if (args.quoteIvAsk !== null) add("quote_ask_iv", f, d, args.quoteIvAsk, "Valid target quote ask-IV at fixed forward/discount; quote-implied range only.");
  if (args.rateBump > 0) {
    add("rate_minus_bump", f, d * Math.exp(args.rateBump * t), iv,
      `Configured continuous-zero rate scenario −${args.rateBump * 100} percentage points; forward/IV held fixed.`);
    add("rate_plus_bump", f, d * Math.exp(-args.rateBump * t), iv,
      `Configured continuous-zero rate scenario +${args.rateBump * 100} percentage points; forward/IV held fixed.`);
  }
  if (args.alternativePrice) add("alternative_calibration", args.alternativePrice.forward, d, args.alternativePrice.iv,
    `${args.alternativePrice.label}; alternative calibrated forward/local IV, same curve.`);
  return { label: "Model sensitivity range", low: Math.min(...scenarios.map((s) => s.price)), high: Math.max(...scenarios.map((s) => s.price)),
    scenarios, reasons };
}
