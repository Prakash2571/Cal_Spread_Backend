// Golden generator for src/synthetic/math.ts (part 1: universe, windows, pricing,
// sorting, IST helpers). Imports the ORIGINAL TypeScript unmodified; run from the repo
// root:
//
//   scratch/go-migration/check.sh node internal/synthetic/testdata/gen_math.mjs
//
// math.ts imports box/math.ts and box/localCharges.ts, which use TypeScript-only syntax,
// so the script re-launches itself under --experimental-transform-types and registers
// the ".js" -> ".ts" resolve hook of internal/brokers/dhan/testdata/ts_hooks.mjs. No
// network, no database, no clock: every `now` is fixed. Writes math_golden.json; the
// opportunities are recorded as plain JSON.stringify text (what the routes send).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
for (const k of Object.keys(process.env)) if (/^(BOX_|SYNTH_|FUT_)/.test(k)) delete process.env[k]; // default rate cards

const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const M = await load("src/synthetic/math.ts");
const C = await load("src/synthetic/config.ts");
const { loadBoxChargeRates } = await load("src/box/localCharges.ts");

let seed = 0x5eed2026;
const rnd = () => { // mulberry32
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (n) => Math.floor(rnd() * n);
const pick = (a) => a[int(a.length)];

const TODAY = "2026-10-28";
const NOW = Date.parse("2026-10-28T05:00:00.000Z"); // 10:30 IST
const optionRates = loadBoxChargeRates();
const futuresRates = C.loadFuturesChargeRates(optionRates);

// ---- universe (Kite instrument rows) ---------------------------------------------------
const all = [];
let token = 1000;
const row = (name, type, expiry, strike, lot, extra = {}) => {
  const tradingsymbol = type === "FUT" ? `${name}${expiry.replaceAll("-", "")}FUT` : `${name}${expiry.replaceAll("-", "")}${strike}${type}`;
  all.push({ instrument_token: token++, exchange_token: token, tradingsymbol, name, last_price: 0, expiry, strike, tick_size: 0.05,
    lot_size: lot, instrument_type: type, segment: type === "FUT" ? "NFO-FUT" : "NFO-OPT", exchange: "NFO", ...extra });
};
const chainRows = (name, expiry, lo, hi, step, lot, opts = {}) => {
  for (let k = lo; k <= hi; k += step) {
    if (!(opts.skipPE ?? []).includes(k)) row(name, "PE", expiry, k, opts.optLot ?? lot, opts.extra);
    if (!(opts.skipCE ?? []).includes(k)) row(name, "CE", expiry, k, opts.optLot ?? lot, opts.extra);
  }
};
row("NIFTY", "FUT", "2026-12-29", 0, 75);
row("NIFTY", "FUT", "2026-11-24", 0, 75);
row("NIFTY", "FUT", "2026-10-27", 0, 75); // expired
chainRows("NIFTY", "2026-11-03", 23500, 25500, 50, 75); // weekly: no future
chainRows("NIFTY", "2026-11-24", 23000, 26000, 50, 75, { skipCE: [24250], skipPE: [25750] });
chainRows("NIFTY", "2026-12-29", 23000, 26000, 100, 75);
row("BANKNIFTY", "FUT", "2026-11-24", 0, 30);
chainRows("BANKNIFTY", "2026-11-24", 50000, 56000, 100, 30);
row("RELIANCE", "FUT", "2026-11-24", 0, 250);
chainRows("RELIANCE", "2026-11-24", 2400, 3200, 20, 250, { extra: { tick_size: 0 } });
row("LOTMIX", "FUT", "2026-11-24", 0, 100);
chainRows("LOTMIX", "2026-11-24", 100, 200, 10, 100, { optLot: 50 });
row("LOTMIX", "FUT", "2026-12-29", 0, 100);
chainRows("LOTMIX", "2026-12-29", 100, 200, 10, 100);
row("NOOPT", "FUT", "2026-11-24", 0, 500);
row("FARONLY", "FUT", "2026-11-24", 0, 400);
row("FARONLY", "FUT", "2026-12-29", 0, 400);
chainRows("FARONLY", "2026-12-29", 900, 1100, 25, 400);
row("ZEROLOT", "FUT", "2026-11-24", 0, 0);
row("ZEROLOT", "FUT", "2026-12-29", 0, 60);
chainRows("ZEROLOT", "2026-11-24", 500, 600, 10, 60);
chainRows("ZEROLOT", "2026-12-29", 500, 600, 10, 60);
row("UNEVEN", "FUT", "2026-11-24", 0, 125);
for (const k of [400, 410, 420, 440, 450, 475, 500, 550]) { row("UNEVEN", "CE", "2026-11-24", k, 125); row("UNEVEN", "PE", "2026-11-24", k, 125); }
row("ONESIDED", "FUT", "2026-11-24", 0, 10);
chainRows("ONESIDED", "2026-11-24", 100, 150, 10, 10, { skipPE: [100, 110, 120, 130, 140, 150] });
all.push({ instrument_token: 9, exchange_token: 9, tradingsymbol: "RELIANCE", name: "RELIANCE", last_price: 0, expiry: "", strike: 0,
  tick_size: 0.05, lot_size: 1, instrument_type: "EQ", segment: "NSE", exchange: "NSE" });
all.push({ instrument_token: 10, exchange_token: 10, tradingsymbol: "NONAME26NOVFUT", name: "", last_price: 0, expiry: "2026-11-24",
  strike: 0, tick_size: 0.05, lot_size: 1, instrument_type: "FUT", segment: "NFO-FUT", exchange: "NFO" });
row("NIFTY", "CE", "2026-11-24", 0, 75); // strike 0 option: ignored

const contract = (i) => i; // SynthInstrument objects are plain
const mapEntries = (m) => [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, contract(v)]);
const chainView = (c) => c && { underlying: c.underlying, expiry: c.expiry, lot_size: c.lot_size, strike_step: c.strike_step,
  future: c.future, strikes: c.strikes, ce: mapEntries(c.ce), pe: mapEntries(c.pe) };
