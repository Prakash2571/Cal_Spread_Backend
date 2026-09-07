import test from "node:test";
import assert from "node:assert/strict";

import { CentralBoxExecutionGateway } from "../../dist/box/executionGateway.js";
import { BoxExecutionSimulator } from "../../dist/box/executionSimulator.js";
import { buildCandidates, evaluateCandidate } from "../../dist/box/math.js";
import { outstandingRoles } from "../../dist/box/positions.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import {
  exactEntryFillViolation,
  singleLotCandidateViolation,
  singleLotPositionViolation,
} from "../../dist/box/singleLotInvariant.js";
import { BOX_LEG_ROLES } from "../../dist/box/types.js";
import { LOT, candidatesFor, cfg, chain, goodCandidate, quotesFor } from "./helpers.mjs";

const NOW = 1_000_000;

function withCandidateLot(candidate, lotSize) {
  return { ...candidate, lot_size: lotSize };
}

test("candidate construction fails closed when the requested scalar is two instrument lots", () => {
  const c = chain({ count: 7, lotSize: LOT });
  const candidates = buildCandidates({
    underlying: "NIFTY",
    name: "NIFTY",
    is_index: true,
    expiry: "2026-09-24",
    lot_size: LOT * 2,
    strikes: c.strikes,
    ce: c.ce,
    pe: c.pe,
  });
  assert.deepEqual(candidates, [], "75-lot contracts must never produce a 150-quantity candidate");
});

test("candidate construction rejects invalid or inconsistent contract lot metadata", () => {
  for (const invalid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const c = chain({ count: 7, lotSize: LOT });
    c.lotSize = invalid;
    assert.equal(candidatesFor(c.strikes, c).length, 0);
  }

  const c = chain({ count: 7, lotSize: LOT });
  c.ce.get(c.strikes[0]).lot_size = LOT * 2;
  const candidates = candidatesFor(c.strikes, c);
  assert.equal(
    candidates.some((candidate) => candidate.lower_strike === c.strikes[0] || candidate.upper_strike === c.strikes[0]),
    false,
    "every pair containing the inconsistent contract is removed",
  );
});

test("normal positions are exactly one lot while integer partial remainders remain valid", () => {
  const { candidate } = goodCandidate();
  const base = {
    lot_size: LOT,
    quantity: LOT,
    legs: candidate.legs,
    remaining_qty_by_role: { k1_ce: LOT, k2_ce: LOT, k2_pe: LOT, k1_pe: LOT },
  };
  assert.equal(singleLotCandidateViolation(candidate), null);
  assert.equal(singleLotPositionViolation(base), null);
  assert.equal(
    singleLotPositionViolation({
      ...base,
      remaining_qty_by_role: { k1_ce: 0, k2_ce: 35, k2_pe: LOT, k1_pe: 0 },
    }),
    null,
    "a legitimate 35-contract remainder is not rounded to a lot",
  );
  assert.match(singleLotPositionViolation({ ...base, quantity: LOT * 2 }), /must equal exactly one lot/);
  assert.match(
    singleLotPositionViolation({
      ...base,
      remaining_qty_by_role: { ...base.remaining_qty_by_role, k1_ce: LOT + 1 },
    }),
    /exceeds the one-lot maximum/,
  );
});

test("entry fills must be exactly one lot per role; overfill truth remains distinguishable", () => {
  const exact = Object.fromEntries(BOX_LEG_ROLES.map((role) => [role, LOT]));
  assert.equal(exactEntryFillViolation(LOT, exact), null);
  assert.match(exactEntryFillViolation(LOT, { ...exact, k1_ce: LOT + 1 }), /must equal exactly one lot/);
  assert.match(exactEntryFillViolation(LOT, { ...exact, k1_ce: 35 }), /must equal exactly one lot/);
});

test("exit sizing preserves authorised integer overfill truth but refuses malformed quantities", () => {
  assert.deepEqual(
    outstandingRoles({
      remaining_qty_by_role: { k1_ce: LOT + 5, k2_ce: 0, k2_pe: 35, k1_pe: 0 },
    }),
    [{ role: "k1_ce", quantity: LOT + 5 }, { role: "k2_pe", quantity: 35 }],
  );
  assert.throws(
    () => outstandingRoles({ remaining_qty_by_role: { k1_ce: 1.5, k2_ce: 0, k2_pe: 0, k1_pe: 0 } }),
    /non-negative safe integer/,
  );
});

test("paper entry boundaries refuse a malformed direct caller before waiting or placing legs", async () => {
  const { candidate } = goodCandidate();
  const malformed = withCandidateLot(candidate, LOT * 2);
  const quotes = quotesFor(candidate, {}, { at: NOW });
  const detection = evaluateCandidate({ candidate: malformed, quotes, now: NOW, maxAgeMs: 1_500 });
  let waits = 0;
  const simulator = new BoxExecutionSimulator({
    cfg: cfg({ executionMode: "paper_legging" }),
    quotes: new BoxQuoteStore(),
    isMarketOpen: () => true,
    isFeedHealthy: () => true,
    now: () => NOW,
    wait: async () => { waits++; },
  });

  const result = await simulator.simulateLeggingEntry({
    candidate: malformed,
    detection,
    qualify: () => { throw new Error("qualification must not run"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "insufficient_quantity");
  assert.match(result.detail, /single-lot entry invariant/);
  assert.equal(waits, 0);
});

test("live entry boundary refuses a malformed direct caller before durable intent submission", async () => {
  const { candidate } = goodCandidate();
  const malformed = withCandidateLot(candidate, LOT * 2);
  const quotes = quotesFor(candidate, {}, { at: NOW });
  const detection = evaluateCandidate({ candidate: malformed, quotes, now: NOW, maxAgeMs: 1_500 });
  const submissions = [];
  const violations = [];
  const manager = {
    submit: async (...args) => { submissions.push(args); throw new Error("must not submit"); },
    invariantViolation: (detail) => violations.push(detail),
    status: () => ({ inFlight: 0, queued: 0 }),
  };
  const gateway = new CentralBoxExecutionGateway({
    cfg: cfg({ executionMode: "live" }),
    simulator: {},
    quotes: new BoxQuoteStore(),
    manager,
    allocateTradeId: () => "should-not-allocate",
    now: () => NOW,
  });

  const result = await gateway.simulateLeggingEntry({
    candidate: malformed,
    detection,
    qualify: () => { throw new Error("qualification must not run"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "insufficient_quantity");
  assert.equal(submissions.length, 0);
  assert.equal(violations.length, 1);
});
