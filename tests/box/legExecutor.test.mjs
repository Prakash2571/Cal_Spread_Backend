/**
 * TRUE PER-LEG EXECUTION (paper_legging).
 *
 * The point of these tests is that the four orders are NOT decided from one shared
 * snapshot at one common instant. Each has its own arrival, its own resting period,
 * its own deadline and its own fill timestamp — so legging risk becomes measurable.
 *
 * Everything is deterministic: the clock and the sleep are injected, and "market
 * data" is a script of depth packets at exact times. A packet applied to the store
 * notifies the executor synchronously, so a fill is stamped with the TICK's own
 * timestamp rather than whenever a poller looked.
 *
 * Timeline used throughout (base = clock origin):
 *   detection  base
 *   submitted  base + 20   (BOX_SIMULATED_DECISION_MS)
 *   arrival    base + 220  (+ BOX_SIMULATED_LATENCY_MS 200)
 *   deadline   base + 720  (arrival + BOX_LEG_TIMEOUT_MS 500)
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxExecutionSimulator } from "../../dist/box/executionSimulator.js";
import { BoxMetrics } from "../../dist/box/metrics.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { evaluateCandidate, evaluateEntryDecision } from "../../dist/box/math.js";
import {
  GOOD_BOX,
  LOT,
  candidatesFor,
  cfg,
  chain,
  goodCandidate,
  quote,
  quotesFor,
  seedStore,
} from "./helpers.mjs";

const DECISION = 20;
const LATENCY = 200;
const TIMEOUT = 500;
const ARRIVAL = DECISION + LATENCY; // 220 after detection
const DEADLINE = ARRIVAL + TIMEOUT; // 720 after detection

/** A deterministic clock whose sleeps fire scheduled market events in order. */
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

/** ₹20 per simulated order — enough to prove charges enter the abort P&L. */
const flatCharge = (orders) => 20 * orders.length;

function build({ candidate, marketOpen = true, feedHealthy = true, config = {} } = {}) {
  const cand = candidate ?? goodCandidate().candidate;
  const conf = cfg({
    executionMode: "paper_legging",
    simulatedDecisionMs: DECISION,
    simulatedLatencyMs: LATENCY,
    legTimeoutMs: TIMEOUT,
    legUnwindLatencyMs: 100,
    executionPollMs: 10,
    ...config,
  });
  const clock = fakeClock();
  const quotes = new BoxQuoteStore();
  const metrics = new BoxMetrics(conf.metricsWindow);
  const flags = { market: marketOpen, feed: feedHealthy };
  const sim = new BoxExecutionSimulator({
    cfg: conf,
    quotes,
    isMarketOpen: () => flags.market,
    isFeedHealthy: () => flags.feed,
    now: clock.now,
    wait: clock.wait,
    chargeTotal: flatCharge,
    metrics,
  });
  return { candidate: cand, conf, clock, quotes, sim, flags, metrics };
}

function detect(b, overrides = {}) {
  const at = b.clock.base;
  seedStore(b.quotes, quotesFor(b.candidate, overrides, { at }), at);
  return evaluateCandidate({
    candidate: b.candidate,
    quotes: b.quotes.view(),
    now: at,
    maxAgeMs: b.conf.quoteMaxAgeMs,
    captureDepth: false,
  });
}

/** Publish one leg's book at an exact time. */
function pushLeg(b, role, spec, at) {
  const token = b.candidate.legs[role].token;
  const q = quote(token, { ...spec, at });
  b.quotes.applyTicks(
    [{ token, last_price: q.last, bid: q.bid, ask: q.ask, bids: q.bids, asks: q.asks }],
    at,
  );
}

/** The side each entry leg needs: BUY wants an ask, SELL wants a bid. */
const SELL_LEGS = ["k2_ce", "k1_pe"];

/** A book that cannot fill `role` (its needed side is empty). */
function unfillable(role) {
  return SELL_LEGS.includes(role)
    ? { bid: 0, bidQty: 0, ask: 999, askQty: 150 }
    : { bid: 1, bidQty: 150, ask: 0, askQty: 0 };
}

