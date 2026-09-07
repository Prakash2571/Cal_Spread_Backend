import test from "node:test";
import assert from "node:assert/strict";

import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { BoxEngine } from "../../dist/box/engine.js";
import { checkedFeedBlockReason } from "../../dist/box/executionGateway.js";
import { toTick } from "../../dist/brokers/dhan/feed.js";
import { parseBinary } from "../../dist/ticker.js";
import { touchPrice, walkDepth } from "../../dist/box/orderPricing.js";

function tick(overrides = {}) {
  return {
    token: 101,
    last_price: 100,
    close_price: 99,
    oi: 0,
    bid: 99.9,
    ask: 100.1,
    ...overrides,
  };
}

function level(price, qty, orders = 1) {
  return { price, qty, orders };
}

function kitePacket(length) {
  const buffer = new ArrayBuffer(4 + length);
  const view = new DataView(buffer);
  view.setInt16(0, 1, false);
  view.setInt16(2, length, false);
  view.setUint32(4, 256, false);
  view.setUint32(8, 10_000, false);
  if (length >= 44) view.setUint32(44, 9_900, false);
  return buffer;
}

test("first LTP-only option tick does not create or notify an executable book", () => {
  const store = new BoxQuoteStore();
  let notifications = 0;
  store.subscribe(() => notifications++);
  assert.deepEqual(store.applyTicks([tick({ depth_updated: false })], 1_000), []);
  assert.equal(store.get(101), undefined);
  assert.equal(store.updateCount, 0);
  assert.equal(notifications, 0);
  assert.equal(store.diagnostics().depthless_ignored, 1);
});

test("LTP-only packet after a book cannot refresh its time, version, or listeners", () => {
  const store = new BoxQuoteStore();
  store.applyTicks([tick({ depth_updated: true, bids: [level(99.9, 25)], asks: [level(100.1, 30)] })], 1_000);
  const before = store.get(101);
  let notifications = 0;
  store.subscribe(() => notifications++);
  assert.deepEqual(store.applyTicks([tick({ last_price: 101, depth_updated: false })], 2_000), []);
  assert.strictEqual(store.get(101), before);
  assert.equal(store.get(101).at, 1_000);
  assert.equal(notifications, 0);
});

test("Dhan retained ladders on a partial packet do not refresh executable storage", () => {
  const state = {
    token: 101,
    last_price: 100,
    close_price: 99,
    oi: 50,
    bids: [level(99.9, 25)],
    asks: [level(100.1, 30)],
  };
  const store = new BoxQuoteStore();
  const full = toTick(state, true);
  const partial = toTick({ ...state, last_price: 101 }, false);
  assert.equal(full.depth_updated, true);
  assert.equal(partial.depth_updated, false);
  store.applyTicks([full], 1_000);
  const version = store.get(101).version;
  store.applyTicks([partial], 2_000);
  assert.equal(store.get(101).version, version);
  assert.equal(store.get(101).at, 1_000);
});

test("authoritative empty depth invalidates the old book and notifies dependents", () => {
  const store = new BoxQuoteStore();
  store.applyTicks([tick({ depth_updated: true, bids: [level(99.9, 25)], asks: [] })], 1_000);
  const seen = [];
  store.subscribe((tokens, at) => seen.push({ tokens, at }));
  assert.deepEqual(store.applyTicks([tick({ depth_updated: true, bids: [], asks: [] })], 2_000), [101]);
  assert.equal(store.get(101), undefined);
  assert.deepEqual(seen, [{ tokens: [101], at: 2_000 }]);
  assert.equal(store.diagnostics().empty_invalidations, 1);
});

test("legacy explicit ladders remain authoritative and malformed levels are dropped", () => {
  const store = new BoxQuoteStore();
  store.applyTicks([tick({
    bids: [level(Infinity, 10), level(99.8, NaN), level(99.7, 1.5), level(99.9, 20)],
    asks: [level(NaN, 10), level(100.1, 30), level(100.2, 0), level(100.3, -1)],
  })], 1_000);
  const quote = store.get(101);
  assert.deepEqual(quote.bids, [level(99.9, 20)]);
  assert.deepEqual(quote.asks, [level(100.1, 30)]);
  assert.equal(store.diagnostics().malformed_levels_dropped, 6);
});

