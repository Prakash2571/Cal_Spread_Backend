/**
 * RESIDUAL FLATTENING + EXIT DEPTH QUALIFICATION, against the REAL execution
 * simulator (deterministic clock, real quote store).
 *
 *  - flattenResidual submits the OPPOSITE side of what we hold, sized to the EXACT
 *    residual quantity, walks depth within the (wider) unwind limit, and returns
 *    the still-outstanding residual — so a retry never re-sends flattened quantity.
 *  - A dead feed / closed market abandons the flatten without erasing the residual.
 *  - estimateExecutableExit is the shared, non-mutating depth-aware qualifier the
 *    monitor's exit gate uses; it must permit a multi-level fill within the limit,
 *    reject a level beyond the limit, and be reduced by the queue haircut exactly
 *    as execution is.
 *  - simulateLeggingExit sizes closing orders from per-role remaining quantity, so
 *    a restored/partial position only ever works its outstanding exposure.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxExecutionSimulator } from "../../dist/box/executionSimulator.js";
import { BoxMetrics } from "../../dist/box/metrics.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { evaluateExitLegs } from "../../dist/box/math.js";
import { GOOD_BOX, LOT, cfg, goodCandidate, positionFrom } from "./helpers.mjs";

const DECISION = 20;
const LATENCY = 200;

function fakeClock(t0 = 1_000_000) {
  let nowMs = t0;
  const pending = [];
  return {
    now: () => nowMs,
    at: (ms, fn) => pending.push({ when: t0 + ms, fn }),
    wait: async (ms) => {
      const target = nowMs + Math.max(0, ms);
      pending
        .filter((p) => p.when > nowMs && p.when <= target)
        .sort((a, b) => a.when - b.when)
        .forEach((p) => {
          nowMs = p.when;
          p.fn();
        });
      nowMs = target;
    },
    base: t0,
  };
}

const flatCharge = (orders) => 20 * orders.length;

function build({ candidate, config = {}, marketOpen = true, feedHealthy = true } = {}) {
  const cand = candidate ?? goodCandidate().candidate;
  const conf = cfg({
    executionMode: "paper_legging",
    simulatedDecisionMs: DECISION,
    simulatedLatencyMs: LATENCY,
    legTimeoutMs: 500,
    legUnwindLatencyMs: 100,
    executionPollMs: 10,
    queueModel: "none",
    ...config,
  });
  const clock = fakeClock();
  const quotes = new BoxQuoteStore();
  const flags = { market: marketOpen, feed: feedHealthy };
  const sim = new BoxExecutionSimulator({
    cfg: conf,
    quotes,
    isMarketOpen: () => flags.market,
    isFeedHealthy: () => flags.feed,
    now: clock.now,
    wait: clock.wait,
    chargeTotal: flatCharge,
    metrics: new BoxMetrics(conf.metricsWindow),
  });
  return { candidate: cand, conf, clock, quotes, sim, flags };
}

/** Push a book for a token with explicit bid/ask level arrays. */
function pushBook(b, token, { bids = [], asks = [] }, at) {
  b.quotes.applyTicks(
    [{
      token,
      last_price: bids[0]?.price ?? asks[0]?.price ?? 0,
      bid: bids[0]?.price ?? 0,
      ask: asks[0]?.price ?? 0,
      bids: bids.map((l) => ({ price: l.price, qty: l.qty, orders: 1 })),
      asks: asks.map((l) => ({ price: l.price, qty: l.qty, orders: 1 })),
    }],
    at,
  );
}

/* ------------------------- flattenResidual (recovery) ---------------------- */

test("A. a residual is fully flattened when liquidity exists", async () => {
  const b = build();
  const { candidate } = goodCandidate();
  const token = candidate.legs.k1_ce.token;
  // We HOLD a long k1_ce (BUY). Flatten by SELLING into the bid.
  pushBook(b, token, { bids: [{ price: 300, qty: 150 }], asks: [{ price: 301, qty: 150 }] }, b.clock.base);
  const residual = [{ token, tradingsymbol: candidate.legs.k1_ce.tradingsymbol, role: "k1_ce", side: "BUY", quantity: LOT, average_price: 300, source: "partial_entry", created_at: b.clock.base }];

  const res = await b.sim.flattenResidual({ residual, keyPrefix: "att1" });
  assert.equal(res.flattened_by_role.k1_ce, LOT);
  assert.equal(res.remaining.length, 0, "residual fully flattened");
});

