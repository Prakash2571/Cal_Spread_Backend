/**
 * REAL MONGODB INTEGRATION — the durable order-intent CAS, and live-entry checkpoints 3/4/5.
 *
 * WHY THIS FILE EXISTS. The unit suite proves the entry-guard ALGORITHM against an in-memory model
 * of the guarded write. A model is not proof of the production pipeline: `updateBoxOrderIntent`
 * issues a `findOneAndUpdate` with an AGGREGATION-PIPELINE `$set`, whose semantics (`$literal`
 * wrapping, the pre-image capture, `$concatArrays` audit append, and the interaction with schema
 * defaults) exist only in a real mongod. A hand-written model can agree with a wrong expectation.
 *
 * So this suite runs the SAME production code paths — `boxOrderIntentPersistence`, the real
 * `BoxOrderIntent` Mongoose model, the real `BoxOrderManager`, the real
 * `CentralBoxExecutionGateway` — against an actual MongoDB server. Only the broker is faked, and
 * deliberately so: broker credentials must never be required by CI.
 *
 * IT MUST NOT SILENTLY SKIP. With `BOX_REQUIRE_MONGODB=1` (set by the CI integration job) an
 * unreachable database is a hard FAILURE. Without it, and with no URI configured, the file skips
 * with a loud explanatory message so a developer can still run the unit suite offline.
 *
 * It writes ONLY to `box_order_intents`, scoped to trade ids prefixed `itest-`, and cleans up.
 * Do not point it at a production database.
 */

import test from "node:test";
import assert from "node:assert/strict";

const URI = (process.env.BOX_TEST_MONGODB_URI ?? "").trim();
const REQUIRED = (process.env.BOX_REQUIRE_MONGODB ?? "").trim() === "1";

if (REQUIRED && !URI) {
  throw new Error(
    "BOX_REQUIRE_MONGODB=1 but BOX_TEST_MONGODB_URI is empty: the MongoDB integration suite " +
      "refuses to pass without having actually tested MongoDB.",
  );
}

const skip = URI
  ? false
  : "set BOX_TEST_MONGODB_URI to a throwaway database (or BOX_REQUIRE_MONGODB=1 in CI) to run the real MongoDB integration suite";

/* ── bootstrap ─────────────────────────────────────────────────────────────────────────── */

let ctx = null;

/**
 * Connect once and hand back the production modules.
 *
 * Everything touching mongoose is imported LAZILY so that, with the env var unset, this file pulls
 * in nothing beyond `node:test` and stays genuinely offline.
 */
async function mongo() {
  if (ctx) return ctx;
  // db.ts reads its URIs at module load, so the env must be set before the import.
  process.env.BOX_MONGODB_URI = URI;
  const [db, repo, model] = await Promise.all([
    import("../../dist/db.js"),
    import("../../dist/box/repository.js"),
    import("../../dist/box/model.js"),
  ]);
  try {
    await db.initBoxConnection();
  } catch (error) {
    throw new Error(`could not connect to ${URI}: ${error?.message ?? error}`);
  }
  const connection = db.boxConnection;
  if (!connection || connection.readyState !== 1) {
    throw new Error(`could not connect to ${URI} (readyState ${connection?.readyState})`);
  }
  const serverInfo = await connection.db.admin().serverInfo();
  console.log(`# real MongoDB integration: mongod ${serverInfo.version}`);
  ctx = { db, repo, model, connection, mongodVersion: serverInfo.version };
  return ctx;
}

/**
 * Remove only this suite's rows: the `itest-` trade ids written directly, plus the trade id the
 * shared live-entry harness allocates when it drives the real gateway.
 */
async function clean(model) {
  await model.BoxOrderIntent.deleteMany({
    $or: [{ trade_id: { $regex: "^itest-" } }, { trade_id: "trade-live-1" }],
  });
}

const audit = (id, from, to, reason, payload) => ({
  audit_id: id,
  at: new Date(),
  from_state: from,
  to_state: to,
  reason,
  ...(payload ? { payload } : {}),
});

