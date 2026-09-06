/**
 * The diagnostic and calibration-analysis modules: queue calibration, implementation shortfall,
 * adverse selection, paired live-vs-paper comparison, outcome/reject statistics, and the bounded
 * persistence buffer.
 *
 * The recurring theme of these assertions is HONESTY: every module must refuse to state more than
 * its evidence supports, and must never silently invent a number.
 *
 * Pure and offline.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  QueueCalibrationEstimator,
  classifyLiquidity,
  formatHaircutRecommendation,
} from "../../dist/box/queueCalibration.js";
import {
  computeAdverseSelection,
  computeExecutionShortfall,
  formatShortfall,
} from "../../dist/box/executionShortfall.js";
import { buildPairedComparison, formatPairedComparison } from "../../dist/box/pairedComparison.js";
import {
  ExecutionOutcomeStore,
  RecordedRejectReplayer,
  REJECT_CLASSES,
  rejectClassFor,
} from "../../dist/box/executionOutcomes.js";
import { CalibrationPersistenceBuffer } from "../../dist/box/calibrationPersistence.js";

/* ═══════════════════════ queue calibration ═══════════════════════ */

const observation = (over = {}) => ({
  broker: "zerodha",
  profile: "MARKETABLE_LIMIT",
  side: "BUY",
  tradingsymbol: "NIFTY26SEP19900CE",
  displayedQtyAtSubmit: 300,
  executableWithinLimitAtSubmit: 150,
  requestedQty: 75,
  limitOffsetTicks: 2,
  immediatelyMarketable: true,
  filledQty: 75,
  fillLatencyMs: 120,
  partial: false,
  bookUpdatesWhileWorking: 3,
  atWall: 1_700_000_000_000,
  ...over,
});

test("liquidity is classified from visible depth relative to what we wanted", () => {
  assert.equal(classifyLiquidity(50, 75), "THIN", "less depth than we want is thin");
  assert.equal(classifyLiquidity(150, 75), "NORMAL");
  assert.equal(classifyLiquidity(400, 75), "DEEP");
  assert.equal(classifyLiquidity(100, 0), "NORMAL", "an undefined ratio must not throw");
});

test("no recommendation is made below the sample floor, and the configured haircut stands", () => {
  const est = new QueueCalibrationEstimator({ currentHaircutPct: 30, minSamples: 30 });
  for (let i = 0; i < 10; i++) est.record(observation());
  const r = est.recommend("zerodha", "MARKETABLE_LIMIT", "NORMAL");
  assert.equal(r.recommendedHaircutPct, null);
  assert.equal(r.confidence, "LOW");
  assert.equal(r.currentHaircutPct, 30);
  assert.match(r.note, /NO recommendation/);
  assert.match(r.note, /does not and cannot reconstruct NSE queue position/);
});

test("a conservative haircut is recommended from the p25 realisation, not the median", () => {
  const est = new QueueCalibrationEstimator({ currentHaircutPct: 30, minSamples: 10, highConfidenceSamples: 100 });
  // 40 orders realise fully; 10 realise only half. Median realisation is 1.0, p25 is lower.
  for (let i = 0; i < 40; i++) est.record(observation({ filledQty: 75 }));
  for (let i = 0; i < 10; i++) est.record(observation({ filledQty: 37, partial: true }));

  const r = est.recommend("zerodha", "MARKETABLE_LIMIT", "NORMAL");
  assert.equal(r.samples, 50);
  assert.equal(r.realisationRatioP50, 1);
  assert.ok(r.realisationRatioP25 <= 1);
  assert.equal(r.recommendedHaircutPct, Math.round((1 - r.realisationRatioP25) * 100));
  assert.ok(r.partialFillRate > 0);
  assert.match(r.note, /not the median/);
  assert.match(r.note, /NOT applied automatically/);
});

