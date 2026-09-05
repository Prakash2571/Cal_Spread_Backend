/**
 * Event-loop and process-pressure diagnostics: real attachment, stall annotation, and the
 * fail-open guarantee that no diagnostic failure can affect execution.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ExecutionEnvironmentMonitor,
  createDisabledEnvironmentMonitor,
} from "../../dist/box/executionEnvironment.js";
import { createFixedExecutionClock, createExecutionClock } from "../../dist/box/executionClock.js";

/** A histogram stub reporting nanoseconds, as Node's real one does. */
function fakeHistogram(percentilesMs = { 50: 1, 95: 4, 99: 12 }, count = 100) {
  let enabled = false;
  return {
    get max() {
      return 30 * 1e6;
    },
    get mean() {
      return 2 * 1e6;
    },
    get count() {
      return count;
    },
    percentile(p) {
      return (percentilesMs[p] ?? 0) * 1e6;
    },
    reset() {},
    enable() {
      enabled = true;
      return true;
    },
    disable() {
      enabled = false;
      return true;
    },
    get isEnabled() {
      return enabled;
    },
  };
}

test("attaches to the real event-loop delay histogram and reports ms percentiles", async () => {
  const monitor = new ExecutionEnvironmentMonitor({ enabled: true, clock: createExecutionClock() });
  monitor.start();
  try {
    assert.equal(monitor.enabled, true, "the real monitorEventLoopDelay should attach in Node");
    // Let the loop turn a few times so the native histogram accrues samples.
    await new Promise((r) => setTimeout(r, 60));
    const snap = monitor.snapshot();
    assert.equal(snap.event_loop.enabled, true);
    assert.ok(snap.event_loop.samples > 0, "histogram should have recorded loop turns");
    for (const key of ["p50", "p95", "p99"]) {
      const v = snap.event_loop[key];
      assert.ok(v !== null && v >= 0, `${key} should be a non-negative ms value, got ${v}`);
      assert.ok(v < 60_000, `${key}=${v} looks like nanoseconds, not milliseconds`);
    }
  } finally {
    monitor.stop();
  }
});

test("reports enabled:false and null percentiles when no histogram is available", () => {
  const monitor = new ExecutionEnvironmentMonitor({
    enabled: true,
    clock: createFixedExecutionClock(),
    histogramFactory: () => null,
  });
  monitor.start();
  const snap = monitor.snapshot();
  assert.equal(monitor.enabled, false);
  assert.equal(snap.event_loop.enabled, false);
  // Honesty: nulls, not zeros that would look like a perfectly healthy loop.
  assert.equal(snap.event_loop.p50, null);
  assert.equal(snap.event_loop.p99, null);
  monitor.stop();
});

test("a stall overlapping an operation is annotated; an earlier stall is not", () => {
  const clock = createFixedExecutionClock({ mono: 1_000, wall: 1_700_000_000_000 });
  const monitor = new ExecutionEnvironmentMonitor({
    enabled: true,
    clock,
    stallThresholdMs: 50,
    histogramFactory: () => fakeHistogram(),
  });
  monitor.start();

  // A stall BEFORE the operation started.
  monitor.recordStall(120, 1_000);

  clock.advance(500); // operation begins at mono 1500
  const opStart = clock.mono();
  monitor.recordStall(310, 1_600); // a stall DURING the operation
  monitor.recordStall(70, 1_700);

  const during = monitor.annotate(opStart);
  assert.equal(during.stalls_during, 2, "only stalls at/after the reference instant count");
  assert.equal(during.worst_stall_ms, 310);
  assert.equal(during.stalled, true);
  assert.equal(during.loop_p99_ms, 12, "p99 is converted from ns to ms");

  const fromStart = monitor.annotate(1_000);
  assert.equal(fromStart.stalls_during, 3);
  assert.equal(fromStart.worst_stall_ms, 310);

  // No reference instant ⇒ no stall claim, but the loop percentile is still reported.
  const unanchored = monitor.annotate(null);
  assert.equal(unanchored.stalls_during, 0);
  assert.equal(unanchored.stalled, false);
  assert.equal(unanchored.loop_p99_ms, 12);
  monitor.stop();
});

test("lag below the threshold is not recorded as a stall", () => {
  const monitor = new ExecutionEnvironmentMonitor({
    enabled: true,
    clock: createFixedExecutionClock(),
    stallThresholdMs: 50,
    histogramFactory: () => fakeHistogram(),
  });
  monitor.start();
  monitor.recordStall(49);
  monitor.recordStall(Number.NaN);
  monitor.recordStall(-10);
  const snap = monitor.snapshot();
  assert.equal(snap.stalls.count, 0);
  assert.equal(snap.stalls.worst_ms, null);
  monitor.stop();
});

