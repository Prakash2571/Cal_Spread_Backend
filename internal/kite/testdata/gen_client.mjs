// Golden generator: src/kite.ts KiteClient against a loopback HTTP server that plays
// Kite. Each case scripts the server's responses, calls one client method and records
// the requests the client sent, its result or error, and the session afterwards.
//
//   scratch/go-migration/check.sh node internal/kite/testdata/gen_client.mjs
//
// The client is loaded through loader.mjs, which points KITE_API_ROOT at the loopback
// server (it refuses the real root), so nothing can reach api.kite.trade.
import http from "node:http";
import { loadKite, writeGolden } from "./loader.mjs";

const script = []; // responses still to serve in the current case
const seen = []; // requests received in the current case
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const headers = {};
    for (const k of ["x-kite-version", "authorization", "content-type"]) {
      if (req.headers[k] !== undefined) headers[k] = req.headers[k];
    }
    seen.push({ method: req.method, url: req.url, headers, body: Buffer.concat(chunks).toString("utf8") });
    const r = script.shift() ?? { status: 599, body: "unscripted request" };
    res.writeHead(r.status, { "content-type": r.type ?? "application/json; charset=utf-8" });
    res.end(r.hex !== undefined ? Buffer.from(r.hex, "hex") : r.body);
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { KiteClient } = await loadKite(`http://127.0.0.1:${server.address().port}`);

const cases = [];
async function run(name, { apiKey = "kite-key", apiSecret = "kite-secret", session = null, responses = [], call, args = [] }) {
  script.length = 0;
  script.push(...responses);
  seen.length = 0;
  let client = null;
  let result = null;
  let error = null;
  try {
    client = new KiteClient({ apiKey, apiSecret });
    if (session !== null) client.setAccessToken(session);
    if (call !== "constructor") result = await client[call](...args);
  } catch (e) {
    error = { name: e.name, message: e.message, status: e.status ?? null };
  }
  if (script.length) throw new Error(`${name}: ${script.length} scripted responses unused`);
  // `result` keeps NaN/Infinity/Maps through the loader's replacer; `json` is the plain
  // JSON.stringify text a route would send for a pass-through result; `raws` is each
  // charge row's untouched Kite object as stored with a trade.
  cases.push({ name, apiKey, apiSecret, session, call, args, responses, requests: [...seen], result: result ?? null,
    json: result === undefined || result === null ? null : JSON.stringify(result),
    raws: call === "getOrderCharges" && Array.isArray(result) ? result.map((r) => JSON.stringify(r.raw)) : null, error,
    after: client ? client.getAccessToken() : null });
}

const ok = (data) => ({ status: 200, body: JSON.stringify({ status: "success", data }) });
const body = (status, value, type) => ({ status, body: typeof value === "string" ? value : JSON.stringify(value), ...(type ? { type } : {}) });
const kiteError = (status, message, error_type = "TokenException") => body(status, { status: "error", message, data: null, error_type });
const hex = (status, text, type) => ({ status, hex: text, ...(type ? { type } : {}) });
const utf8hex = (s) => Buffer.from(s, "utf8").toString("hex");

// --- constructor and login -----------------------------------------------------------
await run("constructor: missing secret", { apiSecret: "", call: "constructor" });
await run("constructor: missing key", { apiKey: "", call: "constructor" });
await run("login url", { call: "getLoginUrl" });
await run("login url encodes the key", { apiKey: "a b&c=d/é~*'()!", call: "getLoginUrl" });

// --- generateSession ------------------------------------------------------------------
await run("session: missing request token", { call: "generateSession", args: [""] });
await run("session: success", { call: "generateSession", args: ["req tok&=~*é/'!()"],
  responses: [ok({ user_type: "individual", email: "t@example.com", user_name: "Test User", "2": "numeric key", user_id: "AB1234",
    access_token: "at-1", public_token: "pt", extra: { nested: [1, 2.5, null, true] } })] });
await run("session: Kite rejects, existing session kept", { session: "old-token", call: "generateSession", args: ["rt"],
  responses: [kiteError(403, "Token is invalid or has expired.")] });
await run("session: success without data", { call: "generateSession", args: ["rt"], responses: [body(200, { status: "success" })] });
await run("session: falsy data", { call: "generateSession", args: ["rt"], responses: [ok(0)] });
await run("session: status not success", { call: "generateSession", args: ["rt"],
  responses: [body(200, { status: "error", data: { access_token: "x" } })] });
