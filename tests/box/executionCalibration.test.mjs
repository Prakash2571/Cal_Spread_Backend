/**
 * Calibration store: dimension isolation, time-bucket gating, freshness, and honest
 * confidence reporting.
 *
 * Covers the required cases:
 *  11. Zerodha and Dhan timing samples never mix.
 *  12. Old calibration becomes STALE.
 *  13. Low sample count reports LOW confidence.
 *  14. Marketable and passive limit stats remain separate.
 *
 * Pure and offline. The wall clock is injected, so staleness is exact rather than timing-dependent.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CALIBRATION_STAGES,
  ExecutionCalibrationStore,
  percentilesOf,
} from "../../dist/box/executionCalibration.js";
import {
  classifyConfidence,
  classifyTimeOfDayBucket,
  istSessionKey,
  IST_MARKET_CLOSE_MINUTES,
  IST_MARKET_OPEN_MINUTES,
} from "../../dist/box/latencyModel.js";

const DAY = 24 * 60 * 60 * 1000;
/** 2026-03-02 09:20 IST — inside the OPEN window. */
const T0 = Date.UTC(2026, 2, 2, 3, 50, 0);

function store(overrides = {}) {
  let now = T0;
  const s = new ExecutionCalibrationStore({
    minSamples: 10,
    bucketMinSamples: 20,
    maxAgeMs: 2 * DAY,
    thresholds: { calibratedMinSamples: 50, staleAfterMs: DAY },
    confidence: { highMinSamples: 100, mediumMinSamples: 10 },
    nowWall: () => now,
    ...overrides,
  });
  return { s, setNow: (v) => (now = v), get now() { return now; } };
}

const dims = (over = {}) => ({
  broker: "zerodha",
  kind: "ENTRY",
  profile: "MARKETABLE_LIMIT",
  bucket: "OPEN",
  ...over,
});

function fill(s, count, valueMs, over = {}, atWall = T0) {
  for (let i = 0; i < count; i++) {
    s.record({ ...dims(over), stage: "post_to_ack_ms", valueMs: valueMs + i, atWall });
  }
}

/* ───────────────────────── dimension isolation ───────────────────────── */

test("REQUIRED 11: Zerodha and Dhan samples never mix", () => {
  const { s } = store();
  fill(s, 40, 100, { broker: "zerodha" });
  fill(s, 40, 900, { broker: "dhan" });

  const z = s.resolve(dims({ broker: "zerodha" }), "post_to_ack_ms");
  const d = s.resolve(dims({ broker: "dhan" }), "post_to_ack_ms");

  assert.equal(z.samples, 40);
  assert.equal(d.samples, 40);
  assert.ok(z.percentiles.p50 < 200, `zerodha p50 ${z.percentiles.p50} was contaminated by dhan`);
  assert.ok(d.percentiles.p50 > 800, `dhan p50 ${d.percentiles.p50} was contaminated by zerodha`);
  assert.equal(s.brokerStatus("zerodha").samples, 40);
  assert.equal(s.brokerStatus("dhan").samples, 40);
});

test("REQUIRED 11: pooling never crosses a broker, even when a broker has no samples at all", () => {
  const { s } = store();
  fill(s, 500, 100, { broker: "zerodha" });
  // Dhan has nothing. It must report unavailable, NOT borrow Zerodha's 500 samples.
  const d = s.resolve(dims({ broker: "dhan" }), "post_to_ack_ms");
  assert.equal(d.fallback, "unavailable");
  assert.equal(d.measured, false);
  assert.equal(d.samples, 0);
  assert.equal(d.percentiles.p50, null);
});

test("REQUIRED 14: marketable and passive statistics stay separate", () => {
  const { s } = store();
  fill(s, 40, 100, { profile: "MARKETABLE_LIMIT" });
  fill(s, 40, 5_000, { profile: "PASSIVE_LIMIT" });

  const m = s.resolve(dims({ profile: "MARKETABLE_LIMIT" }), "post_to_ack_ms");
  const p = s.resolve(dims({ profile: "PASSIVE_LIMIT" }), "post_to_ack_ms");
  assert.ok(m.percentiles.p95 < 200, `marketable p95 ${m.percentiles.p95} absorbed passive samples`);
  assert.ok(p.percentiles.p50 > 4_000, `passive p50 ${p.percentiles.p50} absorbed marketable samples`);
});

test("REQUIRED 14: a profile with no samples never borrows the other profile's", () => {
  const { s } = store();
  fill(s, 500, 100, { profile: "MARKETABLE_LIMIT" });
  const passive = s.resolve(dims({ profile: "PASSIVE_LIMIT" }), "post_to_ack_ms");
  assert.equal(passive.fallback, "unavailable");
  assert.equal(passive.measured, false);
  assert.match(passive.note, /PASSIVE_LIMIT/);
});

