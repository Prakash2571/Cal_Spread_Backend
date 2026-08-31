/**
 * The execution simulator.
 *
 * paper_latency: detection → simulated delay → fill from the LATEST VALID book at
 * the simulated arrival (Task 2), NOT the first post-arrival tick — a resting book
 * that did not update is still valid.
 *
 * paper_legging: four independent orders that may partially fill and abort with an
 * emergency unwind (Task 4).
 *
 * The clock and the sleep are INJECTED so latency is exercised deterministically:
 * `wait(ms)` advances a fake clock and fires any queued "market" ticks that fall
 * due during the wait. The same recorded input always reproduces the same result.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxExecutionSimulator } from "../../dist/box/executionSimulator.js";
import { BoxMetrics } from "../../dist/box/metrics.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { evaluateCandidate, evaluateEntryDecision } from "../../dist/box/math.js";
import { GOOD_BOX, LOT, cfg, goodCandidate, quote, quotesFor, seedStore } from "./helpers.mjs";

/** A deterministic clock + scheduler. */
function fakeClock(t0 = 1_000_000) {
  let nowMs = t0;
  const pending = [];
  return {
    now: () => nowMs,
    at: (ms, fn) => pending.push({ when: t0 + ms, fn }),
    wait: async (ms) => {
      const target = nowMs + Math.max(0, ms);
      pending
        .filter((p) => p.when > nowMs && p.when <= target)
        .sort((a, b) => a.when - b.when)
        .forEach((p) => {
          nowMs = p.when;
          p.fn();
        });
      nowMs = target;
    },
    base: t0,
  };
}

// arrival = base + decision(20) + latency(200) = base + 220. "During latency"
// means a scheduled tick at, say, base + 100.
function build({ config = {}, marketOpen = true, feedHealthy = true, chargeTotal } = {}) {
  const { candidate } = goodCandidate();
  const conf = cfg({
    executionMode: "paper_latency",
    simulatedDecisionMs: 20,
    simulatedLatencyMs: 200,
    executionMaxWaitMs: 2000,
    executionPollMs: 10,
    ...config,
  });
  const clock = fakeClock();
  const quotes = new BoxQuoteStore();
  const flags = { market: marketOpen, feed: feedHealthy };
  // A real metrics instance so execution/legging counters can be asserted. Not
  // sampling (no timers) — snapshot() is read directly.
  const metrics = new BoxMetrics(conf.metricsWindow);
  const sim = new BoxExecutionSimulator({
    cfg: conf,
    quotes,
    isMarketOpen: () => flags.market,
    isFeedHealthy: () => flags.feed,
    now: clock.now,
    wait: clock.wait,
    chargeTotal: chargeTotal ?? (() => 0),
    metrics,
  });
  return { candidate, conf, clock, quotes, sim, flags, metrics };
}

function detect(b, overrides = {}, at = b.clock.base) {
  seedStore(b.quotes, quotesFor(b.candidate, overrides, { at }), at);
  return evaluateCandidate({ candidate: b.candidate, quotes: b.quotes.view(), now: b.clock.base, maxAgeMs: b.conf.quoteMaxAgeMs, captureDepth: false });
}

/** Push one leg's book at a given time (for scenario scripting). */
function pushLeg(b, role, spec, at) {
  const token = b.candidate.legs[role].token;
  const q = quote(token, { ...spec, at });
  b.quotes.applyTicks([{ token, last_price: q.last, bid: q.bid, ask: q.ask, bids: q.bids, asks: q.asks }], at);
}

/** FINAL qualification: executed gross already reflects movement, so the measured
 *  entry slippage is NOT deducted (Task 1) — only the exit allowance. */
function qualify(cfgObj) {
  return (execution, measuredSlippage) =>
    evaluateEntryDecision({
      grossEdge: execution.gross_edge,
      entryCharges: 150,
      estimatedExitCharges: 150,
      entrySlippageAllowance: 0,
      futureExitSlippageAllowance: 0,
      measuredEntrySlippage: measuredSlippage,
      cfg: { ...cfgObj, safetyBuffer: 150, minExpectedNetProfit: 1200, minGrossEdge: 1200, minNetEdge: 0 },
    });
}