await run("session: HTML body", { call: "generateSession", args: ["rt"], responses: [body(502, "<html>Bad Gateway</html>", "text/html")] });
await run("session: null body 200", { call: "generateSession", args: ["rt"], responses: [body(200, "null")] });
await run("session: null body 401 keeps the session", { session: "old", call: "generateSession", args: ["rt"], responses: [body(401, "null")] });
await run("session: numeric access token", { call: "generateSession", args: ["rt"], responses: [ok({ access_token: 12345, user_id: "U1" })] });
await run("session: empty message", { call: "generateSession", args: ["rt"], responses: [body(400, { status: "error", message: "" })] });
await run("session: numeric message", { call: "generateSession", args: ["rt"], responses: [body(400, { status: "error", message: 42 })] });
await run("session: object message", { call: "generateSession", args: ["rt"], responses: [body(400, { status: "error", message: { a: 1 } })] });
await run("session: array message", { call: "generateSession", args: ["rt"], responses: [body(400, { status: "error", message: [1, "b"] })] });

// --- getProfile -------------------------------------------------------------------------
const profile = { user_id: "AB1234", user_name: "T", "10": 1, "2": 2, broker: "ZERODHA", meta: { demat_consent: "physical" },
  products: ["CNC", "NRML", "MIS"], exchanges: ["NSE", "NFO"] };
await run("profile: no session", { call: "getProfile" });
await run("profile: empty-string session", { session: "", call: "getProfile" });
await run("profile: success keeps key order", { session: "tok", call: "getProfile", responses: [ok(profile)] });
await run("profile: 403 clears the session", { session: "tok", call: "getProfile",
  responses: [kiteError(403, "Incorrect `api_key` or `access_token`.")] });
await run("profile: 500 without message keeps the session", { session: "tok", call: "getProfile", responses: [body(500, { status: "error" })] });
await run("profile: 401 with null body clears, then throws", { session: "tok", call: "getProfile", responses: [body(401, "null")] });
await run("profile: 401 with HTML body keeps the session", { session: "tok", call: "getProfile", responses: [body(401, "<html>401</html>", "text/html")] });
await run("profile: empty body", { session: "tok", call: "getProfile", responses: [body(200, "")] });
await run("profile: whitespace body", { session: "tok", call: "getProfile", responses: [body(200, " \n ")] });
await run("profile: trailing garbage", { session: "tok", call: "getProfile", responses: [body(200, '{"status":"success","data":{}} x')] });
await run("profile: BOM before JSON", { session: "tok", call: "getProfile",
  responses: [hex(200, "efbbbf" + utf8hex(JSON.stringify({ status: "success", data: { a: "é" } })))] });
await run("profile: invalid UTF-8 inside a string", { session: "tok", call: "getProfile",
  responses: [hex(200, utf8hex('{"status":"success","data":{"name":"A') + "ff" + utf8hex('B"}}'))] });
await run("profile: duplicate keys", { session: "tok", call: "getProfile", responses: [body(200, '{"status":"success","data":{"a":1,"b":3,"a":2}}')] });
await run("profile: data is an empty array", { session: "tok", call: "getProfile", responses: [ok([])] });
await run("profile: data is an empty string", { session: "tok", call: "getProfile", responses: [ok("")] });
await run("profile: numbers keep their JavaScript form", { session: "tok", call: "getProfile",
  responses: [body(200, '{"status":"success","data":{"a":1e21,"b":1E-7,"c":0.30000000000000004,"d":-0,"e":100.0,"f":1e400}}')] });

// --- quotes -----------------------------------------------------------------------------
const ids = ["NSE:INFY", "NSE:NIFTY 50", "NFO:M&M26NOVFUT", "BSE:ÉTOILE"];
const ohlc = (o, h, l, c) => ({ open: o, high: h, low: l, close: c });
await run("ohlc: realistic, identifiers encoded", { session: "tok", call: "getQuoteOhlc", args: [ids],
  responses: [ok({ "NSE:INFY": { instrument_token: 408065, last_price: 1075, ohlc: ohlc(1085.8, 1085.9, 1070.9, 1075.8) },
    "NSE:NIFTY 50": { instrument_token: 256265, last_price: 24050.35, ohlc: ohlc(24000, 24100.5, 23950.05, 24010) },
    "NFO:M&M26NOVFUT": { instrument_token: 12335874, last_price: 3120.4, ohlc: ohlc(3100, 3130, 3095.55, 3101) } })] });