/** A book with the needed side present but only `qty` resting (thin). */
function thin(role, qty = 1) {
  const p = GOOD_BOX.prices[role];
  return SELL_LEGS.includes(role)
    ? { bid: p.bid, bidQty: qty, ask: p.ask, askQty: 150 }
    : { bid: p.bid, bidQty: 150, ask: p.ask, askQty: qty };
}

/** A book that fills `role` at its normal price. */
function fillable(role) {
  return { ...GOOD_BOX.prices[role], bidQty: 150, askQty: 150 };
}

function qualify(conf, over = {}) {
  const { entryCharges = 150, min = 1200 } = over;
  return (execution, measuredSlippage) =>
    evaluateEntryDecision({
      grossEdge: execution.gross_edge,
      entryCharges,
      estimatedExitCharges: 150,
      entrySlippageAllowance: 0,
      futureExitSlippageAllowance: 0,
      measuredEntrySlippage: measuredSlippage,
      cfg: { ...conf, safetyBuffer: 150, minExpectedNetProfit: min, minGrossEdge: 1200, minNetEdge: 0 },
    });
}

const run = (b, over) =>
  b.sim.simulateLeggingEntry({
    candidate: b.candidate,
    detection: detect(b),
    qualify: qualify(b.conf, over),
  });

const legOf = (res, role) => res.legging.legs.find((l) => l.role === role);
const relative = (b, t) => (t === null || t === undefined ? null : t - b.clock.base);

/* ------------------------------ 1. clean 4/4 ------------------------------- */

test("1. all four orders fill at arrival from the books already resting", async () => {
  const b = build();
  const res = await run(b);
  assert.equal(res.ok, true);
  assert.equal(res.legging.filled_leg_count, 4);
  for (const leg of res.legging.legs) {
    assert.equal(leg.status, "FILLED");
    assert.equal(relative(b, leg.submit_at), DECISION);
    assert.equal(relative(b, leg.arrival_at), ARRIVAL);
    assert.equal(relative(b, leg.fill_at), ARRIVAL, `${leg.role} must fill at its own arrival`);
    assert.equal(leg.fill_qty, LOT);
    assert.equal(leg.remaining_qty, 0);
    assert.ok(leg.quote_version > 0, "the exact book version is recorded");
    assert.equal(leg.book_at, b.clock.base);
  }
  // Same instant for all four → zero dispersion, and no unhedged window.
  assert.equal(res.legging.first_to_last_fill_ms, 0);
  assert.equal(res.legging.exposure_duration_ms, 0);
});

/* -------------------- 2. four legs, four different fills ------------------- */

test("2. four legs fill at four DIFFERENT timestamps (no common snapshot)", async () => {
  const b = build();
  const detection = detect(b);
  // None can fill at arrival...
  b.clock.at(100, () => {
    for (const role of ["k1_ce", "k2_ce", "k2_pe", "k1_pe"]) {
      pushLeg(b, role, unfillable(role), b.clock.now());
    }
  });
  // ...then each becomes executable at its own moment.
  const when = { k1_ce: 250, k2_pe: 300, k2_ce: 350, k1_pe: 400 };
  for (const [role, ms] of Object.entries(when)) {
    b.clock.at(ms, () => pushLeg(b, role, fillable(role), b.clock.now()));
  }

  const res = await b.sim.simulateLeggingEntry({
    candidate: b.candidate,
    detection,
    qualify: qualify(b.conf),
  });

  assert.equal(res.legging.filled_leg_count, 4);
  for (const [role, ms] of Object.entries(when)) {
    assert.equal(relative(b, legOf(res, role).fill_at), ms, `${role} filled at the wrong instant`);
  }
  // Each leg rested from arrival until its own fill.
  assert.equal(relative(b, legOf(res, "k1_pe").pending_since), ARRIVAL);
  assert.equal(res.legging.first_to_last_fill_ms, 400 - 250);
  assert.equal(res.legging.decision_to_first_fill_ms, 250);
  assert.equal(res.legging.decision_to_last_fill_ms, 400);
});

