// Golden generator for internal/analytics: drives the ORIGINAL NIFTY OI analytics of
// src/index.ts (loaded verbatim by harness.mjs) through scripted scenarios and records,
// per operation, every broker call with its answer (the Go test replays this tape), the
// pacing delays, the analytics log lines, the Upstash pipeline bodies, the route
// responses and state snapshots. Pure helpers are recorded case by case.
//
//   TZ=UTC scratch/go-migration/check.sh node --experimental-strip-types internal/analytics/testdata/gen_analytics.mjs
//
// Writes internal/analytics/testdata/analytics.golden.json. No network: the Kite, history
// and quote fakes are local functions and Redis is an in-memory emulation.
import fs from "node:fs";
import path from "node:path";
import querystring from "node:querystring";
import { fileURLToPath } from "node:url";

const EXTRA = " 2026-11-08 , junk,,2026-11-01";
process.env.EXTRA_SESSION_DAYS = EXTRA;
const { loadAnalytics, clock, timers, logs, FakeRedis, redis, drain, rng } = await import("./harness.mjs");

const here = path.dirname(fileURLToPath(import.meta.url));
const IST = 19_800_000;
const MIN = 60_000;
const istMs = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => Date.UTC(y, mo - 1, d, h, mi, s, ms) - IST;
const range = (a, b, step) => {
  const out = [];
  for (let x = a; x <= b; x += step) out.push(x);
  return out;
};
const pad = (n) => String(n).padStart(2, "0");
const istParts = (t) => {
  const d = new Date(t + IST);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), dow: d.getUTCDay() };
};
const istStamp = (t) => {
  const p = istParts(t);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
};
const kiteCandleStamp = (t) => {
  const p = istParts(t);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:00+0530`;
};
/** Parses "YYYY-MM-DD HH:MM:SS" as IST. */
const parseIst = (s) => istMs(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16), +s.slice(17, 19));

// ---------------------------------------------------------------------------
// Instrument universes (Kite instrument rows).

function inst(o) {
  return { instrument_token: 0, exchange_token: 0, tradingsymbol: "", name: "", last_price: 0, expiry: "", strike: 0, tick_size: 0.05, lot_size: 0, instrument_type: "", segment: "", exchange: "", ...o };
}
function optionRows(name, expiries, strikes, base, { lot = 75, skipPe = [] } = {}) {
  const rows = [];
  expiries.forEach((e, ei) => strikes.forEach((k, si) => {
    for (const [ti, type] of ["CE", "PE"].entries()) {
      if (type === "PE" && skipPe.includes(k)) continue;
      rows.push(inst({ instrument_token: base + ei * 100_000 + si * 2 + ti, tradingsymbol: `${name}${e.replaceAll("-", "").slice(2)}${k}${type}`, name, expiry: e, strike: k, lot_size: lot, instrument_type: type, segment: "NFO-OPT", exchange: "NFO" }));
    }
  }));
  return rows;
}
const niftySpot = inst({ instrument_token: 256265, tradingsymbol: "NIFTY 50", name: "NIFTY 50", segment: "INDICES", exchange: "NSE", instrument_type: "EQ" });
const niftyFuts = [["2026-11-24", 13_000_002], ["2026-10-27", 13_000_001], ["2026-11-24", 13_000_009], ["2026-12-29", 13_000_003], ["2027-01-26", 13_000_004], ["2026-09-29", 13_000_000]]
  .map(([e, tok]) => inst({ instrument_token: tok, tradingsymbol: `NIFTY${e.replaceAll("-", "").slice(2)}FUT`, name: "NIFTY", expiry: e, lot_size: 75, instrument_type: "FUT", segment: "NFO-FUT", exchange: "NFO" }));
function niftyUniverse(strikes, { extraRows = [] } = {}) {
  return [
    niftySpot,
    ...optionRows("NIFTY", ["2026-10-27", "2026-11-03"], strikes, 10_000_000),
    ...optionRows("NIFTY", ["2026-10-20"], strikes.slice(0, 3), 10_900_000),
    inst({ instrument_token: 10_999_999, tradingsymbol: "NIFTYZERO", name: "NIFTY", expiry: "2026-10-27", strike: 0, lot_size: 75, instrument_type: "CE", segment: "NFO-OPT", exchange: "NFO" }),
    ...niftyFuts,
    ...extraRows,
  ];
}
const WIDE = range(24000, 27000, 50); // 61 strikes: the window (26 below, 24 above) is narrower
const SMALL = range(24750, 25250, 50); // 11 strikes
const MID = range(24500, 25500, 50); // 21 strikes
const universes = {
  wide: niftyUniverse(WIDE, {
    // A later duplicate of a token (meta keeps the first position, takes the value).
    extraRows: [inst({ instrument_token: 10_000_000, tradingsymbol: "NIFTY2610272400CE", name: "NIFTY", expiry: "2026-10-27", strike: 24000, lot_size: 75, instrument_type: "CE", segment: "NFO-OPT", exchange: "NFO" })],
  }),
  small: niftyUniverse(SMALL),
  mid: niftyUniverse(MID),
  // Next day's nearest expiry for the roll scenario (the 2026-10-27 weekly has expired).
  smallNextWeek: [niftySpot, ...optionRows("NIFTY", ["2026-11-03"], SMALL, 10_100_000), ...niftyFuts],
  chain: [
    ...niftyUniverse(SMALL),
    inst({ instrument_token: 260105, tradingsymbol: "NIFTY BANK", name: "NIFTY BANK", segment: "INDICES", exchange: "NSE", instrument_type: "EQ" }),
    ...optionRows("BANKNIFTY", ["2026-10-28", "2026-11-25"], range(50000, 54000, 500), 20_000_000, { lot: 35, skipPe: [51000] }),
    inst({ instrument_token: 738561, tradingsymbol: "RELIANCE", name: "RELIANCE INDUSTRIES", segment: "NSE", exchange: "NSE", instrument_type: "EQ" }),
    ...optionRows("RELIANCE", ["2026-10-29"], range(2800, 3200, 50), 30_000_000, { lot: 500 }),
    ...optionRows("FINNIFTY", ["2026-10-28"], range(23000, 23400, 100), 40_000_000, { lot: 65 }),
    ...optionRows("OLDCO", ["2026-10-01"], range(100, 140, 10), 50_000_000, { lot: 1000 }),
    inst({ instrument_token: 60_000_001, tradingsymbol: "ZEROCE", name: "ZERO", expiry: "2026-10-29", strike: 0, lot_size: 10, instrument_type: "CE", segment: "NFO-OPT", exchange: "NFO" }),
    inst({ instrument_token: 60_000_009, tradingsymbol: "ZERO", name: "ZERO", segment: "NSE", exchange: "NSE", instrument_type: "EQ" }),
  ],
};
const byId = new Map();
for (const rows of Object.values(universes)) for (const i of rows) byId.set(`${i.exchange}:${i.tradingsymbol}`, i);
const byToken = new Map();
for (const rows of Object.values(universes)) for (const i of rows) if (!byToken.has(i.instrument_token)) byToken.set(i.instrument_token, i);

// ---------------------------------------------------------------------------
// Market data fakes. Values are deterministic functions of the token and the minute.

const round2 = (x) => Math.round(x * 100) / 100;
function spotAt(t, cfg) {
  const m = Math.floor((t + IST) / MIN);
  return round2(25012.35 + (cfg.spotDrift ?? 3.7) * ((m % 600) - 300) / 10 + (cfg.spotShift ?? 0));
}
function oiOf(tok, t, cfg) {
  const m = Math.floor((t + IST) / MIN);
  const r = rng(tok * 31 + (cfg.oiSeed ?? 7))();
  return 75 * (1000 + Math.floor(r * 4000) + ((m * (tok % 13)) % 97));
}
function priceOf(i, t, cfg) {
  if (i.instrument_type === "FUT") return round2(spotAt(t, cfg) + 60 + (i.instrument_token % 7) * 25);
  const s = spotAt(t, cfg);
  const intrinsic = i.instrument_type === "CE" ? Math.max(0, s - i.strike) : Math.max(0, i.strike - s);
  return round2(intrinsic + 40 + ((i.instrument_token * 7) % 23) * 1.35);
}

const env = {
  broker: "zerodha",
  token: "access-token",
  ready: true,
  problems: [],
  universe: "wide",
  universeFail: null,
  quotes: {},
  hist: {},
  spotQuote: { price: 25010.5 },
};
let tape = [];
let delays = [];
const histCalls = new Map();

class KiteError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "KiteError";
    this.status = status;
  }
}

function fail(f, label) {
  if (!f) return;
  if (typeof f === "object") throw new KiteError(f.message, f.status);
  throw new Error(f === true ? `${label} failed` : f);
}
function record(fn, args, run) {
  try {
    const result = run();
    tape.push({ fn, args, result });
    return result;
  } catch (e) {
    tape.push({ fn, args, error: e.message, ...(e instanceof KiteError ? { status: e.status } : {}) });
    throw e;
  }
}

function quoteFull(ids) {
  return record("quoteFull", { ids }, () => {
    const cfg = env.quotes;
    fail(cfg.fail, "quote");
    const out = [];
    for (const id of ids) {
      const i = byId.get(id);
      if (!i) continue;
      const tok = i.instrument_token;
      if ((cfg.missing ?? []).includes(tok)) continue;
      if (out.some((q) => q.instrument_token === tok)) continue;
      const t = clock.now;
      let stamp = istStamp(t);
      if (cfg.stamp === "yesterday") stamp = istStamp(t - 86_400_000);
      else if (cfg.stamp === "none") stamp = "";
      else if (cfg.stamp === "junk") stamp = "27-10-2026 09:15";
      const isSpot = i.segment === "INDICES";
      const last = isSpot ? spotAt(t, cfg) : priceOf(i, t, cfg);
      out.push({
        instrument_token: tok,
        last_price: (cfg.zeroLtp ?? []).includes(tok) ? 0 : last,
        close: round2(last - 3),
        oi: isSpot || (cfg.zeroOi ?? []).includes(tok) ? 0 : oiOf(tok, t, cfg),
        last_trade_time: stamp,
      });
    }
    return out;
  });
}

function sessionMinutes(fromMs, toMs) {
  const out = [];
  for (let t = Math.ceil(fromMs / MIN) * MIN; t <= toMs; t += MIN) {
    const p = istParts(t);
    if (p.dow === 0 || p.dow === 6) continue;
    const mins = p.h * 60 + p.mi;
    if (mins < 9 * 60 + 15 || mins > 15 * 60 + 39) continue;
    out.push(t);
  }
  return out;
}
function histFailure(tok, cfg) {
  const n = (histCalls.get(tok) ?? 0) + 1;
  histCalls.set(tok, n);
  const f = cfg.fail?.[tok];
  if (f === undefined) return null;
  if (f === "always" || n <= f) return "Too many requests";
  return null;
}
const history = {
  async getHistorical(token, from, to, interval, prio) {
    return record("historical", { token, from, to, interval, prio }, () => {
      const cfg = env.hist;
      const why = histFailure(token, cfg);
      if (why) throw new KiteError(why, 429);
      if (cfg.emptySpot) return [];
      return sessionMinutes(parseIst(from), parseIst(to)).map((t) => ({ t: kiteCandleStamp(t), close: spotAt(t, cfg) }));
    });
  },
  async getHistoricalOiSeries(token, from, to, interval, prio) {
    return record("historicalOiSeries", { token, from, to, interval, prio }, () => {
      const cfg = env.hist;
      const why = histFailure(token, cfg);
      if (why) throw new KiteError(why, 429);
      if (cfg.failAllDaily && interval === "day") throw new Error("daily candles unavailable");
      if ((cfg.empty ?? []).includes(token)) return [];
      const i = byToken.get(token);
      if (interval === "day") {
        const out = [];
        for (let t = Math.floor((parseIst(from) + IST) / 86_400_000) * 86_400_000 - IST; t <= parseIst(to); t += 86_400_000) {
          const p = istParts(t);
          if (p.dow === 0 || p.dow === 6) continue;
          if ((cfg.skipDays ?? []).includes(`${p.y}-${pad(p.mo)}-${pad(p.d)}`)) continue;
          const close15 = t + (15 * 60 + 29) * MIN;
          const isSpot = i.segment === "INDICES";
          if (!isSpot && (cfg.shortHistory ?? []).includes(token) && p.d > 23 && p.mo === 10) continue;
          out.push({ t: `${p.y}-${pad(p.mo)}-${pad(p.d)}T00:00:00+0530`, close: isSpot ? spotAt(close15, cfg) : priceOf(i, close15, cfg), oi: isSpot || (cfg.zeroOi ?? []).includes(token) ? 0 : oiOf(token, close15, cfg) });
        }
        return out;
      }
      return sessionMinutes(parseIst(from), parseIst(to)).map((t) => ({ t: kiteCandleStamp(t), close: priceOf(i, t + MIN, cfg), oi: oiOf(token, t + MIN, cfg) }));
    });
  },
};

const routes = new Map();
const fakeEnv = {
  brokerManager: {
    get activeBroker() { return env.broker; },
    activeHealth: () => ({ data_ready: env.ready, problems: env.problems }),
    instrumentProvider: {
      load: async () => {
        if (env.universeFail) throw new Error(env.universeFail);
        return universes[env.universe];
      },
    },
    quoteProvider: {
      quotesByToken: async (tokens) => record("quotesByToken", { tokens }, () => {
        const q = env.spotQuote;
        fail(q.fail, "quotesByToken");
        if (q.empty) return [];
        return tokens.map((t) => ({ token: t, last_price: q.price, close_price: 0, oi: 0, bid: 0, ask: 0 }));
      }),
    },
  },
  kite: {
    getAccessToken: () => env.token,
    getQuoteFull: async (ids) => quoteFull(ids),
    clearSession: () => { tape.push({ fn: "clearSession" }); env.token = null; },
  },
  history,
  KiteError,
  clearKiteSession: async () => {},
  app: { get: (p, h) => routes.set(p, h) },
  delay: async (ms) => { delays.push(ms); },
};

// ---------------------------------------------------------------------------
// The op interpreter.

let H = null;
const replacer = (_k, v) => (typeof v === "number" && !Number.isFinite(v) ? { $num: String(v) } : v);
const clone = (v) => JSON.parse(JSON.stringify(v));

function observe(parts) {
  const out = {};
  for (const part of parts) {
    switch (part) {
      case "frames":
        out.frames = {
          opt: Object.fromEntries(H.OI_FRAME_KEYS.map((k) => [k, clone(H.oiFrameStores[k].points)])),
          fut: Object.fromEntries(H.OI_FRAME_KEYS.map((k) => [k, clone(H.futOiFrameStores[k].points)])),
        };
        break;
      case "day": {
        const d = H.optionOiDay;
        out.day = d && {
          day: d.day, expiry: d.expiry, spotToken: d.spotToken, window: d.window ?? null,
          meta: [...d.meta].map(([tok, m]) => [tok, m.strike, m.type]),
          series: [...d.series].map(([tok, arr]) => [tok, arr.map((s) => [s.t, s.oi, s.ltp])]),
          spot: d.spot.map((s) => [s.t, s.ltp]),
        };
        break;
      }
      case "prevClose": out.prevClose = H.optionPrevClose ? clone(H.optionPrevClose) : null; break;
      case "snaps": out.snaps = { minute: clone(H.chainMinuteSnaps), hour: clone(H.chainHourSnaps) }; break;
      case "fut": out.fut = { contracts: clone(H.futOiContracts), known: clone([...H.futOiKnownContracts.values()]) }; break;
      case "pending":
        out.pending = {
          hash: [...H.pendingHashWrites].map(([k, p]) => [k, { entries: [...p.entries].map(([f, v]) => [f, JSON.stringify(v)]), stale: [...p.stale], ttlSec: p.ttlSec, maxFields: p.maxFields }]),
          plain: [...H.pendingPlainWrites].map(([k, p]) => [k, { value: JSON.stringify(p.value), ttlSec: p.ttlSec }]),
        };
        break;
      case "repairs":
        out.repairs = {
          partial: [...H.partialRepairs].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => [k, v.n, v.at]),
          head: [...H.headRepairs].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => [k, v.n, v.at]),
          prevCloseAttempts: clone(H.prevCloseAttempts),
          closedDayLogged: H.closedDayLogged,
        };
        break;
      case "flushState":
        out.flushState = { inFlight: H.flushInFlight, again: H.flushAgain, ttl: [...H.ttlRefreshedAt].sort((a, b) => (a[0] < b[0] ? -1 : 1)) };
        break;
      case "redis": out.redis = redis.current.dump(); break;
      case "timers": out.timers = timers.list.map((t) => t.ms).sort((a, b) => a - b); break;
      default: throw new Error(`observe: unknown part ${part}`);
    }
  }
  return out;
}

function fakeReq(pathname, query) {
  const parts = pathname.split("/");
  return { params: { underlying: decodeURIComponent(parts[3] ?? "") }, query: querystring.parse(query ?? ""), headers: {} };
}
function fakeRes() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (v) => { r.body = JSON.stringify(v); return r; };
  return r;
}

async function runOp(op) {
  tape = [];
  delays = [];
  const logStart = logs.length;
  const bodiesStart = redis.current.bodies.length;
  let result;
  switch (op.op) {
    case "clock": clock.now = op.t; break;
    case "advance": clock.now += op.ms; break;
    case "env":
      if ("hist" in op.set) histCalls.clear();
      Object.assign(env, op.set);
      break;
    case "redisFail": redis.current.failNext = op.n; break;
    case "redisSeed": redis.current.seed("calspread:" + op.key, op); break;
    case "setFrame": (op.family === "opt" ? H.oiFrameStores : H.futOiFrameStores)[op.key].points = clone(op.points); break;
    case "setPrevClose": H.optionPrevClose = clone(op.value); break;
    case "setSnaps": H.chainMinuteSnaps = clone(op.minute); H.chainHourSnaps = clone(op.hour); break;
    case "setDay": {
      const d = op.value;
      H.optionOiDay = d && {
        day: d.day, expiry: d.expiry, spotToken: d.spotToken,
        meta: new Map(d.meta.map(([tok, strike, type]) => [tok, { strike, type }])),
        series: new Map(d.series.map(([tok, arr]) => [tok, arr.map(([t, oi, ltp]) => ({ t, oi, ltp }))])),
        spot: d.spot.map(([t, ltp]) => ({ t, ltp })),
        ...(d.window ? { window: d.window } : {}),
      };
      break;
    }
    case "appendOiFrameLive": H.appendOiFrameLive(op.t, clone(op.agg)); break;
    case "appendFutOiFrameLive": H.appendFutOiFrameLive(op.t, clone(op.point)); break;
    case "mergeOiFrame": H.mergeOiFrame(op.key, clone(op.points)); break;
    case "mergeFutOiFrame": H.mergeFutOiFrame(op.key, clone(op.points)); break;
    case "coarsenFrames": H.coarsenFrames(); break;
    case "currentWindowAgg": result = H.currentWindowAgg(H.optionOiDay, op.unseeded ? new Set(op.unseeded) : undefined); break;
    case "recordChainSnapshot": H.recordChainSnapshot(H.optionOiDay, op.t); break;
    case "chainBaselineAt": result = H.chainBaselineAt(op.cutoff); break;
    case "chainSnapshotSpan": result = H.chainSnapshotSpan(); break;
    case "oiBackfillFromMs": result = H.oiBackfillFromMs(op.now); break;
    case "futOiBackfillFromMs": result = H.futOiBackfillFromMs(op.now); break;
    case "niftyMonthlyFutures": {
      const sel = H.niftyMonthlyFutures(universes[op.universe]);
      result = sel;
      break;
    }
    case "captureOptionOi": await H.captureOptionOi(); break;
    case "captureFuturesOi": await H.captureFuturesOi(); break;
    case "backfillOiFrames": await H.backfillOiFrames(op.from); break;
    case "backfillFutOiFrames": await H.backfillFutOiFrames(op.from); break;
    case "backfillPrevClose": await H.backfillPrevClose(); break;
    case "flush": await H.flushRedisWrites(); break;
    case "warmLoad": await H.warmLoadFromRedis(); break;
    case "postLogin": H.triggerPostLoginBackfill(); break;
    case "start": H.startRedisFlushRetry(); H.startOptionOiCapture(); break;
    case "fireTimer": {
      // tick = the capture setTimeout chain; flush / gap = the 60 s and 30 min intervals.
      const t = op.which === "tick" ? timers.list.find((x) => x.kind === "timeout")
        : timers.list.find((x) => x.kind === "interval" && x.ms === (op.which === "flush" ? 60_000 : 1_800_000));
      if (!t) throw new Error(`no pending ${op.which} timer`);
      if (t.kind === "timeout") timers.list.splice(timers.list.indexOf(t), 1);
      t.fn();
      break;
    }
    case "gate": result = H.zerodhaCaptureAllowed(op.what); break;
    case "route": {
      const pattern = op.path.replace(/^(\/api\/[^/]+\/).*/, "$1:underlying");
      const handler = routes.get(pattern);
      if (!handler) throw new Error(`no route ${pattern}`);
      const res = fakeRes();
      await handler(fakeReq(op.path, op.query), res);
      result = { status: res.statusCode, body: res.body };
      break;
    }
    case "observe": result = observe(op.parts); break;
    case "flushRacing": {
      // The flush's synchronous part (detach + build the pipeline) runs, then the `during`
      // operations run before its fetch settles, as a capture or merge landing during a
      // slow round trip would.
      const p = H.flushRedisWrites();
      for (const inner of op.during) {
        if (inner.op === "mergeOiFrame") H.mergeOiFrame(inner.key, clone(inner.points));
        else if (inner.op === "appendOiFrameLive") H.appendOiFrameLive(inner.t, clone(inner.agg));
        else throw new Error(`flushRacing: unsupported ${inner.op}`);
      }
      await p;
      break;
    }
    default: throw new Error(`unknown op ${op.op}`);
  }
  await drain();
  const out = {};
  if (tape.length) out.calls = tape;
  if (delays.length) out.delays = delays;
  const lines = logs.slice(logStart).filter((l) => /^\[(OptionOI|FuturesOI|Capture)\]/.test(l));
  if (lines.length) out.logs = lines;
  const bodies = redis.current.bodies.slice(bodiesStart);
  if (bodies.length) out.redis = bodies;
  if (result !== undefined) out.result = result;
  return out;
}

async function scenario(name, ops, { startClock } = {}) {
  const start = startClock ?? istMs(2026, 10, 27, 9, 0);
  clock.now = start;
  timers.list.length = 0;
  redis.current = new FakeRedis();
  histCalls.clear();
  routes.clear();
  Object.assign(env, { broker: "zerodha", token: "access-token", ready: true, problems: [], universe: "wide", universeFail: null, quotes: {}, hist: {}, spotQuote: { price: 25010.5 } });
  H = await loadAnalytics(fakeEnv);
  const steps = [];
  for (const op of ops) {
    try {
      steps.push(await runOp(op));
    } catch (e) {
      throw new Error(`${name}: op ${JSON.stringify(op).slice(0, 120)}: ${e.stack}`);
    }
  }
  return { name, startClock: start, ops, steps };
}

// ---------------------------------------------------------------------------
// Scenario helpers.

const tick = (t) => [{ op: "clock", t }, { op: "captureOptionOi" }, { op: "captureFuturesOi" }, { op: "flush" }];
const ALL = ["frames", "day", "prevClose", "snaps", "fut", "pending", "repairs", "flushState", "redis"];
const frameRoutes = (keys = ["1m", "5m", "15m", "1h"]) => keys.flatMap((k) => [
  { op: "route", path: "/api/option-oi-frame/NIFTY", query: `frame=${k}` },
  { op: "route", path: "/api/futures-oi-frame/NIFTY", query: `frame=${k}` },
]);
const T = (h, mi, s = 0, d = 27, mo = 10) => istMs(2026, mo, d, h, mi, s);
const prevCloseToday = (day = "2026-10-27") => ({ op: "setPrevClose", value: { forDay: day, closedOn: "2026-10-26", expiry: "2026-10-27", complete: true, tokens: { 10000001: { oi: 1500, ltp: 12.5 }, 10000000: { oi: 2250, ltp: 30.25 } } } });

function liveDay() {
  const ops = [prevCloseToday()];
  const missing = [10_000_050, 10_000_051, 10_000_052];
  // Pre-open and the first readings: one cycle misses three window strikes entirely.
  ops.push({ op: "env", set: { quotes: { missing } } }, ...tick(T(9, 9, 57)), { op: "observe", parts: ["day", "frames", "snaps"] });
  ops.push({ op: "env", set: { quotes: {} } }, ...tick(T(9, 10, 57)));
  ops.push({ op: "env", set: { quotes: { missing: [10_000_050] } } }, ...tick(T(9, 14, 57)));
  for (let m = 15; m <= 33; m++) {
    const q = m === 17 ? { missing: [256265] } : m === 21 ? { zeroOi: [10_000_060], zeroLtp: [10_000_061] } : m === 25 ? { stamp: "none" } : m === 27 ? { stamp: "junk" } : {};
    if (m === 23) continue; // a missed minute
    ops.push({ op: "env", set: { quotes: q } }, ...tick(T(9, m, 57)));
  }
  ops.push({ op: "observe", parts: ALL });
  ops.push({ op: "env", set: { quotes: { missing: [10_000_070] } } }, ...tick(T(9, 59, 57)));
  ops.push({ op: "env", set: { quotes: {} } }, ...tick(T(10, 0, 0)), ...tick(T(10, 0, 57)));
  ops.push({ op: "clock", t: T(10, 1, 30) }, { op: "observe", parts: ALL });
  ops.push(...frameRoutes());
  ops.push({ op: "route", path: "/api/option-oi-series/NIFTY" });
  for (const q of [undefined, "minutes=", "minutes=abc", "minutes=0", "minutes=0.5", "minutes=1.5", "minutes=2.5", "minutes=15", "minutes=60", "minutes=239.5", "minutes=241", "minutes=Infinity", "minutes=1e1", "minutes=5&minutes=6", "minutes=%20%2010%20"]) {
    ops.push({ op: "route", path: "/api/option-oi-baseline/NIFTY", ...(q ? { query: q } : {}) });
  }
  ops.push({ op: "route", path: "/api/option-prev-close/NIFTY" });
  // The 15:40 close clamp: samples after the close update the closing bucket.
  ops.push(...tick(T(15, 39, 57)), ...tick(T(15, 40, 57)), ...tick(T(15, 45, 57)));
  ops.push({ op: "clock", t: T(15, 50) }, { op: "observe", parts: ["frames", "pending", "redis"] }, ...frameRoutes(["5m"]));
  ops.push({ op: "route", path: "/api/option-oi-series/NIFTY" });
  // Next morning the series route reports an empty day and the prev-close is stale.
  ops.push({ op: "clock", t: T(9, 5, 0, 28) }, { op: "route", path: "/api/option-oi-series/NIFTY" }, { op: "route", path: "/api/option-prev-close/NIFTY" }, { op: "route", path: "/api/option-oi-baseline/NIFTY" });
  return ops;
}

function holiday() {
  return [
    prevCloseToday("2026-10-28"),
    { op: "env", set: { quotes: { stamp: "yesterday" } } },
    ...tick(T(9, 20, 57, 28)),
    ...tick(T(9, 21, 57, 28)),
    { op: "observe", parts: ["day", "frames", "snaps", "repairs", "pending"] },
    { op: "env", set: { quotes: {} } },
    ...tick(T(9, 22, 57, 28)),
    { op: "observe", parts: ["frames"] },
  ];
}

function dayRoll() {
  return [
    { op: "env", set: { universe: "small" } },
    prevCloseToday("2026-10-26"),
    ...tick(T(15, 37, 57, 26)),
    { op: "env", set: { quotes: { spotShift: 40 } } },
    ...tick(T(15, 38, 57, 26)),
    // Next session, same nearest expiry: the outgoing day becomes the baseline.
    { op: "env", set: { quotes: {} } },
    ...tick(T(9, 15, 57, 27)),
    { op: "observe", parts: ["prevClose", "day", "pending", "redis", "snaps"] },
    { op: "route", path: "/api/option-prev-close/NIFTY" },
    // An expiry change inside the day does not snapshot (and starts a new day object).
    { op: "env", set: { universe: "smallNextWeek" } },
    ...tick(T(9, 16, 57, 27)),
    { op: "observe", parts: ["prevClose", "day"] },
  ];
}

function flatDayRoll() {
  // Day 1 never moved (holiday-like): no baseline, so day 2 asks for the daily-candle backfill.
  return [
    { op: "env", set: { universe: "small", quotes: { spotDrift: 0 } } },
    prevCloseToday("2026-10-26"),
    ...tick(T(11, 0, 57, 26)),
    ...tick(T(11, 1, 57, 26)),
    { op: "env", set: { quotes: {}, hist: { fail: { 10000004: 1, 10000007: "always" }, empty: [10000010] } } },
    ...tick(T(9, 15, 57, 27)),
    { op: "observe", parts: ["prevClose", "repairs", "pending"] },
  ];
}

function prevCloseBackfill() {
  return [
    { op: "env", set: { universe: "small", quotes: { fail: true }, hist: { fail: { 10000002: "always", 10000013: 2 }, empty: [10000005], zeroOi: [10000006], shortHistory: [10000008, 10000009, 10000011] } } },
    { op: "clock", t: T(10, 0) },
    { op: "backfillPrevClose" },
    { op: "observe", parts: ["prevClose", "repairs", "pending"] },
    { op: "route", path: "/api/option-prev-close/NIFTY" },
    { op: "advance", ms: 30 * MIN },
    { op: "backfillPrevClose" },
    { op: "backfillPrevClose" },
    { op: "backfillPrevClose" },
    { op: "observe", parts: ["prevClose", "repairs"] },
    { op: "backfillPrevClose" },
    // A new IST day resets the attempt budget; the stale baseline is not reused.
    { op: "env", set: { hist: {} } },
    { op: "clock", t: T(9, 30, 0, 28) },
    { op: "backfillPrevClose" },
    { op: "observe", parts: ["prevClose", "repairs"] },
    { op: "backfillPrevClose" },
    { op: "env", set: { universeFail: "instrument dump unavailable" } },
    { op: "clock", t: T(9, 30, 0, 29) },
    { op: "backfillPrevClose" },
    { op: "env", set: { universeFail: null, quotes: {}, hist: { failAllDaily: true } } },
    // A live day reference skips the spot quote.
    ...tick(T(9, 31, 57, 29)),
  ];
}

function frameBackfill() {
  const live = [];
  for (let m = 41; m <= 47; m++) live.push(...tick(T(9, m, 57)));
  return [
    { op: "env", set: { universe: "mid" } },
    prevCloseToday(),
    ...live,
    { op: "env", set: { hist: { fail: { 10000012: 1, 10000017: "always" }, spotShift: 0 } } },
    { op: "clock", t: T(9, 48, 10) },
    { op: "oiBackfillFromMs", now: T(9, 48, 10) },
    // Window snapshotted from the previous session's last half hour, crossing the night.
    { op: "backfillOiFrames", from: T(15, 10, 0, 26) },
    { op: "observe", parts: ["frames", "pending", "repairs"] },
    { op: "flush" },
    // The gap detector now asks for the partial buckets (and logs once).
    { op: "oiBackfillFromMs", now: T(9, 48, 30) },
    { op: "observe", parts: ["repairs"] },
    // A complete reconstruction replaces the partial buckets, never the live ones.
    { op: "env", set: { hist: {} } },
    { op: "advance", ms: 26 * MIN },
    { op: "backfillOiFrames" },
    { op: "observe", parts: ["frames", "pending", "repairs"] },
    // Nothing missing: the window is current, so no history call at all.
    { op: "backfillOiFrames", from: T(10, 13, 0) },
    { op: "env", set: { token: null } },
    { op: "backfillOiFrames", from: T(9, 0) },
    { op: "env", set: { token: "access-token", hist: { fail: { 256265: 1 } } } },
    { op: "backfillOiFrames", from: T(9, 0) },
    { op: "env", set: { hist: { emptySpot: true } } },
    { op: "backfillOiFrames", from: T(9, 0) },
    { op: "coarsenFrames" },
    { op: "observe", parts: ["frames"] },
  ];
}

function futBackfill() {
  const live = [];
  for (let m = 41; m <= 44; m++) live.push({ op: "clock", t: T(9, m, 57) }, { op: "captureFuturesOi" });
  return [
    { op: "env", set: { universe: "small" } },
    ...live,
    { op: "flush" },
    { op: "clock", t: T(9, 45, 20) },
    { op: "futOiBackfillFromMs", now: T(9, 45, 20) },
    { op: "backfillFutOiFrames", from: T(15, 20, 0, 26) },
    { op: "observe", parts: ["frames", "pending", "fut"] },
    { op: "env", set: { hist: { fail: { 13000003: 1 } } } },
    { op: "backfillFutOiFrames", from: T(9, 0) },
    { op: "observe", parts: ["frames"] },
    { op: "niftyMonthlyFutures", universe: "small" },
    { op: "route", path: "/api/futures-oi-frame/NIFTY", query: "frame=1m" },
    { op: "route", path: "/api/futures-oi-frame/NIFTY", query: "frame=15m&frame=1h" },
    // A holiday on the near contract skips the futures capture.
    { op: "env", set: { quotes: { stamp: "yesterday" } } },
    { op: "clock", t: T(9, 46, 57) },
    { op: "captureFuturesOi" },
    { op: "observe", parts: ["frames", "repairs"] },
    // A zero quote carries the previous leg forward (positive test).
    { op: "env", set: { quotes: { zeroOi: [13000001], zeroLtp: [13000003] } } },
    { op: "clock", t: T(9, 47, 57) },
    { op: "captureFuturesOi" },
    { op: "observe", parts: ["frames"] },
  ];
}

// Frames for the gap detectors / coarsening, built by hand.
const pt = (t, ce, pe, extra = {}) => ({ t, totalCe: ce, totalPe: pe, straddle: 210.5, spot: 25010.25, ...extra });
const fpt = (t, legs) => ({ t, legs: legs.map(([expiry, oi, ltp]) => ({ expiry, oi, ltp })) });

function gapDetectors() {
  const day1m = range(T(12, 23), T(12, 40), MIN).map((t, i) => pt(t, 1000 + i, 2000 + i));
  const five = [pt(T(9, 20), 1, 2, { wLo: 24000, wHi: 25500 }), pt(T(9, 25), 3, 4, { partial: 1 }), pt(T(9, 30), 5, 6), pt(T(9, 35), 7, 8, { partial: 1 })];
  const fifteen = [pt(T(9, 30, 0, 23), 1, 1), pt(T(10, 0, 0, 23), 2, 2)];
  return [
    { op: "clock", t: T(12, 41) },
    { op: "setFrame", family: "opt", key: "1m", points: day1m },
    { op: "setFrame", family: "opt", key: "5m", points: five },
    { op: "setFrame", family: "opt", key: "15m", points: fifteen },
    { op: "setFrame", family: "fut", key: "5m", points: [fpt(T(11, 0), [["2026-10-27", 1, 2]])] },
    { op: "oiBackfillFromMs", now: T(12, 41) },
    { op: "futOiBackfillFromMs", now: T(12, 41) },
    { op: "observe", parts: ["repairs"] },
    { op: "advance", ms: MIN },
    { op: "oiBackfillFromMs", now: T(12, 42) },
    { op: "advance", ms: 25 * MIN },
    { op: "oiBackfillFromMs", now: T(13, 7) },
    { op: "advance", ms: 25 * MIN },
    { op: "oiBackfillFromMs", now: T(13, 32) },
    { op: "advance", ms: 25 * MIN },
    { op: "oiBackfillFromMs", now: T(13, 57) },
    { op: "observe", parts: ["repairs"] },
    { op: "advance", ms: 25 * MIN },
    { op: "oiBackfillFromMs", now: T(14, 22) },
    { op: "futOiBackfillFromMs", now: T(14, 22) },
    { op: "observe", parts: ["repairs"] },
    // Retention: a head older than the retention start is not chased.
    { op: "setFrame", family: "opt", key: "1m", points: [pt(T(10, 30, 0, 26), 1, 1)] },
    { op: "oiBackfillFromMs", now: T(14, 22) },
    // Empty frames ask for the whole retention window.
    { op: "setFrame", family: "opt", key: "1m", points: [] },
    { op: "setFrame", family: "opt", key: "5m", points: [] },
    { op: "setFrame", family: "opt", key: "15m", points: [] },
    { op: "oiBackfillFromMs", now: T(14, 22) },
    { op: "setFrame", family: "fut", key: "5m", points: [] },
    { op: "futOiBackfillFromMs", now: T(14, 22) },
  ];
}

function coarsen() {
  const fifteen = [];
  for (const d of [23, 26, 27]) {
    for (let m = 9 * 60 + 30; m <= 15 * 60 + 30; m += 15) fifteen.push(pt(T(Math.floor(m / 60), m % 60, 0, d), m, d * 10, m === 11 * 60 ? { partial: 1 } : m === 12 * 60 ? { wLo: 24100, wHi: 25350 } : {}));
    fifteen.push(pt(T(15, 40, 0, d), 999, d));
  }
  const fifteenFut = fifteen.filter((p) => p.t < T(11, 0, 0, 27)).map((p) => fpt(p.t, [["2026-10-27", p.totalCe, 1.5], ["2026-11-24", p.totalPe, 2.5]]));
  return [
    { op: "clock", t: T(11, 7) },
    { op: "setFrame", family: "opt", key: "15m", points: fifteen.filter((p) => p.t <= T(10, 45, 0, 27)) },
    { op: "setFrame", family: "opt", key: "1h", points: [pt(T(10, 0, 0, 26), 1, 1), pt(T(12, 0, 0, 26), 2, 2, { partial: 1 }), pt(T(10, 0, 0, 27), 3, 3)] },
    { op: "setFrame", family: "fut", key: "15m", points: fifteenFut },
    { op: "setFrame", family: "fut", key: "1h", points: [fpt(T(11, 0, 0, 26), [["2026-10-27", 7, 7]])] },
    { op: "coarsenFrames" },
    { op: "observe", parts: ["frames", "pending"] },
    { op: "coarsenFrames" },
    { op: "observe", parts: ["pending"] },
    // The 15m frame stops at 10:45: no 11:00 hour is synthesised from it.
    { op: "setFrame", family: "opt", key: "15m", points: fifteen.filter((p) => p.t <= T(11, 0, 0, 27)) },
    { op: "clock", t: T(11, 0, 0) },
    { op: "coarsenFrames" },
    { op: "clock", t: T(11, 0, 1) },
    { op: "coarsenFrames" },
    { op: "observe", parts: ["frames"] },
  ];
}

function mergeRules() {
  const perMinute = [];
  for (let m = 9 * 60 + 10; m <= 9 * 60 + 47; m++) {
    if (m === 9 * 60 + 33) continue;
    perMinute.push(pt(T(Math.floor(m / 60), m % 60), m, -m, { straddle: m / 4, wLo: 24300, wHi: 25700, ...(m % 7 === 0 ? { partial: 1 } : {}) }));
  }
  perMinute.push(pt(T(15, 39, 0, 26), 1, 1, { wLo: 1, wHi: 2 }));
  return [
    { op: "clock", t: T(9, 48, 5) },
    { op: "setFrame", family: "opt", key: "1m", points: [pt(T(9, 30), 5, 5), pt(T(9, 31), 6, 6, { partial: 1 }), pt(T(9, 49), 7, 7)] },
    { op: "setFrame", family: "opt", key: "5m", points: [pt(T(9, 25), 1, 1, { partial: 1 }), pt(T(9, 35), 2, 2, { partial: 1 }), pt(T(9, 50), 9, 9)] },
    ...["1m", "5m", "15m", "1h"].map((key) => ({ op: "mergeOiFrame", key, points: perMinute })),
    { op: "observe", parts: ["frames", "pending"] },
    { op: "mergeFutOiFrame", key: "5m", points: perMinute.map((p) => fpt(p.t, [["2026-10-27", p.totalCe, p.straddle]])) },
    { op: "observe", parts: ["frames", "pending"] },
    // Live appends after a merge keep the merged point's wLo/wHi; `partial` follows the value.
    { op: "appendOiFrameLive", t: T(9, 46, 57), agg: pt(0, 11, 12, { wLo: 1, wHi: 2, partial: 1 }) },
    { op: "appendOiFrameLive", t: T(9, 46, 58), agg: pt(0, 13, 14) },
    { op: "appendOiFrameLive", t: T(9, 49, 57), agg: pt(0, 15, 16, { partial: 1 }) },
    { op: "appendFutOiFrameLive", t: T(9, 49, 57), point: fpt(0, [["2026-10-27", 5, 6], ["2026-11-24", 7, 8]]) },
    { op: "observe", parts: ["frames", "pending"] },
    // Retention: a sample a day later prunes the 1m frame (and HDELs the pruned buckets).
    { op: "appendOiFrameLive", t: T(9, 32, 57, 28), agg: pt(0, 1, 1) },
    { op: "appendFutOiFrameLive", t: T(9, 32, 57, 28), point: fpt(0, [["2026-10-27", 1, 1]]) },
    { op: "observe", parts: ["frames", "pending"] },
  ];
}

function windowAgg() {
  const meta = [];
  const series = [];
  WIDE.forEach((k, i) => {
    meta.push([10_000_000 + i * 2, k, "CE"], [10_000_000 + i * 2 + 1, k, "PE"]);
  });
  meta.push([10_000_000, 24000, "CE"]); // duplicate token, same values
  meta.push([10_999_001, 25100, "CE"]); // a second CE for one strike: the later one wins
  for (const [tok] of meta) {
    if (tok === 10_000_041) continue; // no sample at all
    series.push([tok, [[T(9, 20), tok % 1000, (tok % 97) + 0.5], [T(9, 21), (tok % 1000) * 2, (tok % 89) + 0.25]]]);
  }
  const uniqMeta = [];
  const seen = new Set();
  for (const m of meta) if (!seen.has(m[0])) { seen.add(m[0]); uniqMeta.push(m); }
  const day = (spot, window) => ({ day: "2026-10-27", expiry: "2026-10-27", spotToken: 256265, meta: uniqMeta, series: series.filter(([tok]) => seen.has(tok)), spot: spot === null ? [] : [[T(9, 20), 25001], [T(9, 21), spot]], window });
  return [
    { op: "clock", t: T(9, 21, 30) },
    { op: "setDay", value: day(25037.5) },
    { op: "currentWindowAgg" },
    { op: "observe", parts: ["day"] },
    { op: "currentWindowAgg", unseeded: [10_000_041, 10_000_119] },
    { op: "setDay", value: day(25037.5, { lo: 24500, hi: 25000 }) },
    { op: "currentWindowAgg", unseeded: [10_000_002] },
    { op: "setDay", value: day(0) },
    { op: "currentWindowAgg" },
    { op: "setDay", value: day(null) },
    { op: "currentWindowAgg" },
    { op: "setDay", value: day(23900) },
    { op: "currentWindowAgg" },
    { op: "setDay", value: day(27100) },
    { op: "currentWindowAgg" },
    { op: "setDay", value: day(25100) },
    { op: "recordChainSnapshot", t: T(9, 21, 30) },
    { op: "recordChainSnapshot", t: T(9, 58, 30) },
    { op: "recordChainSnapshot", t: T(10, 0, 0) },
    { op: "observe", parts: ["snaps", "pending"] },
    { op: "route", path: "/api/option-oi-series/NIFTY" },
  ];
}

function snapshots() {
  const snap = (t, tokens = { 1: [10, 1.5] }) => ({ t, expiry: "2026-10-27", tokens });
  const minute = [snap(T(15, 30, 0, 26)), snap(T(9, 16)), snap(T(9, 30), { 7: [70, 7.5], 3: [30, 3.5] }), snap(T(10, 2))];
  const hour = [snap(T(14, 0, 0, 25)), snap(T(10, 0, 0, 26)), snap(T(10, 0)), snap(T(11, 0))];
  const cut = [T(9, 15), T(9, 16), T(9, 29, 59), T(9, 30), T(10, 1), T(10, 2), T(10, 59), T(11, 0), T(23, 0, 0, 26), T(0, 0, 0, 27), T(0, 0, 0, 28)];
  return [
    { op: "clock", t: T(11, 30) },
    { op: "setSnaps", minute, hour },
    ...cut.map((c) => ({ op: "chainBaselineAt", cutoff: c })),
    { op: "chainSnapshotSpan" },
    { op: "setSnaps", minute: [snap(T(15, 30, 0, 26))], hour: [snap(T(9, 0)), snap(T(10, 0))] },
    ...[T(9, 30), T(10, 30), T(8, 0)].map((c) => ({ op: "chainBaselineAt", cutoff: c })),
    { op: "chainSnapshotSpan" },
    { op: "route", path: "/api/option-oi-baseline/NIFTY", query: "minutes=45" },
    { op: "route", path: "/api/option-oi-baseline/NIFTY", query: "minutes=240" },
    { op: "setSnaps", minute: [], hour: [] },
    { op: "chainSnapshotSpan" },
    { op: "route", path: "/api/option-oi-baseline/NIFTY" },
  ];
}

function writeBehind() {
  const ops = [
    { op: "clock", t: T(9, 30, 57) },
    { op: "appendOiFrameLive", t: T(9, 30, 57), agg: pt(0, 1, 2) },
    { op: "appendOiFrameLive", t: T(9, 31, 57), agg: pt(0, 3, 4) },
    { op: "observe", parts: ["pending"] },
    { op: "redisFail", n: 1 },
    { op: "flush" },
    { op: "observe", parts: ["pending", "flushState"] },
    // Newer writes win over the requeued batch; a drop beats an older entry.
    { op: "appendOiFrameLive", t: T(9, 32, 57), agg: pt(0, 5, 6) },
    { op: "appendOiFrameLive", t: T(9, 32, 59), agg: pt(0, 7, 8) },
    { op: "flush" },
    { op: "observe", parts: ["pending", "flushState", "redis"] },
    // EXPIRE again only after 15 minutes.
    { op: "advance", ms: 5 * MIN },
    { op: "appendOiFrameLive", t: T(9, 37, 57), agg: pt(0, 9, 10) },
    { op: "flush" },
    { op: "advance", ms: 11 * MIN },
    { op: "appendOiFrameLive", t: T(9, 48, 57), agg: pt(0, 11, 12) },
    { op: "flush" },
    { op: "observe", parts: ["flushState", "redis"] },
    // Three consecutive failures mute the cache for 60 s.
    { op: "redisFail", n: 3 },
    { op: "appendOiFrameLive", t: T(9, 49, 57), agg: pt(0, 13, 14) },
    { op: "flush" }, { op: "flush" }, { op: "flush" }, { op: "flush" },
    { op: "observe", parts: ["pending", "flushState"] },
    { op: "advance", ms: 30_000 },
    { op: "flush" },
    { op: "advance", ms: 31_000 },
    { op: "flush" },
    { op: "observe", parts: ["pending", "flushState", "redis"] },
    // The per-key backlog cap drops the oldest buckets (60 for a snapshot key).
    { op: "setDay", value: { day: "2026-10-27", expiry: "2026-10-27", spotToken: 256265, meta: [[10000000, 24000, "CE"], [10000001, 24000, "PE"]], series: [[10000000, [[0, 5, 1]]], [10000001, [[0, 6, 2]]]], spot: [] } },
    { op: "redisFail", n: 100 },
  ];
  for (let m = 0; m < 63; m++) ops.push({ op: "recordChainSnapshot", t: T(10, m % 60, 30) + Math.floor(m / 60) * 3600_000 });
  ops.push({ op: "flush" }, { op: "observe", parts: ["pending"] }, { op: "advance", ms: 61_000 }, { op: "redisFail", n: 0 }, { op: "flush" }, { op: "observe", parts: ["pending", "redis"] });
  // A flush fails while newer writes arrive: the newer values (and drops) win the requeue.
  ops.push(
    { op: "clock", t: T(11, 40, 57) },
    { op: "appendOiFrameLive", t: T(11, 40, 57), agg: pt(0, 21, 21, { partial: 1 }) },
    { op: "clock", t: T(11, 41, 57) },
    { op: "appendOiFrameLive", t: T(11, 41, 57), agg: pt(0, 22, 22, { partial: 1 }) },
    { op: "observe", parts: ["pending"] },
    { op: "redisFail", n: 1 },
    { op: "flushRacing", during: [
      { op: "mergeOiFrame", key: "1m", points: [pt(T(11, 40), 31, 31, { wLo: 24000, wHi: 26000 })] },
      { op: "appendOiFrameLive", t: T(9, 55, 57, 28), agg: pt(0, 41, 41) },
    ] },
    { op: "observe", parts: ["pending", "flushState"] },
    { op: "advance", ms: 1000 },
    { op: "flush" },
    { op: "observe", parts: ["pending", "redis"] },
  );
  return ops;
}

function warmLoad() {
  const now = T(10, 30);
  const v = (o) => JSON.stringify(o);
  return [
    { op: "clock", t: now },
    { op: "redisSeed", key: "oiframe:v2:1m", fields: [[String(T(10, 29)), v(pt(T(10, 29), 1, 1))], [String(T(10, 28)), v(pt(T(10, 28), 2, 2, { partial: 1 }))], [String(T(9, 0, 0, 26)), v(pt(T(9, 0, 0, 26), 3, 3))], ["bad", "{nope"], ["x", v({ t: "1" })], [String(T(10, 27)), v(pt(T(10, 27), 4, 4, { wLo: 24000, wHi: 25000 }))]], ttlSec: 3600 },
    { op: "redisSeed", key: "oiframe:v2:15m", fields: range(T(9, 30), T(10, 15), 15 * MIN).map((t, i) => [String(t), v(pt(t, i, i))]), ttlSec: 3600 },
    { op: "redisSeed", key: "futoiframe:5m", fields: [[String(T(10, 25)), v(fpt(T(10, 25), [["2026-10-27", 1, 2]]))], [String(T(10, 20)), v({ t: T(10, 20) })], [String(T(10, 15)), v(fpt(T(10, 15), []))]], ttlSec: 3600 },
    { op: "redisSeed", key: "futoiframe:15m", fields: [[String(T(10, 15)), v(fpt(T(10, 15), [["2026-10-27", 5, 6]]))]], ttlSec: 3600 },
    { op: "redisSeed", key: "futcontracts", value: v([{ token: 13000001, tradingsymbol: "NIFTY26OCTFUT", expiry: "2026-10-27", lot_size: 75 }, { token: 9, expiry: 5 }, null, { token: 13000002, tradingsymbol: "NIFTY26NOVFUT", expiry: "2026-11-24", lot_size: 75 }]), ttlSec: 3600 },
    { op: "redisSeed", key: "prevclose", value: v({ forDay: "2026-10-27", closedOn: "2026-10-26", expiry: "2026-10-27", complete: false, tokens: { 10000003: { oi: 9, ltp: 1.25 }, 10000001: { oi: 7, ltp: 2 } } }), ttlSec: 3600 },
    { op: "redisSeed", key: "chainsnap:min:2026-10-27", fields: [[String(T(10, 20)), v({ t: T(10, 20), expiry: "2026-10-27", tokens: { 5: [1, 2] } })], [String(T(9, 16)), v({ t: T(9, 16), expiry: "2026-10-27", tokens: { 5: [3, 4], 4: [5, 6] } })], ["z", "[]"]], ttlSec: 3600 },
    ...[0, 1, 2, 3, 4, 5].map((d) => ({ op: "redisSeed", key: `chainsnap:hour:${["2026-10-27", "2026-10-26", "2026-10-25", "2026-10-24", "2026-10-23", "2026-10-22"][d]}`, fields: [[String(T(10, 0, 0, 27 - d)), v({ t: T(10, 0, 0, 27 - d), expiry: "2026-10-27", tokens: { 9: [d, d] } })]], ttlSec: 3600 })),
    // Already in memory: these win over the persisted copies.
    { op: "setFrame", family: "opt", key: "1m", points: [pt(T(10, 29), 50, 50)] },
    { op: "setSnaps", minute: [{ t: T(10, 20), expiry: "live", tokens: {} }], hour: [] },
    { op: "warmLoad" },
    { op: "observe", parts: ["frames", "prevClose", "snaps", "fut", "pending", "redis"] },
    { op: "route", path: "/api/futures-oi-frame/NIFTY", query: "frame=5m" },
    { op: "route", path: "/api/option-oi-baseline/NIFTY", query: "minutes=30" },
  ];
}

function warmLoadStale() {
  return [
    { op: "clock", t: T(10, 30) },
    { op: "redisSeed", key: "prevclose", value: JSON.stringify({ forDay: "2026-10-26", closedOn: "2026-10-23", expiry: "2026-10-27", complete: true, tokens: {} }), ttlSec: 3600 },
    { op: "redisSeed", key: "oiframe:v2:15m", fields: [[String(T(10, 0)), JSON.stringify(pt(T(10, 0), 1, 1))]], ttlSec: 3600 },
    { op: "warmLoad" },
    { op: "observe", parts: ["frames", "prevClose", "pending"] },
    { op: "redisFail", n: 1 },
    { op: "setFrame", family: "opt", key: "1h", points: [] },
    { op: "warmLoad" },
    { op: "observe", parts: ["frames"] },
  ];
}

/** Frames already covering the session up to `last` (no head or tail gap before it). */
function coveredFrames(last, day = 27) {
  const firsts = { "1m": T(9, 16, 0, day), "5m": T(9, 20, 0, day), "15m": T(9, 30, 0, day), "1h": T(10, 0, 0, day) };
  const ops = [];
  for (const [key, first] of Object.entries(firsts)) {
    ops.push({ op: "setFrame", family: "opt", key, points: [pt(first, 1, 1), pt(last, 2, 2)] });
    ops.push({ op: "setFrame", family: "fut", key, points: [fpt(first, [["2026-10-27", 1, 1]]), fpt(last, [["2026-10-27", 2, 2]])] });
  }
  return ops;
}

function scheduler() {
  return [
    { op: "env", set: { universe: "small" } },
    prevCloseToday(),
    ...coveredFrames(T(15, 40, 0, 26), 26),
    // Before 09:10 the first tick captures nothing; the cold chain runs alone.
    { op: "clock", t: T(9, 5, 20) },
    { op: "start" },
    { op: "observe", parts: ["timers", "frames", "pending", "redis"] },
    { op: "clock", t: T(9, 5, 57) },
    { op: "fireTimer", which: "tick" },
    { op: "observe", parts: ["timers"] },
    { op: "clock", t: T(9, 10, 57) },
    { op: "fireTimer", which: "tick" },
    { op: "observe", parts: ["timers", "frames"] },
    { op: "clock", t: T(9, 35, 20) },
    { op: "fireTimer", which: "gap" },
    { op: "observe", parts: ["timers", "frames"] },
    { op: "clock", t: T(9, 36, 0) },
    { op: "appendOiFrameLive", t: T(9, 36, 0), agg: pt(0, 1, 1) },
    { op: "fireTimer", which: "flush" },
    { op: "observe", parts: ["timers", "pending"] },
    { op: "fireTimer", which: "flush" },
    { op: "clock", t: T(10, 1, 57, 31) },
    { op: "fireTimer", which: "tick" },
    { op: "clock", t: T(10, 30, 20, 31) },
    { op: "fireTimer", which: "gap" },
    { op: "clock", t: T(15, 45, 58, 31) },
    { op: "fireTimer", which: "tick" },
    { op: "observe", parts: ["timers", "frames"] },
  ];
}

function postLogin() {
  return [
    { op: "env", set: { universe: "small", token: null } },
    prevCloseToday(),
    ...coveredFrames(T(10, 2)),
    { op: "clock", t: T(10, 14, 40) },
    { op: "start" },
    { op: "env", set: { token: "access-token" } },
    { op: "postLogin" },
    { op: "observe", parts: ALL },
  ];
}

function gate() {
  return [
    { op: "gate", what: "option-OI capture" },
    { op: "env", set: { broker: "dhan" } },
    { op: "gate", what: "option-OI capture" },
    { op: "gate", what: "futures-OI capture" },
    { op: "captureOptionOi" },
    { op: "env", set: { broker: "zerodha", token: null } },
    { op: "gate", what: "x" },
    { op: "env", set: { token: "" } },
    { op: "gate", what: "x" },
  ];
}

function chainRoutes() {
  const q = (path, query) => ({ op: "route", path, ...(query !== undefined ? { query } : {}) });
  return [
    { op: "env", set: { universe: "chain" } },
    { op: "clock", t: T(11, 0) },
    q("/api/option-chain/NIFTY"),
    q("/api/option-chain/nifty", "band=5&expiry=2026-11-03"),
    q("/api/option-chain/NIFTY", "band="),
    q("/api/option-chain/NIFTY", "band=abc"),
    q("/api/option-chain/NIFTY", "band=7.5"),
    q("/api/option-chain/NIFTY", "band=2.5"),
    q("/api/option-chain/NIFTY", "band=1e9"),
    q("/api/option-chain/NIFTY", "band=1&band=2"),
    q("/api/option-chain/NIFTY", "band=-Infinity"),
    q("/api/option-chain/NIFTY", "expiry=%202026-11-03%20"),
    q("/api/option-chain/NIFTY", "expiry=2026-10-20"),
    q("/api/option-chain/NIFTY", "expiry=2026-11-03&expiry=x"),
    q("/api/option-chain/BANKNIFTY", "band=1"),
    q("/api/option-chain/RELIANCE", "band=2"),
    q("/api/option-chain/FINNIFTY"),
    q("/api/option-chain/OLDCO"),
    q("/api/option-chain/ZERO"),
    q("/api/option-chain/NOPE"),
    { op: "env", set: { spotQuote: { fail: true } } },
    q("/api/option-chain/NIFTY", "band=6"),
    { op: "env", set: { spotQuote: { empty: true } } },
    q("/api/option-chain/BANKNIFTY", "band=8"),
    { op: "env", set: { spotQuote: { price: 52_250 } } },
    q("/api/option-chain/BANKNIFTY", "band=8"),
    { op: "env", set: { spotQuote: { price: 0 } } },
    q("/api/option-chain/RELIANCE", "band=5.5"),
    { op: "env", set: { spotQuote: { price: 26_480 } } },
    q("/api/option-chain/NIFTY", "band=5.5"),
    { op: "env", set: { universeFail: "instruments exploded" } },
    q("/api/option-chain/NIFTY"),
    { op: "env", set: { universeFail: null, ready: false, problems: ["Zerodha is not connected"] } },
    q("/api/option-chain/NIFTY", "band=abc"),
    { op: "env", set: { broker: "dhan", problems: ["Dhan session expired — reconnect Dhan", "x"] } },
    q("/api/option-chain/NIFTY"),
    { op: "env", set: { ready: true } },
    // Option routes never need market data and ignore :underlying.
    q("/api/option-oi-frame/BANKNIFTY", "frame=1h"),
    q("/api/option-oi-frame/X", "frame=5M"),
    q("/api/option-oi-frame/X", "frame="),
    q("/api/option-oi-frame/X", "frame=15m&frame=1m"),
    q("/api/futures-oi-frame/X"),
    q("/api/option-prev-close/X"),
    q("/api/option-oi-series/X"),
  ];
}

// ---------------------------------------------------------------------------
// Pure cases.

async function pureCases() {
  clock.now = T(9, 0);
  H = await loadAnalytics(fakeEnv);
  const cases = [];
  const add = (fn, args, result) => cases.push({ fn, args, result });
  const instants = [];
  for (let m = 9 * 60 + 5; m <= 10 * 60 + 5; m++) instants.push(T(Math.floor(m / 60), m % 60, 0), T(Math.floor(m / 60), m % 60, 57));
  for (let m = 15 * 60 + 25; m <= 15 * 60 + 50; m++) instants.push(T(Math.floor(m / 60), m % 60, 0), T(Math.floor(m / 60), m % 60, 57));
  for (const [h, mi] of [[9, 15], [10, 0], [15, 40], [9, 10], [15, 45], [15, 46], [0, 0], [23, 59], [5, 29], [5, 30], [12, 30]]) {
    for (const d of [-1, 0, 1]) instants.push(T(h, mi) + d);
  }
  instants.push(istMs(2026, 10, 24, 11, 0), istMs(2026, 10, 25, 9, 20), istMs(2028, 2, 29, 12, 0), istMs(2026, 12, 31, 23, 59, 59, 999), istMs(2027, 1, 1, 0, 0), istMs(2026, 3, 1, 9, 15, 30));
  const sizes = [60_000, 300_000, 900_000, 3_600_000];
  for (const t of instants) {
    add("istDayKey", [t], H.istDayKey(t));
    add("istDateTime", [t], H.istDateTime(new Date(t)));
    add("istTimeOnDayMs", [t, 0], H.istTimeOnDayMs(t, 0));
    add("sessionOpenMs", [t], H.sessionOpenMs(t));
    add("sessionCloseMs", [t], H.sessionCloseMs(t));
    add("isPreOpenBucket", [t], H.isPreOpenBucket(t));
    for (const b of sizes) {
      add("bucketEndMs", [t, b], H.bucketEndMs(t, b));
      add("candleEndMs", [t, b], H.candleEndMs(t, b));
    }
  }
  const days = [[2026, 10, 26], [2026, 10, 24], [2026, 10, 25], [2026, 11, 8], [2026, 11, 7], [2026, 11, 1], [2026, 10, 30]];
  for (const [y, mo, d] of days) {
    for (const [h, mi, s] of [[9, 9, 59], [9, 10, 0], [9, 14, 0], [12, 0, 0], [15, 45, 0], [15, 45, 59], [15, 46, 0], [23, 0, 0], [0, 30, 0]]) {
      const t = istMs(y, mo, d, h, mi, s);
      clock.now = t;
      add("isIstMarketHours", [t], H.isIstMarketHours());
    }
  }
  clock.now = T(12, 0);
  for (const stamp of [undefined, "", "2026-10-27 09:15:00", "2026-10-27T09:15:00+0530", "27-10-2026", "2026-10-26 15:30:00", "2026-10-28 00:00:01", "2026-10-2", "2026-1027 1", "２０２６-10-27", "2026-10-27"]) {
    add("isQuoteFromToday", [stamp === undefined ? null : stamp, clock.now], H.isQuoteFromToday(stamp));
  }
  const ladders = [WIDE, SMALL, [], [24000, 24100, 24150, 25000], range(100, 300, 25)];
  const spots = [24000, 25012.5, 25025, 25037.5, 23000, 28000, 0, -5, NaN, 24125, 24075, 150, 312.5, 112.5];
  for (const lad of ladders) for (const s of spots) {
    add("nearestStrikeIndex", [lad, s], H.nearestStrikeIndex(lad, s));
    add("pinStrikeWindow", [lad, s], H.pinStrikeWindow(lad, s));
  }
  for (const raw of [undefined, "", "5m", "5M", "1h", "1m", "15m", ["1m", "5m"], "1h ", null]) add("parseFrameKey", [raw === undefined ? { $undefined: true } : raw], H.parseFrameKey(raw));
  for (const k of H.OI_FRAME_KEYS) {
    add("coarsenSourceFor", [k], H.coarsenSourceFor(k));
    add("frameTtlSec", [k], H.frameTtlSec(H.OI_FRAMES[k]));
  }
  add("maxFrameRetentionMs", [], H.maxFrameRetentionMs());
  for (const s of ["2026-10-27T09:15:00+0530", "2026-10-27T09:15:00+05:30", "2026-10-27T03:45:00Z", "2026-10-27T09:15:00.250+0530", "2026-12-31T23:59:00+0530", "2026-10-27T09:15+0530", "2026-10-27T09:15:00-0400", "garbage", "2026-02-29T09:15:00+0530", "2026-10-27T24:00:00+0530", "2028-02-29T09:15:00+0530", "2026-10-27T9:15:00+0530",
    "2026-02-30T09:15:00+0530", "2026-02-32T09:15:00+0530", "2026-04-31T09:15:00+05:30", "2026-13-01T09:15:00+0530", "2026-10-27 09:15:00+0530", "2026-10-27T09:15:00 +0530", "2026-10-27T09:15:00+530", "2026-10-27T09:15:00+05", "2026-10-27T09:15:60+0530", "2026-10-27T24:00:00+05:30", "2026-10-27T09:15:00"]) {
    add("candleTime", [s], new Date(s).getTime());
  }
  for (const [name, now] of [["wide", T(9, 0)], ["wide", T(9, 0, 0, 28)], ["chain", T(9, 0)], ["smallNextWeek", T(9, 0)], ["wide", T(9, 0, 0, 4, 11)]]) {
    clock.now = now;
    const sel = H.niftyNearestExpiryOptions(universes[name]);
    add("niftyNearestExpiryOptions", [name, now], sel && { expiry: sel.expiry, spotToken: sel.spotToken, meta: [...sel.meta].map(([t, m]) => [t, m.strike, m.type]), ids: sel.ids, spotId: sel.spotId });
  }
  add("niftyNearestExpiryOptions", ["noSpot", T(9, 0)], H.niftyNearestExpiryOptions(universes.wide.filter((i) => i.segment !== "INDICES")));
  const pts = range(T(9, 14), T(10, 2), MIN).map((t, i) => pt(t, i, -i, i % 5 === 0 ? { partial: 1 } : {}));
  for (const now of [T(9, 30), T(9, 59, 59), T(10, 0), T(10, 1, 30), T(12, 0)]) {
    clock.now = now; // completedBuckets reads Date.now()
    add("completedBuckets", [pts, now], H.completedBuckets(pts.map((p) => ({ ...p }))));
    for (const b of [900_000, 3_600_000]) add("collapseToBuckets", [pts, b, now], [...H.collapseToBuckets(pts, b, now)]);
  }
  for (const iv of [1, 5, 15, 60]) add("downsampleAgg", [pts, iv], H.downsampleAgg(pts, iv));
  const lists = [[], [{ t: 5 }], [{ t: 1 }, { t: 3 }, { t: 9 }]];
  for (const l of lists) for (const t of [0, 1, 2, 3, 9, 10]) {
    const list = l.map((s) => ({ ...s, expiry: "old", tokens: {} }));
    H.upsertSnapshot(list, { t, expiry: "new", tokens: {} });
    add("upsertSnapshot", [l.map((s) => s.t), t], list.map((s) => [s.t, s.expiry]));
  }
  return cases;
}

const pure = await pureCases();
const scenarios = [];
const defs = [
  ["live-day", liveDay],
  ["holiday", holiday],
  ["day-roll", dayRoll],
  ["flat-day-roll", flatDayRoll],
  ["prev-close-backfill", prevCloseBackfill],
  ["frame-backfill", frameBackfill],
  ["futures-backfill", futBackfill],
  ["gap-detectors", gapDetectors],
  ["coarsen", coarsen],
  ["merge-rules", mergeRules],
  ["window-agg", windowAgg],
  ["snapshots", snapshots],
  ["write-behind", writeBehind],
  ["warm-load", warmLoad],
  ["warm-load-stale", warmLoadStale],
  ["scheduler", scheduler],
  ["post-login", postLogin],
  ["gate", gate],
  ["chain-routes", chainRoutes],
];
for (const [name, make] of defs) scenarios.push(await scenario(name, make()));

const out = path.join(here, "analytics.golden.json");
const lines = [
  `{"extraSessionDays":${JSON.stringify(EXTRA)},`,
  `"universes":${JSON.stringify(universes)},`,
  `"pure":[\n${pure.map((c) => JSON.stringify(c, replacer)).join(",\n")}\n],`,
  `"scenarios":[\n${scenarios.map((s) => JSON.stringify(s, replacer)).join(",\n")}\n]}`,
];
fs.writeFileSync(out, lines.join("\n") + "\n");
process.stdout.write(`wrote ${out}: ${pure.length} pure cases, ${scenarios.length} scenarios, ${scenarios.reduce((n, s) => n + s.steps.length, 0)} steps\n`);
