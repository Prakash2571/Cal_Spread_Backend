// Golden generator for internal/marketdata's routes: the ORIGINAL src/marketDataRoutes.ts
// (registerMarketDataRoutes) driven through a fake Express app with fake req/res objects
// and fake broker deps, but with the REAL MarketDataSessionStore, BoundedTtlCache (inside
// the route module) and TickerHub. Run from the repository root:
//
//   scratch/go-migration/check.sh node internal/marketdata/testdata/gen_routes.mjs
//
// It writes internal/marketdata/testdata/routes.golden.json, which routes_golden_test.go
// replays against the Go routes over real HTTP (server.New + Mount + the Go hub).
//
// src/index.ts cannot be imported (top-level side effects), so getAdminRole,
// requireFullAdmin and sendError are copied VERBATIM out of it into
// scratch/go-migration/tmp/mdroutes/index_fns.ts with their module-level collaborators
// (kite.clearSession, clearKiteSession, deleteAdminSession, the session map) stubbed.
// KiteError is the real class from src/kite.ts. Nothing under src/ is modified.
//
// The script re-launches itself under --experimental-transform-types (hub.ts uses
// constructor parameter properties) and registers ts_hooks.mjs, which maps the sources'
// "./x.js" imports onto "./x.ts". fetch and WebSocket are replaced by fakes, Date.now and
// setInterval/clearInterval by controllable ones, so nothing reaches a network and every
// run writes a byte-identical file. Session ids are random; they are recorded as <sN>
// placeholders (N = creation order).
//
// Per step the golden records: the response status and exact JSON body text; for an SSE
// response the headers set (in order) and flushHeaders; every SSE frame each open stream
// received; every call the route made to its deps, in order ("events"); the session
// store's stats; and how often the hub's onDead ran.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import querystring from "node:querystring";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.execArgv.includes("--experimental-transform-types")) {
  const r = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  process.exit(r.status ?? 1);
}
register(new URL("./ts_hooks.mjs", import.meta.url).href);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const srcDir = path.join(repoRoot, "src");
const tmpDir = path.join(repoRoot, "scratch/go-migration/tmp/mdroutes");
const srcURL = (rel) => pathToFileURL(path.join(srcDir, rel)).href;
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

// ---------------------------------------------------------------------------------------
// Nothing may reach a network; time and intervals are ours.

globalThis.fetch = async () => {
  throw new Error("gen_routes: network access is disabled");
};
class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closes = 0;
    FakeWebSocket.instances.push(this);
  }
  send(payload) { this.sent.push(payload); }
  close() { this.closes++; }
}
globalThis.WebSocket = FakeWebSocket;

const START = 1_790_000_000_000;
let clock = START;
Date.now = () => clock;

// The reference logs every quote and stream; keep the terminal readable. (Errors thrown
// by this script are printed by Node itself, not through console.)
const print = console.log.bind(console);
console.log = console.info = console.warn = console.error = () => {};

let intervals = [];
let currentLog = null;
globalThis.setInterval = (fn, ms) => {
  const handle = { fn, ms, cleared: false };
  intervals.push(handle);
  currentLog?.push(`interval ${ms}`);
  return handle;
};
globalThis.clearInterval = (handle) => {
  if (handle) handle.cleared = true;
  currentLog?.push("clearInterval");
};

// ---------------------------------------------------------------------------------------
// index.ts functions, copied verbatim.

const indexText = fs.readFileSync(path.join(srcDir, "index.ts"), "utf8");
function extractFunction(name) {
  const sig = `function ${name}(`;
  const start = indexText.indexOf(sig);
  if (start < 0 || indexText.indexOf(sig, start + 1) >= 0) {
    throw new Error(`gen_routes: expected exactly one "${sig}" in src/index.ts`);
  }
  let depth = 0;
  for (let i = indexText.indexOf("{", start); i < indexText.length; i++) {
    if (indexText[i] === "{") depth++;
    else if (indexText[i] === "}" && --depth === 0) return indexText.slice(start, i + 1);
  }
  throw new Error(`gen_routes: unbalanced braces in ${name}`);
}
const copied = ["getAdminRole", "requireFullAdmin", "sendError"].map(extractFunction);
const fnsText = [
  "// Written by internal/marketdata/testdata/gen_routes.mjs: three functions copied verbatim",
  "// from src/index.ts, with their module-level collaborators stubbed. Regenerated on every run.",
  `import { KiteError } from ${JSON.stringify(srcURL("kite.ts"))};`,
  "export const calls = { clearSession: 0, clearKiteSession: 0, deleteAdminSession: 0 };",
  "const kite = { clearSession(): void { calls.clearSession++; } };",
  "async function clearKiteSession(): Promise<void> { calls.clearKiteSession++; }",
  "async function deleteAdminSession(_token: string): Promise<void> { calls.deleteAdminSession++; }",
  'type AdminRole = "full" | "trade";',
  "export const adminSessions = new Map<string, { expiry: number; role: AdminRole }>();",
  ...copied,
  "export { getAdminRole, requireFullAdmin, sendError };",
].join("\n\n") + "\n";
fs.mkdirSync(tmpDir, { recursive: true });
const fnsFile = path.join(tmpDir, "index_fns.ts");
fs.writeFileSync(fnsFile, fnsText);
const fns = await import(pathToFileURL(fnsFile).href);

