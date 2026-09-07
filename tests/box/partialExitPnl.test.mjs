/**
 * AN ALREADY-CLOSED LEG MUST NOT MOVE THE RUNNING P&L.
 *
 * THE DEFECT
 * `pos.quantity` and `pos.lot_size` are never decremented by a partial exit — only
 * `remaining_qty_by_role` is. So `measure()` re-marked ALL FOUR roles at the current touch and
 * priced a fresh FULL-LOT FOUR-LEG exit estimate, while the exit charges already PAID on the
 * closed legs (`cumulative_exit_charges`) were never passed in. Two independent errors:
 *
 *   1. every ₹1/unit move in an already-flat leg moved the reported figure by a full lot;
 *   2. the exit-charge estimate re-charged legs that were already closed and paid for.
 *
 * Both flowed into `open_running_net_pnl`, `/api/box/status`, the UI and the archived day total
 * for as long as the position stayed partial. The FINAL close was already correct (it overrides
 * with cumulative gross and cumulative exit charges), which is precisely why this was invisible.
 *
 * THE TEST THAT MATTERS (T2/T3): close two roles completely, then move the quotes on ONLY those
 * closed roles by a huge amount. The running P&L must not move at all. Then move an OPEN role and
 * it must move. That pair separates "the number is frozen" from "the number is dead".
 *
 * Pure and offline.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxPositionMonitor } from "../../dist/box/positionMonitor.js";
import { BoxPositionBook, outstandingRoles } from "../../dist/box/positions.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { exitSideFor } from "../../dist/box/math.js";
import {
  isPartialBox,
  markPartialExit,
  realisedExitGross,
  remainingByRoleOf,
} from "../../dist/box/partialExitPnl.js";
import {
  LOT,
  cfg,
  exitQuotes,
  goodCandidate,
  localChargesStub,
  positionFrom,
  quote,
  seedStore,
} from "./helpers.mjs";

const ROLES = ["k1_ce", "k2_ce", "k2_pe", "k1_pe"];
const EXIT_PRICE = { k1_ce: 299, k2_ce: 221, k2_pe: 199, k1_pe: 106 };

/** A charge stub that is PROPORTIONAL to turnover, so a quantity error is visible. */
function proportionalCharges() {
  const perLeg = (o) => o.quantity * o.price * 0.0005;
  return {
    legs: (orders) => ({
      total: Math.round(orders.reduce((s, o) => s + perLeg(o), 0) * 100) / 100,
      source: "kite_estimate",
      origin: "local",
    }),
    roundTrip: (orders) => ({
      entry: { total: 0 }, estimated_exit: { total: 0 },
      entry_total: 0, estimated_exit_total: 0,
      orders,
    }),
    totals: () => ({ entry: 0, exit: 0 }),
    rates: { rateVersion: "test" },
  };
}

function fakeSim({ plan }) {
  let call = 0;
  const invariantViolations = [];
  return {
    invariantViolations,
    invariantViolation: (r) => invariantViolations.push(r),
    simulateLeggingExit: async ({ position }) => {
      const outstanding = outstandingRoles(position);
      const closeMap = plan[Math.min(call, plan.length - 1)] ?? {};
      call++;
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
        order_sent_at: Date.now(),
        fills_by_role,
        submitted_leg_count: submitted,
        fully_closed_role_count: fullyClosed,
        remaining_role_count: submitted - fullyClosed,
        residual_exposure: [],
        legs: legs.map((l) => ({ order_id: `o:${l.role}:${call}`, role: l.role, requested_qty: LOT })),
      };
      const ok = submitted > 0 && fullyClosed === submitted;
      return ok
        ? { ok: true, legs, record, booksAtFill: new Map() }
        : { ok: false, legs, record, reason: "legging_incomplete", detail: "partial", booksAtFill: new Map() };
    },
    estimateExecutableExit: (position) =>
      outstandingRoles(position).map(({ role, quantity }) => ({
        role, side: exitSideFor(role, "LONG_BOX"), remaining: quantity, executable: quantity, fresh: true,
      })),
    simulateExit: async () => ({ ok: false, reason: "insufficient_quantity", detail: "n/a", record: {} }),
  };
}

