/**
 * Replay the live-parity execution fixtures against the current TypeScript.
 *
 * Same discipline as migrationFixtures.test.mjs: these language-neutral JSON files record
 * what the ledger / latency source / bounded-LIMIT walk DO, so the future Go port can be
 * proven equivalent. A failure here means a behavioural change to freeze-and-review, not
 * something to fix by regenerating.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PaperLiquidityLedger } from "../../dist/box/liquidityLedger.js";
import { createLatencySource } from "../../dist/box/latencySource.js";
import { walkDepth } from "../../dist/box/orderPricing.js";
import { createSchedulingPolicy } from "../../dist/box/executionSchedulingPolicy.js";
import { planPaperSchedule } from "../../dist/box/paperScheduler.js";
import { createStructuredLatencySource, classifyCalibration } from "../../dist/box/latencyModel.js";
import {
  classifyConfidence,
  classifyTimeOfDayBucket,
  istSessionKey,
} from "../../dist/box/latencyModel.js";
import {
  BOX_ORDER_STAGES,
  CumulativeFillLedger,
  durableStateForStage,
  isTerminalStage,
  outstandingQuantity,
  stageAcceptsFurtherFills,
  stageFromCumulativeQuantity,
  terminalQuantityAccounting,
} from "../../dist/box/orderLifecycle.js";
import { ExecutionCalibrationStore } from "../../dist/box/executionCalibration.js";
import { computeExecutionShortfall } from "../../dist/box/executionShortfall.js";
import { QueueCalibrationEstimator, classifyLiquidity } from "../../dist/box/queueCalibration.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migration-fixtures", "box-parity");
const load = (f) => JSON.parse(readFileSync(join(DIR, f), "utf8"));

test("liquidity-ledger.json: reproduces the recorded reservations", () => {
  const { cases } = load("liquidity-ledger.json");
  for (const c of cases) {
    if (c.name.startsWith("two attempts")) {
      const { effective, wantA, wantB, gen, token, side, price, version } = c.input;
      const l = new PaperLiquidityLedger();
      const fillA = Math.min(wantA, l.availableAt(gen, token, side, price, version, effective));
      l.reserve(gen, token, side, price, version, fillA);
      const fillB = Math.min(wantB, l.availableAt(gen, token, side, price, version, effective));
      assert.deepEqual({ fillA, fillB, combined: fillA + fillB }, c.expected);
    } else if (c.name.startsWith("new book version")) {
      const { gen, token, side, price, oldVersion, newVersion, effective } = c.input;
      const l = new PaperLiquidityLedger();
      l.reserve(gen, token, side, price, oldVersion, effective);
      assert.deepEqual(
        {
          availableOldVersion: l.availableAt(gen, token, side, price, oldVersion, effective),
          availableNewVersion: l.availableAt(gen, token, side, price, newVersion, effective),
        },
        c.expected,
      );
    } else {
      const { gen, token, side, price, currentVersion, staleVersion } = c.input;
      const l = new PaperLiquidityLedger();
      l.reserve(gen, token, side, price, currentVersion, 40);
      const staleReserveResult = l.reserve(gen, token, side, price, staleVersion, 30);
      assert.deepEqual(
        { staleReserveResult, currentAvailable: l.availableAt(gen, token, side, price, currentVersion, 70) },
        c.expected,
      );
    }
  }
});

test("latency-source.json: reproduces the recorded sequences", () => {
  const { cases } = load("latency-source.json");
  for (const c of cases) {
    const s = createLatencySource(c.input.config);
    const sequence = Array.from({ length: c.input.draws }, () => s.next());
    assert.deepEqual({ sequence }, c.expected);
  }
});

test("bounded-limit-walk.json: reproduces the recorded fills", () => {
  const { cases } = load("bounded-limit-walk.json");
  for (const c of cases) {
    const { side, levels, remainingQty, limitPrice, queueModel, haircutPct, at, quoteVersion } = c.input;
    const reserved =
      c.input.reservedAt10000 !== undefined
        ? (price) => (Math.round(price * 100) === 10000 ? c.input.reservedAt10000 : 0)
        : undefined;
    const walk = walkDepth({ side, levels, remainingQty, limitPrice, queueModel, haircutPct, at, quoteVersion, reserved });
    const actual = {
      filled_qty: walk.filled_qty,
      executable_within_limit: walk.executable_within_limit,
      slice_prices: walk.slices.map((s) => s.price),
    };
    if (c.expected.average_price !== undefined) actual.average_price = walk.average_price;
    assert.deepEqual(actual, c.expected);
  }
});

test("paper-scheduler.json: reproduces the recorded schedule", () => {
  const { cases } = load("paper-scheduler.json");
  for (const c of cases) {
    const policy = createSchedulingPolicy(c.input.policy);
    const scheduled = planPaperSchedule(c.input.operations, policy);
    const pick = (s) => ({
      id: s.id,
      dequeued_at: s.dequeued_at,
      post_started_at: s.post_started_at,
      ack_at: s.ack_at,
      terminal_at: s.terminal_at,
    });
    const actual = { schedule: scheduled.map(pick) };
    if (c.expected.posts !== undefined) {
      actual.posts = scheduled.map((s) => s.post_started_at).sort((a, b) => a - b);
    }
    assert.deepEqual(actual, c.expected, c.name);
  }
});

test("structured-latency.json: reproduces the recorded component sequences", () => {
  const { cases } = load("structured-latency.json");
  for (const c of cases) {
    const s = createStructuredLatencySource(c.input.config);
    const sequence = Array.from({ length: c.input.draws }, () => s.next());
    assert.deepEqual({ sequence, calibrated: s.calibrated }, c.expected, c.name);
  }
});

test("calibration-status.json: reproduces the recorded classifications", () => {
  const { cases } = load("calibration-status.json");
  for (const c of cases) {
    const status = classifyCalibration(c.input.sampleCount, c.input.lastSampleAgeMs, c.input.thresholds);
    assert.deepEqual({ status }, c.expected, c.name);
  }
});


/* ─────────────────────────────────────────────────────────────────────────────
 * Live-calibrated execution twin: order lifecycle, calibration resolution,
 * shortfall attribution and queue calibration.
 *
 * Same discipline as everything above — these fixtures were GENERATED from the current
 * TypeScript, so a failure here means behaviour changed and is a finding to review, not
 * something to fix by regenerating. The future Go/Rust port must reproduce them exactly.
 * ───────────────────────────────────────────────────────────────────────────── */

