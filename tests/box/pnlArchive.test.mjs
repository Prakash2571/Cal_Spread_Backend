import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBoxPnlDayProof,
  buildDaySnapshot,
  boxPnlDayProofsEqual,
  missingRowIds,
  summarizeDayRows,
  SUMMARY_FIELD,
} from "../../dist/box/pnlSnapshot.js";
import {
  BoxPnlArchiver,
  istDayStartMs,
  snapshotToDocs,
} from "../../dist/box/pnlArchive.js";
import {
  buildTradeEvictionPlan,
  indexedTradeDays,
  partitionDayIndex,
  shouldPruneDayIndex,
} from "../../dist/box/pnlCache.js";
import {
  boxPnlDayProofFromState,
  isArchivedPnlRowInvalid,
  runBoxPnlDayMutation,
  runBoxPnlDayProofCommit,
  runBoxPnlDayProofRepair,
  runIndependentBoxPnlRepairs,
  runLegacyBoxPnlDayMigration,
  runSourceSafePnlRowUpsert,
  shouldReproveBoxPnlDay,
} from "../../dist/box/repository.js";

const NOW_ISO = "2026-08-31T15:00:00.000Z";

function openPos(id, net, gross, real) {
  return {
    id,
    underlying: "NIFTY",
    direction: "LONG_BOX",
    lower_strike: 19900,
    upper_strike: 20100,
    expiry: "2026-09-24",
    opened_at: "2026-08-31T04:00:00.000Z",
    gross_pnl: gross,
    net_pnl: net,
    realisable_net_pnl: real,
  };
}

function closedTrade(id, net, gross, realised) {
  return {
    id,
    underlying: "NIFTY",
    direction: "LONG_BOX",
    lower_strike: 19900,
    upper_strike: 20100,
    expiry: "2026-09-24",
    opened_at: "2026-08-31T04:00:00.000Z",
    closed_at: "2026-08-31T09:00:00.000Z",
    gross_pnl: gross,
    net_pnl: net,
    realised_net_pnl: realised,
  };
}

function cfg(overrides = {}) {
  return {
    pnlCacheEnabled: true,
    pnlCacheIntervalMs: 30_000,
    pnlCacheTtlSec: 1000,
    pnlArchiveHour: 21,
    pnlVerifyHours: [22, 23],
    pnlArchiveDrainDelayMs: 0,
    ...overrides,
  };
}

function mockCache(day, rows, summary) {
  const marks = [];
  return {
    calls: { marks },
    enabled: () => true,
    readDay: async (candidate) => candidate === day
      ? { rows, summary, present: true }
      : { rows: [], summary: null, present: false },
    markArchived: async (candidate, count, iso) => marks.push({ day: candidate, count, iso }),
    pendingDays: async () => [],
    writeSnapshot: async () => true,
  };
}

function makeArchiver({
  cacheImpl,
  upsert = async () => {},
  filterExistingTradeIds,
  loadPersistedDay,
  isPersistedDayComplete,
  markPersistedDayIncomplete,
  markPersistedDayComplete,
  deletePersistedRows,
  reconcileDurableOrphans,
  setReconcileTimeout,
  clearReconcileTimeout,
  reconcileNowMs,
  cfgOverrides,
  getOpenPnl,
  loadClosedSince,
  currentDay = "2026-08-31",
  currentIst = new Date("2026-08-31T21:00:00.000Z"),
}) {
  return new BoxPnlArchiver({
    cfg: cfg(cfgOverrides),
    cache: cacheImpl,
    getOpenPnl: getOpenPnl ?? (() => []),
    loadClosedSince: loadClosedSince ?? (async () => []),
    upsert,
    filterExistingTradeIds: filterExistingTradeIds ?? (async (ids) => ids),
    loadPersistedDay: loadPersistedDay ?? (async () => []),
    isPersistedDayComplete: isPersistedDayComplete ?? (async () => true),
    markPersistedDayIncomplete: markPersistedDayIncomplete ?? (async () => {}),
    markPersistedDayComplete: markPersistedDayComplete ?? (async () => {}),
    deletePersistedRows: deletePersistedRows ?? (async () => 0),
    reconcileDurableOrphans: reconcileDurableOrphans ?? (async () => 0),
    istDayKey: () => currentDay,
    istNow: () => currentIst,
    isDbEnabled: () => true,
    setReconcileTimeout,
    clearReconcileTimeout,
    reconcileNowMs,
  });
}

function replaceDoc(durable, doc) {
  const index = durable.findIndex((row) => row.day === doc.day && row.trade_id === doc.trade_id);
  if (index >= 0) durable[index] = structuredClone(doc);
  else durable.push(structuredClone(doc));
}

/* ----------------------------- pure shaping ------------------------------ */

test("buildDaySnapshot sums open running net and closed realised net", () => {
  const snap = buildDaySnapshot({
    day: "2026-08-31",
    open: [openPos("o1", 100, 150, 80), openPos("o2", 200, 260, 170)],
    closed: [closedTrade("c1", 500, 640, 500)],
    nowIso: NOW_ISO,
  });
  assert.equal(snap.rows.length, 3);
  assert.equal(snap.summary.open_count, 2);
  assert.equal(snap.summary.closed_count, 1);
  assert.equal(snap.summary.open_running_net_pnl, 300);
  assert.equal(snap.summary.closed_realised_net_pnl, 500);
  assert.equal(snap.summary.total_net_pnl, 800);
  assert.equal(snap.summary.total_gross_pnl, 1050);
});

