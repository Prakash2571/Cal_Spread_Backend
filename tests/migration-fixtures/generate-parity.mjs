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

mkdirSync(OUT_DIR, { recursive: true });
let total = 0;
for (const { file, body } of files) {
  writeFileSync(join(OUT_DIR, file), `${JSON.stringify(body, null, 2)}\n`, "utf8");
  total += body.cases.length;
  console.log(`wrote box/${file}  (${body.cases.length} cases)`);
}
console.log(`\n${files.length} files, ${total} cases.`);