/* ---------------------- paper_latency: arrival-book model ------------------ */

test("A. an unchanged, valid resting book fills at the simulated arrival (no new tick needed)", async () => {
  const b = build();
  const detection = detect(b); // seeded at base; nothing scheduled during latency
  const res = await b.sim.simulateEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(res.ok, true);
  assert.equal(res.record.total_slippage, 0, "a resting book fills at the same touch");
  assert.equal(res.record.decision_to_fill_ms, 220, "filled at arrival, not on a later tick");
  for (const leg of res.record.legs) assert.equal(leg.book_changed, false, "no book changed during latency");
});

test("B. an ADVERSE update DURING latency is used (new book at arrival)", async () => {
  const b = build();
  const detection = detect(b);
  // K1 CE ask worsens 300 → 301 at base+100, before arrival.
  b.clock.at(100, () => pushLeg(b, "k1_ce", { bid: 299, bidQty: 150, ask: 301, askQty: 150 }, b.clock.now()));
  const res = await b.sim.simulateEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(res.ok, true);
  const k1 = res.record.legs.find((l) => l.role === "k1_ce");
  assert.equal(k1.executed_price, 301);
  assert.equal(k1.slippage_per_unit, 1, "BUY 1 dearer");
  assert.equal(k1.book_changed, true);
  assert.equal(res.record.total_slippage, 1 * LOT);
});

test("C. a FAVOURABLE update during latency is used", async () => {
  const b = build();
  const detection = detect(b);
  b.clock.at(100, () => pushLeg(b, "k1_ce", { bid: 299, bidQty: 150, ask: 298, askQty: 150 }, b.clock.now()));
  const res = await b.sim.simulateEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(res.ok, true);
  const k1 = res.record.legs.find((l) => l.role === "k1_ce");
  assert.equal(k1.executed_price, 298);
  assert.equal(k1.slippage_per_unit, -2, "BUY 2 cheaper is favourable");
  assert.ok(res.record.total_slippage < 0);
});

test("D. a book that has gone too stale by arrival is rejected", async () => {
  // Trust window shorter than the latency, so the resting book is stale at arrival.
  const b = build({ config: { quoteMaxAgeMs: 100 } });
  const detection = evaluateCandidate({
    candidate: b.candidate,
    quotes: seedStore(b.quotes, quotesFor(b.candidate, {}, { at: b.clock.base }), b.clock.base) && b.quotes.view(),
    now: b.clock.base,
    maxAgeMs: 15_000,
    captureDepth: false,
  });
  const res = await b.sim.simulateEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "missing_book", "a stale book is not a usable book");
});

test("E. a feed that goes unhealthy during the delay is rejected", async () => {
  const b = build();
  const detection = detect(b);
  b.clock.at(100, () => { b.flags.feed = false; });
  const res = await b.sim.simulateEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "feed_unhealthy");
});

test("F. quantity disappearing during latency is rejected as insufficient", async () => {
  const b = build();
  const detection = detect(b);
  // K2 CE (a SELL leg → bid) shows only 40 lots at arrival.
  b.clock.at(100, () => pushLeg(b, "k2_ce", { bid: 220, bidQty: 40, ask: 221, askQty: 150 }, b.clock.now()));
  const res = await b.sim.simulateEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "insufficient_quantity");
});

test("G. one leg updates while three rest — the changed leg AND the valid resting books are used", async () => {
  const b = build();
  const detection = detect(b);
  b.clock.at(100, () => pushLeg(b, "k1_ce", { bid: 299, bidQty: 150, ask: 301, askQty: 150 }, b.clock.now()));
  const res = await b.sim.simulateEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(res.ok, true);
  const changed = res.record.legs.filter((l) => l.book_changed);
  const resting = res.record.legs.filter((l) => !l.book_changed);
  assert.equal(changed.length, 1, "only the updated leg changed");
  assert.equal(resting.length, 3, "the other three filled from their valid resting books");
  assert.equal(res.record.legs.find((l) => l.role === "k1_ce").executed_price, 301);
  assert.equal(res.record.legs.find((l) => l.role === "k2_ce").executed_price, 220);
});