test("closed null realised P&L falls back to net and null values never produce NaN", () => {
  const closed = buildDaySnapshot({
    day: "2026-08-31",
    open: [],
    closed: [closedTrade("c1", 400, 500, null)],
    nowIso: NOW_ISO,
  });
  assert.equal(closed.rows[0].realised_net_pnl, 400);
  assert.equal(closed.summary.closed_realised_net_pnl, 400);

  const open = buildDaySnapshot({
    day: "2026-08-31",
    open: [openPos("o1", null, null, null)],
    closed: [],
    nowIso: NOW_ISO,
  });
  assert.equal(open.summary.total_net_pnl, 0);
  assert.equal(open.summary.total_gross_pnl, 0);
});

test("snapshotToDocs writes the summary last and missingRowIds is a set difference", () => {
  const snap = buildDaySnapshot({
    day: "2026-08-31",
    open: [openPos("o1", 100, 150, 80)],
    closed: [closedTrade("c1", 500, 640, 500)],
    nowIso: NOW_ISO,
  });
  const docs = snapshotToDocs(snap.day, snap.rows, snap.summary);
  assert.equal(docs.at(-1).trade_id, SUMMARY_FIELD);
  assert.equal(docs.at(-1).summary.total_net_pnl, 600);
  assert.deepEqual(missingRowIds(["a", "b", "c"], ["b"]), ["a", "c"]);
});

test("istDayStartMs returns exact IST midnight", () => {
  assert.equal(
    istDayStartMs("2026-08-31"),
    Date.parse("2026-08-31T00:00:00.000+05:30"),
  );
});

test("summarizeDayRows aggregates survivors only", () => {
  const snap = buildDaySnapshot({
    day: "2026-08-31",
    open: [openPos("open", 125.25, 150.5, 100)],
    closed: [closedTrade("closed", 300, 340, 275.5)],
    nowIso: NOW_ISO,
  });
  const summary = summarizeDayRows({ day: snap.day, rows: snap.rows, nowIso: NOW_ISO });
  assert.equal(summary.total_net_pnl, 400.75);
  assert.equal(summary.total_gross_pnl, 490.5);
});

test("day completion proof is content-aware and fixed-size", () => {
  const day = "2026-08-31";
  const one = buildDaySnapshot({
    day, open: [openPos("same-id", 100, 150, 80)], closed: [], nowIso: NOW_ISO,
  });
  const changed = buildDaySnapshot({
    day, open: [openPos("same-id", 101, 150, 80)], closed: [], nowIso: NOW_ISO,
  });
  const many = buildDaySnapshot({
    day,
    open: Array.from({ length: 2_000 }, (_, index) => openPos(`trade-${index}`, index, index, index)),
    closed: [],
    nowIso: NOW_ISO,
  });
  const first = buildBoxPnlDayProof(snapshotToDocs(day, one.rows, one.summary));
  const second = buildBoxPnlDayProof(snapshotToDocs(day, changed.rows, changed.summary));
  const large = buildBoxPnlDayProof(snapshotToDocs(day, many.rows, many.summary));
  assert.equal(boxPnlDayProofsEqual(first, second), false, "same id with changed P&L must differ");
  assert.deepEqual(Object.keys(first).sort(), ["content_sha256", "row_count", "snapshot_version"]);
  assert.equal(first.content_sha256.length, 64);
  assert.equal(large.content_sha256.length, 64);
  assert.equal(JSON.stringify(first).length, JSON.stringify({ ...large, row_count: 1 }).length);
  assert.equal(boxPnlDayProofFromState({ complete: true, expected_trade_ids: ["legacy"] }), null);
  assert.deepEqual(boxPnlDayProofFromState(first), first);
});

test("legacy complete manifest migrates an expired-Redis day through a source-valid v2 proof", async () => {
  const day = "2026-08-30";
  const valid = snapshotToDocs(
    day,
    buildDaySnapshot({
      day, open: [openPos("valid", 125, 150, 100)], closed: [], nowIso: NOW_ISO,
    }).rows,
    null,
  )[0];
  const stale = { ...valid, trade_id: "deleted-stale", net_pnl: 999, gross_pnl: 999 };
  let durable = [valid, stale, {
    day,
    trade_id: SUMMARY_FIELD,
    status: "summary",
    summary: { total_net_pnl: 1124, total_gross_pnl: 1149 },
  }];
  const legacyState = {
    complete: true,
    expected_trade_ids: ["valid", "deleted-stale"],
  };
  let publishedState = null;
  let finalized = false;

  const migrate = () => runLegacyBoxPnlDayMigration({
    expectedTradeIds: legacyState.expected_trade_ids,
    filterSourceValidExpectedIds: async () => ["valid"],
    settleAndLoad: async () => {
      durable = durable.filter((doc) => doc.trade_id !== "deleted-stale");
      const summary = summarizeDayRows({ day, rows: [valid], nowIso: NOW_ISO });
      replaceDoc(durable, { day, trade_id: SUMMARY_FIELD, status: "summary", summary });
      return structuredClone(durable);
    },
    publishV2: async (docs) => {
      publishedState = buildBoxPnlDayProof(docs);
    },
    loadPublished: async () => ({
      docs: structuredClone(durable),
      state: publishedState,
    }),
    finalizeV2: async () => {
      finalized = true;
      delete legacyState.expected_trade_ids;
    },
    markRetry: async () => {},
  });

  const archiver = makeArchiver({
    cacheImpl: mockCache("expired", [], null),
    currentDay: "2026-09-01",
    loadPersistedDay: async () => structuredClone(durable),
    isPersistedDayComplete: async (_day, docs) => legacyState.expected_trade_ids
      ? migrate()
      : boxPnlDayProofsEqual(publishedState, buildBoxPnlDayProof(docs)),
    filterExistingTradeIds: async (ids) => ids.filter((id) => id === "valid"),
  });
  const result = await archiver.verifyDay(day);
  assert.equal(result.ok, true);
  assert.equal(durable.some((doc) => doc.trade_id === "deleted-stale"), false);
  assert.equal(durable.find((doc) => doc.trade_id === SUMMARY_FIELD).summary.total_net_pnl, 125);
  assert.deepEqual(Object.keys(publishedState).sort(), [
    "content_sha256", "row_count", "snapshot_version",
  ]);
  assert.equal(finalized, true);
  assert.equal("expected_trade_ids" in legacyState, false);
});