let seq = 0;
function intentDoc(overrides = {}) {
  const trade = overrides.trade_id ?? `itest-${Date.now().toString(36)}-${seq++}`;
  const role = overrides.role ?? "k1_ce";
  return {
    client_order_id: overrides.client_order_id ?? `BOX:${trade}:ENTRY:${role}:attempt-1`,
    broker_order_id: null,
    broker_mode: "live",
    trade_id: trade,
    attempt_id: overrides.attempt_id ?? "attempt-1",
    role,
    purpose: overrides.purpose ?? "ENTRY",
    phase: overrides.phase ?? "entry",
    exchange: "NFO",
    tradingsymbol: overrides.tradingsymbol ?? `SYM-${role}`,
    token: overrides.token ?? 1001,
    side: overrides.side ?? "BUY",
    quantity: overrides.quantity ?? 75,
    reference_price: 100,
    tick_size: 0.05,
    max_chase_ticks: 2,
    limit_price: 100.1,
    state: overrides.state ?? "CREATED",
    filled_quantity: overrides.filled_quantity ?? 0,
    average_price: null,
    broker_tag: null,
    reject_family: null,
    reject_reason: null,
    created_at: new Date(),
    updated_at: new Date(),
    terminal_at: null,
    audit: [],
    ...overrides,
  };
}

/* ══════════════════ 1. expected-state CAS semantics ══════════════════ */

test("real Mongo: a correct expected-state CAS applies exactly once under concurrency", async (t) => {
  if (skip) return t.skip(skip);
  const { repo, model } = await mongo();
  await clean(model);

  const doc = intentDoc();
  await repo.createBoxOrderIntent(doc);

  // Two processes race the SAME CREATED -> SUBMITTING transition. This is precisely the ownership
  // CAS behind live-entry checkpoint 4: only the winner may POST.
  const [a, b] = await Promise.all([
    repo.updateBoxOrderIntent(
      doc.client_order_id,
      { state: "SUBMITTING" },
      audit("cas-a", "CREATED", "SUBMITTING", "owner A"),
      ["CREATED"],
    ),
    repo.updateBoxOrderIntent(
      doc.client_order_id,
      { state: "SUBMITTING" },
      audit("cas-b", "CREATED", "SUBMITTING", "owner B"),
      ["CREATED"],
    ),
  ]);

  const applied = [a, b].filter((result) => result.applied);
  assert.equal(applied.length, 1, "exactly one owner may win the durable identity");
  const stored = await model.BoxOrderIntent.findOne({ client_order_id: doc.client_order_id }).lean();
  assert.equal(stored.state, "SUBMITTING");
  // Exactly one audit entry was appended — the loser wrote nothing at all.
  assert.equal(stored.audit.length, 1);
  await clean(model);
});

test("real Mongo: a CAS with a stale expected state is refused and writes nothing", async (t) => {
  if (skip) return t.skip(skip);
  const { repo, model } = await mongo();
  await clean(model);

  const doc = intentDoc({ state: "SUBMITTING" });
  await repo.createBoxOrderIntent(doc);

  const result = await repo.updateBoxOrderIntent(
    doc.client_order_id,
    { state: "REJECTED" },
    audit("stale-1", "CREATED", "REJECTED", "stale owner still believes CREATED"),
    ["CREATED"], // stale: the row is already SUBMITTING
  );

  assert.equal(result.applied, false);
  // A refusal reports an explicit ZERO-WIDTH transition, never a null the caller could mistake for
  // "unknown, guess from my own snapshot".
  assert.equal(result.previous_filled_quantity, result.current_filled_quantity);
  const stored = await model.BoxOrderIntent.findOne({ client_order_id: doc.client_order_id }).lean();
  assert.equal(stored.state, "SUBMITTING", "the document must be untouched");
  assert.deepEqual(stored.audit, [], "a refused CAS appends no audit entry");
  await clean(model);
});

test("real Mongo: the pre-image is captured by the same atomic write", async (t) => {
  if (skip) return t.skip(skip);
  const { repo, model } = await mongo();
  await clean(model);

  const doc = intentDoc({ state: "WORKING", filled_quantity: 25 });
  await repo.createBoxOrderIntent(doc);

  // The aggregation `$set` evaluates every expression against the INPUT document, so
  // `previous_filled_quantity` must report 25 even though `filled_quantity` is being set to 60 in
  // the same stage. This is the property that makes the reported delta a fact about the durable
  // transition rather than about the caller's memory — and it only exists in a real pipeline.
  const result = await repo.updateBoxOrderIntent(
    doc.client_order_id,
    { filled_quantity: 60 },
    audit("preimage-1", "WORKING", "WORKING", "cumulative fill advanced"),
  );

  assert.equal(result.applied, true);
  assert.equal(result.previous_filled_quantity, 25);
  assert.equal(result.current_filled_quantity, 60);
  await clean(model);
});