test("order-lifecycle-stages.json: the stage vocabulary and the ACK-is-not-fill rule", () => {
  const { cases } = load("order-lifecycle-stages.json");
  assert.equal(cases.length, BOX_ORDER_STAGES.length, "every stage must be pinned");
  for (const c of cases) {
    assert.deepEqual(
      {
        durable_state: durableStateForStage(c.input.stage),
        terminal: isTerminalStage(c.input.stage),
        accepts_further_fills: stageAcceptsFurtherFills(c.input.stage),
      },
      c.expected,
      c.name,
    );
  }
  // The load-bearing invariant, asserted against the fixture rather than the code.
  const cancelling = cases.filter((c) => c.input.stage.startsWith("CANCEL_"));
  assert.equal(cancelling.length, 2);
  for (const c of cancelling) {
    assert.equal(c.expected.accepts_further_fills, true, `${c.input.stage} must still accept fills`);
    assert.equal(c.expected.terminal, false);
  }
});

test("cumulative-fill-ledger.json: idempotent, monotonic, cumulative-authoritative accounting", () => {
  const { cases } = load("cumulative-fill-ledger.json");
  for (const c of cases) {
    if (c.name.startsWith("cancel race")) {
      const ledger = new CumulativeFillLedger("replay", c.input.requestedQty);
      const applied = c.input.steps.map((step) => {
        const r = ledger.apply(step);
        return { outcome: r.outcome, delta: r.delta, cumulative: r.cumulative, remaining: r.remaining };
      });
      const accounting = terminalQuantityAccounting({
        requestedQty: c.input.requestedQty,
        finalCumulativeQty: ledger.cumulative,
        cumulativeAtCancelRequest: c.input.cumulativeAtCancelRequest,
      });
      assert.deepEqual({ applied, accounting }, c.expected, c.name);
      // The brief's numbers, restated as an explicit guard.
      assert.equal(accounting.filled, 52, "filled must be 52, never 40");
      assert.equal(accounting.cancelled, 23);
    } else if (c.name.startsWith("a duplicate")) {
      const ledger = new CumulativeFillLedger(c.input.clientOrderId, c.input.requestedQty);
      const applied = Array.from({ length: c.input.deliveries }, () => {
        const r = ledger.apply(c.input.event);
        return { outcome: r.outcome, delta: r.delta, cumulative: r.cumulative };
      });
      assert.deepEqual({ applied, snapshot: ledger.snapshot() }, c.expected, c.name);
    } else if (c.name.startsWith("an out-of-order")) {
      const ledger = new CumulativeFillLedger("replay", c.input.requestedQty);
      const applied = c.input.steps.map((step) => {
        const r = ledger.apply(step);
        return {
          outcome: r.outcome,
          delta: r.delta,
          cumulative: r.cumulative,
          sequenceRegression: r.sequenceRegression,
        };
      });
      assert.deepEqual({ applied }, c.expected, c.name);
    } else if (c.name.startsWith("an overfill")) {
      const ledger = new CumulativeFillLedger("replay", c.input.requestedQty);
      const r = ledger.apply({ cumulativeQty: c.input.cumulativeQty, source: "rest_poll" });
      assert.deepEqual(
        { outcome: r.outcome, cumulative: r.cumulative, overfill: r.overfill, remaining: r.remaining },
        c.expected,
        c.name,
      );
    } else {
      const actual = c.input.map((row) => ({
        outstanding: outstandingQuantity(row.requestedQty, row.cumulativeQty),
        stage: stageFromCumulativeQuantity(
          row.cumulativeQty === 0
            ? { requestedQty: row.requestedQty, cumulativeQty: 0, cancelConfirmed: true }
            : row,
        ),
      }));
      assert.deepEqual(actual, c.expected, c.name);
    }
  }
});

