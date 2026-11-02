// Generates the parity fixtures in this directory from the ORIGINAL TypeScript
// (src/eodCapture.ts, src/hourlyCapture.ts, src/yahoo.ts), so the Go port is checked
// against what Node actually computes. Run from the repository root (Node 22.18+ strips
// types natively):
//
//   scratch/go-migration/check.sh node internal/captures/testdata/gen_parity.mjs
//
// The sources are copied to scratch/go-migration/tmp/captures/patched/ and only the COPIES
// are edited: the ./db.js and ./trackedTimers.js imports point at in-memory stubs
// (stub_db.mjs, stub_timers.mjs), each scheduler's `void (async () => {` becomes
// `globalThis.__tick = (async () => {` so a tick can be awaited, and the internal pure
// helpers are exported. fetch, setTimeout, setInterval and Date.now are replaced in this
// process: nothing reaches the network or a database, and delays are recorded, not waited.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const tmp = join(root, "scratch", "go-migration", "tmp", "captures", "patched");
mkdirSync(tmp, { recursive: true });
writeFileSync(join(tmp, "package.json"), '{"type":"module"}\n');
copyFileSync(join(here, "stub_db.mjs"), join(tmp, "stub_db.mjs"));
copyFileSync(join(here, "stub_timers.mjs"), join(tmp, "stub_timers.mjs"));

function prepare(name, exportsList) {
  let src = readFileSync(join(root, "src", name), "utf8");
  for (const [a, b] of [
    ['from "./trackedTimers.js"', 'from "./stub_timers.mjs"'],
    ['from "./db.js"', 'from "./stub_db.mjs"'],
    ["void (async () => {", "globalThis.__tick = (async () => {"],
  ]) {
    src = src.split(a).join(b);
  }
  if (exportsList.length) src += `\nexport { ${exportsList.join(", ")} };\n`;
  writeFileSync(join(tmp, name), src);
  return pathToFileURL(join(tmp, name)).href;
}

const hourlyUrl = prepare("hourlyCapture.ts", [
  "marketHoursFor",
  "currentCaptureSlot",
  "allExpectedSlots",
  "candleToSlotKey",
  "isWeekday",
  "isMarketOpen",
  "istHourKey",
  "SLOTS_PER_DAY",
]);
const eodUrl = prepare("eodCapture.ts", ["getWeekdaysBetween", "isWeekday", "captureEodData"]);
const yahooUrl = prepare("yahoo.ts", ["fetchYieldPct"]);

// ---- process-wide fakes ---------------------------------------------------------------
const realSetImmediate = setImmediate;
const sleeps = [];
globalThis.setTimeout = (fn, ms, ...args) => {
  sleeps.push(ms);
  realSetImmediate(() => fn(...args));
  return { ref() {}, unref() {} };
};
globalThis.setInterval = (fn, ms) => ({ fn, ms });
let now = 0;
Date.now = () => now;
const logs = [];
const fmt = (a) => (a instanceof Error ? "<error>" : typeof a === "string" ? a : JSON.stringify(a));
console.log = console.warn = console.error = (...args) => logs.push(args.map(fmt).join(" "));
const out = (s) => process.stdout.write(s + "\n");

const stub = await import(pathToFileURL(join(tmp, "stub_db.mjs")).href);
const timers = await import(pathToFileURL(join(tmp, "stub_timers.mjs")).href);
let instance = 0;
const freshModule = (url) => import(`${url}?i=${++instance}`);

const clone = (x) => JSON.parse(JSON.stringify(x));
const uniq = (a) => [...new Set(a)];

// ---- deterministic data ---------------------------------------------------------------
let seed = 0x2545f491;
const rnd = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x297a2d39) | 0), (seed >>> 0) / 4294967296);
const px = (lo, hi) => Math.round((lo + rnd() * (hi - lo)) * 20) / 20; // tick size 0.05

const fut = (token, expiry) => ({ token, expiry, lot_size: 100 });
const board = [
  { symbol: "ALPHA", name: "ALPHA", spot_token: 1, futures: [fut(101, "2026-08-27"), fut(102, "2026-09-24"), fut(103, "2026-10-29")] },
  { symbol: "BETA", name: "BETA", spot_token: 2, futures: [fut(201, "2026-08-27"), fut(202, "2026-09-24")] },
  { symbol: "GAMMA", name: "GAMMA", spot_token: 3, futures: [fut(301, "2026-08-27"), fut(302, "2026-09-24"), fut(303, "2026-10-29")] },
  { symbol: "DELTA", name: "DELTA", spot_token: 4, futures: [fut(401, "2026-08-27")] },
  { symbol: "NIFTY", name: "NIFTY", spot_token: 5, futures: [fut(501, "2026-08-27"), fut(502, "2026-09-24"), fut(503, "2026-10-29")], is_index: true },
  { symbol: "M&M", name: "MAHINDRA & MAHINDRA", spot_token: 6, futures: [fut(601, "2026-08-27"), fut(602, "2026-09-24")] },
  { symbol: "EPS", name: "EPS", spot_token: 7, futures: [fut(701, "2026-08-27"), fut(702, "2026-09-24"), fut(703, "2026-10-29")] },
];
const inst = (token, tradingsymbol, extra = {}) => ({
  instrument_token: token, exchange_token: token, tradingsymbol, name: tradingsymbol, last_price: 0,
  expiry: "", strike: 0, tick_size: 0.05, lot_size: 100, instrument_type: "FUT", segment: "NFO-FUT", exchange: "NFO",
  ...extra,
});
const months = ["AUG", "SEP", "OCT"];
const instruments = [inst(1, "ALPHA", { instrument_type: "EQ", exchange: "NSE", segment: "NSE" })];
for (const b of board) {
  b.futures.forEach((f, i) => {
    if (f.token === 702) return; // no instrument: never requested
    const sym = `${b.symbol}26${months[i]}FUT`;
    if (f.token === 103) instruments.push(inst(103, "ALPHA_STALE_FUT")); // later row wins
    instruments.push(inst(f.token, sym));
  });
}
instruments.push(inst(9101, "ALPHA26AUG1000CE", { instrument_type: "CE", segment: "NFO-OPT" }));
const tsym = Object.fromEntries(instruments.filter((i) => i.exchange === "NFO" && i.instrument_type === "FUT").map((i) => [i.instrument_token, `NFO:${i.tradingsymbol}`]));

// ---- fake Kite ------------------------------------------------------------------------
function makeKite(spec, calls) {
  const k = {
    session: spec.session !== false,
    hasSession: () => k.session,
    async getQuoteOhlc(ids) {
      calls.push({ method: "getQuoteOhlc", ids: [...ids] });
      if (spec.fail_quote) throw new Error("kite down");
      return uniq(ids).filter((id) => spec.ohlc?.[id]).map((id) => clone(spec.ohlc[id]));
    },
    async getQuoteFullOhlc(ids) {
      calls.push({ method: "getQuoteFullOhlc", ids: [...ids] });
      if (spec.fail_quote) throw new Error("kite down");
      return uniq(ids).filter((id) => spec.full?.[id]).map((id) => clone(spec.full[id]));
    },
    async getHistoricalFull(token, from, to, interval, prio) {
      calls.push({ method: "getHistoricalFull", token, from, to, interval, prio });
      if ((spec.fail_tokens ?? []).includes(token)) throw new Error("kite down");
      return clone(spec.daily?.[token] ?? []);
    },
    async getHistorical(token, from, to, interval, prio) {
      calls.push({ method: "getHistorical", token, from, to, interval, prio });
      if ((spec.fail_tokens ?? []).includes(token)) throw new Error("kite down");
      return clone(spec.hourly?.[token] ?? []);
    },
  };
  return k;
}

