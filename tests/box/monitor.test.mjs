/**
 * The position monitor: automatic exits, the refusal to fake an exit without
 * liquidity, manual close, and the guarantee that monitoring is independent of
 * the scanner's RUN state.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BoxPositionMonitor,
  describeLiquidityGap,
  liquidityGapKey,
} from "../../dist/box/positionMonitor.js";
import { BoxChargeEstimator } from "../../dist/box/charges.js";
import { BoxPositionBook } from "../../dist/box/positions.js";
import { BoxScanner } from "../../dist/box/scanner.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import {
  GOOD_BOX,
  LOT,
  cfg,
  chargeStub,
  exitQuotes,
  goodCandidate,
  storeFrom,
} from "./helpers.mjs";

/**
 * A monitor holding one open box, with the exit book set to produce a chosen
 * exit box value per unit.
 */
function harness({
  exitValuePerUnit = 198,
  qty = 150,
  entryCost = GOOD_BOX.costPerUnit,
  entryNetEdge = 1425,
  exitFees = 150,
  ageMs = 0,
  expiry = "2026-09-24",
  istDay = "2026-08-29",
  istMinutes = 11 * 60,
  chargesFail = false,
  marketOpen = true,
} = {}) {
  const { candidate } = goodCandidate();
  const conf = cfg();
  const now = Date.now();
  const quotes = storeFrom(exitQuotes(candidate, exitValuePerUnit, { at: now - ageMs, qty }));
  const positions = new BoxPositionBook();
  const stub = chargeStub({ entryTotal: exitFees, exitTotal: exitFees, fail: chargesFail });
  const charges = new BoxChargeEstimator(stub.fn, conf);

  const position = {
    id: "box1",
    key: candidate.key,
    underlying: candidate.underlying,
    name: candidate.name,
    is_index: candidate.is_index,
    expiry,
    lower_strike: candidate.lower_strike,
    upper_strike: candidate.upper_strike,
    box_width: candidate.box_width,
    lot_size: LOT,
    quantity: LOT,
    entry_box_cost_per_unit: entryCost,
    entry_gross_edge: GOOD_BOX.grossEdge,
    entry_net_edge: entryNetEdge,
    entry_charges_total: 150,
    estimated_exit_charges_total: 150,
    safety_buffer: 150,
    opened_at: now - 60_000,
    legs: candidate.legs,
    entry_prices: { k1_ce: 300, k2_ce: 220, k2_pe: 200, k1_pe: 105 },
    metrics: null,
    exit_blocked_reason: null,
    expiry_safety: false,
    closing: false,
    last_persist_at: now,
    config: {},
  };
  positions.add(position);

  const closes = [];
  const events = [];
  const persisted = [];
  const monitor = new BoxPositionMonitor({
    cfg: conf,
    quotes,
    charges,
    positions,
    closePaperTrade: async (args) => {
      closes.push(args);
      positions.remove(args.position.id);
      return true;
    },
    persistLive: async (pos) => {
      persisted.push(pos.id);
    },
    onEvent: (event, pos, metrics, detail) => events.push({ event, detail, metrics }),
    istDayKey: () => istDay,
    istMinutesOfDay: () => istMinutes,
    isMarketOpen: () => marketOpen,
  });

  return { monitor, positions, position, candidate, closes, events, persisted, conf, quotes };
}

/* -------------------------------------------------------------- auto exit --- */

test("a converged, comfortably profitable box is closed automatically", async () => {
  const h = harness({ exitValuePerUnit: 198 });
  await h.monitor.cycle();

  assert.equal(h.closes.length, 1);
  const { metrics, reason } = h.closes[0];
  assert.equal(reason, "EDGE_CONVERGED");
  assert.equal(metrics.remaining_edge, (200 - 198) * LOT);
  assert.ok(metrics.current_net_pnl >= 600);
  assert.equal(h.positions.size, 0);
  assert.ok(h.events.some((e) => e.event === "EXIT_TRIGGERED"));
});