test("the recent-stall history is bounded, so memory is constant under a long stall storm", () => {
  const monitor = new ExecutionEnvironmentMonitor({
    enabled: true,
    clock: createFixedExecutionClock(),
    stallThresholdMs: 10,
    stallHistory: 5,
    histogramFactory: () => fakeHistogram(),
  });
  monitor.start();
  for (let i = 0; i < 500; i++) monitor.recordStall(20 + i, i);
  const snap = monitor.snapshot();
  assert.equal(snap.stalls.recent.length, 5, "ring must stay bounded");
  assert.equal(snap.stalls.count, 500, "the total is still counted");
  assert.equal(snap.stalls.worst_ms, 519, "the worst is retained even after eviction");
  monitor.stop();
});

test("CPU utilisation needs two readings and is null on the first snapshot", () => {
  const clock = createFixedExecutionClock({ mono: 0 });
  const monitor = new ExecutionEnvironmentMonitor({
    enabled: true,
    clock,
    histogramFactory: () => fakeHistogram(),
  });
  monitor.start();
  assert.equal(monitor.snapshot().cpu, null, "a rate must never be guessed from one reading");
  clock.advance(1_000);
  const second = monitor.snapshot().cpu;
  assert.ok(second !== null, "the second snapshot can compute a rate");
  assert.ok(second.utilisation >= 0);
  assert.equal(second.window_ms, 1_000);
  monitor.stop();
});

test("GC statistics are null rather than zero-filled when GC observation is off", () => {
  const monitor = new ExecutionEnvironmentMonitor({
    enabled: true,
    clock: createFixedExecutionClock(),
    histogramFactory: () => fakeHistogram(),
  });
  monitor.start();
  assert.equal(monitor.snapshot().gc, null);
  monitor.stop();
});

test("FAIL-OPEN: a throwing histogram never propagates into the caller", () => {
  const hostile = {
    get max() {
      throw new Error("boom");
    },
    get mean() {
      throw new Error("boom");
    },
    get count() {
      throw new Error("boom");
    },
    percentile() {
      throw new Error("boom");
    },
    reset() {
      throw new Error("boom");
    },
    enable() {
      throw new Error("boom");
    },
    disable() {
      throw new Error("boom");
    },
  };
  const monitor = new ExecutionEnvironmentMonitor({
    enabled: true,
    clock: createFixedExecutionClock(),
    histogramFactory: () => hostile,
  });
  // Not one of these may throw — a diagnostics failure must never reach the trading path.
  assert.doesNotThrow(() => monitor.start());
  assert.doesNotThrow(() => monitor.snapshot());
  assert.doesNotThrow(() => monitor.annotate(0));
  assert.doesNotThrow(() => monitor.recordStall(100));
  assert.doesNotThrow(() => monitor.resetHistogram());
  assert.doesNotThrow(() => monitor.stop());
  assert.equal(monitor.annotate(0).loop_p99_ms, null);
});

test("FAIL-OPEN: a factory that throws leaves the monitor disabled with a recorded reason", () => {
  const monitor = new ExecutionEnvironmentMonitor({
    enabled: true,
    clock: createFixedExecutionClock(),
    histogramFactory: () => {
      throw new Error("perf_hooks unavailable");
    },
  });
  assert.doesNotThrow(() => monitor.start());
  assert.equal(monitor.enabled, false);
  assert.equal(monitor.attachFailure, "perf_hooks unavailable");
  monitor.stop();
});

test("a disabled monitor attaches nothing and costs nothing", () => {
  const monitor = createDisabledEnvironmentMonitor(createFixedExecutionClock());
  monitor.start();
  assert.equal(monitor.enabled, false);
  const snap = monitor.snapshot();
  assert.equal(snap.event_loop.enabled, false);
  assert.equal(snap.stalls.count, 0);
  assert.equal(monitor.annotate(0).stalled, false);
  monitor.stop();
});

test("start() and stop() are idempotent", () => {
  const monitor = new ExecutionEnvironmentMonitor({
    enabled: true,
    clock: createFixedExecutionClock(),
    histogramFactory: () => fakeHistogram(),
  });
  monitor.start();
  monitor.start();
  assert.equal(monitor.enabled, true);
  monitor.stop();
  monitor.stop();
});
