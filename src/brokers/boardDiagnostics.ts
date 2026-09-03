/**
 * Why a parsed instrument universe becomes the board it becomes.
 *
 * The failure this exists to explain: 200+ real futures parsed correctly, yet the board
 * rendered ONE card. `deriveFnoBoard()` silently drops any futures group whose underlying
 * cannot be matched to a spot instrument — which is correct behaviour, but invisible.
 * With no visibility, "the board has one stock" and "the market is quiet" look identical.
 *
 * So this reports the join, stage by stage, and names the underlyings that were dropped
 * along with the reason. Pure: it takes an instrument list and returns a report, so it is
 * testable without a network or a broker.
 */

import type { Instrument } from "../kite.js";

export interface UnmatchedUnderlying {
  underlying: string;
  futureSymbol: string;
  futureName: string;
  expiry: string;
  reason: "no_spot_equity" | "no_index_mapping" | "empty_underlying";
}

export interface BoardDiagnostics {
  parsedInstruments: number;
  futures: number;
  uniqueFutureUnderlyings: number;
  /** Underlyings that resolved to an NSE equity spot. */
  matchedEquities: number;
  /** Underlyings that resolved to an index spot. */
  matchedIndices: number;
  boardSize: number;
  unmatchedUnderlyings: number;
  /** Capped sample, so the payload stays small. */
  unmatchedSamples: UnmatchedUnderlying[];
  /** Spot instruments available to join against. */
  availableEquities: number;
  availableIndices: number;
}

export interface KnownSymbolCheck {
  symbol: string;
  equityFound: boolean;
  futuresFound: number;
  validExpiries: number;
  validLotSizes: number;
  canonicalUnderlyingMatches: boolean;
  onBoard: boolean;
  /** The first failing stage, or null when the symbol is fully healthy. */
  failsAt: string | null;
}

/**
 * Reproduce `deriveFnoBoard`'s join and report each stage.
 *
 * Deliberately mirrors the real function's predicates rather than sharing code: if the
 * two ever drift, this report becomes wrong in a way that is worse than useless. The
 * predicates are simple enough that duplication is the safer trade, and the tests pin
 * both against the same fixtures.
 */
export function diagnoseBoard(
  all: Instrument[],
  indexSpotMap: Record<string, string>,
): BoardDiagnostics {
  const futuresByUnderlying = new Map<string, Instrument[]>();
  const eqBySymbol = new Map<string, Instrument>();
  const indexBySymbol = new Map<string, Instrument>();

  for (const i of all) {
    if (i.exchange === "NFO" && i.instrument_type === "FUT" && i.name) {
      const arr = futuresByUnderlying.get(i.name) ?? [];
      arr.push(i);
      futuresByUnderlying.set(i.name, arr);
    } else if (i.segment === "INDICES") {
      indexBySymbol.set(i.tradingsymbol, i);
    } else if (i.exchange === "NSE" && i.instrument_type === "EQ") {
      eqBySymbol.set(i.tradingsymbol, i);
    }
  }

  // Futures with NO underlying at all never even reach the grouping, so they are counted
  // separately — otherwise they would silently vanish from every total.
  const emptyUnderlying = all.filter(
    (i) => i.exchange === "NFO" && i.instrument_type === "FUT" && !i.name,
  );

  let matchedEquities = 0;
  let matchedIndices = 0;
  const unmatched: UnmatchedUnderlying[] = [];

  for (const [underlying, futs] of futuresByUnderlying) {
    if (eqBySymbol.has(underlying)) {
      matchedEquities++;
      continue;
    }
    const indexSymbol = indexSpotMap[underlying];
    if (indexSymbol && indexBySymbol.has(indexSymbol)) {
      matchedIndices++;
      continue;
    }
    const sample = futs[0]!;
    unmatched.push({
      underlying,
      futureSymbol: sample.tradingsymbol,
      futureName: sample.name,
      expiry: sample.expiry,
      // Distinguishing these matters: a missing equity means the underlying join is
      // broken, whereas a missing index mapping is a known, small, fixable list.
      reason: indexSymbol ? "no_index_mapping" : "no_spot_equity",
    });
  }

  for (const fut of emptyUnderlying.slice(0, 10)) {
    unmatched.push({
      underlying: "",
      futureSymbol: fut.tradingsymbol,
      futureName: fut.name,
      expiry: fut.expiry,
      reason: "empty_underlying",
    });
  }

  return {
    parsedInstruments: all.length,
    futures: all.filter((i) => i.exchange === "NFO" && i.instrument_type === "FUT").length,
    uniqueFutureUnderlyings: futuresByUnderlying.size,
    matchedEquities,
    matchedIndices,
    boardSize: matchedEquities + matchedIndices,
    unmatchedUnderlyings: unmatched.length,
    unmatchedSamples: unmatched.slice(0, 30),
    availableEquities: eqBySymbol.size,
    availableIndices: indexBySymbol.size,
  };
}

/**
 * Stage-by-stage check for underlyings that are definitely in NSE F&O.
 *
 * `failsAt` names the FIRST broken stage, which is the whole point: "BHEL is missing" is
 * not actionable, whereas "BHEL's equity row exists and 3 futures exist but the canonical
 * underlying does not match" points straight at the join.
 */
export function checkKnownSymbols(
  all: Instrument[],
  symbols: string[] = ["BHEL", "RELIANCE", "HDFCBANK", "SBIN", "TCS", "INFY", "ICICIBANK", "AXISBANK", "BHARTIARTL"],
): KnownSymbolCheck[] {
  const eqBySymbol = new Map<string, Instrument>();
  const futuresByUnderlying = new Map<string, Instrument[]>();
  for (const i of all) {
    if (i.exchange === "NSE" && i.instrument_type === "EQ") eqBySymbol.set(i.tradingsymbol, i);
    if (i.exchange === "NFO" && i.instrument_type === "FUT" && i.name) {
      const arr = futuresByUnderlying.get(i.name) ?? [];
      arr.push(i);
      futuresByUnderlying.set(i.name, arr);
    }
  }

  return symbols.map((symbol) => {
    const equity = eqBySymbol.get(symbol);
    const futures = futuresByUnderlying.get(symbol) ?? [];
    const validExpiries = futures.filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.expiry)).length;
    const validLotSizes = futures.filter((f) => f.lot_size > 0).length;
    // The join the board actually performs.
    const canonicalMatches = futures.length > 0 && equity !== undefined;
    const onBoard = canonicalMatches && validExpiries > 0 && validLotSizes > 0;

    let failsAt: string | null = null;
    if (!equity) failsAt = "no NSE equity row with this trading symbol";
    else if (futures.length === 0) failsAt = "no NFO future whose canonical underlying is this symbol";
    else if (validExpiries === 0) failsAt = "futures exist but none has a valid YYYY-MM-DD expiry";
    else if (validLotSizes === 0) failsAt = "futures exist but none has a positive lot size";

    return {
      symbol,
      equityFound: equity !== undefined,
      futuresFound: futures.length,
      validExpiries,
      validLotSizes,
      canonicalUnderlyingMatches: canonicalMatches,
      onBoard,
      failsAt,
    };
  });
}