test("23/24. a converged box that is unprofitable or under ₹600 is left open", async () => {
  // Under water despite the spread having converged.
  const losing = harness({ exitValuePerUnit: 198, entryCost: 199 });
  await losing.monitor.cycle();
  assert.equal(losing.closes.length, 0, "never close at a loss");
  assert.equal(losing.positions.size, 1);

  // Profitable, but only ₹225 net — not worth the round trip.
  const thin = harness({ exitValuePerUnit: 198, entryCost: 191 });
  await thin.monitor.cycle();
  assert.equal(thin.closes.length, 0, "below the ₹600 floor");
  assert.equal(thin.positions.size, 1);
  assert.equal(thin.position.metrics.current_net_pnl, 225);
});

test("25. the 75% profit-capture rule closes a box whose edge has not converged", async () => {
  const h = harness({ exitValuePerUnit: 190, entryNetEdge: 1000 });
  await h.monitor.cycle();
  assert.equal(h.closes.length, 1);
  assert.equal(h.closes[0].reason, "PROFIT_CAPTURE");
  assert.ok(h.closes[0].metrics.remaining_edge > h.closes[0].metrics.convergence_threshold);
});

/* -------------------------------------------------------------------- 26 --- */

test("26. without one-lot touch liquidity the exit is SKIPPED and the box stays open", async () => {
  const h = harness({ exitValuePerUnit: 198, qty: 40 });
  await h.monitor.cycle();

  assert.equal(h.closes.length, 0, "an exit must never be faked");
  assert.equal(h.positions.size, 1, "the position stays open");
  const skipped = h.events.filter((e) => e.event === "EXIT_SKIPPED_LIQUIDITY");
  assert.equal(skipped.length, 1);
  assert.match(h.position.exit_blocked_reason, /needs 75/);
  // And it keeps being monitored: metrics are refreshed every cycle.
  assert.ok(h.position.metrics.remaining_edge !== null);
  await h.monitor.cycle();
  assert.equal(h.positions.size, 1);
});

test("a stale exit book also blocks the exit rather than closing on old prices", async () => {
  const h = harness({ exitValuePerUnit: 198, ageMs: 5000 });
  await h.monitor.cycle();
  assert.equal(h.closes.length, 0);
  assert.equal(h.positions.size, 1);
  assert.match(h.position.exit_blocked_reason ?? "", /stale/);
});

test("describeLiquidityGap names the leg and the shortfall", () => {
  const legs = [
    { role: "k1_ce", side: "SELL", tradingsymbol: "A", price: 10, qty_at_touch: 40, fresh: true, quote_at: 1, age_ms: 5 },
    { role: "k2_ce", side: "BUY", tradingsymbol: "B", price: 10, qty_at_touch: 200, fresh: true, quote_at: 1, age_ms: 5 },
    { role: "k2_pe", side: "SELL", tradingsymbol: "C", price: null, qty_at_touch: 0, fresh: true, quote_at: 1, age_ms: 5 },
    { role: "k1_pe", side: "BUY", tradingsymbol: "D", price: 10, qty_at_touch: 200, fresh: false, quote_at: 1, age_ms: 9000 },
  ];
  const text = describeLiquidityGap(legs, 75);
  assert.match(text, /A shows 40 at 10 \(needs 75\)/);
  assert.match(text, /C has no bid/);
  assert.match(text, /D book is stale/);
  assert.doesNotMatch(text, /\bB\b/);
});

/* -------------------------------------------------------------------- 27 --- */

test("27. manual close fills at the current executable touch", async () => {
  // A box with no automatic trigger at all (edge far from converged, profit
  // below the capture target) still closes on request.
  const h = harness({ exitValuePerUnit: 180, entryNetEdge: 1425 });
  const pre = h.monitor.measure(h.position);
  assert.equal(pre.exit_eligible, false, "no automatic exit is due");

  const result = await h.monitor.closeManually("box1");
  assert.equal(result.ok, true);
  assert.equal(h.closes.length, 1);
  assert.equal(h.closes[0].reason, "MANUAL");
  // Exit prices are the reversed touches, not the LTP or a midpoint.
  const byRole = new Map(h.closes[0].metrics.legs.map((l) => [l.role, l]));
  assert.equal(byRole.get("k1_ce").side, "SELL");
  assert.equal(byRole.get("k2_ce").side, "BUY");
  assert.equal(h.closes[0].metrics.exit_box_value_per_unit, 180);
  assert.equal(h.positions.size, 0);
});

