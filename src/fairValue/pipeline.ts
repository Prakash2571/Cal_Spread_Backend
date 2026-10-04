import { blackPrice, DAY_COUNT, frozenBlackGreeks, settlementPayoff, yearFraction } from "./black.js";
import { MODEL_VERSION } from "./config.js";
import { discountAt } from "./curve.js";
import { estimateOptionsForward, resolveForward } from "./forward.js";
import { invertIv } from "./iv.js";
import { resolveOptionMetadata } from "./metadata.js";
import { buildCalendarRegions } from "./maturity.js";
import { cleanQuote, coherentSnapshot } from "./quotes.js";
import { fitSmile, unavailableSmile, varianceAt } from "./smile.js";
import { modelSensitivity } from "./sensitivity.js";
import { intermediateStrikes, validatePriceGrid } from "./validation.js";
import type { CalibrationObservation, CleanQuote, Diagnostic, ExpirySlice, ForwardResult, InputSnapshot, OptionMetadata, SurfaceSnapshot, ValuationRow } from "./types.js";

function emptyForward(): ForwardResult {
  return { available: false, value: null, source: "unavailable", pair_count: 0,
    dispersion: null, interval: null, pairs: [], excluded_pairs: [], assumptions: [], diagnostics: [] };
}

function blankRow(inst: InputSnapshot["instruments"][number]): ValuationRow {
  return { token: inst.instrument_token, tradingsymbol: inst.tradingsymbol, strike: inst.strike,
    side: inst.instrument_type as "CE" | "PE", metadata: null, lot_size: Number.isSafeInteger(inst.lot_size) && inst.lot_size > 0 ? inst.lot_size : null,
    bid: null, ask: null, mid: null, quote: null, observed_iv: null, bid_iv: null, ask_iv: null,
    surface_iv: null, total_variance: null, fair_value: null, fair_value_per_lot: null,
    independent_value: null, independent_status: "on_demand", comparison: null, greeks: null,
    quality: "unavailable", reasons: [], estimation_method: "unavailable", expiry_payoff: null, sensitivity: null };
}

export function selectObservations(metadata: OptionMetadata[], quotes: CleanQuote[], f: number, d: number, t: number,
  input: InputSnapshot, rows: ValuationRow[]): { observations: CalibrationObservation[]; rejected: { token: number; reason: string }[] } {
  const byToken = new Map(rows.map((r) => [r.token, r]));
  const byStrike = new Map<number, CalibrationObservation[]>();
  const rejected: { token: number; reason: string }[] = [];
  const meta = new Map(metadata.map((m) => [m.token, m]));
  for (const quote of quotes) {
    const inst = meta.get(quote.token);
    const row = byToken.get(quote.token);
    if (!inst || !row) continue;
    const inversion = invertIv({ f, k: inst.strike, t, d, price: quote.mid, side: inst.side,
      tick: inst.tick_size, uncertainty: quote.h, config: input.config.iv });
    row.observed_iv = inversion;
    row.bid_iv = invertIv({ f, k: inst.strike, t, d, price: quote.bid!, side: inst.side, tick: inst.tick_size, config: input.config.iv });
    row.ask_iv = invertIv({ f, k: inst.strike, t, d, price: quote.ask!, side: inst.side, tick: inst.tick_size, config: input.config.iv });
    if (inversion.status !== "valid" || inversion.iv === null) {
      rejected.push({ token: quote.token, reason: `iv_${inversion.status}` });
      row.reasons.push(`iv_${inversion.status}`);
      continue;
    }
    const k = Math.log(inst.strike / f);
    const arr = byStrike.get(inst.strike) ?? [];
    arr.push({ strike: inst.strike, k, w: inversion.iv ** 2 * t, iv: inversion.iv,
      side: inst.side, token: inst.token, quote, dependence_factor: 1 });
    byStrike.set(inst.strike, arr);
  }
  const observations: CalibrationObservation[] = [];
  for (const candidates of byStrike.values()) {
    const k = candidates[0]!.k;
    if (Math.abs(k) <= input.config.smile.atm_band) {
      // Same economic strike: normalize dependence so CE+PE do not count twice.
      observations.push(...candidates.map((o) => ({ ...o, dependence_factor: 1 / candidates.length })));
    } else {
      const side = k < 0 ? "PE" : "CE";
      const preferred = candidates.find((o) => o.side === side);
      if (preferred) {
        observations.push(preferred);
        rejected.push(...candidates.filter((o) => o.side !== side).map((o) => ({ token: o.token, reason: "itm_side_diagnostic_only_otm_preferred" })));
      }
      else rejected.push(...candidates.map((o) => ({ token: o.token, reason: "otm_side_unavailable" })));
    }
  }
  return { observations, rejected };
}

