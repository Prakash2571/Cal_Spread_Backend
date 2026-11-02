// Goldens for internal/brokers/registry, recorded from the ORIGINAL TypeScript:
//   helpers.golden.json  - chunkDateRange, dhanCandlesToRows (history.ts), diagnoseBoard,
//                          checkKnownSymbols (boardDiagnostics.ts), indexSpotCandidates /
//                          resolveIndexSpotSymbol (indexSpot.ts)
//   routes.golden.json   - scenarios driving ActiveBrokerManager (registry.ts) and
//                          registerBrokerRoutes (routes.ts) through fake req/res objects:
//                          every response status + body, the hub / hook / Kite events, the
//                          outbound Dhan HTTP requests and the WebSocket URLs opened.
//
// Run from the repository root:
//   scratch/go-migration/check.sh node internal/brokers/registry/testdata/gen_registry.mjs
//
// Nothing reaches a network: fetch and WebSocket are replaced by recording fakes, the
// clock is fixed (Date.now), MongoDB is the in-memory stub_db.mjs. src/ is imported
// unmodified through hooks.mjs. Output is deterministic.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import querystring from "node:querystring";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.execArgv.includes("--experimental-transform-types")) {
  const r = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, TZ: "UTC" } },
  );
  process.exit(r.status ?? 1);
}
register(pathToFileURL(fileURLToPath(new URL("./hooks.mjs", import.meta.url))).href);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const src = (p) => pathToFileURL(path.join(repoRoot, "src", p)).href;

/* --------------------------------- fakes ---------------------------------- */

let NOW = Date.parse("2026-10-28T06:00:00.000Z");
Date.now = () => NOW;
const LOGS = [];
console.log = console.warn = console.error = (...a) => LOGS.push(a.map(String).join(" "));

let EVENTS = [];
let OUT = [];
let SOCKETS = [];
let HTTP = {};
const ev = (s) => EVENTS.push(s);

class FakeWebSocket {
  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this.binaryType = "blob";
    SOCKETS.push(this.url);
  }
  send() {}
  close() {}
}
globalThis.WebSocket = FakeWebSocket;

const DHAN_API = "https://api.dhan.co/v2";
const DHAN_AUTH = "https://auth.dhan.co";
const MASTER = "https://images.dhan.co/api-data/api-scrip-master-detailed.csv";
const MASTER_FALLBACK = "https://images.dhan.co/api-data/api-scrip-master.csv";

function classify(url, method) {
  if (url === MASTER) return { host: "master", key: "master GET detailed", path: "detailed" };
  if (url === MASTER_FALLBACK) return { host: "master", key: "master GET plain", path: "plain" };
  if (url.startsWith(DHAN_API)) {
    const rest = url.slice(DHAN_API.length);
    return { host: "api", key: `api ${method} ${rest.split("?")[0]}`, path: rest };
  }
  if (url.startsWith(DHAN_AUTH)) {
    const rest = url.slice(DHAN_AUTH.length);
    return { host: "auth", key: `auth ${method} ${rest.split("?")[0]}`, path: rest };
  }
  throw new Error(`unexpected fetch ${url}`);
}

const RECORDED_HEADERS = ["accept", "access-token", "app_id", "app_secret", "client-id", "content-type"];

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = (init.method ?? "GET").toUpperCase();
  const c = classify(url, method);
  const headers = {};
  for (const [k, v] of Object.entries(init.headers ?? {})) {
    if (RECORDED_HEADERS.includes(k.toLowerCase())) headers[k.toLowerCase()] = String(v);
  }
  const sorted = Object.fromEntries(Object.entries(headers).sort(([a], [b]) => (a < b ? -1 : 1)));
  const body = init.body === undefined ? "" : String(init.body);
  OUT.push(`${c.host} ${method} ${c.path} ${JSON.stringify(sorted)} ${body}`);
  const queue = HTTP[c.key];
  if (!queue || queue.length === 0) return new Response("not found", { status: 404 });
  const spec = queue.length > 1 ? queue.shift() : queue[0];
  if (spec.echo) {
    return new Response(JSON.stringify(ECHO[spec.echo](JSON.parse(body))), { status: 200 });
  }
  const text = typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body);
  return new Response(text, { status: spec.status, headers: spec.headers ?? {} });
};

/* --------------------------- deterministic echoes -------------------------- */
// Mirrored by echoQuote / echoIntraday / echoDaily in the Go test.

const pad2 = (n) => String(n).padStart(2, "0");
function quoteEntry(id) {
  return {
    last_price: 100 + (id % 7),
    last_quantity: 1,
    last_trade_time: `2026-10-28 10:00:${pad2(id % 60)}`,
    average_price: 100,
    volume: id % 1000,
    oi: id % 100,
    net_change: 0,
    ohlc: { open: 1, close: 99 + (id % 3), high: 2, low: 0 },
    depth: {
      buy: [{ quantity: 10, orders: 2, price: 99.5 }, { quantity: 5, orders: 1, price: 0 }],
      sell: [{ quantity: 12, orders: 3, price: 100.5 }],
    },
  };
}
const ECHO = {
  quote(body) {
    const seg = Object.keys(body)[0];
    const entries = {};
    for (const id of body[seg]) {
      const key = id === 60010 ? "060010" : String(id);
      if (id === 60500) entries[key] = "junk";
      else if (id === 61001) entries[key] = null;
      else if (id === 60001) entries[key] = { ...quoteEntry(id), depth: { buy: [], sell: [{ quantity: 1, orders: 1, price: 0 }] } };
      else if (id === 60002) entries[key] = { ...quoteEntry(id), depth: null };
      else if (id === 60998) entries[key] = { ...quoteEntry(id), depth: { buy: [null, { price: 1 }], sell: [] } };
      else if (id === 438) {
        const e = quoteEntry(id);
        delete e.last_trade_time;
        entries[key] = { ...e, last_price: "1234.5" };
      } else entries[key] = quoteEntry(id);
    }
    entries["1"] = { last_price: 1 };
    return { status: "success", data: { [seg]: entries } };
  },
  intraday(body) {
    const from = Date.parse(`${body.fromDate}T00:00:00Z`);
    const to = Date.parse(`${body.toDate}T00:00:00Z`);
    const step = Number(body.interval) * 60;
    const out = { open: [], high: [], low: [], close: [], volume: [], timestamp: [] };
    if (body.interval !== "60") out.open_interest = [];
    for (let d = from, i = 0; d <= to; d += 86_400_000, i++) {
      for (let k = 0; k < 3; k++) {
        out.timestamp.push(d / 1000 + 3 * 3600 + 45 * 60 + k * step);
        out.open.push(i + k);
        out.high.push(i + k + 1);
        out.low.push(i + k - 1);
        out.close.push(i + k + 0.5);
        out.volume.push(10 * k);
        if (out.open_interest) out.open_interest.push(1000 + k);
      }
    }
    return out;
  },
  daily(body) {
    const from = Date.parse(`${body.fromDate}T00:00:00Z`);
    const to = Date.parse(`${body.toDate}T00:00:00Z`);
    const out = { open: [], high: [], low: [], close: [], volume: [], timestamp: [], open_interest: [] };
    for (let d = to, i = 0; d >= from; d -= 86_400_000, i++) {
      out.timestamp.push(d / 1000 - 19800);
      out.open.push(i);
      out.high.push(i + 2);
      out.low.push(i - 2);
      out.close.push(i === 0 ? null : i + 0.25);
      out.volume.push(i * 100);
      out.open_interest.push(5000 + i);
    }
    out.timestamp.push("bad");
    return out;
  },
};

