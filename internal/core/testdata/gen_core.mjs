// Golden generator for internal/core: runs the ORIGINAL route code of src/index.ts on
// Express 5.2.1 over loopback HTTP and records every response, plus a few pure helpers.
//
//   scratch/go-migration/check.sh node --experimental-strip-types internal/core/testdata/gen_core.mjs
//
// How the reference is built: the line ranges listed in RANGES are copied VERBATIM from
// src/index.ts (each range is checked against its expected first line, so an edited
// source fails loudly) into scratch/go-migration/tmp/core/core_routes.ts, wrapped in
// `build(env)` so the module-level collaborators (kite, brokerManager, history, the db
// functions, the Yahoo client, SpreadSummary, triggerPostLoginBackfill) are scenario
// fakes. rateLimit, checkTokenPasscode/readPasscode and the index spot helpers are the
// real src modules; KiteError is copied from src/kite.ts. Only delay() is replaced (it
// records the pause instead of sleeping). Date is replaced by a fake clock.
//
// Express is not installed in this repository (no node_modules). The generator loads the
// Express stack from EXPRESS_NODE_MODULES (default /home/prakash/GAR/GAR_B/node_modules,
// read only), after checking that express, body-parser, router, finalhandler, encodeurl,
// escape-html, accepts, negotiator and statuses there have exactly the versions this
// repository's package-lock.json pins. Nothing is installed and nothing leaves loopback.
//
// Writes core.golden.json (route scenarios) and express.golden.json (querystring,
// encodeurl, escape-html and Accept negotiation cases) next to this file.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import querystring from "node:querystring";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const srcDir = path.join(repoRoot, "src");
const tmpDir = path.join(repoRoot, "scratch/go-migration/tmp/core");
const nodeModules = process.env.EXPRESS_NODE_MODULES ?? "/home/prakash/GAR/GAR_B/node_modules";

// --- the Express stack, version-checked against package-lock.json -------------------
const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
for (const name of ["express", "body-parser", "router", "finalhandler", "encodeurl", "escape-html", "accepts", "negotiator", "statuses"]) {
  const want = lock.packages[`node_modules/${name}`]?.version;
  const got = JSON.parse(fs.readFileSync(path.join(nodeModules, name, "package.json"), "utf8")).version;
  if (!want || want !== got) throw new Error(`${name}: lockfile ${want}, ${nodeModules} has ${got}`);
}
const require = createRequire(path.join(nodeModules, "noop.js"));
const express = require("express");
const encodeUrl = require("encodeurl");
const escapeHtml = require("escape-html");
const accepts = require("accepts");

// --- fake clock --------------------------------------------------------------------
const RealDate = Date;
let nowMs = RealDate.UTC(2026, 9, 27, 6, 0, 0);
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(nowMs);
    else super(...args);
  }
  static now() {
    return nowMs;
  }
}
globalThis.Date = FakeDate;

// --- the reference module ------------------------------------------------------------
const indexLines = fs.readFileSync(path.join(srcDir, "index.ts"), "utf8").split("\n");
const RANGES = [
  [173, 183, "function requireMarketData(res: Response, what: string): boolean {"],
  [238, 238, "let adminRfRate: number | null = null;"],
  [243, 249, 'type AdminRole = "full" | "trade";'],
  [256, 297, "function getAdminRole(token: string | undefined): AdminRole | null {"],
  [1047, 1048, "let dividendCache: { at: number; data: Record<string, number> } | null = null;"],
  [1055, 1263, 'app.set("etag", false);'],
  [1396, 1603, "// --- Step 1: send the user to Zerodha's login page ---"],
  [1625, 2071, "// --- Dividend yields (%) per F&O stock, sourced from Yahoo Finance."],
  [2384, 2396, 'app.get("/api/spread-stats/:symbol", async (req: Request, res: Response) => {'],
  [3216, 3363, "interface BoardFuture {"],
  [5188, 5229, "/** Persist the Zerodha access token so it survives a restart (best-effort). */"],
];
function slice([from, to, first]) {
  if (indexLines[from - 1] !== first) {
    throw new Error(`src/index.ts:${from} is ${JSON.stringify(indexLines[from - 1])}, expected ${JSON.stringify(first)}`);
  }
  return indexLines.slice(from - 1, to).join("\n");
}
function mustReplace(text, from, to) {
  if (!text.includes(from)) throw new Error(`cannot find ${JSON.stringify(from)}`);
  return text.replace(from, to);
}
let body = RANGES.map(slice).join("\n\n");
body = mustReplace(
  body,
  "function delay(ms: number): Promise<void> {\n  return new Promise((resolve) => setTimeout(resolve, ms));\n}",
  "function delay(ms: number): Promise<void> {\n  return env.delay(ms);\n}",
);
const kiteLines = fs.readFileSync(path.join(srcDir, "kite.ts"), "utf8").split("\n");
const kiteStart = kiteLines.indexOf("export class KiteError extends Error {");
const kiteErrorClass = kiteLines.slice(kiteStart, kiteStart + 8).join("\n");
if (!kiteErrorClass.trim().endsWith("}")) throw new Error("KiteError class not found");

const moduleText = `// GENERATED by internal/core/testdata/gen_core.mjs from src/index.ts; do not edit.
import { rateLimit } from ${JSON.stringify(path.join(srcDir, "ratelimit.ts"))};
import { checkTokenPasscode, readPasscode } from ${JSON.stringify(path.join(srcDir, "tokenRouteAuth.ts"))};
import { INDEX_SPOT_MAP, indexSpotCandidates, resolveIndexSpotSymbol } from ${JSON.stringify(path.join(srcDir, "indexSpot.ts"))};

${kiteErrorClass}

export function build(env: any) {
  const { express, app, kite, brokerManager, history, FRONTEND_URL, INTERNAL_TOKEN_SECRET, TOKEN_ROUTE_SECRET,
    saveRfRate, saveKiteSession, loadKiteSession, clearKiteSession, deleteAdminSession,
    triggerPostLoginBackfill, getDividendYields, SpreadSummary } = env;

${body}

  return { deriveFnoBoard, deriveFnoStocks, restoreSessionOnStartup, adminSessions, getRf: () => adminRfRate };
}
`;
fs.mkdirSync(tmpDir, { recursive: true });
const modFile = path.join(tmpDir, "core_routes.ts");
fs.writeFileSync(modFile, moduleText);
const ref = await import(pathToFileURL(modFile).href);
const { KiteError } = ref;

// --- scenario fakes ------------------------------------------------------------------
function fail(spec) {
  if (spec.kiteError) return new KiteError(spec.kiteError.message, spec.kiteError.status);
  return new Error(spec.error);
}
const isFailure = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && ("kiteError" in v || "error" in v);