test("the realisation ratio is capped at 1, so a replenishing book cannot produce a negative haircut", () => {
  const est = new QueueCalibrationEstimator({ currentHaircutPct: 30, minSamples: 5 });
  // Filled MORE than was visible at submission: the book replenished while we worked.
  for (let i = 0; i < 20; i++) {
    est.record(observation({ executableWithinLimitAtSubmit: 40, requestedQty: 75, filledQty: 75 }));
  }
  const r = est.recommend("zerodha", "MARKETABLE_LIMIT", "THIN");
  assert.equal(r.realisationRatioP50, 1);
  assert.ok(r.recommendedHaircutPct >= 0, "a haircut can never be negative");
});

test("observations with no visible depth are DROPPED, not counted as total failures", () => {
  const est = new QueueCalibrationEstimator({ currentHaircutPct: 30, minSamples: 1 });
  est.record(observation({ executableWithinLimitAtSubmit: 0 }));
  est.record(observation({ executableWithinLimitAtSubmit: -5 }));
  est.record(observation({ filledQty: Number.NaN }));
  assert.equal(est.dropped, 3, "a zero denominator says nothing about the queue");
  assert.equal(est.recommend("zerodha", "MARKETABLE_LIMIT", "NORMAL").samples, 0);
});

test("marketable and passive evidence never pool, and brokers never pool", () => {
  const est = new QueueCalibrationEstimator({ currentHaircutPct: 30, minSamples: 5 });
  for (let i = 0; i < 20; i++) est.record(observation({ profile: "MARKETABLE_LIMIT", filledQty: 75 }));
  for (let i = 0; i < 20; i++) {
    est.record(observation({ profile: "PASSIVE_LIMIT", filledQty: 8, partial: true }));
  }
  const marketable = est.recommend("zerodha", "MARKETABLE_LIMIT", "NORMAL");
  const passive = est.recommend("zerodha", "PASSIVE_LIMIT", "NORMAL");
  assert.equal(marketable.realisationRatioP50, 1);
  assert.ok(passive.realisationRatioP50 < 0.5, "passive evidence must stay separate");
  // Dhan has nothing and must borrow nothing.
  assert.equal(est.recommend("dhan", "MARKETABLE_LIMIT", "NORMAL").samples, 0);
});

test("size relative to visible depth is EXPOSED rather than converted into an impact model", () => {
  const est = new QueueCalibrationEstimator({ currentHaircutPct: 30, minSamples: 5 });
  // Half the orders are larger than the visible executable depth.
  for (let i = 0; i < 10; i++) est.record(observation({ executableWithinLimitAtSubmit: 150, requestedQty: 75 }));
  for (let i = 0; i < 10; i++) est.record(observation({ executableWithinLimitAtSubmit: 40, requestedQty: 75 }));

  const normal = est.sizeVsDepth("zerodha", "MARKETABLE_LIMIT", "NORMAL");
  const thin = est.sizeVsDepth("zerodha", "MARKETABLE_LIMIT", "THIN");
  assert.equal(normal.p50, 0.5, "75 of 150 visible");
  assert.equal(thin.exceeded_rate, 1, "every thin order wanted more than was showing");
  // No price-impact coefficient is produced anywhere.
  assert.equal(normal.impact_price, undefined);
});

test("a rendered recommendation always carries the disclaimer", () => {
  const est = new QueueCalibrationEstimator({ currentHaircutPct: 30, minSamples: 5 });
  for (let i = 0; i < 10; i++) est.record(observation());
  const text = formatHaircutRecommendation(est.recommend("zerodha", "MARKETABLE_LIMIT", "NORMAL"));
  assert.match(text, /NOT a reconstruction of NSE queue position/);
  assert.match(text, /Advisory only; never applied automatically/);
});

/* ═══════════════════════ implementation shortfall ═══════════════════════ */