await run("ohlc: skips entries without a numeric token, integer keys first", { session: "tok", call: "getQuoteOhlc", args: [["X:A"]],
  responses: [ok({ A: null, B: { instrument_token: "5", last_price: 1 }, C: { last_price: 2 },
    "7": { instrument_token: 7, last_price: 3, ohlc: ohlc(1, 2, 0.5, 1.5) }, D: { instrument_token: 8, last_price: 4, ohlc: ohlc(1, 1, 1, 1) } })] });
await run("ohlc: missing fields", { session: "tok", call: "getQuoteOhlc", args: [["X:A"]], responses: [ok({ X: { instrument_token: 9 } })] });
await run("quotes: empty identifier list", { session: "tok", call: "getQuoteFull", args: [[]] });
await run("quotes: no session", { call: "getQuoteFull", args: [["NSE:INFY"]] });
const many = Array.from({ length: 501 }, (_, i) => `NFO:SYM${i}`);
await run("quotes: chunks of 500", { session: "tok", call: "getQuoteFull", args: [many],
  responses: [ok({ "NFO:SYM0": { instrument_token: 100, last_price: 1.5, ohlc: { close: 1.25 }, oi: 10, last_trade_time: "2026-10-28 15:29:59" } }),
    ok({ "NFO:SYM500": { instrument_token: 600, last_price: 2.5, ohlc: { close: 2.25 }, oi: 20, last_trade_time: "2026-10-28 15:29:58" } })] });
await run("quotes: second chunk fails", { session: "tok", call: "getQuoteFull", args: [many],
  responses: [ok({ "NFO:SYM0": { instrument_token: 100, last_price: 1.5 } }), kiteError(429, "Too many requests", "NetworkException")] });
await run("quote full: stamps and defaults", { session: "tok", call: "getQuoteFull", args: [ids],
  responses: [ok({
    "NSE:INFY": { instrument_token: 408065, timestamp: "2026-10-28 15:30:00", last_trade_time: "2026-10-28 15:29:59", last_price: 1075,
      volume: 1000, ohlc: ohlc(1085.8, 1085.9, 1070.9, 1075.8), oi: 0 },
    "NSE:NIFTY 50": { instrument_token: 256265, last_price: 24050.35, exchange_timestamp: "2026-10-28 15:30:00", ohlc: ohlc(1, 2, 3, 24010) },
    "NFO:A": { instrument_token: 1, last_price: null, last_trade_time: null, exchange_timestamp: "2026-10-28 09:15:00" },
    "NFO:B": { instrument_token: 2 },
    "NFO:C": { instrument_token: 3, last_price: 0, oi: 125000, ohlc: {} } })] });
await run("quote full: data as array", { session: "tok", call: "getQuoteFull", args: [["X:A"]],
  responses: [ok([{ instrument_token: 1, last_price: 5 }, { instrument_token: 2, last_price: 6 }])] });
await run("quote full: data as string", { session: "tok", call: "getQuoteFull", args: [["X:A"]], responses: [ok("abc")] });
await run("quote full ohlc: realistic and missing ohlc", { session: "tok", call: "getQuoteFullOhlc", args: [ids],
  responses: [ok({ "NSE:INFY": { instrument_token: 408065, last_price: 1075, ohlc: ohlc(1085.8, 1085.9, 1070.9, 1075.8), oi: 0 },
    "NFO:M&M26NOVFUT": { instrument_token: 12335874, last_price: 3120.4, ohlc: ohlc(3100, 3130, 3095.55, 3101), oi: 4500 },
    "NFO:X": { instrument_token: 5, last_price: 9 } })] });
