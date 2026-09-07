/**
 * AN ORDER CANNOT FILL BEFORE IT ARRIVES AT THE EXCHANGE.
 *
 * THE DEFECT
 * Under `live_parity` the abort path moved EVERY unresolved leg into `CANCEL_REQUESTED` without
 * asking whether it had arrived, and the quote subscriber deliberately treats `CANCEL_REQUESTED`
 * as fillable while SKIPPING the timeout guard (a cancelling order is genuinely still live past
 * its own deadline). So a leg still in transport — or, in sequential mode, one that was never
 * submitted at all, with `submit_at` and `arrival_at` both still 0 — could consume a later book
 * and report `fill_at < arrival_at`.
 *
 * That is physically impossible, and it is not cosmetic: it invents exposure that then drives an
 * emergency unwind, and it corrupts exactly the numbers this module exists to measure — fill
 * rate, residual rate, unwind frequency, parity timing, implementation shortfall, exposure
 * duration.
 *
 * WHAT MUST STILL WORK
 * The real race is real. An order RESTING on the book when a cancel is requested must still be
 * able to fill inside the cancellation window. The 75 / 40 / +12 → 52 filled, 23 cancelled
 * scenario is pinned in `cancelFillRace.test.mjs` and re-pinned here, because a fix that killed
 * it would have removed the realism the model was added for.
 *
 * These tests assert on OBSERVED QUANTITY, not on statuses: the question is always "did this
 * order acquire contracts it could not possibly have acquired?".
 *
 * Fully deterministic — a scripted clock, recorded books, no randomness, no broker, no network.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { LegExecutor } from "../../dist/box/legExecutor.js";
import { BoxExecutionPolicy } from "../../dist/box/executionPolicy.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import {
  paperLegTimelineViolations,
  paperRunTimelineViolations,
  hasReachedExchange,
} from "../../dist/box/paperLegTimeline.js";
import { cfg, option, quote } from "./helpers.mjs";

const T0 = 1_000_000;
const TOKENS = { k1_ce: 6001, k2_ce: 6002, k2_pe: 6003, k1_pe: 6004 };
const ROLES = ["k1_ce", "k2_ce", "k2_pe", "k1_pe"];
const insts = Object.fromEntries(ROLES.map((r, i) => [r, option(TOKENS[r], 20000 + i * 100, r.endsWith("_ce") ? "CE" : "PE")]));

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
    wait: async (ms) => { now += Math.max(0, ms); drain(); },
  };
}

const buy = (role, qty) => ({
  role,
  side: "BUY",
  inst: insts[role],
  detected_price: 100,
  detected_qty: qty,
  quantity: qty,
});

/** A generously fillable book for every leg. */
const fullBook = (askQty) => ROLES.map((r) => quote(TOKENS[r], { ask: 100, askQty, bid: 99.9, bidQty: askQty }));
const bookFor = (role, askQty) => [quote(TOKENS[role], { ask: 100, askQty, bid: 99.9, bidQty: askQty })];

/* ══════════════════ CASE 1: cancel BEFORE exchange arrival ══════════════════ */

test("P1: a leg aborted while still IN TRANSPORT cannot fill from a later book", async () => {
  const store = new BoxQuoteStore();
  // A fat, fillable book arrives at T0+50 — LONG before the leg reaches the exchange at T0+200.
  const clock = scriptedClock(store, [{ at: T0 + 50, ticks: bookFor("k1_ce", 500) }]);

  const exec = new LegExecutor({
    policy: policy(),
    quotes: store,
    now: clock.now,
    wait: clock.wait,
    cancelRace: { latencyMs: () => 300 },      // live_parity: cancels take time to confirm
  });

  const { legs, timelineViolations } = await exec.run({
    requests: [buy("k1_ce", 75)],
    submitAt: T0,
    latencyMs: 200,                            // arrival_at = T0 + 200
    orderIdPrefix: "transport:entry",
    // Abort at T0+20: the order is in flight and 180ms away from the exchange.
    abortReason: () => (clock.now() >= T0 + 20 ? { reason: "discovery_stopped", detail: "stopped" } : null),
  });

  const leg = legs[0];
  assert.equal(leg.arrival_at, T0 + 200, "the leg was still 180ms from the exchange when cancelled");
  assert.equal(
    leg.fill_qty,
    0,
    "AN ORDER IN TRANSPORT HAS NO QUEUE POSITION AND CANNOT MATCH — any fill here is invented exposure",
  );
  assert.equal(leg.fills.length, 0, "and no slice may be recorded");
  assert.equal(leg.fill_at, null);
  assert.equal(hasReachedExchange(leg), false, "it never became live at the exchange");
  assert.equal(leg.pending_since, null);
  assert.equal(leg.cancel_stage, "in_transport", "the stage is modelled explicitly, not inferred");
  assert.equal(leg.status, "FAILED", "a zero-fill cancellation is a failure to work the order");
  assert.deepEqual(timelineViolations, [], "and the recorded timeline is physically coherent");
});

