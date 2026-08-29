/**
 * The box trading core: strike selection, candidate construction, executable
 * pricing, the ₹1,200 qualification and the convergence exit rules.
 *
 * Every case here is deterministic — no clock, no network, no database.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  atmStrikeFor,
  bestPrice,
  buildCandidates,
  candidateKey,
  computeExitMetrics,
  convergenceThreshold,
  evaluateCandidate,
  evaluateCandidateIndicative,
  evaluateExitLegs,
  exitLiquidityOk,
  exitSideFor,
  passesGrossPrefilter,
  projectedNetEdge,
  qualifiesForEntry,
  qtyAtPrice,
  selectStrikeWindow,
  shouldRecentreWindow,
  strikeStepOf,
  touchFor,
} from "../../dist/box/math.js";
import { BOX_ENTRY_SIDES, BOX_LEG_ROLES } from "../../dist/box/types.js";
import { prefilterGrossThreshold } from "../../dist/box/config.js";
import {
  GOOD_BOX,
  LOT,
  candidatesFor,
  cfg,
  chain,
  exitQuotes,
  goodCandidate,
  quote,
  quotesFor,
} from "./helpers.mjs";

const NOW = 1_000_000;

/* ------------------------------------------------------------------ 1, 2 --- */

test("1. the monitored window is the ATM strike plus three either side", () => {
  const c = chain({ first: 19700, step: 100, count: 11 }); // 19700..20700
  // Spot 20120 is nearest to 20100.
  const picked = selectStrikeWindow(c.strikes, 20120, 3);
  assert.equal(picked.atm, 20100);
  assert.deepEqual(picked.window, [19800, 19900, 20000, 20100, 20200, 20300, 20400]);
  assert.equal(picked.window.filter((s) => s < picked.atm).length, 3);
  assert.equal(picked.window.filter((s) => s > picked.atm).length, 3);
});

test("2. never more than seven strikes, however long the chain", () => {
  for (const count of [7, 11, 41, 200]) {
    const c = chain({ count });
    const spot = c.strikes[Math.floor(count / 2)];
    const picked = selectStrikeWindow(c.strikes, spot, 3);
    assert.ok(picked.window.length <= 7, `count=${count} gave ${picked.window.length}`);
    assert.equal(picked.window.length, 7);
  }
  // At the very edge of a chain the window truncates rather than reaching
  // further the other way — it must never silently exceed seven either.
  const c = chain({ count: 5 });
  const edge = selectStrikeWindow(c.strikes, c.strikes[0], 3);
  assert.ok(edge.window.length <= 7);
  assert.equal(edge.window[0], c.strikes[0]);
});

test("ATM is the strike closest to spot, and the strike step is the median gap", () => {
  assert.equal(atmStrikeFor([100, 200, 300], 260), 300);
  assert.equal(atmStrikeFor([100, 200, 300], 240), 200);
  assert.equal(atmStrikeFor([], 100), null);
  assert.equal(strikeStepOf([19700, 19800, 19900, 20000]), 100);
  assert.equal(strikeStepOf([100]), 0);
});

test("the ATM window only re-centres once the spot clears the hysteresis band", () => {
  // Half a step is 50; the 0.15 band adds 15, so 60 must NOT move it and 70 must.
  assert.equal(shouldRecentreWindow(20000, 20060, 100, 0.15), false);
  assert.equal(shouldRecentreWindow(20000, 20070, 100, 0.15), true);
  assert.equal(shouldRecentreWindow(20000, 19930, 100, 0.15), true);
  assert.equal(shouldRecentreWindow(20000, 20500, 0, 0.15), false);
});

/* --------------------------------------------------------------------- 3 --- */

test("3. seven strikes give exactly 21 strike pairs, and no more", () => {
  const { all, window } = goodCandidate();
  assert.equal(window.length, 7);
  assert.equal(all.length, 21); // C(7,2)
  const keys = new Set(all.map((c) => c.key));
  assert.equal(keys.size, 21, "candidate keys must be unique");
  for (const c of all) assert.ok(c.lower_strike < c.upper_strike, "K1 < K2 always");
});

test("a strike missing either leg cannot form a box", () => {
  const c = chain({ count: 7 });
  c.pe.delete(c.strikes[3]); // no put at that strike
  const all = candidatesFor(c.strikes, c);
  // The 6 pairs involving that strike drop out: 21 - 6 = 15.
  assert.equal(all.length, 15);
  for (const cand of all) {
    assert.notEqual(cand.lower_strike, c.strikes[3]);
    assert.notEqual(cand.upper_strike, c.strikes[3]);
  }
});