export function buildSlice(input: InputSnapshot, expiry: string, excludeStrike?: number): ExpirySlice {
  const { config } = input;
  const now = Date.parse(input.valuation_time);
  const instruments = input.instruments.filter((i) => i.expiry.slice(0, 10) === expiry && i.strike !== excludeStrike);
  const rows = instruments.map(blankRow).sort((a, b) => a.strike - b.strike || a.side.localeCompare(b.side));
  const metadata: OptionMetadata[] = [];
  const clean: CleanQuote[] = [];
  const diagnostics: Diagnostic[] = [];
  const quotes = new Map(input.quotes.map((q) => [q.token, q]));
  const duplicateTokens = new Set<number>();
  const duplicateContracts = new Set<string>();
  const seenTokens = new Set<number>();
  const seenContracts = new Set<string>();
  for (const inst of instruments) {
    const key = `${inst.strike}:${inst.instrument_type}`;
    if (seenTokens.has(inst.instrument_token)) duplicateTokens.add(inst.instrument_token);
    if (seenContracts.has(key)) duplicateContracts.add(key);
    seenTokens.add(inst.instrument_token); seenContracts.add(key);
  }
  for (const row of rows) {
    const inst = instruments.find((i) => i.instrument_token === row.token)!;
    const resolved = resolveOptionMetadata(inst, config.expiry_policy, input.metadata_version);
    const raw = quotes.get(row.token);
    row.bid = raw?.bid ?? null;
    row.ask = raw?.ask ?? null;
    if (duplicateTokens.has(row.token) || duplicateContracts.has(`${row.strike}:${row.side}`)) {
      row.reasons.push("duplicate_instrument_metadata");
      continue;
    }
    if (!resolved.ok) { row.reasons.push(...resolved.reasons); continue; }
    row.metadata = resolved.metadata;
    metadata.push(resolved.metadata);
    const filtered = cleanQuote(resolved.metadata, raw, now, config.quote);
    if (filtered.ok) {
      clean.push(filtered.quote);
      row.quote = filtered.quote;
      row.mid = filtered.quote.calibration_eligible ? filtered.quote.mid : null;
      row.reasons.push(...filtered.quote.reasons);
    } else row.reasons.push(...filtered.rejection.reasons);
  }
  const timestamps = [...new Set(metadata.map((m) => m.expiry_timestamp))];
  const timestamp = timestamps.length === 1 ? timestamps[0]! : null;
  const t = timestamp ? yearFraction(timestamp, now) : null;
  const slice: ExpirySlice = { expiry, expiry_timestamp: timestamp, t, discount: null, forward: emptyForward(),
    smile: unavailableSmile("No validated smile yet."), rows, observations: [], snapshot_dispersion_ms: 0,
    atm_iv: null, quality: "unavailable", reasons: [], diagnostics };
  if (timestamp === null || t === null) {
    slice.reasons.push(timestamps.length > 1 ? "inconsistent_expiry_timestamps" : "expiry_time_unverified");
    return slice;
  }
  if (t <= 0) {
    for (const row of rows) if (row.metadata && row.lot_size) {
      row.expiry_payoff = settlementPayoff({ strike: row.strike, side: row.side, lot: row.lot_size,
        settlement: null, indicative: input.spot?.value ?? null, settlementUnderlying: row.metadata.settlement_underlying });
      row.quality = "limited";
      row.reasons.push("expired", "official_settlement_unknown");
      row.estimation_method = "indicative_expiry_payoff";
    }
    slice.reasons.push("expired", "official_settlement_unknown");
    return slice;
  }
  const discount = discountAt(config.curve, t);
  slice.discount = discount;
  if (discount.d === null) { slice.reasons.push("discount_unavailable"); return slice; }
  const coherent = coherentSnapshot(clean, config.quote);
  slice.snapshot_dispersion_ms = coherent.dispersion_ms;
  for (const rejection of coherent.excluded) {
    const row = rows.find((r) => r.token === rejection.token);
    row?.reasons.push(...rejection.reasons);
  }
  const options = estimateOptionsForward({ metadata, quotes: coherent.eligible, d: discount.d,
    config: { ...config.forward, max_pair_dispersion_ms: Math.min(config.forward.max_pair_dispersion_ms, config.quote.max_pair_dispersion_ms) } });
  const futureQuotes: { expiry_timestamp: string; quote: CleanQuote }[] = [];
  for (const future of input.futures) {
    const futureMeta = { ...metadata[0]!, token: future.quote.token, tick_size: future.tick_size };
    if (!futureMeta.token) continue;
    const filtered = cleanQuote(futureMeta, future.quote, now, config.quote);
    if (filtered.ok) futureQuotes.push({ expiry_timestamp: future.expiry_timestamp, quote: filtered.quote });
  }
  const forward = resolveForward({ options, expiry: timestamp, now, curve: config.curve,
    futures: futureQuotes, spot: input.spot, carry: config.carry[input.underlying] ?? null, maxAgeMs: config.quote.max_age_ms });
  slice.forward = forward;
  if (forward.value === null) { slice.reasons.push("forward_unavailable"); return slice; }
  const incoherentStrikes = new Set(forward.excluded_pairs.filter((p) => p.reasons.some((reason) =>
    ["incoherent_pair_metadata", "incoherent_pair_timestamps", "robust_forward_outlier", "invalid_pair_forward", "pair_premiums_outside_european_bounds"].includes(reason))).map((p) => p.strike));
  for (const row of rows) if (incoherentStrikes.has(row.strike)) row.reasons.push("incoherent_call_put_pair_excluded_from_calibration");
  const calibrationQuotes = coherent.eligible.filter((q) => !incoherentStrikes.has(metadata.find((m) => m.token === q.token)?.strike ?? NaN));
  const selection = selectObservations(metadata, calibrationQuotes, forward.value, discount.d, t, input, rows);
  // Both sides remain quote diagnostics after pair exclusion; zero bids never get
  // a normal midpoint inversion or calibration weight.
  for (const row of rows) {
    if (!row.metadata || !row.quote || row.observed_iv) continue;
    const args = { f: forward.value, k: row.strike, t, d: discount.d, side: row.side,
      tick: row.metadata.tick_size, config: input.config.iv };
    if (row.quote.bid !== null) row.bid_iv = invertIv({ ...args, price: row.quote.bid });
    if (row.quote.ask !== null) row.ask_iv = invertIv({ ...args, price: row.quote.ask });
    if (row.quote.calibration_eligible) row.observed_iv = invertIv({ ...args, price: row.quote.mid, uncertainty: row.quote.h });
  }
  slice.observations = selection.observations;
  const smile = fitSmile(selection.observations, forward.value, discount.d, config.smile);
  smile.calibration.rejected.push(...selection.rejected);
  for (const row of rows) if (!selection.observations.some((o) => o.token === row.token) && row.reasons.length > 0 &&
    !smile.calibration.rejected.some((r) => r.token === row.token)) {
    smile.calibration.rejected.push({ token: row.token, reason: row.reasons.join(", ") });
  }
  slice.smile = smile;
  if (smile.valid && smile.support) {
    const requestedStrikes = rows.filter((r) => r.metadata && Math.log(r.strike / forward.value!) >= smile.support!.min_k - 1e-12 &&
      Math.log(r.strike / forward.value!) <= smile.support!.max_k + 1e-12).map((r) => r.strike);
    const validation = validatePriceGrid({ f: forward.value, d: discount.d,
      strikes: intermediateStrikes([...smile.support.strikes, ...requestedStrikes], 8),
      variance: (k) => varianceAt(smile, k, config.smile), tick: config.quote.tick_floor, config: config.smile });
    if (!validation.valid) {
      smile.valid = false;
      smile.diagnostics.push(...validation.diagnostics, { code: "listed_price_validation_failure", severity: "error",
        message: "Price-space validation failed on listed/intermediate strikes; slice prices suppressed." });
    }
  }
  const proportionalCarry = config.carry[input.underlying]?.verified === true &&
    config.carry[input.underlying]?.proportional === true && (config.carry[input.underlying]?.dividends.length ?? 0) === 0 &&
    (config.carry[input.underlying]?.corporate_actions.length ?? 0) === 0;
  for (const row of rows) {
    if (!row.metadata) continue;
    const k = Math.log(row.strike / forward.value);
    const w = varianceAt(smile, k, config.smile);
    if (w === null) {
      row.reasons.push(smile.valid ? "strike_outside_supported_range" : "smile_invalid_or_unavailable");
      continue;
    }
    row.total_variance = w;
    row.surface_iv = Math.sqrt(w / t);
    row.fair_value = blackPrice({ f: forward.value, k: row.strike, d: discount.d, w, side: row.side });
    row.fair_value_per_lot = row.lot_size === null ? null : row.lot_size * row.fair_value;
    row.greeks = frozenBlackGreeks({ f: forward.value, k: row.strike, d: discount.d, w, side: row.side,
      t, spot: input.spot?.value ?? null, proportionalCarry });
    row.estimation_method = smile.method;
    row.quality = smile.method === "svi" && row.reasons.length === 0 && !discount.assumption && forward.source === "robust_options_implied" ? "supported" : "limited";
    if (discount.assumption) row.reasons.push("flat_discount_assumption");
    if (forward.source !== "robust_options_implied") row.reasons.push(`forward_${forward.source}`);
    if (smile.method === "validated_interpolation") row.reasons.push("validated_interpolation_limited_support");
    if (forward.interval && !forward.interval.compatible) {
      row.quality = "limited"; row.reasons.push("incompatible_forward_intervals");
    }
    if (input.universe.bounded) { row.quality = "limited"; row.reasons.push("bounded_input_chain_support"); }
    if (!row.quote) row.reasons.push("observed_quote_unavailable_model_only");
    row.sensitivity = modelSensitivity({ f: forward.value, strike: row.strike, t, d: discount.d,
      iv: row.surface_iv, side: row.side, forwardDispersion: forward.dispersion,
      rateBump: config.sensitivity_rate_bump,
      quoteIvBid: row.bid_iv?.status === "valid" ? row.bid_iv.iv : null,
      quoteIvAsk: row.ask_iv?.status === "valid" ? row.ask_iv.iv : null });
    if (row.mid !== null && row.quote && row.lot_size !== null) {
      const deviation = row.mid - row.fair_value;
      const buy = row.fair_value - row.ask!;
      const sell = row.bid! - row.fair_value;
      row.comparison = { mid_deviation: deviation,
        mid_deviation_percent: 100 * deviation / Math.max(row.fair_value, config.quote.premium_floor),
        label: Math.abs(deviation) < row.metadata.tick_size * .01 ? "At model" : deviation > 0 ? "Above model" : "Below model",
        theoretical_buy_difference: buy, theoretical_sell_difference: sell,
        lot_mid_deviation: deviation * row.lot_size, lot_buy_difference: buy * row.lot_size,
        lot_sell_difference: sell * row.lot_size,
        convention: "Model comparisons before fees and execution costs; not trade recommendations." };
    }
  }
  const atm = varianceAt(smile, 0, config.smile);
  slice.atm_iv = atm === null ? null : Math.sqrt(atm / t);
  slice.quality = smile.valid ? smile.method === "svi" && !discount.assumption && forward.source === "robust_options_implied" &&
    forward.interval?.compatible !== false && !input.universe.bounded ? "supported" : "limited" : smile.method === "unavailable" ? "unavailable" : "invalid";
  slice.reasons.push(...(smile.valid ? [] : ["smile_invalid_or_unavailable"]));
  if (discount.assumption) slice.reasons.push("flat_discount_assumption");
  if (input.universe.bounded) slice.reasons.push("bounded_input_chain_support");
  slice.diagnostics.push(...forward.diagnostics, ...smile.diagnostics);
  return slice;
}

