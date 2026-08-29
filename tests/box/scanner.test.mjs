/**
 * The scanner: the dependency index, duplicate protection, the charge-validation
 * gate, revalidation after the async charge call, and RUN/STOP semantics.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxScanner } from "../../dist/box/scanner.js";
import { BoxChargeEstimator } from "../../dist/box/charges.js";
import { BoxPositionBook } from "../../dist/box/positions.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { GOOD_BOX, LOT, cfg, chargeStub, goodCandidate, quotesFor } from "./helpers.mjs";

/** A scanner wired to fakes, with the qualifying 7-strike window loaded. */
function harness({ entryTotal = 150, exitTotal = 150, fail = false, config = {} } = {}) {
  const { candidate, all } = goodCandidate();
  const conf = cfg(config);
  const quotes = new BoxQuoteStore();
  const positions = new BoxPositionBook();
  const stub = chargeStub({ entryTotal, exitTotal, fail });
  const charges = new BoxChargeEstimator(stub.fn, conf);

  const opened = [];
  const events = [];
  const scanner = new BoxScanner({
    cfg: conf,
    quotes,
    charges,
    positions,
    openPaperTrade: async (args) => {
      opened.push(args);
      // Mirror what the engine does: the position joins the live book, which is
      // what makes the strike pair unavailable to any later tick.
      positions.add({
        id: `box${opened.length}`,
        key: args.candidate.key,
        underlying: args.candidate.underlying,
        expiry: args.candidate.expiry,
        lower_strike: args.candidate.lower_strike,
        upper_strike: args.candidate.upper_strike,
        legs: args.candidate.legs,
        lot_size: args.candidate.lot_size,
        quantity: args.candidate.lot_size,
      });
      return `box${opened.length}`;
    },
    onEvent: (event, cand, evaluation, detail) => {
      events.push({ event, key: cand.key, reject: evaluation.reject, detail });
    },
  });
  scanner.setCandidatesForUnderlying("NIFTY", all);

  /** Publish a full set of fresh, qualifying quotes for the good box. */
  const seedGood = (overrides = {}) => {
    const now = Date.now();
    const map = quotesFor(candidate, overrides, { at: now });
    for (const [token, q] of map) {
      quotes.applyTicks(
        [{ token, last_price: q.last, bid: q.bid, ask: q.ask, bids: q.bids, asks: q.asks }],
        now,
      );
    }
    return [...map.keys()];
  };

  return { scanner, candidate, all, quotes, positions, charges, stub, opened, events, seedGood, conf };
}

/** Let the scanner's async entry pipeline settle. */
const settle = () => new Promise((r) => setTimeout(r, 5));

/* -------------------------------------------------------------------- 20 --- */

test("20. a tick only recalculates the candidates that reference that token", async () => {
  const h = harness();
  h.seedGood();
  h.scanner.setDiscovering(false); // measure evaluation work only

  const before = h.scanner.getStats().evaluations;
  // The CE at 20000 is a leg of exactly 6 of the 21 pairs (it can be K1 or K2
  // against each of the other six strikes).
  const ceAt20000 = h.all.find((c) => c.upper_strike === 20000).legs.k2_ce.token;
  h.scanner.onTokensUpdated([ceAt20000]);
  assert.equal(h.scanner.getStats().evaluations - before, 6);

  // A token nothing references costs nothing at all.
  const idle = h.scanner.getStats().evaluations;
  h.scanner.onTokensUpdated([999_999]);
  assert.equal(h.scanner.getStats().evaluations, idle);

  // A batch touching several legs of the same box evaluates that box once.
  const cand = h.candidate;
  const mid = h.scanner.getStats().evaluations;
  h.scanner.onTokensUpdated([cand.legs.k1_ce.token, cand.legs.k2_ce.token]);
  const affected = h.scanner.getStats().evaluations - mid;
  assert.ok(affected < 12, `batched work must be de-duplicated, got ${affected}`);
  assert.equal(affected, 11); // 6 + 6 pairs, sharing the pair (19900, 20100)

  // Re-centring the window replaces the index rather than leaking old entries.
  h.scanner.setCandidatesForUnderlying("NIFTY", []);
  const cleared = h.scanner.getStats().evaluations;
  h.scanner.onTokensUpdated([ceAt20000]);
  assert.equal(h.scanner.getStats().evaluations, cleared);
  assert.equal(h.scanner.candidateCount, 0);
});

/* -------------------------------------------------------------------- 19 --- */

