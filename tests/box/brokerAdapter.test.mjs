/**
 * The broker-adapter seam is PAPER ONLY. This checks the shared residual helper
 * that both the paper adapter and the simulator use to compute "what am I still
 * holding" from a set of resolved leg orders.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { residualFromLegs } from "../../dist/box/brokerAdapter.js";

const leg = (over) => ({
  role: "k1_ce",
  side: "BUY",
  token: 1000,
  tradingsymbol: "NIFTY26SEP19900CE",
  order_id: "x",
  client_order_id: "x",
  pricing: null,
  detected_price: 300,
  detected_qty: 0,
  submit_at: 0,
  arrival_at: 0,
  pending_since: null,
  timeout_at: null,
  fill_at: null,
  resolved_at: null,
  fill_price: 300,
  average_fill_price: 300,
  quantity: 75,
  requested_qty: 75,
  fill_qty: 75,
  remaining_qty: 0,
  fills: [],
  quote_version: 1,
  book_at: 0,
  book_exchange_at: null,
  book_age_ms: 0,
  slippage: 0,
  status: "FILLED",
  unwind_price: null,
  unwind_slippage: null,
  unwound_qty: 0,
  fail_reason: null,
  ...over,
});

test("a fully-unwound leg leaves no residual", () => {
  const r = residualFromLegs([leg({ fill_qty: 75, unwound_qty: 75 })], 1000);
  assert.equal(r.length, 0);
});

test("an un-unwound fill is residual for its full quantity", () => {
  const r = residualFromLegs([leg({ fill_qty: 75, unwound_qty: 0 })], 1000);
  assert.equal(r.length, 1);
  assert.equal(r[0].quantity, 75);
  assert.equal(r[0].average_price, 300);
  assert.equal(r[0].side, "BUY");
});

test("a partially-unwound fill is residual only for the outstanding remainder", () => {
  const r = residualFromLegs([leg({ fill_qty: 75, unwound_qty: 40 })], 1000);
  assert.equal(r.length, 1);
  assert.equal(r[0].quantity, 35);
});

test("a leg that never filled contributes no residual", () => {
  const r = residualFromLegs([leg({ fill_qty: 0, unwound_qty: 0, status: "TIMED_OUT" })], 1000);
  assert.equal(r.length, 0);
});
