/**
 * REGRESSION TESTS FOR THE DEEP-REVIEW DEFECTS.
 *
 * Each test here fails against the code as it stood before the accompanying fix.
 * They are grouped by the defect they pin, and each states the consequence it
 * guards against, because a regression test whose purpose is not written down gets
 * "fixed" by deleting it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { evaluateCandidateIndicative, exitSideFor } from "../../dist/box/math.js";
import { BoxPositionMonitor } from "../../dist/box/positionMonitor.js";
import { BoxPositionBook, outstandingRoles } from "../../dist/box/positions.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import {
  cfg,
  exitQuotes,
  goodCandidate,
  localChargesStub,
  positionFrom,
  seedStore,
} from "./helpers.mjs";

const NOW = 1_700_000_000_000;
const ROLES = ["k1_ce", "k2_ce", "k2_pe", "k1_pe"];

/* ══════════════════════════════════════════════════════════════════════════
   DEFECT 1 — the market-closed view could never show a profitable SHORT box.

   The plausibility band was `0 < value < width`, which is not a coherence test
   but a "the LONG box is profitable" test. Because the four entry sides mirror
   by direction, the implied box VALUE is identical for both directions, so the
   band admitted every long-box edge and rejected every profitable short one.
   ══════════════════════════════════════════════════════════════════════════ */

/** Last-close prices producing a given implied long-box value for one candidate. */
function closesForValue(candidate, value) {
  // value = k1_ce − k2_ce + k2_pe − k1_pe  (what establishing the long box costs)
  return new Map([
    [candidate.legs.k1_ce.token, 100 + value],
    [candidate.legs.k2_ce.token, 100],
    [candidate.legs.k2_pe.token, 50],
    [candidate.legs.k1_pe.token, 50],
  ]);
}

test("D1: a short box whose implied value EXCEEDS the width shows its real edge", () => {
  const { candidate } = goodCandidate();
  const short = { ...candidate, direction: "SHORT_BOX" };
  const width = short.box_width;

  // Value above the width is precisely where shorting the box is the arbitrage:
  // you take in more than settling it can ever cost.
  const ev = evaluateCandidateIndicative({
    candidate: short,
    lastPrices: closesForValue(short, width + 40),
    now: NOW,
  });

  assert.equal(ev.reject, "market_closed", "coherent prices must not be rejected as implausible");
  assert.notEqual(ev.gross_edge, null, "a profitable short box must not be silently suppressed");
  assert.equal(ev.gross_edge_per_unit, 40, "edge per unit = value − width for a short box");
  assert.equal(ev.gross_edge, 40 * short.lot_size);
  assert.equal(ev.tradable, false, "still never tradable: these are closing prices");
});

test("D1: long and short boxes are mirror images of equal magnitude", () => {
  const { candidate } = goodCandidate();
  const width = candidate.box_width;

  const below = evaluateCandidateIndicative({
    candidate: { ...candidate, direction: "LONG_BOX" },
    lastPrices: closesForValue(candidate, width - 40),
    now: NOW,
  });
  const above = evaluateCandidateIndicative({
    candidate: { ...candidate, direction: "SHORT_BOX" },
    lastPrices: closesForValue(candidate, width + 40),
    now: NOW,
  });

  assert.equal(below.gross_edge_per_unit, 40, "long box profits below fair value");
  assert.equal(above.gross_edge_per_unit, 40, "short box profits above it, by the same amount");
  assert.equal(below.reject, "market_closed");
  assert.equal(above.reject, "market_closed");
});