const windowView = (w) => w && { underlying: w.underlying, name: w.name, is_index: w.is_index, expiry: w.expiry, lot_size: w.lot_size,
  strike_step: w.strike_step, atm_strike: w.atm_strike, strikes: w.strikes, future: w.future, ce: mapEntries(w.ce), pe: mapEntries(w.pe),
  ref_price: w.ref_price, window_at: w.window_at };

const out = { today: TODAY, now: NOW, optionRates, futuresRates, instruments: all };
const chains = M.indexSyntheticChains(all, TODAY);
out.chains = [...chains.values()].map(chainView);
out.chainsLater = [...M.indexSyntheticChains(all, "2026-11-25").values()].map(chainView);

// ---- windows ------------------------------------------------------------------------------
const boards = { NIFTY: { symbol: "NIFTY", name: "Nifty 50", is_index: true }, BANKNIFTY: { symbol: "BANKNIFTY", name: "Nifty Bank", is_index: true },
  RELIANCE: { symbol: "RELIANCE", name: "Reliance Industries" } };
out.windows = [];
for (const c of chains.values()) {
  const lo = c.strikes[0], hi = c.strikes[c.strikes.length - 1], mid = c.strikes[Math.floor(c.strikes.length / 2)];
  for (const ref of [mid, mid + c.strike_step * 0.5, mid + c.strike_step * 0.49, mid - c.strike_step * 0.51, lo - 1000, hi + 1000, lo, hi, 0, -1, NaN]) {
    for (const eachSide of [0, 1, 2, 3]) {
      const board = boards[c.underlying] ?? { symbol: c.underlying, name: `${c.underlying} name` };
      const w = M.buildSynthWindow({ board, chain: c, ref, eachSide, now: NOW });
      out.windows.push({ underlying: c.underlying, board, ref, eachSide, window: windowView(w), tokens: w ? M.synthWindowTokens(w) : null });
    }
  }
}
out.rebuild = [];
for (const c of chains.values()) {
  const w = M.buildSynthWindow({ board: { symbol: c.underlying, name: c.underlying }, chain: c, ref: c.strikes[Math.floor(c.strikes.length / 2)], eachSide: 2, now: NOW });
  if (!w) continue;
  for (const dRef of [0, 0.3, 0.5, 0.75, 1, 1.5, -0.6, -2]) for (const dt of [0, 999, 1000, 60000]) for (const hysteresis of [0.25, 0.5, 1]) {
    const ref = w.atm_strike + dRef * w.strike_step;
    out.rebuild.push({ underlying: c.underlying, ref, now: NOW + dt, hysteresis, minIntervalMs: 1000,
      value: M.synthWindowNeedsRebuild({ window: w, ref, now: NOW + dt, hysteresis, minIntervalMs: 1000 }) });
  }
}
out.tokensFor = [0, 1, 2, 3, 5].map((n) => [n, M.synthTokensFor(n)]);
out.years = [];
for (const e of ["2026-11-24", "2026-10-28", "2026-10-27", "2027-03-31", "bad", ""]) for (const n of [NOW, Date.parse("2026-10-28T10:00:00Z"), Date.parse("2026-10-28T10:00:00.001Z"), 0]) {
  out.years.push([e, n, M.yearsToExpiry(e, n)]);
}
out.keys = [["NIFTY", "2026-11-24", 24500, "CONVERSION"], ["M&M", "2026-11-24", 2512.5, "REVERSAL"], ["X", "", 0, "CONVERSION"], ["A|B", "e", -1, "REVERSAL"]]
  .map((a) => [a, M.candidateKeyFor(...a)]);

