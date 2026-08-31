/**
 * CONCURRENT EXECUTION ISOLATION.
 *
 * BOX_MAX_CONCURRENT_EXECUTIONS defaults to 8, so several entry pipelines really do
 * run at once. These tests exist because an earlier version kept per-run state on
 * the shared executor/simulator instance:
 *
 *   private booksAtFill        (LegExecutor)  — the books each leg filled from
 *   private leggingStillWanted (Simulator)    — the candidate's discovery predicate
 *
 * With two candidates in flight, the second overwrote the first's pointer. Candidate
 * A's later fill then wrote into candidate B's map, and A was re-qualified against
 * books it never traded — or B's STOP cancelled A's orders. Both are silent
 * corruption of the research output, which is worse than a crash.
 *
 * A VIRTUAL CLOCK is used rather than the single-sleeper fake clock in the other
 * suites: two runs sleeping simultaneously against a shared `now` would race, and
 * the harness itself would become the source of nondeterminism.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers";

import { BoxExecutionSimulator } from "../../dist/box/executionSimulator.js";
import { BoxMetrics } from "../../dist/box/metrics.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { evaluateCandidate, evaluateEntryDecision } from "../../dist/box/math.js";
import { GOOD_BOX, candidatesFor, cfg, chain, quote, quotesFor, seedStore } from "./helpers.mjs";

const DECISION = 20;
const LATENCY = 200;
const TIMEOUT = 500;
const ARRIVAL = DECISION + LATENCY; // 220

/**
 * A virtual clock that supports MANY concurrent sleepers.
 *
 * `wait()` registers a timer and returns; `drive()` repeatedly advances virtual time
 * to the next due item — market event or timer — flushing the microtask queue in
 * between so a woken pipeline can register its next sleep before time moves again.
 * Timers due at the same instant fire in registration order, so the interleaving is
 * fully determined by the script, not by promise scheduling luck.
 */
function virtualClock(t0 = 1_000_000) {
  let now = t0;
  let seq = 0;
  let timers = [];
  let events = [];
  const stalls = [];
  return {
    base: t0,
    now: () => now,
    /** Queue an extra delay to simulate the process stalling during the next sleep. */
    pushStall: (ms) => stalls.push(ms),
    wait: (ms) => {
      const extra = stalls.length > 0 ? stalls.shift() : 0;
      const at = now + Math.max(0, ms) + extra;
      return new Promise((resolve) => timers.push({ at, seq: seq++, resolve }));
    },
    at: (ms, fn) => events.push({ at: t0 + ms, fn }),
    async drive(maxSteps = 200_000) {
      for (let i = 0; i < maxSteps; i++) {
        // Let every pending continuation run so its next sleep is registered.
        await new Promise((r) => tick(r));
        const nextTimer = timers.length > 0 ? Math.min(...timers.map((t) => t.at)) : Infinity;
        const nextEvent = events.length > 0 ? Math.min(...events.map((e) => e.at)) : Infinity;
        const next = Math.min(nextTimer, nextEvent);
        if (next === Infinity) return;
        now = next;
        // Market data first, so a woken order sees the book published at this instant.
        const dueEvents = events.filter((e) => e.at === now);
        events = events.filter((e) => e.at !== now);
        for (const e of dueEvents) e.fn();
        const dueTimers = timers.filter((t) => t.at <= now).sort((a, b) => a.seq - b.seq);
        timers = timers.filter((t) => t.at > now);
        for (const t of dueTimers) t.resolve();
      }
      throw new Error("virtual clock did not settle");
    },
  };
}

/** Two disjoint LONG candidates (no shared contracts) from one chain. */
function twoCandidates() {
  const c = chain();
  const window = [19700, 19800, 19900, 20000, 20100, 20200, 20300];
  const all = candidatesFor(window, c);
  const a = all.find((x) => x.lower_strike === 19900 && x.upper_strike === 20100);
  const b = all.find((x) => x.lower_strike === 19500 + 300 && x.upper_strike === 20000);
  assert.ok(a && b, "fixture: two candidates required");
  assert.notEqual(a.key, b.key, "candidates must be distinct");
  const aTokens = new Set(Object.values(a.legs).map((l) => l.token));
  const bTokens = new Set(Object.values(b.legs).map((l) => l.token));
  for (const t of bTokens) assert.ok(!aTokens.has(t), "fixture: candidates must not share contracts");
  return { a, b };
}