function makeEnv(world, calls, logs) {
  const rec = (cat, ...args) => calls[cat].push(args);
  const kite = {
    getLoginUrl: () => world.kite.loginUrl,
    async generateSession(requestToken) {
      rec("kite", "generateSession", requestToken);
      const s = world.kite.sessions[requestToken];
      if (!s) throw new KiteError("Token is invalid or has expired.", 403);
      if (isFailure(s)) throw fail(s);
      world.kite.token = s.data.access_token;
      return structuredClone(s.data);
    },
    setAccessToken(t) {
      rec("kite", "setAccessToken", t);
      world.kite.token = t;
    },
    hasSession: () => world.kite.token !== null,
    getApiKey: () => world.kite.apiKey,
    getAccessToken: () => world.kite.token,
    clearSession() {
      rec("kite", "clearSession");
      world.kite.token = null;
    },
    async getProfile() {
      rec("kite", "getProfile");
      if (!world.kite.token) throw new KiteError("Not authenticated. Complete the Zerodha login flow first (/login).", 401);
      const p = world.kite.profile;
      if (isFailure(p)) {
        // The real client drops the session itself on a Kite 401/403 before throwing.
        if (p.kiteError && (p.kiteError.status === 401 || p.kiteError.status === 403)) this.clearSession();
        throw fail(p);
      }
      return structuredClone(p.data);
    },
  };
  const brokerManager = {
    get activeBroker() {
      return world.broker.active;
    },
    get generation() {
      return world.broker.generation;
    },
    activeHealth: () => structuredClone(world.broker.health),
    feedHealth: () => structuredClone(world.broker.feed),
    instrumentProvider: {
      async load() {
        rec("instruments", "load");
        if (isFailure(world.instruments)) throw fail(world.instruments);
        return world.instruments;
      },
    },
  };
  const series = (token, key) => {
    const s = world.history[String(token)]?.[key];
    if (s === undefined) return [];
    if (isFailure(s)) throw fail(s);
    // "NaN" in the scenario data stands for a junk value Number() turns into NaN.
    return structuredClone(s).map((row) => (typeof row.close === "string" ? { ...row, close: Number(row.close) } : row));
  };
  const history = {
    async getHistoricalOi(token, from, to) {
      rec("history", "oi", token, from, to);
      return series(token, "oi");
    },
    async getHistorical(token, from, to, interval) {
      rec("history", "hist", token, from, to, interval);
      return series(token, interval);
    },
  };
  const dbFail = (key) => {
    const msg = world.db[key];
    if (msg) throw new Error(msg);
  };
  return {
    express,
    kite,
    brokerManager,
    history,
    FRONTEND_URL: world.config.frontendUrl,
    INTERNAL_TOKEN_SECRET: world.config.internalSecret,
    TOKEN_ROUTE_SECRET: world.config.tokenSecret,
    async saveRfRate(rf) {
      rec("db", "saveRfRate", rf);
    },
    async saveKiteSession(data) {
      rec("db", "saveKiteSession", JSON.parse(JSON.stringify(data)));
      world.db.kiteSession = JSON.parse(JSON.stringify(data));
    },
    async loadKiteSession() {
      rec("db", "loadKiteSession");
      dbFail("loadError");
      return world.db.kiteSession ? structuredClone(world.db.kiteSession) : null;
    },
    async clearKiteSession() {
      rec("db", "clearKiteSession");
      dbFail("clearError");
      world.db.kiteSession = null;
    },
    async deleteAdminSession() {},
    triggerPostLoginBackfill() {
      rec("hooks", "triggerPostLoginBackfill");
    },
    async getDividendYields(symbols) {
      rec("yahoo", "getDividendYields", symbols);
      const out = {};
      for (const s of symbols) if (s) out[s] = world.yields[s] ?? 0;
      return out;
    },
    SpreadSummary: {
      findOne(q) {
        rec("spread", "findOne", q.symbol);
        return {
          async lean() {
            const doc = world.spread[q.symbol];
            if (doc === undefined) return null;
            if (isFailure(doc)) throw fail(doc);
            const out = {};
            for (const [k, v] of Object.entries(doc)) {
              out[k] = k === "first_date" || k === "last_date" ? new RealDate(v) : v;
            }
            return out;
          },
        };
      },
    },
    delay: async (ms) => {
      rec("delays", ms);
    },
    logs,
  };
}

const CATEGORIES = ["kite", "instruments", "history", "db", "hooks", "yahoo", "spread", "delays"];
const KEPT_HEADERS = ["content-type", "location", "retry-after", "vary", "cache-control", "access-control-allow-origin"];

function request(port, { method, path: target, headers = [], body: reqBody }) {
  return new Promise((resolve, reject) => {
    const flat = ["Host", `127.0.0.1:${port}`, "Connection", "close"];
    for (const [k, v] of headers) flat.push(k, v);
    if (reqBody !== undefined && reqBody !== null) flat.push("Content-Length", String(Buffer.byteLength(reqBody)));
    const req = http.request({ host: "127.0.0.1", port, method, path: target, headers: flat, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const kept = {};
        for (const h of KEPT_HEADERS) if (res.headers[h] !== undefined) kept[h] = res.headers[h];
        // Express's development error page carries a stack trace (file paths of this
        // machine); keep the message line only.
        const text = Buffer.concat(chunks).toString("utf8").replace(/<br> &nbsp; &nbsp;at [\s\S]*?<\/pre>/, "</pre>");
        resolve({ status: res.statusCode, headers: kept, body: text });
      });
    });
    req.on("error", reject);
    if (reqBody !== undefined && reqBody !== null) req.write(reqBody);
    req.end();
  });
}

function setPath(obj, dotted, value) {
  const keys = dotted.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k];
  o[keys[keys.length - 1]] = structuredClone(value);
}

async function runScenario(sc) {
  const world = structuredClone(sc.world);
  const logs = [];
  const app = express();
  const calls = Object.fromEntries(CATEGORIES.map((c) => [c, []]));
  const env = makeEnv(world, calls, logs);
  env.app = app;
  const built = ref.build(env);
  for (const [token, s] of Object.entries(world.admin ?? {})) built.adminSessions.set(token, { role: s.role, expiry: s.expiry });
  const server = http.createServer(app);
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const origLog = console.log, origWarn = console.warn, origError = console.error;
  const capture = (...args) =>
    logs.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" ").split("\n")[0]);
  console.log = console.warn = console.error = capture;
  const steps = [];
  try {
    for (const step of sc.steps) {
      for (const c of CATEGORIES) calls[c].length = 0;
      logs.length = 0;
      const out = { ...step };
      if (step.op === "now") nowMs = step.ms;
      else if (step.op === "tz") process.env.TZ = step.tz;
      else if (step.op === "set") setPath(world, step.path, step.value);
      else if (step.op === "req") {
        out.res = await request(port, step);
        await new Promise((r) => setImmediate(r));
      } else if (step.op === "restore") {
        await built.restoreSessionOnStartup();
      } else if (step.op === "board") {
        out.board = JSON.stringify(built.deriveFnoBoard(world.instruments));
        out.stocks = JSON.stringify(built.deriveFnoStocks(world.instruments));
      } else throw new Error(`unknown op ${step.op}`);
      if (step.op === "req" || step.op === "restore") {
        out.calls = structuredClone(calls);
        out.kiteToken = world.kite.token;
        out.rf = built.getRf();
        out.logs = [...logs];
      }
      steps.push(out);
    }
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    await new Promise((r) => server.close(r));
  }
  return { name: sc.name, world: sc.world, steps };
}