export function buildSurface(input: InputSnapshot): SurfaceSnapshot {
  const start = performance.now();
  const expiries = [...new Set(input.instruments.map((i) => i.expiry.slice(0, 10)))].sort();
  const slices = expiries.map((expiry) => buildSlice(input, expiry));
  return { id: input.id, input_snapshot_id: input.id, model_version: MODEL_VERSION,
    config_version: input.config_version, sequence: 0, underlying: input.underlying, name: input.name,
    broker: input.broker, broker_generation: input.broker_generation, feed_generation: input.feed_generation,
    valuation_time: input.valuation_time, published_at: input.valuation_time, timezone: "Asia/Kolkata",
    day_count: DAY_COUNT, premium_unit: "INR per underlying unit; per lot uses instrument multiplier",
    slices, calendar_regions: buildCalendarRegions(slices, input), spot: input.spot,
    spot_provenance: input.spot_provenance ?? null, curve: input.config.curve,
    carry: input.config.carry[input.underlying] ?? null, universe: input.universe,
    diagnostics: input.universe.bounded ? [{ code: "bounded_capture", severity: "warning", message: `${input.universe.captured_contracts}/${input.universe.listed_contracts} listed contracts in bounded input snapshot; full-chain means all eligible observations in this captured snapshot.` }] : [],
    duration_ms: performance.now() - start };
}
