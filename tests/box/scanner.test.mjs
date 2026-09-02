/**
 * The scanner: the dependency index, duplicate protection, the LOCAL net-profit
 * qualification, the execution-simulation pipeline, and RUN/STOP semantics.
 *
 * The scanner no longer waits on Zerodha for charges — the local calculator
 * prices the decision synchronously, and the execution simulator produces the
 * fill from post-latency WebSocket books.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxScanner } from "../../dist/box/scanner.js";
import { BoxChargeEstimator } from "../../dist/box/charges.js";
import { BoxExecutionSimulator } from "../../dist/box/executionSimulator.js";
import { BoxMetrics } from "../../dist/box/metrics.js";
import { BoxPositionBook } from "../../dist/box/positions.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import {
  GOOD_BOX,
  LOT,
  cfg,
  chargeStub,
  goodCandidate,
  localChargesStub,
  quotesFor,
} from "./helpers.mjs";

/** A scanner wired to fakes, with the qualifying 7-strike window loaded. */
function harness({
  entryTotal = 150,
  exitTotal = 150,
  config = {},
  marketOpen = true,
  feedHealthy = true,
} = {}) {
  const { candidate, all } = goodCandidate();
  const conf = cfg(config);
  const quotes = new BoxQuoteStore();
  const positions = new BoxPositionBook();
  const localCharges = localChargesStub({ entryTotal, exitTotal });

  let feedOk = feedHealthy;
  let mktOpen = marketOpen;
  let scanner;
  const metrics = new BoxMetrics(conf.metricsWindow);
  const executionSim = new BoxExecutionSimulator({
    cfg: conf,
    quotes,
    isMarketOpen: () => mktOpen,
    isFeedHealthy: () => feedOk,
    metrics,
  });
  const charges = new BoxChargeEstimator(chargeStub({ entryTotal, exitTotal }).fn, conf);

  const opened = [];
  const events = [];
  scanner = new BoxScanner({
    cfg: conf,
    quotes,
    charges,
    localCharges,
    executionSim,
    positions,
    metrics,
    openPaperTrade: async (args) => {
      opened.push(args);
      positions.add({
        id: `box${opened.length}`,
        key: args.candidate.key,
        underlying: args.candidate.underlying,
        expiry: args.candidate.expiry,
        direction: args.candidate.direction,
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
  scanner.setMarketOpen(mktOpen);
  scanner.setFeedHealthy(feedOk);

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

  return {
    scanner,
    candidate,
    all,
    quotes,
    positions,
    charges,
    localCharges,
    metrics,
    opened,
    events,
    seedGood,
    conf,
    setFeed: (v) => {
      feedOk = v;
      scanner.setFeedHealthy(v);
    },
    setMarket: (v) => {
      mktOpen = v;
      scanner.setMarketOpen(v);
    },
  };
}

/** Let the scanner's async entry pipeline settle. */
const settle = () => new Promise((r) => setTimeout(r, 15));

/* -------------------------------------------------------------------- 20 --- */

test("20. a tick only recalculates the candidates that reference that token", async () => {
  const h = harness();
  h.seedGood();
  h.scanner.setDiscovering(false);

  const before = h.scanner.getStats().evaluations;
  const ceAt20000 = h.all.find((c) => c.upper_strike === 20000).legs.k2_ce.token;
  h.scanner.onTokensUpdated([ceAt20000]);
  assert.equal(h.scanner.getStats().evaluations - before, 6);

  const idle = h.scanner.getStats().evaluations;
  h.scanner.onTokensUpdated([999_999]);
  assert.equal(h.scanner.getStats().evaluations, idle);

  const cand = h.candidate;
  const mid = h.scanner.getStats().evaluations;
  h.scanner.onTokensUpdated([cand.legs.k1_ce.token, cand.legs.k2_ce.token]);
  const affected = h.scanner.getStats().evaluations - mid;
  assert.equal(affected, 11); // 6 + 6 pairs, sharing the pair (19900, 20100)

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

  h.scanner.onTokensUpdated(tokens);
  h.scanner.onTokensUpdated(tokens);
  await settle();

  const forGoodBox = h.opened.filter((o) => o.candidate.key === h.candidate.key);
  assert.equal(forGoodBox.length, 1, "a rapid second tick must not open a duplicate");

  h.scanner.onTokensUpdated(tokens);
  await settle();
  assert.equal(h.opened.filter((o) => o.candidate.key === h.candidate.key).length, 1);

  const book = new BoxPositionBook();
  const key = "NIFTY|2026-09-24|19900|20100|LONG_BOX";
  assert.equal(book.reserve(key), true);
  assert.equal(book.reserve(key), false);
  book.release(key);
  assert.equal(book.reserve(key), true);
});

test("a box that fails Mongo's unique index releases its reservation", async () => {
  const { candidate, all } = goodCandidate();
  const conf = cfg();
  const quotes = new BoxQuoteStore();
  const positions = new BoxPositionBook();
  const executionSim = new BoxExecutionSimulator({
    cfg: conf,
    quotes,
    isMarketOpen: () => true,
    isFeedHealthy: () => true,
  });
  const scanner = new BoxScanner({
    cfg: conf,
    quotes,
    charges: new BoxChargeEstimator(chargeStub({}).fn, conf),
    localCharges: localChargesStub(),
    executionSim,
    positions,
    openPaperTrade: async () => null, // the insert was refused
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

/* ------------------------------ entry gate -------------------------------- */

test("a qualifying box is entered via the execution simulator", async () => {
  const h = harness();
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);
  await settle();

  assert.equal(h.opened.length, 1);
  const o = h.opened[0];
  assert.equal(o.candidate.key, h.candidate.key);
  assert.equal(o.entryChargesTotal, 150);
  assert.equal(o.estimatedExitChargesTotal, 150);
  assert.equal(o.chargeOrigin, "local");
  // The final qualification is expected NET profit on the executed snapshot.
  assert.equal(o.decision.expected_net_profit, 1875 - 150 - 150 - 150);
  assert.ok(o.decision.qualifies);
  // A fill record is attached, with zero slippage in the touch model.
  assert.equal(o.execution.filled, true);
  assert.equal(o.execution.total_slippage, 0);
});

test("gross high but expected NET profit below ₹1,200 → reject", async () => {
  // Charges of ₹450 a side: 1875 - 450 - 450 - 150 buffer = ₹825 net < ₹1,200.
  const h = harness({ entryTotal: 450, exitTotal: 450 });
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);
  await settle();

  assert.equal(h.opened.length, 0, "expected net below the gate must not enter");
  assert.ok(h.scanner.getStats().rejectedNetProfit >= 1);
});

test("gross high AND expected net above the gate → eligible and entered", async () => {
  // ₹1,875 gross, ₹150 a side charges, ₹150 buffer → ₹1,425 net ≥ ₹1,200.
  const h = harness({ entryTotal: 150, exitTotal: 150 });
  const tokens = h.seedGood();
  h.scanner.setDiscovering(false);
  h.scanner.refreshAll();
  const opp = h.scanner.listOpportunities(50).find((o) => o.key === h.candidate.key);
  assert.equal(opp.status, "ELIGIBLE");
  assert.equal(opp.expected_net_profit, 1425);
  assert.equal(opp.min_expected_net_profit, 1200);

  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);
  await settle();
  assert.equal(h.opened.length, 1);
});

test("the published opportunity breaks the arithmetic out, hiding nothing", async () => {
  const h = harness({ entryTotal: 150, exitTotal: 160 });
  h.seedGood();
  h.scanner.setDiscovering(false);
  h.scanner.refreshAll();
  const opp = h.scanner.listOpportunities(50).find((o) => o.key === h.candidate.key);
  assert.equal(opp.gross_edge, 1875);
  assert.equal(opp.entry_charges, 150);
  assert.equal(opp.estimated_exit_charges, 160);
  assert.equal(opp.safety_buffer, 150);
  assert.equal(opp.execution_cost, 0); // touch model, no slippage allowance in test cfg
  assert.equal(opp.expected_net_profit, 1875 - 150 - 160 - 150);
  assert.equal(opp.charge_origin, "local");
  // Direction and the four entry sides are unambiguous.
  assert.equal(opp.direction, "LONG_BOX");
  const sides = new Map(opp.entry_sides.map((s) => [s.role, s.side]));
  assert.deepEqual([sides.get("k1_ce"), sides.get("k2_ce"), sides.get("k2_pe"), sides.get("k1_pe")], ["BUY", "SELL", "BUY", "SELL"]);
});

test("a spread under the gross prefilter never reaches qualification", async () => {
  const h = harness();
  const tokens = h.seedGood({ k1_ce: { ask: 320 } }); // cost 195 → gross ₹375
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);
  await settle();
  assert.equal(h.opened.length, 0);
  assert.equal(h.scanner.getStats().executionsAttempted, 0);
});

/* --------------------------- market / feed gates -------------------------- */

test("market CLOSED: no entry, whatever the numbers look like", async () => {
  const h = harness();
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);
  h.setMarket(false);

  for (let i = 0; i < 3; i++) {
    h.scanner.onTokensUpdated(tokens);
    await settle();
  }
  assert.equal(h.opened.length, 0, "a paper fill needs a live executable book");

  h.setMarket(true);
  h.scanner.onTokensUpdated(tokens);
  await settle();
  assert.equal(h.opened.length, 1);
});

test("a feed that goes unhealthy blocks entry", async () => {
  const h = harness();
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);
  h.setFeed(false);
  h.scanner.onTokensUpdated(tokens);
  await settle();
  assert.equal(h.opened.length, 0);

  h.setFeed(true);
  h.scanner.onTokensUpdated(tokens);
  await settle();
  assert.equal(h.opened.length, 1);
});

test("the last-close view is published as INDICATIVE and cannot be entered", async () => {
  const h = harness();
  h.scanner.setDiscovering(true);
  h.setMarket(false);

  const lastPrices = new Map();
  const ce = (strike) => 300 - (strike - GOOD_BOX.k1) * 0.4;
  const pe = (strike) => 105 + (strike - GOOD_BOX.k1) * 0.475;
  for (const cand of h.all) {
    for (const role of ["k1_ce", "k2_ce", "k2_pe", "k1_pe"]) {
      const leg = cand.legs[role];
      const price = leg.instrument_type === "CE" ? ce(leg.strike) : pe(leg.strike);
      lastPrices.set(leg.token, price);
    }
  }
  const priced = h.scanner.publishIndicative(lastPrices);
  await settle();

  assert.ok(priced > 0);
  assert.equal(h.opened.length, 0);
  const rows = h.scanner.listOpportunities(100);
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.equal(r.status, "INDICATIVE");
    assert.equal(r.price_source, "last_close");
    assert.equal(r.liquidity_ok, false);
  }
  const best = rows.find((r) => r.key === h.candidate.key);
  assert.ok(best);
  assert.equal(best.gross_edge, GOOD_BOX.grossEdge);
});

/* ------------------------- execution simulation --------------------------- */

test("an adverse post-latency move that removes the net edge is not filled", async () => {
  // paper_latency: an adverse move lands DURING the latency window, so it is the
  // current book at arrival and the box no longer nets ₹1,200 — refuse to fill.
  const h = harness({
    config: { executionMode: "paper_latency", simulatedDecisionMs: 0, simulatedLatencyMs: 60, executionMaxWaitMs: 200, executionPollMs: 5 },
  });
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);

  // Overwrite K1 CE with a much worse ask straight away (well before the 60ms
  // arrival), so the latest book at arrival is the adverse one.
  const at = Date.now();
  const worse = quotesFor(h.candidate, { k1_ce: { ask: 360, askQty: 150 } }, { at });
  for (const [token, q] of worse) {
    h.quotes.applyTicks([{ token, last_price: q.last, bid: q.bid, ask: q.ask, bids: q.bids, asks: q.asks }], at);
  }

  await new Promise((r) => setTimeout(r, 220));
  assert.equal(h.opened.length, 0, "the box stopped being worth ₹1,200 net by arrival");
  assert.equal(h.positions.isTaken(h.candidate.key), false, "the reservation is released");
});

test("a favourable/flat post-latency book fills and records the slippage", async () => {
  const h = harness({
    config: { executionMode: "paper_latency", simulatedDecisionMs: 0, simulatedLatencyMs: 10, executionMaxWaitMs: 200, executionPollMs: 5 },
  });
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);

  // No further ticks: the resting book from detection is still valid at arrival
  // (Task 2 — a quiet book does not need a fresh post-arrival tick) and fills.
  await new Promise((r) => setTimeout(r, 220));
  assert.equal(h.opened.length, 1);
  const o = h.opened[0];
  assert.equal(o.execution.mode, "paper_latency");
  assert.equal(o.execution.filled, true);
  assert.equal(o.execution.total_slippage, 0);
  assert.ok(o.execution.decision_to_fill_ms >= 10, "the simulated latency is recorded");
});