test("an adverse move that pushes expected net below the gate is not filled", async () => {
  const b = build();
  const detection = detect(b);
  // Big adverse jump during latency → gross falls, net < ₹1,200.
  b.clock.at(100, () => pushLeg(b, "k1_ce", { bid: 299, bidQty: 150, ask: 360, askQty: 150 }, b.clock.now()));
  const res = await b.sim.simulateEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(res.ok, false);
  assert.ok(["below_expected_net_profit", "edge_disappeared"].includes(res.reason));
});

test("paper_touch fills immediately at the detection book with no latency", async () => {
  const b = build({ config: { executionMode: "paper_touch" } });
  const detection = detect(b);
  const res = await b.sim.simulateEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(res.ok, true);
  assert.equal(res.record.mode, "paper_touch");
  assert.equal(res.record.decision_to_fill_ms, 0);
});

/* ------------------------------- paper_legging ----------------------------- */

/** ₹20 per order, flat — enough to prove charges enter the legging loss. */
const flatCharge = (orders) => 20 * orders.length;

function leggingBuild(over = {}) {
  return build({ config: { executionMode: "paper_legging", ...over }, chargeTotal: flatCharge });
}

test("legging 4/4: all legs fill and a box is opened", async () => {
  const b = leggingBuild();
  const detection = detect(b);
  const res = await b.sim.simulateLeggingEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(res.ok, true);
  assert.equal(res.legging.filled_leg_count, 4);
  assert.equal(res.legging.opened, true);
  assert.equal(res.legging.emergency_unwind, false);
  assert.equal(res.legging.legging_net_loss, null, "a clean open has no legging loss");
  assert.equal(res.legging.legs.filter((l) => l.status === "FILLED").length, 4);
});

test("legging 3/4: one leg fails, the filled three are emergency-unwound and the loss is booked", async () => {
  const b = leggingBuild();
  const detection = detect(b);
  // K1 PE (a SELL leg → needs a bid) shows no bid at arrival → that leg fails.
  b.clock.at(100, () => pushLeg(b, "k1_pe", { bid: 0, bidQty: 0, ask: 106, askQty: 150 }, b.clock.now()));
  const res = await b.sim.simulateLeggingEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(res.ok, false);
  assert.equal(res.legging.filled_leg_count, 3);
  assert.deepEqual(res.legging.failed_legs, ["k1_pe"]);
  assert.equal(res.legging.emergency_unwind, true);
  assert.ok(res.legging.partial_entry_charges > 0);
  assert.ok(res.legging.unwind_charges > 0);
  assert.ok(res.legging.legging_gross_loss <= 0, "unwinding a partial fill loses the spread");
  assert.ok(res.legging.legging_net_loss < res.legging.legging_gross_loss, "charges deepen the loss");
  assert.equal(res.legging.legs.filter((l) => l.status === "UNWOUND").length, 3);
});

test("legging 2/4 and 1/4 both abort and book a loss", async () => {
  for (const [failRoles, expectFilled] of [
    [["k1_pe", "k2_ce"], 2],
    [["k1_pe", "k2_ce", "k2_pe"], 1],
  ]) {
    const b = leggingBuild();
    const detection = detect(b);
    b.clock.at(100, () => {
      for (const role of failRoles) {
        // SELL legs need a bid; BUY legs need an ask. Kill the needed side.
        const isSell = ["k2_ce", "k1_pe"].includes(role);
        pushLeg(b, role, isSell ? { bid: 0, bidQty: 0, ask: 999, askQty: 150 } : { bid: 1, bidQty: 150, ask: 0, askQty: 0 }, b.clock.now());
      }
    });
    const res = await b.sim.simulateLeggingEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
    assert.equal(res.ok, false);
    assert.equal(res.legging.filled_leg_count, expectFilled, `expected ${expectFilled}/4`);
    assert.equal(res.legging.emergency_unwind, true);
    assert.ok(res.legging.legging_net_loss <= 0);
  }
});

