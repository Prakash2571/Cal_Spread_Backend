/**
 * The local, deterministic charge calculator.
 *
 * These are the "known deterministic examples" that pin the rate card: they must
 * fail loudly if a rate is changed by accident, and they prove the structural
 * invariants (heads sum to the leg total; leg totals sum to the group total;
 * BUY/SELL-only heads land on the right side).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  LocalChargeCalculator,
  calculateLegCharges,
  calculateBoxCharges,
  calculateRoundTrip,
  ipftFor,
  loadBoxChargeRates,
  reverseOrders,
  roundStt,
} from "../../dist/box/localCharges.js";

const round2 = (v) => Math.round(v * 100) / 100;

test("a SELL option leg is charged STT on the premium (rounded to the rupee); a BUY leg is not", () => {
  const rates = loadBoxChargeRates();
  const sell = calculateLegCharges({ side: "SELL", tradingsymbol: "X", quantity: 75, price: 300 }, rates);
  const buy = calculateLegCharges({ side: "BUY", tradingsymbol: "X", quantity: 75, price: 300 }, rates);
  const value = 75 * 300; // 22,500

  // STT: sell side only, on the premium, rounded to the NEAREST RUPEE (statutory).
  assert.equal(sell.stt, roundStt(value * (rates.sttSellPct / 100), rates));
  assert.equal(sell.stt, Math.round(value * (rates.sttSellPct / 100)));
  assert.notEqual(sell.stt, round2(value * (rates.sttSellPct / 100)), "must NOT be paise-rounded");
  assert.equal(sell.stt_type, "stt");
  assert.equal(buy.stt, 0);
  assert.equal(buy.stt_type, "");

  // Stamp duty: buy side only, 0.003% (paise-rounded).
  assert.equal(buy.stamp_duty, round2(value * 0.00003));
  assert.equal(sell.stamp_duty, 0);
});

test("STT rounding is centralised in roundStt and honours the mode flag", () => {
  const nearestRupee = { sttRoundNearestRupee: true };
  const paise = { sttRoundNearestRupee: false };
  assert.equal(roundStt(22.5, nearestRupee), 23);
  assert.equal(roundStt(22.49, nearestRupee), 22);
  assert.equal(roundStt(22.5, paise), 22.5);
});

test("brokerage is a flat ₹20 per order and GST is 18% of (brokerage+exchange+SEBI)", () => {
  const rates = loadBoxChargeRates();
  const leg = calculateLegCharges({ side: "BUY", tradingsymbol: "X", quantity: 75, price: 300 }, rates);
  const value = 22_500;
  assert.equal(leg.brokerage, 20);
  // Exchange head = exchange txn + IPFT (₹/crore, 0 by default).
  assert.equal(leg.exchange_txn, round2(value * (rates.exchangeTxnPct / 100) + ipftFor(value, rates)));
  assert.equal(leg.sebi, round2(value * (rates.sebiPct / 100)));
  assert.equal(leg.gst, round2((leg.brokerage + leg.exchange_txn + leg.sebi) * 0.18));
});

test("IPFT is modelled as ₹ per crore of premium and folded into the exchange head", () => {
  const prev = process.env.BOX_IPFT_PER_CRORE;
  process.env.BOX_IPFT_PER_CRORE = "50"; // ₹50 per crore
  try {
    const rates = loadBoxChargeRates();
    const value = 1_00_00_000; // exactly ₹1 crore of premium
    // ₹50 per crore → exactly ₹50 of IPFT on ₹1 crore.
    assert.equal(ipftFor(value, rates), 50);
    const leg = calculateLegCharges({ side: "BUY", tradingsymbol: "X", quantity: 1, price: value }, rates);
    assert.equal(leg.exchange_txn, round2(value * (rates.exchangeTxnPct / 100) + 50));
  } finally {
    if (prev === undefined) delete process.env.BOX_IPFT_PER_CRORE;
    else process.env.BOX_IPFT_PER_CRORE = prev;
  }
});

test("a leg total equals the sum of its rounded heads", () => {
  const rates = loadBoxChargeRates();
  for (const side of ["BUY", "SELL"]) {
    for (const price of [1.5, 105, 300.25, 999.9]) {
      const l = calculateLegCharges({ side, tradingsymbol: "X", quantity: 75, price }, rates);
      const sum = round2(l.brokerage + l.stt + l.exchange_txn + l.sebi + l.stamp_duty + l.gst);
      assert.equal(l.total, sum, `${side} @ ${price}: total must equal summed heads`);
    }
  }
});

test("a group total equals the sum of its legs, and each head aggregates", () => {
  const rates = loadBoxChargeRates();
  const orders = [
    { side: "BUY", tradingsymbol: "A", quantity: 75, price: 300 },
    { side: "SELL", tradingsymbol: "B", quantity: 75, price: 220 },
    { side: "BUY", tradingsymbol: "C", quantity: 75, price: 200 },
    { side: "SELL", tradingsymbol: "D", quantity: 75, price: 105 },
  ];
  const g = calculateBoxCharges(orders, rates);
  assert.equal(g.legs.length, 4);
  assert.equal(g.total, round2(g.legs.reduce((s, l) => s + l.total, 0)));
  for (const head of ["brokerage", "stt", "exchange_txn", "sebi", "stamp_duty", "gst"]) {
    assert.equal(g[head], round2(g.legs.reduce((s, l) => s + l[head], 0)), `${head} must aggregate`);
  }
  assert.equal(g.computed_by, "local", "a locally computed note is labelled as such");
});

test("the round trip reverses every side and projects the exit at the entry fills", () => {
  const entry = [
    { side: "BUY", tradingsymbol: "A", quantity: 75, price: 300 },
    { side: "SELL", tradingsymbol: "B", quantity: 75, price: 220 },
    { side: "BUY", tradingsymbol: "C", quantity: 75, price: 200 },
    { side: "SELL", tradingsymbol: "D", quantity: 75, price: 105 },
  ];
  const rt = calculateRoundTrip(entry, loadBoxChargeRates());
  assert.equal(rt.entry.source, "kite");
  assert.equal(rt.estimated_exit.source, "kite_estimate");
  assert.deepEqual(
    rt.estimated_exit.legs.map((l) => l.side),
    entry.map((e) => (e.side === "BUY" ? "SELL" : "BUY")),
  );
  // The exit's STT now falls on the legs that are SELLs in the reversed set.
  const rev = reverseOrders(entry);
  assert.deepEqual(rt.estimated_exit.legs.map((l) => l.side), rev.map((r) => r.side));
});

test("environment overrides feed straight through to the rate card", () => {
  const prev = process.env.BOX_STT_SELL_PCT;
  process.env.BOX_STT_SELL_PCT = "0.05";
  try {
    const calc = new LocalChargeCalculator(loadBoxChargeRates());
    const sell = calc.legs([{ side: "SELL", tradingsymbol: "X", quantity: 75, price: 300 }], "kite");
    // 0.05% of 22,500 = 11.25 → rounded to the nearest rupee = 11.
    assert.equal(sell.legs[0].stt, Math.round(22_500 * 0.0005));
  } finally {
    if (prev === undefined) delete process.env.BOX_STT_SELL_PCT;
    else process.env.BOX_STT_SELL_PCT = prev;
  }
});

test("totals() returns just entry and exit round-trip figures for the hot path", () => {
  const calc = new LocalChargeCalculator(loadBoxChargeRates());
  const orders = [
    { side: "BUY", tradingsymbol: "A", quantity: 75, price: 300 },
    { side: "SELL", tradingsymbol: "B", quantity: 75, price: 220 },
    { side: "BUY", tradingsymbol: "C", quantity: 75, price: 200 },
    { side: "SELL", tradingsymbol: "D", quantity: 75, price: 105 },
  ];
  const t = calc.totals(orders);
  const rt = calc.roundTrip(orders);
  assert.equal(t.entry, rt.entry_total);
  assert.equal(t.exit, rt.estimated_exit_total);
  assert.ok(t.entry > 0 && t.exit > 0);
});