test("candidate keys identify a box by underlying, expiry and both strikes", () => {
  assert.equal(candidateKey("NIFTY", "2026-09-24", 19900, 20100), "NIFTY|2026-09-24|19900|20100");
});

/* --------------------------------------------------------------------- 4 --- */

test("4. a long box is BUY K1 CE, SELL K2 CE, BUY K2 PE, SELL K1 PE", () => {
  const { candidate } = goodCandidate();
  assert.deepEqual([...BOX_LEG_ROLES], ["k1_ce", "k2_ce", "k2_pe", "k1_pe"]);
  assert.equal(BOX_ENTRY_SIDES.k1_ce, "BUY");
  assert.equal(BOX_ENTRY_SIDES.k2_ce, "SELL");
  assert.equal(BOX_ENTRY_SIDES.k2_pe, "BUY");
  assert.equal(BOX_ENTRY_SIDES.k1_pe, "SELL");

  assert.equal(candidate.legs.k1_ce.strike, GOOD_BOX.k1);
  assert.equal(candidate.legs.k1_ce.instrument_type, "CE");
  assert.equal(candidate.legs.k2_ce.strike, GOOD_BOX.k2);
  assert.equal(candidate.legs.k2_ce.instrument_type, "CE");
  assert.equal(candidate.legs.k2_pe.strike, GOOD_BOX.k2);
  assert.equal(candidate.legs.k2_pe.instrument_type, "PE");
  assert.equal(candidate.legs.k1_pe.strike, GOOD_BOX.k1);
  assert.equal(candidate.legs.k1_pe.instrument_type, "PE");
});

/* ------------------------------------------------------------------ 5, 6 --- */

test("5/6. BUY legs fill at the best ASK and SELL legs at the best BID — never the LTP", () => {
  const { candidate } = goodCandidate();
  // A deliberately misleading last-traded price on every leg.
  const quotes = quotesFor(candidate, {
    k1_ce: { last: 999 },
    k2_ce: { last: 999 },
    k2_pe: { last: 999 },
    k1_pe: { last: 999 },
  }, { at: NOW });
  const ev = evaluateCandidate({ candidate, quotes, now: NOW, maxAgeMs: 1500 });
  const byRole = new Map(ev.legs.map((l) => [l.role, l]));

  assert.equal(byRole.get("k1_ce").side, "BUY");
  assert.equal(byRole.get("k1_ce").price, GOOD_BOX.prices.k1_ce.ask);
  assert.equal(byRole.get("k2_pe").side, "BUY");
  assert.equal(byRole.get("k2_pe").price, GOOD_BOX.prices.k2_pe.ask);

  assert.equal(byRole.get("k2_ce").side, "SELL");
  assert.equal(byRole.get("k2_ce").price, GOOD_BOX.prices.k2_ce.bid);
  assert.equal(byRole.get("k1_pe").side, "SELL");
  assert.equal(byRole.get("k1_pe").price, GOOD_BOX.prices.k1_pe.bid);

  for (const leg of ev.legs) assert.notEqual(leg.price, 999, "an LTP must never be a fill");
});

test("the touch is the highest bid / lowest ask regardless of level order", () => {
  assert.equal(bestPrice([{ price: 10, qty: 1 }, { price: 12, qty: 1 }], "bid"), 12);
  assert.equal(bestPrice([{ price: 14, qty: 1 }, { price: 11, qty: 1 }], "ask"), 11);
  assert.equal(bestPrice([], "bid"), null);
  assert.equal(bestPrice([{ price: 0, qty: 5 }], "ask"), null);
  // Size resting AT the touch is summed; deeper levels are ignored in V1.
  assert.equal(qtyAtPrice([{ price: 11, qty: 40 }, { price: 11, qty: 35 }, { price: 12, qty: 900 }], 11), 75);
  const t = touchFor(quote(1, { bid: 10, bidQty: 80, ask: 11, askQty: 90, at: NOW }), "BUY");
  assert.deepEqual(t, { price: 11, qty: 90 });
});

/* --------------------------------------------------------------- 7, 8, 9 --- */