// ---- scenario runner ------------------------------------------------------------------
const dateKeys = new Set(["trading_date", "expiry", "near_expiry", "mid_expiry", "first_date", "last_date"]);
const reviveDates = (d) => {
  const o = {};
  for (const [k, v] of Object.entries(d)) o[k] = dateKeys.has(k) && typeof v === "string" ? new Date(v) : v;
  return o;
};
const cmp = (keys) => (a, b) => {
  for (const k of keys) {
    const x = a[k] instanceof Date ? a[k].toISOString() : a[k];
    const y = b[k] instanceof Date ? b[k].toISOString() : b[k];
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
};
const models = {
  hourlyprices: [stub.HourlyPrice, ["symbol", "date", "time"]],
  stock_futures_current: [stub.StockFuture, ["symbol", "trading_date", "expiry"]],
  stock_futures_archive: [stub.StockFutureArchive, ["symbol", "trading_date", "expiry"]],
  spread_daily: [stub.SpreadDaily, ["symbol", "trading_date"]],
  spread_summary: [stub.SpreadSummary, ["symbol"]],
};

async function run(sc) {
  stub.resetAll();
  for (const [name, [model]] of Object.entries(models)) model.seed((sc.db?.[name] ?? []).map(reviveDates));
  const seededIds = new Set((sc.db?.spread_summary ?? []).map((d) => d._id));
  for (const key of ["HOURLY_BACKFILL_LOOKBACK_DAYS", "DAY_REVIEW_TIME", "EXTRA_SESSION_DAYS"]) {
    if (sc.env && key in sc.env) process.env[key] = sc.env[key];
    else delete process.env[key];
  }
  sleeps.length = 0;
  logs.length = 0;
  const calls = [];
  const kite = makeKite(sc.kite ?? {}, calls);
  const ticks = sc.ticks ?? {};
  const getLatestTick = (token) => (token in ticks ? { token, last_price: ticks[token] } : undefined);
  let boardError = false;
  const deps = {
    getBoard: async () => {
      if (boardError) throw new Error("board unavailable");
      return clone(sc.board);
    },
    getLatestTick,
    kite,
    getAllInstruments: async () => clone(sc.instruments),
  };
  const hm = await freshModule(hourlyUrl);
  const em = await freshModule(eodUrl);
  for (const step of sc.steps) {
    if (step.at) now = Date.parse(step.at);
    try {
      await runStep(step);
    } catch {
      logs.push(`[step error] ${step.op}`); // the call rejected (index.ts logged it)
    }
  }
  async function runStep(step) {
    switch (step.op) {
      case "capture":
        await hm.captureHourlyPrices(
          clone(sc.board), getLatestTick, step.no_kite ? undefined : kite,
          step.no_instruments ? undefined : clone(sc.instruments), step.slot);
        break;
      case "drain": await hm.drainCacheToDB(); break;
      case "backfill": await hm.backfillMissedHours(deps); break;
      case "backfill_concurrent":
        await Promise.all([hm.backfillMissedHours(deps), hm.backfillMissedHours(deps)]);
        break;
      case "review": await hm.reviewDayCompleteness(deps); break;
      case "start_hourly": hm.startHourlyScheduler(deps); break;
      case "start_review": hm.startDayReviewScheduler(deps); break;
      case "start_eod": em.startEodScheduler(deps); break;
      case "tick":
        globalThis.__tick = undefined;
        timers.registry[step.name].fn();
        await globalThis.__tick;
        break;
      case "capture_eod": await em.captureEodData(deps); break;
      case "backfill_eod": await em.backfillStockFutures(deps); break;
      case "compute": await em.computeSpreads(step.dates); break;
      case "recompute": await em.recomputeSpreadSummary(); break;
      case "check": await em.checkAndRecomputeSummary(); break;
      case "session": kite.session = step.value; break;
      case "board_error": boardError = step.value; break;
      case "nse_fno": stub.flags.nseFno = step.value; break;
      case "fail_writes": {
        const [model] = models[step.model];
        model.failAfter = step.after === null ? null : model.writes + step.after;
        break;
      }
      default: throw new Error(`unknown op ${step.op}`);
    }
  }
  const db = {};
  for (const [name, [model, keys]] of Object.entries(models)) {
    db[name] = model.docs
      .map((d) => {
        const o = { ...d };
        if (name === "spread_summary") o._id = seededIds.has(d._id) ? d._id : "<new>";
        else delete o._id;
        return o;
      })
      .sort(cmp(keys));
  }
  sc.expected = { kite_calls: calls, sleeps: [...sleeps], logs: [...logs], db: clone(db) };
  return sc;
}

// ---- hourly scenarios -----------------------------------------------------------------
const base = { board, instruments };
const liveTicks = { 101: 1000.5, 102: 1010.25, 103: 1020.75, 201: 500, 501: 24500, 502: 24600.35, 601: 0 };
const restOhlc = {};
const q = (token, last) => ({ instrument_token: token, last_price: last, ohlc: { open: last - 1, high: last + 2, low: last - 3, close: last - 0.5 } });
for (const [token, last] of [[202, 505.6], [301, 300.1], [302, 305.35], [303, 0], [601, 3000], [602, 3010.55], [701, 70.1], [703, 72.3], [201, 499.9]]) {
  restOhlc[tsym[token]] = q(token, last);
}

function hourlyCandles(token, days, opts = {}) {
  const rows = [];
  for (const d of days) {
    for (const hh of ["09", "10", "11", "12", "13", "14", "15"]) {
      if (opts.skip?.(d, hh)) continue;
      const close = opts.zero?.(d, hh) ? 0 : px(100 + token % 97, 140 + token % 97);
      const sep = opts.space ? " " : "T";
      const mm = opts.onHour ? "00" : "15";
      rows.push({ t: `${d}${sep}${hh}:${mm}:00${opts.space ? "" : "+0530"}`, close });
    }
  }
  return rows;
}
const windowDays = ["2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-03", "2026-08-04", "2026-08-05"];
const hourlyKite = {
  hourly: {
    101: hourlyCandles(101, windowDays),
    102: hourlyCandles(102, windowDays, { zero: (d, hh) => d === "2026-08-03" && hh === "11" }),
    103: hourlyCandles(103, windowDays, { skip: (d) => d === "2026-07-31" }),
    201: hourlyCandles(201, windowDays, { space: true }),
    202: hourlyCandles(202, windowDays),
    502: hourlyCandles(502, windowDays),
    503: hourlyCandles(503, windowDays),
    601: hourlyCandles(601, windowDays, { onHour: true }),
    602: hourlyCandles(602, windowDays, { onHour: true, skip: (d, hh) => hh === "12" }),
    701: hourlyCandles(701, windowDays),
    702: hourlyCandles(702, windowDays, { skip: (d) => d === "2026-08-04" }),
    703: hourlyCandles(703, windowDays.slice(0, 3)),
  },
  fail_tokens: [501],
  ohlc: restOhlc,
};
const hp = (symbol, date, time, cur = 100, mid = 101, far = null) => ({
  symbol, date, time, month: date.slice(0, 7), current_month_close: cur, mid_month_close: mid, far_month_close: far, spread: mid - cur,
});
const slotsFor = (d) => (d >= "2026-08-03" ? ["10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "15:40"] : ["10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "15:30"]);
const existingHourly = [];
for (const d of ["2026-07-29", "2026-07-30", "2026-08-03", "2026-08-04"]) {
  for (const t of slotsFor(d)) {
    if (!(d === "2026-08-03" && t === "15:00")) existingHourly.push(hp("ALPHA", d, t));
    existingHourly.push(hp("M&M", d, t, 200, 202.5, null));
  }
}
for (const d of windowDays.slice(1)) {
  for (const t of slotsFor(d)) existingHourly.push(hp("GAMMA", d, t, 300, 301, 302));
}
existingHourly.push(hp("ALPHA", "2026-07-20", "10:00")); // before the window

const hourlyScenarios = [
  {
    name: "capture_live_and_rest", ...base, ticks: liveTicks, kite: { ohlc: restOhlc },
    steps: [
      { op: "capture", at: "2026-08-04T04:31:00Z", slot: "10:00" },
      { op: "drain" },
      { op: "capture", at: "2026-08-04T05:31:30Z" }, // no slot: "HH:00" of 11:01 IST
      { op: "drain" },
    ],
  },
  {
    name: "capture_without_kite_or_instruments", ...base, ticks: liveTicks, kite: { ohlc: restOhlc },
    steps: [
      { op: "capture", at: "2026-08-04T04:31:00Z", slot: "10:00", no_kite: true },
      { op: "capture", at: "2026-08-04T04:31:00Z", slot: "10:00", no_instruments: true },
      { op: "session", value: false },
      { op: "capture", at: "2026-08-04T04:31:00Z", slot: "10:00" },
      { op: "drain" },
    ],
  },
  {
    name: "capture_rest_failure", ...base, ticks: liveTicks, kite: { fail_quote: true },
    steps: [{ op: "capture", at: "2026-08-04T04:31:00Z", slot: "10:00" }, { op: "drain" }],
  },
  {
    name: "drain_stops_on_first_failure", ...base, ticks: liveTicks, kite: { ohlc: restOhlc },
    steps: [
      { op: "capture", at: "2026-08-04T04:31:00Z", slot: "10:00" },
      { op: "fail_writes", model: "hourlyprices", after: 2 },
      { op: "drain" },
      { op: "drain" },
      { op: "fail_writes", model: "hourlyprices", after: null },
      { op: "capture", at: "2026-08-04T05:31:00Z", slot: "11:00" },
      { op: "drain" },
    ],
  },
];
for (const [label, env] of [["default", undefined], ["2", "2"], ["0", "0"], ["abc", "abc"], ["neg", "-1"], ["2.5", "2.5"], ["0.51", "0.51"], ["0.52", "0.52"], ["hex", "0x2"], ["inf", "Infinity"]]) {
  hourlyScenarios.push({
    name: `backfill_lookback_${label}`, ...base, kite: hourlyKite, env: env === undefined ? {} : { HOURLY_BACKFILL_LOOKBACK_DAYS: env },
    db: { hourlyprices: existingHourly },
    steps: [{ op: "backfill", at: "2026-08-05T06:50:00Z" }, ...(label === "inf" ? [{ op: "backfill" }] : [])],
  });
}
hourlyScenarios.push(
  {
    name: "backfill_guards", ...base, kite: { ...hourlyKite, session: false }, db: { hourlyprices: existingHourly },
    steps: [
      { op: "backfill", at: "2026-08-05T06:50:00Z" },
      { op: "session", value: true },
      { op: "board_error", value: true },
      { op: "backfill" },
      { op: "board_error", value: false },
      { op: "backfill_concurrent" },
    ],
  },
  {
    name: "backfill_write_failure_releases_guard", ...base, kite: hourlyKite, env: { HOURLY_BACKFILL_LOOKBACK_DAYS: "1" },
    steps: [
      { op: "fail_writes", model: "hourlyprices", after: 3 },
      { op: "backfill", at: "2026-08-05T06:50:00Z" },
      { op: "fail_writes", model: "hourlyprices", after: null },
      { op: "backfill" },
    ],
  },
  {
    // The far leg's fetch fails after current and mid succeeded: the whole symbol is
    // skipped (one catch around the three calls), the others are still filled.
    name: "backfill_far_leg_failure", ...base, kite: { ...hourlyKite, fail_tokens: [103] }, env: { HOURLY_BACKFILL_LOOKBACK_DAYS: "1" },
    steps: [{ op: "backfill", at: "2026-08-05T06:50:00Z" }],
  },
);
const reviewDb = [];
for (const s of ["ALPHA", "BETA", "GAMMA", "NIFTY", "M&M", "EPS"]) {
  for (const t of slotsFor("2026-08-04")) if (!(s === "BETA" && t >= "14:00") && !(s === "EPS")) reviewDb.push(hp(s, "2026-08-04", t));
}
const fullDay = [];
for (const s of ["ALPHA", "BETA", "GAMMA", "NIFTY", "M&M", "EPS"]) for (const t of slotsFor("2026-08-04")) fullDay.push(hp(s, "2026-08-04", t));
hourlyScenarios.push(
  {
    name: "review_incomplete_then_backfill", ...base, kite: hourlyKite, env: { HOURLY_BACKFILL_LOOKBACK_DAYS: "1" }, db: { hourlyprices: reviewDb },
    steps: [{ op: "review", at: "2026-08-04T11:00:00Z" }],
  },
  { name: "review_complete", ...base, kite: hourlyKite, db: { hourlyprices: fullDay }, steps: [{ op: "review", at: "2026-08-04T11:00:00Z" }] },
  {
    name: "review_guards", ...base, kite: { ...hourlyKite, session: false }, db: { hourlyprices: reviewDb },
    steps: [
      { op: "review", at: "2026-08-08T11:00:00Z" }, // Saturday
      { op: "review", at: "2026-08-04T11:00:00Z" }, // no session
      { op: "board_error", value: true },
      { op: "review" },
    ],
  },
  {
    name: "review_no_eligible_symbols", board: [board[3]], instruments, kite: hourlyKite,
    steps: [{ op: "review", at: "2026-08-04T11:00:00Z" }],
  },
);
const at = (date, hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.parse(`${date}T00:00:00Z`) + (h * 60 + m - 330) * 60000).toISOString();
};
hourlyScenarios.push({
  name: "hourly_scheduler_windows", ...base, ticks: liveTicks, kite: { ohlc: restOhlc },
  steps: [
    { op: "start_hourly" },
    ...["09:14", "09:59", "10:00", "10:01", "10:03", "11:02", "12:30", "15:40", "15:41", "15:42"].map((t) => ({ op: "tick", name: "hourly-capture", at: at("2026-08-04", t) })),
    ...["15:00", "15:30", "15:31", "15:32", "15:33"].map((t) => ({ op: "tick", name: "hourly-capture", at: at("2026-07-31", t) })),
    { op: "board_error", value: true },
    { op: "tick", name: "hourly-capture", at: at("2026-08-05", "13:00") },
    { op: "board_error", value: false },
    { op: "tick", name: "hourly-capture", at: at("2026-08-05", "13:01") },
    { op: "tick", name: "hourly-capture", at: at("2026-08-05", "13:02") },
    { op: "tick", name: "hourly-capture", at: at("2026-08-08", "10:00") }, // Saturday
  ],
});
hourlyScenarios.push({
  // The REST fallback failure and the failed write are logged inside the capture and the
  // drain, so the slot is still marked: the rest of its window does not retry, and the
  // unwritten row goes out with the next slot's drain.
  name: "hourly_scheduler_failures_still_mark", ...base, ticks: liveTicks, kite: { fail_quote: true },
  steps: [
    { op: "start_hourly" },
    { op: "fail_writes", model: "hourlyprices", after: 1 },
    { op: "tick", name: "hourly-capture", at: at("2026-08-04", "10:00") },
    { op: "tick", name: "hourly-capture", at: at("2026-08-04", "10:01") },
    { op: "fail_writes", model: "hourlyprices", after: null },
    { op: "tick", name: "hourly-capture", at: at("2026-08-04", "11:00") },
  ],
});
// Candles without rnd(): adding them must not shift the random data of later scenarios.
const fixedCandles = (token, days) => {
  const rows = [];
  days.forEach((d, i) => {
    for (const [j, hh] of ["09", "10", "11", "12", "13", "14", "15"].entries()) {
      rows.push({ t: `${d}T${hh}:15:00+0530`, close: 100 + (token % 97) + i + j / 20 });
    }
  });
  return rows;
};
const muhuratDays = ["2026-08-07", "2026-08-08", "2026-08-10"]; // Fri, Sat (muhurat), Mon
hourlyScenarios.push({
  // EXTRA_SESSION_DAYS (a weekend session) is honoured only by index.ts isIstMarketHours:
  // the hourly, day-review and EOD schedulers skip the Saturday, and the gap backfill
  // never expects (or writes) its slots even when Kite has candles for it.
  name: "extra_session_days_ignored", ...base, ticks: liveTicks,
  kite: { hourly: { 101: fixedCandles(101, muhuratDays), 102: fixedCandles(102, muhuratDays), 103: fixedCandles(103, muhuratDays) } },
  env: { EXTRA_SESSION_DAYS: "2026-08-08", HOURLY_BACKFILL_LOOKBACK_DAYS: "3" },
  steps: [
    { op: "start_hourly" },
    { op: "start_review" },
    { op: "start_eod" },
    ...["09:30", "10:00", "11:01", "15:40"].map((t) => ({ op: "tick", name: "hourly-capture", at: at("2026-08-08", t) })),
    ...["15:45", "16:00"].map((t) => ({ op: "tick", name: "eod-capture", at: at("2026-08-08", t) })),
    { op: "tick", name: "day-review", at: at("2026-08-08", "16:30") },
    { op: "backfill", at: at("2026-08-10", "12:20") },
  ],
});
for (const [label, env] of [["default", undefined], ["17_05", "17:05"], ["hour_only", "17"], ["empty_minute", "17:"], ["junk", "abc:xyz"], ["fraction", "16.5:30"], ["hex", "0x10:0x1e"], ["spaces", " 9 : 5 "], ["seconds", "08:15:59"], ["empty", ""]]) {
  const times = ["00:30", "08:15", "08:17", "08:18", "09:05", "16:29", "16:30", "16:31", "16:32", "16:33", "17:00", "17:05", "17:07", "17:08"];
  hourlyScenarios.push({
    name: `day_review_time_${label}`, board: [board[1]], instruments, kite: { session: false },
    env: env === undefined ? {} : { DAY_REVIEW_TIME: env },
    steps: [
      { op: "start_review" },
      ...times.map((t) => ({ op: "tick", name: "day-review", at: at("2026-08-04", t) })),
      ...times.map((t) => ({ op: "tick", name: "day-review", at: at("2026-08-05", t) })),
      { op: "tick", name: "day-review", at: at("2026-08-08", "16:30") },
    ],
  });
}