/* ------------------------------- the master -------------------------------- */

const day = (days) => new Date(Date.parse("2026-10-28T06:00:00.000Z") + days * 86_400_000).toISOString().slice(0, 10);
const J = "EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,DISPLAY_NAME,UNDERLYING_SYMBOL,UNDERLYING_SECURITY_ID,LOT_SIZE,SM_EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE,TICK_SIZE";
function buildMaster() {
  const rows = [J,
    "NSE,I,13,INDEX,NIFTY,NIFTY 50,NIFTY,13,0,,0,,0.05",
    "NSE,I,25,INDEX,BANKNIFTY,NIFTY BANK,BANKNIFTY,25,0,,0,,0.05",
    "NSE,E,438,EQUITY,BHEL,BHEL LTD,BHEL,438,1,,0,,0.05",
    "NSE,E,2885,EQUITY,RELIANCE,RELIANCE LTD,RELIANCE,2885,1,,0,,0.05",
    "NSE,E,1333,EQUITY,HDFCBANK,HDFC BANK LTD,HDFCBANK,1333,1,,0,,0.05",
    `NSE,D,35001,FUTIDX,NIFTY-Nov2026-FUT,NIFTY NOV FUT,NIFTY,13,75,${day(29)},0,,0.1`,
    `NSE,D,35002,FUTIDX,BANKNIFTY-Nov2026-FUT,BANKNIFTY NOV FUT,BANKNIFTY,25,30,${day(29)},0,,0.1`,
    `NSE,D,35003,FUTIDX,FINNIFTY-Nov2026-FUT,FINNIFTY NOV FUT,FINNIFTY,27,65,${day(29)},0,,0.1`,
    `NSE,D,50000,FUTSTK,BHEL-Nov2026-FUT,BHEL NOV FUT,BHEL,438,2625,${day(29)},0,,0.05`,
    `NSE,D,50001,FUTSTK,BHEL-Dec2026-FUT,BHEL DEC FUT,BHEL,438,2625,${day(57)},0,,0.05`,
    `NSE,D,51000,FUTSTK,RELIANCE-Nov2026-FUT,RELIANCE NOV FUT,RELIANCE,2885,250,${day(29)},0,,0.05`,
    `NSE,D,52000,FUTSTK,ORPHAN-Nov2026-FUT,ORPHAN NOV FUT,ORPHAN,,100,${day(29)},0,,0.05`,
    `NSE,D,53000,FUTSTK,HDFCBANK-Nov2026-FUT,HDFCBANK NOV FUT,HDFCBANK,1333,0,${day(29)},0,,0.05`,
    `NSE,D,54000,FUTSTK,01INSETEST-Nov2026-FUT,01INSETEST,01INSETEST,,1,${day(29)},0,,0.05`,
  ];
  for (let i = 0; i < 1003; i++) {
    const id = 60000 + i;
    const strike = 200 + (i % 50) * 5;
    const type = i % 2 === 0 ? "CE" : "PE";
    rows.push(`NSE,D,${id},OPTSTK,BHEL-Nov2026-${strike}-${type}-${i},BHEL ${strike} ${type},BHEL,438,2625,${day(29)},${strike},${type},0.05`);
  }
  return rows.join("\n");
}
const MASTER_CSV = buildMaster();

const KITE_ROWS = [
  { instrument_token: 256265, exchange_token: 1001, tradingsymbol: "NIFTY 50", name: "NIFTY 50", last_price: 0, expiry: "", strike: 0, tick_size: 0, lot_size: 0, instrument_type: "EQ", segment: "INDICES", exchange: "NSE" },
  { instrument_token: 112129, exchange_token: 438, tradingsymbol: "BHEL", name: "BHARAT HEAVY ELECTRICALS", last_price: 0, expiry: "", strike: 0, tick_size: 0.05, lot_size: 1, instrument_type: "EQ", segment: "NSE", exchange: "NSE" },
  { instrument_token: 13238786, exchange_token: 51714, tradingsymbol: "BHEL26NOVFUT", name: "BHEL", last_price: 0, expiry: "2026-11-26", strike: 0, tick_size: 0.05, lot_size: 2625, instrument_type: "FUT", segment: "NFO-FUT", exchange: "NFO" },
  { instrument_token: 13239042, exchange_token: 51715, tradingsymbol: "NIFTY26NOVFUT", name: "NIFTY", last_price: 0, expiry: "2026-11-26", strike: 0, tick_size: 0.1, lot_size: 75, instrument_type: "FUT", segment: "NFO-FUT", exchange: "NFO" },
];

/* ------------------------------ the modules -------------------------------- */

const { ActiveBrokerManager } = await import(src("brokers/registry.ts"));
const { registerBrokerRoutes } = await import(src("brokers/routes.ts"));
const { HistoryProvider, chunkDateRange, dhanCandlesToRows } = await import(src("brokers/history.ts"));
const { diagnoseBoard, checkKnownSymbols } = await import(src("brokers/boardDiagnostics.ts"));
const { INDEX_SPOT_MAP, indexSpotCandidates, resolveIndexSpotSymbol } = await import(src("indexSpot.ts"));
const { parseDhanScripMaster } = await import(src("brokers/dhan/instruments.ts"));
const { __db } = await import(new URL("./stub_db.mjs", import.meta.url).href);

/* ------------------------------ JSON helpers ------------------------------- */

function replacer(_k, v) {
  if (typeof v === "number") {
    if (Number.isNaN(v)) return { $num: "NaN" };
    if (v === Infinity) return { $num: "Infinity" };
    if (v === -Infinity) return { $num: "-Infinity" };
    if (Object.is(v, -0)) return { $num: "-0" };
  }
  return v;
}
const canonical = (v) => JSON.stringify(v, replacer);

/* -------------------------------- helpers ---------------------------------- */

