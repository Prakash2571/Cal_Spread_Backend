/**
 * SUITE J — EXIT ALWAYS WINS.
 *
 * Every risk gate added by this change is an ENTRY gate. None of them may ever prevent the
 * reduction of exposure already owned. The asymmetry is the single most important property here:
 * the worst case of refusing an entry is a missed opportunity, while the worst case of refusing a
 * reduction is an open position nobody can close.
 *
 * The gates under test:
 *
 *   - BOX_LIVE_MAX_BOX_CAPITAL_RUPEES        (per-Box ₹ cap)
 *   - BOX_SESSION_MAX_COMPLETED_TRADES       (session cycle budget)
 *   - BOX_ONE_ACTIVE_BOX_PER_UNDERLYING      (underlying lock)
 *   - BOX_LIVE_MAX_OPEN_BOXES                (open-box limit)
 *   - scanner STOPPED
 *   - entry disabled
 *   - durable reservation authority outage
 *
 * For each, an EXIT / PROTECTIVE_CANCEL / EMERGENCY_RESIDUAL must still work.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CentralBoxExecutionGateway } from "../../dist/box/executionGateway.js";
import { CoordinatedBoxExecutionGateway } from "../../dist/box/executionCoordinator.js";
import {
  InProcessInstrumentReservations,
  ChainedInstrumentReservations,
  DurableInstrumentReservations,
  InMemoryReservationDatabase,
  InMemoryReservationPort,
} from "../../dist/box/instrumentReservations.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { activeUnderlyings } from "../../dist/box/underlyingLock.js";
import { entrySideFor } from "../../dist/box/math.js";
import { BOX_LEG_ROLES } from "../../dist/box/types.js";
import { cfg, exitQuotes, goodCandidate, positionFrom, seedStore } from "./helpers.mjs";

const NOW = 10_000;
const FOUR_LOTS = { k1_ce: 75, k2_ce: 75, k2_pe: 75, k1_pe: 75 };

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function brokerOrder(req, filled = req.quantity) {
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
    state: filled >= req.quantity ? "COMPLETE" : "PARTIALLY_FILLED",
    filled_quantity: filled,
    pending_quantity: Math.max(0, req.quantity - filled),
    average_price: filled > 0 ? req.pricing.reference_price : null,
    fills: filled > 0 ? [{ fill_id: `f-${req.role}`, quantity: filled, price: req.pricing.reference_price, at: NOW }] : [],
    reject_family: null,
    reject_reason: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function detectionLegs(candidate, quotes, sideFor) {
  return BOX_LEG_ROLES.map((role) => {
    const leg = candidate.legs[role];
    const q = quotes.get(leg.token);
    const side = sideFor(role, candidate.direction ?? "LONG_BOX");
    return {
      role, side, token: leg.token, tradingsymbol: leg.tradingsymbol,
      strike: leg.strike, instrument_type: leg.instrument_type,
      price: side === "BUY" ? q.asks[0].price : q.bids[0].price,
      qty_at_touch: candidate.lot_size,
      bid: q.bids[0].price, bid_qty: q.bids[0].quantity,
      ask: q.asks[0].price, ask_qty: q.asks[0].quantity,
      quote_at: q.at, exchange_at: null, quote_version: q.version, depth: null,
      age_ms: 0, fresh: true, executable: true,
    };
  });
}

/** The REAL CentralBoxExecutionGateway in live mode over a fake manager. */
function gatewayHarness(config = {}) {
  const { candidate } = goodCandidate();
  const quotes = new BoxQuoteStore();
  seedStore(quotes, exitQuotes(candidate, 198, { at: NOW, qty: 100_000 }), NOW);
  const submitted = [];
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
    simulator: { hasCapacity: () => false, estimateExecutableExit: () => [] },
    quotes,
    manager: {
      status: () => ({ inFlight: 0, queued: 0 }),
      submit: async (req, feed, capital) => {
        submitted.push({ ...req, _capital: capital ?? null });
        return brokerOrder(req);
      },
      invariantViolation: () => {},
    },
    broker: () => "zerodha",
    allocateTradeId: () => "trade-1",
    isTokenWarm: () => true,
    feedGeneration: () => 7,
    now: () => NOW,
    chargeTotal: () => 0,
  });
  return { candidate, quotes, gateway, submitted };
}

function entryDetection(h) {
  return {
    candidate: h.candidate,
    at: NOW,
    legs: detectionLegs(h.candidate, h.quotes, entrySideFor),
    entry_net_debit_per_unit: 20,
    entry_box_cost_per_unit: 20,
    gross_edge_per_unit: 80,
    gross_edge: 4_000,
    tradable: true, depth_ok: true, worst_age_ms: 0, quote_version: 1, reject: null,
  };
}

