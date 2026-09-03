/**
 * Dhan instrument master → Calspread's internal `Instrument` shape.
 *
 * A DHAN SECURITY ID IS NOT A KITE INSTRUMENT TOKEN.
 * They are unrelated identifier spaces that happen to both be integers. Treating
 * them as interchangeable is the central hazard of this file: the same number means
 * a different contract at each broker, so a Dhan-sourced instrument that leaked into
 * a Zerodha session (or a persisted record without broker identity) would silently
 * point at the wrong option. Two things guard against that:
 *
 *   1. `internalToken` is derived from (segment, securityId) via `dhanInternalToken`,
 *      NOT from securityId alone, so distinct segments cannot collide.
 *   2. Every trade already persists its `broker` (see brokers/types.ts), so a stored
 *      token is only ever interpreted alongside the broker that produced it.
 *
 * The reverse lookup (`DhanInstrumentIndex`) is what the feed and order adapter use
 * to get back from an internal token to the (segment, securityId) Dhan needs.
 *
 * CSV PARSING IS HEADER-DRIVEN, NOT POSITIONAL.
 * Dhan has changed the master's column set before. Mapping by column NAME means a
 * new column is harmless; mapping by index would silently shift every field.
 */

import type { Instrument } from "../../kite.js";
import { DHAN_SCRIP_MASTER_FALLBACK_URL, DHAN_SCRIP_MASTER_URL } from "./http.js";
import {
  dhanSegmentFor,
  internalExchangeFor,
  DHAN_CODE_BY_SEGMENT,
  type DhanExchangeSegment,
} from "./segments.js";

/** A Dhan instrument, normalized but retaining its broker-native identity. */
export interface DhanInstrument extends Instrument {
  /** Dhan's own identifier — the ONLY thing Dhan's APIs accept. */
  dhan_security_id: number;
  dhan_segment: DhanExchangeSegment;
  /** The underlying's security id, needed for option-chain calls. */
  dhan_underlying_security_id: number | null;
}

/**
 * Derive a stable internal token from (segment, securityId).
 *
 * Existing hot paths are `Map<number, …>` keyed by an instrument token, so Dhan
 * instruments need a numeric key. Folding the segment code in is what stops an
 * NSE equity and an NSE derivative that share a security id from colliding.
 *
 * The segment occupies the high bits (× 1e9, comfortably above any real security
 * id) so the low part stays readable as the true Dhan id in logs. The result is
 * stable across restarts because it is a pure function of Dhan's own identifiers —
 * essential, since positions adopted at boot are matched by token.
 */
export function dhanInternalToken(segment: DhanExchangeSegment, securityId: number): number {
  const segmentCode = DHAN_CODE_BY_SEGMENT[segment];
  return segmentCode * 1_000_000_000 + securityId;
}

/** Recover (segment, securityId) from an internal token. */
export function dhanIdentityFromToken(
  token: number,
): { segment: DhanExchangeSegment; securityId: number } | null {
  const segmentCode = Math.floor(token / 1_000_000_000);
  const securityId = token % 1_000_000_000;
  const entry = (Object.entries(DHAN_CODE_BY_SEGMENT) as [DhanExchangeSegment, number][]).find(
    ([, code]) => code === segmentCode,
  );
  if (!entry || securityId <= 0) return null;
  return { segment: entry[0], securityId };
}

/**
 * Quote-aware CSV line splitter.
 *
 * Instrument names contain commas ("NIFTY BANK, MONTHLY"), so a naive split
 * corrupts every field after them.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // A doubled quote inside a quoted field is a literal quote.
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

/**
 * Locate a column by any of several accepted header names.
 *
 * Dhan's two masters (plain and "detailed") name some columns differently, and the
 * names have shifted between revisions. Accepting a set of aliases keeps one parser
 * working across both rather than silently producing empty fields.
 */
function columnIndex(header: string[], ...names: string[]): number {
  const normalized = header.map((h) => h.trim().toUpperCase().replace(/[\s_-]+/g, "_"));
  for (const name of names) {
    const want = name.toUpperCase().replace(/[\s_-]+/g, "_");
    const at = normalized.indexOf(want);
    if (at >= 0) return at;
  }
  return -1;
}

/**
 * Normalize Dhan's expiry to the ISO `YYYY-MM-DD` the app uses everywhere.
 *
 * Dhan has used both `YYYY-MM-DD` and `DD/MM/YYYY`, sometimes with a time suffix.
 * An unparseable value yields "" rather than a wrong date — a bad expiry would place
 * an option in the wrong chain, which is worse than omitting it.
 */
export function normalizeDhanExpiry(raw: string): string {
  const value = raw.trim();
  if (value === "" || value.toUpperCase() === "NA") return "";
  const isoLike = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (isoLike) return `${isoLike[1]}-${isoLike[2]}-${isoLike[3]}`;
  const dmy = /^(\d{2})[/-](\d{2})[/-](\d{4})/.exec(value);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return "";
}