test("7/8/9. box cost, expiry payoff and gross edge come from executable prices", () => {
  const { candidate } = goodCandidate();
  const quotes = quotesFor(candidate, {}, { at: NOW });
  const ev = evaluateCandidate({ candidate, quotes, now: NOW, maxAgeMs: 1500 });

  // 7. cost = Ask(K1 CE) - Bid(K2 CE) + Ask(K2 PE) - Bid(K1 PE)
  assert.equal(ev.entry_box_cost_per_unit, 300 - 220 + 200 - 105);
  assert.equal(ev.entry_box_cost_per_unit, GOOD_BOX.costPerUnit);

  // 8. expiry payoff per unit is the width, K2 - K1
  assert.equal(candidate.box_width, GOOD_BOX.k2 - GOOD_BOX.k1);
  assert.equal(candidate.box_width, 200);

  // 9. gross edge = (width - cost) x lot size
  assert.equal(ev.gross_edge_per_unit, 200 - 175);
  assert.equal(ev.gross_edge, 25 * LOT);
  assert.equal(ev.gross_edge, GOOD_BOX.grossEdge);
  assert.equal(ev.tradable, true);
  assert.equal(ev.reject, null);
});

/* -------------------------------------------------------------------- 10 --- */

test("10. size is always exactly one lot, taken from instrument metadata", () => {
  const { candidate } = goodCandidate();
  assert.equal(candidate.lot_size, LOT);
  for (const role of BOX_LEG_ROLES) {
    assert.equal(candidate.legs[role].lot_size, LOT, "lot size comes from the contract");
  }
  // A different underlying's lot size flows straight through — nothing is fixed.
  const wide = chain({ count: 7, lotSize: 250 });
  const other = candidatesFor(wide.strikes, wide)[0];
  assert.equal(other.lot_size, 250);

  // One lot is the threshold: lot-1 at the touch is not executable, lot is.
  const short = quotesFor(candidate, { k1_ce: { askQty: LOT - 1 } }, { at: NOW });
  assert.equal(evaluateCandidate({ candidate, quotes: short, now: NOW, maxAgeMs: 1500 }).tradable, false);
  const exact = quotesFor(candidate, { k1_ce: { askQty: LOT } }, { at: NOW });
  assert.equal(evaluateCandidate({ candidate, quotes: exact, now: NOW, maxAgeMs: 1500 }).tradable, true);
});

/* -------------------------------------------------------------------- 11 --- */

test("11. every leg must show one whole lot AT the touch price", () => {
  const { candidate } = goodCandidate();
  for (const role of BOX_LEG_ROLES) {
    const thinKey = BOX_ENTRY_SIDES[role] === "BUY" ? "askQty" : "bidQty";
    const quotes = quotesFor(candidate, { [role]: { [thinKey]: 40 } }, { at: NOW });
    const ev = evaluateCandidate({ candidate, quotes, now: NOW, maxAgeMs: 1500 });
    assert.equal(ev.tradable, false, `${role} thin at the touch must reject`);
    assert.equal(ev.reject, "insufficient_qty");
    // The edge is still reported so the UI can show the near-miss.
    assert.equal(ev.gross_edge, GOOD_BOX.grossEdge);
  }
});

test("depth beyond the touch is NOT walked to make up a lot", () => {
  const { candidate } = goodCandidate();
  const quotes = quotesFor(candidate, {}, { at: NOW });
  const token = candidate.legs.k1_ce.token;
  const q = quotes.get(token);
  // 40 at the touch, plenty one tick worse: still not executable for 75.
  q.asks = [
    { price: 300, qty: 40, orders: 1 },
    { price: 300.5, qty: 5000, orders: 9 },
  ];
  q.ask_qty = 40;
  const ev = evaluateCandidate({ candidate, quotes, now: NOW, maxAgeMs: 1500 });
  assert.equal(ev.tradable, false);
  assert.equal(ev.reject, "insufficient_qty");
});

/* -------------------------------------------------------------------- 12 --- */