test("legacy migration fails closed and keeps retry evidence when a source-valid row is missing", async () => {
  let markedRetry = 0;
  let published = 0;
  const migrated = await runLegacyBoxPnlDayMigration({
    expectedTradeIds: ["present", "missing"],
    filterSourceValidExpectedIds: async (ids) => ids,
    settleAndLoad: async () => [{ day: "2026-08-30", trade_id: "present", status: "open" }],
    publishV2: async () => { published++; },
    loadPublished: async () => ({ docs: [], state: null }),
    finalizeV2: async () => assert.fail("an incomplete legacy day must not finalize"),
    markRetry: async () => { markedRetry++; },
  });
  assert.equal(migrated, false);
  assert.equal(published, 0);
  assert.equal(markedRetry, 1);
});

/* ------------------------- basic archive/verify -------------------------- */

test("archive streams rows then summary and stops cleanly on an upsert error", async () => {
  const day = "2026-08-31";
  const snap = buildDaySnapshot({
    day,
    open: [openPos("o1", 100, 150, 80), openPos("o2", 200, 260, 170)],
    closed: [],
    nowIso: NOW_ISO,
  });
  const cacheImpl = mockCache(day, snap.rows, snap.summary);
  const written = [];
  const success = makeArchiver({
    cacheImpl,
    upsert: async (doc) => written.push(doc.trade_id),
  });
  const result = await success.archiveDay(day);
  assert.deepEqual(written, ["o1", "o2", SUMMARY_FIELD]);
  assert.equal(result.ok, true);
  assert.equal(cacheImpl.calls.marks.length, 1);

  let calls = 0;
  const failingCache = mockCache(day, snap.rows, snap.summary);
  const failing = makeArchiver({
    cacheImpl: failingCache,
    upsert: async () => {
      calls++;
      if (calls === 2) throw new Error("mongo blip");
    },
  });
  const failed = await failing.archiveDay(day);
  assert.equal(failed.ok, false);
  assert.equal(failed.written, 1);
  assert.equal(failingCache.calls.marks.length, 0);
});

test("verify removes extra persisted rows and rewrites summary content even when its id exists", async () => {
  const day = "2026-08-31";
  const snap = buildDaySnapshot({
    day,
    open: [openPos("survivor", 200, 260, 170)],
    closed: [],
    nowIso: NOW_ISO,
  });
  const durable = [
    { ...snapshotToDocs(day, snap.rows, snap.summary)[0], net_pnl: 50, gross_pnl: 60 },
    { day, trade_id: "orphan", status: "open", net_pnl: 999 },
    {
      day,
      trade_id: SUMMARY_FIELD,
      status: "summary",
      summary: { ...snap.summary, open_count: 99, total_net_pnl: 999 },
    },
  ];
  const deleted = [];
  const written = [];
  const archiver = makeArchiver({
    cacheImpl: mockCache(day, snap.rows, snap.summary),
    loadPersistedDay: async () => durable,
    deletePersistedRows: async (_day, ids) => {
      deleted.push(...ids);
      for (let i = durable.length - 1; i >= 0; i--) {
        if (ids.includes(durable[i].trade_id)) durable.splice(i, 1);
      }
      return ids.length;
    },
    upsert: async (doc) => {
      written.push(doc);
      replaceDoc(durable, doc);
    },
  });

  const result = await archiver.verifyDay(day);
  assert.deepEqual(deleted, ["orphan"]);
  assert.equal(result.missing, 1);
  assert.deepEqual(written.map((doc) => doc.trade_id), ["survivor", SUMMARY_FIELD]);
  assert.equal(written[1].summary.open_count, 1);
  assert.equal(written[1].summary.total_net_pnl, 200);
  assert.equal(durable.find((doc) => doc.trade_id === "survivor").net_pnl, 200);
});

/* --------------------------- Redis day safety ---------------------------- */

test("Redis eviction discovers membership and ignores unrelated current D3", () => {
  const tradeId = "deleted-on-d3";
  const indexed = [
    { day: "2026-08-30" },
    { day: "2026-08-31" },
    { day: "2026-09-01" },
  ];
  const cached = new Map([
    ["2026-08-30", { rows: [{ trade_id: tradeId }] }],
    ["2026-08-31", { rows: [{ trade_id: tradeId }] }],
    ["2026-09-01", { rows: [{ trade_id: "unrelated-current" }] }],
  ]);
  const members = indexedTradeDays(indexed, cached, tradeId);
  assert.deepEqual(members, [{ day: "2026-08-30" }, { day: "2026-08-31" }]);

  const plan = buildTradeEvictionPlan(members, tradeId, 900);
  assert.deepEqual(plan.days, ["2026-08-30", "2026-08-31"]);
  assert.deepEqual(plan.commands.filter((command) => command[0] === "HDEL"), [
    ["HDEL", "calspread:box:pnl:day:2026-08-30", tradeId, SUMMARY_FIELD],
    ["HDEL", "calspread:box:pnl:day:2026-08-31", tradeId, SUMMARY_FIELD],
  ]);
  assert.equal(
    plan.commands.some((command) => String(command[1]).includes("2026-09-01")),
    false,
  );
});

