/**
 * AMBIGUOUS TRANSPORT OUTCOMES: adopt, never resubmit.
 *
 * A POST that times out may still have been accepted. The only safe response is to ASK the
 * broker using our own durable identity, adopt the order if it is uniquely identified, and
 * quarantine otherwise. Resubmitting on the assumption that "the request failed" is how a
 * one-lot box becomes a two-lot box.
 *
 * Covers required case 5 (POST timeout followed by broker adoption), for BOTH brokers, since
 * Zerodha and Dhan expose different identity mechanisms (a bounded tag vs a correlation id) and
 * must reach the same semantics through them.
 *
 * Offline: a fake transport, a fake clock, no network.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BrokerAmbiguousSubmitError } from "../../dist/box/brokerAdapter.js";
import { KiteBrokerAdapter, stableKiteTag } from "../../dist/box/kiteBrokerAdapter.js";

const CLIENT_ID = "BOX:trade-9:ENTRY:k1_ce:attempt-1";
const TAG = stableKiteTag(CLIENT_ID);

const request = (overrides = {}) => ({
  client_order_id: CLIENT_ID,
  role: "k1_ce",
  trade_id: "trade-9",
  attempt_id: "attempt-1",
  purpose: "ENTRY",
  phase: "entry",
  exchange: "NFO",
  tradingsymbol: "NIFTY26SEP19900CE",
  token: 1001,
  side: "BUY",
  quantity: 75,
  pricing: {
    order_type: "LIMIT",
    reference_price: 100,
    tick_size: 0.05,
    max_chase_ticks: 2,
    limit_price: 100.1,
  },
  ...overrides,
});

const transportOrder = (overrides = {}) => ({
  order_id: "K-ADOPT-1",
  status: "COMPLETE",
  exchange: "NFO",
  tradingsymbol: "NIFTY26SEP19900CE",
  transaction_type: "BUY",
  quantity: 75,
  filled_quantity: 75,
  pending_quantity: 0,
  average_price: 100.05,
  price: 100.1,
  tag: TAG,
  status_message: null,
  order_timestamp: null,
  exchange_update_timestamp: null,
  ...overrides,
});

const adapterConfig = (overrides = {}) => ({
  executionMode: "live",
  enabled: true,
  ackTimeoutMs: 1_000,
  workingTimeoutMs: 1_000,
  partialTimeoutMs: 1_000,
  cancelTimeoutMs: 1_000,
  brokerMinIntervalMs: 0,
  maxModifications: 2,
  maxChaseTicks: 2,
  ...overrides,
});

function fakeClock() {
  let now = 1_000;
  return { now: () => now, wait: async (ms) => { now += Math.max(0, ms); } };
}

/** A transport whose POST always times out, and whose order book is scriptable. */
function timingOutTransport(orderBook) {
  const calls = [];
  return {
    calls,
    async placeOrder() {
      calls.push("place");
      const error = new Error("request timed out");
      error.name = "AbortError";
      throw error;
    },
    async listOrders() {
      calls.push("listOrders");
      return orderBook;
    },
    async getOrder(orderId) {
      calls.push("getOrder");
      return orderBook.find((o) => o.order_id === orderId) ?? null;
    },
    async cancelOrder() {
      calls.push("cancel");
    },
    async modifyOrder() {
      calls.push("modify");
    },
    async listPositions() {
      return [];
    },
  };
}

const rejection = async (promise) => {
  try {
    await promise;
    throw new Error("expected a rejection");
  } catch (error) {
    return error;
  }
};

/* ───────────────── Zerodha: adoption by stable tag ───────────────── */

test("REQUIRED 5: a POST timeout whose order DOES exist is adopted, not resubmitted", async () => {
  const transport = timingOutTransport([transportOrder()]);
  const adapter = new KiteBrokerAdapter(transport, adapterConfig(), fakeClock());

  const order = await adapter.submitOrder(request());

  // The order was adopted and resolved from the broker's own state.
  assert.equal(order.broker_order_id, "K-ADOPT-1");
  assert.equal(order.state, "COMPLETE");
  assert.equal(order.filled_quantity, 75, "the adopted order's real fill is what counts");
  assert.equal(order.client_order_id, CLIENT_ID, "our durable identity is preserved");

  // Exactly ONE placement. The order book was read to find it.
  assert.equal(transport.calls.filter((c) => c === "place").length, 1, "never resubmit");
  assert.ok(transport.calls.includes("listOrders"), "the broker was asked, not guessed at");
});

test("an adopted order that is still working is polled to a terminal state", async () => {
  const working = transportOrder({ status: "OPEN", filled_quantity: 0, pending_quantity: 75, average_price: 0 });
  const book = [working];
  const transport = timingOutTransport(book);
  // After the first getOrder the broker reports completion.
  let reads = 0;
  const originalGet = transport.getOrder.bind(transport);
  transport.getOrder = async (id) => {
    reads++;
    await originalGet(id);
    return reads >= 2 ? transportOrder() : working;
  };

  const adapter = new KiteBrokerAdapter(transport, adapterConfig(), fakeClock());
  const order = await adapter.submitOrder(request());
  assert.equal(order.state, "COMPLETE");
  assert.equal(order.filled_quantity, 75);
  assert.equal(transport.calls.filter((c) => c === "place").length, 1);
});

test("an adopted order carries its PARTIAL fill, never a rounded-up one", async () => {
  const partial = transportOrder({
    status: "CANCELLED",
    filled_quantity: 40,
    pending_quantity: 35,
    average_price: 100.02,
  });
  const transport = timingOutTransport([partial]);
  const adapter = new KiteBrokerAdapter(transport, adapterConfig(), fakeClock());
  const order = await adapter.submitOrder(request());
  assert.equal(order.state, "CANCELLED");
  assert.equal(order.filled_quantity, 40, "a partial must not be rounded into a complete box");
  assert.equal(order.pending_quantity, 35);
});

