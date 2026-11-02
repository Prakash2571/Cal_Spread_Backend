// Golden generator for internal/calendar. It runs the ORIGINAL calendar-trade code of
// src/index.ts with Node 22 type stripping:
//
//   scratch/go-migration/check.sh node --experimental-strip-types --no-warnings \
//     internal/calendar/testdata/gen_calendar.mjs
//
// index.ts cannot be imported (it starts the whole server at load time), so the regions
// the trade routes need are copied VERBATIM, located by marker text, into a module under
// scratch/go-migration/tmp/calendar/ behind a small prelude of fakes; the copy is deleted
// after import. src/ is only read.
//
// Real (original code): index.ts resolveLadder, bestPrice, round2, toLegCharges,
// aggregateCharges, chargeTotals, unpricedLogLegs, reverseLegs, priceChargeGroups,
// serializeTrade, the four /api/trades handlers, deriveFnoBoard, makeIdResolver,
// isMarketOpen, getAdminRole/requireAdmin, requireMarketData, getAllInstrumentsCached and
// sendError; src/kite.ts KiteClient (a copy whose KITE_API_ROOT points at a loopback
// server that plays Kite; the real root is refused); src/indexSpot.ts.
// Faked: the Express app (handlers are recorded and called with plain req/res objects),
// the Mongoose Trade model (in memory; ids from a counter), appendTradeLog (records the
// entry in the key order the TradeLog schema stores it), mongoose.isValidObjectId (bson
// 6.10.4's ObjectId.isValid for strings: exactly 24 hex digits), the broker manager, the
// ticker hub and the clock (Date).
//
// Output: helpers.golden.json (pure helpers, stubbed Kite) and routes.golden.json (route
// scenarios: every request, the Kite exchanges it caused, the response, the ledger rows).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const srcDir = path.join(repoRoot, "src");
const tmpDir = path.join(repoRoot, "scratch/go-migration/tmp/calendar");

// ---------------------------------------------------------------------------------------
// Clock: every `new Date()` and Date.now() in the reference code reads fakeNow.
const RealDate = Date;
let fakeNow = RealDate.UTC(2026, 9, 28, 4, 30, 0);
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(fakeNow);
    else super(...args);
  }
  static now() {
    return fakeNow;
  }
}
globalThis.Date = FakeDate;

/** IST wall time -> epoch ms. */
const ist = (y, mo, d, h, mi, s = 0, ms = 0) => RealDate.UTC(y, mo - 1, d, h, mi, s, ms) - 19_800_000;

// ---------------------------------------------------------------------------------------
// Loopback Kite. Each request takes the next scripted entry: a static response, or
// {charges: mode}, a /charges/orders answer computed from the request. Every exchange
// (request + the response actually served) is recorded for the Go replay.
let script = [];
let exchanges = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const headers = {};
    for (const k of ["x-kite-version", "authorization", "content-type"]) {
      if (req.headers[k] !== undefined) headers[k] = req.headers[k];
    }
    const request = { method: req.method, url: req.url, headers, body: Buffer.concat(chunks).toString("utf8") };
    const entry = script.shift();
    let response;
    if (entry === undefined) response = { status: 599, body: "unscripted request" };
    else if (entry.charges) response = chargesResponse(request, entry.charges);
    else response = { status: entry.status, body: entry.body, ...(entry.type ? { type: entry.type } : {}) };
    const ex = { request, response };
    if (entry?.sideEffect) {
      ex.sideEffect = entry.sideEffect;
      if (entry.sideEffect.deleteTrade) fakeStore.delete(entry.sideEffect.deleteTrade);
    }
    exchanges.push(ex);
    res.writeHead(response.status, { "content-type": response.type ?? "application/json; charset=utf-8" });
    res.end(response.body);
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const apiRoot = `http://127.0.0.1:${server.address().port}`;
if (!apiRoot.startsWith("http://127.0.0.1:")) throw new Error("gen: Kite must be the loopback fake");

/** A plausible F&O futures contract note per order (float noise on purpose). */
function chargeRow(o, i, mode) {
  const turnover = o.quantity * o.average_price;
  const brokerage = Math.min(20, turnover * 0.0003);
  const stt = o.transaction_type === "SELL" ? turnover * 0.0002 : 0;
  const exch = turnover * 0.0000173;
  const sebi = turnover * 0.000001;
  const stamp = o.transaction_type === "BUY" ? turnover * 0.00002 : 0;
  const gst = 0.18 * (brokerage + exch + sebi);
  const charges = {
    transaction_tax: stt,
    transaction_tax_type: "stt",
    exchange_turnover_charge: exch,
    sebi_turnover_charge: sebi,
    brokerage,
    stamp_duty: stamp,
    gst: { igst: gst, cgst: 0, sgst: 0, total: gst },
    total: brokerage + stt + exch + sebi + stamp + gst,
  };
  if (mode.stringy && i === 0) charges.brokerage = String(brokerage); // num() reads it as 0
  if (mode.noTotals && i === 1) {
    delete charges.total;
    delete charges.gst.total;
  }
  const row = {
    transaction_type: o.transaction_type,
    tradingsymbol: o.tradingsymbol,
    exchange: o.exchange,
    variety: o.variety,
    product: o.product,
    order_type: o.order_type,
    quantity: o.quantity,
    price: o.average_price,
    charges,
  };
  return mode.withIds ? { order_id: o.order_id, ...row } : row;
}

function chargesResponse(request, mode) {
  const orders = JSON.parse(request.body);
  let rows = orders.map((o, i) => chargeRow(o, i, mode));
  if (mode.reverse) rows = rows.reverse();
  if (mode.drop) rows = rows.slice(0, rows.length - mode.drop);
  return { status: 200, body: JSON.stringify({ status: "success", data: rows }) };
}

// ---------------------------------------------------------------------------------------
// Reference module: src/kite.ts copy + verbatim index.ts regions behind the fakes.
function mustReplace(text, from, to, what) {
  if (!text.includes(from)) throw new Error(`gen: cannot find ${what} in the reference source`);
  return text.replace(from, to);
}

fs.mkdirSync(tmpDir, { recursive: true });
let kiteText = fs.readFileSync(path.join(srcDir, "kite.ts"), "utf8");
kiteText = mustReplace(
  kiteText,
  `  constructor(
    private readonly minGapMs = HISTORICAL_MIN_GAP_MS,
    private readonly slotTimeoutMs = HISTORICAL_SLOT_TIMEOUT_MS,
  ) {}`,
  `  private readonly minGapMs: number;
  private readonly slotTimeoutMs: number;
  constructor(minGapMs = HISTORICAL_MIN_GAP_MS, slotTimeoutMs = HISTORICAL_SLOT_TIMEOUT_MS) {
    this.minGapMs = minGapMs;
    this.slotTimeoutMs = slotTimeoutMs;
  }`,
  "HistoricalGate constructor",
);
kiteText = mustReplace(kiteText, `const KITE_API_ROOT = "https://api.kite.trade";`,
  `const KITE_API_ROOT = ${JSON.stringify(apiRoot)};`, "KITE_API_ROOT");
const kiteFile = path.join(tmpDir, `kite.${process.pid}.ts`);
fs.writeFileSync(kiteFile, kiteText);

