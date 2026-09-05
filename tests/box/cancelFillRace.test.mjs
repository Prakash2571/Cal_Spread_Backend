/**
 * THE CANCEL-VS-FILL RACE, in paper.
 *
 * A cancel is a REQUEST, not an outcome. Between the request leaving our wire and the broker
 * confirming a terminal state, the exchange can still match resting quantity. The live
 * adapters already respect this; paper did not model it at all.
 *
 * Covers the required cases:
 *   2. A working order receives partial fills.
 *   3. A cancel races an additional fill.
 *   4. The cancel-terminal cumulative quantity wins.
 *
 * Plus the control that matters most: WITHOUT the race model, behaviour is byte-for-byte what
 * it was, so standard paper is untouched.
 *
 * Fully deterministic — a scripted clock, recorded books, no randomness, no broker, no network.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { LegExecutor } from "../../dist/box/legExecutor.js";
import { BoxExecutionPolicy } from "../../dist/box/executionPolicy.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { cfg, option, quote } from "./helpers.mjs";

const T0 = 1_000_000;
const TOKEN = 5001;
const inst = option(TOKEN, 20000, "CE");

function policy(overrides = {}) {
  return new BoxExecutionPolicy(
    cfg({
      queueModel: "none",
      legExecutionMode: "parallel",
      legTimeoutMs: 200,
      executionPollMs: 10,
      simulatedLatencyMs: 0,
      quoteMaxAgeMs: 600_000,
      defaultTickSize: 0.05,
      legMaxChaseTicks: 2,
      ...overrides,
    }),
  );
}

/**
 * A clock whose `wait()` advances simulated time and publishes any scripted book updates whose
 * instant has arrived. This is how a mid-cancellation tick is delivered deterministically.
 */
function scriptedClock(store, script) {
  let now = T0;
  const pending = [...script].sort((a, b) => a.at - b.at);
  const drain = () => {
    while (pending.length > 0 && pending[0].at <= now) {
      const event = pending.shift();
      store.applyTicks(event.ticks, event.at);
    }
  };
  return {
    now: () => now,
    wait: async (ms) => {
      now += Math.max(0, ms);
      drain();
    },
  };
}

const buy = (qty) => ({
  role: "k1_ce",
  side: "BUY",
  inst,
  detected_price: 100,
  detected_qty: qty,
  quantity: qty,
});

const book = (askQty) => [quote(TOKEN, { ask: 100, askQty, bid: 99.9, bidQty: askQty })];

/**
 * The scenario from the brief: 75 requested, 40 filled, cancel requested, 12 more fill while
 * the cancel is in flight, remainder cancelled.
 */
async function runRace({ cancelRace, extraQty = 12, cancelLatencyMs = 100 }) {
  const store = new BoxQuoteStore();
  const clock = scriptedClock(store, [
    // Inside the cancellation window (cancel requested at T0+200, confirms at T0+300).
    { at: T0 + 250, ticks: book(extraQty) },
  ]);
  // Initial book: only 40 of the 75 is available.
  store.applyTicks(book(40), T0);

  const exec = new LegExecutor({
    policy: policy(),
    quotes: store,
    now: clock.now,
    wait: clock.wait,
    ...(cancelRace ? { cancelRace: { latencyMs: () => cancelLatencyMs } } : {}),
  });

  const result = await exec.run({
    requests: [buy(75)],
    submitAt: T0,
    latencyMs: 0,
    orderIdPrefix: "race:entry",
  });
  return result.legs[0];
}

/* ─────────────────────────── the control case ─────────────────────────── */

test("REQUIRED 2: a working order takes a partial fill and rests for the remainder", async () => {
  const store = new BoxQuoteStore();
  const clock = scriptedClock(store, [{ at: T0 + 100, ticks: book(35) }]);
  store.applyTicks(book(40), T0);

  const exec = new LegExecutor({ policy: policy(), quotes: store, now: clock.now, wait: clock.wait });
  const { legs } = await exec.run({
    requests: [buy(75)],
    submitAt: T0,
    latencyMs: 0,
    orderIdPrefix: "partial:entry",
  });
  const leg = legs[0];
  // 40 from the first book, then 35 from a later one completes the order.
  assert.equal(leg.fill_qty, 75);
  assert.equal(leg.remaining_qty, 0);
  assert.equal(leg.status, "FILLED");
  assert.ok(leg.fills.length >= 2, "a partial then a completion is two or more slices");
});