// ---- EOD scenarios --------------------------------------------------------------------
const eodBoard = board.map((b) => ({ ...b, futures: b.futures.map((f, i) => ({ ...f, expiry: ["2026-03-26", "2026-04-28", "2026-05-26"][i] })) }));
const fullQuotes = {};
for (const b of eodBoard) {
  for (const f of b.futures) {
    if (!tsym[f.token] || f.token === 303) continue; // 303: no quote returned
    const close = f.token === 202 ? 0 : px(100 + f.token, 200 + f.token);
    fullQuotes[tsym[f.token]] = { instrument_token: f.token, last_price: close + 0.5, open: close - 1, high: close + 3, low: close - 4, close, oi: f.token * 1000 };
  }
}
const sf = (symbol, day, expiry, close, extra = {}) => ({
  trading_date: `${day}T00:00:00.000Z`, symbol, instrument: "FUTSTK", expiry: `${expiry}T00:00:00.000Z`,
  open: close - 1, high: close + 1, low: close - 2, close, settle_price: close, contracts: 0, value_lakh: 0, open_interest: 5000, change_in_oi: 0, ...extra,
});
const sd = (symbol, day, near, mid, nearClose, midClose) => ({
  symbol, trading_date: `${day}T00:00:00.000Z`, near_expiry: `${near}T00:00:00.000Z`, mid_expiry: `${mid}T00:00:00.000Z`,
  near_close: nearClose, mid_close: midClose, spread: midClose - nearClose,
});
function dailyCandles(token, days, opts = {}) {
  return days.filter((d) => !opts.skip?.(d)).map((d) => {
    const close = opts.zero?.(d) ? 0 : px(100 + token, 200 + token);
    return { date: d, open: close - 1, high: close + 2, low: close - 3, close, volume: 1000 + token, oi: token * 10 };
  });
}
const backfillDays = ["2026-03-04", "2026-03-05", "2026-03-06", "2026-03-09"];
const dailyKite = { full: fullQuotes, daily: {}, fail_tokens: [301] };
for (const b of eodBoard) for (const f of b.futures) dailyKite.daily[f.token] = dailyCandles(f.token, backfillDays, { zero: (d) => f.token === 102 && d === "2026-03-05" });
const cutoffDays = ["2025-12-29", "2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02", "2026-01-05"];
const cutoffKite = { daily: {} };
for (const b of eodBoard) for (const f of b.futures) cutoffKite.daily[f.token] = dailyCandles(f.token, cutoffDays);

