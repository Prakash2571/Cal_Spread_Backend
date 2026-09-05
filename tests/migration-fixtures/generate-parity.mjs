/**
 * Generate the language-neutral fixtures for the live-parity execution primitives.
 *
 * Same contract as tests/migration-fixtures/generate.mjs: every `expected` is PRODUCED
 * BY the current TypeScript implementation, never hand-written, and a changed fixture
 * means changed behaviour — a finding, not a chore. The future Go port of the liquidity
 * ledger, latency source and bounded-LIMIT walk must reproduce these exactly.
 *
 * Usage (after `npm run build`):  node tests/migration-fixtures/generate-parity.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
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
  CumulativeFillLedger,
  BOX_ORDER_STAGES,
  durableStateForStage,
  stageAcceptsFurtherFills,
  stageFromCumulativeQuantity,
  isTerminalStage,
  outstandingQuantity,
  terminalQuantityAccounting,
} from "../../dist/box/orderLifecycle.js";
import { ExecutionCalibrationStore } from "../../dist/box/executionCalibration.js";
import { computeExecutionShortfall } from "../../dist/box/executionShortfall.js";
import { classifyLiquidity, QueueCalibrationEstimator } from "../../dist/box/queueCalibration.js";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "box-parity");

const files = [];
function fixture(file, operation, description, cases) {
  files.push({
    file,
    body: {
      category: "execution-parity",
      operation,
      description,
      generated_from: "TypeScript reference implementation (src/box)",
      cases,
    },
  });
}

/* 1 ─ shared liquidity reservation ---------------------------------------- */

fixture(
  "liquidity-ledger.json",
  "PaperLiquidityLedger",
  "Two concurrent paper attempts share one observed level; a new book version is fresh.",
  (() => {
    const cases = [];

    // Two boxes want 75 each of a level whose effective depth is 70.
    const l1 = new PaperLiquidityLedger();
    const availA = l1.availableAt(0, 100, "BUY", 100.1, 7, 70);
    const fillA = Math.min(75, availA);
    l1.reserve(0, 100, "BUY", 100.1, 7, fillA);
    const availB = l1.availableAt(0, 100, "BUY", 100.1, 7, 70);
    const fillB = Math.min(75, availB);
    cases.push({
      name: "two attempts cannot double-consume one level",
      input: { effective: 70, wantA: 75, wantB: 75, gen: 0, token: 100, side: "BUY", price: 100.1, version: 7 },
      expected: { fillA, fillB, combined: fillA + fillB },
    });

    // A new version releases the reservation.
    const l2 = new PaperLiquidityLedger();
    l2.reserve(0, 100, "BUY", 100.1, 7, 70);
    cases.push({
      name: "new book version is fresh liquidity",
      input: { gen: 0, token: 100, side: "BUY", price: 100.1, oldVersion: 7, newVersion: 8, effective: 70 },
      expected: {
        availableOldVersion: l2.availableAt(0, 100, "BUY", 100.1, 7, 70),
        availableNewVersion: l2.availableAt(0, 100, "BUY", 100.1, 8, 70),
      },
    });

    // A stale (superseded) reservation is ignored.
    const l3 = new PaperLiquidityLedger();
    l3.reserve(0, 100, "BUY", 100.1, 8, 40);
    const staleReserve = l3.reserve(0, 100, "BUY", 100.1, 7, 30);
    cases.push({
      name: "a superseded-version reserve is a no-op",
      input: { gen: 0, token: 100, side: "BUY", price: 100.1, currentVersion: 8, staleVersion: 7 },
      expected: { staleReserveResult: staleReserve, currentAvailable: l3.availableAt(0, 100, "BUY", 100.1, 8, 70) },
    });

    return cases;
  })(),
);

/* 2 ─ deterministic latency source ---------------------------------------- */

fixture(
  "latency-source.json",
  "createLatencySource",
  "Constant and recorded-sample latency, consumed in a fixed order; a seed only rotates the start.",
  (() => {
    const draw = (config, n) => {
      const s = createLatencySource(config);
      return Array.from({ length: n }, () => s.next());
    };
    return [
      {
        name: "constant",
        input: { config: { mode: "constant", constantMs: 250 }, draws: 4 },
        expected: { sequence: draw({ mode: "constant", constantMs: 250 }, 4) },
      },
      {
        name: "recorded samples cycle in order",
        input: { config: { mode: "recorded_samples", constantMs: 250, samples: [180, 210, 420] }, draws: 5 },
        expected: { sequence: draw({ mode: "recorded_samples", constantMs: 250, samples: [180, 210, 420] }, 5) },
      },
      {
        name: "seed rotates the start deterministically",
        input: { config: { mode: "recorded_samples", constantMs: 250, samples: [10, 20, 30, 40], seed: 2 }, draws: 4 },
        expected: { sequence: draw({ mode: "recorded_samples", constantMs: 250, samples: [10, 20, 30, 40], seed: 2 }, 4) },
      },
    ];
  })(),
);

