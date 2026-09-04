/**
 * The scheduler↔leg-executor integration seam.
 *
 * Proves the leg executor consults the injected arrival planner (so live_parity legs
 * arrive on the SHARED scheduler's timeline — queue + pacing + whole-lifecycle
 * serialisation), that the plan overrides the per-leg latency draw, and — crucially —
 * that WITHOUT a planner the behaviour is byte-identical (standard paper unchanged).
 *
 * Also composes the real planner (planPaperSchedule + structured latency) to show the
 * end-to-end staggering it produces under cap=1.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { LegExecutor } from "../../dist/box/legExecutor.js";
import { BoxExecutionPolicy } from "../../dist/box/executionPolicy.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { createLatencySource } from "../../dist/box/latencySource.js";
import { createStructuredLatencySource } from "../../dist/box/latencyModel.js";
import { createSchedulingPolicy } from "../../dist/box/executionSchedulingPolicy.js";
import { planPaperSchedule } from "../../dist/box/paperScheduler.js";
import { cfg, option, quote } from "./helpers.mjs";

const T0 = 1_000_000;
function clock(t0 = T0) {
  let now = t0;
  return { now: () => now, wait: async (ms) => { now += Math.max(0, ms); } };
}
function policy(overrides = {}) {
  return new BoxExecutionPolicy(
    cfg({
      queueModel: "none",
      legExecutionMode: "parallel",
      legTimeoutMs: 5000,
      executionPollMs: 10,
      simulatedLatencyMs: 100,
      quoteMaxAgeMs: 600_000,
      defaultTickSize: 0.05,
      ...overrides,
    }),
  );
}
const TOKEN = 5001;
const inst = option(TOKEN, 20000, "CE");
function buyLeg(qty, role = "k1_ce", tk = TOKEN, i = inst) {
  return { role, side: "BUY", inst: i, detected_price: 100, detected_qty: qty, quantity: qty };
}
function seedBook(store, qty, at) {
  store.applyTicks([quote(TOKEN, { ask: 100, askQty: qty, bid: 99.9, bidQty: qty })], at);
  store.applyTicks([quote(5002, { ask: 100, askQty: qty, bid: 99.9, bidQty: qty })], at);
}

test("an arrival planner overrides per-leg latency for exchange-arrival timing", async () => {
  const store = new BoxQuoteStore();
  const c = clock();
  seedBook(store, 500, c.now());
  // Planner returns absolute arrivals; the executor must use them verbatim.
  const exec = new LegExecutor({
    policy: policy(),
    quotes: store,
    now: c.now,
    wait: c.wait,
    latency: createLatencySource({ mode: "recorded_samples", constantMs: 999, samples: [999] }),
    arrivalPlanner: ({ submitAt }) => [submitAt + 100, submitAt + 400],
  });
  const submitAt = c.now();
  const { legs } = await exec.run({
    requests: [buyLeg(50), buyLeg(50, "k2_ce", 5002, option(5002, 20200, "CE"))],
    submitAt,
    orderIdPrefix: "P",
  });
  assert.equal(legs[0].arrival_at - submitAt, 100, "planner arrival wins over the 999ms latency draw");
  assert.equal(legs[1].arrival_at - submitAt, 400);
});

test("no arrival planner ⇒ latency source drives arrival (standard/existing unchanged)", async () => {
  const store = new BoxQuoteStore();
  const c = clock();
  seedBook(store, 500, c.now());
  const exec = new LegExecutor({ policy: policy(), quotes: store, now: c.now, wait: c.wait });
  const submitAt = c.now();
  const { legs } = await exec.run({ requests: [buyLeg(50)], submitAt, latencyMs: 175, orderIdPrefix: "S" });
  assert.equal(legs[0].arrival_at - submitAt, 175);
});

test("the real planner staggers four legs on the cap=1 lifecycle timeline", async () => {
  const store = new BoxQuoteStore();
  const c = clock();
  seedBook(store, 500, c.now());
  const structured = createStructuredLatencySource({
    mode: "recorded_samples",
    constantMs: 200,
    postToAckSamples: [80],
    ackToTerminalSamples: [120],
  });
  const schedPolicy = createSchedulingPolicy({ maxConcurrentOperations: 1, minBrokerIntervalMs: 0 });
  const planner = ({ count, submitAt }) => {
    const ops = Array.from({ length: count }, (_, i) => {
      const d = structured.next();
      return { id: String(i), purpose: "ENTRY", sequence: i, readyAt: submitAt, postToAckMs: d.postToAckMs, ackToTerminalMs: d.ackToTerminalMs };
    });
    return planPaperSchedule(ops, schedPolicy).map((s) => s.ack_at);
  };
  const exec = new LegExecutor({ policy: policy(), quotes: store, now: c.now, wait: c.wait, arrivalPlanner: planner });
  const submitAt = c.now();
  const { legs } = await exec.run({
    requests: [
      buyLeg(10),
      buyLeg(10, "k2_ce", 5002, option(5002, 20200, "CE")),
    ],
    submitAt,
    orderIdPrefix: "L",
  });
  // Leg0 ack = 80. Leg1 dequeues only after leg0 terminal (80+120=200), ack = 200+80 = 280.
  assert.equal(legs[0].arrival_at - submitAt, 80);
  assert.equal(legs[1].arrival_at - submitAt, 280, "second leg waits a whole lifecycle (cap=1)");
});