function helperCases() {
  const cases = { chunk: [], candles: [], board: [], known: [], spot: [] };
  const D = (s) => new Date(s);
  const chunkInputs = [
    ["2026-10-01", "2026-10-20", 5], ["2026-10-01", "2026-10-03", 5], ["2026-10-01", "2026-10-01", 5],
    ["2026-10-05", "2026-10-01", 5], ["2026-10-01", "2026-12-31", 30], ["2026-10-01", "2026-10-20", 0],
    ["2026-10-01", "2026-10-20", -1], ["2026-10-01", "2026-10-20", 2.5], ["garbage", "2026-10-20", 5],
    ["2026-10-01", "garbage", 5], ["2026-10-01T05:30:00Z", "2026-10-09T23:00:00Z", 3], ["2026-10-01", "2027-01-01", 90],
    ["-001000-01-01T00:00:00Z", "+275760-09-13T00:00:00Z", 1e9],
  ];
  for (const [f, t, n] of chunkInputs) {
    const from = D(f);
    const to = D(t);
    cases.chunk.push({ from: from.getTime(), to: to.getTime(), maxDays: n, out: chunkDateRange(from, to, n).map((c) => ({ from: c.from.getTime(), to: c.to.getTime() })) });
  }
  const candleInputs = [
    { open: [1, 2], high: [3, 4], low: [0, 1], close: [2, 3], volume: [10, 20], timestamp: [1760000000, 1759990000], open_interest: [5, 6] },
    { timestamp: [1760000000.5, "1760000001", null, 1760000002], close: [1, 2, 3, "4"] },
    { open: [1], timestamp: [1760000000, 1760000000, 1759999999] },
    {},
    { timestamp: [-86400, 0, 253402300799, 8.64e12, 8.64e12 + 1, 1e300] },
    { timestamp: [1e-3, 59.9999, 19800, -19800.5] },
  ];
  for (const input of candleInputs) cases.candles.push({ input, out: dhanCandlesToRows(input) });

  const now = Date.now;
  const dhanRows = parseDhanScripMaster(MASTER_CSV).map((r) => ({
    instrument_token: r.instrument_token, exchange_token: r.exchange_token, tradingsymbol: r.tradingsymbol, name: r.name,
    last_price: r.last_price, expiry: r.expiry, strike: r.strike, tick_size: r.tick_size, lot_size: r.lot_size,
    instrument_type: r.instrument_type, segment: r.segment, exchange: r.exchange,
  }));
  void now;
  const inst = (o) => ({ instrument_token: 1, exchange_token: 1, tradingsymbol: "", name: "", last_price: 0, expiry: "", strike: 0, tick_size: 0.05, lot_size: 0, instrument_type: "", segment: "", exchange: "", ...o });
  const synthetic = [];
  for (let i = 0; i < 40; i++) synthetic.push(inst({ exchange: "NFO", instrument_type: "FUT", name: `ORPH${i}`, tradingsymbol: `ORPH${i}FUT`, expiry: "2026-11-26", lot_size: 1 }));
  for (let i = 0; i < 13; i++) synthetic.push(inst({ exchange: "NFO", instrument_type: "FUT", name: "", tradingsymbol: `NONAME${i}`, expiry: "2026-11-26" }));
  synthetic.push(inst({ exchange: "NSE", instrument_type: "EQ", tradingsymbol: "TCS", segment: "INDICES" }));
  synthetic.push(inst({ exchange: "NFO", instrument_type: "FUT", name: "TCS", tradingsymbol: "TCSFUT", expiry: "26-11-2026", lot_size: 1 }));
  synthetic.push(inst({ exchange: "NSE", instrument_type: "EQ", tradingsymbol: "SBIN", segment: "NSE" }));
  synthetic.push(inst({ exchange: "NFO", instrument_type: "FUT", name: "SBIN", tradingsymbol: "SBINFUT", expiry: "2026-11-26", lot_size: 0 }));
  synthetic.push(inst({ exchange: "NFO", instrument_type: "FUT", name: "SBIN", tradingsymbol: "SBINFUT2", expiry: "2026-11-26\n", lot_size: -1 }));
  synthetic.push(inst({ exchange: "NSE", instrument_type: "EQ", tradingsymbol: "INFY", segment: "NSE" }));
  synthetic.push(inst({ exchange: "NFO", instrument_type: "FUT", name: "INFY", tradingsymbol: "INFYFUT", expiry: "2026-11-26", lot_size: 300 }));
  synthetic.push(inst({ exchange: "NSE", instrument_type: "EQ", tradingsymbol: "AXISBANK", segment: "NSE" }));
  synthetic.push(inst({ exchange: "NFO", instrument_type: "FUT", name: "MIDCPNIFTY", tradingsymbol: "MIDCPFUT", expiry: "2026-11-26", lot_size: 1 }));
  synthetic.push(inst({ exchange: "NSE", instrument_type: "EQ", tradingsymbol: "NIFTY MID SELECT", segment: "INDICES" }));
  synthetic.push(inst({ exchange: "NFO", instrument_type: "FUT", name: "NIFTYNXT50", tradingsymbol: "NXTFUT", expiry: "2026-11-26", lot_size: 1 }));
  const universes = { dhan: dhanRows, kite: KITE_ROWS, synthetic, mixed: [...dhanRows.slice(0, 20), ...KITE_ROWS, ...synthetic], empty: [] };
  const maps = { index: INDEX_SPOT_MAP, none: {}, custom: { ORPHAN: "ORPHAN INDEX", BHEL: "BHEL" } };
  for (const [u, rows] of Object.entries(universes)) {
    for (const [m, map] of Object.entries(maps)) cases.board.push({ universe: u, map: m, out: diagnoseBoard(rows, map) });
    cases.known.push({ universe: u, symbols: null, out: checkKnownSymbols(rows) });
    cases.known.push({ universe: u, symbols: ["SBIN", "TCS", "INFY", "AXISBANK", "BHEL", "NIFTY", ""], out: checkKnownSymbols(rows, ["SBIN", "TCS", "INFY", "AXISBANK", "BHEL", "NIFTY", ""]) });
  }
  const spots = ["NIFTY 50", "NIFTY", "NIFTY BANK", "FINNIFTY", "NIFTY NEXT 50", "RELIANCE", "INDIA VIX", "NIFTYIT"];
  for (const [m, map] of Object.entries(maps)) {
    for (const u of ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50", "RELIANCE", "INDIA VIX", "NIFTYIT", "ORPHAN", "BHEL", ""]) {
      for (const [h, set] of [["all", spots], ["none", []], ["dhan", ["NIFTY", "BANKNIFTY", "FINNIFTY", "BHEL"]]]) {
        cases.spot.push({ map: m, underlying: u, has: h, candidates: indexSpotCandidates(u, map), resolved: resolveIndexSpotSymbol(u, (s) => set.includes(s), map) });
      }
    }
  }
  return { cases, universes, maps, spotSets: { all: spots, none: [], dhan: ["NIFTY", "BANKNIFTY", "FINNIFTY", "BHEL"] } };
}

