/**
 * DhanBrokerAdapter: correlation identity, status normalization, reject
 * classification and — most importantly — the anti-duplicate reconciliation path.
 *
 * The single most damaging bug available in this file's subject matter is
 * re-submitting an order whose outcome is unknown, because a four-leg box would grow
 * a fifth leg. The `submitOrder` tests below drive a fake Dhan client through the
 * ambiguous paths and assert that exactly ONE POST is ever attempted.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DhanBrokerAdapter,
  classifyDhanReject,
  dhanOrderState,
  normalizePosition,
} from "../../dist/box/dhanBrokerAdapter.js";
import {
  dhanCorrelationId,
  isValidDhanCorrelationId,
  DHAN_CORRELATION_MAX_LENGTH,
} from "../../dist/brokers/dhan/correlation.js";
import { DhanNetworkError, DhanError } from "../../dist/brokers/dhan/errors.js";
import {
  BrokerAmbiguousSubmitError,
  BrokerOrderRejectedError,
  BrokerDisabledError,
} from "../../dist/box/brokerAdapter.js";

/* ---------------------------- correlation identity ------------------------- */

const CLIENT_ID = "BOX:6512f0a0a0a0a0a0a0a0a0a0:ENTRY:k1_ce:attempt-1";

test("Dhan's correlation-id limit is 30 characters", () => {
  // Per the current DhanHQ v2 docs. Pinned as a constant test because the whole
  // hashing design exists to fit inside it.
  assert.equal(DHAN_CORRELATION_MAX_LENGTH, 30);
});

test("a correlation id fits Dhan's 30-character limit", () => {
  const id = dhanCorrelationId(CLIENT_ID);
  assert.ok(id.length <= DHAN_CORRELATION_MAX_LENGTH, `${id} is ${id.length} chars`);
  assert.ok(isValidDhanCorrelationId(id));
});

test("the extra room over a 64-bit digest is spent on STRENGTH, not padding", () => {
  // A 96-bit digest base36-encodes to ~15-21 chars, so a real id is comfortably
  // longer than the 14 a 64-bit digest produced — evidence the third lane is
  // actually present rather than the id being padded out to look longer.
  const id = dhanCorrelationId(CLIENT_ID);
  assert.ok(id.length >= 16, `expected a wider digest, got ${id} (${id.length})`);
  // And it must NOT carry raw client-id characters, which would reintroduce the
  // prefix-collision hazard the hash exists to remove.
  assert.ok(!id.includes("ENTRY"));
  assert.ok(!id.includes("6512f0a0"));
});

test("a correlation id is DETERMINISTIC — the reconciliation key must be recomputable", () => {
  // After a crash there is no stored mapping to consult, so the same client id must
  // always produce the same correlation id or reconcile-by-correlation cannot work.
  assert.equal(dhanCorrelationId(CLIENT_ID), dhanCorrelationId(CLIENT_ID));
});

test("legs of the SAME box get different correlation ids", () => {
  // The trade id sits in the middle of the client id, so a naive 25-char truncation
  // would make these collide. That is the failure this hash exists to prevent.
  const roles = ["k1_ce", "k2_ce", "k2_pe", "k1_pe"].map((role) =>
    dhanCorrelationId(`BOX:6512f0a0a0a0a0a0a0a0a0a0:ENTRY:${role}:attempt-1`),
  );
  assert.equal(new Set(roles).size, 4, `expected 4 distinct ids, got ${roles.join(",")}`);
});

test("the SAME leg of DIFFERENT boxes gets different correlation ids", () => {
  const a = dhanCorrelationId("BOX:aaaaaaaaaaaaaaaaaaaaaaaa:ENTRY:k1_ce:attempt-1");
  const b = dhanCorrelationId("BOX:bbbbbbbbbbbbbbbbbbbbbbbb:ENTRY:k1_ce:attempt-1");
  assert.notEqual(a, b);
});

