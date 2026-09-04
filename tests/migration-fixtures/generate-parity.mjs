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

mkdirSync(OUT_DIR, { recursive: true });
let total = 0;
for (const { file, body } of files) {
  writeFileSync(join(OUT_DIR, file), `${JSON.stringify(body, null, 2)}\n`, "utf8");
  total += body.cases.length;
  console.log(`wrote box/${file}  (${body.cases.length} cases)`);
}
console.log(`\n${files.length} files, ${total} cases.`);
