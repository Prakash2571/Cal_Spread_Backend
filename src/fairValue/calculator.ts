import { blackPrice, frozenBlackGreeks } from "./black.js";
import { discountAt } from "./curve.js";
import { utcTimestamp } from "./metadata.js";
import { hypotheticalForward, proportionalCalendarSupported, requestedTime, totalVarianceBetween } from "./maturity.js";
import { varianceAt } from "./smile.js";
import { validatePriceGrid } from "./validation.js";
import { modelSensitivity } from "./sensitivity.js";
import { MODEL_VERSION } from "./config.js";
import type { CalculatorRequest, CalculatorResult, ExpirySlice, InputSnapshot, SurfaceSnapshot } from "./types.js";

export function validateCalculatorRequest(value: unknown): CalculatorRequest {
  if (!value || typeof value !== "object") throw new Error("Calculator request must be an object.");
  const r = value as Record<string, unknown>;
  const timestamp = utcTimestamp(r.expiry_timestamp);
  if (typeof r.underlying !== "string" || !/^[A-Z0-9&._-]{1,40}$/i.test(r.underlying) ||
      typeof r.strike !== "number" || !Number.isFinite(r.strike) || r.strike <= 0 || !timestamp ||
      (r.side !== "CE" && r.side !== "PE") || typeof r.research_mode !== "boolean") {
    throw new Error("Calculator needs underlying, positive numeric strike, exact UTC/offset expiry, CE/PE and boolean research_mode.");
  }
  if (r.input_snapshot_id !== undefined && (typeof r.input_snapshot_id !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(r.input_snapshot_id))) throw new Error("Invalid input_snapshot_id.");
  return { underlying: r.underlying.toUpperCase(), strike: r.strike, expiry_timestamp: timestamp,
    side: r.side, research_mode: r.research_mode,
    ...(typeof r.input_snapshot_id === "string" ? { input_snapshot_id: r.input_snapshot_id } : {}) };
}

