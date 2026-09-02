import test from "node:test";
import assert from "node:assert/strict";

import { CentralBoxExecutionGateway } from "../../dist/box/executionGateway.js";
import { exitSideFor } from "../../dist/box/math.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import {
  cfg,
  exitQuotes,
  goodCandidate,
  positionFrom,
  seedStore,
} from "./helpers.mjs";

const ROLES = ["k1_ce", "k2_ce", "k2_pe", "k1_pe"];

function brokerOrder(req, filled = req.quantity) {
  return {
    client_order_id: req.client_order_id,
    broker_order_id: `B-${req.role}`,
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
    state: filled === req.quantity ? "COMPLETE" : "PARTIALLY_FILLED",
    filled_quantity: filled,
    pending_quantity: req.quantity - filled,
    average_price: filled > 0 ? req.pricing.reference_price : null,
    fills: filled > 0 ? [{ fill_id: `fill-${req.role}-${filled}`, quantity: filled, price: req.pricing.reference_price, at: 10_100 }] : [],
    reject_family: null,
    reject_reason: null,
    created_at: 10_000,
    updated_at: 10_100,
  };
}

function liveHarness({ fillByRole = {} } = {}) {
  const { candidate } = goodCandidate();
  const now = 10_000;
  const quotes = new BoxQuoteStore();
  seedStore(quotes, exitQuotes(candidate, 198, { at: now, qty: 500 }), now);
  const submitted = [];
  const violations = [];
  const manager = {
    status: () => ({ inFlight: 0, queued: 0 }),
    submit: async (req) => {
      submitted.push(structuredClone(req));
      return brokerOrder(req, fillByRole[req.role] ?? req.quantity);
    },
    invariantViolation: (reason) => violations.push(reason),
  };
  const simulator = {
    hasCapacity: () => false,
    estimateExecutableExit: () => [],
  };
  const gateway = new CentralBoxExecutionGateway({
    cfg: cfg({
      executionMode: "live",
      liveTradingEnabled: true,
      queueModel: "none",
      liveMaxChaseTicks: 2,
      legMaxChaseTicks: 2,
    }),
    simulator,
    quotes,
    manager,
    allocateTradeId: () => "allocated-trade",
    isTokenWarm: () => true,
    now: () => now,
  });
  return { candidate, quotes, submitted, violations, manager, gateway, now };
}

function detectionLegs(candidate, quotes) {
  return ROLES.map((role) => {
    const inst = candidate.legs[role];
    const side = exitSideFor(role, candidate.direction);
    const quote = quotes.get(inst.token);
    return {
      role,
      side,
      token: inst.token,
      tradingsymbol: inst.tradingsymbol,
      strike: inst.strike,
      instrument_type: inst.instrument_type,
      price: side === "BUY" ? quote.ask : quote.bid,
      qty_at_touch: 500,
      bid: quote.bid,
      bid_qty: quote.bid_qty,
      ask: quote.ask,
      ask_qty: quote.ask_qty,
      quote_at: quote.at,
      quote_version: quote.version,
      depth: null,
      age_ms: 0,
      fresh: true,
      executable: true,
    };
  });
}

test("live gateway submits exactly the 1-4 nonzero outstanding roles and trusts broker-confirmed fills", async (t) => {
  const quantities = [35, 20, 10, 5];
  for (let count = 1; count <= 4; count++) {
    await t.test(`${count} outstanding role${count === 1 ? "" : "s"}`, async () => {
      const h = liveHarness();
      const remaining = Object.fromEntries(ROLES.map((role, index) => [role, index < count ? quantities[index] : 0]));
      const position = positionFrom(h.candidate, {
        id: `restart-${count}`,
        remaining_qty_by_role: remaining,
        position_state: "PARTIALLY_EXITED",
      });
      const result = await h.gateway.simulateLeggingExit({
        position,
        detectionLegs: detectionLegs(h.candidate, h.quotes),
        detectedAt: h.now,
        stillWanted: () => true,
      });

      assert.equal(result.ok, true);
      assert.equal(h.submitted.length, count);
      assert.deepEqual(
        h.submitted.map(({ role, quantity }) => [role, quantity]),
        ROLES.slice(0, count).map((role, index) => [role, quantities[index]]),
      );
      assert.equal(h.submitted.every((req) => req.quantity > 0 && req.pricing.order_type === "LIMIT"), true);
      assert.deepEqual(
        Object.entries(result.record.fills_by_role),
        ROLES.slice(0, count).map((role, index) => [role, quantities[index]]),
        "the gateway projects only broker-confirmed cumulative fills",
      );
      assert.deepEqual(h.violations, []);
    });
  }
});