const book = (prices, qty) => prices.map((p, i) => ({ price: p, quantity: qty[i], orders: i + 1 }));
await run("quote depth: best bid/ask with fallbacks", { session: "tok", call: "getQuoteDepth", args: [ids],
  responses: [ok({
    "NFO:A": { instrument_token: 11, last_price: 100, depth: { buy: book([99.5, 99, 98.5, 98, 97.5], [75, 150, 225, 300, 375]), sell: book([100.5, 101, 101.5, 102, 102.5], [75, 75, 75, 75, 75]) } },
    "NFO:B": { instrument_token: 12, last_price: 50, depth: { buy: [], sell: [] } },
    "NFO:C": { instrument_token: 13, last_price: 25 },
    "NFO:D": { instrument_token: 14, last_price: 10, depth: { buy: [{ price: null, quantity: 1 }], sell: [{ price: 0, quantity: 1 }] } },
    "NFO:E": { instrument_token: 11, last_price: 101, depth: { buy: [{ price: 100.5 }], sell: [{ price: 101.5 }] } } })] });
await run("quote ladder: drops empty levels", { session: "tok", call: "getQuoteLadder", args: [ids],
  responses: [ok({
    "NFO:A": { instrument_token: 21, last_price: 100, depth: { buy: book([99.5, 99, 0, 0, 0], [75, 150, 0, 0, 0]), sell: book([100.5, 101, 101.5, 0, 0], [75, 75, 75, 0, 0]) } },
    "NFO:B": { instrument_token: 22, last_price: 50, depth: { buy: [{ price: 49 }], sell: [{ quantity: 5 }, { price: 51, quantity: null }] } },
    "NFO:C": { instrument_token: 23 } })] });
await run("quotes: 401 clears the session", { session: "tok", call: "getQuoteDepth", args: [["NSE:INFY"]],
  responses: [kiteError(401, "Invalid session")] });
await run("quotes: 403 with null body clears, then throws", { session: "tok", call: "getQuoteLadder", args: [["NSE:INFY"]], responses: [body(403, "null")] });

// --- basket margin --------------------------------------------------------------------
const leg = (tradingsymbol, transaction_type, quantity, price = 0) =>
  ({ exchange: "NFO", tradingsymbol, transaction_type, variety: "regular", product: "NRML", order_type: "MARKET", quantity, price });
const calendar = [leg("NIFTY26NOVFUT", "BUY", 75), leg("NIFTY26DECFUT", "SELL", 75)];
const margins = (initial, final) => ({ initial: { type: "", span: 120000, exposure: 32000.5, total: initial }, final: { total: final },
  orders: [{ type: "equity", total: 1 }] });
await run("basket: realistic, positions considered by default", { session: "tok", call: "getBasketMargin", args: [calendar],
  responses: [ok(margins(152000.5, 41250.25))] });
await run("basket: standalone", { session: "tok", call: "getBasketMargin", args: [calendar, { considerPositions: false }],
  responses: [ok(margins(152000.5, 41250.25))] });
await run("basket: explicit true", { session: "tok", call: "getBasketMargin", args: [calendar, { considerPositions: true }],
  responses: [ok(margins(1, 2))] });
await run("basket: zero final falls back to initial", { session: "tok", call: "getBasketMargin", args: [calendar], responses: [ok(margins(150000, 0))] });
await run("basket: missing totals", { session: "tok", call: "getBasketMargin", args: [calendar], responses: [ok({})] });
await run("basket: body encoding", { session: "tok", call: "getBasketMargin",
  args: [[leg("M&M<26>\u2028é\"q\\", "BUY", 1e21, 0.1 + 0.2), leg("X", "SELL", 0.000001, 1e-7), leg("Y", "BUY", 123456789.125, -0)]],
  responses: [ok(margins(1, 2))] });
await run("basket: 403 clears the session", { session: "tok", call: "getBasketMargin", args: [calendar], responses: [kiteError(403, "Forbidden")] });
await run("basket: no session", { call: "getBasketMargin", args: [calendar] });

// --- order charges ----------------------------------------------------------------------
const charge = (side, symbol, qty, avg, id) => ({ order_id: id, exchange: "NFO", tradingsymbol: symbol, transaction_type: side,
  variety: "regular", product: "NRML", order_type: "MARKET", quantity: qty, average_price: avg });
const orders = [charge("BUY", "NIFTY26NOVFUT", 75, 24000.5, "calspread-0-0"), charge("SELL", "NIFTY26DECFUT", 75, 24150.25, "calspread-0-1")];
const heads = (extra = {}) => ({ transaction_tax: 0, transaction_tax_type: "stt", exchange_turnover_charge: 31.5, sebi_turnover_charge: 1.8,
  brokerage: 20, stamp_duty: 36, gst: { igst: 9.6, cgst: 0, sgst: 0, total: 9.6 }, total: 98.9, ...extra });
