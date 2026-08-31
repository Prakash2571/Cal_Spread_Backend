/**
 * Direction: LONG_BOX and SHORT_BOX.
 *
 * The two directions share one candidate/quote/evaluation code path; these tests
 * pin the side mapping, the edge sign, the identity key, and the backwards-compatible
 * treatment of documents written before short boxes existed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCandidates,
  candidateKey,
  computeExitMetrics,
  entrySideFor,
  evaluateCandidate,
  evaluateExitLegs,
  exitSideFor,
} from "../../dist/box/math.js";
import {
  BOX_DIRECTIONS,
  BOX_ENTRY_SIDES_BY_DIRECTION,
  directionOf,
  directionSign,
} from "../../dist/box/types.js";
import { LOT, chain, cfg, goodCandidate, quotesFor } from "./helpers.mjs";

const NOW = 1_000_000;

test("both directions are built for every strike pair when requested", () => {
  const c = chain({ count: 7 });
  const both = buildCandidates({
    underlying: "NIFTY",
    name: "NIFTY 50",
    is_index: true,
    expiry: c.expiry,
    lot_size: c.lotSize,
    strikes: c.strikes,
    ce: c.ce,
    pe: c.pe,
    directions: BOX_DIRECTIONS,
  });
  assert.equal(both.length, 42, "21 pairs x 2 directions");
  const longs = both.filter((x) => x.direction === "LONG_BOX");
  const shorts = both.filter((x) => x.direction === "SHORT_BOX");
  assert.equal(longs.length, 21);
  assert.equal(shorts.length, 21);
  // Default is long-only, preserving the previous behaviour.
  const longOnly = buildCandidates({
    underlying: "NIFTY", name: "NIFTY 50", is_index: true, expiry: c.expiry,
    lot_size: c.lotSize, strikes: c.strikes, ce: c.ce, pe: c.pe,
  });
  assert.equal(longOnly.length, 21);
  assert.ok(longOnly.every((x) => x.direction === "LONG_BOX"));
});

test("LONG_BOX side mapping: BUY K1CE, SELL K2CE, BUY K2PE, SELL K1PE", () => {
  const s = BOX_ENTRY_SIDES_BY_DIRECTION.LONG_BOX;
  assert.deepEqual(s, { k1_ce: "BUY", k2_ce: "SELL", k2_pe: "BUY", k1_pe: "SELL" });
  assert.equal(entrySideFor("k1_ce", "LONG_BOX"), "BUY");
  assert.equal(exitSideFor("k1_ce", "LONG_BOX"), "SELL");
});

test("SHORT_BOX side mapping is the exact mirror: SELL K1CE, BUY K2CE, SELL K2PE, BUY K1PE", () => {
  const s = BOX_ENTRY_SIDES_BY_DIRECTION.SHORT_BOX;
  assert.deepEqual(s, { k1_ce: "SELL", k2_ce: "BUY", k2_pe: "SELL", k1_pe: "BUY" });
  assert.equal(entrySideFor("k1_ce", "SHORT_BOX"), "SELL");
  assert.equal(exitSideFor("k1_ce", "SHORT_BOX"), "BUY");
});

test("the edge sign is opposite for the two directions on the same book", () => {
  const { candidate: longCand } = goodCandidate();
  // Build the SHORT candidate on the same strikes/legs.
  const shortCand = { ...longCand, direction: "SHORT_BOX", key: candidateKey("NIFTY", longCand.expiry, longCand.lower_strike, longCand.upper_strike, "SHORT_BOX") };

  const quotes = quotesFor(longCand, {}, { at: NOW });

  const longEval = evaluateCandidate({ candidate: longCand, quotes, now: NOW, maxAgeMs: 1500 });
  const shortEval = evaluateCandidate({ candidate: shortCand, quotes, now: NOW, maxAgeMs: 1500 });

  // Long box entry net debit = Ask(K1CE)-Bid(K2CE)+Ask(K2PE)-Bid(K1PE) = 175 (a cost).
  assert.equal(longEval.entry_net_debit_per_unit, 175);
  assert.equal(longEval.gross_edge_per_unit, 200 - 175); // width - cost = +25

  // Short box entry net debit = Ask(K2CE)+Ask(K1PE)-Bid(K1CE)-Bid(K2PE)
  //                           = 221 + 106 - 299 - 199 = -171 (a credit received).
  assert.equal(shortEval.entry_net_debit_per_unit, 221 + 106 - 299 - 199);
  // Short gross edge = -width - netDebit = -200 - (-171) = -29 (this book favours the LONG).
  assert.equal(shortEval.gross_edge_per_unit, -200 - shortEval.entry_net_debit_per_unit);
  assert.ok(longEval.gross_edge > 0 && shortEval.gross_edge < 0, "opposite signs");
});

test("a SHORT box is profitable exactly when the box trades ABOVE its width", () => {
  const { candidate: longCand } = goodCandidate();
  const shortCand = { ...longCand, direction: "SHORT_BOX", key: candidateKey("NIFTY", longCand.expiry, longCand.lower_strike, longCand.upper_strike, "SHORT_BOX") };
  // Make the box expensive to buy (cheap to sell high): push the two long-box
  // SELL touches up so the short box collects more than the ₹200 width.
  // Short receives Bid(K1CE)+Bid(K2PE) and pays Ask(K2CE)+Ask(K1PE).
  const quotes = quotesFor(longCand, {
    k1_ce: { bid: 360, bidQty: 150 },
    k2_pe: { bid: 260, bidQty: 150 },
  }, { at: NOW });
  const ev = evaluateCandidate({ candidate: shortCand, quotes, now: NOW, maxAgeMs: 1500 });
  // credit = 360 + 260 - 221(K2CE ask) - 106(K1PE ask) = 293 > width 200.
  assert.equal(-ev.entry_net_debit_per_unit, 360 + 260 - 221 - 106);
  assert.ok(ev.gross_edge > 0, "selling the box above its width is the short opportunity");
});

test("candidate keys and directionSign encode direction distinctly", () => {
  assert.equal(directionSign("LONG_BOX"), 1);
  assert.equal(directionSign("SHORT_BOX"), -1);
  const kl = candidateKey("NIFTY", "2026-09-24", 19900, 20100, "LONG_BOX");
  const ks = candidateKey("NIFTY", "2026-09-24", 19900, 20100, "SHORT_BOX");
  assert.notEqual(kl, ks);
  assert.match(kl, /LONG_BOX$/);
  assert.match(ks, /SHORT_BOX$/);
});

test("a stored document without a direction deserializes as LONG_BOX", () => {
  assert.equal(directionOf({}), "LONG_BOX");
  assert.equal(directionOf({ direction: null }), "LONG_BOX");
  assert.equal(directionOf({ direction: undefined }), "LONG_BOX");
  assert.equal(directionOf({ direction: "SHORT_BOX" }), "SHORT_BOX");
  assert.equal(directionOf({ direction: "LONG_BOX" }), "LONG_BOX");
});

test("exit sign does not invert between directions: captured edge falls as either converges", () => {
  const { candidate } = goodCandidate();
  // A SHORT box entered at a credit of 210 (net debit -210), width 200.
  const shortCand = { ...candidate, direction: "SHORT_BOX" };
  const entryNetDebit = -210;
  // Exit legs priced so the short box can be closed by buying it back cheaply.
  // For a short box the exit BUYS K1CE & K2PE (ask) and SELLS K2CE & K1PE (bid).
  const exitLegs = evaluateExitLegs({
    legs: ["k1_ce", "k2_ce", "k2_pe", "k1_pe"].map((role) => ({ role, inst: candidate.legs[role] })),
    quotes: quotesFor(candidate, {}, { at: 1_000_000 }),
    lotSize: LOT,
    now: 1_000_000,
    maxAgeMs: 1500,
    direction: "SHORT_BOX",
  });
  const m = computeExitMetrics({
    boxWidth: 200,
    lotSize: LOT,
    entryBoxCostPerUnit: entryNetDebit,
    entryNetEdge: (210 - 200) * LOT,
    entryChargesTotal: 150,
    currentExitChargesTotal: 150,
    legs: exitLegs,
    now: 1_000_000,
    direction: "SHORT_BOX",
    entryEdge: (210 - 200) * LOT, // credit above width
    cfg: cfg(),
  });
  // remaining edge is finite and captured edge = entryEdge - remaining, same
  // definition as a long box (no sign inversion / NaN).
  assert.ok(Number.isFinite(m.remaining_edge));
  assert.ok(Number.isFinite(m.captured_edge));
  assert.equal(m.captured_edge, m.entry_edge - m.remaining_edge);
  assert.equal(m.direction, "SHORT_BOX");
});
