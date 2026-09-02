/**
 * BoxMetrics: the logical-attempt lifecycle and its derived statistics.
 *
 * These tests pin the semantics the execution-health panel depends on:
 *
 *   - `attempted` counts ONE thing per strategy decision — never a leg, an order,
 *     or a retry.
 *   - `completed = success + failed + partial_recovered + partial_unresolved +
 *     aborted` — every terminal outcome is mutually exclusive and exhaustive.
 *   - `attempted >= completed` always, and an attempt that resolves synchronously
 *     (no in-flight window) has `attempted === completed`.
 *   - A terminal outcome can only be recorded once per attempt id; a conflicting
 *     second terminal is rejected and counted as a diagnostic, never silently
 *     double-booked.
 *   - Rupee/latency observations attach only to the terminal call, and percentile
 *     rings never invent a value for an unmeasured field (paper_touch/paper_latency
 *     have no ack/fill network legs and must read null, not zero).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxMetrics, RingBuffer } from "../../dist/box/metrics.js";

test("RingBuffer.percentile is a plain nearest-rank over pushed samples", () => {
  const r = new RingBuffer(10);
  for (const v of [10, 20, 30, 40, 50]) r.push(v);
  assert.equal(r.percentile(0), 10);
  assert.equal(r.percentile(0.5), 30);
  assert.equal(r.percentile(0.99), 50);
  assert.equal(r.mean, 30);
  assert.equal(r.max, 50);
});

test("RingBuffer never grows past capacity and overwrites the oldest sample", () => {
  const r = new RingBuffer(3);
  for (const v of [1, 2, 3, 4, 5]) r.push(v);
  assert.equal(r.size, 3);
  assert.equal(r.count, 5, "the lifetime count keeps growing even once bounded");
  // Only 3, 4, 5 remain.
  assert.equal(r.percentile(0), 3);
  assert.equal(r.percentile(1), 5);
});

test("a single logical attempt that resolves synchronously has attempted === completed", () => {
  const m = new BoxMetrics(50);
  m.beginLogicalAttempt("a1");
  m.finishLogicalAttempt("a1", "SUCCESS", null, { decisionToFillMs: 220 });
  const snap = m.snapshot();
  assert.equal(snap.execution.attempted, 1);
  assert.equal(snap.execution.completed, 1);
  assert.equal(snap.execution.successful, 1);
});

test("attempted >= completed while an attempt is still in flight", () => {
  const m = new BoxMetrics(50);
  m.beginLogicalAttempt("a1");
  m.beginLogicalAttempt("a2");
  m.finishLogicalAttempt("a1", "FAILED", "missing_book");
  const snap = m.snapshot();
  assert.equal(snap.execution.attempted, 2);
  assert.equal(snap.execution.completed, 1, "a2 has not resolved yet");
  assert.ok(snap.execution.attempted >= snap.execution.completed);
});

test("completed is always the exact sum of every mutually exclusive terminal outcome", () => {
  const m = new BoxMetrics(50);
  const outcomes = ["SUCCESS", "FAILED", "PARTIAL_RECOVERED", "PARTIAL_UNRESOLVED", "ABORTED"];
  outcomes.forEach((outcome, i) => {
    m.beginLogicalAttempt(`x${i}`);
    m.finishLogicalAttempt(`x${i}`, outcome, outcome === "FAILED" ? "missing_book" : null);
  });
  const snap = m.snapshot();
  assert.equal(snap.execution.attempted, 5);
  assert.equal(snap.execution.completed, 5);
  assert.equal(
    snap.execution.completed,
    snap.execution.successful +
      snap.execution.failed +
      snap.execution.partial_recovered +
      snap.execution.partial_unresolved +
      snap.execution.aborted,
  );
  // failure_rate is (failed + partial_unresolved) / completed = 2/5.
  assert.equal(snap.execution.failure_rate, 0.4);
  assert.equal(snap.execution.success_rate, 0.2);
});

test("internal retries never change the attempted or completed counters", () => {
  const m = new BoxMetrics(50);
  m.beginLogicalAttempt("a1");
  m.recordLogicalRetry();
  m.recordLogicalRetry();
  m.finishLogicalAttempt("a1", "SUCCESS", null);
  const snap = m.snapshot();
  assert.equal(snap.execution.attempted, 1);
  assert.equal(snap.execution.completed, 1);
  assert.equal(snap.execution.retries, 2);
});

test("a duplicate begin for the same attempt id is a no-op, not a second attempt", () => {
  const m = new BoxMetrics(50);
  const first = m.beginLogicalAttempt("dup");
  const second = m.beginLogicalAttempt("dup");
  assert.equal(first, true);
  assert.equal(second, false);
  m.finishLogicalAttempt("dup", "SUCCESS", null);
  const snap = m.snapshot();
  assert.equal(snap.execution.attempted, 1);
});

test("a conflicting second terminal for the same attempt id is rejected, not double-booked", () => {
  const m = new BoxMetrics(50);
  m.beginLogicalAttempt("a1");
  const firstOk = m.finishLogicalAttempt("a1", "SUCCESS", null);
  const secondOk = m.finishLogicalAttempt("a1", "FAILED", "duplicate");
  assert.equal(firstOk, true);
  assert.equal(secondOk, false, "the attempt already resolved and cannot resolve twice");
  const snap = m.snapshot();
  assert.equal(snap.execution.successful, 1);
  assert.equal(snap.execution.failed, 0, "the conflicting terminal must not also count as a failure");
  assert.equal(snap.execution.terminal_conflicts, 1);
});

test("an unmeasured latency/rupee field reads null, never a fabricated zero", () => {
  const m = new BoxMetrics(50);
  m.beginLogicalAttempt("a1");
  // paper_touch/paper_latency: no live ack/fill network legs exist.
  m.finishLogicalAttempt("a1", "SUCCESS", null, {
    decisionDeterioration: 0,
    arrivalExecutionSlippage: 0,
    orderSendToAckMs: null,
    ackToFillMs: null,
  });
  const snap = m.snapshot();
  assert.equal(snap.execution.latency.order_send_to_ack_ms, null);
  assert.equal(snap.execution.latency.ack_to_fill_ms, null);
  // A genuine zero measurement (fills exactly at the arrival book) is retained
  // and distinct from "no data".
  assert.equal(snap.execution.execution_slippage.last, 0);
  assert.equal(snap.execution.decision_deterioration.last, 0);
});

test("decision deterioration and execution slippage are signed rupee figures, not magnitudes", () => {
  const m = new BoxMetrics(50);
  // A LONG_BOX and a SHORT_BOX both deteriorating by the SAME rupee amount must
  // record the SAME sign here — the sign convention is "positive = worse than
  // detected", already resolved by the caller before it reaches the metric.
  m.beginLogicalAttempt("long");
  m.finishLogicalAttempt("long", "SUCCESS", null, { decisionDeterioration: 500, arrivalExecutionSlippage: 120 });
  m.beginLogicalAttempt("short");
  m.finishLogicalAttempt("short", "SUCCESS", null, { decisionDeterioration: 500, arrivalExecutionSlippage: 120 });
  const snap = m.snapshot();
  assert.equal(snap.execution.decision_deterioration.mean, 500);
  assert.equal(snap.execution.execution_slippage.mean, 120);
});

test("rejection categories are a fixed taxonomy keyed by the parent-attempt terminal reason", () => {
  const m = new BoxMetrics(50);
  m.beginLogicalAttempt("a1");
  m.finishLogicalAttempt("a1", "FAILED", "missing_book");
  m.beginLogicalAttempt("a2");
  m.finishLogicalAttempt("a2", "FAILED", "missing_book");
  m.beginLogicalAttempt("a3");
  m.finishLogicalAttempt("a3", "FAILED", "cross_leg_time_skew");
  const snap = m.snapshot();
  assert.equal(snap.execution.rejection_categories.missing_book, 2);
  assert.equal(snap.execution.rejection_categories.cross_leg_time_skew, 1);
});

test("percentile rollups over many logical attempts summarise p50/p95 without unbounded growth", () => {
  const m = new BoxMetrics(20);
  for (let i = 1; i <= 100; i++) {
    m.beginLogicalAttempt(`a${i}`);
    m.finishLogicalAttempt(`a${i}`, "SUCCESS", null, { decisionToFillMs: i * 10 });
  }
  const snap = m.snapshot();
  // Only the last 20 ring samples survive (window=20), so p50/p95 are computed over
  // attempts 81..100 (810..1000ms) — bounded memory, never the full 100.
  assert.ok(snap.execution.decision_to_fill_ms.p50 >= 810 && snap.execution.decision_to_fill_ms.p50 <= 1000);
  assert.ok(snap.execution.decision_to_fill_ms.p95 <= 1000);
  assert.equal(snap.execution.decision_to_fill_ms.samples, 20);
  assert.equal(snap.execution.attempted, 100, "attempted is a plain counter, unbounded by the ring window");
});