/**
 * Map Dhan's instrument classification to Kite's `instrument_type` vocabulary.
 *
 * The Box code branches on "CE"/"PE"/"FUT", so Dhan's own labels are translated
 * rather than passed through — otherwise every downstream comparison would need a
 * broker-specific branch, which is exactly what this integration avoids.
 */
export function normalizeDhanInstrumentType(instrument: string, optionType: string): string {
  const opt = optionType.trim().toUpperCase();
  if (opt === "CE" || opt === "CALL") return "CE";
  if (opt === "PE" || opt === "PUT") return "PE";
  const inst = instrument.trim().toUpperCase();
  if (inst.includes("OPT")) return opt === "" ? "" : opt;
  if (inst.includes("FUT")) return "FUT";
  if (inst === "INDEX" || inst === "INDICES") return "INDEX";
  if (inst === "EQUITY" || inst === "ES") return "EQ";
  return inst;
}

/** Kite-style `segment` string, which some existing filters read. */
function internalSegment(exchange: string, instrumentType: string): string {
  if (exchange === "NFO") return "NFO-OPT";
  if (exchange === "INDICES") return "INDICES";
  if (instrumentType === "FUT") return `${exchange}-FUT`;
  return exchange;
}

/**
 * Parse the Dhan instrument master CSV.
 *
 * Skips rows it cannot make sense of instead of throwing: the master is ~100k rows
 * and one malformed line must not cost the whole universe.
 */
export function parseDhanScripMaster(csv: string): DhanInstrument[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]!);

  const iExch = columnIndex(header, "EXCH_ID", "EXCHANGE", "EXCH");
  const iSegment = columnIndex(header, "SEGMENT", "SEGMENT_NAME");
  const iSecurityId = columnIndex(header, "SECURITY_ID", "SECURITYID");
  const iInstrument = columnIndex(header, "INSTRUMENT", "INSTRUMENT_NAME");
  const iInstrumentType = columnIndex(header, "INSTRUMENT_TYPE", "INSTRUMENTTYPE");
  const iSymbolName = columnIndex(header, "SYMBOL_NAME", "TRADING_SYMBOL", "SEM_TRADING_SYMBOL");
  const iDisplayName = columnIndex(header, "DISPLAY_NAME", "SEM_CUSTOM_SYMBOL");
  const iUnderlying = columnIndex(header, "UNDERLYING_SYMBOL", "SEM_UNDERLYING", "UNDERLYING");
  const iUnderlyingId = columnIndex(header, "UNDERLYING_SECURITY_ID", "SEM_UNDERLYING_SECURITY_ID");
  const iLotSize = columnIndex(header, "LOT_SIZE", "SEM_LOT_UNITS");
  const iExpiry = columnIndex(header, "SM_EXPIRY_DATE", "EXPIRY_DATE", "SEM_EXPIRY_DATE");
  const iStrike = columnIndex(header, "STRIKE_PRICE", "SEM_STRIKE_PRICE");
  const iOptionType = columnIndex(header, "OPTION_TYPE", "SEM_OPTION_TYPE");
  const iTickSize = columnIndex(header, "TICK_SIZE", "SEM_TICK_SIZE");

  // Without a security id nothing can be addressed at Dhan, so bail loudly rather
  // than returning a plausible-looking empty universe.
  if (iSecurityId < 0) {
    throw new Error(
      `[Dhan] instrument master has no SECURITY_ID column (header: ${header.slice(0, 12).join(",")}…).`,
    );
  }

  const out: DhanInstrument[] = [];
  const pick = (cells: string[], at: number): string => (at >= 0 ? (cells[at] ?? "").trim() : "");

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    const securityId = Number(pick(cells, iSecurityId));
    if (!Number.isFinite(securityId) || securityId <= 0) continue;

    const rawSegment = pick(cells, iSegment);
    const rawExch = pick(cells, iExch);
    const instrumentRaw = pick(cells, iInstrument);
    const optionType = pick(cells, iOptionType);
    const instrumentType = normalizeDhanInstrumentType(instrumentRaw, optionType);
    const isIndex = instrumentType === "INDEX" || rawSegment.toUpperCase() === "I";

    // Dhan's SEGMENT column is a short code ("D" derivatives, "E" equity, "I"
    // index); combining it with EXCH_ID is more reliable than either alone.
    const segment = resolveSegment(rawExch, rawSegment, instrumentRaw, isIndex);
    if (!segment) continue;

    const exchange = internalExchangeFor(segment);
    const tradingsymbol = pick(cells, iSymbolName) || pick(cells, iDisplayName);
    if (!tradingsymbol) continue;

    const lotSize = Number(pick(cells, iLotSize));
    const tickSize = Number(pick(cells, iTickSize));
    const strike = Number(pick(cells, iStrike));
    const underlyingId = Number(pick(cells, iUnderlyingId));

    out.push({
      instrument_token: dhanInternalToken(segment, securityId),
      // Kite's `exchange_token` has no Dhan analogue; the security id is the closest
      // honest value and nothing in Calspread keys off it.
      exchange_token: securityId,
      tradingsymbol,
      name: pick(cells, iUnderlying) || pick(cells, iDisplayName) || tradingsymbol,
      last_price: 0,
      expiry: normalizeDhanExpiry(pick(cells, iExpiry)),
      strike: Number.isFinite(strike) && strike > 0 ? strike : 0,
      tick_size: Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0.05,
      lot_size: Number.isFinite(lotSize) && lotSize > 0 ? lotSize : 0,
      instrument_type: instrumentType,
      segment: internalSegment(exchange, instrumentType),
      exchange,
      dhan_security_id: securityId,
      dhan_segment: segment,
      dhan_underlying_security_id:
        Number.isFinite(underlyingId) && underlyingId > 0 ? underlyingId : null,
    });
  }
  return out;
}