test("real Mongo: concurrent cumulative-fill writes report deltas that sum exactly once", async (t) => {
  if (skip) return t.skip(skip);
  const { repo, model } = await mongo();
  await clean(model);

  const doc = intentDoc({ state: "WORKING", filled_quantity: 0 });
  await repo.createBoxOrderIntent(doc);

  // Two observers apply cumulative snapshots 40 and 75 in an arbitrary order. The monotonic
  // `$lte` guard means a regressing snapshot is refused, and the applied deltas must sum to 75
  // exactly — never double-count, never lose a fill.
  const [a, b] = await Promise.all([
    repo.updateBoxOrderIntent(doc.client_order_id, { filled_quantity: 40 }, audit("f-40", "WORKING", "WORKING", "poll 40")),
    repo.updateBoxOrderIntent(doc.client_order_id, { filled_quantity: 75 }, audit("f-75", "WORKING", "WORKING", "poll 75")),
  ]);

  const deltas = [a, b]
    .filter((result) => result.applied)
    .map((result) => result.current_filled_quantity - result.previous_filled_quantity);
  assert.equal(deltas.reduce((sum, d) => sum + d, 0), 75, `deltas ${JSON.stringify(deltas)} must sum to 75`);
  const stored = await model.BoxOrderIntent.findOne({ client_order_id: doc.client_order_id }).lean();
  assert.equal(stored.filled_quantity, 75, "cumulative quantity is monotonic");
  await clean(model);
});

test("real Mongo: a regressing cumulative quantity is refused", async (t) => {
  if (skip) return t.skip(skip);
  const { repo, model } = await mongo();
  await clean(model);

  const doc = intentDoc({ state: "WORKING", filled_quantity: 75 });
  await repo.createBoxOrderIntent(doc);

  const result = await repo.updateBoxOrderIntent(
    doc.client_order_id,
    { filled_quantity: 40 },
    audit("regress-1", "WORKING", "WORKING", "out-of-order poll"),
  );

  assert.equal(result.applied, false);
  const stored = await model.BoxOrderIntent.findOne({ client_order_id: doc.client_order_id }).lean();
  assert.equal(stored.filled_quantity, 75);
  await clean(model);
});

/* ══════════════════ 2. broker-identity fencing ══════════════════ */

test("real Mongo: a conflicting broker order id fences the transition out", async (t) => {
  if (skip) return t.skip(skip);
  const { repo, model } = await mongo();
  await clean(model);

  const doc = intentDoc({ state: "SUBMITTING" });
  await repo.createBoxOrderIntent(doc);

  // First writer binds the durable identity to broker order B-1.
  const bound = await repo.updateBoxOrderIntent(
    doc.client_order_id,
    { state: "WORKING", broker_order_id: "B-1" },
    audit("fence-1", "SUBMITTING", "WORKING", "acknowledged as B-1"),
  );
  assert.equal(bound.applied, true);

  // A second writer claiming a DIFFERENT broker order id for the same durable identity must be
  // refused. Accepting it would silently re-point our record at someone else's live order.
  const conflicting = await repo.updateBoxOrderIntent(
    doc.client_order_id,
    { state: "COMPLETE", broker_order_id: "B-2", filled_quantity: 75 },
    audit("fence-2", "WORKING", "COMPLETE", "stale writer claims B-2"),
  );
  assert.equal(conflicting.applied, false, "a broker-identity mismatch must reject the transition");

  const stored = await model.BoxOrderIntent.findOne({ client_order_id: doc.client_order_id }).lean();
  assert.equal(stored.broker_order_id, "B-1");
  assert.equal(stored.state, "WORKING");
  assert.equal(stored.filled_quantity, 0, "the refused write must not have leaked a fill");

  // The SAME broker id remains free to advance — fencing rejects impostors, not the real owner.
  const same = await repo.updateBoxOrderIntent(
    doc.client_order_id,
    { state: "COMPLETE", broker_order_id: "B-1", filled_quantity: 75 },
    audit("fence-3", "WORKING", "COMPLETE", "B-1 completed"),
  );
  assert.equal(same.applied, true);
  await clean(model);
});