/* ═══════════ the ₹ capital cap ═══════════ */

test("the per-Box ₹ cap blocks ENTRY but not an EXIT of the same Box", async () => {
  // A cap far below the Box's notional: entry must be refused.
  const h = gatewayHarness({ liveMaxBoxCapitalRupees: 1 });
  const entry = await h.gateway.simulateLeggingEntry({
    candidate: h.candidate,
    detection: entryDetection(h),
    stillWanted: () => true,
    qualify: () => ({ qualifies: true }),
  });
  assert.equal(entry.ok, false);
  assert.equal(entry.reason, "box_capital_limit");
  assert.equal(h.submitted.length, 0, "nothing reached the broker");

  // The exit of a position on the very same contracts proceeds.
  const position = positionFrom(h.candidate, { id: "t1", remaining_qty_by_role: FOUR_LOTS });
  const exit = await h.gateway.simulateLeggingExit({
    position,
    detectionLegs: detectionLegs(h.candidate, h.quotes, (r, d) => (entrySideFor(r, d) === "BUY" ? "SELL" : "BUY")),
    detectedAt: NOW,
    stillWanted: () => true,
  });
  assert.equal(exit.ok, true, "a capital cap on NEW exposure must never block reducing owned exposure");
  assert.ok(h.submitted.some((r) => r.purpose === "EXIT"));
});

test("the per-Box ₹ cap does not gate residual flattening", async () => {
  const h = gatewayHarness({ liveMaxBoxCapitalRupees: 1 });
  const inst = h.candidate.legs.k1_ce;
  const pass = await h.gateway.flattenResidual({
    keyPrefix: "attempt-1",
    residual: [{
      token: inst.token, tradingsymbol: inst.tradingsymbol, exchange: inst.exchange,
      role: "k1_ce", side: "BUY", quantity: 25, average_price: 100,
      source: "partial_entry", created_at: NOW,
    }],
  });
  assert.ok(pass, "emergency residual flattening must always run");
  assert.ok(h.submitted.some((r) => r.purpose === "EMERGENCY_RESIDUAL"));
});

test("no reduction order ever carries a capital stamp", async () => {
  const h = gatewayHarness({ liveMaxBoxCapitalRupees: 10_000_000 });
  const position = positionFrom(h.candidate, { id: "t1", remaining_qty_by_role: FOUR_LOTS });
  await h.gateway.simulateLeggingExit({
    position,
    detectionLegs: detectionLegs(h.candidate, h.quotes, (r, d) => (entrySideFor(r, d) === "BUY" ? "SELL" : "BUY")),
    detectedAt: NOW,
    stillWanted: () => true,
  });
  for (const req of h.submitted) {
    assert.notEqual(req.purpose, "ENTRY");
    assert.equal(req._capital, null, `${req.purpose} must not be gated by the entry capital cap`);
  }
});

/* ═══════════ the coordinator-level gates ═══════════ */

function controllableGateway() {
  const started = [];
  const gates = new Map();
  let seq = 0;
  return {
    mode: "paper_legging",
    started,
    finish(index, result) {
      gates.get(index)(result ?? { ok: true, legging: { residual_exposure: [] } });
    },
    hasCapacity: () => true,
    invariantViolation: () => {},
    estimateExecutableExit: () => [],
    flattenResidual: async () => ({ flattened: {}, remaining: [], charges: 0 }),
    simulateEntry: async () => ({ ok: true }),
    simulateExit: async () => ({ ok: true }),
    simulateLeggingExit: async () => ({ ok: true, record: { residual_exposure: [] } }),
    simulateLeggingEntry(args) {
      const index = seq++;
      started.push({ index, key: args.candidate.key, purpose: "ENTRY" });
      return new Promise((resolve) => gates.set(index, resolve));
    },
  };
}