function harness({ plan = [{}], exitValuePerUnit = 198, charges = "flat" } = {}) {
  const { candidate } = goodCandidate();
  const conf = cfg({ executionMode: "paper_legging" });
  const now = Date.now();
  const quotes = new BoxQuoteStore();
  seedStore(quotes, exitQuotes(candidate, exitValuePerUnit, { at: now, qty: 150 }), now);

  const positions = new BoxPositionBook();
  const position = positionFrom(candidate, { opened_at: now - 60_000, last_persist_at: now });
  positions.add(position);

  const sim = fakeSim({ plan });
  const closes = [];
  const partials = [];
  const monitor = new BoxPositionMonitor({
    cfg: conf,
    quotes,
    localCharges: charges === "proportional"
      ? proportionalCharges()
      : localChargesStub({ entryTotal: 150, exitTotal: 150 }),
    executionSim: sim,
    positions,
    closePaperTrade: async (args) => { closes.push(args); positions.remove(args.position.id); return true; },
    persistPartialExit: async () => true,
    persistLive: async () => {},
    onEvent: () => {},
    istDayKey: () => "2026-08-29",
    istMinutesOfDay: () => 11 * 60,
    isMarketOpen: () => true,
    isFeedHealthy: () => true,
  });

  /** Move ONE role's book, leaving every other role untouched. */
  const moveRole = (role, { bid, ask }) => {
    const token = candidate.legs[role].token;
    const at = Date.now();
    quotes.applyTicks([{
      token,
      last_price: bid,
      bid, ask,
      bids: [{ price: bid, qty: 500, orders: 1 }],
      asks: [{ price: ask, qty: 500, orders: 1 }],
    }], at);
  };

  return { monitor, positions, position, candidate, closes, partials, sim, quotes, moveRole };
}

const unthrottle = (pos) => { pos.last_exit_attempt_at = 0; };

/* ══════════════════ T1. a WHOLE box is byte-for-byte unchanged ══════════════════ */

test("T1: a whole, un-exited box keeps the pre-existing arithmetic exactly", async () => {
  const h = harness({ plan: [{}] });
  const m = h.monitor.measure(h.position);

  assert.equal(isPartialBox(h.position), false, "nothing has been closed");
  assert.equal(m.partial_exit_mark, undefined, "so the partial-aware path must not engage at all");
  // The untouched whole-box identity: (exit value per unit − entry cost per unit) × lot.
  assert.equal(m.gross_pnl_if_closed_now, (198 - h.position.entry_box_cost_per_unit) * LOT);
  assert.equal(m.estimated_exit_charges, 150, "the full-lot four-leg estimate, as before");
  assert.equal(
    m.current_net_pnl,
    m.gross_pnl_if_closed_now - (h.position.entry_charges_total + 150),
    "and net is gross minus the whole round trip, exactly as before",
  );
});

/* ══════════════════ T2/T3. THE HEADLINE PAIR ══════════════════ */