/* ------------------------------- scenarios --------------------------------- */

const TOKENS = { full: "full-token", trade: "trade-token", bogus: "bogus-token" };
const ROLES = { "full-token": "full", "trade-token": "trade" };
const getAdminRole = (token) => ROLES[token] ?? null;
const requireAdmin = (req, res, next) => {
  if (getAdminRole(req.headers["x-admin-token"]) === null) return res.status(403).json({ error: "Admin authentication required" });
  next();
};
const requireFullAdmin = (req, res, next) => {
  if (getAdminRole(req.headers["x-admin-token"]) !== "full") return res.status(403).json({ error: "Full admin access required." });
  next();
};

const ENV_KEYS = ["DHAN_CLIENT_ID", "DHAN_API_KEY", "DHAN_API_SECRET", "DHAN_REDIRECT_URL", "DHAN_POSTBACK_URL",
  "DHAN_STATIC_IP_EXPECTED", "DHAN_STATIC_PUBLIC_IP", "DHAN_DATA_ENABLED", "DHAN_LIVE_TRADING_ENABLED",
  "DHAN_HTTP_TIMEOUT_MS", "DHAN_MIN_INTERVAL_MS", "DHAN_MAX_READ_ATTEMPTS", "TOKEN_ROUTE_SECRET"];

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

