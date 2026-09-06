/**
 * MULTI-PROCESS RESERVATION SAFETY.
 *
 * The whole point of these tests is that they are NOT two objects over two unrelated
 * Maps. Every "worker" here is a separate `DurableInstrumentReservations` instance
 * with its own owner-id namespace, pointed at ONE shared `InMemoryReservationDatabase`
 * — the same topology as two PM2 workers sharing a Mongo cluster. If the algorithm
 * only worked because both halves lived in one object, these tests would pass
 * vacuously and prove nothing; they are written so that they cannot.
 *
 * WHY AN IN-MEMORY DATABASE AND NOT A REAL MONGO
 * The Box suite is deliberately offline (`.github/workflows/ci.yml`: "no Zerodha
 * credentials, no MongoDB, no Redis, no market access") so it runs deterministically
 * on every push. `InMemoryReservationPort` is not a stub that assumes success — it
 * models the two properties that actually decide the outcome: a real unique compound
 * multikey index (a Map from `deployment \0 key`, so uniqueness is enforced by
 * insertion exactly as a database enforces it), and a yield to the event loop BEFORE
 * each critical section, so concurrent callers genuinely interleave and an ordering
 * bug can be discovered rather than accidentally serialised away.
 *
 * The same assertions run against a REAL cluster in
 * `mongoReservationIntegration.test.mjs` when `BOX_TEST_MONGODB_URI` is set, which is
 * what covers the things an in-memory model cannot: Mongo's own index semantics, its
 * wire protocol, and its TTL monitor.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { InProcessInstrumentReservations } from "../../dist/box/reservations/inProcess.js";
import { DurableInstrumentReservations } from "../../dist/box/reservations/durable.js";
import { ChainedInstrumentReservations } from "../../dist/box/reservations/chained.js";
import {
  InMemoryReservationDatabase,
  InMemoryReservationPort,
} from "../../dist/box/reservations/memoryStore.js";
import {
  createProcessIdentity,
  isOwnedByProcess,
  mintOwnerId,
  processOwnerPrefix,
  resolveDeploymentId,
} from "../../dist/box/reservations/identity.js";

const NOW = 1_700_000_000_000;
const TTL = 1000;
const DEPLOYMENT = "test-deployment";

/**
 * One simulated worker: its own store instance, its own owner namespace, the SHARED
 * database. `clock` is a mutable box so a test can advance time deterministically —
 * there are no real timers anywhere in this file.
 */
function makeWorker(db, options = {}) {
  const clock = options.clock ?? { value: NOW };
  const generation = options.generation ?? { value: 1 };
  const broker = options.broker ?? { value: "zerodha" };
  const tag = options.tag ?? "w1";
  const deployment = options.deployment ?? DEPLOYMENT;
  const port = new InMemoryReservationPort(db, {
    clock: () => clock.value,
    crossProcess: options.crossProcess ?? true,
  });
  const store = new DurableInstrumentReservations({
    port,
    context: () => ({
      deployment,
      broker: broker.value,
      generation: generation.value,
      mode: options.mode ?? "live",
    }),
    ownerPrefix: `${deployment}:${tag}:`,
    skewGraceMs: options.skewGraceMs ?? 0,
    // Large, so a frozen/advanced clock never triggers a resync mid-test.
    clockSyncIntervalMs: 1_000_000_000,
    now: () => clock.value,
    log: () => {},
  });
  let seq = 0;
  return {
    store,
    port,
    clock,
    generation,
    broker,
    deployment,
    prefix: `${deployment}:${tag}:`,
    /** A globally unique owner id in THIS worker's namespace. */
    owner: (label = "entry") => `${deployment}:${tag}:${label}-${(seq += 1)}`,
    acquire(owner, keys, extra = {}) {
      return store.tryAcquireAll({
        owner,
        keys,
        ttlMs: extra.ttlMs ?? TTL,
        now: extra.now ?? clock.value,
        ...(extra.sideByKey ? { sideByKey: extra.sideByKey } : {}),
      });
    },
  };
}

async function ready(...workers) {
  for (const worker of workers) await worker.store.initialise();
}

/** Fresh, non-colliding contract keys per iteration. */
function keysFor(iteration, ...suffixes) {
  return suffixes.map((s) => `ZERODHA:NFO:R${iteration}${s}`);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. THE INDEX SEMANTICS THE WHOLE DESIGN RESTS ON
 * ══════════════════════════════════════════════════════════════════════════ */

test("MP1 (mandatory): [X,Y] succeeds, [Y,Z] fails ATOMICALLY, Z stays free, [Z] then succeeds", async () => {
  const db = new InMemoryReservationDatabase();
  const a = makeWorker(db, { tag: "wa" });
  const b = makeWorker(db, { tag: "wb" });
  const c = makeWorker(db, { tag: "wc" });
  await ready(a, b, c);

  const [X, Y, Z] = ["K:X", "K:Y", "K:Z"];

  const first = await a.acquire(a.owner(), [X, Y]);
  assert.equal(first.ok, true);
  assert.equal(first.durability, "durable");

  // Overlaps on Y only. It must fail, and — this is the atomicity claim — it must NOT
  // have taken Z on the way to discovering the conflict.
  const second = await b.acquire(b.owner(), [Y, Z]);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "conflict");
  assert.deepEqual(
    second.conflicts.map((c) => c.key),
    [Y],
    "only the genuinely contended key is reported",
  );

  // The proof: Z is free. A partial reservation would have left it held.
  assert.equal(await b.store.ownerOf(Z, b.clock.value), null, "Z must not be reserved by a failed acquire");

  const third = await c.acquire(c.owner(), [Z]);
  assert.equal(third.ok, true, "Z must still be acquirable after the overlapping attempt failed");
});