/* ══════════════════ 3. idempotent duplicate retry ══════════════════ */

test("real Mongo: replaying an identical audited transition stays idempotent", async (t) => {
  if (skip) return t.skip(skip);
  const { repo, model } = await mongo();
  await clean(model);

  const doc = intentDoc({ state: "WORKING", filled_quantity: 75 });
  await repo.createBoxOrderIntent(doc);

  const entry = audit("dup-1", "WORKING", "COMPLETE", "terminal snapshot");
  const first = await repo.updateBoxOrderIntent(doc.client_order_id, { state: "COMPLETE", filled_quantity: 75 }, entry);
  // A retry after a network wobble replays the same audit id. The `$concatArrays` guard must append
  // it exactly once, and the cumulative quantity must not advance a second time.
  const retry = await repo.updateBoxOrderIntent(doc.client_order_id, { state: "COMPLETE", filled_quantity: 75 }, entry);

  assert.equal(first.applied, true);
  const stored = await model.BoxOrderIntent.findOne({ client_order_id: doc.client_order_id }).lean();
  assert.equal(stored.audit.filter((event) => event.audit_id === "dup-1").length, 1, "one audit entry only");
  assert.equal(stored.filled_quantity, 75);
  // The retry reports a zero-width delta, so a caller adding deltas cannot double-count.
  if (retry.applied) {
    assert.equal(retry.current_filled_quantity - retry.previous_filled_quantity, 0);
  }
  await clean(model);
});

test("real Mongo: creating the same client order id twice is idempotent, and immutable fields are enforced", async (t) => {
  if (skip) return t.skip(skip);
  const { repo, model } = await mongo();
  await clean(model);

  const doc = intentDoc();
  const first = await repo.createBoxOrderIntent(doc);
  const again = await repo.createBoxOrderIntent(doc);
  assert.equal(first.client_order_id, again.client_order_id);
  assert.equal(await model.BoxOrderIntent.countDocuments({ client_order_id: doc.client_order_id }), 1);

  // Reusing a deterministic identity with a different quantity is a programming error that must be
  // refused rather than silently rewriting a live order's terms.
  await assert.rejects(
    () => repo.createBoxOrderIntent({ ...doc, quantity: 74 }),
    /immutable/i,
  );
  await clean(model);
});

/* ══════════════════ 4. default fields / no update-pipeline conflict ══════════════════ */

test("real Mongo: broker fields and schema defaults update without an aggregation-pipeline conflict", async (t) => {
  if (skip) return t.skip(skip);
  const { repo, model } = await mongo();
  await clean(model);

  // `updateBoxOrderIntent` uses an AGGREGATION pipeline, in which `$inc`/`$setOnInsert` are not
  // operators at all — mixing them in would throw. This exercises a patch that touches broker
  // identity, a nullable field, a numeric field and an enum-backed field in ONE write, which is
  // where such a conflict would surface.
  for (const brokerMode of ["live", "paper"]) {
    const doc = intentDoc({ broker_mode: brokerMode, state: "SUBMITTING" });
    await repo.createBoxOrderIntent(doc);
    const result = await repo.updateBoxOrderIntent(
      doc.client_order_id,
      {
        state: "REJECTED",
        broker_order_id: null,
        reject_family: "risk",
        reject_reason: "insufficient margin",
        terminal_at: new Date(),
      },
      audit("defaults-1", "SUBMITTING", "REJECTED", "broker rejected", {
        origin: "local_pre_submit_refusal",
        no_broker_post: true,
        stage: "pre_post",
        reason: "entry is no longer wanted",
      }),
    );
    assert.equal(result.applied, true, `${brokerMode}: patch applied`);
    const stored = await model.BoxOrderIntent.findOne({ client_order_id: doc.client_order_id }).lean();
    assert.equal(stored.state, "REJECTED");
    assert.equal(stored.broker_mode, brokerMode, "broker mode survives the write");
    assert.equal(stored.reject_reason, "insufficient margin");
    // The structured payload must survive verbatim: `$literal` is what stops Mongo from trying to
    // interpret `$`-prefixed payload content as a field path.
    assert.equal(stored.audit[0].payload.no_broker_post, true);
    assert.equal(stored.audit[0].payload.stage, "pre_post");
  }
  await clean(model);
});

