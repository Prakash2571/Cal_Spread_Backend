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