test("retries and phases of one leg get different correlation ids", () => {
  const first = dhanCorrelationId("BOX:t1:ENTRY:k1_ce:attempt-1");
  const second = dhanCorrelationId("BOX:t1:ENTRY:k1_ce:attempt-2");
  const exit = dhanCorrelationId("BOX:t1:EXIT:k1_ce:attempt-1");
  assert.equal(new Set([first, second, exit]).size, 3);
});

test("correlation ids stay alphanumeric and bounded across many inputs", () => {
  for (let i = 0; i < 500; i++) {
    const id = dhanCorrelationId(`BOX:trade${i}:ENTRY:k2_pe:attempt-${i % 7}`);
    assert.ok(isValidDhanCorrelationId(id), `${id} is not a valid Dhan correlation id`);
  }
});

test("no collisions across a realistic population of Box orders", () => {
  // 4 roles x 2 purposes x 3 attempts x 400 trades = 9,600 distinct client ids.
  // A collision here would attribute one box's fill to another, so this is the
  // property the 96-bit digest is actually for.
  const ids = new Set();
  let n = 0;
  for (let t = 0; t < 400; t++) {
    for (const role of ["k1_ce", "k2_ce", "k2_pe", "k1_pe"]) {
      for (const purpose of ["ENTRY", "EXIT"]) {
        for (let a = 1; a <= 3; a++) {
          const id = dhanCorrelationId(`BOX:6512f0a0a0a0a0a0a0a0a${String(t).padStart(3, "0")}:${purpose}:${role}:attempt-${a}`);
          assert.ok(isValidDhanCorrelationId(id), id);
          ids.add(id);
          n++;
        }
      }
    }
  }
  assert.equal(ids.size, n, `expected ${n} distinct correlation ids, got ${ids.size}`);
});

test("ids differing only in a TRAILING character still differ", () => {
  // The digest folds in the input length and mixes by position, so a shared prefix
  // cannot collapse two ids together.
  const a = dhanCorrelationId("BOX:t1:ENTRY:k1_ce:attempt-1");
  const b = dhanCorrelationId("BOX:t1:ENTRY:k1_ce:attempt-11");
  assert.notEqual(a, b);
});

test("isValidDhanCorrelationId rejects over-long and non-alphanumeric ids", () => {
  assert.equal(isValidDhanCorrelationId(""), false);
  // Exactly at the limit is fine; one over is not.
  assert.equal(isValidDhanCorrelationId("a".repeat(30)), true);
  assert.equal(isValidDhanCorrelationId("a".repeat(31)), false);
  assert.equal(isValidDhanCorrelationId("BOX:t1:ENTRY"), false, "colons are not allowed");
});

/* --------------------------- status normalization -------------------------- */

test("Dhan order statuses map onto BrokerOrderState", () => {
  assert.equal(dhanOrderState("TRANSIT", 0, 75), "ACKNOWLEDGED");
  assert.equal(dhanOrderState("PENDING", 0, 75), "OPEN");
  assert.equal(dhanOrderState("TRADED", 75, 75), "COMPLETE");
  assert.equal(dhanOrderState("PART_TRADED", 25, 75), "PARTIALLY_FILLED");
  assert.equal(dhanOrderState("CANCELLED", 0, 75), "CANCELLED");
  assert.equal(dhanOrderState("CLOSED", 0, 75), "CANCELLED");
  assert.equal(dhanOrderState("REJECTED", 0, 75), "REJECTED");
});

test("a PENDING order with a partial fill is PARTIALLY_FILLED, not merely OPEN", () => {
  // Dhan can report a partially filled order as PENDING. Trusting the label alone
  // would leave the box's exposure accounting wrong about a half-filled leg.
  assert.equal(dhanOrderState("PENDING", 25, 75), "PARTIALLY_FILLED");
});

test("EXPIRED keeps a partial fill rather than discarding it", () => {
  // Validity lapsing does not undo quantity that already traded.
  assert.equal(dhanOrderState("EXPIRED", 25, 75), "PARTIALLY_FILLED");
  assert.equal(dhanOrderState("EXPIRED", 0, 75), "CANCELLED");
});