test("operation kinds are separated, and cancel latency never comes from entry latency", () => {
  const { s } = store();
  fill(s, 40, 50, { kind: "ENTRY" });
  fill(s, 40, 3_000, { kind: "CANCEL" });
  const cancel = s.resolve(dims({ kind: "CANCEL" }), "post_to_ack_ms");
  assert.equal(cancel.fallback, "none");
  assert.ok(cancel.percentiles.p50 > 2_500);
});

/* ─────────────────────── time-of-day bucket gating ─────────────────────── */

test("time buckets classify the session edges and default to NORMAL outside it", () => {
  assert.equal(classifyTimeOfDayBucket(IST_MARKET_OPEN_MINUTES), "OPEN");
  assert.equal(classifyTimeOfDayBucket(IST_MARKET_OPEN_MINUTES + 14), "OPEN");
  assert.equal(classifyTimeOfDayBucket(IST_MARKET_OPEN_MINUTES + 15), "NORMAL");
  assert.equal(classifyTimeOfDayBucket(12 * 60), "NORMAL");
  assert.equal(classifyTimeOfDayBucket(IST_MARKET_CLOSE_MINUTES - 14), "CLOSE");
  assert.equal(classifyTimeOfDayBucket(IST_MARKET_CLOSE_MINUTES), "CLOSE");
  // Outside the session is not evidence about the open or the close.
  assert.equal(classifyTimeOfDayBucket(6 * 60), "NORMAL");
  assert.equal(classifyTimeOfDayBucket(22 * 60), "NORMAL");
  assert.equal(classifyTimeOfDayBucket(Number.NaN), "NORMAL");
});

test("a thin time bucket is NOT activated — it pools rather than overfitting", () => {
  const { s } = store(); // bucketMinSamples 20, minSamples 10
  fill(s, 12, 100, { bucket: "OPEN" }); // below the bucket bar, above the pooled bar
  const r = s.resolve(dims({ bucket: "OPEN" }), "post_to_ack_ms");
  assert.equal(r.fallback, "bucket_pooled", "12 samples must not activate a narrow bucket");
  assert.equal(r.measured, true);
  assert.match(r.note, /only 12 fresh samples/);
  assert.match(r.note, /overfitting/);
  // A fallback is never HIGH confidence, however clean the numbers look.
  assert.notEqual(r.confidence, "HIGH");
});

test("a bucket with enough of its own observations IS used, and reports no fallback", () => {
  const { s } = store();
  fill(s, 25, 100, { bucket: "OPEN" });
  const r = s.resolve(dims({ bucket: "OPEN" }), "post_to_ack_ms");
  assert.equal(r.fallback, "none");
  assert.equal(r.used.bucket, "OPEN");
  assert.match(r.note, /has 25 fresh samples/);
});

test("pooling across buckets uses the other buckets' samples, not the thin one alone", () => {
  const { s } = store();
  fill(s, 5, 100, { bucket: "OPEN" });
  fill(s, 30, 400, { bucket: "NORMAL" });
  const r = s.resolve(dims({ bucket: "OPEN" }), "post_to_ack_ms");
  assert.equal(r.fallback, "bucket_pooled");
  assert.equal(r.samples, 35, "both buckets contribute to the pooled set");
});

test("pooling escalates to across-kinds before giving up, still within one broker+profile", () => {
  const { s } = store();
  fill(s, 4, 100, { kind: "CANCEL", bucket: "OPEN" });
  fill(s, 30, 120, { kind: "ENTRY", bucket: "NORMAL" });
  const r = s.resolve(dims({ kind: "CANCEL", bucket: "OPEN" }), "post_to_ack_ms");
  assert.equal(r.fallback, "kind_pooled");
  assert.equal(r.samples, 34);
  assert.equal(r.confidence, "MEDIUM", "a cross-kind pool is capped at MEDIUM");
});

/* ────────────────────────── freshness / staleness ────────────────────────── */

test("REQUIRED 12: a calibrated set becomes STALE once its newest sample ages out", () => {
  const { s, setNow } = store(); // calibratedMinSamples 50, staleAfterMs 1 day, maxAgeMs 2 days
  fill(s, 60, 100, { bucket: "OPEN" }, T0);

  // Same session: calibrated and fresh.
  const fresh = s.resolve(dims(), "post_to_ack_ms");
  assert.equal(fresh.status, "CALIBRATED");
  assert.equal(fresh.measured, true);

  // A day and a half later the set is still retained, but it is STALE.
  setNow(T0 + 1.5 * DAY);
  const stale = s.resolve(dims(), "post_to_ack_ms");
  assert.equal(stale.status, "STALE");
  assert.equal(stale.confidence, "LOW", "a stale set is never trusted, however large");
  assert.ok(stale.freshnessMs > DAY);
});