test("legging 0/4: nothing fills, so there is no legging loss", async () => {
  const b = leggingBuild();
  const detection = detect(b);
  // Every leg loses its needed side at arrival.
  b.clock.at(100, () => {
    pushLeg(b, "k1_ce", { bid: 299, bidQty: 150, ask: 0, askQty: 0 }, b.clock.now());
    pushLeg(b, "k2_pe", { bid: 199, bidQty: 150, ask: 0, askQty: 0 }, b.clock.now());
    pushLeg(b, "k2_ce", { bid: 0, bidQty: 0, ask: 221, askQty: 150 }, b.clock.now());
    pushLeg(b, "k1_pe", { bid: 0, bidQty: 0, ask: 106, askQty: 150 }, b.clock.now());
  });
  const res = await b.sim.simulateLeggingEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(res.ok, false);
  assert.equal(res.legging.filled_leg_count, 0);
  assert.equal(res.legging.emergency_unwind, false);
  assert.equal(res.legging.legging_net_loss, null, "no exposure taken → no loss");
});

test("legging unwind_failed: a filled leg cannot be unwound because the opposite touch is gone", async () => {
  const b = leggingBuild();
  const detection = detect(b);
  // K1 CE fills as a BUY (ask present), but its unwind SELL needs a bid; remove
  // the bid at the unwind instant. Also fail one other leg so the box aborts.
  b.clock.at(100, () => pushLeg(b, "k2_ce", { bid: 0, bidQty: 0, ask: 221, askQty: 150 }, b.clock.now())); // k2_ce fails
  // At the unwind (arrival + unwind latency), k1_ce loses its bid.
  b.clock.at(300, () => pushLeg(b, "k1_ce", { bid: 0, bidQty: 0, ask: 300, askQty: 150 }, b.clock.now()));
  const res = await b.sim.simulateLeggingEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "unwind_failed");
  assert.ok(res.legging.legs.some((l) => l.fail_reason && l.fail_reason.includes("unwind")));
});

test("legging handles a SHORT box (mirrored sides) without sign errors", async () => {
  const { candidate } = goodCandidate();
  const shortCand = { ...candidate, direction: "SHORT_BOX" };
  const b = leggingBuild();
  b.candidate = shortCand;
  const detection = detect(b);
  const res = await b.sim.simulateLeggingEntry({ candidate: shortCand, detection, qualify: qualify(b.conf) });
  // Whether it opens or aborts, the per-leg sides are the SHORT mirror.
  const byRole = new Map(res.legging.legs.map((l) => [l.role, l.side]));
  assert.equal(byRole.get("k1_ce"), "SELL");
  assert.equal(byRole.get("k2_ce"), "BUY");
  assert.equal(byRole.get("k2_pe"), "SELL");
  assert.equal(byRole.get("k1_pe"), "BUY");
});

/* --------------------------------- replay ---------------------------------- */

test("REPLAY: the same recorded ticks reproduce the exact same execution result", async () => {
  const run = async (mode) => {
    const b = build({ config: { executionMode: mode }, chargeTotal: flatCharge });
    const detection = detect(b);
    b.clock.at(100, () => pushLeg(b, "k1_ce", { bid: 299, bidQty: 150, ask: 301, askQty: 150 }, b.clock.now()));
    return mode === "paper_legging"
      ? b.sim.simulateLeggingEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) })
      : b.sim.simulateEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  };
  const a = await run("paper_latency");
  const c = await run("paper_latency");
  assert.equal(a.ok, c.ok);
  assert.equal(a.record.total_slippage, c.record.total_slippage);
  assert.equal(a.record.decision_to_fill_ms, c.record.decision_to_fill_ms);

  const l1 = await run("paper_legging");
  const l2 = await run("paper_legging");
  assert.equal(l1.ok, l2.ok);
  assert.equal(l1.legging.filled_leg_count, l2.legging.filled_leg_count);
});