test("a resting book that is STALE by arrival is not filled", async () => {
  // Trust window (30ms) shorter than the latency (60ms): the resting detection
  // book has aged past the trust limit by the time the order arrives → reject.
  const h = harness({
    config: { executionMode: "paper_latency", simulatedDecisionMs: 0, simulatedLatencyMs: 60, executionMaxWaitMs: 100, executionPollMs: 5, quoteMaxAgeMs: 30 },
  });
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);
  await new Promise((r) => setTimeout(r, 160));
  assert.equal(h.opened.length, 0, "a book stale by arrival is never faked into a fill");
  assert.equal(h.positions.isTaken(h.candidate.key), false);
});

test("a duplicate execution pipeline for the same candidate is prevented", async () => {
  const h = harness({
    config: { executionMode: "paper_latency", simulatedDecisionMs: 0, simulatedLatencyMs: 30, executionMaxWaitMs: 200, executionPollMs: 5 },
  });
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);
  // Two ticks in the same turn: the reservation + in-flight guard admit one pipeline.
  h.scanner.onTokensUpdated(tokens);
  h.scanner.onTokensUpdated(tokens);
  assert.ok(h.scanner.getStats().executionsAttempted <= 1, "only one pipeline may start");

  setTimeout(() => {
    const at = Date.now();
    for (const [token, q] of quotesFor(h.candidate, {}, { at })) {
      h.quotes.applyTicks([{ token, last_price: q.last, bid: q.bid, ask: q.ask, bids: q.bids, asks: q.asks }], at);
    }
  }, 45);
  await new Promise((r) => setTimeout(r, 320));
  assert.equal(h.opened.filter((o) => o.candidate.key === h.candidate.key).length, 1);
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
  assert.equal(h.scanner.getStats().executionsAttempted, 0);
  assert.ok(h.scanner.getStats().evaluations > 0);

  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);
  await settle();
  assert.equal(h.opened.length, 1);

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
  assert.ok(rows.length >= 1);
  assert.ok(rows.length < 21, `expected a filtered list, got ${rows.length}`);
  for (const r of rows) assert.ok(r.gross_edge > 0, "a negative-edge box is not an opportunity");
  const edges = rows.map((r) => r.expected_net_profit ?? r.gross_edge);
  assert.deepEqual(edges, [...edges].sort((a, b) => b - a));

  const best = rows[0];
  assert.equal(best.key, h.candidate.key);
  assert.equal(best.quantity, LOT);
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