test("REQUIRED 12: samples beyond the retention window are excluded from ACTIVE calibration but still retained", () => {
  const { s, setNow } = store();
  fill(s, 60, 100, { bucket: "OPEN" }, T0);
  setNow(T0 + 3 * DAY); // beyond maxAgeMs of 2 days

  const resolved = s.resolve(dims(), "post_to_ack_ms");
  assert.equal(resolved.fallback, "unavailable", "stale sessions must not calibrate today");
  assert.equal(resolved.measured, false);
  assert.equal(resolved.percentiles.p50, null);

  // But the data is still there for analytics and drift detection.
  const snap = s.snapshot();
  const entry = snap.find((e) => e.bucket === "OPEN" && e.stage === "post_to_ack_ms");
  assert.ok(entry, "the distribution must still be visible in diagnostics");
  assert.equal(entry.samples, 60);
  assert.equal(entry.fresh, false);
  assert.ok(entry.age_ms >= 3 * DAY);
});

test("the newest session is reported, so an operator can see which day is calibrating", () => {
  const { s } = store();
  fill(s, 25, 100, { bucket: "OPEN" }, T0);
  const r = s.resolve(dims(), "post_to_ack_ms");
  assert.equal(r.newestSession, istSessionKey(T0));
  assert.equal(r.newestSession, "2026-03-02");
});

/* ───────────────────────────── confidence ───────────────────────────── */

test("REQUIRED 13: a low sample count reports LOW confidence", () => {
  const { s } = store(); // mediumMinSamples 10
  fill(s, 6, 100, { bucket: "OPEN" });
  const r = s.resolve(dims(), "post_to_ack_ms");
  assert.equal(r.confidence, "LOW");
  assert.ok(r.samples < 10);
});

test("REQUIRED 13: confidence climbs only with fresh, measured, non-fallback samples", () => {
  const { s } = store(); // highMinSamples 100, calibratedMinSamples 50, bucketMinSamples 20
  fill(s, 150, 100, { bucket: "OPEN" });
  const r = s.resolve(dims(), "post_to_ack_ms");
  assert.equal(r.fallback, "none");
  assert.equal(r.status, "CALIBRATED");
  assert.equal(r.confidence, "HIGH");
});

test("an unmeasured resolution is ALWAYS low confidence, whatever else is true", () => {
  // The honesty contract, asserted directly on the classifier.
  assert.equal(
    classifyConfidence({ status: "CALIBRATED", sampleCount: 100_000, measured: false }),
    "LOW",
  );
  assert.equal(classifyConfidence({ status: "STALE", sampleCount: 100_000, measured: true }), "LOW");
  assert.equal(classifyConfidence({ status: "UNCALIBRATED", sampleCount: 0, measured: true }), "LOW");
  assert.equal(
    classifyConfidence({ status: "CALIBRATED", sampleCount: 500, measured: true, fellBack: true }),
    "MEDIUM",
  );
  assert.equal(
    classifyConfidence({ status: "CALIBRATED", sampleCount: 500, measured: true, fellBack: false }),
    "HIGH",
  );
});

test("an unavailable resolution never presents numbers, and says the fallback constant is in use", () => {
  const { s } = store();
  const r = s.resolve(dims(), "ack_to_terminal_ms");
  assert.equal(r.measured, false);
  assert.equal(r.status, "UNCALIBRATED");
  assert.equal(r.confidence, "LOW");
  assert.deepEqual(r.percentiles, { p50: null, p75: null, p90: null, p95: null, p99: null });
  assert.match(r.note, /NOT calibrated/);
  assert.match(r.note, /constant fallback/);
});

/* ─────────────────────── sample hygiene and stages ─────────────────────── */

test("a negative span is dropped, never rounded to zero (a wall-clock subtraction bug)", () => {
  const { s } = store();
  s.record({ ...dims(), stage: "post_to_ack_ms", valueMs: -5, atWall: T0 });
  s.record({ ...dims(), stage: "post_to_ack_ms", valueMs: Number.NaN, atWall: T0 });
  s.record({ ...dims(), stage: "post_to_ack_ms", valueMs: 10, atWall: Number.NaN });
  assert.equal(s.dropped, 3, "malformed samples must be counted, not silently absorbed");
  assert.equal(s.resolve(dims(), "post_to_ack_ms").samples, 0);
});

