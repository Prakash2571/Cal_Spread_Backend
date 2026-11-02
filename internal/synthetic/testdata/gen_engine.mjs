// Golden generator for src/synthetic/engine.ts and src/synthetic/routes.ts. It drives the
// ORIGINAL TypeScript, unmodified, through scripted scenarios and records what an observer
// sees after every step. Run from the repo root:
//
//   scratch/go-migration/check.sh node internal/synthetic/testdata/gen_engine.mjs
//
// writes testdata/engine_golden.json, which engine_golden_test.go replays against the Go
// engine and routes.
//
// Determinism model (the Go replay implements the same one):
// - Time is a fake clock. Date.now, setInterval, setTimeout and their clear functions are
//   replaced before the engine is imported. `advance(ms)` fires due timers one at a time in
//   (due, creation) order, each followed by a settle.
// - Every asynchronous dependency call (store, REST quotes, instrument dump, board, basket
//   margin) is recorded and then PARKED. Its effect and outcome are computed when it is
//   called (a database executes a request when it arrives); the answer is delivered later.
//   `settle()` delivers parked answers one at a time, oldest first, and lets the engine run
//   until nothing can move before delivering the next. Kinds can be held back and released
//   explicitly to script races.
// - Synchronous dependencies (setTokens, isAuthenticated, ...) answer at once; setTokens is
//   recorded in the same call log.
// After every step the generator records: the calls made, SSE frames written to each fake
// client, the results of operations that finished, getStatus(), getOpenPositions() and a
// digest of the full opportunity list (each only when it changed since the last record).
// JSON is stored as text so the Go side can compare key order exactly.
//
// Scenarios: lifecycle, manual-close, delete and settings (2026-10-28); sse-exits,
// closing-bell, budget-shared, budget-own, restart-switch, store-failures and routes
// (2026-10-29: SSE frames, every exit kind, SYNTH_SHARE_BOX_BUDGET on and off, restart
// re-linking and broker-switch staleness, the closing bell, storage failures, route edge
// cases). GEN_DEBUG=1 prints what the new scenarios check along the way.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import querystring from "node:querystring";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.execArgv.includes("--experimental-transform-types")) {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning",
    fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
register(pathToFileURL(path.join(root, "internal/brokers/dhan/testdata/ts_hooks.mjs")).href);
for (const k of Object.keys(process.env)) if (/^(BOX_|SYNTH_|FUT_)/.test(k)) delete process.env[k];

/* ------------------------------- fake clock and timers ------------------------------- */

const real = { setImmediate: globalThis.setImmediate, setTimeout: globalThis.setTimeout };
const clock = { now: 0 };
Date.now = () => clock.now;
let timers = []; // { id, due, interval|null, fn }
let timerSeq = 0;
function addTimer(fn, ms, repeat) {
  let delay = Math.trunc(Number(ms));
  if (!(delay >= 1)) delay = 1;
  const t = { id: ++timerSeq, due: clock.now + delay, interval: repeat ? delay : null, fn };
  timers.push(t);
  return { _fake: t, unref() { return this; }, ref() { return this; }, hasRef() { return false; } };
}
function clearTimer(h) {
  if (h && h._fake) timers = timers.filter((t) => t !== h._fake);
}
globalThis.setTimeout = (fn, ms, ...args) => addTimer(() => fn(...args), ms, false);
globalThis.setInterval = (fn, ms, ...args) => addTimer(() => fn(...args), ms, true);
globalThis.clearTimeout = clearTimer;
globalThis.clearInterval = clearTimer;

const consoleLines = [];
console.log = (...a) => consoleLines.push(a.map(String).join(" "));
console.warn = console.log;
console.error = console.log;

const load = (rel, q = "") => import(pathToFileURL(path.join(root, rel)).href + q);
const E = await load("src/synthetic/engine.ts");
const C = await load("src/synthetic/config.ts");
const M = await load("src/synthetic/math.ts");
let routesInstance = 0;
async function loadRoutes() {
  // A fresh module instance per engine, so its delete limiter starts empty (one per
  // process in Node). The limiter's sweep interval is not part of the engine's timers.
  const saved = globalThis.setInterval;
  globalThis.setInterval = () => ({ unref() { return this; } });
  try {
    return await load("src/synthetic/routes.ts", `?instance=${++routesInstance}`);
  } finally {
    globalThis.setInterval = saved;
  }
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => real.setImmediate(r));
};

/* ----------------------------------- fake async I/O ----------------------------------- */

const io = { log: [], pending: [], held: new Set(), faults: {}, seq: 0 };
const snap = (v) => JSON.parse(JSON.stringify(v ?? null));

/**
 * One asynchronous dependency call. `exec(fault)` runs NOW (the effect happens when the
 * request arrives) and returns the value or throws; the answer is delivered when the call
 * is released. `fault` is the next scripted outcome for this kind, if any.
 */
function ioCall(kind, args, exec) {
  io.log.push(JSON.stringify({ kind, args: snap(args) }));
  const fault = io.faults[kind]?.length ? io.faults[kind].shift() : undefined;
  let outcome;
  try {
    outcome = { value: exec(fault) };
  } catch (err) {
    outcome = { error: err };
  }
  return new Promise((resolve, reject) => {
    io.pending.push({ seq: ++io.seq, kind, release: () => (outcome.error ? reject(outcome.error) : resolve(outcome.value)) });
  });
}

async function settle() {
  await flush();
  for (let guard = 0; guard < 100000; guard++) {
    const i = io.pending.findIndex((p) => !io.held.has(p.kind));
    if (i < 0) return;
    const [p] = io.pending.splice(i, 1);
    p.release();
    await flush();
  }
  throw new Error("settle: runaway");
}

function failIf(f) {
  if (f && f.error !== undefined && !f.apply) throw new Error(f.error);
}
function failAfter(f) {
  if (f && f.error !== undefined && f.apply) throw new Error(f.error);
}

/* --------------------------------------- store ---------------------------------------- */

const LEG_ORDER = ["role", "side", "instrument_type", "strike", "tradingsymbol", "token", "entry_price", "entry_bid",
  "entry_ask", "entry_bid_qty", "entry_ask_qty", "entry_qty_at_touch", "entry_age_ms", "entry_depth", "exit_price",
  "exit_bid", "exit_ask", "exit_bid_qty", "exit_ask_qty", "exit_qty_at_touch", "exit_age_ms", "exit_depth"];
const LEG_DEFAULT = { strike: 0, token: 0, entry_bid: 0, entry_ask: 0 };
const MARGIN_KEYS = ["margin", "margin_source", "margin_hedge_benefit", "margin_at", "margin_error"];
const isHexId = (id) => typeof id === "string" && /^[0-9a-fA-F]{24}$/.test(id);

/** A trade as the store keeps it: legs carry every schema field (null when never set). */
function storedDoc(t) {
  const legs = (t.legs ?? []).map((l) => {
    const out = {};
    for (const k of LEG_ORDER) out[k] = l[k] === undefined ? (LEG_DEFAULT[k] ?? null) : l[k];
    return out;
  });
  return JSON.stringify({ ...t, legs });
}