// --- instrument dumps ----------------------------------------------------------------
function inst(token, tradingsymbol, name, expiry, strike, lot, type, segment, exchange, tick = 0.05) {
  return {
    instrument_token: token,
    exchange_token: Math.floor(token / 256),
    tradingsymbol,
    name,
    last_price: 0,
    expiry,
    strike,
    tick_size: tick,
    lot_size: lot,
    instrument_type: type,
    segment,
    exchange,
  };
}
const MONTHS = [
  ["2026-10-27", "26OCT"],
  ["2026-11-24", "26NOV"],
  ["2026-12-29", "26DEC"],
  ["2027-01-26", "27JAN"],
];
function futuresOf(base, sym, lots, order = [0, 1, 2, 3]) {
  return order.map((m) => inst(base + m * 7, `${sym}${MONTHS[m][1]}FUT`, sym, MONTHS[m][0], 0, lots[m], "FUT", "NFO-FUT", "NFO"));
}
function kiteDump() {
  const rows = [];
  // Zerodha index rows are NSE / INDICES / "EQ".
  rows.push(inst(256265, "NIFTY 50", "NIFTY 50", "", 0, 0, "EQ", "INDICES", "NSE", 0));
  rows.push(inst(260105, "NIFTY BANK", "NIFTY BANK", "", 0, 0, "EQ", "INDICES", "NSE", 0));
  rows.push(inst(257801, "NIFTY FIN SERVICE", "NIFTY FIN SERVICE", "", 0, 0, "EQ", "INDICES", "NSE", 0));
  rows.push(inst(264969, "INDIA VIX", "INDIA VIX", "", 0, 0, "EQ", "INDICES", "NSE", 0));
  rows.push(inst(270857, "NIFTY NEXT 50", "NIFTY NEXT 50", "", 0, 0, "EQ", "INDICES", "NSE", 0));
  const stocks = [
    [738561, "RELIANCE", "RELIANCE INDUSTRIES", [500, 500, 250, 250]],
    [2953217, "TCS", "TATA CONSULTANCY SERV LT", [175, 175, 175, 175]],
    [519937, "M&M", "MAHINDRA & MAHINDRA", [350, 350, 350, 350]],
    [3400961, "M&MFIN", "M&M FIN. SERVICES", [2000, 2000, 2000, 2000]],
    [1041153, "MARICO", "MARICO", [1200, 1200, 1200, 1200]],
    [4268801, "BAJAJ-AUTO", "BAJAJ AUTO", [75, 75, 75, 75]],
    [81153, "BAJAJFINSV", "BAJAJ FINSERV", [500, 500, 500, 500]],
    [3861249, "ADANIPORTS", "ADANI PORTS AND SPECIAL ECONOMIC ZONE", [475, 475, 475, 475]],
    [341249, "HDFCBANK", "HDFC BANK", [550, 550, 550, 550]],
    [6401, "ADANIENT", "ADANI ENTERPRISES", [300, 300, 300, 300]],
    [1510401, "AXISBANK", "AXIS BANK", [625, 625, 625, 625]],
    [2939649, "LT", "LARSEN & TOUBRO", [175, 175, 175, 175]],
    [4561409, "LTIM", "LTIMINDTREE", [150, 150, 150, 150]],
    [6386689, "L&TFH", "L&T FINANCE", [4462, 4462, 4462, 4462]],
    [3520257, "NAM-INDIA", "NIPPON LIFE INDIA AMC", [1600, 1600, 1600, 1600]],
  ];
  let fbase = 13_000_000;
  for (const [token, sym, name, lots] of stocks) {
    rows.push(inst(token, sym, name, "", 0, 0, "EQ", "NSE", "NSE"));
    // Contract order in the dump is not expiry order; the first-seen lot (fno_lot_size)
    // is the far month's for RELIANCE.
    const order = sym === "RELIANCE" ? [3, 0, 2, 1] : sym === "TCS" ? [1, 0, 2, 3] : [0, 1, 2, 3];
    rows.push(...futuresOf(fbase, sym, lots, order));
    rows.push(inst(fbase + 1, `${sym}26OCT1000CE`, sym, MONTHS[0][0], 1000, lots[0], "CE", "NFO-OPT", "NFO"));
    rows.push(inst(fbase + 2, `${sym}26OCT1000PE`, sym, MONTHS[0][0], 1000, lots[0], "PE", "NFO-OPT", "NFO"));
    fbase += 1000;
  }
  // A second TCS equity row: the board and fno-stocks keep the LAST, the detail route
  // (Array.find) the FIRST.
  rows.push(inst(2953218, "TCS", "TCS DUPLICATE ROW", "", 0, 0, "EQ", "NSE", "NSE"));
  // Index futures. MIDCPNIFTY has futures but no spot row: skipped from the board.
  rows.push(...futuresOf(20_000_000, "NIFTY", [75, 75, 75, 75], [2, 3, 0, 1]));
  rows.push(...futuresOf(20_100_000, "BANKNIFTY", [35, 35, 35, 35]));
  rows.push(...futuresOf(20_200_000, "FINNIFTY", [65, 65, 65, 65]));
  rows.push(...futuresOf(20_300_000, "MIDCPNIFTY", [140, 140, 140, 140]));
  rows.push(...futuresOf(20_400_000, "NIFTYNXT50", [25, 25, 25, 25]).slice(0, 2));
  // Futures with no spot at all, a FUT with an empty name, and other exchanges.
  rows.push(...futuresOf(21_000_000, "UNLISTEDCO", [100, 100, 100, 100]));
  rows.push(inst(21_100_000, "BLANKNAME26OCTFUT", "", MONTHS[0][0], 0, 10, "FUT", "NFO-FUT", "NFO"));
  rows.push(inst(128083204, "RELIANCE", "RELIANCE INDUSTRIES", "", 0, 0, "EQ", "BSE", "BSE"));
  rows.push(inst(208893, "SENSEX26OCTFUT", "SENSEX", MONTHS[0][0], 0, 20, "FUT", "BFO-FUT", "BFO"));
  rows.push(inst(109134599, "CRUDEOIL26NOVFUT", "CRUDEOIL", "2026-11-19", 0, 100, "FUT", "MCX-FUT", "MCX", 1));
  // An underlying with a contract that has no expiry ("" sorts first) and five contracts.
  rows.push(inst(408065, "INFY", "INFOSYS", "", 0, 0, "EQ", "NSE", "NSE"));
  rows.push(...futuresOf(22_000_000, "INFY", [400, 400, 400, 400], [3, 2, 1, 0]));
  rows.push(inst(22_000_099, "INFYXFUT", "INFY", "", 0, 400, "FUT", "NFO-FUT", "NFO"));
  return rows;
}
// A board-sized dump in a scrambled order: real NSE F&O symbols (digits, "-" and "&"
// exercise the ICU collation of localeCompare), four monthly contracts each listed in a
// shuffled order, options, and the five allow-listed indices plus other index rows.
function realisticDump() {
  const symbols = [
    "360ONE", "AARTIIND", "ABB", "ABCAPITAL", "ADANIENSOL", "ADANIGREEN", "ALKEM", "AMBUJACEM", "APOLLOHOSP",
    "ASHOKLEY", "ASIANPAINT", "AUBANK", "AUROPHARMA", "BAJAJ-AUTO", "BAJAJFINSV", "BAJFINANCE", "BANKBARODA", "BEL",
    "BHARTIARTL", "BHEL", "BPCL", "BRITANNIA", "BSE", "CANBK", "CDSL", "CHOLAFIN", "CIPLA", "COALINDIA", "DABUR",
    "DIVISLAB", "DLF", "DRREDDY", "EICHERMOT", "GAIL", "GRASIM", "HAL", "HCLTECH", "HDFCAMC", "HDFCLIFE", "HEROMOTOCO",
    "HINDALCO", "HINDUNILVR", "ICICIBANK", "IDFCFIRSTB", "IEX", "INDHOTEL", "INDIGO", "INDUSINDBK", "IRCTC", "ITC",
    "J&KBANK", "JINDALSTEL", "JSWSTEEL", "KOTAKBANK", "LICHSGFIN", "LUPIN", "M&M", "M&MFIN", "MARUTI", "MCX",
    "MOTHERSON", "MPHASIS", "NESTLEIND", "NMDC", "NTPC", "ONGC", "PAGEIND", "PIDILITIND", "PNB", "POWERGRID",
    "SBICARD", "SBILIFE", "SBIN", "SHREECEM", "SIEMENS", "SUNPHARMA", "TATACONSUM", "TATAMOTORS", "TATAPOWER",
    "TATASTEEL", "TECHM", "TITAN", "TRENT", "ULTRACEMCO", "UPL", "VEDL", "WIPRO", "ZYDUSLIFE",
  ];
  let seed = 20261027;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const rows = [];
  symbols.forEach((sym, k) => {
    const token = 100_000 + k * 1031;
    const lot = [50, 75, 125, 250, 300, 500, 600, 1100, 2000, 3750][k % 10];
    rows.push(inst(token, sym, `${sym} LIMITED`, "", 0, 0, "EQ", "NSE", "NSE"));
    const order = [0, 1, 2, 3].sort(() => rand() - 0.5);
    const lots = MONTHS.map((_, m) => (m === 3 && k % 7 === 0 ? lot * 2 : lot));
    rows.push(...futuresOf(30_000_000 + k * 100, sym, lots, order));
    for (const kind of ["CE", "PE"]) {
      rows.push(inst(30_000_000 + k * 100 + (kind === "CE" ? 50 : 60), `${sym}26OCT${1000 + k}${kind}`, sym, MONTHS[0][0], 1000 + k, lot, kind, "NFO-OPT", "NFO"));
    }
  });
  for (const [token, sym] of [[256265, "NIFTY 50"], [260105, "NIFTY BANK"], [257801, "NIFTY FIN SERVICE"], [288009, "NIFTY MID SELECT"], [270857, "NIFTY NEXT 50"], [264969, "INDIA VIX"], [261641, "NIFTY IT"]]) {
    rows.push(inst(token, sym, sym, "", 0, 0, "EQ", "INDICES", "NSE", 0));
  }
  [["NIFTY", 75], ["BANKNIFTY", 35], ["FINNIFTY", 65], ["MIDCPNIFTY", 140], ["NIFTYNXT50", 25]].forEach(([u, lot], k) => {
    rows.push(...futuresOf(40_000_000 + k * 100, u, [lot, lot, lot, lot], [3, 1, 0, 2]));
  });
  // Shuffle the whole dump: nothing may depend on the master's row order except the
  // documented first-seen / last-wins rules.
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  return rows;
}
function dhanDump() {
  // Dhan names the index spots after the underlying and types them INDEX.
  const rows = [];
  rows.push(inst(13, "NIFTY", "NIFTY", "", 0, 0, "INDEX", "INDICES", "NSE"));
  rows.push(inst(25, "BANKNIFTY", "BANKNIFTY", "", 0, 0, "INDEX", "INDICES", "NSE"));
  rows.push(inst(27, "FINNIFTY", "FINNIFTY", "", 0, 0, "INDEX", "INDICES", "NSE"));
  rows.push(inst(442, "MIDCPNIFTY", "MIDCPNIFTY", "", 0, 0, "INDEX", "INDICES", "NSE"));
  rows.push(inst(1_000_002_885, "RELIANCE", "RELIANCE INDUSTRIES LTD", "", 0, 0, "EQ", "NSE", "NSE"));
  rows.push(...futuresOf(2_000_035_000, "NIFTY", [75, 75, 75, 75]));
  rows.push(...futuresOf(2_000_036_000, "BANKNIFTY", [35, 35, 35, 35]));
  rows.push(...futuresOf(2_000_037_000, "MIDCPNIFTY", [140, 140, 140, 140]));
  rows.push(...futuresOf(2_000_038_000, "RELIANCE", [500, 500, 500, 500]));
  return rows;
}

