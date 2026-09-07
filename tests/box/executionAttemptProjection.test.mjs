import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MAX_FLATTEN_APPLICATION_IDS,
  adoptObservedFlattenCharges,
  compactObservedFlattenChargeWatermarks,
  compactResidualProjectionBookkeeping,
  createResidualProjectionCommand,
  persistOwnedResidualProjection,
  recoveryExecutionAttemptId,
  residualProjectionChanges,
  residualProjectionIdentity,
  runInitialRegisteredResidualPass,
  seedObservedFlattenCharges,
  transitionResidualProjectionSnapshot,
} from "../../dist/box/executionAttemptProjection.js";

const URI = (process.env.BOX_TEST_MONGODB_URI ?? "").trim();
if (URI) process.env.BOX_MONGODB_URI = URI;
const {
  BOX_RECOVERY_KEY,
  BOX_RECOVERY_UNIQUE_INDEX,
  BoxRecoveryPersistenceGate,
  boxExecutionAttemptDailyRiskContribution,
  boxRecoveryPersistenceValidationError,
  isBoxRecoveryPersistenceReady,
} = await import("../../dist/box/repository.js");

const residual = (quantity = 75, attempt = 1) => [{
  token: 9001,
  tradingsymbol: "SYM-k1_ce",
  exchange: "NFO",
  role: "k1_ce",
  side: "BUY",
  quantity,
  average_price: 100,
  source: "partial_entry",
  created_at: 1_000,
  flatten_attempt: attempt,
}];

class AtomicProjectionStore {
  constructor(snapshot) {
    this.snapshot = structuredClone(snapshot);
  }

  async apply(command) {
    // JavaScript runs this synchronous transition without an await: concurrent callers therefore
    // model an atomic compare-and-set, while their returned promises may settle concurrently.
    const transition = transitionResidualProjectionSnapshot(this.snapshot, command);
    this.snapshot = structuredClone(transition.snapshot);
    await new Promise((resolve) => setImmediate(resolve));
    return transition.result;
  }
}

test("legacy execution-attempt rows start at version zero without a migration", async () => {
  const before = residual(75, 1);
  const after = residual(40, 2);
  const store = new AtomicProjectionStore({
    residual_exposure: before,
    flatten_charges: null,
    resolved: false,
    // Deliberately no version, projection identity, or application ledger.
  });
  const command = createResidualProjectionCommand({
    attemptId: "legacy-attempt",
    expectedVersion: 0,
    expectedResidual: before,
    nextResidual: after,
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 12.345,
  });

  const result = await store.apply(command);
  assert.equal(result.status, "applied");
  assert.equal(result.projection_version, 1);
  assert.equal(result.flatten_charges, 12.35);
  assert.equal(result.flatten_charge_day, "2026-09-07");
  assert.equal(result.flatten_charges_for_day, 12.35);
  assert.deepEqual(result.residual_exposure, after);
  assert.equal(store.snapshot.applied_flatten_applications.length, 1);
});

test("no-POST/no-progress passes do not consume projection ownership", async () => {
  const legacy = residual(75, 1).map(({ flatten_attempt: _attempt, ...leg }) => leg);
  const unchanged = residual(75, 1);
  const noOp = createResidualProjectionCommand({
    attemptId: "no-post-attempt",
    expectedVersion: 0,
    expectedResidual: legacy,
    nextResidual: unchanged,
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 0,
  });
  assert.equal(
    residualProjectionChanges(noOp),
    false,
    "legacy missing generation and explicit attempt 1 are the same semantic projection",
  );

  const fill = createResidualProjectionCommand({
    attemptId: "no-post-attempt",
    expectedVersion: 0,
    expectedResidual: legacy,
    nextResidual: residual(25, 2),
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 9,
  });
  assert.equal(residualProjectionChanges(fill), true);
  const store = new AtomicProjectionStore({ residual_exposure: legacy, flatten_charges: 0, resolved: false });
  if (residualProjectionChanges(noOp)) await store.apply(noOp);
  const result = await store.apply(fill);
  assert.equal(result.status, "applied", "the broker-confirmed fill still owns version zero");
  assert.equal(store.snapshot.flatten_charges, 9);
  assert.deepEqual(store.snapshot.residual_exposure, residual(25, 2));
});

test("two projection writers apply one version and one charge exactly once", async () => {
  const before = residual(75, 1);
  const command = createResidualProjectionCommand({
    attemptId: "race-attempt",
    expectedVersion: 0,
    expectedResidual: before,
    nextResidual: residual(25, 2),
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 9.87,
  });
  const store = new AtomicProjectionStore({
    projection_version: 0,
    residual_projection_identity: residualProjectionIdentity(before),
    residual_exposure: before,
    flatten_charges: 1,
    applied_flatten_applications: [],
    resolved: false,
  });

  const results = await Promise.all([store.apply(command), store.apply(command)]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["already_applied", "applied"]);
  assert.equal(store.snapshot.projection_version, 1);
  assert.equal(store.snapshot.flatten_charges, 10.87, "the delta is present once, not once per worker");
  assert.deepEqual(store.snapshot.residual_exposure, residual(25, 2));
});