/* --------------------- logical-attempt execution metrics ------------------ */

test("a successful open counts exactly ONE logical attempt with attempted === completed", async () => {
  const h = harness();
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);
  await settle();

  assert.equal(h.opened.length, 1);
  const snap = h.metrics.snapshot();
  assert.equal(snap.execution.attempted, 1);
  assert.equal(snap.execution.completed, 1, "an immediate atomic fill is its own terminal state");
  assert.equal(snap.execution.successful, 1);
  assert.equal(snap.execution.failed, 0);
  assert.equal(snap.execution.partial_recovered, 0);
  assert.equal(snap.execution.partial_unresolved, 0);
  assert.equal(snap.execution.aborted, 0);
  assert.equal(
    snap.execution.completed,
    snap.execution.successful +
      snap.execution.failed +
      snap.execution.partial_recovered +
      snap.execution.partial_unresolved +
      snap.execution.aborted,
    "completed must equal the sum of every mutually exclusive terminal outcome",
  );
  assert.equal(snap.execution.success_rate, 1);
  assert.equal(snap.execution.failure_rate, 0);
});

test("a rejected entry counts one logical attempt with a FAILED terminal state, never inflating attempted beyond completed", async () => {
  // The pipeline is dispatched (it clears the LOCAL pre-check), but an adverse
  // move DURING the simulated latency removes the net edge by arrival, so the
  // execution snapshot itself refuses the fill — this must still register as one
  // resolved parent attempt, not a silent pre-dispatch skip.
  const h = harness({
    config: { executionMode: "paper_latency", simulatedDecisionMs: 0, simulatedLatencyMs: 60, executionMaxWaitMs: 200, executionPollMs: 5 },
  });
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);

  const at = Date.now();
  const worse = quotesFor(h.candidate, { k1_ce: { ask: 360, askQty: 150 } }, { at });
  for (const [token, q] of worse) {
    h.quotes.applyTicks([{ token, last_price: q.last, bid: q.bid, ask: q.ask, bids: q.bids, asks: q.asks }], at);
  }
  await new Promise((r) => setTimeout(r, 220));

  assert.equal(h.opened.length, 0);
  const snap = h.metrics.snapshot();
  assert.equal(snap.execution.attempted, 1);
  assert.equal(snap.execution.completed, 1);
  assert.equal(snap.execution.failed, 1);
  assert.equal(snap.execution.successful, 0);
  assert.ok(snap.execution.attempted >= snap.execution.completed);
  assert.ok(
    "below_expected_net_profit" in snap.execution.rejection_categories ||
      "edge_disappeared" in snap.execution.rejection_categories,
  );
});