const indexText = fs.readFileSync(path.join(srcDir, "index.ts"), "utf8");
function region(start, end, what) {
  const a = indexText.indexOf(start);
  if (a < 0 || indexText.indexOf(start, a + 1) >= 0) throw new Error(`gen: start of ${what} missing or repeated`);
  const b = indexText.indexOf(end, a);
  if (b < 0) throw new Error(`gen: end of ${what} missing`);
  return `// ---- src/index.ts: ${what} (verbatim)\n` + indexText.slice(a, b);
}
const regions = [
  region('type AdminRole = "full" | "trade";', "// In-memory cache of the instrument dump", "admin sessions"),
  region("function requireMarketData(res: Response, what: string): boolean {",
    "/**\n * ZERODHA-ONLY analytics recorders", "requireMarketData"),
  region("function isMarketOpen(): boolean {", "/** Simple delay helper", "isMarketOpen"),
  region('/** Build a token -> "EXCHANGE:TRADINGSYMBOL" resolver from the instrument dump. */',
    'app.get("/api/history/:symbol"', "makeIdResolver"),
  region("interface Ladder {", "interface BoardFuture {", "calendar trades"),
  region("interface BoardFuture {", "interface FnoStock extends Instrument {", "deriveFnoBoard"),
  region("async function getAllInstrumentsCached(): Promise<Instrument[]> {",
    "/**\n * After a login, immediately backfill", "getAllInstrumentsCached + sendError"),
];
const kiteUrl = pathToFileURL(kiteFile).href;
const prelude = `// GENERATED by internal/calendar/testdata/gen_calendar.mjs; deleted after import.
import { KiteClient, KiteError } from ${JSON.stringify(kiteUrl)};
import type { ChargeOrder, Instrument, OrderCharges } from ${JSON.stringify(kiteUrl)};
import { resolveIndexSpotSymbol } from ${JSON.stringify(pathToFileURL(path.join(srcDir, "indexSpot.ts")).href)};
type Request = any;
type Response = any;
type NextFunction = any;
type ILegCharges = any;
type ITrade = any;
type ITradeCharges = any;
type ITradeLogLeg = any;
type TradeRecord = any;
const H: any = (globalThis as any).__calendarHarness;
const app = H.app;
const tickerHub = { getFreshLadder: (token: number, maxAgeMs?: number) => H.freshLadder(token, maxAgeMs) };
const kite: any = new Proxy({}, {
  get: (_t, k) => {
    const target = H.kiteStub ?? H.kiteClient;
    const v = target[k];
    return typeof v === "function" ? v.bind(target) : v;
  },
});
const brokerManager = {
  activeHealth: () => ({ data_ready: H.md.ready, problems: H.md.problems }),
  get activeBroker() { return H.md.broker; },
  instrumentProvider: { load: () => H.loadInstruments() },
};
const isDbEnabled = () => H.dbEnabled;
const isValidId = (id: string) => H.isValidId(id);
const Trade: any = new Proxy({}, { get: (_t, k) => H.Trade[k] });
const appendTradeLog = (entry: any) => H.appendTradeLog(entry);
const clearKiteSession = () => H.clearKiteSession();
const deleteAdminSession = (token: string) => H.deleteAdminSession(token);
`;
const exportsText = `
export { resolveLadder, bestPrice, round2, toLegCharges, aggregateCharges, chargeTotals, unpricedLogLegs,
  reverseLegs, priceChargeGroups, serializeTrade, deriveFnoBoard, isMarketOpen, adminSessions, KiteClient, KiteError };
`;
const refFile = path.join(tmpDir, `calendar_ref.${process.pid}.ts`);
fs.writeFileSync(refFile, prelude + "\n" + regions.join("\n") + exportsText);

// ---------------------------------------------------------------------------------------
// Fakes behind the prelude.
const warns = [];
console.warn = (...args) => warns.push(typeof args[0] === "string" ? args[0] : String(args[0]));

const tradeId = (n) => "65a1" + n.toString(16).padStart(20, "0");
class FakeObjectId {
  constructor(hex) {
    this.hex = hex;
  }
  toString() {
    return this.hex;
  }
}
const FIELDS = ["symbol", "name", "is_index", "lot_size", "buy", "sell", "status", "opened_at", "closed_at",
  "close_pnl", "buy_close", "sell_close", "margin", "entry_charges", "exit_charges", "est_exit_charges",
  "entry_value", "exit_value", "total_charges", "net_pnl"];
const fakeStore = new Map(); // hex id -> stored fields (Dates kept)
let idCounter = 0;
const plain = (src) => {
  const o = {};
  for (const k of FIELDS) if (k in src) o[k] = structuredClone(src[k]);
  return o;
};
const leanDoc = (hex) => ({ _id: new FakeObjectId(hex), ...structuredClone(fakeStore.get(hex)) });
const docProto = {
  toObject() {
    return { _id: this._id, ...plain(this) };
  },
  async save() {
    const hex = this._id.toString();
    if (!fakeStore.has(hex)) {
      // Mongoose DocumentNotFoundError: save() matched no document.
      throw new Error(`No document found for query "{ _id: new ObjectId('${hex}') }" on model "Trade"`);
    }
    fakeStore.set(hex, plain(this));
    return this;
  },
};
const hydrate = (hex) => Object.assign(Object.create(docProto), { _id: new FakeObjectId(hex) }, structuredClone(fakeStore.get(hex)));
const TradeModel = {
  findOne(filter) {
    return {
      lean: async () => {
        for (const [hex, d] of fakeStore) if (d.symbol === filter.symbol && d.status === filter.status) return leanDoc(hex);
        return null;
      },
    };
  },
  async create(payload) {
    const hex = tradeId(++idCounter);
    fakeStore.set(hex, plain(payload));
    return hydrate(hex);
  },
  find() {
    const byNewest = (a, b) => fakeStore.get(b).opened_at - fakeStore.get(a).opened_at || (a < b ? 1 : a > b ? -1 : 0);
    return { sort: () => ({ limit: (n) => ({ lean: async () => [...fakeStore.keys()].sort(byNewest).slice(0, n).map(leanDoc) }) }) };
  },
  async findById(id) {
    const hex = String(id).toLowerCase(); // a 24-hex string casts to its ObjectId
    return fakeStore.has(hex) ? hydrate(hex) : null;
  },
  async deleteOne(filter) {
    fakeStore.delete(String(filter._id));
    return { acknowledged: true, deletedCount: 1 };
  },
};

// trade_log documents as the TradeLog schema stores them (Mongoose writes schema order).
const storedLogLeg = (l) => ({
  side: l.side, token: l.token, tradingsymbol: l.tradingsymbol, exchange: l.exchange, expiry: l.expiry,
  quantity: l.quantity, price: l.price, value: l.value, brokerage: l.brokerage, stt: l.stt, stt_type: l.stt_type,
  exchange_txn: l.exchange_txn, sebi: l.sebi, stamp_duty: l.stamp_duty, gst: l.gst, total: l.total, raw: l.raw ?? null,
});
const storedLedger = (e) => ({
  trade_id: e.trade_id, symbol: e.symbol, name: e.name, is_index: e.is_index, lot_size: e.lot_size, event: e.event,
  at: e.at.toISOString(), legs: e.legs.map(storedLogLeg), value: e.value,
  charges: {
    brokerage: e.charges.brokerage, stt: e.charges.stt, exchange_txn: e.charges.exchange_txn, sebi: e.charges.sebi,
    stamp_duty: e.charges.stamp_duty, gst: e.charges.gst, total: e.charges.total,
  },
  source: e.source, margin: e.margin, gross_pnl: e.gross_pnl, total_charges: e.total_charges, net_pnl: e.net_pnl,
});
const ledger = [];