// --- scenarios -----------------------------------------------------------------------
const T0 = RealDate.UTC(2026, 9, 27, 6, 0, 0); // 2026-10-27 11:30 IST
const DAY = 86_400_000;
const FULL = "full-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TRADE = "trade-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const EXPIRED = "expired-full-ccccccccccccccccccccccccccccccc";
const ZERODHA_DOWN = {
  active: "zerodha",
  health: { authenticated: false, data_ready: false, trading_ready: false, problems: ["Zerodha is not connected"] },
  feed: { connected: false, state: "DOWN" },
  generation: 1,
};
const ZERODHA_UP = {
  active: "zerodha",
  health: { authenticated: true, data_ready: true, trading_ready: true, problems: [] },
  feed: { connected: true, state: "LIVE" },
  generation: 3,
};
function baseWorld(over = {}) {
  return {
    config: { frontendUrl: "http://localhost:5173", internalSecret: "int-secret", tokenSecret: "  route-pass  " },
    kite: {
      apiKey: "kite_api_key",
      token: null,
      loginUrl: "https://kite.zerodha.com/connect/login?api_key=kite_api_key&v=3",
      sessions: {},
      profile: { data: {} },
    },
    broker: structuredClone(ZERODHA_DOWN),
    admin: {
      [FULL]: { role: "full", expiry: T0 + DAY },
      [TRADE]: { role: "trade", expiry: T0 + DAY },
      [EXPIRED]: { role: "full", expiry: T0 - 1 },
    },
    instruments: kiteDump(),
    history: {},
    yields: {},
    spread: {},
    db: { kiteSession: null, loadError: null, clearError: null },
    ...over,
  };
}
const H = (...pairs) => pairs;
const get = (p, headers = []) => ({ op: "req", method: "GET", path: p, headers });
const post = (p, body, headers = [], ctype = "application/json") => ({
  op: "req",
  method: "POST",
  path: p,
  headers: ctype && body !== undefined ? [["Content-Type", ctype], ...headers] : headers,
  body,
});
const full = ["x-admin-token", FULL];
const trade = ["x-admin-token", TRADE];

const scenarios = [];

scenarios.push({
  name: "health and status",
  world: baseWorld(),
  steps: [
    { op: "now", ms: T0 },
    get("/"),
    get("/api/status"),
    { op: "set", path: "kite.token", value: "tok-1" },
    { op: "set", path: "broker", value: ZERODHA_UP },
    get("/"),
    get("/api/status"),
    {
      op: "set",
      path: "broker",
      value: {
        active: "dhan",
        health: { authenticated: false, data_ready: false, trading_ready: false, problems: ["Dhan session expired — reconnect Dhan"] },
        feed: { connected: false, state: "CONNECTING" },
        generation: 7,
      },
    },
    get("/api/status"),
    {
      op: "set",
      path: "broker",
      value: {
        active: "dhan",
        health: { authenticated: true, data_ready: false, trading_ready: false, problems: ["Dhan data API is disabled (DHAN_DATA_ENABLED=false)"] },
        feed: { connected: true, state: "CONNECTED_NO_SUBSCRIPTIONS" },
        generation: 8,
      },
    },
    get("/api/status"),
    get("/api/nope"),
    { op: "req", method: "POST", path: "/api/status", headers: [] },
  ],
});

