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
  if (exchange === "INDICES") return "INDICES";
  // Kite distinguishes "NFO-FUT" from "NFO-OPT", and this value is meant to be
  // Kite-shaped. Labelling every derivative "NFO-OPT" made futures indistinguishable
  // from options to any filter that reads `segment` — a landmine even though today's
  // callers happen to key off `instrument_type` instead.
  if (instrumentType === "FUT") return `${exchange}-FUT`;
  if (exchange === "NFO" || exchange === "BFO") return `${exchange}-OPT`;
  return exchange;
}

/**
 * Parse the Dhan instrument master CSV.
 *
 * Skips rows it cannot make sense of instead of throwing: the master is ~100k rows
 * and one malformed line must not cost the whole universe.
 */
/**
 * Exchange TEST/dummy scrips, which are present in the live master.
 *
 * NSE publishes test series (`01INSETEST` … `14INSETEST`) with far-future expiries.
 * They parse perfectly and look like ordinary futures, so without this filter they
 * populate the board with ~20 fake underlyings and crowd out the real ones — which is
 * exactly what happened.
 */
const TEST_SYMBOL = /(?:INSETEST|TESTSCRIP|DUMMY|^TEST)/i;

/** A future expiring further out than this is not a real tradable contract. */
const MAX_FUTURE_EXPIRY_DAYS = 400;

/**
 * What the last parse actually saw.
 *
 * Exposed because Dhan's column names are not something to keep guessing at: when the
 * board looks wrong, this says which columns were FOUND, which were missing, and what a
 * parsed row looks like. That turns "the board is empty" into a five-second diagnosis.
 */
export interface DhanParseReport {
  header: string[];
  columns: Record<string, number>;
  missingColumns: string[];
  totalRows: number;
  parsed: number;
  skippedTest: number;
  skippedNoSecurityId: number;
  skippedNoSymbol: number;
  skippedSegment: number;
  skippedImplausibleExpiry: number;
  byExchange: Record<string, number>;
  byInstrumentType: Record<string, number>;
  fnoFutures: number;
  nfoCalls: number;
  nfoPuts: number;
  nseEquities: number;
  indices: number;
  distinctFutureUnderlyings: number;
  underlyingResolution: {
    byForeignKey: number;
    bySymbolColumn: number;
    byStrip: number;
    unresolved: number;
  };
  samples: { tradingsymbol: string; name: string; exchange: string; instrument_type: string; expiry: string; token: number; securityId: number }[];
}

let lastParseReport: DhanParseReport | null = null;