const universes = {};
const H = {
  routes: [],
  app: {
    post: (p, ...hs) => H.routes.push({ method: "POST", path: p, handlers: hs }),
    get: (p, ...hs) => H.routes.push({ method: "GET", path: p, handlers: hs }),
    delete: (p, ...hs) => H.routes.push({ method: "DELETE", path: p, handlers: hs }),
  },
  dbEnabled: true,
  md: { ready: true, broker: "zerodha", problems: [] },
  instrumentOutcomes: [],
  instrumentCalls: 0,
  hub: {},
  hubCalls: [],
  cleared: 0,
  kiteClient: null,
  kiteStub: null,
  isValidId: (id) => typeof id === "string" && /^[0-9a-fA-F]{24}$/.test(id),
  Trade: TradeModel,
  appendTradeLog: async (entry) => {
    ledger.push(JSON.stringify(storedLedger(entry)));
  },
  clearKiteSession: async () => {
    H.cleared++;
  },
  deleteAdminSession: async () => {},
  freshLadder: (tk) => {
    H.hubCalls.push(tk);
    return H.hub[tk] ?? null;
  },
  loadInstruments: async () => {
    const o = H.instrumentOutcomes[Math.min(H.instrumentCalls, H.instrumentOutcomes.length - 1)];
    H.instrumentCalls++;
    if (o.error) throw o.error.kite ? new ref.KiteError(o.error.message, o.error.status) : new Error(o.error.message);
    return universes[o.list];
  },
};
globalThis.__calendarHarness = H;

let ref;
try {
  ref = await import(pathToFileURL(refFile).href);
} finally {
  fs.rmSync(refFile, { force: true });
  fs.rmSync(kiteFile, { force: true });
}

// ---------------------------------------------------------------------------------------
// Golden serialisation: non-finite numbers and -0 survive as {"$num": ...}.
function replacer(_key, value) {
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
    return { $num: Number.isNaN(value) ? "NaN" : Object.is(value, -0) ? "-0" : value > 0 ? "Infinity" : "-Infinity" };
  }
  return value;
}
function writeGolden(file, obj) {
  const parts = Object.keys(obj).map((k) =>
    Array.isArray(obj[k])
      ? `${JSON.stringify(k)}:[\n${obj[k].map((e) => JSON.stringify(e, replacer)).join(",\n")}\n]`
      : `${JSON.stringify(k)}:${JSON.stringify(obj[k], replacer)}`,
  );
  fs.writeFileSync(path.join(here, file), `{\n${parts.join(",\n")}\n}\n`);
}

/** Deterministic PRNG (mulberry32) so regenerated goldens are byte-identical. */
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n), pick: (arr) => arr[Math.floor(next() * arr.length)] };
}

// =======================================================================================
// Part 1: pure helpers.
const r = rng(20261028);
const BOUNDARY = [0, 0.005, 0.015, 0.025, 0.045, 0.125, 0.135, 0.145, 1.005, 1.015, 1.255, 2.675, 4.35, 8.345,
  10.235, 1234.565, 1e-7, 0.1 + 0.2, 123456789.125, 999999.995, -0.004, -0.005, -1.005, -2.675, -1234.565, 5e-324,
  1e21, 0.29, 1.4999999999999998, 0.49999999999999994, 2.5, -2.5, 99.995, 100.005, 7.3e-5];
const randMoney = () => {
  switch (r.int(5)) {
    case 0: return Math.round(r.next() * 1e6) / 100;
    case 1: return Math.round(r.next() * 1e7) / 1000;
    case 2: return r.next() * 50;
    case 3: return r.pick(BOUNDARY);
    default: return Math.round(r.next() * 4000) / 100 * 0.18;
  }
};
const randPrice = () => (r.int(4) === 0 ? Math.round(r.next() * 4e6) / 1000 : Math.round(r.next() * 4e5) / 100 + 0.05 * r.int(3));
const LOTS = [1, 15, 25, 50, 75, 100, 350, 450, 500, 1250, 4000, 0, 0.5];
const SYMS = ["ABC26OCTFUT", "XYZ26NOVFUT", "M&M26DECFUT", "NIFTY26OCTFUT", "BANKNIFTY26NOVFUT", "", "ÉTOILE26OCTFUT"];
const randLeg = () => ({
  side: r.pick(["BUY", "SELL"]),
  token: 1000 + r.int(20000),
  expiry: r.pick(["2026-10-29", "2026-11-26", "2026-12-31"]),
  tradingsymbol: r.pick(SYMS),
  exchange: r.pick(["NFO", "BFO", "NSE"]),
  quantity: r.pick(LOTS),
  price: randPrice(),
});
const randBreakdown = () => {
  const igst = randMoney();
  return {
    transaction_tax: randMoney(),
    transaction_tax_type: r.pick(["stt", "ctt", ""]),
    exchange_turnover_charge: randMoney(),
    sebi_turnover_charge: randMoney(),
    brokerage: randMoney(),
    stamp_duty: randMoney(),
    gst: { igst, cgst: 0, sgst: 0, total: r.int(3) === 0 ? igst + 0.0001 : igst },
    total: randMoney(),
  };
};
const randOc = (leg, i) => ({
  order_id: `calspread-0-${i}`,
  tradingsymbol: leg.tradingsymbol,
  transaction_type: leg.side,
  quantity: leg.quantity,
  price: leg.price,
  charges: randBreakdown(),
  raw: r.int(4) === 0 ? null : { z: 1, a: [2, { y: 3 }], m: "x" },
});

const helpers = {
  round2: [], bestPrice: [], toLegCharges: [], aggregateCharges: [], chargeTotals: [], unpricedLogLegs: [],
  reverseLegs: [], serializeTrade: [], priceChargeGroups: [], resolveLadder: [],
};

// round2: boundary values, their negations, and random money. Outputs are JSON text,
// except that NaN and the infinities are spelled out (JSON.stringify would write null).
const outNum = (v) => (v === null ? "null" : Number.isFinite(v) ? JSON.stringify(v) : String(v));
{
  const values = [...BOUNDARY, ...BOUNDARY.map((v) => -v)];
  for (let i = 0; i < 400; i++) values.push(randMoney() * (r.int(2) ? 1 : -1));
  values.push(NaN, Infinity, -Infinity);
  helpers.round2.push({ in: values, out: values.map((v) => outNum(ref.round2(v))) });
}

// bestPrice: unordered levels, zero / negative / NaN / Infinity prices, empty books, any side.
for (let i = 0; i < 300; i++) {
  const n = r.int(7);
  const levels = [];
  for (let j = 0; j < n; j++) {
    const k = r.int(12);
    const price = k === 0 ? 0 : k === 1 ? -randPrice() : k === 2 ? NaN : k === 3 && r.int(4) === 0 ? Infinity : randPrice();
    levels.push({ price, qty: r.int(5000) });
  }
  const side = r.pick(["bid", "ask", "ask", "bid", "other"]);
  helpers.bestPrice.push({ levels, side, out: outNum(ref.bestPrice(levels, side)) });
}

// toLegCharges.
for (let i = 0; i < 250; i++) {
  const leg = randLeg();
  if (i % 50 === 7) leg.price = NaN;
  const oc = randOc(leg, i);
  if (i % 60 === 11) oc.charges.brokerage = Infinity;
  helpers.toLegCharges.push({ leg, oc, out: JSON.stringify(ref.toLegCharges(leg, oc)) });
}

