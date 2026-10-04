import { blackPrice } from "./black.js";
import { buildSlice } from "./pipeline.js";
import { varianceAt } from "./smile.js";
import { intermediateStrikes, validatePriceGrid } from "./validation.js";
import { resolveOptionMetadata } from "./metadata.js";
import type { IndependentEstimate, InputSnapshot } from "./types.js";

/** Removes BOTH CE/PE before quote filtering, parity estimation, IV selection and calibration. */
export function independentEstimate(input: InputSnapshot, expiry: string, strike: number): IndependentEstimate {
  const started = performance.now();
  if (!Number.isFinite(strike) || strike <= 0) throw new Error("Independent estimate requires a positive numeric strike.");
  const target = input.instruments.filter((i) => i.expiry.slice(0, 10) === expiry && i.strike === strike);
  const excluded = target.map((i) => i.instrument_token);
  const result: IndependentEstimate = { status: "unavailable", input_snapshot_id: input.id, config_version: input.config_version,
    expiry, strike, values: [], forward: { available: false, value: null, source: "unavailable", pair_count: 0,
      dispersion: null, interval: null, pairs: [], excluded_pairs: [], assumptions: [], diagnostics: [] },
    smile: { method: "unavailable", parameters: null, nodes: [], support: null, valid: false, diagnostics: [],
      butterfly: { min_g: null, checked_points: 0, domain: null, right_wing_slope: null, left_wing_slope: null, tail_condition: null, global_proof: false },
      calibration: { observation_count: 0, distinct_strikes: 0, normalized_rmse: null, inside_spread_percent: null,
        optimizer_status: "unsupported", optimizer_iterations: 0, optimizer_starts: 0, duration_ms: 0, residuals: [], rejected: [] } },
    excluded_tokens: excluded, duration_ms: 0, reasons: [] };
  if (target.length === 0) { result.reasons.push("target_strike_not_in_input_snapshot"); return result; }
  if (target.some((inst) => !resolveOptionMetadata(inst, input.config.expiry_policy, input.metadata_version).ok)) {
    result.reasons.push("invalid_target_instrument_metadata_or_style"); return result;
  }
  // buildSlice removes the target instrument set before any forward/smile work.
  const slice = buildSlice(input, expiry, strike);
  result.forward = slice.forward; result.smile = slice.smile;
  result.duration_ms = performance.now() - started;
  if (!slice.smile.valid || slice.forward.value === null || slice.discount?.d === null || slice.discount === null || slice.t === null || slice.t <= 0) {
    result.status = "insufficient_data";
    result.reasons.push("insufficient_valid_remaining_observations", ...slice.reasons);
    return result;
  }
  const f = slice.forward.value, d = slice.discount.d;
  const w = varianceAt(slice.smile, Math.log(strike / f), input.config.smile);
  if (w === null) { result.status = "insufficient_data"; result.reasons.push("target_outside_remaining_strike_support"); return result; }
  const validation = validatePriceGrid({ f, d, strikes: intermediateStrikes([...slice.smile.support!.strikes, strike], 8),
    variance: (k) => varianceAt(slice.smile, k, input.config.smile), tick: input.config.quote.tick_floor, config: input.config.smile });
  if (!validation.valid) {
    result.reasons.push("independent_target_price_validation_failed");
    result.smile = { ...slice.smile, diagnostics: [...slice.smile.diagnostics, ...validation.diagnostics] };
    return result;
  }
  result.values = (["CE", "PE"] as const).map((side) => {
    const lot = target.find((i) => i.instrument_type === side)?.lot_size ?? null;
    const value = blackPrice({ f, k: strike, d, w, side });
    return { side, fair_value: value, per_lot: lot !== null && Number.isSafeInteger(lot) && lot > 0 ? value * lot : null };
  });
  result.status = "available";
  result.reasons.push("both_target_sides_excluded_from_forward_and_smile", ...slice.reasons);
  result.duration_ms = performance.now() - started;
  return result;
}