/** The most recent instrument-master parse report, for diagnostics. */
export function getDhanParseReport(): DhanParseReport | null {
  return lastParseReport;
}

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

  const columns = {
    EXCH_ID: iExch, SEGMENT: iSegment, SECURITY_ID: iSecurityId, INSTRUMENT: iInstrument,
    INSTRUMENT_TYPE: iInstrumentType, SYMBOL_NAME: iSymbolName, DISPLAY_NAME: iDisplayName,
    UNDERLYING_SYMBOL: iUnderlying, UNDERLYING_SECURITY_ID: iUnderlyingId, LOT_SIZE: iLotSize,
    EXPIRY_DATE: iExpiry, STRIKE_PRICE: iStrike, OPTION_TYPE: iOptionType, TICK_SIZE: iTickSize,
  };
  const report: DhanParseReport = {
    header,
    columns,
    missingColumns: Object.entries(columns).filter(([, v]) => v < 0).map(([k]) => k),
    totalRows: lines.length - 1,
    parsed: 0, skippedTest: 0, skippedNoSecurityId: 0, skippedNoSymbol: 0,
    skippedSegment: 0, skippedImplausibleExpiry: 0,
    byExchange: {}, byInstrumentType: {}, fnoFutures: 0,
    nfoCalls: 0, nfoPuts: 0, nseEquities: 0, indices: 0,
    distinctFutureUnderlyings: 0,
    underlyingResolution: { byForeignKey: 0, bySymbolColumn: 0, byStrip: 0, unresolved: 0 },
    samples: [],
  };
  const now = Date.now();

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    const securityId = Number(pick(cells, iSecurityId));
    if (!Number.isFinite(securityId) || securityId <= 0) {
      report.skippedNoSecurityId++;
      continue;
    }

    const rawSegment = pick(cells, iSegment);
    const rawExch = pick(cells, iExch);
    const instrumentRaw = pick(cells, iInstrument);
    const optionType = pick(cells, iOptionType);
    const instrumentType = normalizeDhanInstrumentType(instrumentRaw, optionType);
    const isIndex = instrumentType === "INDEX" || rawSegment.toUpperCase() === "I";

    // Dhan's SEGMENT column is a short code ("D" derivatives, "E" equity, "I"
    // index); combining it with EXCH_ID is more reliable than either alone.
    const segment = resolveSegment(rawExch, rawSegment, instrumentRaw, isIndex);
    if (!segment) {
      report.skippedSegment++;
      continue;
    }

    const exchange = internalExchangeFor(segment);
    const tradingsymbol = pick(cells, iSymbolName) || pick(cells, iDisplayName);
    if (!tradingsymbol) {
      report.skippedNoSymbol++;
      continue;
    }

    const underlyingName = pick(cells, iUnderlying);
    // Exchange TEST series parse cleanly and look like real futures, so they must be
    // excluded explicitly or they populate the board with fake underlyings.
    if (TEST_SYMBOL.test(tradingsymbol) || TEST_SYMBOL.test(underlyingName)) {
      report.skippedTest++;
      continue;
    }

    const expiryIso = normalizeDhanExpiry(pick(cells, iExpiry));
    // A derivative expiring years out is a test/long-dated artefact, not something the
    // calendar or box strategies can trade.
    if (expiryIso !== "" && instrumentType !== "EQ" && instrumentType !== "INDEX") {
      const expiryMs = Date.parse(`${expiryIso}T00:00:00+05:30`);
      if (Number.isFinite(expiryMs) && expiryMs - now > MAX_FUTURE_EXPIRY_DAYS * 86_400_000) {
        report.skippedImplausibleExpiry++;
        continue;
      }
    }

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
      name: underlyingName || pick(cells, iDisplayName) || tradingsymbol,
      last_price: 0,
      expiry: expiryIso,
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

    report.parsed++;
    report.byExchange[exchange] = (report.byExchange[exchange] ?? 0) + 1;
    report.byInstrumentType[instrumentType] = (report.byInstrumentType[instrumentType] ?? 0) + 1;
    if (exchange === "NFO" && instrumentType === "CE") report.nfoCalls++;
    if (exchange === "NFO" && instrumentType === "PE") report.nfoPuts++;
    if (exchange === "NSE" && instrumentType === "EQ") report.nseEquities++;
    if (instrumentType === "INDEX") report.indices++;
    if (exchange === "NFO" && instrumentType === "FUT") {
      report.fnoFutures++;
      // Sample real F&O futures specifically: they are what the calendar board needs,
      // so they are the rows worth eyeballing when the board looks wrong.
      if (report.samples.length < 8) {
        const last = out[out.length - 1]!;
        report.samples.push({
          tradingsymbol: last.tradingsymbol,
          name: last.name,
          exchange: last.exchange,
          instrument_type: last.instrument_type,
          expiry: last.expiry,
          token: last.instrument_token,
          securityId: last.dhan_security_id,
        });
      }
    }
  }

  // ---------------- SECOND PASS: canonical underlying resolution ----------------
  //
  // Done as a second pass because a derivative's underlying spot row may appear ANYWHERE
  // in the file, including after it. Resolving during the first pass would depend on file
  // ordering, which is not something to rely on.
  //
  // NOTE ON THE TWO JOIN CONVENTIONS. The board resolves an equity underlying and an
  // index underlying DIFFERENTLY, and conflating them breaks one or the other:
  //
  //   equity: futures.name must equal the EQUITY'S TRADING SYMBOL ("BHEL"), because
  //           the board looks it up with eqBySymbol.get(name).
  //   index:  futures.name must equal the DERIVATIVE UNDERLYING SYMBOL ("NIFTY"), NOT
  //           the index spot's trading symbol ("NIFTY 50"), because the board looks it
  //           up with INDEX_SPOT_MAP[name] — a map keyed by "NIFTY" that RETURNS
  //           "NIFTY 50".
  //
  // So the foreign key is followed to the spot row only to read an EQUITY's symbol.
  // For an index it is used solely to confirm the underlying IS an index; the name then
  // comes from the underlying-symbol column (or the stripped contract symbol), both of
  // which yield "NIFTY". Resolving an index future to "NIFTY 50" would silently drop
  // every index from the board.
  const spotBySecurityId = new Map<number, { symbol: string; isIndex: boolean }>();
  const equitySpotSymbols = new Set<string>();
  for (const inst of out) {
    const isIndexSpot = inst.instrument_type === "INDEX";
    if (inst.instrument_type === "EQ" || isIndexSpot) {
      spotBySecurityId.set(inst.dhan_security_id, {
        symbol: normalizeUnderlyingKey(inst.tradingsymbol),
        isIndex: isIndexSpot,
      });
      if (!isIndexSpot) equitySpotSymbols.add(normalizeUnderlyingKey(inst.tradingsymbol));
    }
  }

  let resolvedByForeignKey = 0;
  let resolvedBySymbolColumn = 0;
  let resolvedByStrip = 0;
  let unresolvedUnderlying = 0;

  for (const inst of out) {
    const isDerivative =
      inst.instrument_type === "FUT" || inst.instrument_type === "CE" || inst.instrument_type === "PE";
    if (!isDerivative) continue;

    const declared = normalizeUnderlyingKey(inst.name);
    const stripped = stripContractSuffix(inst.tradingsymbol);
    const spot =
      inst.dhan_underlying_security_id !== null
        ? spotBySecurityId.get(inst.dhan_underlying_security_id)
        : undefined;

    // 1. The numeric foreign key into an EQUITY row — immune to column renames and to
    //    display formatting, and it yields exactly the symbol the board joins on.
    if (spot && !spot.isIndex) {
      inst.name = spot.symbol;
      resolvedByForeignKey++;
      continue;
    }
    // 1b. The foreign key points at an INDEX. The board needs the underlying symbol
    //     here, not the index's trading symbol, so take the declared/stripped form.
    if (spot?.isIndex) {
      const indexUnderlying = declared !== "" ? declared : stripped;
      if (indexUnderlying !== "") {
        inst.name = indexUnderlying;
        resolvedByForeignKey++;
        continue;
      }
    }
    // 2. The underlying-symbol column, when it named something we recognise as a spot.
    if (declared !== "" && equitySpotSymbols.has(declared)) {
      inst.name = declared;
      resolvedBySymbolColumn++;
      continue;
    }
    // 3. Strip the contract suffix off the symbol. Accepted only if it lands on a real
    //    spot, so a mangled guess cannot invent an underlying.
    if (stripped !== "" && equitySpotSymbols.has(stripped)) {
      inst.name = stripped;
      resolvedByStrip++;
      continue;
    }
    // Keep whatever the master declared, so an index underlying whose spot row is
    // missing entirely still groups together and can be matched downstream.
    inst.name = declared !== "" ? declared : stripped;
    if (inst.name === "") unresolvedUnderlying++;
  }

  report.underlyingResolution = {
    byForeignKey: resolvedByForeignKey,
    bySymbolColumn: resolvedBySymbolColumn,
    byStrip: resolvedByStrip,
    unresolved: unresolvedUnderlying,
  };
  report.distinctFutureUnderlyings = new Set(
    out.filter((i) => i.instrument_type === "FUT").map((i) => i.name).filter(Boolean),
  ).size;

  lastParseReport = report;
  console.log(
    `[Dhan] instrument master parsed: ${report.parsed}/${report.totalRows} rows, ` +
      `${report.fnoFutures} NFO futures, skipped ${report.skippedTest} test / ` +
      `${report.skippedImplausibleExpiry} long-dated / ${report.skippedSegment} unknown-segment / ` +
      `${report.skippedNoSymbol} no-symbol.`,
  );
  if (report.missingColumns.length > 0) {
    // Loud, because a missing column is why a field silently reads empty.
    console.warn(
      `[Dhan] instrument master is MISSING expected columns: ${report.missingColumns.join(", ")}. ` +
        `Header was: ${header.slice(0, 20).join(",")}`,
    );
  }
  console.log(
    `[Dhan] underlying resolution: ${resolvedByForeignKey} by foreign key, ` +
      `${resolvedBySymbolColumn} by symbol column, ${resolvedByStrip} by suffix strip, ` +
      `${unresolvedUnderlying} unresolved; ${report.distinctFutureUnderlyings} distinct ` +
      `futures underlyings.`,
  );
  if (report.distinctFutureUnderlyings < 50) {
    console.error(
      `[Dhan] ONLY ${report.distinctFutureUnderlyings} distinct futures underlyings resolved ` +
        `(expected 180+). The board will be almost empty. This is an underlying-JOIN failure, ` +
        `not a market condition — inspect GET /api/dhan/instruments/diagnostics.`,
    );
  }
  if (report.fnoFutures < 100) {
    // The real F&O universe is ~200 underlyings x 3 expiries. Far fewer means the
    // classification is wrong, not that the market is quiet.
    console.error(
      `[Dhan] ONLY ${report.fnoFutures} NFO futures were classified (expected 500+) — the master ` +
        `layout has probably changed. Board and scanner will be incomplete. ` +
        `Inspect GET /api/dhan/instruments/diagnostics.`,
    );
  }
  return out;
}