// aggregateCharges (at = the clock).
for (let i = 0; i < 120; i++) {
  fakeNow = RealDate.UTC(2026, 9, 28, 4, 30, 0) + i * 1234 + (i % 7);
  const legs = [];
  const n = i % 10 === 0 ? 0 : 1 + r.int(4);
  for (let j = 0; j < n; j++) {
    const leg = randLeg();
    legs.push(ref.toLegCharges(leg, randOc(leg, j)));
  }
  const source = r.pick(["kite", "kite_estimate"]);
  helpers.aggregateCharges.push({ legs, source, now: fakeNow, out: JSON.stringify(ref.aggregateCharges(legs, source)) });
}

// chargeTotals.
helpers.chargeTotals.push({ in: null, out: JSON.stringify(ref.chargeTotals(null)) });
for (let i = 0; i < 20; i++) {
  const legs = [ref.toLegCharges(randLeg(), randOc(randLeg(), 0))];
  const c = ref.aggregateCharges(legs, "kite");
  if (i === 3) c.total = NaN;
  helpers.chargeTotals.push({ in: c, out: JSON.stringify(ref.chargeTotals(c)) });
}

// unpricedLogLegs (stored key order) and reverseLegs.
for (let i = 0; i < 40; i++) {
  const legs = [];
  const n = i % 9 === 0 ? 0 : 1 + r.int(3);
  for (let j = 0; j < n; j++) legs.push(randLeg());
  if (i % 13 === 5 && legs.length) legs[0].side = "HOLD";
  helpers.unpricedLogLegs.push({ legs, out: JSON.stringify(ref.unpricedLogLegs(legs).map(storedLogLeg)) });
  helpers.reverseLegs.push({ legs, out: JSON.stringify(ref.reverseLegs(legs)) });
}

// serializeTrade: docs as the store returns them (every field present; dates as Date).
{
  const iso = (ms) => new RealDate(ms).toISOString();
  const chargesDoc = (source, at) => ({ ...ref.aggregateCharges([ref.toLegCharges(randLeg(), randOc(randLeg(), 0))], source), at: new RealDate(at) });
  const cases = [];
  for (let i = 0; i < 24; i++) {
    const open = i % 3 !== 0;
    const opened = RealDate.UTC(2026, 9, 1 + i, 4, 30, 0) + i * 37;
    const num = () => (r.int(6) === 0 ? null : r.int(9) === 0 ? r.pick([NaN, Infinity, -Infinity]) : randMoney());
    cases.push({
      id: tradeId(1000 + i), symbol: r.pick(["ABC", "M&M", "NIFTY", "É"]), name: r.pick(["ABC LTD", "", "NIFTY 50"]),
      is_index: r.int(2) === 1, lot_size: r.pick(LOTS),
      buy: { token: 12001 + i, expiry: "2026-10-29", entry: randPrice() },
      sell: { token: 12002 + i, expiry: "2026-11-26", entry: randPrice() },
      status: open ? "open" : "closed", opened_at: iso(opened), closed_at: open ? null : iso(opened + 3_600_123),
      close_pnl: open ? null : num(), buy_close: open ? null : num(), sell_close: open ? null : num(), margin: num(),
      entry_charges: r.int(3) === 0 ? null : chargesDoc("kite", opened - 5),
      exit_charges: open || r.int(3) === 0 ? null : chargesDoc(r.pick(["kite", "kite_estimate"]), opened + 3_600_000),
      est_exit_charges: r.int(3) === 0 ? null : chargesDoc("kite_estimate", opened - 4),
      entry_value: num(), exit_value: open ? null : num(), total_charges: open ? null : num(), net_pnl: open ? null : num(),
    });
  }
  for (const c of cases) {
    const doc = { ...c, _id: new FakeObjectId(c.id), opened_at: new RealDate(c.opened_at), closed_at: c.closed_at ? new RealDate(c.closed_at) : null };
    delete doc.id;
    helpers.serializeTrade.push({ doc: JSON.parse(JSON.stringify(c, replacer)), out: JSON.stringify(ref.serializeTrade(doc)) });
  }
}

// priceChargeGroups with a stubbed getOrderCharges.
{
  const groupsOf = (sizes, sources) => sizes.map((n, gi) => ({ legs: Array.from({ length: n }, () => randLeg()), source: sources[gi] }));
  const rowsFor = (orders, how) => {
    let rows = orders.map((o, i) => ({
      order_id: how.includes("noid") ? String(i) : o.order_id,
      tradingsymbol: o.tradingsymbol, transaction_type: o.transaction_type, quantity: o.quantity, price: o.average_price,
      charges: randBreakdown(), raw: r.int(3) === 0 ? null : { total: r.int(100), gst: { igst: 1 } },
    }));
    if (how.includes("reverse")) rows = rows.reverse();
    if (how.includes("short")) rows = rows.slice(1);
    if (how.includes("long")) rows = [...rows, rows[0]];
    if (how.includes("dupid") && rows.length > 1) rows[1] = { ...rows[1], order_id: rows[0].order_id };
    return rows;
  };
  const plans = [
    [[2, 2], ["kite", "kite_estimate"], "inorder"], [[2, 2], ["kite", "kite_estimate"], "reverse"],
    [[2, 2], ["kite", "kite_estimate"], "noid"], [[2, 2], ["kite", "kite_estimate"], "noid reverse"],
    [[2], ["kite"], "inorder"], [[2], ["kite_estimate"], "reverse"], [[2, 2], ["kite", "kite_estimate"], "short"],
    [[2, 2], ["kite", "kite_estimate"], "long"], [[2], ["kite"], "throws"], [[0], ["kite"], "inorder"],
    [[0, 2], ["kite", "kite_estimate"], "inorder"], [[3, 1], ["kite", "kite_estimate"], "dupid"],
    [[1, 3], ["kite_estimate", "kite"], "noid"], [[2, 2], ["kite", "kite_estimate"], "dupid reverse"],
  ];
  for (let p = 0; p < plans.length * 3; p++) {
    const [sizes, sources, how] = plans[p % plans.length];
    fakeNow = RealDate.UTC(2026, 9, 28, 5, 0, 0) + p * 1001;
    const groups = groupsOf(sizes, sources);
    let requested = null;
    let rows = null;
    H.kiteStub = {
      getOrderCharges: async (orders) => {
        requested = JSON.stringify(orders);
        if (how === "throws") throw new ref.KiteError("Charges API is unavailable.", 503);
        rows = rowsFor(orders, how);
        return rows;
      },
    };
    warns.length = 0;
    const out = await ref.priceChargeGroups(groups);
    H.kiteStub = null;
    helpers.priceChargeGroups.push({
      groups, now: fakeNow, how, requested,
      rows: rows === null ? null : rows.map((row) => ({ ...row, raw: row.raw === null ? null : JSON.stringify(row.raw) })),
      out: out === null ? "null" : JSON.stringify(out.map((g) => ({ charges: g.charges, logLegs: g.logLegs.map(storedLogLeg) }))),
      warns: [...warns],
    });
  }
}