test("D1: the band still rejects incoherent closes, in BOTH directions", () => {
  const { candidate } = goodCandidate();
  const width = candidate.box_width;
  // Zero edge (value = width), an edge as large as the whole width (value = 0), and
  // edges far beyond it. A NEGATIVE implied value is covered in math.test.mjs, where
  // it surfaces as `no_quote` because the constructed leg prices go negative.
  for (const direction of ["LONG_BOX", "SHORT_BOX"]) {
    const c = { ...candidate, direction };
    for (const value of [0, width, 2 * width, 5 * width]) {
      const ev = evaluateCandidateIndicative({ candidate: c, lastPrices: closesForValue(c, value), now: NOW });
      assert.equal(ev.gross_edge, null, `${direction} value ${value} must yield no edge`);
      assert.equal(ev.entry_box_cost_per_unit, null);
      assert.equal(ev.reject, "implausible_close");
    }
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   DEFECT 2 — an unguarded `persistPartialExit`. The store REJECTS on a socket
   error, and the rejection escaped, skipping the quarantine. The position kept
   claiming full quantity on roles the broker had already closed, so the next
   cycle re-closed an already-flat role: reverse exposure.

   DEFECT 3 — a confirmed exit fill with NO price defaulted to 0, fabricating
   ±entryPrice × qty of realised P&L and pricing that leg's charges on ₹0 of
   turnover.
   ══════════════════════════════════════════════════════════════════════════ */

/** A representative exit price per role (the side each leg closes at). */
const EXIT_PRICE = { k1_ce: 299, k2_ce: 221, k2_pe: 199, k1_pe: 106 };

/**
 * A legging-exit simulator closing a scripted quantity per role per call, in the
 * exact result shape the monitor consumes (top-level `legs` plus a `record`).
 *
 * `priceless` reproduces a broker reporting filled quantity with no usable price.
 */
function scriptedSim({ plan, priceless = false }) {
  const submissions = [];
  const invariantViolations = [];
  let call = 0;
  const build = (position) => {
    const outstanding = outstandingRoles(position);
    const closeMap = plan[Math.min(call, plan.length - 1)] ?? {};
    call++;
    submissions.push(outstanding.map((o) => ({ role: o.role, quantity: o.quantity })));
    const legs = [];
    const fills_by_role = {};
    let fullyClosed = 0;
    for (const { role, quantity } of outstanding) {
      const closed = closeMap[role] ?? 0;
      fills_by_role[role] = closed;
      if (closed > 0) {
        legs.push({
          role,
          side: exitSideFor(role, "LONG_BOX"),
          token: position.legs[role].token,
          tradingsymbol: position.legs[role].tradingsymbol,
          strike: 0,
          instrument_type: role.endsWith("_ce") ? "CE" : "PE",
          price: priceless ? null : EXIT_PRICE[role],
          qty_at_touch: closed,
          bid: 0, bid_qty: 0, ask: 0, ask_qty: 0,
          quote_at: null, quote_version: null, depth: null, age_ms: null,
          fresh: true, executable: true,
        });
        if (closed === quantity) fullyClosed++;
      }
    }
    const submitted = outstanding.length;
    const record = {
      mode: "paper_legging",
      detected_at: Date.now(),
      order_sent_at: Date.now(),
      fills_by_role,
      submitted_leg_count: submitted,
      fully_closed_role_count: fullyClosed,
      remaining_role_count: submitted - fullyClosed,
      residual_exposure: [],
      legs: legs.map((l) => ({ order_id: `o:${l.role}:${call}` })),
    };
    const ok = submitted > 0 && fullyClosed === submitted;
    return ok
      ? { ok: true, legs, record, booksAtFill: new Map() }
      : { ok: false, legs, record, reason: "legging_incomplete", detail: "partial", booksAtFill: new Map() };
  };
  return {
    submissions,
    invariantViolations,
    invariantViolation: (reason) => invariantViolations.push(reason),
    simulateLeggingExit: async ({ position }) => build(position),
    estimateExecutableExit: (position) =>
      outstandingRoles(position).map(({ role, quantity }) => ({
        role,
        side: exitSideFor(role, "LONG_BOX"),
        remaining: quantity,
        executable: quantity,
        fresh: true,
      })),
    simulateExit: async () => ({ ok: false, reason: "insufficient_quantity", detail: "n/a", record: {} }),
  };
}

function monitorWith({ plan, persistPartialExit, priceless = false }) {
  const { candidate } = goodCandidate();
  const conf = cfg({ executionMode: "paper_legging" });
  const now = Date.now();
  const quotes = new BoxQuoteStore();
  seedStore(quotes, exitQuotes(candidate, 198, { at: now, qty: 150 }), now);

  const positions = new BoxPositionBook();
  const position = positionFrom(candidate, { opened_at: now - 60_000, last_persist_at: now });
  positions.add(position);

  const sim = scriptedSim({ plan, priceless });
  const closes = [];
  const partials = [];
  const monitor = new BoxPositionMonitor({
    cfg: conf,
    quotes,
    localCharges: localChargesStub({ entryTotal: 150, exitTotal: 150 }),
    executionSim: sim,
    positions,
    closePaperTrade: async (args) => {
      closes.push(args);
      positions.remove(args.position.id);
      return true;
    },
    persistPartialExit:
      persistPartialExit ??
      (async (args) => {
        partials.push(args);
        return true;
      }),
    persistLive: async () => {},
    onEvent: () => {},
    istDayKey: () => "2026-08-29",
    istMinutesOfDay: () => 11 * 60,
    isMarketOpen: () => true,
    isFeedHealthy: () => true,
  });
  return { monitor, positions, position, sim, closes, partials };
}

test("D2: a REJECTING partial-exit store never lets the monitor cycle throw", async () => {
  const h = monitorWith({
    plan: [{ k1_ce: 75, k2_pe: 75 }],
    persistPartialExit: async () => {
      throw new Error("connection closed");
    },
  });
  // Before the fix this rejection escaped applyLeggingExitResult entirely.
  await h.monitor.cycle();
  assert.equal(h.closes.length, 0, "nothing was closed");
});

test("D2: a rejected partial persist quarantines instead of banking the fill", async () => {
  const h = monitorWith({
    plan: [{ k1_ce: 75, k2_pe: 75 }],
    persistPartialExit: async () => {
      throw new Error("connection closed");
    },
  });
  await h.monitor.cycle();

  const pos = h.positions.get(h.position.id);
  assert.ok(pos, "the position is retained, never dropped");
  assert.equal(pos.position_state, "RECOVERY", "an unpersisted confirmed fill must quarantine");
  assert.ok(
    h.sim.invariantViolations.some((v) => /awaits durable persistence/.test(v)),
    `the invariant hook must be told (got ${JSON.stringify(h.sim.invariantViolations)})`,
  );
  // The critical assertion: quantities must NOT advance on a write that never landed.
  for (const role of ROLES) {
    assert.equal(pos.remaining_qty_by_role[role], 75, `${role} quantity unchanged`);
  }
});

test("D2: a rejected persist never re-closes an already-flat role", async () => {
  let calls = 0;
  const h = monitorWith({
    plan: [{ k1_ce: 75, k2_pe: 75 }],
    persistPartialExit: async () => {
      calls++;
      if (calls === 1) throw new Error("connection closed");
      return true;
    },
  });

  await h.monitor.cycle();
  assert.deepEqual(
    h.sim.submissions[0].map((s) => s.role).sort(),
    [...ROLES].sort(),
    "the first attempt works all four roles",
  );

  // Let the queued retry run and make the decrement authoritative.
  h.position.last_exit_attempt_at = 0;
  await h.monitor.cycle();

  const pos = h.positions.get(h.position.id);
  if (pos) {
    assert.equal(pos.remaining_qty_by_role.k1_ce, 0, "k1_ce is recorded flat once persisted");
    assert.equal(pos.remaining_qty_by_role.k2_pe, 0, "k2_pe is recorded flat once persisted");
    // Any subsequent submission must contain only genuinely outstanding roles.
    for (const submission of h.sim.submissions.slice(1)) {
      for (const { role } of submission) {
        assert.ok(
          pos.remaining_qty_by_role[role] > 0,
          `${role} was re-submitted although it is already flat`,
        );
      }
    }
  }
});

test("D3: a confirmed fill with no price is refused, not valued at zero", async () => {
  const h = monitorWith({ plan: [{ k1_ce: 75 }], priceless: true });
  await h.monitor.cycle();

  assert.ok(
    h.sim.invariantViolations.some((v) => /no usable price/.test(v)),
    `the contradiction must be reported (got ${JSON.stringify(h.sim.invariantViolations)})`,
  );

  // Nothing may be banked from a priceless fill. The fabricated figure would have
  // been ±entryPrice × 75 — of the order of ₹20,000+.
  for (const p of h.partials) {
    for (const attempt of p.position.exit_attempts) {
      assert.ok(
        Math.abs(attempt.gross_pnl ?? 0) < 5_000,
        `a priceless fill must not fabricate P&L (got ${attempt.gross_pnl})`,
      );
    }
  }
  const pos = h.positions.get(h.position.id);
  if (pos) {
    assert.equal(pos.remaining_qty_by_role.k1_ce, 75, "the refused quantity stays outstanding");
  }
});
