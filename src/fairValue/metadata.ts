import type { Instrument } from "../kite.js";
import type { ExpiryPolicy, OptionMetadata } from "./types.js";
import { INDEX_SPOT_MAP } from "../indexSpot.js";

/** Reject date rollovers accepted by Date.parse (e.g. February 30). */
export function validDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) &&
    new Date(date).toISOString().slice(0, 10) === date;
}

export function utcTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !validDate(value.slice(0, 10)) || !Number.isFinite(Date.parse(value))) return null;
  const time = value.slice(11, 19).split(":").map(Number);
  if (time[0]! > 23 || time[1]! > 59 || time[2]! > 59) return null;
  const offset = value.match(/[+-](\d{2}):(\d{2})$/);
  if (offset && (Number(offset[1]) > 23 || Number(offset[2]) > 59)) return null;
  return new Date(value).toISOString();
}

export function validateExpiryPolicy(policy: ExpiryPolicy | null): void {
  if (policy === null) return;
  if (policy.exchange !== "NFO" || policy.timezone !== "Asia/Kolkata" ||
      !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(policy.local_time) ||
      !policy.source?.trim() || !policy.version?.trim() || !utcTimestamp(policy.as_of) ||
      !policy.convention?.trim() || Object.keys(policy.overrides).length > 1000) {
    throw new Error("Expiry policy requires NFO, Asia/Kolkata, HH:mm:ss, verified source/time/version and bounded overrides.");
  }
  for (const [symbol, timestamp] of Object.entries(policy.overrides)) {
    if (!symbol || !utcTimestamp(timestamp)) throw new Error("Invalid exact instrument expiry override.");
  }
}

export function resolveOptionMetadata(inst: Instrument, policy: ExpiryPolicy | null, metadataVersion: string):
  { ok: true; metadata: OptionMetadata } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  if (inst.exchange !== "NFO" || (inst.instrument_type !== "CE" && inst.instrument_type !== "PE")) reasons.push("unsupported_contract_style");
  if (!inst.name?.trim() || !inst.tradingsymbol?.trim() || !Number.isSafeInteger(inst.instrument_token) || inst.instrument_token <= 0 ||
      !Number.isFinite(inst.strike) || inst.strike <= 0 || !Number.isFinite(inst.tick_size) || inst.tick_size <= 0 ||
      !Number.isSafeInteger(inst.lot_size) || inst.lot_size <= 0) reasons.push("invalid_instrument_metadata");
  const explicit = (inst as Instrument & { expiry_timestamp?: string; exercise_style?: string }).expiry_timestamp;
  const style = (inst as Instrument & { exercise_style?: string }).exercise_style;
  if (style !== undefined && style !== "european") reasons.push("unsupported_contract_style");
  let timestamp: string | null = null;
  let source = "";
  if (explicit !== undefined) {
    timestamp = utcTimestamp(explicit);
    source = "instrument_metadata_exact_timestamp";
  } else if (policy?.overrides[inst.tradingsymbol]) {
    timestamp = utcTimestamp(policy.overrides[inst.tradingsymbol]);
    source = `${policy.source} / ${policy.version} / exact instrument override`;
  } else if (validDate(inst.expiry) && policy !== null) {
    timestamp = utcTimestamp(`${inst.expiry}T${policy.local_time}+05:30`);
    source = `${policy.source} / ${policy.version} / date from instrument metadata`;
  } else if (utcTimestamp(inst.expiry)) {
    timestamp = utcTimestamp(inst.expiry);
    source = "instrument_metadata_exact_timestamp";
  }
  if (!validDate(inst.expiry.slice(0, 10))) reasons.push("invalid_expiry_metadata");
  if (!timestamp) reasons.push(validDate(inst.expiry) ? "expiry_time_unverified" : "invalid_expiry_metadata");
  if (reasons.length > 0 || !timestamp) return { ok: false, reasons };
  return { ok: true, metadata: {
    token: inst.instrument_token, tradingsymbol: inst.tradingsymbol, underlying: inst.name.toUpperCase(),
    exchange: inst.exchange, side: inst.instrument_type as "CE" | "PE", strike: inst.strike,
    expiry: inst.expiry.slice(0, 10), expiry_timestamp: timestamp, expiry_source: source,
    timezone: "Asia/Kolkata", style: "european",
    settlement_underlying: INDEX_SPOT_MAP[inst.name.toUpperCase()] ? "official_index_close" : "official_stock_settlement",
    lot_size: inst.lot_size, tick_size: inst.tick_size, metadata_version: metadataVersion,
  } };
}