scenarios.push({
  name: "token routes",
  world: baseWorld(),
  steps: [
    { op: "now", ms: RealDate.UTC(2026, 9, 27, 18, 31, 0) }, // 00:01 IST on the 28th
    get("/api/internal/kite-token"),
    get("/api/internal/kite-token", H(["x-internal-secret", "wrong"])),
    get("/api/internal/kite-token", H(["x-internal-secret", "int-secret"])),
    get("/api/internal/kite-token?secret=int-secret"),
    get("/api/internal/kite-token?secret=int-secret&secret=int-secret"),
    get("/api/internal/kite-token?secret=int-secret", H(["x-internal-secret", ""])),
    get("/api/internal/kite-token?secret=int%2Dsecret"),
    get("/api/kite/token?passcode=route-pass"),
    { op: "set", path: "kite.token", value: "access-xyz" },
    get("/api/internal/kite-token", H(["x-internal-secret", "int-secret"])),
    get("/api/kite/token"),
    get("/api/kite/token?passcode=wrong"),
    get("/api/kite/token?passcode=route-pass"),
    get("/api/kite/token", H(["x-token-passcode", "route-pass"])),
    get("/api/kite/token", H(["x-token-passcode", " route-pass "])),
    get("/api/kite/token", H(["x-token-passcode", "route-pass"], ["x-token-passcode", "route-pass"])),
    get("/api/kite/token?passcode=route+pass"),
    get("/api/kite/token?passcode=route-pass&passcode=x"),
    { op: "set", path: "kite.token", value: "" },
    get("/api/internal/kite-token", H(["x-internal-secret", "int-secret"])),
    get("/api/kite/token?passcode=route-pass"),
  ],
});

scenarios.push({
  name: "token routes not configured",
  world: baseWorld({ config: { frontendUrl: "http://localhost:5173", internalSecret: "", tokenSecret: "   " } }),
  steps: [
    { op: "now", ms: T0 },
    get("/api/internal/kite-token?secret=x"),
    get("/api/internal/kite-token"),
    get("/api/kite/token?passcode=x"),
    get("/api/rf?passcode="),
  ],
});

{
  const steps = [{ op: "now", ms: T0 }];
  for (let i = 0; i < 30; i++) steps.push(get("/api/kite/token?passcode=wrong", H(["X-Forwarded-For", "10.1.1.1"])));
  steps.push(get("/api/kite/token?passcode=route-pass", H(["X-Forwarded-For", "10.1.1.1"])));
  steps.push(get("/api/internal/kite-token?secret=int-secret", H(["X-Forwarded-For", "10.1.1.1"])));
  steps.push(get("/api/rf?passcode=route-pass", H(["X-Forwarded-For", "10.1.1.1"])));
  steps.push(get("/api/kite/token?passcode=route-pass", H(["X-Forwarded-For", "10.9.9.9, 10.1.1.1"])));
  steps.push({ op: "now", ms: T0 + 30_500 });
  steps.push(get("/api/kite/token?passcode=route-pass", H(["X-Forwarded-For", " 10.1.1.1 , proxy"])));
  steps.push({ op: "now", ms: T0 + 60_000 });
  steps.push(get("/api/kite/token?passcode=route-pass", H(["X-Forwarded-For", "10.1.1.1"])));
  steps.push({ op: "now", ms: T0 + 60_001 });
  steps.push(get("/api/kite/token?passcode=route-pass", H(["X-Forwarded-For", "10.1.1.1"])));
  scenarios.push({ name: "token route limiters", world: baseWorld(), steps });
}

scenarios.push({
  name: "risk-free rate",
  world: baseWorld(),
  steps: [
    { op: "now", ms: T0 },
    get("/api/rf/current"),
    get("/api/rf?passcode=route-pass"),
    post("/api/rf", '{"rf":6.5}'),
    post("/api/rf", '{"rf":6.5}', [trade]),
    post("/api/rf", '{"rf":6.5}', [["x-admin-token", EXPIRED]]),
    post("/api/rf", '{"rf":6.5}', [["x-admin-token", FULL + "x"]]),
    post("/api/rf", '{"rf":6.5}', [full]),
    get("/api/rf/current"),
    get("/api/rf?passcode=route-pass"),
    post("/api/rf", '{"rf":"7.25"}', [full]),
    post("/api/rf", '{"rf":null}', [full]),
    post("/api/rf", '{"rf":true}', [full]),
    post("/api/rf", '{"rf":false}', [full]),
    post("/api/rf", '{"rf":[5]}', [full]),
    post("/api/rf", '{"rf":[true]}', [full]),
    post("/api/rf", '{"rf":[]}', [full]),
    post("/api/rf", '{"rf":[[" 8 "]]}', [full]),
    post("/api/rf", '{"rf":[1,2]}', [full]),
    post("/api/rf", '{"rf":{}}', [full]),
    post("/api/rf", '{"rf":"abc"}', [full]),
    post("/api/rf", '{"rf":"0x10"}', [full]),
    post("/api/rf", '{"rf":" 1e2 "}', [full]),
    post("/api/rf", '{"rf":"\\u00a012\\u00a0"}', [full]),
    post("/api/rf", '{"rf":"1_000"}', [full]),
    post("/api/rf", '{"rf":"Infinity"}', [full]),
    post("/api/rf", '{"rf":""}', [full]),
    post("/api/rf", '{"rf":-0}', [full]),
    post("/api/rf", '{"rf":1e-7}', [full]),
    post("/api/rf", '{"rf":123456789012345680000}', [full]),
    post("/api/rf", '{"rf":5,"rf":9.75}', [full]),
    post("/api/rf", "{}", [full]),
    post("/api/rf", "", [full]),
    post("/api/rf", "[6]", [full]),
    post("/api/rf", undefined, [full]),
    post("/api/rf", '{"rf":4}', [full], "text/plain"),
    post("/api/rf", '{"rf":', [full]),
    get("/api/rf/current"),
    get("/api/rf?passcode=route-pass"),
  ],
});

scenarios.push({
  name: "login redirect",
  world: baseWorld(),
  steps: [
    { op: "now", ms: T0 },
    get("/login"),
    get("/api/login"),
    get("/login", [trade]),
    get(`/login?x-admin-token=${FULL}`),
    get(`/api/login`, [full]),
    get(`/api/login?x-admin-token=${TRADE}`, [full]),
    get(`/api/login?x-admin-token=`, [full]),
    get(`/api/login?x-admin-token=${FULL}&x-admin-token=${FULL}`, [full]),
    get(`/login?x-admin-token=${EXPIRED}`),
    get(`/login`, [full, ["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"]]),
    get(`/login`, [full, ["Accept", "application/json"]]),
    get(`/login`, [full, ["Accept", "text/html;q=0.5, text/plain;q=0.9"]]),
    get(`/login`, [full, ["Accept", "*/*"]]),
    get(`/login`, [full, ["Accept", ""]]),
    { op: "set", path: "kite.loginUrl", value: 'https://kite.zerodha.com/connect/login?api_key=k y&v=3&x="<>`{}|%zz%41%4é' },
    get(`/login`, [full]),
    get(`/login`, [full, ["Accept", "text/html"]]),
  ],
});