test("candidates that never clear prefilter/qualification do not create a logical attempt", async () => {
  const h = harness();
  const tokens = h.seedGood({ k1_ce: { ask: 320 } }); // well under the gross prefilter
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);
  await settle();

  const snap = h.metrics.snapshot();
  assert.equal(snap.execution.attempted, 0, "a pre-dispatch reject is not a strategy attempt");
  assert.equal(snap.execution.completed, 0);
});

test("retries recorded on the metrics object never change the attempted denominator", async () => {
  const h = harness();
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);

  // Simulate internal leg-level retries that happen inside one logical attempt.
  h.metrics.recordLogicalRetry();
  h.metrics.recordLogicalRetry();
  h.metrics.recordLogicalRetry();

  h.scanner.onTokensUpdated(tokens);
  await settle();

  const snap = h.metrics.snapshot();
  assert.equal(snap.execution.attempted, 1, "retries must never inflate the parent attempt count");
  assert.equal(snap.execution.retries, 3);
});


/* --------------- paper_latency: deterioration / slippage scenarios -------- */

/**
 * Deterioration vs. arrival-book execution slippage are DIFFERENT numbers:
 *
 *   decision deterioration = detection expected net − realised expected net
 *     (a strategy/latency-quality measurement: did the mispricing decay?)
 *   arrival execution slippage = fill price vs. the ARRIVAL book the order
 *     actually executed against (an execution-quality measurement)
 *
 * paper_latency prices the fill exactly from the captured arrival book, so its
 * arrival-book slippage is deterministically zero — these tests pin the
 * deterioration number instead, and assert the zero slippage is not confused
 * with "no measurement".
 */