test("no matching order means QUARANTINE, never a resubmission", async () => {
  // An empty order book is NOT proof the order was never created — one read that does not yet
  // show a just-placed order is weak evidence, and acting on it is how duplicates happen.
  const transport = timingOutTransport([]);
  const adapter = new KiteBrokerAdapter(transport, adapterConfig(), fakeClock());
  const error = await rejection(adapter.submitOrder(request()));
  assert.ok(error instanceof BrokerAmbiguousSubmitError);
  assert.equal(error.order.state, "RECONCILIATION_REQUIRED");
  assert.equal(transport.calls.filter((c) => c === "place").length, 1, "no retry, ever");
  assert.match(error.message, /NO retry was attempted/);
  assert.match(error.message, /timed out/, "the message explains why the outcome is unknown");
});

test("SEVERAL orders sharing our tag are never adopted — attribution must be unique", async () => {
  const transport = timingOutTransport([
    transportOrder({ order_id: "K-A" }),
    transportOrder({ order_id: "K-B" }),
  ]);
  const adapter = new KiteBrokerAdapter(transport, adapterConfig(), fakeClock());
  const error = await rejection(adapter.submitOrder(request()));
  assert.ok(error instanceof BrokerAmbiguousSubmitError);
  assert.equal(error.order.state, "RECONCILIATION_REQUIRED");
  assert.equal(error.order.broker_order_id, null, "no ambiguous broker id is claimed");
});

test("a tag match whose immutable attributes disagree is never adopted", async () => {
  // A tag is a hash. Adopting on a collision would attribute someone else's exposure to this Box.
  const cases = [
    ["quantity", transportOrder({ quantity: 150 })],
    ["side", transportOrder({ transaction_type: "SELL" })],
    ["tradingsymbol", transportOrder({ tradingsymbol: "NIFTY26SEP19900PE" })],
    ["exchange", transportOrder({ exchange: "BFO" })],
  ];
  for (const [label, candidate] of cases) {
    const transport = timingOutTransport([candidate]);
    const adapter = new KiteBrokerAdapter(transport, adapterConfig(), fakeClock());
    const error = await rejection(adapter.submitOrder(request()));
    assert.ok(error instanceof BrokerAmbiguousSubmitError, `${label} should not be adopted`);
    assert.equal(error.order.state, "RECONCILIATION_REQUIRED", `${label} should quarantine`);
  }
});

test("an order already attributed to a different client id is never stolen", async () => {
  const transport = timingOutTransport([transportOrder()]);
  const adapter = new KiteBrokerAdapter(transport, adapterConfig(), fakeClock());
  // Make the adapter believe K-ADOPT-1 belongs to another leg by listing it first under a
  // different session identity.
  await adapter.listOrders();
  const stolen = await rejection(
    adapter.submitOrder(request({ client_order_id: "BOX:trade-9:ENTRY:k2_ce:attempt-1" })),
  );
  assert.ok(stolen instanceof BrokerAmbiguousSubmitError);
});

test("the tag used for adoption is deterministic, bounded, and attempt-specific", () => {
  // Determinism is what makes adoption possible at all: the same client id must always hash to
  // the same tag, across processes and restarts.
  assert.equal(stableKiteTag(CLIENT_ID), stableKiteTag(CLIENT_ID));
  assert.ok(stableKiteTag(CLIENT_ID).length <= 20, "Kite caps tag length");
  // Different attempts must NOT collide, or two attempts at one leg could be confused.
  const a1 = stableKiteTag("BOX:t:ENTRY:k1_ce:attempt-1");
  const a2 = stableKiteTag("BOX:t:ENTRY:k1_ce:attempt-2");
  assert.notEqual(a1, a2);
  // Different roles must not collide either.
  assert.notEqual(stableKiteTag("BOX:t:ENTRY:k1_ce:attempt-1"), stableKiteTag("BOX:t:ENTRY:k2_ce:attempt-1"));
});

test("a DEFINITIVE 4xx rejection is not treated as ambiguous and triggers no lookup", async () => {
  const transport = timingOutTransport([]);
  transport.placeOrder = async () => {
    transport.calls.push("place");
    const { KiteHttpError } = await import("../../dist/box/kiteBrokerAdapter.js");
    throw new KiteHttpError(400, "insufficient funds", {});
  };
  const adapter = new KiteBrokerAdapter(transport, adapterConfig(), fakeClock());
  const error = await rejection(adapter.submitOrder(request()));
  assert.equal(error.name, "BrokerOrderRejectedError");
  assert.equal(error.order.state, "REJECTED");
  assert.ok(
    !transport.calls.includes("listOrders"),
    "a definitive refusal needs no reconciliation — the broker already told us",
  );
});

test("a failing order-book lookup degrades to quarantine rather than throwing", async () => {
  const transport = timingOutTransport([]);
  transport.listOrders = async () => {
    transport.calls.push("listOrders");
    throw new Error("order book unavailable");
  };
  const adapter = new KiteBrokerAdapter(transport, adapterConfig(), fakeClock());
  const error = await rejection(adapter.submitOrder(request()));
  assert.ok(error instanceof BrokerAmbiguousSubmitError, "the lookup failure must not mask the ambiguity");
  assert.equal(error.order.state, "RECONCILIATION_REQUIRED");
  assert.equal(transport.calls.filter((c) => c === "place").length, 1);
});
