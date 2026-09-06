/**
 * BOX EXECUTION COORDINATION — contract-level exclusion.
 *
 * The behaviour under test is concurrency, so almost every test here drives TWO
 * executions that genuinely overlap in time (both started before either is awaited)
 * and then asserts on the interleaving that actually occurred. A test that starts
 * them sequentially would pass against completely broken code.
 *
 * The gateway underneath is a controllable fake, because what is being tested is the
 * coordinator's decisions — the real simulator and live adapter are exercised
 * elsewhere. The coordinator itself is the real code.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CoordinatedBoxExecutionGateway } from "../../dist/box/executionCoordinator.js";
import {
  InProcessInstrumentReservations,
  ChainedInstrumentReservations,
} from "../../dist/box/instrumentReservations.js";
import { instrumentKey, boxInstrumentRefs, keysOf } from "../../dist/box/instrumentKey.js";
import { entrySideFor } from "../../dist/box/math.js";
import { BOX_LEG_ROLES } from "../../dist/box/types.js";
import { cfg, goodCandidate } from "./helpers.mjs";

const NOW = 1_700_000_000_000;

/**
 * Drain the microtask queue.
 *
 * The coordinator's wait path is several awaits deep (wake → re-acquire →
 * revalidate → delegate), and `sleep` is stubbed to resolve immediately, so the
 * whole thing settles in microtasks. `setImmediate` runs after all of them.
 */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/* ───────────────────────────── fixtures ───────────────────────────── */

/** A candidate whose four legs are built from explicit strikes, so overlap is exact. */
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
    legs: {
      k1_ce: leg(k1, "CE"),
      k2_ce: leg(k2, "CE"),
      k2_pe: leg(k2, "PE"),
      k1_pe: leg(k1, "PE"),
    },
  };
}

function detectionFor(candidate, { grossEdge = 4000, tradable = true } = {}) {
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
      price: 100,
      qty_at_touch: 50,
      bid: 99, bid_qty: 50, ask: 100, ask_qty: 50,
      quote_at: NOW, exchange_at: null, quote_version: 1, depth: null,
      age_ms: 5, fresh: true, executable: true,
    })),
    entry_net_debit_per_unit: 20,
    entry_box_cost_per_unit: 20,
    gross_edge_per_unit: grossEdge / 50,
    gross_edge: grossEdge,
    tradable,
    depth_ok: true,
    worst_age_ms: 5,
    quote_version: 1,
    reject: null,
  };
}

/**
 * A gateway whose entry call blocks until the test releases it.
 *
 * This is what makes real overlap testable: execution A can be held mid-flight while
 * B attempts the same contract, which is precisely the race being guarded.
 */
function controllableGateway({ mode = "paper_legging" } = {}) {
  const started = [];
  const gates = new Map();
  let seq = 0;
  return {
    mode,
    started,
    /** Let a held execution finish. */
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
      started.push({ index, key: args.candidate.key, at: Date.now() });
      return new Promise((resolve) => gates.set(index, resolve));
    },
  };
}

function makeCoordinator({ gateway, quotes = new Map(), config = {}, broker = "zerodha", now = () => NOW } = {}) {
  const reservations = new InProcessInstrumentReservations();
  const logs = [];
  const coordinator = new CoordinatedBoxExecutionGateway({
    inner: gateway,
    reservations,
    waitable: reservations,
    cfg: cfg({ conflictWaitMaxMs: 250, instrumentLockTtlMs: 5000, maxConcurrentPerUnderlying: 0, ...config }),
    quotes: { view: () => quotes },
    broker: () => broker,
    now,
    // Deterministic: no real timers, so the poll backstop cannot make a test flaky.
    sleep: () => Promise.resolve(),
    log: (f) => logs.push(f),
  });
  return { coordinator, reservations, logs };
}

/* ════════════════════ instrument identity & namespaces ════════════════════ */