function harness({ marketOpen = true, feedHealthy = true, config = {} } = {}) {
  const conf = cfg({
    executionMode: "paper_legging",
    simulatedDecisionMs: DECISION,
    simulatedLatencyMs: LATENCY,
    legTimeoutMs: TIMEOUT,
    legUnwindLatencyMs: 100,
    executionPollMs: 10,
    ...config,
  });
  const clock = virtualClock();
  const quotes = new BoxQuoteStore();
  const flags = { market: marketOpen, feed: feedHealthy };
  const sim = new BoxExecutionSimulator({
    cfg: conf,
    quotes,
    isMarketOpen: () => flags.market,
    isFeedHealthy: () => flags.feed,
    now: clock.now,
    wait: clock.wait,
    chargeTotal: (orders) => 20 * orders.length,
    metrics: new BoxMetrics(conf.metricsWindow),
  });
  return { conf, clock, quotes, sim, flags };
}

function detect(h, candidate) {
  const at = h.clock.base;
  seedStore(h.quotes, quotesFor(candidate, {}, { at }), at);
  return evaluateCandidate({
    candidate,
    quotes: h.quotes.view(),
    now: at,
    maxAgeMs: h.conf.quoteMaxAgeMs,
    captureDepth: false,
  });
}

function push(h, candidate, role, spec, at) {
  const token = candidate.legs[role].token;
  const q = quote(token, { ...spec, at });
  h.quotes.applyTicks(
    [{ token, last_price: q.last, bid: q.bid, ask: q.ask, bids: q.bids, asks: q.asks }],
    at,
  );
}

const SELL_LEGS = ["k2_ce", "k1_pe"];
const unfillable = (role) =>
  SELL_LEGS.includes(role)
    ? { bid: 0, bidQty: 0, ask: 999, askQty: 150 }
    : { bid: 1, bidQty: 150, ask: 0, askQty: 0 };
const thin = (role, qty = 1) => {
  const p = GOOD_BOX.prices[role];
  return SELL_LEGS.includes(role)
    ? { bid: p.bid, bidQty: qty, ask: p.ask, askQty: 150 }
    : { bid: p.bid, bidQty: 150, ask: p.ask, askQty: qty };
};
const fillable = (role) => ({ ...GOOD_BOX.prices[role], bidQty: 150, askQty: 150 });

const qualify = (conf) => (execution, measuredSlippage) =>
  evaluateEntryDecision({
    grossEdge: execution.gross_edge,
    entryCharges: 150,
    estimatedExitCharges: 150,
    entrySlippageAllowance: 0,
    futureExitSlippageAllowance: 0,
    measuredEntrySlippage: measuredSlippage,
    cfg: { ...conf, safetyBuffer: 150, minExpectedNetProfit: 1200, minGrossEdge: 1200, minNetEdge: 0 },
  });

/** Comparable, clock-independent view of one result. */
function normalise(res, base, candidate) {
  return {
    ok: res.ok === true,
    reason: res.reason ?? null,
    filled: res.legging.filled_leg_count,
    net: res.legging.legging_net_loss,
    final_net: res.legging.final_expected_net_profit,
    first_to_last: res.legging.first_to_last_fill_ms,
    exposure: res.legging.exposure_duration_ms,
    legs: res.legging.legs
      .map((l) => ({
        role: l.role,
        token: l.token,
        status: l.status,
        fill_at: l.fill_at === null ? null : l.fill_at - base,
        fill_price: l.fill_price,
        slippage: l.slippage,
      }))
      .sort((x, y) => x.role.localeCompare(y.role)),
    // Which contracts the qualification actually priced — the isolation proof.
    priced_tokens: res.ok
      ? res.evaluation.legs.map((l) => l.token).sort((x, y) => x - y)
      : null,
    candidate_tokens: Object.values(candidate.legs)
      .map((l) => l.token)
      .sort((x, y) => x - y),
  };
}

/**
 * Scenario: A fills cleanly at arrival; B has one thin leg and is STOPped mid-flight.
 * Deliberately asymmetric so a leak between them would change the outcome.
 */