test("WITHOUT the race model a cancel is instantaneous — standard paper is unchanged", async () => {
  const leg = await runRace({ cancelRace: false });
  // The order timed out at T0+200 holding 40, and the T0+250 liquidity was never available
  // to it, because the pre-existing model terminalises immediately.
  assert.equal(leg.fill_qty, 40);
  assert.equal(leg.remaining_qty, 35);
  assert.equal(leg.status, "TIMED_OUT");
  assert.equal(leg.resolved_at, T0 + 200, "resolution is the deadline, as before");
  // None of the race bookkeeping is populated.
  assert.equal(leg.cancel_requested_at, null);
  assert.equal(leg.cancel_confirmed_at, null);
  assert.equal(leg.fill_qty_at_cancel_request, null);
  assert.equal(leg.raced_fill_qty, 0);
});

/* ───────────────────────────── the race ───────────────────────────── */

test("REQUIRED 3 & 4: a cancel races an extra fill, and the terminal cumulative quantity wins", async () => {
  const leg = await runRace({ cancelRace: true, extraQty: 12, cancelLatencyMs: 100 });

  // THE ASSERTION THAT MATTERS: 52, not 40. The quantity at cancel-request time is not the
  // final quantity, and treating it as such would silently discard 12 real contracts.
  assert.equal(leg.fill_qty, 52, "filled must be 52, NOT 40 just because cancel was requested at 40");
  assert.equal(leg.remaining_qty, 23, "the cancelled remainder is 23");
  assert.equal(leg.fill_qty + leg.remaining_qty, 75, "quantity is conserved");

  // The race is visible and quantified.
  assert.equal(leg.fill_qty_at_cancel_request, 40);
  assert.equal(leg.raced_fill_qty, 12);
  assert.equal(leg.cancel_requested_at, T0 + 200);
  assert.equal(leg.cancel_confirmed_at, T0 + 300);
  assert.equal(leg.resolved_at, T0 + 300, "resolution is the CONFIRMATION, not the request");
  assert.equal(leg.status, "TIMED_OUT", "the cause was our own deadline");
  assert.match(leg.fail_reason, /12 filled during cancellation/);
});

test("the raced quantity comes from a real observed book, at a real price within the limit", async () => {
  const leg = await runRace({ cancelRace: true, extraQty: 12 });
  const total = leg.fills.reduce((sum, f) => sum + f.qty, 0);
  assert.equal(total, leg.fill_qty, "fill slices must account for the whole cumulative quantity");
  for (const fill of leg.fills) {
    // Nothing invented: every slice is an observed level, and never worse than the limit.
    assert.equal(fill.price, 100);
    assert.ok(fill.price <= leg.pricing.limit_price + 1e-9);
    assert.ok(fill.displayed_qty > 0);
  }
  // The raced slice is stamped with the mid-cancellation tick's own timestamp.
  assert.ok(leg.fills.some((f) => f.at === T0 + 250), "the raced slice carries the tick's time");
});

test("losing the race entirely produces a FILLED order, never a cancellation", async () => {
  // Enough extra liquidity arrives during the window to complete all 75.
  const leg = await runRace({ cancelRace: true, extraQty: 35, cancelLatencyMs: 100 });
  assert.equal(leg.fill_qty, 75);
  assert.equal(leg.remaining_qty, 0);
  assert.equal(
    leg.status,
    "FILLED",
    "an order that completed during cancellation is a real position, not a cancellation",
  );
  assert.equal(leg.raced_fill_qty, 35);
  assert.equal(leg.fail_reason, null, "a completed order carries no failure reason");
});