test("day index pruning bounds old fields despite whole-hash TTL refresh", () => {
  const now = Date.parse("2026-09-02T00:00:00.000Z");
  const entries = [
    {
      day: "2026-08-30", archived: true, updated_at: "2026-08-30T00:00:00.000Z",
      archived_at: null, row_count: 1, expires_at: "2026-09-01T00:00:00.000Z",
    },
    {
      day: "2026-09-01", archived: false, updated_at: "2026-09-01T23:59:00.000Z",
      archived_at: null, row_count: 1, expires_at: "2026-09-03T00:00:00.000Z",
    },
  ];
  const result = partitionDayIndex(entries, 900, now);
  assert.deepEqual(result.expiredDays, ["2026-08-30"]);
  assert.deepEqual(result.active.map((entry) => entry.day), ["2026-09-01"]);
  assert.equal(shouldPruneDayIndex(now - 59_999, 900, now), false);
  assert.equal(shouldPruneDayIndex(now - 225_000, 900, now), true);
});

/* ------------------- historical completeness and restart ----------------- */

test("historical Redis outage fails closed instead of mixing current-open with later closes", async () => {
  const historical = "2026-08-30";
  let freshCalls = 0;
  const cacheImpl = mockCache("other", [], null);
  const archiver = makeArchiver({
    cacheImpl,
    currentDay: "2026-09-01",
    getOpenPnl: () => { freshCalls++; return [openPos("wrong-current", 999, 999, 999)]; },
    loadClosedSince: async () => { freshCalls++; return [closedTrade("wrong-later", 999, 999, 999)]; },
    loadPersistedDay: async () => [],
  });
  await assert.rejects(
    archiver.verifyDay(historical),
    /historical Box P&L snapshot.*unavailable or incomplete/,
  );
  assert.equal(freshCalls, 0);
});

test("negative control: an old summary without a committed manifest is not accepted", async () => {
  const day = "2026-08-30";
  const snap = buildDaySnapshot({
    day,
    open: [openPos("old-row", 100, 150, 80)],
    closed: [],
    nowIso: NOW_ISO,
  });
  const durable = snapshotToDocs(day, snap.rows, snap.summary);
  const archiver = makeArchiver({
    cacheImpl: mockCache("other", [], null),
    currentDay: "2026-09-01",
    loadPersistedDay: async () => durable,
    // Models a failed incremental verify: the old summary still exists, but the
    // generation was invalidated before its missing new row failed to drain.
    isPersistedDayComplete: async () => false,
  });
  await assert.rejects(archiver.verifyDay(day), /unavailable or incomplete/);
});

test("negative control: completed day-bounded durable snapshot repairs a historical Redis miss", async () => {
  const day = "2026-08-30";
  const snap = buildDaySnapshot({
    day,
    open: [openPos("historical-survivor", 125, 150, 100)],
    closed: [],
    nowIso: NOW_ISO,
  });
  const durable = snapshotToDocs(day, snap.rows, snap.summary);
  const written = [];
  const archiver = makeArchiver({
    cacheImpl: mockCache("other", [], null),
    currentDay: "2026-09-01",
    loadPersistedDay: async () => durable,
    upsert: async (doc) => written.push(doc),
  });
  const result = await archiver.verifyDay(day);
  assert.equal(result.ok, true);
  assert.deepEqual(written.map((doc) => doc.trade_id), ["historical-survivor", SUMMARY_FIELD]);
  assert.equal(written[1].summary.total_net_pnl, 125);
});

test("persisted orphan is removed and its summary repaired on restart", async () => {
  const day = "2026-08-30";
  const survivor = snapshotToDocs(
    day,
    buildDaySnapshot({ day, open: [openPos("survivor", 200, 260, 170)], closed: [], nowIso: NOW_ISO }).rows,
    null,
  )[0];
  const durable = [
    survivor,
    { ...survivor, trade_id: "orphan", net_pnl: 900, gross_pnl: 900 },
    { day, trade_id: SUMMARY_FIELD, status: "summary", summary: { total_net_pnl: 1100 } },
  ];
  let reconcileCalls = 0;
  const archiver = makeArchiver({
    cacheImpl: mockCache("other", [], null),
    currentDay: "2026-09-01",
    currentIst: new Date("2026-09-01T10:00:00.000Z"),
    reconcileDurableOrphans: async () => {
      reconcileCalls++;
      const index = durable.findIndex((doc) => doc.trade_id === "orphan");
      durable.splice(index, 1);
      const summary = summarizeDayRows({ day, rows: [survivor], nowIso: NOW_ISO });
      replaceDoc(durable, { day, trade_id: SUMMARY_FIELD, status: "summary", summary });
      return 1;
    },
  });
  await archiver.reconcileOnStartup();
  assert.equal(reconcileCalls, 1);
  assert.equal(durable.some((doc) => doc.trade_id === "orphan"), false);
  assert.equal(durable.find((doc) => doc.trade_id === SUMMARY_FIELD).summary.total_net_pnl, 200);
});

test("cleanup throw leaves durable intent and restart repair converges", async () => {
  const state = { sourceExists: true, pending: false, orphan: true, repaired: false };
  const first = makeArchiver({ cacheImpl: mockCache("other", [], null) });
  await assert.rejects(
    first.withTradeDeletion("deleted", async () => {
      state.pending = true;
      state.sourceExists = false;
      throw new Error("cleanup interrupted");
    }),
    /cleanup interrupted/,
  );
  assert.equal(state.pending, true);
  assert.equal(state.orphan, true);

  const restarted = makeArchiver({
    cacheImpl: mockCache("other", [], null),
    currentIst: new Date("2026-08-31T10:00:00.000Z"),
    reconcileDurableOrphans: async () => {
      assert.equal(state.pending, true);
      assert.equal(state.sourceExists, false);
      state.orphan = false;
      state.pending = false;
      state.repaired = true;
      return 1;
    },
  });
  await restarted.reconcileOnStartup();
  assert.equal(state.repaired, true);
  assert.equal(state.orphan, false);
});