test("12. a stale book is never traded on", () => {
  const { candidate } = goodCandidate();
  const fresh = quotesFor(candidate, {}, { at: NOW - 1500 });
  assert.equal(
    evaluateCandidate({ candidate, quotes: fresh, now: NOW, maxAgeMs: 1500 }).tradable,
    true,
    "exactly at the limit is still fresh",
  );

  for (const role of BOX_LEG_ROLES) {
    const quotes = quotesFor(candidate, { [role]: { at: NOW - 1501 } }, { at: NOW });
    const ev = evaluateCandidate({ candidate, quotes, now: NOW, maxAgeMs: 1500 });
    assert.equal(ev.tradable, false, `${role} stale must reject`);
    assert.equal(ev.reject, "stale_quote");
    assert.equal(ev.worst_age_ms, 1501);
  }

  // A leg with no book at all is rejected before staleness is even considered.
  const missing = quotesFor(candidate, {}, { at: NOW });
  missing.delete(candidate.legs.k2_pe.token);
  const ev = evaluateCandidate({ candidate, quotes: missing, now: NOW, maxAgeMs: 1500 });
  assert.equal(ev.tradable, false);
  assert.equal(ev.reject, "no_quote");
});

/* ---------------------------------------------------------------- 13, 14 --- */

test("13. a SELL leg with no bid is rejected", () => {
  const { candidate } = goodCandidate();
  for (const role of ["k2_ce", "k1_pe"]) {
    const quotes = quotesFor(candidate, { [role]: { bid: 0, bidQty: 0 } }, { at: NOW });
    const ev = evaluateCandidate({ candidate, quotes, now: NOW, maxAgeMs: 1500 });
    assert.equal(ev.tradable, false);
    assert.equal(ev.reject, "missing_bid");
    assert.equal(ev.gross_edge, null, "no price means no invented edge");
  }
});

test("14. a BUY leg with no ask is rejected", () => {
  const { candidate } = goodCandidate();
  for (const role of ["k1_ce", "k2_pe"]) {
    const quotes = quotesFor(candidate, { [role]: { ask: 0, askQty: 0 } }, { at: NOW });
    const ev = evaluateCandidate({ candidate, quotes, now: NOW, maxAgeMs: 1500 });
    assert.equal(ev.tradable, false);
    assert.equal(ev.reject, "missing_ask");
    assert.equal(ev.gross_edge, null);
  }
});

/* ------------------------------------------------------- 15, 16, 17, 18 --- */

test("15/16. the projected net edge subtracts entry fees, exit fees AND the safety buffer", () => {
  const net = projectedNetEdge({
    grossEdge: 1875,
    entryCharges: 150,
    estimatedExitCharges: 150,
    safetyBuffer: 150,
  });
  assert.equal(net, 1875 - 150 - 150 - 150);
  assert.equal(net, 1425);

  // Each deduction must actually bite, one at a time.
  assert.equal(
    projectedNetEdge({ grossEdge: 1875, entryCharges: 0, estimatedExitCharges: 0, safetyBuffer: 0 }),
    1875,
  );
  assert.equal(
    projectedNetEdge({ grossEdge: 1875, entryCharges: 200, estimatedExitCharges: 0, safetyBuffer: 0 }),
    1675,
  );
  assert.equal(
    projectedNetEdge({ grossEdge: 1875, entryCharges: 0, estimatedExitCharges: 300, safetyBuffer: 0 }),
    1575,
  );
  assert.equal(
    projectedNetEdge({ grossEdge: 1875, entryCharges: 0, estimatedExitCharges: 0, safetyBuffer: 150 }),
    1725,
  );
});

test("17/18. ₹1,199 does not qualify and ₹1,200 does — measured on the GROSS spread", () => {
  const c = cfg();
  assert.equal(c.minGrossEdge, 1200, "the shipped gate must be ₹1,200 gross");
  assert.equal(c.minNetEdge, 0, "and no net floor by default — fees are managed by hand");

  assert.equal(qualifiesForEntry(1199, null, c), false);
  assert.equal(qualifiesForEntry(1199.99, null, c), false);
  assert.equal(qualifiesForEntry(1200, null, c), true);
  assert.equal(qualifiesForEntry(1200.01, null, c), true);
  assert.equal(qualifiesForEntry(null, null, c), false, "no edge, no trade");
});

test("fees do NOT raise the bar the spread has to clear", () => {
  const c = cfg();
  // ₹1,200 gross with ₹300 of charges and the ₹150 buffer nets only ₹750 — and
  // that is fine: the gate is the spread, the net figure is for the record.
  const net = projectedNetEdge({
    grossEdge: 1200,
    entryCharges: 150,
    estimatedExitCharges: 150,
    safetyBuffer: 150,
  });
  assert.equal(net, 750);
  assert.equal(qualifiesForEntry(1200, net, c), true, "₹1,200 of spread qualifies");

  // Even a box whose net edge is NEGATIVE still qualifies on the spread alone,
  // because the operator has said they will manage the fees themselves.
  const negative = projectedNetEdge({
    grossEdge: 1250,
    entryCharges: 800,
    estimatedExitCharges: 800,
    safetyBuffer: 150,
  });
  assert.ok(negative < 0);
  assert.equal(qualifiesForEntry(1250, negative, c), true);
});

