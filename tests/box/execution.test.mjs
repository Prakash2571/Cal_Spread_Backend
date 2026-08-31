/**
 * The execution simulator (paper_latency): detection → simulated delay → fill
 * from the first post-arrival WebSocket book.
 *
 * The clock and the sleep are INJECTED, so latency is exercised deterministically
 * without real timers: `wait(ms)` advances a fake clock and lets any queued
 * "market" ticks land at the right simulated time.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxExecutionSimulator } from "../../dist/box/executionSimulator.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { evaluateCandidate, evaluateEntryDecision } from "../../dist/box/math.js";
import { GOOD_BOX, LOT, cfg, goodCandidate, quotesFor, seedStore } from "./helpers.mjs";

/**
 * A deterministic clock + scheduler. `at(ms, fn)` runs fn when the fake clock
 * reaches `t0 + ms`; `wait(ms)` fast-forwards, firing any due scheduled events.
 */
function fakeClock(t0 = 1_000_000) {
  let nowMs = t0;
  const pending = [];
  return {
    now: () => nowMs,
    at: (ms, fn) => pending.push({ when: t0 + ms, fn }),
    wait: async (ms) => {
      const target = nowMs + Math.max(0, ms);
      // Fire everything due up to the target, in order.
      pending
        .filter((p) => p.when > nowMs && p.when <= target)
        .sort((a, b) => a.when - b.when)
        .forEach((p) => {
          nowMs = p.when;
          p.fn();
        });
      nowMs = target;
    },
    set t0(v) {},
    base: t0,
  };
}

function build({ config = {}, marketOpen = true, feedHealthy = true } = {}) {
  const { candidate } = goodCandidate();
  const conf = cfg({ executionMode: "paper_latency", simulatedDecisionMs: 20, simulatedLatencyMs: 200, executionMaxWaitMs: 2000, executionPollMs: 10, ...config });
  const clock = fakeClock();
  const quotes = new BoxQuoteStore();
  const sim = new BoxExecutionSimulator({
    cfg: conf,
    quotes,
    isMarketOpen: () => marketOpen,
    isFeedHealthy: () => feedHealthy,
    now: clock.now,
    wait: clock.wait,
  });
  return { candidate, conf, clock, quotes, sim };
}

/** The detection snapshot at the clock's base time. */
function detect(b, overrides = {}) {
  seedStore(b.quotes, quotesFor(b.candidate, overrides, { at: b.clock.base }), b.clock.base);
  return evaluateCandidate({ candidate: b.candidate, quotes: b.quotes.view(), now: b.clock.base, maxAgeMs: b.conf.quoteMaxAgeMs, captureDepth: false });
}

/** A qualify function using flat ₹150-a-side charges and no buffer/slippage. */
function qualify(cfgObj) {
  return (execution, slippage) =>
    evaluateEntryDecision({
      grossEdge: execution.gross_edge,
      entryCharges: 150,
      estimatedExitCharges: 150,
      executionCost: Math.max(0, slippage),
      cfg: { ...cfgObj, safetyBuffer: 150, minExpectedNetProfit: 1200, minGrossEdge: 1200, minNetEdge: 0 },
    });
}

test("zero price movement fills at the detected touch with zero slippage", async () => {
  const b = build();
  const detection = detect(b);
  // The same book is re-published just after arrival (t0 + 20 + 200 = +220).
  b.clock.at(230, () => seedStore(b.quotes, quotesFor(b.candidate, {}, { at: b.clock.now() }), b.clock.now()));
  const res = await b.sim.simulateEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(res.ok, true);
  assert.equal(res.record.total_slippage, 0);
  // The fill is stamped at the moment the post-arrival book actually landed
  // (t0 + 230), never before the simulated arrival (t0 + 220).
  assert.equal(res.record.decision_to_fill_ms, 230);
  assert.equal(res.record.simulated_latency_ms, 200);
  assert.equal(res.evaluation.gross_edge, GOOD_BOX.grossEdge);
});

test("a FAVOURABLE post-latency move fills at a better price (negative slippage)", async () => {
  const b = build();
  const detection = detect(b);
  // K1 CE ask drops 300 → 298 after arrival: a BUY leg fills cheaper.
  b.clock.at(230, () => seedStore(b.quotes, quotesFor(b.candidate, { k1_ce: { ask: 298, askQty: 150 } }, { at: b.clock.now() }), b.clock.now()));
  const res = await b.sim.simulateEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(res.ok, true);
  assert.ok(res.record.total_slippage < 0, "a favourable move is negative slippage");
  const k1ce = res.record.legs.find((l) => l.role === "k1_ce");
  assert.equal(k1ce.executed_price, 298);
  assert.equal(k1ce.slippage_per_unit, -2); // BUY 2 cheaper
});

test("an ADVERSE post-latency move still fills when it clears the gate, recording the slippage", async () => {
  const b = build();
  const detection = detect(b);
  // K1 CE ask rises 300 → 301: slightly worse, but the box still clears ₹1,200
  // net (gross falls to (200-176)x75 = ₹1,800; net 1800-300-75-150 = ₹1,275).
  b.clock.at(230, () => seedStore(b.quotes, quotesFor(b.candidate, { k1_ce: { ask: 301, askQty: 150 } }, { at: b.clock.now() }), b.clock.now()));
  const res = await b.sim.simulateEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(res.ok, true);
  const k1ce = res.record.legs.find((l) => l.role === "k1_ce");
  assert.equal(k1ce.slippage_per_unit, 1); // BUY 1 dearer
  assert.equal(res.record.total_slippage, 1 * LOT);
});