/* ------------------ 3. thin at arrival, fills on a later tick -------------- */

test("3. a leg that is thin at arrival stays PENDING and fills on a later update", async () => {
  const b = build();
  const detection = detect(b);
  b.clock.at(100, () => pushLeg(b, "k1_ce", thin("k1_ce", 1), b.clock.now()));
  b.clock.at(310, () => pushLeg(b, "k1_ce", fillable("k1_ce"), b.clock.now()));

  const res = await b.sim.simulateLeggingEntry({
    candidate: b.candidate,
    detection,
    qualify: qualify(b.conf),
  });

  assert.equal(res.legging.filled_leg_count, 4);
  const late = legOf(res, "k1_ce");
  assert.equal(relative(b, late.pending_since), ARRIVAL, "it rested rather than failing");
  assert.equal(relative(b, late.fill_at), 310);
  // The other three filled at arrival, so the box was one-sided for 90ms.
  assert.equal(res.legging.first_to_last_fill_ms, 310 - ARRIVAL);
  assert.equal(res.legging.exposure_duration_ms, 90);
});

/* ---------------------------- 4. real timeout ------------------------------ */

test("4. a leg that never gets a full lot TIMES OUT at arrival + BOX_LEG_TIMEOUT_MS", async () => {
  const b = build();
  const detection = detect(b);
  // Permanently thin: quantity never reaches one lot.
  b.clock.at(100, () => pushLeg(b, "k1_pe", thin("k1_pe", 5), b.clock.now()));

  const res = await b.sim.simulateLeggingEntry({
    candidate: b.candidate,
    detection,
    qualify: qualify(b.conf),
  });

  const timedOut = legOf(res, "k1_pe");
  assert.equal(timedOut.status, "TIMED_OUT");
  assert.equal(relative(b, timedOut.timeout_at), DEADLINE, "deadline is ARRIVAL-relative");
  assert.equal(relative(b, timedOut.resolved_at), DEADLINE);
  assert.equal(timedOut.fill_at, null);
  assert.match(timedOut.fail_reason, /unfilled 500ms after arriving/);
  assert.deepEqual(res.legging.timed_out_legs, ["k1_pe"]);
  assert.equal(res.legging.filled_leg_count, 3);
  assert.equal(b.metrics.snapshot().legging.leg_timeouts, 1);
});

/* ------------------------ 5-7. partial fills unwind ------------------------ */

for (const [failRoles, expectFilled] of [
  [["k1_pe"], 3],
  [["k1_pe", "k2_ce"], 2],
  [["k1_pe", "k2_ce", "k2_pe"], 1],
]) {
  test(`${8 - expectFilled}. ${expectFilled}/4 fill → the filled legs are emergency-unwound`, async () => {
    const b = build();
    const detection = detect(b);
    b.clock.at(100, () => {
      for (const role of failRoles) pushLeg(b, role, unfillable(role), b.clock.now());
    });

    const res = await b.sim.simulateLeggingEntry({
      candidate: b.candidate,
      detection,
      qualify: qualify(b.conf),
    });

    assert.equal(res.ok, false);
    assert.equal(res.legging.filled_leg_count, expectFilled);
    assert.equal(res.legging.opened, false);
    assert.equal(res.legging.emergency_unwind, true);
    assert.equal(res.legging.legs.filter((l) => l.status === "UNWOUND").length, expectFilled);
    assert.ok(res.legging.partial_entry_charges > 0);
    assert.ok(res.legging.unwind_charges > 0);
    assert.ok(res.legging.legging_net_loss < 0, "an abort always costs money");
    // Exposure ran from the first fill until the unwind completed.
    assert.ok(res.legging.exposure_duration_ms >= TIMEOUT, "exposure spans the wait + unwind");
  });
}

/* ------------------------- 8. resting-book rule ---------------------------- */