test("one-sided books support only the relevant reducing side", () => {
  const store = new BoxQuoteStore();
  store.applyTicks([tick({ depth_updated: true, bids: [level(99.9, 75)], asks: [] })], 1_000);
  const quote = store.get(101);
  assert.equal(touchPrice("SELL", quote.bids, quote.asks), 99.9);
  assert.equal(touchPrice("BUY", quote.bids, quote.asks), null);
  const sell = walkDepth({ side: "SELL", levels: quote.bids, remainingQty: 75, limitPrice: 99.8, queueModel: "none", haircutPct: 0, at: 1_000, quoteVersion: quote.version });
  const buy = walkDepth({ side: "BUY", levels: quote.asks, remainingQty: 75, limitPrice: 100.2, queueModel: "none", haircutPct: 0, at: 1_000, quoteVersion: quote.version });
  assert.equal(sell.filled_qty, 75);
  assert.equal(buy.filled_qty, 0);
});

test("generation invalidation clears readiness and an LTP packet cannot warm it", () => {
  const store = new BoxQuoteStore();
  store.applyTicks([tick({ depth_updated: true, bids: [level(99.9, 75)], asks: [level(100.1, 75)] })], 1_000);
  store.invalidateGeneration();
  store.applyTicks([tick({ depth_updated: false })], 2_000);
  assert.equal(store.size, 0);
  assert.equal(store.lastUpdateAt, null);
  assert.deepEqual(store.diagnostics(), {
    authoritative_observations: 1,
    usable_book_updates: 1,
    depthless_ignored: 1,
    empty_invalidations: 0,
    malformed_levels_dropped: 0,
    generation_invalidations: 1,
    ready_books: 0,
  });
});

test("Zerodha provenance is true only for full packets", () => {
  const ltp = parseBinary(kitePacket(8))[0];
  const quote = parseBinary(kitePacket(44))[0];
  const full = parseBinary(kitePacket(184))[0];
  assert.equal(ltp.depth_updated, false);
  assert.equal(quote.depth_updated, false);
  assert.equal(full.depth_updated, true);
  assert.deepEqual(full.bids, []);
  assert.deepEqual(full.asks, []);
});

test("walkDepth and touchPrice fail closed on non-finite or fractional malformed levels", () => {
  const levels = [level(Infinity, 100), level(100, Infinity), level(99, 1.5), level(98, 25)];
  const walked = walkDepth({ side: "SELL", levels, remainingQty: 25, limitPrice: 97, queueModel: "none", haircutPct: 0, at: 1, quoteVersion: 1 });
  assert.equal(walked.filled_qty, 25);
  assert.equal(walked.average_price, 98);
  assert.equal(touchPrice("SELL", levels, []), 98);
  assert.equal(walkDepth({ side: "SELL", levels, remainingQty: 25, limitPrice: Infinity, queueModel: "none", haircutPct: 0, at: 1, quoteVersion: 1 }).filled_qty, 0);
});