test("a stale writer cannot restore an older quantity or generation", async () => {
  const original = residual(75, 1);
  const store = new AtomicProjectionStore({
    projection_version: 0,
    residual_projection_identity: residualProjectionIdentity(original),
    residual_exposure: original,
    flatten_charges: 0,
    applied_flatten_applications: [],
    resolved: false,
  });
  const winner = createResidualProjectionCommand({
    attemptId: "stale-attempt",
    expectedVersion: 0,
    expectedResidual: original,
    nextResidual: residual(20, 3),
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 5,
  });
  const stale = createResidualProjectionCommand({
    attemptId: "stale-attempt",
    expectedVersion: 0,
    expectedResidual: original,
    nextResidual: residual(60, 2),
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 8,
  });

  assert.equal((await store.apply(winner)).status, "applied");
  const result = await store.apply(stale);
  assert.equal(result.status, "stale");
  assert.equal(result.projection_version, 1);
  assert.deepEqual(result.residual_exposure, residual(20, 3));
  assert.equal(store.snapshot.flatten_charges, 5);
});

test("lost acknowledgement retries the immutable command and converges local risk once", async () => {
  const before = residual(75, 1);
  const command = createResidualProjectionCommand({
    attemptId: "lost-ack-attempt",
    expectedVersion: 0,
    expectedResidual: before,
    nextResidual: residual(45, 2),
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 7.25,
  });
  const store = new AtomicProjectionStore({
    residual_exposure: before,
    flatten_charges: 0,
    resolved: false,
  });
  const seen = [];
  let loseAck = true;
  let riskDebit = 0;
  const observedFlattenCharges = new Map();
  const observedFlattenChargesByDay = new Map();
  const persist = async (immutableCommand) => {
    seen.push(structuredClone(immutableCommand));
    const result = await store.apply(immutableCommand);
    if (loseAck) {
      loseAck = false;
      throw new Error("reply lost after atomic commit");
    }
    return result;
  };

  await assert.rejects(() => persistOwnedResidualProjection({
    attemptId: "lost-ack-attempt",
    command,
    persist,
    observedFlattenCharges,
    observedFlattenChargesByDay,
    onAppliedCharge: (charge) => { riskDebit += charge; },
  }), /reply lost/);
  const retry = await persistOwnedResidualProjection({
    attemptId: "lost-ack-attempt",
    command,
    persist,
    observedFlattenCharges,
    observedFlattenChargesByDay,
    onAppliedCharge: (charge) => { riskDebit += charge; },
  });

  assert.equal(retry.status, "already_applied");
  assert.deepEqual(seen[0], seen[1], "pending retry retains quantity, charge, version and application id");
  assert.equal(store.snapshot.flatten_charges, 7.25, "durable charge is exactly once");
  assert.equal(riskDebit, 7.25, "the lost-ack retry observes and debits the durable total once");
});

test("a lost prior-day acknowledgement advances lifetime bookkeeping without debiting today", async () => {
  const before = residual(75, 1);
  const command = createResidualProjectionCommand({
    attemptId: "rollover-lost-ack",
    expectedVersion: 0,
    expectedResidual: before,
    nextResidual: [],
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 8.75,
  });
  const store = new AtomicProjectionStore({
    residual_exposure: before,
    flatten_charges: 0,
    resolved: false,
  });
  const observedFlattenCharges = new Map();
  const observedFlattenChargesByDay = new Map();
  let currentDay = "2026-09-07";
  let currentDayDebit = 0;
  let loseAck = true;
  const persist = async (immutableCommand) => {
    const result = await store.apply(immutableCommand);
    if (loseAck) {
      loseAck = false;
      throw new Error("day-D reply lost after commit");
    }
    return result;
  };
  const apply = () => persistOwnedResidualProjection({
    attemptId: "rollover-lost-ack",
    command,
    persist,
    observedFlattenCharges,
    observedFlattenChargesByDay,
    onAppliedCharge: (charge, observation) => {
      if (observation?.chargeDay === currentDay) currentDayDebit += charge;
    },
  });

  await assert.rejects(apply, /day-D reply lost/);
  currentDay = "2026-09-08";
  const retry = await apply();
  assert.equal(retry.status, "already_applied");
  assert.equal(retry.flatten_charge_day, "2026-09-07");
  assert.equal(retry.flatten_charges_for_day, 8.75);
  assert.equal(observedFlattenCharges.get("rollover-lost-ack"), 8.75,
    "the process lifetime watermark still converges");
  assert.equal(currentDayDebit, 0, "day D's delayed acknowledgement cannot debit day D+1");
  await apply();
  assert.equal(currentDayDebit, 0, "repeated prior-day acknowledgements remain idempotent");
});