// ---- charges ---------------------------------------------------------------------------------
out.charges = [];
for (let i = 0; i < 40; i++) {
  const legs = ["fut", "ce", "pe"].map((role) => ({ role, side: pick(["BUY", "SELL"]), tradingsymbol: `SYM${i}${role}`,
    price: role === "fut" ? 1000 + rnd() * 30000 : rnd() < 0.1 ? 0 : rnd() * 600 }));
  const quantity = pick([1, 25, 50, 75, 250, 1800]);
  out.charges.push({ legs, quantity, order: M.synthOrderCharges(legs, quantity, optionRates, futuresRates),
    both: M.synthCharges(legs, quantity, optionRates, futuresRates) });
}

// ---- evaluation -------------------------------------------------------------------------------
const quoteScenarios = [];
const books = (w, kind) => {
  const q = new Map();
  const tokens = M.synthWindowTokens(w);
  for (const t of tokens) {
    if ((kind === "clean" || kind === "messy") && rnd() < 0.05) continue; // no quote
    const isFut = t === w.future.token;
    const strike = isFut ? 0 : [...w.ce.entries(), ...w.pe.entries()].find(([, v]) => v.token === t)[0];
    const isCE = !isFut && w.ce.get(strike)?.token === t;
    const fair = isFut ? w.ref_price * (1 + 0.004) : Math.max(0.05, isCE ? w.ref_price - strike : strike - w.ref_price) + 20 * rnd();
    const spread = Math.max(0.05, Math.round(fair * 0.002 * 20) / 20);
    let bid = Math.round((fair - spread / 2) * 20) / 20, ask = Math.round((fair + spread / 2) * 20) / 20;
    let bidQty = w.lot_size * (1 + int(20)), askQty = w.lot_size * (1 + int(20));
    let at = NOW - int(800);
    if (kind === "messy") {
      const r = rnd();
      if (r < 0.06) bid = 0; else if (r < 0.12) ask = 0; else if (r < 0.17) { bid = ask + 0.5; } else if (r < 0.24) bidQty = askQty = int(w.lot_size);
      else if (r < 0.3) at = NOW - 60_000; else if (r < 0.33) { bid = ask; }
    }
    if (kind === "crossed" && !isFut) {
      if (isCE) bid = ask + 0.05; // every call crossed; the future is always clean
      else if (strike % 3 === 0) bidQty = askQty = w.lot_size - 1;
    }
    const last = kind === "indicative" && rnd() < 0.1 ? 0 : Math.round(fair * 20) / 20;
    q.set(t, kind === "indicative" ? { bid: 0, bid_qty: 0, ask: 0, ask_qty: 0, last, at: NOW - 3_600_000 } : { bid, bid_qty: bidQty, ask, ask_qty: askQty, last, at });
  }
  return q;
};
const paramSets = [
  { name: "default", quantity: 1, rfPct: 6.5, includeCarry: true, minExpectedNetProfit: 500, safetyBuffer: 50, expectedSlippage: 25 },
  { name: "no carry", quantity: 1, rfPct: 6.5, includeCarry: false, minExpectedNetProfit: -1e9, safetyBuffer: 0, expectedSlippage: 0 },
  { name: "zero rf", quantity: 2, rfPct: 0, includeCarry: true, minExpectedNetProfit: 0, safetyBuffer: 10, expectedSlippage: 5 },
  { name: "negative rf", quantity: 1, rfPct: -1.25, includeCarry: true, minExpectedNetProfit: -100, safetyBuffer: 0, expectedSlippage: 0 },
];
out.evaluations = [];
const evalInputs = [];
const windowsFor = [["NIFTY", 24510, 3], ["BANKNIFTY", 53333, 2], ["RELIANCE", 2805, 3], ["UNEVEN", 452, 2], ["FARONLY", 1010, 1]];
for (const [u, ref, eachSide] of windowsFor) {
  const c = chains.get(u);
  const w = M.buildSynthWindow({ board: boards[u] ?? { symbol: u, name: u }, chain: c, ref, eachSide, now: NOW });
  for (const kind of ["clean", "messy", "crossed", "indicative"]) {
    const q = books(w, kind);
    const quotes = [...q.entries()];
    for (const ps of paramSets) {
      const quantity = ps.quantity * w.lot_size;
      const params = { quantity, now: NOW, quoteMaxAgeMs: 2000, rfPct: ps.rfPct, includeCarry: ps.includeCarry,
        minExpectedNetProfit: ps.minExpectedNetProfit, safetyBuffer: ps.safetyBuffer, expectedSlippage: ps.expectedSlippage,
        optionRates, futuresRates, indicative: kind === "indicative" };
      const opps = [];
      for (const strike of w.strikes) for (const direction of M.SYNTH_DIRECTIONS) {
        opps.push(M.evaluateSynthetic({ window: w, strike, direction, quoteFor: (t) => q.get(t), params }));
      }
      const json = opps.map((o) => JSON.stringify(o));
      const sorted = M.sortOpportunities(opps.slice()).map((o) => o.key);
      evalInputs.push({ u, kind, ps: ps.name, w, q, params, opps });
      out.evaluations.push({ underlying: u, ref, eachSide, kind, params: { ...params, optionRates: undefined, futuresRates: undefined },
        quotes, opportunities: json, sorted });
    }
  }
}

