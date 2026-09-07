/**
 * SUITE C — the maximum ₹ per-Box admission metric and its gate.
 *
 * The boundary cases are the whole point: "exactly at the cap" and "one paisa over" must be
 * decided exactly, which is why the implementation compares integer paise rather than rupee
 * floats. These tests would fail on a float implementation.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BOX_CAPITAL_LIMIT_REASON,
  boxCapitalSummary,
  evaluateBoxCapitalAdmission,
  fromPaise,
  grossEntryOrderNotional,
  toPaise,
} from "../../dist/box/boxCapital.js";

const ROLES = ["k1_ce", "k2_ce", "k2_pe", "k1_pe"];

/** Four legs at a given per-unit limit price and quantity. */
function legs({ prices, quantity = 100, sides = ["BUY", "SELL", "BUY", "SELL"] }) {
  return ROLES.map((role, i) => ({
    role,
    side: sides[i],
    tradingsymbol: `SYM${i}`,
    quantity,
    pricing: { limit_price: prices[i] },
  }));
}

function judge(requests, limitRupees, stage = "pre_submit") {
  return evaluateBoxCapitalAdmission({
    metrics: grossEntryOrderNotional(requests, 4),
    limitRupees,
    broker: "zerodha",
    candidateKey: "RELIANCE|2025-09-25|2500|2600|LONG_BOX",
    at: 1_000,
    stage,
  });
}

test("paise conversion is exact and half-up", () => {
  assert.equal(toPaise(1), 100);
  assert.equal(toPaise(0.01), 1);
  assert.equal(toPaise(1200.55), 120055);
  assert.equal(fromPaise(120055), 1200.55);
  // Non-finite input must not produce NaN downstream.
  assert.equal(toPaise(Number.NaN), 0);
  assert.equal(toPaise(Number.POSITIVE_INFINITY), 0);
});

test("gross notional sums |limit_price x quantity| across all four legs", () => {
  // 10*100 + 20*100 + 30*100 + 40*100 = 10,000
  const m = grossEntryOrderNotional(legs({ prices: [10, 20, 30, 40] }), 4);
  assert.equal(m.gross_entry_order_notional_rupees, 10_000);
  assert.equal(m.leg_count, 4);
  assert.equal(m.complete, true);
  assert.equal(m.incomplete_reason, null);
});

test("BUY and SELL legs are ADDED, never netted", () => {
  // Netting a 4-leg box would collapse to ~0 and let an arbitrarily large Box through.
  const m = grossEntryOrderNotional(
    legs({ prices: [50, 50, 50, 50], sides: ["BUY", "SELL", "BUY", "SELL"] }),
    4,
  );
  assert.equal(m.gross_entry_order_notional_rupees, 50 * 100 * 4);
});

test("the metric uses the bounded LIMIT price, not any other price field", () => {
  const requests = legs({ prices: [10, 10, 10, 10] });
  // A decoy LTP an order of magnitude away must be ignored entirely.
  for (const r of requests) r.ltp = 1_000;
  const m = grossEntryOrderNotional(requests, 4);
  assert.equal(m.gross_entry_order_notional_rupees, 10 * 100 * 4);
});

test("the metric scales with the four-leg REQUESTED quantity", () => {
  const one = grossEntryOrderNotional(legs({ prices: [10, 10, 10, 10], quantity: 1 }), 4);
  const fifty = grossEntryOrderNotional(legs({ prices: [10, 10, 10, 10], quantity: 50 }), 4);
  assert.equal(one.gross_entry_order_notional_rupees, 40);
  assert.equal(fifty.gross_entry_order_notional_rupees, 2_000);
});

// ── the cap boundary ─────────────────────────────────────────────────────────────────────

test("an amount BELOW the cap is allowed", () => {
  const verdict = judge(legs({ prices: [10, 20, 30, 39] }), 10_000);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.enabled, true);
  assert.equal(verdict.reason, null);
  assert.equal(verdict.calculated_rupees, 9_900);
});

test("an amount EXACTLY at the cap is allowed (the cap is an inclusive maximum)", () => {
  const verdict = judge(legs({ prices: [10, 20, 30, 40] }), 10_000);
  assert.equal(verdict.calculated_rupees, 10_000);
  assert.equal(verdict.allowed, true);
});

test("₹0.01 over the cap is BLOCKED", () => {
  // 10,000.01 total: one leg carries a single extra paisa across 1 unit.
  const requests = [
    { role: "k1_ce", side: "BUY", tradingsymbol: "A", quantity: 1, pricing: { limit_price: 9_999.99 } },
    { role: "k2_ce", side: "SELL", tradingsymbol: "B", quantity: 1, pricing: { limit_price: 0.01 } },
    { role: "k2_pe", side: "BUY", tradingsymbol: "C", quantity: 1, pricing: { limit_price: 0.005 } },
    { role: "k1_pe", side: "SELL", tradingsymbol: "D", quantity: 1, pricing: { limit_price: 0.005 } },
  ];
  const metrics = grossEntryOrderNotional(requests, 4);
  // 999999 + 1 + 1 + 1 paise = 1000002 paise = ₹10,000.02
  assert.equal(metrics.gross_entry_order_notional_paise, 1_000_002);
  const verdict = evaluateBoxCapitalAdmission({
    metrics,
    limitRupees: 10_000,
    broker: "zerodha",
    candidateKey: "K",
    at: 1,
    stage: "pre_submit",
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, BOX_CAPITAL_LIMIT_REASON);
  assert.match(verdict.detail, /exceeds the configured BOX_LIVE_MAX_BOX_CAPITAL_RUPEES/);
});

test("the refusal detail states this is NOT broker margin", () => {
  const verdict = judge(legs({ prices: [100, 100, 100, 100] }), 1_000);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.detail, /NOT broker margin/);
});