test("the shortfall chain decomposes the detected edge and reconciles to the realised result", () => {
  const s = computeExecutionShortfall({
    theoreticalDetectedEdge: 1_875,
    executedGrossEdge: 1_700,
    brokerage: 80,
    taxesAndFees: 70,
    unwindCost: 0,
    realisedNetResult: 1_425,
    outcome: "filled_4_of_4",
    legs: [
      // A BUY that paid 0.10 more than detected, over 75: 7.50 of cost.
      { role: "k1_ce", side: "BUY", detectedPrice: 100, submitPrice: 100.05, filledPrice: 100.1, requestedQty: 75, filledQty: 75 },
      { role: "k2_ce", side: "SELL", detectedPrice: 50, submitPrice: 49.95, filledPrice: 49.9, requestedQty: 75, filledQty: 75 },
    ],
  });

  assert.equal(s.incomplete, false);
  assert.equal(s.brokerage, 80);
  assert.equal(s.taxesAndFees, 70);
  // Both legs lost 0.05 per unit between detection and submission → 3.75 each.
  assert.equal(s.edgeDecay, 7.5);
  // And 0.05 per unit between submission and fill → 3.75 each.
  assert.equal(s.slippage, 7.5);
  // The residual is surfaced, not hidden in another bucket.
  assert.equal(
    s.unexplained,
    Math.round((1_875 - (7.5 + 7.5 + 80 + 70) - 1_425) * 100) / 100,
  );
});

test("positive always means COST, whichever side the leg was", () => {
  const buy = computeExecutionShortfall({
    theoreticalDetectedEdge: 0,
    executedGrossEdge: null,
    brokerage: 0,
    taxesAndFees: 0,
    unwindCost: 0,
    realisedNetResult: 0,
    outcome: "filled_4_of_4",
    legs: [{ role: "k1_ce", side: "BUY", detectedPrice: 100, submitPrice: 100, filledPrice: 101, requestedQty: 10, filledQty: 10 }],
  });
  const sell = computeExecutionShortfall({
    theoreticalDetectedEdge: 0,
    executedGrossEdge: null,
    brokerage: 0,
    taxesAndFees: 0,
    unwindCost: 0,
    realisedNetResult: 0,
    outcome: "filled_4_of_4",
    legs: [{ role: "k1_pe", side: "SELL", detectedPrice: 100, submitPrice: 100, filledPrice: 99, requestedQty: 10, filledQty: 10 }],
  });
  assert.equal(buy.slippage, 10, "paying more costs us");
  assert.equal(sell.slippage, 10, "receiving less costs us the same amount");
});

test("attribution is over FILLED quantity — an unfilled leg costs no slippage", () => {
  const s = computeExecutionShortfall({
    theoreticalDetectedEdge: 1_000,
    executedGrossEdge: 0,
    brokerage: 0,
    taxesAndFees: 0,
    unwindCost: 250,
    realisedNetResult: -250,
    outcome: "partial_unwound",
    legs: [{ role: "k1_ce", side: "BUY", detectedPrice: 100, submitPrice: 101, filledPrice: null, requestedQty: 75, filledQty: 0 }],
  });
  assert.equal(s.slippage, 0, "nothing filled, so nothing slipped");
  assert.equal(s.edgeDecay, 0, "decay is measured over filled quantity too");
  assert.equal(s.unwindCost, 250, "the cost shows up where it belongs");
  assert.equal(s.incomplete, true, "and a failed attempt is NOT hidden");
});

test("a failed attempt still produces a record — statistics never quietly exclude failures", () => {
  for (const outcome of ["no_fill", "partial_residual", "aborted_after_fill"]) {
    const s = computeExecutionShortfall({
      theoreticalDetectedEdge: 1_500,
      executedGrossEdge: null,
      brokerage: 0,
      taxesAndFees: 0,
      unwindCost: 100,
      realisedNetResult: -100,
      outcome,
      legs: [],
    });
    assert.equal(s.outcome, outcome);
    assert.equal(s.incomplete, true);
    assert.equal(s.realisedNetResult, -100);
  }
});

test("a missing price yields null attribution, never a fabricated zero", () => {
  const s = computeExecutionShortfall({
    theoreticalDetectedEdge: 0,
    executedGrossEdge: null,
    brokerage: 0,
    taxesAndFees: 0,
    unwindCost: 0,
    realisedNetResult: 0,
    outcome: "filled_4_of_4",
    legs: [{ role: "k1_ce", side: "BUY", detectedPrice: null, submitPrice: null, filledPrice: 100, requestedQty: 10, filledQty: 10 }],
  });
  assert.equal(s.legs[0].edgeDecay, null);
  assert.equal(s.legs[0].totalShortfall, null);
  assert.equal(s.edgeDecay, null, "no leg supplied decay, so the total is unknown — not zero");
});