/* 3 ─ bounded-LIMIT depth walk, with and without reservation --------------- */

fixture(
  "bounded-limit-walk.json",
  "walkDepth",
  "A BUY LIMIT never fills past its limit; the reserved lookup shrinks available depth.",
  (() => {
    const asks = [
      { price: 100.0, qty: 25, orders: 2 },
      { price: 100.05, qty: 20, orders: 2 },
      { price: 100.1, qty: 10, orders: 1 },
      { price: 100.2, qty: 999, orders: 9 }, // past the limit — must never fill
    ];
    const base = {
      side: "BUY",
      levels: asks,
      limitPrice: 100.1,
      queueModel: "none",
      haircutPct: 0,
      at: 1000,
      quoteVersion: 3,
    };
    const walkPlain = walkDepth({ ...base, remainingQty: 75 });
    const walkReserved = walkDepth({
      ...base,
      remainingQty: 75,
      // 100.00 already fully reserved by a prior attempt → its 25 is gone.
      reserved: (price) => (Math.round(price * 100) === 10000 ? 25 : 0),
    });
    return [
      {
        name: "fills only within the limit, partial when depth is short",
        input: { ...base, remainingQty: 75 },
        expected: {
          filled_qty: walkPlain.filled_qty,
          average_price: walkPlain.average_price,
          executable_within_limit: walkPlain.executable_within_limit,
          slice_prices: walkPlain.slices.map((s) => s.price),
        },
      },
      {
        name: "reserved liquidity is subtracted from the walk",
        input: { ...base, remainingQty: 75, reservedAt10000: 25 },
        expected: {
          filled_qty: walkReserved.filled_qty,
          executable_within_limit: walkReserved.executable_within_limit,
          slice_prices: walkReserved.slices.map((s) => s.price),
        },
      },
    ];
  })(),
);

/* 4 ─ paper scheduler: mirrors the live OrderManager queue + pacing --------- */

fixture(
  "paper-scheduler.json",
  "planPaperSchedule",
  "Whole-lifecycle serialisation under cap=1, exactly N concurrent under cap=N, shared transport pacing between POSTs, and priority pre-emption of the queue (never of an in-flight op).",
  (() => {
    const fourEntry = ["k1_ce", "k2_ce", "k2_pe", "k1_pe"].map((role, i) => ({
      id: role,
      purpose: "ENTRY",
      sequence: i,
      readyAt: 0,
      postToAckMs: 80,
      ackToTerminalMs: 120,
    }));
    const pick = (s) => ({ id: s.id, dequeued_at: s.dequeued_at, post_started_at: s.post_started_at, ack_at: s.ack_at, terminal_at: s.terminal_at });

    const singleSlot = planPaperSchedule(fourEntry, createSchedulingPolicy({ maxConcurrentOperations: 1, minBrokerIntervalMs: 0 }));
    const twoSlot = planPaperSchedule(fourEntry, createSchedulingPolicy({ maxConcurrentOperations: 2, minBrokerIntervalMs: 0 }));
    const spaced = planPaperSchedule(fourEntry, createSchedulingPolicy({ maxConcurrentOperations: 2, minBrokerIntervalMs: 250 }));

    const priorityOps = [
      { id: "entryA", purpose: "ENTRY", sequence: 0, readyAt: 0, postToAckMs: 80, ackToTerminalMs: 120 },
      { id: "entryB", purpose: "ENTRY", sequence: 1, readyAt: 0, postToAckMs: 80, ackToTerminalMs: 120 },
      { id: "unwind", purpose: "EMERGENCY_RESIDUAL", sequence: 2, readyAt: 50, postToAckMs: 80, ackToTerminalMs: 120 },
    ];
    const priority = planPaperSchedule(priorityOps, createSchedulingPolicy({ maxConcurrentOperations: 1, minBrokerIntervalMs: 0 }));

    return [
      {
        name: "scheduler-single-slot: cap=1 serialises whole lifecycles",
        input: { operations: fourEntry, policy: { maxConcurrentOperations: 1, minBrokerIntervalMs: 0 } },
        expected: { schedule: singleSlot.map(pick) },
      },
      {
        name: "scheduler-two-slot: exactly two lifecycles overlap",
        input: { operations: fourEntry, policy: { maxConcurrentOperations: 2, minBrokerIntervalMs: 0 } },
        expected: { schedule: twoSlot.map(pick) },
      },
      {
        name: "transport-spacing: POSTs are paced even under cap=2",
        input: { operations: fourEntry, policy: { maxConcurrentOperations: 2, minBrokerIntervalMs: 250 } },
        expected: { schedule: spaced.map(pick), posts: spaced.map((s) => s.post_started_at).sort((a, b) => a - b) },
      },
      {
        name: "priority-unwind-before-entry: emergency jumps a queued ENTRY",
        input: { operations: priorityOps, policy: { maxConcurrentOperations: 1, minBrokerIntervalMs: 0 } },
        expected: { schedule: priority.map(pick) },
      },
    ];
  })(),
);