/**
 * The canonical underlying symbol of an instrument — the board's join key.
 *
 * THIS IS THE ROOT CAUSE OF THE ONE-STOCK BOARD.
 *
 * `deriveFnoBoard()` groups futures by `instrument.name` and then joins to a spot with
 * `eqBySymbol.get(name)`, keyed on the equity's TRADING SYMBOL. That works for Kite,
 * where an NFO future's `name` is exactly the underlying symbol ("BHEL"). It is a Kite
 * naming convention, and Dhan does not follow it: if the underlying-symbol column is
 * absent or named differently, `name` fell back to the DISPLAY name — something like
 * "BHEL 25 SEP FUT" — which can never equal an equity trading symbol. Every future
 * whose display name did not happen to be a bare symbol therefore matched nothing and
 * was silently dropped, collapsing 200+ underlyings to the handful that coincidentally
 * did match.
 *
 * So the underlying is resolved by three mechanisms, strongest first:
 *
 *   1. `UNDERLYING_SECURITY_ID` → the spot row's own trading symbol. A NUMERIC FOREIGN
 *      KEY, so it is immune to column renames and display-name formatting. This is the
 *      reliable join and the reason the fix does not depend on guessing a column name.
 *   2. `UNDERLYING_SYMBOL`, when the master supplies it.
 *   3. The contract symbol with its expiry/instrument suffix stripped — a last resort,
 *      used only so a partially-formed master still yields a usable board.
 */