test("REPLAY: a 3/4 abort is reproduced deterministically with the same loss", async () => {
  const run = async () => {
    const b = leggingBuild();
    const detection = detect(b);
    b.clock.at(100, () => pushLeg(b, "k1_pe", { bid: 0, bidQty: 0, ask: 106, askQty: 150 }, b.clock.now()));
    return b.sim.simulateLeggingEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  };
  const a = await run();
  const c = await run();
  assert.equal(a.legging.filled_leg_count, 3);
  assert.equal(a.legging.filled_leg_count, c.legging.filled_leg_count);
  assert.equal(a.legging.legging_net_loss, c.legging.legging_net_loss);
  assert.deepEqual(a.legging.failed_legs, c.legging.failed_legs);
});


/* -------------------- paper_legging: ABORT AFTER A 4/4 FILL ----------------- */

/**
 * The dangerous edge case: all four orders FILL, but the economics computed on
 * the executed prices no longer clear the gate.
 *
 * We cannot pretend the entry was simply refused — the orders really filled, so a
 * complete box briefly existed. It must be reversed immediately and the true cost
 * of that round trip booked, with NO box opened.
 */

/** A qualifier whose gate/charges can be tuned to force a specific verdict. */
function qualifyWith(cfgObj, { entryCharges = 150, exitCharges = 150, min = 1200 } = {}) {
  return (execution, measuredSlippage) =>
    evaluateEntryDecision({
      grossEdge: execution.gross_edge,
      entryCharges,
      estimatedExitCharges: exitCharges,
      entrySlippageAllowance: 0,
      futureExitSlippageAllowance: 0,
      measuredEntrySlippage: measuredSlippage,
      cfg: { ...cfgObj, safetyBuffer: 150, minExpectedNetProfit: min, minGrossEdge: 1200, minNetEdge: 0 },
    });
}

test("4/4 filled + still qualifies: the box opens and nothing is unwound", async () => {
  const b = leggingBuild();
  const detection = detect(b);
  const res = await b.sim.simulateLeggingEntry({
    candidate: b.candidate,
    detection,
    qualify: qualifyWith(b.conf), // net 1425 >= 1200
  });
  assert.equal(res.ok, true);
  assert.equal(res.legging.opened, true);
  assert.equal(res.legging.abort_after_fill, false);
  assert.equal(res.legging.emergency_unwind, false);
  // The executed economics are recorded even on a clean open, for analytics.
  assert.equal(res.legging.final_expected_net_profit, 1425);
  assert.equal(res.legging.required_expected_net_profit, 1200);
});

test("4/4 filled but the executed net falls below the gate: abort after fill, all four reversed, no box", async () => {
  const b = leggingBuild();
  const detection = detect(b);
  // Charges make the executed net ₹675 — a real fill that no longer qualifies.
  const res = await b.sim.simulateLeggingEntry({
    candidate: b.candidate,
    detection,
    qualify: qualifyWith(b.conf, { entryCharges: 900 }),
  });

  assert.equal(res.ok, false, "no box may be opened");
  assert.equal(res.reason, "abort_after_fill");
  assert.equal(res.legging.abort_after_fill, true);
  assert.equal(res.legging.opened, false);
  assert.equal(res.legging.filled_leg_count, 4, "all four really did fill");
  assert.deepEqual(res.legging.failed_legs, [], "no leg failed — the economics did");
  assert.equal(res.legging.final_expected_net_profit, 675);
  assert.equal(res.legging.required_expected_net_profit, 1200);

  // The whole box was reversed, and that cost real money.
  assert.equal(res.legging.emergency_unwind, true);
  assert.equal(res.legging.legs.filter((l) => l.status === "UNWOUND").length, 4);
  assert.ok(res.legging.partial_entry_charges > 0, "the four entry fills were charged");
  assert.ok(res.legging.unwind_charges > 0, "the four reversals were charged");
  assert.ok(res.legging.legging_gross_loss <= 0, "crossing the spread both ways loses money");
  assert.ok(
    res.legging.legging_net_loss < res.legging.legging_gross_loss,
    "charges deepen the abort loss",
  );
});