test("live gateway projects a partial exit from broker cumulative fill, not requested quantity", async () => {
  const h = liveHarness({ fillByRole: { k1_ce: 12 } });
  const position = positionFrom(h.candidate, {
    id: "broker-partial",
    remaining_qty_by_role: { k1_ce: 35, k2_ce: 0, k2_pe: 0, k1_pe: 0 },
    position_state: "PARTIALLY_EXITED",
  });

  const result = await h.gateway.simulateLeggingExit({
    position,
    detectionLegs: detectionLegs(h.candidate, h.quotes),
    detectedAt: h.now,
    stillWanted: () => true,
  });

  assert.equal(result.ok, false, "12/35 broker-confirmed is not a clean close");
  assert.equal(h.submitted[0].quantity, 35, "the exact outstanding quantity was requested");
  assert.equal(result.record.fills_by_role.k1_ce, 12, "the audit uses broker cumulative fill");
  assert.equal(result.record.remaining_role_count, 1);
  assert.equal(result.legs[0].qty_at_touch, 12);
  assert.deepEqual(h.violations, [], "a confirmed partial is not an uncertain outcome");
});

test("restart exact-map flow persisted 75→35 submits only 35 for that role", async () => {
  const h = liveHarness();
  const position = positionFrom(h.candidate, {
    id: "persisted-restart",
    remaining_qty_by_role: { k1_ce: 0, k2_ce: 35, k2_pe: 0, k1_pe: 0 },
    position_state: "PARTIALLY_EXITED",
  });

  const result = await h.gateway.simulateLeggingExit({
    position,
    detectionLegs: detectionLegs(h.candidate, h.quotes),
    detectedAt: h.now,
    stillWanted: () => true,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(h.submitted.map(({ role, quantity }) => ({ role, quantity })), [{ role: "k2_ce", quantity: 35 }]);
  assert.equal(result.record.fills_by_role.k2_ce, 35);
});

test("paper gateway delegation remains byte-for-byte unchanged", async () => {
  const calls = [];
  const values = {
    entry: { entry: true },
    legEntry: { legEntry: true },
    exit: { exit: true },
    legExit: { legExit: true },
    estimate: [{ estimate: true }],
    flatten: { flatten: true },
  };
  const simulator = {
    hasCapacity: () => true,
    simulateEntry: async (arg) => { calls.push(["entry", arg]); return values.entry; },
    simulateLeggingEntry: async (arg) => { calls.push(["legEntry", arg]); return values.legEntry; },
    simulateExit: async (arg) => { calls.push(["exit", arg]); return values.exit; },
    simulateLeggingExit: async (arg) => { calls.push(["legExit", arg]); return values.legExit; },
    estimateExecutableExit: (arg, now) => { calls.push(["estimate", arg, now]); return values.estimate; },
    flattenResidual: async (arg) => { calls.push(["flatten", arg]); return values.flatten; },
  };
  const gateway = new CentralBoxExecutionGateway({
    cfg: cfg({ executionMode: "paper_legging" }),
    simulator,
    quotes: new BoxQuoteStore(),
  });
  const args = { stable: "same-object" };

  assert.equal(gateway.hasCapacity(), true);
  assert.equal(await gateway.simulateEntry(args), values.entry);
  assert.equal(await gateway.simulateLeggingEntry(args), values.legEntry);
  assert.equal(await gateway.simulateExit(args), values.exit);
  assert.equal(await gateway.simulateLeggingExit(args), values.legExit);
  assert.equal(gateway.estimateExecutableExit(args, 123), values.estimate);
  assert.equal(await gateway.flattenResidual(args), values.flatten);
  assert.equal(calls.every((call) => call[1] === args), true, "paper arguments are delegated by identity without rewriting");
});