test("each process converges to the durable cumulative charge exactly once", async () => {
  const before = residual(75, 1);
  const command = createResidualProjectionCommand({
    attemptId: "risk-owner-attempt",
    expectedVersion: 0,
    expectedResidual: before,
    nextResidual: [],
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 11.5,
  });
  const store = new AtomicProjectionStore({ residual_exposure: before, flatten_charges: 0, resolved: false });
  const workers = [1, 2].map(() => ({ observed: new Map(), observedByDay: new Map(), debited: 0 }));

  const applyFor = (worker) => persistOwnedResidualProjection({
    attemptId: "risk-owner-attempt",
    command,
    persist: (candidate) => store.apply(candidate),
    observedFlattenCharges: worker.observed,
    observedFlattenChargesByDay: worker.observedByDay,
    onAppliedCharge: (charge) => { worker.debited += charge; },
  });
  const results = await Promise.all(workers.map(applyFor));

  assert.deepEqual(results.map((result) => result.status).sort(), ["already_applied", "applied"]);
  assert.deepEqual(workers.map((worker) => worker.debited), [11.5, 11.5],
    "the durable write is once while each process independently converges");
  await Promise.all(workers.map(applyFor));
  assert.deepEqual(workers.map((worker) => worker.debited), [11.5, 11.5],
    "repeated acknowledgements do not double debit either process");
  assert.equal(store.snapshot.flatten_charges, 11.5);
  assert.equal(store.snapshot.resolved, true);
});

test("stale adoption debits only the durable delta above a loaded attempt baseline", async () => {
  const before = residual(75, 1);
  const store = new AtomicProjectionStore({
    projection_version: 0,
    residual_projection_identity: residualProjectionIdentity(before),
    residual_exposure: before,
    flatten_charges: 3,
    applied_flatten_applications: [],
    resolved: false,
  });
  const winner = createResidualProjectionCommand({
    attemptId: "loaded-attempt",
    expectedVersion: 0,
    expectedResidual: before,
    nextResidual: residual(20, 3),
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 5,
  });
  const stale = createResidualProjectionCommand({
    attemptId: "loaded-attempt",
    expectedVersion: 0,
    expectedResidual: before,
    nextResidual: residual(60, 2),
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 9,
  });
  assert.equal((await store.apply(winner)).status, "applied");

  const observed = new Map();
  const observedByDay = new Map();
  seedObservedFlattenCharges(observed, "loaded-attempt", 3);
  let debited = 0;
  const adopt = () => persistOwnedResidualProjection({
    attemptId: "loaded-attempt",
    command: stale,
    persist: (candidate) => store.apply(candidate),
    observedFlattenCharges: observed,
    observedFlattenChargesByDay: observedByDay,
    onAppliedCharge: (charge) => { debited += charge; },
  });
  assert.equal((await adopt()).status, "stale");
  assert.equal(debited, 5, "historical seed is not debited again");
  assert.equal((await adopt()).status, "stale");
  assert.equal(debited, 5, "the same stale authoritative total is observed once");
});

test("late recovery adoption debits only its persisted current-day bucket", () => {
  const observed = new Map();
  let debited = 0;
  const adopted = adoptObservedFlattenCharges({
    observedByAttempt: observed,
    attemptId: "late-recovery",
    cumulativeCharges: 19,
    currentDay: "2026-09-07",
    chargeDay: "2026-09-07",
    chargesForDay: 4,
    onNewCharge: (charge) => { debited += charge; },
  });
  assert.equal(adopted, 4);
  assert.equal(observed.get("late-recovery"), 19,
    "prior-day cumulative history becomes the watermark, not today's debit");
  assert.equal(debited, 4);
  assert.equal(adoptObservedFlattenCharges({
    observedByAttempt: observed,
    attemptId: "late-recovery",
    cumulativeCharges: 19,
    currentDay: "2026-09-07",
    chargeDay: "2026-09-07",
    chargesForDay: 4,
    onNewCharge: (charge) => { debited += charge; },
  }), 0);
  assert.equal(debited, 4, "re-adoption cannot debit the day bucket twice");
});

test("carryover attempts attribute flatten charges to payment day across restart", async () => {
  const yesterday = new Date("2026-09-06T08:00:00.000Z");
  const todayStart = Date.parse("2026-09-06T18:30:00.000Z");
  assert.equal(boxExecutionAttemptDailyRiskContribution({
    resolved_at: yesterday,
    net_abort_pnl: -20,
    flatten_charges: 105,
    flatten_charge_day: "2026-09-07",
    flatten_charges_for_day: 5,
  }, todayStart, "2026-09-07"), -5,
  "today's restart seed includes the late fee but not yesterday's abort or cumulative fees");

  const before = residual(20, 2);
  const store = new AtomicProjectionStore({
    projection_version: 1,
    residual_projection_identity: residualProjectionIdentity(before),
    residual_exposure: before,
    flatten_charges: 100,
    flatten_charge_day: "2026-09-06",
    flatten_charges_for_day: 100,
    applied_flatten_applications: [],
    resolved: false,
  });
  const firstToday = createResidualProjectionCommand({
    attemptId: "carryover",
    expectedVersion: 1,
    expectedResidual: before,
    nextResidual: residual(10, 3),
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 2,
  });
  assert.equal((await store.apply(firstToday)).status, "applied");
  assert.equal(store.snapshot.flatten_charges, 102);
  assert.equal(store.snapshot.flatten_charge_day, "2026-09-07");
  assert.equal(store.snapshot.flatten_charges_for_day, 2,
    "a new day starts a fresh bucket without losing lifetime cumulative charges");
});