test("durable orphan reconciliation still runs when the Redis P&L cache is disabled", async () => {
  let calls = 0;
  const archiver = makeArchiver({
    cacheImpl: mockCache("other", [], null),
    cfgOverrides: { pnlCacheEnabled: false },
    reconcileDurableOrphans: async () => { calls++; return 0; },
  });
  await archiver.reconcileOnStartup();
  assert.equal(calls, 1);
});

test("poison reconciliation work is aggregated after later pending and archive repairs run", async () => {
  const repaired = [];
  const pending = await runIndependentBoxPnlRepairs({
    scope: "pending",
    items: ["early-poison", "later-pending"],
    identify: (id) => id,
    repair: async (id) => {
      if (id === "early-poison") throw new Error("repeatable cleanup failure");
      repaired.push(id);
      return 1;
    },
  });
  const archive = await runIndependentBoxPnlRepairs({
    scope: "archive-page",
    items: ["later-archive"],
    identify: (id) => id,
    repair: async (id) => { repaired.push(id); return 1; },
  });

  assert.deepEqual(repaired, ["later-pending", "later-archive"]);
  assert.equal(pending.failureCount, 1);
  assert.equal(pending.repaired + archive.repaired, 2);
  assert.match(pending.errors[0].message, /early-poison.*repeatable cleanup failure/);
});

test("successful startup schedules a deduplicated full pass that reaches a concurrent lower id", async () => {
  let now = 1_000;
  const timers = [];
  const setReconcileTimeout = (callback, delay) => {
    const timer = {
      callback,
      delay,
      cleared: false,
      fired: false,
      unrefCalled: false,
      unref() { this.unrefCalled = true; },
    };
    timers.push(timer);
    return timer;
  };
  const clearReconcileTimeout = (timer) => { timer.cleared = true; };
  let pass = 0;
  const seen = [];
  let firstDone;
  const firstCompleted = new Promise((resolve) => { firstDone = resolve; });
  let secondDone;
  const secondCompleted = new Promise((resolve) => { secondDone = resolve; });
  const pending = ["m-high"];
  const archiver = makeArchiver({
    cacheImpl: mockCache("other", [], null),
    cfgOverrides: { pnlCacheEnabled: false },
    setReconcileTimeout,
    clearReconcileTimeout,
    reconcileNowMs: () => now,
    reconcileDurableOrphans: async () => {
      pass++;
      seen.push(...pending);
      if (pass === 1) {
        // Inserted behind the first pass's effective cursor after it has scanned.
        pending.unshift("a-low");
        firstDone();
      } else {
        secondDone();
      }
      return 0;
    },
  });

  archiver.start();
  await firstCompleted;
  await new Promise((resolve) => setImmediate(resolve));
  const firstTimer = timers.find((timer) => !timer.cleared);
  assert.equal(firstTimer.delay, 5 * 60_000);
  assert.equal(firstTimer.unrefCalled, true);

  // Repeated periodic requests remain one timer, while an immediate repair
  // request accelerates that same slot instead of creating overlapping work.
  archiver.requestFullReconcile(5 * 60_000);
  assert.equal(timers.filter((timer) => !timer.cleared && !timer.fired).length, 1);
  archiver.requestDurableReconcile(30_000);
  assert.equal(firstTimer.cleared, true);
  const accelerated = timers.find((timer) => !timer.cleared);
  assert.equal(accelerated.delay, 30_000);

  now += accelerated.delay;
  accelerated.fired = true;
  accelerated.callback();
  await secondCompleted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pass, 2);
  assert.equal(seen.includes("a-low"), true);
  assert.equal(timers.filter((timer) => !timer.cleared && !timer.fired).length, 1);

  const armedAfterSecondPass = timers.find((timer) => !timer.cleared && !timer.fired);
  archiver.stop();
  assert.equal(armedAfterSecondPass.cleared, true);
});

test("durable cleanup retry remains active in-process after an ambiguous failure", async () => {
  let retried;
  const retriedPromise = new Promise((resolve) => { retried = resolve; });
  const archiver = makeArchiver({
    cacheImpl: mockCache("other", [], null),
    reconcileDurableOrphans: async () => { retried(); return 0; },
  });
  archiver.requestDurableReconcile(0);
  await Promise.race([
    retriedPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("retry did not run")), 100)),
  ]);
  archiver.stop();
});

test("startup isolates an unavailable D1 so D2 and current D3 still reconcile", async () => {
  const d1 = "2026-08-29";
  const d2 = "2026-08-30";
  const d3 = "2026-08-31";
  const snapshots = new Map([d2, d3].map((day, index) => {
    const snap = buildDaySnapshot({
      day, open: [openPos(`valid-${day}`, 100 + index, 150, 80)], closed: [], nowIso: NOW_ISO,
    });
    return [day, snap];
  }));
  const completed = [];
  const cacheImpl = {
    enabled: () => true,
    pendingDays: async () => [{ day: d1 }, { day: d2 }],
    readDay: async (day) => snapshots.has(day)
      ? { ...snapshots.get(day), present: true }
      : { rows: [], summary: null, present: false },
    markArchived: async () => {},
    writeSnapshot: async () => true,
  };
  const archiver = makeArchiver({
    cacheImpl,
    currentDay: d3,
    currentIst: new Date("2026-08-31T22:00:00.000Z"),
    loadPersistedDay: async () => [],
    isPersistedDayComplete: async () => false,
    markPersistedDayComplete: async (day) => completed.push(day),
  });
  await archiver.reconcileOnStartup();
  assert.deepEqual(completed, [d2, d3]);
  archiver.stop();
});

