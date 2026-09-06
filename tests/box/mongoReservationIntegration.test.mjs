/**
 * REAL MONGODB INTEGRATION — verifying the index semantics rather than assuming them.
 *
 * `durableInstrumentReservations.test.mjs` proves the ALGORITHM against a model of a
 * unique compound multikey index. This file proves the MODEL, by running the same
 * decisive assertions against an actual cluster:
 *
 *   • that `{ deployment: 1, keys: 1 }` unique really does refuse a second document
 *     sharing any one array element,
 *   • that a rejected insert leaves NO document and NO index entry behind, so a
 *     four-leg claim is genuinely all-or-none,
 *   • that the index is created and is actually unique,
 *   • that two independent ports racing over one cluster produce exactly one winner,
 *   • and what a durable acquisition really costs in milliseconds.
 *
 * WHY IT IS SKIPPED BY DEFAULT
 * CI is deliberately offline — `.github/workflows/ci.yml` states the Box suite needs
 * "no Zerodha credentials, no MongoDB, no Redis, no market access" — so this is the
 * suite's first env-gated test rather than a new hard dependency. Point it at a
 * throwaway database and run:
 *
 *   BOX_TEST_MONGODB_URI="mongodb://127.0.0.1:27017/calspread_reservation_test" npm test
 *
 * It writes ONLY to `box_instrument_reservations` and `box_reservation_fences`, and
 * drops both before and after. Do not point it at a production database.
 */

import test from "node:test";
import assert from "node:assert/strict";

const URI = (process.env.BOX_TEST_MONGODB_URI ?? "").trim();
const skip = URI
  ? false
  : "set BOX_TEST_MONGODB_URI to a throwaway database to run the real MongoDB reservation tests";

const DEPLOYMENT = `itest-${Date.now().toString(36)}`;
const TTL = 400;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Everything that touches mongoose is loaded lazily, so with the env var unset this
 * file imports nothing beyond `node:test` and the suite stays genuinely offline.
 */
async function bootstrap() {
  // db.ts reads its URIs at module load, so the env must be set before the import.
  process.env.BOX_MONGODB_URI = URI;
  const [{ initBoxConnection, boxConnection }, reservations] = await Promise.all([
    import("../../dist/db.js"),
    import("../../dist/box/reservations/index.js"),
  ]);
  await initBoxConnection();
  const connection = boxConnection;
  assert.ok(connection && connection.readyState === 1, `could not connect to ${URI}`);
  // Start from a clean slate; these two collections are the only ones touched.
  for (const name of ["box_instrument_reservations", "box_reservation_fences"]) {
    await connection.db.collection(name).deleteMany({}).catch(() => {});
  }
  return { connection, ...reservations };
}

let ctx = null;
async function context() {
  if (ctx === null) ctx = await bootstrap();
  return ctx;
}

/** One "worker": its own port instance and owner namespace, the SAME cluster. */
function makeWorker(mod, tag, options = {}) {
  const generation = options.generation ?? { value: 1 };
  const broker = options.broker ?? { value: "zerodha" };
  const store = new mod.DurableInstrumentReservations({
    port: new mod.MongoReservationPort(),
    context: () => ({
      deployment: options.deployment ?? DEPLOYMENT,
      broker: broker.value,
      generation: generation.value,
      mode: "live",
    }),
    ownerPrefix: `${options.deployment ?? DEPLOYMENT}:${tag}:`,
    skewGraceMs: 0,
    log: () => {},
  });
  let seq = 0;
  return {
    store,
    generation,
    broker,
    owner: () => `${options.deployment ?? DEPLOYMENT}:${tag}:e${(seq += 1)}`,
    acquire: (owner, keys, ttlMs = TTL) =>
      store.tryAcquireAll({ owner, keys, ttlMs, now: Date.now() }),
  };
}

test("MI1 (mandatory): the unique multikey index really enforces one contract, one reservation", async (t) => {
  if (skip) return t.skip(skip);
  const mod = await context();
  const a = makeWorker(mod, "wa");
  const b = makeWorker(mod, "wb");
  const c = makeWorker(mod, "wc");
  await a.store.initialise();
  await b.store.initialise();
  await c.store.initialise();

  const [X, Y, Z] = [`${DEPLOYMENT}:X`, `${DEPLOYMENT}:Y`, `${DEPLOYMENT}:Z`];

  const first = await a.acquire(a.owner(), [X, Y], 60_000);
  assert.equal(first.ok, true);

  const second = await b.acquire(b.owner(), [Y, Z], 60_000);
  assert.equal(second.ok, false, "MongoDB must reject a document sharing an indexed array element");
  assert.equal(second.reason, "conflict");
  assert.deepEqual(second.conflicts.map((k) => k.key), [Y]);

  // THE ATOMICITY CLAIM, against a real server: the rejected insert left nothing.
  assert.equal(await b.store.ownerOf(Z, Date.now()), null, "Z must not be reserved by the rejected insert");
  const third = await c.acquire(c.owner(), [Z], 60_000);
  assert.equal(third.ok, true, "Z is still free, so a single-document insert really is all-or-none");
});