test("projection application ids remain bounded while evicted commands are stale", async () => {
  let current = residual(75, 1);
  const store = new AtomicProjectionStore({
    projection_version: 0,
    residual_projection_identity: residualProjectionIdentity(current),
    residual_exposure: current,
    flatten_charges: 0,
    applied_flatten_applications: [],
    resolved: false,
  });
  const commands = [];
  for (let version = 0; version < MAX_FLATTEN_APPLICATION_IDS + 3; version++) {
    const next = residual(Math.max(1, 75 - version - 1), version + 2);
    const command = createResidualProjectionCommand({
      attemptId: "bounded-attempt",
      expectedVersion: version,
      expectedResidual: current,
      nextResidual: next,
      flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 1,
    });
    commands.push(command);
    assert.equal((await store.apply(command)).status, "applied");
    current = next;
  }
  assert.equal(store.snapshot.applied_flatten_applications.length, MAX_FLATTEN_APPLICATION_IDS);
  assert.equal(store.snapshot.flatten_charges, MAX_FLATTEN_APPLICATION_IDS + 3);
  assert.equal((await store.apply(commands.at(-1))).status, "already_applied");
  assert.equal((await store.apply(commands[0])).status, "stale",
    "an evicted id remains harmless because its expected version is old");
  assert.equal(store.snapshot.flatten_charges, MAX_FLATTEN_APPLICATION_IDS + 3);
});

test("resolved watermarks and obsolete day buckets are released while live ones survive", () => {
  const observedByAttempt = new Map([
    ["live", 12.5],
    ["pending", 4],
    ["resolved", 99],
  ]);
  const observedByAttemptDay = new Map([
    ["live\u00002026-09-07", 12.5],
    ["live\u00002026-09-04", 3],
    ["pending\u00002026-09-07", 4],
    ["resolved\u00002026-09-07", 99],
  ]);

  const sizes = compactObservedFlattenChargeWatermarks({
    observedByAttempt,
    observedByAttemptDay,
    // Exactly what the engine retains: exposure still being flattened plus an outstanding
    // acknowledgement. The resolved attempt is represented by the authoritative seed.
    retainAttemptIds: new Set(["live", "pending"]),
    currentDay: "2026-09-07",
  });

  assert.deepEqual([...observedByAttempt.keys()].sort(), ["live", "pending"]);
  assert.deepEqual(
    [...observedByAttemptDay.keys()].sort(),
    ["live\u00002026-09-07", "pending\u00002026-09-07"],
    "a prior-day bucket cannot outlive its rollover",
  );
  assert.deepEqual(sizes, { lifetime: 2, dayBuckets: 2 });
  assert.equal(observedByAttempt.get("live"), 12.5,
    "compaction never lowers a retained watermark, so a repeat acknowledgement stays idempotent");
});

test("projection version/identity bookkeeping is released only for unprojectable attempts", () => {
  const projectionVersionByAttempt = new Map([["live", 7], ["pending", 2], ["resolved", 11]]);
  const projectionIdentityByAttempt = new Map([
    ["live", residualProjectionIdentity(residual(40, 3))],
    ["pending", residualProjectionIdentity(residual(75, 1))],
    ["resolved", residualProjectionIdentity([])],
  ]);

  const sizes = compactResidualProjectionBookkeeping({
    projectionVersionByAttempt,
    projectionIdentityByAttempt,
    retainAttemptIds: new Set(["live", "pending"]),
  });

  assert.deepEqual([...projectionVersionByAttempt.keys()].sort(), ["live", "pending"]);
  assert.deepEqual([...projectionIdentityByAttempt.keys()].sort(), ["live", "pending"]);
  assert.equal(projectionVersionByAttempt.get("live"), 7,
    "a retained attempt keeps the exact expected version its next compare-and-set needs");
  assert.deepEqual(sizes, { projectionVersions: 2, projectionIdentities: 2 });

  // Every attempt resolving leaves nothing behind, which is the bound the audit asked for.
  assert.deepEqual(
    compactResidualProjectionBookkeeping({
      projectionVersionByAttempt,
      projectionIdentityByAttempt,
      retainAttemptIds: new Set(),
    }),
    { projectionVersions: 0, projectionIdentities: 0 },
  );
});