/* --------------------- lifecycle and cross-process races ----------------- */

test("pending prepare plus zero source delete and cancellation preserves valid archive content", async () => {
  const day = "2026-08-31";
  const tradeId = "still-valid";
  const snap = buildDaySnapshot({
    day, open: [openPos(tradeId, 100, 150, 80)], closed: [], nowIso: NOW_ISO,
  });
  const durable = snapshotToDocs(day, snap.rows, snap.summary);
  let sourceExists = true;
  let fenceStatus = "pending"; // prepare is visible to a concurrent writer

  const result = await runSourceSafePnlRowUpsert({
    allowed: async () => !isArchivedPnlRowInvalid(sourceExists, fenceStatus),
    write: async () => replaceDoc(durable, durable[0]),
    remove: async () => assert.fail("pending fence with a source must not remove the row"),
    rewriteSummary: async () => assert.fail("valid summary must not be rewritten as empty"),
  });
  assert.equal(result, "written");

  const deletedCount = 0; // guarded source deletion lost/refused its race
  if (deletedCount === 0) fenceStatus = null; // cancellation
  assert.equal(sourceExists, true);
  assert.equal(isArchivedPnlRowInvalid(sourceExists, fenceStatus), false);
  assert.equal(durable.some((doc) => doc.trade_id === tradeId), true);
  assert.equal(durable.find((doc) => doc.trade_id === SUMMARY_FIELD).summary.total_net_pnl, 100);
});

test("same-id concurrent P&L update invalidates completion proof deterministically", async () => {
  const day = "2026-08-31";
  const initial = buildDaySnapshot({
    day, open: [openPos("same-id", 100, 150, 80)], closed: [], nowIso: NOW_ISO,
  });
  const concurrent = buildDaySnapshot({
    day, open: [openPos("same-id", 250, 300, 200)], closed: [], nowIso: NOW_ISO,
  });
  let durable = snapshotToDocs(day, initial.rows, initial.summary);
  let invalidated = false;
  await assert.rejects(
    runBoxPnlDayProofCommit({
      expected: structuredClone(durable),
      settle: async () => {},
      load: async () => structuredClone(durable),
      publish: async () => {
        // Membership is unchanged and the concurrent summary is internally valid;
        // only the canonical content digest can detect this race.
        durable = snapshotToDocs(day, concurrent.rows, concurrent.summary);
      },
      invalidate: async () => { invalidated = true; },
    }),
    /content changed while publishing/,
  );
  assert.equal(invalidated, true);
});

test("a fail-once proof publication remains eligible and succeeds on retry", async () => {
  const day = "2026-08-31";
  const snap = buildDaySnapshot({
    day, open: [openPos("retry-proof", 100, 150, 80)], closed: [], nowIso: NOW_ISO,
  });
  const durable = snapshotToDocs(day, snap.rows, snap.summary);
  const state = { complete: true, needs_reproof: false };
  let publications = 0;
  const attempt = () => runBoxPnlDayProofCommit({
    expected: durable,
    settle: async () => {},
    load: async () => structuredClone(durable),
    publish: async () => {
      publications++;
      if (publications === 1) throw new Error("transient state write failure");
      state.complete = true;
      state.needs_reproof = false;
    },
    invalidate: async () => {
      state.complete = false;
      state.needs_reproof = true;
    },
  });
  await assert.rejects(attempt(), /transient state write failure/);
  assert.equal(shouldReproveBoxPnlDay(state), true);
  await attempt();
  assert.deepEqual(state, { complete: true, needs_reproof: false });
});

function replaceDaySummary(durable, day) {
  const rows = durable.filter((doc) => doc.trade_id !== SUMMARY_FIELD);
  const summary = summarizeDayRows({ day, rows, nowIso: NOW_ISO });
  replaceDoc(durable, { day, trade_id: SUMMARY_FIELD, status: "summary", summary });
}

test("periodic v2 scan repairs A-published proof after B late same-ID write crashes", async () => {
  const day = "2026-08-31";
  const first = buildDaySnapshot({
    day, open: [openPos("same-id", 100, 150, 80)], closed: [], nowIso: NOW_ISO,
  });
  const late = buildDaySnapshot({
    day, open: [openPos("same-id", 275, 320, 210)], closed: [], nowIso: NOW_ISO,
  });
  const durable = snapshotToDocs(day, first.rows, first.summary);
  const proofA = buildBoxPnlDayProof(durable);
  const state = { ...proofA, complete: true, needs_reproof: false };

  // B invalidated before A's publication. A then completed, B wrote after A's
  // post-check, and B crashed before its own post-invalidation/publication.
  state.complete = false;
  state.needs_reproof = true;
  Object.assign(state, proofA, { complete: true, needs_reproof: false });
  replaceDoc(durable, snapshotToDocs(day, late.rows, late.summary)[0]);
  assert.equal(state.complete, true);
  assert.equal(
    boxPnlDayProofsEqual(state, buildBoxPnlDayProof(durable)),
    false,
    "the stale complete proof must disagree with B's late row",
  );

  const selectedByPeriodicV2Scan = state.snapshot_version === 2 &&
    (state.complete || state.needs_reproof);
  assert.equal(selectedByPeriodicV2Scan, true);
  const repaired = await runBoxPnlDayProofRepair({
    lastExactProof: proofA,
    expectedRowCount: proofA.row_count,
    load: async () => structuredClone(durable),
    validate: async () => {},
    settle: async () => replaceDaySummary(durable, day),
    publish: async (prior, next) => {
      assert.equal(boxPnlDayProofsEqual(prior, proofA), true);
      Object.assign(state, next, { complete: true, needs_reproof: false });
    },
    markRetry: async () => {
      state.complete = false;
      state.needs_reproof = true;
    },
  });
  assert.equal(repaired.row_count, 1);
  assert.equal(repaired.content_sha256, state.content_sha256);
  assert.equal(durable.find((doc) => doc.trade_id === SUMMARY_FIELD).summary.total_net_pnl, 275);
  assert.deepEqual({ complete: state.complete, needs_reproof: state.needs_reproof }, {
    complete: true,
    needs_reproof: false,
  });
});