await run("charges: empty input makes no call", { session: "tok", call: "getOrderCharges", args: [[]] });
await run("charges: realistic", { session: "tok", call: "getOrderCharges", args: [orders],
  responses: [ok([{ transaction_type: "BUY", tradingsymbol: "NIFTY26NOVFUT", exchange: "NFO", variety: "regular", product: "NRML",
    order_type: "MARKET", quantity: 75, price: 24000.5, charges: heads() },
  { transaction_type: "SELL", tradingsymbol: "NIFTY26DECFUT", exchange: "NFO", quantity: 75, price: 24150.25,
    charges: heads({ transaction_tax: 362.25, stamp_duty: 0, total: 425.15 }) }])] });
await run("charges: totals recomputed, heads defensive", { session: "tok", call: "getOrderCharges", args: [orders],
  responses: [ok([{ order_id: "kite-1", tradingsymbol: "OTHER", transaction_type: "sell", quantity: 0, price: "5",
    charges: { transaction_tax: 1.5, transaction_tax_type: 7, exchange_turnover_charge: "2", sebi_turnover_charge: 0.25, brokerage: 20,
      stamp_duty: null, gst: { igst: 1, cgst: 2, sgst: 3 }, total: 0, new_head: 1.25 } },
  { order_id: "", quantity: 50, price: 10, charges: "abc" }])] });
await run("charges: more rows than orders", { session: "tok", call: "getOrderCharges", args: [[orders[0]]],
  responses: [ok([{ charges: heads() }, { quantity: 3 }])] });
await run("charges: null row", { session: "tok", call: "getOrderCharges", args: [orders], responses: [ok([null])] });
await run("charges: data not an array", { session: "tok", call: "getOrderCharges", args: [orders], responses: [ok({ 0: {} })] });
await run("charges: body encoding", { session: "tok", call: "getOrderCharges",
  args: [[charge("BUY", "M&M<>é", 1e21, 0.1 + 0.2, "id \"q\"")]], responses: [ok([])] });
await run("charges: 401 clears the session", { session: "tok", call: "getOrderCharges", args: [orders], responses: [kiteError(401, "expired")] });

// --- historical candles --------------------------------------------------------------
const candles = (rows) => ok({ candles: rows });
const day = [["2026-10-01T00:00:00+0530", 24000, 24100, 23900, 24050, 1000, 500000],
  ["2026-10-03T00:00:00+0530", 24050, 24200.5, 24000, 24150.75, 1500, 510000]];
await run("historical oi: daily", { session: "tok", call: "getHistoricalOi", args: [12335874, "2026-10-01", "2026-10-28"], responses: [candles(day)] });
await run("historical full: default interval", { session: "tok", call: "getHistoricalFull", args: [12335874, "2026-10-01", "2026-10-28"],
  responses: [candles(day)] });
await run("historical full: 60minute, background, time-of-day bounds", { session: "tok", call: "getHistoricalFull",
  args: [256265, "2026-10-01 09:15:00", "2026-10-28 15:30:00+05:30", "60minute", "background"],
  responses: [candles([["2026-10-01T09:15:00+0530", 1, 2, 0.5, 1.5, 0, 0]])] });
await run("historical: no oi parameter", { session: "tok", call: "getHistorical", args: [256265, "2026-10-27", "2026-10-28", "5minute"],
  responses: [candles([["2026-10-27T09:15:00+0530", 24000, 24010, 23990, 24005.5, 0], ["2026-10-27T09:20:00+0530", 24005.5, 24020, 24000, 24012, 0]])] });
await run("historical oi series: minute", { session: "tok", call: "getHistoricalOiSeries", args: [12335874, "2026-10-28", "2026-10-28", "minute", "interactive"],
  responses: [candles([["2026-10-28T09:15:00+0530", 1, 2, 0.5, 1.5, 10, 75000]])] });
