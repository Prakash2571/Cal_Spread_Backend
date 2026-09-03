/**
 * Resolving an index F&O underlying to its SPOT instrument, across brokers.
 *
 * THE BUG THIS FIXES
 * Index F&O silently vanished from the board (204 rows, all stocks, `indexRowsInBoard:
 * []`) and the option-chain page answered `No spot instrument for "NIFTY"`. Both did the
 * same lookup:
 *
 *     all.find(i => i.segment === "INDICES" && i.tradingsymbol === INDEX_SPOT_MAP[u])
 *
 * `INDEX_SPOT_MAP` maps `"NIFTY" -> "NIFTY 50"`, and `"NIFTY 50"` is ZERODHA's trading
 * symbol for that index. Dhan calls it plain `"NIFTY"`. Confirmed from the live
 * instrument master rather than assumed — of 190 index instruments Dhan publishes:
 *
 *     "NIFTY", "BANKNIFTY", "FINNIFTY", "NIFTY 100", "NIFTY 200", "NIFTY 500",
 *     "NIFTY AUTO", "NIFTY FMCG", "NIFTYIT", "INDIA VIX", ...
 *
 * and every mapped name resolved `spotFound: false`. So the futures side was fine (all
 * five underlyings reported `hasFutures: true`) and only the SPOT join failed.
 *
 * WHY CANDIDATES, IN THIS ORDER
 * The curated map is tried FIRST so Zerodha behaviour is bit-for-bit unchanged — no
 * regression risk on the broker that was working. Only when the curated name is absent
 * does the underlying symbol itself get tried, which is Dhan's convention. Neither
 * broker is special-cased and nothing is guessed: a candidate is accepted only if it
 * actually exists in the loaded universe.
 *
 * THE MAP STILL GATES WHICH UNDERLYINGS ARE INDICES.
 * Resolution returns null for anything not in `INDEX_SPOT_MAP`, so an ordinary equity
 * underlying can never be matched against an index instrument that happens to share its
 * name. Widening that gate is the one change here that would be unsafe.
 */

/**
 * Index F&O underlying -> the index's spot trading symbol, in ZERODHA's naming.
 *
 * Also the allow-list of index underlyings the board will show, which is why it stays a
 * curated map rather than a broker-neutral heuristic.
 */
export const INDEX_SPOT_MAP: Record<string, string> = {
  NIFTY: "NIFTY 50",
  BANKNIFTY: "NIFTY BANK",
  FINNIFTY: "NIFTY FIN SERVICE",
  MIDCPNIFTY: "NIFTY MID SELECT",
  NIFTYNXT50: "NIFTY NEXT 50",
};

/**
 * Spot trading symbols to try for an index underlying, best first.
 *
 * Empty for a non-index underlying, which is what preserves the allow-list gate.
 */
export function indexSpotCandidates(
  underlying: string,
  indexSpotMap: Record<string, string> = INDEX_SPOT_MAP,
): string[] {
  const mapped = indexSpotMap[underlying];
  if (!mapped) return [];
  // Deduplicated, in case a broker's own name equals the curated one.
  return [...new Set([mapped, underlying])];
}

/**
 * The spot trading symbol for an index underlying, or null.
 *
 * `hasSpot` is injected so this stays pure and independent of how the caller indexes the
 * universe (a Map, a find over an array, a diagnostics stub).
 */
export function resolveIndexSpotSymbol(
  underlying: string,
  hasSpot: (tradingsymbol: string) => boolean,
  indexSpotMap: Record<string, string> = INDEX_SPOT_MAP,
): string | null {
  for (const candidate of indexSpotCandidates(underlying, indexSpotMap)) {
    if (hasSpot(candidate)) return candidate;
  }
  return null;
}