test("an OPTIONAL net floor can be switched on, and then it does bind", () => {
  const floored = cfg({ minNetEdge: 1200 });
  // ₹1,650 gross - ₹300 charges - ₹150 buffer = exactly ₹1,200 net.
  const ok = projectedNetEdge({
    grossEdge: 1650,
    entryCharges: 150,
    estimatedExitCharges: 150,
    safetyBuffer: 150,
  });
  assert.equal(ok, 1200);
  assert.equal(qualifiesForEntry(1650, ok, floored), true);

  const short = projectedNetEdge({
    grossEdge: 1649,
    entryCharges: 150,
    estimatedExitCharges: 150,
    safetyBuffer: 150,
  });
  assert.equal(short, 1199);
  assert.equal(qualifiesForEntry(1649, short, floored), false);
  // With a floor configured, an unpriced box cannot satisfy it.
  assert.equal(qualifiesForEntry(5000, null, floored), false);
  // …whereas with the default (no floor) an unpriced box still clears the gate.
  assert.equal(qualifiesForEntry(5000, null, cfg()), true);
});

test("the local prefilter never discards a box that could still qualify", () => {
  const c = cfg();
  const threshold = prefilterGrossThreshold(c);
  // Gross-only gate → the prefilter IS the gross requirement.
  assert.equal(threshold, 1200);
  assert.equal(passesGrossPrefilter(threshold, threshold), true);
  assert.equal(passesGrossPrefilter(threshold - 1, threshold), false);
  assert.equal(passesGrossPrefilter(null, threshold), false);

  // With a net floor configured the prefilter has to reach further, using a
  // deliberate LOWER bound on charges so it cannot filter out a box that would
  // have qualified once real charges came back.
  const floored = cfg({ minNetEdge: 1200 });
  assert.equal(prefilterGrossThreshold(floored), 1200 + 150 + 160);
  assert.ok(floored.prefilterChargeAllowance <= 8 * 20 * 1.18 + 1);
});

/* -------------------------------------------------------------------- 21 --- */

test("21. the exit reverses every leg: the two longs sell, the two shorts buy", () => {
  assert.equal(exitSideFor("k1_ce"), "SELL");
  assert.equal(exitSideFor("k2_ce"), "BUY");
  assert.equal(exitSideFor("k2_pe"), "SELL");
  assert.equal(exitSideFor("k1_pe"), "BUY");
  for (const role of BOX_LEG_ROLES) {
    assert.notEqual(exitSideFor(role), BOX_ENTRY_SIDES[role]);
  }

  const { candidate } = goodCandidate();
  const quotes = quotesFor(candidate, {}, { at: NOW });
  const legs = evaluateExitLegs({
    legs: BOX_LEG_ROLES.map((role) => ({ role, inst: candidate.legs[role] })),
    quotes,
    lotSize: LOT,
    now: NOW,
    maxAgeMs: 1500,
  });
  const byRole = new Map(legs.map((l) => [l.role, l]));
  // Selling K1 CE takes the BID (299), buying K2 CE back pays the ASK (221).
  assert.equal(byRole.get("k1_ce").side, "SELL");
  assert.equal(byRole.get("k1_ce").price, 299);
  assert.equal(byRole.get("k2_ce").side, "BUY");
  assert.equal(byRole.get("k2_ce").price, 221);
  assert.equal(byRole.get("k2_pe").side, "SELL");
  assert.equal(byRole.get("k2_pe").price, 199);
  assert.equal(byRole.get("k1_pe").side, "BUY");
  assert.equal(byRole.get("k1_pe").price, 106);
});

/* ---------------------------------------------------------------- 22 - 25 --- */

