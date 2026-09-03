/**
 * Exchange-segment translation between Calspread's internal vocabulary and Dhan's.
 *
 * WHY THIS IS ITS OWN MODULE
 * Calspread speaks Zerodha's dialect throughout: an instrument lives on "NSE" or
 * "NFO", and an identifier is `EXCHANGE:TRADINGSYMBOL`. Dhan uses a different axis
 * entirely — a named SEGMENT (`NSE_EQ`, `NSE_FNO`, `IDX_I`) in REST payloads and a
 * small integer for the same thing in binary feed packets.
 *
 * Getting this wrong is silent and expensive: `NSE_EQ` where `NSE_FNO` belongs does
 * not error, it simply returns nothing (or the wrong instrument), so the mapping is
 * centralised here with the numeric codes and the string names defined side by side.
 */

/** Dhan's REST segment names. */
export type DhanExchangeSegment =
  | "IDX_I"
  | "NSE_EQ"
  | "NSE_FNO"
  | "NSE_CURRENCY"
  | "BSE_EQ"
  | "BSE_FNO"
  | "BSE_CURRENCY"
  | "MCX_COMM";

/**
 * Segment code → name, as used in the BINARY feed header's byte 3.
 *
 * The feed identifies an instrument by (segment code, security id), so decoding a
 * packet without this table cannot tell an NSE equity from an NSE derivative that
 * happens to share a security id.
 */
export const DHAN_SEGMENT_BY_CODE: Readonly<Record<number, DhanExchangeSegment>> = {
  0: "IDX_I",
  1: "NSE_EQ",
  2: "NSE_FNO",
  3: "NSE_CURRENCY",
  4: "BSE_EQ",
  5: "MCX_COMM",
  7: "BSE_CURRENCY",
  8: "BSE_FNO",
};

/** Name → binary segment code (the inverse of DHAN_SEGMENT_BY_CODE). */
export const DHAN_CODE_BY_SEGMENT: Readonly<Record<DhanExchangeSegment, number>> = {
  IDX_I: 0,
  NSE_EQ: 1,
  NSE_FNO: 2,
  NSE_CURRENCY: 3,
  BSE_EQ: 4,
  MCX_COMM: 5,
  BSE_CURRENCY: 7,
  BSE_FNO: 8,
};

export function dhanSegmentFromCode(code: number): DhanExchangeSegment | null {
  return DHAN_SEGMENT_BY_CODE[code] ?? null;
}

/**
 * Internal exchange → Dhan segment.
 *
 * The Box strategy only ever trades NSE equity derivatives, so `NFO → NSE_FNO` is
 * the mapping that matters; the rest exist so quote/history lookups for spot and
 * index underlyings resolve correctly.
 *
 * Returns null for anything unrecognised rather than guessing a segment — a wrong
 * segment silently returns the wrong instrument, which is far worse than an error.
 */
export function dhanSegmentFor(exchange: string, isIndex = false): DhanExchangeSegment | null {
  const ex = exchange.trim().toUpperCase();
  // An index has no tradable segment of its own: Dhan groups every index under IDX_I
  // regardless of which exchange computes it.
  if (isIndex || ex === "INDICES" || ex === "IDX_I" || ex === "IDX") return "IDX_I";
  switch (ex) {
    case "NSE":
    case "NSE_EQ":
      return "NSE_EQ";
    case "NFO":
    case "NSE_FNO":
      return "NSE_FNO";
    case "CDS":
    case "NSE_CURRENCY":
      return "NSE_CURRENCY";
    case "BSE":
    case "BSE_EQ":
      return "BSE_EQ";
    case "BFO":
    case "BSE_FNO":
      return "BSE_FNO";
    case "BCD":
    case "BSE_CURRENCY":
      return "BSE_CURRENCY";
    case "MCX":
    case "MCX_COMM":
      return "MCX_COMM";
    default:
      return null;
  }
}

/**
 * Dhan segment → the internal exchange label Calspread stores on instruments.
 *
 * Deliberately produces Zerodha-style labels ("NFO", "NSE") so a Dhan instrument is
 * structurally indistinguishable from a Kite one everywhere downstream — the whole
 * reason the Box engine does not need to know which broker is active.
 */
export function internalExchangeFor(segment: DhanExchangeSegment): string {
  switch (segment) {
    case "NSE_EQ":
      return "NSE";
    case "NSE_FNO":
      return "NFO";
    case "NSE_CURRENCY":
      return "CDS";
    case "BSE_EQ":
      return "BSE";
    case "BSE_FNO":
      return "BFO";
    case "BSE_CURRENCY":
      return "BCD";
    case "MCX_COMM":
      return "MCX";
    case "IDX_I":
      return "INDICES";
  }
}
