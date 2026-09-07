/**
 * SUITE D (integration) + SUITE E (exact-contract regression) — the underlying lock as WIRED.
 *
 * The pure policy is covered in underlyingLock.test.mjs. This suite drives the REAL
 * CoordinatedBoxExecutionGateway over the REAL reservation chain (in-process + durable), because
 * the properties that matter here are about wiring:
 *
 *   - both layers block: durable position state (Layer 1a) AND the entry-pipeline lease (Layer 1b),
 *   - the lease is claimed ATOMICALLY with the four contract keys, in one document,
 *   - the refusal reason is `underlying_already_active`, never a contract conflict,
 *   - the lock is released once a Box is flat, and NOT lost while it is open,
 *   - a second PROCESS is blocked too, via the durable tier,
 *   - EXITS and residual flattening are never gated by it,
 *   - with the restriction OFF, exact-contract behaviour is bit-for-bit unchanged.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CoordinatedBoxExecutionGateway } from "../../dist/box/executionCoordinator.js";
import {
  InProcessInstrumentReservations,
  ChainedInstrumentReservations,
  DurableInstrumentReservations,
  InMemoryReservationDatabase,
  InMemoryReservationPort,
} from "../../dist/box/instrumentReservations.js";
import { instrumentKey } from "../../dist/box/instrumentKey.js";
import {
  activeUnderlyings,
  isUnderlyingReservationKey,
  underlyingReservationKey,
} from "../../dist/box/underlyingLock.js";
import { entrySideFor } from "../../dist/box/math.js";
import { BOX_LEG_ROLES } from "../../dist/box/types.js";
import { cfg } from "./helpers.mjs";

const NOW = 1_700_000_000_000;
const FOUR_LOTS = { k1_ce: 50, k2_ce: 50, k2_pe: 50, k1_pe: 50 };

function workerIdentity(tag) {
  return { deployment: "test", instance: `host-${tag}`, pid: 1, boot: tag, processTag: `host-${tag}:p1:${tag}` };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function boxFor({ underlying = "RELIANCE", k1, k2, direction = "LONG_BOX", expiry = "2026-09-24" } = {}) {
  const leg = (strike, type) => ({
    token: Number(`${strike}${type === "CE" ? 1 : 2}`),
    tradingsymbol: `${underlying}${expiry.slice(2, 4)}SEP${strike}${type}`,
    exchange: "NFO",
    strike,
    instrument_type: type,
    expiry,
    lot_size: 50,
    tick_size: 0.05,
  });
  return {
    key: `${underlying}|${expiry}|${k1}|${k2}|${direction}`,
    underlying,
    name: underlying,
    is_index: false,
    expiry,
    direction,
    lower_strike: k1,
    upper_strike: k2,
    box_width: k2 - k1,
    lot_size: 50,
    legs: { k1_ce: leg(k1, "CE"), k2_ce: leg(k2, "CE"), k2_pe: leg(k2, "PE"), k1_pe: leg(k1, "PE") },
  };
}

function detectionFor(candidate) {
  return {
    candidate,
    at: NOW,
    legs: BOX_LEG_ROLES.map((role) => ({
      role,
      side: entrySideFor(role, candidate.direction),
      token: candidate.legs[role].token,
      tradingsymbol: candidate.legs[role].tradingsymbol,
      strike: candidate.legs[role].strike,
      instrument_type: candidate.legs[role].instrument_type,
      price: 100, qty_at_touch: 50,
      bid: 99, bid_qty: 50, ask: 100, ask_qty: 50,
      quote_at: NOW, exchange_at: null, quote_version: 1, depth: null,
      age_ms: 5, fresh: true, executable: true,
    })),
    entry_net_debit_per_unit: 20,
    entry_box_cost_per_unit: 20,
    gross_edge_per_unit: 80,
    gross_edge: 4000,
    tradable: true,
    depth_ok: true,
    worst_age_ms: 5,
    quote_version: 1,
    reject: null,
  };
}

function controllableGateway({ mode = "paper_legging" } = {}) {
  const started = [];
  const gates = new Map();
  let seq = 0;
  return {
    mode,
    started,
    finish(index, result) {
      const gate = gates.get(index);
      assert.ok(gate, `no execution at index ${index}`);
      gate(result ?? { ok: true, legging: { residual_exposure: [] } });
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
      started.push({ index, key: args.candidate.key });
      return new Promise((resolve) => gates.set(index, resolve));
    },
  };
}

/**
 * @param options.activeUnderlyings  a mutable array of position-like rows, so a test can make
 *   durable state change between executions exactly as the engine would.
 */