const olderDaily = [];
for (const d of ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-09"]) {
  for (const s of ["ALPHA", "BETA", "GAMMA", "EPS", "OLDONLY"]) {
    const near = px(900, 1100);
    olderDaily.push(sd(s, d, "2026-03-26", "2026-04-28", near, Math.round((near + px(-5, 15)) * 100) / 100));
  }
}
const eodScenarios = [
  {
    name: "eod_scheduler_capture_and_summary", board: eodBoard, instruments, kite: { full: fullQuotes },
    db: {
      stock_futures_current: [sf("ALPHA", "2026-03-09", "2026-03-26", 1000)],
      spread_daily: olderDaily,
      spread_summary: [
        { _id: "65f000000000000000000001", symbol: "ALPHA", observations: 1, first_date: "2026-03-02T00:00:00.000Z", last_date: "2026-03-02T00:00:00.000Z", mean_spread: 1, max_spread: 1, min_spread: 1, mean_deviation: 0, max_abs_spread: 1, std_dev_spread: 0, percentile_95: 1, mean_reversion_probability: 0 },
        { _id: "65f000000000000000000002", symbol: "ZETA", observations: 3, first_date: "2025-01-02T00:00:00.000Z", last_date: "2025-01-06T00:00:00.000Z", mean_spread: 2, max_spread: 3, min_spread: 1, mean_deviation: 0.6667, max_abs_spread: 3, std_dev_spread: 0.8165, percentile_95: 3, mean_reversion_probability: 50 },
      ],
    },
    steps: [
      { op: "start_eod" },
      ...["15:44", "15:45", "15:46", "15:47", "15:48", "15:59", "16:00", "16:01", "16:03"].map((t) => ({ op: "tick", name: "eod-capture", at: at("2026-03-10", t) })),
      { op: "tick", name: "eod-capture", at: at("2026-03-14", "15:45") }, // Saturday
    ],
  },
  {
    name: "eod_scheduler_no_session_burns_day", board: eodBoard, instruments, kite: { full: fullQuotes, session: false },
    steps: [
      { op: "start_eod" },
      { op: "tick", name: "eod-capture", at: at("2026-03-10", "15:45") },
      { op: "session", value: true },
      { op: "tick", name: "eod-capture", at: at("2026-03-10", "15:46") },
      { op: "tick", name: "eod-capture", at: at("2026-03-11", "15:47") },
    ],
  },
  {
    name: "eod_scheduler_error_retries", board: eodBoard, instruments, kite: { full: fullQuotes },
    steps: [
      { op: "start_eod" },
      { op: "board_error", value: true },
      { op: "tick", name: "eod-capture", at: at("2026-03-10", "15:45") },
      { op: "board_error", value: false },
      { op: "tick", name: "eod-capture", at: at("2026-03-10", "15:46") },
      { op: "tick", name: "eod-capture", at: at("2026-03-10", "15:47") },
      { op: "nse_fno", value: false },
      { op: "tick", name: "eod-capture", at: at("2026-03-10", "16:00") },
      { op: "nse_fno", value: true },
      { op: "tick", name: "eod-capture", at: at("2026-03-10", "16:01") },
    ],
  },
  {
    name: "eod_capture_guards_and_write_failure", board: eodBoard, instruments, kite: { full: fullQuotes },
    steps: [
      { op: "capture_eod", at: at("2026-03-14", "15:45") }, // Saturday
      { op: "nse_fno", value: false },
      { op: "capture_eod", at: at("2026-03-10", "15:45") },
      { op: "nse_fno", value: true },
      { op: "fail_writes", model: "stock_futures_current", after: 4 },
      { op: "capture_eod" },
      { op: "fail_writes", model: "stock_futures_current", after: null },
      { op: "capture_eod" },
    ],
  },
  {
    name: "eod_capture_no_identifiers", board: eodBoard.filter((b) => b.is_index), instruments, kite: { full: fullQuotes },
    steps: [{ op: "capture_eod", at: at("2026-03-10", "15:45") }],
  },
  {
    name: "eod_backfill", board: eodBoard, instruments, kite: dailyKite,
    db: {
      stock_futures_current: [sf("ALPHA", "2026-03-04", "2026-03-26", 1000), sf("ALPHA", "2026-03-04", "2026-04-28", 1010), sf("ALPHA", "2026-02-27", "2026-03-26", 990)],
      stock_futures_archive: [sf("ALPHA", "2026-03-06", "2026-03-26", 1), sf("ALPHA", "2026-03-06", "2026-04-28", 2)],
    },
    steps: [{ op: "backfill_eod", at: "2026-03-10T03:30:00Z" }],
  },
  {
    name: "eod_backfill_across_cutoff", board: eodBoard, instruments, kite: cutoffKite,
    db: {
      stock_futures_current: [sf("BETA", "2025-12-29", "2026-01-27", 500)],
      stock_futures_archive: [
        sf("ALPHA", "2025-12-30", "2026-01-27", 1500.25), sf("ALPHA", "2025-12-30", "2026-02-24", 1512.8), sf("ALPHA", "2025-12-30", "2026-03-30", 1520.05),
        sf("BETA", "2025-12-30", "2026-01-27", 700), sf("ALPHA", "2026-01-02", "2026-01-27", 1),
      ],
    },
    steps: [{ op: "backfill_eod", at: "2026-01-06T03:30:00Z" }],
  },
  {
    name: "eod_backfill_guards", board: eodBoard, instruments, kite: { ...dailyKite, session: false },
    db: { stock_futures_archive: [sf("ALPHA", "2025-08-29", "2025-09-25", 1)] },
    steps: [
      { op: "backfill_eod", at: "2026-03-10T03:30:00Z" },
      { op: "session", value: true },
      { op: "nse_fno", value: false },
      { op: "backfill_eod" },
      { op: "nse_fno", value: true },
      { op: "backfill_eod" }, // archive rows do not count as seed data
    ],
  },
  {
    name: "eod_backfill_up_to_date", board: eodBoard, instruments, kite: dailyKite,
    db: { stock_futures_current: [sf("ALPHA", "2026-03-09", "2026-03-26", 1000)] },
    steps: [{ op: "backfill_eod", at: "2026-03-10T03:30:00Z" }, { op: "backfill_eod", at: "2026-03-09T20:00:00Z" }],
  },
  {
    name: "compute_spreads_routing",
    db: {
      stock_futures_current: [
        sf("ALPHA", "2026-01-02", "2026-02-24", 1012.4), sf("ALPHA", "2026-01-02", "2026-01-27", 1000.15), sf("ALPHA", "2026-01-02", "2026-03-30", 1030.9),
        sf("BETA", "2026-01-02", "2026-01-27", 0), sf("BETA", "2026-01-02", "2026-02-24", 510),
        sf("GAMMA", "2026-01-02", "2026-01-27", 300.3),
        sf("ALPHA", "2025-06-02", "2025-06-26", 5), sf("ALPHA", "2025-06-02", "2025-07-31", 6),
        sf("EPS", "2026-01-05", "2026-01-27", 70.05), sf("EPS", "2026-01-05", "2026-02-24", 70.1),
      ],
      stock_futures_archive: [
        sf("ALPHA", "2025-06-02", "2025-07-31", 812.35), sf("ALPHA", "2025-06-02", "2025-06-26", 800.1),
        sf("GAMMA", "2025-06-02", "2025-06-26", 300), sf("GAMMA", "2025-06-02", "2025-07-31", 0),
        sf("ALPHA", "2026-01-05", "2026-01-27", 1), sf("ALPHA", "2026-01-05", "2026-02-24", 9),
      ],
      spread_daily: [sd("ALPHA", "2026-01-02", "2026-01-27", "2026-02-24", 1, 2)],
    },
    steps: [
      { op: "compute", dates: [] },
      { op: "compute", dates: ["2025-06-02", "2025-09-01", "2026-01-02", "2026-01-05", "2026-01-06"] },
      { op: "nse_fno", value: false },
      { op: "compute", dates: ["2026-01-02"] },
    ],
  },
  {
    // A failed spread_daily upsert stops the drain with that row at the head of the queue;
    // the next computeSpreads queues its rows behind it and its drain writes them all.
    name: "compute_spreads_write_failure",
    db: {
      stock_futures_current: [
        sf("ALPHA", "2026-03-02", "2026-03-26", 1000), sf("ALPHA", "2026-03-02", "2026-04-28", 1010.5),
        sf("BETA", "2026-03-02", "2026-03-26", 500), sf("BETA", "2026-03-02", "2026-04-28", 503.25),
        sf("GAMMA", "2026-03-02", "2026-04-28", 299.95), sf("GAMMA", "2026-03-02", "2026-03-26", 300),
        sf("ALPHA", "2026-03-03", "2026-03-26", 1001), sf("ALPHA", "2026-03-03", "2026-04-28", 1012),
      ],
    },
    steps: [
      { op: "fail_writes", model: "spread_daily", after: 1 },
      { op: "compute", dates: ["2026-03-02"] },
      { op: "fail_writes", model: "spread_daily", after: null },
      { op: "compute", dates: ["2026-03-03"] },
    ],
  },
];