export function calculate(input: InputSnapshot, surface: SurfaceSnapshot, request: CalculatorRequest): CalculatorResult {
  const r = validateCalculatorRequest(request);
  const t = requestedTime(input, r.expiry_timestamp);
  const listedRow = surface.slices.flatMap((s) => s.rows).find((row) => row.strike === r.strike && row.side === r.side && row.metadata?.expiry_timestamp === r.expiry_timestamp);
  const listedMetadata = listedRow?.metadata ?? input.listing_catalog?.find((m) => m.strike === r.strike && m.side === r.side && m.expiry_timestamp === r.expiry_timestamp) ?? null;
  const result: CalculatorResult = { available: false, input_snapshot_id: input.id, config_version: input.config_version,
    model_version: MODEL_VERSION, valuation_time: input.valuation_time,
    contract: listedMetadata ? "listed" : "hypothetical", instrument_token: listedMetadata?.token ?? null,
    strike_method: "unavailable", maturity_method: "unavailable", strike: r.strike,
    expiry_timestamp: r.expiry_timestamp, side: r.side, t, forward: null, discount: null, k: null,
    total_variance: null, surface_iv: null, fair_value: null, fair_value_per_lot: null,
    lot_size: listedMetadata?.lot_size ?? null, greeks: null, quality: "unavailable", reasons: [], assumptions: [], diagnostics: [], sensitivity: null };
  const fail = (reason: string): CalculatorResult => { result.reasons.push(reason); return result; };
  if (input.underlying !== r.underlying || surface.input_snapshot_id !== input.id || surface.config_version !== input.config_version) return fail("inconsistent_snapshot_identity");
  if (!Number.isFinite(t) || t <= 0) return fail("future_expiry_required");
  const config = input.config;
  const research = r.research_mode && config.research_enabled;
  const slices = surface.slices.filter((s) => s.t !== null && s.t > 0 && s.smile.valid && s.forward.value !== null && s.discount?.d != null)
    .sort((a, b) => a.t! - b.t!);
  if (slices.length === 0) return fail("no_valid_maturity_slices");
  let f: number | null = null;
  let variance: (k: number) => number | null;
  let low: number, high: number;
  let reference: ExpirySlice;
  const exact = slices.find((s) => s.expiry_timestamp === r.expiry_timestamp);
  if (!exact && surface.slices.some((s) => s.expiry_timestamp === r.expiry_timestamp)) {
    return fail("listed_expiry_slice_invalid_or_unavailable");
  }
  if (exact) {
    reference = exact;
    f = exact.forward.value;
    variance = (k) => varianceAt(exact.smile, k, config.smile, research);
    low = exact.smile.support!.min_k; high = exact.smile.support!.max_k;
    result.maturity_method = "listed_expiry";
    result.assumptions.push(...exact.forward.assumptions);
  } else {
    if (!proportionalCalendarSupported(input)) return fail("maturity_carry_or_event_assumption_unsupported");
    const upperIndex = slices.findIndex((s) => s.t! > t);
    if (upperIndex > 0) {
      const a = slices[upperIndex - 1]!, b = slices[upperIndex]!;
      reference = a;
      const region = surface.calendar_regions.find((g) => g.first_expiry === a.expiry && g.second_expiry === b.expiry);
      if (!region?.valid) {
        if (region) result.diagnostics.push(...region.diagnostics);
        return fail("maturity_region_invalid_or_unavailable");
      }
      low = region.min_k; high = region.max_k;
      variance = (k) => totalVarianceBetween(a, b, t, k, config, research);
      const forward = hypotheticalForward(input, t, a, b, "interpolation");
      f = forward.value; result.assumptions.push(...forward.assumptions);
      if (f === null) return fail(forward.reason ?? "hypothetical_forward_unavailable");
      result.maturity_method = "maturity_interpolation";
      result.assumptions.push("Linear interpolation of total variance at the SAME forward log-moneyness; no full arbitrage guarantee.");
    } else {
      if (!research) return fail("maturity_extrapolation_requires_research_opt_in_and_enabled_configuration");
      if (config.maturity_extrapolation !== "constant_short_end_and_forward_variance") return fail("maturity_extrapolation_disabled");
      const first = slices[0]!, last = slices[slices.length - 1]!;
      const distance = t < first.t! ? first.t! - t : t - last.t!;
      if (distance * 365 > config.max_maturity_extrapolation_days) return fail("maturity_extrapolation_distance_limit");
      if (t < first.t!) {
        reference = first; low = first.smile.support!.min_k; high = first.smile.support!.max_k;
        variance = (k) => { const w = varianceAt(first.smile, k, config.smile, research); return w === null ? null : t / first.t! * w; };
        const forward = hypotheticalForward(input, t, first, null, "short_research");
        f = forward.value; result.assumptions.push(...forward.assumptions);
        result.assumptions.push("Research constant-short-end-variance-rate assumption w(T)=T/T1×w(T1); especially unreliable near events or expiry.");
      } else {
        const previous = slices[slices.length - 2];
        if (!previous) return fail("forward_variance_extrapolation_needs_two_maturities");
        reference = last;
        low = Math.max(previous.smile.support!.min_k, last.smile.support!.min_k);
        high = Math.min(previous.smile.support!.max_k, last.smile.support!.max_k);
        variance = (k) => {
          const wn = varianceAt(last.smile, k, config.smile, research), wp = varianceAt(previous.smile, k, config.smile, research);
          if (wn === null || wp === null) return null;
          const forwardVariance = (wn - wp) / (last.t! - previous.t!);
          // No clamping: negative forward variance is an explicit unavailable region.
          return forwardVariance < 0 ? null : wn + forwardVariance * (t - last.t!);
        };
        const forward = hypotheticalForward(input, t, previous, last, "long_research");
        f = forward.value; result.assumptions.push(...forward.assumptions);
        result.assumptions.push("Research continuation of validated nonnegative forward total-variance slope from the final two maturities; no silent negative-variance repair.");
      }
      result.maturity_method = "maturity_extrapolation";
    }
  }
  if (f === null || !Number.isFinite(f) || f <= 0) return fail("hypothetical_forward_unavailable");
  const discount = discountAt(config.curve, t);
  if (discount.d === null) return fail("requested_discount_unavailable");
  const k = Math.log(r.strike) - Math.log(f);
  if (!Number.isFinite(k)) return fail("invalid_log_moneyness");
  const extra = k < low - 1e-12 || k > high + 1e-12;
  if (extra && !research) return fail("strike_extrapolation_requires_research_opt_in_and_enabled_configuration");
  if (extra && Math.max(low - k, k - high) > config.smile.strike_extrapolation_k) return fail("strike_extrapolation_distance_limit");
  if (extra && config.smile.strike_extrapolation_k === 0) return fail("strike_extrapolation_disabled");
  const w = variance(k);
  if (w === null || !Number.isFinite(w) || w < 0) return fail("requested_variance_unavailable_or_negative_forward_variance");
  result.strike_method = extra ? "strike_extrapolation" : exact?.rows.some((row) => row.strike === r.strike) ? "listed_strike" : "strike_interpolation";
  const domainLow = Math.min(low, k), domainHigh = Math.max(high, k);
  const validationKs = Array.from({ length: config.smile.diagnostic_points }, (_, i) => domainLow + (domainHigh - domainLow) * i / (config.smile.diagnostic_points - 1));
  // Add local requested neighbors and listed strike coordinates to the validation grid.
  validationKs.push(k, Math.max(domainLow, k - 1e-4), Math.min(domainHigh, k + 1e-4),
    ...reference.smile.nodes.flatMap((n) => [n.k - 1e-5, n.k, n.k + 1e-5]).filter((x) => x >= domainLow && x <= domainHigh));
  const strikes = validationKs.map((x) => f! * Math.exp(x));
  if (strikes.some((strike) => !Number.isFinite(strike) || strike <= 0)) return fail("requested_strike_numeric_range");
  const validation = validatePriceGrid({ f, d: discount.d, strikes, variance, tick: config.quote.tick_floor, config: config.smile });
  result.diagnostics.push(...validation.diagnostics);
  if (!validation.valid) return fail("requested_price_space_validation_failed");
  result.available = true; result.forward = f; result.discount = discount.d; result.k = k; result.total_variance = w;
  result.surface_iv = Math.sqrt(w / t);
  result.fair_value = blackPrice({ f, k: r.strike, d: discount.d, w, side: r.side });
  result.fair_value_per_lot = result.lot_size === null ? null : result.fair_value * result.lot_size;
  const carry = input.config.carry[input.underlying];
  result.greeks = frozenBlackGreeks({ f, k: r.strike, d: discount.d, w, side: r.side, t,
    spot: input.spot?.value ?? null, proportionalCarry: carry?.verified === true && carry.proportional && carry.dividends.length === 0 && carry.corporate_actions.length === 0 });
  result.quality = extra || result.maturity_method === "maturity_extrapolation" ? "research"
    : result.contract === "hypothetical" || result.maturity_method === "maturity_interpolation" || reference.quality !== "supported" ? "limited" : "supported";
  if (discount.assumption) result.assumptions.push(discount.assumption);
  if (result.contract === "hypothetical") result.reasons.push("hypothetical_non_tradeable_no_broker_id_or_lot");
  if (extra) result.reasons.push("limited_svi_wing_extrapolation");
  if (result.maturity_method === "maturity_extrapolation") result.reasons.push("research_maturity_extrapolation");
  result.reasons.push(...reference.reasons);
  result.sensitivity = modelSensitivity({ f, strike: r.strike, t, d: discount.d, iv: result.surface_iv, side: r.side,
    forwardDispersion: reference.forward.dispersion, rateBump: config.sensitivity_rate_bump,
    quoteIvBid: listedRow?.bid_iv?.status === "valid" ? listedRow.bid_iv.iv : null,
    quoteIvAsk: listedRow?.ask_iv?.status === "valid" ? listedRow.ask_iv.iv : null });
  return result;
}
