/**
 * The calibrated latency source: consumes measured distributions when they exist, falls back
 * safely and honestly when they do not, and never labels a constant as measured.
 *
 * Deterministic and offline — no randomness anywhere in the source under test.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ExecutionCalibrationStore } from "../../dist/box/executionCalibration.js";
import {
  CalibratedStructuredLatencySource,
  UNCALIBRATED_ACK_TO_TERMINAL_FRACTION,
  formatCalibrationBlock,
} from "../../dist/box/calibratedLatencySource.js";

const DAY = 24 * 60 * 60 * 1000;
/** 2026-03-02 12:00 IST — squarely inside NORMAL. */
const T0 = Date.UTC(2026, 2, 2, 6, 30, 0);

const dims = (over = {}) => ({
  broker: "zerodha",
  kind: "ENTRY",
  profile: "MARKETABLE_LIMIT",
  bucket: "NORMAL",
  ...over,
});

function harness({ storeOpts = {}, sourceOpts = {}, dimensions } = {}) {
  let now = T0;
  const store = new ExecutionCalibrationStore({
    minSamples: 10,
    bucketMinSamples: 20,
    maxAgeMs: 2 * DAY,
    thresholds: { calibratedMinSamples: 50, staleAfterMs: DAY },
    confidence: { highMinSamples: 100, mediumMinSamples: 10 },
    nowWall: () => now,
    ...storeOpts,
  });
  let current = dims();
  const source = new CalibratedStructuredLatencySource({
    store,
    dimensions: dimensions ?? (() => current),
    fallbackConstantMs: 250,
    ...sourceOpts,
  });
  return {
    store,
    source,
    setNow: (v) => (now = v),
    setDimensions: (d) => (current = d),
    seed(stage, values, over = {}, atWall = T0) {
      for (const v of values) store.record({ ...dims(over), stage, valueMs: v, atWall });
    },
  };
}

/* ───────────────────────── uncalibrated fallback ───────────────────────── */

test("with no samples at all it uses the configured constant and says so", () => {
  const { source } = harness();
  assert.equal(source.calibrated, false);
  assert.equal(source.fullyCalibrated, false);
  assert.equal(source.mode, "constant");

  const draw = source.next();
  assert.equal(draw.postToAckMs, 250, "the documented fallback constant");
  assert.equal(
    draw.ackToTerminalMs,
    Math.round(250 * UNCALIBRATED_ACK_TO_TERMINAL_FRACTION),
    "an uncalibrated run still separates travel time from working time",
  );

  const status = source.status();
  assert.equal(status.measured, false, "a constant must NEVER be reported as measured");
  assert.equal(status.confidence, "LOW");
  assert.equal(status.status, "UNCALIBRATED");
  assert.equal(status.samples, 0);
  assert.equal(status.freshnessMs, null);
  assert.equal(status.postToAck.fallbackConstantMs, 250);
  assert.equal(status.postToAck.fallbackReason, "no_samples");
  assert.match(status.note, /NOT MEASURED/);
  assert.match(status.note, /250ms/, "the constant must be named in the note");
});

test("the uncalibrated fallback matches the previous behaviour exactly (no silent change)", () => {
  const { source } = harness({ sourceOpts: { fallbackConstantMs: 400 } });
  const draw = source.next();
  assert.equal(draw.postToAckMs, 400);
  assert.equal(draw.ackToTerminalMs, 160); // round(400 * 0.4)
});

test("too few samples is treated as uncalibrated, with the reason recorded", () => {
  const h = harness(); // minSamples 10
  h.seed("post_to_ack_ms", [10, 20, 30]);
  const status = h.source.status();
  assert.equal(status.measured, false);
  assert.equal(status.postToAck.fallbackReason, "insufficient_samples");
  assert.equal(h.source.next().postToAckMs, 250, "it must not draw from 3 observations");
});

/* ──────────────────────── measured consumption ──────────────────────── */