// resolveLadder with a stubbed hub, universe and getQuoteLadder.
{
  const book = (last, bids, asks) => ({ last, bids: bids.map(([price, qty]) => ({ price, qty, orders: 1 })), asks: asks.map(([price, qty]) => ({ price, qty, orders: 2 })) });
  const inst = (token, exchange, tradingsymbol) => ({ instrument_token: token, exchange_token: 0, tradingsymbol, name: "", last_price: 0,
    expiry: "", strike: 0, tick_size: 0.05, lot_size: 1, instrument_type: "FUT", segment: "NFO-FUT", exchange });
  const universe = [inst(1, "NSE", "ABC"), inst(2, "NFO", "ABC26OCTFUT"), inst(3, "NFO", "ABC26NOVFUT"),
    inst(4, "NSE", "NIFTY 50"), inst(2, "BFO", "ABC26OCTFUT-DUP"), inst(5, "NSE", "M&M")];
  const cases = [
    { tokens: [1, 2, 3], hub: { 2: book(101, [[100.5, 10]], [[101.5, 5]]), 3: book(102, [], [[102.5, 7]]) },
      rest: { 1: book(99, [], []) } },
    { tokens: [1, 2, 3], hub: { 1: book(99, [], []), 2: book(101, [], []), 3: book(102, [[101.9, 1]], []) },
      rest: { 1: book(99.5, [[99.4, 3]], [[99.6, 4]]), 2: book(101.1, [[101, 1]], [[101.2, 1]]) } },
    { tokens: [4, 9, 2], hub: {}, rest: { 4: book(24000.5, [], []), 2: book(101, [[100, 1]], [[102, 1]]), 77: book(1, [], []) } },
    { tokens: [2, 3], hub: { 2: book(101, [[1, 1]], []), 3: book(0, [], [[1, 1]]) }, rest: {} },
    { tokens: [9], hub: {}, rest: {} },
    { tokens: [1, 5], hub: {}, rest: { error: { kite: true, status: 403, message: "Incorrect `api_key` or `access_token`." } } },
    { tokens: [1], hub: {}, universeError: { kite: false, message: "instrument master not loaded" }, rest: {} },
    { tokens: [3, 3, 1], hub: { 3: book(102, [[101.9, 1]], [[102.1, 1]]) }, rest: { 1: book(99, [[98, 1]], []) } },
  ];
  for (const c of cases) {
    let ids = null;
    H.hub = c.hub;
    H.hubCalls = [];
    H.instrumentCalls = 0;
    universes.R = universe;
    H.instrumentOutcomes = [c.universeError ? { error: c.universeError } : { list: "R" }];
    H.kiteStub = {
      getQuoteLadder: async (identifiers) => {
        ids = identifiers;
        if (c.rest.error) throw new ref.KiteError(c.rest.error.message, c.rest.error.status);
        return new Map(Object.entries(c.rest).map(([k, v]) => [Number(k), v]));
      },
    };
    let out;
    let error = null;
    try {
      const m = await ref.resolveLadder(c.tokens);
      out = JSON.stringify([...m.entries()].sort((a, b) => a[0] - b[0]).map(([tk, l]) =>
        [tk, { last: l.last, bids: l.bids.map((x) => ({ price: x.price, qty: x.qty })), asks: l.asks.map((x) => ({ price: x.price, qty: x.qty })) }]));
    } catch (e) {
      error = { name: e.name, message: e.message, status: e.status ?? null };
      out = null;
    }
    H.kiteStub = null;
    helpers.resolveLadder.push({ ...c, universe, ids, hubCalls: [...H.hubCalls], instrumentCalls: H.instrumentCalls, out, error });
  }
}
writeGolden("helpers.golden.json", helpers);

// =======================================================================================
// Part 2: route scenarios.
const inst = (instrument_token, tradingsymbol, name, exchange, segment, instrument_type, expiry, lot_size) => ({
  instrument_token, exchange_token: Math.floor(instrument_token / 256), tradingsymbol, name, last_price: 0, expiry,
  strike: 0, tick_size: 0.05, lot_size, instrument_type, segment, exchange,
});
universes.U = [
  inst(12002, "ABC26NOVFUT", "ABC", "NFO", "NFO-FUT", "FUT", "2026-11-26", 450),
  inst(738561, "ABC", "ABC LTD", "NSE", "NSE", "EQ", "", 1),
  inst(12001, "ABC26OCTFUT", "ABC", "NFO", "NFO-FUT", "FUT", "2026-10-29", 500),
  inst(12003, "ABC26DECFUT", "ABC", "NFO", "NFO-FUT", "FUT", "2026-12-31", 450),
  inst(2953217, "XYZ", "XYZ INDUSTRIES LTD", "NSE", "NSE", "EQ", "", 1),
  inst(12012, "XYZ26NOVFUT", "XYZ", "NFO", "NFO-FUT", "FUT", "2026-11-26", 1250),
  inst(12011, "XYZ26OCTFUT", "XYZ", "NFO", "NFO-FUT", "FUT", "2026-10-29", 1250),
  inst(519937, "M&M", "MAHINDRA & MAHINDRA LTD", "NSE", "NSE", "EQ", "", 1),
  inst(12021, "M&M26OCTFUT", "M&M", "NFO", "NFO-FUT", "FUT", "2026-10-29", 350),
  inst(12022, "M&M26NOVFUT", "M&M", "NFO", "NFO-FUT", "FUT", "2026-11-26", 350),
  inst(1001, "ONEFUT", "ONE FUTURE LTD", "NSE", "NSE", "EQ", "", 1),
  inst(12031, "ONEFUT26OCTFUT", "ONEFUT", "NFO", "NFO-FUT", "FUT", "2026-10-29", 100),
  inst(256265, "NIFTY 50", "NIFTY 50", "NSE", "INDICES", "EQ", "", 0),
  inst(13002, "NIFTY26NOVFUT", "NIFTY", "NFO", "NFO-FUT", "FUT", "2026-11-24", 75),
  inst(13001, "NIFTY26OCTFUT", "NIFTY", "NFO", "NFO-FUT", "FUT", "2026-10-27", 75),
  inst(14001, "GHOST26OCTFUT", "GHOST", "NFO", "NFO-FUT", "FUT", "2026-10-29", 10),
];
const boards = Object.fromEntries(Object.entries(universes).filter(([k]) => k !== "R").map(([k, u]) => [k, ref.deriveFnoBoard(u)]));

const ok = (data) => ({ status: 200, body: JSON.stringify({ status: "success", data }) });
const kerr = (status, message, error_type = "GeneralException") =>
  ({ status, body: JSON.stringify({ status: "error", message, data: null, error_type }) });
const lv = (rows) => {
  const out = rows.map(([price, quantity, orders = 1]) => ({ price, quantity, orders }));
  while (out.length < 5) out.push({ price: 0, quantity: 0, orders: 0 });
  return out;
};
const quote = (token, last, bids = [], asks = []) => ({ instrument_token: token, last_price: last, depth: { buy: lv(bids), sell: lv(asks) } });
const quotes = (entries) => ok(Object.fromEntries(entries));
const margin = (initial, final) => ok({ initial: { total: initial }, final: { total: final }, orders: [] });
const charges = (mode = {}) => ({ charges: mode });
const book = (last, bids, asks) => ({
  last, bids: bids.map(([price, qty, orders = 1]) => ({ price, qty, orders })), asks: asks.map(([price, qty, orders = 1]) => ({ price, qty, orders })),
});

