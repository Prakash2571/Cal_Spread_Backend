/**
 * The three defects the final audit found, pinned so they cannot regress:
 *
 *  1. Durable-persistence latency is MEASURED as its own stage, not folded into transport pacing.
 *  2. Paper can MODEL that persistence delay, and honestly models 0 until it has been measured.
 *  3. Residual-flatten charges are computed for live as well as paper, and are no longer discarded.
 *
 * Pure and offline.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ExecutionTimingRecorder,
  TIMING_STAGES,
} from "../../dist/box/executionTiming.js";
import { createFixedExecutionClock } from "../../dist/box/executionClock.js";
import { CALIBRATION_STAGES, ExecutionCalibrationStore } from "../../dist/box/executionCalibration.js";
import { planPaperSchedule } from "../../dist/box/paperScheduler.js";
import { createSchedulingPolicy } from "../../dist/box/executionSchedulingPolicy.js";

const identity = {
  broker: "zerodha",
  purpose: "ENTRY",
  role: "k1_ce",
  tradeId: "t",
  attemptId: "a",
  requestedQty: 75,
};

/* ───────────── 1. persistence latency is measured separately ───────────── */

test("intent_persisted is a first-class timing stage, and persistence_wait_ms a calibration stage", () => {
  assert.ok(TIMING_STAGES.includes("intent_persisted"), "the durable write must be observable");
  assert.ok(
    CALIBRATION_STAGES.includes("persistence_wait_ms"),
    "and must have its own calibration distribution",
  );
});

test("a durable write is attributed to persistence, NOT to transport pacing", () => {
  const clock = createFixedExecutionClock({ mono: 0, wall: 1_700_000_000_000 });
  const recorder = new ExecutionTimingRecorder({ enabled: true, clock });
  const trace = recorder.trace("BOX:t:ENTRY:k1_ce:attempt-1", identity);

  trace.mark("scheduler_enqueued");
  clock.advance(10);
  trace.mark("scheduler_dequeued");
  clock.advance(35); // the Mongo round trip
  trace.mark("intent_persisted");
  clock.advance(5); // pacing wait only
  trace.mark("transport_started");
  clock.advance(1);
  trace.mark("http_request_started");

  const spans = trace.spans();
  assert.equal(spans.scheduler_wait_ms, 10);
  assert.equal(spans.persistence_wait_ms, 35, "the database round trip is its own measurement");
  assert.equal(
    spans.transport_wait_ms,
    5,
    "pacing must be pacing only — 35ms of Mongo must NOT be reported as rate limiting",
  );
});

test("without a persistence mark the pacing span still measures from the dequeue (nothing is lost)", () => {
  const clock = createFixedExecutionClock({ mono: 0, wall: 0 });
  const recorder = new ExecutionTimingRecorder({ enabled: true, clock });
  const trace = recorder.trace("BOX:t:ENTRY:k2_ce:attempt-1", identity);
  trace.mark("scheduler_dequeued");
  clock.advance(12);
  trace.mark("transport_started");
  const spans = trace.spans();
  assert.equal(spans.persistence_wait_ms, undefined, "an unobserved stage is absent, not zero");
  assert.equal(spans.transport_wait_ms, 12, "the span degrades gracefully rather than disappearing");
});

test("persistence samples are calibrated per broker like every other stage", () => {
  const store = new ExecutionCalibrationStore({
    minSamples: 5,
    bucketMinSamples: 5,
    nowWall: () => 1_000,
  });
  for (let i = 0; i < 10; i++) {
    store.record({
      broker: "zerodha",
      kind: "ENTRY",
      profile: "MARKETABLE_LIMIT",
      bucket: "NORMAL",
      stage: "persistence_wait_ms",
      valueMs: 30 + i,
      atWall: 1_000,
    });
  }
  const zerodha = store.resolve(
    { broker: "zerodha", kind: "ENTRY", profile: "MARKETABLE_LIMIT", bucket: "NORMAL" },
    "persistence_wait_ms",
  );
  assert.equal(zerodha.measured, true);
  assert.ok(zerodha.percentiles.p50 >= 30);

  const dhan = store.resolve(
    { broker: "dhan", kind: "ENTRY", profile: "MARKETABLE_LIMIT", bucket: "NORMAL" },
    "persistence_wait_ms",
  );
  assert.equal(dhan.measured, false, "a different broker's database latency is not ours");
});

