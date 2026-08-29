/**
 * Persistence shape: what a box document looks like on the wire, the quote
 * snapshots written to the append-only ledger, and the quote store that feeds
 * every decision.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { serializeBoxTrade, toEventLegs, tradeKey } from "../../dist/box/serialize.js";
import { BoxQuoteStore, SpotStore } from "../../dist/box/quotes.js";
import { configSnapshot, loadBoxConfig, prefilterGrossThreshold } from "../../dist/box/config.js";
import { evaluateCandidate } from "../../dist/box/math.js";
import { GOOD_BOX, LOT, goodCandidate, quotesFor } from "./helpers.mjs";

/** A closed box document as Mongo would hand it back. */
function doc(overrides = {}) {
  const { candidate } = goodCandidate();
  const opened = new Date("2026-08-29T04:20:00.000Z");
  const closed = new Date("2026-08-29T05:10:30.000Z");
  return {
    _id: { toString: () => "68b0f1c2a1b2c3d4e5f60001" },
    execution_mode: "paper_touch",
    underlying: "NIFTY",
    name: "NIFTY 50",
    is_index: true,
    expiry: candidate.expiry,
    lower_strike: GOOD_BOX.k1,
    upper_strike: GOOD_BOX.k2,
    lot_size: LOT,
    quantity: LOT,
    status: "closed",
    legs: [
      {
        role: "k1_ce",
        token: candidate.legs.k1_ce.token,
        tradingsymbol: candidate.legs.k1_ce.tradingsymbol,
        exchange: "NFO",
        strike: GOOD_BOX.k1,
        instrument_type: "CE",
        side: "BUY",
        entry_price: 300,
        entry_bid: 299,
        entry_bid_qty: 150,
        entry_ask: 300,
        entry_ask_qty: 150,
        entry_quote_at: opened,
        entry_depth: { bids: [{ price: 299, qty: 150, orders: 1 }], asks: [{ price: 300, qty: 150, orders: 1 }] },
        exit_price: 350,
        exit_bid: 350,
        exit_bid_qty: 150,
        exit_ask: 351,
        exit_ask_qty: 150,
        exit_quote_at: closed,
        exit_depth: { bids: [], asks: [] },
      },
    ],
    box_width: GOOD_BOX.width,
    entry_box_cost: GOOD_BOX.costPerUnit * LOT,
    entry_gross_edge: GOOD_BOX.grossEdge,
    entry_charges: null,
    estimated_exit_charges: null,
    safety_buffer: 150,
    entry_net_edge: 1425,
    opened_at: opened,
    current_remaining_edge: 150,
    exit_box_value: 198 * LOT,
    exit_charges: null,
    gross_pnl: 1725,
    total_charges: 300,
    net_pnl: 1425,
    closed_at: closed,
    exit_reason: "EDGE_CONVERGED",
    exit_blocked_reason: null,
    expiry_safety: false,
    scanner_config_snapshot: configSnapshot(loadBoxConfig()),
    error: null,
    ...overrides,
  };
}

/* -------------------------------------------------------------------- 28 --- */

test("28. a box document serializes to a stable API shape with ISO dates", () => {
  const s = serializeBoxTrade(doc());

  assert.equal(s.id, "68b0f1c2a1b2c3d4e5f60001");
  assert.equal(typeof s.id, "string");
  assert.equal(s.execution_mode, "paper_touch", "paper mode is always explicit");
  assert.equal(s.opened_at, "2026-08-29T04:20:00.000Z");
  assert.equal(s.closed_at, "2026-08-29T05:10:30.000Z");
  assert.equal(s.legs[0].entry_quote_at, "2026-08-29T04:20:00.000Z");
  assert.equal(s.legs[0].exit_quote_at, "2026-08-29T05:10:30.000Z");
  assert.equal(s.exit_reason, "EDGE_CONVERGED");
  assert.equal(s.net_pnl, 1425);
  assert.equal(s.quantity, LOT);
  assert.equal(s.lot_size, LOT);

  // The entry execution record survives on the closed document.
  assert.equal(s.legs[0].entry_price, 300);
  assert.equal(s.legs[0].entry_ask, 300);
  assert.equal(s.legs[0].entry_ask_qty, 150);
  assert.deepEqual(s.legs[0].entry_depth.asks, [{ price: 300, qty: 150, orders: 1 }]);
  assert.equal(s.legs[0].exit_price, 350);

  // The settings the trade was taken under are frozen onto it.
  assert.equal(s.scanner_config_snapshot.min_gross_edge, 1200);
  assert.equal(s.scanner_config_snapshot.min_net_edge, 0);
  assert.equal(s.scanner_config_snapshot.safety_buffer, 150);
  assert.equal(s.scanner_config_snapshot.strikes_each_side, 3);
  assert.equal(s.scanner_config_snapshot.execution_mode, "paper_touch");

  // No Mongo internals leak.
  assert.equal("_id" in s, false);
  assert.equal(JSON.parse(JSON.stringify(s)).id, s.id, "must be JSON round-trippable");
});

test("an open box serializes with null exit fields rather than placeholders", () => {
  const s = serializeBoxTrade(
    doc({
      status: "open",
      closed_at: null,
      exit_reason: null,
      exit_box_value: null,
      gross_pnl: null,
      total_charges: null,
      net_pnl: null,
    }),
  );
  assert.equal(s.status, "open");
  assert.equal(s.closed_at, null);
  assert.equal(s.net_pnl, null);
  assert.equal(s.gross_pnl, null);
  assert.equal(s.exit_reason, null);
});