const T0 = ist(2026, 10, 28, 10, 0, 0); // Wednesday
const FAR = T0 + 365 * 86_400_000;
const NOT_READY = { ready: false, broker: "zerodha", problems: ["Zerodha is not connected"] };
const ROUTES = {
  take: { method: "POST", path: "/api/trades" },
  list: { method: "GET", path: "/api/trades" },
  close: { method: "POST", path: "/api/trades/:id/close" },
  delete: { method: "DELETE", path: "/api/trades/:id" },
};
const FULL = "full-token";
const TRADE = "trade-token";

// Books used by several scenarios.
const ABC_OCT = book(1010.4, [[1010.3, 500], [1010.35, 1000], [0, 0]], [[1010.6, 500], [1010.45, 250], [1010.9, 700]]);
const ABC_NOV = book(1025.1, [[1024.95, 450], [1025.05, 900]], [[1025.3, 450]]);
const ABC_SPOT = quotes([["NSE:ABC", quote(738561, 1000.25)]]);
const takeABC = (extra = {}) => ({
  name: "take ABC", route: "take", token: FULL, body: '{"symbol":"abc"}', hub: { 12001: ABC_OCT, 12002: ABC_NOV },
  kite: [ABC_SPOT, margin(152340.55, 98765.5), charges()], ...extra,
});
const NIFTY_HUB = {
  13001: book(24150.5, [[24150.1, 75], [24150.25, 150]], [[24151, 75]]),
  13002: book(24260.1, [[24259.9, 75]], [[24260.6, 75], [24260.4, 300]]),
  256265: book(24100.35, [], []),
};
const NIFTY_SPOT = quotes([["NSE:NIFTY 50", quote(256265, 24100.35)]]);
const XYZ_REST = quotes([
  ["NSE:XYZ", quote(2953217, 2520.15)],
  ["NFO:XYZ26OCTFUT", quote(12011, 2531.5, [[2531.2, 1250], [2531.35, 2500]], [[2531.7, 1250]])],
  ["NFO:XYZ26NOVFUT", quote(12012, 2528.2, [[2528.1, 1250]], [[2528.6, 1250], [2528.45, 2500]])],
]);
const MM_REST = quotes([
  ["NSE:M&M", quote(519937, 3105.8)],
  ["NFO:M&M26OCTFUT", quote(12021, 3110.35, [[3110.2, 350]], [[3110.55, 350]])],
  ["NFO:M&M26NOVFUT", quote(12022, 3128.9, [[3128.75, 700]], [[3129.1, 350]])],
]);

const scenarios = [];
let clock = T0;
async function scenario(name, steps) {
  fakeStore.clear();
  idCounter = 0;
  ledger.length = 0;
  ref.adminSessions.clear();
  ref.adminSessions.set(FULL, { expiry: FAR, role: "full" });
  ref.adminSessions.set(TRADE, { expiry: FAR, role: "trade" });
  ref.adminSessions.set("expired-token", { expiry: T0 - 1, role: "full" });
  H.kiteClient = new ref.KiteClient({ apiKey: "kite-key", apiSecret: "kite-secret" });
  H.kiteClient.setAccessToken("kite-token");
  clock = T0;
  const out = { name, steps: [] };
  for (const s of steps) out.steps.push(await runStep(name, s));
  scenarios.push(out);
}

function seedTrade(d) {
  const toDate = (v) => (v === null ? null : new RealDate(v));
  const chargesDoc = (c) => (c === null ? null : { ...c, at: new RealDate(c.at) });
  const { id, ...rest } = d;
  fakeStore.set(id, plain({
    ...rest, opened_at: toDate(d.opened_at), closed_at: toDate(d.closed_at),
    entry_charges: chargesDoc(d.entry_charges), exit_charges: chargesDoc(d.exit_charges), est_exit_charges: chargesDoc(d.est_exit_charges),
  }));
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (v) => {
    res.body = JSON.stringify(v);
    return res;
  };
  return res;
}

async function invoke(route, req, res) {
  const pending = [];
  let i = 0;
  const next = (err) => {
    if (err) throw err;
    const h = route.handlers[i++];
    if (h) pending.push(Promise.resolve(h(req, res, next)));
  };
  next();
  for (let k = 0; k < pending.length; k++) await pending[k];
}

async function runStep(scName, s) {
  clock = s.at ?? clock + 1000;
  fakeNow = clock;
  H.dbEnabled = s.db !== false;
  H.md = s.md ?? { ready: true, broker: "zerodha", problems: [] };
  H.instrumentOutcomes = s.instruments ?? [{ list: "U" }];
  H.instrumentCalls = 0;
  H.hub = s.hub ?? {};
  H.hubCalls = [];
  H.cleared = 0;
  if (s.session !== undefined) {
    if (s.session === null) H.kiteClient.clearSession();
    else H.kiteClient.setAccessToken(s.session);
  }
  for (const d of s.seed ?? []) seedTrade(d);
  script = [...(s.kite ?? [])];
  exchanges = [];
  warns.length = 0;
  const ledgerBefore = ledger.length;
  const def = ROUTES[s.route];
  const route = H.routes.find((x) => x.method === def.method && x.path === def.path);
  const req = {
    headers: s.token === undefined ? {} : { "x-admin-token": s.token },
    body: s.body === undefined ? undefined : JSON.parse(s.body),
    params: s.id === undefined ? {} : { id: s.id },
  };
  const res = fakeRes();
  await invoke(route, req, res);
  await new Promise((resolve) => setImmediate(resolve));
  if (script.length) throw new Error(`${scName} / ${s.name}: ${script.length} scripted Kite responses unused`);
  if (res.body === null) throw new Error(`${scName} / ${s.name}: no response`);
  const step = {
    name: s.name, at: clock, route: s.route, token: s.token ?? null, body: s.body ?? null, id: s.id ?? null,
    db: H.dbEnabled, md: H.md, instruments: H.instrumentOutcomes, hub: H.hub, seed: s.seed ?? [],
    response: { status: res.statusCode, body: res.body }, exchanges,
    kiteSessionAfter: H.kiteClient.getAccessToken(), cleared: H.cleared, instrumentCalls: H.instrumentCalls,
    hubCalls: [...H.hubCalls], ledger: ledger.slice(ledgerBefore), warns: [...warns],
  };
  if (s.session !== undefined) step.session = s.session === null ? { clear: true } : { set: s.session };
  if (s.id !== undefined && s.id.length === 12) step.decision = "12-char-id";
  return step;
}