export function stripContractSuffix(tradingsymbol: string): string {
  // Dhan contract symbols take shapes like "BHEL-Sep2026-FUT", "BHEL26SEPFUT",
  // "BHEL 25 SEP FUT", "BHEL 300 CE", "RELIANCE-Sep2026-2500-PE".
  const MONTH = "JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC";
  const upper = tradingsymbol.trim().toUpperCase();

  // STAGE 1 — drop trailing contract components as WHOLE TOKENS.
  //
  // Token-wise is essential, because a substring rule silently corrupts real symbols:
  // an unconditional `(FUT|CE|PE)$` strip turns RELIANCE into RELIAN, since RELIANCE
  // genuinely ends in "CE". Only ever discarding a complete token makes that impossible.
  // Splitting on "-" also decomposes an ISO expiry into numeric tokens, which the
  // numeric rule then drops for free.
  const tokens = upper.split(/[\s_\-]+/).filter((t) => t !== "");
  const contractToken = new RegExp(
    `^(?:FUT|CE|PE|\\d+(?:\\.\\d+)?|(?:${MONTH})\\d{0,4}|\\d{2,4}(?:${MONTH}))$`,
  );
  let end = tokens.length;
  // Never consume the last token: something must remain to be the underlying.
  while (end > 1 && contractToken.test(tokens[end - 1]!)) end--;
  // Rejoin with "-" so genuinely hyphenated underlyings ("BAJAJ-AUTO") survive.
  let value = tokens.slice(0, end).join("-");

  // STAGE 2 — the same components may be CONCATENATED into a single token
  // ("BHEL26SEPFUT"), where there is no separator to split on. Peel them off, but only
  // where a digit or a month name marks the boundary, which is what keeps RELIANCE safe.
  const inToken: RegExp[] = [
    new RegExp(`(?<=\\d|${MONTH})(?:FUT|CE|PE)$`), // instrument suffix
    new RegExp(`(?<=[A-Z0-9])(?:${MONTH})$`), // month
    /(?<=[A-Z])\d{2,8}(?:\.\d+)?$/, // strike or 2-4 digit expiry
  ];
  // Bounded: a contract symbol has only a handful of components, and an unbounded loop
  // over adversarial input is not a risk worth taking.
  for (let pass = 0; pass < 8; pass++) {
    const before = value;
    for (const re of inToken) value = value.replace(re, "");
    if (value === before) break;
  }
  return value.replace(/[-\s]+$/, "");
}

/** Normalize an underlying symbol for use as a join key. */
export function normalizeUnderlyingKey(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, " ");
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
