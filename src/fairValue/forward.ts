import { discountAt } from "./curve.js";
import { yearFraction } from "./black.js";
import { priceBounds } from "./black.js";
import type { CarrySpec, CleanQuote, Diagnostic, DiscountCurveSpec, ForwardPair, ForwardResult, OptionMetadata } from "./types.js";

export interface ForwardConfig {
  min_pairs: number;
  huber_delta: number;
  refine: boolean;
  refinement_iterations: number;
  outlier_scale: number;
  max_pair_dispersion_ms: number;
  tick_floor: number;
  max_relative_dispersion: number;
}

export const DEFAULT_FORWARD_CONFIG: ForwardConfig = {
  min_pairs: 3, huber_delta: 1.5, refine: true, refinement_iterations: 30,
  outlier_scale: 6, max_pair_dispersion_ms: 2_000, tick_floor: 0.05,
  max_relative_dispersion: 0.005,
};

export function weightedMedian(values: { value: number; weight: number }[]): number {
  const eligible = values.filter((v) => Number.isFinite(v.value) && Number.isFinite(v.weight) && v.weight > 0)
    .sort((a, b) => a.value - b.value);
  const total = eligible.reduce((sum, v) => sum + v.weight, 0);
  if (eligible.length === 0 || !Number.isFinite(total)) throw new Error("Weighted median has no finite positive weights.");
  let cumulative = 0;
  for (const item of eligible) {
    cumulative += item.weight;
    if (cumulative >= total / 2) return item.value;
  }
  return eligible[eligible.length - 1]!.value;
}

export function huber(value: number, delta: number): number {
  const a = Math.abs(value);
  return a <= delta ? value * value / 2 : delta * (a - delta / 2);
}

export function estimateOptionsForward(args: {
  metadata: OptionMetadata[]; quotes: CleanQuote[]; d: number; config?: ForwardConfig; excludeStrike?: number;
}): ForwardResult {
  const { metadata, quotes, d } = args;
  const cfg = args.config ?? DEFAULT_FORWARD_CONFIG;
  if (!Number.isFinite(d) || d <= 0) throw new Error("Forward estimation requires positive finite discount factor.");
  const byToken = new Map(quotes.filter((q) => q.calibration_eligible && q.weight > 0).map((q) => [q.token, q]));
  const byStrike = new Map<number, { call?: OptionMetadata; put?: OptionMetadata }>();
  for (const inst of metadata) {
    if (inst.strike === args.excludeStrike) continue;
    const pair = byStrike.get(inst.strike) ?? {};
    if (inst.side === "CE") pair.call = inst;
    else pair.put = inst;
    byStrike.set(inst.strike, pair);
  }
  const excluded: ForwardResult["excluded_pairs"] = [];
  const pairs: ForwardPair[] = [];
  for (const [strike, { call, put }] of byStrike) {
    const reasons: string[] = [];
    if (!call || !put) { excluded.push({ strike, reasons: ["missing_call_put_metadata"] }); continue; }
    const c = byToken.get(call.token);
    const p = byToken.get(put.token);
    if (!c || !p) { excluded.push({ strike, reasons: ["call_put_quote_ineligible"] }); continue; }
    if (call.style !== "european" || put.style !== "european" || call.underlying !== put.underlying ||
        call.expiry_timestamp !== put.expiry_timestamp || call.lot_size !== put.lot_size ||
        call.settlement_underlying !== put.settlement_underlying) reasons.push("incoherent_pair_metadata");
    if (c.freshness_basis !== p.freshness_basis ||
        Math.abs(Date.parse(c.quote_timestamp) - Date.parse(p.quote_timestamp)) > cfg.max_pair_dispersion_ms ||
        Math.abs(Date.parse(c.receive_timestamp) - Date.parse(p.receive_timestamp)) > cfg.max_pair_dispersion_ms) reasons.push("incoherent_pair_timestamps");
    const forward = strike + (c.mid - p.mid) / d;
    const lower = strike + (c.bid! - p.ask!) / d;
    const upper = strike + (c.ask! - p.bid!) / d;
    if (!Number.isFinite(forward) || forward <= 0 || !Number.isFinite(lower) || !Number.isFinite(upper) || upper <= 0) reasons.push("invalid_pair_forward");
    if (reasons.length > 0) { excluded.push({ strike, reasons }); continue; }
    const scale = Math.max((c.spread + p.spread) / 2, call.tick_size, put.tick_size, cfg.tick_floor);
    const callBounds = priceBounds(forward, strike, d, "CE"), putBounds = priceBounds(forward, strike, d, "PE");
    const tolerance = Math.max(call.tick_size, put.tick_size, cfg.tick_floor) * .02;
    if (c.mid < callBounds.lower - tolerance || c.mid > callBounds.upper + tolerance ||
        p.mid < putBounds.lower - tolerance || p.mid > putBounds.upper + tolerance) {
      excluded.push({ strike, reasons: ["pair_premiums_outside_european_bounds"] });
      continue;
    }
    pairs.push({ strike, forward, lower, upper, weight: Math.min(c.weight, p.weight), scale,
      call_token: call.token, put_token: put.token, residual: 0 });
  }
  const diagnostics: Diagnostic[] = [];
  const unavailable = (reason: string, selected = pairs): ForwardResult => ({ available: false, value: null,
    source: "unavailable", pair_count: selected.length, dispersion: null, interval: null, pairs: selected,
    excluded_pairs: excluded, assumptions: [], diagnostics: [...diagnostics, { code: "forward_unavailable", severity: "warning", message: reason }] });
  if (pairs.length < cfg.min_pairs) return unavailable(`Need ${cfg.min_pairs} eligible call-put pairs, have ${pairs.length}.`);
  const f0 = weightedMedian(pairs.map((p) => ({ value: p.forward, weight: p.weight })));
  const mad = weightedMedian(pairs.map((p) => ({ value: Math.abs(p.forward - f0), weight: p.weight })));
  const selected = pairs.filter((p) => {
    const limit = cfg.outlier_scale * Math.max(1.4826 * mad, p.scale / d, cfg.tick_floor / d);
    if (Math.abs(p.forward - f0) <= limit) return true;
    excluded.push({ strike: p.strike, reasons: ["robust_forward_outlier"] });
    return false;
  });
  if (selected.length < cfg.min_pairs) return unavailable("Insufficient coherent pairs after robust outlier exclusion.", selected);
  let estimate = weightedMedian(selected.map((p) => ({ value: p.forward, weight: p.weight })));
  if (cfg.refine) {
    // IRLS solves the convex one-dimensional Huber objective on standardized parity
    // residuals. Base weights are min(call freshness×depth, put freshness×depth).
    for (let iteration = 0; iteration < cfg.refinement_iterations; iteration++) {
      let numerator = 0;
      let denominator = 0;
      for (const p of selected) {
        const residual = d * (p.forward - estimate) / p.scale;
        const robust = Math.abs(residual) <= cfg.huber_delta ? 1 : cfg.huber_delta / Math.abs(residual);
        const weight = p.weight * robust / (p.scale * p.scale);
        numerator += weight * p.forward;
        denominator += weight;
      }
      const next = numerator / denominator;
      if (!Number.isFinite(next) || next <= 0) return unavailable("Robust forward refinement failed.", selected);
      const change = Math.abs(next - estimate);
      estimate = next;
      if (change <= cfg.tick_floor * 1e-6) break;
    }
  }
  const dispersion = weightedMedian(selected.map((p) => ({ value: Math.abs(p.forward - estimate), weight: p.weight })));
  const lower = Math.max(...selected.map((p) => p.lower));
  const upper = Math.min(...selected.map((p) => p.upper));
  const compatible = lower <= upper;
  if (!compatible) diagnostics.push({ code: "incompatible_forward_intervals", severity: "warning",
    message: "Call-put bid/ask forward intervals have no common intersection; inspect stale/noisy pairs." });
  if (dispersion / estimate > cfg.max_relative_dispersion) return unavailable("Options-implied forward dispersion exceeds the configured quality limit.", selected);
  return { available: true, value: estimate, source: "robust_options_implied", pair_count: selected.length,
    dispersion, interval: { lower, upper, compatible },
    pairs: selected.map((p) => ({ ...p, residual: d * (p.forward - estimate) })),
    excluded_pairs: excluded, diagnostics,
    assumptions: [`European parity; fixed supplied D. Weighted-median initialization; Huber delta ${cfg.huber_delta}; uncertainty scale=max((call spread+put spread)/2, ticks).`,
      "Freshness/depth weights and robust-outlier tuning are configurable engineering heuristics."],
  };
}

