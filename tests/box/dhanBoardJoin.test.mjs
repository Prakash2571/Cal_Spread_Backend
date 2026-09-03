/**
 * The one-stock board: futures parse, but the underlying JOIN fails.
 *
 * `deriveFnoBoard()` groups futures by `instrument.name` and joins to a spot with
 * `eqBySymbol.get(name)` — keyed on the equity's TRADING SYMBOL. That is a KITE naming
 * convention: on Kite, an NFO future's `name` is exactly "BHEL". Dhan does not follow it,
 * so when the underlying-symbol column is absent or renamed, `name` fell back to the
 * display name ("BHEL 25 SEP FUT"), matched no equity, and the whole group was silently
 * dropped. 200+ underlyings collapsed to the few whose display name happened to be a
 * bare symbol — which is exactly the BHEL-only board that was observed.
 *
 * The fix resolves the underlying from `UNDERLYING_SECURITY_ID`, a numeric foreign key
 * that is immune to column renames and display formatting. These tests pin that.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseDhanScripMaster,
  getDhanParseReport,
  stripContractSuffix,
  normalizeUnderlyingKey,
  dhanInternalToken,
} from "../../dist/brokers/dhan/instruments.js";
import { diagnoseBoard, checkKnownSymbols } from "../../dist/brokers/boardDiagnostics.js";

/** Five real F&O names, three expiries each, plus their equity rows. */
const FNO = [
  { sym: "BHEL", eqId: 438, futBase: 50000 },
  { sym: "RELIANCE", eqId: 2885, futBase: 51000 },
  { sym: "HDFCBANK", eqId: 1333, futBase: 52000 },
  { sym: "SBIN", eqId: 3045, futBase: 53000 },
  { sym: "TCS", eqId: 11536, futBase: 54000 },
];

/**
 * Expiries are derived from the CURRENT date, not hard-coded.
 *
 * The parser drops any derivative expiring more than MAX_FUTURE_EXPIRY_DAYS out, so a
 * fixture with fixed dates silently changes meaning as real time passes — eventually
 * testing the long-dated filter instead of the join. Relative dates keep these rows
 * permanently in the "plausible near expiry" band the board actually consumes.
 */