test("a calibrated stage draws the ACTUAL measured samples, in a fixed reproducible rotation", () => {
  const h = harness();
  const samples = [80, 95, 110, 130, 900, 100, 88, 92, 105, 120, 99, 101, 97, 103, 111, 89, 94, 98, 102, 107, 115, 125, 135, 145, 155];
  h.seed("post_to_ack_ms", samples);

  assert.equal(h.source.calibrated, true);
  assert.equal(h.source.mode, "recorded_samples");

  const first = Array.from({ length: samples.length }, () => h.source.next().postToAckMs);
  // Every drawn value is a real observation — nothing interpolated or invented.
  for (const v of first) assert.ok(samples.includes(v), `${v} is not a measured sample`);
  // The tail is preserved: a constant could never produce the 900ms observation.
  assert.ok(first.includes(900), "the measured right tail must survive into paper");

  // Determinism: reset reproduces the identical sequence.
  h.source.reset();
  const second = Array.from({ length: samples.length }, () => h.source.next().postToAckMs);
  assert.deepEqual(second, first, "the same samples must yield the same draws every run");
});

test("both stages calibrated ⇒ fullyCalibrated, measured:true, and no constant in play", () => {
  const h = harness();
  const post = Array.from({ length: 60 }, (_, i) => 90 + i);
  const ack = Array.from({ length: 60 }, (_, i) => 400 + i);
  h.seed("post_to_ack_ms", post);
  h.seed("ack_to_terminal_ms", ack);

  assert.equal(h.source.fullyCalibrated, true);
  const status = h.source.status();
  assert.equal(status.measured, true);
  assert.equal(status.postToAck.fallbackConstantMs, null);
  assert.equal(status.ackToTerminal.fallbackConstantMs, null);
  assert.equal(status.samples, 120);
  assert.equal(status.status, "CALIBRATED");
  assert.match(status.note, /measured samples/);
  assert.doesNotMatch(status.note, /NOT MEASURED/);

  const draw = h.source.next();
  assert.ok(post.includes(draw.postToAckMs));
  assert.ok(ack.includes(draw.ackToTerminalMs));
});

test("stages calibrate independently: one measured stage does not imply the other", () => {
  const h = harness();
  h.seed("post_to_ack_ms", Array.from({ length: 60 }, (_, i) => 90 + i));
  // ack_to_terminal_ms deliberately left empty.

  assert.equal(h.source.calibrated, true, "one measured stage counts as partially calibrated");
  assert.equal(h.source.fullyCalibrated, false);
  const status = h.source.status();
  assert.equal(status.measured, false, "measured is the STRICT reading: both stages or nothing");
  assert.equal(status.postToAck.measured, true);
  assert.equal(status.ackToTerminal.measured, false);
  assert.equal(h.source.next().ackToTerminalMs, 100, "the uncalibrated stage keeps its constant");
});

/* ───────────────────── stale / freshness behaviour ───────────────────── */

test("a STALE set falls back to the constant rather than being quietly reused", () => {
  const h = harness();
  h.seed("post_to_ack_ms", Array.from({ length: 60 }, (_, i) => 90 + i), {}, T0);
  assert.equal(h.source.status().measured, false); // ack stage still uncalibrated
  assert.equal(h.source.status().postToAck.measured, true);

  // Move three days on — beyond the retention window entirely.
  h.setNow(T0 + 3 * DAY);
  h.source.invalidate();
  const status = h.source.status();
  assert.equal(status.postToAck.measured, false, "yesterday's tail is not today's");
  assert.equal(status.postToAck.fallbackReason, "no_samples");
  assert.equal(h.source.next().postToAckMs, 250);
});

test("confidence is the WEAKER of the two stages, never the better one", () => {
  const h = harness(); // highMinSamples 100
  h.seed("post_to_ack_ms", Array.from({ length: 150 }, (_, i) => 90 + (i % 40))); // HIGH
  h.seed("ack_to_terminal_ms", Array.from({ length: 12 }, (_, i) => 400 + i)); // below mediumMinSamples? no: 12 >= 10
  const status = h.source.status();
  assert.equal(status.postToAck.resolution.confidence, "HIGH");
  assert.notEqual(status.ackToTerminal.resolution.confidence, "HIGH");
  assert.notEqual(status.confidence, "HIGH", "the report must not inherit the stronger stage");
});

/* ───────────────────── time-of-day bucket switching ───────────────────── */