test("27. manual close REFUSES rather than inventing a price when the market is not there", async () => {
  const h = harness({ exitValuePerUnit: 198, qty: 40 });
  const result = await h.monitor.closeManually("box1");

  assert.equal(result.ok, false);
  assert.equal(result.code, 409);
  assert.match(result.error, /Cannot close at an executable price/);
  assert.match(result.error, /still open and being monitored/);
  assert.equal(h.closes.length, 0);
  assert.equal(h.positions.size, 1, "refusing must leave the position open");
  assert.ok(h.events.some((e) => e.event === "EXIT_SKIPPED_LIQUIDITY"));
});

test("manual close of an unknown position is a 404, not a crash", async () => {
  const h = harness();
  const result = await h.monitor.closeManually("nope");
  assert.equal(result.ok, false);
  assert.equal(result.code, 404);
});

/* -------------------------------------------------------------------- 30 --- */

test("30. STOP stops discovery but the monitor keeps managing and exiting", async () => {
  const h = harness({ exitValuePerUnit: 198 });

  // A scanner that is explicitly STOPPED, sharing the same position book.
  const scanner = new BoxScanner({
    cfg: h.conf,
    quotes: new BoxQuoteStore(),
    charges: new BoxChargeEstimator(chargeStub({}).fn, h.conf),
    positions: h.positions,
    openPaperTrade: async () => {
      throw new Error("discovery must not run while stopped");
    },
    onEvent: () => {},
  });
  scanner.setDiscovering(false);
  assert.equal(scanner.isDiscovering(), false);
  assert.equal(h.positions.size, 1, "the open box survives STOP");

  // The monitor is wired to nothing but the position book — it does not consult
  // the scanner's state at all, which is exactly why STOP cannot orphan a box.
  await h.monitor.cycle();
  assert.equal(h.closes.length, 1, "the open box still auto-exits while stopped");
  assert.equal(h.closes[0].reason, "EDGE_CONVERGED");
  assert.equal(h.positions.size, 0);
});

test("the monitor keeps refreshing metrics and periodically persists them", async () => {
  const h = harness({ exitValuePerUnit: 180 }); // no exit trigger
  await h.monitor.cycle();
  assert.equal(h.closes.length, 0);
  assert.ok(h.position.metrics, "metrics are refreshed every cycle");
  assert.equal(h.position.metrics.exit_box_value_per_unit, 180);

  // Force the persistence window open and confirm the slow flush happens.
  h.position.last_persist_at = 0;
  await h.monitor.cycle();
  assert.deepEqual(h.persisted, ["box1"]);
  assert.ok(h.monitor.getStats().cycles >= 2);
});

test("cycles never overlap, so a slow charge call cannot double-close a box", async () => {
  const h = harness({ exitValuePerUnit: 198 });
  await Promise.all([h.monitor.cycle(), h.monitor.cycle(), h.monitor.cycle()]);
  assert.equal(h.closes.length, 1);
});

/* ----------------------------- expiry safety ------------------------------ */

test("the expiry-safety window is entered on expiry day near the close", async () => {
  // Expiring today, 15:00 IST — inside the default 45-minute window.
  const h = harness({
    exitValuePerUnit: 180,
    expiry: "2026-08-29",
    istDay: "2026-08-29",
    istMinutes: 15 * 60,
  });
  await h.monitor.cycle();

  assert.equal(h.position.expiry_safety ?? false, true);
  assert.ok(h.events.some((e) => e.event === "EXPIRY_SAFETY"));
  // It closes even though no convergence/profit rule fired, because an abandoned
  // box at expiry is the worse outcome.
  assert.equal(h.closes.length, 1);
  assert.equal(h.closes[0].reason, "EXPIRY_SAFETY");
});