test("MP2: four legs are all-or-none — a conflict on the LAST leg reserves none of the first three", async () => {
  const db = new InMemoryReservationDatabase();
  const a = makeWorker(db, { tag: "wa" });
  const b = makeWorker(db, { tag: "wb" });
  await ready(a, b);

  const legs = ["L:2500CE", "L:2550CE", "L:2500PE", "L:2550PE"];
  // A holds only the fourth leg.
  assert.equal((await a.acquire(a.owner(), [legs[3]])).ok, true);

  const attempt = await b.acquire(b.owner(), legs);
  assert.equal(attempt.ok, false);
  assert.equal(attempt.reason, "conflict");

  for (const leg of legs.slice(0, 3)) {
    assert.equal(await b.store.ownerOf(leg, b.clock.value), null, `${leg} must be free after an all-or-none failure`);
  }
  assert.equal(b.store.activeCount(b.clock.value), 0, "the loser holds nothing");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. TRUE MULTI-WORKER RACES
 * ══════════════════════════════════════════════════════════════════════════ */

test("MP3 (mandatory): 400 concurrent overlapping acquisitions — EXACTLY one winner every time", async () => {
  const db = new InMemoryReservationDatabase();
  const a = makeWorker(db, { tag: "wa" });
  const b = makeWorker(db, { tag: "wb" });
  await ready(a, b);

  const ITERATIONS = 400;
  let aWins = 0;
  let bWins = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    const [X, Y, Z] = keysFor(i, ":X", ":Y", ":Z");
    const ownerA = a.owner();
    const ownerB = b.owner();

    // Started before either is awaited: genuinely concurrent.
    const [ra, rb] = await Promise.all([a.acquire(ownerA, [X, Y]), b.acquire(ownerB, [Y, Z])]);

    const winners = [ra.ok, rb.ok].filter(Boolean).length;
    assert.equal(winners, 1, `iteration ${i}: expected exactly one winner, got ${winners}`);
    if (ra.ok) aWins++;
    else {
      bWins++;
      assert.equal(ra.reason, "conflict");
    }

    // Y is held by exactly one owner, and it is the winner.
    const holder = await a.store.ownerOf(Y, a.clock.value);
    assert.equal(holder, ra.ok ? ownerA : ownerB);

    // Release both; only the real owner's delete does anything.
    await a.store.release({ owner: ownerA, now: a.clock.value });
    await b.store.release({ owner: ownerB, now: b.clock.value });
  }

  assert.equal(aWins + bWins, ITERATIONS);
  assert.equal(db.docs.size, 0, "no reservation leaked across 400 iterations");
  assert.equal(db.uniqueIndex.size, 0, "no index entry leaked across 400 iterations");
});

test("MP4: unrelated contracts are fully concurrent — BOTH workers win", async () => {
  const db = new InMemoryReservationDatabase();
  const a = makeWorker(db, { tag: "wa" });
  const b = makeWorker(db, { tag: "wb" });
  await ready(a, b);

  for (let i = 0; i < 100; i++) {
    const ownerA = a.owner();
    const ownerB = b.owner();
    const [ra, rb] = await Promise.all([
      a.acquire(ownerA, keysFor(i, ":RELIANCE:2500CE", ":RELIANCE:2550CE")),
      b.acquire(ownerB, keysFor(i, ":TCS:3000CE", ":TCS:3050CE")),
    ]);
    assert.equal(ra.ok, true, `iteration ${i}: RELIANCE box must not be blocked by a TCS box`);
    assert.equal(rb.ok, true, `iteration ${i}: TCS box must not be blocked by a RELIANCE box`);
    await a.store.release({ owner: ownerA, now: a.clock.value });
    await b.store.release({ owner: ownerB, now: b.clock.value });
  }
  assert.equal(db.docs.size, 0);
});

test("MP5: same underlying, DIFFERENT strikes stay concurrent — no per-underlying lock", async () => {
  const db = new InMemoryReservationDatabase();
  const a = makeWorker(db, { tag: "wa" });
  const b = makeWorker(db, { tag: "wb" });
  await ready(a, b);

  const boxA = ["ZERODHA:NFO:RELIANCE24SEP2400CE", "ZERODHA:NFO:RELIANCE24SEP2450CE"];
  const boxB = ["ZERODHA:NFO:RELIANCE24SEP2800CE", "ZERODHA:NFO:RELIANCE24SEP2850CE"];

  const [ra, rb] = await Promise.all([a.acquire(a.owner(), boxA), b.acquire(b.owner(), boxB)]);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true, "RELIANCE 2400/2450 and RELIANCE 2800/2850 share no contract");
});

test("MP6 (mandatory): BUY and SELL of the SAME contract conflict — direction is irrelevant to exclusion", async () => {
  const db = new InMemoryReservationDatabase();
  const a = makeWorker(db, { tag: "wa" });
  const b = makeWorker(db, { tag: "wb" });
  await ready(a, b);

  const contract = "ZERODHA:NFO:RELIANCE24SEP2550CE";
  const ownerA = a.owner();
  const ownerB = b.owner();

  const [ra, rb] = await Promise.all([
    a.acquire(ownerA, [contract], { sideByKey: new Map([[contract, "BUY"]]) }),
    b.acquire(ownerB, [contract], { sideByKey: new Map([[contract, "SELL"]]) }),
  ]);

  assert.equal([ra.ok, rb.ok].filter(Boolean).length, 1, "one contract, one owner, whatever the side");
  const loser = ra.ok ? rb : ra;
  assert.equal(loser.reason, "conflict");
  // The incumbent's side is reported so a log can describe the overlap, without it
  // ever changing the outcome.
  assert.equal(loser.conflicts[0].key, contract);
  assert.ok(["BUY", "SELL"].includes(loser.conflicts[0].heldSide));
});