/** Exit metrics for a given exit box value, with the shipped defaults. */
function metricsFor(exitValuePerUnit, { entryCost = GOOD_BOX.costPerUnit, entryNetEdge = 1425, entryFees = 150, exitFees = 150, qty = 150 } = {}) {
  const { candidate } = goodCandidate();
  const quotes = exitQuotes(candidate, exitValuePerUnit, { at: NOW, qty });
  const legs = evaluateExitLegs({
    legs: BOX_LEG_ROLES.map((role) => ({ role, inst: candidate.legs[role] })),
    quotes,
    lotSize: LOT,
    now: NOW,
    maxAgeMs: 1500,
  });
  return computeExitMetrics({
    boxWidth: GOOD_BOX.width,
    lotSize: LOT,
    entryBoxCostPerUnit: entryCost,
    entryNetEdge,
    entryChargesTotal: entryFees,
    currentExitChargesTotal: exitFees,
    legs,
    now: NOW,
    cfg: cfg(),
  });
}

test("22. the convergence threshold is max(₹200, 20% of the original net edge)", () => {
  const c = cfg();
  assert.equal(convergenceThreshold(500, c), 200); // floor wins
  assert.equal(convergenceThreshold(1000, c), 200); // 20% == floor
  assert.equal(convergenceThreshold(1425, c), 285); // percentage wins
  assert.equal(convergenceThreshold(4000, c), 800);

  // remainingEdge = (width - exitValue) x lot, so it falls as the box converges.
  const m = metricsFor(198);
  assert.equal(m.exit_box_value_per_unit, 198);
  assert.equal(m.remaining_edge, (200 - 198) * LOT); // ₹150
  assert.equal(m.convergence_threshold, 285);
  assert.equal(m.gross_pnl_if_closed_now, (198 - 175) * LOT); // ₹1,725
  assert.equal(m.total_round_trip_charges, 300);
  assert.equal(m.current_net_pnl, 1725 - 300); // ₹1,425
  assert.equal(m.exit_eligible, true);
  assert.equal(m.exit_reason, "EDGE_CONVERGED");
});

test("23. convergence NEVER closes a box whose net P&L is zero or negative", () => {
  // A converged box (remaining ₹150 <= ₹285) that is nonetheless under water,
  // because it was entered at a worse cost than it can be unwound at.
  const m = metricsFor(198, { entryCost: 199 });
  assert.equal(m.remaining_edge, 150);
  assert.ok(m.remaining_edge <= m.convergence_threshold, "the raw spread HAS converged");
  assert.equal(m.gross_pnl_if_closed_now, (198 - 199) * LOT); // -₹75
  assert.equal(m.current_net_pnl, -75 - 300); // -₹375
  assert.equal(m.exit_eligible, false, "must not exit at a loss");
  assert.equal(m.exit_reason, null);

  // Exactly break-even is also refused: the rule is strictly positive.
  const flat = metricsFor(198, { entryCost: 198, entryFees: 0, exitFees: 0 });
  assert.equal(flat.current_net_pnl, 0);
  assert.equal(flat.exit_eligible, false);
});

test("24. a normal convergence exit also requires at least ₹600 of net profit", () => {
  // Converged (₹150 <= ₹285) and profitable, but only ₹225 net.
  const thin = metricsFor(198, { entryCost: 191 });
  assert.equal(thin.remaining_edge, 150);
  assert.equal(thin.gross_pnl_if_closed_now, (198 - 191) * LOT); // ₹525
  assert.equal(thin.current_net_pnl, 225);
  assert.equal(thin.min_exit_net_pnl, 600);
  assert.equal(thin.exit_eligible, false, "₹225 is not worth the round trip");

  // Nudge it over ₹600 and the same box becomes eligible.
  const ok = metricsFor(198, { entryCost: 186 });
  assert.equal(ok.current_net_pnl, (198 - 186) * LOT - 300); // ₹600
  assert.ok(ok.current_net_pnl >= 600);
  assert.equal(ok.exit_eligible, true);
  assert.equal(ok.exit_reason, "EDGE_CONVERGED");
});

test("25. capturing 75% of the original net edge is reason enough to exit", () => {
  // entryNetEdge ₹1,000 → threshold ₹200, capture target ₹750.
  const m = metricsFor(190, { entryNetEdge: 1000 });
  assert.equal(m.remaining_edge, (200 - 190) * LOT); // ₹750
  assert.equal(m.convergence_threshold, 200);
  assert.ok(m.remaining_edge > m.convergence_threshold, "the edge has NOT converged");
  assert.equal(m.profit_capture_target, 750);
  assert.equal(m.current_net_pnl, (190 - 175) * LOT - 300); // ₹825
  assert.equal(m.exit_eligible, true);
  assert.equal(m.exit_reason, "PROFIT_CAPTURE", "profit capture stands on its own");

  // Just under the target, with the edge unconverged, nothing fires.
  const under = metricsFor(189, { entryNetEdge: 1000 });
  assert.equal(under.current_net_pnl, (189 - 175) * LOT - 300); // ₹750
  assert.equal(under.exit_eligible, true); // exactly at 75% qualifies
  const wellUnder = metricsFor(186, { entryNetEdge: 1000 });
  assert.ok(wellUnder.current_net_pnl < 750);
  assert.equal(wellUnder.exit_eligible, false);
});