const validId = tradeId(255);
await scenario("gates and validation", [
  { name: "no token", route: "take", body: '{"symbol":"abc"}' },
  { name: "unknown token", route: "take", token: "nope", body: '{"symbol":"abc"}' },
  { name: "expired token", route: "take", token: "expired-token", body: '{"symbol":"abc"}' },
  { name: "trade role, no database", route: "take", token: TRADE, db: false, body: '{"symbol":"abc"}' },
  { name: "list without database", route: "list", token: TRADE, db: false },
  { name: "list without token, no database", route: "list", db: false },
  { name: "close without database", route: "close", token: FULL, db: false, id: validId },
  { name: "close without token", route: "close", id: validId },
  { name: "delete without database", route: "delete", token: TRADE, db: false, id: "nope" },
  { name: "delete without token", route: "delete", id: validId },
  { name: "Zerodha not data-ready", route: "take", token: FULL, md: NOT_READY, body: '{"symbol":"abc"}' },
  { name: "Dhan not data-ready", route: "take", token: TRADE, body: '{"symbol":"abc"}',
    md: { ready: false, broker: "dhan", problems: ["Dhan session expired — reconnect Dhan", "Dhan data API is disabled (DHAN_DATA_ENABLED=false)"] } },
  { name: "Saturday", route: "take", token: FULL, at: ist(2026, 10, 31, 11, 0), body: '{"symbol":"abc"}' },
  { name: "09:14:59", route: "take", token: FULL, at: ist(2026, 10, 28, 9, 14, 59, 999), body: '{"symbol":"abc"}' },
  { name: "15:41:00", route: "take", token: FULL, at: ist(2026, 10, 28, 15, 41, 0), body: '{"symbol":"abc"}' },
  { name: "09:15:00, no body", route: "take", token: FULL, at: ist(2026, 10, 28, 9, 15, 0) },
  { name: "blank symbol", route: "take", token: FULL, body: '{"symbol":"  \\t "}' },
  { name: "null symbol", route: "take", token: FULL, body: '{"symbol":null}' },
  { name: "array body", route: "take", token: FULL, body: '["ABC"]' },
  { name: "numeric symbol", route: "take", token: FULL, body: '{"symbol":123}' },
  { name: "symbol is upper-cased like JavaScript", route: "take", token: FULL, body: '{"symbol":" straße\\u00a0"}' },
  { name: "object symbol", route: "take", token: FULL, body: '{"symbol":{"a":1}}' },
  { name: "unknown symbol", route: "take", token: FULL, body: '{"symbol":"nope"}' },
  { name: "future without spot is not on the board", route: "take", token: FULL, body: '{"symbol":"ghost"}' },
  { name: "array symbol, one future", route: "take", token: FULL, body: '{"symbol":["onefut"]}' },
  { name: "instruments: Kite 403 clears the session", route: "take", token: FULL, body: '{"symbol":"abc"}',
    instruments: [{ error: { kite: true, status: 403, message: "Incorrect `api_key` or `access_token`." } }] },
  { name: "instruments: other error", route: "take", token: FULL, body: '{"symbol":"abc"}', session: "kite-token",
    instruments: [{ error: { kite: false, message: "The Dhan instrument master has not been parsed yet." } }] },
  { name: "15:40:59 is still open", route: "take", token: FULL, at: ist(2026, 10, 28, 15, 40, 59, 999), body: '{"symbol":"onefut"}' },
]);

await scenario("take trades", [
  takeABC({ name: "take ABC: hub books, REST spot, margin and charges" }),
  { name: "ABC is already open", route: "take", token: TRADE, body: '{"symbol":"ABC"}' },
  { name: "list", route: "list", token: TRADE },
  { name: "take XYZ: REST books, backwardation buys next month, margin and charges fail", route: "take", token: TRADE,
    body: '{"symbol":"xyz"}', kite: [XYZ_REST, kerr(500, "Margin service is down"), charges({ drop: 1 })] },
  { name: "take M&M: identifiers encoded, charges reversed with ids, a string head, missing totals", route: "take", token: FULL,
    body: '{"symbol":"m&m"}', kite: [MM_REST, margin(50000.49, 0), charges({ withIds: true, reverse: true, stringy: true, noTotals: true })] },
  { name: "take NIFTY: index, empty hub book for spot, charges 403 clears Kite's own session", route: "take", token: FULL,
    body: '{"symbol":"nifty"}', hub: NIFTY_HUB, kite: [NIFTY_SPOT, margin(120000, 118500.5), kerr(403, "Token is invalid or has expired.", "TokenException")] },
  { name: "list newest first", route: "list", token: FULL },
]);

await scenario("take refusals", [
  { name: "spot last is 0", route: "take", token: FULL, body: '{"symbol":"abc"}', hub: { 12001: ABC_OCT, 12002: ABC_NOV },
    kite: [quotes([["NSE:ABC", quote(738561, 0)]])] },
  { name: "REST omits the current month", route: "take", token: FULL, body: '{"symbol":"abc"}',
    kite: [quotes([["NSE:ABC", quote(738561, 1000)], ["NFO:ABC26NOVFUT", quote(12002, 1025, [[1025, 1]], [[1025.5, 1]])]])] },
  { name: "current month last is 0", route: "take", token: FULL, body: '{"symbol":"abc"}',
    hub: { 12001: book(0, [[1010, 1]], [[1011, 1]]), 12002: ABC_NOV }, kite: [ABC_SPOT] },
  { name: "no ask on the leg to buy", route: "take", token: FULL, body: '{"symbol":"abc"}',
    hub: { 12001: book(1010.4, [[1010.3, 500]], []), 12002: ABC_NOV }, kite: [ABC_SPOT] },
  { name: "no bid on the leg to sell", route: "take", token: FULL, body: '{"symbol":"abc"}',
    hub: { 12001: ABC_OCT, 12002: book(1025.1, [[0, 5], [-1, 1]], [[1025.3, 450]]) }, kite: [ABC_SPOT] },
  { name: "quote 403 clears the session", route: "take", token: FULL, body: '{"symbol":"abc"}', hub: { 12001: ABC_OCT, 12002: ABC_NOV },
    kite: [kerr(403, "Incorrect `api_key` or `access_token`.", "TokenException")] },
  { name: "no Kite session for the REST fallback", route: "take", token: FULL, body: '{"symbol":"abc"}', hub: { 12001: ABC_OCT, 12002: ABC_NOV } },
  { name: "Kite answers 200 with an error status", route: "take", token: FULL, body: '{"symbol":"abc"}', session: "kite-token",
    hub: { 12001: ABC_OCT, 12002: ABC_NOV }, kite: [{ status: 200, body: '{"status":"error","message":"Quote service paused"}' }] },
  { name: "Kite answers HTML", route: "take", token: FULL, body: '{"symbol":"abc"}', hub: { 12001: ABC_OCT, 12002: ABC_NOV },
    kite: [{ status: 502, body: "<html>Bad Gateway</html>", type: "text/html" }] },
  { name: "second instrument load fails", route: "take", token: FULL, body: '{"symbol":"abc"}',
    instruments: [{ list: "U" }, { error: { kite: true, status: 500, message: "Failed to download instruments (HTTP 500)." } }] },
  { name: "finally taken", ...takeABC() },
]);

