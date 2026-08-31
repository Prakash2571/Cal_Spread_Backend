/**
 * The entry decision: expected NET profit is the real gate, with every cost term
 * visible. Gross is only a prefilter.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { evaluateEntryDecision } from "../../dist/box/math.js";
import { requiredNetProfit } from "../../dist/box/config.js";
import { cfg } from "./helpers.mjs";

const gate = (over = {}) => cfg(over);

test("gross high but expected net below ₹1,200 → reject, with the arithmetic shown", () => {
  // gross 1900, fees 350, slippage/exec 250, buffer 150 → expected net 1150 < 1200.
  const c = gate({ safetyBuffer: 150, minExpectedNetProfit: 1200, minGrossEdge: 1200 });
  const d = evaluateEntryDecision({
    grossEdge: 1900,
    entryCharges: 175,
    estimatedExitCharges: 175,
    executionCost: 250,
    cfg: c,
  });
  assert.equal(d.gross_edge, 1900);
  assert.equal(d.entry_charges, 175);
  assert.equal(d.estimated_exit_charges, 175);
  assert.equal(d.execution_cost, 250);
  assert.equal(d.safety_buffer, 150);
  assert.equal(d.expected_net_profit, 1900 - 175 - 175 - 250 - 150); // 1150
  assert.equal(d.qualifies, false);
  assert.equal(d.reject, "below_expected_net_profit");
  assert.equal(d.passes_gross_prefilter, true, "it cleared the cheap prefilter, but not the gate");
});

test("gross high and expected net above ₹1,200 → eligible", () => {
  // gross 2400, fees 350, slippage 200, buffer 150 → expected net 1700 ≥ 1200.
  const c = gate({ safetyBuffer: 150, minExpectedNetProfit: 1200, minGrossEdge: 1200 });
  const d = evaluateEntryDecision({
    grossEdge: 2400,
    entryCharges: 175,
    estimatedExitCharges: 175,
    executionCost: 200,
    cfg: c,
  });
  assert.equal(d.expected_net_profit, 2400 - 175 - 175 - 200 - 150); // 1700
  assert.equal(d.qualifies, true);
  assert.equal(d.reject, null);
});

test("exactly ₹1,200 expected net qualifies; a paisa under does not", () => {
  const c = gate({ safetyBuffer: 0, minExpectedNetProfit: 1200, minGrossEdge: 1200 });
  const at = evaluateEntryDecision({ grossEdge: 1500, entryCharges: 150, estimatedExitCharges: 150, executionCost: 0, cfg: c });
  assert.equal(at.expected_net_profit, 1200);
  assert.equal(at.qualifies, true);
  const under = evaluateEntryDecision({ grossEdge: 1499.99, entryCharges: 150, estimatedExitCharges: 150, executionCost: 0, cfg: c });
  assert.equal(under.qualifies, false);
  assert.equal(under.reject, "below_expected_net_profit");
});

test("a box below the gross prefilter is rejected before the net maths matter", () => {
  const c = gate({ minGrossEdge: 1200, minExpectedNetProfit: 1200 });
  const d = evaluateEntryDecision({ grossEdge: 800, entryCharges: 50, estimatedExitCharges: 50, executionCost: 0, cfg: c });
  assert.equal(d.passes_gross_prefilter, false);
  assert.equal(d.qualifies, false);
  assert.equal(d.reject, "below_gross_prefilter");
});

test("unpriced charges cannot qualify", () => {
  const c = gate();
  const d = evaluateEntryDecision({ grossEdge: 3000, entryCharges: null, estimatedExitCharges: null, executionCost: 0, cfg: c });
  assert.equal(d.qualifies, false);
  assert.equal(d.reject, "unpriced_charges");
  assert.equal(d.expected_net_profit, null);
});

test("execution/slippage cost bites the decision directly", () => {
  const c = gate({ safetyBuffer: 0, minExpectedNetProfit: 1200, minGrossEdge: 1200 });
  const clean = evaluateEntryDecision({ grossEdge: 1600, entryCharges: 150, estimatedExitCharges: 150, executionCost: 0, cfg: c });
  assert.equal(clean.qualifies, true); // 1300 net
  const slipped = evaluateEntryDecision({ grossEdge: 1600, entryCharges: 150, estimatedExitCharges: 150, executionCost: 200, cfg: c });
  assert.equal(slipped.expected_net_profit, 1100);
  assert.equal(slipped.qualifies, false, "slippage alone can push it under the gate");
});

test("the legacy MIN_BOX_NET_EDGE floor raises the effective gate", () => {
  const c = gate({ minExpectedNetProfit: 1200, minNetEdge: 1500 });
  assert.equal(requiredNetProfit(c), 1500);
  const d = evaluateEntryDecision({ grossEdge: 2000, entryCharges: 150, estimatedExitCharges: 150, executionCost: 0, cfg: c });
  assert.equal(d.expected_net_profit, 2000 - 150 - 150 - 150); // 1550
  assert.equal(d.min_expected_net_profit, 1500);
  assert.equal(d.qualifies, true);
  const d2 = evaluateEntryDecision({ grossEdge: 1800, entryCharges: 150, estimatedExitCharges: 150, executionCost: 0, cfg: c });
  assert.equal(d2.expected_net_profit, 1350);
  assert.equal(d2.qualifies, false, "below the raised floor");
});

test("the default shipped gate is ₹1,200 of expected net profit", () => {
  assert.equal(requiredNetProfit(cfg()), 1200);
});


/* ------------------- Task 1: entry-slippage double counting ---------------- */