test("a TRADED label with a short fill is treated as PARTIALLY_FILLED", () => {
  assert.equal(dhanOrderState("TRADED", 25, 75), "PARTIALLY_FILLED");
});

test("PART_TRADED that has since completed reports COMPLETE", () => {
  assert.equal(dhanOrderState("PART_TRADED", 75, 75), "COMPLETE");
});

test("an UNRECOGNISED status becomes UNKNOWN, never a guessed terminal state", () => {
  // The order manager knows how to reconcile UNKNOWN; inventing COMPLETE would
  // fabricate a fill that never happened.
  assert.equal(dhanOrderState("SOMETHING_NEW", 0, 75), "UNKNOWN");
  assert.equal(dhanOrderState("", 0, 75), "UNKNOWN");
  assert.equal(dhanOrderState(undefined, 0, 75), "UNKNOWN");
});

test("status matching is case-insensitive and whitespace tolerant", () => {
  assert.equal(dhanOrderState(" traded ", 75, 75), "COMPLETE");
});

/* --------------------------- reject classification ------------------------- */

test("rejections are classified into actionable families", () => {
  assert.equal(classifyDhanReject(null, "Insufficient margin available"), "margin");
  assert.equal(classifyDhanReject(null, "Order price is outside the price band"), "price_band");
  assert.equal(classifyDhanReject(null, "Quantity freeze limit exceeded"), "quantity_freeze");
  assert.equal(classifyDhanReject(null, "Market closed for this segment"), "market_closed");
  assert.equal(classifyDhanReject(null, "Invalid securityId supplied"), "instrument_unavailable");
  assert.equal(classifyDhanReject(null, "Rate limit exceeded"), "rate_limit");
  assert.equal(classifyDhanReject(null, "Invalid access token"), "auth");
  assert.equal(classifyDhanReject(null, "RMS blocked this order"), "rms");
});

test("an unmatched rejection is generic rather than a plausible guess", () => {
  assert.equal(classifyDhanReject(null, "Something entirely new happened"), "generic");
  assert.equal(classifyDhanReject(null, null), "generic");
});

/* ------------------------------- positions -------------------------------- */

test("a long position normalizes with the BUY average", () => {
  const p = normalizePosition(
    { securityId: "45678", tradingSymbol: "ASTRAL25SEP2500CE", exchangeSegment: "NSE_FNO", netQty: 275, buyAvg: 12.5, sellAvg: 0 },
    () => null,
  );
  assert.equal(p.net_quantity, 275);
  assert.equal(p.average_price, 12.5);
  assert.equal(p.exchange, "NFO", "translated to the internal exchange label");
});

test("a short position normalizes with the SELL average and a negative quantity", () => {
  const p = normalizePosition(
    { securityId: "45678", tradingSymbol: "X", exchangeSegment: "NSE_FNO", netQty: -275, buyAvg: 0, sellAvg: 9.75 },
    () => null,
  );
  assert.equal(p.net_quantity, -275);
  assert.equal(p.average_price, 9.75);
});

/* ------------------------------ submitOrder ------------------------------- */

const REQUEST = {
  client_order_id: CLIENT_ID,
  role: "k1_ce",
  trade_id: "6512f0a0a0a0a0a0a0a0a0a0",
  attempt_id: "attempt-1",
  purpose: "ENTRY",
  phase: "entry",
  exchange: "NFO",
  tradingsymbol: "ASTRAL25SEP2500CE",
  token: 2_000_045_678,
  side: "BUY",
  quantity: 275,
  pricing: {
    order_type: "LIMIT",
    reference_price: 12.5,
    tick_size: 0.05,
    max_chase_ticks: 2,
    limit_price: 12.6,
  },
};