test("T2: after two roles close, moving ONLY the CLOSED roles' quotes cannot move the running P&L", async () => {
  // Close k1_ce and k2_ce completely; leave k2_pe and k1_pe fully open.
  const h = harness({ plan: [{ k1_ce: LOT, k2_ce: LOT, k2_pe: 0, k1_pe: 0 }] });
  await h.monitor.cycle();

  const pos = h.positions.get("box1");
  assert.ok(pos, "the position is still open");
  assert.equal(pos.position_state, "PARTIALLY_EXITED");
  assert.deepEqual(remainingByRoleOf(pos), { k1_ce: 0, k2_ce: 0, k2_pe: LOT, k1_pe: LOT });

  const before = h.monitor.measure(pos);

  // MOVE THE CLOSED ROLES BY A HUGE AMOUNT. These legs are flat; nothing here is ours any more.
  h.moveRole("k1_ce", { bid: 9_000, ask: 9_001 });
  h.moveRole("k2_ce", { bid: 1, ask: 2 });

  const after = h.monitor.measure(pos);

  // THE HEADLINE ASSERTION, first so a failure names the defect rather than a missing field.
  assert.equal(
    after.gross_pnl_if_closed_now,
    before.gross_pnl_if_closed_now,
    "a ₹8,700 move on an ALREADY-FLAT leg must not move the running gross by a single paisa",
  );
  assert.equal(after.current_net_pnl, before.current_net_pnl, "nor the running net");
  assert.equal(after.realisable_net_pnl, before.realisable_net_pnl);
  assert.equal(after.estimated_exit_charges, before.estimated_exit_charges, "nor the charge estimate");

  // And the breakdown that makes the figure auditable.
  assert.ok(before.partial_exit_mark, "a partially exited box must be marked partial-aware");
  assert.equal(before.partial_exit_mark.marked_quantity_by_role.k1_ce, 0, "a flat role is not marked");
  assert.equal(before.partial_exit_mark.marked_quantity_by_role.k2_pe, LOT);
  assert.equal(after.partial_exit_mark.realised_gross, before.partial_exit_mark.realised_gross);
  assert.equal(after.partial_exit_mark.unrealised_gross, before.partial_exit_mark.unrealised_gross);
});

test("T3: moving an OPEN role's quote DOES move the running P&L — the number is frozen, not dead", async () => {
  const h = harness({ plan: [{ k1_ce: LOT, k2_ce: LOT, k2_pe: 0, k1_pe: 0 }] });
  await h.monitor.cycle();
  const pos = h.positions.get("box1");

  const before = h.monitor.measure(pos);
  // k2_pe is still fully OPEN. A long box BOUGHT it, so it is SOLD to exit: a higher bid is more
  // profit, and that must be reflected.
  h.moveRole("k2_pe", { bid: 260, ask: 261 });
  const after = h.monitor.measure(pos);

  assert.ok(
    after.gross_pnl_if_closed_now > before.gross_pnl_if_closed_now,
    `an OPEN role is still ours and must still be marked ` +
      `(${before.gross_pnl_if_closed_now} -> ${after.gross_pnl_if_closed_now})`,
  );
  // Only the unrealised half moved; the realised half is frozen.
  assert.equal(
    after.partial_exit_mark.realised_gross,
    before.partial_exit_mark.realised_gross,
    "realised gross is frozen at the prices the closed legs actually filled at",
  );
  assert.notEqual(after.partial_exit_mark.unrealised_gross, before.partial_exit_mark.unrealised_gross);
});

/* ══════════════════ T4. charges are not double counted ══════════════════ */

test("T4: exit charges = already paid (exact) + an estimate for the REMAINING quantity only", async () => {
  const h = harness({ plan: [{ k1_ce: LOT, k2_ce: LOT, k2_pe: 0, k1_pe: 0 }], charges: "proportional" });
  await h.monitor.cycle();
  const pos = h.positions.get("box1");

  const m = h.monitor.measure(pos);
  const mark = m.partial_exit_mark;

  assert.ok(pos.cumulative_exit_charges > 0, "closing two legs cost something");
  assert.equal(
    mark.exit_charges_incurred,
    pos.cumulative_exit_charges,
    "what was paid is taken from the exact cumulative figure, never re-estimated",
  );

  // The remaining estimate must cover exactly TWO legs, not four.
  const twoLegEstimate = h.monitor.deps === undefined
    ? mark.estimated_remaining_exit_charges
    : mark.estimated_remaining_exit_charges;
  assert.ok(twoLegEstimate > 0);
  assert.equal(
    m.estimated_exit_charges,
    Math.round((mark.exit_charges_incurred + twoLegEstimate) * 100) / 100,
    "the published figure is the sum of the two, and nothing else",
  );

  // A full four-leg re-estimate would be materially larger. Prove the difference is real by
  // comparing against the SAME position pretending nothing had closed.
  const asWholeBox = { ...pos, remaining_qty_by_role: { k1_ce: LOT, k2_ce: LOT, k2_pe: LOT, k1_pe: LOT } };
  const wholeBoxEstimate = h.monitor.measure(asWholeBox).estimated_exit_charges;
  assert.ok(
    twoLegEstimate < wholeBoxEstimate,
    `closing two legs must cost less than closing four (${twoLegEstimate} vs ${wholeBoxEstimate})`,
  );
});