// ---- IST helpers ------------------------------------------------------------------------------
out.ist = [];
const instants = ["2026-10-28T03:44:59.999Z", "2026-10-28T03:45:00Z", "2026-10-28T09:29:00Z", "2026-10-28T09:30:00Z", "2026-10-28T09:59:59Z",
  "2026-10-28T10:00:00Z", "2026-10-28T18:29:59Z", "2026-10-28T18:30:00Z", "2026-10-27T23:00:00Z", "1970-01-01T00:00:00Z"].map(Date.parse);
for (const n of instants) {
  out.ist.push({ now: n, minutes: M.istMinutesOfDay(n) });
  for (const [expiry, today] of [["2026-10-28", "2026-10-28"], ["2026-10-27", "2026-10-28"], ["2026-10-29", "2026-10-28"], ["2026-10-28", "2026-10-29"]]) {
    for (const minutes of [0, 15, 30, 400]) out.ist.push({ now: n, expiry, today, minutes, safety: M.inExpirySafetyWindow(expiry, today, n, minutes) });
    for (const open of [true, false]) out.ist.push({ now: n, expiry, today, open, past: M.isPastSettlement(expiry, today, n, open) });
  }
}

// ---- part 2: paper positions (own random stream, so part 1 stays byte-identical) --------------
seed = 0x7ade2026;
const level = (p, q) => ({ price: p, qty: q });
out.depthOf = [undefined, {}, { bids: [], asks: [] }, { bids: [level(1, 2)] },
  { bids: Array.from({ length: 7 }, (_, i) => level(100 - i, i + 1)), asks: Array.from({ length: 6 }, (_, i) => ({ price: 101 + i, qty: 10, orders: 3 })) }]
  .map((q) => ({ input: q ?? null, value: M.depthOf(q) }));