test("19. only one paper box can ever be open on the same strike pair", async () => {
  const h = harness();
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);

  // Two ticks in the SAME turn of the event loop, before any await resolves.
  h.scanner.onTokensUpdated(tokens);
  h.scanner.onTokensUpdated(tokens);
  await settle();

  const forGoodBox = h.opened.filter((o) => o.candidate.key === h.candidate.key);
  assert.equal(forGoodBox.length, 1, "a rapid second tick must not open a duplicate");

  // And every later tick sees the pair as taken.
  h.scanner.onTokensUpdated(tokens);
  await settle();
  assert.equal(h.opened.filter((o) => o.candidate.key === h.candidate.key).length, 1);

  // The reservation is what makes it atomic, independent of any I/O.
  const book = new BoxPositionBook();
  assert.equal(book.reserve("NIFTY|2026-09-24|19900|20100"), true);
  assert.equal(book.reserve("NIFTY|2026-09-24|19900|20100"), false);
  book.release("NIFTY|2026-09-24|19900|20100");
  assert.equal(book.reserve("NIFTY|2026-09-24|19900|20100"), true);
});

test("a box that fails Mongo's unique index releases its reservation", async () => {
  const { candidate, all } = goodCandidate();
  const conf = cfg();
  const quotes = new BoxQuoteStore();
  const positions = new BoxPositionBook();
  const stub = chargeStub({});
  const scanner = new BoxScanner({
    cfg: conf,
    quotes,
    charges: new BoxChargeEstimator(stub.fn, conf),
    positions,
    // Simulates the duplicate-key path: the insert was refused.
    openPaperTrade: async () => null,
    onEvent: () => {},
  });
  scanner.setCandidatesForUnderlying("NIFTY", all);
  scanner.setDiscovering(true);
  const now = Date.now();
  for (const [token, q] of quotesFor(candidate, {}, { at: now })) {
    quotes.applyTicks([{ token, last_price: 0, bid: q.bid, ask: q.ask, bids: q.bids, asks: q.asks }], now);
  }
  scanner.onTokensUpdated([candidate.legs.k1_ce.token]);
  await settle();
  assert.equal(positions.isTaken(candidate.key), false, "a refused insert must not leak a claim");
});

/* -------------------------------- fees gate ------------------------------- */

test("a box whose charges cannot be priced is shown UNPRICED and never auto-traded", async () => {
  const h = harness({ fail: true });
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);
  await settle();

  assert.equal(h.opened.length, 0, "no charges means no automatic entry");
  const opp = h.scanner.listOpportunities(50).find((o) => o.key === h.candidate.key);
  assert.equal(opp.status, "UNPRICED");
  assert.equal(opp.gross_edge, GOOD_BOX.grossEdge);
  assert.equal(opp.projected_net_edge, null);
  assert.ok(h.events.some((e) => e.event === "ENTRY_REJECTED_FEES"));
});

test("charges are only requested for boxes that clear the gross prefilter", async () => {
  const h = harness();
  // A box priced so its gross edge is far below ₹1,200 + safety + charges.
  const tokens = h.seedGood({ k1_ce: { ask: 320 } }); // cost 195 → gross ₹375
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);
  await settle();

  assert.equal(h.stub.calls.length, 0, "the slow charge call must not be reached");
  assert.equal(h.opened.length, 0);
  assert.equal(h.scanner.getStats().chargeAttempts, 0);
});

test("charges are requested once and then served from cache", async () => {
  const h = harness();
  const tokens = h.seedGood();
  h.scanner.setDiscovering(false); // evaluate + publish without entering
  h.scanner.onTokensUpdated(tokens);
  await settle();
  assert.equal(h.stub.calls.length, 0, "discovery off: nothing is priced");

  // With discovery on, the eight order lines go out in ONE request.
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);
  await settle();
  assert.equal(h.stub.calls.length, 1);
  const groups = h.stub.calls[0];
  assert.equal(groups.length, 2, "entry group + projected exit group");
  assert.equal(groups[0].legs.length, 4);
  assert.equal(groups[1].legs.length, 4);
  assert.equal(groups[0].source, "kite");
  assert.equal(groups[1].source, "kite_estimate");
  // The exit group is the entry legs with both sides reversed.
  assert.deepEqual(
    groups[1].legs.map((l) => l.side),
    groups[0].legs.map((l) => (l.side === "BUY" ? "SELL" : "BUY")),
  );
  // Every order is exactly one lot.
  for (const g of groups) for (const l of g.legs) assert.equal(l.quantity, LOT);
});

test("the ₹1,200 rule is applied to the REVALIDATED book, not the first snapshot", async () => {
  // Charges are ₹600 a side, so the ₹1,875 gross box nets 1875-600-600-150 = ₹525.
  const h = harness({ entryTotal: 600, exitTotal: 600 });
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);
  await settle();
  assert.equal(h.stub.calls.length, 1, "it was worth pricing…");
  assert.equal(h.opened.length, 0, "…but ₹525 net does not qualify");
});