/* ══════════════════ T5. the final close still reconciles ══════════════════ */

test("T5: the final close equals the cumulative realised accounting, unchanged", async () => {
  const h = harness({
    plan: [
      { k1_ce: LOT, k2_ce: LOT, k2_pe: 0, k1_pe: 0 },   // attempt 1: two roles
      { k2_pe: LOT, k1_pe: LOT },                        // attempt 2: the rest
    ],
  });
  await h.monitor.cycle();
  const pos = h.positions.get("box1");
  const partialMark = h.monitor.measure(pos).partial_exit_mark;
  const realisedAfterFirst = partialMark.realised_gross;

  unthrottle(pos);
  await h.monitor.cycle();

  assert.equal(h.closes.length, 1, "the box closes once every role is flat");
  const close = h.closes[0];
  const cumulativeGross = close.position.exit_attempts.reduce((s, a) => s + (a.gross_pnl ?? 0), 0);

  assert.equal(
    close.grossPnlOverride,
    Math.round(cumulativeGross * 100) / 100,
    "the final gross is still the SUM OF THE ATTEMPTS, exactly as before",
  );
  assert.equal(
    close.exitChargesTotalOverride,
    pos.cumulative_exit_charges,
    "and the final exit charges are still the exact cumulative figure",
  );
  // The running mark was an honest interim view of the same accounting.
  assert.ok(
    Math.abs(realisedAfterFirst) > 0,
    "the interim realised component was non-zero, so this is a real reconciliation",
  );
  assert.ok(
    close.grossPnlOverride !== realisedAfterFirst,
    "and the second attempt genuinely added realised gross",
  );
});

test("T6: a FLAT position marks zero unrealised — realised is the whole story", async () => {
  const h = harness({ plan: [{ k1_ce: LOT, k2_ce: LOT, k2_pe: LOT, k1_pe: LOT }] });
  await h.monitor.cycle();
  assert.equal(h.closes.length, 1);
  // Re-measure the projected position the close was built from.
  const closed = h.closes[0].position;
  assert.deepEqual(remainingByRoleOf(closed), { k1_ce: 0, k2_ce: 0, k2_pe: 0, k1_pe: 0 });
  const mark = markPartialExit({
    direction: "LONG_BOX",
    remainingByRole: remainingByRoleOf(closed),
    entryPrices: closed.entry_prices,
    legs: [],
    realisedGross: realisedExitGross(closed),
    exitChargesIncurred: closed.cumulative_exit_charges,
    entryChargesTotal: closed.entry_charges_total,
    estimatedRemainingExitCharges: 0,
    executionCost: 0,
  });
  assert.equal(mark.unrealised_gross, 0, "nothing is left to mark");
  assert.equal(mark.gross, mark.realised_gross, "so gross is exactly the realised accounting");
});

/* ══════════════════ T7. the pure primitive, directly ══════════════════ */

