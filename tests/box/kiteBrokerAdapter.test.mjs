import test from "node:test";
import assert from "node:assert/strict";

import {
  BrokerAmbiguousSubmitError,
  BrokerDisabledError,
} from "../../dist/box/brokerAdapter.js";
import {
  KiteBrokerAdapter,
  KiteHttpTransport,
} from "../../dist/box/kiteBrokerAdapter.js";

const request = (overrides = {}) => ({
  client_order_id: "BOX:trade-1:ENTRY:k1_ce:attempt-1",
  role: "k1_ce",
  trade_id: "trade-1",
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
  order_id: "K1",
  status: "COMPLETE",
  exchange: "NFO",
  tradingsymbol: "NIFTY26SEP19900CE",
  transaction_type: "BUY",
  quantity: 75,
  filled_quantity: 75,
  pending_quantity: 0,
  average_price: 100.05,
  price: 100.1,
  tag: "BOXTAG",
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
  brokerMinIntervalMs: 50,
  maxModifications: 2,
  maxChaseTicks: 2,
  ...overrides,
});

function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    wait: async (ms) => { now += ms; },
  };
}

function scriptedTransport({ states = [], cancelError = null } = {}) {
  const calls = [];
  let price = 100.1;
  const queue = [...states];
  const transport = {
    calls,
    placeOrder: async (payload) => { calls.push(["place", payload]); return { order_id: "K1" }; },
    cancelOrder: async (id) => {
      calls.push(["cancel", id]);
      if (cancelError) throw cancelError;
    },
    modifyOrder: async (id, payload) => {
      calls.push(["modify", id, payload]);
      price = payload.price;
    },
    getOrder: async (id) => {
      const next = queue.shift() ?? transportOrder({ price });
      const result = typeof next === "function" ? next(price) : { ...next, price: next.price ?? price };
      calls.push(["get", id, result.status, result.filled_quantity]);
      return result;
    },
    listOrders: async () => { calls.push(["listOrders"]); return []; },
    listPositions: async () => { calls.push(["listPositions"]); return []; },
    margins: async () => { calls.push(["margins"]); return { available: 1, utilised: 0 }; },
    health: async () => { calls.push(["health"]); return { ok: true, transport: "up", authenticated: true, message: null, checked_at: 0 }; },
  };
  return transport;
}

async function rejection(promise) {
  try {
    await promise;
    assert.fail("expected rejection");
  } catch (error) {
    return error;
  }
}

test("disabled KiteBrokerAdapter makes zero transport calls for every broker operation", async () => {
  const transport = scriptedTransport();
  const adapter = new KiteBrokerAdapter(
    transport,
    adapterConfig({ executionMode: "paper_latency", enabled: false }),
    fakeClock(),
  );

  const operations = [
    () => adapter.submitOrder(request()),
    () => adapter.cancelOrder("missing"),
    () => adapter.modifyOrder("missing", { limit_price: 100.05 }),
    () => adapter.getOrder("missing"),
    () => adapter.listOrders(),
    () => adapter.listPositions(),
    () => adapter.margins(),
  ];
  for (const operation of operations) {
    await assert.rejects(operation, BrokerDisabledError);
  }
  const health = await adapter.health();
  assert.equal(health.transport, "disabled");
  assert.deepEqual(transport.calls, [], "submit/cancel/modify/reads/margins/health never reach transport");
});

test("Kite adapter enforces bounded LIMIT chase and modification count before transport", async () => {
  const transport = scriptedTransport();
  const adapter = new KiteBrokerAdapter(
    transport,
    adapterConfig({ maxModifications: 1, maxChaseTicks: 2 }),
    fakeClock(),
  );

  await assert.rejects(
    () => adapter.submitOrder(request({ pricing: { ...request().pricing, max_chase_ticks: 3, limit_price: 100.15 } })),
    /Invalid bounded LIMIT pricing envelope/,
  );
  await assert.rejects(
    () => adapter.submitOrder(request({ pricing: { ...request().pricing, limit_price: 100.15 } })),
    /exceeds the configured chase band/,
  );
  assert.equal(transport.calls.filter(([name]) => name === "place").length, 0);

  const complete = await adapter.submitOrder(request());
  assert.equal(complete.state, "COMPLETE");
  await adapter.modifyOrder(request().client_order_id, { limit_price: 100.05, quantity: 75 });
  await assert.rejects(
    () => adapter.modifyOrder(request().client_order_id, { limit_price: 100.1, quantity: 75 }),
    /modification limit reached/,
  );
  assert.equal(transport.calls.filter(([name]) => name === "modify").length, 1);
});