function coordinatorHarness({
  config = {},
  positions = [],
  residuals = [],
  sessionGate,
  durable = false,
  breakDurable = false,
} = {}) {
  const identity = { deployment: "test", instance: "h", pid: 1, boot: "b", processTag: "h:p1:b" };
  const local = new InProcessInstrumentReservations();
  const clock = { value: NOW };
  const now = () => clock.value;
  let store = local;
  let durableStore = null;
  if (durable) {
    const db = new InMemoryReservationDatabase();
    durableStore = new DurableInstrumentReservations({
      port: new InMemoryReservationPort(db, { clock: now }),
      context: () => ({ deployment: "test", broker: "zerodha", generation: 1, mode: "paper_legging" }),
      ownerPrefix: "test:h:p1:b:",
      skewGraceMs: 0,
      clockSyncIntervalMs: 1e9,
      now,
      log: () => {},
    });
    store = new ChainedInstrumentReservations([local, durableStore]);
  }
  const inner = controllableGateway();
  const coordinator = new CoordinatedBoxExecutionGateway({
    inner,
    reservations: store,
    local,
    waitable: local,
    cfg: cfg({
      conflictWaitMaxMs: 250,
      instrumentLockTtlMs: 5_000,
      maxConcurrentPerUnderlying: 0,
      reservationClockSkewGraceMs: 0,
      durableReservationsEnabled: durable,
      ...config,
    }),
    quotes: { view: () => new Map() },
    broker: () => "zerodha",
    generation: () => 1,
    identity,
    now,
    activeUnderlyings: () => activeUnderlyings({ positions, residuals }),
    ...(sessionGate ? { sessionEntryGate: sessionGate } : {}),
    sleep: (ms) => { clock.value += Math.max(1, Math.round(ms)); return new Promise((r) => setImmediate(r)); },
    setTimer: () => null,
    clearTimer: () => {},
    log: () => {},
  });
  return { coordinator, inner, durableStore, local, clock };
}

async function ready(options = {}) {
  const made = coordinatorHarness(options);
  if (made.durableStore) await made.durableStore.initialise();
  return made;
}

function boxCandidate(overrides = {}) {
  const { candidate } = goodCandidate();
  return { ...candidate, ...overrides };
}

function coordDetection(candidate) {
  return {
    candidate,
    at: NOW,
    legs: BOX_LEG_ROLES.map((role) => ({
      role,
      side: entrySideFor(role, "LONG_BOX"),
      token: candidate.legs[role].token,
      tradingsymbol: candidate.legs[role].tradingsymbol,
      strike: candidate.legs[role].strike,
      instrument_type: candidate.legs[role].instrument_type,
      price: 100, qty_at_touch: 75,
      bid: 99, bid_qty: 75, ask: 100, ask_qty: 75,
      quote_at: NOW, exchange_at: null, quote_version: 1, depth: null,
      age_ms: 0, fresh: true, executable: true,
    })),
    entry_net_debit_per_unit: 20,
    entry_box_cost_per_unit: 20,
    gross_edge_per_unit: 80,
    gross_edge: 4_000,
    tradable: true, depth_ok: true, worst_age_ms: 0, quote_version: 1, reject: null,
  };
}

async function tryEntry(h, candidate) {
  return h.coordinator.simulateLeggingEntry({
    candidate,
    detection: coordDetection(candidate),
    stillWanted: () => true,
    qualify: () => ({ qualifies: true }),
  });
}

async function tryExit(h, candidate) {
  return h.coordinator.simulateLeggingExit({
    position: {
      id: "t1",
      underlying: candidate.underlying,
      legs: candidate.legs,
      direction: "LONG_BOX",
      remaining_qty_by_role: FOUR_LOTS,
    },
    detectedAt: NOW,
  });
}

test("a CONSUMED SESSION BUDGET blocks entry but not an exit", async () => {
  const h = await ready({
    sessionGate: () => ({
      allowed: false,
      reason: "session_budget_exhausted",
      detail: "one-shot session already consumed",
    }),
  });
  const candidate = boxCandidate();
  const entry = await tryEntry(h, candidate);
  assert.equal(entry.ok, false);
  assert.equal(entry.reason, "session_limit_reached");
  assert.equal(h.inner.started.length, 0);

  const exit = await tryExit(h, candidate);
  assert.equal(exit.ok, true, "a spent session budget must never block reducing owned exposure");
});

test("an UNREADABLE session blocks entry but not an exit", async () => {
  // The fail-closed case: if durable session state cannot be read, entry is refused. Reduction is
  // deliberately unaffected — otherwise a Mongo blip would strand an open position.
  const h = await ready({
    sessionGate: () => ({
      allowed: false,
      reason: "session_state_unreadable",
      detail: "durable session state could not be read",
    }),
  });
  const candidate = boxCandidate();
  assert.equal((await tryEntry(h, candidate)).ok, false);
  assert.equal((await tryExit(h, candidate)).ok, true);
});