/** Combine Dhan's exchange id and segment code into a REST segment name. */
function resolveSegment(
  exch: string,
  segmentCode: string,
  instrument: string,
  isIndex: boolean,
): DhanExchangeSegment | null {
  if (isIndex) return "IDX_I";
  const ex = exch.trim().toUpperCase();
  const seg = segmentCode.trim().toUpperCase();
  const inst = instrument.trim().toUpperCase();
  const derivative = seg === "D" || inst.includes("FUT") || inst.includes("OPT");

  if (ex === "NSE") return derivative ? "NSE_FNO" : seg === "C" ? "NSE_CURRENCY" : "NSE_EQ";
  if (ex === "BSE") return derivative ? "BSE_FNO" : seg === "C" ? "BSE_CURRENCY" : "BSE_EQ";
  if (ex === "MCX") return "MCX_COMM";
  // Fall back to the generic translator for anything already segment-shaped.
  return dhanSegmentFor(ex, isIndex);
}

/**
 * Cached instrument master with a reverse index.
 *
 * Cached because the master is a multi-megabyte CSV that changes once a day; the
 * TTL keeps a long-running process from missing new weekly expiries.
 */
export class DhanInstrumentStore {
  private all: DhanInstrument[] = [];
  private byToken = new Map<number, DhanInstrument>();
  private loadedAt = 0;
  private inFlight: Promise<DhanInstrument[]> | null = null;

  constructor(private ttlMs = 60 * 60 * 1000) {}

  /** Load (or return cached) instruments. Concurrent callers share one fetch. */
  async load(force = false): Promise<DhanInstrument[]> {
    const fresh = Date.now() - this.loadedAt < this.ttlMs && this.all.length > 0;
    if (fresh && !force) return this.all;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.fetchMaster()
      .then((rows) => {
        this.all = rows;
        this.byToken = new Map(rows.map((r) => [r.instrument_token, r]));
        this.loadedAt = Date.now();
        return rows;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async fetchMaster(): Promise<DhanInstrument[]> {
    // The detailed master is preferred (it carries underlying ids); the plain one is
    // a usable fallback so a single bad URL cannot leave Dhan with no universe.
    const urls = [DHAN_SCRIP_MASTER_URL, DHAN_SCRIP_MASTER_FALLBACK_URL];
    let lastErr: unknown = null;
    for (const url of urls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const csv = await res.text();
        const rows = parseDhanScripMaster(csv);
        if (rows.length === 0) throw new Error("parsed zero instruments");
        return rows;
      } catch (err) {
        lastErr = err;
        console.warn(`[Dhan] instrument master ${url} failed:`, err);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(
      `[Dhan] could not load the instrument master: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  }

  get instruments(): DhanInstrument[] {
    return this.all;
  }

  get size(): number {
    return this.all.length;
  }

  get lastLoadedAt(): number | null {
    return this.loadedAt === 0 ? null : this.loadedAt;
  }

  /** Internal token → Dhan instrument. */
  get(token: number): DhanInstrument | undefined {
    return this.byToken.get(token);
  }

  /**
   * Internal token → the (segment, securityId) the feed and order APIs need.
   *
   * Falls back to decoding the token arithmetically when the master has not loaded,
   * so a subscription is not lost just because the CSV is late.
   */
  identify(token: number): { segment: DhanExchangeSegment; securityId: number } | null {
    const known = this.byToken.get(token);
    if (known) return { segment: known.dhan_segment, securityId: known.dhan_security_id };
    return dhanIdentityFromToken(token);
  }

  clear(): void {
    this.all = [];
    this.byToken.clear();
    this.loadedAt = 0;
  }
}