test("8. an unchanged resting book fills at arrival — no post-arrival tick required", async () => {
  const b = build();
  const detection = detect(b); // seeded once at base; nothing scheduled afterwards
  const res = await b.sim.simulateLeggingEntry({
    candidate: b.candidate,
    detection,
    qualify: qualify(b.conf),
  });
  assert.equal(res.legging.filled_leg_count, 4);
  for (const leg of res.legging.legs) {
    assert.equal(relative(b, leg.fill_at), ARRIVAL);
    // The book was 220ms old and still perfectly valid.
    assert.equal(leg.book_age_ms, ARRIVAL);
  }
});

/* ------------------ 9-10. pre-arrival moves and the LIMIT ------------------ */

test("9. an adverse move WITHIN the chase limit fills at that (worse) price", async () => {
  // Default chase is 2 ticks × ₹0.05 = ₹0.10, so a BUY reference of ₹300 has a
  // limit of ₹300.10. A move to exactly the limit is executable.
  const b = build();
  const detection = detect(b);
  b.clock.at(100, () => pushLeg(b, "k1_ce", { bid: 300, bidQty: 150, ask: 300.1, askQty: 150 }, b.clock.now()));
  const res = await b.sim.simulateLeggingEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  const leg = legOf(res, "k1_ce");
  assert.equal(leg.status, "FILLED");
  assert.equal(leg.fill_price, 300.1, "fills at the within-limit price");
  assert.equal(leg.slippage, Math.round((300.1 - GOOD_BOX.prices.k1_ce.ask) * LOT * 100) / 100);
});

test("9b. an adverse move BEYOND the chase limit is REFUSED — the order does not chase", async () => {
  // A runaway move (₹300 → ₹305, 100 ticks) is far past the ₹300.10 limit. The
  // order must NOT consume it (that is the market-order behaviour we removed); it
  // rests and, with no better price arriving, times out — so the box does not
  // fill 4/4.
  const b = build();
  const detection = detect(b);
  b.clock.at(100, () => pushLeg(b, "k1_ce", { bid: 304, bidQty: 150, ask: 305, askQty: 150 }, b.clock.now()));
  const res = await b.sim.simulateLeggingEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  const leg = legOf(res, "k1_ce");
  assert.notEqual(leg.status, "FILLED", "a price beyond the limit must not fill");
  assert.equal(leg.fill_qty, 0);
  assert.equal(res.ok, false, "the box cannot open with a leg stuck past its limit");
  assert.ok(res.legging.failed_legs.includes("k1_ce"));
});

test("10. a FAVOURABLE update before arrival is the price that fills", async () => {
  const b = build();
  const detection = detect(b);
  b.clock.at(100, () => pushLeg(b, "k1_ce", { bid: 289, bidQty: 150, ask: 290, askQty: 150 }, b.clock.now()));
  const res = await b.sim.simulateLeggingEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  const leg = legOf(res, "k1_ce");
  assert.equal(leg.fill_price, 290);
  assert.ok(leg.slippage < 0, "a better price is negative slippage");
});

/* ---------------- 11. adverse move while PENDING is respected -------------- */

test("11. a leg that fills while PENDING uses the book at THAT moment (within the limit)", async () => {
  const b = build();
  const detection = detect(b);
  b.clock.at(100, () => pushLeg(b, "k1_ce", thin("k1_ce", 1), b.clock.now()));
  // It becomes executable later at a within-limit worse price (₹300 → ₹300.10).
  b.clock.at(320, () => pushLeg(b, "k1_ce", { bid: 300, bidQty: 150, ask: 300.1, askQty: 150 }, b.clock.now()));

  const res = await b.sim.simulateLeggingEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  const leg = legOf(res, "k1_ce");
  assert.equal(relative(b, leg.fill_at), 320);
  assert.equal(leg.fill_price, 300.1);
  assert.equal(leg.book_at, b.clock.base + 320, "the fill book is the one from that tick");
  assert.ok(leg.slippage > 0);
});

/* ------------------- 12-14. the world changes mid-flight ------------------- */

