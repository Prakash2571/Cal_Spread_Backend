/**
 * The structured latency model: calibration status classification and the deterministic
 * per-broker structured latency source (POST→ACK and ACK→terminal drawn independently).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyCalibration,
  createStructuredLatencySource,
  DEFAULT_CALIBRATION_THRESHOLDS,
  BROKER_IDS,
  LATENCY_OPERATION_KINDS,
} from "../../dist/box/latencyModel.js";

test("no samples ⇒ UNCALIBRATED", () => {
  assert.equal(classifyCalibration(0, null), "UNCALIBRATED");
  assert.equal(classifyCalibration(0, 10), "UNCALIBRATED");
});

test("some samples below the threshold ⇒ PARTIALLY_CALIBRATED", () => {
  assert.equal(classifyCalibration(17, 1000), "PARTIALLY_CALIBRATED");
});

test("enough fresh samples ⇒ CALIBRATED", () => {
  assert.equal(classifyCalibration(500, 1000), "CALIBRATED");
});

test("enough samples but the newest is old ⇒ STALE", () => {
  const old = DEFAULT_CALIBRATION_THRESHOLDS.staleAfterMs + 1;
  assert.equal(classifyCalibration(500, old), "STALE");
});

test("custom thresholds are honoured", () => {
  assert.equal(classifyCalibration(10, 100, { calibratedMinSamples: 10, staleAfterMs: 1000 }), "CALIBRATED");
  assert.equal(classifyCalibration(9, 100, { calibratedMinSamples: 10, staleAfterMs: 1000 }), "PARTIALLY_CALIBRATED");
});

test("structured source draws POST→ACK and ACK→terminal from their own samples in order", () => {
  const s = createStructuredLatencySource({
    mode: "recorded_samples",
    constantMs: 250,
    postToAckSamples: [90, 110, 130],
    ackToTerminalSamples: [200, 400],
  });
  assert.equal(s.calibrated, true);
  const a = s.next();
  assert.equal(a.postToAckMs, 90);
  assert.equal(a.ackToTerminalMs, 200);
  const b = s.next();
  assert.equal(b.postToAckMs, 110);
  assert.equal(b.ackToTerminalMs, 400);
  const c = s.next();
  assert.equal(c.postToAckMs, 130);
  assert.equal(c.ackToTerminalMs, 200); // wraps independently
});

test("structured source is deterministic across reset", () => {
  const cfg = { mode: "recorded_samples", constantMs: 250, postToAckSamples: [90, 110], ackToTerminalSamples: [200] };
  const s = createStructuredLatencySource(cfg);
  const first = [s.next(), s.next(), s.next()];
  s.reset();
  const second = [s.next(), s.next(), s.next()];
  assert.deepEqual(first, second);
});

test("no samples ⇒ constant fallback, and calibrated is false", () => {
  const s = createStructuredLatencySource({ mode: "constant", constantMs: 250 });
  assert.equal(s.calibrated, false);
  const d = s.next();
  assert.equal(d.postToAckMs, 250);
  // ACK→terminal falls back to a fraction of the constant, never collapsing both into one.
  assert.ok(d.ackToTerminalMs > 0 && d.ackToTerminalMs < 250);
});

test("the model exposes both brokers and all operation kinds", () => {
  assert.deepEqual([...BROKER_IDS], ["zerodha", "dhan"]);
  assert.ok(LATENCY_OPERATION_KINDS.includes("ENTRY"));
  assert.ok(LATENCY_OPERATION_KINDS.includes("UNWIND"));
  assert.ok(LATENCY_OPERATION_KINDS.includes("CANCEL"));
});