function adapter(clientOverrides = {}, cfgOverrides = {}) {
  const calls = { place: 0, byCorrelation: 0, get: 0, cancel: 0, modify: 0 };
  const client = {
    placeOrder: async () => {
      calls.place++;
      throw new DhanNetworkError("timed out");
    },
    getOrderByCorrelationId: async () => {
      calls.byCorrelation++;
      return null;
    },
    getOrder: async () => {
      calls.get++;
      return null;
    },
    cancelOrder: async () => {
      calls.cancel++;
      return { orderId: "1", orderStatus: "CANCELLED" };
    },
    modifyOrder: async () => {
      calls.modify++;
      return { orderId: "1", orderStatus: "PENDING" };
    },
    getTradesForOrder: async () => [],
    listOrders: async () => [],
    listPositions: async () => [],
    getFundLimit: async () => ({ availabelBalance: 100000, utilizedAmount: 5000 }),
    getProfile: async () => ({ dhanClientId: "C1" }),
    ...clientOverrides,
  };
  const cfg = {
    executionMode: "live",
    enabled: true,
    staticIpReady: () => true,
    ackTimeoutMs: 30,
    workingTimeoutMs: 60,
    partialTimeoutMs: 30,
    cancelTimeoutMs: 30,
    brokerMinIntervalMs: 1,
    maxModifications: 2,
    maxChaseTicks: 2,
    dhanClientId: () => "C1",
    identify: () => ({ segment: "NSE_FNO", securityId: 45678 }),
    ...cfgOverrides,
  };
  return { a: new DhanBrokerAdapter(client, cfg), calls, client };
}

test("an AMBIGUOUS submission reconciles by correlation id and NEVER re-POSTs", { timeout: 5000 }, async () => {
  const { a, calls } = adapter();
  await assert.rejects(() => a.submitOrder(REQUEST), BrokerAmbiguousSubmitError);
  assert.equal(calls.place, 1, "exactly one POST /orders was attempted");
  assert.ok(calls.byCorrelation >= 1, "the correlation lookup was used to reconcile");
});

test("an ambiguous submission that DOES resolve adopts the existing order", { timeout: 5000 }, async () => {
  // Dhan timed out but the order is live. It must be adopted, not re-sent.
  const { a, calls } = adapter({
    getOrderByCorrelationId: async () => ({
      orderId: "DHAN-1",
      orderStatus: "TRADED",
      tradingSymbol: "ASTRAL25SEP2500CE",
      securityId: "45678",
      exchangeSegment: "NSE_FNO",
      quantity: 275,
      filledQty: 275,
      averageTradedPrice: 12.55,
      price: 12.6,
      transactionType: "BUY",
    }),
  });
  const order = await a.submitOrder(REQUEST);
  assert.equal(calls.place, 1, "still exactly one POST");
  assert.equal(order.state, "COMPLETE");
  assert.equal(order.broker_order_id, "DHAN-1");
  assert.equal(order.filled_quantity, 275);
});

test("a DEFINITIVE 4xx is a rejection, not an ambiguity", { timeout: 5000 }, async () => {
  // Dhan understood and refused, so no reconciliation lookup is needed.
  const { a, calls } = adapter({
    placeOrder: async () => {
      calls.place++;
      throw new DhanError("Insufficient margin available", 400, "MARGIN_ERROR");
    },
  });
  await assert.rejects(() => a.submitOrder(REQUEST), BrokerOrderRejectedError);
  assert.equal(calls.byCorrelation, 0, "a definitive rejection needs no reconciliation");
});

test("a 429 is treated as AMBIGUOUS, not as a definitive rejection", { timeout: 5000 }, async () => {
  // "Not now" says nothing about whether an earlier attempt landed.
  const { a, calls } = adapter({
    placeOrder: async () => {
      calls.place++;
      throw new DhanError("Rate limited", 429, "RATE_LIMIT");
    },
  });
  await assert.rejects(() => a.submitOrder(REQUEST), BrokerAmbiguousSubmitError);
  assert.ok(calls.byCorrelation >= 1);
});