test("an adverse move that pushes expected net below the gate is NOT filled", async () => {
  const b = build();
  const detection = detect(b);
  // K1 CE ask jumps to 360: gross falls to (200 - 235) → negative-ish; net < 1200.
  b.clock.at(230, () => seedStore(b.quotes, quotesFor(b.candidate, { k1_ce: { ask: 360, askQty: 150 } }, { at: b.clock.now() }), b.clock.now()));
  const res = await b.sim.simulateEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(res.ok, false);
  assert.ok(["below_expected_net_profit", "edge_disappeared"].includes(res.reason));
});

test("insufficient quantity after the latency window is not filled", async () => {
  const b = build();
  const detection = detect(b);
  // Post-arrival the K2 CE bid only shows 40 lots at the touch.
  b.clock.at(230, () => seedStore(b.quotes, quotesFor(b.candidate, { k2_ce: { bidQty: 40 } }, { at: b.clock.now() }), b.clock.now()));
  const res = await b.sim.simulateEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "insufficient_quantity");
});

test("a MISSING post-arrival book for a leg is never invented into a fill", async () => {
  const b = build();
  const detection = detect(b);
  // Only three legs re-publish after arrival; k1_pe stays at its detection book.
  b.clock.at(230, () => {
    const at = b.clock.now();
    for (const role of ["k1_ce", "k2_ce", "k2_pe"]) {
      const inst = b.candidate.legs[role];
      const q = quotesFor(b.candidate, {}, { at }).get(inst.token);
      b.quotes.applyTicks([{ token: inst.token, last_price: q.last, bid: q.bid, ask: q.ask, bids: q.bids, asks: q.asks }], at);
    }
  });
  const res = await b.sim.simulateEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "missing_book");
});

test("a dead feed during the delay aborts the fill", async () => {
  let healthy = true;
  const { candidate } = goodCandidate();
  const conf = cfg({ executionMode: "paper_latency", simulatedDecisionMs: 20, simulatedLatencyMs: 200, executionMaxWaitMs: 2000, executionPollMs: 10 });
  const clock = fakeClock();
  const quotes = new BoxQuoteStore();
  const sim = new BoxExecutionSimulator({ cfg: conf, quotes, isMarketOpen: () => true, isFeedHealthy: () => healthy, now: clock.now, wait: clock.wait });
  seedStore(quotes, quotesFor(candidate, {}, { at: clock.base }), clock.base);
  const detection = evaluateCandidate({ candidate, quotes: quotes.view(), now: clock.base, maxAgeMs: conf.quoteMaxAgeMs });
  clock.at(100, () => { healthy = false; });
  clock.at(230, () => seedStore(quotes, quotesFor(candidate, {}, { at: clock.now() }), clock.now()));
  const res = await sim.simulateEntry({ candidate, detection, qualify: qualify(conf) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "feed_unhealthy");
});

test("the edge disappearing during the delay is reported as such", async () => {
  const b = build();
  const detection = detect(b);
  // Post-arrival the box costs its full width (no edge left): all legs move so
  // cost == width → gross 0.
  b.clock.at(230, () =>
    seedStore(
      b.quotes,
      quotesFor(b.candidate, { k1_ce: { ask: 325, askQty: 150 } }, { at: b.clock.now() }),
      b.clock.now(),
    ),
  );
  const res = await b.sim.simulateEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(res.ok, false);
  assert.ok(["edge_disappeared", "below_expected_net_profit"].includes(res.reason));
});

test("a duplicate execution pipeline for the same candidate is refused", async () => {
  const b = build();
  const detection = detect(b);
  b.clock.at(230, () => seedStore(b.quotes, quotesFor(b.candidate, {}, { at: b.clock.now() }), b.clock.now()));
  const first = b.sim.simulateEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  const second = await b.sim.simulateEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "duplicate");
  await first; // let the first pipeline settle
});

test("paper_touch fills immediately at the detection book (no latency wait)", async () => {
  const b = build({ config: { executionMode: "paper_touch" } });
  const detection = detect(b);
  const res = await b.sim.simulateEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(res.ok, true);
  assert.equal(res.record.mode, "paper_touch");
  assert.equal(res.record.total_slippage, 0);
  assert.equal(res.record.decision_to_fill_ms, 0);
});

test("REPLAY HARNESS: recorded tick batches drive the store → scanner path with no live feed", () => {
  // The store's replay() seam feeds recorded batches through the exact same code
  // path a live socket would, notifying observers — the basis of a deterministic
  // backtest without Zerodha.
  const store = new BoxQuoteStore();
  const seen = [];
  const off = store.subscribe((changed, at) => seen.push({ changed: [...changed], at }));
  const batch = [
    { token: 1000, last_price: 300, bid: 299, ask: 300, bids: [{ price: 299, qty: 150, orders: 1 }], asks: [{ price: 300, qty: 150, orders: 1 }] },
  ];
  const changed = store.replay(batch, 5_000);
  assert.deepEqual(changed, [1000]);
  assert.equal(store.get(1000).at, 5_000);
  assert.equal(seen.length, 1, "observers are notified exactly as for a live tick");
  assert.deepEqual(seen[0].changed, [1000]);
  off();
  store.replay(batch, 6_000);
  assert.equal(seen.length, 1, "unsubscribing stops notifications (bounded observers)");
});