test("P2: a sequential leg that was NEVER SUBMITTED cannot fill", async () => {
  const store = new BoxQuoteStore();
  // Deep books for every leg, published while the abort is being processed.
  const clock = scriptedClock(store, [{ at: T0 + 30, ticks: fullBook(500) }]);
  store.applyTicks(fullBook(0), T0);           // present but unfillable, so leg 1 rests

  const exec = new LegExecutor({
    policy: policy({ legExecutionMode: "sequential" }),
    quotes: store,
    now: clock.now,
    wait: clock.wait,
    cancelRace: { latencyMs: () => 300 },
  });

  const { legs, timelineViolations } = await exec.run({
    requests: ROLES.map((r) => buy(r, 75)),
    submitAt: T0,
    latencyMs: 0,
    orderIdPrefix: "sequential:entry",
    abortReason: () => (clock.now() >= T0 + 20 ? { reason: "market_closed", detail: "closed" } : null),
  });

  // Legs 2-4 were never submitted at all: sequential mode releases the next only on a full fill.
  for (const leg of legs.slice(1)) {
    assert.equal(leg.submit_at, 0, `${leg.role} was never submitted`);
    assert.equal(leg.arrival_at, 0);
    assert.equal(
      leg.fill_qty,
      0,
      `${leg.role} WAS NEVER SUBMITTED — a fill here would be exposure in an order that does not exist`,
    );
    assert.equal(leg.fills.length, 0);
    assert.equal(hasReachedExchange(leg), false);
    assert.equal(leg.cancel_stage, "pre_submission");
    assert.equal(leg.status, "FAILED");
  }
  assert.deepEqual(timelineViolations, []);
});

/* ══════════════════ CASE 2: cancel AFTER arrival, before any fill ══════════════════ */

test("P3: a leg cancelled after arriving but before filling still joins the race and may fill", async () => {
  const store = new BoxQuoteStore();
  store.applyTicks(bookFor("k1_ce", 0), T0);                     // arrived, nothing executable
  const clock = scriptedClock(store, [{ at: T0 + 60, ticks: bookFor("k1_ce", 75) }]);

  const exec = new LegExecutor({
    policy: policy(),
    quotes: store,
    now: clock.now,
    wait: clock.wait,
    cancelRace: { latencyMs: () => 300 },
  });

  const { legs, timelineViolations } = await exec.run({
    requests: [buy("k1_ce", 75)],
    submitAt: T0,
    latencyMs: 0,                                                // arrival_at = T0, so it IS resting
    orderIdPrefix: "arrived:entry",
    abortReason: () => (clock.now() >= T0 + 20 ? { reason: "discovery_stopped", detail: "stopped" } : null),
  });

  const leg = legs[0];
  assert.equal(leg.cancel_stage, "at_exchange", "it was genuinely resting on the book");
  assert.equal(hasReachedExchange(leg), true);
  assert.equal(leg.fill_qty, 75, "liquidity inside the cancellation window is a REAL fill — this is the race");
  assert.ok(leg.fill_at >= leg.arrival_at, "and it happened after arrival");
  assert.deepEqual(timelineViolations, []);
});

/* ══════════════════ CASE 3: cancel EXACTLY at arrival ══════════════════ */