export function resolveForward(args: {
  options: ForwardResult; expiry: string; now: number; curve: DiscountCurveSpec;
  futures: { expiry_timestamp: string; quote: CleanQuote }[];
  spot: { value: number; timestamp: string } | null; carry: CarrySpec | null; maxAgeMs: number;
}): ForwardResult {
  if (args.options.available) return args.options;
  const assumptions: string[] = [];
  const make = (value: number, source: ForwardResult["source"]): ForwardResult => ({ ...args.options,
    available: true, value, source, assumptions: [...args.options.assumptions, ...assumptions] });
  const matching = args.futures.find((f) => f.expiry_timestamp === args.expiry && f.quote.calibration_eligible && f.quote.age_ms <= args.maxAgeMs);
  if (matching && matching.quote.mid > 0) {
    assumptions.push("Fresh exact-expiry futures midpoint approximates forward; deterministic rates and no material futures/forward convexity adjustment.");
    return make(matching.quote.mid, "matching_expiry_futures");
  }
  const { spot, carry } = args;
  if (!spot || !carry?.verified || !Number.isFinite(spot.value) || spot.value <= 0 ||
      !Number.isFinite(Date.parse(spot.timestamp)) ||
      args.now - Date.parse(spot.timestamp) > args.maxAgeMs || Date.parse(spot.timestamp) > args.now ||
      carry.corporate_actions.length > 0) return args.options;
  const t = yearFraction(args.expiry, args.now);
  if (t <= 0) return args.options;
  const discount = discountAt(args.curve, t);
  if (discount.d === null) return args.options;
  let value: number;
  if (carry.dividends.length > 0) {
    let pv = 0;
    for (const event of carry.dividends) {
      const time = Date.parse(event.timestamp);
      if (!Number.isFinite(time) || !Number.isFinite(event.amount) || event.amount < 0) return args.options;
      if (time <= args.now || time >= Date.parse(args.expiry)) continue;
      const eventD = discountAt(args.curve, yearFraction(time, args.now)).d;
      if (eventD === null) return args.options;
      pv += event.amount * eventD;
    }
    value = (spot.value - pv) / discount.d;
    assumptions.push("Verified deterministic carry with known cash dividends strictly before expiry: (spot−PV dividends)/D; no borrow/funding basis or corporate-action adjustment.");
  } else if (carry.proportional && carry.dividend_yield !== null && Number.isFinite(carry.dividend_yield)) {
    value = spot.value * Math.exp(-carry.dividend_yield * t) / discount.d;
    assumptions.push("Verified proportional carry with continuous dividend yield: S exp((r−q)T); no borrow/funding basis.");
  } else return args.options;
  if (!Number.isFinite(value) || value <= 0) return args.options;
  assumptions.push(`Carry source ${carry.source}, version ${carry.version}, as of ${carry.as_of}.`);
  return make(value, "verified_spot_carry");
}