const SESSION_OK = {
  data: {
    user_type: "individual",
    email: "trader@example.com",
    user_name: "Trader One",
    user_shortname: "Trader",
    broker: "ZERODHA",
    exchanges: ["NSE", "NFO"],
    products: ["CNC", "NRML", "MIS"],
    order_types: ["MARKET", "LIMIT"],
    avatar_url: null,
    user_id: "AB1234",
    api_key: "kite_api_key",
    access_token: "access-new",
    public_token: "pub",
    refresh_token: "",
    enctoken: "enc",
    login_time: "2026-10-27 11:29:58",
    meta: { demat_consent: "consent" },
  },
};
scenarios.push({
  name: "kite session exchange",
  world: baseWorld({
    kite: {
      apiKey: "kite_api_key",
      token: "access-old",
      loginUrl: "https://kite.zerodha.com/connect/login?api_key=kite_api_key&v=3",
      sessions: {
        "rt-ok": SESSION_OK,
        "123": { data: { user_id: 12345, access_token: "access-num" } },
        "a,b": { data: { user_id: "XY9", user_name: "Joined Token", access_token: "access-joined" } },
        "rt-403": { kiteError: { message: "Token is invalid or has expired.", status: 403 } },
        "rt-200": { kiteError: { message: "Invalid `checksum`.", status: 200 } },
        "rt-500": { kiteError: { message: "Failed to generate session (HTTP 502).", status: 502 } },
        "rt-fetch": { error: "fetch failed" },
      },
      profile: { data: {} },
    },
  }),
  steps: [
    { op: "now", ms: T0 },
    post("/api/session", '{"request_token":"rt-ok"}'),
    post("/api/session", '{"request_token":"rt-ok"}', [trade]),
    post("/api/session", undefined, [full]),
    post("/api/session", "{}", [full]),
    post("/api/session", '{"request_token":""}', [full]),
    post("/api/session", '{"request_token":null}', [full]),
    post("/api/session", '["rt-ok"]', [full]),
    post("/api/session", '{"request_token":"rt-403"}', [full]),
    post("/api/session", '{"request_token":"rt-200"}', [full]),
    post("/api/session", '{"request_token":"rt-500"}', [full]),
    post("/api/session", '{"request_token":"rt-fetch"}', [full]),
    post("/api/session", '{"request_token":"unknown"}', [full]),
    post("/api/session", '{"request_token":123}', [full]),
    post("/api/session", '{"request_token":["a","b"]}', [full]),
    { op: "now", ms: RealDate.UTC(2026, 9, 27, 18, 45, 0) },
    post("/api/session", '{"request_token":"rt-ok"}', [full]),
    post("/api/session", '{"request_token":', [full]),
  ],
});

scenarios.push({
  name: "kite callback",
  world: baseWorld({
    config: { frontendUrl: "https://front.example/app", internalSecret: "int-secret", tokenSecret: "route-pass" },
    kite: {
      apiKey: "kite_api_key",
      token: null,
      loginUrl: "https://kite.zerodha.com/connect/login?api_key=kite_api_key&v=3",
      sessions: { "rt-ok": SESSION_OK, "rt-403": { kiteError: { message: "Token is invalid or has expired.", status: 403 } } },
      profile: { data: {} },
    },
  }),
  steps: [
    { op: "now", ms: T0 },
    get("/callback"),
    get("/callback?status=success"),
    get("/callback?request_token=rt-ok"),
    get("/callback?request_token=rt-ok&status=failure"),
    get("/callback?request_token=rt-ok&status=success&status=success"),
    get("/callback?request_token=rt-403&status=success"),
    get("/callback?request_token=rt-ok&status=success"),
    get("/callback?request_token=rt-ok&status=success", [["Accept", "text/html"]]),
    get("/callback?status=success&request_token=rt%2Dok", [["Accept", "application/json"]]),
  ],
});

scenarios.push({
  name: "logout and access token",
  world: baseWorld({ db: { kiteSession: { access_token: "t", user_id: "u", user_name: "n", login_date: "2026-10-27" }, loadError: null, clearError: null } }),
  steps: [
    { op: "now", ms: T0 },
    get("/api/kite/access-token", [full]),
    { op: "set", path: "kite.token", value: "access-live" },
    get("/api/kite/access-token"),
    get("/api/kite/access-token", [trade]),
    get("/api/kite/access-token", [full]),
    { op: "now", ms: RealDate.UTC(2026, 9, 27, 18, 30, 0) },
    get("/api/kite/access-token", [full]),
    { op: "req", method: "POST", path: "/api/logout", headers: [trade] },
    { op: "req", method: "POST", path: "/api/logout", headers: [full] },
    get("/api/kite/access-token", [full]),
    { op: "req", method: "POST", path: "/api/logout", headers: [full] },
  ],
});

scenarios.push({
  name: "profile",
  world: baseWorld({
    kite: {
      apiKey: "kite_api_key",
      token: null,
      loginUrl: "",
      sessions: {},
      profile: {
        data: {
          user_id: "AB1234",
          user_type: "individual",
          email: "trader@example.com",
          user_name: "Trader One",
          exchanges: ["NSE", "NFO", "BSE"],
          meta: { demat_consent: "consent", nested: { "2": "b", "1": "a", z: [1.5, -0, 1e21, 1e-7] } },
          avatar_url: null,
          broker: "ZERODHA",
        },
      },
    },
  }),
  steps: [
    { op: "now", ms: T0 },
    get("/api/profile"),
    { op: "set", path: "kite.token", value: "tok" },
    get("/api/profile"),
    { op: "set", path: "kite.profile", value: { kiteError: { message: "Incorrect `api_key` or `access_token`.", status: 403 } } },
    get("/api/profile"),
    { op: "set", path: "kite.token", value: "tok" },
    { op: "set", path: "kite.profile", value: { kiteError: { message: "Gateway timeout", status: 504 } } },
    get("/api/profile"),
    { op: "set", path: "kite.profile", value: { kiteError: { message: "Kite said no", status: 200 } } },
    get("/api/profile"),
    { op: "set", path: "kite.profile", value: { error: "fetch failed" } },
    get("/api/profile"),
  ],
});

scenarios.push({
  name: "instruments and fno stocks",
  world: baseWorld(),
  steps: [
    { op: "now", ms: T0 },
    { op: "board" },
    get("/api/instruments"),
    get("/api/instruments?exchange=NFO&type=FUT&q=nifty"),
    get("/api/instruments?exchange=&type=&q=bank"),
    get("/api/instruments?exchange=BSE"),
    get("/api/instruments?type=&q=%20M%26M%20"),
    get("/api/instruments?exchange=NSE&exchange=NFO"),
    get("/api/instruments?q=IN&q=FY"),
    get("/api/instruments?type=INDEX&exchange=NSE"),
    get("/api/fno-stocks"),
    get("/api/fno-stocks?q=bajaj"),
    get("/api/fno-stocks?q=%26"),
    get("/api/fno-stocks?q=zzz"),
    get("/api/fno-stocks/reliance"),
    get("/api/fno-stocks/TCS"),
    get("/api/fno-stocks/M%26M"),
    get("/api/fno-stocks/M&M"),
    get("/api/fno-stocks/INFY"),
    get("/api/fno-stocks/NIFTY"),
    get("/api/fno-stocks/UNKNOWN"),
    get("/api/fno-stocks/%FF"),
    get("/api/fno-stocks/TCS/"),
    { op: "set", path: "instruments", value: { kiteError: { message: "Instruments forbidden", status: 403 } } },
    { op: "set", path: "kite.token", value: "tok" },
    get("/api/instruments"),
    get("/api/fno-stocks"),
    { op: "set", path: "instruments", value: { error: "socket hang up" } },
    get("/api/fno-stocks/TCS"),
    get("/api/fno-board"),
    get("/api/debug/indices"),
  ],
});

scenarios.push({
  name: "board and debug indices",
  world: baseWorld(),
  steps: [
    { op: "now", ms: T0 },
    get("/api/fno-board"),
    get("/api/fno-board?q=nifty"),
    get("/api/fno-board?q=NIFTY%2050"),
    get("/api/fno-board?q=%20aDaNi%20"),
    get("/api/fno-board?q=zzz"),
    get("/api/debug/indices"),
    { op: "set", path: "instruments", value: dhanDump() },
    { op: "board" },
    get("/api/fno-board"),
    get("/api/debug/indices"),
    { op: "set", path: "instruments", value: [] },
    get("/api/fno-board"),
    get("/api/debug/indices"),
  ],
});