test("T7: markPartialExit marks ONLY remaining quantity, per role, on the correct side", () => {
  // A LONG box BUYS k1_ce and k2_pe and SELLS k2_ce and k1_pe (see entrySideFor). Each leg below
  // is marked +10/unit in our favour, so the whole-box mark is 4 × 10 × 75 = 3000.
  const legs = [
    { role: "k1_ce", price: 310 },   // bought at 300, sell at 310    => +10/unit
    { role: "k2_ce", price: 210 },   // sold at 220, buy back at 210  => +10/unit
    { role: "k2_pe", price: 210 },   // bought at 200, sell at 210    => +10/unit
    { role: "k1_pe", price: 95 },    // sold at 105, buy back at 95   => +10/unit
  ];
  const entryPrices = { k1_ce: 300, k2_ce: 220, k2_pe: 200, k1_pe: 105 };

  // All four open: 4 × 10 × 75 = 3000.
  const whole = markPartialExit({
    direction: "LONG_BOX",
    remainingByRole: { k1_ce: 75, k2_ce: 75, k2_pe: 75, k1_pe: 75 },
    entryPrices, legs, realisedGross: 0, exitChargesIncurred: 0,
    entryChargesTotal: 0, estimatedRemainingExitCharges: 0, executionCost: 0,
  });
  assert.equal(whole.unrealised_gross, 3_000);

  // Two flat: only the other two are marked => 2 × 10 × 75 = 1500, plus frozen realised.
  const partial = markPartialExit({
    direction: "LONG_BOX",
    remainingByRole: { k1_ce: 0, k2_ce: 0, k2_pe: 75, k1_pe: 75 },
    entryPrices, legs, realisedGross: 1_234.5, exitChargesIncurred: 0,
    entryChargesTotal: 0, estimatedRemainingExitCharges: 0, executionCost: 0,
  });
  assert.equal(partial.unrealised_gross, 1_500, "the two flat roles contribute nothing");
  assert.equal(partial.realised_gross, 1_234.5, "and the realised component is passed through frozen");
  assert.equal(partial.gross, 2_734.5);

  // Uneven quantities are handled per role, which a scalar lot size cannot express.
  const uneven = markPartialExit({
    direction: "LONG_BOX",
    remainingByRole: { k1_ce: 0, k2_ce: 35, k2_pe: 75, k1_pe: 0 },
    entryPrices, legs, realisedGross: 0, exitChargesIncurred: 0,
    entryChargesTotal: 0, estimatedRemainingExitCharges: 0, executionCost: 0,
  });
  assert.equal(uneven.unrealised_gross, 10 * 35 + 10 * 75, "35 of one role and 75 of another");
});

test("T8: an unpriceable REMAINING leg yields null rather than a fabricated mark", () => {
  const mark = markPartialExit({
    direction: "LONG_BOX",
    remainingByRole: { k1_ce: 0, k2_ce: 75, k2_pe: 75, k1_pe: 0 },
    entryPrices: { k1_ce: 300, k2_ce: 220, k2_pe: 200, k1_pe: 105 },
    legs: [
      { role: "k1_ce", price: null },   // flat, so its missing price is irrelevant
      { role: "k2_ce", price: null },   // OPEN and unpriceable => the mark is unknown
      { role: "k2_pe", price: 210 },
      { role: "k1_pe", price: null },
    ],
    realisedGross: 500, exitChargesIncurred: 10,
    entryChargesTotal: 20, estimatedRemainingExitCharges: 5, executionCost: 0,
  });
  assert.equal(mark.unrealised_gross, null, "an unpriceable OPEN leg must not be guessed at");
  assert.equal(mark.gross, null);
  assert.equal(mark.net, null);
  assert.equal(mark.realised_gross, 500, "but what is already realised is still known exactly");
  assert.equal(mark.exit_charges_total, 15, "and the charge stack is still exact");
});

test("T9: legacy positions with no per-role map read as a WHOLE box, not as flat", () => {
  const { candidate } = goodCandidate();
  const legacy = positionFrom(candidate);
  delete legacy.remaining_qty_by_role;
  assert.deepEqual(
    remainingByRoleOf(legacy),
    { k1_ce: LOT, k2_ce: LOT, k2_pe: LOT, k1_pe: LOT },
    "an adopted document written before the field existed is fully open, never fully flat",
  );
  assert.equal(isPartialBox(legacy), false, "so it keeps the whole-box arithmetic");
});