/* 5 ─ structured broker latency: POST->ACK and ACK->terminal ---------------- */

fixture(
  "structured-latency.json",
  "createStructuredLatencySource",
  "POST->ACK and ACK->terminal are drawn independently from their own recorded samples, in a fixed order; the constant fallback separates the two stages instead of collapsing them.",
  (() => {
    const draw = (config, n) => {
      const s = createStructuredLatencySource(config);
      return Array.from({ length: n }, () => s.next());
    };
    const recorded = { mode: "recorded_samples", constantMs: 250, postToAckSamples: [90, 110, 130], ackToTerminalSamples: [200, 400] };
    const constant = { mode: "constant", constantMs: 250 };
    return [
      {
        name: "recorded components cycle independently",
        input: { config: recorded, draws: 4 },
        expected: { sequence: draw(recorded, 4), calibrated: createStructuredLatencySource(recorded).calibrated },
      },
      {
        name: "constant fallback still separates the two stages",
        input: { config: constant, draws: 2 },
        expected: { sequence: draw(constant, 2), calibrated: createStructuredLatencySource(constant).calibrated },
      },
    ];
  })(),
);

/* 6 ─ calibration status classification ------------------------------------ */

fixture(
  "calibration-status.json",
  "classifyCalibration",
  "UNCALIBRATED / PARTIALLY_CALIBRATED / CALIBRATED / STALE from sample count and the age of the newest sample.",
  (() => {
    const th = { calibratedMinSamples: 200, staleAfterMs: 8 * 60 * 60 * 1000 };
    const rows = [
      { sampleCount: 0, lastSampleAgeMs: null },
      { sampleCount: 17, lastSampleAgeMs: 1000 },
      { sampleCount: 500, lastSampleAgeMs: 1000 },
      { sampleCount: 500, lastSampleAgeMs: th.staleAfterMs + 1 },
    ];
    return rows.map((r) => ({
      name: `count=${r.sampleCount} age=${r.lastSampleAgeMs}`,
      input: { ...r, thresholds: th },
      expected: { status: classifyCalibration(r.sampleCount, r.lastSampleAgeMs, th) },
    }));
  })(),
);


/* 7 ─ order lifecycle: stage vocabulary and the ACK-is-not-fill rule ------- */

fixture(
  "order-lifecycle-stages.json",
  "BoxOrderStage",
  "The observable stage vocabulary, its mapping onto durable state, terminality, and which stages still accept fills. A cancel in flight MUST still accept fills.",
  BOX_ORDER_STAGES.map((stage) => ({
    name: stage,
    input: { stage },
    expected: {
      durable_state: durableStateForStage(stage),
      terminal: isTerminalStage(stage),
      accepts_further_fills: stageAcceptsFurtherFills(stage),
    },
  })),
);