async function runScenario(sc) {
  NOW = sc.startMs;
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, sc.env);
  HTTP = JSON.parse(JSON.stringify(sc.http ?? {}));
  EVENTS = [];
  OUT = [];
  SOCKETS = [];
  __db.reset(sc.db, sc.seed ?? {});
  const S = { kiteToken: sc.kite?.token ?? null, hubConnected: sc.kite?.hubConnected ?? false, hubSubscribed: sc.kite?.hubSubscribed ?? 0 };

  const kite = {
    getAccessToken: () => S.kiteToken,
    hasSession: () => S.kiteToken !== null,
    getApiKey: () => "kite-key",
    getInstruments: async () => {
      ev("kite:instruments");
      return KITE_ROWS.map((r) => ({ ...r }));
    },
    getQuoteFull: async (ids) => {
      ev(`kite:quote ${JSON.stringify(ids)}`);
      return ids.map((_, i) => ({ instrument_token: 100 + i, last_price: 10 + i, close: 9, oi: i, last_trade_time: i === 0 ? "" : "2026-10-28 09:15:00" }));
    },
    getBasketMargin: async (orders, opts) => {
      ev(`kite:basket ${JSON.stringify(orders)} ${opts?.considerPositions ?? true}`);
      return { initial: 1, final: 2, total: 2 };
    },
    getHistoricalFull: async (t, f, to, iv, p) => {
      ev(`kite:historicalFull ${t} ${f} ${to} ${iv} ${p}`);
      return [{ date: "2026-10-27", open: 1, high: 2, low: 0, close: 1.5, volume: 10, oi: 3 }];
    },
    getHistorical: async (t, f, to, iv, p) => {
      ev(`kite:historical ${t} ${f} ${to} ${iv} ${p}`);
      return [{ t: "2026-10-27T09:15:00+0530", close: 1.5 }];
    },
    getHistoricalOi: async (t, f, to, p) => {
      ev(`kite:historicalOi ${t} ${f} ${to} ${p}`);
      return [{ date: "2026-10-27", close: 1.5, oi: 3 }];
    },
    getHistoricalOiSeries: async (t, f, to, iv, p) => {
      ev(`kite:historicalOiSeries ${t} ${f} ${to} ${iv} ${p}`);
      return [{ t: "2026-10-27T09:15:00+0530", close: 1.5, oi: 3 }];
    },
  };
  const hub = {
    isConnected: () => S.hubConnected,
    subscribedCount: () => S.hubSubscribed,
    subscribeTokens: (t) => ev(`hub:subscribe ${JSON.stringify(t)}`),
    unsubscribeTokens: (t) => ev(`hub:unsubscribe ${JSON.stringify(t)}`),
    stop: () => ev("hub:stop"),
    ingestExternalTicks: (t) => ev(`hub:ingest ${t.length}`),
    setExternalConnected: (c) => ev(`hub:external ${c}`),
    seed() {},
    retain: () => () => {},
    addTickListener: () => () => {},
    addConnectionListener: () => () => {},
  };
  const istDayKey = (at = Date.now()) => new Date(at + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let m;
  m = new ActiveBrokerManager({
    kite,
    tickerHub: hub,
    boxConfig: () => ({}),
    istDayKey,
    zerodhaCredentials: () => ({ apiKey: kite.getApiKey(), accessToken: kite.getAccessToken() }),
    onBoxLaneTicks: (t) => {
      m.noteTick();
      ev(`boxLaneTicks ${t.length}`);
    },
    onBoxLaneConnection: (c) => ev(`boxLaneConnection ${c}`),
    onDhanTicks: (t) => {
      m.noteTick();
      hub.ingestExternalTicks(t);
    },
    onDhanConnection: (c) => hub.setExternalConnected(c),
    onSessionLost: (b, r) => ev(`sessionLost ${b} ${r}`),
  });
  const idleProbe = {
    scannerRunning: () => false, openPositionCount: () => 0, brokersWithOpenPositions: () => [], workingOrderCount: () => 0,
    executionInFlight: () => false, reconciliationComplete: () => true, residualLegCount: () => 0, unknownOrderCount: () => 0,
    unresolvedIntentsFor: async () => 0,
  };
  m.attach(idleProbe, {
    stopScanner: () => ev("stopScanner"),
    invalidateBooks: () => ev("invalidateBooks"),
    reloadUniverse: async () => ev("reloadUniverse"),
    publish: () => ev("publish"),
    dropMarketDataSessions: () => {
      ev("dropSessions");
      return 0;
    },
  });
  const routes = [];
  const app = {
    get: (p, ...h) => routes.push({ method: "GET", path: p, handlers: h }),
    post: (p, ...h) => routes.push({ method: "POST", path: p, handlers: h }),
  };
  registerBrokerRoutes(app, { manager: m, requireAdmin, requireFullAdmin, getAdminRole, onBrokerChanged: (b) => ev(`changed ${b}`), indexSpotMap: INDEX_SPOT_MAP });
  const history = new HistoryProvider({ activeBroker: () => m.activeBroker, kite, dhan: m.dhan, dhanInstruments: m.dhanInstrumentStore });
  const leases = [];

  async function request(step) {
    const route = routes.find((r) => r.method === step.method && r.path === step.path);
    if (!route) throw new Error(`no route ${step.method} ${step.path}`);
    const headers = {};
    if (step.token) headers["x-admin-token"] = TOKENS[step.token];
    for (const [k, v] of Object.entries(step.headers ?? {})) headers[k.toLowerCase()] = v;
    const req = {
      method: step.method,
      path: step.path,
      headers,
      query: querystring.parse(step.query ?? ""),
      body: step.body,
      socket: { remoteAddress: "127.0.0.1" },
      header: (n) => headers[n.toLowerCase()],
    };
    const res = {
      statusCode: 200,
      headersOut: {},
      body: undefined,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(v) {
        this.body = JSON.stringify(v);
        return this;
      },
      setHeader(k, v) {
        this.headersOut[k.toLowerCase()] = v;
      },
    };
    for (const h of route.handlers) {
      let advanced = false;
      await h(req, res, () => {
        advanced = true;
      });
      if (!advanced) break;
    }
    const out = { status: res.statusCode, body: res.body };
    if (res.headersOut["retry-after"] !== undefined) out.retryAfter = res.headersOut["retry-after"];
    return out;
  }

  async function value(fn) {
    try {
      return { value: canonical(await fn()) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  const results = [];
  for (const step of sc.steps) {
    EVENTS = [];
    OUT = [];
    let r;
    switch (step.op) {
      case "req":
        r = await request(step);
        break;
      case "restore":
        await m.restore();
        r = {};
        break;
      case "startRuntime":
        await m.startActiveRuntime();
        r = {};
        break;
      case "stopFeeds":
        m.stopFeeds();
        r = {};
        break;
      case "advance":
        NOW += step.ms;
        r = {};
        break;
      case "env":
        for (const [k, v] of Object.entries(step.set ?? {})) process.env[k] = v;
        for (const k of step.unset ?? []) delete process.env[k];
        r = {};
        break;
      case "kiteToken":
        S.kiteToken = step.token;
        r = {};
        break;
      case "noteTick":
        m.noteTick();
        r = {};
        break;
      case "acquire":
        leases.push(m.acquireBrowserTokens(step.tokens));
        r = {};
        break;
      case "release":
        leases[step.lease]();
        r = {};
        break;
      case "setSynthetic":
        m.setSyntheticTokens(step.tokens);
        r = {};
        break;
      case "setAnalytics":
        m.subscriptions.setOwnerTokens("analytics", step.tokens);
        r = {};
        break;
      case "quotes":
        r = await value(() => m.quoteProvider.quotesByToken(step.tokens));
        break;
      case "marketData":
        r = await value(() => m.marketData().getQuoteFull(step.ids));
        break;
      case "marketAuth":
        r = await value(() => m.marketData().isAuthenticated());
        break;
      case "margin":
        r = await value(() => m.margins().basketMargin(step.orders, step.considerPositions === undefined ? undefined : { considerPositions: step.considerPositions }));
        break;
      case "history": {
        const fn = {
          full: () => history.getHistoricalFull(step.token, step.from, step.to, step.interval, step.prio),
          close: () => history.getHistorical(step.token, step.from, step.to, step.interval, step.prio),
          oi: () => history.getHistoricalOi(step.token, step.from, step.to, step.prio),
          oiSeries: () => history.getHistoricalOiSeries(step.token, step.from, step.to, step.interval, step.prio),
        }[step.fn];
        r = await value(fn);
        break;
      }
      case "loadInstruments":
        r = await value(async () => (await m.instrumentProvider.load(step.force)).length);
        break;
      case "owns":
        r = await value(() => m.assertActiveBrokerToken(step.token, "golden"));
        break;
      case "snapshot":
        r = await value(() => m.snapshot());
        break;
      case "feedHealth":
        r = await value(() => m.feedHealth());
        break;
      case "laneStats":
        r = await value(() => m.laneStats(step.lane));
        break;
      case "upstream":
        r = await value(() => m.upstreamFeedStats());
        break;
      case "health":
        r = await value(() => m.healthFor(step.broker));
        break;
      case "db":
        r = await value(() => __db.dump());
        break;
      default:
        throw new Error(`unknown op ${step.op}`);
    }
    await settle();
    results.push({ ...r, events: EVENTS, out: [...OUT].sort() });
  }
  return { ...sc, http: sc.http ?? {}, results, sockets: SOCKETS };
}

/* ------------------------------ the scenarios ------------------------------ */

const CREDS = { DHAN_CLIENT_ID: "1100001", DHAN_API_KEY: "app-key", DHAN_API_SECRET: "app-secret", DHAN_MIN_INTERVAL_MS: "0", DHAN_MAX_READ_ATTEMPTS: "1" };
const MASTER_OK = { "master GET detailed": [{ status: 200, body: MASTER_CSV }] };
const CONSUME_OK = {
  "auth GET /app/consumeApp-consent": [{
    status: 200,
    body: { accessToken: "dhan-tok-1", dhanClientId: "1100001", dhanClientName: "Test User", dhanClientUcc: "UCC1", givenPowerOfAttorney: "true", expiryTime: "2026-11-02T10:00:00.000Z" },
  }],
};
const SESSION_SEED = (o = {}) => ({
  access_token: "persisted-tok", dhan_client_id: "1100001", dhan_client_name: "Restored", dhan_client_ucc: "U9", given_power_of_attorney: true,
  expiry_time: null, login_at: Date.parse("2026-10-27T03:00:00.000Z"), login_date: "2026-10-27", updated_at: Date.parse("2026-10-27T03:00:00.000Z"), ...o,
});
const req = (method, p, o = {}) => ({ op: "req", method, path: p, ...o });
const AB = (o) => ({ selected_by: "admin", selected_at: Date.parse("2026-10-20T00:00:00.000Z"), ...o });
const BOX_ORDERS = [
  { exchange: "NFO", tradingsymbol: "BHEL-Nov2026-200-CE-0", transaction_type: "BUY", variety: "regular", product: "NRML", order_type: "MARKET", quantity: 2625, price: 50 },
  { exchange: "NFO", tradingsymbol: "BHEL-Nov2026-205-PE-1", transaction_type: "SELL", variety: "regular", product: "NRML", order_type: "MARKET", quantity: 2625, price: 0, reference_price: 12.5 },
  { exchange: "NFO", tradingsymbol: "BHEL-Nov2026-FUT", transaction_type: "BUY", variety: "regular", product: "NRML", order_type: "MARKET", quantity: 2625, price: 0, reference_price: null },
];
const OPTION_TOKENS = Array.from({ length: 1003 }, (_, i) => 2_000_060_000 + i);

const SCENARIOS = [
  {
    name: "defaults: no Dhan env, no database, Zerodha without a session",
    env: {}, db: false, kite: { token: null, hubConnected: false },
    steps: [
      req("GET", "/api/broker/status"),
      req("GET", "/api/broker/status", { token: "bogus" }),
      req("GET", "/api/broker/status", { token: "trade" }),
      req("GET", "/api/broker/switch-blockers", { token: "trade" }),
      req("GET", "/api/broker/switch-blockers", { token: "trade", query: "broker=dhan" }),
      req("GET", "/api/broker/switch-blockers", { token: "trade", query: "broker=%20DHAN%20" }),
      req("GET", "/api/broker/switch-blockers", { token: "trade", query: "broker=foo" }),
      req("GET", "/api/broker/switch-blockers", { token: "trade", query: "broker=dhan&broker=zerodha" }),
      req("GET", "/api/broker/switch-blockers", { query: "broker=dhan" }),
      req("POST", "/api/broker/select", { token: "trade", body: { broker: "dhan" } }),
      req("POST", "/api/broker/select", { token: "full" }),
      req("POST", "/api/broker/select", { token: "full", body: { broker: 5 } }),
      req("POST", "/api/broker/select", { token: "full", body: ["dhan"] }),
      req("POST", "/api/broker/select", { token: "full", body: { broker: "dhan" } }),
      req("POST", "/api/broker/select", { token: "full", body: { broker: " Zerodha " } }),
      req("POST", "/api/dhan/login", { token: "trade" }),
      req("POST", "/api/dhan/login", { token: "full" }),
      req("POST", "/api/dhan/session", { token: "full", body: {} }),
      req("POST", "/api/dhan/session", { token: "full", body: { tokenId: "   " } }),
      req("POST", "/api/dhan/session", { token: "full", body: { tokenId: null } }),
      req("POST", "/api/dhan/session", { token: "full", body: { tokenId: 12345 } }),
      req("POST", "/api/dhan/session", { token: "full", body: { tokenId: [" a", "b "] } }),
      req("GET", "/api/dhan/status", { token: "trade" }),
      req("GET", "/api/dhan/status"),
      req("POST", "/api/dhan/verify-ip", { token: "trade" }),
      req("POST", "/api/dhan/verify-ip", { token: "full" }),
      req("GET", "/api/dhan/instruments/diagnostics", { token: "full" }),
      req("POST", "/api/dhan/logout", { token: "full" }),
      req("POST", "/api/dhan/postback", { body: { orderId: "1", orderStatus: "TRADED", correlationId: "c1" } }),
      req("POST", "/api/dhan/postback", { body: { orderId: "", orderStatus: "X" } }),
      req("POST", "/api/dhan/postback", { body: { orderId: 7 } }),
      req("POST", "/api/dhan/postback"),
      req("POST", "/api/dhan/postback", { body: [1, 2] }),
      req("GET", "/api/dhan/access-token", { token: "full" }),
      req("GET", "/api/dhan/access-token", { token: "trade" }),
      req("GET", "/api/dhan/token"),
      req("GET", "/api/dhan/token", { query: "passcode=x" }),
      { op: "feedHealth" }, { op: "laneStats", lane: "futures" }, { op: "laneStats", lane: "box" }, { op: "upstream" },
      { op: "marketAuth" }, { op: "health", broker: "dhan" },
      { op: "kiteToken", token: "" },
      { op: "snapshot" },
      { op: "quotes", tokens: [] },
      { op: "quotes", tokens: [112129, 999, 13238786] },
      { op: "owns", token: 999 },
      { op: "owns", token: 112129 },
    ],
  },
  {
    name: "Dhan login, session and token routes with a database",
    env: { ...CREDS, TOKEN_ROUTE_SECRET: " pass " }, db: true, kite: { token: "kite-token", hubConnected: true, hubSubscribed: 3 },
    http: {
      "auth POST /app/generate-consent": [
        { status: 200, body: { consentAppId: "consent 1/2", consentAppStatus: "GENERATED" } },
        { status: 500, body: { errorMessage: "consent backend down", message: "ignored" } },
        { status: 200, body: { consentAppStatus: "GENERATED" } },
        { status: 403, body: "<html>denied</html>" },
        { status: 502, body: "" },
      ],
      ...CONSUME_OK,
      ...MASTER_OK,
    },
    steps: [
      req("POST", "/api/dhan/login", { token: "full" }),
      req("POST", "/api/dhan/login", { token: "full" }),
      req("POST", "/api/dhan/login", { token: "full" }),
      req("POST", "/api/dhan/login", { token: "full" }),
      req("POST", "/api/dhan/login", { token: "full" }),
      req("GET", "/api/dhan/status", { token: "trade" }),
      req("POST", "/api/dhan/session", { token: "full", body: { tokenId: " tid-1 " } }),
      req("GET", "/api/dhan/status", { token: "trade" }),
      req("GET", "/api/dhan/access-token", { token: "full" }),
      req("GET", "/api/dhan/token"),
      req("GET", "/api/dhan/token", { query: "passcode=wrong" }),
      req("GET", "/api/dhan/token", { query: "passcode=pass&passcode=pass" }),
      req("GET", "/api/dhan/token", { headers: { "x-token-passcode": "pass" } }),
      req("GET", "/api/dhan/token", { query: "passcode=pass" }),
      req("GET", "/api/dhan/token", { query: "passcode=pass", headers: { "x-token-passcode": "" } }),
      req("GET", "/api/broker/status", { token: "trade" }),
      { op: "db" },
      { op: "advance", ms: 6 * 86_400_000 },
      req("GET", "/api/dhan/access-token", { token: "full" }),
      req("GET", "/api/dhan/token", { query: "passcode=pass" }),
      req("GET", "/api/dhan/status", { token: "trade" }),
      { op: "env", unset: ["TOKEN_ROUTE_SECRET"] },
      req("GET", "/api/dhan/token", { query: "passcode=pass" }),
    ],
  },
  {
    name: "switch to Dhan and back with a database: teardown order, durable generation",
    env: { ...CREDS, DHAN_STATIC_PUBLIC_IP: " 203.0.113.7 " }, db: true,
    seed: { active_broker: AB({ broker: "zerodha", generation: 4 }) },
    kite: { token: "kite-token", hubConnected: true, hubSubscribed: 2 },
    http: { ...CONSUME_OK, ...MASTER_OK, "api GET /ip/getIP": [{ status: 200, body: { ipAddress1: "203.0.113.7", ipAddress2: "NA", status: "ok" } }] },
    steps: [
      { op: "restore" },
      { op: "acquire", tokens: [256265, 112129, 112129, -1, 0] },
      { op: "setAnalytics", tokens: [112129, 13238786] },
      { op: "loadInstruments", force: false },
      { op: "owns", token: 2000050000 },
      req("POST", "/api/dhan/session", { token: "full", body: { tokenId: "tid" } }),
      req("POST", "/api/broker/select", { token: "full", body: { broker: "dhan" } }),
      { op: "upstream" }, { op: "laneStats", lane: "futures" }, { op: "laneStats", lane: "box" }, { op: "feedHealth" },
      { op: "acquire", tokens: [2000050000, 1000000438] },
      { op: "setSynthetic", tokens: [2000060000, 2000060001] },
      { op: "owns", token: 256265 },
      { op: "owns", token: 2000050000 },
      { op: "noteTick" },
      { op: "feedHealth" },
      req("GET", "/api/dhan/instruments/diagnostics", { token: "full" }),
      req("POST", "/api/dhan/verify-ip", { token: "full" }),
      req("GET", "/api/dhan/status", { token: "trade" }),
      { op: "db" },
      req("POST", "/api/broker/select", { token: "full", body: { broker: "dhan" } }),
      req("POST", "/api/broker/select", { token: "full", body: { broker: "zerodha" } }),
      { op: "db" },
      req("POST", "/api/dhan/logout", { token: "full" }),
      { op: "db" },
      { op: "snapshot" },
    ],
  },
  {
    name: "restore a persisted Dhan selection and session, then start the runtime",
    env: { ...CREDS, DHAN_STATIC_IP_EXPECTED: "TRUE", DHAN_LIVE_TRADING_ENABLED: "yes" }, db: true,
    seed: { active_broker: AB({ broker: "dhan", generation: 9, selected_by: "full" }), dhan_session: SESSION_SEED() },
    kite: { token: null, hubConnected: false },
    http: {
      ...MASTER_OK,
      "api POST /marketfeed/quote": [{ echo: "quote" }],
      "api POST /charts/intraday": [{ echo: "intraday" }],
      "api POST /charts/historical": [{ echo: "daily" }],
    },
    steps: [
      { op: "snapshot" },
      { op: "restore" },
      { op: "snapshot" },
      { op: "startRuntime" },
      req("GET", "/api/dhan/status", { token: "trade" }),
      { op: "marketAuth" },
      { op: "quotes", tokens: [1000000438, ...OPTION_TOKENS, 13, 2000035001, 999, 2000060005] },
      { op: "marketData", ids: ["NFO:BHEL-Nov2026-FUT", "NSE:BHEL", "INDICES:NIFTY", "NFO:NOPE", "NFO:BHEL-Nov2026-FUT", "NFO:BHEL-Nov2026-205-PE-1001"] },
      { op: "history", fn: "close", token: 2000050000, from: "2026-10-01", to: "2026-10-12", interval: "minute" },
      { op: "history", fn: "oiSeries", token: 2000050000, from: "2026-10-01 09:15:00", to: "2026-10-03 15:30:00", interval: "15minute" },
      { op: "history", fn: "full", token: 13, from: "2026-10-01", to: "2026-10-04", interval: "60minute" },
      { op: "history", fn: "full", token: 2000050000, from: "2026-10-01", to: "2026-10-04" },
      { op: "history", fn: "oi", token: 2000035001, from: "2026-10-01", to: "2026-10-03" },
      { op: "history", fn: "close", token: 2000050000, from: "garbage", to: "2026-10-03", interval: "minute" },
      { op: "history", fn: "full", token: 2000050000, from: "garbage", to: "2026-10-03", interval: "day" },
      { op: "history", fn: "close", token: 2000099999, from: "2026-10-01", to: "2026-10-02", interval: "5minute" },
      { op: "history", fn: "close", token: 5, from: "2026-10-01", to: "2026-10-02", interval: "3minute" },
      { op: "history", fn: "close", token: 9_000_000_005, from: "2026-10-01", to: "2026-10-02", interval: "30minute" },
      { op: "history", fn: "close", token: 2000050000, from: "2026-10-05", to: "2026-10-01", interval: "minute" },
      { op: "history", fn: "close", token: 2000050000, from: "2026-10-01", to: "2026-10-02", interval: "week" },
      { op: "stopFeeds" },
      { op: "upstream" },
      req("GET", "/api/broker/status", { token: "trade" }),
    ],
  },
  {
    name: "Dhan basket margins: multi-order preferred, per-leg fallback, unavailable",
    env: { ...CREDS }, db: true,
    seed: { active_broker: AB({ broker: "dhan", generation: 2 }), dhan_session: SESSION_SEED() },
    http: {
      ...MASTER_OK,
      "api POST /margincalculator/multi": [
        { status: 200, body: { data: { totalMargin: 41250.4, spanMargin: 30000.5, exposureMargin: 11250, marginBenefit: 158750, foMargin: "12" } } },
        { status: 200, body: { totalMargin: 0 } },
        { status: 500, body: { errorType: "Server", errorMessage: "multi down" } },
        { status: 200, body: { total_margin: "99.5", span_margin: null } },
      ],
      "api POST /margincalculator": [
        { status: 200, body: { totalMargin: 50000.6, spanMargin: 40000.4 } },
        { status: 200, body: { totalMargin: "x", spanMargin: "7" } },
        { status: 200, body: "" },
        { status: 400, body: { errorMessage: "bad leg" } },
        { status: 200, body: { totalMargin: 10, spanMargin: 1 } },
        { status: 400, body: { errorMessage: "bad leg" } },
      ],
    },
    steps: [
      { op: "restore" },
      { op: "margin", orders: BOX_ORDERS },
      { op: "snapshot" },
      { op: "margin", orders: BOX_ORDERS, considerPositions: true },
      { op: "margin", orders: BOX_ORDERS },
      { op: "margin", orders: [...BOX_ORDERS, { ...BOX_ORDERS[0], tradingsymbol: "NOPE" }] },
      { op: "margin", orders: [{ ...BOX_ORDERS[0], exchange: "NSE" }] },
      { op: "margin", orders: [] },
      { op: "margin", orders: BOX_ORDERS.slice(0, 2) },
      { op: "snapshot" },
    ],
  },
  {
    name: "Zerodha active: kite margins, quotes, history and the second lane",
    env: {}, db: false, kite: { token: "kite-token", hubConnected: true, hubSubscribed: 1 },
    steps: [
      { op: "margin", orders: BOX_ORDERS },
      { op: "margin", orders: BOX_ORDERS, considerPositions: false },
      { op: "marketAuth" },
      { op: "marketData", ids: ["NSE:BHEL", "NFO:BHEL26NOVFUT"] },
      { op: "history", fn: "full", token: 13238786, from: "2026-10-01", to: "2026-10-04" },
      { op: "history", fn: "close", token: 13238786, from: "2026-10-01", to: "2026-10-04", interval: "minute", prio: "background" },
      { op: "history", fn: "oi", token: 13238786, from: "2026-10-01", to: "2026-10-04" },
      { op: "history", fn: "oiSeries", token: 13238786, from: "2026-10-01", to: "2026-10-04", interval: "5minute" },
      { op: "setSynthetic", tokens: [13238786, 13239042] },
      { op: "laneStats", lane: "box" },
      { op: "setSynthetic", tokens: [13239042] },
      { op: "laneStats", lane: "box" },
      { op: "acquire", tokens: [256265] },
      { op: "release", lease: 0 },
      { op: "release", lease: 0 },
      { op: "laneStats", lane: "futures" },
      { op: "stopFeeds" },
      { op: "laneStats", lane: "box" },
      { op: "snapshot" },
    ],
  },
  {
    name: "static IP verification",
    env: { ...CREDS, DHAN_STATIC_PUBLIC_IP: "203.0.113.9", DHAN_LIVE_TRADING_ENABLED: "1" }, db: true,
    seed: { active_broker: AB({ broker: "dhan", generation: 3 }), dhan_session: SESSION_SEED() },
    http: {
      "api GET /ip/getIP": [
        { status: 200, body: { data: { primaryIP: "198.51.100.1", secondaryIP: " 203.0.113.9 " } } },
        { status: 200, body: { primaryIP: "198.51.100.1", secondaryIP: "198.51.100.2", modifyDate: "2026-01-01" } },
        { status: 200, body: { status: "success", data: { ipFlag: "NA" } } },
        { status: 200, body: "" },
        { status: 500, body: { errorMessage: "ip service down" } },
        { status: 200, body: [["203.0.113.9"], { nested: { deeper: "10.0.0.1" } }] },
      ],
    },
    steps: [
      { op: "health", broker: "dhan" },
      req("GET", "/api/dhan/status", { token: "trade" }),
      { op: "restore" },
      req("GET", "/api/dhan/status", { token: "trade" }),
      req("GET", "/api/dhan/status", { token: "trade" }),
      req("POST", "/api/dhan/verify-ip", { token: "full" }),
      { op: "health", broker: "dhan" },
      req("POST", "/api/dhan/verify-ip", { token: "full" }),
      req("POST", "/api/dhan/verify-ip", { token: "full" }),
      req("POST", "/api/dhan/verify-ip", { token: "full" }),
      { op: "env", set: { DHAN_STATIC_IP_EXPECTED: "false" } },
      req("POST", "/api/dhan/verify-ip", { token: "full" }),
      { op: "env", set: { DHAN_STATIC_IP_EXPECTED: "" } },
      { op: "health", broker: "dhan" },
      { op: "env", unset: ["DHAN_STATIC_IP_EXPECTED"] },
      { op: "health", broker: "dhan" },
      { op: "env", unset: ["DHAN_STATIC_PUBLIC_IP"], set: { DHAN_STATIC_IP_EXPECTED: "yes" } },
      { op: "health", broker: "dhan" },
      req("POST", "/api/dhan/verify-ip", { token: "full" }),
      { op: "env", set: { DHAN_DATA_ENABLED: "no" } },
      { op: "health", broker: "dhan" },
      { op: "marketAuth" },
      { op: "env", set: { DHAN_DATA_ENABLED: "  YES " } },
      { op: "marketAuth" },
      { op: "snapshot" },
    ],
  },
  {
    name: "expired persisted Dhan session is cleared at boot",
    env: { ...CREDS }, db: true,
    seed: { active_broker: AB({ broker: "dhan" }), dhan_session: SESSION_SEED({ expiry_time: Date.parse("2026-10-28T05:59:59.999Z") }) },
    steps: [
      { op: "restore" },
      { op: "db" },
      { op: "snapshot" },
      { op: "startRuntime" },
      req("GET", "/api/dhan/status", { token: "trade" }),
    ],
  },
  {
    name: "rate limits run before auth",
    env: { ...CREDS, TOKEN_ROUTE_SECRET: "pass" }, db: false,
    http: { "auth POST /app/generate-consent": [{ status: 200, body: { consentAppId: "c" } }] },
    steps: [
      ...Array.from({ length: 11 }, () => req("POST", "/api/broker/select", { body: { broker: "dhan" } })),
      req("POST", "/api/broker/select", { token: "full", body: { broker: "dhan" }, headers: { "x-forwarded-for": " 9.9.9.9 , 1.1.1.1" } }),
      ...Array.from({ length: 10 }, () => req("POST", "/api/dhan/login", { token: "trade" })),
      ...Array.from({ length: 10 }, () => req("POST", "/api/dhan/session", { token: "full", body: {} })),
      req("POST", "/api/dhan/login", { token: "full" }),
      { op: "advance", ms: 299_999 },
      req("POST", "/api/dhan/session", { token: "full", body: {} }),
      { op: "advance", ms: 2 },
      req("POST", "/api/dhan/login", { token: "full" }),
      ...Array.from({ length: 31 }, () => req("GET", "/api/dhan/token", { query: "passcode=nope" })),
    ],
  },
];

// The login/token scenario jumps the clock six days ahead, so it runs last: the route
// limiters are module-level in Node and every scenario must start in fresh windows.
SCENARIOS.push(SCENARIOS.splice(1, 1)[0]);

const results = [];
let start = Date.parse("2026-10-28T06:00:00.000Z");
for (const sc of SCENARIOS) {
  // An hour after everything before it (the Go replay builds fresh limiters per
  // scenario; Node's buckets must have expired).
  sc.startMs = start;
  results.push(await runScenario(sc));
  start = Math.max(start, NOW) + 3_600_000;
}

const helpers = helperCases();
fs.writeFileSync(path.join(here, "helpers.golden.json"), canonical({ generator: "gen_registry.mjs", ...helpers }) + "\n");
fs.writeFileSync(
  path.join(here, "routes.golden.json"),
  `{\n "generator": "gen_registry.mjs",\n "masters": ${canonical({ main: MASTER_CSV })},\n "kiteRows": ${canonical(KITE_ROWS)},\n "scenarios": [\n${results.map((r) => "  " + canonical(r)).join(",\n")}\n ]\n}\n`,
);
process.stdout.write(`gen_registry.mjs: ${results.length} scenarios, ${results.reduce((n, r) => n + r.steps.length, 0)} steps -> routes.golden.json, helpers.golden.json\n`);
