/**
 * paper_legging FILL MECHANICS — depth walking, partial fills that consume future
 * liquidity, timeouts on a partial, the queue haircut, four-leg exchange-timestamp
 * coherence, the independent-order EXIT, and residual exposure.
 *
 * Deterministic throughout: an injected clock whose sleeps fire scripted depth
 * packets, applied to a REAL BoxQuoteStore so the executor's subscription wakes
 * pending orders at the tick's own timestamp.
 *
 * Timeline (base = clock origin): detection base, submit base+20, arrival base+220,
 * deadline base+720.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxExecutionSimulator } from "../../dist/box/executionSimulator.js";
import { BoxMetrics } from "../../dist/box/metrics.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { evaluateCandidate, evaluateEntryDecision, evaluateExitLegs } from "../../dist/box/math.js";
import { GOOD_BOX, LOT, cfg, goodCandidate, positionFrom, quotesFor, seedStore } from "./helpers.mjs";

const DECISION = 20;
const LATENCY = 200;
const TIMEOUT = 500;
const ARRIVAL = DECISION + LATENCY; // 220
const DEADLINE = ARRIVAL + TIMEOUT; // 720

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

const flatCharge = (orders) => 20 * orders.length;
const SELL_LEGS = ["k2_ce", "k1_pe"];

function build({ candidate, config = {}, marketOpen = true, feedHealthy = true } = {}) {
  const cand = candidate ?? goodCandidate().candidate;
  const conf = cfg({
    executionMode: "paper_legging",
    simulatedDecisionMs: DECISION,
    simulatedLatencyMs: LATENCY,
    legTimeoutMs: TIMEOUT,
    legUnwindLatencyMs: 100,
    executionPollMs: 10,
    ...config,
  });
  const clock = fakeClock();
  const quotes = new BoxQuoteStore();
  const metrics = new BoxMetrics(conf.metricsWindow);
  const flags = { market: marketOpen, feed: feedHealthy };
  const sim = new BoxExecutionSimulator({
    cfg: conf,
    quotes,
    isMarketOpen: () => flags.market,
    isFeedHealthy: () => flags.feed,
    now: clock.now,
    wait: clock.wait,
    chargeTotal: flatCharge,
    metrics,
  });
  return { candidate: cand, conf, clock, quotes, sim, flags, metrics };
}

function detect(b, overrides = {}) {
  const at = b.clock.base;
  seedStore(b.quotes, quotesFor(b.candidate, overrides, { at }), at);
  return evaluateCandidate({ candidate: b.candidate, quotes: b.quotes.view(), now: at, maxAgeMs: b.conf.quoteMaxAgeMs, captureDepth: false });
}

/** Apply an explicit multi-level book for one role at a given time. */
function pushLevels(b, role, { bids = [], asks = [], last = 0 }, at, exchangeTs) {
  const token = b.candidate.legs[role].token;
  const tick = {
    token,
    last_price: last,
    bid: bids[0]?.price ?? 0,
    ask: asks[0]?.price ?? 0,
    bids: bids.map((l) => ({ price: l.price, qty: l.qty, orders: 1 })),
    asks: asks.map((l) => ({ price: l.price, qty: l.qty, orders: 1 })),
  };
  if (exchangeTs !== undefined) tick.exchange_ts = exchangeTs;
  b.quotes.applyTicks([tick], at);
}

function qualify(conf, over = {}) {
  const { entryCharges = 150, min = 1200 } = over;
  return (execution, measuredSlippage) =>
    evaluateEntryDecision({
      grossEdge: execution.gross_edge,
      entryCharges,
      estimatedExitCharges: 150,
      entrySlippageAllowance: 0,
      futureExitSlippageAllowance: 0,
      measuredEntrySlippage: measuredSlippage,
      cfg: { ...conf, safetyBuffer: 150, minExpectedNetProfit: min, minGrossEdge: 1200, minNetEdge: 0 },
    });
}

const legOf = (res, role) => res.legging.legs.find((l) => l.role === role);
const relative = (b, t) => (t === null || t === undefined ? null : t - b.clock.base);

/* ----------------------------- depth walking ------------------------------- */