const odd = [["2026-10-01T09:15:00+0530", "1", null, true, "24050.5", "", "1e3"], ["2026-10-02"], [20261003, 1, 2, 3, 4, 5, 6],
  [null, 1, 2, 3, 4, 5, 6], "2026-10-04,1,2", [false, 0, 0, 0, "0x1F", " 7 ", "abc"], ["2026-10-05", 1, 2, 3, [5], {}, [1, 2]]];
for (const call of ["getHistoricalOi", "getHistoricalFull", "getHistorical", "getHistoricalOiSeries"]) {
  await run(`historical: odd candle rows (${call})`, { session: "tok", call, args: [1, "2026-10-01", "2026-10-05", "day"], responses: [candles(odd)] });
}
await run("historical: null row", { session: "tok", call: "getHistoricalOi", args: [1, "a", "b"], responses: [candles([day[0], null])] });
await run("historical: empty candles", { session: "tok", call: "getHistorical", args: [1, "a", "b", "day"], responses: [candles([])] });
await run("historical: candles missing", { session: "tok", call: "getHistorical", args: [1, "a", "b", "day"], responses: [ok({})] });
await run("historical: candles is a string", { session: "tok", call: "getHistoricalOiSeries", args: [1, "a", "b", "day"], responses: [candles("abc")] });
await run("historical: candles is an object", { session: "tok", call: "getHistoricalFull", args: [1, "a", "b"], responses: [candles({ 0: [] })] });
await run("historical: 429 keeps the session", { session: "tok", call: "getHistorical", args: [1, "a", "b", "day"],
  responses: [kiteError(429, "Too many requests", "NetworkException")] });
await run("historical: 403 clears the session", { session: "tok", call: "getHistoricalOi", args: [1, "a", "b"], responses: [kiteError(403, "Forbidden")] });
await run("historical: no session", { call: "getHistoricalOi", args: [1, "a", "b"] });

// --- instruments ------------------------------------------------------------------------
const csv = "instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n" +
  "12335874,48187,NIFTY26NOVFUT,NIFTY,0,2026-11-24,0,0.05,75,FUT,NFO-FUT,NFO\n" +
  "13568002,52999,NIFTY2661223500CE,NIFTY,0,2026-06-12,23500,0.05,75,CE,NFO-OPT,NFO\n";
await run("instruments: public dump", { call: "getInstruments", responses: [body(200, csv, "text/csv")] });
await run("instruments: one exchange", { session: "tok", call: "getInstruments", args: ["NFO"], responses: [body(200, csv, "text/csv")] });
await run("instruments: exchange is encoded", { call: "getInstruments", args: ["N F/O&é"], responses: [body(200, csv, "text/csv")] });
await run("instruments: retried with the session", { session: "tok", call: "getInstruments", responses: [body(403, "Forbidden", "text/plain"), body(200, csv, "text/csv")] });
await run("instruments: refused without a session", { call: "getInstruments", responses: [body(403, "Forbidden", "text/plain")] });
await run("instruments: refused with a session", { session: "tok", call: "getInstruments",
  responses: [body(403, "Forbidden", "text/plain"), body(401, "Unauthorized", "text/plain")] });
await run("instruments: empty-string session is not retried", { session: "", call: "getInstruments", responses: [body(403, "Forbidden", "text/plain")] });
await run("instruments: server error body is cut at 200 UTF-16 units", { call: "getInstruments",
  responses: [body(500, "é".repeat(150) + "x".repeat(49) + "😀" + "tail".repeat(30), "text/plain")] });
await run("instruments: server error retried, last response reported", { session: "tok", call: "getInstruments",
  responses: [body(500, "oops", "text/plain"), body(502, "<html>gateway</html>", "text/html")] });
await run("instruments: BOM and CRLF", { call: "getInstruments", responses: [hex(200, "efbbbf" + utf8hex(csv.replaceAll("\n", "\r\n")), "text/csv")] });
await run("instruments: invalid UTF-8 byte", { call: "getInstruments",
  responses: [hex(200, utf8hex(csv.split("\n").slice(0, 2).join("\n").replace("NIFTY,0", "NIF")) + "fe" + utf8hex("TY,0\n"), "text/csv")] });
await run("instruments: header only", { call: "getInstruments", responses: [body(200, csv.split("\n")[0], "text/csv")] });

server.close();
const written = writeGolden("client.golden.json", { cases });
console.log(`kite client: ${cases.length} cases -> ${written}`);