/* ══════════════════ 5. live-entry checkpoints 3/4/5 through real Mongo ══════════════════ */

/**
 * The production persistence contract, wired into the real gateway + order manager.
 * Only the broker is faked.
 */
async function realStack(options = {}) {
  const { repo } = await mongo();
  const { liveStack } = await import("../box/liveEntryHarness.mjs");
  return liveStack({ ...options, persistence: repo.boxOrderIntentPersistence });
}

test("real Mongo: checkpoint 5 refuses in pacing, terminalizing durably with no POST", async (t) => {
  if (skip) return t.skip(skip);
  const { model } = await mongo();
  await clean(model);
  const { runEntry, entryPosts } = await import("../box/liveEntryHarness.mjs");

  let allowed = true;
  const stack = await realStack({
    adapterOptions: { duringPacing: async () => { allowed = false; } },
  });
  const result = await runEntry(stack, { stillWanted: () => allowed });

  assert.equal(result.ok, false);
  assert.deepEqual(entryPosts(stack.adapter), [], "ownership loss in pacing must produce zero POSTs");

  // Now assert it against REAL MongoDB rows, through the real aggregation-pipeline write.
  const rows = await model.BoxOrderIntent.find({ purpose: "ENTRY" }).lean();
  assert.equal(rows.length, 4, "all four legs are durable");
  for (const row of rows) {
    assert.equal(row.state, "REJECTED");
    assert.equal(row.filled_quantity, 0);
    assert.equal(row.broker_order_id, null, "no broker identity was ever obtained");
    const provenance = row.audit.find((event) => event.payload?.origin === "local_pre_submit_refusal");
    assert.ok(provenance, `${row.role} carries durable local-no-POST provenance`);
    assert.equal(provenance.payload.no_broker_post, true);
    assert.ok(["dequeue", "post_persist", "pre_post"].includes(provenance.payload.stage));
  }
  // And the shared helper agrees when reading a row that came back out of MongoDB.
  const { hasDurableLocalNoPostProvenance } = await import("../../dist/box/executionGateway.js");
  for (const row of rows) {
    assert.equal(
      hasDurableLocalNoPostProvenance({ ...row, updated_at: new Date(row.updated_at) }),
      true,
      `${row.role} provenance survives a MongoDB round trip`,
    );
  }
  await clean(model);
});

test("real Mongo: checkpoint 4 refuses after the durable SUBMITTING write, with no POST", async (t) => {
  if (skip) return t.skip(skip);
  const { model, repo } = await mongo();
  await clean(model);
  const { runEntry, entryPosts } = await import("../box/liveEntryHarness.mjs");

  // Ownership is lost the moment the first durable row lands, so the post-persistence checkpoint is
  // the one that must catch it — after real Mongo writes, before any transport. The wrapper adds
  // only an observation; every write still goes through the production contract.
  let allowed = true;
  const persistence = {
    ...repo.boxOrderIntentPersistence,
    create: async (intent) => {
      const created = await repo.boxOrderIntentPersistence.create(intent);
      allowed = false;
      return created;
    },
  };
  const { liveStack } = await import("../box/liveEntryHarness.mjs");
  const stack = await liveStack({ persistence });
  const result = await runEntry(stack, { stillWanted: () => allowed });

  assert.equal(result.ok, false);
  assert.deepEqual(entryPosts(stack.adapter), []);
  const rows = await model.BoxOrderIntent.find({ purpose: "ENTRY" }).lean();
  assert.ok(rows.length > 0, "durable rows exist in real MongoDB");
  for (const row of rows) {
    assert.equal(row.state, "REJECTED");
    assert.equal(row.filled_quantity, 0);
  }
  await clean(model);
});