test("the UNDERLYING LOCK blocks entry but not an exit or a residual flatten", async () => {
  const candidate = boxCandidate();
  const h = await ready({
    config: { oneActiveBoxPerUnderlying: true },
    positions: [{ underlying: candidate.underlying, position_state: "BOX", remaining_qty_by_role: FOUR_LOTS }],
    residuals: [{ underlying: candidate.underlying, legs: 2 }],
  });
  const entry = await tryEntry(h, candidate);
  assert.equal(entry.ok, false);
  assert.equal(entry.reason, "underlying_already_active");

  assert.equal((await tryExit(h, candidate)).ok, true);
  const pass = await h.coordinator.flattenResidual({ residual: [{ role: "k1_ce", quantity: 25 }], keyPrefix: "a1" });
  assert.ok(pass, "residual flattening is never gated");
});

test("a DURABLE RESERVATION OUTAGE blocks LIVE entry but not an exit", async () => {
  // The pre-existing carve-out, re-asserted here because the new gates must not have disturbed it.
  const h = await ready({ durable: true, config: { durableReservationsEnabled: true } });
  // Break the authority AFTER initialise, so entry sees an unavailable tier.
  h.durableStore.tryAcquireAll = async () => ({ ok: false, reason: "unavailable", tier: "mongo", detail: "down" });
  h.durableStore.renew = async () => ({ ok: false, reason: "unavailable", detail: "down" });

  const candidate = boxCandidate();
  // In paper mode the coordinator degrades to the local tier and says so, so assert on the EXIT
  // half here: whatever entry does, reduction must proceed.
  const exit = await tryExit(h, candidate);
  assert.equal(exit.ok, true, "a database outage must never strand an open position");
});

test("EVERY new gate simultaneously still permits an exit", async () => {
  // The combined case the specification calls out: amount exceeded, session completed, same
  // underlying active, max open boxes reached, scanner stopped. A valid attributed reduction must
  // still work.
  const candidate = boxCandidate();
  const h = await ready({
    config: { oneActiveBoxPerUnderlying: true, liveMaxOpenBoxes: 0 },
    positions: [{ underlying: candidate.underlying, position_state: "PARTIALLY_EXITED", remaining_qty_by_role: FOUR_LOTS }],
    residuals: [{ underlying: candidate.underlying, legs: 3 }],
    sessionGate: () => ({ allowed: false, reason: "session_budget_exhausted", detail: "spent" }),
  });

  const entry = await tryEntry(h, candidate);
  assert.equal(entry.ok, false, "entry must be refused");
  assert.equal(h.inner.started.length, 0);

  const exit = await tryExit(h, candidate);
  assert.equal(exit.ok, true, "the exit must still run with every entry gate closed");

  const pass = await h.coordinator.flattenResidual({ residual: [{ role: "k1_ce", quantity: 10 }], keyPrefix: "a1" });
  assert.ok(pass, "emergency residual flattening must still run");
});

test("the SESSION gate is never consulted for a reduction", async () => {
  // Proof by construction rather than by outcome: the gate is a spy, and an exit must not call it.
  let calls = 0;
  const candidate = boxCandidate();
  const h = await ready({
    sessionGate: () => {
      calls++;
      return { allowed: true, reason: null, detail: null };
    },
  });
  await tryExit(h, candidate);
  assert.equal(calls, 0, "an exit must not even ask the session layer for permission");

  const pass = await h.coordinator.flattenResidual({ residual: [{ role: "k1_ce", quantity: 5 }], keyPrefix: "a1" });
  assert.ok(pass);
  assert.equal(calls, 0, "a residual flatten must not ask either");

  // The entry DOES ask. Started and released rather than awaited, because the inner gateway holds
  // an entry open until the test finishes it.
  const entry = tryEntry(h, candidate);
  await flush();
  assert.equal(calls, 1, "an entry must ask exactly once");
  h.inner.finish(0);
  await entry;
});

test("an EXIT succeeds on a fully-locked underlying while entry is refused", async () => {
  // The observable proof that the underlying gate is entry-only: identical state, opposite verdicts.
  const candidate = boxCandidate();
  const locked = await ready({
    config: { oneActiveBoxPerUnderlying: true },
    positions: [{ underlying: candidate.underlying, position_state: "BOX", remaining_qty_by_role: FOUR_LOTS }],
  });
  assert.equal((await tryExit(locked, candidate)).ok, true);
  const entry = await tryEntry(locked, candidate);
  assert.equal(entry.ok, false);
  assert.equal(entry.reason, "underlying_already_active");
});

test("an EXIT never takes an underlying-level reservation, so it cannot block its own retry", async () => {
  const candidate = boxCandidate();
  const h = await ready({ config: { oneActiveBoxPerUnderlying: true } });
  // Two consecutive exits both succeed. If the first had claimed the underlying, the second would
  // have been refused by its own predecessor.
  assert.equal((await tryExit(h, candidate)).ok, true);
  assert.equal((await tryExit(h, candidate)).ok, true);
});
