/**
 * The daily P&L snapshot + nightly archiver.
 *
 * Two layers are pinned here:
 *   1. buildDaySnapshot / snapshotToDocs / missingRowIds — the PURE shaping of
 *      "how is today going" (open running net + closed realised net) and the
 *      set-difference the verify pass relies on.
 *   2. BoxPnlArchiver.archiveDay / verifyDay — the streamed drain: one document
 *      at a time, summary last, break-on-error leaves the rest for verify, and a
 *      completed drain marks the day archived. All I/O is mocked, so no Redis or
 *      Mongo is touched.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDaySnapshot,
  missingRowIds,
  SUMMARY_FIELD,
} from "../../dist/box/pnlSnapshot.js";
import {
  BoxPnlArchiver,
  istDayStartMs,
  snapshotToDocs,
} from "../../dist/box/pnlArchive.js";

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

test("buildDaySnapshot sums open running net and closed realised net into the day total", () => {
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
  assert.equal(snap.summary.total_gross_pnl, 150 + 260 + 640);

  const open1 = snap.rows.find((r) => r.trade_id === "o1");
  assert.equal(open1.status, "open");
  assert.equal(open1.realisable_net_pnl, 80);
  assert.equal(open1.realised_net_pnl, null);

  const closed1 = snap.rows.find((r) => r.trade_id === "c1");
  assert.equal(closed1.status, "closed");
  assert.equal(closed1.net_pnl, 500);
  assert.equal(closed1.realisable_net_pnl, null);
});

test("a closed trade with no realised_net_pnl falls back to net_pnl", () => {
  const snap = buildDaySnapshot({
    day: "2026-08-31",
    open: [],
    closed: [closedTrade("c1", 400, 500, null)],
    nowIso: NOW_ISO,
  });
  const row = snap.rows[0];
  assert.equal(row.net_pnl, 400);
  assert.equal(row.realised_net_pnl, 400);
  assert.equal(snap.summary.closed_realised_net_pnl, 400);
});

test("a null P&L counts as zero in the aggregate, never NaN", () => {
  const snap = buildDaySnapshot({
    day: "2026-08-31",
    open: [openPos("o1", null, null, null)],
    closed: [],
    nowIso: NOW_ISO,
  });
  assert.equal(snap.summary.open_running_net_pnl, 0);
  assert.equal(snap.summary.total_net_pnl, 0);
});

test("snapshotToDocs emits one doc per row then the summary doc last", () => {
  const snap = buildDaySnapshot({
    day: "2026-08-31",
    open: [openPos("o1", 100, 150, 80)],
    closed: [closedTrade("c1", 500, 640, 500)],
    nowIso: NOW_ISO,
  });
  const docs = snapshotToDocs("2026-08-31", snap.rows, snap.summary);
  assert.equal(docs.length, 3);
  const last = docs[docs.length - 1];
  assert.equal(last.trade_id, SUMMARY_FIELD);
  assert.equal(last.status, "summary");
  assert.ok(last.summary);
  assert.equal(last.summary.total_net_pnl, 600);
});

test("missingRowIds is the set of cached ids absent from the persisted set", () => {
  assert.deepEqual(missingRowIds(["a", "b", "c"], ["b"]), ["a", "c"]);
  assert.deepEqual(missingRowIds(["a"], ["a"]), []);
  assert.deepEqual(missingRowIds([], ["x"]), []);
});

test("istDayStartMs is IST midnight for the day", () => {
  const start = istDayStartMs("2026-08-31");
  assert.equal(start, Date.parse("2026-08-31T00:00:00.000+05:30"));
  assert.ok(Date.parse("2026-08-31T10:00:00+05:30") >= start);
  assert.ok(Date.parse("2026-08-30T23:59:00+05:30") < start);
});

/* --------------------------- archiver orchestration ----------------------- */

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

/** A mock cache that serves a fixed day and records markArchived calls. */
function mockCache(day, rows, summary) {
  const marks = [];
  return {
    calls: { marks },
    enabled: () => true,
    readDay: async (d) => (d === day ? { rows, summary } : { rows: [], summary: null }),
    markArchived: async (d, count, iso) => marks.push({ day: d, count, iso }),
    pendingDays: async () => [],
    writeSnapshot: async () => true,
  };
}