test("placement timeout, 5xx, and malformed success are ambiguous and never retried", async (t) => {
  const cases = [
    ["timeout", async () => { const error = new Error("request timed out"); error.name = "AbortError"; throw error; }],
    ["5xx", async () => ({ ok: false, status: 503, json: async () => ({ message: "unavailable" }) })],
    ["malformed", async () => ({ ok: true, status: 200, json: async () => ({ data: {} }) })],
  ];

  for (const [name, response] of cases) {
    await t.test(name, async () => {
      // Count PLACEMENTS specifically, not total HTTP calls: an ambiguous submission now READS
      // the order book to look for its own tag before quarantining, and a read is emphatically
      // not a retry. Counting every fetch would make this assertion fail for the wrong reason.
      let placements = 0;
      let orderBookReads = 0;
      const http = new KiteHttpTransport({
        apiKey: "key",
        accessToken: () => "token",
        timeoutMs: 250,
        baseUrl: "https://offline.invalid",
        fetchImpl: async (url, init) => {
          const method = init?.method ?? "GET";
          if (method === "POST") placements++;
          else orderBookReads++;
          // The tag lookup must find nothing, so the outcome stays a quarantine.
          if (method === "GET") return { ok: true, status: 200, json: async () => ({ data: [] }) };
          return response(url, init);
        },
      });
      const adapter = new KiteBrokerAdapter(http, adapterConfig(), fakeClock());
      const req = request({ client_order_id: `BOX:trade-${name}:ENTRY:k1_ce:attempt-1` });
      const error = await rejection(adapter.submitOrder(req));
      assert.ok(error instanceof BrokerAmbiguousSubmitError);
      assert.equal(error.name, "BrokerAmbiguousSubmitError", "outcome is not a definitive broker reject");
      assert.equal(error.order.state, "RECONCILIATION_REQUIRED");
      assert.equal(error.order.reject_family, null);
      assert.equal(placements, 1, "placement is never blindly retried");
      assert.ok(orderBookReads >= 1, "an ambiguous submission asks the broker rather than guessing");
      // The quarantine message must explain WHY the outcome is unknown, for operator triage.
      assert.match(error.message, /reconciliation is required and NO retry was attempted/);

      const quarantined = await adapter.submitOrder(req);
      assert.equal(quarantined.state, "RECONCILIATION_REQUIRED");
      assert.equal(placements, 1, "same client ID returns quarantined evidence without a second placement");
    });
  }
});

for (const scenario of ["working", "partial"]) {
  test(`${scenario} timeout protectively cancels and returns broker-terminal cumulative fill`, async () => {
    const states = scenario === "working"
      ? [
          transportOrder({ status: "OPEN", filled_quantity: 0, pending_quantity: 75, average_price: 0 }),
          transportOrder({ status: "OPEN", filled_quantity: 0, pending_quantity: 75, average_price: 0 }),
          transportOrder({ status: "CANCELLED", filled_quantity: 35, pending_quantity: 40, average_price: 100.05 }),
        ]
      : [
          transportOrder({ status: "OPEN", filled_quantity: 35, pending_quantity: 40, average_price: 100.05 }),
          transportOrder({ status: "OPEN", filled_quantity: 35, pending_quantity: 40, average_price: 100.05 }),
          transportOrder({ status: "CANCELLED", filled_quantity: 35, pending_quantity: 40, average_price: 100.05 }),
        ];
    const transport = scriptedTransport({ states });
    const adapter = new KiteBrokerAdapter(
      transport,
      adapterConfig({
        ackTimeoutMs: 1_000,
        workingTimeoutMs: scenario === "working" ? 100 : 1_000,
        partialTimeoutMs: scenario === "partial" ? 50 : 1_000,
      }),
      fakeClock(),
    );

    const order = await adapter.submitOrder(request());
    assert.equal(order.state, "CANCELLED");
    assert.equal(order.filled_quantity, 35, "final cumulative fill comes from broker confirmation");
    assert.equal(order.pending_quantity, 40);
    assert.equal(transport.calls.filter(([name]) => name === "cancel").length, 1);
  });
}

test("an uncertain protective cancellation remains reconciliation-required", async () => {
  const transport = scriptedTransport({
    states: [
      transportOrder({ status: "OPEN", filled_quantity: 0, pending_quantity: 75, average_price: 0 }),
      transportOrder({ status: "OPEN", filled_quantity: 0, pending_quantity: 75, average_price: 0 }),
    ],
    cancelError: new Error("cancel transport uncertain"),
  });
  const adapter = new KiteBrokerAdapter(
    transport,
    adapterConfig({ ackTimeoutMs: 1_000, workingTimeoutMs: 100 }),
    fakeClock(),
  );

  const error = await rejection(adapter.submitOrder(request()));
  assert.ok(error instanceof BrokerAmbiguousSubmitError);
  assert.equal(error.order.state, "RECONCILIATION_REQUIRED");
  assert.equal(error.order.filled_quantity, 0);
  assert.equal(transport.calls.filter(([name]) => name === "cancel").length, 1);
  assert.equal(transport.calls.filter(([name]) => name === "place").length, 1, "no placement retry occurs");
});