test("a 200 with no orderId is ambiguous and reconciles rather than re-POSTing", { timeout: 5000 }, async () => {
  const { a, calls } = adapter({
    placeOrder: async () => {
      calls.place++;
      return { orderStatus: "PENDING" };
    },
  });
  await assert.rejects(() => a.submitOrder(REQUEST), BrokerAmbiguousSubmitError);
  assert.equal(calls.place, 1);
  assert.ok(calls.byCorrelation >= 1);
});

test("submitting the same client order id twice does not place a second order", { timeout: 5000 }, async () => {
  let placed = 0;
  const { a } = adapter({
    placeOrder: async () => {
      placed++;
      return { orderId: "DHAN-9", orderStatus: "TRADED" };
    },
    getOrder: async () => ({
      orderId: "DHAN-9",
      orderStatus: "TRADED",
      tradingSymbol: "X",
      securityId: "45678",
      exchangeSegment: "NSE_FNO",
      quantity: 275,
      filledQty: 275,
      averageTradedPrice: 12.6,
      price: 12.6,
      transactionType: "BUY",
    }),
  });
  const first = await a.submitOrder(REQUEST);
  const second = await a.submitOrder(REQUEST);
  assert.equal(placed, 1, "in-session idempotency prevented a duplicate");
  assert.equal(first.client_order_id, second.client_order_id);
});

/* --------------------------------- gating --------------------------------- */

test("a DISABLED adapter makes zero broker calls, including reads", { timeout: 5000 }, async () => {
  const { a, calls } = adapter({}, { enabled: false });
  await assert.rejects(() => a.submitOrder(REQUEST), BrokerDisabledError);
  await assert.rejects(() => a.listOrders(), BrokerDisabledError);
  await assert.rejects(() => a.listPositions(), BrokerDisabledError);
  assert.equal(calls.place, 0);
});

test("paper execution mode cannot reach the live adapter", { timeout: 5000 }, async () => {
  const { a } = adapter({}, { executionMode: "paper_legging" });
  await assert.rejects(() => a.submitOrder(REQUEST), BrokerDisabledError);
});

test("submission FAILS CLOSED when the static IP is not whitelisted", { timeout: 5000 }, async () => {
  // Dhan refuses order placement from a non-whitelisted IP. Discovering that
  // mid-box would leave a partially built position, so it is refused locally.
  const { a, calls } = adapter({}, { staticIpReady: () => false });
  await assert.rejects(() => a.submitOrder(REQUEST), /static public IP is not whitelisted/);
  assert.equal(calls.place, 0, "nothing was sent");
});

test("static-IP failure does NOT block reads, so reconciliation can still recover", { timeout: 5000 }, async () => {
  const { a } = adapter({}, { staticIpReady: () => false });
  // listOrders must still work: blocking it would prevent the very reconciliation
  // needed to resolve outstanding exposure.
  const orders = await a.listOrders();
  assert.deepEqual(orders, []);
});

test("an unbounded LIMIT envelope is refused before anything is sent", { timeout: 5000 }, async () => {
  const { a, calls } = adapter();
  await assert.rejects(
    () =>
      a.submitOrder({
        ...REQUEST,
        // A limit far above the reference: this is a market order in disguise.
        pricing: { ...REQUEST.pricing, limit_price: 500 },
      }),
    /chase band|bounded LIMIT/,
  );
  assert.equal(calls.place, 0);
});

test("health reports authenticated-but-not-trading-ready when the static IP is missing", { timeout: 5000 }, async () => {
  const { a } = adapter({}, { staticIpReady: () => false });
  const health = await a.health();
  assert.equal(health.authenticated, true, "the session itself is fine");
  assert.equal(health.ok, false, "but trading is not possible");
  assert.match(health.message, /static public IP/);
});

test("margins normalize Dhan's fund limit", { timeout: 5000 }, async () => {
  const { a } = adapter();
  const margin = await a.margins();
  assert.equal(margin.available, 100000);
  assert.equal(margin.utilised, 5000);
});
