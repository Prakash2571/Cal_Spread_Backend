import test from "node:test";
import assert from "node:assert/strict";

import { CentralBoxExecutionGateway } from "../../dist/box/executionGateway.js";
import { entrySideFor } from "../../dist/box/math.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { BOX_LEG_ROLES } from "../../dist/box/types.js";
import { cfg, exitQuotes, goodCandidate, seedStore } from "./helpers.mjs";

const NOW = 10_000;

function brokerOrder(req, filled = req.quantity, state) {
  return {
    client_order_id: req.client_order_id,
    broker_order_id: `B-${req.role}-${req.purpose}`,
    tag: null,
    role: req.role,
    trade_id: req.trade_id,
    attempt_id: req.attempt_id,
    purpose: req.purpose,
    phase: req.phase,
    exchange: req.exchange,
    tradingsymbol: req.tradingsymbol,
    token: req.token,
    side: req.side,
    quantity: req.quantity,
    pricing: { ...req.pricing },
    limit_price: req.pricing.limit_price,
    state: state ?? (filled >= req.quantity ? "COMPLETE" : "PARTIALLY_FILLED"),
    filled_quantity: filled,
    pending_quantity: Math.max(0, req.quantity - filled),
    average_price: filled > 0 ? req.pricing.reference_price : null,
    fills: filled > 0 ? [{ fill_id: `f-${req.role}`, quantity: filled, price: req.pricing.reference_price, at: NOW + 100 }] : [],
    reject_family: null,
    reject_reason: null,
    created_at: NOW,
    updated_at: NOW + 100,
  };
}

/** Detection legs priced from the seeded book, on the ENTRY side of each role. */
function detectionFor(candidate, quotes) {
  return {
    candidate,
    at: NOW,
    legs: BOX_LEG_ROLES.map((role) => {
      const leg = candidate.legs[role];
      const q = quotes.get(leg.token);
      const side = entrySideFor(role, candidate.direction ?? "LONG_BOX");
      const price = side === "BUY" ? q.asks[0].price : q.bids[0].price;
      return {
        role,
        side,
        token: leg.token,
        tradingsymbol: leg.tradingsymbol,
        strike: leg.strike,
        instrument_type: leg.instrument_type,
        price,
        qty_at_touch: candidate.lot_size,
        bid: q.bids[0].price, bid_qty: q.bids[0].quantity,
        ask: q.asks[0].price, ask_qty: q.asks[0].quantity,
        quote_at: q.at, exchange_at: null, quote_version: q.version, depth: null,
        age_ms: 0, fresh: true, executable: true,
      };
    }),
    entry_net_debit_per_unit: 20,
    entry_box_cost_per_unit: 20,
    gross_edge_per_unit: 80,
    gross_edge: 4_000,
    tradable: true,
    depth_ok: true,
    worst_age_ms: 0,
    quote_version: 1,
    reject: null,
  };
}

/**
 * @param submit  the fake manager's submit. Receives the request and returns/throws a
 *   BrokerOrder, so a test controls exactly what the broker "confirmed".
 */
function harness(submit, config = {}) {
  const { candidate } = goodCandidate();
  const quotes = new BoxQuoteStore();
  // Deep books at a wide spread, so precheck admits both the entry and the reversed unwind.
  seedStore(quotes, exitQuotes(candidate, 198, { at: NOW, qty: 100_000 }), NOW);
  const submitted = [];
  const violations = [];
  const manager = {
    status: () => ({ inFlight: 0, queued: 0 }),
    submit: async (req, feed, capital) => {
      submitted.push({ ...structuredClone(req), _capital: capital ? structuredClone(capital) : null });
      return submit(req);
    },
    invariantViolation: (reason) => violations.push(reason),
  };
  const gateway = new CentralBoxExecutionGateway({
    cfg: cfg({
      executionMode: "live",
      liveTradingEnabled: true,
      queueModel: "none",
      liveMaxChaseTicks: 2,
      legMaxChaseTicks: 2,
      unwindMaxChaseTicks: 5,
      ...config,
    }),
    simulator: {
      hasCapacity: () => false,
      estimateExecutableExit: () => [],
      simulateLeggingEntry: async () => { throw new Error("live must not reach the simulator"); },
    },
    quotes,
    manager,
    broker: () => "zerodha",
    allocateTradeId: () => "allocated-trade",
    isTokenWarm: () => true,
    feedGeneration: () => 7,
    now: () => NOW,
    chargeTotal: () => 0,
  });
  return { candidate, quotes, gateway, manager, submitted, violations };
}