test("the book is re-checked after the charge call, and a decayed book is refused", async () => {
  const { candidate, all } = goodCandidate();
  const conf = cfg();
  const quotes = new BoxQuoteStore();
  const positions = new BoxPositionBook();

  // While the (async) charge call is in flight, the ask jumps: the box that comes
  // back from revalidation is no longer worth ₹1,200 net.
  const stub = chargeStub({
    onCall: () => {
      const now = Date.now();
      const t = candidate.legs.k1_ce.token;
      quotes.applyTicks(
        [{ token: t, last_price: 0, bid: 299, ask: 340, bids: [{ price: 299, qty: 150, orders: 1 }], asks: [{ price: 340, qty: 150, orders: 1 }] }],
        now,
      );
    },
  });
  const opened = [];
  const scanner = new BoxScanner({
    cfg: conf,
    quotes,
    charges: new BoxChargeEstimator(stub.fn, conf),
    positions,
    openPaperTrade: async (a) => {
      opened.push(a);
      return "box1";
    },
    onEvent: () => {},
  });
  scanner.setCandidatesForUnderlying("NIFTY", all);
  scanner.setDiscovering(true);

  const now = Date.now();
  for (const [token, q] of quotesFor(candidate, {}, { at: now })) {
    quotes.applyTicks([{ token, last_price: 0, bid: q.bid, ask: q.ask, bids: q.bids, asks: q.asks }], now);
  }
  scanner.onTokensUpdated([candidate.legs.k1_ce.token]);
  await settle();

  assert.equal(stub.calls.length, 1, "the opportunity was priced");
  assert.equal(opened.length, 0, "but the trade was refused on the re-checked book");
  assert.equal(positions.isTaken(candidate.key), false);
});

test("the paper fills recorded are the REVALIDATED touch prices", async () => {
  const h = harness();
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);
  await settle();

  assert.equal(h.opened.length, 1);
  const { evaluation, netEdge, entryChargesTotal, estimatedExitChargesTotal } = h.opened[0];
  const byRole = new Map(evaluation.legs.map((l) => [l.role, l]));
  assert.equal(byRole.get("k1_ce").price, 300); // ask
  assert.equal(byRole.get("k2_ce").price, 220); // bid
  assert.equal(byRole.get("k2_pe").price, 200); // ask
  assert.equal(byRole.get("k1_pe").price, 105); // bid
  assert.equal(evaluation.gross_edge, GOOD_BOX.grossEdge);
  assert.equal(entryChargesTotal, 150);
  assert.equal(estimatedExitChargesTotal, 150);
  assert.equal(netEdge, 1875 - 150 - 150 - 150);
  assert.ok(netEdge >= 1200);
});

/* -------------------------------------------------------------------- 29 --- */

test("29. with the scanner STOPPED no new paper box is ever opened", async () => {
  const h = harness();
  const tokens = h.seedGood();

  h.scanner.setDiscovering(false);
  for (let i = 0; i < 5; i++) {
    h.scanner.onTokensUpdated(tokens);
    await settle();
  }
  assert.equal(h.opened.length, 0, "STOP must block every entry");
  assert.equal(h.stub.calls.length, 0, "and must not even price candidates");
  assert.equal(h.scanner.isDiscovering(), false);
  // Evaluation still happens, so the UI keeps showing what the market looks like.
  assert.ok(h.scanner.getStats().evaluations > 0);

  // Pressing RUN starts entering immediately.
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);
  await settle();
  assert.equal(h.opened.length, 1);

  // And STOP again halts further discovery while the position stays in the book.
  h.scanner.setDiscovering(false);
  assert.equal(h.positions.size, 1);
  h.scanner.onTokensUpdated(tokens);
  await settle();
  assert.equal(h.opened.length, 1);
  assert.equal(h.positions.size, 1, "STOP never drops an open position");
});

/* ----------------------------- published view ----------------------------- */

test("the opportunity list surfaces real edges rather than every F&O box", async () => {
  const h = harness();
  h.seedGood();
  h.scanner.setDiscovering(false);
  h.scanner.refreshAll();

  const rows = h.scanner.listOpportunities(100);
  // 21 candidates exist, but only boxes with a positive executable edge are shown.
  assert.ok(rows.length >= 1);
  assert.ok(rows.length < 21, `expected a filtered list, got ${rows.length}`);
  for (const r of rows) assert.ok(r.gross_edge > 0, "a negative-edge box is not an opportunity");
  // Sorted best-first.
  const edges = rows.map((r) => r.projected_net_edge ?? r.gross_edge);
  assert.deepEqual(edges, [...edges].sort((a, b) => b - a));

  const best = rows[0];
  assert.equal(best.key, h.candidate.key);
  assert.equal(best.quantity, LOT);
  assert.equal(best.lot_size, LOT);
  assert.equal(best.safety_buffer, 150);
  assert.equal(best.box_width, GOOD_BOX.width);
  assert.equal(best.entry_box_cost, GOOD_BOX.costPerUnit * LOT);
  assert.equal(best.liquidity_ok, true);
});

test("a box already open is published as OPEN", async () => {
  const h = harness();
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);
  await settle();
  h.scanner.onTokensUpdated(tokens);
  const opp = h.scanner.listOpportunities(50).find((o) => o.key === h.candidate.key);
  assert.equal(opp.status, "OPEN");
});