test("direct recovery registers with the watchdog before its first no-progress pass", async () => {
  const events = [];
  const registered = new Map();
  const inFlight = new Set();
  const result = await runInitialRegisteredResidualPass({
    markInFlight: () => { events.push("in-flight"); inFlight.add("recovery"); },
    register: () => { events.push("registered"); registered.set("recovery", residual()); },
    flatten: async () => {
      events.push("flatten");
      assert.equal(registered.has("recovery"), true);
      assert.equal(inFlight.has("recovery"), true);
      return { remaining: residual(), flatten_charges: 0 };
    },
    clearInFlight: () => { events.push("cleared"); inFlight.delete("recovery"); },
  });
  assert.deepEqual(events, ["in-flight", "registered", "flatten", "cleared"]);
  assert.deepEqual(result.remaining, residual());
  assert.equal(registered.has("recovery"), true,
    "no-book/gate-refusal/broker-rejection style no-progress remains autonomously retryable");
  assert.equal(inFlight.size, 0);
});

test("offline recovery-index validation rejects missing, incompatible, and duplicate states", () => {
  const valid = {
    name: BOX_RECOVERY_UNIQUE_INDEX,
    unique: true,
    key: { candidate_key: 1 },
    partialFilterExpression: { candidate_key: BOX_RECOVERY_KEY, resolved: false },
  };
  assert.equal(boxRecoveryPersistenceValidationError([valid], ["one"]), null);
  assert.match(boxRecoveryPersistenceValidationError([], []), /missing/);
  assert.match(boxRecoveryPersistenceValidationError([{ ...valid, unique: false }], []), /not unique/);
  assert.match(boxRecoveryPersistenceValidationError([{
    ...valid,
    partialFilterExpression: { candidate_key: BOX_RECOVERY_KEY, resolved: true },
  }], []), /partial filter/);
  assert.match(boxRecoveryPersistenceValidationError([valid], ["one", "two"]), /duplicate unresolved/);
});

test("projection and crash-recovery identities are deterministic and content-sensitive", () => {
  const a = residual(75, 1);
  const reordered = [
    ...a,
    { ...a[0], token: 9002, tradingsymbol: "SYM-k2_ce", role: "k2_ce" },
  ];
  const reversed = [...reordered].reverse();
  assert.equal(residualProjectionIdentity(reordered), residualProjectionIdentity(reversed));
  assert.equal(
    recoveryExecutionAttemptId("boot-recovery:2026-09-07", reordered),
    recoveryExecutionAttemptId("boot-recovery:2026-09-07", reversed),
  );
  assert.notEqual(
    recoveryExecutionAttemptId("boot-recovery:2026-09-07", reordered),
    recoveryExecutionAttemptId("boot-recovery:2026-09-08", reordered),
  );
});

/* ══════════ crash-recovery readiness must survive a reconnect ══════════
 *
 * The boundary is verified by a round trip, so it is only trustworthy while THAT connection is up.
 * The bit used to be one-shot — cleared on every disconnect, set only by `boot()`, which cannot run
 * twice — so one routine reconnect quarantined crash-only recovery (and, with such exposure
 * attributed, live entry) until an operator restarted the process.
 */

test("a restored Box connection re-verifies the crash-recovery boundary and lifts the quarantine", async () => {
  let connected = true;
  let nowMs = 0;
  let establishes = 0;
  let fail = false;
  const gate = new BoxRecoveryPersistenceGate({
    isConnected: () => connected,
    establish: async () => {
      establishes++;
      if (fail) throw new Error("index verification unavailable");
    },
    now: () => nowMs,
    reverifyBackoffMs: 1_000,
  });

  // Fail closed before boot — and a readiness PROBE must never establish the safety-critical
  // boundary as a side effect in a process that never established it explicitly.
  assert.equal(gate.isReady(), false);
  assert.equal(establishes, 0);

  await gate.establishNow();
  assert.equal(establishes, 1);
  assert.equal(gate.isReady(), true);

  // A lost connection invalidates the verification: it proved nothing about the next connection.
  connected = false;
  assert.equal(gate.isReady(), false);

  connected = true;
  assert.equal(gate.isReady(), false, "the first probe after a reconnect is still fail-closed");
  assert.equal(gate.isReady(), false);
  assert.equal(gate.isReady(), false);
  assert.equal(establishes, 2, "repeated probes start exactly one re-verification, never a storm");
  await gate.pendingVerification();
  assert.equal(gate.isReady(), true, "the restored connection lifts the quarantine, with no restart");
  assert.equal(establishes, 2);

  // A re-verification that FAILS stays quarantined and is not retried inside the backoff window.
  nowMs = 1_000;
  connected = false;
  fail = true;
  assert.equal(gate.isReady(), false);
  connected = true;
  assert.equal(gate.isReady(), false);
  await gate.pendingVerification();
  assert.equal(establishes, 3);
  assert.equal(gate.isReady(), false, "an unverifiable boundary stays fail-closed");
  await gate.pendingVerification();
  assert.equal(establishes, 3, "and is not retried within the backoff window");

  // The next window recovers on its own.
  nowMs = 2_000;
  fail = false;
  assert.equal(gate.isReady(), false);
  await gate.pendingVerification();
  assert.equal(establishes, 4);
  assert.equal(gate.isReady(), true);
});