scenarios.push({
  name: "realistic board",
  world: baseWorld({ instruments: realisticDump(), yields: { "360ONE": 0.31, "M&M": 0.83, "BAJAJ-AUTO": 2.2 } }),
  steps: [
    { op: "now", ms: T0 },
    { op: "board" },
    get("/api/fno-board"),
    get("/api/fno-board?q=tata"),
    get("/api/fno-stocks"),
    get("/api/fno-stocks?q=%26"),
    get("/api/fno-stocks/J%26KBANK"),
    get("/api/fno-stocks/360one"),
    get("/api/fno-stocks/ABB"),
    get("/api/instruments?exchange=NFO&type=FUT&q=bajaj"),
    get("/api/instruments?exchange=NSE&type=EQ&q=limited&q=x"),
    get("/api/debug/indices"),
    get("/api/dividends"),
  ],
});

scenarios.push({
  name: "dividends",
  world: baseWorld({ yields: { RELIANCE: 0.38, TCS: 1.62, "M&M": 0.83, HDFCBANK: 1.07, INFY: 2.71 } }),
  steps: [
    { op: "now", ms: T0 },
    get("/api/dividends"),
    { op: "now", ms: T0 + 5_000 },
    get("/api/dividends"),
    { op: "now", ms: T0 + DAY - 1 },
    get("/api/dividends"),
    { op: "set", path: "yields", value: { RELIANCE: 0.4 } },
    { op: "now", ms: T0 + DAY },
    get("/api/dividends"),
    { op: "set", path: "instruments", value: { kiteError: { message: "Session expired", status: 401 } } },
    { op: "now", ms: T0 + 3 * DAY },
    { op: "set", path: "kite.token", value: "tok" },
    get("/api/dividends"),
  ],
});

scenarios.push({
  name: "spread stats",
  world: baseWorld({
    spread: {
      RELIANCE: {
        _id: "65f1c2d3e4f5a6b7c8d9e0f1",
        symbol: "RELIANCE",
        observations: 412,
        first_date: "2024-10-28T00:00:00.000Z",
        last_date: "2026-10-26T00:00:00.000Z",
        mean_spread: 12.3456,
        max_spread: 48.5,
        min_spread: -3.25,
        mean_deviation: 4.1,
        max_abs_spread: 48.5,
        std_dev_spread: 5.6789,
        percentile_95: 22.15,
        mean_reversion_probability: 0.8125,
      },
      "M&M": {
        _id: "65f1c2d3e4f5a6b7c8d9e0f2",
        symbol: "M&M",
        observations: 3,
        first_date: "2026-10-22T00:00:00.000Z",
        last_date: "2026-10-26T00:00:00.000Z",
        mean_spread: 0,
        max_spread: 0,
        min_spread: 0,
        mean_deviation: 0,
        max_abs_spread: 0,
        std_dev_spread: 0,
        percentile_95: 0,
        mean_reversion_probability: 0,
      },
      BROKEN: { error: "connection terminated unexpectedly" },
    },
  }),
  steps: [
    { op: "now", ms: T0 },
    get("/api/spread-stats/reliance"),
    get("/api/spread-stats/M%26M"),
    get("/api/spread-stats/TCS"),
    get("/api/spread-stats/broken"),
  ],
});

// History: tokens are the board futures of RELIANCE (13000000 + 7*m), INFY (22000000 + 7*m),
// NIFTY (20000000 + 7*m) and TCS.
const R = (m) => 13_000_000 + m * 7;
const N = (m) => 20_000_000 + m * 7;
const I = (m) => 22_000_000 + m * 7;
const oiRows = (base) => [
  { date: "2026-10-23", close: base + 0.05, oi: 1_000_000 },
  { date: "2026-10-26", close: base + 1.15, oi: 1_050_500 },
];
const candle = (t, close) => ({ t, close });
scenarios.push({
  name: "history routes",
  world: baseWorld({
    history: {
      [R(0)]: {
        oi: oiRows(2900),
        day: [candle("2026-10-21T00:00:00+0530", 2900.1), candle("2026-10-22T00:00:00+0530", 2901.35), candle("2026-10-23T00:00:00+0530", 2899.9), candle("2026-10-23T09:15:00+0530", 2898.4)],
        "60minute": [candle("2026-10-26T09:15:00+0530", 2905.5), candle("2026-10-26T10:15:00+0530", 2906.25)],
        minute: [candle("2026-10-27T11:28:00+0530", 2910), candle("2026-10-27T11:29:00+0530", 2910.45)],
        "5minute": [candle("2026-10-27T09:15:00+0530", 2903.3)],
      },
      [R(1)]: {
        oi: oiRows(2920),
        day: [candle("2026-10-20T00:00:00+0530", 2915), candle("2026-10-22T00:00:00+0530", 2921.6), candle("2026-10-23T00:00:00+0530", 2919.95), candle("2026-10-21T00:00:00+0530", 2918.333)],
        "60minute": [],
      },
      [R(2)]: {
        oi: [],
        day: [candle("2026-10-22T00:00:00+0530", 2940.105), candle("2026-10-24T00:00:00+0530", 2950), candle("2026-10-20T00:00:00+0530", "NaN")],
      },
      [I(0)]: { oi: { kiteError: { message: "Insufficient permission for that call.", status: 403 } } },
      [N(0)]: { day: [candle("2026-10-21T00:00:00+0530", 25000)], oi: oiRows(25000) },
      [N(1)]: { day: [candle("2026-10-22T00:00:00+0530", 25100)] },
      [N(2)]: { day: { error: "upstream exploded" } },
    },
  }),
  steps: [
    { op: "tz", tz: "UTC" },
    { op: "now", ms: T0 },
    get("/api/history/RELIANCE"),
    get("/api/spread-history/RELIANCE"),
    get("/api/intraday/RELIANCE"),
    get("/api/minute/RELIANCE"),
    get("/api/fivemin/RELIANCE"),
    {
      op: "set",
      path: "broker",
      value: {
        active: "dhan",
        health: { authenticated: false, data_ready: false, trading_ready: false, problems: ["Dhan is not connected"] },
        feed: { connected: false, state: "DOWN" },
        generation: 4,
      },
    },
    get("/api/history/RELIANCE"),
    { op: "set", path: "broker", value: ZERODHA_UP },
    get("/api/history/reliance"),
    get("/api/history/RELIANCE"),
    get("/api/spread-history/RELIANCE"),
    get("/api/intraday/RELIANCE"),
    get("/api/minute/RELIANCE"),
    get("/api/fivemin/RELIANCE"),
    { op: "set", path: "broker", value: ZERODHA_DOWN },
    get("/api/history/RELIANCE"),
    get("/api/minute/RELIANCE"),
    { op: "set", path: "broker", value: ZERODHA_UP },
    get("/api/history/UNKNOWN"),
    get("/api/history/%FF"),
    get("/api/spread-history/NIFTY"),
    get("/api/spread-history/TCS"),
    get("/api/intraday/NIFTY"),
    { op: "now", ms: T0 + 59_999 },
    get("/api/minute/RELIANCE"),
    { op: "now", ms: T0 + 60_000 },
    get("/api/minute/RELIANCE"),
    { op: "now", ms: T0 + 299_999 },
    get("/api/fivemin/RELIANCE"),
    { op: "now", ms: T0 + 300_000 },
    get("/api/fivemin/RELIANCE"),
    { op: "now", ms: RealDate.UTC(2026, 9, 27, 18, 29, 59, 999) },
    get("/api/history/RELIANCE"),
    { op: "now", ms: RealDate.UTC(2026, 9, 27, 18, 30, 0) },
    get("/api/history/RELIANCE"),
    get("/api/spread-history/RELIANCE"),
    get("/api/intraday/RELIANCE"),
    { op: "set", path: "kite.token", value: "tok" },
    get("/api/history/INFY"),
    get("/api/intraday/INFY"),
  ],
});

