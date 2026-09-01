/**
 * EXECUTABLE ORDER PRICING — the pure marketable-limit, depth-walking and queue
 * haircut core (orderPricing.ts). No clock, no store: given a book and a config
 * it must return the same fills every time.
 *
 * Covers the price-envelope scenarios from the spec: BUY fills at the ask, one/two
 * ticks worse within the limit, refuses above the limit; the SELL mirror; walking
 * multiple depth levels; the queue haircut reducing executable quantity, and the
 * "none" model using raw displayed liquidity.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOrderPricing,
  computeLimitPrice,
  effectiveQty,
  roundToTick,
  touchPrice,
  walkDepth,
} from "../../dist/box/orderPricing.js";

const lvl = (price, qty, orders = 1) => ({ price, qty, orders });

/* ------------------------------ limit pricing ------------------------------ */

test("BUY limit is the reference ASK plus the chase band, tick-snapped", () => {
  // ₹100.00 ask, ₹0.05 tick, 2 ticks of chase → ₹100.10.
  const p = computeLimitPrice({ side: "BUY", referencePrice: 100, tickSize: 0.05, maxChaseTicks: 2 });
  assert.equal(p, 100.1);
});

test("SELL limit is the reference BID minus the chase band", () => {
  // ₹100.00 bid, 2 ticks → willing to sell down to ₹99.90.
  const p = computeLimitPrice({ side: "SELL", referencePrice: 100, tickSize: 0.05, maxChaseTicks: 2 });
  assert.equal(p, 99.9);
});

test("zero chase means the limit is exactly the touch", () => {
  assert.equal(computeLimitPrice({ side: "BUY", referencePrice: 100, tickSize: 0.05, maxChaseTicks: 0 }), 100);
  assert.equal(computeLimitPrice({ side: "SELL", referencePrice: 100, tickSize: 0.05, maxChaseTicks: 0 }), 100);
});

test("roundToTick snaps to the tick grid", () => {
  assert.equal(roundToTick(100.123, 0.05), 100.1);
  assert.equal(roundToTick(100.14, 0.05), 100.15);
});

test("buildOrderPricing packages side/qty/reference/tick/limit", () => {
  const pr = buildOrderPricing({ side: "BUY", quantity: 75, referencePrice: 100, tickSize: 0.05, maxChaseTicks: 2 });
  assert.equal(pr.order_type, "MARKETABLE_LIMIT");
  assert.equal(pr.reference_price, 100);
  assert.equal(pr.limit_price, 100.1);
  assert.equal(pr.max_chase_ticks, 2);
  assert.equal(pr.quantity, 75);
});

/* --------------------------- the queue haircut ----------------------------- */

test("queue 'none' uses the whole displayed quantity", () => {
  assert.equal(effectiveQty(100, "none", 30), 100);
});

test("queue 'haircut' floors displayed × (1 − pct)", () => {
  assert.equal(effectiveQty(100, "haircut", 30), 70);
  assert.equal(effectiveQty(1, "haircut", 30), 0, "one lot at 30% floors to nothing executable for us");
  assert.equal(effectiveQty(5, "haircut", 30), 3);
});

/* ------------------------------ depth walking ------------------------------ */

test("a BUY fills at the ask when the whole lot rests there", () => {
  const r = walkDepth({
    side: "BUY",
    levels: [lvl(100, 500)],
    remainingQty: 75,
    limitPrice: 100.1,
    queueModel: "none",
    haircutPct: 0,
    at: 1000,
    quoteVersion: 1,
  });
  assert.equal(r.filled_qty, 75);
  assert.equal(r.average_price, 100);
  assert.equal(r.slices.length, 1);
});

test("a BUY WALKS multiple levels within the limit and averages them", () => {
  // 50 @ 100.00, 100 @ 100.05, want 75, limit 100.10 → 50@100 + 25@100.05.
  const r = walkDepth({
    side: "BUY",
    levels: [lvl(100, 50), lvl(100.05, 100)],
    remainingQty: 75,
    limitPrice: 100.1,
    queueModel: "none",
    haircutPct: 0,
    at: 1000,
    quoteVersion: 1,
  });
  assert.equal(r.filled_qty, 75);
  // (50×100 + 25×100.05) / 75 = 100.0167 (2dp)
  assert.equal(r.average_price, 100.02);
  assert.equal(r.slices.length, 2);
  assert.deepEqual(r.slices.map((s) => s.qty), [50, 25]);
});

test("a BUY stops at the LIMIT: levels past it are never taken", () => {
  // 50 @ 100.00, 10 @ 100.05, 1000 @ 100.15; limit 100.10 → only 60 executable.
  const r = walkDepth({
    side: "BUY",
    levels: [lvl(100, 50), lvl(100.05, 10), lvl(100.15, 1000)],
    remainingQty: 75,
    limitPrice: 100.1,
    queueModel: "none",
    haircutPct: 0,
    at: 1000,
    quoteVersion: 1,
  });
  assert.equal(r.filled_qty, 60, "the 100.15 level is past the limit and excluded");
  assert.equal(r.executable_within_limit, 60);
});

test("the SELL mirror: walks bids DOWN to the limit", () => {
  // Sell 75, limit 99.90: 40 @ 100.00 + 100 @ 99.95 → 40 + 35.
  const r = walkDepth({
    side: "SELL",
    levels: [lvl(100, 40), lvl(99.95, 100), lvl(99.85, 1000)],
    remainingQty: 75,
    limitPrice: 99.9,
    queueModel: "none",
    haircutPct: 0,
    at: 1000,
    quoteVersion: 1,
  });
  assert.equal(r.filled_qty, 75);
  assert.deepEqual(r.slices.map((s) => s.price), [100, 99.95]);
  assert.equal(r.slices[1].price >= 99.9, true, "never below the sell limit");
});

test("a SELL refuses a bid below the limit", () => {
  const r = walkDepth({
    side: "SELL",
    levels: [lvl(99.85, 1000)],
    remainingQty: 75,
    limitPrice: 99.9,
    queueModel: "none",
    haircutPct: 0,
    at: 1000,
    quoteVersion: 1,
  });
  assert.equal(r.filled_qty, 0);
  assert.equal(r.average_price, null);
});

test("the haircut reduces executable quantity and can force a shortfall", () => {
  // 100 displayed, 30% haircut → 70 executable, so a 75-lot order only gets 70.
  const r = walkDepth({
    side: "BUY",
    levels: [lvl(100, 100)],
    remainingQty: 75,
    limitPrice: 100.1,
    queueModel: "haircut",
    haircutPct: 30,
    at: 1000,
    quoteVersion: 1,
  });
  assert.equal(r.filled_qty, 70);
  assert.equal(r.slices[0].displayed_qty, 100);
  assert.equal(r.slices[0].effective_qty, 70);
});

test("the same book with 'none' fills what 'haircut' could not", () => {
  const args = { side: "BUY", levels: [lvl(100, 100)], remainingQty: 75, limitPrice: 100.1, at: 1, quoteVersion: 1 };
  assert.equal(walkDepth({ ...args, queueModel: "haircut", haircutPct: 30 }).filled_qty, 70);
  assert.equal(walkDepth({ ...args, queueModel: "none", haircutPct: 30 }).filled_qty, 75);
});

test("touchPrice returns lowest ask for BUY, highest bid for SELL", () => {
  const bids = [lvl(99, 10), lvl(99.5, 10)];
  const asks = [lvl(100.5, 10), lvl(100, 10)];
  assert.equal(touchPrice("BUY", bids, asks), 100);
  assert.equal(touchPrice("SELL", bids, asks), 99.5);
});