test("P4: a cancel landing exactly at arrival treats the order as live at the exchange", async () => {
  const ARRIVE = T0 + 100;
  const store = new BoxQuoteStore();
  store.applyTicks(bookFor("k1_ce", 0), T0);
  const clock = scriptedClock(store, [{ at: ARRIVE + 40, ticks: bookFor("k1_ce", 75) }]);

  const exec = new LegExecutor({
    policy: policy(),
    quotes: store,
    now: clock.now,
    wait: clock.wait,
    cancelRace: { latencyMs: () => 300 },
  });

  const { legs, timelineViolations } = await exec.run({
    requests: [buy("k1_ce", 75)],
    submitAt: T0,
    latencyMs: 100,
    orderIdPrefix: "atarrival:entry",
    // Fires only once the clock has reached the arrival instant, never before.
    abortReason: () => (clock.now() >= ARRIVE ? { reason: "discovery_stopped", detail: "stopped" } : null),
  });

  const leg = legs[0];
  assert.equal(leg.arrival_at, ARRIVE);
  assert.equal(leg.cancel_stage, "at_exchange", "at arrival the order IS on the book");
  assert.equal(leg.pending_since, ARRIVE, "and pending_since must equal arrival, never precede it");
  assert.ok(leg.pending_since >= leg.arrival_at);
  assert.equal(leg.fill_qty, 75, "so a fill inside the cancellation window is legitimate");
  assert.ok(leg.fill_at >= leg.arrival_at);
  assert.deepEqual(timelineViolations, []);
});

/* ══════════════════ CASE 4/5: the existing realism must survive ══════════════════ */

test("P5: PRESERVED — 75 requested, 40 filled, cancel requested, 12 more fill => 52 filled / 23 cancelled", async () => {
  const store = new BoxQuoteStore();
  const clock = scriptedClock(store, [{ at: T0 + 250, ticks: bookFor("k1_ce", 12) }]);
  store.applyTicks(bookFor("k1_ce", 40), T0);

  const exec = new LegExecutor({
    policy: policy(),
    quotes: store,
    now: clock.now,
    wait: clock.wait,
    cancelRace: { latencyMs: () => 100 },
  });

  const { legs, timelineViolations } = await exec.run({
    requests: [buy("k1_ce", 75)],
    submitAt: T0,
    latencyMs: 0,
    orderIdPrefix: "preserved:entry",
  });

  const leg = legs[0];
  assert.equal(leg.fill_qty, 52, "52, NOT 40 — the raced quantity is real and must not be discarded");
  assert.equal(leg.remaining_qty, 23);
  assert.equal(leg.fill_qty_at_cancel_request, 40);
  assert.equal(leg.raced_fill_qty, 12);
  assert.equal(leg.status, "TIMED_OUT");
  assert.equal(leg.cancel_stage, "at_exchange", "a timeout cancel always happens at the exchange");
  assert.deepEqual(timelineViolations, [], "and every slice is after arrival");
  for (const slice of leg.fills) assert.ok(slice.at >= leg.arrival_at, "no slice may precede arrival");
});

test("P6: a full fill that beats its cancel confirmation is still FILLED, after arrival", async () => {
  const store = new BoxQuoteStore();
  const clock = scriptedClock(store, [{ at: T0 + 220, ticks: bookFor("k1_ce", 75) }]);
  store.applyTicks(bookFor("k1_ce", 0), T0);

  const exec = new LegExecutor({
    policy: policy(),
    quotes: store,
    now: clock.now,
    wait: clock.wait,
    cancelRace: { latencyMs: () => 200 },
  });

  const { legs, timelineViolations } = await exec.run({
    requests: [buy("k1_ce", 75)],
    submitAt: T0,
    latencyMs: 0,
    orderIdPrefix: "lostrace:entry",
  });

  const leg = legs[0];
  assert.equal(leg.status, "FILLED", "losing the race leaves a real position");
  assert.equal(leg.fill_qty, 75);
  assert.ok(leg.fill_at >= leg.arrival_at);
  assert.equal(leg.cancel_stage, "at_exchange");
  assert.deepEqual(timelineViolations, []);
});

/* ══════════════════ standard paper must be untouched ══════════════════ */

