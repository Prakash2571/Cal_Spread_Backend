/**
 * Live-parity wiring inside the leg executor: shared liquidity + per-leg latency.
 *
 * The ledger and latency source are unit-tested in isolation elsewhere; these tests
 * prove they are actually consulted by the fill path — and, crucially, that WITHOUT
 * them the behaviour is unchanged (a run with no ledger fills the full displayed depth).
 *
 * Deterministic throughout: injected clock, a real BoxQuoteStore fed a scripted book,
 * queueModel "none" so displayed == effective and the arithmetic is obvious.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { LegExecutor } from "../../dist/box/legExecutor.js";
import { BoxExecutionPolicy } from "../../dist/box/executionPolicy.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { PaperLiquidityLedger } from "../../dist/box/liquidityLedger.js";
import { createLatencySource } from "../../dist/box/latencySource.js";
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
      legTimeoutMs: 500,
      executionPollMs: 10,
      simulatedLatencyMs: 100,
      quoteMaxAgeMs: 60_000,
      legMaxChaseTicks: 2,
      defaultTickSize: 0.05,
      ...overrides,
    }),
  );
}

const TOKEN = 5001;
const inst = option(TOKEN, 20000, "CE");

/** One BUY leg wanting `qty`, priced against a ₹100 detection touch. */
function buyLeg(qty) {
  return { role: "k1_ce", side: "BUY", inst, detected_price: 100, detected_qty: qty, quantity: qty };
}

/** Seed a single-level ask book of `qty` at ₹100. */
function seedBook(store, qty, at) {
  store.applyTicks([quote(TOKEN, { ask: 100, askQty: qty, bid: 99.9, bidQty: qty })], at);
}

/* ------------------- shared liquidity across two attempts ------------------- */

test("without a ledger, a run fills the full displayed depth (standard unchanged)", async () => {
  const c = clock();
  const store = new BoxQuoteStore();
  seedBook(store, 100, c.now());
  const exec = new LegExecutor({ policy: policy(), quotes: store, now: c.now, wait: c.wait });

  const { legs } = await exec.run({ requests: [buyLeg(75)], submitAt: c.now(), latencyMs: 50, orderIdPrefix: "A" });
  assert.equal(legs[0].status, "FILLED");
  assert.equal(legs[0].fill_qty, 75);
});

test("with a SHARED ledger, two attempts cannot both consume the same displayed level", async () => {
  const ledger = new PaperLiquidityLedger();
  const store = new BoxQuoteStore();
  const c = clock();
  seedBook(store, 100, c.now()); // displayed 100, none-haircut ⇒ effective 100
  const exec = new LegExecutor({
    policy: policy(),
    quotes: store,
    now: c.now,
    wait: c.wait,
    reservation: ledger,
    generation: () => 0,
  });

  // Attempt A takes 75 of the 100 and reserves it.
  const a = await exec.run({ requests: [buyLeg(75)], submitAt: c.now(), latencyMs: 50, orderIdPrefix: "A" });
  // Attempt B walks the SAME book version; only 25 remains.
  const b = await exec.run({ requests: [buyLeg(75)], submitAt: c.now(), latencyMs: 50, orderIdPrefix: "B" });

  assert.equal(a.legs[0].fill_qty, 75, "A takes 75");
  assert.equal(b.legs[0].fill_qty, 25, "B gets only the 25 A left behind");
  assert.ok(
    a.legs[0].fill_qty + b.legs[0].fill_qty <= 100,
    "combined fills never exceed the displayed depth",
  );
  assert.equal(b.legs[0].status, "TIMED_OUT", "B rests for the missing 50, then times out");
});

test("a genuinely NEW book version is fresh liquidity for the next attempt", async () => {
  const ledger = new PaperLiquidityLedger();
  const store = new BoxQuoteStore();
  const c = clock();
  seedBook(store, 100, c.now());
  const exec = new LegExecutor({
    policy: policy(),
    quotes: store,
    now: c.now,
    wait: c.wait,
    reservation: ledger,
    generation: () => 0,
  });

  await exec.run({ requests: [buyLeg(100)], submitAt: c.now(), latencyMs: 50, orderIdPrefix: "A" }); // consumes all 100
  // A brand-new book (new version) republishes 100 at ₹100.
  seedBook(store, 100, c.now());
  const b = await exec.run({ requests: [buyLeg(75)], submitAt: c.now(), latencyMs: 50, orderIdPrefix: "B" });

  assert.equal(b.legs[0].status, "FILLED", "the fresh book is not suppressed by old reservations");
  assert.equal(b.legs[0].fill_qty, 75);
});

/* --------------------------- per-leg latency source -------------------------- */

test("a latency source drives per-leg arrival deterministically", async () => {
  const store = new BoxQuoteStore();
  const c = clock();
  seedBook(store, 500, c.now());
  const latency = createLatencySource({ mode: "recorded_samples", constantMs: 200, samples: [100, 300] });
  const exec = new LegExecutor({ policy: policy(), quotes: store, now: c.now, wait: c.wait, latency });

  const submitAt = c.now();
  const { legs } = await exec.run({
    requests: [buyLeg(50), { ...buyLeg(50), role: "k2_ce", inst: option(5002, 20200, "CE") }],
    submitAt,
    orderIdPrefix: "P",
  });

  // Parallel submit consumes the source in role order: leg0 ← 100ms, leg1 ← 300ms.
  assert.equal(legs[0].arrival_at - submitAt, 100);
  assert.equal(legs[1].arrival_at - submitAt, 300);
});

test("with no latency source the run-level constant is used (standard unchanged)", async () => {
  const store = new BoxQuoteStore();
  const c = clock();
  seedBook(store, 500, c.now());
  const exec = new LegExecutor({ policy: policy(), quotes: store, now: c.now, wait: c.wait });

  const submitAt = c.now();
  const { legs } = await exec.run({ requests: [buyLeg(50)], submitAt, latencyMs: 175, orderIdPrefix: "S" });
  assert.equal(legs[0].arrival_at - submitAt, 175);
});