test("B. a residual that only partly fills leaves EXACTLY the remainder — and a retry re-sends only that", async () => {
  const b = build();
  const { candidate } = goodCandidate();
  const token = candidate.legs.k1_ce.token;
  // Only 40 available at the bid within the unwind limit.
  pushBook(b, token, { bids: [{ price: 300, qty: 40 }], asks: [{ price: 301, qty: 150 }] }, b.clock.base);
  const residual = [{ token, tradingsymbol: candidate.legs.k1_ce.tradingsymbol, role: "k1_ce", side: "BUY", quantity: LOT, average_price: 300, source: "partial_entry", created_at: b.clock.base }];

  const first = await b.sim.flattenResidual({ residual, keyPrefix: "att1" });
  assert.equal(first.flattened_by_role.k1_ce, 40);
  assert.equal(first.remaining.length, 1);
  assert.equal(first.remaining[0].quantity, LOT - 40, "remainder is exactly 35");

  // The retry works ONLY the remaining 35 (never the original 75 again).
  const b2 = build();
  pushBook(b2, token, { bids: [{ price: 300, qty: 150 }], asks: [{ price: 301, qty: 150 }] }, b2.clock.base);
  const second = await b2.sim.flattenResidual({ residual: first.remaining, keyPrefix: "att1" });
  assert.equal(second.legs[0].requested_qty, LOT - 40, "retry requested exactly the remainder");
  assert.equal(second.flattened_by_role.k1_ce, LOT - 40);
  assert.equal(second.remaining.length, 0);
});

test("D. a dead feed abandons the flatten without erasing the residual", async () => {
  const b = build({ feedHealthy: false });
  const { candidate } = goodCandidate();
  const token = candidate.legs.k1_ce.token;
  pushBook(b, token, { bids: [{ price: 300, qty: 150 }], asks: [{ price: 301, qty: 150 }] }, b.clock.base);
  const residual = [{ token, tradingsymbol: candidate.legs.k1_ce.tradingsymbol, role: "k1_ce", side: "BUY", quantity: LOT, average_price: 300, source: "partial_entry", created_at: b.clock.base }];

  const res = await b.sim.flattenResidual({ residual, keyPrefix: "att1" });
  assert.equal(res.flattened_by_role.k1_ce, 0, "nothing flattened with a dead feed");
  assert.equal(res.remaining.length, 1);
  assert.equal(res.remaining[0].quantity, LOT, "residual intact");
});

test("E. a closed market abandons the flatten without erasing the residual", async () => {
  const b = build({ marketOpen: false });
  const { candidate } = goodCandidate();
  const token = candidate.legs.k1_ce.token;
  pushBook(b, token, { bids: [{ price: 300, qty: 150 }], asks: [{ price: 301, qty: 150 }] }, b.clock.base);
  const residual = [{ token, tradingsymbol: candidate.legs.k1_ce.tradingsymbol, role: "k1_ce", side: "BUY", quantity: LOT, average_price: 300, source: "partial_entry", created_at: b.clock.base }];

  const res = await b.sim.flattenResidual({ residual, keyPrefix: "att1" });
  assert.equal(res.remaining[0].quantity, LOT, "residual intact when the market is shut");
});

test("a SHORT residual is flattened by BUYING back into the ask", async () => {
  const b = build();
  const { candidate } = goodCandidate();
  const token = candidate.legs.k2_ce.token;
  // We HOLD a short k2_ce (SELL). Flatten by BUYING at the ask.
  pushBook(b, token, { bids: [{ price: 219, qty: 150 }], asks: [{ price: 220, qty: 150 }] }, b.clock.base);
  const residual = [{ token, tradingsymbol: candidate.legs.k2_ce.tradingsymbol, role: "k2_ce", side: "SELL", quantity: LOT, average_price: 220, source: "failed_unwind", created_at: b.clock.base }];
  const res = await b.sim.flattenResidual({ residual, keyPrefix: "att1" });
  assert.equal(res.flattened_by_role.k2_ce, LOT);
  assert.equal(res.remaining.length, 0);
});

/* -------------------- estimateExecutableExit (exit qual) ------------------- */

/** A position whose k1_ce exit-side (bid) book we control; others fully liquid. */
function positionWithBooks(b, k1ceBids) {
  const { candidate } = goodCandidate();
  const pos = positionFrom(candidate);
  const at = b.clock.base;
  // Fully liquid books for the other three roles so only k1_ce is under test.
  for (const role of ["k2_ce", "k2_pe", "k1_pe"]) {
    const p = GOOD_BOX.prices[role];
    pushBook(b, candidate.legs[role].token, { bids: [{ price: p.bid, qty: 300 }], asks: [{ price: p.ask, qty: 300 }] }, at);
  }
  pushBook(b, candidate.legs.k1_ce.token, { bids: k1ceBids, asks: [{ price: 301, qty: 300 }] }, at);
  return pos;
}