const depthBook = (t) => (t % 3 === 0 ? null : M.depthOf({ bids: [level(t % 97, 75), level((t % 97) - 0.05, 150)], asks: [level((t % 97) + 0.05, 75)] }));
out.trades = [];
const exitRules = [
  { convergenceFloor: 100, convergencePct: 0.25, minExitNetPnl: 50, profitCapturePct: 0.8, minCapturedPct: 0.9 },
  { convergenceFloor: 0, convergencePct: 0, minExitNetPnl: -1e9, profitCapturePct: 0, minCapturedPct: 0 },
  { convergenceFloor: 1e6, convergencePct: 1, minExitNetPnl: 1e6, profitCapturePct: 2, minCapturedPct: 5 },
];
let tradeN = 0;
const closedToday = [];
const openMarks = [];
for (const e of evalInputs.filter((x) => x.kind !== "indicative")) {
  for (const opp of e.opps) {
    const executable = opp.status === "ELIGIBLE" || opp.status === "WATCHING";
    if (tradeN >= 70 || rnd() >= (executable ? 0.6 : 0.03)) continue;
    const id = `trade-${tradeN++}`;
    const broker = tradeN % 2 ? "zerodha" : "dhan";
    const withDepth = tradeN % 4 !== 0;
    const opened = M.openTradeFromOpportunity({ opp, id, broker, now: NOW, day: TODAY,
      optionRateVersion: optionRates.rateVersion, futuresRateVersion: futuresRates.rateVersion, depthFor: withDepth ? depthBook : undefined });
    const rec = { u: e.u, kind: e.kind, ps: e.ps, key: opp.key, id, broker, withDepth, opened: opened ? JSON.stringify(opened) : null, exits: [] };
    out.trades.push(rec);
    if (!opened) continue;
    for (let s = 0; s < 3; s++) {
      const later = NOW + 1000 * (1 + int(600));
      const quotes = [];
      const ltps = [];
      for (const leg of opened.legs) {
        const move = (rnd() - 0.5) * leg.entry_price * 0.02;
        const fair = Math.max(0.05, leg.entry_price + move);
        const half = Math.max(0.05, Math.round(fair * 0.001 * 20) / 20);
        let bid = Math.round((fair - half) * 20) / 20, ask = Math.round((fair + half) * 20) / 20;
        let qty = opened.quantity * (1 + int(5));
        let at = later - int(500);
        const r = rnd();
        if (s === 2 && r < 0.3) bid = 0; else if (s === 2 && r < 0.45) at = later - 60_000; else if (s === 2 && r < 0.55) qty = opened.quantity - 1;
        if (!(s === 2 && r > 0.9)) quotes.push([leg.token, { bid, bid_qty: qty, ask, ask_qty: qty, last: Math.round(fair * 20) / 20, at }]);
        ltps.push([leg.token, r < 0.1 ? null : Math.round(fair * 20) / 20]);
      }
      const qm = new Map(quotes);
      const lm = new Map(ltps);
      const rules = exitRules[(tradeN + s) % exitRules.length];
      const expirySafety = s === 1;
      const m = M.evaluateSynthExit({ trade: opened, quoteFor: (t) => qm.get(t), ltpFor: (t) => (lm.has(t) ? lm.get(t) : null), now: later,
        quoteMaxAgeMs: 2000, expirySafety, rules, optionRates, futuresRates });
      const reason = m.reason ?? "MANUAL";
      const closeDepth = s === 0;
      const closed = M.closeTradeAtTouch(opened, m, reason, later + 5, "2026-10-29", closeDepth ? depthBook : undefined);
      rec.exits.push({ now: later, quotes, ltps, rules, expirySafety, metrics: JSON.stringify(m), reason, closedAt: later + 5,
        closedDay: "2026-10-29", closeDepth, closed: closed ? JSON.stringify(closed) : null });
      if (s === 0) openMarks.push({ mtm_ltp: m.mtm_ltp, gross_pnl: m.gross_pnl, net_pnl: m.net_pnl, margin: tradeN % 3 ? Math.round(rnd() * 2e7) / 100 : null });
      if (closed && s === 1 && closedToday.length < 25) {
        const c = { ...closed, margin: tradeN % 2 ? 123456.789 + tradeN : null };
        if (tradeN % 5 === 0) delete c.margin; // a row stored before margin existed
        closedToday.push(c);
      }
    }
    rec.settled = JSON.stringify(M.settleTradeAtExpiry(opened, Date.parse("2026-11-24T10:00:01Z"), "2026-11-24"));
    rec.margin = JSON.stringify(M.synthMarginOrders(opened));
    // Boundary exits: the first exit's book again, with each threshold set exactly at the
    // value it is compared with (>= and <= at equality).
    const first = rec.exits[0];
    const fm = JSON.parse(first.metrics);
    if (fm.net_pnl !== null && fm.remaining_edge !== null && fm.captured_pct !== null && fm.net_pnl > 0) {
      const qm = new Map(first.quotes);
      const lm = new Map(first.ltps);
      const E = opened.entry_net_edge;
      const boundary = [
        { convergenceFloor: fm.remaining_edge, convergencePct: 0, minExitNetPnl: fm.net_pnl, profitCapturePct: 99, minCapturedPct: 99 },
        { convergenceFloor: -1e9, convergencePct: 0, minExitNetPnl: fm.net_pnl, profitCapturePct: E === 0 ? 0 : fm.net_pnl / E, minCapturedPct: 99 },
        { convergenceFloor: -1e9, convergencePct: 0, minExitNetPnl: fm.net_pnl, profitCapturePct: 99, minCapturedPct: fm.captured_pct },
        { convergenceFloor: fm.remaining_edge, convergencePct: 0, minExitNetPnl: fm.net_pnl + 0.01, profitCapturePct: 99, minCapturedPct: 99 },
      ];
      for (const rules of boundary) {
        const m = M.evaluateSynthExit({ trade: opened, quoteFor: (t) => qm.get(t), ltpFor: (t) => (lm.has(t) ? lm.get(t) : null), now: first.now,
          quoteMaxAgeMs: 2000, expirySafety: false, rules, optionRates, futuresRates });
        const reason = m.reason ?? "MANUAL";
        const closed = M.closeTradeAtTouch(opened, m, reason, first.now + 5, "2026-10-29", undefined);
        rec.exits.push({ now: first.now, quotes: first.quotes, ltps: first.ltps, rules, expirySafety: false, metrics: JSON.stringify(m), reason,
          closedAt: first.now + 5, closedDay: "2026-10-29", closeDepth: false, closed: closed ? JSON.stringify(closed) : null, boundary: true });
      }
    }
  }
}
out.dayPnl = [];
for (const [o, c] of [[openMarks, closedToday], [[], []], [openMarks.slice(0, 3), []], [[], closedToday.slice(0, 4)]]) {
  out.dayPnl.push({ day: TODAY, open: o, closed: c.map((t) => JSON.stringify(t)), value: JSON.stringify(M.computeSynthDayPnl({ day: TODAY, open: o, closedToday: c })) });
}

