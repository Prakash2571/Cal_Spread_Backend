/**
 * The deterministic latency source.
 *
 * The whole point is reproducibility: no Math.random, a fixed consumption order, and a
 * seed that only rotates the start. Same config + same number of draws ⇒ same sequence.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createLatencySource } from "../../dist/box/latencySource.js";

test("constant mode always returns the same latency", () => {
  const s = createLatencySource({ mode: "constant", constantMs: 250 });
  assert.equal(s.mode, "constant");
  for (let i = 0; i < 5; i++) assert.equal(s.next(), 250);
});

test("recorded samples are consumed in order, then cycle", () => {
  const s = createLatencySource({ mode: "recorded_samples", constantMs: 250, samples: [180, 210, 420] });
  assert.deepEqual([s.next(), s.next(), s.next(), s.next()], [180, 210, 420, 180]);
});

test("the same config produces an identical sequence every run (determinism)", () => {
  const cfg = { mode: "recorded_samples", constantMs: 250, samples: [180, 210, 195, 260, 850] };
  const a = createLatencySource(cfg);
  const b = createLatencySource(cfg);
  const seqA = Array.from({ length: 12 }, () => a.next());
  const seqB = Array.from({ length: 12 }, () => b.next());
  assert.deepEqual(seqA, seqB);
});

test("a seed only rotates the fixed starting offset — still deterministic, no randomness", () => {
  const base = { mode: "recorded_samples", constantMs: 250, samples: [10, 20, 30, 40] };
  const seeded = createLatencySource({ ...base, seed: 2 });
  assert.deepEqual([seeded.next(), seeded.next(), seeded.next()], [30, 40, 10]);
  // A second source with the same seed is identical.
  const again = createLatencySource({ ...base, seed: 2 });
  assert.deepEqual([again.next(), again.next(), again.next()], [30, 40, 10]);
});

test("a large or negative seed is normalised into range", () => {
  const base = { mode: "recorded_samples", constantMs: 250, samples: [10, 20, 30, 40] };
  assert.equal(createLatencySource({ ...base, seed: 6 }).next(), 30, "6 % 4 = 2");
  assert.equal(createLatencySource({ ...base, seed: -1 }).next(), 40, "-1 wraps to last");
});

test("reset() replays the same sequence from the start", () => {
  const s = createLatencySource({ mode: "recorded_samples", constantMs: 250, samples: [1, 2, 3] });
  const first = [s.next(), s.next()];
  s.reset();
  const second = [s.next(), s.next()];
  assert.deepEqual(first, second);
});

test("empty samples fall back to the constant, never crash or return undefined", () => {
  const s = createLatencySource({ mode: "recorded_samples", constantMs: 300, samples: [] });
  assert.equal(s.next(), 300);
  assert.equal(s.next(), 300);
});

test("negative / NaN samples are sanitised, never producing a negative delay", () => {
  const s = createLatencySource({ mode: "recorded_samples", constantMs: 100, samples: [-50, NaN, 200] });
  const seq = [s.next(), s.next(), s.next()];
  for (const v of seq) assert.ok(Number.isFinite(v) && v >= 0, `${v} must be finite and >= 0`);
  assert.equal(seq[2], 200, "valid samples pass through");
});

test("samples are rounded to whole milliseconds", () => {
  const s = createLatencySource({ mode: "recorded_samples", constantMs: 100, samples: [180.6] });
  assert.equal(s.next(), 181);
});

test("an unknown mode falls back to constant behaviour", () => {
  // Defensive: config could be widened later; must never throw here.
  const s = createLatencySource({ mode: "constant", constantMs: 250, samples: [1, 2] });
  assert.equal(s.next(), 250);
});