test("changing time bucket re-resolves, so an OPEN draw uses OPEN samples", () => {
  const h = harness();
  h.seed("post_to_ack_ms", Array.from({ length: 30 }, () => 1_000), { bucket: "OPEN" }, T0);
  h.seed("post_to_ack_ms", Array.from({ length: 30 }, () => 100), { bucket: "NORMAL" }, T0);
  h.seed("ack_to_terminal_ms", Array.from({ length: 30 }, () => 50), { bucket: "OPEN" }, T0);
  h.seed("ack_to_terminal_ms", Array.from({ length: 30 }, () => 50), { bucket: "NORMAL" }, T0);

  h.setDimensions(dims({ bucket: "NORMAL" }));
  assert.equal(h.source.next().postToAckMs, 100);

  h.setDimensions(dims({ bucket: "OPEN" }));
  assert.equal(h.source.next().postToAckMs, 1_000, "the open is genuinely slower and must be used");
});

test("REQUIRED 11 (source level): a source for one broker never draws the other broker's samples", () => {
  const h = harness();
  h.seed("post_to_ack_ms", Array.from({ length: 60 }, () => 100), { broker: "zerodha" });
  h.seed("ack_to_terminal_ms", Array.from({ length: 60 }, () => 40), { broker: "zerodha" });

  h.setDimensions(dims({ broker: "dhan" }));
  const status = h.source.status();
  assert.equal(status.measured, false, "dhan has no samples and must not borrow zerodha's");
  assert.equal(h.source.next().postToAckMs, 250);
});

/* ───────────────────── caching / refresh behaviour ───────────────────── */

test("newly measured samples are picked up after the refresh interval, without a per-draw sort", () => {
  const h = harness({ sourceOpts: { refreshEveryDraws: 3 } });
  assert.equal(h.source.next().postToAckMs, 250); // draw 1, uncalibrated

  h.seed("post_to_ack_ms", Array.from({ length: 60 }, () => 111));
  // Still cached for the remainder of the interval — that is the deliberate trade.
  h.source.next(); // 2
  h.source.next(); // 3
  assert.equal(h.source.next().postToAckMs, 111, "resolution refreshes after the interval");
});

test("invalidate() forces an immediate re-resolution", () => {
  const h = harness({ sourceOpts: { refreshEveryDraws: 100_000 } });
  assert.equal(h.source.next().postToAckMs, 250);
  h.seed("post_to_ack_ms", Array.from({ length: 60 }, () => 77));
  assert.equal(h.source.next().postToAckMs, 250, "still cached");
  h.source.invalidate();
  assert.equal(h.source.next().postToAckMs, 77);
});

/* ─────────────────────────── the report block ─────────────────────────── */

test("the calibration block shows the evidence next to the confidence", () => {
  const h = harness({ storeOpts: { region: "ap-south-1" } });
  h.seed("post_to_ack_ms", Array.from({ length: 120 }, (_, i) => 90 + (i % 30)));
  h.seed("ack_to_terminal_ms", Array.from({ length: 120 }, (_, i) => 400 + (i % 30)));

  const block = formatCalibrationBlock(h.source.status());
  assert.match(block, /^CALIBRATION:/);
  assert.match(block, /broker: zerodha/);
  assert.match(block, /region: ap-south-1/);
  assert.match(block, /sample count: 240/);
  assert.match(block, /profile: MARKETABLE_LIMIT/);
  assert.match(block, /confidence: (LOW|MEDIUM|HIGH)/);
  assert.match(block, /measured: yes/);
});

test("an uncalibrated block states plainly that a constant is in use", () => {
  const { source } = harness();
  const block = formatCalibrationBlock(source.status());
  assert.match(block, /confidence: LOW/);
  assert.match(block, /measured: NO — a configured constant is in use/);
  assert.match(block, /freshness: n\/a \(no measured samples\)/);
  // There must be no bare realism claim anywhere in the block.
  assert.doesNotMatch(block, /\d+% realistic/);
});

test("a draw is never negative and never non-finite, whatever the samples contain", () => {
  const h = harness();
  h.seed("post_to_ack_ms", Array.from({ length: 60 }, () => 0));
  h.seed("ack_to_terminal_ms", Array.from({ length: 60 }, () => 0));
  for (let i = 0; i < 10; i++) {
    const d = h.source.next();
    assert.ok(Number.isFinite(d.postToAckMs) && d.postToAckMs >= 0);
    assert.ok(Number.isFinite(d.ackToTerminalMs) && d.ackToTerminalMs >= 0);
  }
});