// Spread summary statistics.
const summaryDaily = [];
const dayList = (n, start = "2024-01-01") => {
  const out = [];
  const d = new Date(start + "T00:00:00Z");
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
};
for (let s = 0; s < 40; s++) {
  const n = 1 + Math.floor(rnd() * 160);
  const days = dayList(n, ["2024-01-01", "2025-03-03", "2026-01-01"][s % 3]);
  // Natural order deliberately not chronological.
  const order = days.map((d, i) => [rnd(), d, i]).sort((a, b) => a[0] - b[0]);
  for (const [, d] of order) {
    const near = px(50, 5000);
    const mid = Math.round((near + (rnd() * 40 - 12)) * 100) / 100;
    summaryDaily.push(sd(`S${String(s).padStart(2, "0")}`, d, "2026-12-31", "2027-01-28", near, mid));
  }
}
const special = {
  CONST: [2.5, 2.5, 2.5, 2.5],
  ONE: [7.35],
  TWO: [-1.2, 3.4],
  TIES: [1, 2, 3, 2, 2, 1, 3],
  HALFUP: [0.00005, 0.00005, 0.00005],
  HALFDOWN: [-0.00005, -0.00005],
  ROUNDING: [1.23455, 2.00005, -3.99995, 0.12345, 1e-9],
  ALT: [5, -5, 5, -5, 5, -5, 5, -5, 5, -5, 5],
  ZEROS: [0, 0, 0],
  NEG: [-10.5, -11.25, -9.75, -12.05, -10.0],
  BIG: Array.from({ length: 500 }, () => Math.round((rnd() * 60 - 20) * 100) / 100),
  P95_20: Array.from({ length: 20 }, (_, i) => i + 0.5),
  P95_21: Array.from({ length: 21 }, (_, i) => 21 - i),
};
for (const [sym, spreads] of Object.entries(special)) {
  const days = dayList(spreads.length, "2025-06-02");
  spreads.forEach((sp, i) => summaryDaily.push({ ...sd(sym, days[i], "2026-12-31", "2027-01-28", 100, 100), spread: sp }));
}
eodScenarios.push(
  {
    name: "recompute_summary_statistics",
    db: {
      spread_daily: summaryDaily,
      spread_summary: [
        { _id: "65f0000000000000000000aa", symbol: "S01", observations: 1, first_date: "2020-01-01T00:00:00.000Z", last_date: "2020-01-01T00:00:00.000Z", mean_spread: 0, max_spread: 0, min_spread: 0, mean_deviation: 0, max_abs_spread: 0, std_dev_spread: 0, percentile_95: 0, mean_reversion_probability: 0 },
        { _id: "65f0000000000000000000bb", symbol: "GONE", observations: 1, first_date: "2020-01-01T00:00:00.000Z", last_date: "2020-01-01T00:00:00.000Z", mean_spread: 0, max_spread: 0, min_spread: 0, mean_deviation: 0, max_abs_spread: 0, std_dev_spread: 0, percentile_95: 0, mean_reversion_probability: 0 },
      ],
    },
    steps: [{ op: "recompute" }],
  },
  {
    name: "recompute_summary_empty_daily_keeps_summary",
    db: { spread_summary: [{ _id: "65f0000000000000000000cc", symbol: "KEEP", observations: 1, first_date: "2020-01-01T00:00:00.000Z", last_date: "2020-01-01T00:00:00.000Z", mean_spread: 0, max_spread: 0, min_spread: 0, mean_deviation: 0, max_abs_spread: 0, std_dev_spread: 0, percentile_95: 0, mean_reversion_probability: 0 }] },
    steps: [{ op: "recompute" }, { op: "nse_fno", value: false }, { op: "recompute" }],
  },
  { name: "check_no_daily", steps: [{ op: "check" }] },
  { name: "check_no_summary", db: { spread_daily: olderDaily.slice(0, 8) }, steps: [{ op: "check" }] },
  {
    name: "check_daily_newer",
    db: { spread_daily: olderDaily.slice(0, 12), spread_summary: [{ _id: "65f0000000000000000000dd", symbol: "ALPHA", observations: 1, first_date: "2026-03-02T00:00:00.000Z", last_date: "2026-03-02T00:00:00.000Z", mean_spread: 0, max_spread: 0, min_spread: 0, mean_deviation: 0, max_abs_spread: 0, std_dev_spread: 0, percentile_95: 0, mean_reversion_probability: 0 }] },
    steps: [{ op: "check" }],
  },
  {
    name: "check_up_to_date",
    db: { spread_daily: olderDaily.slice(0, 5), spread_summary: [{ _id: "65f0000000000000000000ee", symbol: "ALPHA", observations: 1, first_date: "2026-03-02T00:00:00.000Z", last_date: "2026-03-02T00:00:00.000Z", mean_spread: 0, max_spread: 0, min_spread: 0, mean_deviation: 0, max_abs_spread: 0, std_dev_spread: 0, percentile_95: 0, mean_reversion_probability: 0 }] },
    steps: [{ op: "check" }, { op: "nse_fno", value: false }, { op: "check" }],
  },
);