function makeCoordinator({
  gateway,
  config = {},
  broker = "zerodha",
  clock = { value: NOW },
  now = () => clock.value,
  durable = false,
  generation = { value: 1 },
  db = null,
  identity = workerIdentity("w0"),
  positions = [],
  residuals = [],
} = {}) {
  const local = new InProcessInstrumentReservations();
  const logs = [];
  const brokerRef = { value: broker };
  const context = () => ({
    deployment: identity.deployment,
    broker: brokerRef.value,
    generation: generation.value,
    mode: gateway.mode,
  });

  let store = local;
  let durableStore = null;
  let database = db;
  if (durable) {
    database = database ?? new InMemoryReservationDatabase();
    durableStore = new DurableInstrumentReservations({
      port: new InMemoryReservationPort(database, { clock: now }),
      context,
      ownerPrefix: `${identity.deployment}:${identity.processTag}:`,
      skewGraceMs: 0,
      clockSyncIntervalMs: 1_000_000_000,
      now,
      log: () => {},
    });
    store = new ChainedInstrumentReservations([local, durableStore]);
  }

  const state = { positions, residuals };
  const coordinator = new CoordinatedBoxExecutionGateway({
    inner: gateway,
    reservations: store,
    local,
    waitable: local,
    cfg: cfg({
      conflictWaitMaxMs: 250,
      instrumentLockTtlMs: 5000,
      maxConcurrentPerUnderlying: 0,
      reservationClockSkewGraceMs: 0,
      durableReservationsEnabled: durable,
      oneActiveBoxPerUnderlying: true,
      ...config,
    }),
    quotes: { view: () => new Map() },
    broker: () => brokerRef.value,
    generation: () => generation.value,
    identity,
    now,
    // Mirrors the engine's real callback: derived from durable-shaped state, synchronous.
    activeUnderlyings: () => activeUnderlyings({ positions: state.positions, residuals: state.residuals }),
    sleep: (ms) => {
      clock.value += Math.max(1, Math.round(ms));
      return new Promise((resolve) => setImmediate(resolve));
    },
    setTimer: () => null,
    clearTimer: () => {},
    log: (f) => logs.push(f),
  });
  return { coordinator, reservations: local, durableStore, store, database, logs, state, clock, brokerRef, generation };
}

async function ready(options = {}) {
  const made = makeCoordinator(options);
  if (made.durableStore !== null) await made.durableStore.initialise();
  return made;
}

/* ── LAYER 1a: durable position state blocks ────────────────────────────────────────── */