test("a leg walks TWO depth levels within the limit and records the slices", async () => {
  // queue 'none' so the exact displayed quantities are executable.
  const b = build({ config: { queueModel: "none" } });
  const detection = detect(b);
  // k1_ce is a BUY (ref ask 300, limit 300.10): 50 @ 300.00 then 25 needed @ 300.05.
  b.clock.at(100, () =>
    pushLevels(b, "k1_ce", { asks: [{ price: 300, qty: 50 }, { price: 300.05, qty: 100 }], bids: [{ price: 299.9, qty: 150 }], last: 300 }, b.clock.now()),
  );
  const res = await b.sim.simulateLeggingEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  const leg = legOf(res, "k1_ce");
  assert.equal(leg.status, "FILLED");
  assert.equal(leg.fill_qty, LOT);
  assert.equal(leg.fills.length, 2, "took two levels");
  assert.deepEqual(leg.fills.map((s) => s.qty), [50, 25]);
  // (50×300 + 25×300.05)/75 = 300.0167 → 300.02
  assert.equal(leg.average_fill_price, 300.02);
});

/* --------------------- partial fill → pending → complete ------------------- */

test("a partial fill RESTS and a later book completes the remaining quantity", async () => {
  const b = build({ config: { queueModel: "none" } });
  const detection = detect(b);
  // At arrival only 40 rest at the ask → partial 40, remaining 35, PARTIALLY_FILLED.
  b.clock.at(100, () =>
    pushLevels(b, "k1_ce", { asks: [{ price: 300, qty: 40 }], bids: [{ price: 299.9, qty: 150 }], last: 300 }, b.clock.now()),
  );
  // At +330 the full lot is available → completes the remaining 35 at 300.
  b.clock.at(330, () =>
    pushLevels(b, "k1_ce", { asks: [{ price: 300, qty: 150 }], bids: [{ price: 299.9, qty: 150 }], last: 300 }, b.clock.now()),
  );
  const res = await b.sim.simulateLeggingEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  const leg = legOf(res, "k1_ce");
  assert.equal(leg.status, "FILLED");
  assert.equal(leg.fill_qty, LOT);
  assert.equal(relative(b, leg.pending_since), ARRIVAL, "it began resting at arrival");
  assert.equal(relative(b, leg.fill_at), 330, "completed on the later book");
  assert.equal(leg.fills.length, 2, "40 then 35");
  assert.deepEqual(leg.fills.map((s) => s.qty), [40, 35]);
  assert.equal(res.legging.filled_leg_count, 4);
});

test("a partial that never completes TIMES OUT holding its partial quantity", async () => {
  const b = build({ config: { queueModel: "none" } });
  const detection = detect(b);
  b.clock.at(100, () =>
    pushLevels(b, "k1_ce", { asks: [{ price: 300, qty: 40 }], bids: [{ price: 299.9, qty: 150 }], last: 300 }, b.clock.now()),
  );
  const res = await b.sim.simulateLeggingEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  const leg = legOf(res, "k1_ce");
  assert.equal(leg.status, "TIMED_OUT");
  assert.equal(relative(b, leg.timeout_at), DEADLINE);
  assert.equal(leg.fill_qty, 40, "the 40 that filled are kept");
  assert.equal(leg.fill_at, null, "never fully filled");
  assert.ok(res.legging.partial_fill_legs.includes("k1_ce"));
  assert.equal(b.metrics.snapshot().legging.partial_fills >= 1, true);
});

/* ------------------------------ queue haircut ------------------------------ */

test("the queue haircut reduces executable quantity, leaving a remainder pending", async () => {
  // Default haircut 30%: 100 displayed → 70 executable, so a 75-lot needs a refresh.
  const b = build();
  const detection = detect(b);
  b.clock.at(100, () =>
    pushLevels(b, "k1_ce", { asks: [{ price: 300, qty: 100 }], bids: [{ price: 299.9, qty: 300 }], last: 300 }, b.clock.now()),
  );
  const res = await b.sim.simulateLeggingEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  const leg = legOf(res, "k1_ce");
  // 70 fill at arrival, then it times out 5 short (no refresh).
  assert.equal(leg.fill_qty, 70);
  assert.equal(leg.status, "TIMED_OUT");
  assert.equal(leg.fills[0].displayed_qty, 100);
  assert.equal(leg.fills[0].effective_qty, 70);
});