const { registerMarketDataRoutes } = await import(srcURL("marketDataRoutes.ts"));
const { MarketDataSessionStore } = await import(srcURL("marketDataSession.ts"));
const { TickerHub } = await import(srcURL("hub.ts"));
const { computeFeedHealth } = await import(srcURL("brokers/feedHealth.ts"));
const { KiteError } = await import(srcURL("kite.ts"));

const ROUTES = [
  "POST /api/quotes",
  "GET /api/quotes",
  "POST /api/stream/session",
  "GET /api/stream/session/:id",
  "GET /api/stream",
  "GET /api/market-data/status",
  "GET /api/market-data/diagnostics",
];

// ---------------------------------------------------------------------------------------
// Fake Express request/response.

function makeReq(op, id) {
  const listeners = {};
  return {
    method: op.method,
    // express.json(): undefined without a JSON body.
    body: op.body === undefined ? undefined : JSON.parse(op.body),
    // Express 5's "simple" query parser is node:querystring's parse.
    query: querystring.parse(op.query ?? ""),
    params: id === undefined ? {} : { id },
    headers: Object.fromEntries(Object.entries(op.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    listeners,
    on(event, fn) { (listeners[event] ??= []).push(fn); return this; },
  };
}

function makeRes(log) {
  const listeners = {};
  return {
    statusCode: 200,
    headers: [],
    frames: [],
    body: undefined,
    flushed: false,
    listeners,
    get sse() {
      return this.headers.some(([k, v]) => k.toLowerCase() === "content-type" && v === "text/event-stream");
    },
    status(code) { this.statusCode = code; return this; },
    json(value) {
      if (this.body !== undefined) throw new Error("gen_routes: res.json called twice");
      this.body = JSON.stringify(value); // Express 5 res.json: JSON.stringify, no replacer/spaces
      return this;
    },
    setHeader(name, value) { this.headers.push([name, value]); return this; },
    flushHeaders() { this.flushed = true; },
    write(chunk) { this.frames.push(String(chunk)); return true; },
    end() { log.push("end"); return this; },
    on(event, fn) { (listeners[event] ??= []).push(fn); return this; },
  };
}

// ---------------------------------------------------------------------------------------
// Scenario runner.

const scenarios = [];

async function run(name, initial, ops) {
  clock = START;
  intervals = [];
  FakeWebSocket.instances.length = 0;
  const st = structuredClone(initial);
  const log = [];
  currentLog = log;
  const ids = []; // session index -> id
  const placeholder = (id) => {
    const i = ids.indexOf(id);
    return i >= 0 ? `<s${i}>` : id;
  };
  const labelOf = (context) => {
    const m = /^session ([0-9a-f]{8})…$/.exec(context);
    if (!m) return context;
    const i = ids.findIndex((id) => id.startsWith(m[1]));
    return i >= 0 ? `session <s${i}>…` : context;
  };
  const substIds = (text) => ids.reduce((t, id, i) => t.split(JSON.stringify(id)).join(JSON.stringify(`<s${i}>`)), text);

  const brokerManager = {
    get activeBroker() { return st.broker; },
    get generation() { return st.generation; },
    activeHealth() { return { broker: st.broker, data_ready: st.dataReady, problems: st.problems }; },
    assertActiveBrokerToken(token, context) {
      const ctx = labelOf(context);
      const last = log[log.length - 1];
      if (last && typeof last === "object" && last.ctx === ctx) last.tokens.push(token);
      else log.push({ ctx, tokens: [token] });
      return st.owned === null ? true : st.owned.includes(token);
    },
    quoteProvider: {
      async quotesByToken(tokens) {
        log.push(`quotes ${JSON.stringify(tokens)}`);
        const e = st.quoteError;
        if (e) throw e.kind === "kite" ? new KiteError(e.message, e.status) : new Error(e.message);
        return tokens.filter((t) => st.quotes[t] !== undefined).map((t) => st.quotes[t]);
      },
    },
    acquireBrowserTokens(tokens) {
      log.push(`acquire ${JSON.stringify(tokens)}`);
      return () => log.push("release");
    },
    feedHealth: () => st.feed,
    subscriptions: { stats: () => st.subs },
    boxSubscriptions: { stats: () => st.boxSubs },
    upstreamFeedStats: () => st.upstream,
    laneStats: (lane) => st.lanes[lane],
  };

  let dead = 0;
  const realHub = new TickerHub(() => ({ apiKey: "api-key", accessToken: "access-token" }), () => { dead++; });
  const tickerHub = {
    seed(ticks) {
      log.push(`seed ${JSON.stringify(ticks)}`);
      realHub.seed(ticks);
    },
    attachClient(res, tokens) {
      log.push(`attach ${JSON.stringify(tokens)}`);
      const detach = realHub.attachClient(res, tokens);
      return () => {
        log.push("detach");
        detach();
      };
    },
  };

  const realStore = new MarketDataSessionStore({ now: () => clock });
  const sessions = {
    create(tokens, broker, generation) {
      const s = realStore.create(tokens, broker, generation);
      if (!/^[0-9a-f]{32}$/.test(s.id)) throw new Error(`gen_routes: bad session id ${s.id}`);
      ids.push(s.id);
      log.push(`create ${JSON.stringify(tokens)} ${broker} ${generation} -> <s${ids.length - 1}>`);
      return s;
    },
    resolve(id, broker, generation) {
      const r = realStore.resolve(id, broker, generation);
      log.push(`resolve ${placeholder(id)} ${broker} ${generation} -> ${r.ok ? "ok" : r.reason}`);
      return r;
    },
    open(id) { log.push(`open ${placeholder(id)}`); realStore.open(id); },
    close(id) { log.push(`close ${placeholder(id)}`); realStore.close(id); },
    stats() { return realStore.stats(); },
  };

  const boardSize = async () => {
    log.push("boardSize");
    if (st.boardSize !== null && typeof st.boardSize === "object") throw new Error(st.boardSize.throw);
    return st.boardSize;
  };

  fns.adminSessions.clear();
  fns.adminSessions.set("full-token", { expiry: START + 86_400_000, role: "full" });
  fns.adminSessions.set("trade-token", { expiry: START + 86_400_000, role: "trade" });
  fns.adminSessions.set("old-token", { expiry: START - 1, role: "full" });
  fns.calls.clearSession = fns.calls.clearKiteSession = 0;

  const routes = {};
  const app = {
    get: (p, ...handlers) => { routes[`GET ${p}`] = handlers; },
    post: (p, ...handlers) => { routes[`POST ${p}`] = handlers; },
  };
  registerMarketDataRoutes(app, {
    brokerManager,
    tickerHub,
    sessions,
    requireFullAdmin: fns.requireFullAdmin,
    sendError: fns.sendError,
    boardSize,
  });
  if (JSON.stringify(Object.keys(routes)) !== JSON.stringify(ROUTES)) {
    throw new Error(`gen_routes: registered ${JSON.stringify(Object.keys(routes))}`);
  }

  const streams = {};
  const frameMarks = {};
  const steps = [];
  for (const op of ops) {
    const step = { op };
    switch (op.op) {
      case "request": {
        const id = op.session !== undefined ? ids[op.session] : op.id;
        if (op.session !== undefined && id === undefined) throw new Error(`${name}: no session ${op.session}`);
        const req = makeReq(op, id);
        const res = makeRes(log);
        const handlers = routes[`${op.method} ${op.path}`];
        if (!handlers) throw new Error(`${name}: no route ${op.method} ${op.path}`);
        const before = intervals.length;
        // Express-style chain; a middleware that calls next() without returning its promise
        // (requireFullAdmin) is covered by awaiting every handler's promise.
        const pending = [];
        let i = 0;
        const next = () => {
          const h = handlers[i++];
          if (!h) return undefined;
          const p = Promise.resolve(h(req, res, next));
          pending.push(p);
          return p;
        };
        next();
        for (let k = 0; k < pending.length; k++) await pending[k];
        await new Promise((resolve) => setImmediate(resolve));
        step.status = res.statusCode;
        if (res.body !== undefined) step.body = substIds(res.body);
        if (res.sse) {
          step.sse = true;
          step.headers = res.headers;
          step.flushed = res.flushed;
        }
        if (op.stream !== undefined) {
          if (!res.sse) throw new Error(`${name}: ${op.method} ${op.path} did not open a stream (${res.statusCode} ${res.body})`);
          streams[op.stream] = { req, res, interval: intervals[before] };
        } else if (res.sse) {
          throw new Error(`${name}: unexpected stream from ${op.method} ${op.path}`);
        }
        break;
      }
      case "seed": realHub.seed(op.ticks); break;
      case "ingest": realHub.ingestExternalTicks(op.ticks); break;
      case "hubSocket": realHub.subscribeTokens(op.tokens); break;
      case "socketError": FakeWebSocket.instances.at(-1).onerror?.(); break;
      case "ping": {
        const s = streams[op.stream];
        if (!s?.interval || s.interval.cleared) throw new Error(`${name}: stream ${op.stream} has no live keep-alive`);
        s.interval.fn();
        break;
      }
      case "disconnect": {
        // `req` and `res` both emit close, as Node does when a browser goes away.
        const s = streams[op.stream];
        for (const fn of s.req.listeners.close ?? []) fn();
        for (const fn of s.res.listeners.close ?? []) fn();
        break;
      }
      case "advance": clock += op.ms; break;
      case "state": Object.assign(st, structuredClone(op.set)); break;
      default: throw new Error(`${name}: unknown op ${op.op}`);
    }
    step.events = log.splice(0).map((e) => (typeof e === "string" ? e : `assert ${e.ctx} ${JSON.stringify(e.tokens)}`));
    const frames = {};
    for (const [n, s] of Object.entries(streams)) {
      const from = frameMarks[n] ?? 0;
      if (s.res.frames.length > from) frames[n] = s.res.frames.slice(from);
      frameMarks[n] = s.res.frames.length;
    }
    if (Object.keys(frames).length > 0) step.frames = frames;
    step.sessions = realStore.stats();
    if (dead > 0) {
      step.dead = dead;
      dead = 0;
    }
    if (fns.calls.clearSession !== fns.calls.clearKiteSession) throw new Error(`${name}: sendError cleared memory and store unevenly`);
    if (fns.calls.clearSession > 0) {
      step.clearSession = fns.calls.clearSession;
      fns.calls.clearSession = fns.calls.clearKiteSession = 0;
    }
    steps.push(step);
  }
  currentLog = null;
  scenarios.push({ name, start: START, state: initial, steps });
}

// ---------------------------------------------------------------------------------------
// Fixtures.

const subs = (lane, browser = 0, scanner = 0, strategy = 0, analytics = 0, tokens = 0, leases = 0) =>
  ({ browser, scanner, strategy, analytics, tokens, leases, lane });
const laneStats = (lane, connected, subscribedTokens, wantedTokens, ticksPerSecond, lastTickAgeMs, reconnects, generation) =>
  ({ lane, connected, subscribedTokens, wantedTokens, ticksPerSecond, lastTickAgeMs, reconnects, generation });
const upstreamOf = (broker, wanted, subscribed, socketConnected, lastTickAt) =>
  ({ broker, wanted, subscribed, socket_connected: socketConnected, last_tick_at: lastTickAt });
const feedOf = (input) => computeFeedHealth({ now: START, ...input });

const kt = (token, ltp, close, oi) => ({ token, last_price: ltp, close_price: close, oi, bid: 0, ask: 0 });
const lv = (price, qty, orders) => ({ price, qty, orders });
const dt = (token, ltp, close, oi, bid, ask, bids, asks) => {
  const t = { token, last_price: ltp, close_price: close, oi, bid, ask };
  if (bids !== undefined) t.bids = bids;
  if (asks !== undefined) t.asks = asks;
  return t;
};
const table = (...ticks) => Object.fromEntries(ticks.map((t) => [t.token, t]));
const range = (from, n) => Array.from({ length: n }, (_, i) => from + i);

const base = {
  broker: "zerodha",
  generation: 1,
  dataReady: true,
  problems: [],
  owned: null,
  quotes: {},
  quoteError: null,
  feed: feedOf({ connected: false, authenticated: true, subscribed: 0, universe: null, lastTickAt: null }),
  subs: subs("futures"),
  boxSubs: subs("box"),
  upstream: upstreamOf("zerodha", 0, 0, false, null),
  lanes: { futures: laneStats("futures", false, 0, 0, 0, null, 0, 1), box: laneStats("box", false, 0, 0, 0, null, 0, 1) },
  boardSize: null,
};
const withState = (patch) => ({ ...structuredClone(base), ...structuredClone(patch) });

const req = (method, p, extra = {}) => ({ op: "request", method, path: p, ...extra });
const postJSON = (p, body, extra = {}) => req("POST", p, { body: typeof body === "string" ? body : JSON.stringify(body), ...extra });
const quotesPost = (tokens) => postJSON("/api/quotes", { tokens });
const quotesGet = (query) => req("GET", "/api/quotes", query === undefined ? {} : { query });
const sessionPost = (tokens) => postJSON("/api/stream/session", { tokens });
const sessionGet = (session, stream) => req("GET", "/api/stream/session/:id", { session, ...(stream === undefined ? {} : { stream }) });
const legacyGet = (query, stream) => req("GET", "/api/stream", { ...(query === undefined ? {} : { query }), ...(stream === undefined ? {} : { stream }) });
const status = () => req("GET", "/api/market-data/status");
const diag = (token) => req("GET", "/api/market-data/diagnostics", token === undefined ? {} : { headers: { "x-admin-token": token } });
const state = (set) => ({ op: "state", set });
const advance = (ms) => ({ op: "advance", ms });

// ---------------------------------------------------------------------------------------
// Scenarios.

await run("POST /api/quotes validation", withState({ quotes: table(kt(1, 101.5, 100, 0), kt(100, 7, 6.5, 1500)) }), [
  req("POST", "/api/quotes"),
  postJSON("/api/quotes", "{}"),
  postJSON("/api/quotes", "[1,2]"),
  postJSON("/api/quotes", { tokens: "1,2" }),
  postJSON("/api/quotes", { tokens: null }),
  postJSON("/api/quotes", { tokens: { 0: 1 } }),
  quotesPost([]),
  quotesPost([1, "2"]),
  quotesPost([1.5]),
  quotesPost([0]),
  quotesPost([-3]),
  postJSON("/api/quotes", '{"tokens":[-0]}'),
  quotesPost([null]),
  quotesPost([true]),
  quotesPost([{}]),
  quotesPost([[1]]),
  quotesPost([1, 2, 1.000001]),
  quotesPost(range(1, 4001)),
  quotesPost(range(1, 4001).map(String)),
  quotesPost(range(1, 4000)),
  quotesPost([1, 1, 1]),
  postJSON("/api/quotes", { tokens: [1], extra: true }),
  postJSON("/api/quotes", '{"tokens":[1e2]}'),
  postJSON("/api/quotes", '{"tokens":[100.0],"tokens2":[5]}'),
]);

{
  const tooManyPairs = (n) => Array.from({ length: n }, () => "a=1").join("&") + "&tokens=7";
  await run("GET /api/quotes lenient parsing", withState({ quotes: table(kt(1, 10, 9, 0), kt(2, 20, 19, 0), kt(7, 70, 69, 7000), kt(15, 150, 149, 0)) }), [
    quotesGet(),
    quotesGet("tokens="),
    quotesGet("tokens"),
    quotesGet("TOKENS=1"),
    quotesGet("tokens=abc,-1,0,1.5,,%20"),
    quotesGet("tokens=Infinity,1e400,-0,NaN,-Infinity"),
    quotesGet("tokens=1,2,2,15"),
    quotesGet("tokens=%207%20,0x10,1e3,+5,%2B6,0b111,0o17,%C2%A02,0X1f"),
    quotesGet("tokens=1&tokens=2&tokens=2"),
    quotesGet("tokens=2,1&x-admin-token=abc"),
    quotesGet("tokens=%31%2C7"),
    quotesGet("tokens=1,%zz,7"),
    quotesGet("tokens=1,%E0%A4%A,7,%"),
    quotesGet("tokens=1+2"),
    quotesGet("tok%65ns=15"),
    quotesGet("tokens=9007199254740993,4294967296,9007199254740991"),
    quotesGet("&&tokens=7&&"),
    quotesGet("tokens=7&tokens"),
    quotesGet(tooManyPairs(999)),
    quotesGet(tooManyPairs(1000)),
    quotesGet("tokens=" + range(1, 4001).join(",")),
    quotesGet("tokens=" + range(1, 4000).join(",") + ",1,2,3"),
  ]);
}

await run("quote refusals and broker errors", withState({ generation: 4, dataReady: false, problems: ["Zerodha is not connected"], quotes: table(kt(1, 10, 9, 0), kt(2, 20, 19, 0)) }), [
  quotesPost([1]),
  quotesGet("tokens=1"),
  state({ broker: "dhan", problems: ["Dhan session expired — reconnect Dhan", "Dhan data API is disabled (DHAN_DATA_ENABLED=false)"] }),
  quotesPost([1]),
  state({ dataReady: true, problems: [], owned: [1, 2, 3] }),
  quotesPost([1, 2, 3, ...range(4, 12)]),
  quotesGet("tokens=3,99"),
  state({ broker: "zerodha", owned: null, quoteError: { kind: "kite", status: 403, message: "Incorrect `api_key` or `access_token`." } }),
  quotesPost([1, 2]),
  state({ quoteError: { kind: "kite", status: 401, message: "Session expired" } }),
  quotesGet("tokens=1,2"),
  state({ quoteError: { kind: "kite", status: 429, message: "Too many requests" } }),
  quotesPost([1, 2]),
  state({ quoteError: { kind: "kite", status: 200, message: "Kite returned an error." } }),
  quotesPost([1, 2]),
  state({ quoteError: { kind: "kite", status: 500, message: "Failed to fetch instruments (HTTP 502)." } }),
  quotesPost([1, 2]),
  state({ quoteError: { kind: "error", message: "fetch failed" } }),
  quotesPost([1, 2]),
  state({ quoteError: null }),
  quotesPost([1, 2]),
  quotesPost([2, 1]),
]);

{
  const v1 = table(kt(1, 100, 99, 0), kt(2, 200.05, 199, 1200), kt(3, 0.30000000000000004, 1e-7, 123456789.125));
  const v2 = table(kt(1, 101, 99, 0), kt(2, 201, 199, 1250), kt(3, 1e21, 5e-324, 0));
  const dhan = table(
    dt(1, 2500.5, 2490, 0, 2500.45, 2500.6, [lv(2500.45, 75, 3), lv(2500.4, 150, 5)], [lv(2500.6, 25, 1)]),
    dt(2, 99.95, 101, 55000, 0, 99.9, [], [lv(99.9, 10, 1)]),
    dt(3, 12, 11.5, 0, 0, 0),
  );
  await run("quote cache: keys, hits and the TTL", withState({ quotes: v1 }), [
    quotesPost([3, 1, 2]),
    quotesPost([1, 2, 3]),
    quotesGet("tokens=2,3,1"),
    state({ quotes: v2 }),
    quotesPost([1, 2, 3]),
    advance(3999),
    quotesPost([1, 2, 3]),
    advance(1),
    quotesPost([1, 2, 3]),
    state({ generation: 2 }),
    quotesPost([1, 2, 3]),
    state({ generation: 1 }),
    quotesPost([1, 2, 3]),
    state({ broker: "dhan", quotes: dhan }),
    quotesPost([1, 2, 3]),
    quotesPost([3, 2, 1]),
    quotesPost([1, 2]),
    quotesPost([2, 1, 1]),
    state({ quotes: {} }),
    quotesPost([77]),
    quotesPost([77]),
    advance(4000),
    quotesPost([77]),
  ]);
}

await run("quote cache: 256 entries, oldest first", withState({}), [
  ...range(1, 257).map((t) => quotesPost([t])),
  quotesPost([257]),
  quotesPost([2]),
  quotesPost([1]),
  quotesPost([2]),
  quotesPost([256]),
  advance(4000),
  quotesPost([500]),
  quotesPost([256]),
]);

await run("POST /api/stream/session", withState({ generation: 7 }), [
  req("POST", "/api/stream/session"),
  sessionPost([]),
  sessionPost(range(1, 4001)),
  sessionPost(["1"]),
  sessionPost([2.5]),
  state({ dataReady: false, problems: ["Zerodha is not connected"] }),
  sessionPost([1]),
  state({ broker: "dhan", problems: ["Dhan is not connected"] }),
  sessionPost([1]),
  state({ dataReady: true, problems: [], owned: [5, 6] }),
  sessionPost([5, 6, 7, 8]),
  sessionPost([5, 5, 6]),
  sessionPost(range(1, 4000).map((t) => (t % 2 === 0 ? 5 : 6))),
]);

{
  const quotes = table(
    kt(1, 100, 99, 0),
    dt(2, 2500.5, 2490, 0, 2500.45, 2500.6, [lv(2500.45, 75, 3)], [lv(2500.6, 25, 1), lv(2500.65, 50, 2)]),
    kt(3, 333.3, 330, 9000),
  );
  await run("session stream: snapshot, fan-out, ping, reconnect, cleanup", withState({ quotes }), [
    quotesPost([1, 2, 3]),
    sessionPost([2, 3, 99]),
    sessionGet(0, "S0"),
    { op: "ingest", ticks: [{ token: 7, last_price: 70.25, close_price: 70, oi: 0, bid: 70.2, ask: 70.3 }] },
    { op: "ping", stream: "S0" },
    sessionGet(0, "S1"),
    { op: "ingest", ticks: [{ token: 2, last_price: 2501, close_price: 2490, oi: 0, bid: 2500.95, ask: 2501.05,
      bids: [lv(2500.95, 10, 1)], asks: [lv(2501.05, 20, 2)], depth_updated: true, exchange_ts: START + 1000 }] },
    { op: "ping", stream: "S1" },
    status(),
    { op: "disconnect", stream: "S0" },
    { op: "ingest", ticks: [{ token: 3, last_price: 334, close_price: 330, oi: 9100, bid: 0, ask: 0 }] },
    { op: "disconnect", stream: "S1" },
    advance(299_999),
    sessionGet(0, "S2"),
    { op: "disconnect", stream: "S2" },
    advance(300_001),
    sessionGet(0),
    req("GET", "/api/stream/session/:id", { id: "deadbeef" }),
  ]);
}

await run("session refusals", withState({}), [
  sessionPost([1, 2]),
  state({ generation: 2 }),
  sessionGet(0),
  sessionGet(0),
  sessionPost([1]),
  state({ broker: "dhan" }),
  sessionGet(1),
  sessionPost([3, 4]),
  state({ dataReady: false, problems: ["Dhan session expired — reconnect Dhan"] }),
  sessionGet(2),
  state({ dataReady: true, problems: [], owned: [3] }),
  sessionGet(2),
  state({ owned: null }),
  sessionGet(2, "S0"),
  { op: "disconnect", stream: "S0" },
  state({ broker: "zerodha" }),
  sessionPost([5]),
  state({ dataReady: false, problems: ["Zerodha is not connected"] }),
  sessionGet(3),
  sessionGet(2),
  status(),
]);

await run("legacy GET /api/stream", withState({ dataReady: false, problems: ["Zerodha is not connected"] }), [
  legacyGet(),
  legacyGet("tokens=x,0,-5"),
  legacyGet("tokens=1"),
  state({ dataReady: true, problems: [], owned: [1] }),
  legacyGet("tokens=1,2"),
  state({ owned: null }),
  { op: "seed", ticks: [kt(1, 10, 9, 0), dt(2, 20, 19, 0, 19.5, 20.5, [lv(19.5, 3, 1)], [])] },
  legacyGet("tokens=2,1,2,abc", "S0"),
  { op: "ingest", ticks: [{ token: 9, last_price: 9.5, close_price: 9, oi: 0, bid: 0, ask: 0 }] },
  { op: "ping", stream: "S0" },
  { op: "disconnect", stream: "S0" },
  legacyGet("tokens=" + range(1, 4001).join(","), "S1"),
  { op: "disconnect", stream: "S1" },
]);

await run("kite_error reaches every stream", withState({}), [
  sessionPost([1]),
  sessionGet(0, "S0"),
  legacyGet("tokens=2", "S1"),
  { op: "hubSocket", tokens: [1, 2] },
  { op: "socketError" },
  { op: "ingest", ticks: [{ token: 1, last_price: 11, close_price: 10, oi: 0, bid: 10.95, ask: 11.05 }] },
  { op: "ping", stream: "S1" },
  status(),
  { op: "disconnect", stream: "S0" },
  { op: "disconnect", stream: "S1" },
]);

{
  const live = withState({
    generation: 3,
    feed: feedOf({ connected: true, authenticated: true, subscribed: 816, universe: 98_765, lastTickAt: START - 1500 }),
    subs: subs("futures", 812, 0, 4, 2, 816, 3),
    boxSubs: subs("box", 0, 120, 0, 0, 120, 1),
    upstream: upstreamOf("zerodha", 816, 816, true, START - 1500),
    lanes: {
      futures: laneStats("futures", true, 816, 816, 0, 1500, 0, 3),
      box: laneStats("box", true, 118, 120, 12.5, 250, 2, 3),
    },
  });
  await run("market-data status snapshots", live, [
    status(),
    sessionPost([1, 2, 3]),
    sessionPost([4]),
    sessionGet(0, "S0"),
    status(),
    { op: "disconnect", stream: "S0" },
    state({
      broker: "dhan",
      generation: 4,
      dataReady: false,
      feed: feedOf({ connected: false, authenticated: false, subscribed: 0, universe: null, lastTickAt: null }),
      subs: subs("futures"),
      boxSubs: subs("box"),
      upstream: upstreamOf("dhan", null, null, false, null),
      lanes: { futures: laneStats("futures", false, 0, 0, 0, null, 0, 4), box: laneStats("box", false, 0, 0, 0, null, 0, 4) },
    }),
    status(),
    state({
      dataReady: true,
      feed: feedOf({ connected: true, authenticated: true, subscribed: 40, universe: 250_000, lastTickAt: START - 45_000 }),
      upstream: upstreamOf("dhan", 40, 38, true, START - 45_000),
      lanes: { futures: laneStats("futures", true, 38, 40, 0, 45_000, 0, 4), box: laneStats("box", false, 0, 7, 0, null, 0, 4) },
    }),
    status(),
    state({ feed: feedOf({ connected: true, authenticated: true, subscribed: 0, universe: 250_000, lastTickAt: null }) }),
    status(),
    state({ feed: feedOf({ connected: true, authenticated: true, subscribed: 40, universe: 250_000, lastTickAt: null }) }),
    status(),
    state({ feed: feedOf({ connected: false, connecting: true, authenticated: true, subscribed: 40, universe: 250_000, lastTickAt: START - 10 }) }),
    status(),
  ]);
}

{
  const healthy = {
    feed: feedOf({ connected: true, authenticated: true, subscribed: 10, universe: 5000, lastTickAt: START - 200 }),
    subs: subs("futures", 10, 0, 0, 0, 10, 1),
    upstream: upstreamOf("zerodha", 10, 10, true, START - 200),
    boardSize: 204,
  };
  await run("diagnostics: auth, the five diagnoses and board size", withState({ boardSize: 204 }), [
    diag(),
    diag("trade-token"),
    diag("old-token"),
    diag("no-such-token"),
    diag("full-token"),
    state({ ...healthy, upstream: upstreamOf("zerodha", null, null, false, null) }),
    diag("full-token"),
    state({ upstream: upstreamOf("zerodha", 0, 0, true, null) }),
    diag("full-token"),
    state({ upstream: upstreamOf("dhan", 10, null, true, null) }),
    diag("full-token"),
    state({ upstream: upstreamOf("zerodha", 10, 0, true, null) }),
    diag("full-token"),
    state({ upstream: upstreamOf("zerodha", 10, 10, true, START - 200),
      feed: feedOf({ connected: true, authenticated: true, subscribed: 10, universe: 5000, lastTickAt: null }) }),
    diag("full-token"),
    state(healthy),
    diag("full-token"),
    state({ boardSize: null }),
    diag("full-token"),
    state({ boardSize: { throw: "instrument dump failed" } }),
    diag("full-token"),
    state({ boardSize: 0, subs: subs("futures", 0, 3, 0, 0, 3, 1) }),
    diag("full-token"),
  ]);
}

// ---------------------------------------------------------------------------------------
// Output: one step per line so the file diffs well.

const sources = Object.fromEntries(
  ["marketDataRoutes.ts", "marketDataSession.ts", "boundedCache.ts", "hub.ts", "ticker.ts", "kite.ts", "brokers/feedHealth.ts"]
    .map((rel) => [rel, sha256(fs.readFileSync(path.join(srcDir, rel), "utf8"))]),
);
sources["index.ts#getAdminRole,requireFullAdmin,sendError"] = sha256(copied.join("\n"));
const meta = { generator: "internal/marketdata/testdata/gen_routes.mjs", node: process.version, routes: ROUTES, sources };
const lines = [];
lines.push("{");
lines.push(`"meta": ${JSON.stringify(meta)},`);
lines.push('"scenarios": [');
scenarios.forEach((sc, i) => {
  lines.push(`{"name": ${JSON.stringify(sc.name)}, "start": ${sc.start}, "state": ${JSON.stringify(sc.state)}, "steps": [`);
  lines.push(sc.steps.map((s) => JSON.stringify(s)).join(",\n"));
  lines.push(`]}${i < scenarios.length - 1 ? "," : ""}`);
});
lines.push("]");
lines.push("}");
const out = path.join(here, "routes.golden.json");
fs.writeFileSync(out, lines.join("\n") + "\n");
print(`routes: ${scenarios.length} scenarios, ${scenarios.reduce((n, s) => n + s.steps.length, 0)} steps -> ${path.relative(repoRoot, out)}`);
