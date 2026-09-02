/**
 * PARTIAL-EXIT LIFECYCLE + MANUAL CLOSE (paper_legging).
 *
 * The core invariant under test: a simulated fill is irreversible. A partial exit
 * decrements EXACT per-role remaining quantity, is persisted before the execution
 * is treated as clean, never re-closes a flat role, never creates reverse exposure,
 * and the box is CLOSED only when every role is flat. Manual and automatic closes
 * share one code path and differ only in the exit reason.
 *
 * The executor is a controllable FAKE so the monitor's accounting can be driven
 * deterministically (the real depth-walking executor is exercised in
 * legFills.test.mjs / execution.test.mjs). The monitor logic under test —
 * applyLeggingExitResult, per-role decrement, over-close guard, cumulative
 * accounting, close-only-when-flat, manual honest return — is the REAL code.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxPositionMonitor } from "../../dist/box/positionMonitor.js";
import { BoxPositionBook, outstandingRoles } from "../../dist/box/positions.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { exitSideFor } from "../../dist/box/math.js";
import {
  GOOD_BOX,
  LOT,
  cfg,
  exitQuotes,
  goodCandidate,
  localChargesStub,
  positionFrom,
  seedStore,
} from "./helpers.mjs";

const ROLES = ["k1_ce", "k2_ce", "k2_pe", "k1_pe"];
/** A representative exit price per role (the side each leg closes at). */
const EXIT_PRICE = { k1_ce: 299, k2_ce: 221, k2_pe: 199, k1_pe: 106 };

/**
 * A fake execution simulator whose legging exit closes a scripted quantity per
 * role per attempt. Records the roles/quantities it was ASKED to close each call,
 * so a test can prove a retry only ever submits the outstanding exposure.
 */