test("queued feed stamp accepts only a still-executable same-generation book", () => {
  const store = new BoxQuoteStore();
  store.applyTicks([tick({
    depth_updated: true,
    bids: [level(99.9, 100)],
    asks: [level(100.1, 100)],
  })], 1_000);
  const admitted = store.get(101);
  const request = {
    client_order_id: "BOX:t:ENTRY:k1_ce:a1",
    role: "k1_ce",
    trade_id: "t",
    attempt_id: "a1",
    purpose: "ENTRY",
    phase: "entry",
    exchange: "NFO",
    tradingsymbol: "OPT",
    token: 101,
    side: "BUY",
    quantity: 75,
    pricing: {
      order_type: "LIMIT",
      reference_price: 100.1,
      tick_size: 0.05,
      max_chase_ticks: 0,
      limit_price: 100.1,
    },
  };
  const stamp = {
    token: 101,
    feed_generation: 4,
    quote_version: admitted.version,
    quote_at: admitted.at,
    checked_at: 1_000,
  };
  const reason = (overrides = {}) => checkedFeedBlockReason({
    request,
    stamp,
    currentGeneration: 4,
    tokenCurrent: true,
    quote: store.get(101),
    now: 1_100,
    quoteMaxAgeMs: 500,
    queueModel: "none",
    queueLiquidityHaircutPct: 0,
    ...overrides,
  });

  store.applyTicks([tick({ depth_updated: true, bids: [level(99.9, 75)], asks: [level(100.1, 75)] })], 1_050);
  assert.equal(reason(), null, "a newer same-generation book may proceed when the immutable LIMIT still covers it");

  store.applyTicks([tick({ depth_updated: true, bids: [level(99.9, 75)], asks: [level(100.1, 74)] })], 1_060);
  assert.match(reason(), /no longer covers/);
  store.applyTicks([tick({ depth_updated: true, bids: [level(99.9, 75)], asks: [level(100.2, 100)] })], 1_070);
  assert.match(reason(), /no longer covers/);
  assert.match(reason({ currentGeneration: 5 }), /generation changed/);
  assert.match(reason({ now: 2_000 }), /stale/);

  store.applyTicks([tick({ depth_updated: true, bids: [], asks: [] })], 1_080);
  assert.match(reason({ quote: store.get(101), tokenCurrent: false }), /current feed generation/);
});

function engineHarness() {
  const feed = {
    addTickListener: () => () => {},
    addConnectionListener: () => () => {},
    retain: () => () => {},
    subscribeTokens() {},
    unsubscribeTokens() {},
    subscribedCount: () => 0,
    isConnected: () => true,
  };
  const engine = new BoxEngine({
    marketData: { isAuthenticated: () => true, getQuoteFull: async () => [] },
    activeBroker: () => "zerodha",
    feed,
    charges: { legs: () => ({ total: 0 }) },
    getAllInstruments: async () => [],
    getBoard: async () => [],
    priceChargeGroups: async () => new Map(),
    istDayKey: () => "2026-09-07",
    makeIdResolver: () => () => null,
    isMarketOpen: () => true,
    margins: {
      broker: "zerodha",
      basketMargin: async () => ({ initial: 0, final: 0, total: 0, source: "unavailable" }),
    },
  });
  // The market watcher normally owns this cached state. Set it directly so this
  // focused harness can exercise public intake/lifecycle methods without timers.
  engine.marketOpen = true;
  return engine;
}

test("engine reconnect clears paper/scanner books; raw LTP restores health but not readiness", () => {
  const engine = engineHarness();
  engine.ingestBoxLaneTicks([tick({
    depth_updated: true,
    bids: [level(99.9, 75)],
    asks: [level(100.1, 75)],
  })]);
  assert.equal(engine.getStatus().executable_books, 1);
  assert.equal(engine.tokenFeedGeneration.size, 1);

  engine.onBoxLaneConnection(false);
  assert.equal(engine.getStatus().executable_books, 0);
  assert.equal(engine.quotes.get(101), undefined, "scanner and paper simulator share the cleared executable store");
  assert.equal(engine.tokenFeedGeneration.size, 0);

  engine.ingestBoxLaneTicks([tick({ last_price: 101, depth_updated: false })]);
  const status = engine.getStatus();
  assert.equal(status.feed_healthy, true, "raw current-socket tick restores global liveness");
  assert.ok(status.raw_tick_age_ms >= 0);
  assert.equal(status.executable_books, 0);
  assert.equal(status.executable_book_diagnostics.ready_books, 0);
  assert.equal(status.executable_book_diagnostics.depthless_ignored, 1);
  assert.equal(status.executable_book_diagnostics.generation_invalidations, 1);
  assert.equal(engine.tokenFeedGeneration.size, 0, "LTP-only packet cannot warm token readiness");
});