function latencyHarness(config = {}) {
  return harness({
    entryTotal: 0,
    exitTotal: 0,
    config: {
      executionMode: "paper_latency",
      simulatedDecisionMs: 0,
      simulatedLatencyMs: 60,
      executionMaxWaitMs: 200,
      executionPollMs: 5,
      safetyBuffer: 0,
      minExpectedNetProfit: 1000,
      minGrossEdge: 500,
      ...config,
    },
  });
}

test("1. detection ₹1,875 net worsens to ₹1,500 by arrival: fills, and deterioration is exactly ₹375", async () => {
  const h = latencyHarness();
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);

  // K1 CE ask worsens 300 → 305 during latency: cost 175 → 180, gross 1875 → 1500.
  const at = Date.now();
  for (const [token, q] of quotesFor(h.candidate, { k1_ce: { ask: 305, askQty: 150 } }, { at })) {
    h.quotes.applyTicks([{ token, last_price: q.last, bid: q.bid, ask: q.ask, bids: q.bids, asks: q.asks }], at);
  }
  await new Promise((r) => setTimeout(r, 220));

  assert.equal(h.opened.length, 1, "1500 net still clears the ₹1,000 gate");
  const snap = h.metrics.snapshot();
  assert.equal(snap.execution.attempted, 1);
  assert.equal(snap.execution.successful, 1);
  assert.equal(snap.execution.decision_deterioration.last, 375);
});