test("BOX_QUEUE_MODEL=none uses the raw displayed quantity (fills the full lot)", async () => {
  const b = build({ config: { queueModel: "none" } });
  const detection = detect(b);
  b.clock.at(100, () =>
    pushLevels(b, "k1_ce", { asks: [{ price: 300, qty: 100 }], bids: [{ price: 299.9, qty: 300 }], last: 300 }, b.clock.now()),
  );
  const res = await b.sim.simulateLeggingEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  const leg = legOf(res, "k1_ce");
  assert.equal(leg.status, "FILLED");
  assert.equal(leg.fill_qty, LOT);
});

/* --------------------- four-leg exchange-timestamp skew -------------------- */

/** Seed all four legs at GOOD_BOX prices, each stamped with its own exchange ts. */
function seedWithExchangeTs(b, perRole, at = b.clock.base) {
  for (const role of ["k1_ce", "k2_ce", "k2_pe", "k1_pe"]) {
    const p = GOOD_BOX.prices[role];
    pushLevels(
      b,
      role,
      { asks: [{ price: p.ask, qty: 150 }], bids: [{ price: p.bid, qty: 150 }], last: p.ask },
      at,
      perRole[role],
    );
  }
  return evaluateCandidate({ candidate: b.candidate, quotes: b.quotes.view(), now: at, maxAgeMs: b.conf.quoteMaxAgeMs, captureDepth: false });
}

test("exchange dispersion WITHIN the threshold is accepted", async () => {
  const b = build({ config: { queueModel: "none", maxCrossLegExchangeDispersionMs: 250 } });
  const base = b.clock.base;
  const det = seedWithExchangeTs(b, { k1_ce: base, k2_ce: base + 50, k2_pe: base + 100, k1_pe: base + 150 });
  const res = await b.sim.simulateLeggingEntry({ candidate: b.candidate, detection: det, qualify: qualify(b.conf) });
  assert.equal(res.ok, true, "150ms of dispersion is within 250ms");
  assert.equal(res.legging.temporal.exchange_dispersion_ms, 150);
  assert.equal(res.legging.temporal.legs_with_exchange_ts, 4);
});