test("calibration-resolution.json: the fallback ladder, freshness and the honesty contract", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const T0 = Date.UTC(2026, 2, 2, 6, 30, 0);
  const dims = (over = {}) => ({
    broker: "zerodha",
    kind: "ENTRY",
    profile: "MARKETABLE_LIMIT",
    bucket: "NORMAL",
    ...over,
  });
  const opts = (nowWall) => ({
    minSamples: 10,
    bucketMinSamples: 20,
    maxAgeMs: 2 * DAY,
    thresholds: { calibratedMinSamples: 50, staleAfterMs: DAY },
    confidence: { highMinSamples: 100, mediumMinSamples: 10 },
    nowWall: () => nowWall,
  });
  const strip = (r) => ({
    fallback: r.fallback,
    status: r.status,
    confidence: r.confidence,
    samples: r.samples,
    measured: r.measured,
    percentiles: r.percentiles,
    newestSession: r.newestSession,
  });
  const seed = (store, count, valueMs, over, atWall) => {
    for (let i = 0; i < count; i++) {
      store.record({ ...dims(over), stage: "post_to_ack_ms", valueMs, atWall });
    }
  };

  const build = {
    "an adequately-sampled bucket is used directly": () => {
      const s = new ExecutionCalibrationStore(opts(T0));
      seed(s, 25, 120, { bucket: "NORMAL" }, T0);
      return s.resolve(dims(), "post_to_ack_ms");
    },
    "a thin bucket pools across buckets rather than overfitting": () => {
      const s = new ExecutionCalibrationStore(opts(T0));
      seed(s, 5, 100, { bucket: "OPEN" }, T0);
      seed(s, 30, 400, { bucket: "NORMAL" }, T0);
      return s.resolve(dims({ bucket: "OPEN" }), "post_to_ack_ms");
    },
    "a thin kind pools across kinds, still within one broker and profile": () => {
      const s = new ExecutionCalibrationStore(opts(T0));
      seed(s, 4, 100, { kind: "CANCEL", bucket: "OPEN" }, T0);
      seed(s, 30, 120, { kind: "ENTRY", bucket: "NORMAL" }, T0);
      return s.resolve(dims({ kind: "CANCEL", bucket: "OPEN" }), "post_to_ack_ms");
    },
    "pooling NEVER crosses a broker": () => {
      const s = new ExecutionCalibrationStore(opts(T0));
      seed(s, 500, 100, { broker: "zerodha" }, T0);
      return s.resolve(dims({ broker: "dhan" }), "post_to_ack_ms");
    },
    "pooling NEVER crosses the marketable/passive boundary": () => {
      const s = new ExecutionCalibrationStore(opts(T0));
      seed(s, 500, 100, { profile: "MARKETABLE_LIMIT" }, T0);
      return s.resolve(dims({ profile: "PASSIVE_LIMIT" }), "post_to_ack_ms");
    },
    "a calibrated set past the staleness window is STALE and LOW confidence": () => {
      const s = new ExecutionCalibrationStore(opts(T0 + 1.5 * DAY));
      seed(s, 60, 100, { bucket: "NORMAL" }, T0);
      return s.resolve(dims(), "post_to_ack_ms");
    },
    "a set beyond the retention window cannot calibrate today": () => {
      const s = new ExecutionCalibrationStore(opts(T0 + 3 * DAY));
      seed(s, 60, 100, { bucket: "NORMAL" }, T0);
      return s.resolve(dims(), "post_to_ack_ms");
    },
  };

  const { cases } = load("calibration-resolution.json");
  for (const c of cases) {
    const factory = build[c.name];
    assert.ok(factory, `no replay defined for "${c.name}"`);
    assert.deepEqual(strip(factory()), c.expected, c.name);
  }
  // Whatever the numbers, an unmeasured resolution must never present percentiles.
  for (const c of cases) {
    if (c.expected.measured === false) {
      assert.deepEqual(
        c.expected.percentiles,
        { p50: null, p75: null, p90: null, p95: null, p99: null },
        `${c.name} must not present percentiles it did not measure`,
      );
      assert.equal(c.expected.confidence, "LOW");
    }
  }
});