test("the rendered shortfall is the explicit subtraction chain", () => {
  const text = formatShortfall(
    computeExecutionShortfall({
      theoreticalDetectedEdge: 1_875,
      executedGrossEdge: 1_700,
      brokerage: 80,
      taxesAndFees: 70,
      unwindCost: 0,
      realisedNetResult: 1_425,
      outcome: "filled_4_of_4",
      legs: [],
    }),
  );
  for (const label of [
    "THEORETICAL_DETECTED_EDGE",
    "SLIPPAGE",
    "BROKERAGE",
    "TAXES_AND_FEES",
    "UNWIND_COST",
    "REALISED_NET_RESULT",
  ]) {
    assert.match(text, new RegExp(label));
  }
});

test("adverse selection is signed so positive always means the market moved against us", () => {
  // We bought, then the price fell — we were adversely selected.
  const buy = computeAdverseSelection({
    role: "k1_ce",
    side: "BUY",
    touchAtDetection: 100,
    touchAtSubmit: 100.1,
    touchAtAck: 100.2,
    touchAfterFill: 99.5,
    horizonMs: 500,
    filledPrice: 100.2,
  });
  assert.equal(buy.detectionToSubmit, 0.1, "the market moved away before we submitted");
  assert.equal(buy.submitToAck, 0.1);
  assert.ok(buy.postFillAdverseMove > 0, "a fall after buying is adverse");
  assert.equal(buy.horizonMs, 500);

  // We sold, then the price rose — also adverse.
  const sell = computeAdverseSelection({
    role: "k1_pe",
    side: "SELL",
    touchAtDetection: 100,
    touchAtSubmit: 100,
    touchAtAck: 100,
    touchAfterFill: 101,
    horizonMs: 500,
    filledPrice: 100,
  });
  assert.ok(sell.postFillAdverseMove > 0);

  // Missing observations yield nulls, not zeros.
  const partial = computeAdverseSelection({
    role: "k1_ce",
    side: "BUY",
    touchAtDetection: null,
    touchAtSubmit: null,
    touchAtAck: null,
    touchAfterFill: null,
    horizonMs: null,
    filledPrice: null,
  });
  assert.equal(partial.detectionToSubmit, null);
  assert.equal(partial.postFillAdverseMove, null);
});

/* ═══════════════════════ paired comparison ═══════════════════════ */

const prediction = (id, over = {}) => ({
  candidateId: id,
  broker: "zerodha",
  profile: "MARKETABLE_LIMIT",
  legs: ["k1_ce", "k2_ce", "k2_pe", "k1_pe"],
  detectedEdge: 1_875,
  predictedArrivalMs: 250,
  predictedFillMs: 300,
  predictedFilledQty: 75,
  predictedSlippage: 10,
  predictedCharges: 150,
  predictedOutcome: "filled_4_of_4",
  predictedNetResult: 1_425,
  ...over,
});

const observed = (id, over = {}) => ({
  candidateId: id,
  broker: "zerodha",
  profile: "MARKETABLE_LIMIT",
  observedAckMs: 300,
  observedFillMs: 420,
  observedFilledQty: 75,
  observedSlippage: 18,
  observedCharges: 155,
  observedOutcome: "filled_4_of_4",
  observedNetResult: 1_380,
  ...over,
});

test("pairs are formed by candidate id and report per-trade error, not aggregate similarity", () => {
  const report = buildPairedComparison({
    broker: "zerodha",
    profile: "MARKETABLE_LIMIT",
    predictions: [prediction("c1"), prediction("c2")],
    observations: [observed("c1"), observed("c2", { observedAckMs: 900, observedFillMs: 1_100 })],
  });
  assert.equal(report.pairs, 2);
  assert.equal(report.rows[0].arrival_error_ms, 50, "live 300 − paper 250");
  assert.equal(report.rows[1].arrival_error_ms, 650);
  // The tail is visible, which a mean would have hidden.
  assert.equal(report.arrival_error.abs_p99, 650);
  assert.ok(report.arrival_error.signed_mean > 0, "paper was optimistic");
  assert.equal(report.outcome_agreement_rate, 1);
});