test("exchange dispersion BEYOND the threshold is rejected as cross_leg_time_skew", async () => {
  const b = build({ config: { queueModel: "none", maxCrossLegExchangeDispersionMs: 250 } });
  const base = b.clock.base;
  const det = seedWithExchangeTs(b, { k1_ce: base, k2_ce: base + 100, k2_pe: base + 200, k1_pe: base + 600 });
  const res = await b.sim.simulateLeggingEntry({ candidate: b.candidate, detection: det, qualify: qualify(b.conf) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "cross_leg_time_skew");
  assert.equal(res.legging.temporal.exchange_dispersion_ms, 600);
  assert.equal(res.legging.legs.length, 0, "no orders were sent");
  assert.equal(b.metrics.snapshot().legging.cross_leg_skew_rejects, 1);
});

test("a MISSING exchange timestamp falls back safely (no skew rejection)", async () => {
  const b = build({ config: { queueModel: "none", maxCrossLegExchangeDispersionMs: 250 } });
  const base = b.clock.base;
  // k1_pe has no exchange ts → dispersion cannot be computed → gate skipped.
  const det = seedWithExchangeTs(b, { k1_ce: base, k2_ce: base + 100, k2_pe: base + 900, k1_pe: undefined });
  const res = await b.sim.simulateLeggingEntry({ candidate: b.candidate, detection: det, qualify: qualify(b.conf) });
  assert.equal(res.ok, true, "a missing timestamp must never itself reject");
  assert.equal(res.legging.temporal.exchange_dispersion_ms, null);
  assert.equal(res.legging.temporal.legs_with_exchange_ts, 3);
});

/* ------------------------------- exit legging ------------------------------ */

function exitBuild(config = {}) {
  const { candidate } = goodCandidate();
  const b = build({ candidate, config: { queueModel: "none", ...config } });
  const position = positionFrom(candidate);
  return { b, candidate, position };
}

/** Seed both sides of every leg so all four exit orders can fill. */
function seedExitBooks(b, overrides = {}) {
  const at = b.clock.base;
  for (const role of ["k1_ce", "k2_ce", "k2_pe", "k1_pe"]) {
    const p = { ...GOOD_BOX.prices[role], ...(overrides[role] ?? {}) };
    pushLevels(b, role, { asks: [{ price: p.ask, qty: p.askQty ?? 150 }], bids: [{ price: p.bid, qty: p.bidQty ?? 150 }], last: p.ask }, at);
  }
  return evaluateExitLegs({
    legs: ["k1_ce", "k2_ce", "k2_pe", "k1_pe"].map((role) => ({ role, inst: b.candidate.legs[role] })),
    quotes: b.quotes.view(),
    lotSize: LOT,
    now: at,
    maxAgeMs: b.conf.quoteMaxAgeMs,
    direction: "LONG_BOX",
  });
}

test("exit 4/4: all four closing orders fill and the box closes on the average fills", async () => {
  const { b, position } = exitBuild();
  const detLegs = seedExitBooks(b);
  const res = await b.sim.simulateLeggingExit({ position, detectionLegs: detLegs, detectedAt: b.clock.base });
  assert.equal(res.ok, true);
  assert.equal(res.record.filled_leg_count, 4);
  assert.equal(res.legs.length, 4);
  for (const leg of res.legs) assert.ok(leg.price > 0 && leg.executable);
});

test("exit 3/4: one closing order fails, leaving RESIDUAL exposure (not a clean close)", async () => {
  const { b, position } = exitBuild();
  // k1_ce closes by SELLING → remove its bid so that leg cannot close.
  const detLegs = seedExitBooks(b, { k1_ce: { bid: 0, bidQty: 0 } });
  const res = await b.sim.simulateLeggingExit({ position, detectionLegs: detLegs, detectedAt: b.clock.base });
  assert.equal(res.ok, false);
  assert.equal(res.record.filled_leg_count, 3);
  assert.equal(res.record.residual_exposure.length, 1, "the unclosed leg is residual exposure");
  assert.equal(res.record.residual_exposure[0].role, "k1_ce");
  assert.equal(res.record.residual_exposure[0].source, "partial_exit");
  assert.equal(res.reason, "legging_incomplete");
});

/* --------------------- residual from a failed ENTRY unwind ----------------- */

/* ------------------------- deterministic replay ---------------------------- */

test("REPLAY: the same scripted depth walk reproduces identical fills and slices", async () => {
  const scenario = async () => {
    const b = build({ config: { queueModel: "none" } });
    const detection = detect(b);
    b.clock.at(100, () =>
      pushLevels(b, "k1_ce", { asks: [{ price: 300, qty: 40 }], bids: [{ price: 299.9, qty: 150 }], last: 300 }, b.clock.now()),
    );
    b.clock.at(330, () =>
      pushLevels(b, "k1_ce", { asks: [{ price: 300, qty: 150 }, { price: 300.05, qty: 150 }], bids: [{ price: 299.9, qty: 150 }], last: 300 }, b.clock.now()),
    );
    const res = await b.sim.simulateLeggingEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
    return {
      ok: res.ok,
      filled: res.legging.filled_leg_count,
      legs: res.legging.legs.map((l) => ({
        role: l.role,
        status: l.status,
        fill_qty: l.fill_qty,
        avg: l.average_fill_price,
        fill_at: relative(b, l.fill_at),
        slices: l.fills.map((s) => ({ price: s.price, qty: s.qty })),
      })),
    };
  };
  const a = await scenario();
  const c = await scenario();
  assert.deepEqual(a, c, "same recorded market ⇒ byte-identical fills");
  assert.equal(a.filled, 4);
  assert.equal(a.legs.find((l) => l.role === "k1_ce").slices.length, 2, "a non-trivial two-slice fill");
});

test("a partial entry whose unwind fails leaves residual exposure (failed_unwind)", async () => {
  const b = build({ config: { queueModel: "none" } });
  const detection = detect(b);
  // k2_ce fails to fill (a SELL leg → kill its bid) so the box aborts 3/4.
  b.clock.at(100, () => pushLevels(b, "k2_ce", { asks: [{ price: 221, qty: 150 }], bids: [], last: 221 }, b.clock.now()));
  // At the unwind, k1_ce (a filled BUY) loses its bid → its reversal cannot fill.
  b.clock.at(300, () => pushLevels(b, "k1_ce", { asks: [{ price: 300, qty: 150 }], bids: [], last: 300 }, b.clock.now()));
  const res = await b.sim.simulateLeggingEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "unwind_failed");
  assert.ok(res.legging.residual_exposure.length >= 1);
  assert.ok(res.legging.residual_exposure.some((r) => r.source === "failed_unwind"));
  assert.equal(res.legging.legs.filter((l) => l.status === "UNWIND_FAILED").length >= 1, true);
});