test("an exit is never eligible while a reversed leg lacks fresh one-lot liquidity", () => {
  // Same converged, profitable box — but only 40 lots' worth at the touch.
  const thin = metricsFor(198, { qty: 40 });
  assert.equal(thin.remaining_edge, 150);
  assert.ok(thin.current_net_pnl > 600);
  assert.equal(thin.liquidity_ok, false);
  assert.equal(thin.exit_eligible, false, "no exit without an executable market");
  assert.equal(thin.exit_reason, null);
  assert.equal(exitLiquidityOk(thin.legs), false);
  // …but the ARITHMETIC verdict is still reported, which is what lets the monitor
  // record EXIT_SKIPPED_LIQUIDITY instead of silently doing nothing.
  assert.equal(thin.rule_reason, "EDGE_CONVERGED");

  const good = metricsFor(198, { qty: 150 });
  assert.equal(good.liquidity_ok, true);
  assert.equal(good.rule_reason, "EDGE_CONVERGED");
  assert.equal(good.exit_eligible, true);
  assert.equal(good.exit_reason, "EDGE_CONVERGED");
  assert.equal(exitLiquidityOk(good.legs), true);
});

test("a box with no reason to close reports no rule verdict either", () => {
  const m = metricsFor(180, { entryNetEdge: 1425 });
  assert.equal(m.rule_reason, null);
  assert.equal(m.exit_eligible, false);
  assert.equal(m.exit_reason, null);
});

test("exit arithmetic is unavailable, not guessed, when charges cannot be priced", () => {
  const m = metricsFor(198, { exitFees: null });
  assert.equal(m.gross_pnl_if_closed_now, 1725);
  assert.equal(m.total_round_trip_charges, null);
  assert.equal(m.current_net_pnl, null);
  assert.equal(m.exit_eligible, false, "an unpriced round trip can never auto-exit");
});


/* --------------------------- market-closed view --------------------------- */

test("the last-close view reports the spread but is never tradable", () => {
  const { candidate } = goodCandidate();
  // Closing prices only — no bid, no ask, no depth anywhere.
  const lastPrices = new Map([
    [candidate.legs.k1_ce.token, 300],
    [candidate.legs.k2_ce.token, 220],
    [candidate.legs.k2_pe.token, 200],
    [candidate.legs.k1_pe.token, 105],
  ]);
  const ev = evaluateCandidateIndicative({ candidate, lastPrices, now: NOW });

  // The economics are computed the same way, so a box that was mispriced at the
  // close is visible.
  assert.equal(ev.entry_box_cost_per_unit, 175);
  assert.equal(ev.gross_edge, GOOD_BOX.grossEdge);
  assert.equal(ev.gross_edge_per_unit, 25);

  // …but nothing about it is executable.
  assert.equal(ev.tradable, false, "a closing price is not an executable touch");
  assert.equal(ev.reject, "market_closed");
  assert.equal(ev.worst_age_ms, null);
  for (const leg of ev.legs) {
    assert.equal(leg.executable, false);
    assert.equal(leg.fresh, false);
    assert.equal(leg.qty_at_touch, 0);
    assert.equal(leg.bid, 0);
    assert.equal(leg.ask, 0);
    assert.equal(leg.quote_at, null);
  }
});

test("a missing closing price yields no indicative edge rather than a guess", () => {
  const { candidate } = goodCandidate();
  const lastPrices = new Map([
    [candidate.legs.k1_ce.token, 300],
    [candidate.legs.k2_ce.token, 220],
    // K2 PE never traded — no close to use.
    [candidate.legs.k1_pe.token, 105],
  ]);
  const ev = evaluateCandidateIndicative({ candidate, lastPrices, now: NOW });
  assert.equal(ev.entry_box_cost_per_unit, null);
  assert.equal(ev.gross_edge, null);
  assert.equal(ev.tradable, false);
  assert.equal(ev.reject, "no_quote");
});