test("2. detection ₹1,875 net collapses to ₹900 by arrival: refused, and the loss is booked as a FAILED terminal attempt", async () => {
  const h = latencyHarness();
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);

  // Cost 175 → 188 (gross 1875 → 900), below the ₹1,000 gate.
  const at = Date.now();
  for (const [token, q] of quotesFor(h.candidate, { k1_ce: { ask: 313, askQty: 150 } }, { at })) {
    h.quotes.applyTicks([{ token, last_price: q.last, bid: q.bid, ask: q.ask, bids: q.bids, asks: q.asks }], at);
  }
  await new Promise((r) => setTimeout(r, 220));

  assert.equal(h.opened.length, 0);
  const snap = h.metrics.snapshot();
  assert.equal(snap.execution.attempted, 1);
  assert.equal(snap.execution.completed, 1);
  assert.equal(snap.execution.failed, 1);
  assert.ok("below_expected_net_profit" in snap.execution.rejection_categories);
});

test("3. an unchanged arrival book fills with zero deterioration AND zero execution slippage — not 'no measurement'", async () => {
  const h = latencyHarness();
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);
  await new Promise((r) => setTimeout(r, 220));

  assert.equal(h.opened.length, 1);
  const snap = h.metrics.snapshot();
  assert.equal(snap.execution.decision_deterioration.last, 0);
  assert.equal(snap.execution.execution_slippage.last, 0, "a genuine zero, distinct from an absent sample");
  assert.equal(snap.execution.execution_slippage.samples, 1, "the sample WAS recorded, it just happens to be zero");
});

test("4. quantity vanishing from the arrival book is refused as insufficient_quantity, not silently retried as a new attempt", async () => {
  const h = latencyHarness();
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);

  // K2 CE (a SELL leg → needs a bid) shows only 10 lots at arrival — one lot (75)
  // still cannot walk to a full fill within the marketable-limit band.
  const at = Date.now();
  for (const [token, q] of quotesFor(h.candidate, { k2_ce: { bid: 220, bidQty: 10, ask: 221, askQty: 150 } }, { at })) {
    h.quotes.applyTicks([{ token, last_price: q.last, bid: q.bid, ask: q.ask, bids: q.bids, asks: q.asks }], at);
  }
  await new Promise((r) => setTimeout(r, 220));

  assert.equal(h.opened.length, 0);
  const snap = h.metrics.snapshot();
  assert.equal(snap.execution.attempted, 1, "one strategy decision, whatever the internal book-walk did");
  assert.equal(snap.execution.completed, 1);
  assert.ok("insufficient_quantity" in snap.execution.rejection_categories);
});

test("5. a leg stale by arrival is refused as missing_book, counted as one resolved FAILED attempt", async () => {
  const h = latencyHarness({ quoteMaxAgeMs: 30 });
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);
  await new Promise((r) => setTimeout(r, 220));

  assert.equal(h.opened.length, 0);
  const snap = h.metrics.snapshot();
  assert.equal(snap.execution.attempted, 1);
  assert.equal(snap.execution.completed, 1);
  assert.equal(snap.execution.failed, 1);
  assert.ok("missing_book" in snap.execution.rejection_categories);
});

test("6. cross-leg exchange-timestamp incoherence under paper_legging refuses the candidate as one resolved FAILED attempt", async () => {
  const h = harness({
    entryTotal: 0,
    exitTotal: 0,
    config: {
      executionMode: "paper_legging",
      simulatedDecisionMs: 0,
      simulatedLatencyMs: 10,
      executionMaxWaitMs: 200,
      executionPollMs: 5,
      safetyBuffer: 0,
      minExpectedNetProfit: 500,
      minGrossEdge: 500,
      maxCrossLegExchangeDispersionMs: 50,
    },
  });
  const now = Date.now();
  // All four legs carry a valid exchange timestamp, but wildly dispersed —
  // K1 CE is 500ms stale relative to the other three at detection.
  const map = quotesFor(h.candidate, {}, { at: now });
  for (const [token, q] of map) {
    const isSkewed = token === h.candidate.legs.k1_ce.token;
    h.quotes.applyTicks(
      [{
        token,
        last_price: q.last,
        bid: q.bid,
        ask: q.ask,
        bids: q.bids,
        asks: q.asks,
        exchange_ts: isSkewed ? now - 500 : now,
      }],
      now,
    );
  }
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated([...map.keys()]);
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(h.opened.length, 0, "an incoherent cross-sectional snapshot is never auto-entered");
  const snap = h.metrics.snapshot();
  assert.equal(snap.execution.attempted, 1);
  assert.equal(snap.execution.completed, 1);
  assert.equal(snap.execution.failed, 1);
  assert.ok("cross_leg_time_skew" in snap.execution.rejection_categories);
});