test("depth qualification permits a MULTI-LEVEL fill within the limit", async () => {
  // Need 75; 50 @ 300.00 + 100 @ 299.95, both within the sell limit (limit 299.90).
  const b = build();
  const pos = positionWithBooks(b, [{ price: 300, qty: 50 }, { price: 299.95, qty: 100 }]);
  const est = b.sim.estimateExecutableExit(pos);
  const k1 = est.find((e) => e.role === "k1_ce");
  assert.ok(k1.executable >= LOT, `expected >= ${LOT} executable, got ${k1.executable}`);
  assert.equal(est.every((e) => e.fresh && e.executable >= e.remaining), true, "gate permits execution");
});

test("depth qualification REJECTS liquidity beyond the limit", async () => {
  // 50 @ 300.00 within limit, but the rest at 299.50 is beyond the 299.90 sell limit.
  const b = build();
  const pos = positionWithBooks(b, [{ price: 300, qty: 50 }, { price: 299.5, qty: 1000 }]);
  const est = b.sim.estimateExecutableExit(pos);
  const k1 = est.find((e) => e.role === "k1_ce");
  assert.equal(k1.executable, 50, "only the within-limit level counts");
  assert.equal(est.every((e) => e.fresh && e.executable >= e.remaining), false, "gate rejects");
});

test("the queue haircut reduces the qualification exactly as it reduces execution", async () => {
  // 100 displayed within limit; 30% haircut → 70 executable < 75 needed → reject.
  const b = build({ config: { queueModel: "haircut", queueLiquidityHaircutPct: 30 } });
  const pos = positionWithBooks(b, [{ price: 300, qty: 100 }]);
  const est = b.sim.estimateExecutableExit(pos);
  const k1 = est.find((e) => e.role === "k1_ce");
  assert.equal(k1.executable, 70, "displayed 100 → 70 after the 30% haircut");
  assert.equal(est.every((e) => e.fresh && e.executable >= e.remaining), false);
});

/* --------- simulateLeggingExit sizes from per-role remaining quantity ------ */

test("D(restart). a restored partial position works ONLY its outstanding role/qty", async () => {
  const b = build();
  const { candidate } = goodCandidate();
  const pos = positionFrom(candidate);
  // Simulate what adoptDoc restores after a restart: only k2_pe is still open.
  pos.remaining_qty_by_role = { k1_ce: 0, k2_ce: 0, k2_pe: LOT, k1_pe: 0 };
  pos.position_state = "PARTIALLY_EXITED";

  // Seed exit-side books for all roles (only k2_pe should actually be submitted).
  const at = b.clock.base;
  const detLegs = evaluateExitLegs({
    legs: ["k1_ce", "k2_ce", "k2_pe", "k1_pe"].map((role) => ({ role, inst: candidate.legs[role] })),
    quotes: (() => {
      for (const role of ["k1_ce", "k2_ce", "k2_pe", "k1_pe"]) {
        const p = GOOD_BOX.prices[role];
        pushBook(b, candidate.legs[role].token, { bids: [{ price: p.bid, qty: 300 }], asks: [{ price: p.ask, qty: 300 }] }, at);
      }
      return b.quotes.view();
    })(),
    lotSize: LOT,
    now: at,
    maxAgeMs: b.conf.quoteMaxAgeMs,
    direction: "LONG_BOX",
  });

  const res = await b.sim.simulateLeggingExit({ position: pos, detectionLegs: detLegs, detectedAt: at });
  assert.equal(res.record.submitted_leg_count, 1, "only one role submitted");
  assert.deepEqual(res.record.legs.map((l) => l.role), ["k2_pe"]);
  assert.equal(res.record.legs[0].requested_qty, LOT);
});

test("B(mixed). remaining 0/35/75/0 submits exactly two orders of 35 and 75", async () => {
  const b = build();
  const { candidate } = goodCandidate();
  const pos = positionFrom(candidate);
  pos.remaining_qty_by_role = { k1_ce: 0, k2_ce: 35, k2_pe: 75, k1_pe: 0 };
  pos.position_state = "PARTIALLY_EXITED";
  const at = b.clock.base;
  for (const role of ["k1_ce", "k2_ce", "k2_pe", "k1_pe"]) {
    const p = GOOD_BOX.prices[role];
    pushBook(b, candidate.legs[role].token, { bids: [{ price: p.bid, qty: 300 }], asks: [{ price: p.ask, qty: 300 }] }, at);
  }
  const detLegs = evaluateExitLegs({
    legs: ["k1_ce", "k2_ce", "k2_pe", "k1_pe"].map((role) => ({ role, inst: candidate.legs[role] })),
    quotes: b.quotes.view(),
    lotSize: LOT,
    now: at,
    maxAgeMs: b.conf.quoteMaxAgeMs,
    direction: "LONG_BOX",
  });
  const res = await b.sim.simulateLeggingExit({ position: pos, detectionLegs: detLegs, detectedAt: at });
  const submitted = new Map(res.record.legs.map((l) => [l.role, l.requested_qty]));
  assert.deepEqual([...submitted.entries()].sort(), [["k2_ce", 35], ["k2_pe", 75]]);
});