test("P7: standard paper (no cancel-race model) is unchanged by the arrival split", async () => {
  const store = new BoxQuoteStore();
  const clock = scriptedClock(store, [{ at: T0 + 50, ticks: bookFor("k1_ce", 500) }]);

  const exec = new LegExecutor({ policy: policy(), quotes: store, now: clock.now, wait: clock.wait });
  const { legs, timelineViolations } = await exec.run({
    requests: [buy("k1_ce", 75)],
    submitAt: T0,
    latencyMs: 200,
    orderIdPrefix: "standard:entry",
    abortReason: () => (clock.now() >= T0 + 20 ? { reason: "discovery_stopped", detail: "stopped" } : null),
  });

  const leg = legs[0];
  assert.equal(leg.fill_qty, 0, "an aborted in-flight order never filled in standard paper either");
  assert.equal(leg.status, "FAILED");
  assert.equal(leg.cancel_stage, "in_transport", "now recorded explicitly, but the outcome is the same");
  assert.deepEqual(timelineViolations, []);
});

/* ══════════════════ the invariant checker itself ══════════════════ */

test("P8: the timeline checker actually detects an impossible fill (it is not vacuous)", () => {
  const coherent = {
    role: "k1_ce", submit_at: T0, arrival_at: T0 + 100, pending_since: T0 + 100,
    fill_at: T0 + 150, fill_qty: 75, raced_fill_qty: 0, cancel_requested_at: null,
    cancel_stage: null, fills: [{ at: T0 + 150, price: 100, qty: 75 }],
  };
  assert.deepEqual(paperLegTimelineViolations(coherent), [], "a coherent timeline reports nothing");

  // The exact shape the defect produced: filled before it arrived.
  const preArrival = { ...coherent, fill_at: T0 + 50, fills: [{ at: T0 + 50, price: 100, qty: 75 }] };
  const violations = paperLegTimelineViolations(preArrival);
  assert.ok(violations.some((v) => /fill_at .* precedes arrival_at/.test(v)), `got ${JSON.stringify(violations)}`);
  assert.ok(violations.some((v) => /fill slice 0 .* precedes arrival_at/.test(v)));

  // A leg that filled without ever reaching the exchange.
  const neverArrived = { ...coherent, pending_since: null, arrival_at: 0, submit_at: 0, fill_at: null, fills: [] };
  assert.ok(
    paperLegTimelineViolations(neverArrived).some((v) => /without ever reaching the exchange/.test(v)),
  );

  // A raced fill on an order that never rested.
  const impossibleRace = { ...coherent, pending_since: null, raced_fill_qty: 12, cancel_requested_at: T0 + 10 };
  assert.ok(
    paperLegTimelineViolations(impossibleRace).some((v) => /never reached the exchange/.test(v)),
  );

  // pending_since cannot precede arrival.
  const earlyRest = { ...coherent, pending_since: T0 + 10 };
  assert.ok(paperLegTimelineViolations(earlyRest).some((v) => /pending_since .* precedes arrival_at/.test(v)));

  // And the run-level helper prefixes by role.
  assert.ok(paperRunTimelineViolations([preArrival]).every((v) => v.startsWith("k1_ce: ")));
});

/* ══════════════════ NEGATIVE CONTROL ══════════════════ */

test("NEGATIVE CONTROL: the in-transport scenario really is the one the old model allowed to fill", async () => {
  // Same scenario as P1, but the leg is given time to ARRIVE before the abort. The book is
  // identical and the abort is identical; the only difference is arrival. If P1's zero fill were
  // an artefact of the book or the clock rather than of the arrival rule, this would also be 0.
  const store = new BoxQuoteStore();
  const clock = scriptedClock(store, [{ at: T0 + 50, ticks: bookFor("k1_ce", 500) }]);

  const exec = new LegExecutor({
    policy: policy(),
    quotes: store,
    now: clock.now,
    wait: clock.wait,
    cancelRace: { latencyMs: () => 300 },
  });

  const { legs } = await exec.run({
    requests: [buy("k1_ce", 75)],
    submitAt: T0,
    latencyMs: 0,                       // the ONLY change: arrival_at = T0, so it is resting
    orderIdPrefix: "control:entry",
    abortReason: () => (clock.now() >= T0 + 20 ? { reason: "discovery_stopped", detail: "stopped" } : null),
  });

  assert.equal(
    legs[0].fill_qty,
    75,
    "PROOF OF CAUSALITY: the same book and the same abort DO fill once the order has arrived, " +
      "so P1's zero is the arrival rule at work and not a dead scenario",
  );
  assert.equal(legs[0].cancel_stage, "at_exchange");
});