const scenarios = [];
for (const sc of [...hourlyScenarios, ...eodScenarios]) scenarios.push(await run(clone(sc)));

// ---- pure helpers ---------------------------------------------------------------------
const hm = await freshModule(hourlyUrl);
const em = await freshModule(eodUrl);
const helpers = { slots_per_day: hm.SLOTS_PER_DAY, market_hours: {}, capture_slot: [], candle_slot: [], expected_slots: [], weekdays_between: [], is_weekday: {}, hour_key: [], market_open: [] };
for (const d of ["2026-07-31", "2026-08-02", "2026-08-03", "2026-12-31", "2025-01-01", "abc", "", "2026-08-03T10"]) helpers.market_hours[d] = hm.marketHoursFor(d);
for (const day of ["2026-07-31", "2026-08-03"]) {
  for (let m = 8 * 60; m <= 16 * 60 + 15; m++) {
    const t = Date.parse(`${day}T00:00:00Z`) + (m - 330) * 60000;
    now = t;
    const slot = hm.currentCaptureSlot(new Date(t + 5.5 * 3600000));
    if (slot !== null) helpers.capture_slot.push({ at: new Date(t).toISOString(), slot });
    else if (m % 7 === 0) helpers.capture_slot.push({ at: new Date(t).toISOString(), slot: null });
  }
}
const stamps = [];
for (const d of ["2026-07-31", "2026-08-03", "2025-02-30", "abcd-ef-gh"]) {
  for (const hh of ["00", "08", "09", "10", "11", "12", "13", "14", "15", "16", "-1", "9:", " 9"]) {
    for (const mm of ["00", "15", "30", "16", "1:"]) {
      stamps.push(`${d}T${hh}:${mm}:00+0530`, `${d} ${hh}:${mm}:00`);
    }
  }
}
stamps.push("", "2026-08-03", "2026-08-03T", "x", "2026-08-03T9:15", "2026-08-03 1:15:00", "2026-08-03TT09:15", "T2026-08-03 09:15", "2026-08-0309:15:00");
for (const s of stamps) helpers.candle_slot.push({ t: s, key: hm.candleToSlotKey(s) });
for (const [a, b, e] of [
  ["2026-07-29", "2026-08-05", "12:00"], ["2026-08-01", "2026-08-03", "15:40"], ["2026-08-03", "2026-08-03", "09:00"],
  ["2026-08-03", "2026-08-03", "15:00"], ["2026-08-03", "2026-08-03", "16:00"], ["2026-08-05", "2026-08-04", "12:00"],
  ["2026-07-31", "2026-07-31", "15:30"], ["+275760-09", "2026-08-05", "12:00"], ["2026-02-27", "2026-03-02", "10:00"],
]) helpers.expected_slots.push({ start: a, end: b, end_time: e, slots: hm.allExpectedSlots(a, b, e) });
for (const [a, b] of [
  ["2026-03-04", "2026-03-09"], ["2026-03-09", "2026-03-09"], ["2026-03-10", "2026-03-09"], ["2025-12-29", "2026-01-05"],
  ["2026-02-27", "2026-03-02"], ["2024-02-28", "2024-03-01"], ["bad", "2026-03-09"], ["2026-03-04", ""], ["2026-02-30", "2026-03-04"],
]) helpers.weekdays_between.push({ start: a, end: b, days: em.getWeekdaysBetween(a, b) });
for (const d of ["2026-03-07", "2026-03-08", "2026-03-09", "garbage", "", "2026-02-30", "2026-02-32", "2026", "2026-01", "+002026-03-07"]) {
  helpers.is_weekday[d] = [hm.isWeekday(d), em.isWeekday(d)];
}
for (let i = 0; i < 60; i++) {
  now = Date.parse("2026-08-02T18:00:00Z") + Math.floor(rnd() * 7 * 86400000);
  helpers.hour_key.push({ at: new Date(now).toISOString(), key: hm.istHourKey() });
  helpers.market_open.push({ at: new Date(now).toISOString(), open: hm.isMarketOpen() });
}