test("source-invalid row cleanup authorizes only the established survivor membership", async () => {
  const day = "2026-08-31";
  const snap = buildDaySnapshot({
    day,
    open: [openPos("survivor", 125, 150, 100), openPos("deleted", 900, 900, 900)],
    closed: [],
    nowIso: NOW_ISO,
  });
  const durable = snapshotToDocs(day, snap.rows, snap.summary);
  const lastExact = buildBoxPnlDayProof(durable);
  const state = { ...lastExact, complete: true, needs_reproof: false };
  const source = new Set(["survivor"]);

  // Models deletion-intent cleanup: invalidation retains the old proof while the
  // fenced row is removed, then repair is authorized for exactly one survivor.
  await runBoxPnlDayMutation({
    invalidate: async () => {
      state.complete = false;
      state.needs_reproof = true;
    },
    mutate: async () => {
      const index = durable.findIndex((doc) => doc.trade_id === "deleted");
      durable.splice(index, 1);
    },
  });
  assert.equal(state.row_count, 2, "last exact proof metadata must survive cleanup");
  await runBoxPnlDayProofRepair({
    lastExactProof: lastExact,
    expectedRowCount: 1,
    load: async () => structuredClone(durable),
    validate: async (docs) => {
      assert.equal(docs.filter((doc) => doc.trade_id !== SUMMARY_FIELD)
        .every((doc) => source.has(doc.trade_id)), true);
    },
    settle: async () => replaceDaySummary(durable, day),
    publish: async (_prior, next) => Object.assign(
      state, next, { complete: true, needs_reproof: false },
    ),
    markRetry: async () => {
      state.complete = false;
      state.needs_reproof = true;
    },
  });
  assert.equal(durable.some((doc) => doc.trade_id === "deleted"), false);
  assert.equal(state.row_count, 1);
  assert.equal(durable.find((doc) => doc.trade_id === SUMMARY_FIELD).summary.total_net_pnl, 125);
});

test("periodic repair never certifies a partial generation with changed row membership", async () => {
  const day = "2026-08-31";
  const exact = buildDaySnapshot({
    day, open: [openPos("exact", 100, 150, 80)], closed: [], nowIso: NOW_ISO,
  });
  const partial = buildDaySnapshot({
    day,
    open: [openPos("exact", 100, 150, 80), openPos("partial-extra", 500, 550, 450)],
    closed: [],
    nowIso: NOW_ISO,
  });
  const exactDocs = snapshotToDocs(day, exact.rows, exact.summary);
  const durable = snapshotToDocs(day, partial.rows, partial.summary);
  const lastExact = buildBoxPnlDayProof(exactDocs);
  const state = { ...lastExact, complete: true, needs_reproof: false };
  let settled = 0;
  let published = 0;

  await assert.rejects(
    runBoxPnlDayProofRepair({
      lastExactProof: lastExact,
      expectedRowCount: lastExact.row_count,
      load: async () => structuredClone(durable),
      validate: async () => {},
      settle: async () => { settled++; replaceDaySummary(durable, day); },
      publish: async () => { published++; },
      markRetry: async () => {
        state.complete = false;
        state.needs_reproof = true;
      },
    }),
    /membership count 2 differs from last exact row_count 1/,
  );
  assert.equal(settled, 0, "membership must be rejected before summary/proof mutation");
  assert.equal(published, 0);
  assert.equal(state.content_sha256, lastExact.content_sha256);
  assert.deepEqual({ complete: state.complete, needs_reproof: state.needs_reproof }, {
    complete: false,
    needs_reproof: true,
  });
});

test("collect already in flight is serialized through drain before delete cleanup", async () => {
  const day = "2026-08-31";
  const tradeId = "collect-in-flight";
  const snap = buildDaySnapshot({ day, open: [openPos(tradeId, 100, 150, 80)], closed: [], nowIso: NOW_ISO });
  let releaseCollect;
  let enteredCollect;
  const collectBlocked = new Promise((resolve) => { releaseCollect = resolve; });
  const collectEntered = new Promise((resolve) => { enteredCollect = resolve; });
  const written = [];
  const archiver = makeArchiver({
    cacheImpl: mockCache(day, snap.rows, snap.summary),
    filterExistingTradeIds: async (ids) => {
      enteredCollect();
      await collectBlocked;
      return ids;
    },
    upsert: async (doc) => written.push(doc.trade_id),
  });

  const archive = archiver.archiveDay(day);
  await collectEntered;
  let cleanupRan = false;
  const deletion = archiver.withTradeDeletion(tradeId, async () => { cleanupRan = true; });
  await Promise.resolve();
  assert.equal(cleanupRan, false);
  releaseCollect();
  await Promise.all([archive, deletion]);
  assert.equal(cleanupRan, true);
  assert.deepEqual(written, [SUMMARY_FIELD]);
  assert.equal(
    snap.rows.some((row) => written.includes(row.trade_id)),
    false,
    "the row collected before deletion must not drain",
  );
});