test("winning the race leaves the quantity untouched and reports no raced fill", async () => {
  const store = new BoxQuoteStore();
  // No liquidity arrives during the cancellation window at all.
  const clock = scriptedClock(store, []);
  store.applyTicks(book(40), T0);
  const exec = new LegExecutor({
    policy: policy(),
    quotes: store,
    now: clock.now,
    wait: clock.wait,
    cancelRace: { latencyMs: () => 100 },
  });
  const { legs } = await exec.run({
    requests: [buy(75)],
    submitAt: T0,
    latencyMs: 0,
    orderIdPrefix: "won:entry",
  });
  const leg = legs[0];
  assert.equal(leg.fill_qty, 40);
  assert.equal(leg.raced_fill_qty, 0);
  assert.equal(leg.fill_qty_at_cancel_request, 40);
  assert.equal(leg.status, "TIMED_OUT");
});

test("a zero-latency cancel confirms immediately and cannot be raced", async () => {
  const leg = await runRace({ cancelRace: true, extraQty: 35, cancelLatencyMs: 0 });
  assert.equal(leg.fill_qty, 40, "with no window there is no race");
  assert.equal(leg.raced_fill_qty, 0);
  assert.equal(leg.cancel_confirmed_at, T0 + 200);
});

test("a tick arriving AFTER the cancel confirmation cannot revive the order", async () => {
  const store = new BoxQuoteStore();
  const clock = scriptedClock(store, [
    { at: T0 + 250, ticks: book(5) }, // inside the window
    { at: T0 + 400, ticks: book(500) }, // well after confirmation at T0+300
  ]);
  store.applyTicks(book(40), T0);
  const exec = new LegExecutor({
    policy: policy(),
    quotes: store,
    now: clock.now,
    wait: clock.wait,
    cancelRace: { latencyMs: () => 100 },
  });
  const { legs } = await exec.run({
    requests: [buy(75)],
    submitAt: T0,
    latencyMs: 0,
    orderIdPrefix: "late:entry",
  });
  const leg = legs[0];
  assert.equal(leg.fill_qty, 45, "only the in-window liquidity counted");
  assert.equal(leg.raced_fill_qty, 5);
  assert.ok(!leg.fills.some((f) => f.at === T0 + 400), "a post-terminal tick must never fill");
});

/* ──────────────────── an aborted run cancels, and races ──────────────────── */

test("an aborted run issues cancels that must still be confirmed, and can still fill", async () => {
  const store = new BoxQuoteStore();
  const clock = scriptedClock(store, [{ at: T0 + 60, ticks: book(10) }]);
  store.applyTicks(book(20), T0);

  let wanted = true;
  const exec = new LegExecutor({
    policy: policy({ legTimeoutMs: 5_000 }),
    quotes: store,
    now: clock.now,
    wait: clock.wait,
    cancelRace: { latencyMs: () => 100 },
  });
  const run = exec.run({
    requests: [buy(75)],
    submitAt: T0,
    latencyMs: 0,
    orderIdPrefix: "abort:entry",
    // Abort as soon as the order has taken its first partial.
    abortReason: () =>
      !wanted ? null : clock.now() >= T0 + 20
        ? { reason: "discovery_stopped", detail: "the candidate was no longer wanted" }
        : null,
  });
  const { legs, aborted } = await run;
  const leg = legs[0];

  assert.ok(aborted, "the run reports the abort");
  assert.equal(aborted.reason, "discovery_stopped");
  // 20 from the initial book, then 10 more during the cancellation window.
  assert.equal(leg.fill_qty, 30);
  assert.equal(leg.raced_fill_qty, 10, "quantity really was acquired after the cancel request");
  assert.equal(leg.status, "CANCELLED", "an aborted partial stays visible as CANCELLED");
  assert.match(leg.fail_reason, /10 filled during cancellation/);
});