test("4/4 filled but the executed net is NEGATIVE: still aborts, and the loss is booked", async () => {
  const b = leggingBuild();
  const detection = detect(b);
  const res = await b.sim.simulateLeggingEntry({
    candidate: b.candidate,
    detection,
    qualify: qualifyWith(b.conf, { entryCharges: 2000 }), // net = -425
  });
  assert.equal(res.ok, false);
  assert.equal(res.legging.abort_after_fill, true);
  assert.equal(res.legging.final_expected_net_profit, -425);
  assert.ok(res.legging.legging_net_loss < 0, "an abort always costs money");
});

test("4/4 filled, edge destroyed in flight: the executed prices are what qualification sees", async () => {
  const b = leggingBuild();
  const detection = detect(b);
  // During the latency the box gets much more expensive to buy, but every leg is
  // still executable — so all four fill and the GROSS edge itself is gone.
  b.clock.at(100, () => {
    pushLeg(b, "k1_ce", { bid: 399, bidQty: 150, ask: 400, askQty: 150 }, b.clock.now());
  });
  const res = await b.sim.simulateLeggingEntry({
    candidate: b.candidate,
    detection,
    qualify: qualifyWith(b.conf),
  });
  assert.equal(res.ok, false, "a decayed dislocation must not open a box");
  assert.equal(res.legging.filled_leg_count, 4);
  assert.equal(res.legging.abort_after_fill, true);
  assert.ok(
    res.legging.final_expected_net_profit < 1200,
    `executed net should have collapsed (got ${res.legging.final_expected_net_profit})`,
  );
});

test("abort-after-fill whose unwind partially fails is reported as unwind_failed, not a clean abort", async () => {
  const b = leggingBuild();
  const detection = detect(b);
  // All four fill at arrival (base + 220). Then K1 CE loses its BID, so the leg
  // that must be SOLD to reverse the position has no opposite touch at unwind.
  b.clock.at(300, () => {
    pushLeg(b, "k1_ce", { bid: 0, bidQty: 0, ask: 300, askQty: 150 }, b.clock.now());
  });
  const res = await b.sim.simulateLeggingEntry({
    candidate: b.candidate,
    detection,
    qualify: qualifyWith(b.conf, { entryCharges: 900 }),
  });

  assert.equal(res.ok, false);
  assert.equal(res.legging.abort_after_fill, true, "it is still an abort-after-fill");
  assert.equal(res.reason, "unwind_failed", "a stranded leg is the more serious condition");
  const stranded = res.legging.legs.filter((l) => l.status === "UNWIND_FAILED");
  assert.equal(stranded.length, 1, "the un-reversible leg must stay visible");
  assert.equal(stranded[0].role, "k1_ce");
  assert.ok(stranded[0].fail_reason.includes("unwind"));
  // The legs that could be reversed still were.
  assert.equal(res.legging.legs.filter((l) => l.status === "UNWOUND").length, 3);
});

test("an aborted 4/4 is counted as an abort, never as a successful fill", async () => {
  const b = leggingBuild();
  const detection = detect(b);
  await b.sim.simulateLeggingEntry({
    candidate: b.candidate,
    detection,
    qualify: qualifyWith(b.conf, { entryCharges: 900 }),
  });
  const snap = b.metrics.snapshot();
  assert.equal(snap.legging.outcomes["4_of_4"], 0, "must NOT inflate the 4/4 fill rate");
  assert.equal(snap.legging.outcomes.abort_after_fill, 1);
  assert.ok(snap.legging.outcomes.aborts >= 1);
  assert.equal(snap.execution.filled, 0, "no fill was achieved");
});