test("a prediction with no matching real execution is NOT counted as a zero error", () => {
  const report = buildPairedComparison({
    broker: "zerodha",
    profile: "MARKETABLE_LIMIT",
    predictions: [prediction("c1"), prediction("unmatched")],
    observations: [observed("c1")],
  });
  assert.equal(report.pairs, 1, "only genuinely paired executions count");
  assert.equal(report.arrival_error.samples, 1);
});

test("pairs never cross a broker or a profile boundary", () => {
  const report = buildPairedComparison({
    broker: "zerodha",
    profile: "MARKETABLE_LIMIT",
    predictions: [prediction("c1")],
    // Same candidate id, but a different broker and a different profile.
    observations: [observed("c1", { broker: "dhan" }), observed("c1", { profile: "PASSIVE_LIMIT" })],
  });
  assert.equal(report.pairs, 0, "comparing across brokers or profiles would be meaningless");
});

test("fill-rate and partial-rate differences are reported as live minus paper", () => {
  const report = buildPairedComparison({
    broker: "zerodha",
    profile: "MARKETABLE_LIMIT",
    predictions: [
      prediction("a", { predictedFilledQty: 75, predictedOutcome: "filled_4_of_4" }),
      prediction("b", { predictedFilledQty: 75, predictedOutcome: "filled_4_of_4" }),
    ],
    observations: [
      observed("a", { observedFilledQty: 75, observedOutcome: "filled_4_of_4" }),
      // Live only partially filled this one — paper was wrong.
      observed("b", { observedFilledQty: 40, observedOutcome: "partial" }),
    ],
  });
  assert.equal(report.partial_fill_rate_difference, 0.5, "live partialled half; paper predicted none");
  assert.equal(report.outcome_agreement_rate, 0.5);
  assert.equal(report.rows[1].filled_qty_error, -35);
});

test("zero pairs concludes NOTHING, explicitly", () => {
  const report = buildPairedComparison({
    broker: "zerodha",
    profile: "MARKETABLE_LIMIT",
    predictions: [],
    observations: [],
  });
  assert.equal(report.pairs, 0);
  assert.equal(report.confidence, "LOW");
  assert.match(report.note, /NOTHING can be concluded/);
  assert.equal(report.arrival_error.abs_p50, null);
  const text = formatPairedComparison(report);
  assert.doesNotMatch(text, /\d+% realistic/);
});

test("a small number of pairs is LOW confidence however clean the numbers look", () => {
  const predictions = Array.from({ length: 5 }, (_, i) => prediction(`c${i}`));
  const observations = predictions.map((p) => observed(p.candidateId, { observedAckMs: p.predictedArrivalMs }));
  const report = buildPairedComparison({
    broker: "zerodha",
    profile: "MARKETABLE_LIMIT",
    predictions,
    observations,
  });
  assert.equal(report.arrival_error.abs_p50, 0, "paper was exactly right on every pair");
  assert.equal(report.confidence, "LOW", "five pairs still justifies nothing");
});

/* ═══════════════════════ outcome and reject statistics ═══════════════════════ */

