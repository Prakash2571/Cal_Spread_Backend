/**
 * Index F&O vanished from the board, and the option chain 404'd.
 *
 * `GET /api/debug/indices` on the live Dhan session, before the fix:
 *
 *   totalIndexInstruments: 190          <- indices ARE parsed and classified
 *   resolved: NIFTY      hasFutures: true  spotSymbol "NIFTY 50"          spotFound: false
 *             BANKNIFTY  hasFutures: true  spotSymbol "NIFTY BANK"        spotFound: false
 *             FINNIFTY   hasFutures: true  spotSymbol "NIFTY FIN SERVICE" spotFound: false
 *   indexRowsInBoard: []                <- every index dropped
 *   totalBoardRows: 204                 <- all stocks
 *
 * The futures side was fine (`hasFutures: true` everywhere). Only the SPOT join failed,
 * because `INDEX_SPOT_MAP` holds ZERODHA's trading symbols and Dhan publishes the same
 * indices as "NIFTY", "BANKNIFTY", "FINNIFTY".
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  INDEX_SPOT_MAP,
  indexSpotCandidates,
  resolveIndexSpotSymbol,
} from "../../dist/indexSpot.js";
import { diagnoseBoard } from "../../dist/brokers/boardDiagnostics.js";

/** The real index trading symbols Dhan publishes (from /api/debug/indices). */
const DHAN_INDEX_SYMBOLS = [
  "NIFTY",
  "BANKNIFTY",
  "FINNIFTY",
  "NIFTY 100",
  "NIFTY 200",
  "NIFTY 500",
  "NIFTY AUTO",
  "NIFTY FMCG",
  "NIFTYIT",
  "NIFTY MIDCAP 150",
  "INDIA VIX",
];

/** Zerodha's names for the same indices. */
const KITE_INDEX_SYMBOLS = [
  "NIFTY 50",
  "NIFTY BANK",
  "NIFTY FIN SERVICE",
  "NIFTY MID SELECT",
  "NIFTY NEXT 50",
];

const has = (list) => (sym) => list.includes(sym);

/* ------------------------------ the resolution ---------------------------- */

test("DHAN's index spot resolves from the underlying symbol", () => {
  // The reported failure: all three were spotFound:false.
  assert.equal(resolveIndexSpotSymbol("NIFTY", has(DHAN_INDEX_SYMBOLS)), "NIFTY");
  assert.equal(resolveIndexSpotSymbol("BANKNIFTY", has(DHAN_INDEX_SYMBOLS)), "BANKNIFTY");
  assert.equal(resolveIndexSpotSymbol("FINNIFTY", has(DHAN_INDEX_SYMBOLS)), "FINNIFTY");
});

test("ZERODHA's index spot still resolves to the curated name", () => {
  // Zero regression on the broker that was already working.
  assert.equal(resolveIndexSpotSymbol("NIFTY", has(KITE_INDEX_SYMBOLS)), "NIFTY 50");
  assert.equal(resolveIndexSpotSymbol("BANKNIFTY", has(KITE_INDEX_SYMBOLS)), "NIFTY BANK");
  assert.equal(resolveIndexSpotSymbol("MIDCPNIFTY", has(KITE_INDEX_SYMBOLS)), "NIFTY MID SELECT");
  assert.equal(resolveIndexSpotSymbol("NIFTYNXT50", has(KITE_INDEX_SYMBOLS)), "NIFTY NEXT 50");
});

test("the CURATED name wins when both are present", () => {
  // Order is deliberate: preferring the curated name means Zerodha's behaviour cannot
  // change, whatever a broker happens to also publish.
  assert.equal(
    resolveIndexSpotSymbol("NIFTY", has(["NIFTY", "NIFTY 50"])),
    "NIFTY 50",
  );
});

test("every mapped index underlying resolves under BOTH naming conventions", () => {
  for (const [underlying, kiteName] of Object.entries(INDEX_SPOT_MAP)) {
    assert.equal(resolveIndexSpotSymbol(underlying, has([kiteName])), kiteName, underlying);
    assert.equal(
      resolveIndexSpotSymbol(underlying, has([underlying])),
      underlying,
      `${underlying} under Dhan's convention`,
    );
  }
});

test("an index underlying with NO spot row at all resolves to null", () => {
  assert.equal(resolveIndexSpotSymbol("NIFTY", has(["SOMETHING ELSE"])), null);
});

/* ------------------------- the allow-list gate holds ---------------------- */

test("a non-index underlying is NEVER matched against an index instrument", () => {
  // Widening the gate would let an equity underlying bind to a same-named index, which
  // is far worse than a missing row: it would price a stock off an index.
  assert.deepEqual(indexSpotCandidates("RELIANCE"), []);
  assert.equal(resolveIndexSpotSymbol("RELIANCE", () => true), null);
  assert.equal(resolveIndexSpotSymbol("INDIA VIX", () => true), null, "not F&O-tradable here");
  assert.equal(resolveIndexSpotSymbol("NIFTYIT", () => true), null, "not in the allow-list");
});

test("candidates are the curated name then the underlying, deduplicated", () => {
  assert.deepEqual(indexSpotCandidates("NIFTY"), ["NIFTY 50", "NIFTY"]);
  assert.deepEqual(indexSpotCandidates("X", { X: "X" }), ["X"], "no duplicate candidate");
});

/* ------------------------------ board assembly ---------------------------- */

/** A board fixture in one broker's naming. */
function fixture(indexSpotSymbol) {
  return [
    // The index spot.
    {
      instrument_token: 11,
      exchange_token: 11,
      tradingsymbol: indexSpotSymbol,
      name: indexSpotSymbol,
      last_price: 0,
      expiry: "",
      strike: 0,
      tick_size: 0.05,
      lot_size: 0,
      instrument_type: "INDEX",
      segment: "INDICES",
      exchange: "INDICES",
    },
    // Its future, whose underlying is always the DERIVATIVE symbol "NIFTY".
    {
      instrument_token: 12,
      exchange_token: 12,
      tradingsymbol: "NIFTY-FUT",
      name: "NIFTY",
      last_price: 0,
      expiry: "2026-09-29",
      strike: 0,
      tick_size: 0.05,
      lot_size: 50,
      instrument_type: "FUT",
      segment: "NFO-FUT",
      exchange: "NFO",
    },
  ];
}

test("the index reaches the board under DHAN's naming", () => {
  const board = diagnoseBoard(fixture("NIFTY"), INDEX_SPOT_MAP);
  assert.equal(board.matchedIndices, 1, "NIFTY must join to its own spot row");
  assert.equal(board.boardSize, 1);
  assert.equal(board.unmatchedUnderlyings, 0);
});

test("the index reaches the board under ZERODHA's naming", () => {
  const board = diagnoseBoard(fixture("NIFTY 50"), INDEX_SPOT_MAP);
  assert.equal(board.matchedIndices, 1);
  assert.equal(board.boardSize, 1);
});

test("a missing index spot is reported as a MAPPING problem, not a missing equity", () => {
  // "no_index_mapping" points at a naming mismatch; "no_spot_equity" would send someone
  // to look for a stock that never existed.
  const board = diagnoseBoard(fixture("TOTALLY OTHER INDEX"), INDEX_SPOT_MAP);
  assert.equal(board.matchedIndices, 0);
  assert.equal(board.unmatchedUnderlyings, 1);
  assert.equal(board.unmatchedSamples[0].underlying, "NIFTY");
  assert.equal(board.unmatchedSamples[0].reason, "no_index_mapping");
});