test("real Mongo: a full four-leg entry persists every leg and every fill", async (t) => {
  if (skip) return t.skip(skip);
  const { model } = await mongo();
  await clean(model);
  const { runEntry, entryPosts } = await import("../box/liveEntryHarness.mjs");

  const stack = await realStack({ direction: "SHORT_BOX" });
  const result = await runEntry(stack);

  assert.equal(result.ok, true, `entry should open: ${result.detail ?? ""}`);
  // Hedge-first ordering still holds when persistence is real MongoDB rather than a model.
  assert.deepEqual(entryPosts(stack.adapter).map((post) => post.side), ["BUY", "BUY", "SELL", "SELL"]);

  const rows = await model.BoxOrderIntent.find({ purpose: "ENTRY" }).lean();
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.state, "COMPLETE", `${row.role} reached COMPLETE in MongoDB`);
    assert.equal(row.filled_quantity, 75);
    assert.ok(row.broker_order_id, `${row.role} recorded its broker identity`);
  }
  await clean(model);
});

/* ══════════════════ 6. restart / durable reload ══════════════════ */

test("real Mongo: a restarted process reloads durable state and adopts, without a duplicate POST", async (t) => {
  if (skip) return t.skip(skip);
  const { model, repo } = await mongo();
  await clean(model);

  // Leave a WORKING leg behind, exactly as an abrupt restart would.
  const doc = intentDoc({ state: "WORKING", filled_quantity: 25, broker_order_id: "B-restart-1" });
  await repo.createBoxOrderIntent(doc);
  await repo.updateBoxOrderIntent(
    doc.client_order_id,
    { state: "WORKING", broker_order_id: "B-restart-1", filled_quantity: 25 },
    audit("restart-seed", "SUBMITTING", "WORKING", "working before restart"),
  );

  // A fresh process loads the durable journal.
  const nonterminal = await repo.loadNonterminalBoxOrderIntents();
  const mine = nonterminal.filter((intent) => intent.trade_id.startsWith("itest-"));
  assert.equal(mine.length, 1, "the working leg is rediscovered after restart");
  assert.equal(mine[0].broker_order_id, "B-restart-1", "the broker identity survived");
  assert.equal(mine[0].filled_quantity, 25, "the confirmed partial fill survived");

  // It can also be found by broker identity, which is how reconciliation attributes an order it
  // sees at the broker back to a durable intent.
  const byBroker = await repo.findBoxOrderIntentByBrokerId("B-restart-1");
  assert.equal(byBroker?.client_order_id, doc.client_order_id);

  // Continuing safely means advancing the EXISTING identity, never creating a second one.
  const advanced = await repo.updateBoxOrderIntent(
    doc.client_order_id,
    { state: "COMPLETE", broker_order_id: "B-restart-1", filled_quantity: 75 },
    audit("restart-finish", "WORKING", "COMPLETE", "reconciled to terminal after restart"),
  );
  assert.equal(advanced.applied, true);
  assert.equal(advanced.previous_filled_quantity, 25);
  assert.equal(advanced.current_filled_quantity, 75);
  assert.equal(await model.BoxOrderIntent.countDocuments({ client_order_id: doc.client_order_id }), 1);
  await clean(model);
});

test("real Mongo: terminal rows leave the nonterminal working set", async (t) => {
  if (skip) return t.skip(skip);
  const { model, repo } = await mongo();
  await clean(model);

  const doc = intentDoc({ state: "WORKING" });
  await repo.createBoxOrderIntent(doc);
  await repo.updateBoxOrderIntent(
    doc.client_order_id,
    { state: "CANCELLED", terminal_at: new Date() },
    audit("terminal-1", "WORKING", "CANCELLED", "cancellation confirmed terminal"),
  );

  const nonterminal = await repo.loadNonterminalBoxOrderIntents();
  assert.equal(
    nonterminal.filter((intent) => intent.client_order_id === doc.client_order_id).length,
    0,
    "a confirmed-terminal row is no longer outstanding work",
  );
  // But it is still OWNED, so reconciliation can still attribute a broker order to it.
  const owned = await repo.loadOwnedBoxOrderIntents();
  assert.equal(owned.filter((intent) => intent.client_order_id === doc.client_order_id).length, 1);
  await clean(model);
});

/* ── teardown ──────────────────────────────────────────────────────────────────────────── */

test("real Mongo: teardown", async (t) => {
  if (skip) return t.skip(skip);
  const { model, connection } = await mongo();
  await clean(model);
  // Release the socket so the test process can exit promptly rather than being held open by a
  // pooled connection.
  await connection.close().catch(() => {});
  const mongoose = (await import("mongoose")).default;
  await mongoose.disconnect().catch(() => {});
});