test("outcome rates are measured per broker and profile, never pooled", () => {
  const store = new ExecutionOutcomeStore();
  for (let i = 0; i < 8; i++) store.recordOutcome("zerodha", "MARKETABLE_LIMIT", "filled_4_of_4");
  store.recordOutcome("zerodha", "MARKETABLE_LIMIT", "partial");
  store.recordOutcome("zerodha", "MARKETABLE_LIMIT", "cancel_race");
  store.recordOutcome("dhan", "MARKETABLE_LIMIT", "broker_reject");

  const z = store.outcomeCounts("zerodha", "MARKETABLE_LIMIT");
  assert.equal(z.total, 10);
  assert.equal(z.counts.filled_4_of_4, 8);
  assert.equal(z.rates.filled_4_of_4, 0.8);
  assert.equal(z.counts.broker_reject, 0, "dhan's reject must not appear under zerodha");

  const d = store.outcomeCounts("dhan", "MARKETABLE_LIMIT");
  assert.equal(d.total, 1);
  assert.equal(d.rates.broker_reject, 1);

  // A profile with no attempts reports a zero TOTAL, so a 0 rate is never mistaken for measured 0%.
  const passive = store.outcomeCounts("zerodha", "PASSIVE_LIMIT");
  assert.equal(passive.total, 0);
});

test("reject families are classified from what the broker actually said", () => {
  assert.equal(rejectClassFor("rms"), "rms");
  assert.equal(rejectClassFor("margin"), "margin");
  assert.equal(rejectClassFor("price_band"), "price_band");
  assert.equal(rejectClassFor("quantity_freeze"), "quantity_freeze");
  assert.equal(rejectClassFor("rate_limit"), "rate_limit");
  assert.equal(rejectClassFor("auth"), "auth");
  // An unclassified rejection stays "other" rather than being guessed at...
  assert.equal(rejectClassFor("generic", "something odd happened"), "other");
  assert.equal(rejectClassFor(null, null), "other");
  // ...except for the two narrow, evidence-based refinements.
  assert.equal(rejectClassFor("generic", "request timed out"), "network_unknown");
  assert.equal(rejectClassFor("generic", "Internal Server Error 503"), "broker_internal");
  for (const cls of REJECT_CLASSES) assert.equal(typeof cls, "string");
});

test("reject rates are measured, and no API exists to fabricate one", () => {
  const store = new ExecutionOutcomeStore();
  store.recordReject("zerodha", "margin", "insufficient margin");
  store.recordReject("zerodha", "margin", "insufficient margin");
  store.recordReject("zerodha", "rms", "RMS blocked");
  const counts = store.rejectCounts("zerodha");
  assert.equal(counts.total, 3);
  assert.equal(counts.counts.margin, 2);
  assert.equal(counts.rates.margin, 0.667);
  assert.equal(counts.counts.rms, 1);
  // There is deliberately no way to inject a synthetic reject rate.
  assert.equal(store.setRejectProbability, undefined);
  assert.equal(store.simulateReject, undefined);
});

test("recorded real rejects can be replayed deterministically, and only those", () => {
  const replayer = new RecordedRejectReplayer([
    {
      broker: "zerodha",
      clientOrderId: "BOX:t:ENTRY:k1_ce:attempt-1",
      rejectClass: "margin",
      family: "margin",
      message: "insufficient margin",
      atWall: 1_700_000_000_000,
    },
  ]);
  assert.equal(replayer.size, 1);
  assert.equal(replayer.rejectFor("BOX:t:ENTRY:k1_ce:attempt-1").rejectClass, "margin");
  // An order that was never rejected cannot be made to look rejected.
  assert.equal(replayer.rejectFor("BOX:t:ENTRY:k2_ce:attempt-1"), null);
});

/* ═══════════════════════ persistence buffer ═══════════════════════ */

const sample = (i) => ({
  broker: "zerodha",
  kind: "ENTRY",
  profile: "MARKETABLE_LIMIT",
  bucket: "NORMAL",
  stage: "post_to_ack_ms",
  valueMs: 100 + i,
  atWall: 1_700_000_000_000 + i,
});

test("recording is synchronous and does not touch the sink until the batch is full", async () => {
  const batches = [];
  const buffer = new CalibrationPersistenceBuffer({
    enabled: true,
    sink: async (batch) => {
      batches.push([...batch]);
    },
    batchSize: 3,
    flushMs: 60_000,
  });
  buffer.record(sample(1));
  buffer.record(sample(2));
  assert.equal(batches.length, 0, "no write before the batch is full");
  assert.equal(buffer.diagnostics().pending, 2);

  buffer.record(sample(3));
  await buffer.flush();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 3);
  assert.equal(buffer.diagnostics().persisted_total, 3);
  await buffer.dispose();
});