/* --------------------- immutable detection/arrival snapshots -------------- */

test("the persisted execution audit's detection depth survives later WS ticks unchanged", async () => {
  const h = latencyHarness();
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);
  await new Promise((r) => setTimeout(r, 220));

  assert.equal(h.opened.length, 1);
  const execution = h.opened[0].execution;
  const k1 = execution.legs.find((l) => l.role === "k1_ce");
  const snapshotAsk = k1.detected_depth?.asks?.[0]?.price ?? k1.detected_price;

  // A later, unrelated tick must never reach back and mutate the audit record
  // already returned from the fill.
  const later = Date.now() + 5_000;
  h.quotes.applyTicks(
    [{ token: h.candidate.legs.k1_ce.token, last_price: 999, bid: 500, ask: 999, bids: [{ price: 500, qty: 1, orders: 1 }], asks: [{ price: 999, qty: 1, orders: 1 }] }],
    later,
  );

  const stillSnapshotAsk = k1.detected_depth?.asks?.[0]?.price ?? k1.detected_price;
  assert.equal(stillSnapshotAsk, snapshotAsk, "the stored detection snapshot is immutable");
  assert.notEqual(h.quotes.get(h.candidate.legs.k1_ce.token).ask, snapshotAsk, "the live store DID move on");
});


/* -------------- regression: abort-after-fill classification / no double-count ------------- */

test("a 4/4 legging fill that fails final re-qualification is ABORTED, never PARTIAL_RECOVERED", async () => {
  // A gate set just ₹5 below the detection net (1425): pre-dispatch qualifies,
  // but ANY in-flight adverse tick — even one that still fills within the
  // marketable-limit chase band — drops the EXECUTED net below the gate. All
  // four legs fill (each within its own limit), then the re-qualification on
  // the executed prices fails: the true abort-after-fill case.
  const h = harness({
    config: {
      executionMode: "paper_legging",
      simulatedDecisionMs: 0,
      simulatedLatencyMs: 30,
      executionMaxWaitMs: 200,
      executionPollMs: 5,
      minExpectedNetProfit: 1420,
    },
  });
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);

  // K1 CE ask worsens by exactly the 2-tick default chase band (₹0.10) — the
  // leg still fills at its limit, but the ₹7.50 cost (0.10 × lot 75) is enough
  // to push the executed net from ₹1,425 to ₹1,417.50, under the ₹1,420 gate.
  const at = Date.now();
  for (const [token, q] of quotesFor(h.candidate, { k1_ce: { ask: 300.1, askQty: 150 } }, { at })) {
    h.quotes.applyTicks([{ token, last_price: q.last, bid: q.bid, ask: q.ask, bids: q.bids, asks: q.asks }], at);
  }
  // The four fills, the re-qualification failure and the emergency unwind of all
  // four legs all happen after the simulated arrival — allow enough real time.
  await new Promise((r) => setTimeout(r, 400));

  assert.equal(h.opened.length, 0, "no box may be opened");
  const snap = h.metrics.snapshot();
  assert.equal(snap.execution.attempted, 1);
  assert.equal(snap.execution.completed, 1);
  assert.equal(snap.execution.aborted, 1, "a clean 4/4-then-reversed fill must count as ABORTED");
  assert.equal(snap.execution.partial_recovered, 0, "must NOT be mislabelled as a clean recovery");
  assert.equal(snap.execution.failed, 0);
  assert.equal(snap.execution.partial_unresolved, 0);
});