test("12. the feed going unhealthy while orders rest abandons them (fills are kept)", async () => {
  const b = build();
  const detection = detect(b);
  b.clock.at(100, () => {
    for (const role of ["k1_ce", "k2_ce", "k2_pe", "k1_pe"]) pushLeg(b, role, unfillable(role), b.clock.now());
  });
  b.clock.at(300, () => {
    b.flags.feed = false;
  });

  const res = await b.sim.simulateLeggingEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "feed_unhealthy");
  assert.equal(res.legging.filled_leg_count, 0);
  assert.ok(res.legging.legs.every((l) => l.status === "FAILED"));
});

test("13. the market closing while orders rest abandons them", async () => {
  const b = build();
  const detection = detect(b);
  b.clock.at(100, () => {
    for (const role of ["k1_ce", "k2_ce", "k2_pe", "k1_pe"]) pushLeg(b, role, unfillable(role), b.clock.now());
  });
  b.clock.at(300, () => {
    b.flags.market = false;
  });

  const res = await b.sim.simulateLeggingEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "market_closed");
});

test("14. STOP while an entry is working abandons the remaining orders", async () => {
  const b = build();
  const detection = detect(b);
  let wanted = true;
  b.clock.at(100, () => {
    for (const role of ["k1_ce", "k2_ce", "k2_pe", "k1_pe"]) pushLeg(b, role, unfillable(role), b.clock.now());
  });
  b.clock.at(300, () => {
    wanted = false;
  });

  const res = await b.sim.simulateLeggingEntry({
    candidate: b.candidate,
    detection,
    qualify: qualify(b.conf),
    stillWanted: () => wanted,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "discovery_stopped");
});

/* ---------------------------- 15. no duplicates ---------------------------- */

test("15. the same candidate cannot spawn two sets of orders at once", async () => {
  const b = build();
  const detection = detect(b);
  const first = b.sim.simulateLeggingEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  const second = await b.sim.simulateLeggingEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "duplicate");
  assert.equal(second.legging.legs.length, 0, "no orders were created for the duplicate");
  const done = await first;
  assert.equal(done.legging.filled_leg_count, 4, "the original run is unaffected");
});

/* ------------- 16. 4/4 fills, economics fail → full abort unwind ----------- */

test("16. 4/4 filled at different times but the executed net fails → whole box reversed", async () => {
  const b = build();
  const detection = detect(b);
  b.clock.at(100, () => pushLeg(b, "k2_pe", thin("k2_pe", 1), b.clock.now()));
  b.clock.at(300, () => pushLeg(b, "k2_pe", fillable("k2_pe"), b.clock.now()));

  const res = await b.sim.simulateLeggingEntry({
    candidate: b.candidate,
    detection,
    qualify: qualify(b.conf, { entryCharges: 900 }), // net 675 < 1200
  });

  assert.equal(res.ok, false);
  assert.equal(res.reason, "abort_after_fill");
  assert.equal(res.legging.filled_leg_count, 4);
  assert.equal(res.legging.abort_after_fill, true);
  assert.equal(res.legging.opened, false);
  assert.equal(res.legging.legs.filter((l) => l.status === "UNWOUND").length, 4);
  assert.ok(res.legging.legging_net_loss < 0);
  // Exposure began at the first fill and ended with the unwind, so it exceeds the
  // 80ms the box was merely incomplete.
  assert.ok(res.legging.exposure_duration_ms > 80);
});

/* ----------------------------- 17. SHORT_BOX ------------------------------ */

test("17. SHORT_BOX submits the mirrored per-leg sides", async () => {
  const c = chain();
  const all = candidatesFor([19700, 19800, 19900, 20000, 20100, 20200, 20300], c, {
    directions: ["SHORT_BOX"],
  });
  const short = all.find((x) => x.lower_strike === GOOD_BOX.k1 && x.upper_strike === GOOD_BOX.k2);
  assert.ok(short, "fixture: short candidate not found");

  const b = build({ candidate: short });
  const res = await run(b);

  // A short box is the exact opposite of a long one on every leg.
  assert.equal(legOf(res, "k1_ce").side, "SELL");
  assert.equal(legOf(res, "k2_ce").side, "BUY");
  assert.equal(legOf(res, "k2_pe").side, "SELL");
  assert.equal(legOf(res, "k1_pe").side, "BUY");
  assert.equal(res.legging.filled_leg_count, 4);
  // Each leg filled against the side it actually needs.
  assert.equal(legOf(res, "k1_ce").fill_price, GOOD_BOX.prices.k1_ce.bid);
  assert.equal(legOf(res, "k2_ce").fill_price, GOOD_BOX.prices.k2_ce.ask);
});