test("MI2: the unique index is actually created and actually unique", async (t) => {
  if (skip) return t.skip(skip);
  const mod = await context();
  const worker = makeWorker(mod, "idx");
  await worker.store.initialise();

  const indexes = await ctx.connection.db.collection("box_instrument_reservations").indexes();
  const unique = indexes.find((i) => i.name === mod.RESERVATION_UNIQUE_INDEX);
  assert.ok(unique, `${mod.RESERVATION_UNIQUE_INDEX} must exist`);
  assert.equal(unique.unique, true, "and it must be unique, or there is no exclusion at all");
  assert.deepEqual(Object.keys(unique.key), ["deployment", "keys"]);

  const ttl = indexes.find((i) => i.name === mod.RESERVATION_TTL_INDEX);
  assert.ok(ttl, "the TTL index exists for garbage collection");
  assert.equal(ttl.expireAfterSeconds, 0);
});

test("MI3 (mandatory): 200 concurrent overlapping acquisitions against one cluster — exactly one winner", async (t) => {
  if (skip) return t.skip(skip);
  const mod = await context();
  const a = makeWorker(mod, "ra");
  const b = makeWorker(mod, "rb");
  await a.store.initialise();
  await b.store.initialise();

  for (let i = 0; i < 200; i++) {
    const keys = [`${DEPLOYMENT}:r${i}:X`, `${DEPLOYMENT}:r${i}:Y`, `${DEPLOYMENT}:r${i}:Z`];
    const ownerA = a.owner();
    const ownerB = b.owner();
    const [ra, rb] = await Promise.all([
      a.acquire(ownerA, [keys[0], keys[1]], 60_000),
      b.acquire(ownerB, [keys[1], keys[2]], 60_000),
    ]);
    const winners = [ra.ok, rb.ok].filter(Boolean).length;
    assert.equal(winners, 1, `iteration ${i}: expected exactly one winner, got ${winners}`);
    await a.store.release({ owner: ownerA, now: Date.now() });
    await b.store.release({ owner: ownerB, now: Date.now() });
  }
});

test("MI4: unrelated boxes execute concurrently against one cluster", async (t) => {
  if (skip) return t.skip(skip);
  const mod = await context();
  const a = makeWorker(mod, "ua");
  const b = makeWorker(mod, "ub");
  await a.store.initialise();
  await b.store.initialise();
  const [ra, rb] = await Promise.all([
    a.acquire(a.owner(), [`${DEPLOYMENT}:REL:2500CE`, `${DEPLOYMENT}:REL:2550CE`], 60_000),
    b.acquire(b.owner(), [`${DEPLOYMENT}:TCS:3000CE`, `${DEPLOYMENT}:TCS:3050CE`], 60_000),
  ]);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
});

test("MI5 (mandatory): a crashed worker's lease is reclaimed after its TTL, not before", async (t) => {
  if (skip) return t.skip(skip);
  const mod = await context();
  const a = makeWorker(mod, "ca");
  const b = makeWorker(mod, "cb");
  await a.store.initialise();
  await b.store.initialise();

  const X = `${DEPLOYMENT}:crash:X`;
  const Y = `${DEPLOYMENT}:crash:Y`;
  const ownerA = a.owner();
  assert.equal((await a.acquire(ownerA, [X, Y], TTL)).ok, true);

  // Worker A vanishes: no release, no renewal.
  const early = await b.acquire(b.owner(), [Y], 60_000);
  assert.equal(early.ok, false, "the lease is authoritative until it expires");

  // Logical expiry, decided from the stored timestamp — NOT from Mongo's TTL monitor,
  // which only runs about once a minute and is therefore useless as a lock primitive.
  await sleep(TTL + 100);
  const late = await b.acquire(b.owner(), [Y], 60_000);
  assert.equal(late.ok, true, "a crashed worker must not strand contracts");
  assert.equal(await b.store.ownerOf(X, Date.now()), null, "its other leg is free too");
});

test("MI6 (mandatory): a stale owner cannot release the new owner's reservation", async (t) => {
  if (skip) return t.skip(skip);
  const mod = await context();
  const a = makeWorker(mod, "sa");
  const b = makeWorker(mod, "sb");
  await a.store.initialise();
  await b.store.initialise();

  const X = `${DEPLOYMENT}:stale:X`;
  const ownerA = a.owner();
  assert.equal((await a.acquire(ownerA, [X], TTL)).ok, true);
  await sleep(TTL + 100);
  const ownerB = b.owner();
  assert.equal((await b.acquire(ownerB, [X], 60_000)).ok, true);

  assert.equal(await a.store.release({ owner: ownerA, keys: [X], now: Date.now() }), 0);
  assert.equal(await b.store.ownerOf(X, Date.now()), ownerB, "B MUST still own X");
});