test("decision_to_fill_ms is pushed exactly once per successful atomic fill, not twice", async () => {
  const h = harness();
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);
  await settle();

  assert.equal(h.opened.length, 1);
  const snap = h.metrics.snapshot();
  assert.equal(snap.execution.decision_to_fill_ms.samples, 1, "one fill must contribute exactly one sample");
  assert.equal(snap.execution.entry_slippage.samples, 1);
});

test("decision_to_fill_ms is pushed exactly once per successful legging (4/4) fill", async () => {
  const h = harness({
    config: { executionMode: "paper_legging", simulatedDecisionMs: 0, simulatedLatencyMs: 10, executionMaxWaitMs: 200, executionPollMs: 5 },
  });
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(h.opened.length, 1);
  const snap = h.metrics.snapshot();
  assert.equal(snap.execution.decision_to_fill_ms.samples, 1, "one 4/4 fill must contribute exactly one sample");
});

test("a real leg-level retry (a resting/partial order filled again on a later tick) increments retries in production", async () => {
  const h = harness({
    config: { executionMode: "paper_legging", simulatedDecisionMs: 0, simulatedLatencyMs: 10, executionMaxWaitMs: 400, executionPollMs: 5 },
  });
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);

  // K1 CE (a BUY leg) shows nothing executable at arrival, then a fillable ask
  // appears afterwards — the SAME order is retried on the later tick, not
  // resubmitted as a new strategy attempt.
  await new Promise((r) => setTimeout(r, 5));
  const emptyAt = Date.now();
  for (const [token, q] of quotesFor(h.candidate, { k1_ce: { bid: 299, bidQty: 150, ask: 0, askQty: 0 } }, { at: emptyAt })) {
    h.quotes.applyTicks([{ token, last_price: q.last, bid: q.bid, ask: q.ask, bids: q.bids, asks: q.asks }], emptyAt);
  }
  await new Promise((r) => setTimeout(r, 40));
  const laterAt = Date.now();
  for (const [token, q] of quotesFor(h.candidate, {}, { at: laterAt })) {
    h.quotes.applyTicks([{ token, last_price: q.last, bid: q.bid, ask: q.ask, bids: q.bids, asks: q.asks }], laterAt);
  }
  await new Promise((r) => setTimeout(r, 300));

  const snap = h.metrics.snapshot();
  assert.ok(snap.execution.retries >= 1, "a real per-order retry must be observable in the shipped stat");
  assert.equal(snap.execution.attempted, 1, "the retry must never inflate the parent attempt count");
});


test("a real leg-level retry is also observable under sequential leg execution mode", async () => {
  const h = harness({
    config: {
      executionMode: "paper_legging",
      legExecutionMode: "sequential",
      simulatedDecisionMs: 0,
      simulatedLatencyMs: 10,
      executionMaxWaitMs: 400,
      executionPollMs: 5,
    },
  });
  const tokens = h.seedGood();
  h.scanner.setDiscovering(true);
  h.scanner.onTokensUpdated(tokens);

  // The FIRST leg released (k1_ce, a BUY) shows nothing executable at arrival,
  // then a fillable ask appears afterwards — retried on the later tick, still
  // within its own order, before the next leg is ever released.
  await new Promise((r) => setTimeout(r, 5));
  const emptyAt = Date.now();
  for (const [token, q] of quotesFor(h.candidate, { k1_ce: { bid: 299, bidQty: 150, ask: 0, askQty: 0 } }, { at: emptyAt })) {
    h.quotes.applyTicks([{ token, last_price: q.last, bid: q.bid, ask: q.ask, bids: q.bids, asks: q.asks }], emptyAt);
  }
  await new Promise((r) => setTimeout(r, 30));
  const laterAt = Date.now();
  for (const [token, q] of quotesFor(h.candidate, {}, { at: laterAt })) {
    h.quotes.applyTicks([{ token, last_price: q.last, bid: q.bid, ask: q.ask, bids: q.bids, asks: q.asks }], laterAt);
  }
  await new Promise((r) => setTimeout(r, 500));

  const snap = h.metrics.snapshot();
  assert.ok(snap.execution.retries >= 1, "sequential mode must also surface a genuine per-order retry");
  assert.equal(snap.execution.attempted, 1, "the retry must never inflate the parent attempt count in sequential mode either");
});