/* -------------------- 18-19. exact timing arithmetic ---------------------- */

test("18. first_to_last_fill_ms is max(fill_at) − min(fill_at), not latency", async () => {
  const b = build();
  const detection = detect(b);
  b.clock.at(100, () => pushLeg(b, "k1_pe", thin("k1_pe", 1), b.clock.now()));
  b.clock.at(430, () => pushLeg(b, "k1_pe", fillable("k1_pe"), b.clock.now()));

  const res = await b.sim.simulateLeggingEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  const fills = res.legging.legs.map((l) => l.fill_at);
  assert.equal(res.legging.first_to_last_fill_ms, Math.max(...fills) - Math.min(...fills));
  assert.equal(res.legging.first_to_last_fill_ms, 430 - ARRIVAL);
  // Explicitly NOT the detection-relative figure.
  assert.notEqual(res.legging.first_to_last_fill_ms, res.legging.decision_to_last_fill_ms);
  assert.equal(res.legging.decision_to_last_fill_ms, 430);
});

test("19. exposure_duration_ms is exposure_ended_at − exposure_started_at", async () => {
  const b = build();
  const detection = detect(b);
  b.clock.at(100, () => pushLeg(b, "k2_ce", thin("k2_ce", 1), b.clock.now()));
  b.clock.at(500, () => pushLeg(b, "k2_ce", fillable("k2_ce"), b.clock.now()));

  const res = await b.sim.simulateLeggingEntry({ candidate: b.candidate, detection, qualify: qualify(b.conf) });
  const r = res.legging;
  assert.equal(relative(b, r.exposure_started_at), ARRIVAL, "starts at the FIRST fill");
  assert.equal(relative(b, r.exposure_ended_at), 500, "ends when the box completes");
  assert.equal(r.exposure_duration_ms, r.exposure_ended_at - r.exposure_started_at);
  assert.equal(r.exposure_duration_ms, 500 - ARRIVAL);
});

/* --------------------------- 20. deterministic replay --------------------- */

test("20. replaying the same event stream reproduces identical fills and P&L", async () => {
  const script = (b) => {
    b.clock.at(100, () => {
      pushLeg(b, "k1_pe", unfillable("k1_pe"), b.clock.now());
      pushLeg(b, "k2_ce", thin("k2_ce", 2), b.clock.now());
    });
    b.clock.at(340, () => pushLeg(b, "k2_ce", fillable("k2_ce"), b.clock.now()));
  };
  const once = async () => {
    const b = build();
    const detection = detect(b);
    script(b);
    const res = await b.sim.simulateLeggingEntry({
      candidate: b.candidate,
      detection,
      qualify: qualify(b.conf),
    });
    return {
      reason: res.reason ?? null,
      filled: res.legging.filled_leg_count,
      legs: res.legging.legs.map((l) => ({
        role: l.role,
        status: l.status,
        fill_at: relative(b, l.fill_at),
        fill_price: l.fill_price,
        unwind_price: l.unwind_price,
        slippage: l.slippage,
      })),
      first_to_last: res.legging.first_to_last_fill_ms,
      exposure: res.legging.exposure_duration_ms,
      gross: res.legging.legging_gross_loss,
      net: res.legging.legging_net_loss,
    };
  };

  const a = await once();
  const c = await once();
  assert.deepEqual(a, c, "the same recorded market must produce byte-identical results");
  // And it is a meaningful scenario, not a trivially empty one.
  assert.equal(a.filled, 3);
  assert.ok(a.net < 0);
});