function makeSourceSafeStore(sourceIds) {
  const source = new Set(sourceIds);
  const fences = new Set();
  const durable = [];
  let beforeRowWrite = async () => {};

  const rewrite = (day) => {
    for (let i = durable.length - 1; i >= 0; i--) {
      const doc = durable[i];
      if (doc.day === day && doc.trade_id !== SUMMARY_FIELD &&
          (!source.has(doc.trade_id) || fences.has(doc.trade_id))) durable.splice(i, 1);
    }
    const rows = durable.filter((doc) => doc.day === day && doc.trade_id !== SUMMARY_FIELD);
    const summary = summarizeDayRows({ day, rows, nowIso: NOW_ISO });
    replaceDoc(durable, { day, trade_id: SUMMARY_FIELD, status: "summary", summary });
  };

  return {
    source,
    fences,
    durable,
    setBeforeRowWrite(fn) { beforeRowWrite = fn; },
    async upsert(doc) {
      if (doc.trade_id === SUMMARY_FIELD) {
        rewrite(doc.day);
        return;
      }
      await runSourceSafePnlRowUpsert({
        allowed: async () => source.has(doc.trade_id) && !fences.has(doc.trade_id),
        write: async () => {
          await beforeRowWrite(doc);
          replaceDoc(durable, doc);
        },
        remove: async () => {
          const index = durable.findIndex(
            (row) => row.day === doc.day && row.trade_id === doc.trade_id,
          );
          if (index >= 0) durable.splice(index, 1);
        },
        rewriteSummary: async () => rewrite(doc.day),
      });
    },
    cleanup(tradeId) {
      fences.add(tradeId);
      source.delete(tradeId);
      const days = new Set(durable.filter((doc) => doc.trade_id === tradeId).map((doc) => doc.day));
      for (let i = durable.length - 1; i >= 0; i--) {
        if (durable[i].trade_id === tradeId) durable.splice(i, 1);
      }
      for (const day of days) rewrite(day);
    },
  };
}

test("two archiver instances converge for both writer-before-delete and delete-before-writer orderings", async () => {
  const day = "2026-08-31";
  const tradeId = "cross-process";
  const snap = buildDaySnapshot({ day, open: [openPos(tradeId, 100, 150, 80)], closed: [], nowIso: NOW_ISO });

  // Writer wins first; deletion cleanup runs later and removes row + summary contribution.
  const firstStore = makeSourceSafeStore([tradeId]);
  const firstWriter = makeArchiver({
    cacheImpl: mockCache(day, snap.rows, snap.summary),
    upsert: (doc) => firstStore.upsert(doc),
  });
  await firstWriter.archiveDay(day);
  assert.equal(firstStore.durable.some((doc) => doc.trade_id === tradeId), true);
  firstStore.cleanup(tradeId);
  assert.equal(firstStore.durable.some((doc) => doc.trade_id === tradeId), false);
  assert.equal(firstStore.durable.find((doc) => doc.trade_id === SUMMARY_FIELD).summary.total_net_pnl, 0);

  // A different process validates first, deletion cleanup runs, then its late write
  // self-cleans at the durable post-check.
  const secondStore = makeSourceSafeStore([tradeId]);
  let releaseWrite;
  let enteredWrite;
  const blocked = new Promise((resolve) => { releaseWrite = resolve; });
  const entered = new Promise((resolve) => { enteredWrite = resolve; });
  secondStore.setBeforeRowWrite(async () => { enteredWrite(); await blocked; });
  const otherProcess = makeArchiver({
    cacheImpl: mockCache(day, snap.rows, snap.summary),
    upsert: (doc) => secondStore.upsert(doc),
  });
  const archive = otherProcess.archiveDay(day);
  await entered;
  secondStore.cleanup(tradeId);
  releaseWrite();
  await archive;
  assert.equal(secondStore.durable.some((doc) => doc.trade_id === tradeId), false);
  assert.equal(secondStore.durable.find((doc) => doc.trade_id === SUMMARY_FIELD).summary.total_net_pnl, 0);
});

test("survivor summary is rewritten after a racing deleted row settles", async () => {
  const day = "2026-08-31";
  const deleted = "deleted";
  const survivor = "survivor";
  const snap = buildDaySnapshot({
    day,
    open: [openPos(deleted, 100, 150, 80), openPos(survivor, 200, 260, 170)],
    closed: [],
    nowIso: NOW_ISO,
  });
  const store = makeSourceSafeStore([deleted, survivor]);
  let releaseDeleted;
  let enteredDeleted;
  const blocked = new Promise((resolve) => { releaseDeleted = resolve; });
  const entered = new Promise((resolve) => { enteredDeleted = resolve; });
  store.setBeforeRowWrite(async (doc) => {
    if (doc.trade_id === deleted) { enteredDeleted(); await blocked; }
  });
  const writer = makeArchiver({
    cacheImpl: mockCache(day, snap.rows, snap.summary),
    upsert: (doc) => store.upsert(doc),
  });
  const archive = writer.archiveDay(day);
  await entered;
  store.cleanup(deleted);
  releaseDeleted();
  await archive;

  assert.equal(store.durable.some((doc) => doc.trade_id === deleted), false);
  assert.equal(store.durable.some((doc) => doc.trade_id === survivor), true);
  const summary = store.durable.find((doc) => doc.trade_id === SUMMARY_FIELD).summary;
  assert.equal(summary.open_count, 1);
  assert.equal(summary.total_net_pnl, 200);
  assert.equal(summary.total_gross_pnl, 260);
});

test("source validation failure aborts archive rather than deleting valid content", async () => {
  const day = "2026-08-31";
  const snap = buildDaySnapshot({ day, open: [openPos("valid", 100, 150, 80)], closed: [], nowIso: NOW_ISO });
  const written = [];
  const archiver = makeArchiver({
    cacheImpl: mockCache(day, snap.rows, snap.summary),
    filterExistingTradeIds: async () => { throw new Error("source unavailable"); },
    upsert: async (doc) => written.push(doc),
  });
  await assert.rejects(archiver.archiveDay(day), /source unavailable/);
  assert.deepEqual(written, []);
});