// Summary statistics per symbol straight from the recompute scenario.
const summaryScenario = scenarios.find((s) => s.name === "recompute_summary_statistics");

// ---- Yahoo ----------------------------------------------------------------------------
const YNOW = Date.parse("2026-10-27T06:00:00Z");
const ys = YNOW / 1000;
const day = 86400;
const chart = (meta, events) => JSON.stringify({ chart: { result: [{ meta, ...(events === undefined ? {} : { events }) }], error: null } });
const divs = (...rows) => Object.fromEntries(rows.map(([k, v]) => [String(k), v]));
const yahooCases = [
  { symbol: "RELIANCE", body: chart({ regularMarketPrice: 2500.5, chartPreviousClose: 2400 }, { dividends: divs([ys - 30 * day, { amount: 5.5, date: ys - 30 * day }], [ys - 200 * day, { amount: 4.25, date: ys - 200 * day }]) }) },
  { symbol: "M&M", body: chart({ regularMarketPrice: 3012.35 }, { dividends: divs([ys - 100 * day, { amount: 21.1, date: ys - 100 * day }]) }) },
  { symbol: "BAJAJ-AUTO", body: chart({ regularMarketPrice: 9000 }, { dividends: divs([ys - 10 * day, { amount: 80, date: ys - 10 * day }]) }) },
  { symbol: "L&T FIN", body: chart({ regularMarketPrice: 150.75 }, { dividends: {} }) },
  { symbol: "ÉTOILE*(x)!~'", body: chart({ regularMarketPrice: 99 }, { dividends: divs([ys - 5 * day, { amount: 1, date: ys - 5 * day }]) }) },
  { symbol: "A/B?C#D%E+F=G", body: chart({ regularMarketPrice: 10 }, { dividends: divs([ys - 5 * day, { amount: 0.3 }]) }) },
  {
    symbol: "SUMORDER",
    body: `{"chart":{"result":[{"meta":{"regularMarketPrice":7},"events":{"dividends":{"${ys - 3 * day}":{"amount":0.3},"${ys - 50 * day}":{"amount":0.1},"z":{"amount":0.7,"date":${ys}},"${ys - 9 * day}":{"amount":0.2},"9999999999":{"amount":0.05},"a":{"amount":0.11,"date":${ys}}}}}]}}`,
  },
  { symbol: "OLD", body: chart({ regularMarketPrice: 100 }, { dividends: divs([ys - 400 * day, { amount: 9, date: ys - 400 * day }], [ys - 365 * day, { amount: 2, date: ys - 365 * day }], [ys - 365 * day - 1, { amount: 3, date: ys - 365 * day - 1 }]) }) },
  { symbol: "DATESTR", body: chart({ regularMarketPrice: 100 }, { dividends: { x: { amount: 1, date: String(ys - day) }, y: { amount: 2, date: "soon" }, w: { amount: 4, date: [ys - day] }, v: { amount: 8, date: true }, u: { amount: 16, date: null } } }) },
  { symbol: "AMTSTR", body: chart({ regularMarketPrice: 100 }, { dividends: divs([ys - day, { amount: "5", date: ys - day }], [ys - 2 * day, { amount: null }], [ys - 3 * day, null], [ys - 4 * day, 7]) }) },
  { symbol: "PREV", body: chart({ chartPreviousClose: 400 }, { dividends: divs([ys - day, { amount: 4 }]) }) },
  { symbol: "PRICENULL", body: chart({ regularMarketPrice: null, chartPreviousClose: 400 }, { dividends: divs([ys - day, { amount: 4 }]) }) },
  { symbol: "PRICE0", body: chart({ regularMarketPrice: 0, chartPreviousClose: 400 }, { dividends: divs([ys - day, { amount: 4 }]) }) },
  { symbol: "PRICENEG", body: chart({ regularMarketPrice: -5 }, { dividends: divs([ys - day, { amount: 4 }]) }) },
  { symbol: "PRICESTR", body: chart({ regularMarketPrice: "250" }, { dividends: divs([ys - day, { amount: 4 }]) }) },
  { symbol: "PRICESTR0", body: chart({ regularMarketPrice: "0" }, { dividends: divs([ys - day, { amount: 4 }]) }) },
  { symbol: "PRICEBAD", body: chart({ regularMarketPrice: "abc" }, { dividends: divs([ys - day, { amount: 4 }]) }) },
  { symbol: "PRICEARR", body: chart({ regularMarketPrice: [250] }, { dividends: divs([ys - day, { amount: 4 }]) }) },
  { symbol: "PRICEARR2", body: chart({ regularMarketPrice: [250, 1] }, { dividends: divs([ys - day, { amount: 4 }]) }) },
  { symbol: "PRICEARR0", body: chart({ regularMarketPrice: [] }, { dividends: divs([ys - day, { amount: 4 }]) }) },
  { symbol: "PRICEOBJ", body: chart({ regularMarketPrice: {} }, { dividends: divs([ys - day, { amount: 4 }]) }) },
  { symbol: "PRICETRUE", body: chart({ regularMarketPrice: true }, { dividends: divs([ys - day, { amount: 4 }]) }) },
  { symbol: "NOEVENTS", body: chart({ regularMarketPrice: 100 }) },
  { symbol: "EVENTSNULL", body: chart({ regularMarketPrice: 100 }, null) },
  { symbol: "DIVNULL", body: chart({ regularMarketPrice: 100 }, { dividends: null }) },
  { symbol: "DIVARR", body: chart({ regularMarketPrice: 100 }, { dividends: [{ amount: 1, date: ys - day }, { amount: 2 }] }) },
  { symbol: "DIVSTR", body: chart({ regularMarketPrice: 100 }, { dividends: "ab" }) },
  { symbol: "DIVNUM", body: chart({ regularMarketPrice: 100 }, { dividends: 5 }) },
  { symbol: "NORESULT", body: '{"chart":{"result":[]}}' },
  { symbol: "NULLRESULT", body: '{"chart":{"result":null,"error":{"code":"Not Found"}}}' },
  { symbol: "RESULTOBJ", body: `{"chart":{"result":{"0":{"meta":{"regularMarketPrice":50},"events":{"dividends":{"${ys - day}":{"amount":1}}}}}}}` },
  { symbol: "RESULTSTR", body: '{"chart":{"result":"abc"}}' },
  { symbol: "RESULT0", body: '{"chart":{"result":[0]}}' },
  { symbol: "NOCHART", body: "{}" },
  { symbol: "CHARTARR", body: '{"chart":[{"result":[]}]}' },
  { symbol: "NULLJSON", body: "null" },
  { symbol: "NUMJSON", body: "5" },
  { symbol: "STRJSON", body: '"chart"' },
  { symbol: "BADJSON", body: "{not json" },
  { symbol: "TRAILING", body: '{"chart":{}} x' },
  { symbol: "EMPTYBODY", body: "" },
  { symbol: "BOM", body: "\uFEFF" + chart({ regularMarketPrice: 100 }, { dividends: divs([ys - day, { amount: 4 }]) }) },
  { symbol: "WS", body: " \n\t" + chart({ regularMarketPrice: 100 }, { dividends: divs([ys - day, { amount: 4 }]) }) + "\n " },
  { symbol: "DUPKEY", body: `{"chart":{"result":[{"meta":{"regularMarketPrice":100},"events":{"dividends":{"b":{"amount":1,"date":${ys}},"a":{"amount":0.1,"date":${ys}},"b":{"amount":0.2,"date":${ys}}}}}]}}` },
  { symbol: "HUGEPRICE", body: `{"chart":{"result":[{"meta":{"regularMarketPrice":1e400},"events":{"dividends":{"${ys - day}":{"amount":1}}}}]}}` },
  { symbol: "TINYPRICE", body: `{"chart":{"result":[{"meta":{"regularMarketPrice":5e-324},"events":{"dividends":{"${ys - day}":{"amount":1}}}}]}}` },
  { symbol: "HUGEAMOUNT", body: `{"chart":{"result":[{"meta":{"regularMarketPrice":10},"events":{"dividends":{"${ys - day}":{"amount":1e400}}}}]}}` },
  { symbol: "HTTP404", status: 404, body: chart({ regularMarketPrice: 100 }, { dividends: divs([ys - day, { amount: 4 }]) }) },
  { symbol: "HTTP429", status: 429, body: "Too Many Requests" },
  { symbol: "HTTP302", status: 302, body: "moved" },
  { symbol: "HTTP201", status: 201, body: chart({ regularMarketPrice: 100 }, { dividends: divs([ys - day, { amount: 4 }]) }) },
  { symbol: "NETERR", network_error: true },
];
const CHART_ROOT = "https://query1.finance.yahoo.com/v8/finance/chart";
const byUrl = new Map();
for (const c of yahooCases) byUrl.set(`${CHART_ROOT}/${encodeURIComponent(c.symbol)}.NS?range=1y&interval=1mo&events=div`, c);
const fetchCalls = [];
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), headers: { ...init.headers } });
  const c = byUrl.get(String(url));
  if (!c || c.network_error) throw new TypeError("fetch failed");
  return new Response(c.body, { status: c.status ?? 200 });
};
const enc = (x) => (Number.isNaN(x) ? "NaN" : x === Infinity ? "Infinity" : x === -Infinity ? "-Infinity" : x);
now = YNOW;
const ym = await freshModule(yahooUrl);
const yahoo = { now: new Date(YNOW).toISOString(), chart_root: CHART_ROOT, cases: [], yields: [] };
for (const c of yahooCases) {
  fetchCalls.length = 0;
  // A rejection (e.g. `json.chart` on null) is what getDividendYields' .catch maps to 0.
  let rejected = false;
  const v = await ym.fetchYieldPct(c.symbol).catch(() => ((rejected = true), 0));
  const call = fetchCalls[0];
  yahoo.cases.push({ ...c, request: call ? { path: call.url.slice(CHART_ROOT.length), headers: call.headers } : null, yield: enc(v), rejected });
}
const allSymbols = ["RELIANCE", "", "M&M", "RELIANCE", ...yahooCases.map((c) => c.symbol)];
for (const conc of [undefined, 1, 2, 0, -1, 100]) {
  fetchCalls.length = 0;
  const r = await ym.getDividendYields(allSymbols, conc);
  yahoo.yields.push({
    concurrency: conc === undefined ? 6 : conc,
    symbols: allSymbols,
    result: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, enc(v)])),
    requests: fetchCalls.map((f) => f.url.slice(CHART_ROOT.length)).sort(),
  });
}