test("an OPEN RELIANCE Box blocks a different-strike RELIANCE Box, with no lease involved", async () => {
  const gateway = controllableGateway();
  const { coordinator, logs } = await ready({
    gateway,
    positions: [{ underlying: "RELIANCE", position_state: "BOX", remaining_qty_by_role: FOUR_LOTS }],
  });
  const candidate = boxFor({ k1: 2550, k2: 2650 });
  const result = await coordinator.simulateLeggingEntry({
    candidate,
    detection: detectionFor(candidate),
    stillWanted: () => true,
    qualify: () => ({ qualifies: true }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "underlying_already_active");
  assert.equal(gateway.started.length, 0, "the inner gateway must never be reached");
  assert.ok(logs.some((l) => l.status === "suppressed_underlying_active"));
});

test("the refusal is NOT a contract-reservation conflict, and says so", async () => {
  const gateway = controllableGateway();
  const { coordinator } = await ready({
    gateway,
    positions: [{ underlying: "RELIANCE", position_state: "BOX", remaining_qty_by_role: FOUR_LOTS }],
  });
  const candidate = boxFor({ k1: 2550, k2: 2650 });
  const result = await coordinator.simulateLeggingEntry({
    candidate, detection: detectionFor(candidate), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  assert.notEqual(result.reason, "duplicate");
  assert.match(result.detail, /regardless of strike pair, expiry or direction/);
  assert.match(result.detail, /NOT a contract reservation conflict/);
});

test("a PARTIAL, RECOVERY or RESIDUAL RELIANCE state each block a new RELIANCE Box", async () => {
  for (const [label, state] of [
    ["partial", { positions: [{ underlying: "RELIANCE", position_state: "PARTIALLY_EXITED", remaining_qty_by_role: { k1_ce: 50, k2_ce: 0, k2_pe: 50, k1_pe: 0 } }] }],
    ["recovery", { positions: [{ underlying: "RELIANCE", position_state: "RECOVERY", remaining_qty_by_role: FOUR_LOTS }] }],
    ["residual", { residuals: [{ underlying: "RELIANCE", legs: 2 }] }],
  ]) {
    const gateway = controllableGateway();
    const { coordinator } = await ready({ gateway, ...state });
    const candidate = boxFor({ k1: 2550, k2: 2650 });
    const result = await coordinator.simulateLeggingEntry({
      candidate, detection: detectionFor(candidate), stillWanted: () => true, qualify: () => ({ qualifies: true }),
    });
    assert.equal(result.ok, false, `${label} must block`);
    assert.equal(result.reason, "underlying_already_active", `${label} reason`);
  }
});

test("a DIFFERENT underlying is admitted while RELIANCE is active", async () => {
  const gateway = controllableGateway();
  const { coordinator } = await ready({
    gateway,
    positions: [{ underlying: "RELIANCE", position_state: "BOX", remaining_qty_by_role: FOUR_LOTS }],
  });
  const tcs = boxFor({ underlying: "TCS", k1: 3000, k2: 3100 });
  const pending = coordinator.simulateLeggingEntry({
    candidate: tcs, detection: detectionFor(tcs), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  await flush();
  assert.equal(gateway.started.length, 1, "TCS must be admitted");
  gateway.finish(0);
  assert.equal((await pending).ok, true);
});

test("a FULLY FLAT RELIANCE Box does NOT block: the lock is not permanent", async () => {
  const gateway = controllableGateway();
  const { coordinator } = await ready({
    gateway,
    positions: [{ underlying: "RELIANCE", position_state: "BOX", remaining_qty_by_role: { k1_ce: 0, k2_ce: 0, k2_pe: 0, k1_pe: 0 } }],
  });
  const candidate = boxFor({ k1: 2550, k2: 2650 });
  const pending = coordinator.simulateLeggingEntry({
    candidate, detection: detectionFor(candidate), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  await flush();
  assert.equal(gateway.started.length, 1);
  gateway.finish(0);
  assert.equal((await pending).ok, true);
});

/* ── LAYER 1b: the entry-pipeline lease ─────────────────────────────────────────────── */

test("the underlying key is claimed ATOMICALLY with the four contract keys, in one document", async () => {
  const gateway = controllableGateway();
  const { coordinator, reservations } = await ready({ gateway });
  const candidate = boxFor({ k1: 2500, k2: 2600 });
  const pending = coordinator.simulateLeggingEntry({
    candidate, detection: detectionFor(candidate), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  await flush();

  const held = reservations.activeKeys(NOW);
  assert.equal(held.length, 5, "four contracts plus the underlying");
  const underlyingKeys = held.filter(isUnderlyingReservationKey);
  assert.deepEqual(underlyingKeys, [underlyingReservationKey("zerodha", "RELIANCE")]);
  // And the four contract keys are still exactly the contracts.
  const contractKeys = held.filter((k) => !isUnderlyingReservationKey(k)).sort();
  assert.deepEqual(
    contractKeys,
    BOX_LEG_ROLES.map((role) => instrumentKey("zerodha", candidate.legs[role])).sort(),
  );

  gateway.finish(0);
  await pending;
});

test("a second in-flight RELIANCE entry is refused by the LEASE, with no durable position yet", async () => {
  // Nothing is in `positions` — this is purely the pipeline-ownership layer.
  const gateway = controllableGateway();
  const { coordinator } = await ready({ gateway });
  const first = boxFor({ k1: 2500, k2: 2600 });
  const second = boxFor({ k1: 2550, k2: 2650 });

  const a = coordinator.simulateLeggingEntry({
    candidate: first, detection: detectionFor(first), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  await flush();
  assert.equal(gateway.started.length, 1);

  const b = await coordinator.simulateLeggingEntry({
    candidate: second, detection: detectionFor(second), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  assert.equal(b.ok, false);
  assert.equal(b.reason, "underlying_already_active");
  assert.equal(gateway.started.length, 1, "the second Box must never reach the gateway");

  gateway.finish(0);
  await a;
});

/* ── LAYER 1c: durable open-position ownership ──────────────────────────────────────── */

test("a SUCCESSFUL entry CONVERTS its lease into an open-position claim rather than releasing it", async () => {
  // THE GAP THIS CLOSES. If a clean settle released the underlying, there would be an instant
  // between "entry settled" and "the engine registered the position" in which neither layer
  // blocked — and a SIBLING PROCESS, which cannot see this process's in-memory position book,
  // could open a second Box on the underlying. The lease is therefore transferred, not released.
  const gateway = controllableGateway();
  const { coordinator, reservations } = await ready({ gateway });
  const first = boxFor({ k1: 2500, k2: 2600 });
  const a = coordinator.simulateLeggingEntry({
    candidate: first, detection: detectionFor(first), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  await flush();
  gateway.finish(0, { ok: true, legging: { trade_id: "trade-1", residual_exposure: [] } });
  assert.equal((await a).ok, true);
  await flush();

  assert.ok(
    reservations.activeKeys(NOW).some(isUnderlyingReservationKey),
    "the underlying must stay protected after a successful entry",
  );
  assert.deepEqual(coordinator.claimedUnderlyings(), ["RELIANCE"]);
});

test("a second RELIANCE Box is refused while the open-position claim is held", async () => {
  const gateway = controllableGateway();
  const { coordinator } = await ready({ gateway });
  const first = boxFor({ k1: 2500, k2: 2600 });
  const a = coordinator.simulateLeggingEntry({
    candidate: first, detection: detectionFor(first), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  await flush();
  gateway.finish(0, { ok: true, legging: { trade_id: "trade-1", residual_exposure: [] } });
  await a;
  await flush();

  const second = boxFor({ k1: 2550, k2: 2650 });
  const b = await coordinator.simulateLeggingEntry({
    candidate: second, detection: detectionFor(second), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  assert.equal(b.ok, false);
  assert.equal(b.reason, "underlying_already_active");
  assert.equal(gateway.started.length, 1);
});

test("releasing the claim when the Box is FLAT frees the underlying for the next cycle", async () => {
  const gateway = controllableGateway();
  const { coordinator, reservations } = await ready({ gateway });
  const first = boxFor({ k1: 2500, k2: 2600 });
  const a = coordinator.simulateLeggingEntry({
    candidate: first, detection: detectionFor(first), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  await flush();
  gateway.finish(0, { ok: true, legging: { trade_id: "trade-1", residual_exposure: [] } });
  await a;
  await flush();

  // The engine calls this when the position closes fully flat.
  await coordinator.releaseUnderlyingForPosition("RELIANCE", "trade-1");
  assert.deepEqual(coordinator.claimedUnderlyings(), []);
  assert.equal(reservations.activeKeys(NOW).filter(isUnderlyingReservationKey).length, 0);

  const second = boxFor({ k1: 2550, k2: 2650 });
  const b = coordinator.simulateLeggingEntry({
    candidate: second, detection: detectionFor(second), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  await flush();
  assert.equal(gateway.started.length, 2, "the underlying is free once the Box is flat");
  gateway.finish(1, { ok: true, legging: { trade_id: "trade-2", residual_exposure: [] } });
  await b;
});

test("a FAILED entry releases the underlying: a refusal must not consume the lock", async () => {
  const gateway = controllableGateway();
  const { coordinator, reservations } = await ready({ gateway });
  const first = boxFor({ k1: 2500, k2: 2600 });
  const a = coordinator.simulateLeggingEntry({
    candidate: first, detection: detectionFor(first), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  await flush();
  // No fill, no residual: a clean failure.
  gateway.finish(0, { ok: false, reason: "price_moved", detail: "gone", legging: { residual_exposure: [] } });
  await a;
  await flush();

  assert.equal(coordinator.claimedUnderlyings().length, 0, "a failed entry must not hold the underlying");
  assert.equal(reservations.activeKeys(NOW).filter(isUnderlyingReservationKey).length, 0);
});

test("the claim is reference-counted, so one trade's release cannot drop another's protection", async () => {
  const gateway = controllableGateway();
  const { coordinator } = await ready({ gateway });
  await coordinator.claimUnderlyingForPosition("RELIANCE", "trade-1");
  await coordinator.claimUnderlyingForPosition("RELIANCE", "trade-2");
  assert.deepEqual(coordinator.claimedUnderlyings(), ["RELIANCE"]);

  await coordinator.releaseUnderlyingForPosition("RELIANCE", "trade-1");
  assert.deepEqual(coordinator.claimedUnderlyings(), ["RELIANCE"], "trade-2 still relies on it");

  await coordinator.releaseUnderlyingForPosition("RELIANCE", "trade-2");
  assert.deepEqual(coordinator.claimedUnderlyings(), []);
});

test("RESTART: an underlying claim is re-established from adopted durable state", async () => {
  // After a reboot every lease has expired, so protection must be REBUILT rather than assumed.
  const db = new InMemoryReservationDatabase();
  const clock = { value: NOW };
  const booted = await ready({
    gateway: controllableGateway(),
    durable: true,
    db,
    identity: workerIdentity("w0"),
    clock,
    now: () => clock.value,
  });
  // The engine's boot path does exactly this for every adopted position.
  assert.equal(await booted.coordinator.claimUnderlyingForPosition("RELIANCE", "trade-1"), true);

  // A sibling process is now blocked, with no in-memory position book shared between them.
  const sibling = await ready({
    gateway: controllableGateway(),
    durable: true,
    db,
    identity: workerIdentity("w1"),
    clock,
    now: () => clock.value,
  });
  const candidate = boxFor({ k1: 2900, k2: 3000 });
  const result = await sibling.coordinator.simulateLeggingEntry({
    candidate, detection: detectionFor(candidate), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "underlying_already_active");
});

test("an open-position claim keeps the heartbeat alive, so it cannot lapse by TTL", async () => {
  const gateway = controllableGateway();
  const { coordinator } = await ready({ gateway, durable: true });
  await coordinator.claimUnderlyingForPosition("RELIANCE", "trade-1");
  // renewTick is the heartbeat's body; driving it explicitly proves the claim is renewed
  // rather than left to expire.
  await coordinator.renewTick();
  assert.deepEqual(coordinator.claimedUnderlyings(), ["RELIANCE"], "the claim must survive renewal");
  assert.equal(coordinator.holdsReservations, true);
});

test("a broker switch clears position claims so they are re-taken in the new namespace", async () => {
  const gateway = controllableGateway();
  const { coordinator } = await ready({ gateway });
  await coordinator.claimUnderlyingForPosition("RELIANCE", "trade-1");
  assert.deepEqual(coordinator.claimedUnderlyings(), ["RELIANCE"]);
  await coordinator.resetForBrokerSwitch();
  assert.deepEqual(
    coordinator.claimedUnderlyings(),
    [],
    "claims are keyed by the outgoing broker's namespace and must not be carried over",
  );
});

test("an UNCERTAIN settle RETAINS the underlying lease rather than releasing it", async () => {
  const gateway = controllableGateway();
  const { coordinator, reservations } = await ready({ gateway });
  const first = boxFor({ k1: 2500, k2: 2600 });
  const a = coordinator.simulateLeggingEntry({
    candidate: first, detection: detectionFor(first), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  await flush();
  // A residual-bearing outcome is the ambiguous case: exposure may remain.
  gateway.finish(0, {
    ok: false,
    reason: "legging_incomplete",
    detail: "partial",
    legging: { residual_exposure: [{ role: "k1_ce", quantity: 25 }] },
  });
  await a;
  await flush();

  assert.ok(
    reservations.activeKeys(NOW).some(isUnderlyingReservationKey),
    "unresolved exposure must keep the underlying held",
  );
});

/* ── cross-process ──────────────────────────────────────────────────────────────────── */

test("a SECOND PROCESS is blocked on the same underlying through the durable tier", async () => {
  const db = new InMemoryReservationDatabase();
  const gatewayA = controllableGateway();
  const gatewayB = controllableGateway();
  const clock = { value: NOW };
  const w0 = await ready({ gateway: gatewayA, durable: true, db, identity: workerIdentity("w0"), clock, now: () => clock.value });
  const w1 = await ready({ gateway: gatewayB, durable: true, db, identity: workerIdentity("w1"), clock, now: () => clock.value });

  const first = boxFor({ k1: 2500, k2: 2600 });
  const a = w0.coordinator.simulateLeggingEntry({
    candidate: first, detection: detectionFor(first), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  await flush();
  assert.equal(gatewayA.started.length, 1);

  // Worker 1: a DIFFERENT strike pair, so zero contract overlap. Only the underlying collides.
  const second = boxFor({ k1: 2700, k2: 2800 });
  const b = await w1.coordinator.simulateLeggingEntry({
    candidate: second, detection: detectionFor(second), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  assert.equal(b.ok, false);
  assert.equal(b.reason, "underlying_already_active");
  assert.equal(gatewayB.started.length, 0, "a second process must not open a same-underlying Box");

  gatewayA.finish(0);
  await a;
});

test("two processes on DIFFERENT underlyings both proceed", async () => {
  const db = new InMemoryReservationDatabase();
  const gatewayA = controllableGateway();
  const gatewayB = controllableGateway();
  const clock = { value: NOW };
  const w0 = await ready({ gateway: gatewayA, durable: true, db, identity: workerIdentity("w0"), clock, now: () => clock.value });
  const w1 = await ready({ gateway: gatewayB, durable: true, db, identity: workerIdentity("w1"), clock, now: () => clock.value });

  const rel = boxFor({ underlying: "RELIANCE", k1: 2500, k2: 2600 });
  const tcs = boxFor({ underlying: "TCS", k1: 3000, k2: 3100 });
  const a = w0.coordinator.simulateLeggingEntry({
    candidate: rel, detection: detectionFor(rel), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  const b = w1.coordinator.simulateLeggingEntry({
    candidate: tcs, detection: detectionFor(tcs), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  await flush();
  assert.equal(gatewayA.started.length, 1);
  assert.equal(gatewayB.started.length, 1);
  gatewayA.finish(0);
  gatewayB.finish(0);
  assert.equal((await a).ok, true);
  assert.equal((await b).ok, true);
});

test("one broker's underlying lock does not block the other broker's", async () => {
  const db = new InMemoryReservationDatabase();
  const gatewayA = controllableGateway();
  const gatewayB = controllableGateway();
  const clock = { value: NOW };
  const w0 = await ready({ gateway: gatewayA, durable: true, db, identity: workerIdentity("w0"), broker: "zerodha", clock, now: () => clock.value });
  const w1 = await ready({ gateway: gatewayB, durable: true, db, identity: workerIdentity("w1"), broker: "dhan", clock, now: () => clock.value });

  const rel = boxFor({ k1: 2500, k2: 2600 });
  const a = w0.coordinator.simulateLeggingEntry({
    candidate: rel, detection: detectionFor(rel), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  await flush();
  const relOther = boxFor({ k1: 2700, k2: 2800 });
  const b = w1.coordinator.simulateLeggingEntry({
    candidate: relOther, detection: detectionFor(relOther), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  await flush();
  assert.equal(gatewayB.started.length, 1, "a different broker is a different key namespace");
  gatewayA.finish(0);
  gatewayB.finish(0);
  await a;
  await b;
});

/* ── SUITE J: exits are never gated ────────────────────────────────────────────────── */

test("an EXIT is NOT blocked while the underlying is fully locked for entry", async () => {
  const gateway = controllableGateway();
  const { coordinator } = await ready({
    gateway,
    positions: [{ underlying: "RELIANCE", position_state: "BOX", remaining_qty_by_role: FOUR_LOTS }],
    residuals: [{ underlying: "RELIANCE", legs: 3 }],
  });
  const candidate = boxFor({ k1: 2500, k2: 2600 });
  // Entry is refused...
  const entry = await coordinator.simulateLeggingEntry({
    candidate, detection: detectionFor(candidate), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  assert.equal(entry.reason, "underlying_already_active");

  // ...but the exit of the very position causing the lock proceeds.
  const exit = await coordinator.simulateLeggingExit({
    position: {
      id: "trade-1",
      underlying: "RELIANCE",
      legs: candidate.legs,
      direction: "LONG_BOX",
      remaining_qty_by_role: FOUR_LOTS,
    },
    detectedAt: NOW,
  });
  assert.equal(exit.ok, true, "an entry restriction must never block reduction of owned exposure");
});

test("an EXIT never takes an underlying-level reservation", async () => {
  const gateway = controllableGateway();
  const { coordinator, reservations } = await ready({ gateway });
  const candidate = boxFor({ k1: 2500, k2: 2600 });
  const pending = coordinator.simulateLeggingExit({
    position: {
      id: "trade-1",
      underlying: "RELIANCE",
      legs: candidate.legs,
      direction: "LONG_BOX",
      remaining_qty_by_role: FOUR_LOTS,
    },
    detectedAt: NOW,
  });
  await flush();
  assert.equal(
    reservations.activeKeys(NOW).filter(isUnderlyingReservationKey).length,
    0,
    "an exit must not claim the underlying, or it would block its own retry",
  );
  await pending;
});

test("residual flattening is never gated by the underlying lock", async () => {
  const gateway = controllableGateway();
  const { coordinator } = await ready({
    gateway,
    positions: [{ underlying: "RELIANCE", position_state: "RECOVERY", remaining_qty_by_role: FOUR_LOTS }],
    residuals: [{ underlying: "RELIANCE", legs: 4 }],
  });
  const pass = await coordinator.flattenResidual({
    residual: [{ role: "k1_ce", quantity: 25, token: 1, tradingsymbol: "X", side: "BUY", average_price: 1, source: "partial_entry", created_at: NOW }],
    keyPrefix: "attempt-1",
  });
  assert.ok(pass, "emergency residual flattening must always run");
});

/* ── SUITE E: exact-contract behaviour with the restriction OFF ─────────────────────── */

test("restriction OFF: same underlying, DIFFERENT strikes run concurrently, as before", async () => {
  // This is the pre-existing documented behaviour (reservation test MP5). Turning the feature
  // off must restore it exactly.
  const gateway = controllableGateway();
  const { coordinator, reservations } = await ready({ gateway, config: { oneActiveBoxPerUnderlying: false } });
  const first = boxFor({ k1: 2500, k2: 2600 });
  const second = boxFor({ k1: 2700, k2: 2800 });

  const a = coordinator.simulateLeggingEntry({
    candidate: first, detection: detectionFor(first), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  const b = coordinator.simulateLeggingEntry({
    candidate: second, detection: detectionFor(second), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  await flush();
  assert.equal(gateway.started.length, 2, "no per-underlying lock when the feature is off");
  // And no underlying key is taken at all.
  assert.equal(reservations.activeKeys(NOW).filter(isUnderlyingReservationKey).length, 0);
  gateway.finish(0);
  gateway.finish(1);
  await a;
  await b;
});

test("restriction OFF: overlapping EXACT contracts still serialise", async () => {
  const gateway = controllableGateway();
  const { coordinator } = await ready({ gateway, config: { oneActiveBoxPerUnderlying: false } });
  const first = boxFor({ k1: 2500, k2: 2600 });
  // Shares RELIANCE 2600 CE and 2600 PE.
  const overlapping = boxFor({ k1: 2600, k2: 2700 });

  const a = coordinator.simulateLeggingEntry({
    candidate: first, detection: detectionFor(first), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  await flush();
  assert.equal(gateway.started.length, 1);

  const b = coordinator.simulateLeggingEntry({
    candidate: overlapping, detection: detectionFor(overlapping), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  await flush();
  assert.equal(gateway.started.length, 1, "the shared contract must still serialise");

  gateway.finish(0);
  await a;
  await b;
});

test("restriction ON: overlapping exact contracts are ALSO still blocked", async () => {
  // The new layer is additive. It must not accidentally replace contract exclusion.
  const gateway = controllableGateway();
  const { coordinator } = await ready({ gateway });
  const first = boxFor({ k1: 2500, k2: 2600 });
  const overlapping = boxFor({ k1: 2600, k2: 2700 });

  const a = coordinator.simulateLeggingEntry({
    candidate: first, detection: detectionFor(first), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  await flush();
  const b = await coordinator.simulateLeggingEntry({
    candidate: overlapping, detection: detectionFor(overlapping), stillWanted: () => true, qualify: () => ({ qualifies: true }),
  });
  assert.equal(b.ok, false);
  assert.equal(gateway.started.length, 1);
  gateway.finish(0);
  await a;
});