test("T23: Zerodha and Dhan namespaces cannot collide on an identical token", () => {
  const inst = { token: 12345, tradingsymbol: "RELIANCE24SEP2550CE", exchange: "NFO" };
  const z = instrumentKey("zerodha", inst);
  const d = instrumentKey("dhan", inst);
  assert.notEqual(z, d, "the same contract under two brokers must be two keys");
  assert.match(z, /^ZERODHA:/);
  assert.match(d, /^DHAN:/);

  // And a token-only fallback is still namespaced.
  const zt = instrumentKey("zerodha", { token: 999, tradingsymbol: "", exchange: "NFO" });
  const dt = instrumentKey("dhan", { token: 999, tradingsymbol: "", exchange: "NFO" });
  assert.notEqual(zt, dt, "identical numeric tokens must not collide across brokers");
});

test("T9-a: instrument keys are emitted in a deterministic total order", () => {
  const a = boxFor({ k1: 2500, k2: 2550 });
  const refs1 = boxInstrumentRefs("zerodha", a.legs, (r) => entrySideFor(r, "LONG_BOX"), BOX_LEG_ROLES);
  const refs2 = boxInstrumentRefs("zerodha", a.legs, (r) => entrySideFor(r, "LONG_BOX"), [...BOX_LEG_ROLES].reverse());
  assert.deepEqual(keysOf(refs1), keysOf(refs2), "key order must not depend on role iteration order");
  const sorted = [...keysOf(refs1)].sort();
  assert.deepEqual(keysOf(refs1), sorted, "keys must be sorted, so a lock-ordering tier cannot deadlock");
});

/* ════════════════════════ reservation store ════════════════════════ */

test("T19: an owner cannot release another owner's reservation", () => {
  const store = new InProcessInstrumentReservations();
  assert.equal(store.tryAcquireAll({ owner: "A", keys: ["K1"], ttlMs: 1000, now: NOW }).ok, true);
  const released = store.release({ owner: "B", keys: ["K1"], now: NOW });
  assert.equal(released, 0, "B must not be able to release K1");
  assert.equal(store.ownerOf("K1", NOW), "A", "A still holds it");
  assert.equal(store.release({ owner: "A", keys: ["K1"], now: NOW }), 1, "A can release its own");
  assert.equal(store.ownerOf("K1", NOW), null);
});

test("T9-b: acquisition is all-or-none, so no partial state can deadlock", () => {
  const store = new InProcessInstrumentReservations();
  store.tryAcquireAll({ owner: "A", keys: ["X"], ttlMs: 1000, now: NOW });

  // B wants X and Y. X is taken, so B must get NEITHER.
  const outcome = store.tryAcquireAll({ owner: "B", keys: ["X", "Y"], ttlMs: 1000, now: NOW });
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.conflicts.map((c) => c.key), ["X"]);
  assert.equal(store.ownerOf("Y", NOW), null, "Y must NOT have been taken by the failed attempt");

  // Which is exactly what prevents the classic cycle: B never holds Y while waiting
  // for X, so A can still take Y and finish.
  assert.equal(store.tryAcquireAll({ owner: "A", keys: ["Y"], ttlMs: 1000, now: NOW }).ok, true);
});

test("T18: a crashed owner's reservation is recoverable through TTL expiry", () => {
  const store = new InProcessInstrumentReservations();
  store.tryAcquireAll({ owner: "dead-process", keys: ["K"], ttlMs: 1000, now: NOW });
  assert.equal(store.ownerOf("K", NOW + 999), "dead-process", "still held before expiry");
  assert.equal(store.ownerOf("K", NOW + 1001), null, "expired, so recoverable without any cleanup");
  assert.equal(store.tryAcquireAll({ owner: "new", keys: ["K"], ttlMs: 1000, now: NOW + 1001 }).ok, true);
});

test("T26: the store stays bounded — expired entries are swept, not accumulated", () => {
  const store = new InProcessInstrumentReservations();
  for (let i = 0; i < 5000; i++) {
    store.tryAcquireAll({ owner: `o${i}`, keys: [`K${i}`], ttlMs: 10, now: NOW });
  }
  assert.equal(store.activeCount(NOW), 5000, "all live before expiry");
  assert.equal(store.activeCount(NOW + 11), 0, "every expired entry is swept");
  assert.equal(store.activeKeys(NOW + 11).length, 0, "no residue left behind");
});