test("the trade key identifies one box per underlying, expiry and strike pair", () => {
  assert.equal(
    tradeKey({ underlying: "NIFTY", expiry: "2026-09-24", lower_strike: 19900, upper_strike: 20100 }),
    "NIFTY|2026-09-24|19900|20100",
  );
  const { candidate } = goodCandidate();
  assert.equal(tradeKey({
    underlying: candidate.underlying,
    expiry: candidate.expiry,
    lower_strike: candidate.lower_strike,
    upper_strike: candidate.upper_strike,
  }), candidate.key);
});

test("ledger rows preserve the exact book each decision was taken on", () => {
  const { candidate } = goodCandidate();
  const now = 1_000_000;
  const ev = evaluateCandidate({
    candidate,
    quotes: quotesFor(candidate, {}, { at: now - 200 }),
    now,
    maxAgeMs: 1500,
  });
  const legs = toEventLegs(ev.legs);

  assert.equal(legs.length, 4);
  assert.deepEqual(legs.map((l) => l.role), ["k1_ce", "k2_ce", "k2_pe", "k1_pe"]);
  assert.deepEqual(legs.map((l) => l.side), ["BUY", "SELL", "BUY", "SELL"]);
  for (const l of legs) {
    assert.ok(l.quote_at instanceof Date, "the receive time is preserved as a Date");
    assert.equal(l.age_ms, 200);
    assert.ok(l.bid > 0 && l.ask > 0, "both sides of the book are recorded");
    assert.ok(l.bid_qty > 0 && l.ask_qty > 0);
  }
  // The prices recorded are the executable ones, per side.
  assert.equal(legs[0].price, 300); // BUY  → ask
  assert.equal(legs[1].price, 220); // SELL → bid
});

/* ---------------------------- config + quotes ----------------------------- */

test("the shipped configuration is the documented V1 specification", () => {
  const c = loadBoxConfig();
  // The entry gate is ₹1,200 from the SPREAD; fees are reported, not gated.
  assert.equal(c.minGrossEdge, 1200);
  assert.equal(c.minNetEdge, 0);
  assert.equal(c.safetyBuffer, 150);
  assert.equal(c.quoteMaxAgeMs, 1500);
  assert.equal(c.strikesEachSide, 3);
  assert.equal(c.convergenceFloor, 200);
  assert.equal(c.convergencePct, 0.2);
  assert.equal(c.minExitNetPnl, 600);
  assert.equal(c.profitCapturePct, 0.75);
  assert.equal(prefilterGrossThreshold(c), 1200);
  assert.equal(configSnapshot(c).execution_mode, "paper_touch");
  assert.equal(configSnapshot(c).min_gross_edge, 1200);
});

test("the quote store stamps books with their receive time and ages them out", () => {
  const store = new BoxQuoteStore();
  const tick = {
    token: 42,
    last_price: 101,
    bid: 100,
    ask: 102,
    bids: [{ price: 100, qty: 75, orders: 1 }],
    asks: [{ price: 102, qty: 75, orders: 1 }],
  };
  const changed = store.applyTicks([tick], 5_000);
  assert.deepEqual(changed, [42]);
  const q = store.get(42);
  assert.equal(q.at, 5_000);
  assert.equal(q.bid, 100);
  assert.equal(q.ask_qty, 75);
  assert.equal(q.source, "ws");
  assert.equal(store.isFresh(42, 1500, 6_000), true);
  assert.equal(store.isFresh(42, 1500, 6_600), false);
  assert.equal(store.isFresh(43, 1500, 5_000), false);
});

test("a depthless tick must not refresh a good book's timestamp", () => {
  const store = new BoxQuoteStore();
  store.applyTicks(
    [{ token: 7, last_price: 10, bid: 9, ask: 11, bids: [{ price: 9, qty: 75, orders: 1 }], asks: [{ price: 11, qty: 75, orders: 1 }] }],
    1_000,
  );
  // A packet with no depth arrives later: the executable touch has not changed,
  // so the book must keep ageing rather than appear freshly confirmed.
  const changed = store.applyTicks([{ token: 7, last_price: 10.5, bid: 0, ask: 0 }], 9_000);
  assert.deepEqual(changed, []);
  assert.equal(store.get(7).at, 1_000);
  assert.equal(store.isFresh(7, 1500, 9_000), false);
});

test("a REST ladder seeds a book that is treated as fresh at fetch time", () => {
  const store = new BoxQuoteStore();
  store.applyLadder(11, { last: 50, bids: [{ price: 49, qty: 100 }], asks: [{ price: 51, qty: 100 }] }, 2_000);
  const q = store.get(11);
  assert.equal(q.source, "rest");
  assert.equal(q.bid, 49);
  assert.equal(q.ask_qty, 100);
  assert.equal(store.isFresh(11, 1500, 3_000), true);

  store.forget([11]);
  assert.equal(store.get(11), undefined);
});

test("the spot store tracks the underlying value used to place the ATM window", () => {
  const spots = new SpotStore();
  spots.set(1, 20_050, 1_000);
  assert.deepEqual(spots.get(1), { value: 20_050, at: 1_000 });
  assert.equal(spots.isFresh(1, 10_000, 5_000), true);
  assert.equal(spots.isFresh(1, 10_000, 20_000), false);
  spots.set(1, 0, 2_000); // a zero print is ignored
  assert.equal(spots.get(1).value, 20_050);
});