fixture(
  "cumulative-fill-ledger.json",
  "CumulativeFillLedger",
  "Idempotent, monotonic, cumulative-authoritative fill accounting: duplicates contribute nothing, out-of-order events cannot rewind quantity, and an overfill is applied but flagged.",
  (() => {
    const cases = [];

    // The brief's cancel-race arithmetic, end to end.
    const race = new CumulativeFillLedger("BOX:t:ENTRY:k1_ce:attempt-1", 75);
    const raceSteps = [
      { cumulativeQty: 40, eventId: "f1", sequence: 1, source: "order_update" },
      { cumulativeQty: 52, eventId: "f2", sequence: 2, source: "order_update" },
      { cumulativeQty: 52, eventId: "cancel-terminal", sequence: 3, source: "rest_poll" },
    ];
    const raceOutcomes = raceSteps.map((step) => {
      const r = race.apply(step);
      return { outcome: r.outcome, delta: r.delta, cumulative: r.cumulative, remaining: r.remaining };
    });
    cases.push({
      name: "cancel race: 40 filled, cancel requested, 12 more fill, remainder cancelled",
      input: { requestedQty: 75, steps: raceSteps, cumulativeAtCancelRequest: 40 },
      expected: {
        applied: raceOutcomes,
        accounting: terminalQuantityAccounting({
          requestedQty: 75,
          finalCumulativeQty: race.cumulative,
          cumulativeAtCancelRequest: 40,
        }),
      },
    });

    // Duplicate delivery.
    const dup = new CumulativeFillLedger("BOX:t:ENTRY:k2_ce:attempt-1", 75);
    const dupEvent = { cumulativeQty: 40, eventId: "dhan:TRADE-991", source: "order_update" };
    const dupOutcomes = [dup.apply(dupEvent), dup.apply(dupEvent), dup.apply(dupEvent)].map((r) => ({
      outcome: r.outcome,
      delta: r.delta,
      cumulative: r.cumulative,
    }));
    cases.push({
      name: "a duplicate broker event contributes no quantity",
      // The client order id is part of the INPUT, not the expectation: it is identity, not
      // behaviour, and pinning the generator's own id would make the fixture unreplayable.
      input: {
        clientOrderId: "BOX:t:ENTRY:k2_ce:attempt-1",
        requestedQty: 75,
        event: dupEvent,
        deliveries: 3,
      },
      expected: { applied: dupOutcomes, snapshot: dup.snapshot() },
    });

    // Out-of-order delivery.
    const ooo = new CumulativeFillLedger("BOX:t:ENTRY:k2_pe:attempt-1", 75);
    const oooSteps = [
      { cumulativeQty: 52, eventId: "e9", sequence: 9, source: "order_update" },
      { cumulativeQty: 40, eventId: "e7", sequence: 7, source: "order_update" },
    ];
    const oooOutcomes = oooSteps.map((step) => {
      const r = ooo.apply(step);
      return { outcome: r.outcome, delta: r.delta, cumulative: r.cumulative, sequenceRegression: r.sequenceRegression };
    });
    cases.push({
      name: "an out-of-order event cannot reduce cumulative quantity",
      input: { requestedQty: 75, steps: oooSteps },
      expected: { applied: oooOutcomes },
    });

    // Overfill.
    const over = new CumulativeFillLedger("BOX:t:ENTRY:k1_pe:attempt-1", 75);
    const overResult = over.apply({ cumulativeQty: 80, source: "rest_poll" });
    cases.push({
      name: "an overfill is applied as broker truth and flagged, never clamped",
      input: { requestedQty: 75, cumulativeQty: 80 },
      expected: {
        outcome: overResult.outcome,
        cumulative: overResult.cumulative,
        overfill: overResult.overfill,
        remaining: overResult.remaining,
      },
    });

    // Quantity derivation.
    cases.push({
      name: "outstanding quantity and stage from cumulative quantity",
      input: [
        { requestedQty: 75, cumulativeQty: 52 },
        { requestedQty: 75, cumulativeQty: 75 },
        { requestedQty: 75, cumulativeQty: 80 },
        { requestedQty: 75, cumulativeQty: 0 },
      ],
      expected: [
        { outstanding: outstandingQuantity(75, 52), stage: stageFromCumulativeQuantity({ requestedQty: 75, cumulativeQty: 52 }) },
        { outstanding: outstandingQuantity(75, 75), stage: stageFromCumulativeQuantity({ requestedQty: 75, cumulativeQty: 75 }) },
        { outstanding: outstandingQuantity(75, 80), stage: stageFromCumulativeQuantity({ requestedQty: 75, cumulativeQty: 80 }) },
        {
          outstanding: outstandingQuantity(75, 0),
          stage: stageFromCumulativeQuantity({ requestedQty: 75, cumulativeQty: 0, cancelConfirmed: true }),
        },
      ],
    });

    return cases;
  })(),
);

/* 8 ─ calibration resolution: fallback ladder, freshness, confidence ------- */