test("calibration-confidence.json: reproduces the recorded confidence classifications", () => {
  const { cases } = load("calibration-confidence.json");
  for (const c of cases) {
    assert.deepEqual({ confidence: classifyConfidence(c.input) }, c.expected, c.name);
  }
});

test("time-of-day-buckets.json: reproduces the recorded session bucketing", () => {
  const { cases } = load("time-of-day-buckets.json");
  for (const c of cases) {
    if (c.input.atWall !== undefined) {
      assert.deepEqual({ session: istSessionKey(c.input.atWall) }, c.expected, c.name);
    } else {
      assert.deepEqual({ bucket: classifyTimeOfDayBucket(c.input.istMinutesOfDay) }, c.expected, c.name);
    }
  }
});

test("implementation-shortfall.json: reproduces the recorded attribution", () => {
  const { cases } = load("implementation-shortfall.json");
  for (const c of cases) {
    assert.deepEqual(computeExecutionShortfall(c.input), c.expected, c.name);
  }
});

test("queue-calibration.json: reproduces the recorded realisation ratios and recommendations", () => {
  const observation = (over = {}) => ({
    broker: "zerodha",
    profile: "MARKETABLE_LIMIT",
    side: "BUY",
    tradingsymbol: "NIFTY26SEP19900CE",
    displayedQtyAtSubmit: 300,
    executableWithinLimitAtSubmit: 150,
    requestedQty: 75,
    limitOffsetTicks: 2,
    immediatelyMarketable: true,
    filledQty: 75,
    fillLatencyMs: 120,
    partial: false,
    bookUpdatesWhileWorking: 3,
    atWall: 1700000000000,
    ...over,
  });
  const strip = (r) => ({
    samples: r.samples,
    realisationRatioP50: r.realisationRatioP50,
    realisationRatioP25: r.realisationRatioP25,
    realisationRatioP10: r.realisationRatioP10,
    recommendedHaircutPct: r.recommendedHaircutPct,
    currentHaircutPct: r.currentHaircutPct,
    confidence: r.confidence,
    partialFillRate: r.partialFillRate,
    sizeExceededVisibleDepthRate: r.sizeExceededVisibleDepthRate,
  });

  const { cases } = load("queue-calibration.json");
  for (const c of cases) {
    if (c.name.startsWith("below the sample floor")) {
      const est = new QueueCalibrationEstimator({ currentHaircutPct: 30, minSamples: 30 });
      for (let i = 0; i < c.input.observations; i++) est.record(observation());
      assert.deepEqual(strip(est.recommend("zerodha", "MARKETABLE_LIMIT", "NORMAL")), c.expected, c.name);
      assert.equal(c.expected.recommendedHaircutPct, null, "no evidence ⇒ no recommendation");
    } else if (c.name.startsWith("40 full")) {
      const est = new QueueCalibrationEstimator({
        currentHaircutPct: 30,
        minSamples: 10,
        highConfidenceSamples: 100,
      });
      for (let i = 0; i < c.input.fullOrders; i++) est.record(observation({ filledQty: 75 }));
      for (let i = 0; i < c.input.halfOrders; i++) est.record(observation({ filledQty: 37, partial: true }));
      assert.deepEqual(strip(est.recommend("zerodha", "MARKETABLE_LIMIT", "NORMAL")), c.expected, c.name);
    } else {
      const actual = c.input.map((row) => classifyLiquidity(row.visible, row.requested));
      assert.deepEqual(actual, c.expected, c.name);
    }
  }
});