function script(h, a, b, { bWanted }) {
  const detA = detect(h, a);
  const detB = detect(h, b);
  // B's k2_pe cannot fill at arrival, and B is abandoned at 300.
  h.clock.at(100, () => push(h, b, "k2_pe", thin("k2_pe", 1), h.clock.now()));
  h.clock.at(300, () => {
    bWanted.value = false;
  });
  return { detA, detB };
}

test("two concurrent candidates cannot corrupt each other's fill books or qualification", async () => {
  const { a, b } = twoCandidates();
  const h = harness();
  const bWanted = { value: true };
  const { detA, detB } = script(h, a, b, { bWanted });

  const pA = h.sim.simulateLeggingEntry({
    candidate: a,
    detection: detA,
    qualify: qualify(h.conf),
    stillWanted: () => true,
  });
  const pB = h.sim.simulateLeggingEntry({
    candidate: b,
    detection: detB,
    qualify: qualify(h.conf),
    stillWanted: () => bWanted.value,
  });

  await h.clock.drive();
  const [resA, resB] = await Promise.all([pA, pB]);

  // A is untouched by B's abandonment.
  assert.equal(resA.ok, true, "A must still open");
  assert.equal(resA.legging.filled_leg_count, 4);
  assert.equal(resA.legging.final_expected_net_profit, 1425);

  // THE ISOLATION PROOF: qualification priced exactly A's own four contracts.
  const nA = normalise(resA, h.clock.base, a);
  assert.deepEqual(nA.priced_tokens, nA.candidate_tokens, "A was qualified on foreign books");
  for (const leg of resA.legging.legs) {
    assert.equal(leg.status, "FILLED");
    assert.equal(leg.fill_price, GOOD_BOX.prices[leg.role][SELL_LEGS.includes(leg.role) ? "bid" : "ask"]);
  }

  // B was stopped while its fourth leg rested, so it aborted and unwound its three.
  assert.equal(resB.ok, false);
  assert.equal(resB.reason, "discovery_stopped");
  assert.equal(resB.legging.filled_leg_count, 3);
  assert.equal(resB.legging.legs.filter((l) => l.status === "UNWOUND").length, 3);

  // And no contract crossed between the two runs.
  const aTokens = new Set(resA.legging.legs.map((l) => l.token));
  for (const leg of resB.legging.legs) assert.ok(!aTokens.has(leg.token));
});

test("A's result is identical whether it runs alone or alongside B", async () => {
  const { a, b } = twoCandidates();

  // Concurrent.
  const hC = harness();
  const wantedC = { value: true };
  const sC = script(hC, a, b, { bWanted: wantedC });
  const cA = hC.sim.simulateLeggingEntry({ candidate: a, detection: sC.detA, qualify: qualify(hC.conf), stillWanted: () => true });
  const cB = hC.sim.simulateLeggingEntry({ candidate: b, detection: sC.detB, qualify: qualify(hC.conf), stillWanted: () => wantedC.value });
  await hC.clock.drive();
  const [concA, concB] = await Promise.all([cA, cB]);

  // A alone, same script and timings.
  const hA = harness();
  const wantedA = { value: true };
  const sA = script(hA, a, b, { bWanted: wantedA });
  const soloAP = hA.sim.simulateLeggingEntry({ candidate: a, detection: sA.detA, qualify: qualify(hA.conf), stillWanted: () => true });
  await hA.clock.drive();
  const soloA = await soloAP;

  // B alone, same script and timings.
  const hB = harness();
  const wantedB = { value: true };
  const sB = script(hB, a, b, { bWanted: wantedB });
  const soloBP = hB.sim.simulateLeggingEntry({ candidate: b, detection: sB.detB, qualify: qualify(hB.conf), stillWanted: () => wantedB.value });
  await hB.clock.drive();
  const soloB = await soloBP;

  assert.deepEqual(
    normalise(concA, hC.clock.base, a),
    normalise(soloA, hA.clock.base, a),
    "A's fills/prices/P&L must not depend on B running",
  );
  assert.deepEqual(
    normalise(concB, hC.clock.base, b),
    normalise(soloB, hB.clock.base, b),
    "B's fills/prices/P&L must not depend on A running",
  );
});