/* ───────────── 2. paper models it, and models 0 honestly ───────────── */

const policy = createSchedulingPolicy({ maxConcurrentOperations: 1, minBrokerIntervalMs: 0 });
const op = (over = {}) => ({
  id: "0",
  purpose: "ENTRY",
  sequence: 0,
  readyAt: 1_000,
  postToAckMs: 100,
  ackToTerminalMs: 50,
  ...over,
});

test("omitting persistenceMs models zero delay — knowingly optimistic, never invented", () => {
  const [s] = planPaperSchedule([op()], policy);
  assert.equal(s.persisted_at, s.dequeued_at, "no guessed database latency");
  assert.equal(s.persistence_wait_ms, 0);
  assert.equal(s.post_started_at, s.dequeued_at, "the POST is not delayed by an imagined write");
});

test("a MEASURED persistenceMs delays the POST inside the held slot, as live does", () => {
  const [s] = planPaperSchedule([op({ persistenceMs: 35 })], policy);
  assert.equal(s.persistence_wait_ms, 35);
  assert.equal(s.persisted_at, s.dequeued_at + 35);
  assert.equal(s.post_started_at, s.dequeued_at + 35, "the order cannot be sent before it is durable");
  assert.equal(s.ack_at, s.post_started_at + 100, "ACK is measured from the POST, not the dequeue");
  assert.equal(s.transport_wait_ms, 0, "with no pacing contention the pacing wait is genuinely 0");
});

test("persistence and transport pacing compose without either being double-counted", () => {
  const paced = createSchedulingPolicy({ maxConcurrentOperations: 2, minBrokerIntervalMs: 200 });
  const scheduled = planPaperSchedule(
    [op({ id: "a", sequence: 0, persistenceMs: 35 }), op({ id: "b", sequence: 1, persistenceMs: 35 })],
    paced,
  );
  const [a, b] = scheduled;
  assert.equal(a.persistence_wait_ms, 35);
  assert.equal(a.transport_wait_ms, 0, "the first order waits only for its own durable write");
  // The second order becomes durable at the same instant, then waits for the shared wire. Its
  // pacing wait is measured from the moment it was ALLOWED to send (1035) to the moment the wire
  // freed (a.post + 200 = 1235) — 200ms, not 165: the durable write and the pacing wait are
  // sequential, not overlapping.
  assert.equal(b.persistence_wait_ms, 35);
  assert.equal(b.post_started_at, a.post_started_at + 200, "the shared wire paces the second POST");
  assert.equal(b.transport_wait_ms, b.post_started_at - b.persisted_at);
  for (const s of scheduled) {
    assert.equal(
      s.post_started_at - s.dequeued_at,
      s.persistence_wait_ms + s.transport_wait_ms,
      "the two waits must exactly account for the gap — no overlap, no gap",
    );
  }
});

test("a negative or absent persistenceMs can never pull the POST earlier than the dequeue", () => {
  for (const bad of [-100, Number.NaN, undefined]) {
    const [s] = planPaperSchedule([op({ persistenceMs: bad })], policy);
    assert.ok(s.persisted_at >= s.dequeued_at, `persistenceMs=${bad} moved the order backwards`);
    assert.ok(s.persistence_wait_ms >= 0);
  }
});

/* ───────────── 3. residual-flatten charges are real ───────────── */