test("the module-level readiness probe is fail-closed with no Box connection", () => {
  // The production wiring: no connection offline, so crash-only recovery stays quarantined and
  // nothing tries to build indexes.
  assert.equal(isBoxRecoveryPersistenceReady(), false);
});

const mongoSkip = URI
  ? false
  : "set BOX_TEST_MONGODB_URI to a throwaway database to run the real MongoDB projection CAS test";

test("real Mongo: concurrent projection writers apply one charge/version", async (t) => {
  if (mongoSkip) return t.skip(mongoSkip);
  process.env.BOX_MONGODB_URI = URI;
  const [db, repo, model] = await Promise.all([
    import("../../dist/db.js"),
    import("../../dist/box/repository.js"),
    import("../../dist/box/model.js"),
  ]);
  await db.initBoxConnection();
  await model.BoxExecutionAttempt.deleteMany({ candidate_key: "projection-cas-test" });
  const before = residual(75, 1);
  const created = await model.BoxExecutionAttempt.create({
    candidate_key: "projection-cas-test",
    residual_exposure: before,
    resolved: false,
    flatten_charges: 0,
    projection_version: 0,
    residual_projection_identity: residualProjectionIdentity(before),
    applied_flatten_applications: [],
  });
  const command = createResidualProjectionCommand({
    attemptId: created._id.toString(),
    expectedVersion: 0,
    expectedResidual: before,
    nextResidual: residual(30, 2),
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 4.5,
  });

  const results = await Promise.all([
    repo.applyBoxExecutionAttemptProjection(created._id.toString(), command),
    repo.applyBoxExecutionAttemptProjection(created._id.toString(), command),
  ]);
  const stored = await model.BoxExecutionAttempt.findById(created._id).lean();
  assert.deepEqual(results.map((result) => result.status).sort(), ["already_applied", "applied"]);
  assert.deepEqual(results.map((result) => result.flatten_charge_day), ["2026-09-07", "2026-09-07"]);
  assert.deepEqual(results.map((result) => result.flatten_charges_for_day), [4.5, 4.5]);
  assert.equal(stored.projection_version, 1);
  assert.equal(stored.flatten_charges, 4.5);
  assert.deepEqual(stored.residual_exposure, residual(30, 2));
  await model.BoxExecutionAttempt.deleteMany({ candidate_key: "projection-cas-test" });
});

test("real Mongo: a physically legacy row accepts one version-zero CAS", async (t) => {
  if (mongoSkip) return t.skip(mongoSkip);
  const [db, repo, model] = await Promise.all([
    import("../../dist/db.js"),
    import("../../dist/box/repository.js"),
    import("../../dist/box/model.js"),
  ]);
  await db.initBoxConnection();
  await model.BoxExecutionAttempt.deleteMany({ candidate_key: "projection-legacy-cas-test" });
  const before = residual(75, 1);
  const id = new model.BoxExecutionAttempt()._id;
  await model.BoxExecutionAttempt.collection.insertOne({
    _id: id,
    candidate_key: "projection-legacy-cas-test",
    residual_exposure: before,
    resolved: false,
    flatten_charges: null,
    // Deliberately omit projection_version, residual_projection_identity, and the application ring.
  });
  const command = createResidualProjectionCommand({
    attemptId: id.toString(),
    expectedVersion: 0,
    expectedResidual: before,
    nextResidual: residual(35, 2),
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 6.25,
  });

  const result = await repo.applyBoxExecutionAttemptProjection(id.toString(), command);
  const stored = await model.BoxExecutionAttempt.collection.findOne({ _id: id });
  assert.equal(result.status, "applied");
  assert.equal(result.flatten_charge_day, "2026-09-07");
  assert.equal(result.flatten_charges_for_day, 6.25);
  assert.equal(stored.projection_version, 1);
  assert.equal(stored.flatten_charges, 6.25);
  assert.equal(stored.flatten_charge_day, "2026-09-07");
  assert.equal(stored.flatten_charges_for_day, 6.25);
  assert.deepEqual(stored.residual_exposure, residual(35, 2));
  assert.deepEqual(stored.applied_flatten_applications, [command.application_id]);
  assert.equal((await repo.applyBoxExecutionAttemptProjection(id.toString(), command)).status, "already_applied");
  await model.BoxExecutionAttempt.deleteMany({ candidate_key: "projection-legacy-cas-test" });
});