test("eight concurrent executions each stay internally consistent", async () => {
  const c = chain({ count: 33, first: 19000 });
  const strikes = c.strikes;
  const all = candidatesFor(strikes, c);
  // Eight candidates on DISJOINT strike pairs, each 200 wide so the shared price
  // fixture produces a genuinely qualifying edge (width 200 − cost 175).
  const picks = [];
  for (let i = 0; i + 2 < strikes.length && picks.length < 8; i += 4) {
    const cand = all.find((x) => x.lower_strike === strikes[i] && x.upper_strike === strikes[i + 2]);
    if (cand) picks.push(cand);
  }
  assert.equal(picks.length, 8, "fixture: need eight disjoint candidates");

  const h = harness();
  const detections = picks.map((cand) => detect(h, cand));
  // Every other candidate loses a leg at arrival, so outcomes differ.
  picks.forEach((cand, i) => {
    if (i % 2 === 1) {
      h.clock.at(100, () => push(h, cand, "k1_pe", unfillable("k1_pe"), h.clock.now()));
    }
  });

  const runs = picks.map((cand, i) =>
    h.sim.simulateLeggingEntry({
      candidate: cand,
      detection: detections[i],
      qualify: qualify(h.conf),
      stillWanted: () => true,
    }),
  );
  await h.clock.drive();
  const results = await Promise.all(runs);

  results.forEach((res, i) => {
    const cand = picks[i];
    const own = new Set(Object.values(cand.legs).map((l) => l.token));
    for (const leg of res.legging.legs) {
      assert.ok(own.has(leg.token), `run ${i} reported a contract it never ordered`);
    }
    if (i % 2 === 0) {
      assert.equal(res.ok, true, `run ${i} should have filled 4/4`);
      const n = normalise(res, h.clock.base, cand);
      assert.deepEqual(n.priced_tokens, n.candidate_tokens, `run ${i} qualified on foreign books`);
    } else {
      assert.equal(res.ok, false, `run ${i} should have aborted`);
      assert.equal(res.legging.filled_leg_count, 3);
    }
  });
});

test("a stalled event loop cannot fill an order after its deadline had passed", async () => {
  // Deadline is arrival + 50 = 270. The process then stalls until 620.
  const h = harness({ config: { legTimeoutMs: 50, executionPollMs: 500 } });
  const { a } = twoCandidates();
  const detection = detect(h, a);
  h.clock.pushStall(400); // the sleep toward arrival overshoots badly

  const p = h.sim.simulateLeggingEntry({
    candidate: a,
    detection,
    qualify: qualify(h.conf),
    stillWanted: () => true,
  });
  await h.clock.drive();
  const res = await p;

  assert.equal(res.ok, false, "nothing may fill after the deadline");
  assert.equal(res.legging.filled_leg_count, 0);
  for (const leg of res.legging.legs) {
    assert.equal(leg.status, "TIMED_OUT", `${leg.role} must expire, not fill late`);
    assert.equal(leg.fill_at, null);
    // Resolution is stamped at the DEADLINE, not at the late wake-up.
    assert.equal(leg.resolved_at - h.clock.base, ARRIVAL + 50);
  }
});

test("no listeners or in-flight keys leak after many concurrent executions", async () => {
  const c = chain({ count: 33, first: 19000 });
  const all = candidatesFor(c.strikes, c);
  const h = harness();
  const baseline = h.quotes.listenerCount;

  for (let round = 0; round < 25; round++) {
    const picks = [];
    for (let i = 0; i + 2 < c.strikes.length && picks.length < 4; i += 4) {
      const cand = all.find((x) => x.lower_strike === c.strikes[i] && x.upper_strike === c.strikes[i + 2]);
      if (cand) picks.push(cand);
    }
    const dets = picks.map((cand) => detect(h, cand));
    const runs = picks.map((cand, i) =>
      h.sim.simulateLeggingEntry({
        candidate: cand,
        detection: dets[i],
        qualify: qualify(h.conf),
        stillWanted: () => true,
      }),
    );
    await h.clock.drive();
    await Promise.all(runs);
  }

  assert.equal(h.quotes.listenerCount, baseline, "quote listeners must be unsubscribed");
  assert.equal(h.sim.activeCount, 0, "no execution pipeline may remain active");
});