// ── disabled / backwards compatibility ───────────────────────────────────────────────────

test("cap 0 disables the gate entirely (backwards compatible default)", () => {
  const verdict = judge(legs({ prices: [1e6, 1e6, 1e6, 1e6] }), 0);
  assert.equal(verdict.enabled, false);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.reason, null);
  assert.equal(verdict.configured_max_rupees, 0);
});

test("a negative cap is treated as disabled, never as a cap of zero", () => {
  // A cap of zero would block every entry. Garbage config must degrade to the old behaviour.
  const verdict = judge(legs({ prices: [10, 10, 10, 10] }), -5);
  assert.equal(verdict.enabled, false);
  assert.equal(verdict.allowed, true);
});

test("with the cap DISABLED an incomplete metric still admits", () => {
  // Nothing to prove when no cap is configured; refusing here would regress every existing
  // paper deployment.
  const partial = grossEntryOrderNotional(legs({ prices: [10, 20, 30, 40] }).slice(0, 3), 4);
  assert.equal(partial.complete, false);
  const verdict = evaluateBoxCapitalAdmission({
    metrics: partial,
    limitRupees: 0,
    broker: "zerodha",
    candidateKey: "K",
    at: 1,
    stage: "pre_submit",
  });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.enabled, false);
});

// ── fail closed ──────────────────────────────────────────────────────────────────────────

test("FAILS CLOSED: a cap with fewer than four priced legs is refused", () => {
  const partial = grossEntryOrderNotional(legs({ prices: [10, 20, 30, 40] }).slice(0, 3), 4);
  const verdict = evaluateBoxCapitalAdmission({
    metrics: partial,
    limitRupees: 100_000,
    broker: "zerodha",
    candidateKey: "K",
    at: 1,
    stage: "pre_submit",
  });
  // The three-leg total (₹6,000) is FAR under the cap, so a naive implementation would admit.
  assert.equal(partial.gross_entry_order_notional_rupees, 6_000);
  assert.equal(verdict.allowed, false, "an under-stated total must never be admitted");
  assert.equal(verdict.reason, BOX_CAPITAL_LIMIT_REASON);
  assert.match(verdict.detail, /cannot verify/);
});

test("FAILS CLOSED: an unpriced or zero-priced leg makes the metric incomplete", () => {
  for (const bad of [null, 0, -1, Number.NaN, undefined]) {
    const requests = legs({ prices: [10, 20, 30, 40] });
    requests[2].pricing.limit_price = bad;
    const m = grossEntryOrderNotional(requests, 4);
    assert.equal(m.complete, false, `limit_price ${String(bad)} must not count as priced`);
    const verdict = evaluateBoxCapitalAdmission({
      metrics: m, limitRupees: 100_000, broker: "zerodha", candidateKey: "K", at: 1, stage: "pre_submit",
    });
    assert.equal(verdict.allowed, false);
  }
});

test("FAILS CLOSED: a non-integer or non-positive quantity makes the metric incomplete", () => {
  for (const bad of [0, -100, 1.5, Number.NaN]) {
    const requests = legs({ prices: [10, 20, 30, 40] });
    requests[1].quantity = bad;
    const m = grossEntryOrderNotional(requests, 4);
    assert.equal(m.complete, false, `quantity ${String(bad)} must not count`);
  }
});

// ── reporting ────────────────────────────────────────────────────────────────────────────

test("the report records amount, configured maximum, broker, candidate key, stage and time", () => {
  const verdict = judge(legs({ prices: [10, 20, 30, 40] }), 5_000, "dequeue");
  assert.equal(verdict.calculated_rupees, 10_000);
  assert.equal(verdict.configured_max_rupees, 5_000);
  assert.equal(verdict.broker, "zerodha");
  assert.equal(verdict.candidate_key, "RELIANCE|2025-09-25|2500|2600|LONG_BOX");
  assert.equal(verdict.stage, "dequeue");
  assert.equal(verdict.at, 1_000);
  assert.equal(verdict.allowed, false);
});

test("broker margin is reported separately and defaults to null, never 0", () => {
  const plain = judge(legs({ prices: [10, 10, 10, 10] }), 100_000);
  assert.equal(plain.broker_estimated_margin_rupees, null, "absent margin must not read as ₹0");

  const withMargin = evaluateBoxCapitalAdmission({
    metrics: grossEntryOrderNotional(legs({ prices: [10, 10, 10, 10] }), 4),
    limitRupees: 100_000,
    broker: "zerodha",
    candidateKey: "K",
    at: 1,
    stage: "pre_submit",
    brokerEstimatedMarginRupees: 18_500,
  });
  // Carried alongside, and the ADMISSION number is untouched by it.
  assert.equal(withMargin.broker_estimated_margin_rupees, 18_500);
  assert.equal(withMargin.calculated_rupees, 4_000);
});

test("the status summary is bounded and omits per-leg / candidate detail", () => {
  const summary = boxCapitalSummary(judge(legs({ prices: [10, 20, 30, 40] }), 5_000));
  assert.deepEqual(Object.keys(summary).sort(), [
    "configured_max_rupees",
    "enabled",
    "last_allowed",
    "last_at",
    "last_calculated_rupees",
    "last_stage",
  ]);
  // No high-cardinality labels: no candidate key, no tradingsymbols.
  const serialised = JSON.stringify(summary);
  assert.ok(!serialised.includes("RELIANCE"));
  assert.ok(!serialised.includes("SYM"));
});

test("a null report summarises as disabled rather than throwing", () => {
  const summary = boxCapitalSummary(null);
  assert.equal(summary.enabled, false);
  assert.equal(summary.last_calculated_rupees, null);
  assert.equal(summary.last_allowed, null);
});