test("the live gateway BILLS residual flattening instead of reporting zero", async () => {
  const { CentralBoxExecutionGateway } = await import("../../dist/box/executionGateway.js");
  const { BoxQuoteStore } = await import("../../dist/box/quotes.js");
  const { loadBoxConfig } = await import("../../dist/box/config.js");
  const { quote } = await import("./helpers.mjs");

  const TOKEN = 7001;
  const quotes = new BoxQuoteStore();
  quotes.applyTicks([quote(TOKEN, { bid: 99.9, bidQty: 500, ask: 100, askQty: 500 })], 1_000);

  const residual = [
    {
      role: "k1_ce",
      token: TOKEN,
      tradingsymbol: "SYM-k1_ce",
      exchange: "NFO",
      side: "BUY",
      quantity: 75,
      average_price: 100,
      source: "partial_entry",
      created_at: 1_000,
    },
  ];

  // A manager that reports the flatten as fully filled.
  const manager = {
    status: () => ({ inFlight: 0, queued: 0 }),
    submit: async (req) => ({
      client_order_id: req.client_order_id,
      broker_order_id: "B1",
      tag: null,
      role: req.role,
      trade_id: req.trade_id,
      attempt_id: req.attempt_id,
      purpose: req.purpose,
      phase: req.phase,
      exchange: req.exchange,
      tradingsymbol: req.tradingsymbol,
      token: req.token,
      side: req.side,
      quantity: req.quantity,
      pricing: { ...req.pricing },
      limit_price: req.pricing.limit_price,
      state: "COMPLETE",
      filled_quantity: req.quantity,
      pending_quantity: 0,
      average_price: 99.9,
      fills: [{ fill_id: "f1", quantity: req.quantity, price: 99.9, at: 2_000 }],
      reject_family: null,
      reject_reason: null,
      created_at: 1_000,
      updated_at: 2_000,
    }),
    invariantViolation: () => {},
  };

  let charged = null;
  const gateway = new CentralBoxExecutionGateway({
    cfg: { ...loadBoxConfig(), executionMode: "live" },
    simulator: { flattenResidual: async () => { throw new Error("paper path must not be used"); } },
    quotes,
    manager,
    chargeTotal: (orders) => {
      charged = orders;
      return 12.34;
    },
  });

  const res = await gateway.flattenResidual({ residual, keyPrefix: "attempt-1" });

  assert.equal(res.flatten_charges, 12.34, "live flattening must bill its own fees, not report 0");
  assert.equal(res.remaining.length, 0);
  assert.equal(charged.length, 1, "exactly the filled flatten order is chargeable");
  assert.equal(charged[0].quantity, 75);
  assert.equal(charged[0].price, 99.9, "charged at the price the broker actually reported");
  assert.equal(charged[0].side, "SELL", "flattening a long residual is a SELL");
});

test("an UNFILLED flatten order is not charged for", async () => {
  const { CentralBoxExecutionGateway } = await import("../../dist/box/executionGateway.js");
  const { BoxQuoteStore } = await import("../../dist/box/quotes.js");
  const { loadBoxConfig } = await import("../../dist/box/config.js");
  const { quote } = await import("./helpers.mjs");

  const TOKEN = 7002;
  const quotes = new BoxQuoteStore();
  quotes.applyTicks([quote(TOKEN, { bid: 99.9, bidQty: 500, ask: 100, askQty: 500 })], 1_000);

  const manager = {
    status: () => ({ inFlight: 0, queued: 0 }),
    submit: async (req) => ({
      client_order_id: req.client_order_id,
      broker_order_id: "B2",
      tag: null,
      role: req.role,
      trade_id: req.trade_id,
      attempt_id: req.attempt_id,
      purpose: req.purpose,
      phase: req.phase,
      exchange: req.exchange,
      tradingsymbol: req.tradingsymbol,
      token: req.token,
      side: req.side,
      quantity: req.quantity,
      pricing: { ...req.pricing },
      limit_price: req.pricing.limit_price,
      state: "CANCELLED",
      filled_quantity: 0,
      pending_quantity: req.quantity,
      average_price: null,
      fills: [],
      reject_family: null,
      reject_reason: null,
      created_at: 1_000,
      updated_at: 2_000,
    }),
    invariantViolation: () => {},
  };

  let called = false;
  const gateway = new CentralBoxExecutionGateway({
    cfg: { ...loadBoxConfig(), executionMode: "live" },
    simulator: { flattenResidual: async () => { throw new Error("paper path must not be used"); } },
    quotes,
    manager,
    chargeTotal: () => {
      called = true;
      return 99;
    },
  });

  const res = await gateway.flattenResidual({
    residual: [
      {
        role: "k1_ce",
        token: TOKEN,
        tradingsymbol: "SYM-k1_ce",
        exchange: "NFO",
        side: "BUY",
        quantity: 75,
        average_price: 100,
        source: "partial_entry",
        created_at: 1_000,
      },
    ],
    keyPrefix: "attempt-2",
  });

  assert.equal(res.flatten_charges, 0, "nothing filled, so nothing is chargeable");
  assert.equal(called, false, "the fee calculator is not invoked for an empty order set");
  assert.equal(res.remaining.length, 1, "and the exposure is still outstanding");
});