test("real Mongo: recovery index is established and duplicate unresolved rows fail closed", async (t) => {
  if (mongoSkip) return t.skip(mongoSkip);
  const [db, repo, model] = await Promise.all([
    import("../../dist/db.js"),
    import("../../dist/box/repository.js"),
    import("../../dist/box/model.js"),
  ]);
  await db.initBoxConnection();
  await model.BoxExecutionAttempt.init();
  await model.BoxExecutionAttempt.deleteMany({ candidate_key: BOX_RECOVERY_KEY });
  const dropRecoveryIndex = async () => {
    try {
      await model.BoxExecutionAttempt.collection.dropIndex(BOX_RECOVERY_UNIQUE_INDEX);
    } catch (error) {
      if (error?.code !== 27 && error?.codeName !== "IndexNotFound") throw error;
    }
  };

  await dropRecoveryIndex();
  await repo.initialiseBoxExecutionAttemptPersistence();
  const indexes = await model.BoxExecutionAttempt.collection.indexes();
  assert.equal(boxRecoveryPersistenceValidationError(indexes, []), null);

  await dropRecoveryIndex();
  const first = residual(75, 1);
  const second = residual(30, 2);
  await model.BoxExecutionAttempt.collection.insertMany([
    {
      _id: new model.BoxExecutionAttempt()._id,
      candidate_key: BOX_RECOVERY_KEY,
      resolved: false,
      resolved_at: new Date(),
      residual_exposure: first,
      projection_version: 0,
      residual_projection_identity: residualProjectionIdentity(first),
      flatten_charges: 0,
    },
    {
      _id: new model.BoxExecutionAttempt()._id,
      candidate_key: BOX_RECOVERY_KEY,
      resolved: false,
      resolved_at: new Date(),
      residual_exposure: second,
      projection_version: 0,
      residual_projection_identity: residualProjectionIdentity(second),
      flatten_charges: 0,
    },
  ]);
  try {
    await assert.rejects(
      () => repo.initialiseBoxExecutionAttemptPersistence(),
      /duplicate unresolved rows require quarantine\/repair/,
    );
    await assert.rejects(
      () => repo.ensureBoxRecoveryExecutionAttempt({
        id: recoveryExecutionAttemptId(BOX_RECOVERY_KEY, first),
        recoveryKey: BOX_RECOVERY_KEY,
        residual: first,
        executionMode: "live",
        broker: "zerodha",
        at: new Date(),
      }),
      /quarantined/,
    );
    const startupRows = await repo.loadUnresolvedBoxExecutionAttempts();
    assert.equal(startupRows.some((row) => row.candidate_key === BOX_RECOVERY_KEY), false,
      "unsafe duplicates are excluded from watchdog adoption");
  } finally {
    await model.BoxExecutionAttempt.deleteMany({ candidate_key: BOX_RECOVERY_KEY });
    await repo.initialiseBoxExecutionAttemptPersistence();
  }
});

test("real Mongo: crash-only recovery adopts the existing unresolved boundary across snapshot changes", async (t) => {
  if (mongoSkip) return t.skip(mongoSkip);
  process.env.BOX_MONGODB_URI = URI;
  const [db, repo, model] = await Promise.all([
    import("../../dist/db.js"),
    import("../../dist/box/repository.js"),
    import("../../dist/box/model.js"),
  ]);
  await db.initBoxConnection();
  await model.BoxExecutionAttempt.deleteMany({ candidate_key: "boot-recovery" });
  await repo.initialiseBoxExecutionAttemptPersistence();
  const firstResidual = residual(75, 1);
  const first = await repo.ensureBoxRecoveryExecutionAttempt({
    id: recoveryExecutionAttemptId("boot-recovery", firstResidual),
    recoveryKey: "boot-recovery",
    residual: firstResidual,
    executionMode: "live",
    broker: "zerodha",
    at: new Date(),
  });
  const changedResidual = residual(30, 2);
  const second = await repo.ensureBoxRecoveryExecutionAttempt({
    id: recoveryExecutionAttemptId("boot-recovery", changedResidual),
    recoveryKey: "boot-recovery",
    residual: changedResidual,
    executionMode: "live",
    broker: "zerodha",
    at: new Date(),
  });

  assert.equal(second._id.toString(), first._id.toString());
  assert.deepEqual(second.residual_exposure, firstResidual, "the existing durable projection remains authoritative");
  assert.equal(await model.BoxExecutionAttempt.countDocuments({ candidate_key: "boot-recovery", resolved: false }), 1);
  await model.BoxExecutionAttempt.deleteMany({ candidate_key: "boot-recovery" });
});


/* ══════════ the daily-risk seed must be bounded and indexed ══════════ */

test("every daily-risk seed branch is bounded and index-ordered", () => {
  // The seed used to be one unbounded `$or`, so it could scan the whole attempt collection as
  // stranded unresolved rows accumulated. Asserted on the source because the bound is a property of
  // the QUERY, not of any result an offline harness can produce.
  const repository = readFileSync(new URL("../../src/box/repository.ts", import.meta.url), "utf8");
  const seed = repository.slice(
    repository.indexOf("export async function loadBoxLiveRiskSeed"),
    repository.indexOf("/* ----------------------------- daily P&L archive"),
  );
  assert.equal(seed.includes("$or"), false, "no unbounded multi-branch scan");
  assert.equal(
    (seed.match(/\.limit\(BOX_DAILY_RISK_SEED_LIMIT\)/g) ?? []).length,
    3,
    "each attempt contribution is bounded",
  );
  // And each bound is served in the order that matters, so truncation drops the least significant
  // rows rather than an arbitrary page.
  assert.match(seed, /flatten_charge_day: tradingDay \}\)[\s\S]*?\.sort\(\{ flatten_charges_for_day: -1 \}\)/);
  assert.match(seed, /resolved_at: \{ \$gte: new Date\(sinceMs\) \} \}\)[\s\S]*?\.sort\(\{ resolved_at: -1 \}\)/);
  assert.match(seed, /resolved: false \}\)[\s\S]*?\.sort\(\{ resolved_at: -1 \}\)/);
  // Overlapping branches must be merged by identity or the day is charged more than once.
  assert.match(seed, /attemptsById\.set\(String\(row\._id\), row\)/);

  const model = readFileSync(new URL("../../src/box/model.ts", import.meta.url), "utf8");
  assert.match(
    model,
    /boxExecutionAttemptSchema\.index\(\s*\{ flatten_charge_day: 1, flatten_charges_for_day: -1 \}/,
    "the day-scoped branch needs its own index",
  );
});