test("an aborted zero-fill order becomes FAILED, matching the instantaneous path", async () => {
  const store = new BoxQuoteStore();
  const clock = scriptedClock(store, []);
  // A book that is entirely past the limit: nothing is executable.
  store.applyTicks([quote(TOKEN, { ask: 200, askQty: 500, bid: 199, bidQty: 500 })], T0);

  const exec = new LegExecutor({
    policy: policy({ legTimeoutMs: 5_000 }),
    quotes: store,
    now: clock.now,
    wait: clock.wait,
    cancelRace: { latencyMs: () => 50 },
  });
  const { legs } = await exec.run({
    requests: [buy(75)],
    submitAt: T0,
    latencyMs: 0,
    orderIdPrefix: "abortzero:entry",
    abortReason: () => ({ reason: "feed_unhealthy", detail: "the feed went unhealthy" }),
  });
  assert.equal(legs[0].fill_qty, 0);
  assert.equal(legs[0].status, "FAILED");
  assert.equal(legs[0].raced_fill_qty, 0);
});

/* ─────────────────────────── ACK is not fill ─────────────────────────── */

test("ack_at is recorded from the scheduler's arrival and carries no quantity claim", async () => {
  const store = new BoxQuoteStore();
  const clock = scriptedClock(store, []);
  // A book that cannot fill anything, so the order is acknowledged and holds nothing.
  store.applyTicks([quote(TOKEN, { ask: 500, askQty: 500, bid: 499, bidQty: 500 })], T0);

  const exec = new LegExecutor({
    policy: policy({ legTimeoutMs: 100 }),
    quotes: store,
    now: clock.now,
    wait: clock.wait,
    // An arrival planner is what live_parity supplies; its arrival IS the ACK.
    arrivalPlanner: () => [T0 + 40],
  });
  const { legs } = await exec.run({
    requests: [buy(75)],
    submitAt: T0,
    orderIdPrefix: "ack:entry",
  });
  const leg = legs[0];
  assert.equal(leg.ack_at, T0 + 40, "the ACK instant is recorded in its own field");
  assert.equal(leg.arrival_at, T0 + 40);
  assert.equal(leg.fill_qty, 0, "an ACK is emphatically not a fill");
  assert.equal(leg.status, "TIMED_OUT");
});

test("without an arrival planner ack_at stays null rather than being invented", async () => {
  const store = new BoxQuoteStore();
  const clock = scriptedClock(store, []);
  store.applyTicks(book(75), T0);
  const exec = new LegExecutor({ policy: policy(), quotes: store, now: clock.now, wait: clock.wait });
  const { legs } = await exec.run({
    requests: [buy(75)],
    submitAt: T0,
    latencyMs: 50,
    orderIdPrefix: "noack:entry",
  });
  assert.equal(legs[0].ack_at, null, "standard paper observes no separate ACK, so it claims none");
  assert.equal(legs[0].fill_qty, 75);
});

/* ───────────────────── shared liquidity during the race ───────────────────── */

test("REQUIRED 15: liquidity consumed during a cancellation window cannot be double-spent", async () => {
  // One shared ledger, two orders on the same instrument. The second must only see what the
  // first left behind — including quantity the first took while it was cancelling.
  const { PaperLiquidityLedger } = await import("../../dist/box/liquidityLedger.js");
  const ledger = new PaperLiquidityLedger();

  const store = new BoxQuoteStore();
  const clock = scriptedClock(store, []);
  store.applyTicks(book(40), T0);

  const exec = new LegExecutor({
    policy: policy({ legTimeoutMs: 100 }),
    quotes: store,
    now: clock.now,
    wait: clock.wait,
    reservation: ledger,
    cancelRace: { latencyMs: () => 50 },
  });

  const first = await exec.run({
    requests: [buy(75)],
    submitAt: T0,
    latencyMs: 0,
    orderIdPrefix: "shared-a:entry",
  });
  assert.equal(first.legs[0].fill_qty, 40, "the first order takes all 40 displayed");

  const second = await exec.run({
    requests: [buy(75)],
    submitAt: clock.now(),
    latencyMs: 0,
    orderIdPrefix: "shared-b:entry",
  });
  assert.equal(
    second.legs[0].fill_qty,
    0,
    "the level is exhausted; the second order must not re-take the same 40",
  );
});
