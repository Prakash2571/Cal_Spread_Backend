/**
 * The execution-parity report: live vs paper percentile comparison + outcome rates,
 * built from two broker-timing snapshots. Diagnostics only, pure and deterministic.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BrokerTimingStore } from "../../dist/box/brokerTimingStore.js";
import { buildParityReport, buildParityReports, formatParityReport } from "../../dist/box/parityReport.js";

function entryLeg(broker, submitToAck) {
  return {
    broker,
    trade_id: "T",
    attempt_id: "A",
    role: "k1_ce",
    purpose: "ENTRY",
    kind: "ENTRY",
    detected_at: null,
    queued_at: null,
    dequeued_at: null,
    post_started_at: 0,
    post_returned_at: null,
    acknowledged_at: submitToAck,
    first_fill_at: null,
    last_fill_at: null,
    terminal_at: null,
    cancel_requested_at: null,
    cancel_confirmed_at: null,
  };
}

// A live store and a paper store, each with a distribution of submit_to_ack samples.
function stores(liveAcks, paperAcks) {
  const live = new BrokerTimingStore();
  const paper = new BrokerTimingStore();
  for (const a of liveAcks) live.recordLegTiming(entryLeg("zerodha", a));
  for (const a of paperAcks) paper.recordLegTiming(entryLeg("zerodha", a));
  return { live, paper };
}

test("compares live vs paper percentiles and computes % error", () => {
  // Live acks cluster ~100; paper ~110 → paper ~10% slower.
  const liveAcks = Array.from({ length: 50 }, () => 100);
  const paperAcks = Array.from({ length: 50 }, () => 110);
  const { live, paper } = stores(liveAcks, paperAcks);
  const report = buildParityReport(live.snapshot()[0], paper.snapshot()[0]);
  const m = report.metrics.find((x) => x.metric === "submit_to_ack_ms");
  assert.ok(m, "submit_to_ack_ms compared");
  assert.equal(m.live.p50, 100);
  assert.equal(m.paper.p50, 110);
  assert.equal(m.error_pct.p50, 10, "+10% error");
  assert.equal(m.low_confidence, false, "50 samples each ≥ threshold 30");
});

test("flags low confidence when either side is under the threshold", () => {
  const { live, paper } = stores([100, 100], [110]); // 2 vs 1 samples
  const report = buildParityReport(live.snapshot()[0], paper.snapshot()[0]);
  const m = report.metrics.find((x) => x.metric === "submit_to_ack_ms");
  assert.equal(m.low_confidence, true);
  assert.equal(report.overall_low_confidence, true);
});

test("a metric present on only one side still appears, with null error", () => {
  const live = new BrokerTimingStore();
  const paper = new BrokerTimingStore();
  live.recordLegTiming(entryLeg("zerodha", 100)); // live has submit_to_ack
  // paper records nothing → paper side null
  const report = buildParityReport(live.snapshot()[0], paper.snapshot()[0]);
  const m = report.metrics.find((x) => x.metric === "submit_to_ack_ms");
  assert.ok(m.live !== null && m.paper === null);
  assert.equal(m.error_pct, null);
});

test("outcome rates are compared per outcome", () => {
  const live = new BrokerTimingStore();
  const paper = new BrokerTimingStore();
  live.recordBoxOutcome({ broker: "zerodha", outcome: "filled_4_of_4" });
  paper.recordBoxOutcome({ broker: "zerodha", outcome: "filled_4_of_4" });
  paper.recordBoxOutcome({ broker: "zerodha", outcome: "partial" });
  const report = buildParityReport(live.snapshot()[0], paper.snapshot()[0]);
  const filled = report.outcomes.find((o) => o.outcome === "filled_4_of_4");
  const partial = report.outcomes.find((o) => o.outcome === "partial");
  assert.deepEqual([filled.live, filled.paper], [1, 1]);
  assert.deepEqual([partial.live, partial.paper], [0, 1]);
});

test("buildParityReports matches snapshots by broker", () => {
  const { live, paper } = stores([100, 100], [100, 100]);
  const reports = buildParityReports(live.snapshot(), paper.snapshot());
  assert.ok(reports.every((r) => r.broker === "zerodha" || r.broker === "dhan"));
});

test("formatParityReport renders a readable text block", () => {
  const { live, paper } = stores(Array.from({ length: 40 }, () => 100), Array.from({ length: 40 }, () => 120));
  const text = formatParityReport(buildParityReport(live.snapshot()[0], paper.snapshot()[0]));
  assert.match(text, /Broker: Zerodha/);
  assert.match(text, /submit_to_ack_ms/);
  assert.match(text, /error/);
});
