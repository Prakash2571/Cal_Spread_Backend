/**
 * PROVE THE MODULES ARE FED, NOT MERELY PRESENT.
 *
 * A module that is built, unit-tested and never called reports empty forever while looking
 * finished. That is what these tests exist to catch: each one asserts a production CALL SITE exists
 * and that the module produces a non-empty result once real data flows through it.
 *
 * Written after an audit found ten such modules inert.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classifyOrderProfile } from "../../dist/box/orderPricing.js";
import { ExecutionOutcomeStore } from "../../dist/box/executionOutcomes.js";
import { QueueCalibrationEstimator } from "../../dist/box/queueCalibration.js";
import { BrokerTimingStore } from "../../dist/box/brokerTimingStore.js";
import { buildParityReports } from "../../dist/box/parityReport.js";

const src = (f) => readFileSync(new URL(`../../src/box/${f}`, import.meta.url), "utf8");
/** Strip comments so a mention in prose never counts as a call site. */
const code = (f) =>
  src(f)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
    .join("\n");

/* ─────────────── production call sites must exist ─────────────── */

test("classifyOrderProfile is CALLED in the fill path, not just defined", () => {
  const leg = code("legExecutor.ts");
  assert.ok(leg.includes("classifyOrderProfile("), "the leg executor must classify against a book");
  // And the result must actually be stored on the order, not computed and dropped.
  assert.ok(leg.includes("order_type: classified.profile"), "the classification must reach the order");
  assert.ok(leg.includes("limit_offset_ticks = classified.offsetTicks"));
});

test("recordOutcome is CALLED, so outcome rates have a numerator", () => {
  const engine = code("engine.ts");
  assert.ok(engine.includes("this.outcomeStore.recordOutcome("), "nothing recorded outcomes before");
  // Both a success and a failure path must feed it, or the rates are structurally skewed.
  assert.ok(engine.includes("this.observeAttempt(legging, false)"), "abort path must be observed");
  assert.ok(engine.includes("this.observeAttempt(args.legging, true)"), "success path must be observed");
});

test("the queue estimator is FED, not only read", () => {
  const engine = code("engine.ts");
  assert.ok(engine.includes("this.queueEstimator.record("), "the estimator had no data source before");
  assert.ok(engine.includes("this.queueEstimator.recommendAll()"), "and is still surfaced");
});

test("implementation shortfall is COMPUTED in production", () => {
  const engine = code("engine.ts");
  assert.ok(engine.includes("computeExecutionShortfall("));
  assert.ok(engine.includes("last_implementation_shortfall"), "and surfaced in diagnostics");
});

test("the parity report has BOTH halves produced", () => {
  const engine = code("engine.ts");
  assert.ok(engine.includes("buildParityReports("), "the report had no production caller before");
  assert.ok(engine.includes("this.paperTiming.recordLegTiming("), "the PAPER half must be produced");
  assert.ok(engine.includes("this.paperTiming.recordBoxOutcome("));
  // Live and paper must be separate stores, or the report compares a distribution with itself.
  assert.ok(engine.includes("this.brokerTiming.snapshot()") && engine.includes("this.paperTiming.snapshot()"));
});

test("queue evidence is captured from a real observed book, before it is consumed", () => {
  const leg = code("legExecutor.ts");
  assert.ok(leg.includes("leg.executable_within_limit_at_arrival === null"), "captured once");
  assert.ok(
    leg.indexOf("executable_within_limit_at_arrival =") < leg.indexOf("if (walk.filled_qty <= 0)"),
    "must be captured BEFORE any quantity is consumed, or the denominator is already depleted",
  );
});

/* ─────────────── and the modules produce real output when fed ─────────────── */

test("outcome rates become non-zero once outcomes are recorded", () => {
  const store = new ExecutionOutcomeStore();
  assert.equal(store.outcomeCounts("zerodha", "MARKETABLE_LIMIT").total, 0, "empty before");
  for (let i = 0; i < 3; i++) store.recordOutcome("zerodha", "MARKETABLE_LIMIT", "filled_4_of_4");
  store.recordOutcome("zerodha", "MARKETABLE_LIMIT", "partial");
  const counts = store.outcomeCounts("zerodha", "MARKETABLE_LIMIT");
  assert.equal(counts.total, 4);
  assert.equal(counts.rates.filled_4_of_4, 0.75);
});