function isoDaysFromNow(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

const EXPIRIES = [isoDaysFromNow(20), isoDaysFromNow(48), isoDaysFromNow(76)];
/** Comfortably past the 400-day plausibility cutoff. */
const FAR_EXPIRY = isoDaysFromNow(3700);
/** Within the cutoff, so a row is rejected on its own merits and not for its date. */
const NEAR_EXPIRY = EXPIRIES[0];

/**
 * A master whose derivative rows carry a DISPLAY-style symbol and NO usable
 * underlying-symbol text — the shape that produced the one-stock board. Only the numeric
 * UNDERLYING_SECURITY_ID connects a future to its spot.
 */
function masterWithDisplayNames() {
  const rows = [
    "EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,DISPLAY_NAME,UNDERLYING_SYMBOL,UNDERLYING_SECURITY_ID,LOT_SIZE,SM_EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE,TICK_SIZE",
  ];
  for (const { sym, eqId } of FNO) {
    rows.push(`NSE,E,${eqId},EQUITY,${sym},${sym} LTD,${sym},${eqId},1,,0,,0.05`);
  }
  for (const { sym, eqId, futBase } of FNO) {
    EXPIRIES.forEach((expiry, i) => {
      const label = expiry.slice(0, 7);
      // SYMBOL_NAME is display-shaped and UNDERLYING_SYMBOL is EMPTY: the exact
      // condition under which symbol-based joining fails.
      rows.push(
        `NSE,D,${futBase + i},FUTSTK,${sym} ${label} FUT,${sym} ${label} FUT,,${eqId},250,${expiry},0,,0.05`,
      );
    });
  }
  return rows.join("\n");
}

/* ------------------------------- suffix strip ------------------------------ */

test("contract suffixes strip back to the bare underlying", () => {
  // "BHEL-SEP2026-FUT" is the case a single greedy regex gets WRONG: an optional strike
  // group matches "2026-FUT" and leaves "BHEL-SEP" behind.
  assert.equal(stripContractSuffix("BHEL-Sep2026-FUT"), "BHEL");
  assert.equal(stripContractSuffix("BHEL-SEP26-FUT"), "BHEL");
  assert.equal(stripContractSuffix("BHEL26SEPFUT"), "BHEL");
  assert.equal(stripContractSuffix("RELIANCE 2026-09-29 FUT"), "RELIANCE");
  assert.equal(stripContractSuffix("NIFTY 25 SEP FUT"), "NIFTY");
  assert.equal(stripContractSuffix("SBIN"), "SBIN", "a bare symbol is unchanged");
});

test("real NSE symbols are never corrupted by suffix stripping", () => {
  // A wrong underlying is worse than an unresolved one: it silently attaches contracts
  // to the wrong stock. RELIANCE is the canary — it genuinely ends in "CE".
  for (const symbol of [
    "RELIANCE",
    "BAJAJ-AUTO",
    "M&M",
    "L&TFH",
    "TATASTEEL",
    "IDEA",
    "BHEL",
    "SBIN",
    "HDFCBANK",
  ]) {
    assert.equal(stripContractSuffix(symbol), symbol, `${symbol} must survive unchanged`);
  }
});

test("hyphenated underlyings survive contract stripping", () => {
  assert.equal(stripContractSuffix("BAJAJ-AUTO-Sep2026-FUT"), "BAJAJ-AUTO");
  assert.equal(stripContractSuffix("BAJAJ-AUTO 2500 CE"), "BAJAJ-AUTO");
});

test("option contract suffixes strip the strike as well", () => {
  assert.equal(stripContractSuffix("BHEL 300 CE"), "BHEL");
  assert.equal(stripContractSuffix("RELIANCE-Sep2026-2500-PE"), "RELIANCE");
  assert.equal(stripContractSuffix("HDFCBANK26SEP1650CE"), "HDFCBANK");
  assert.equal(stripContractSuffix("BHEL300.5CE"), "BHEL", "fractional strikes too");
});

test("underlying keys normalize whitespace and case", () => {
  assert.equal(normalizeUnderlyingKey("  bhel "), "BHEL");
  assert.equal(normalizeUnderlyingKey("nifty  bank"), "NIFTY BANK");
});

/* --------------------- the join, via the numeric foreign key ---------------- */

test("futures resolve their underlying from UNDERLYING_SECURITY_ID", () => {
  // The reliable join: no reliance on symbol text or column naming.
  const rows = parseDhanScripMaster(masterWithDisplayNames());
  const futures = rows.filter((r) => r.instrument_type === "FUT");
  assert.equal(futures.length, 15, "5 underlyings x 3 expiries");
  for (const f of futures) {
    assert.ok(
      FNO.some((x) => x.sym === f.name),
      `future ${f.tradingsymbol} resolved to "${f.name}", not a real underlying`,
    );
  }
  const report = getDhanParseReport();
  assert.equal(report.underlyingResolution.byForeignKey, 15);
  assert.equal(report.distinctFutureUnderlyings, 5);
});

test("BHEL's stock future normalizes to the expected internal shape", () => {
  const rows = parseDhanScripMaster(masterWithDisplayNames());
  const bhel = rows.find((r) => r.instrument_type === "FUT" && r.name === "BHEL");
  assert.ok(bhel, "a BHEL future exists");
  assert.equal(bhel.exchange, "NFO");
  assert.equal(bhel.instrument_type, "FUT");
  assert.equal(bhel.name, "BHEL");
  assert.match(bhel.expiry, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(bhel.lot_size > 0);
  assert.equal(bhel.instrument_token, dhanInternalToken("NSE_FNO", bhel.dhan_security_id));
});

test("BHEL's equity row normalizes to the expected internal shape", () => {
  const rows = parseDhanScripMaster(masterWithDisplayNames());
  const eq = rows.find((r) => r.instrument_type === "EQ" && r.tradingsymbol === "BHEL");
  assert.ok(eq, "a BHEL equity exists");
  assert.equal(eq.exchange, "NSE");
  assert.equal(eq.instrument_type, "EQ");
  assert.equal(eq.name, "BHEL");
});

/* ------------------------------ board assembly ----------------------------- */

test("FIVE real underlyings produce FIVE board cards, not one", () => {
  // The regression this whole change exists for.
  const rows = parseDhanScripMaster(masterWithDisplayNames());
  const board = diagnoseBoard(rows, {});
  assert.equal(board.uniqueFutureUnderlyings, 5);
  assert.equal(board.matchedEquities, 5);
  assert.ok(board.boardSize >= 5, `board size was ${board.boardSize}`);
  assert.equal(board.unmatchedUnderlyings, 0);
});

test("every known symbol passes every stage", () => {
  const rows = parseDhanScripMaster(masterWithDisplayNames());
  const checks = checkKnownSymbols(rows, FNO.map((f) => f.sym));
  for (const check of checks) {
    assert.equal(check.failsAt, null, `${check.symbol} failed at: ${check.failsAt}`);
    assert.equal(check.equityFound, true);
    assert.equal(check.futuresFound, 3);
    assert.equal(check.validExpiries, 3);
    assert.equal(check.validLotSizes, 3);
    assert.equal(check.onBoard, true);
  }
});

test("an unmatched underlying is REPORTED, not silently dropped", () => {
  // The invisibility was the real problem: a dropped group looked identical to a quiet
  // market.
  const rows = parseDhanScripMaster(
    [
      "EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,UNDERLYING_SYMBOL,UNDERLYING_SECURITY_ID,LOT_SIZE,SM_EXPIRY_DATE,TICK_SIZE",
      // A future whose underlying has NO equity row anywhere.
      `NSE,D,60000,FUTSTK,ORPHAN FUT,ORPHAN,99999,250,${NEAR_EXPIRY},0.05`,
    ].join("\n"),
  );
  const board = diagnoseBoard(rows, {});
  assert.equal(board.boardSize, 0);
  assert.equal(board.unmatchedUnderlyings, 1);
  assert.equal(board.unmatchedSamples[0].reason, "no_spot_equity");
  assert.equal(board.unmatchedSamples[0].underlying, "ORPHAN");
});

test("checkKnownSymbols names the FIRST failing stage", () => {
  // "BHEL is missing" is not actionable; "futures exist but no equity row" is.
  const rows = parseDhanScripMaster(
    [
      "EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,UNDERLYING_SYMBOL,UNDERLYING_SECURITY_ID,LOT_SIZE,SM_EXPIRY_DATE,TICK_SIZE",
      `NSE,D,50000,FUTSTK,BHEL FUT,BHEL,438,250,${NEAR_EXPIRY},0.05`,
    ].join("\n"),
  );
  const [check] = checkKnownSymbols(rows, ["BHEL"]);
  assert.equal(check.equityFound, false);
  assert.match(check.failsAt, /no NSE equity row/);
});

test("index futures group even without an NSE equity row", () => {
  // Index underlyings have no equity; they join through INDEX_SPOT_MAP instead.
  const rows = parseDhanScripMaster(
    [
      "EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,UNDERLYING_SYMBOL,UNDERLYING_SECURITY_ID,LOT_SIZE,SM_EXPIRY_DATE,TICK_SIZE",
      "NSE,I,13,INDEX,NIFTY 50,NIFTY,13,0,,0.05",
      `NSE,D,70000,FUTIDX,NIFTY FUT,NIFTY,13,50,${NEAR_EXPIRY},0.05`,
    ].join("\n"),
  );
  const board = diagnoseBoard(rows, { NIFTY: "NIFTY 50" });
  assert.equal(board.matchedIndices, 1, "the index underlying joined via the spot map");
  assert.equal(board.boardSize, 1);
});

test("an index future keeps the UNDERLYING symbol, not the index's trading symbol", () => {
  // The two join conventions differ and must not be conflated. The board resolves an
  // index with INDEX_SPOT_MAP[name] — a map keyed "NIFTY" that RETURNS "NIFTY 50". So
  // following the foreign key to the spot row and taking "NIFTY 50" as the name would
  // make the lookup miss and drop every index. Equities are the opposite: there the
  // spot's trading symbol IS the join key.
  const rows = parseDhanScripMaster(
    [
      "EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,UNDERLYING_SYMBOL,UNDERLYING_SECURITY_ID,LOT_SIZE,SM_EXPIRY_DATE,TICK_SIZE",
      "NSE,I,13,INDEX,NIFTY 50,NIFTY,13,0,,0.05",
      "NSE,I,25,INDEX,NIFTY BANK,BANKNIFTY,25,0,,0.05",
      "NSE,E,438,EQUITY,BHEL,BHEL,438,1,,0.05",
      `NSE,D,70000,FUTIDX,NIFTY FUT,NIFTY,13,50,${NEAR_EXPIRY},0.05`,
      `NSE,D,70001,FUTIDX,BANKNIFTY FUT,BANKNIFTY,25,15,${NEAR_EXPIRY},0.05`,
      `NSE,D,50000,FUTSTK,BHEL FUT,BHEL,438,250,${NEAR_EXPIRY},0.05`,
    ].join("\n"),
  );

  const nifty = rows.find((r) => r.dhan_security_id === 70000);
  assert.equal(nifty.name, "NIFTY", 'must be "NIFTY", never "NIFTY 50"');
  const bankNifty = rows.find((r) => r.dhan_security_id === 70001);
  assert.equal(bankNifty.name, "BANKNIFTY", 'must be "BANKNIFTY", never "NIFTY BANK"');
  // ...while the equity future resolves to the equity's trading symbol.
  const bhel = rows.find((r) => r.dhan_security_id === 50000);
  assert.equal(bhel.name, "BHEL");

  const board = diagnoseBoard(rows, { NIFTY: "NIFTY 50", BANKNIFTY: "NIFTY BANK" });
  assert.equal(board.matchedIndices, 2, "both indices joined");
  assert.equal(board.matchedEquities, 1);
  assert.equal(board.boardSize, 3);
  assert.equal(board.unmatchedUnderlyings, 0);
});

test("futures and options get distinct Kite-shaped segments", () => {
  // `segment` is meant to be Kite-shaped. Labelling every NFO row "NFO-OPT" made a
  // future indistinguishable from an option to anything that filters on segment.
  const rows = parseDhanScripMaster(
    [
      "EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,UNDERLYING_SYMBOL,UNDERLYING_SECURITY_ID,LOT_SIZE,SM_EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE,TICK_SIZE",
      "NSE,E,438,EQUITY,BHEL,BHEL,438,1,,0,,0.05",
      `NSE,D,50000,FUTSTK,BHEL FUT,BHEL,438,250,${NEAR_EXPIRY},0,,0.05`,
      `NSE,D,50001,OPTSTK,BHEL 300 CE,BHEL,438,250,${NEAR_EXPIRY},300,CE,0.05`,
    ].join("\n"),
  );
  assert.equal(rows.find((r) => r.dhan_security_id === 50000).segment, "NFO-FUT");
  assert.equal(rows.find((r) => r.dhan_security_id === 50001).segment, "NFO-OPT");
  assert.equal(rows.find((r) => r.dhan_security_id === 438).segment, "NSE");
});

test("long-dated contracts are excluded and cannot reach the board", () => {
  const rows = parseDhanScripMaster(
    [
      "EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,UNDERLYING_SYMBOL,UNDERLYING_SECURITY_ID,LOT_SIZE,SM_EXPIRY_DATE,TICK_SIZE",
      "NSE,E,438,EQUITY,BHEL,BHEL,438,1,,0.05",
      `NSE,D,50000,FUTSTK,BHEL FUT,BHEL,438,250,${NEAR_EXPIRY},0.05`,
      // A well-formed, non-TEST row whose only defect is an absurd expiry.
      `NSE,E,777,EQUITY,LONGDATED,LONGDATED,777,1,,0.05`,
      `NSE,D,50002,FUTSTK,LONGDATED FUT,LONGDATED,777,250,${FAR_EXPIRY},0.05`,
    ].join("\n"),
  );
  assert.ok(getDhanParseReport().skippedImplausibleExpiry >= 1);
  assert.ok(!rows.some((r) => r.dhan_security_id === 50002), "the long-dated future is gone");
  const board = diagnoseBoard(rows, {});
  assert.equal(board.boardSize, 1, "only BHEL; LONGDATED has an equity but no future");
});

test("TEST scrips never reach the board even when otherwise well-formed", () => {
  const rows = parseDhanScripMaster(
    [
      "EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,UNDERLYING_SYMBOL,UNDERLYING_SECURITY_ID,LOT_SIZE,SM_EXPIRY_DATE,TICK_SIZE",
      "NSE,E,900,EQUITY,01INSETEST,01INSETEST,900,1,,0.05",
      `NSE,D,901,FUTSTK,01INSETEST FUT,01INSETEST,900,1,${NEAR_EXPIRY},0.05`,
      "NSE,E,438,EQUITY,BHEL,BHEL,438,1,,0.05",
      `NSE,D,50000,FUTSTK,BHEL FUT,BHEL,438,250,${NEAR_EXPIRY},0.05`,
    ].join("\n"),
  );
  const board = diagnoseBoard(rows, {});
  assert.equal(board.boardSize, 1, "only BHEL");
  assert.ok(!rows.some((r) => /INSETEST/.test(r.tradingsymbol)));
});

/* --------------------------- token round trip ------------------------------ */

test("internal token round-trips through the whole identity chain", () => {
  // board token == subscription token == Dhan security id mapping == packet reverse map.
  // If any stage reverts to the raw security id, every LTP stays "-".
  const rows = parseDhanScripMaster(masterWithDisplayNames());
  const bhelFut = rows.find((r) => r.instrument_type === "FUT" && r.name === "BHEL");

  const token = bhelFut.instrument_token;
  // 1. board/subscription token -> Dhan identity
  assert.equal(token, dhanInternalToken(bhelFut.dhan_segment, bhelFut.dhan_security_id));
  // 2. Dhan identity -> back to the same token (what the feed's reverse map must do)
  assert.equal(dhanInternalToken("NSE_FNO", bhelFut.dhan_security_id), token);
  // 3. and it is NOT the bare security id, which is the mistake that breaks matching
  assert.notEqual(token, bhelFut.dhan_security_id);
});