fixture(
  "calibration-resolution.json",
  "ExecutionCalibrationStore.resolve",
  "The fallback ladder (exact bucket -> pooled buckets -> pooled kinds -> unavailable), session freshness, and the honesty contract that an unmeasured resolution reports measured:false with null percentiles.",
  (() => {
    const DAY = 24 * 60 * 60 * 1000;
    const T0 = Date.UTC(2026, 2, 2, 6, 30, 0); // 2026-03-02 12:00 IST
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

    const cases = [];

    const exact = new ExecutionCalibrationStore(opts(T0));
    seed(exact, 25, 120, { bucket: "NORMAL" }, T0);
    cases.push({
      name: "an adequately-sampled bucket is used directly",
      input: { bucketSamples: 25, bucketMinSamples: 20 },
      expected: strip(exact.resolve(dims(), "post_to_ack_ms")),
    });

    const pooled = new ExecutionCalibrationStore(opts(T0));
    seed(pooled, 5, 100, { bucket: "OPEN" }, T0);
    seed(pooled, 30, 400, { bucket: "NORMAL" }, T0);
    cases.push({
      name: "a thin bucket pools across buckets rather than overfitting",
      input: { openSamples: 5, normalSamples: 30 },
      expected: strip(pooled.resolve(dims({ bucket: "OPEN" }), "post_to_ack_ms")),
    });

    const kinds = new ExecutionCalibrationStore(opts(T0));
    seed(kinds, 4, 100, { kind: "CANCEL", bucket: "OPEN" }, T0);
    seed(kinds, 30, 120, { kind: "ENTRY", bucket: "NORMAL" }, T0);
    cases.push({
      name: "a thin kind pools across kinds, still within one broker and profile",
      input: { cancelSamples: 4, entrySamples: 30 },
      expected: strip(kinds.resolve(dims({ kind: "CANCEL", bucket: "OPEN" }), "post_to_ack_ms")),
    });

    const otherBroker = new ExecutionCalibrationStore(opts(T0));
    seed(otherBroker, 500, 100, { broker: "zerodha" }, T0);
    cases.push({
      name: "pooling NEVER crosses a broker",
      input: { zerodhaSamples: 500, dhanSamples: 0 },
      expected: strip(otherBroker.resolve(dims({ broker: "dhan" }), "post_to_ack_ms")),
    });

    const otherProfile = new ExecutionCalibrationStore(opts(T0));
    seed(otherProfile, 500, 100, { profile: "MARKETABLE_LIMIT" }, T0);
    cases.push({
      name: "pooling NEVER crosses the marketable/passive boundary",
      input: { marketableSamples: 500, passiveSamples: 0 },
      expected: strip(otherProfile.resolve(dims({ profile: "PASSIVE_LIMIT" }), "post_to_ack_ms")),
    });

    const stale = new ExecutionCalibrationStore(opts(T0 + 1.5 * DAY));
    seed(stale, 60, 100, { bucket: "NORMAL" }, T0);
    cases.push({
      name: "a calibrated set past the staleness window is STALE and LOW confidence",
      input: { samples: 60, ageMs: 1.5 * DAY },
      expected: strip(stale.resolve(dims(), "post_to_ack_ms")),
    });

    const expired = new ExecutionCalibrationStore(opts(T0 + 3 * DAY));
    seed(expired, 60, 100, { bucket: "NORMAL" }, T0);
    cases.push({
      name: "a set beyond the retention window cannot calibrate today",
      input: { samples: 60, ageMs: 3 * DAY },
      expected: strip(expired.resolve(dims(), "post_to_ack_ms")),
    });

    return cases;
  })(),
);

fixture(
  "calibration-confidence.json",
  "classifyConfidence",
  "Confidence is LOW for anything unmeasured or stale, capped at MEDIUM for a fallback, and HIGH only for a large fresh non-fallback set.",
  [
    { status: "CALIBRATED", sampleCount: 100000, measured: false },
    { status: "STALE", sampleCount: 100000, measured: true },
    { status: "UNCALIBRATED", sampleCount: 0, measured: true },
    { status: "PARTIALLY_CALIBRATED", sampleCount: 5, measured: true },
    { status: "CALIBRATED", sampleCount: 500, measured: true, fellBack: true },
    { status: "CALIBRATED", sampleCount: 500, measured: true, fellBack: false },
  ].map((input) => ({
    name: `${input.status} n=${input.sampleCount} measured=${input.measured} fellBack=${input.fellBack ?? false}`,
    input,
    expected: { confidence: classifyConfidence(input) },
  })),
);