test("real Mongo: the bounded daily-risk seed is indexed and counts an overlapping row once", async (t) => {
  if (mongoSkip) return t.skip(mongoSkip);
  process.env.BOX_MONGODB_URI = URI;
  const [db, repo, model] = await Promise.all([
    import("../../dist/db.js"),
    import("../../dist/box/repository.js"),
    import("../../dist/box/model.js"),
  ]);
  await db.initBoxConnection();
  await model.BoxExecutionAttempt.init();

  const indexes = await model.BoxExecutionAttempt.collection.indexes();
  const dayIndex = indexes.find((index) => index.name === "box_execution_attempt_flatten_charge_day");
  assert.ok(dayIndex, "the day-scoped seed branch must have a supporting index");
  assert.equal(dayIndex.key.flatten_charge_day, 1);
  assert.equal(dayIndex.key.flatten_charges_for_day, -1);

  // A future IST day, so rows written by any other test cannot contribute to these totals.
  const tradingDay = "2099-01-02";
  const sinceMs = Date.parse(`${tradingDay}T00:00:00+05:30`);
  const key = "daily-risk-seed-bound-test";
  await model.BoxExecutionAttempt.deleteMany({ candidate_key: key });
  const resolvedTodayCharged = new model.BoxExecutionAttempt()._id;
  const carryoverCharged = new model.BoxExecutionAttempt()._id;
  const legacyResolvedToday = new model.BoxExecutionAttempt()._id;
  await model.BoxExecutionAttempt.collection.insertMany([
    {
      // In the day-charge branch AND the resolved-today branch: it must be counted once.
      _id: resolvedTodayCharged,
      candidate_key: key,
      resolved: true,
      resolved_at: new Date(sinceMs + 6 * 60 * 60 * 1_000),
      net_abort_pnl: -100,
      flatten_charges: 25,
      flatten_charge_day: tradingDay,
      flatten_charges_for_day: 10,
    },
    {
      // In the day-charge branch AND the still-unresolved branch. Its prior-day cumulative history
      // must not be charged again, only today's bucket.
      _id: carryoverCharged,
      candidate_key: key,
      resolved: false,
      resolved_at: new Date(sinceMs - 5 * 24 * 60 * 60 * 1_000),
      net_abort_pnl: -50,
      flatten_charges: 30,
      flatten_charge_day: tradingDay,
      flatten_charges_for_day: 5,
    },
    {
      // Physically legacy: resolved today with no day bucket, so its cumulative charge is the
      // additive-compatible fallback.
      _id: legacyResolvedToday,
      candidate_key: key,
      resolved: true,
      resolved_at: new Date(sinceMs + 7 * 60 * 60 * 1_000),
      net_abort_pnl: -20,
      flatten_charges: 7,
    },
  ]);

  try {
    const seed = await repo.loadBoxLiveRiskSeed(sinceMs, tradingDay);
    assert.equal(seed.realisedPnl, -142, "(-100-10) + (-5) + (-20-7), each row exactly once");
    assert.equal(seed.rejects, 0);
    assert.equal(seed.consecutiveFailures, 0);
    assert.equal(seed.flattenChargeBaselinesForDay[String(resolvedTodayCharged)], 10);
    assert.equal(seed.flattenChargeBaselinesForDay[String(carryoverCharged)], 5);
    assert.equal(seed.flattenChargeBaselinesForDay[String(legacyResolvedToday)], undefined);
    assert.equal(seed.flattenChargeBaselines[String(carryoverCharged)], 30,
      "the unresolved row's lifetime watermark still seeds idempotency");
    assert.equal(seed.flattenChargeBaselines[String(resolvedTodayCharged)], undefined);
  } finally {
    await model.BoxExecutionAttempt.deleteMany({ candidate_key: key });
  }
});


/**
 * Release the Mongo socket this file opened.
 *
 * An open connection is a live handle, so without this the runner sits on a drained event loop
 * after the last assertion and the CI job hangs until its wall-clock limit rather than reporting
 * the result it already has. Offline runs never connect, so this is a no-op there.
 */
after(async () => {
  if (!URI) return;
  const { boxConnection } = await import("../../dist/db.js");
  await boxConnection?.close();
});