class MemStore {
  constructor() {
    this.rows = new Map(); // id -> { status, doc, deleted_from }
    this.settings = {}; // key -> value (raw, may be invalid)
    this.enabledFlag = true;
    this.idSeq = 0;
  }
  enabled() {
    return this.enabledFlag;
  }
  newId() {
    return "5f" + (++this.idSeq).toString(16).padStart(22, "0");
  }
  read(id) {
    if (!isHexId(id)) return null;
    const r = this.rows.get(id.toLowerCase());
    if (!r) return null;
    const t = JSON.parse(r.doc);
    if (r.status !== "deleted") return { ...t, status: r.status === "open" ? "open" : "closed" };
    return { ...t, status: "closed", deleted: true, deleted_from: r.deleted_from === "open" ? "open" : "closed" };
  }
  ensureReady() {
    return ioCall("store.ensureReady", [], (f) => { failIf(f); failAfter(f); return undefined; });
  }
  get(id) {
    return ioCall("store.get", [id], (f) => { failIf(f); return this.read(id); });
  }
  insertOpen(trade) {
    return ioCall("store.insertOpen", [trade], (f) => {
      failIf(f);
      let res = "ok";
      const dup = this.rows.has(trade.id) ||
        [...this.rows.values()].some((r) => r.status === "open" && JSON.parse(r.doc).underlying === trade.underlying);
      if (dup) res = "duplicate";
      else this.rows.set(trade.id, { status: "open", doc: storedDoc(trade), deleted_from: null });
      failAfter(f);
      return res;
    });
  }
  close(trade) {
    return ioCall("store.close", [trade], (f) => {
      failIf(f);
      const r = this.rows.get(trade.id);
      let won = false;
      if (r && r.status === "open") {
        const before = JSON.parse(r.doc);
        const next = JSON.parse(storedDoc(trade));
        for (const k of MARGIN_KEYS) next[k] = before[k];
        r.status = "closed";
        r.doc = JSON.stringify(next);
        won = true;
      }
      failAfter(f);
      return won;
    });
  }
  setMargin(id, patch) {
    return ioCall("store.setMargin", [id, patch], (f) => {
      failIf(f);
      const r = isHexId(id) ? this.rows.get(id.toLowerCase()) : undefined;
      if (r && r.status !== "deleted") {
        const doc = JSON.parse(r.doc);
        for (const k of MARGIN_KEYS) doc[k] = patch[k];
        r.doc = JSON.stringify(doc);
      }
      failAfter(f);
      return undefined;
    });
  }
  markDeleted(id, from, audit) {
    return ioCall("store.markDeleted", [id, from, audit], (f) => {
      failIf(f);
      if (f && f.value !== undefined) return f.value; // scripted answer, nothing written
      let ok = false;
      const r = isHexId(id) ? this.rows.get(id.toLowerCase()) : undefined;
      if (r && r.status === from) {
        r.status = "deleted";
        r.deleted_from = from;
        ok = true;
      }
      failAfter(f);
      return ok;
    });
  }
  loadOpen() {
    return ioCall("store.loadOpen", [], (f) => {
      failIf(f);
      return [...this.rows.entries()].filter(([, r]) => r.status === "open")
        .map(([id]) => this.read(id))
        .sort((a, b) => a.opened_at - b.opened_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    });
  }
  loadClosed(opts) {
    return ioCall("store.loadClosed", [opts], (f) => {
      failIf(f);
      let rows = [...this.rows.entries()].filter(([, r]) => r.status === "closed").map(([id]) => this.read(id));
      if (opts.sinceDay !== undefined) rows = rows.filter((t) => t.closed_day !== null && t.closed_day >= opts.sinceDay);
      rows.sort((a, b) => (b.closed_at ?? -Infinity) - (a.closed_at ?? -Infinity) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      return opts.limit > 0 ? rows.slice(0, opts.limit) : rows;
    });
  }
  loadSettings() {
    return ioCall("store.loadSettings", [], (f) => {
      failIf(f);
      const out = {};
      for (const key of C.SYNTH_SETTING_KEYS) {
        const v = this.settings[key];
        if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
      }
      return out;
    });
  }
  saveSettings(values) {
    return ioCall("store.saveSettings", [values], (f) => {
      failIf(f);
      for (const key of C.SYNTH_SETTING_KEYS) this.settings[key] = values[key];
      failAfter(f);
      return undefined;
    });
  }
}

/* ------------------------------------- universe --------------------------------------- */

const TODAY = "2026-10-28";
function buildUniverse(tokenBase, prefix = "") {
  const all = [];
  let token = tokenBase;
  const sym = (name, expiry, strike, type) => {
    const d = expiry.replaceAll("-", "").slice(2);
    return type === "FUT" ? `${prefix}${name}${d}FUT` : `${prefix}${name}${d}${strike}${type}`;
  };
  const row = (name, type, expiry, strike, lot, tick = 0.05) => {
    all.push({ instrument_token: token, exchange_token: token + 7, tradingsymbol: sym(name, expiry, strike, type), name,
      last_price: 0, expiry, strike: type === "FUT" ? 0 : strike, tick_size: tick, lot_size: lot, instrument_type: type,
      segment: type === "FUT" ? "NFO-FUT" : "NFO-OPT", exchange: "NFO" });
    token++;
  };
  const chain = (name, expiry, lo, hi, step, lot) => {
    for (let k = lo; k <= hi + 1e-9; k += step) {
      row(name, "CE", expiry, k, lot);
      row(name, "PE", expiry, k, lot);
    }
  };
  row("NIFTY", "FUT", "2026-11-24", 0, 75);
  chain("NIFTY", "2026-11-24", 24700, 25300, 50, 75);
  chain("NIFTY", "2026-10-30", 24900, 25100, 50, 75); // weekly: no future, never paired
  row("BANKNIFTY", "FUT", "2026-11-24", 0, 30);
  chain("BANKNIFTY", "2026-11-24", 55500, 56500, 100, 30);
  row("RELIANCE", "FUT", "2026-11-24", 0, 500);
  chain("RELIANCE", "2026-11-24", 2800, 3000, 20, 500);
  row("M&MFIN", "FUT", "2026-11-24", 0, 2000);
  chain("M&MFIN", "2026-11-24", 300, 340, 5, 2000);
  row("M&M", "FUT", "2026-11-24", 0, 200);
  chain("M&M", "2026-11-24", 3300, 3500, 20, 200);
  row("TODAYCO", "FUT", TODAY, 0, 1000);
  chain("TODAYCO", TODAY, 90, 110, 2.5, 1000);
  row("NOOPT", "FUT", "2026-11-24", 0, 400);
  all.push({ instrument_token: token++, exchange_token: 1, tradingsymbol: "NIFTY 50", name: "NIFTY", last_price: 0,
    expiry: "", strike: 0, tick_size: 0.05, lot_size: 0, instrument_type: "EQ", segment: "INDICES", exchange: "NSE" });
  return all;
}
const BOARD = [
  { symbol: "RELIANCE", name: "RELIANCE INDUSTRIES" },
  { symbol: "NIFTY", name: "NIFTY 50", is_index: true },
  { symbol: "M&MFIN", name: "M&M FINANCIAL" },
  { symbol: "M&M", name: "MAHINDRA & MAHINDRA" },
  { symbol: "BANKNIFTY", name: "NIFTY BANK", is_index: true },
  { symbol: "TODAYCO", name: "TODAY CO" },
  { symbol: "NOOPT", name: "NO OPTIONS" },
  { symbol: "ABSENT", name: "NOT LISTED" },
];
const UNIVERSES = { kite: buildUniverse(1001), dhan: buildUniverse(50001) };
// The kite universe without RELIANCE's 2900 strike: a position on it cannot be re-linked.
UNIVERSES.thin = UNIVERSES.kite.filter((i) => !(i.name === "RELIANCE" && i.strike === 2900));

function inst(universe, name, type, strike, expiry = name === "TODAYCO" ? TODAY : "2026-11-24") {
  const hit = UNIVERSES[universe].find((i) => i.exchange === "NFO" && i.name === name && i.instrument_type === type &&
    i.expiry === expiry && (type === "FUT" || i.strike === strike));
  if (!hit) throw new Error(`no instrument ${name} ${type} ${strike}`);
  return hit;
}
const tok = (u, name, type, strike) => inst(u, name, type, strike).instrument_token;

/** A depth tick: one level a side (or none when the price is 0). */
function book(token, bid, bidQty, ask, askQty, last = 0, extra = {}) {
  return { token, last_price: last || (bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask), bid, ask,
    bids: bid > 0 ? [{ price: bid, qty: bidQty, orders: 3 }] : [], asks: ask > 0 ? [{ price: ask, qty: askQty, orders: 2 }] : [],
    depth_updated: true, ...extra };
}

/**
 * Parity-consistent books for one underlying: future (bid/ask around F) and, for each
 * strike, CE/PE whose mid satisfies K + C - P = F. `skew` adds a mispricing per strike:
 * { [K]: { ce: +x, pe: +y } } shifts that leg's bid and ask.
 */
function chainBooks(u, name, F, strikes, opts = {}) {
  const sp = opts.spread ?? 0.5;
  const q = opts.qty ?? 5000;
  const tv = opts.tv ?? 80;
  const out = [book(tok(u, name, "FUT", 0), F - sp / 2, q, F + sp / 2, q)];
  for (const K of strikes) {
    const ce = Math.max(F - K, 0) + tv;
    const pe = ce - (F - K);
    const sk = opts.skew?.[K] ?? {};
    const cm = ce + (sk.ce ?? 0);
    const pm = pe + (sk.pe ?? 0);
    out.push(book(tok(u, name, "CE", K), round2(cm - sp / 2), q, round2(cm + sp / 2), q));
    out.push(book(tok(u, name, "PE", K), round2(pm - sp / 2), q, round2(pm + sp / 2), q));
  }
  return out;
}
const round2 = (v) => Math.round(v * 100) / 100;

/* -------------------------------------- scenarios -------------------------------------- */

function istMs(day, hhmm, ss = 0) {
  const [h, m] = hhmm.split(":").map(Number);
  return Date.parse(`${day}T00:00:00.000Z`) + ((h * 60 + m) * 60 + ss) * 1000 - 5.5 * 3600 * 1000;
}
function isMarketOpenAt(ms) {
  const ist = new Date(ms + 5.5 * 60 * 60 * 1000);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 40;
}

const golden = { generated_by: "internal/synthetic/testdata/gen_engine.mjs", today: TODAY, universes: UNIVERSES,
  board: BOARD, scenarios: [] };

class Scenario {
  constructor(name, spec) {
    this.name = name;
    this.spec = spec;
    this.steps = [];
    this.env = spec.env ?? {};
    for (const k of Object.keys(process.env)) if (/^(BOX_|SYNTH_)/.test(k)) delete process.env[k];
    Object.assign(process.env, this.env);
    this.config = C.loadSynthConfig();
    clock.now = spec.start;
    timers = [];
    timerSeq = 0;
    io.log = [];
    io.pending = [];
    io.held = new Set();
    io.faults = {};
    io.seq = 0;
    this.w = {
      auth: spec.auth ?? true,
      marketOpen: spec.marketOpen ?? null,
      switching: false,
      generation: 1,
      broker: spec.broker ?? "zerodha",
      rf: spec.rf ?? null,
      boxLane: spec.boxLane ?? null,
      universe: "kite",
      rest: {},
      marginDefault: spec.marginDefault ?? { value: { initial: 101000, final: 98765.4, total: 98765.4, source: "kite_basket", hedge_benefit: 51234.5 } },
      sessions: { "tok-full": "full", "tok-trade": "trade" },
    };
    this.hasMargins = spec.margins ?? true;
    this.hasBoxLane = spec.boxLane !== undefined && spec.boxLane !== null;
    this.store = new MemStore();
    this.store.enabledFlag = spec.storeEnabled ?? true;
    this.clients = new Map();
    this.ops = new Map();
    this.opSeq = 0;
    this.last = { status: null, open: null, opps: null };
    this.newEngine();
    golden.scenarios.push({ name, env: this.env, start: spec.start,
      world: { auth: this.w.auth, marketOpen: this.w.marketOpen, broker: this.w.broker, rf: this.w.rf,
        boxLane: this.w.boxLane, margins: this.hasMargins, marginDefault: this.w.marginDefault,
        storeEnabled: this.store.enabledFlag }, steps: this.steps });
  }

  deps() {
    const w = this.w;
    const universe = () => UNIVERSES[w.universe];
    const idToToken = () => new Map(universe().map((i) => [`${i.exchange}:${i.tradingsymbol}`, i.instrument_token]));
    return {
      getAllInstruments: () => ioCall("getAllInstruments", [], (f) => { failIf(f); return snap(universe()); }),
      getBoard: () => ioCall("getBoard", [], (f) => { failIf(f); return snap(BOARD); }),
      marketData: {
        isAuthenticated: () => w.auth,
        getQuoteFull: (ids) => ioCall("getQuoteFull", [ids], (f) => {
          failIf(f);
          const m = idToToken();
          const out = [];
          for (const id of ids) {
            const t = m.get(id);
            const q = t === undefined ? undefined : w.rest[t];
            if (q) out.push({ instrument_token: t, last_price: q.last_price, last_trade_time: q.last_trade_time });
          }
          return out;
        }),
      },
      isMarketOpen: () => (w.marketOpen === null ? isMarketOpenAt(Date.now()) : w.marketOpen),
      istDayKey: (at = Date.now()) => new Date(at + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10),
      makeIdResolver: (all) => {
        const byToken = new Map();
        for (const i of all) byToken.set(i.instrument_token, `${i.exchange}:${i.tradingsymbol}`);
        return (token) => byToken.get(token) ?? null;
      },
      getRfPct: () => w.rf,
      activeBroker: () => w.broker,
      setTokens: (tokens) => { io.log.push(JSON.stringify({ kind: "setTokens", args: [[...tokens]] })); },
      store: this.store,
      margins: this.hasMargins
        ? { broker: w.broker, basketMargin: (orders, opts) => ioCall("basketMargin", [orders, opts], (f) => {
          const r = f ?? w.marginDefault;
          if (r.error !== undefined) throw new Error(r.error);
          const v = { ...r.value };
          if (v.total === "NaN") v.total = NaN;
          return v;
        }) }
        : undefined,
      boxLane: this.hasBoxLane ? () => ({ ...w.boxLane }) : undefined,
      switching: () => w.switching,
      brokerGeneration: () => w.generation,
      config: this.config,
    };
  }

  newEngine() {
    this.engine = new E.SyntheticEngine(this.deps());
    this.app = null;
  }

  async routes() {
    if (this.app) return this.app;
    const R = await loadRoutes();
    const routes = [];
    const add = (method) => (p, ...handlers) => routes.push({ method, path: p, handlers });
    const w = this.w;
    const getAdminRole = (token) => (token ? w.sessions[token] ?? null : null);
    const requireAdmin = (req, res, next) => {
      const token = req.headers["x-admin-token"];
      if (getAdminRole(token) === null) {
        res.status(403).json({ error: "Admin authentication required" });
        return;
      }
      next();
    };
    R.registerSyntheticRoutes({ get: add("GET"), post: add("POST"), delete: add("DELETE") },
      { engine: this.engine, requireAdmin, getAdminRole });
    this.app = routes;
    return routes;
  }

  /** Run one operation; `fn` returns a value or a promise. */
  startOp(kind, fn, toJSON = (v) => JSON.stringify(v ?? null)) {
    const id = ++this.opSeq;
    const op = { id, kind, done: false, result: null };
    this.ops.set(id, op);
    const finish = (r) => { op.done = true; op.result = r; };
    try {
      const v = fn();
      if (v && typeof v.then === "function") {
        v.then((x) => finish({ ok: toJSON(x) }), (err) => finish({ throw: String(err?.message ?? err) }));
      } else finish({ ok: toJSON(v) });
    } catch (err) {
      finish({ throw: String(err?.message ?? err) });
    }
    return op;
  }

  async record(op, params, extra = {}) {
    await settle();
    const out = { calls: io.log };
    io.log = [];
    const frames = {};
    for (const [name, c] of this.clients) {
      if (c.frames.length > 0 || c.ended !== c.reportedEnded) {
        frames[name] = { frames: c.frames, ended: c.ended };
        c.frames = [];
        c.reportedEnded = c.ended;
      }
    }
    if (Object.keys(frames).length > 0) out.frames = frames;
    const settled = [];
    for (const o of this.ops.values()) {
      if (o.done) {
        settled.push({ op: o.id, kind: o.kind, ...o.result });
        this.ops.delete(o.id);
      }
    }
    if (settled.length > 0) out.settled = settled;
    const status = JSON.stringify(this.engine.getStatus());
    if (status !== this.last.status) out.status = this.last.status = status;
    const open = JSON.stringify(this.engine.getOpenPositions());
    if (open !== this.last.open) out.open = this.last.open = open;
    const opps = JSON.stringify(this.engine.opportunities.map((o) =>
      [o.key, o.status, o.reject, o.entry_blocked, o.expected_net_profit, o.position_id]));
    if (opps !== this.last.opps) out.opps = this.last.opps = opps;
    if (extra.fullOpps) out.published = JSON.stringify(this.engine.getOpportunities());
    if (extra.fullList) out.full = JSON.stringify(this.engine.opportunities);
    out.pending = io.pending.map((p) => p.kind);
    this.steps.push({ op, ...params, out });
    return out;
  }

  // ---- operations (each one is a step) ----
  async boot() {
    const o = this.startOp("boot", () => this.engine.boot());
    return this.record("boot", { opId: o.id });
  }
  async call(name, args = [], extra = {}) {
    const o = this.startOp(name, () => this.engine[name](...args));
    return this.record("call", { name, args, opId: o.id }, extra);
  }
  async advance(ms, extra = {}) {
    const target = clock.now + ms;
    for (;;) {
      let next = null;
      for (const t of timers) if (t.due <= target && (!next || t.due < next.due || (t.due === next.due && t.id < next.id))) next = t;
      if (!next) break;
      clock.now = next.due;
      if (next.interval !== null) next.due += next.interval;
      else timers = timers.filter((t) => t !== next);
      next.fn();
      await settle();
    }
    clock.now = target;
    return this.record("advance", { ms }, extra);
  }
  async ticks(list, extra = {}) {
    const o = this.startOp("onTicks", () => this.engine.onTicks(list));
    return this.record("ticks", { ticks: list, opId: o.id }, extra);
  }
  async set(changes, extra = {}) {
    const w = this.w;
    for (const [k, v] of Object.entries(changes)) {
      switch (k) {
        case "auth": case "marketOpen": case "switching": case "generation": case "broker": case "rf":
        case "universe": case "marginDefault":
          w[k] = v;
          break;
        case "boxLane":
          w.boxLane = v;
          break;
        case "storeEnabled":
          this.store.enabledFlag = v;
          break;
        case "rest":
          for (const [t, q] of Object.entries(v)) {
            if (q === null) delete w.rest[t];
            else w.rest[t] = q;
          }
          break;
        case "faults":
          for (const [kind, list] of Object.entries(v)) (io.faults[kind] ??= []).push(...list);
          break;
        case "hold":
          for (const kind of v) io.held.add(kind);
          break;
        case "unhold":
          for (const kind of v) io.held.delete(kind);
          break;
        case "settings":
          Object.assign(this.store.settings, v);
          break;
        case "seedRows":
          for (const r of v) this.store.rows.set(JSON.parse(r.doc).id, { status: r.status, doc: storedDoc(JSON.parse(r.doc)), deleted_from: r.deleted_from ?? null });
          break;
        case "externalClose":
          for (const e of v) {
            const r = this.store.rows.get(e.id);
            const doc = { ...JSON.parse(r.doc), ...e.fields };
            r.status = "closed";
            r.doc = storedDoc(doc);
          }
          break;
        case "externalDelete":
          for (const id of v) {
            const r = this.store.rows.get(id);
            r.deleted_from = r.status;
            r.status = "deleted";
          }
          break;
        default:
          throw new Error(`set: unknown ${k}`);
      }
    }
    return this.record("set", { set: changes }, extra);
  }
  async release(kind, extra = {}) {
    const i = io.pending.findIndex((p) => p.kind === kind);
    if (i < 0) throw new Error(`release: nothing pending of ${kind}`);
    const [p] = io.pending.splice(i, 1);
    p.release();
    return this.record("release", { kind }, extra);
  }
  async sseAdd(name) {
    const c = { frames: [], ended: false, reportedEnded: false };
    const res = { write: (s) => { c.frames.push(s); return true; }, end: () => { c.ended = true; } };
    this.clients.set(name, c);
    c.remove = this.engine.addSseClient(res);
    return this.record("sseAdd", { name });
  }
  async sseRemove(name) {
    this.clients.get(name).remove();
    return this.record("sseRemove", { name });
  }
  /** Simulate a process restart on the same store: the old engine's timers die with it. */
  async restart(extra = {}) {
    timers = [];
    for (const c of this.clients.values()) c.ended = true;
    this.clients.clear();
    this.newEngine();
    return this.record("restart", {}, extra);
  }
  async http(method, p, opts = {}) {
    const routes = await this.routes();
    const [pathname, query = ""] = p.split("?");
    let route = null;
    let params = null;
    for (const r of routes) {
      if (r.method !== method) continue;
      const rp = r.path.split("/");
      const up = pathname.split("/");
      if (rp.length !== up.length) continue;
      const ps = {};
      let ok = true;
      for (let i = 0; i < rp.length; i++) {
        if (rp[i].startsWith(":")) ps[rp[i].slice(1)] = decodeURIComponent(up[i]);
        else if (rp[i] !== up[i]) { ok = false; break; }
      }
      if (ok) { route = r; params = ps; break; }
    }
    if (!route) throw new Error(`no route ${method} ${p}`);
    const headers = {};
    if (opts.token !== undefined) headers["x-admin-token"] = opts.token;
    if (opts.xff !== undefined) headers["x-forwarded-for"] = opts.xff;
    const req = { method, params, query: querystring.parse(query), headers, body: opts.body,
      header(n) { return this.headers[n.toLowerCase()]; }, get(n) { return this.headers[n.toLowerCase()]; },
      socket: { remoteAddress: "127.0.0.1" }, on() {} };
    // The request is answered when a handler writes the JSON response (every route here
    // returns right after it does).
    const o = this.startOp("http", () => new Promise((resolve, reject) => {
      const res = { statusCode: 200, hdrs: {},
        status(c) { this.statusCode = c; return this; },
        json(b) {
          const out = { status: this.statusCode, body: JSON.stringify(b) };
          if (this.hdrs["retry-after"] !== undefined) out.retry_after = this.hdrs["retry-after"];
          resolve(out);
          return this;
        },
        setHeader(k, v) { this.hdrs[k.toLowerCase()] = String(v); },
        getHeader(k) { return this.hdrs[k.toLowerCase()]; } };
      let i = 0;
      const next = () => {
        const h = route.handlers[i++];
        if (!h) return;
        try {
          const r = h(req, res, next);
          if (r && typeof r.then === "function") r.then(undefined, reject);
        } catch (err) {
          reject(err);
        }
      };
      next();
    }), (v) => JSON.stringify(v));
    const params2 = { method, path: p };
    if (opts.token !== undefined) params2.token = opts.token;
    if (opts.xff !== undefined) params2.xff = opts.xff;
    if (opts.body !== undefined) params2.body = JSON.stringify(opts.body);
    params2.opId = o.id;
    return this.record("http", params2, opts.extra ?? {});
  }
  assert(cond, msg) {
    if (!cond) throw new Error(`[${this.name}] ${msg}`);
  }
  status() {
    return this.engine.getStatus();
  }
  lastSettled(out) {
    return out.settled?.[out.settled.length - 1];
  }
}

/* ------------------------------------ scenario bodies ------------------------------------ */

const START = istMs(TODAY, "10:00");
const restOf = (u, name, price, time = "2026-10-28 09:59:58") => ({ [tok(u, name, "FUT", 0)]: { last_price: price, last_trade_time: time } });
const NIFTY_K = [24950, 25000, 25050];
const REL_K = [2880, 2900, 2920];

// The NIFTY CONVERSION at 25000 is rich: CE bid shifted +30 makes K + CE.bid - PE.ask - FUT.ask large.
const niftyRich = (F = 25010, extra = {}) => chainBooks("kite", "NIFTY", F, NIFTY_K, { skew: { 25000: { ce: 30 } }, ...extra });
const niftyFair = (F = 25010, extra = {}) => chainBooks("kite", "NIFTY", F, NIFTY_K, extra);
const relFair = (F = 2901, extra = {}) => chainBooks("kite", "RELIANCE", F, REL_K, { tv: 40, ...extra });
const relRich = (F = 2901, extra = {}) => chainBooks("kite", "RELIANCE", F, REL_K, { tv: 40, skew: { 2900: { ce: 6 } }, ...extra });

async function scenarioLifecycle() {
  const s = new Scenario("lifecycle", {
    start: START, rf: 6.5,
    env: { SYNTH_STRIKE_LEVEL: "1", SYNTH_EVAL_INTERVAL_MS: "1000", SYNTH_PUBLISH_INTERVAL_MS: "1000" },
  });
  await s.set({ rest: { ...restOf("kite", "NIFTY", 25010.25), ...restOf("kite", "RELIANCE", 2901.5), ...restOf("kite", "M&M", 3402) } });
  await s.boot();
  await s.call("getStatus");
  let out = await s.call("start");
  s.assert(s.lastSettled(out)?.ok === '{"ok":true}', "start ok");
  s.assert(s.status().monitored_underlyings >= 2, "windows built");
  await s.call("getChain", ["NIFTY"]);
  await s.call("getChain", ["ABSENT"]);
  await s.ticks([...niftyRich(), ...relFair()]);
  await s.advance(1000, { fullOpps: true });
  s.assert(s.engine.opportunities.some((o) => o.status === "ELIGIBLE" && o.entry_blocked === "confirming"), "confirming");
  await s.advance(1000); // same books: still confirming
  await s.ticks([...niftyRich(), ...relFair()]);
  out = await s.advance(1000, { fullOpps: true });
  s.assert(s.status().open_count === 1, "entered");
  await s.call("getOpportunities", [3]);
  await s.call("getOpportunities", [0.5]);
  await s.call("getChain", ["NIFTY"]);
  // Re-entry is blocked: position open, and later the cooldown.
  await s.ticks([...niftyRich(), ...relFair()]);
  await s.advance(1000);
  // Prices converge: the CE falls back to fair. Exit needs two confirmations on new books.
  await s.ticks([...niftyFair(), ...relFair()]);
  await s.advance(1000);
  s.assert(s.status().open_count === 1, "first exit confirmation");
  await s.advance(1000); // no new books: no new confirmation
  await s.ticks([...niftyFair(), ...relFair()]);
  await s.advance(1000);
  s.assert(s.status().open_count === 0 && s.status().day_pnl.closed_count === 1, "converged exit");
  await s.call("getHistory", ["today", 500]);
  await s.call("getHistory", ["all", 1]);
  await s.ticks([...niftyRich(), ...relFair()]);
  await s.advance(1000);
  await s.ticks([...niftyRich(), ...relFair()]);
  await s.advance(1000, { fullOpps: true });
  s.assert(s.engine.opportunities.some((o) => o.entry_blocked === "cooldown"), "cooldown");
  // Feed goes quiet: rows show feed_stale and status feed_healthy false.
  await s.advance(11000);
  await s.call("stop");
  await s.advance(1000);
  await s.call("start");
  await s.call("dispose");
}

async function scenarioManualClose() {
  const s = new Scenario("manual-close", {
    start: START,
    env: { SYNTH_STRIKE_LEVEL: "1", SYNTH_EVAL_INTERVAL_MS: "1000", SYNTH_SIGNAL_CONFIRMATIONS: "1" },
  });
  await s.set({ rest: { ...restOf("kite", "NIFTY", 25010.25) } });
  await s.boot();
  await s.call("start");
  await s.ticks(niftyRich());
  await s.advance(1000);
  s.assert(s.status().open_count === 1, "entered");
  const id = s.engine.getOpenPositions()[0].id;
  await s.http("POST", `/api/synthetic/trades/${"0".repeat(24)}/close`, { token: "tok-trade" });
  await s.http("POST", `/api/synthetic/trades/${id}/close`, {});
  // Not executable. Closing a CONVERSION sells the future (needs a bid), buys the CE (needs
  // an ask) and sells the PE: no bid and no ask, then a stale book, a crossed book and a
  // thin touch.
  const [fut, ce, pe] = [tok("kite", "NIFTY", "FUT", 0), tok("kite", "NIFTY", "CE", 25000), tok("kite", "NIFTY", "PE", 25000)];
  await s.ticks([book(fut, 0, 0, 25011, 900), book(ce, 180, 900, 0, 0), book(pe, 109.5, 900, 110, 900)]);
  await s.http("POST", `/api/synthetic/trades/${id}/close`, { token: "tok-trade" });
  await s.advance(16000);
  await s.ticks([book(fut, 25009.5, 900, 25010, 900), book(ce, 180, 900, 181, 900)]);
  await s.http("POST", `/api/synthetic/trades/${id}/close`, { token: "tok-trade" });
  await s.ticks([book(pe, 111, 900, 110, 900)]);
  await s.http("POST", `/api/synthetic/trades/${id}/close`, { token: "tok-trade" });
  await s.ticks([book(pe, 109.5, 10, 110, 10)]);
  await s.http("POST", `/api/synthetic/trades/${id}/close`, { token: "tok-trade" });
  await s.ticks(niftyFair());
  await s.set({ marketOpen: false });
  await s.http("POST", `/api/synthetic/trades/${id}/close`, { token: "tok-trade" });
  await s.set({ marketOpen: null });
  // Already closing: hold the store write, close twice.
  await s.set({ hold: ["store.close"] });
  await s.http("POST", `/api/synthetic/trades/${id}/close`, { token: "tok-full" });
  await s.http("POST", `/api/synthetic/trades/${id}/close`, { token: "tok-trade" });
  await s.call("getOpenPositions");
  await s.release("store.close");
  await s.set({ unhold: ["store.close"] });
  s.assert(s.status().open_count === 0, "closed manually");
  // Lost race: another process closes the row first.
  await s.advance(61000);
  await s.ticks(niftyRich());
  await s.advance(1000);
  s.assert(s.status().open_count === 1, "re-entered");
  const id2 = s.engine.getOpenPositions()[0].id;
  await s.set({ externalClose: [{ id: id2, fields: { status: "closed", closed_at: clock.now, closed_day: TODAY,
    exit_reason: "MANUAL", gross_pnl: 1000, exit_charges: 500, total_charges: 800, net_pnl: 200, exit_note: null } }] });
  await s.ticks(niftyFair());
  await s.http("POST", `/api/synthetic/trades/${id2}/close`, { token: "tok-trade" });
  await s.call("getHistory", ["today", 10]);
  // Unlinked after a namespace change.
  await s.advance(61000);
  await s.ticks(niftyRich());
  await s.advance(1000);
  const id3 = s.engine.getOpenPositions()[0]?.id;
  s.assert(id3, "third entry");
  await s.call("invalidateNamespace");
  await s.http("POST", `/api/synthetic/trades/${id3}/close`, { token: "tok-trade" });
}

async function scenarioDelete() {
  const s = new Scenario("delete", {
    start: START,
    env: { SYNTH_STRIKE_LEVEL: "1", SYNTH_EVAL_INTERVAL_MS: "1000", SYNTH_SIGNAL_CONFIRMATIONS: "1", SYNTH_REENTRY_COOLDOWN_MS: "2000" },
  });
  await s.set({ rest: { ...restOf("kite", "NIFTY", 25010.25), ...restOf("kite", "RELIANCE", 2901.5) } });
  await s.boot();
  await s.call("start");
  await s.ticks([...niftyRich(), ...relFair()]);
  await s.advance(1000);
  const id = s.engine.getOpenPositions()[0].id;
  await s.http("DELETE", `/api/synthetic/trades/${id}`, { token: "tok-trade" });
  await s.http("DELETE", `/api/synthetic/trades/${id}`, {});
  await s.http("DELETE", `/api/synthetic/trades/${id}`, { token: "tok-full", body: { expected_status: "closed" } });
  // Being closed right now.
  await s.set({ hold: ["store.close"] });
  await s.http("POST", `/api/synthetic/trades/${id}/close`, { token: "tok-full" });
  await s.http("DELETE", `/api/synthetic/trades/${id}`, { token: "tok-full", body: { expected_status: "open" } });
  await s.release("store.close");
  await s.set({ unhold: ["store.close"] });
  // A closed trade: expected open is refused with the en-IN amount; then deleted.
  await s.http("DELETE", `/api/synthetic/trades/${id}`, { token: "tok-full", body: { expected_status: "open" } });
  await s.http("DELETE", `/api/synthetic/trades/${id}`, { token: "tok-full", body: { reason: `  ${"x".repeat(600)}  `, expected_status: "closed" } });
  await s.http("DELETE", `/api/synthetic/trades/${id}`, { token: "tok-full" }); // already deleted: idempotent
  await s.http("DELETE", "/api/synthetic/trades/nonsense", { token: "tok-full" });
  await s.http("DELETE", `/api/synthetic/trades/${"a".repeat(24)}`, { token: "tok-full" });
  // An open position: delete it (reason trimmed), tokens released, trade_deleted.
  await s.advance(3000);
  await s.ticks([...niftyRich(), ...relFair()]);
  await s.advance(1000);
  const id2 = s.engine.getOpenPositions()[0].id;
  await s.http("DELETE", `/api/synthetic/trades/${id2}`, { token: "tok-full", body: { reason: "  test entry  ", expected_status: "open" } });
  // The delete write fails but landed: reconciled from the stored row.
  await s.advance(3000);
  await s.ticks([...niftyRich(), ...relFair()]);
  await s.advance(1000);
  const id3 = s.engine.getOpenPositions()[0].id;
  await s.set({ faults: { "store.markDeleted": [{ error: "ack lost", apply: true }] } });
  await s.http("DELETE", `/api/synthetic/trades/${id3}`, { token: "tok-full", body: { reason: 42 } });
  // markDeleted matches nothing because the row was closed elsewhere meanwhile.
  await s.advance(3000);
  await s.ticks([...niftyRich(), ...relFair()]);
  await s.advance(1000);
  const id4 = s.engine.getOpenPositions()[0].id;
  await s.set({ externalClose: [{ id: id4, fields: { status: "closed", closed_at: clock.now, closed_day: TODAY,
    exit_reason: "PROFIT_CAPTURE", gross_pnl: 99999.4, exit_charges: 10, total_charges: 20, net_pnl: 1234567.89, exit_note: null } }] });
  await s.http("DELETE", `/api/synthetic/trades/${id4}`, { token: "tok-full" });
  // It is a closed row now (not in memory any more? still in memory: the engine never saw the close).
  await s.call("getOpenPositions");
  // Write error and read error: the route answers 500.
  await s.set({ faults: { "store.markDeleted": [{ error: "connection reset" }], "store.get": [{ error: "still down" }] } });
  await s.http("DELETE", `/api/synthetic/trades/${id4}`, { token: "tok-full" });
  // A fresh position (RELIANCE) whose delete matches nothing while the row still reads open.
  await s.advance(61000);
  await s.ticks([...niftyRich(), ...relRich()]);
  await s.advance(1000);
  const id5 = s.engine.getOpenPositions().find((t) => t.id !== id4)?.id;
  s.assert(id5, "fifth entry");
  await s.set({ faults: { "store.markDeleted": [{ value: false }] } });
  await s.http("DELETE", `/api/synthetic/trades/${id5}`, { token: "tok-full" });
  // Storage down: 503.
  await s.set({ storeEnabled: false });
  await s.http("DELETE", `/api/synthetic/trades/${id5}`, { token: "tok-full" });
  await s.set({ storeEnabled: true });
  await s.call("getHistory", ["today", 100]);
  // The limiter: 20 per minute per client, counted before auth.
  for (let i = 0; i < 8; i++) await s.http("DELETE", `/api/synthetic/trades/${"b".repeat(24)}`, { token: "tok-trade" });
  await s.http("DELETE", `/api/synthetic/trades/${"b".repeat(24)}`, { token: "tok-full", xff: "10.0.0.9, 10.0.0.1" });
  await s.advance(60000);
  await s.http("DELETE", `/api/synthetic/trades/${"b".repeat(24)}`, {});
}

async function scenarioSettings() {
  const s = new Scenario("settings", {
    start: START,
    env: { SYNTH_STRIKE_LEVEL: "2", SYNTH_EVAL_INTERVAL_MS: "1000", SYNTH_MAX_OPEN_POSITIONS: "3" },
    storeEnabled: false,
  });
  await s.set({ rest: { ...restOf("kite", "NIFTY", 25010.25) } });
  await s.boot();
  await s.http("GET", "/api/synthetic/status", { token: "tok-trade" });
  await s.http("GET", "/api/synthetic/status", { token: "nope" });
  const bad = [
    {}, { min_expected_net_profit: null }, { min_expected_net_profit: true }, { min_expected_net_profit: "" },
    { min_expected_net_profit: "abc" }, { min_expected_net_profit: -1 }, { min_expected_net_profit: 100001 },
    { safety_buffer: 50001 }, { max_open_positions: 2.5 }, { max_open_positions: 10001 }, { max_open_positions: "4.5" },
    { unknown: 5 }, { safety_buffer: "x", min_expected_net_profit: -5 },
  ];
  for (const body of bad) await s.http("POST", "/api/synthetic/settings", { token: "tok-full", body });
  await s.http("POST", "/api/synthetic/settings", { token: "tok-full" });
  // Storage unavailable: applied, not persisted.
  await s.http("POST", "/api/synthetic/settings", { token: "tok-trade", body: { min_expected_net_profit: "700", safety_buffer: 0, max_open_positions: 0 } });
  // Storage comes up: the next load attempt (30 s) saves the dirty change instead of applying stored values.
  await s.set({ storeEnabled: true, settings: { min_expected_net_profit: 900, safety_buffer: 50, max_open_positions: 2.5 } });
  await s.advance(30000);
  // Save failure rolls back with 503.
  await s.set({ faults: { "store.saveSettings": [{ error: "disk full" }] } });
  await s.http("POST", "/api/synthetic/settings", { token: "tok-full", body: { safety_buffer: 250 } });
  await s.http("POST", "/api/synthetic/settings", { token: "tok-full", body: { safety_buffer: "  250  ", max_open_positions: "1" } });
  // Strike level.
  for (const level of [undefined, 0, 1.5, "2", true, [3], "x", null, 4]) {
    await s.http("POST", "/api/synthetic/strike-level", { token: "tok-trade", body: level === undefined ? undefined : { level } });
  }
  await s.http("POST", "/api/synthetic/start", { token: "tok-trade" });
  await s.http("POST", "/api/synthetic/strike-level", { token: "tok-trade", body: { level: 1 } });
  await s.http("POST", "/api/synthetic/strike-level", { token: "tok-trade", body: { level: 3 } });
  await s.http("GET", "/api/synthetic/opportunities?limit=2", { token: "tok-trade" });
  await s.http("GET", "/api/synthetic/opportunities?limit=abc", { token: "tok-trade" });
  await s.http("GET", "/api/synthetic/opportunities?limit=1&limit=2", { token: "tok-trade" });
  await s.http("GET", "/api/synthetic/trades/open", { token: "tok-trade" });
  await s.http("GET", "/api/synthetic/trades/history?scope=today", { token: "tok-trade" });
  await s.http("GET", "/api/synthetic/trades/history?scope=all&limit=3.7", { token: "tok-trade" });
  await s.set({ faults: { "store.loadClosed": [{ error: "timeout" }] } });
  await s.http("GET", "/api/synthetic/trades/history?limit=99999", { token: "tok-trade" });
  await s.http("GET", "/api/synthetic/chain/nifty", { token: "tok-trade" });
  await s.http("GET", "/api/synthetic/chain/absent", { token: "tok-trade" });
  await s.http("POST", "/api/synthetic/stop", { token: "tok-trade" });
  // Restart: the saved settings are applied (an invalid saved value is ignored).
  await s.set({ settings: { max_open_positions: 2.5 } });
  await s.restart();
  await s.boot();
  await s.set({ auth: false });
  await s.http("POST", "/api/synthetic/start", { token: "tok-trade" });
  await s.set({ auth: true, switching: true });
  await s.http("POST", "/api/synthetic/start", { token: "tok-trade" });
}

/* ------------------------------ coverage scenarios ------------------------------ */
// Added 2026-10-29: SSE frames, every exit kind, the token budget with and without
// SYNTH_SHARE_BOX_BUDGET, restart/re-link/broker switch staleness, the closing bell,
// storage failures and the route cases the first four scenarios do not reach.

const DEBUG = process.env.GEN_DEBUG === "1";
const dbg = (...a) => { if (DEBUG) process.stdout.write(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n"); };
const TODAY_K = [97.5, 100, 102.5];
const todayFair = (F = 100.4, extra = {}) => chainBooks("kite", "TODAYCO", F, TODAY_K, { tv: 2, spread: 0.1, ...extra });
const todayRich = (F = 100.4, extra = {}) => todayFair(F, { skew: { 100: { ce: 1.5 } }, ...extra });
const openOf = (s, u) => s.engine.getOpenPositions().find((t) => t.underlying === u);
const showOpen = (s, label) => dbg(label, s.engine.getOpenPositions().map((t) => ({ u: t.underlying, rule: t.exit_rule_reason,
  blocked: t.exit_blocked_reason, net: t.net_pnl, rem: t.remaining_edge, thr: t.convergence_threshold, cap: t.profit_capture_target,
  pct: t.captured_pct, safety: t.expiry_safety, elig: t.exit_eligible })));

async function scenarioSseExits() {
  const s = new Scenario("sse-exits", {
    start: istMs(TODAY, "14:44"), rf: 7,
    env: { SYNTH_STRIKE_LEVEL: "1", SYNTH_EVAL_INTERVAL_MS: "1000", SYNTH_PUBLISH_INTERVAL_MS: "4000",
      SYNTH_SIGNAL_CONFIRMATIONS: "1", SYNTH_REENTRY_COOLDOWN_MS: "3000", SYNTH_MAX_PUBLISHED_OPPORTUNITIES: "10" },
  });
  await s.set({ rest: { ...restOf("kite", "NIFTY", 25010.25), ...restOf("kite", "TODAYCO", 100.4) } });
  await s.sseAdd("a"); // before boot: the publish timer is the first timer
  await s.boot();
  await s.call("start");
  await s.sseAdd("b");
  await s.ticks([...niftyRich(), ...todayRich()]);
  await s.advance(1000);
  s.assert(s.status().open_count === 2, "NIFTY and TODAYCO entered");
  showOpen(s, "after entry");
  // Wider windows while positions are open: their legs stay subscribed.
  await s.http("POST", "/api/synthetic/strike-level", { token: "tok-trade", body: { level: 2 } });
  await s.advance(4000, { fullOpps: true }); // the publish timer fires
  // NIFTY captures most of the lock without converging: PROFIT_CAPTURE.
  await s.ticks([...chainBooks("kite", "NIFTY", 25010, [24900, 24950, 25000, 25050, 25100], { skew: { 25000: { ce: 4 } } }), ...todayRich()]);
  showOpen(s, "partial (before eval)");
  await s.advance(1000);
  showOpen(s, "after partial");
  s.assert(s.status().day_pnl.closed_count === 1, "profit capture exit");
  s.assert(s.engine.closedToday[0].exit_reason === "PROFIT_CAPTURE", "exit reason PROFIT_CAPTURE");
  await s.sseRemove("b");
  await s.sseRemove("a"); // no client: the publish timer stops
  // TODAYCO enters the expiry-safety window at 14:45 with stale books: blocked.
  await s.advance(55000);
  showOpen(s, "14:45 stale");
  s.assert(openOf(s, "TODAYCO")?.expiry_safety === true, "expiry safety window");
  await s.sseAdd("c");
  // Still rich (no exit rule holds): expiry safety alone closes it, at once.
  await s.ticks(todayRich());
  await s.advance(1000);
  showOpen(s, "after fresh books");
  s.assert(s.status().open_count === 0 && s.engine.closedToday[0].exit_reason === "EXPIRY_SAFETY", "expiry safety exit");
  await s.http("GET", "/api/synthetic/trades/history?scope=today", { token: "tok-trade" });
  // After the cooldown the same signal is refused: no entries this close to expiry.
  await s.advance(3000);
  await s.ticks(todayRich());
  await s.advance(1000);
  s.assert(s.engine.opportunities.some((o) => o.entry_blocked === "expiry_cutoff"), "expiry cutoff");
  await s.call("dispose");
}

async function scenarioClosingBell() {
  const s = new Scenario("closing-bell", {
    start: istMs(TODAY, "14:44"),
    env: { SYNTH_STRIKE_LEVEL: "1", SYNTH_EVAL_INTERVAL_MS: "5000", SYNTH_SIGNAL_CONFIRMATIONS: "1" },
  });
  const closes = {};
  const close = (u, name, type, strike, price, day = TODAY, time = "15:29:58") => {
    closes[tok(u, name, type, strike)] = { last_price: price, last_trade_time: `${day} ${time}` };
  };
  await s.set({ rest: { ...restOf("kite", "RELIANCE", 2901.5), ...restOf("kite", "TODAYCO", 100.4) } });
  await s.boot();
  await s.call("start");
  await s.ticks([...relRich(), ...todayRich()]);
  await s.advance(5000);
  s.assert(s.status().open_count === 2, "RELIANCE and TODAYCO entered");
  // Last-session prints: most from today, one strike stale since yesterday (ignored).
  close("kite", "RELIANCE", "FUT", 0, 2903.4);
  for (const K of REL_K) {
    close("kite", "RELIANCE", "CE", K, Math.max(2903.4 - K, 0) + 41);
    close("kite", "RELIANCE", "PE", K, Math.max(K - 2903.4, 0) + 39.5, K === 2920 ? "2026-10-27" : TODAY);
  }
  close("kite", "TODAYCO", "FUT", 0, 100.6);
  await s.set({ rest: closes });
  // To the bell: universe refreshes on the way, TODAYCO settles at expiry once the
  // market is shut after 15:30, and the close view is rebuilt from the closes.
  await s.advance(istMs(TODAY, "15:41", 10) - clock.now);
  showOpen(s, "after bell");
  s.assert(s.engine.closedToday.some((t) => t.exit_reason === "EXPIRED"), "TODAYCO settled at expiry");
  s.assert(s.status().close_session_day === TODAY, "close view");
  await s.call("getChain", ["RELIANCE"]);
  await s.http("GET", "/api/synthetic/opportunities", { token: "tok-trade" });
  const rel = openOf(s, "RELIANCE");
  await s.http("POST", `/api/synthetic/trades/${rel.id}/close`, { token: "tok-full" });
  await s.call("getHistory", ["all", 10]);
}

async function scenarioBudget(name, share) {
  const s = new Scenario(name, {
    start: START,
    env: { SYNTH_STRIKE_LEVEL: "2", SYNTH_EVAL_INTERVAL_MS: "1000", SYNTH_MAX_TOKENS: "40",
      SYNTH_SHARE_BOX_BUDGET: share ? "true" : "false", SYNTH_SIGNAL_CONFIRMATIONS: "1" },
    boxLane: { running: false, heldTokens: 0, budget: 20 },
  });
  await s.set({ rest: { ...restOf("kite", "NIFTY", 25010.25), ...restOf("kite", "BANKNIFTY", 56010), ...restOf("kite", "RELIANCE", 2901.5),
    ...restOf("kite", "M&M", 3402), ...restOf("kite", "M&MFIN", 321), ...restOf("kite", "TODAYCO", 100.4) } });
  await s.boot();
  await s.call("tokenBudget");
  await s.call("start");
  dbg(name, "start", { mon: s.status().monitored_underlyings, skipped: s.status().skipped_for_budget, budget: s.status().token_budget });
  // Box starts: it may grow to its full budget, so this scanner shrinks at the next pass.
  await s.set({ boxLane: { running: true, heldTokens: 10, budget: 20 } });
  await s.advance(1000);
  dbg(name, "box running", { mon: s.status().monitored_underlyings, skipped: s.status().skipped_for_budget, budget: s.status().token_budget });
  // Box is about to declare most of the lane: yield synchronously.
  await s.call("yieldToBox", [2990]);
  await s.call("tokenBudget");
  // Box stops again: the freed budget is picked up by a refresh after the debounce.
  await s.set({ boxLane: { running: false, heldTokens: 4, budget: 20 } });
  await s.advance(1000);
  await s.advance(6000);
  dbg(name, "box idle", { mon: s.status().monitored_underlyings, skipped: s.status().skipped_for_budget, budget: s.status().token_budget });
  // An open position's three legs are never dropped to make room.
  await s.ticks(niftyRich(25010, { }).concat(chainBooks("kite", "NIFTY", 25010, [24900, 25100])));
  await s.advance(1000);
  await s.set({ boxLane: { running: true, heldTokens: 2995, budget: 20 } });
  await s.advance(1000);
  dbg(name, "squeezed", { mon: s.status().monitored_underlyings, subs: s.status().subscribed_tokens, budget: s.status().token_budget, open: s.status().open_count });
  await s.http("GET", "/api/synthetic/status", { token: "tok-trade" });
}

async function scenarioRestartSwitch() {
  const s = new Scenario("restart-switch", {
    start: START,
    env: { SYNTH_STRIKE_LEVEL: "1", SYNTH_EVAL_INTERVAL_MS: "1000", SYNTH_SIGNAL_CONFIRMATIONS: "1", SYNTH_REENTRY_COOLDOWN_MS: "2000" },
  });
  await s.set({ rest: { ...restOf("kite", "NIFTY", 25010.25), ...restOf("kite", "RELIANCE", 2901.5) } });
  await s.boot();
  await s.call("start");
  // Two entries in one pass; their margin captures fail and retry after 1.5 s and 3 s:
  // five failures in a row, so one capture gives up and stores the reason.
  await s.set({ faults: { basketMargin: [1, 2, 3, 4, 5].map(() => ({ error: "margin service busy" })) } });
  await s.ticks([...niftyRich(), ...relRich()]);
  await s.advance(1000);
  s.assert(s.status().open_count === 2, "two entries");
  await s.advance(1500);
  await s.advance(3000);
  dbg("margins", s.engine.getOpenPositions().map((t) => [t.underlying, t.margin, t.margin_error]));
  // The backfill (every 60 s) retries it: a per-leg fallback figure this time.
  await s.set({ marginDefault: { value: { initial: 1, final: 1, total: 154321.6, source: "dhan_per_leg_fallback" } } });
  await s.advance(60000);
  dbg("margins later", s.engine.getOpenPositions().map((t) => [t.underlying, t.margin, t.margin_source, t.margin_error]));
  // A calculator that answers without a figure fails the next capture.
  await s.set({ marginDefault: { value: { initial: 0, final: 0, total: "NaN", source: "kite_basket" } } });
  // A third position whose capture is still in flight at the restart.
  await s.set({ hold: ["basketMargin"] });
  await s.ticks([...niftyRich(), ...relRich(), ...chainBooks("kite", "M&M", 3402, [3380, 3400, 3420], { tv: 50, skew: { 3400: { ce: 9 } } })]);
  await s.set({ rest: restOf("kite", "M&M", 3402) });
  await s.advance(60000);
  await s.ticks([...niftyRich(), ...relRich(), ...chainBooks("kite", "M&M", 3402, [3380, 3400, 3420], { tv: 50, skew: { 3400: { ce: 9 } } })]);
  await s.advance(1000);
  dbg("before restart", s.status().open_count, s.engine.getOpenPositions().map((t) => [t.underlying, t.margin, t.margin_error]));
  // Restart on Dhan: every open position is adopted unlinked, then re-linked by contract
  // in the Dhan namespace on the first pass.
  await s.restart();
  await s.set({ unhold: ["basketMargin"], broker: "dhan", universe: "dhan", generation: 2 });
  await s.boot();
  // The first pass re-links and starts a refresh (the board answer is held); START
  // waits for that refresh, then runs its own with discovery on.
  await s.set({ hold: ["getBoard"] });
  await s.advance(1000);
  await s.http("POST", "/api/synthetic/start", { token: "tok-trade" });
  await s.release("getBoard");
  await s.release("getBoard");
  await s.set({ unhold: ["getBoard"] });
  await s.call("stop");
  await s.advance(60000);
  dbg("after restart", s.status().unlinked_positions, s.engine.getOpenPositions().map((t) => [t.underlying, t.linked, t.margin, t.margin_error]));
  await s.call("start");
  // A broker switch: the registry stops discovery, drops the namespace, loads the new
  // universe and reloads ours while the switch is still in progress.
  await s.set({ switching: true });
  await s.http("POST", "/api/synthetic/start", { token: "tok-trade" });
  await s.call("stop");
  await s.call("invalidateNamespace");
  await s.advance(1000);
  await s.set({ broker: "zerodha", universe: "kite", generation: 3 });
  await s.call("reloadUniverse");
  await s.set({ switching: false });
  await s.advance(1000);
  // A refresh that sees the generation move while it waits is discarded.
  await s.call("start");
  await s.set({ hold: ["getAllInstruments"] });
  await s.call("reloadUniverse");
  await s.set({ generation: 4 });
  await s.release("getAllInstruments");
  await s.set({ unhold: ["getAllInstruments"] });
  dbg("superseded", { universe_at: s.status().universe_at, mon: s.status().monitored_underlyings });
  await s.advance(11000);
  // A universe where one open leg is missing: that position stays unlinked.
  await s.call("invalidateNamespace");
  await s.set({ universe: "thin", generation: 5 });
  await s.call("reloadUniverse");
  dbg("thin", s.status().unlinked_positions);
  await s.advance(11000);
  await s.http("GET", "/api/synthetic/trades/open", { token: "tok-trade" });
  await s.call("invalidateBooks");
  await s.advance(1000);
}

/** A trade another process opened: priced from `books` at `at`, as the engine would. */
function tradeFor(s, u, strike, direction, books, id, at, day = TODAY) {
  const e = s.engine;
  const chain = M.indexSyntheticChains(UNIVERSES.kite, day).get(u);
  const fut = books.find((t) => t.token === chain.future.token);
  const w = M.buildSynthWindow({ board: BOARD.find((b) => b.symbol === u), chain, ref: (fut.bid + fut.ask) / 2, eachSide: 1, now: at });
  const q = new Map(books.map((t) => [t.token, { bid: t.bid, bid_qty: t.bids[0]?.qty ?? 0, ask: t.ask,
    ask_qty: t.asks[0]?.qty ?? 0, last: t.last_price, at }]));
  const cfg = e.cfg;
  const opp = M.evaluateSynthetic({ window: w, strike, direction, quoteFor: (tk) => q.get(tk), params: {
    quantity: w.lot_size, now: at, quoteMaxAgeMs: cfg.quoteMaxAgeMs, rfPct: cfg.defaultRfPct, includeCarry: cfg.includeCarry,
    minExpectedNetProfit: 0, safetyBuffer: 0, expectedSlippage: 0, optionRates: cfg.optionRates,
    futuresRates: cfg.futuresRates, indicative: false } });
  const t = M.openTradeFromOpportunity({ opp, id, broker: "zerodha", now: at, day,
    optionRateVersion: cfg.optionRates.rateVersion, futuresRateVersion: cfg.futuresRates.rateVersion });
  if (!t) throw new Error(`tradeFor ${u}: not executable`);
  return t;
}

async function scenarioStoreFailures() {
  const s = new Scenario("store-failures", {
    start: START,
    env: { SYNTH_STRIKE_LEVEL: "1", SYNTH_EVAL_INTERVAL_MS: "1000", SYNTH_SIGNAL_CONFIRMATIONS: "1", SYNTH_REENTRY_COOLDOWN_MS: "2000" },
  });
  await s.set({ rest: { ...restOf("kite", "NIFTY", 25010.25), ...restOf("kite", "RELIANCE", 2901.5) },
    faults: { "store.loadSettings": [{ error: "db down" }, { error: "db down" }] },
    settings: { min_expected_net_profit: 400, max_open_positions: 5 } });
  await s.boot();
  await s.call("start");
  await s.ticks([...niftyRich(), ...relFair()]);
  await s.advance(1000);
  s.assert(s.status().paper_blocked_reason === "loading", "loading after failed settings reads");
  await s.set({ faults: { "store.ensureReady": [{ error: "index missing" }] } });
  await s.advance(29000);
  s.assert(s.status().paper_blocked_reason === "unsafe_index", "unsafe index");
  await s.advance(30000);
  s.assert(s.status().paper_blocked_reason === null, "ready");
  // A failed insert: cooldown, then the entry is retried.
  await s.set({ faults: { "store.insertOpen": [{ error: "insert failed" }] } });
  await s.ticks([...niftyRich(), ...relFair()]);
  await s.advance(1000);
  s.assert(s.status().last_error?.startsWith("Paper entry on NIFTY failed"), "entry failure");
  await s.advance(2000);
  await s.ticks([...niftyRich(), ...relFair()]);
  await s.advance(1000);
  s.assert(s.status().open_count === 1, "entered after the cooldown");
  // Another process holds RELIANCE open: the insert is a duplicate and its row is adopted.
  const other = tradeFor(s, "RELIANCE", 2900, "CONVERSION", relRich(), "5e0000000000000000000001", clock.now - 5000);
  await s.set({ seedRows: [{ doc: JSON.stringify(other), status: "open" }] });
  await s.ticks([...niftyRich(), ...relRich()]);
  await s.advance(1000);
  s.assert(s.status().open_count === 2 && s.status().unlinked_positions === 1, "adopted the other process's position");
  await s.advance(11000);
  // A failed close is retried 5 s later; storage off at exit time fails it at once.
  await s.set({ faults: { "store.close": [{ error: "write timeout" }] } });
  await s.ticks([...niftyFair(), ...relRich()]);
  await s.advance(1000);
  await s.ticks([...niftyFair(), ...relRich()]);
  await s.advance(1000);
  s.assert(s.status().last_error?.startsWith("Closing NIFTY failed"), "close failure");
  await s.set({ storeEnabled: false });
  await s.advance(5000);
  dbg("store off", s.status().last_error);
  await s.set({ storeEnabled: true });
  await s.advance(4000);
  await s.ticks([...niftyFair(), ...relRich()]);
  await s.advance(1000);
  s.assert(s.engine.closedToday[0]?.underlying === "NIFTY", "the retried close landed");
  // Re-entry whose margin write fails (logged, not retried).
  await s.set({ faults: { "store.setMargin": [{ error: "margin write failed" }] } });
  await s.advance(2000);
  await s.ticks([...niftyRich(), ...relRich()]);
  await s.advance(1000);
  dbg("re-entry", s.status().open_count, s.status().last_error, openOf(s, "NIFTY")?.margin);
  s.assert(openOf(s, "NIFTY")?.margin === 98765, "re-entered with a margin in memory");
  // A trade closed elsewhere whose re-read fails: the close is not counted twice.
  const rel = openOf(s, "RELIANCE");
  await s.set({ externalClose: [{ id: rel.id, fields: { status: "closed", closed_at: clock.now, closed_day: TODAY,
    exit_reason: "MANUAL", gross_pnl: 10, exit_charges: 5, total_charges: 8, net_pnl: 2, exit_note: null } }],
  faults: { "store.get": [{ error: "read failed" }] } });
  await s.ticks(relRich());
  await s.http("POST", `/api/synthetic/trades/${rel.id}/close`, { token: "tok-trade" });
  // Open in the store but not managed here: refused.
  await s.set({ seedRows: [{ doc: JSON.stringify({ ...other, id: "5e0000000000000000000002", underlying: "M&M" }), status: "open" }] });
  await s.http("DELETE", "/api/synthetic/trades/5e0000000000000000000002", { token: "tok-full" });
  // Deleted elsewhere while listed today: memory follows, with a trade_deleted event (the
  // upper-case id finds the row but not the listed trade).
  await s.sseAdd("watch");
  const listed = s.engine.closedToday[0];
  await s.set({ externalDelete: [listed.id] });
  await s.http("DELETE", `/api/synthetic/trades/${listed.id.toUpperCase()}`, { token: "tok-full", body: { reason: "  cleanup " } });
  await s.http("DELETE", `/api/synthetic/trades/${listed.id}`, { token: "tok-full", body: { reason: "  cleanup " } });
  await s.sseRemove("watch");
  await s.call("getHistory", ["all", 3]);
}

async function scenarioRoutes() {
  const s = new Scenario("routes", {
    start: START,
    env: { SYNTH_STRIKE_LEVEL: "1", SYNTH_EVAL_INTERVAL_MS: "1000" },
  });
  await s.set({ rest: { ...restOf("kite", "M&M", 3402), ...restOf("kite", "NIFTY", 25010.25) } });
  await s.boot();
  await s.http("POST", "/api/synthetic/start", { token: "tok-full" });
  await s.http("GET", "/api/synthetic/chain/m%26m", { token: "tok-trade" });
  await s.http("GET", "/api/synthetic/chain/Nifty", { token: "tok-trade" });
  await s.http("GET", "/api/synthetic/opportunities?limit=", { token: "tok-trade" });
  await s.http("GET", "/api/synthetic/opportunities?limit=1e400", { token: "tok-trade" });
  await s.http("GET", "/api/synthetic/opportunities?limit=-3", { token: "tok-trade" });
  await s.http("GET", "/api/synthetic/opportunities?limit=%202%20", { token: "tok-trade" });
  await s.http("GET", "/api/synthetic/trades/history?scope=today&scope=today", { token: "tok-trade" });
  await s.http("GET", "/api/synthetic/trades/history?scope=TODAY&limit=0", { token: "tok-trade" });
  await s.http("GET", "/api/synthetic/trades/history?limit=0.5", { token: "tok-trade" });
  await s.http("POST", "/api/synthetic/settings", { token: "tok-trade", body: [1, 2] });
  await s.http("POST", "/api/synthetic/settings", { token: "tok-trade", body: { max_open_positions: "3", min_expected_net_profit: " 600 " } });
  await s.http("POST", "/api/synthetic/strike-level", { token: "tok-trade", body: [2] });
  await s.http("POST", "/api/synthetic/strike-level", { token: "tok-trade", body: { level: " 2 " } });
  await s.http("POST", "/api/synthetic/stop", { token: "tok-trade" });
  await s.http("POST", "/api/synthetic/stop", { token: "tok-trade" });
  // Closed rows refused for an operator who saw them open: the net in en-IN rupees.
  const closedRow = (id, net, reason) => {
    const t = tradeFor(s, "NIFTY", 25000, "CONVERSION", niftyRich(), id, clock.now - 60000);
    return { doc: JSON.stringify({ ...t, status: "closed", closed_at: clock.now - 1000, closed_day: TODAY, exit_reason: reason,
      gross_pnl: net, exit_charges: 0, total_charges: 0, net_pnl: net }), status: "closed" };
  };
  await s.http("POST", "/api/synthetic/start", { token: "tok-full" });
  await s.set({ seedRows: [closedRow("5d0000000000000000000001", 1234567.89, "PROFIT_CAPTURE"),
    closedRow("5d0000000000000000000002", -98765.5, null), closedRow("5d0000000000000000000003", -0.4, "MANUAL")] });
  for (const id of ["5d0000000000000000000001", "5d0000000000000000000002", "5d0000000000000000000003"]) {
    await s.http("DELETE", `/api/synthetic/trades/${id}`, { token: "tok-full", body: { expected_status: "open" } });
  }
  await s.http("POST", "/api/synthetic/stop", { token: "tok-trade" });
  // The delete limiter: 20 per minute per client, counted before auth (403s count too, and
  // so do the three refusals above, so the last four of these are 429).
  for (let i = 0; i < 21; i++) await s.http("DELETE", `/api/synthetic/trades/${"c".repeat(24)}`, { token: i % 2 ? "tok-trade" : undefined });
  await s.http("DELETE", `/api/synthetic/trades/${"c".repeat(24)}`, { token: "tok-full", xff: "10.1.1.1" });
  await s.advance(30000);
  await s.http("DELETE", `/api/synthetic/trades/${"c".repeat(24)}`, { token: "tok-full" });
  await s.advance(30001);
  await s.http("DELETE", `/api/synthetic/trades/${"c".repeat(24)}`, { token: "tok-full" });
}

async function scenarioOptions() {
  const s = new Scenario("options", {
    start: START,
    env: { SYNTH_STRIKE_LEVEL: "1", SYNTH_EVAL_INTERVAL_MS: "1000", SYNTH_PAPER_TRADING: "false", SYNTH_ENABLE_REVERSAL: "false",
      SYNTH_SKIP_EXPIRY_DAY: "true", SYNTH_MAX_UNDERLYINGS: "2", SYNTH_INCLUDE_CARRY: "false", SYNTH_EXPECTED_SLIPPAGE: "5",
      SYNTH_DEFAULT_RF_PCT: "6.25", SYNTH_MAX_PUBLISHED_OPPORTUNITIES: "2", BOX_BROKERAGE_PER_ORDER: "15" },
    margins: false,
  });
  await s.set({ rest: { ...restOf("kite", "NIFTY", 25010.25), ...restOf("kite", "BANKNIFTY", 56010), ...restOf("kite", "RELIANCE", 2901.5),
    ...restOf("kite", "TODAYCO", 100.4) } });
  await s.boot();
  await s.call("start");
  await s.ticks([...niftyRich(), ...chainBooks("kite", "BANKNIFTY", 56010, [55900, 56000, 56100], { tv: 200, skew: { 56000: { ce: 40 } } })]);
  await s.advance(1000, { fullOpps: true, fullList: true });
  s.assert(s.engine.opportunities.some((o) => o.entry_blocked === "paper_off"), "paper off");
  await s.call("getOpportunities", [1]);
  await s.http("GET", "/api/synthetic/opportunities", { token: "tok-trade" });
}

async function scenarioEntryRaces() {
  const s = new Scenario("entry-races", {
    start: START,
    env: { SYNTH_STRIKE_LEVEL: "1", SYNTH_EVAL_INTERVAL_MS: "1000", SYNTH_SIGNAL_CONFIRMATIONS: "1", SYNTH_MAX_OPEN_POSITIONS: "1",
      SYNTH_REENTRY_COOLDOWN_MS: "2000" },
  });
  await s.set({ rest: { ...restOf("kite", "NIFTY", 25010.25), ...restOf("kite", "RELIANCE", 2901.5) } });
  await s.boot();
  // Refresh failures: the instrument dump fails (the board answer is still out, the
  // refresh fails at once), then the futures prices fail.
  await s.set({ hold: ["getBoard"], faults: { getAllInstruments: [{ error: "dump unavailable" }] } });
  await s.call("start");
  await s.release("getBoard");
  await s.set({ unhold: ["getBoard"], faults: { getQuoteFull: [{ error: "quote timeout" }] } });
  await s.call("stop");
  await s.call("start");
  await s.advance(61000);
  s.assert(s.status().monitored_underlyings === 2, "windows built after the failures");
  // The insert is in flight when the namespace changes: the position is adopted unlinked.
  await s.set({ hold: ["store.insertOpen"] });
  await s.ticks([...niftyRich(), ...relRich()]);
  await s.advance(1000, { fullOpps: true });
  await s.ticks([...niftyRich(), ...relRich()]);
  await s.advance(1000);
  await s.call("invalidateNamespace");
  await s.release("store.insertOpen");
  await s.set({ unhold: ["store.insertOpen"] });
  s.assert(s.status().open_count === 1 && s.status().unlinked_positions === 1, "unlinked after the namespace change");
  await s.call("reloadUniverse");
  await s.ticks([...niftyRich(), ...relRich()]);
  await s.advance(1000);
  s.assert(s.engine.opportunities.some((o) => o.entry_blocked === "max_open"), "max open");
  // No storage: rows say no_db; a manual close then fails with the store's error.
  await s.set({ storeEnabled: false });
  await s.ticks([...niftyRich(), ...relRich()]);
  await s.advance(1000);
  await s.set({ storeEnabled: true, faults: { "store.close": [{ error: "disk quota" }] } });
  const open = s.engine.getOpenPositions()[0];
  await s.ticks([...niftyRich(), ...relRich()]);
  await s.http("POST", `/api/synthetic/trades/${open.id}/close`, { token: "tok-trade" });
  await s.advance(6000);
}

async function scenarioMidnight() {
  const s = new Scenario("midnight", {
    start: istMs(TODAY, "23:59", 40),
    env: { SYNTH_STRIKE_LEVEL: "1", SYNTH_EVAL_INTERVAL_MS: "5000" },
  });
  const t1 = tradeFor(s, "NIFTY", 25000, "CONVERSION", niftyRich(), "5c0000000000000000000001", istMs(TODAY, "11:00"));
  const t2 = tradeFor(s, "TODAYCO", 100, "CONVERSION", todayRich(), "5c0000000000000000000002", istMs(TODAY, "11:30"));
  const closedToday = { ...t1, status: "closed", closed_at: istMs(TODAY, "12:00"), closed_day: TODAY, exit_reason: "EDGE_CONVERGED",
    gross_pnl: 1800, exit_charges: 300, total_charges: 700, net_pnl: 1100, margin: 98000, margin_source: "kite_basket",
    margin_at: istMs(TODAY, "11:00", 2) };
  await s.set({ seedRows: [{ doc: JSON.stringify(closedToday), status: "closed" }, { doc: JSON.stringify(t2), status: "open" }] });
  await s.boot();
  await s.http("GET", "/api/synthetic/trades/history?scope=today", { token: "tok-trade" });
  // Past midnight: today's closed list starts empty, and the position whose expiry is now
  // in the past settles at the parity lock.
  await s.advance(30000);
  s.assert(s.status().day_pnl.day === "2026-10-29", "rolled");
  await s.http("GET", "/api/synthetic/trades/history?scope=today", { token: "tok-trade" });
  await s.call("getHistory", ["all", 10]);
}

await scenarioLifecycle();
await scenarioManualClose();
await scenarioDelete();
await scenarioSettings();
await scenarioSseExits();
await scenarioClosingBell();
await scenarioBudget("budget-shared", true);
await scenarioBudget("budget-own", false);
await scenarioRestartSwitch();
await scenarioStoreFailures();
await scenarioRoutes();
await scenarioOptions();
await scenarioEntryRaces();
await scenarioMidnight();

fs.writeFileSync(path.join(here, "engine_golden.json"), JSON.stringify(golden, null, 1) + "\n");
const steps = golden.scenarios.reduce((n, s) => n + s.steps.length, 0);
process.stdout.write(`wrote engine_golden.json: ${golden.scenarios.length} scenarios, ${steps} steps\n`);