test("FINAL qualification does not deduct measured entry slippage a second time", () => {
  // Detection gross ₹2,500; latency cost ₹300 → executed gross ₹2,200. The final
  // expected net must start from ₹2,200 ONCE — the ₹300 is already inside it.
  const c = gate({ safetyBuffer: 150, minExpectedNetProfit: 1200, minGrossEdge: 1200 });
  const d = evaluateEntryDecision({
    grossEdge: 2200, // executed gross (already reflects the ₹300 adverse move)
    entryCharges: 150,
    estimatedExitCharges: 150,
    entrySlippageAllowance: 0, // never deduct entry slippage at the final gate
    futureExitSlippageAllowance: 0,
    measuredEntrySlippage: 300, // recorded as analytics, NOT deducted
    cfg: c,
  });
  // 2200 - 150 - 150 - 0 - 150 = 1750 (the ₹300 is NOT subtracted again).
  assert.equal(d.expected_net_profit, 1750);
  assert.equal(d.measured_entry_slippage, 300, "measured slippage is recorded");
  assert.equal(d.entry_slippage_allowance, 0);
  assert.equal(d.execution_cost, 0, "no allowance was deducted at the final gate");
  // The buggy double-count would have produced 1750 - 300 = 1450.
  assert.notEqual(d.expected_net_profit, 1450, "must not double-count the ₹300");
});

test("favourable entry movement improves executed gross naturally, with no artificial bonus", () => {
  const c = gate({ safetyBuffer: 150, minExpectedNetProfit: 1200, minGrossEdge: 1200 });
  // Detection gross ₹2,200; a favourable move improves executed gross to ₹2,400.
  const d = evaluateEntryDecision({
    grossEdge: 2400,
    entryCharges: 150,
    estimatedExitCharges: 150,
    entrySlippageAllowance: 0,
    futureExitSlippageAllowance: 0,
    measuredEntrySlippage: -200, // favourable (negative), analytics only
    cfg: c,
  });
  // 2400 - 150 - 150 - 150 = 1950. The favourable move helped ONLY via the higher
  // executed gross — no extra bonus is added for the negative slippage.
  assert.equal(d.expected_net_profit, 1950);
  assert.equal(d.measured_entry_slippage, -200);
});

test("the PRE-EXECUTION projection DOES deduct the expected entry-slippage allowance", () => {
  const c = gate({ safetyBuffer: 150, minExpectedNetProfit: 1200, minGrossEdge: 1200 });
  // On the DETECTION edge, a forward entry-slippage allowance is a real cost.
  const d = evaluateEntryDecision({
    grossEdge: 2500,
    entryCharges: 150,
    estimatedExitCharges: 150,
    entrySlippageAllowance: 250,
    futureExitSlippageAllowance: 250,
    cfg: c,
  });
  // 2500 - 150 - 150 - (250 + 250) - 150 = 1550.
  assert.equal(d.expected_net_profit, 1550);
  assert.equal(d.entry_slippage_allowance, 250);
  assert.equal(d.future_exit_slippage_allowance, 250);
  assert.equal(d.execution_cost, 500, "both allowances are deducted pre-execution");
  assert.equal(d.measured_entry_slippage, null, "nothing is measured yet");
});