// ---- JavaScript primitives the Go helpers (jsutil.go) stand in for ------------------------
// Inputs that JSON cannot carry (NaN, Infinity, -0) travel as strings; "in" is the input.
const numIn = (x) => (Number.isNaN(x) ? "NaN" : x === Infinity ? "Infinity" : x === -Infinity ? "-Infinity" : Object.is(x, -0) ? "-0" : x);
const jsutil = { parse_int: [], num_string: [], pad2: [], parse_day: [], iso_string: [], encode: [] };
for (const s of ["", "0", "7", "07", " 12", "\t\n 15abc", "+9", "-3", "-", "+", "abc", "1e3", "0x1F", "12.9", "٣", "９", "\u00a09", "\ufeff9", "\u20289", "\u200b9", "99999999999999999999", "-0", "0x", "1_0", "00", "9 ", "1.", ".5", "NaN", "Infinity"]) {
  jsutil.parse_int.push({ in: s, out: enc(parseInt(s, 10)) });
}
for (const x of [0, -0, 1, -1, 1.5, 100, 1e20, 1e21, 1.5e21, 1e-6, 1e-7, 1.5e-7, 123456789012345680000, 12345678901234567890, 5e-324, 1.7976931348623157e308, 0.1 + 0.2, 16.5, 16, 30, 2 ** 53, -1e21, -1e-7, NaN, Infinity, -Infinity]) {
  jsutil.num_string.push({ in: numIn(x), out: String(x) });
  jsutil.pad2.push({ in: numIn(x), out: String(x).padStart(2, "0") });
}
for (const s of [
  "2026-03-07", "2026-02-28", "2026-02-29", "2026-02-30", "2026-02-31", "2026-02-32", "2024-02-29", "2024-02-30", "2024-02-31", "2025-04-31", "2025-04-30",
  "2026", "2026-1", "2026-01", "2026-3-7", "+002026-03-07", "-000001-01-01", "-000000-01-01", "+275760-09-13", "+275760-09-14", "275760-09-13", "+275760-09",
  "0000-01-01", "0001-01-01", "9999-12-31", "10000-01-01", "+010000-01-01", "2026-13-01", "2026-00-10", "2026-01-00", "2026-01-32", "1970-01-01", "1969-12-31",
  "abc", "", " 2026-03-07", "2026-03-07 ", "2026-03-07T01", "2026-03-07Z", "2026-03", "2026-03-", "T", "0", "12", "1e3", "2026-03-07\n",
]) {
  const t = new Date(s + "T00:00:00Z").getTime();
  const t2 = new Date(s + "T00:00:00.000Z").getTime();
  jsutil.parse_day.push({ in: s, ms: Number.isNaN(t) ? null : t, ms_millis_form: Number.isNaN(t2) ? null : t2 });
}
for (const x of [0, 1, -1, 1.5, -1.5, 0.9, -0.9, 86400000, 1785000000000.7, -1785000000000.7, 8.64e15, 8.64e15 + 2, 8.64e15 + 1, -8.64e15, -8.64e15 - 1, -62198755200000, -62167219200000, -62167219200001, 253402300799999, 253402300800000, 1e16, NaN, Infinity, -Infinity]) {
  let out = null;
  try {
    out = new Date(x).toISOString();
  } catch {
    out = null;
  }
  jsutil.iso_string.push({ in: numIn(x), out });
}
for (const s of ["", "RELIANCE", "M&M", "A/B?C#D%E+F=G", "ÉTOILE*(x)!~'", "日本語", "😀", " ", "a b", "-_.!~*'()", "\u0000", "\u007f", "~", "\u00ff", "a%20b", "\u2028", "[]{}|\\^`\"<>"]) {
  jsutil.encode.push({ in: s, out: encodeURIComponent(s) });
}

const meta = { generated_from: "src/eodCapture.ts, src/hourlyCapture.ts, src/yahoo.ts (Node " + process.version + ")" };
writeFileSync(join(here, "jsutil.json"), JSON.stringify({ ...meta, ...jsutil }, null, 1) + "\n");
writeFileSync(join(here, "scenarios.json"), JSON.stringify({ ...meta, scenarios }, null, 1) + "\n");
writeFileSync(join(here, "helpers.json"), JSON.stringify({ ...meta, ...helpers }, null, 1) + "\n");
writeFileSync(join(here, "summary.json"), JSON.stringify({ ...meta, spread_daily: summaryScenario.db.spread_daily, summary: summaryScenario.expected.db.spread_summary }, null, 1) + "\n");
writeFileSync(join(here, "yahoo.json"), JSON.stringify({ ...meta, ...yahoo }, null, 1) + "\n");
out(`wrote ${scenarios.length} scenarios, ${helpers.candle_slot.length} candle stamps, ${yahoo.cases.length} yahoo cases`);
