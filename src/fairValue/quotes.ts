import type { CleanQuote, MarketQuote, OptionMetadata, QuotePolicy, QuoteRejection } from "./types.js";

export const DEFAULT_QUOTE_POLICY: QuotePolicy = {
  max_age_ms: 30_000, max_relative_spread: 0.25, max_absolute_spread: 100,
  min_depth: 1, premium_floor: 1, tick_floor: 0.05, depth_target: 100,
  freshness_tau_ms: 15_000, max_pair_dispersion_ms: 2_000,
  max_snapshot_dispersion_ms: 10_000, future_timestamp_tolerance_ms: 1_000,
  zero_bid_policy: "diagnostic_only",
};

export function cleanQuote(metadata: OptionMetadata, quote: MarketQuote | undefined, now: number, policy: QuotePolicy):
  { ok: true; quote: CleanQuote } | { ok: false; rejection: QuoteRejection } {
  const reasons: string[] = [];
  const reject = (): { ok: false; rejection: QuoteRejection } => ({ ok: false, rejection: {
    token: metadata.token, strike: metadata.strike, side: metadata.side, reasons,
  } });
  if (!Number.isFinite(now)) throw new Error("Invalid valuation timestamp.");
  if (!quote) { reasons.push("missing_quote"); return reject(); }
  const { bid, ask, bid_depth, ask_depth } = quote;
  if (quote.token !== metadata.token || bid === null || ask === null || ![bid, ask, bid_depth, ask_depth].every(Number.isFinite) ||
      bid < 0 || ask <= 0 || bid_depth < 0 || ask_depth < 0 ||
      !Number.isSafeInteger(bid_depth) || !Number.isSafeInteger(ask_depth) ||
      !Number.isFinite(quote.version) || quote.version < 0) {
    reasons.push("invalid_quote"); return reject();
  }
  if (ask < bid) reasons.push("crossed_quote");
  const received = Date.parse(quote.receive_timestamp);
  const exchanged = quote.exchange_timestamp === null ? null : Date.parse(quote.exchange_timestamp);
  if (!Number.isFinite(received) || (exchanged !== null && !Number.isFinite(exchanged))) {
    reasons.push("invalid_quote_timestamp"); return reject();
  }
  const timestamp = exchanged ?? received;
  const age = now - timestamp;
  if (age < -policy.future_timestamp_tolerance_ms || received > now + policy.future_timestamp_tolerance_ms ||
      (exchanged !== null && exchanged > received + policy.future_timestamp_tolerance_ms)) reasons.push("future_quote_timestamp");
  if (age > policy.max_age_ms || now - received > policy.max_age_ms) reasons.push("stale_quote");
  const mid = bid / 2 + ask / 2;
  const spread = ask - bid;
  const relative = spread / Math.max(mid, policy.premium_floor);
  const zeroBid = bid === 0;
  if (zeroBid && policy.zero_bid_policy === "exclude") reasons.push("zero_bid_low_information");
  if (!zeroBid && (relative > policy.max_relative_spread || spread > policy.max_absolute_spread)) reasons.push("wide_spread");
  const depth = Math.min(bid_depth, ask_depth);
  if (!zeroBid && depth < policy.min_depth) reasons.push("insufficient_depth");
  if (zeroBid && ask_depth < policy.min_depth) reasons.push("insufficient_depth");
  if (reasons.length > 0) return reject();
  const availableDepth = zeroBid ? ask_depth : depth;
  return { ok: true, quote: {
    ...quote, mid, spread, relative_spread: relative, age_ms: Math.max(0, age),
    freshness_basis: exchanged === null ? "receive" : "exchange",
    quote_timestamp: new Date(timestamp).toISOString(), available_depth: availableDepth,
    weight: zeroBid ? 0 : Math.exp(-Math.max(0, age) / policy.freshness_tau_ms) * Math.min(1, availableDepth / policy.depth_target),
    h: Math.max(spread / 2, metadata.tick_size, policy.tick_floor),
    calibration_eligible: !zeroBid,
    reasons: zeroBid ? ["zero_bid_low_information", "diagnostic_only_no_midpoint_calibration"] : exchanged === null ? ["receive_time_freshness"] : [],
  } };
}

/** Synchronize a cross-section to its newest eligible timestamp, retaining exclusion evidence. */
export function coherentSnapshot(quotes: CleanQuote[], policy: QuotePolicy): {
  eligible: CleanQuote[]; excluded: { token: number; reasons: string[] }[]; dispersion_ms: number;
} {
  const calibration = quotes.filter((q) => q.calibration_eligible);
  const times = calibration.map((q) => Date.parse(q.quote_timestamp));
  if (times.length === 0) return { eligible: [], excluded: [], dispersion_ms: 0 };
  const newest = Math.max(...times);
  const eligible = calibration.filter((q) => newest - Date.parse(q.quote_timestamp) <= policy.max_snapshot_dispersion_ms);
  const keep = new Set(eligible.map((q) => q.token));
  return { eligible,
    excluded: calibration.filter((q) => !keep.has(q.token)).map((q) => ({ token: q.token, reasons: ["snapshot_time_dispersion"] })),
    dispersion_ms: eligible.length > 1 ? newest - Math.min(...eligible.map((q) => Date.parse(q.quote_timestamp))) : 0,
  };
}