test("the queue estimator produces a recommendation once fed real observations", () => {
  const est = new QueueCalibrationEstimator({ currentHaircutPct: 30, minSamples: 10 });
  assert.equal(est.recommend("zerodha", "MARKETABLE_LIMIT", "NORMAL").recommendedHaircutPct, null);
  for (let i = 0; i < 20; i++) {
    est.record({
      broker: "zerodha",
      profile: "MARKETABLE_LIMIT",
      side: "BUY",
      tradingsymbol: "SYM",
      displayedQtyAtSubmit: 300,
      executableWithinLimitAtSubmit: 150,
      requestedQty: 75,
      limitOffsetTicks: 2,
      immediatelyMarketable: true,
      filledQty: 60,
      fillLatencyMs: 120,
      partial: true,
      bookUpdatesWhileWorking: null,
      atWall: 1_700_000_000_000,
    });
  }
  const r = est.recommend("zerodha", "MARKETABLE_LIMIT", "NORMAL");
  assert.equal(r.samples, 20);
  assert.ok(r.recommendedHaircutPct !== null, "with evidence it must recommend something");
  assert.ok(r.realisationRatioP50 < 1, "60 of 75 wanted is a partial realisation");
});

test("a parity report compares two independently-populated stores", () => {
  const live = new BrokerTimingStore({ now: () => 1_000 });
  const paper = new BrokerTimingStore({ now: () => 1_000 });
  const timing = (over) => ({
    broker: "zerodha",
    trade_id: "t",
    attempt_id: "a",
    role: "k1_ce",
    purpose: "ENTRY",
    kind: "ENTRY",
    detected_at: 0,
    queued_at: 0,
    dequeued_at: 0,
    post_started_at: 0,
    post_returned_at: null,
    acknowledged_at: 100,
    first_fill_at: 200,
    last_fill_at: 200,
    terminal_at: 250,
    cancel_requested_at: null,
    cancel_confirmed_at: null,
    ...over,
  });
  for (let i = 0; i < 5; i++) live.recordLegTiming(timing({ acknowledged_at: 300 }));
  for (let i = 0; i < 5; i++) paper.recordLegTiming(timing({ acknowledged_at: 100 }));

  const reports = buildParityReports(live.snapshot(), paper.snapshot());
  const zerodha = reports.find((r) => r.broker === "zerodha");
  assert.ok(zerodha, "a report must exist for a populated broker");
  const ack = zerodha.metrics.find((m) => m.metric === "submit_to_ack_ms");
  assert.ok(ack, "the compared metric must be present on both sides");
  assert.equal(ack.live.p50, 300);
  assert.equal(ack.paper.p50, 100);
  assert.ok(ack.error_pct.p50 < 0, "paper being faster than live must show as a negative error");
  // Five samples justifies nothing, and the report must say so.
  assert.equal(ack.low_confidence, true);
  assert.equal(zerodha.overall_low_confidence, true);
});

test("the classifier really distinguishes the two profiles from a book", () => {
  const bids = [{ price: 99.9, qty: 100, orders: 1 }];
  const asks = [{ price: 100, qty: 100, orders: 1 }];
  // A BUY willing to pay the ask crosses: marketable.
  const marketable = classifyOrderProfile({ side: "BUY", limitPrice: 100.1, bids, asks, tickSize: 0.05 });
  assert.equal(marketable.profile, "MARKETABLE_LIMIT");
  assert.equal(marketable.assumed, false, "decided from the book, not assumed");
  assert.ok(marketable.offsetTicks > 0, "through the touch");
  // A BUY priced below the ask rests behind unknown queue depth: passive.
  const passive = classifyOrderProfile({ side: "BUY", limitPrice: 99.5, bids, asks, tickSize: 0.05 });
  assert.equal(passive.profile, "PASSIVE_LIMIT");
  assert.ok(passive.offsetTicks < 0, "behind the touch");
});

/* ─────────── what remains inert must stay HONESTLY documented ─────────── */

test("modules that are still not wired are documented as such", () => {
  const doc = readFileSync(new URL("../../src/box/LIVE_EXECUTION.md", import.meta.url), "utf8");
  // Each of these has no production call site; the docs must not imply otherwise.
  for (const claim of [
    /fault injection itself is NOT yet plumbed/,
    /UNREACHABLE BY CONSTRUCTION/,
    /no production producer yet/,
  ]) {
    assert.match(doc, claim, "an unwired capability must be labelled, not implied");
  }
});

test("nothing that IS wired is still labelled unwired", () => {
  const doc = readFileSync(new URL("../../src/box/LIVE_EXECUTION.md", import.meta.url), "utf8");
  // The parity report now has both halves; the stale "no production caller" note must be gone.
  assert.doesNotMatch(
    doc,
    /parityReport[^.]*no production caller/i,
    "the parity report is wired now, so the doc must not still say it is not",
  );
});
