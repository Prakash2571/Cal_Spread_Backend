/**
 * Live execution observability store: per-broker/per-kind latency buckets, fail-open
 * recording, per-broker isolation, calibration status, dataset export, and the new
 * RingBuffer.values() it relies on.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { RingBuffer } from "../../dist/box/metrics.js";
import { BrokerTimingStore, deriveLegComponents } from "../../dist/box/brokerTimingStore.js";

function legTiming(overrides = {}) {
  return {
    broker: "zerodha",
    trade_id: "T1",
    attempt_id: "A1",
    role: "k1_ce",
    purpose: "ENTRY",
    kind: "ENTRY",
    detected_at: 0,
    queued_at: 10,
    dequeued_at: 30,
    post_started_at: 40,
    post_returned_at: 55,
    acknowledged_at: 130,
    first_fill_at: 300,
    last_fill_at: 320,
    terminal_at: 350,
    cancel_requested_at: null,
    cancel_confirmed_at: null,
    ...overrides,
  };
}

test("RingBuffer.values() returns samples chronologically, including after wrap", () => {
  const r = new RingBuffer(3);
  r.push(1);
  r.push(2);
  assert.deepEqual(r.values(), [1, 2]); // partial
  r.push(3);
  r.push(4); // overwrites 1
  assert.deepEqual(r.values(), [2, 3, 4]); // wrapped, oldest first
});

test("deriveLegComponents computes spans as later − earlier", () => {
  const c = deriveLegComponents(legTiming());
  assert.equal(c.queue_wait_ms, 20); // 30 - 10
  assert.equal(c.transport_wait_ms, 10); // 40 - 30
  assert.equal(c.broker_post_duration_ms, 15); // 55 - 40
  assert.equal(c.submit_to_ack_ms, 90); // 130 - 40
  assert.equal(c.submit_to_first_fill_ms, 260); // 300 - 40
  assert.equal(c.ack_to_terminal_ms, 220); // 350 - 130
  assert.equal(c.first_fill_to_last_fill_ms, 20); // 320 - 300
});

test("deriveLegComponents omits missing or inverted endpoints (never fabricates)", () => {
  const c = deriveLegComponents(legTiming({ first_fill_at: null, last_fill_at: null, acknowledged_at: 500 }));
  assert.equal(c.submit_to_first_fill_ms, undefined);
  // acknowledged_at (500) after terminal_at (350) is inverted ⇒ omitted, not negative.
  assert.equal(c.ack_to_terminal_ms, undefined);
});

test("recording is fail-open — garbage input never throws", () => {
  const store = new BrokerTimingStore();
  assert.doesNotThrow(() => store.recordLegTiming({}));
  assert.doesNotThrow(() => store.recordLegTiming(null));
  assert.doesNotThrow(() => store.recordBoxOutcome({}));
});

test("zerodha and dhan distributions never mix", () => {
  const store = new BrokerTimingStore();
  store.recordLegTiming(legTiming({ broker: "zerodha", acknowledged_at: 140 })); // submit_to_ack 100
  store.recordLegTiming(legTiming({ broker: "dhan", acknowledged_at: 240 })); // submit_to_ack 200
  const snap = store.snapshot();
  const z = snap.find((s) => s.broker === "zerodha");
  const d = snap.find((s) => s.broker === "dhan");
  assert.equal(z.by_kind.ENTRY.submit_to_ack_ms.last, 100);
  assert.equal(d.by_kind.ENTRY.submit_to_ack_ms.last, 200);
});

test("calibration status advances with sample count and staleness", () => {
  let clock = 1_000_000;
  const store = new BrokerTimingStore({
    now: () => clock,
    thresholds: { calibratedMinSamples: 3, staleAfterMs: 10_000 },
  });
  assert.equal(store.calibrationStatus("zerodha"), "UNCALIBRATED");
  store.recordLegTiming(legTiming());
  assert.equal(store.calibrationStatus("zerodha"), "PARTIALLY_CALIBRATED");
  store.recordLegTiming(legTiming());
  store.recordLegTiming(legTiming());
  assert.equal(store.calibrationStatus("zerodha"), "CALIBRATED");
  clock += 20_000; // newest sample now older than the freshness window
  assert.equal(store.calibrationStatus("zerodha"), "STALE");
});

test("calibrationDataset exports raw ENTRY samples ready to feed back into paper", () => {
  const store = new BrokerTimingStore();
  store.recordLegTiming(legTiming({ acknowledged_at: 140 })); // submit_to_ack 100
  store.recordLegTiming(legTiming({ acknowledged_at: 160 })); // submit_to_ack 120
  const ds = store.calibrationDataset("zerodha");
  assert.equal(ds.broker, "zerodha");
  assert.deepEqual(ds.entry.post_to_ack_ms, [100, 120]);
  assert.equal(ds.sample_count, 2);
  assert.ok(typeof ds.generated_at === "string");
});

test("outcome rates are counted per broker", () => {
  const store = new BrokerTimingStore();
  store.recordBoxOutcome({ broker: "zerodha", outcome: "filled_4_of_4" });
  store.recordBoxOutcome({ broker: "zerodha", outcome: "filled_4_of_4" });
  store.recordBoxOutcome({ broker: "zerodha", outcome: "partial" });
  const z = store.snapshot().find((s) => s.broker === "zerodha");
  assert.equal(z.outcomes.filled_4_of_4, 2);
  assert.equal(z.outcomes.partial, 1);
});

test("recent timeline is bounded and returns newest-last", () => {
  const store = new BrokerTimingStore({ timelineSize: 2 });
  store.recordLegTiming(legTiming({ attempt_id: "A1" }));
  store.recordLegTiming(legTiming({ attempt_id: "A2" }));
  store.recordLegTiming(legTiming({ attempt_id: "A3" }));
  const tl = store.recentTimeline();
  assert.equal(tl.length, 2);
  assert.deepEqual(tl.map((t) => t.attempt_id), ["A2", "A3"]);
});