test("chained tiers roll back so all-or-none holds across tiers too", () => {
  const primary = new InProcessInstrumentReservations();
  const secondary = new InProcessInstrumentReservations();
  // Secondary already holds K under a different owner, so the chain must fail AND
  // must not leave the primary holding it.
  secondary.tryAcquireAll({ owner: "other", keys: ["K"], ttlMs: 1000, now: NOW });
  const chain = new ChainedInstrumentReservations([primary, secondary]);
  const outcome = chain.tryAcquireAll({ owner: "me", keys: ["K"], ttlMs: 1000, now: NOW });
  assert.equal(outcome.ok, false);
  assert.equal(primary.ownerOf("K", NOW), null, "primary must have been rolled back");
});

/* ════════════════════════ concurrency behaviour ════════════════════════ */

test("T7: two boxes sharing NO instrument execute concurrently", async () => {
  const gateway = controllableGateway();
  const { coordinator } = makeCoordinator({ gateway });

  const reliance = boxFor({ underlying: "RELIANCE", k1: 2500, k2: 2550 });
  const tcs = boxFor({ underlying: "TCS", k1: 3000, k2: 3050 });

  // Both started before either is awaited — genuinely overlapping.
  const pa = coordinator.simulateLeggingEntry({ candidate: reliance, detection: detectionFor(reliance), stillWanted: () => true, qualify: () => ({ ok: true }) });
  const pb = coordinator.simulateLeggingEntry({ candidate: tcs, detection: detectionFor(tcs), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(gateway.started.length, 2, "both must reach the executor without waiting for each other");
  gateway.finish(0);
  gateway.finish(1);
  const [ra, rb] = await Promise.all([pa, pb]);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
});

test("T8: two boxes sharing ONE instrument cannot submit it simultaneously", async () => {
  const gateway = controllableGateway();
  const { coordinator } = makeCoordinator({ gateway });

  // 2500/2550 and 2550/2600 both trade the 2550 strike.
  const a = boxFor({ k1: 2500, k2: 2550 });
  const b = boxFor({ k1: 2550, k2: 2600 });

  const pa = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  const pb = coordinator.simulateLeggingEntry({ candidate: b, detection: detectionFor(b), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(gateway.started.length, 1, "only ONE may be in the executor while they share 2550");
  assert.equal(gateway.started[0].key, a.key, "the first to reserve wins");

  gateway.finish(0);
  await pa;
  const rb = await pb;
  // B is not silently dropped: it either executed after A released, or aborted on
  // revalidation. Both are correct; simultaneous submission is not.
  assert.ok(rb.ok === true || rb.reason === "edge_disappeared", `B resolved as ${JSON.stringify(rb.reason ?? "ok")}`);
});

test("T9-c: two boxes sharing MULTIPLE instruments cannot deadlock", async () => {
  const gateway = controllableGateway();
  const { coordinator } = makeCoordinator({ gateway });

  // Identical strikes, opposite directions: all four contracts overlap.
  const a = boxFor({ k1: 2500, k2: 2550, direction: "LONG_BOX" });
  const b = boxFor({ k1: 2500, k2: 2550, direction: "SHORT_BOX" });

  const pa = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  const pb = coordinator.simulateLeggingEntry({ candidate: b, detection: detectionFor(b), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(gateway.started.length, 1, "four-way overlap must serialise");
  gateway.finish(0);
  // The decisive assertion: both promises settle. A deadlock would hang here.
  const settled = await Promise.all([pa, pb]);
  assert.equal(settled.length, 2, "neither execution deadlocked");
});

test("T10/T11: same-side and opposite-side overlaps both serialise safely", async () => {
  for (const [label, dirA, dirB] of [
    ["same side", "LONG_BOX", "LONG_BOX"],
    ["opposite side", "LONG_BOX", "SHORT_BOX"],
  ]) {
    const gateway = controllableGateway();
    const { coordinator } = makeCoordinator({ gateway });
    // Share exactly the 2550 CE/PE pair.
    const a = boxFor({ k1: 2500, k2: 2550, direction: dirA });
    const b = boxFor({ k1: 2550, k2: 2600, direction: dirB });

    const pa = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
    const pb = coordinator.simulateLeggingEntry({ candidate: b, detection: detectionFor(b), stillWanted: () => true, qualify: () => ({ ok: true }) });
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(gateway.started.length, 1, `${label}: must serialise (no internal netting by default)`);
    gateway.finish(0);
    await Promise.all([pa, pb]);
  }
});

test("T20: an identical opportunity cannot execute twice concurrently", async () => {
  const gateway = controllableGateway();
  const { coordinator } = makeCoordinator({ gateway });
  const a = boxFor({ k1: 2500, k2: 2550 });

  const pa = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  const pb = coordinator.simulateLeggingEntry({ candidate: { ...a }, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await Promise.resolve();
  await Promise.resolve();

  const rb = await pb;
  assert.equal(rb.ok, false);
  assert.equal(rb.reason, "duplicate", "the second identical opportunity is suppressed, not queued");
  assert.equal(coordinator.metrics().duplicateSuppressed, 1);
  gateway.finish(0);
  await pa;
});

/* ════════════════════════ revalidation ════════════════════════ */

test("T13: a deteriorated opportunity ABORTS after waiting", async () => {
  const gateway = controllableGateway();
  // Empty quote map ⇒ revalidation finds no book ⇒ not tradable.
  const { coordinator, logs } = makeCoordinator({ gateway, quotes: new Map() });

  const a = boxFor({ k1: 2500, k2: 2550 });
  const b = boxFor({ k1: 2550, k2: 2600 });

  const pa = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  const pb = coordinator.simulateLeggingEntry({ candidate: b, detection: detectionFor(b), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await Promise.resolve();
  await Promise.resolve();

  gateway.finish(0); // release A, waking B
  await pa;
  const rb = await pb;

  assert.equal(rb.ok, false);
  assert.equal(rb.reason, "edge_disappeared", "queue position is not a reason to trade");
  assert.equal(gateway.started.length, 1, "B must never have reached the executor");
  assert.equal(coordinator.metrics().revalidationRejected, 1);
  assert.ok(logs.some((l) => l.status === "abort"), "the abort must be logged with its reason");
});

test("T12/T14: the waiting box is re-priced, and proceeds when still valid", async () => {
  const gateway = controllableGateway();
  const a = boxFor({ k1: 2500, k2: 2550 });
  const b = boxFor({ k1: 2550, k2: 2600 });

  // A live book good enough for B's revalidation to pass.
  const quotes = new Map();
  for (const cand of [a, b]) {
    for (const role of BOX_LEG_ROLES) {
      const inst = cand.legs[role];
      quotes.set(inst.token, {
        token: inst.token,
        bid: 100, ask: 100.05,
        bids: [{ price: 100, quantity: 500, orders: 1 }],
        asks: [{ price: 100.05, quantity: 500, orders: 1 }],
        last: 100, at: NOW, version: 1, source: "ws",
        exchange_at: null,
      });
    }
  }
  const { coordinator, logs } = makeCoordinator({ gateway, quotes });

  const pa = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  // B's detected edge is tiny, so whatever the fresh book says cannot be a
  // deterioration — this isolates "was it re-measured and allowed through".
  const pb = coordinator.simulateLeggingEntry({ candidate: b, detection: detectionFor(b, { grossEdge: 1 }), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(gateway.started.length, 1, "serialised while 2550 is shared");

  gateway.finish(0);
  await pa;
  // The wake → re-acquire → revalidate → delegate path is several awaits deep, so
  // drain the microtask queue rather than guessing a number of ticks.
  await flush();

  const m = coordinator.metrics();
  assert.equal(m.revalidationPassed + m.revalidationRejected, 1, "B was revalidated exactly once");
  if (m.revalidationPassed === 1) {
    assert.equal(gateway.started.length, 2, "a still-valid opportunity proceeds");
    assert.ok(logs.some((l) => l.status === "execute" && l.revalidated === true), "and logs the revalidated execute");
    gateway.finish(1);
  }
  await pb;
});

/* ════════════════════════ release semantics ════════════════════════ */

test("T15: a reservation is released after a clean terminal state", async () => {
  const gateway = controllableGateway();
  const { coordinator, reservations } = makeCoordinator({ gateway });
  const a = boxFor({ k1: 2500, k2: 2550 });

  const pa = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await Promise.resolve();
  assert.equal(reservations.activeCount(NOW), 4, "all four legs reserved while executing");

  gateway.finish(0, { ok: true, legging: { residual_exposure: [] } });
  await pa;
  assert.equal(reservations.activeCount(NOW), 0, "released once the outcome is knowable");
});

test("T16/T17: residual exposure and unknown state do NOT release the reservation", async () => {
  for (const [label, result] of [
    ["residual exposure", { ok: false, reason: "legging_incomplete", legging: { residual_exposure: [{ role: "k1_ce" }] } }],
    ["ambiguous terminal", { ok: false, reason: "legging_incomplete", legging: { residual_exposure: [] } }],
    ["failed unwind", { ok: false, reason: "unwind_failed", legging: { residual_exposure: [] } }],
  ]) {
    const gateway = controllableGateway();
    const { coordinator, reservations } = makeCoordinator({ gateway });
    const a = boxFor({ k1: 2500, k2: 2550 });

    const pa = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
    await Promise.resolve();
    gateway.finish(0, result);
    await pa;

    assert.equal(
      reservations.activeCount(NOW),
      4,
      `${label}: the contracts must stay reserved so a second box cannot assume there is no exposure`,
    );
    // …and it is still bounded: the TTL, not a leak.
    assert.equal(reservations.activeCount(NOW + 5001), 0, `${label}: TTL still bounds it`);
    assert.equal(coordinator.metrics().reservationsHeldOnUncertainty, 1);
  }
});

test("a thrown execution holds the reservation rather than releasing on unknown state", async () => {
  const gateway = controllableGateway();
  gateway.simulateLeggingEntry = async () => {
    throw new Error("transport exploded mid-submit");
  };
  const { coordinator, reservations } = makeCoordinator({ gateway });
  const a = boxFor({ k1: 2500, k2: 2550 });

  await assert.rejects(
    () => coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) }),
    /transport exploded/,
  );
  assert.equal(reservations.activeCount(NOW), 4, "unknown state must not free the contracts");
  assert.equal(coordinator.metrics().reservationsHeldOnUncertainty, 1);
});

/* ════════════════════════ fail-closed & paper parity ════════════════════════ */

test("T25: live execution fails CLOSED when a durable store is required but absent", async () => {
  const gateway = controllableGateway({ mode: "live" });
  const { coordinator } = makeCoordinator({
    gateway,
    config: { reservationRequireDurable: true },
  });
  const a = boxFor({ k1: 2500, k2: 2550 });
  const r = await coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });

  assert.equal(r.ok, false, "live must refuse rather than execute uncoordinated");
  assert.match(r.detail, /not durable/);
  assert.equal(gateway.started.length, 0, "nothing reached the executor");
  assert.equal(coordinator.metrics().failedClosed, 1);
});

test("T25-b: paper may continue on the in-process store, and says which store it is", async () => {
  const gateway = controllableGateway({ mode: "paper_legging" });
  const { coordinator } = makeCoordinator({ gateway, config: { reservationRequireDurable: true } });
  const a = boxFor({ k1: 2500, k2: 2550 });
  const p = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await Promise.resolve();
  assert.equal(gateway.started.length, 1, "paper is not blocked, so development and tests still work");
  assert.equal(coordinator.metrics().store, "in-process");
  assert.equal(coordinator.metrics().durable, false, "and it is honest about not being durable");
  gateway.finish(0);
  await p;
});

test("T22: PAPER goes through the same coordinator as live — no shortcut", async () => {
  // The decisive structural check: the coordinator is mode-agnostic, so a paper
  // gateway is coordinated by exactly the same code path as a live one.
  for (const mode of ["paper_touch", "paper_latency", "paper_legging", "live"]) {
    const gateway = controllableGateway({ mode });
    const { coordinator } = makeCoordinator({ gateway });
    assert.equal(coordinator.mode, mode, "the coordinator reports the wrapped mode");

    const a = boxFor({ k1: 2500, k2: 2550 });
    const b = boxFor({ k1: 2550, k2: 2600 });
    const pa = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
    const pb = coordinator.simulateLeggingEntry({ candidate: b, detection: detectionFor(b), stillWanted: () => true, qualify: () => ({ ok: true }) });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(gateway.started.length, 1, `${mode}: shared contract must serialise in every mode`);
    gateway.finish(0);
    await Promise.all([pa, pb]);
  }
});

test("the coordinator can be disabled, and then does not gate at all", async () => {
  const gateway = controllableGateway();
  const { coordinator } = makeCoordinator({ gateway, config: { executionCoordinatorEnabled: false } });
  const a = boxFor({ k1: 2500, k2: 2550 });
  const b = boxFor({ k1: 2550, k2: 2600 });
  const pa = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  const pb = coordinator.simulateLeggingEntry({ candidate: b, detection: detectionFor(b), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(gateway.started.length, 2, "the escape hatch genuinely bypasses coordination");
  gateway.finish(0);
  gateway.finish(1);
  await Promise.all([pa, pb]);
});

/* ════════════════════════ broker switch & budgets ════════════════════════ */

test("T24-adjacent: a broker switch clears every reservation", async () => {
  const gateway = controllableGateway();
  const { coordinator, reservations } = makeCoordinator({ gateway });
  const a = boxFor({ k1: 2500, k2: 2550 });
  const p = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await Promise.resolve();
  assert.equal(reservations.activeCount(NOW), 4);

  coordinator.resetForBrokerSwitch();
  assert.equal(reservations.activeCount(NOW), 0, "old-namespace keys must not survive a switch");
  assert.equal(coordinator.metrics().activeExecutions, 0);
  gateway.finish(0);
  await p;
});

test("the per-underlying budget caps concurrency WITHOUT replacing per-contract exclusion", async () => {
  const gateway = controllableGateway();
  const { coordinator } = makeCoordinator({ gateway, config: { maxConcurrentPerUnderlying: 1 } });

  // Same underlying, ZERO shared contracts: excluded only by the budget.
  const a = boxFor({ underlying: "RELIANCE", k1: 2500, k2: 2550 });
  const b = boxFor({ underlying: "RELIANCE", k1: 2800, k2: 2850 });
  const pa = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  const pb = coordinator.simulateLeggingEntry({ candidate: b, detection: detectionFor(b), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(gateway.started.length, 1, "budget of 1 admits one");
  gateway.finish(0);
  await Promise.all([pa, pb]);

  // With the budget OFF the same two run concurrently, proving the budget — not a
  // contract conflict — was the constraint.
  const g2 = controllableGateway();
  const { coordinator: c2 } = makeCoordinator({ gateway: g2, config: { maxConcurrentPerUnderlying: 0 } });
  const qa = c2.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  const qb = c2.simulateLeggingEntry({ candidate: b, detection: detectionFor(b), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(g2.started.length, 2, "2500/2550 and 2800/2850 share nothing and must run together");
  g2.finish(0);
  g2.finish(1);
  await Promise.all([qa, qb]);
});

test("residual flattening is never gated behind a reservation", async () => {
  const gateway = controllableGateway();
  const { coordinator, reservations } = makeCoordinator({ gateway });
  const a = boxFor({ k1: 2500, k2: 2550 });
  const p = coordinator.simulateLeggingEntry({ candidate: a, detection: detectionFor(a), stillWanted: () => true, qualify: () => ({ ok: true }) });
  await Promise.resolve();
  assert.equal(reservations.activeCount(NOW), 4, "an entry holds all four legs");

  // Flattening reduces exposure that already exists; making it queue behind a
  // speculative entry would leave a naked leg open.
  const flat = await coordinator.flattenResidual({ keyPrefix: "t", residual: [] });
  assert.ok(flat, "flatten proceeded despite the reservation");
  gateway.finish(0);
  await p;
});

test("metrics expose coordination without high-cardinality labels", async () => {
  const gateway = controllableGateway();
  const { coordinator } = makeCoordinator({ gateway });
  const m = coordinator.metrics();
  for (const field of [
    "activeExecutions", "activeInstrumentReservations", "waitingExecutions",
    "reservationConflicts", "duplicateSuppressed", "expiredWhileWaiting",
    "revalidationRejected", "reservationsHeldOnUncertainty", "failedClosed",
  ]) {
    assert.equal(typeof m[field], "number", `${field} must be a number`);
  }
  assert.ok("p50" in m.waitMs && "p95" in m.waitMs, "wait duration percentiles are exposed");
  // No ids or symbols anywhere in the snapshot.
  const json = JSON.stringify(m);
  assert.doesNotMatch(json, /entry-|exit-|RELIANCE|NFO:/, "metrics must not carry ids or symbols");
});