test("expiry safety still refuses to invent prices when the touch is not there", async () => {
  const h = harness({
    exitValuePerUnit: 180,
    qty: 40,
    expiry: "2026-08-29",
    istDay: "2026-08-29",
    istMinutes: 15 * 60,
  });
  await h.monitor.cycle();

  assert.equal(h.closes.length, 0, "no fabricated expiry close");
  assert.equal(h.positions.size, 1);
  assert.ok(h.events.some((e) => e.event === "EXPIRY_SAFETY"));
  assert.ok(h.events.some((e) => e.event === "EXIT_SKIPPED_LIQUIDITY"));
  assert.ok(h.position.exit_blocked_reason, "the condition is exposed, not hidden");
});

test("a box expiring later is not in the expiry-safety window", async () => {
  const h = harness({
    exitValuePerUnit: 180,
    expiry: "2026-09-24",
    istDay: "2026-08-29",
    istMinutes: 15 * 60,
  });
  await h.monitor.cycle();
  assert.equal(h.position.expiry_safety, false);
  assert.equal(h.closes.length, 0);
});


/* ---------------------------- market closed ------------------------------- */

test("market CLOSED: metrics keep refreshing but no exit is attempted", async () => {
  // A box that WOULD auto-exit during market hours.
  const h = harness({ exitValuePerUnit: 198, marketOpen: false });
  await h.monitor.cycle();

  assert.equal(h.closes.length, 0, "there is nothing to close into after hours");
  assert.equal(h.positions.size, 1);
  // The position is still measured, so the UI stays informative overnight.
  assert.ok(h.position.metrics, "metrics are still refreshed");
  assert.equal(h.position.metrics.remaining_edge, (200 - 198) * LOT);
  // "The market is shut" is not a liquidity event, so nothing is logged.
  assert.equal(h.events.length, 0);
  assert.equal(h.position.exit_blocked_reason, null);
});

test("market CLOSED does not fabricate an expiry-safety close either", async () => {
  const h = harness({
    exitValuePerUnit: 180,
    expiry: "2026-08-29",
    istDay: "2026-08-29",
    istMinutes: 16 * 60, // past the close
    marketOpen: false,
  });
  await h.monitor.cycle();
  assert.equal(h.closes.length, 0);
  assert.equal(h.positions.size, 1);
});

/* --------------------------- ledger de-duplication ------------------------ */

test("a persistent liquidity gap is logged once, not once per cycle", async () => {
  const h = harness({ exitValuePerUnit: 198, qty: 40 });

  for (let i = 0; i < 5; i++) await h.monitor.cycle();

  const skipped = h.events.filter((e) => e.event === "EXIT_SKIPPED_LIQUIDITY");
  assert.equal(skipped.length, 1, "the same blockage must not spam the ledger");
  assert.equal(h.positions.size, 1);
  // The displayed reason is still kept current for the operator.
  assert.match(h.position.exit_blocked_reason, /needs 75/);
});

test("liquidityGapKey is stable across cycles but changes when the cause does", () => {
  const base = (over = {}) => ({
    role: "k1_ce",
    side: "SELL",
    tradingsymbol: "A",
    price: 10,
    qty_at_touch: 40,
    fresh: true,
    quote_at: 1,
    age_ms: 5,
    ...over,
  });
  const ok = { role: "k2_ce", side: "BUY", tradingsymbol: "B", price: 10, qty_at_touch: 200, fresh: true, quote_at: 1, age_ms: 5 };

  // Same cause, different volatile numbers → same key (so no repeat ledger row).
  const a = liquidityGapKey([base({ age_ms: 5 }), ok], 75);
  const b = liquidityGapKey([base({ age_ms: 900, qty_at_touch: 41 }), ok], 75);
  assert.equal(a, b);
  assert.equal(a, "k1_ce:thin");

  // A different cause → a different key, so it IS reported.
  const stale = liquidityGapKey([base({ fresh: false }), ok], 75);
  assert.notEqual(stale, a);
  assert.equal(stale, "k1_ce:stale");

  // Everything fillable → no gap at all.
  assert.equal(liquidityGapKey([base({ qty_at_touch: 200 }), ok], 75), "ok");
});