fixture(
  "time-of-day-buckets.json",
  "classifyTimeOfDayBucket",
  "Coarse OPEN / NORMAL / CLOSE bucketing of the NSE session, and the IST session key used for freshness. Outside the session is NORMAL, never a fourth bucket.",
  [555, 560, 569, 570, 720, 915, 916, 930, 360, 1320].map((minutes) => ({
    name: `minute ${minutes}`,
    input: { istMinutesOfDay: minutes },
    expected: { bucket: classifyTimeOfDayBucket(minutes) },
  })).concat([
    {
      name: "IST session key straddles the UTC day boundary correctly",
      input: { atWall: Date.UTC(2026, 2, 2, 19, 0, 0) },
      expected: { session: istSessionKey(Date.UTC(2026, 2, 2, 19, 0, 0)) },
    },
  ]),
);

/* 9 ─ implementation shortfall and queue calibration ---------------------- */

fixture(
  "implementation-shortfall.json",
  "computeExecutionShortfall",
  "The subtraction chain from detected edge to realised net, attributed per leg, with the unexplained residual surfaced. Positive always means COST, whichever side the leg was.",
  (() => {
    const complete = {
      theoreticalDetectedEdge: 1875,
      executedGrossEdge: 1700,
      brokerage: 80,
      taxesAndFees: 70,
      unwindCost: 0,
      realisedNetResult: 1425,
      outcome: "filled_4_of_4",
      legs: [
        { role: "k1_ce", side: "BUY", detectedPrice: 100, submitPrice: 100.05, filledPrice: 100.1, requestedQty: 75, filledQty: 75 },
        { role: "k2_ce", side: "SELL", detectedPrice: 50, submitPrice: 49.95, filledPrice: 49.9, requestedQty: 75, filledQty: 75 },
      ],
    };
    const incomplete = {
      theoreticalDetectedEdge: 1000,
      executedGrossEdge: 0,
      brokerage: 0,
      taxesAndFees: 0,
      unwindCost: 250,
      realisedNetResult: -250,
      outcome: "partial_unwound",
      legs: [
        { role: "k1_ce", side: "BUY", detectedPrice: 100, submitPrice: 101, filledPrice: null, requestedQty: 75, filledQty: 0 },
      ],
    };
    return [
      { name: "a complete 4/4 box", input: complete, expected: computeExecutionShortfall(complete) },
      { name: "an incomplete box that had to be unwound", input: incomplete, expected: computeExecutionShortfall(incomplete) },
    ];
  })(),
);

fixture(
  "queue-calibration.json",
  "QueueCalibrationEstimator",
  "Realisation ratio measured against VISIBLE executable depth, and the conservative haircut recommended from its p25. NOT a reconstruction of NSE queue position, and never applied automatically.",
  (() => {
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

    const thin = new QueueCalibrationEstimator({ currentHaircutPct: 30, minSamples: 30 });
    for (let i = 0; i < 10; i++) thin.record(observation());

    const mixed = new QueueCalibrationEstimator({ currentHaircutPct: 30, minSamples: 10, highConfidenceSamples: 100 });
    for (let i = 0; i < 40; i++) mixed.record(observation({ filledQty: 75 }));
    for (let i = 0; i < 10; i++) mixed.record(observation({ filledQty: 37, partial: true }));

    return [
      {
        name: "below the sample floor no recommendation is made",
        input: { observations: 10, minSamples: 30 },
        expected: strip(thin.recommend("zerodha", "MARKETABLE_LIMIT", "NORMAL")),
      },
      {
        name: "40 full realisations and 10 half realisations",
        input: { fullOrders: 40, halfOrders: 10, visible: 150, requested: 75 },
        expected: strip(mixed.recommend("zerodha", "MARKETABLE_LIMIT", "NORMAL")),
      },
      {
        name: "liquidity classification from visible depth vs requested",
        input: [
          { visible: 50, requested: 75 },
          { visible: 150, requested: 75 },
          { visible: 400, requested: 75 },
        ],
        expected: [classifyLiquidity(50, 75), classifyLiquidity(150, 75), classifyLiquidity(400, 75)],
      },
    ];
  })(),
);

mkdirSync(OUT_DIR, { recursive: true });
let total = 0;
for (const { file, body } of files) {
  writeFileSync(join(OUT_DIR, file), `${JSON.stringify(body, null, 2)}\n`, "utf8");
  total += body.cases.length;
  console.log(`wrote box/${file}  (${body.cases.length} cases)`);
}
console.log(`\n${files.length} files, ${total} cases.`);