test("a full buffer drops the OLDEST and COUNTS the loss rather than growing without bound", async () => {
  const buffer = new CalibrationPersistenceBuffer({
    enabled: true,
    // A sink that never settles, so nothing drains.
    sink: () => new Promise(() => {}),
    batchSize: 1_000_000,
    flushMs: 60_000,
    maxBuffered: 5,
  });
  for (let i = 0; i < 50; i++) buffer.record(sample(i));
  const d = buffer.diagnostics();
  assert.ok(d.pending <= 5, `memory stays bounded, pending was ${d.pending}`);
  assert.ok(d.lost_total > 0, "the loss is reported, never hidden");
  assert.equal(d.buffered_total, 50, "everything offered is still counted");
  assert.equal(d.persisted_total, 0, "the stuck sink persisted nothing");
});

test("a batch larger than the memory cap is shrunk — the cap wins, never the throughput knob", async () => {
  const batches = [];
  const buffer = new CalibrationPersistenceBuffer({
    enabled: true,
    sink: async (batch) => {
      batches.push(batch.length);
    },
    batchSize: 1_000,
    flushMs: 60_000,
    maxBuffered: 4,
  });
  for (let i = 0; i < 4; i++) buffer.record(sample(i));
  await buffer.flush();
  assert.deepEqual(batches, [4], "the effective batch is capped at maxBuffered");
  await buffer.dispose();
});

test("a failing sink loses the batch, reports it, and never invents replacement samples", async () => {
  let calls = 0;
  const buffer = new CalibrationPersistenceBuffer({
    enabled: true,
    sink: async () => {
      calls++;
      throw new Error("mongo unavailable");
    },
    batchSize: 2,
    flushMs: 60_000,
  });
  buffer.record(sample(1));
  buffer.record(sample(2));
  await buffer.flush();

  const d = buffer.diagnostics();
  assert.equal(d.flush_failures, 1);
  assert.equal(d.lost_total, 2);
  assert.equal(d.persisted_total, 0);
  assert.match(d.last_error, /mongo unavailable/);
  assert.equal(d.pending, 0, "the failed batch is not retried forever");

  // Execution carries on: further records are still accepted.
  buffer.record(sample(3));
  assert.equal(buffer.diagnostics().pending, 1);
  await buffer.dispose();
  assert.ok(calls >= 1);
});

test("a disabled buffer accepts nothing and writes nothing", async () => {
  let called = false;
  const buffer = new CalibrationPersistenceBuffer({
    enabled: false,
    sink: async () => {
      called = true;
    },
    batchSize: 1,
    flushMs: 1,
  });
  buffer.start();
  buffer.record(sample(1));
  await buffer.flush();
  assert.equal(called, false);
  assert.equal(buffer.diagnostics().enabled, false);
  assert.equal(buffer.diagnostics().buffered_total, 0);
  await buffer.dispose();
});

test("concurrent flushes are serialised so the sink never sees overlapping writes", async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const buffer = new CalibrationPersistenceBuffer({
    enabled: true,
    sink: async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent--;
    },
    batchSize: 1,
    flushMs: 60_000,
  });
  buffer.record(sample(1));
  buffer.record(sample(2));
  buffer.record(sample(3));
  await Promise.all([buffer.flush(), buffer.flush(), buffer.flush()]);
  assert.equal(maxConcurrent, 1, "overlapping writes could reorder or duplicate observations");
  await buffer.dispose();
});

test("dispose() makes a final attempt so a clean shutdown keeps the session tail", async () => {
  const written = [];
  const buffer = new CalibrationPersistenceBuffer({
    enabled: true,
    sink: async (batch) => {
      written.push(...batch);
    },
    batchSize: 100,
    flushMs: 60_000,
  });
  buffer.record(sample(1));
  buffer.record(sample(2));
  assert.equal(written.length, 0);
  await buffer.dispose();
  assert.equal(written.length, 2, "the pending tail must be persisted on shutdown");
});