// ---- config.ts (env is restored after each set) ----------------------------------------------
const envSets = [
  {},
  { SYNTH_STRIKE_LEVEL: "2", SYNTH_QUOTE_MAX_AGE_MS: "5000", SYNTH_EVAL_INTERVAL_MS: "50", SYNTH_PUBLISH_INTERVAL_MS: "-5",
    SYNTH_UNIVERSE_REFRESH_MS: "1000", SYNTH_SHARE_BOX_BUDGET: "no", SYNTH_INCLUDE_CARRY: "YES", SYNTH_ENABLE_REVERSAL: "0",
    SYNTH_MAX_OPEN_POSITIONS: "2.7", SYNTH_SIGNAL_CONFIRMATIONS: "0.4", SYNTH_MAX_PUBLISHED_OPPORTUNITIES: "5", SYNTH_FUT_STT_SELL_PCT: "0.1",
    SYNTH_FUT_CHARGE_RATE_VERSION: "  v2  ", BOX_STT_SELL_PCT: "0.2", SYNTH_DEFAULT_RF_PCT: "abc", SYNTH_MAX_TOKENS: "1200",
    SYNTH_CONVERGENCE_PCT: "0.5", SYNTH_EXPIRY_SAFETY_MINUTES: "30", BOX_BROKERAGE_PER_ORDER: "15", BOX_CHARGE_RATE_VERSION: "custom-1" },
  { SYNTH_STRIKE_LEVEL: " 1 ", SYNTH_PAPER_TRADING: "maybe", SYNTH_SKIP_EXPIRY_DAY: "TRUE", SYNTH_FUT_CHARGE_RATE_VERSION: "   ",
    SYNTH_MIN_EXPECTED_NET_PROFIT: "1e3", SYNTH_SAFETY_BUFFER: "0x10", SYNTH_EXPECTED_SLIPPAGE: "Infinity", SYNTH_ATM_HYSTERESIS: "",
    SYNTH_WINDOW_MIN_INTERVAL_MS: " 2500 ", SYNTH_LANE_TOKEN_LIMIT: "-1", SYNTH_ENABLE_CONVERSION: "false", SYNTH_REENTRY_COOLDOWN_MS: "0",
    SYNTH_MAX_UNDERLYINGS: "12", SYNTH_STRIKE_LEVEL_UNUSED: "x", SYNTH_FUT_IPFT_PER_CRORE: "0", BOX_STT_ROUND_NEAREST_RUPEE: "no" },
  { SYNTH_STRIKE_LEVEL: "7" },
];
out.config = { loads: [], clamp: [], parse: [] };
for (const env of envSets) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    out.config.loads.push({ env, config: C.loadSynthConfig(), futures: C.loadFuturesChargeRates() });
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
  }
}
for (const v of [1, 2, 3, 0, 4, "1", "2 ", "3.0", "x", true, false, null, [], [2], ["3"], {}, 1.5, -1, "", "0x3", "1e0", "  3  "]) {
  out.config.clamp.push({ input: v, value: C.clampSynthStrikeLevel(v) });
}
for (const key of C.SYNTH_SETTING_KEYS) {
  for (const v of [0, 1, 99999, 100000, 100001, 50000, 50001, 10000, 10001, -1, 0.5, 10.5, "500", " 750 ", "", "  ", "abc", null, true,
    [], {}, "1e3", "0x10", "2.5", -0]) {
    out.config.parse.push({ key, input: v, value: C.parseSynthSetting(key, v) });
  }
}

const file = path.join(here, "math_golden.json");
fs.writeFileSync(file, JSON.stringify(out, (k, v) => (typeof v === "number" && !Number.isFinite(v) ? { $num: String(v) } : v)) + "\n");
console.log(`synthetic math: ${out.chains.length} chains, ${out.windows.length} windows, ${out.evaluations.length} evaluation sets ` +
  `(${out.evaluations.reduce((n, e) => n + e.opportunities.length, 0)} opportunities), ${out.trades.length} trades ` +
  `(${out.trades.filter((t) => t.opened).length} opened, ${out.trades.reduce((n, t) => n + t.exits.filter((x) => x.closed).length, 0)} closes) -> ${file}`);