function fakeSim({ plan, executable } = {}) {
  const submissions = []; // one entry per simulateLeggingExit call
  let call = 0;
  const buildResult = (position) => {
    const outstanding = outstandingRoles(position);
    const closeMap = plan[Math.min(call, plan.length - 1)] ?? {};
    call++;
    submissions.push(outstanding.map((o) => ({ role: o.role, quantity: o.quantity })));
    const legs = [];
    const fills_by_role = {};
    let fullyClosed = 0;
    for (const { role, quantity } of outstanding) {
      const closed = Math.min(quantity, closeMap[role] ?? 0);
      fills_by_role[role] = closed;
      if (closed > 0) {
        legs.push({
          role,
          side: exitSideFor(role, "LONG_BOX"),
          token: position.legs[role].token,
          tradingsymbol: position.legs[role].tradingsymbol,
          strike: 0,
          instrument_type: role.endsWith("_ce") ? "CE" : "PE",
          price: EXIT_PRICE[role],
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
    simulateLeggingExit: async ({ position }) => buildResult(position),
    estimateExecutableExit: (position) =>
      outstandingRoles(position).map(({ role, quantity }) => ({
        role,
        side: exitSideFor(role, "LONG_BOX"),
        remaining: quantity,
        executable: executable ?? quantity,
        fresh: true,
      })),
    // Not used on this path, but present for safety.
    simulateExit: async () => ({ ok: false, reason: "insufficient_quantity", detail: "n/a", record: {} }),
  };
}

function harness({ plan = [{}], executable, exitValuePerUnit = 198, config = {} } = {}) {
  const { candidate } = goodCandidate();
  const conf = cfg({ executionMode: "paper_legging", ...config });
  const now = Date.now();
  const quotes = new BoxQuoteStore();
  // A converged, comfortably profitable exit book so the exit rule fires.
  seedStore(quotes, exitQuotes(candidate, exitValuePerUnit, { at: now, qty: 150 }), now);

  const positions = new BoxPositionBook();
  const position = positionFrom(candidate, { opened_at: now - 60_000, last_persist_at: now });
  positions.add(position);

  const sim = fakeSim({ plan, executable });
  const closes = [];
  const partials = [];
  const events = [];
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
    persistPartialExit: async (args) => {
      partials.push({
        remaining: { ...args.position.remaining_qty_by_role },
        state: args.position.position_state,
        residual: args.residual.map((r) => ({ role: r.role, quantity: r.quantity })),
      });
      return true;
    },
    persistLive: async () => {},
    onEvent: (event, pos, metrics, detail) => events.push({ event, detail }),
    istDayKey: () => "2026-08-29",
    istMinutesOfDay: () => 11 * 60,
    isMarketOpen: () => true,
    isFeedHealthy: () => true,
  });

  return { monitor, positions, position, candidate, closes, partials, events, sim };
}

/** Force the next cycle past the partial-exit retry throttle. */
function unthrottle(pos) {
  pos.last_exit_attempt_at = 0;
}

/* ------------------------------- G. full 4/4 ------------------------------- */

test("G. a full 4/4 legging exit closes the box normally", async () => {
  const h = harness({ plan: [{ k1_ce: 75, k2_ce: 75, k2_pe: 75, k1_pe: 75 }] });
  await h.monitor.cycle();
  assert.equal(h.closes.length, 1, "closed exactly once");
  assert.equal(h.positions.size, 0, "removed from the book");
  assert.equal(h.partials.length, 0, "a clean close needs no partial persistence");
  // Cumulative gross was passed through as the authoritative P&L.
  assert.equal(typeof h.closes[0].grossPnlOverride, "number");
  assert.ok(Array.isArray(h.closes[0].exitAttempts) && h.closes[0].exitAttempts.length === 1);
});

/* ------------------------------- H. 0/4 exit ------------------------------- */

test("H. a 0/4 exit changes nothing — no close, no decrement, no charges", async () => {
  const h = harness({ plan: [{}] });
  await h.monitor.cycle();
  assert.equal(h.closes.length, 0);
  assert.equal(h.partials.length, 0);
  for (const role of ROLES) assert.equal(h.position.remaining_qty_by_role[role], LOT);
  assert.equal(h.position.cumulative_exit_charges, 0);
  assert.equal(h.position.position_state, "BOX");
});

/* --------------------------- A. 3/4 then retry ----------------------------- */

test("A. 3/4 exit persists partial state; retry submits ONLY the remaining role", async () => {
  const h = harness({
    plan: [
      { k1_ce: 75, k2_ce: 75, k2_pe: 75, k1_pe: 0 }, // attempt 1: 3 roles close
      { k1_pe: 75 }, // attempt 2: only the remaining role
    ],
  });

  await h.monitor.cycle(); // attempt 1
  assert.equal(h.closes.length, 0, "a 3/4 exit is NOT a closed box");
  assert.equal(h.positions.size, 1, "position stays open");
  assert.equal(h.position.position_state, "PARTIALLY_EXITED");
  assert.equal(h.position.remaining_qty_by_role.k1_ce, 0);
  assert.equal(h.position.remaining_qty_by_role.k2_ce, 0);
  assert.equal(h.position.remaining_qty_by_role.k2_pe, 0);
  assert.equal(h.position.remaining_qty_by_role.k1_pe, LOT, "the unfilled role is still fully open");
  assert.equal(h.partials.length, 1, "the partial exit was persisted");
  assert.deepEqual(h.partials[0].residual, [{ role: "k1_pe", quantity: LOT }]);

  unthrottle(h.position);
  await h.monitor.cycle(); // attempt 2

  // The retry must have submitted ONLY the outstanding role, exactly once.
  assert.deepEqual(h.sim.submissions[1], [{ role: "k1_pe", quantity: LOT }], "retry submits only k1_pe×75");
  assert.equal(h.closes.length, 1, "now flat → closed");
  assert.equal(h.positions.size, 0);
});

/* -------------------------- B. mixed quantities ---------------------------- */

test("B. a mixed-quantity partial decrements exact per-role remaining", async () => {
  // k1_ce 75, k2_ce 40, k2_pe 0, k1_pe 75  →  remaining 0 / 35 / 75 / 0
  const h = harness({ plan: [{ k1_ce: 75, k2_ce: 40, k2_pe: 0, k1_pe: 75 }] });
  await h.monitor.cycle();
  assert.equal(h.position.remaining_qty_by_role.k1_ce, 0);
  assert.equal(h.position.remaining_qty_by_role.k2_ce, 35);
  assert.equal(h.position.remaining_qty_by_role.k2_pe, 75);
  assert.equal(h.position.remaining_qty_by_role.k1_pe, 0);
  assert.equal(h.position.position_state, "PARTIALLY_EXITED");
  assert.equal(h.closes.length, 0);

  // The NEXT attempt must request only 35 / 75 on the two outstanding roles.
  unthrottle(h.position);
  h.sim.submissions.length = 0;
  await h.monitor.cycle();
  const submitted = new Map(h.sim.submissions[0].map((s) => [s.role, s.quantity]));
  assert.deepEqual([...submitted.entries()].sort(), [["k2_ce", 35], ["k2_pe", 75]]);
});

/* ------------------------- C. repeated partial fills ----------------------- */

test("C. repeated partial fills on one role never over-close", async () => {
  // Start with a single outstanding role of 75, closing 40 then 20 then 15.
  const h = harness({ plan: [{ k1_ce: 40 }, { k1_ce: 20 }, { k1_ce: 15 }] });
  // Reduce the position to a single outstanding role for a focused test.
  h.position.remaining_qty_by_role = { k1_ce: LOT, k2_ce: 0, k2_pe: 0, k1_pe: 0 };
  h.position.position_state = "PARTIALLY_EXITED";

  unthrottle(h.position);
  await h.monitor.cycle();
  assert.equal(h.position.remaining_qty_by_role.k1_ce, 35);

  unthrottle(h.position);
  await h.monitor.cycle();
  assert.equal(h.position.remaining_qty_by_role.k1_ce, 15);

  unthrottle(h.position);
  await h.monitor.cycle();
  assert.equal(h.position.remaining_qty_by_role.k1_ce, 0);
  assert.equal(h.closes.length, 1, "flat → closed");
});

/* ------------------- F. no-reverse-exposure invariant ---------------------- */

test("F. an over-close is clamped, never turned into reverse exposure", async () => {
  // The executor (buggily) reports closing 200 of a 75 lot. The monitor must clamp
  // to 75, leave remaining at 0 (never negative), and flag the invariant breach.
  const h = harness({ plan: [{ k1_ce: 200, k2_ce: 75, k2_pe: 75, k1_pe: 75 }] });
  await h.monitor.cycle();
  for (const role of ROLES) {
    assert.ok(h.position.remaining_qty_by_role[role] >= 0, `${role} never negative`);
    assert.ok(h.position.remaining_qty_by_role[role] <= LOT, `${role} never above the lot`);
  }
  // All roles clamped to flat → closed.
  assert.equal(h.closes.length, 1);
});

test("F2. every scripted partial keeps 0 <= remaining <= original for all roles", async () => {
  const h = harness({
    plan: [
      { k1_ce: 30, k2_ce: 75, k2_pe: 10, k1_pe: 0 },
      { k1_ce: 45, k2_pe: 65, k1_pe: 40 },
      { k1_pe: 35 },
    ],
  });
  for (let i = 0; i < 3; i++) {
    unthrottle(h.position);
    await h.monitor.cycle();
    for (const role of ROLES) {
      const q = h.position.remaining_qty_by_role[role];
      assert.ok(q >= 0 && q <= LOT, `${role}=${q} out of [0,${LOT}] after attempt ${i + 1}`);
    }
  }
});

/* ------------------------------ manual close ------------------------------- */

test("manual: paper_legging manual 4/4 close uses the independent-order path", async () => {
  const h = harness({ plan: [{ k1_ce: 75, k2_ce: 75, k2_pe: 75, k1_pe: 75 }] });
  const res = await h.monitor.closeManually(h.position.id);
  assert.equal(res.ok, true);
  assert.equal(h.closes.length, 1);
  assert.equal(h.closes[0].reason, "MANUAL", "only the reason differs from an auto close");
  assert.equal(h.positions.size, 0);
});

test("manual: a partial manual close reports the remaining exposure honestly", async () => {
  const h = harness({ plan: [{ k1_ce: 75, k2_ce: 75, k2_pe: 0, k1_pe: 0 }] });
  const res = await h.monitor.closeManually(h.position.id);
  assert.equal(res.ok, false);
  assert.equal(res.partial, true, "must not pretend nothing happened");
  assert.deepEqual(res.filled_roles.sort(), ["k1_ce", "k2_ce"]);
  assert.equal(res.remaining_qty_by_role.k2_pe, LOT);
  assert.equal(res.remaining_qty_by_role.k1_pe, LOT);
  assert.equal(h.positions.size, 1, "position stays open and managed");
  assert.equal(h.position.position_state, "PARTIALLY_EXITED");
  assert.equal(h.partials.length, 1, "partial manual close persists the same way as auto");
});

for (const mode of ["paper_touch", "paper_latency"]) {
  test(`manual: ${mode} manual close uses the ATOMIC path, not the legging executor`, async () => {
    const { candidate } = goodCandidate();
    const conf = cfg({ executionMode: mode });
    const now = Date.now();
    const quotes = new BoxQuoteStore();
    seedStore(quotes, exitQuotes(candidate, 198, { at: now, qty: 150 }), now);
    const positions = new BoxPositionBook();
    const position = positionFrom(candidate, { opened_at: now - 60_000, last_persist_at: now });
    positions.add(position);

    let leggingCalled = false;
    const closes = [];
    const sim = {
      // The atomic path calls simulateExit; simulateLeggingExit must NOT be used.
      simulateExit: async ({ detectionLegs }) => ({ ok: true, legs: detectionLegs, record: null }),
      simulateLeggingExit: async () => {
        leggingCalled = true;
        throw new Error("legging exit must not be used for an atomic mode");
      },
      estimateExecutableExit: () => [],
    };
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
      persistPartialExit: async () => true,
      persistLive: async () => {},
      onEvent: () => {},
      istDayKey: () => "2026-08-29",
      istMinutesOfDay: () => 11 * 60,
      isMarketOpen: () => true,
      isFeedHealthy: () => true,
    });

    const res = await monitor.closeManually(position.id);
    assert.equal(res.ok, true);
    assert.equal(leggingCalled, false, "atomic modes must not touch the legging executor");
    assert.equal(closes[0].reason, "MANUAL");
    assert.equal(positions.size, 0);
  });
}

test("manual: a manual retry targets only the remaining exposure", async () => {
  const h = harness({
    plan: [
      { k1_ce: 75, k2_ce: 75, k2_pe: 0, k1_pe: 0 },
      { k2_pe: 75, k1_pe: 75 },
    ],
  });
  await h.monitor.closeManually(h.position.id);
  const r1 = await h.monitor.closeManually(h.position.id);
  assert.equal(r1.ok, true, "the remaining two roles close");
  assert.deepEqual(h.sim.submissions[1].map((s) => s.role).sort(), ["k1_pe", "k2_pe"]);
  assert.equal(h.positions.size, 0);
});