test("MP7 (mandatory): [X,Y,Z,W] vs [Y,Z,P,Q] — one wins, and the loser holds NEITHER P NOR Q", async () => {
  const db = new InMemoryReservationDatabase();
  const a = makeWorker(db, { tag: "wa" });
  const b = makeWorker(db, { tag: "wb" });
  await ready(a, b);

  const [X, Y, Z, W, P, Q] = ["o:X", "o:Y", "o:Z", "o:W", "o:P", "o:Q"];
  const ownerA = a.owner();
  const ownerB = b.owner();

  const [ra, rb] = await Promise.all([
    a.acquire(ownerA, [X, Y, Z, W]),
    b.acquire(ownerB, [Y, Z, P, Q]),
  ]);
  assert.equal([ra.ok, rb.ok].filter(Boolean).length, 1);

  if (ra.ok) {
    // B lost: P and Q — which nobody else wanted — must be untouched.
    assert.equal(await b.store.ownerOf(P, b.clock.value), null, "P must not be held by the loser");
    assert.equal(await b.store.ownerOf(Q, b.clock.value), null, "Q must not be held by the loser");
    assert.equal(await a.store.ownerOf(W, a.clock.value), ownerA);
  } else {
    assert.equal(await a.store.ownerOf(X, a.clock.value), null, "X must not be held by the loser");
    assert.equal(await a.store.ownerOf(W, a.clock.value), null, "W must not be held by the loser");
    assert.equal(await b.store.ownerOf(P, b.clock.value), ownerB);
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. CRASH RECOVERY THROUGH EXPIRY
 * ══════════════════════════════════════════════════════════════════════════ */

test("MP8 (mandatory): a worker that vanishes without releasing blocks until TTL, then stops blocking", async () => {
  const db = new InMemoryReservationDatabase();
  const clockA = { value: NOW };
  const clockB = { value: NOW };
  const a = makeWorker(db, { tag: "wa", clock: clockA });
  const b = makeWorker(db, { tag: "wb", clock: clockB });
  await ready(a, b);

  const [X, Y, Z] = ["c:X", "c:Y", "c:Z"];
  const ownerA = a.owner();
  assert.equal((await a.acquire(ownerA, [X, Y], { ttlMs: TTL })).ok, true);

  // Worker A "crashes": no release, no renewal, and its clock never advances again.
  // Its document is still sitting in the database.

  // BEFORE the TTL: the reservation is authoritative and must be respected. This is
  // the property that makes the store worth having — a new process does NOT get to
  // wipe the table just because it did not write the row.
  clockB.value = NOW + TTL - 1;
  const early = await b.acquire(b.owner(), [Y, Z]);
  assert.equal(early.ok, false);
  assert.equal(early.reason, "conflict");
  assert.equal(early.conflicts[0].heldBy, ownerA);

  // AFTER the logical TTL: the lease is stale and may be reclaimed.
  clockB.value = NOW + TTL + 1;
  const ownerB = b.owner();
  const late = await b.acquire(ownerB, [Y, Z]);
  assert.equal(late.ok, true, "a crashed worker must not strand contracts past the TTL");

  // And the crashed worker's OTHER leg is not left incorrectly locked either.
  assert.equal(await b.store.ownerOf(X, clockB.value), null, "X must be free once A's lease expired");
  const c = makeWorker(db, { tag: "wc", clock: clockB });
  await ready(c);
  assert.equal((await c.acquire(c.owner(), [X])).ok, true, "X must be acquirable again");
});

test("MP9: a freshly started worker RESPECTS live reservations and only reaps expired ones", async () => {
  const db = new InMemoryReservationDatabase();
  const clock = { value: NOW };
  const alive = makeWorker(db, { tag: "alive", clock });
  const dead = makeWorker(db, { tag: "dead", clock });
  await ready(alive, dead);

  const liveOwner = alive.owner();
  assert.equal((await alive.acquire(liveOwner, ["s:LIVE"], { ttlMs: 60_000 })).ok, true);
  const deadOwner = dead.owner();
  assert.equal((await dead.acquire(deadOwner, ["s:DEAD"], { ttlMs: 500 })).ok, true);

  // A brand-new process starts up.
  clock.value = NOW + 1000;
  const booting = makeWorker(db, { tag: "boot", clock });
  await ready(booting);
  const reaped = await booting.store.reapExpired();

  assert.equal(reaped, 1, "startup recovery reclaims exactly the expired lease");
  assert.equal(db.docs.has(liveOwner), true, "a live reservation owned by ANOTHER worker must survive startup");
  assert.equal(db.docs.has(deadOwner), false, "the expired lease is gone");
  // And the newcomer still cannot take the live one.
  const blocked = await booting.acquire(booting.owner(), ["s:LIVE"]);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "conflict");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. OWNER-VERIFIED RELEASE
 * ══════════════════════════════════════════════════════════════════════════ */

test("MP10 (mandatory): a stale owner CANNOT release the new owner's reservation", async () => {
  const db = new InMemoryReservationDatabase();
  const clock = { value: NOW };
  const a = makeWorker(db, { tag: "wa", clock });
  const b = makeWorker(db, { tag: "wb", clock });
  await ready(a, b);

  const X = "r:X";
  const ownerA = a.owner();
  assert.equal((await a.acquire(ownerA, [X], { ttlMs: TTL })).ok, true);

  // A's lease expires. B legitimately takes the contract.
  clock.value = NOW + TTL + 1;
  const ownerB = b.owner();
  assert.equal((await b.acquire(ownerB, [X])).ok, true);
  assert.equal(await b.store.ownerOf(X, clock.value), ownerB);

  // A wakes up and tries to clean up after itself — the classic GET-then-DEL hazard.
  const released = await a.store.release({ owner: ownerA, keys: [X], now: clock.value });
  assert.equal(released, 0, "the stale owner released nothing");
  assert.equal(await b.store.ownerOf(X, clock.value), ownerB, "B MUST still own X");
});

test("MP11: release is fence-pinned as well as owner-pinned", async () => {
  const db = new InMemoryReservationDatabase();
  const a = makeWorker(db, { tag: "wa" });
  await ready(a);

  const owner = a.owner();
  const lease = await a.acquire(owner, ["f:X"]);
  assert.equal(lease.ok, true);

  // A release quoting the wrong fence must be refused even with the right owner.
  assert.equal(await a.store.release({ owner, keys: ["f:X"], now: a.clock.value, fence: lease.fence + 99 }), 0);
  assert.equal(await a.store.ownerOf("f:X", a.clock.value), owner);
  // The correct fence works.
  assert.equal(await a.store.release({ owner, keys: ["f:X"], now: a.clock.value, fence: lease.fence }), 1);
  assert.equal(await a.store.ownerOf("f:X", a.clock.value), null);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. RENEWAL
 * ══════════════════════════════════════════════════════════════════════════ */

test("MP12 (mandatory): renewal extends ownership; the challenger fails until the RENEWED expiry passes", async () => {
  const db = new InMemoryReservationDatabase();
  const clock = { value: NOW };
  const a = makeWorker(db, { tag: "wa", clock });
  const b = makeWorker(db, { tag: "wb", clock });
  await ready(a, b);

  const X = "n:X";
  const ownerA = a.owner();
  const lease = await a.acquire(ownerA, [X], { ttlMs: TTL });
  assert.equal(lease.ok, true);

  // Renew BEFORE the original expiry.
  clock.value = NOW + TTL - 200;
  const renewed = await a.store.renew({ owner: ownerA, keys: [X], ttlMs: TTL, now: clock.value, fence: lease.fence });
  assert.equal(renewed.ok, true);
  assert.equal(renewed.expiresAt, clock.value + TTL);

  // Past the ORIGINAL expiry but inside the renewed one: the challenger must fail.
  clock.value = NOW + TTL + 100;
  const blocked = await b.acquire(b.owner(), [X]);
  assert.equal(blocked.ok, false, "a renewed lease must keep protecting the contract");
  assert.equal(blocked.reason, "conflict");

  // A stops renewing. Past the RENEWED expiry the challenger succeeds.
  clock.value = NOW + TTL - 200 + TTL + 1;
  assert.equal((await b.acquire(b.owner(), [X])).ok, true, "once renewal stops, the lease expires normally");
});

test("MP13: only the current owner may renew, and an already-expired lease is NOT renewable", async () => {
  const db = new InMemoryReservationDatabase();
  const clock = { value: NOW };
  const a = makeWorker(db, { tag: "wa", clock });
  const b = makeWorker(db, { tag: "wb", clock });
  await ready(a, b);

  const X = "n2:X";
  const ownerA = a.owner();
  assert.equal((await a.acquire(ownerA, [X], { ttlMs: TTL })).ok, true);

  // A stranger cannot renew it.
  const stranger = await b.store.renew({ owner: b.owner(), keys: [X], ttlMs: TTL, now: clock.value });
  assert.equal(stranger.ok, false);
  assert.equal(stranger.reason, "lost");

  // Nor can the rightful owner resurrect it after expiry: a challenger may already
  // have taken the contracts, so a lapsed lease is not renewable. The document is still
  // there, so the reason is the precise `expired` rather than the coarse `lost` — the two
  // call for different operator responses, and both are ownership loss to the caller.
  clock.value = NOW + TTL + 1;
  const tooLate = await a.store.renew({ owner: ownerA, keys: [X], ttlMs: TTL, now: clock.value });
  assert.equal(tooLate.ok, false);
  assert.equal(tooLate.reason, "expired");
  assert.ok(a.store.diagnostics().ownershipLost >= 1, "losing ownership is counted as a safety event");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 6. OWNERSHIP VERIFICATION, FENCING AND BROKER GENERATION
 * ══════════════════════════════════════════════════════════════════════════ */

test("MP14: verify() reports the lease as LOST once another worker legitimately takes it", async () => {
  const db = new InMemoryReservationDatabase();
  const clock = { value: NOW };
  const a = makeWorker(db, { tag: "wa", clock });
  const b = makeWorker(db, { tag: "wb", clock });
  await ready(a, b);

  const X = "v:X";
  const ownerA = a.owner();
  const lease = await a.acquire(ownerA, [X], { ttlMs: TTL });
  assert.equal((await a.store.verify({ owner: ownerA, keys: [X], now: clock.value, fence: lease.fence })).owned, true);

  clock.value = NOW + TTL + 1;
  assert.equal((await b.acquire(b.owner(), [X])).ok, true);

  // A's own state still says "running". The authority disagrees, and the authority wins.
  const verdict = await a.store.verify({ owner: ownerA, keys: [X], now: clock.value, fence: lease.fence });
  assert.equal(verdict.owned, false);
  assert.equal(verdict.reason, "lost");
});

test("MP15 (mandatory): a STALE BROKER GENERATION is refused even while the lease is intact", async () => {
  const db = new InMemoryReservationDatabase();
  const generation = { value: 10 };
  const a = makeWorker(db, { tag: "wa", generation });
  await ready(a);

  const owner = a.owner();
  const lease = await a.acquire(owner, ["g:X"], { ttlMs: 60_000 });
  assert.equal(lease.ok, true);
  assert.equal((await a.store.verify({ owner, keys: ["g:X"], now: a.clock.value, fence: lease.fence })).owned, true);

  // A broker switch happens. The lease has NOT expired — it is simply from a world
  // that no longer exists.
  generation.value = 11;

  const verdict = await a.store.verify({ owner, keys: ["g:X"], now: a.clock.value, fence: lease.fence });
  assert.equal(verdict.owned, false, "execution must be refused even though local state says it is running");
  assert.equal(verdict.reason, "superseded");
  assert.match(verdict.detail, /generation 10/);

  // Renewal is refused too, so a heartbeat cannot quietly keep a stale generation alive.
  const renewed = await a.store.renew({ owner, keys: ["g:X"], ttlMs: 60_000, now: a.clock.value, fence: lease.fence });
  assert.equal(renewed.ok, false);
  assert.equal(renewed.reason, "lost");
});

test("MP16: a reservation from another BROKER is superseded, and another DEPLOYMENT never contends", async () => {
  const db = new InMemoryReservationDatabase();
  const broker = { value: "zerodha" };
  const a = makeWorker(db, { tag: "wa", broker });
  await ready(a);
  const owner = a.owner();
  const lease = await a.acquire(owner, ["b:X"], { ttlMs: 60_000 });
  broker.value = "dhan";
  const verdict = await a.store.verify({ owner, keys: ["b:X"], now: a.clock.value, fence: lease.fence });
  assert.equal(verdict.owned, false);
  assert.equal(verdict.reason, "superseded");

  // A different deployment sharing the same cluster is a different lock namespace, so
  // staging can never block production on the same contract key.
  const staging = makeWorker(db, { tag: "wa", deployment: "staging" });
  await ready(staging);
  assert.equal((await staging.acquire(staging.owner(), ["b:X"])).ok, true);
});

test("MP17: the fencing token is strictly monotonic across workers", async () => {
  const db = new InMemoryReservationDatabase();
  const a = makeWorker(db, { tag: "wa" });
  const b = makeWorker(db, { tag: "wb" });
  await ready(a, b);

  const fences = [];
  for (let i = 0; i < 50; i++) {
    const worker = i % 2 === 0 ? a : b;
    const owner = worker.owner();
    const lease = await worker.acquire(owner, [`m:${i}`]);
    assert.equal(lease.ok, true);
    fences.push(lease.fence);
    await worker.store.release({ owner, now: worker.clock.value });
  }
  for (let i = 1; i < fences.length; i++) {
    assert.ok(fences[i] > fences[i - 1], `fence must strictly increase: ${fences[i - 1]} -> ${fences[i]}`);
  }
  assert.equal(new Set(fences).size, fences.length, "no fencing token is ever reused");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 7. CLOCK SKEW
 * ══════════════════════════════════════════════════════════════════════════ */

test("MP18: a worker whose LOCAL clock is wildly wrong cannot steal a live lease", async () => {
  const db = new InMemoryReservationDatabase();
  // ONE authority clock. Both workers derive expiry from it.
  const authority = { value: NOW };
  const truthful = { value: NOW };
  // This worker's own clock is a full minute ahead — enough that, if it used its own
  // clock, it would consider a 1s lease long expired.
  const skewed = { value: NOW + 60_000 };

  const a = new DurableInstrumentReservations({
    port: new InMemoryReservationPort(db, { clock: () => authority.value }),
    context: () => ({ deployment: DEPLOYMENT, broker: "zerodha", generation: 1, mode: "live" }),
    ownerPrefix: `${DEPLOYMENT}:truthful:`,
    skewGraceMs: 0,
    clockSyncIntervalMs: 1_000_000_000,
    now: () => truthful.value,
    log: () => {},
  });
  const b = new DurableInstrumentReservations({
    port: new InMemoryReservationPort(db, { clock: () => authority.value }),
    context: () => ({ deployment: DEPLOYMENT, broker: "zerodha", generation: 1, mode: "live" }),
    ownerPrefix: `${DEPLOYMENT}:skewed:`,
    skewGraceMs: 0,
    clockSyncIntervalMs: 1_000_000_000,
    now: () => skewed.value,
    log: () => {},
  });
  await a.initialise();
  await b.initialise();

  const ownerA = `${DEPLOYMENT}:truthful:e1`;
  assert.equal(
    (await a.tryAcquireAll({ owner: ownerA, keys: ["sk:X"], ttlMs: 5000, now: truthful.value })).ok,
    true,
  );

  // The skewed worker asks for the same contract, using ITS OWN (wrong) clock.
  const attempt = await b.tryAcquireAll({ owner: `${DEPLOYMENT}:skewed:e1`, keys: ["sk:X"], ttlMs: 5000, now: skewed.value });
  assert.equal(attempt.ok, false, "worker clock skew must not be able to expire a live lease");
  assert.equal(attempt.reason, "conflict");
  assert.equal(b.diagnostics().clockOffsetMs, -60_000, "the offset against the authority is measured, not assumed");
});

test("MP19: the skew grace band makes the holder pessimistic and the challenger late", async () => {
  const db = new InMemoryReservationDatabase();
  const clock = { value: NOW };
  const a = makeWorker(db, { tag: "wa", clock, skewGraceMs: 250 });
  const b = makeWorker(db, { tag: "wb", clock, skewGraceMs: 250 });
  await ready(a, b);

  const owner = a.owner();
  const lease = await a.acquire(owner, ["gr:X"], { ttlMs: TTL });
  assert.equal(lease.ok, true);

  // Inside the last 250ms of the lease the HOLDER already stops claiming ownership.
  clock.value = NOW + TTL - 100;
  const verdict = await a.store.verify({ owner, keys: ["gr:X"], now: clock.value, fence: lease.fence });
  assert.equal(verdict.owned, false, "the holder gives up early");
  assert.equal(verdict.reason, "expired");

  // The CHALLENGER still cannot take it until 250ms AFTER the nominal expiry.
  clock.value = NOW + TTL + 100;
  assert.equal((await b.acquire(b.owner(), ["gr:X"])).ok, false, "the challenger waits late");
  clock.value = NOW + TTL + 251;
  assert.equal((await b.acquire(b.owner(), ["gr:X"])).ok, true, "past the grace band it may reclaim");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 8. THE CHAIN: FAST PATH, ROLLBACK, RELEASE ORDER
 * ══════════════════════════════════════════════════════════════════════════ */

function makeChain(db, options = {}) {
  const worker = makeWorker(db, options);
  const local = new InProcessInstrumentReservations();
  return { ...worker, local, chain: new ChainedInstrumentReservations([local, worker.store]) };
}

test("MP20 (mandatory): a failed DURABLE acquire rolls the LOCAL reservation back immediately", async () => {
  const db = new InMemoryReservationDatabase();
  const other = makeWorker(db, { tag: "other" });
  const mine = makeChain(db, { tag: "mine" });
  await ready(other, mine);

  // Another worker holds one of the four legs.
  assert.equal((await other.acquire(other.owner(), ["ch:2550CE"])).ok, true);

  const owner = mine.owner();
  const legs = ["ch:2500CE", "ch:2550CE", "ch:2500PE", "ch:2550PE"];
  const outcome = await mine.chain.tryAcquireAll({ owner, keys: legs, ttlMs: TTL, now: mine.clock.value });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "conflict");
  // THE ROLLBACK. Without it the local tier would keep these four legs for a full TTL
  // over a lease that was never granted, blocking sibling executions in this process.
  assert.equal(mine.local.activeCount(mine.clock.value), 0, "local tier must not retain a rejected reservation");
  for (const leg of legs) {
    assert.equal(mine.local.ownerOfSync(leg, mine.clock.value), null);
  }
});

test("MP21: a LOCAL conflict is rejected without touching the durable authority at all", async () => {
  const db = new InMemoryReservationDatabase();
  const mine = makeChain(db, { tag: "mine" });
  await ready(mine);

  const first = mine.owner();
  assert.equal((await mine.chain.tryAcquireAll({ owner: first, keys: ["fp:X"], ttlMs: TTL, now: mine.clock.value })).ok, true);

  const opsBefore = db.operations;
  const second = await mine.chain.tryAcquireAll({ owner: mine.owner(), keys: ["fp:X"], ttlMs: TTL, now: mine.clock.value });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "conflict");
  assert.equal(second.conflicts[0].tier, "in-process", "the cheap tier answered");
  assert.equal(db.operations, opsBefore, "NO database operation may occur for a same-process conflict");
});

test("MP22: the chain reports the DURABLE fence and durability, not the local one", async () => {
  const db = new InMemoryReservationDatabase();
  const mine = makeChain(db, { tag: "mine" });
  await ready(mine);
  const outcome = await mine.chain.tryAcquireAll({
    owner: mine.owner(),
    keys: ["dz:X"],
    ttlMs: TTL,
    now: mine.clock.value,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.durability, "durable");
  assert.equal(mine.chain.durable, true);
  // The local tier's own fence counter starts at 1 too, so assert against the store
  // that actually issued it rather than against a literal.
  assert.equal(outcome.fence, mine.store.diagnostics().acquireSuccess);
});

test("MP23: release frees BOTH tiers, and a stale owner still cannot release either", async () => {
  const db = new InMemoryReservationDatabase();
  const mine = makeChain(db, { tag: "mine" });
  const rival = makeWorker(db, { tag: "rival" });
  await ready(mine, rival);

  const owner = mine.owner();
  const lease = await mine.chain.tryAcquireAll({ owner, keys: ["rel:X"], ttlMs: TTL, now: mine.clock.value });
  assert.equal(lease.ok, true);

  await mine.chain.release({ owner, keys: ["rel:X"], now: mine.clock.value, fence: lease.fence });
  assert.equal(mine.local.activeCount(mine.clock.value), 0, "local tier released");
  assert.equal(db.docs.size, 0, "durable tier released");

  // The rival can now take it, and the original owner's repeated release is inert.
  const rivalOwner = rival.owner();
  assert.equal((await rival.acquire(rivalOwner, ["rel:X"])).ok, true);
  await mine.chain.release({ owner, keys: ["rel:X"], now: mine.clock.value, fence: lease.fence });
  assert.equal(await rival.store.ownerOf("rel:X", rival.clock.value), rivalOwner);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 9. DATABASE OUTAGE — FAIL CLOSED
 * ══════════════════════════════════════════════════════════════════════════ */

test("MP24 (mandatory): an unreachable authority reports UNAVAILABLE, never 'free'", async () => {
  const db = new InMemoryReservationDatabase();
  const mine = makeChain(db, { tag: "mine" });
  await ready(mine);

  db.failure = new Error("connection timed out");

  const durableOnly = await mine.store.tryAcquireAll({
    owner: mine.owner(),
    keys: ["out:X"],
    ttlMs: TTL,
    now: mine.clock.value,
  });
  assert.equal(durableOnly.ok, false);
  assert.equal(durableOnly.reason, "unavailable", "an outage must NOT be reported as a conflict");
  assert.equal(durableOnly.tier, "memory");

  // Through the chain the outcome is the same, and the local tier is rolled back so a
  // dead database cannot leave this process holding phantom contracts.
  const outcome = await mine.chain.tryAcquireAll({
    owner: mine.owner(),
    keys: ["out:Y"],
    ttlMs: TTL,
    now: mine.clock.value,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "unavailable");
  assert.equal(mine.local.activeCount(mine.clock.value), 0);
  assert.equal(mine.chain.ready, false, "the chain is not ready while its authority is down");
});

test("MP25: renewal and verification during an outage report UNKNOWN, not lost", async () => {
  const db = new InMemoryReservationDatabase();
  const mine = makeWorker(db, { tag: "mine" });
  await ready(mine);
  const owner = mine.owner();
  const lease = await mine.acquire(owner, ["ou:X"], { ttlMs: 60_000 });
  assert.equal(lease.ok, true);

  db.failure = new Error("primary stepped down");

  const renewed = await mine.store.renew({ owner, keys: ["ou:X"], ttlMs: 60_000, now: mine.clock.value });
  assert.equal(renewed.ok, false);
  assert.equal(renewed.reason, "unavailable", "unknown ownership is not confirmed loss");

  const verdict = await mine.store.verify({ owner, keys: ["ou:X"], now: mine.clock.value });
  assert.equal(verdict.owned, false);
  assert.equal(verdict.reason, "unavailable");

  // Critically, the reservation was NOT deleted. Recovery is still possible and the
  // contract stays protected until the TTL runs out.
  db.failure = null;
  assert.equal(db.docs.has(owner), true);
});

test("MP26: the tier recovers by itself once the authority comes back", async () => {
  const db = new InMemoryReservationDatabase();
  const clock = { value: NOW };
  const mine = makeWorker(db, { tag: "mine", clock });
  await ready(mine);

  db.failure = new Error("down");
  assert.equal((await mine.acquire(mine.owner(), ["rc:X"])).ok, false);

  db.failure = null;
  // `readyRetryMs` bounds how often a reconnect is attempted, so advance past it
  // rather than hammering a dead database.
  clock.value = NOW + 2000;
  const outcome = await mine.acquire(mine.owner(), ["rc:X"]);
  assert.equal(outcome.ok, true, "the durable tier reconnects without a restart");
  assert.equal(mine.store.ready, true);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 10. BROKER SWITCH SCOPING
 * ══════════════════════════════════════════════════════════════════════════ */

test("MP27 (mandatory): clear() drops only THIS process's reservations, never a sibling worker's", async () => {
  const db = new InMemoryReservationDatabase();
  const mine = makeWorker(db, { tag: "mine" });
  const sibling = makeWorker(db, { tag: "sibling" });
  await ready(mine, sibling);

  const mineOwner = mine.owner();
  const siblingOwner = sibling.owner();
  assert.equal((await mine.acquire(mineOwner, ["bs:MINE"], { ttlMs: 60_000 })).ok, true);
  assert.equal((await sibling.acquire(siblingOwner, ["bs:THEIRS"], { ttlMs: 60_000 })).ok, true);

  await mine.store.clear();

  assert.equal(db.docs.has(mineOwner), false, "my broker-namespaced reservation is gone");
  assert.equal(db.docs.has(siblingOwner), true, "a live sibling worker's reservation MUST survive my broker switch");
  assert.equal(await sibling.store.ownerOf("bs:THEIRS", sibling.clock.value), siblingOwner);
});

test("MP28: process identity is unique per boot, so a reused pid is not mistaken for 'me'", async () => {
  const first = createProcessIdentity({ CALSPREAD_DEPLOYMENT_ID: "prod", CALSPREAD_INSTANCE_ID: "host-1" });
  const second = createProcessIdentity({ CALSPREAD_DEPLOYMENT_ID: "prod", CALSPREAD_INSTANCE_ID: "host-1" });
  assert.notEqual(first.processTag, second.processTag, "a restart yields a different identity");
  assert.equal(first.deployment, "prod");

  const owner = mintOwnerId(first, "entry", 7);
  assert.equal(isOwnedByProcess(owner, first), true);
  assert.equal(isOwnedByProcess(owner, second), false, "another process must never claim my owner ids");
  assert.ok(owner.startsWith(processOwnerPrefix(first)));

  // Two workers minting the SAME sequence number produce different owner ids — the
  // exact collision a bare per-process counter would have caused.
  assert.notEqual(mintOwnerId(first, "entry", 7), mintOwnerId(second, "entry", 7));

  // Deployment namespacing defaults apart rather than together.
  assert.equal(resolveDeploymentId({ NODE_ENV: "production" }), "production");
  assert.equal(resolveDeploymentId({}), "development");
  assert.notEqual(resolveDeploymentId({ NODE_ENV: "production" }), resolveDeploymentId({}));
  // A label that could break a log line or a query is sanitised, not trusted.
  assert.equal(resolveDeploymentId({ CALSPREAD_DEPLOYMENT_ID: "prod/mumbai 1" }), "prod-mumbai-1");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 11. DIAGNOSTICS AND COST
 * ══════════════════════════════════════════════════════════════════════════ */

test("MP29: diagnostics expose durable health with no high-cardinality labels", async () => {
  const db = new InMemoryReservationDatabase();
  const mine = makeChain(db, { tag: "mine" });
  const rival = makeWorker(db, { tag: "rival" });
  await ready(mine, rival);

  await rival.acquire(rival.owner(), ["ZERODHA:NFO:RELIANCE24SEP2550CE"]);
  await mine.chain.tryAcquireAll({
    owner: mine.owner(),
    keys: ["ZERODHA:NFO:RELIANCE24SEP2550CE"],
    ttlMs: TTL,
    now: mine.clock.value,
  });

  const d = mine.chain.diagnostics();
  for (const field of [
    "acquireAttempts",
    "acquireSuccess",
    "conflicts",
    "errors",
    "renewSuccess",
    "renewFailure",
    "ownershipLost",
    "expiredReservationsObserved",
    "activeReservations",
  ]) {
    assert.equal(typeof d[field], "number", `${field} must be a number`);
  }
  assert.equal(typeof d.durable, "boolean");
  assert.equal(typeof d.ready, "boolean");
  assert.ok(d.conflicts >= 1);

  // The same rule the coordinator metrics test enforces: counts and statuses only,
  // never an execution id, symbol or instrument token.
  const serialised = JSON.stringify(mine.chain.tierDiagnostics());
  assert.doesNotMatch(serialised, /RELIANCE|NFO:|entry-|exit-/);
});

test("MP30: acquisition latency is measured and reported (p50/p95/p99)", async () => {
  const db = new InMemoryReservationDatabase();
  const mine = makeChain(db, { tag: "mine" });
  await ready(mine);

  const localOnly = new InProcessInstrumentReservations();
  const samples = { local: [], durable: [], combined: [] };

  for (let i = 0; i < 300; i++) {
    const keys = keysFor(i, ":A", ":B", ":C", ":D");

    let t = process.hrtime.bigint();
    await localOnly.tryAcquireAll({ owner: `local-${i}`, keys, ttlMs: TTL, now: mine.clock.value });
    samples.local.push(Number(process.hrtime.bigint() - t) / 1e6);

    const durableOwner = mine.owner();
    t = process.hrtime.bigint();
    await mine.store.tryAcquireAll({ owner: durableOwner, keys, ttlMs: TTL, now: mine.clock.value });
    samples.durable.push(Number(process.hrtime.bigint() - t) / 1e6);
    await mine.store.release({ owner: durableOwner, now: mine.clock.value });

    const chainOwner = mine.owner();
    t = process.hrtime.bigint();
    await mine.chain.tryAcquireAll({ owner: chainOwner, keys, ttlMs: TTL, now: mine.clock.value });
    samples.combined.push(Number(process.hrtime.bigint() - t) / 1e6);
    await mine.chain.release({ owner: chainOwner, now: mine.clock.value });
  }

  const pct = (arr, p) => {
    const s = [...arr].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };
  const report = {};
  for (const [name, arr] of Object.entries(samples)) {
    report[name] = {
      p50: Number(pct(arr, 0.5).toFixed(4)),
      p95: Number(pct(arr, 0.95).toFixed(4)),
      p99: Number(pct(arr, 0.99).toFixed(4)),
    };
  }
  // Printed, not hidden. These are ALGORITHM overhead against an in-memory authority;
  // a real Mongo adds its round trips on top, which the integration benchmark measures.
  console.log(`[reservation-latency-ms] ${JSON.stringify(report)}`);

  const d = mine.store.diagnostics();
  assert.equal(typeof d.acquireLatencyP50Ms, "number");
  assert.equal(typeof d.acquireLatencyP95Ms, "number");
  assert.equal(typeof d.acquireLatencyP99Ms, "number");
  // The durable tier must not be pathologically slower than the local one; the point
  // is to prove the cost is bounded, not to assert a wall-clock number in CI.
  assert.ok(report.combined.p95 < 25, `combined p95 ${report.combined.p95}ms is implausibly slow`);
});

test("MP31: an empty instrument set fails CLOSED rather than granting a lease over nothing", async () => {
  const db = new InMemoryReservationDatabase();
  const mine = makeWorker(db, { tag: "mine" });
  await ready(mine);
  const outcome = await mine.acquire(mine.owner(), []);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "unavailable");
});

test("MP32: duplicate keys in one request are deduplicated, not treated as self-conflict", async () => {
  const db = new InMemoryReservationDatabase();
  const mine = makeWorker(db, { tag: "mine" });
  await ready(mine);
  const owner = mine.owner();
  const outcome = await mine.acquire(owner, ["dd:X", "dd:X", "dd:Y"]);
  assert.equal(outcome.ok, true, "a document may repeat an index value internally");
  assert.deepEqual(outcome.keys, ["dd:X", "dd:Y"]);
});

test("MP33: a re-entrant acquire by the same owner replaces its own row rather than deadlocking on it", async () => {
  const db = new InMemoryReservationDatabase();
  const mine = makeWorker(db, { tag: "mine" });
  await ready(mine);
  const owner = mine.owner();
  assert.equal((await mine.acquire(owner, ["re:X"])).ok, true);
  const again = await mine.acquire(owner, ["re:X", "re:Y"]);
  assert.equal(again.ok, true, "an owner is never in conflict with itself");
  assert.equal(db.docs.size, 1, "and it does not accumulate rows");
  assert.deepEqual([...db.docs.get(owner).keys], ["re:X", "re:Y"]);
});


/* ══════════════════════════════════════════════════════════════════════════
 * 12. THE CHAIN'S FENCE BOOKKEEPING
 *
 * A fencing token only means something to the tier that minted it. The in-process
 * tier's is a per-process counter; the durable tier's is a persisted per-deployment
 * `$inc`. They are unrelated number spaces that both happen to start near 1 on a fresh
 * process — which is exactly why conflating them is easy to do and hard to notice.
 *
 * These tests pre-advance the durable counter so the two are DELIBERATELY out of step,
 * which is the state of every real deployment (a second worker, or any restart).
 * ══════════════════════════════════════════════════════════════════════════ */

function makeChainWithSkewedFences(db, options = {}) {
  // Pre-advance the shared durable counter, as a sibling worker or a restart would.
  db.fences.set(options.deployment ?? DEPLOYMENT, options.startFence ?? 500);
  const worker = makeWorker(db, options);
  const local = new InProcessInstrumentReservations();
  return { ...worker, local, chain: new ChainedInstrumentReservations([local, worker.store]) };
}

test("MP34: a chained RENEWAL succeeds when the tiers' fence counters are far apart", async () => {
  const db = new InMemoryReservationDatabase();
  const mine = makeChainWithSkewedFences(db, { tag: "mine" });
  await ready(mine);

  const owner = mine.owner();
  const lease = await mine.chain.tryAcquireAll({ owner, keys: ["cf:X"], ttlMs: TTL, now: mine.clock.value });
  assert.equal(lease.ok, true);
  // The DURABLE fence is what is reported outward, and it is nowhere near the local one.
  assert.equal(lease.fence, 501);
  assert.equal(lease.durability, "durable");

  const renewed = await mine.chain.renew({
    owner,
    keys: ["cf:X"],
    ttlMs: TTL,
    now: mine.clock.value,
    fence: lease.fence,
  });
  assert.equal(renewed.ok, true, "the in-process tier must not be handed the DURABLE tier's fence");

  const verdict = await mine.chain.verify({
    owner,
    keys: ["cf:X"],
    now: mine.clock.value,
    fence: lease.fence,
  });
  assert.equal(verdict.owned, true, "verification must agree, for the same reason");
});

test("MP35: a chained RELEASE frees both tiers when the fence counters are far apart", async () => {
  const db = new InMemoryReservationDatabase();
  const mine = makeChainWithSkewedFences(db, { tag: "mine" });
  await ready(mine);

  const owner = mine.owner();
  const lease = await mine.chain.tryAcquireAll({ owner, keys: ["cf2:X"], ttlMs: TTL, now: mine.clock.value });
  assert.equal(lease.ok, true);

  await mine.chain.release({ owner, keys: ["cf2:X"], now: mine.clock.value, fence: lease.fence });
  assert.equal(mine.local.activeCount(mine.clock.value), 0, "the local tier really released");
  assert.equal(db.docs.size, 0, "and so did the durable tier");
});

test("MP36: a repeated chained renewal keeps succeeding — a heartbeat must not degrade", async () => {
  const db = new InMemoryReservationDatabase();
  const clock = { value: NOW };
  const mine = makeChainWithSkewedFences(db, { tag: "mine", clock });
  await ready(mine);

  const owner = mine.owner();
  const lease = await mine.chain.tryAcquireAll({ owner, keys: ["cf3:X"], ttlMs: TTL, now: clock.value });
  assert.equal(lease.ok, true);

  let fence = lease.fence;
  for (let i = 0; i < 10; i++) {
    clock.value += TTL / 3;
    const renewed = await mine.chain.renew({ owner, keys: ["cf3:X"], ttlMs: TTL, now: clock.value, fence });
    assert.equal(renewed.ok, true, `renewal ${i} must succeed`);
    fence = renewed.fence;
  }
  assert.equal(db.docs.size, 1, "exactly one durable reservation throughout");
});

test("MP37: the chain refuses a renewal, verification or release quoting a SUPERSEDED fence", async () => {
  const db = new InMemoryReservationDatabase();
  const mine = makeChainWithSkewedFences(db, { tag: "mine" });
  await ready(mine);

  const owner = mine.owner();
  const lease = await mine.chain.tryAcquireAll({ owner, keys: ["cf4:X"], ttlMs: TTL, now: mine.clock.value });
  assert.equal(lease.ok, true);

  const stale = lease.fence - 1;
  assert.equal((await mine.chain.renew({ owner, keys: ["cf4:X"], ttlMs: TTL, now: mine.clock.value, fence: stale })).ok, false);
  assert.equal((await mine.chain.verify({ owner, keys: ["cf4:X"], now: mine.clock.value, fence: stale })).owned, false);
  assert.equal(await mine.chain.release({ owner, keys: ["cf4:X"], now: mine.clock.value, fence: stale }), 0);
  // The real lease is untouched by any of those attempts.
  assert.equal(db.docs.size, 1);
  assert.equal(mine.local.activeCount(mine.clock.value), 1);
});

test("MP38: a superseded broker generation is refused WITHOUT extending the lease", async () => {
  const db = new InMemoryReservationDatabase();
  const clock = { value: NOW };
  const generation = { value: 10 };
  const a = makeWorker(db, { tag: "wa", clock, generation });
  const b = makeWorker(db, { tag: "wb", clock, generation });
  await ready(a, b);

  const owner = a.owner();
  const lease = await a.acquire(owner, ["gx:X"], { ttlMs: TTL });
  assert.equal(lease.ok, true);
  const originalExpiry = db.docs.get(owner).expiresAt;

  // The broker switches. The lease is intact but from a world that no longer exists.
  generation.value = 11;
  clock.value = NOW + 100;
  const renewed = await a.store.renew({ owner, keys: ["gx:X"], ttlMs: TTL, now: clock.value, fence: lease.fence });
  assert.equal(renewed.ok, false, "a superseded generation may not renew");

  // THE POINT: the expiry must not have moved. Extending it and only then rejecting the
  // renewal would lock the contract for another full TTL on behalf of a worker that is
  // not allowed to trade it.
  assert.equal(db.docs.get(owner).expiresAt, originalExpiry, "the lease was NOT extended before being refused");

  // So the contract becomes available on the original schedule.
  clock.value = NOW + TTL + 1;
  assert.equal((await b.acquire(b.owner(), ["gx:X"])).ok, true);
});

test("MP39: an insert that committed but reported a duplicate is recognised as OUR OWN", async () => {
  // The reachable shape: a retryable write lands, its acknowledgement is lost, the retry
  // raises a duplicate-key error, and the offending index is not guaranteed to be reported
  // as `_id`. Treating that as a conflict would have the execution wait out the whole
  // conflict window against itself.
  const db = new InMemoryReservationDatabase();
  const mine = makeWorker(db, { tag: "mine" });
  await ready(mine);

  const owner = mine.owner();
  const first = await mine.acquire(owner, ["sc:X", "sc:Y"]);
  assert.equal(first.ok, true);

  // Force the pessimistic classification a real driver error can produce.
  const port = mine.port;
  const realInsert = port.insert.bind(port);
  port.insert = async (doc) => {
    const outcome = await realInsert(doc);
    return outcome === "owner_exists" ? "key_conflict" : outcome;
  };

  const retry = await mine.acquire(owner, ["sc:X", "sc:Y"]);
  assert.equal(retry.ok, true, "our own committed insert must be recognised, not waited out");
  assert.equal(retry.fence, first.fence, "and it reports the fence that was actually stored");
});

test("MP40: a fencing token from a FAILED attempt is reused rather than burned", async () => {
  // `nextFence` is a shared per-deployment `$inc`. It is a write, not a lock — unrelated
  // boxes are never excluded by it — but it is a round trip, and the conflict-wait loop
  // would otherwise spend one per retry round just to be told no again.
  const db = new InMemoryReservationDatabase();
  const holder = makeWorker(db, { tag: "holder" });
  const loser = makeWorker(db, { tag: "loser" });
  await ready(holder, loser);

  assert.equal((await holder.acquire(holder.owner(), ["fr:X"], { ttlMs: 60_000 })).ok, true);

  const before = db.fences.get(DEPLOYMENT);
  for (let i = 0; i < 5; i++) {
    const attempt = await loser.acquire(loser.owner(), ["fr:X"]);
    assert.equal(attempt.ok, false);
    assert.equal(attempt.reason, "conflict");
  }
  const after = db.fences.get(DEPLOYMENT);
  assert.equal(after, before + 1, "five failed retries consumed ONE fencing token, not five");

  // And the recycled token is still usable, so nothing was corrupted.
  assert.equal((await loser.acquire(loser.owner(), ["fr:FREE"])).ok, true);
});

test("MP41: the Mongo-shaped port stops being ready when its connection drops", async () => {
  // `ready` must not latch. An index dropped during maintenance, or a reconnect to a
  // different cluster, has to be re-detected — otherwise inserts silently stop being
  // unique while the tier reports itself healthy.
  const db = new InMemoryReservationDatabase();
  const mine = makeWorker(db, { tag: "mine" });
  await ready(mine);
  assert.equal(mine.store.ready, true);

  db.failure = new Error("connection lost");
  assert.equal(mine.port.ready, false, "a dropped connection is observable");
  assert.equal(mine.store.ready, false, "and the tier reports itself unusable");
});