// Local-time Date arithmetic under two zones: setMonth(-3) from 31 May, setFullYear(-2)
// from 29 February, setDate(-7) across a month boundary.
for (const tz of ["UTC", "Asia/Kolkata"]) {
  scenarios.push({
    name: `history dates ${tz}`,
    world: baseWorld({ broker: structuredClone(ZERODHA_UP) }),
    steps: [
      { op: "tz", tz },
      { op: "now", ms: RealDate.UTC(2026, 4, 31, 20, 0, 0) },
      get("/api/history/TCS"),
      get("/api/spread-history/TCS"),
      get("/api/intraday/TCS"),
      get("/api/minute/TCS"),
      get("/api/fivemin/TCS"),
      { op: "now", ms: RealDate.UTC(2028, 1, 29, 21, 0, 0) },
      get("/api/history/HDFCBANK"),
      get("/api/spread-history/HDFCBANK"),
      get("/api/intraday/HDFCBANK"),
      { op: "now", ms: RealDate.UTC(2026, 2, 3, 18, 45, 0) },
      get("/api/history/LT"),
      get("/api/spread-history/LT"),
      get("/api/intraday/LT"),
      get("/api/minute/LT"),
      get("/api/fivemin/LT"),
      { op: "tz", tz: "UTC" },
    ],
  });
}

scenarios.push({
  name: "restore kite session",
  world: baseWorld({ db: { kiteSession: { access_token: "persisted-1", user_id: "AB1234", user_name: "Trader One", login_date: "2026-10-27" }, loadError: null, clearError: null } }),
  steps: [
    { op: "now", ms: T0 },
    { op: "restore" },
    { op: "set", path: "kite.token", value: null },
    { op: "now", ms: RealDate.UTC(2026, 9, 27, 18, 30, 0) },
    { op: "restore" },
    { op: "restore" },
    { op: "set", path: "db.kiteSession", value: { access_token: "persisted-2", user_id: "", user_name: "", login_date: "2026-10-28" } },
    { op: "restore" },
    { op: "set", path: "kite.token", value: null },
    { op: "set", path: "db.loadError", value: "connection refused" },
    { op: "restore" },
    { op: "set", path: "db.loadError", value: null },
    { op: "set", path: "db.clearError", value: "read only" },
    { op: "set", path: "db.kiteSession", value: { access_token: "persisted-3", user_id: "u", user_name: "n", login_date: "2026-01-01" } },
    { op: "restore" },
  ],
});

const out = [];
for (const sc of scenarios) out.push(await runScenario(sc));
process.env.TZ = "UTC";
fs.writeFileSync(path.join(here, "core.golden.json"), JSON.stringify({ scenarios: out }, null, 1) + "\n");

// --- library cases ---------------------------------------------------------------------
const queries = [
  "", "a=1", "a=1&a=2&a=3", "a", "a=", "=x", "=", "&", "&&a=1&&", "a=1&b", "a=b=c", "+a+=+b+",
  "q=%20M%26M%20", "q=%zz", "q=%4", "q=%", "q=%E0%A4", "q=%E0%A4%A", "q=%ED%A0%80", "q=%F0%9F%98%80", "q=%C3%A9+%C3",
  "x%2Dadmin%2Dtoken=abc", "x-admin-token=a&x-admin-token=", "q=a;b", "q=%2B+", "k%=v%", "a=%41%zz%42",
  "q=%f0%9f%98", "q=%80", "q=%C0%AF", "q=%EF%BB%BFx", "semi;colon=1", "%=%", "q=%FF%FE", "a[b]=1&a[c]=2",
  Array.from({ length: 1005 }, (_, i) => `k${i}=${i}`).join("&"),
  "&".repeat(999) + "a=1",
  "&".repeat(1000) + "a=1",
];
const urls = [
  "https://kite.zerodha.com/connect/login?api_key=kite_api_key&v=3",
  "http://localhost:5173/?auth=success",
  'https://x.example/a b"<>`{}|\\^~[]',
  "https://x.example/%", "https://x.example/%4", "https://x.example/%41", "https://x.example/%zz", "https://x.example/%4z",
  "https://x.example/%%41", "https://x.example/%4%41", "https://x.example/é ü 😀", "https://x.example/\u0000\u001f\u007f",
  "https://x.example/%E2%82%AC/€", "https://x.example/?q=a+b&r=c%20d#frag ment", "%", "%%", "%a", "a%", "%é", "%4é",
];
const acceptHeaders = [
  undefined, "", "*/*", "text/html", "text/plain", "application/json", "text/*", "text/html;q=0.5, text/plain;q=0.9",
  "text/plain;q=0.5, text/html;q=0.5", "text/html, text/plain", "text/plain, text/html", "*/*;q=0", "text/html;q=0",
  "text/html;level=1", "text/html;level=1, text/plain;q=0.1", "text/*;q=0.3, text/html;q=0.7, text/html;level=1",
  "application/xml, */*;q=0.1", "TEXT/HTML", "text/html;charset=utf-8", "text/html;charset=*", 'text/html;foo="a,b", text/plain;q=0.2',
  "text/html;q=abc", "text/html;q=", "text/html;q=0.5;q=0.9", "text/html; q=0.4 , text/plain ; q = 0.3", ",text/html", "text/html,",
  "garbage", "text", "/html", "text/", "text/html;=x", "text/html;q", "*/*;q=0.5, text/html;q=0", "text/plain;q=1.5, text/html;q=2",
  "text/html;q=1e-1, text/plain;q=.05", "text/html;q=-1", 'text/html;q="0.2", text/plain;q="0.3"', "text/html;q=0.5x",
  "\ttext/html ;\tq=0.6", "text/html;level=\"1\";q=0.9, text/plain;q=0.8", "image/png, application/*",
];
const library = {
  queries: queries.map((q) => ({ q, parsed: querystring.parse(q) })),
  encodeUrl: urls.map((u) => ({ in: u, out: encodeUrl(u) })),
  escapeHtml: urls.map((u) => ({ in: u, out: escapeHtml(u) })),
  accepts: acceptHeaders.map((h) => ({
    accept: h ?? null,
    result: accepts({ headers: h === undefined ? {} : { accept: h } }).types(["text", "html"]) || "",
  })),
  decodeParam: ["M%26M", "BAJAJ%2DAUTO", "%E2%82%AC", "a+b", "%2F", "%FF", "%E0%A4"].map((p) => {
    try {
      return { raw: p, ok: true, value: decodeURIComponent(p) };
    } catch {
      return { raw: p, ok: false };
    }
  }),
};
fs.writeFileSync(path.join(here, "express.golden.json"), JSON.stringify(library, null, 1) + "\n");
fs.rmSync(modFile, { force: true });
console.log(`core.golden.json: ${out.length} scenarios, ${out.reduce((n, s) => n + s.steps.length, 0)} steps; express.golden.json written`);