function entryOf(submitted) {
  return submitted.filter((r) => r.purpose === "ENTRY");
}
function unwindsOf(submitted) {
  return submitted.filter((r) => r.purpose === "EMERGENCY_RESIDUAL");
}

async function runEntry(h, { qualify = () => ({ qualifies: true, expected_net_profit: 5_000, min_expected_net_profit: 1_200 }) } = {}) {
  return h.gateway.simulateLeggingEntry({
    candidate: h.candidate,
    detection: detectionFor(h.candidate, h.quotes),
    stillWanted: () => true,
    qualify,
  });
}

/* ── 4/4 ─────────────────────────────────────────────────────────────────────────────── */

test("4/4 filled and qualifying opens the Box, labelled OPENED, with no unwind", async () => {
  const h = harness((req) => brokerOrder(req, req.quantity));
  const result = await runEntry(h);
  assert.equal(result.ok, true);
  assert.equal(result.legging.outcome_class, "OPENED");
  assert.equal(unwindsOf(h.submitted).length, 0);
  assert.deepEqual(h.violations, []);
});

/* ── partial fills ───────────────────────────────────────────────────────────────────── */

test("3 full + 1 zero: the Box is NOT opened and exactly three legs are unwound", async () => {
  const h = harness((req) =>
    req.purpose === "ENTRY"
      ? brokerOrder(req, req.role === "k1_pe" ? 0 : req.quantity)
      : brokerOrder(req, req.quantity));
  const result = await runEntry(h, {
    qualify: () => { throw new Error("an incomplete entry must never reach final economics"); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "legging_incomplete");
  assert.equal(result.legging.opened, false, "there is no valid Box");
  const unwinds = unwindsOf(h.submitted);
  assert.equal(unwinds.length, 3, "the zero-fill leg has nothing to reverse");
  assert.ok(!unwinds.some((u) => u.role === "k1_pe"));
  assert.equal(result.legging.outcome_class, "PARTIAL_ENTRY_UNWOUND");
  assert.deepEqual(result.legging.residual_exposure, []);
});

test("a SETTLED PARTIAL fill is authoritative and IS unwound at its exact quantity", async () => {
  // The regression guard: treating PARTIALLY_FILLED as "still working" would skip the unwind and
  // strand a confirmed fill as naked exposure.
  const h = harness((req) =>
    req.purpose === "ENTRY"
      ? brokerOrder(req, req.role === "k1_pe" ? 40 : req.quantity, req.role === "k1_pe" ? "PARTIALLY_FILLED" : "COMPLETE")
      : brokerOrder(req, req.quantity));
  const result = await runEntry(h, { qualify: () => { throw new Error("unreachable"); } });

  assert.equal(result.ok, false);
  const unwinds = unwindsOf(h.submitted);
  assert.equal(unwinds.length, 4, "the settled partial must be reversed too");
  assert.equal(unwinds.find((u) => u.role === "k1_pe").quantity, 40, "exactly the confirmed 40, not the full requested lot");
  assert.deepEqual(result.legging.residual_exposure, []);
});

test("the unwind reverses the ENTRY side on every leg", async () => {
  const h = harness((req) =>
    req.purpose === "ENTRY" ? brokerOrder(req, req.role === "k1_pe" ? 0 : req.quantity) : brokerOrder(req, req.quantity));
  await runEntry(h, { qualify: () => { throw new Error("unreachable"); } });
  const entries = new Map(entryOf(h.submitted).map((r) => [r.role, r.side]));
  for (const unwind of unwindsOf(h.submitted)) {
    assert.notEqual(unwind.side, entries.get(unwind.role), `${unwind.role} unwind must reverse the entry side`);
  }
});

test("no fill anywhere: nothing is unwound and the label is NO_FILL", async () => {
  const h = harness((req) => brokerOrder(req, 0));
  const result = await runEntry(h, { qualify: () => { throw new Error("unreachable"); } });
  assert.equal(result.ok, false);
  assert.equal(unwindsOf(h.submitted).length, 0, "no exposure means no charges to pay");
  assert.equal(result.legging.outcome_class, "NO_FILL");
  assert.match(result.detail, /no exposure to unwind/);
});

test("an INCOMPLETE unwind carries the remainder as durable residual, labelled RESIDUAL", async () => {
  const h = harness((req) => {
    if (req.purpose === "ENTRY") return brokerOrder(req, req.role === "k1_pe" ? 0 : req.quantity);
    // The unwind itself only partially fills on one leg.
    return brokerOrder(req, req.role === "k2_ce" ? 30 : req.quantity);
  });
  const result = await runEntry(h, { qualify: () => { throw new Error("unreachable"); } });
  assert.equal(result.ok, false);
  assert.equal(result.legging.outcome_class, "PARTIAL_ENTRY_RESIDUAL");
  const residual = result.legging.residual_exposure;
  assert.equal(residual.length, 1);
  assert.equal(residual[0].role, "k2_ce");
  assert.equal(residual[0].quantity, h.candidate.lot_size - 30, "exactly what the unwind did not cover");
  assert.equal(residual[0].source, "partial_entry");
});

/* ── unprovable quantity ─────────────────────────────────────────────────────────────── */

test("an UNKNOWN leg quarantines: nothing is unwound and nothing is opened", async () => {
  const h = harness((req) =>
    req.purpose === "ENTRY"
      ? brokerOrder(req, req.role === "k1_pe" ? 0 : req.quantity, req.role === "k1_pe" ? "UNKNOWN" : "COMPLETE")
      : brokerOrder(req, req.quantity));
  const result = await runEntry(h, { qualify: () => { throw new Error("unreachable"); } });

  assert.equal(result.ok, false);
  assert.equal(unwindsOf(h.submitted).length, 0, "unwinding an unproven quantity would create opposite exposure");
  assert.equal(result.legging.opened, false);
  assert.ok(
    h.violations.some((v) => /uncertain broker terminal quantity/.test(v)),
    "an unprovable quantity must raise an invariant violation",
  );
});

test("a RECONCILIATION_REQUIRED leg also quarantines rather than unwinding", async () => {
  const h = harness((req) =>
    req.purpose === "ENTRY"
      ? brokerOrder(req, req.quantity, req.role === "k2_pe" ? "RECONCILIATION_REQUIRED" : "COMPLETE")
      : brokerOrder(req, req.quantity));
  const result = await runEntry(h, { qualify: () => ({ qualifies: true }) });
  assert.equal(result.ok, false);
  assert.equal(unwindsOf(h.submitted).length, 0);
  assert.equal(result.legging.opened, false);
});

/* ── PART 4: filled, then economics failed ───────────────────────────────────────────── */

test("4/4 filled but failing final economics unwinds all four and reports abort_after_fill", async () => {
  const h = harness((req) => brokerOrder(req, req.quantity));
  const result = await runEntry(h, {
    qualify: () => ({ qualifies: false, expected_net_profit: 100, min_expected_net_profit: 1_200 }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "abort_after_fill");
  assert.equal(result.legging.abort_after_fill, true);
  assert.equal(unwindsOf(h.submitted).length, 4, "a complete Box is reversed on all four legs");
  assert.deepEqual(result.legging.residual_exposure, []);
});

test("it is labelled FILLED_THEN_ECONOMICS_ABORT, distinctly from a costless refusal", async () => {
  const h = harness((req) => brokerOrder(req, req.quantity));
  const result = await runEntry(h, {
    qualify: () => ({ qualifies: false, expected_net_profit: 100, min_expected_net_profit: 1_200 }),
  });
  assert.equal(result.legging.outcome_class, "FILLED_THEN_ECONOMICS_ABORT");
  // Explicitly NOT one of the no-cost labels: real orders really filled.
  assert.notEqual(result.legging.outcome_class, "NO_FILL");
  assert.notEqual(result.legging.outcome_class, "REFUSED_BEFORE_SUBMIT");
});

test("the abort records the executed economics and the gate they failed, so it can be sized", async () => {
  const h = harness((req) => brokerOrder(req, req.quantity));
  const result = await runEntry(h, {
    qualify: () => ({ qualifies: false, expected_net_profit: 250.5, min_expected_net_profit: 1_200 }),
  });
  assert.equal(result.legging.final_expected_net_profit, 250.5);
  assert.equal(result.legging.required_expected_net_profit, 1_200);
});

test("the economics abort is NOT reached when the entry was incomplete", async () => {
  // Ordering matters: an incomplete entry must be unwound as a partial, never evaluated for
  // economics and then relabelled as an abort-after-fill it was not.
  let qualifyCalls = 0;
  const h = harness((req) =>
    req.purpose === "ENTRY" ? brokerOrder(req, req.role === "k1_ce" ? 0 : req.quantity) : brokerOrder(req, req.quantity));
  const result = await runEntry(h, { qualify: () => { qualifyCalls++; return { qualifies: false }; } });
  assert.equal(qualifyCalls, 0, "final economics must not run on an incomplete Box");
  assert.equal(result.reason, "legging_incomplete");
  assert.notEqual(result.legging.outcome_class, "FILLED_THEN_ECONOMICS_ABORT");
});

/* ── conservation ────────────────────────────────────────────────────────────────────── */

test("an unwind exceeding the confirmed fill raises a conservation violation", async () => {
  // Broker truth reports MORE unwound than was ever entered: that is new opposite exposure and
  // must reach RECOVERY rather than being clamped away.
  const h = harness((req) => {
    if (req.purpose === "ENTRY") return brokerOrder(req, req.role === "k1_pe" ? 0 : 40, "PARTIALLY_FILLED");
    return brokerOrder(req, req.quantity + 10, "COMPLETE");
  });
  await runEntry(h, { qualify: () => { throw new Error("unreachable"); } });
  assert.ok(
    h.violations.some((v) => /violated quantity conservation/.test(v)),
    `expected a conservation violation, got: ${JSON.stringify(h.violations)}`,
  );
  assert.ok(h.violations.some((v) => /unwound_more_than_confirmed|overfill/.test(v)));
});

test("a clean partial unwind raises NO conservation violation", async () => {
  const h = harness((req) =>
    req.purpose === "ENTRY" ? brokerOrder(req, req.role === "k1_pe" ? 0 : req.quantity) : brokerOrder(req, req.quantity));
  await runEntry(h, { qualify: () => { throw new Error("unreachable"); } });
  assert.ok(
    !h.violations.some((v) => /violated quantity conservation/.test(v)),
    `unexpected conservation violation: ${JSON.stringify(h.violations)}`,
  );
});

test("exact per-role quantity conservation holds: entry fill = unwind fill + residual", async () => {
  const h = harness((req) => {
    if (req.purpose === "ENTRY") return brokerOrder(req, req.role === "k1_pe" ? 0 : 50, "PARTIALLY_FILLED");
    return brokerOrder(req, req.role === "k2_pe" ? 20 : req.quantity);
  });
  const result = await runEntry(h, { qualify: () => { throw new Error("unreachable"); } });

  const residualByRole = new Map(result.legging.residual_exposure.map((r) => [r.role, r.quantity]));
  for (const leg of result.legging.legs) {
    const entryFill = leg.fill_qty ?? 0;
    const unwound = leg.unwound_qty ?? 0;
    const residual = residualByRole.get(leg.role) ?? 0;
    assert.equal(
      entryFill,
      unwound + residual,
      `${leg.role}: entry ${entryFill} must equal unwound ${unwound} + residual ${residual}`,
    );
    assert.ok(residual >= 0, `${leg.role}: residual must never be negative`);
  }
});

/* ── the capital stamp rides on every entry leg ──────────────────────────────────────── */

test("every ENTRY leg carries the Box-level capital stamp for the dequeue re-check", async () => {
  const h = harness((req) => brokerOrder(req, req.quantity), { liveMaxBoxCapitalRupees: 10_000_000 });
  await runEntry(h);
  const entries = entryOf(h.submitted);
  assert.equal(entries.length, 4);
  for (const entry of entries) {
    assert.ok(entry._capital, `${entry.role} must carry a capital stamp`);
    assert.equal(entry._capital.candidate_key, h.candidate.key);
    assert.ok(entry._capital.box_notional_paise > 0);
  }
  // All four legs share ONE Box-level figure — it is a property of the set, not of a leg.
  const distinct = new Set(entries.map((e) => e._capital.box_notional_paise));
  assert.equal(distinct.size, 1);
});

test("an UNWIND leg carries NO capital stamp: the cap gates entry only", async () => {
  const h = harness(
    (req) => (req.purpose === "ENTRY" ? brokerOrder(req, req.role === "k1_pe" ? 0 : req.quantity) : brokerOrder(req, req.quantity)),
    { liveMaxBoxCapitalRupees: 10_000_000 },
  );
  await runEntry(h, { qualify: () => { throw new Error("unreachable"); } });
  for (const unwind of unwindsOf(h.submitted)) {
    assert.equal(unwind._capital, null, "a reduction must never be gated by the entry capital cap");
  }
});

test("the per-Box capital cap refuses BEFORE any broker submission", async () => {
  // 4 legs x 75 x ~350 = ~105,000, so a 1,000 cap must refuse.
  const h = harness((req) => brokerOrder(req, req.quantity), { liveMaxBoxCapitalRupees: 1_000 });
  const result = await runEntry(h);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "box_capital_limit");
  assert.equal(h.submitted.length, 0, "nothing may reach the broker");
  assert.match(result.detail, /NOT broker margin/);
});