test("record() is fail-open and never throws on a hostile sample", () => {
  const { s } = store();
  assert.doesNotThrow(() => s.record(null));
  assert.doesNotThrow(() => s.record({}));
  assert.doesNotThrow(() => s.record({ ...dims(), stage: "post_to_ack_ms", valueMs: 1, atWall: T0 }));
});

test("every declared stage can be recorded and resolved independently", () => {
  const { s } = store();
  for (const [i, stage] of CALIBRATION_STAGES.entries()) {
    for (let n = 0; n < 25; n++) {
      s.record({ ...dims(), stage, valueMs: (i + 1) * 100, atWall: T0 });
    }
  }
  for (const [i, stage] of CALIBRATION_STAGES.entries()) {
    const r = s.resolve(dims(), stage);
    assert.equal(r.samples, 25, `${stage} lost samples`);
    assert.equal(r.percentiles.p50, (i + 1) * 100, `${stage} was contaminated by another stage`);
  }
});

test("distributions are bounded: a long run cannot grow memory without limit", () => {
  const { s } = store({ window: 50 });
  fill(s, 5_000, 100, { bucket: "OPEN" });
  const entry = s.snapshot().find((e) => e.stage === "post_to_ack_ms");
  assert.equal(entry.samples, 50, "the ring must stay at its capacity");
  assert.equal(entry.total_observed, 5_000, "but the true observation count is still reported");
});

test("percentilesOf reports the full p50/p75/p90/p95/p99 set, or all nulls when empty", () => {
  assert.deepEqual(percentilesOf([]), { p50: null, p75: null, p90: null, p95: null, p99: null });
  const p = percentilesOf(Array.from({ length: 100 }, (_, i) => i + 1));
  assert.equal(p.p50, 51);
  assert.equal(p.p75, 76);
  assert.equal(p.p90, 91);
  assert.equal(p.p95, 96);
  assert.equal(p.p99, 100);
});

/* ───────────────────────── export / import ───────────────────────── */

test("export/import round-trips distributions so calibration survives a restart", () => {
  const { s } = store({ region: "ap-south-1" });
  fill(s, 30, 250, { bucket: "NORMAL" });
  const payload = s.export();
  assert.equal(payload.region, "ap-south-1");
  assert.ok(payload.entries.length > 0);

  const restored = new ExecutionCalibrationStore({
    region: "ap-south-1",
    minSamples: 10,
    bucketMinSamples: 20,
    maxAgeMs: 2 * DAY,
    nowWall: () => T0,
  });
  const result = restored.import(payload);
  assert.equal(result.reason, null);
  assert.ok(result.imported > 0);
  const r = restored.resolve(dims({ bucket: "NORMAL" }), "post_to_ack_ms");
  assert.equal(r.samples, 30);
  assert.equal(r.measured, true);
});

test("importing another region's calibration is REFUSED, with a visible reason", () => {
  const { s } = store({ region: "ap-south-1" });
  fill(s, 30, 250);
  const payload = s.export();

  const other = new ExecutionCalibrationStore({ region: "us-east-1", nowWall: () => T0 });
  const result = other.import(payload);
  assert.equal(result.imported, 0);
  assert.equal(result.skipped, payload.entries.length);
  assert.match(result.reason, /region mismatch/);
  // Nothing leaked in.
  assert.equal(other.resolve(dims(), "post_to_ack_ms").samples, 0);
});

test("an export carries only latency numbers and dimension labels — no secrets", () => {
  const { s } = store({ region: "ap-south-1" });
  fill(s, 5, 100);
  const serialized = JSON.stringify(s.export()).toLowerCase();
  for (const forbidden of ["token", "api_key", "apikey", "secret", "password", "authorization"]) {
    assert.ok(!serialized.includes(forbidden), `export leaked "${forbidden}"`);
  }
});

test("unknown dimensions in an imported payload are skipped rather than trusted", () => {
  const target = new ExecutionCalibrationStore({ nowWall: () => T0, minSamples: 1, bucketMinSamples: 1 });
  const result = target.import({
    region: null,
    generated_at_wall: T0,
    entries: [
      {
        broker: "some_other_broker",
        kind: "ENTRY",
        profile: "MARKETABLE_LIMIT",
        bucket: "OPEN",
        stage: "post_to_ack_ms",
        values: [1, 2, 3],
        newestAtWall: T0,
        newestSession: "2026-03-02",
        totalObserved: 3,
      },
    ],
  });
  assert.equal(result.imported, 0);
  assert.equal(result.skipped, 1);
});