function makeArchiver({ cacheImpl, upsert, loadPersistedIds, cfgOverrides }) {
  return new BoxPnlArchiver({
    cfg: cfg(cfgOverrides),
    cache: cacheImpl,
    getOpenPnl: () => [],
    loadClosedSince: async () => [],
    upsert,
    loadPersistedIds: loadPersistedIds ?? (async () => []),
    istDayKey: () => "2026-08-31",
    istNow: () => new Date(Date.parse("2026-08-31T21:00:00+05:30") + 5.5 * 3600 * 1000),
    isDbEnabled: () => true,
  });
}

test("archiveDay streams every cached row plus the summary, in order, then marks archived", async () => {
  const day = "2026-08-31";
  const snap = buildDaySnapshot({
    day,
    open: [openPos("o1", 100, 150, 80)],
    closed: [closedTrade("c1", 500, 640, 500)],
    nowIso: NOW_ISO,
  });
  const written = [];
  const cacheImpl = mockCache(day, snap.rows, snap.summary);
  const archiver = makeArchiver({
    cacheImpl,
    upsert: async (doc) => {
      written.push(doc.trade_id);
    },
  });

  const res = await archiver.archiveDay(day);
  assert.equal(res.ok, true);
  assert.equal(res.written, 3);
  assert.equal(res.total, 3);
  // Summary is written last so a part-way drain never looks complete.
  assert.equal(written[written.length - 1], SUMMARY_FIELD);
  assert.equal(cacheImpl.calls.marks.length, 1);
  assert.equal(cacheImpl.calls.marks[0].count, 3);
});

test("archiveDay stops on the first upsert error and does NOT mark archived", async () => {
  const day = "2026-08-31";
  const snap = buildDaySnapshot({
    day,
    open: [openPos("o1", 100, 150, 80), openPos("o2", 200, 260, 170)],
    closed: [],
    nowIso: NOW_ISO,
  });
  let n = 0;
  const cacheImpl = mockCache(day, snap.rows, snap.summary);
  const archiver = makeArchiver({
    cacheImpl,
    upsert: async () => {
      n++;
      if (n === 2) throw new Error("mongo blip");
    },
  });

  const res = await archiver.archiveDay(day);
  assert.equal(res.ok, false);
  assert.equal(res.written, 1);
  assert.equal(cacheImpl.calls.marks.length, 0, "an incomplete drain must not mark the day archived");
});

test("verifyDay drains only the rows still missing from Mongo", async () => {
  const day = "2026-08-31";
  const snap = buildDaySnapshot({
    day,
    open: [openPos("o1", 100, 150, 80), openPos("o2", 200, 260, 170)],
    closed: [],
    nowIso: NOW_ISO,
  });
  const written = [];
  const cacheImpl = mockCache(day, snap.rows, snap.summary);
  // o1 already archived; o2 and the summary are missing.
  const archiver = makeArchiver({
    cacheImpl,
    upsert: async (doc) => written.push(doc.trade_id),
    loadPersistedIds: async () => ["o1"],
  });

  const res = await archiver.verifyDay(day);
  assert.equal(res.missing, 2);
  assert.equal(res.written, 2);
  assert.deepEqual(new Set(written), new Set(["o2", SUMMARY_FIELD]));
  assert.equal(cacheImpl.calls.marks.length, 1);
});

test("verifyDay is a no-op (but marks archived) when nothing is missing", async () => {
  const day = "2026-08-31";
  const snap = buildDaySnapshot({ day, open: [openPos("o1", 100, 150, 80)], closed: [], nowIso: NOW_ISO });
  const written = [];
  const cacheImpl = mockCache(day, snap.rows, snap.summary);
  const archiver = makeArchiver({
    cacheImpl,
    upsert: async (doc) => written.push(doc.trade_id),
    loadPersistedIds: async () => ["o1", SUMMARY_FIELD],
  });
  const res = await archiver.verifyDay(day);
  assert.equal(res.missing, 0);
  assert.equal(written.length, 0);
  assert.equal(cacheImpl.calls.marks.length, 1);
});