test("MI7 (mandatory): renewal keeps a challenger out until the renewed expiry passes", async (t) => {
  if (skip) return t.skip(skip);
  const mod = await context();
  const a = makeWorker(mod, "na");
  const b = makeWorker(mod, "nb");
  await a.store.initialise();
  await b.store.initialise();

  const X = `${DEPLOYMENT}:renew:X`;
  const ownerA = a.owner();
  const lease = await a.acquire(ownerA, [X], TTL);
  assert.equal(lease.ok, true);

  await sleep(TTL / 2);
  const renewed = await a.store.renew({ owner: ownerA, keys: [X], ttlMs: TTL * 4, now: Date.now(), fence: lease.fence });
  assert.equal(renewed.ok, true);

  // Past the ORIGINAL expiry, inside the renewed one.
  await sleep(TTL);
  assert.equal((await b.acquire(b.owner(), [X], 60_000)).ok, false, "the renewed lease still protects it");

  await a.store.release({ owner: ownerA, now: Date.now(), fence: lease.fence });
  assert.equal((await b.acquire(b.owner(), [X], 60_000)).ok, true);
});

test("MI8: the fencing token is monotonic, and the server clock is the authority", async (t) => {
  if (skip) return t.skip(skip);
  const mod = await context();
  const port = new mod.MongoReservationPort();
  await port.ensureReady();

  const fences = [];
  for (let i = 0; i < 20; i++) fences.push(await port.nextFence(DEPLOYMENT));
  for (let i = 1; i < fences.length; i++) {
    assert.ok(fences[i] > fences[i - 1], "fencing tokens must strictly increase");
  }

  const t1 = await port.serverTimeMs();
  await sleep(50);
  const t2 = await port.serverTimeMs();
  assert.ok(t2 > t1, "the server clock advances");
  assert.ok(Math.abs(t1 - Date.now()) < 60_000, "and is in the same ballpark as this process's clock");
});

test("MI9: measured durable acquisition latency against a real cluster", async (t) => {
  if (skip) return t.skip(skip);
  const mod = await context();
  const worker = makeWorker(mod, "bench");
  await worker.store.initialise();
  const local = new mod.InProcessInstrumentReservations();
  const chain = new mod.ChainedInstrumentReservations([local, worker.store]);

  const samples = { local: [], durable: [], combined: [] };
  for (let i = 0; i < 100; i++) {
    const keys = [0, 1, 2, 3].map((n) => `${DEPLOYMENT}:bench${i}:${n}`);

    let t0 = process.hrtime.bigint();
    await local.tryAcquireAll({ owner: `l${i}`, keys, ttlMs: 5000, now: Date.now() });
    samples.local.push(Number(process.hrtime.bigint() - t0) / 1e6);
    await local.release({ owner: `l${i}`, now: Date.now() });

    const d = worker.owner();
    t0 = process.hrtime.bigint();
    await worker.store.tryAcquireAll({ owner: d, keys, ttlMs: 5000, now: Date.now() });
    samples.durable.push(Number(process.hrtime.bigint() - t0) / 1e6);
    await worker.store.release({ owner: d, now: Date.now() });

    const c = worker.owner();
    t0 = process.hrtime.bigint();
    await chain.tryAcquireAll({ owner: c, keys, ttlMs: 5000, now: Date.now() });
    samples.combined.push(Number(process.hrtime.bigint() - t0) / 1e6);
    await chain.release({ owner: c, now: Date.now() });
  }

  const pct = (arr, p) => {
    const s = [...arr].sort((x, y) => x - y);
    return Number(s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3));
  };
  const report = {};
  for (const [name, arr] of Object.entries(samples)) {
    report[name] = { p50: pct(arr, 0.5), p95: pct(arr, 0.95), p99: pct(arr, 0.99) };
  }
  // Reported, never hidden: distributed safety costs network round trips and an
  // operator is entitled to know how many milliseconds they are paying for it.
  console.log(`[mongo-reservation-latency-ms] ${JSON.stringify(report)}`);
  assert.ok(report.combined.p50 >= report.local.p50, "the durable tier is not free, and the numbers say so");
});

test("MI10: cleanup — drop the throwaway collections", async (t) => {
  if (skip) return t.skip(skip);
  await context();
  for (const name of ["box_instrument_reservations", "box_reservation_fences"]) {
    await ctx.connection.db.collection(name).deleteMany({ }).catch(() => {});
  }
  await ctx.connection.close();
});