await scenario("close trades", [
  takeABC({ name: "take ABC" }),
  { name: "take XYZ, charges fail", route: "take", token: TRADE, body: '{"symbol":"xyz"}',
    kite: [XYZ_REST, margin(310000, 305000.25), kerr(500, "Charges service is down")] },
  { name: "take M&M", route: "take", token: FULL, body: '{"symbol":"m&m"}', kite: [MM_REST, margin(51000, 50500), charges()] },
  { name: "take NIFTY", route: "take", token: FULL, body: '{"symbol":"nifty"}', hub: NIFTY_HUB,
    kite: [NIFTY_SPOT, margin(120000, 118500.5), charges({ withIds: true })] },
  { name: "invalid id", route: "close", token: FULL, id: "xyz" },
  { name: "25 hex digits", route: "close", token: FULL, id: tradeId(1) + "0" },
  { name: "24 characters, not hex", route: "close", token: FULL, id: "zz" + tradeId(1).slice(2) },
  { name: "12 characters", route: "close", token: FULL, id: "abcdefghijkl" },
  { name: "unknown id", route: "close", token: FULL, id: validId },
  { name: "not data-ready", route: "close", token: FULL, id: tradeId(1), md: NOT_READY },
  { name: "close ABC (upper-case id): hub books", route: "close", token: TRADE, id: tradeId(1).toUpperCase(),
    hub: { 12001: book(1012.3, [[1012.1, 500], [1012.25, 300]], [[1012.4, 500]]), 12002: book(1026.3, [[1026, 450]], [[1026.4, 450], [1026.2, 900]]) },
    kite: [charges()] },
  { name: "closing a closed trade returns it unchanged", route: "close", token: FULL, id: tradeId(1) },
  { name: "close XYZ: REST books, exit priced, legacy entry backfill", route: "close", token: FULL, id: tradeId(2),
    kite: [quotes([["NFO:XYZ26NOVFUT", quote(12012, 2540, [[2539.85, 1250], [2539.9, 1250]], [[2540.2, 1250]])],
      ["NFO:XYZ26OCTFUT", quote(12011, 2541, [[2540.8, 1250]], [[2541.15, 1250], [2541.05, 2500]])]]), charges(), charges({ withIds: true })] },
  { name: "close M&M: exit charges fail, entry estimate used", route: "close", token: FULL, id: tradeId(3),
    kite: [quotes([["NFO:M&M26OCTFUT", quote(12021, 3101.5, [[3101.25, 350]], [[3101.7, 350]])],
      ["NFO:M&M26NOVFUT", quote(12022, 3120.1, [[3119.9, 350]], [[3120.35, 350]])]]), kerr(500, "Charges service is down")] },
  { name: "close NIFTY: instrument lookup fails", route: "close", token: FULL, id: tradeId(4),
    hub: { 13001: book(24180, [[24179.5, 75]], [[24180.5, 75]]), 13002: book(24280, [[24279.6, 75]], [[24280.4, 75]]) },
    instruments: [{ error: { kite: true, status: 403, message: "Incorrect `api_key` or `access_token`." } }] },
  takeABC({ name: "take ABC again" }),
  { name: "close ABC: no bid and last 0 on the long leg, short leg missing", route: "close", token: FULL, id: tradeId(5),
    kite: [quotes([["NFO:ABC26OCTFUT", quote(12001, 0, [], [[1013, 5]])]]), charges()] },
  { name: "take XYZ again", route: "take", token: FULL, body: '{"symbol":"xyz"}', kite: [XYZ_REST, margin(310000, 305000), charges()] },
  { name: "close XYZ: quote 403 clears the session", route: "close", token: FULL, id: tradeId(6),
    kite: [kerr(403, "Token is invalid or has expired.", "TokenException")] },
  { name: "close XYZ: deleted while closing", route: "close", token: FULL, id: tradeId(6), session: "kite-token",
    hub: { 12011: book(2535, [[2534.9, 1250]], [[2535.1, 1250]]), 12012: book(2533, [[2532.8, 1250]], [[2533.2, 1250]]) },
    kite: [{ charges: {}, sideEffect: { deleteTrade: tradeId(6) } }] },
  { name: "list", route: "list", token: FULL },
]);

const legacyOpen = {
  id: "65a10000000000000000abcd", symbol: "XYZ", name: "XYZ INDUSTRIES LTD", is_index: false, lot_size: 1250,
  buy: { token: 12012, expiry: "2026-11-26", entry: 2528.45 }, sell: { token: 12011, expiry: "2026-10-29", entry: 2531.35 },
  status: "open", opened_at: T0 - 86_400_000, closed_at: null, close_pnl: null, buy_close: null, sell_close: null, margin: null,
  entry_charges: null, exit_charges: null, est_exit_charges: null, entry_value: null, exit_value: null, total_charges: null, net_pnl: null,
};
const storedCharges = (source, at) => ({
  legs: [
    { side: "BUY", tradingsymbol: "M&M26OCTFUT", quantity: 350, price: 3110.55, value: 1088692.5, brokerage: 20, stt: 0, stt_type: "stt",
      exchange_txn: 18.83, sebi: 1.09, stamp_duty: 21.77, gst: 7.38, total: 69.07 },
    { side: "SELL", tradingsymbol: "M&M26NOVFUT", quantity: 350, price: 3128.75, value: 1095062.5, brokerage: 20, stt: 219.01, stt_type: "stt",
      exchange_txn: 18.94, sebi: 1.1, stamp_duty: 0, gst: 7.21, total: 266.26 },
  ],
  value: 2183755, brokerage: 40, stt: 219.01, exchange_txn: 37.77, sebi: 2.19, stamp_duty: 21.77, gst: 14.59, total: 335.33,
  source, at: new RealDate(at).toISOString(),
});
const legacyClosed = {
  id: "65a10000000000000000beef", symbol: "M&M", name: "MAHINDRA & MAHINDRA LTD", is_index: false, lot_size: 350,
  buy: { token: 12021, expiry: "2026-10-29", entry: 3110.55 }, sell: { token: 12022, expiry: "2026-11-26", entry: 3128.75 },
  status: "closed", opened_at: T0 - 2 * 86_400_000, closed_at: T0 - 86_400_000 + 123, close_pnl: 1137.5, buy_close: 3115.2,
  sell_close: 3130.15, margin: 50500, entry_charges: storedCharges("kite", T0 - 2 * 86_400_000), exit_charges: storedCharges("kite", T0 - 86_400_000),
  est_exit_charges: storedCharges("kite_estimate", T0 - 2 * 86_400_000), entry_value: 2183755, exit_value: 2194027.5, total_charges: 670.66,
  net_pnl: 466.84,
};
await scenario("legacy trades and delete", [
  { name: "close a legacy trade: entry charges and value backfilled", route: "close", token: FULL, id: legacyOpen.id, seed: [legacyOpen],
    hub: { 12011: book(2535, [[2534.9, 1250]], [[2535.1, 1250]]), 12012: book(2533, [[2532.8, 1250]], [[2533.2, 1250]]) },
    kite: [charges(), charges()] },
  { name: "a stored closed trade is returned as stored", route: "close", token: FULL, id: legacyClosed.id, seed: [legacyClosed] },
  takeABC({ name: "take ABC" }),
  { name: "delete: invalid id", route: "delete", token: FULL, id: "not-an-id" },
  { name: "delete: unknown id", route: "delete", token: FULL, id: validId },
  { name: "delete: 12 characters", route: "delete", token: FULL, id: "ABCDEFGHIJKL" },
  { name: "delete: open trade refused", route: "delete", token: FULL, id: tradeId(1) },
  { name: "delete: upper-case id, the id is echoed as sent", route: "delete", token: FULL, id: legacyOpen.id.toUpperCase() },
  { name: "delete again", route: "delete", token: FULL, id: legacyOpen.id },
  { name: "delete with the trade role", route: "delete", token: TRADE, id: legacyClosed.id },
  { name: "list", route: "list", token: TRADE },
]);

writeGolden("routes.golden.json", {
  sessions: [
    { token: FULL, role: "full", expiry: FAR },
    { token: TRADE, role: "trade", expiry: FAR },
    { token: "expired-token", role: "full", expiry: T0 - 1 },
  ],
  kiteSession: "kite-token",
  universes: { U: universes.U },
  boards,
  scenarios,
});
server.closeAllConnections();
server.close();
console.log(`wrote helpers.golden.json and routes.golden.json (${scenarios.length} scenarios, ${scenarios.reduce((n, s) => n + s.steps.length, 0)} steps)`);
