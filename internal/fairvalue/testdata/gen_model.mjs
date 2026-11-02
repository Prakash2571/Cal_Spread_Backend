// Records what the ORIGINAL Fair Value TypeScript (src/fairValue/*.ts) computes, so the
// Go model in internal/fairvalue/model can be checked bit for bit and byte for byte.
// Run from the repository root while src/ exists (Node 22 strips types natively):
//
//   scratch/go-migration/check.sh node internal/fairvalue/testdata/gen_model.mjs
//
// The model sources are COPIED to scratch/go-migration/tmp/fv-golden/ and only the
// copies are edited: "./x.js" import specifiers become "./x.ts", indexSpot.ts is copied
// next to them, and history.ts's constructor parameter property (which type stripping
// cannot erase) is expanded. tests/fairValue/fixtures.mjs is copied with its dist/
// imports pointed at the copies. Nothing touches the network or a database.
//
// Numbers that must match bit for bit are written as 16-hex-digit IEEE-754 patterns;
// structured results are written as their exact JSON.stringify text with every
// duration_ms set to 0 (it is a timing diagnostic).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const tmp = path.join(root, "scratch/go-migration/tmp/fv-golden");
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}\n');

const mustReplace = (text, from, to, what) => {
  if (!text.includes(from)) throw new Error(`gen_model: cannot find ${what}`);
  return text.split(from).join(to);
};
const files = ["normal", "black", "curve", "metadata", "iv", "svi", "optimizer", "smile", "forward", "validation",
  "quotes", "maturity", "sensitivity", "history", "pipeline", "independent", "calculator", "config", "types"];
for (const f of files) {
  let text = fs.readFileSync(path.join(root, "src/fairValue", `${f}.ts`), "utf8");
  text = text.replace(/from "\.\/([A-Za-z]+)\.js"/g, 'from "./$1.ts"');
  if (f === "metadata") text = mustReplace(text, 'from "../indexSpot.js"', 'from "./indexSpot.ts"', "indexSpot import");
  if (f === "history") {
    text = mustReplace(text, "constructor(private options: { maxBytes: number; maxUnderlyings: number; now: () => number }) {}",
      "private options: { maxBytes: number; maxUnderlyings: number; now: () => number };\n" +
      "  constructor(options: { maxBytes: number; maxUnderlyings: number; now: () => number }) { this.options = options; }",
      "SnapshotHistory constructor");
  }
  fs.writeFileSync(path.join(tmp, `${f}.ts`), text);
}
fs.copyFileSync(path.join(root, "src/indexSpot.ts"), path.join(tmp, "indexSpot.ts"));
fs.writeFileSync(path.join(tmp, "fixtures.mjs"),
  fs.readFileSync(path.join(root, "tests/fairValue/fixtures.mjs"), "utf8")
    .replace(/'\.\.\/\.\.\/dist\/fairValue\/([A-Za-z]+)\.js'/g, "'./$1.ts'"));

const load = (name) => import(pathToFileURL(path.join(tmp, name)).href);
const normal = await load("normal.ts");
const black = await load("black.ts");
const curveM = await load("curve.ts");
const metadataM = await load("metadata.ts");
const ivM = await load("iv.ts");
const sviM = await load("svi.ts");
const optimizerM = await load("optimizer.ts");
const smileM = await load("smile.ts");
const forwardM = await load("forward.ts");
const validationM = await load("validation.ts");
const quotesM = await load("quotes.ts");
const maturityM = await load("maturity.ts");
const sensitivityM = await load("sensitivity.ts");
const pipelineM = await load("pipeline.ts");
const independentM = await load("independent.ts");
const calculatorM = await load("calculator.ts");
const configM = await load("config.ts");
const fx = await load("fixtures.mjs");

// ---- helpers ----------------------------------------------------------------------------
const view = new DataView(new ArrayBuffer(8));
const h = (x) => { view.setFloat64(0, x); return view.getBigUint64(0).toString(16).padStart(16, "0"); };
const zeroDuration = (key, value) => (key === "duration_ms" ? 0 : value);
const js = (v) => JSON.stringify(v, zeroDuration);
const attempt = (fn) => { try { return { out: js(fn()) }; } catch (e) { return { error: e.message }; } };
const attemptBits = (fn) => { try { return h(fn()); } catch (e) { return `E:${e.message}`; } };
let seed = 0x5eed1234;
const rnd = () => { // mulberry32
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gauss = () => { const u = Math.max(rnd(), 1e-12); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const { NOW, EXPIRY, curve, expiryPolicy, metadata, quote, clean, chain, inputSnapshot } = fx;
const out = { generated_by: "internal/fairvalue/testdata/gen_model.mjs", node: process.version };

// ---- normal.ts ----------------------------------------------------------------------------
out.normal = [];
const specials = [0, -0, 1, -1, 8, -8, 0.9999999999999999, 1.0000000000000002, 7.999999999999999, 8.000000000000002,
  1e-300, -1e-300, 5e-324, 26, -26, 38, -38, 40, NaN, Infinity, -Infinity];
for (let i = 0; i <= 2000; i++) specials.push(-40 + i * 0.04);
for (let i = 0; i < 1500; i++) specials.push(gauss() * (i % 3 === 0 ? 10 : 2));
for (const x of specials) out.normal.push([h(x), h(normal.erf(x)), h(normal.erfc(x)), h(normal.normalCdf(x)), h(normal.normalPdf(x))]);

// ---- black.ts -------------------------------------------------------------------------------
out.black = [];
const blackRow = (f, k, d, w, side) => [h(f), h(k), h(d), h(w), side, attemptBits(() => black.blackPrice({ f, k, d, w, side }))];
for (const f of [0.5, 100, 25000]) for (const factor of [.0001, .3, .95, 1, 1.2, 10, 10000])
  for (const w of [0, 1e-30, 1e-10, .001, .04, 1, 25]) for (const d of [1.03, .98, 1]) for (const side of ["CE", "PE"])
    out.black.push(blackRow(f, f * factor, d, w, side));
for (let i = 0; i < 2500; i++) {
  const f = 10 ** (rnd() * 5);
  out.black.push(blackRow(f, f * Math.exp(gauss() * 0.6), 0.9 + rnd() * 0.15, rnd() ** 2 * 2, pick(["CE", "PE"])));
}
for (const [f, k, d, w, side] of [[100, 0, 1, .04, "CE"], [-1, 100, 1, .04, "CE"], [100, 100, 0, .04, "CE"], [100, 100, NaN, .04, "CE"],
  [100, 100, 1, -1, "CE"], [100, 100, 1, .04, "american"], [1e300, 1e10, 1e10, .04, "CE"], [Infinity, 100, 1, .04, "PE"]])
  out.black.push(blackRow(f, k, d, w, side));
out.blackFromIv = [];
for (let i = 0; i < 600; i++) {
  const f = 50 + rnd() * 100, k = f * Math.exp(gauss() * 0.3), t = i % 50 === 0 ? 0 : rnd() * 2, d = Math.exp(-0.05 * t);
  const iv = i % 60 === 0 ? -0.1 : rnd() * 1.5, side = pick(["CE", "PE"]);
  out.blackFromIv.push([h(f), h(k), h(t), h(d), h(iv), side, attemptBits(() => black.blackFromIv(f, k, t, d, iv, side))]);
}
out.greeks = [];
for (let i = 0; i < 500; i++) {
  const f = 50 + rnd() * 100, k = i % 25 === 0 ? f : f * Math.exp(gauss() * 0.3), t = i % 40 === 0 ? 0 : 0.01 + rnd() * 2;
  const d = Math.exp(-0.06 * t), w = i % 10 === 0 ? 0 : (0.05 + rnd()) ** 2 * t, side = pick(["CE", "PE"]);
  const spot = i % 3 === 0 ? null : i % 97 === 0 ? -5 : f * (0.9 + rnd() * 0.2), carry = i % 2 === 0;
  out.greeks.push({ args: [h(f), h(k), h(d), h(w), side, h(t), spot === null ? null : h(spot), carry],
    ...attempt(() => black.frozenBlackGreeks({ f, k, d, w, side, t, spot, proportionalCarry: carry })) });
}
out.settlement = [];
for (const args of [
  { strike: 100, side: "CE", lot: 75, settlement: null, indicative: 120, settlementUnderlying: "official_index_close" },
  { strike: 100, side: "CE", lot: 75, settlement: 118, indicative: 120, settlementUnderlying: "official_index_close" },
  { strike: 100, side: "PE", lot: 75, settlement: null, indicative: null, settlementUnderlying: "official_stock_settlement" },
  { strike: 100, side: "PE", lot: 50, settlement: 0, indicative: 99, settlementUnderlying: "official_stock_settlement" },
  { strike: 100, side: "PE", lot: 50.5, settlement: null, indicative: 99, settlementUnderlying: "x" },
  { strike: 100, side: "CE", lot: 50, settlement: -1, indicative: 99, settlementUnderlying: "x" },
  { strike: 0, side: "CE", lot: 50, settlement: null, indicative: 99, settlementUnderlying: "x" },
]) out.settlement.push({ args, ...attempt(() => black.settlementPayoff(args)) });
out.yearFraction = [];
for (const [e, v] of [["2027-01-01T00:00:00Z", "2026-01-01T00:00:00Z"], [Date.parse("2026-10-01T10:00:00Z") + 1000, "2026-10-01T10:00:00Z"],
  ["2026-11-01", "2026-10-01"], ["2026-11-01T10:00:00", "2026-10-01T10:00:00Z"], ["2026-11-17T15:30:00+05:30", NOW],
  ["2026-02-30T10:00:00Z", NOW], [NOW + 12345.678, NOW], ["2026-11-17T10:00:00.5Z", "2026-10-01T06:00:00.123+01:00"]])
  out.yearFraction.push({ args: [typeof e === "number" ? h(e) : e, typeof v === "number" ? h(v) : v], bits: attemptBits(() => black.yearFraction(e, v)) });

// ---- iv.ts ----------------------------------------------------------------------------------
out.iv = [];
const ivCase = (a) => {
  const args = { ...a };
  for (const key of ["f", "k", "t", "d", "price", "tick", "uncertainty"]) if (typeof args[key] === "number") args[key] = h(args[key]);
  out.iv.push({ args, out: js(ivM.invertIv(a)) });
};
for (const side of ["CE", "PE"]) for (const k of [80, 100, 120]) for (const t of [.05, .5, 2]) for (const iv of [.2, .5, 1])
  ivCase({ f: 100, k, t, d: 1.01, price: black.blackFromIv(100, k, t, 1.01, iv, side), side, tick: 1e-8 });
const ivBase = { f: 100, k: 100, t: .5, d: .98, price: 8, side: "CE", tick: .01 };
for (const patch of [{ price: 100 }, { price: 98 }, { price: 0 }, { t: 0 }, { f: Infinity }, { side: "american" },
  { uncertainty: -1 }, { uncertainty: NaN }, { tick: 0 },
  { config: { ...ivM.DEFAULT_IV_CONFIG, max_volatility: .01 } }, { config: { ...ivM.DEFAULT_IV_CONFIG, max_iterations: 1 } },
  { config: { ...ivM.DEFAULT_IV_CONFIG, initial_high: 0 } }, { t: 1e308 }])
  ivCase({ ...ivBase, ...patch });
ivCase({ ...ivBase, k: 150, t: .01, d: .99, price: black.blackFromIv(100, 150, .01, .99, 1, "CE"), tick: 1e-12, uncertainty: 1 });
for (let i = 0; i < 600; i++) {
  const f = 100 * Math.exp(gauss() * .1), k = f * Math.exp(gauss() * .4), t = 0.002 + rnd() * 2, d = Math.exp(-.05 * t);
  const side = pick(["CE", "PE"]), iv = .03 + rnd() * 1.5, fair = black.blackFromIv(f, k, t, d, iv, side);
  const price = i % 7 === 0 ? Math.max(0, fair - 0.05) : i % 11 === 0 ? fair + 0.05 : fair * (1 + gauss() * 1e-4);
  const tick = pick([.05, .01, 1e-8]);
  const a = { f, k, t, d, price, side, tick };
  if (i % 2 === 0) a.uncertainty = pick([tick / 2, 0.05, 1]);
  if (i % 13 === 0) a.config = { ...ivM.DEFAULT_IV_CONFIG, max_iterations: 40, initial_high: 2 };
  ivCase(a);
}

// ---- svi.ts ---------------------------------------------------------------------------------
const sviParams = [{ a: .012, b: .09, rho: -.4, m: .015, eta: .15 }, { a: -.0410, b: .1331, m: .3586, rho: .3060, eta: .4153 },
  { a: .01, b: .06, rho: -.4, m: .01, eta: .15 }, { a: .02, b: .02, rho: -.1, m: 0, eta: .2 }];
for (let i = 0; i < 36; i++) sviParams.push({ a: (rnd() - .4) * .1, b: rnd() * .6, rho: (rnd() * 2 - 1) * .99, m: (rnd() - .5) * .6, eta: .005 + rnd() * .5 });
out.sviPoints = [];
out.sviDiagnose = [];
for (const p of sviParams) {
  for (let i = 0; i < 25; i++) {
    const k = i === 0 ? p.m : (rnd() - .5) * 4;
    const dv = sviM.sviDerivatives(p, k);
    out.sviPoints.push([p, h(k), h(sviM.sviVariance(p, k)), h(dv.w), h(dv.first), h(dv.second), dv.g === null ? null : h(dv.g), sviM.basicSviConstraints(p)]);
  }
  const observedK = Array.from({ length: 3 + Math.floor(rnd() * 15) }, () => (rnd() - .5) * 1.2);
  const cfg = rnd() < .2 ? { ...configM.DEFAULT_SMILE_CONFIG, diagnostic_points: 51, adaptive_depth: 6 } : configM.DEFAULT_SMILE_CONFIG;
  out.sviDiagnose.push({ p, observedK: observedK.map(h), config: cfg, out: js(sviM.diagnoseSvi(p, observedK, cfg)) });
}

// ---- optimizer.ts ----------------------------------------------------------------------------
out.optimizer = [];
const objectives = {
  rosenbrock: (p) => (1 - p[0]) ** 2 + 100 * (p[1] - p[0] * p[0]) ** 2,
  shiftedSquares: (p) => p.reduce((sum, v, i) => sum + (v - (i + 1) * 0.3) ** 2, 0),
  nanLeft: (p) => (p[0] < 0 ? NaN : (p[0] - 0.7) ** 2 + (p[1] + 0.2) ** 2),
};
for (const [name, start, bounds, steps, maxIterations, tolerance] of [
  ["rosenbrock", [-1.2, 1], [[-2, 2], [-1, 3]], [.1, .1], 500, 1e-10],
  ["rosenbrock", [0, 0], [[-2, 2], [-1, 3]], [.12, .15], 80, 1e-7],
  ["shiftedSquares", [0, 0, 0, 0, 0], [[-1, 1], [-1, 1], [-1, 1], [-1, 1], [-1, 1]], [.12, .15, .15, .12, .12], 700, 1e-7],
  ["shiftedSquares", [0.9, 0.9, 0.9], [[0, 1], [0, 1], [0, 1]], [.2, .2, .2], 300, 1e-12],
  ["nanLeft", [0.1, 0.5], [[-1, 1], [-1, 1]], [.3, .3], 200, 1e-9],
]) out.optimizer.push({ name, start, bounds, steps, maxIterations, tolerance,
  out: js(optimizerM.boundedNelderMead({ objective: objectives[name], start, bounds, steps, maxIterations, tolerance })) });

// ---- quotes.ts ------------------------------------------------------------------------------
out.cleanQuote = [];
const policyVariants = [quotesM.DEFAULT_QUOTE_POLICY, { ...quotesM.DEFAULT_QUOTE_POLICY, zero_bid_policy: "exclude" },
  { ...quotesM.DEFAULT_QUOTE_POLICY, tick_floor: .001, premium_floor: 1, max_relative_spread: 1 }];
const inst100 = metadata(100);
const baseQuote = quote(inst100.token, 5);
const quotePatches = [{}, { bid: null }, { ask: NaN }, { bid: 7 }, { ask: 20 }, { bid_depth: 0 }, { bid_depth: 1.5 },
  { exchange_timestamp: new Date(NOW - 31_000).toISOString() }, { receive_timestamp: new Date(NOW + 30_000).toISOString() },
  { exchange_timestamp: null }, { bid: 0, bid_depth: 0 }, { bid: 0, ask_depth: 0 }, { token: 1 }, { version: -1 },
  { exchange_timestamp: "invalid_exchange_timestamp" }, { receive_timestamp: "2026-10-01" }, { bid: 5, ask: 5 }];
for (const policy of policyVariants) for (const patch of quotePatches) {
  const q = { ...baseQuote, ...patch };
  out.cleanQuote.push({ metadata: inst100, quote: q, now: h(NOW), policy, ...attempt(() => quotesM.cleanQuote(inst100, q, NOW, policy)) });
}
out.cleanQuote.push({ metadata: inst100, quote: null, now: h(NOW), policy: quotesM.DEFAULT_QUOTE_POLICY,
  ...attempt(() => quotesM.cleanQuote(inst100, undefined, NOW, quotesM.DEFAULT_QUOTE_POLICY)) });
for (let i = 0; i < 250; i++) {
  const mid = 0.5 + rnd() * 200, spread = rnd() * mid * .4;
  const q = { ...baseQuote, bid: Math.max(0, mid - spread / 2), ask: mid + spread / 2, bid_depth: Math.floor(rnd() * 300),
    ask_depth: Math.floor(rnd() * 300), exchange_timestamp: rnd() < .2 ? null : new Date(NOW - Math.floor(rnd() * 40000)).toISOString(),
    receive_timestamp: new Date(NOW - Math.floor(rnd() * 35000) + 500).toISOString() };
  const policy = pick(policyVariants);
  out.cleanQuote.push({ metadata: inst100, quote: q, now: h(NOW), policy, ...attempt(() => quotesM.cleanQuote(inst100, q, NOW, policy)) });
}
out.coherent = [];
for (const quotes of [[clean(1, 5), clean(2, 5, { quote_timestamp: new Date(NOW - 20_000).toISOString() })],
  [], [clean(1, 5, { calibration_eligible: false })], [clean(1, 5), clean(1, 5, { quote_timestamp: new Date(NOW - 20_000).toISOString() }),
    clean(3, 7, { quote_timestamp: new Date(NOW - 9_000).toISOString() })]])
  out.coherent.push({ quotes, out: js(quotesM.coherentSnapshot(quotes, quotesM.DEFAULT_QUOTE_POLICY)) });

// ---- forward.ts ------------------------------------------------------------------------------
out.weightedMedian = [];
for (let i = 0; i < 200; i++) {
  const n = Math.floor(rnd() * 9);
  const values = Array.from({ length: n }, () => ({ value: rnd() < .05 ? NaN : gauss() * 10, weight: rnd() < .15 ? 0 : rnd() < .05 ? Infinity : rnd() * 3 }));
  out.weightedMedian.push({ values: values.map((v) => [h(v.value), h(v.weight)]), bits: attemptBits(() => forwardM.weightedMedian(values)) });
}
out.huber = [];
for (let i = 0; i < 200; i++) { const v = gauss() * 4, dl = .1 + rnd() * 3; out.huber.push([h(v), h(dl), h(forwardM.huber(v, dl))]); }
out.forward = [];
const forwardCase = (name, input, extra = {}) => out.forward.push({ name, metadata: input.metadata, quotes: input.quotes, d: h(input.d),
  config: extra.config ?? null, excludeStrike: extra.excludeStrike ?? null,
  ...attempt(() => forwardM.estimateOptionsForward({ ...input, ...extra })) });
{
  const input = chain([70, 85, 95, 100, 105, 120, 150]);
  const outlier = input.quotes.find((q) => q.token === metadata(150).token);
  outlier.mid += 100; outlier.bid += 100; outlier.ask += 100;
  forwardCase("outlier", input);
  forwardCase("exclude", chain([90, 100, 110]), { excludeStrike: 100 });
  const incoherent = chain([80, 90, 100, 110]);
  incoherent.quotes[0].quote_timestamp = new Date(NOW - 5_000).toISOString();
  forwardCase("incoherent", incoherent);
  forwardCase("single", chain([100]));
  forwardCase("noRefine", chain([80, 90, 100, 110, 120], 103, .3, .97, .25), { config: { ...forwardM.DEFAULT_FORWARD_CONFIG, refine: false } });
}
for (let i = 0; i < 40; i++) {
  const strikes = Array.from({ length: 3 + Math.floor(rnd() * 12) }, (_, j) => 60 + j * (5 + Math.floor(rnd() * 3)));
  const input = chain(strikes, 90 + rnd() * 20, .05 + rnd(), Math.exp(-.06 * rnd()), .1 + rnd() * .5);
  for (const q of input.quotes) {
    const noise = gauss() * 0.02;
    q.mid += noise; q.bid += noise; q.ask += noise;
    if (rnd() < .05) { q.mid += 5; q.bid += 5; q.ask += 5; }
    if (rnd() < .05) q.weight = 0;
    if (rnd() < .03) q.freshness_basis = "receive";
  }
  if (rnd() < .2) input.metadata.pop();
  forwardCase(`random${i}`, input, i % 5 === 0 ? { config: { ...forwardM.DEFAULT_FORWARD_CONFIG, min_pairs: 2, outlier_scale: 2 } } : {});
}
out.resolve = [];
{
  const unavailableInput = chain([100]);
  const carry = { source: "verified carry test", as_of: curve.as_of, version: "v1", convention: "deterministic carry",
    verified: true, proportional: true, dividend_yield: .02, dividends: [], corporate_actions: [] };
  const base = { expiry: EXPIRY, now: NOW, curve, futures: [{ expiry_timestamp: "2026-12-17T10:00:00Z", quote: clean(1, 104) }],
    spot: { value: 100, timestamp: new Date(NOW - 100).toISOString() }, carry: null, maxAgeMs: 30_000 };
  const dividendTime = "2026-10-15T03:45:00Z";
  const dividends = [{ timestamp: dividendTime, amount: 2 }, { timestamp: "2027-01-01T00:00:00Z", amount: 1000 }];
  for (const [name, patch] of [["noCarry", {}], ["futures", { futures: [{ expiry_timestamp: EXPIRY, quote: clean(1, 101) }] }],
    ["futuresNonPositive", { futures: [{ expiry_timestamp: EXPIRY, quote: clean(1, 0) }, { expiry_timestamp: EXPIRY, quote: clean(2, 101) }] }],
    ["proportional", { carry }], ["discrete", { carry: { ...carry, proportional: false, dividend_yield: null, dividends } }],
    ["corporateAction", { carry: { ...carry, corporate_actions: ["2026-10-10T00:00:00Z"] } }],
    ["staleSpot", { carry, spot: { value: 100, timestamp: new Date(NOW - 60_000).toISOString() } }],
    ["futureSpot", { carry, spot: { value: 100, timestamp: new Date(NOW + 60_000).toISOString() } }],
    ["noCurve", { carry, curve: { ...curve, flat_rate: null, allow_flat_fallback: false } }],
    ["badDividend", { carry: { ...carry, proportional: false, dividend_yield: null, dividends: [{ timestamp: "junk", amount: 1 }] } }]]) {
    const args = { ...base, ...patch };
    out.resolve.push({ name, chain: { metadata: unavailableInput.metadata, quotes: unavailableInput.quotes, d: h(unavailableInput.d) },
      args: { ...args, now: h(args.now) },
      ...attempt(() => forwardM.resolveForward({ ...args, options: forwardM.estimateOptionsForward(unavailableInput) })) });
  }
}

// ---- validation.ts ---------------------------------------------------------------------------
out.priceGrid = [];
{
  const values = new Map([[80, 25], [100, 12], [103, 9.6]].map(([k, price]) => {
    const iv = ivM.invertIv({ f: 100, k, t: 1, d: 1, price, side: "CE", tick: 1e-8 });
    return [k, iv.iv ** 2];
  }));
  out.priceGrid.push({ kind: "roundedMap", map: [...values].map(([k, w]) => [k, h(w)]), f: h(100), d: h(1), strikes: [80, 100, 103].map(h), tick: h(.001),
    config: configM.DEFAULT_SMILE_CONFIG, out: js(validationM.validatePriceGrid({ f: 100, d: 1, strikes: [80, 100, 103], tick: .001,
      variance: (k) => values.get(Math.round(100 * Math.exp(k))) ?? null, config: configM.DEFAULT_SMILE_CONFIG })) });
}
for (let i = 0; i < 30; i++) {
  const p = sviParams[i % sviParams.length], f = 80 + rnd() * 40, d = .95 + rnd() * .1, tick = pick([.001, .05, 1e-8]);
  const strikes = Array.from({ length: 2 + Math.floor(rnd() * 20) }, () => (i % 9 === 0 && rnd() < .1 ? -5 : f * Math.exp((rnd() - .5) * 1.5)));
  const cfg = i % 4 === 0 ? { ...configM.DEFAULT_SMILE_CONFIG, price_tolerance_ticks: 0 } : configM.DEFAULT_SMILE_CONFIG;
  out.priceGrid.push({ kind: "svi", p, f: h(f), d: h(d), strikes: strikes.map(h), tick: h(tick), config: cfg,
    out: js(validationM.validatePriceGrid({ f, d, strikes, tick, variance: (k) => sviM.sviVariance(p, k), config: cfg })) });
}
out.priceGrid.push({ kind: "svi", p: sviParams[0], f: h(100), d: h(1), strikes: [], tick: h(.01), config: configM.DEFAULT_SMILE_CONFIG,
  out: js(validationM.validatePriceGrid({ f: 100, d: 1, strikes: [], tick: .01, variance: () => .04, config: configM.DEFAULT_SMILE_CONFIG })) });
out.priceGrid.push({ kind: "svi", p: sviParams[0], f: h(100), d: h(0), strikes: [h(100)], tick: h(.01), config: configM.DEFAULT_SMILE_CONFIG,
  out: js(validationM.validatePriceGrid({ f: 100, d: 0, strikes: [100], tick: .01, variance: () => .04, config: configM.DEFAULT_SMILE_CONFIG })) });
out.intermediate = [];
for (let i = 0; i < 60; i++) {
  const strikes = Array.from({ length: Math.floor(rnd() * 8) }, () => Math.round(rnd() * 40) * 2.5 + 50);
  const sub = pick([4, 8, 1, 3]);
  out.intermediate.push({ strikes, sub, out: validationM.intermediateStrikes(strikes, sub).map(h) });
}

// ---- smile.ts ---------------------------------------------------------------------------------
const sviObservations = (p, count = 19, noise = 0, f = 100, d = .98, t = .5) => Array.from({ length: count }, (_, i) => {
  const k = -.3 + i * .6 / (count - 1);
  const strike = f * Math.exp(k), w = sviM.sviVariance(p, k);
  const side = k < 0 ? "PE" : "CE";
  const mid = Math.max(.001, black.blackPrice({ f, k: strike, d, w, side }) + noise * gauss());
  const quote = clean(i + 1, mid, { h: .05, bid: mid - .05, ask: mid + .05, weight: noise ? .5 + rnd() * .5 : 1 });
  return { strike, k, w, iv: Math.sqrt(w / t), side, token: i + 1, quote, dependence_factor: 1 };
});
out.smile = [];
const smileCase = (name, fn, observations, f, d, config) => out.smile.push({ name, fn, observations, f: h(f), d: h(d), config,
  ...attempt(() => smileM[fn](observations, f, d, config)) });
{
  const C = configM.DEFAULT_SMILE_CONFIG;
  const obs = sviObservations({ a: .01, b: .06, rho: -.4, m: .01, eta: .15 });
  smileCase("knownSvi", "fitSvi", obs, 100, .98, C);
  smileCase("knownSmile", "fitSmile", obs, 100, .98, C);
  smileCase("knownInterp", "fitInterpolation", obs, 100, .98, C);
  const sparse = sviObservations({ a: .02, b: .02, rho: -.1, m: 0, eta: .2 }, 5);
  smileCase("sparse", "fitSmile", sparse, 100, .98, C);
  smileCase("two", "fitSmile", sparse.slice(0, 2), 100, .98, C);
  smileCase("interpModel", "fitSmile", obs, 100, .98, { ...C, model: "interpolation" });
  smileCase("eightStarts", "fitSvi", obs, 100, .98, { ...C, optimizer_starts: 8 });
  smileCase("tightRmse", "fitSmile", sviObservations({ a: .01, b: .06, rho: -.4, m: .01, eta: .15 }, 19, .2), 100, .98, { ...C, max_normalized_rmse: .1 });
  smileCase("fewIterations", "fitSmile", obs, 100, .98, { ...C, optimizer_iterations: 20 });
  for (let i = 0; i < 8; i++) {
    const p = { a: .005 + rnd() * .02, b: .02 + rnd() * .15, rho: (rnd() - .6) * 1.2, m: (rnd() - .5) * .1, eta: .05 + rnd() * .3 };
    smileCase(`random${i}`, "fitSmile", sviObservations(p, 11 + Math.floor(rnd() * 15), rnd() < .5 ? .01 : 0), 100, .98, C);
  }
}

// ---- sensitivity.ts ----------------------------------------------------------------------------
out.sensitivity = [];
for (const args of [{ f: 100, strike: 100, t: .5, d: .98, iv: .2, side: "CE", forwardDispersion: 1, rateBump: .0025, quoteIvBid: .19, quoteIvAsk: .21 },
  { f: 100, strike: 90, t: .5, d: .98, iv: .2, side: "PE", forwardDispersion: null, rateBump: 0, quoteIvBid: null, quoteIvAsk: null },
  { f: 100, strike: 90, t: .5, d: .98, iv: .2, side: "PE", forwardDispersion: 200, rateBump: .0125, quoteIvBid: -1, quoteIvAsk: null },
  { f: 100, strike: 90, t: .5, d: .98, iv: .2, side: "CE", forwardDispersion: 0, rateBump: .05, quoteIvBid: null, quoteIvAsk: .3,
    alternativePrice: { iv: .25, forward: 101, label: "Alt" } }]) {
  out.sensitivity.push({ args: { ...args, f: h(args.f), strike: h(args.strike), t: h(args.t), d: h(args.d), iv: h(args.iv) }, ...attempt(() => sensitivityM.modelSensitivity(args)) });
}

// ---- metadata.ts / curve.ts --------------------------------------------------------------------
out.utc = [];
for (const v of ["2026-10-01T10:00:00Z", "2026-10-01T10:00:00.5Z", "2026-10-01T10:00:00.123+05:30", "2026-10-01T10:00:00.1234Z",
  "2026-10-01T10:00:00", "2026-10-01", "2026-02-30T10:00:00Z", "2026-02-29T10:00:00Z", "2028-02-29T10:00:00Z", "2026-10-01T24:00:00Z",
  "2026-10-01T23:59:60Z", "2026-10-01T10:00:00+24:00", "2026-10-01T10:00:00-05:61", "2026-10-01 10:00:00Z", "2026-13-01T10:00:00Z",
  "0000-01-01T00:00:00Z", "9999-12-31T23:59:59.999-23:59", "2026-10-01T10:00:00z", 5, null])
  out.utc.push([v, metadataM.utcTimestamp(v), typeof v === "string" ? metadataM.validDate(v.slice(0, 10)) : null]);
out.optionMetadata = [];
{
  const inst = { instrument_token: 123, name: "NIFTY", tradingsymbol: "NIFTY-HOLIDAY-CE", exchange: "NFO",
    instrument_type: "CE", expiry: "2026-11-16", lot_size: 75, tick_size: .05, strike: 25000 };
  const overridePolicy = { ...expiryPolicy, overrides: { "NIFTY-HOLIDAY-CE": "2026-11-16T15:00:00+05:30" } };
  for (const [policy, patch] of [[null, {}], [expiryPolicy, {}], [null, { expiry_timestamp: "2026-11-16T10:10:00Z" }],
    [expiryPolicy, { exercise_style: "american" }], [overridePolicy, {}], [expiryPolicy, { exchange: "NSE" }], [expiryPolicy, { instrument_type: "FUT" }],
    [expiryPolicy, { lot_size: 0 }], [expiryPolicy, { strike: NaN }], [expiryPolicy, { expiry: "2026-02-30" }], [null, { expiry: "2026-11-16T15:30:00+05:30" }],
    [expiryPolicy, { name: "  " }], [expiryPolicy, { name: "reliance" }], [expiryPolicy, { expiry_timestamp: "bad" }], [expiryPolicy, { instrument_token: 1.5 }]]) {
    const i = { ...inst, ...patch };
    out.optionMetadata.push({ inst: { ...i, strike: h(i.strike) }, policy, out: js(metadataM.resolveOptionMetadata(i, policy, "v1")) });
  }
}
out.discount = [];
{
  const spec = { ...curve, nodes: [{ t: .5, zero_rate: -.02 }, { t: 1, zero_rate: -.03 }], allow_flat_fallback: false };
  const cases = [[spec, .75], [spec, 0], [spec, .5], [spec, .25], [spec, 2], [curve, 1], [curve, 0], [curve, -1],
    [{ ...curve, nodes: [{ t: 1, zero_rate: .03 }, { t: 1, zero_rate: .05 }] }, .5], [{ ...curve, nodes: [{ t: 0, zero_rate: .1 }, { t: 2, zero_rate: .05 }] }, 1],
    [{ ...curve, flat_rate: 800, nodes: [] }, 2], [{ ...curve, convention: "simple" }, 1], [{ ...curve, source: " " }, 1]];
  for (let i = 0; i < 40; i++) {
    const nodes = [];
    let t = 0;
    for (let j = 0; j < 1 + Math.floor(rnd() * 6); j++) { t += .05 + rnd() * .5; nodes.push({ t, zero_rate: (rnd() - .3) * .1 }); }
    cases.push([{ ...curve, nodes, flat_rate: rnd() < .5 ? .06 : null, allow_flat_fallback: rnd() < .6 }, rnd() * (t + .5)]);
  }
  for (const [s, t] of cases) out.discount.push({ spec: s, t: h(t), ...attempt(() => curveM.discountAt(s, t)) });
}

// ---- config.ts --------------------------------------------------------------------------------
const FIXED_MS = Date.parse("2026-10-27T12:00:00.123Z");
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(FIXED_MS); else super(...a); }
  static now() { return FIXED_MS; }
}
const withFixedClock = (fn) => { globalThis.Date = FixedDate; try { return fn(); } finally { globalThis.Date = RealDate; } };
const configResult = (fn) => { try { const c = fn(); return { version: configM.configVersion(c), out: JSON.stringify(c) }; } catch (e) { return { error: e.message }; } };
out.config = { fixedMs: h(FIXED_MS), env: [], merge: [] };
for (const env of [{}, { FAIR_VALUE_ENABLED: "true" }, { FAIR_VALUE_ENABLED: "TRUE" }, { FAIR_VALUE_CONFIG_JSON: "   " },
  { FAIR_VALUE_CONFIG_JSON: '{"enabled": true, "max_tokens": 300}' }, { FAIR_VALUE_CONFIG_JSON: "{bad" },
  { FAIR_VALUE_CONFIG_JSON: '{"nope": 1}' }, { FAIR_VALUE_CONFIG_JSON: "[1]" }, { FAIR_VALUE_CONFIG_JSON: '{"quote": {"max_age_ms": 1}}' },
  { FAIR_VALUE_CONFIG_JSON: '{} x' }, { FAIR_VALUE_CONFIG_JSON: "" }])
  out.config.env.push({ env, ...withFixedClock(() => configResult(() => configM.defaultConfig(env))) });
const baseConfig = withFixedClock(() => configM.defaultConfig({}));
const carrySpec = (over = {}) => ({ source: "carry src", as_of: "2026-10-01T05:30:00+05:30", version: "c1", convention: "deterministic carry",
  verified: true, proportional: true, dividend_yield: .015, dividends: [], corporate_actions: [], ...over });
const mergePatches = [
  {}, { enabled: true }, { enabled: "true" }, { workers: 100 }, { workers: 2 }, { max_tokens: 20.5 }, { max_tokens: -0 },
  { quote: { max_age_ms: Infinity } }, { quote: { max_age_ms: 45_000, zero_bid_policy: "exclude" } }, { quote: { tick_floor: 0 } },
  { quote: { zero_bid_policy: "sometimes" } }, { quote: { nope: 1 } }, { quote: 5 }, { quote: [] }, { quote: null }, { smile: { min_svi_strikes: 5 } },
  { smile: { model: "interpolation", optimizer_starts: 8 } }, { smile: { model: "sabr" } }, { iv: { max_iterations: 300, price_tolerance: 1e-14 } },
  { forward: { refine: "yes" } }, { forward: { min_pairs: 2, refine: false } },
  JSON.parse('{"__proto__":{"enabled":true}}'), { constructor: {} }, { zzz: 1, quote: 5 }, JSON.parse('{"zzz":1,"1":2}'),
  { curve: { as_of: "2026-10-01" } }, { curve: { as_of: "2026-10-01T12:00:00+05:30" } },
  { curve: { nodes: [{ t: .25, zero_rate: .06, note: "x" }, { t: 1, zero_rate: .065 }], flat_rate: .07, allow_flat_fallback: true } },
  { curve: { nodes: [{ zero_rate: .06, t: .25 }] } }, { curve: { nodes: [{ t: 1, zero_rate: .03 }, { t: 1, zero_rate: .05 }] } },
  { curve: { nodes: "" } }, { curve: { nodes: "ab" } }, { curve: { nodes: 5 } }, { curve: { nodes: {} } }, { curve: { nodes: null } },
  { curve: { nodes: [null] } }, { curve: { nodes: [5] } }, { curve: { source: 5 } }, { curve: { source: null } }, { curve: { source: [] } },
  { curve: { flat_rate: "0.05" } }, { curve: { allow_flat_fallback: 1 } }, { curve: { convention: "simple" } }, { curve: { nope: 1 } },
  { curve: { nodes: Array.from({ length: 101 }, (_, i) => ({ t: i + 1, zero_rate: .05 })) } },
  { expiry_policy: expiryPolicy }, { expiry_policy: { ...expiryPolicy, overrides: { "NIFTY26NOVFUT": "2026-11-26T15:30:00+05:30" } } },
  { expiry_policy: { ...expiryPolicy, local_time: "25:00:00" } }, { expiry_policy: { ...expiryPolicy, local_time: ["15:30:00"] } },
  { expiry_policy: { ...expiryPolicy, overrides: "" } }, { expiry_policy: { ...expiryPolicy, overrides: "ab" } },
  { expiry_policy: { ...expiryPolicy, overrides: ["2026-11-26T15:30:00+05:30"] } }, { expiry_policy: { ...expiryPolicy, overrides: null } },
  { expiry_policy: { ...expiryPolicy, overrides: 5 } }, { expiry_policy: { ...expiryPolicy, overrides: { "": "2026-11-26T15:30:00Z" } } },
  { expiry_policy: { ...expiryPolicy, overrides: { X: "2026-11-26" } } }, { expiry_policy: { ...expiryPolicy, source: 5 } },
  { expiry_policy: { ...expiryPolicy, exchange: "NSE" } }, { expiry_policy: "NFO" }, { expiry_policy: [] }, { expiry_policy: null },
  { carry: { NIFTY: carrySpec() } }, { carry: { "123": carrySpec(), NIFTY: carrySpec({ extra: true }) } },
  { carry: { NIFTY: carrySpec({ dividend_yield: null, proportional: false, dividends: [{ timestamp: "2026-11-01T00:00:00+05:30", amount: 5, note: 1 }] }) } },
  { carry: { NIFTY: carrySpec({ dividends: [{ timestamp: "2026-11-01T00:00:00Z", amount: 5 }] }) } },
  { carry: { NIFTY: carrySpec({ dividend_yield: 0, dividends: [{ timestamp: "2026-11-01T00:00:00Z", amount: 5 }] }) } },
  { carry: { NIFTY: carrySpec({ dividends: [null] , dividend_yield: null }) } }, { carry: { NIFTY: carrySpec({ dividends: [5], dividend_yield: null }) } },
  { carry: { NIFTY: carrySpec({ dividend_yield: null, dividends: [{ timestamp: "2026-11-01T00:00:00Z", amount: -1 }] }) } },
  { carry: { NIFTY: carrySpec({ corporate_actions: ["2026-11-01T00:00:00+05:30"] }) } }, { carry: { NIFTY: carrySpec({ corporate_actions: ["2026-11-01"] }) } },
  { carry: { NIFTY: carrySpec({ dividend_yield: 3 }) } }, { carry: { NIFTY: carrySpec({ dividend_yield: undefined }) } },
  { carry: { NIFTY: carrySpec({ source: 7 }) } }, { carry: { NIFTY: carrySpec({ verified: "yes" }) } }, { carry: { "": carrySpec() } },
  { carry: { NIFTY: null } }, { carry: { NIFTY: 5 } }, { carry: [] }, { carry: null }, { carry: "x" },
  { carry: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`U${i}`, carrySpec()])) },
  { maturity_extrapolation: "constant_short_end_and_forward_variance", research_enabled: true, max_maturity_extrapolation_days: 40 },
  { maturity_extrapolation: "always" }, { forward_interpolation: "log_carry_assumption", proportional_calendar_assumption: true },
  { recenter_log_distance: .0005 }, { history_memory_max_bytes: 1048576 }, { sensitivity_rate_bump: .06 }, null, 5, "x", [1],
];
for (const patch of mergePatches) {
  // JSON.parse(JSON.stringify(...)) drops undefined members the way an HTTP body would.
  const body = patch === undefined ? undefined : JSON.parse(JSON.stringify(patch) ?? "null");
  out.config.merge.push({ patch: body, ...configResult(() => configM.mergeConfig(baseConfig, body)) });
}

// ---- pipeline / maturity / calculator / independent --------------------------------------------
const expiries3 = ["2026-10-20T10:00:00Z", "2026-11-17T10:00:00Z", "2026-12-15T10:00:00Z"];
const skew = (strike) => .3 - .12 * Math.log(strike / 100) + .25 * Math.log(strike / 100) ** 2;
const inputs = {};
inputs.default = inputSnapshot();
inputs.interpolation = inputSnapshot({ configPatch: { smile: { ...inputSnapshot().config.smile, model: "interpolation" } } });
inputs.calendar = inputSnapshot({ expiries: expiries3, configPatch: { proportional_calendar_assumption: true, forward_interpolation: "log_carry_assumption" } });
inputs.research = inputSnapshot({ expiries: expiries3, configPatch: { proportional_calendar_assumption: true, forward_interpolation: "log_carry_assumption",
  research_enabled: true, maturity_extrapolation: "constant_short_end_and_forward_variance", max_maturity_extrapolation_days: 40 } });
{
  const input = inputSnapshot(); input.config.expiry_policy = null; input.instruments.forEach((i) => { delete i.expiry_timestamp; });
  inputs.unverified = input;
}
{
  const input = inputSnapshot();
  const target = input.instruments.filter((i) => i.strike === 100).map((i) => i.instrument_token);
  const call = input.quotes.find((q) => q.token === target[0]); call.bid += 20; call.ask += 20;
  inputs.incoherent = input;
  const dup = structuredClone(input); dup.instruments.push({ ...dup.instruments[0], instrument_token: 99999 });
  inputs.duplicate = dup;
}
inputs.skew = inputSnapshot({ strikes: Array.from({ length: 17 }, (_, i) => 60 + i * 5), iv: skew });
inputs.skewCalendar = inputSnapshot({ strikes: Array.from({ length: 13 }, (_, i) => 70 + i * 5), expiries: expiries3, iv: (s, t) => skew(s) + .05 * t,
  configPatch: { proportional_calendar_assumption: true, forward_interpolation: "log_carry_assumption" } });
{ const input = inputSnapshot(); input.universe = { ...input.universe, captured_contracts: 18, listed_contracts: 40, bounded: true }; inputs.bounded = input; }
{ const input = inputSnapshot(); input.valuation_time = "2026-11-18T00:00:00.000Z"; inputs.expired = input; }
{
  const input = inputSnapshot({ strikes: [95, 100] });
  input.futures = [{ expiry_timestamp: "2026-11-17T10:00:00.000Z", quote: { ...input.quotes[0], token: 777, bid: 100.4, ask: 100.6 }, tick_size: .05 }];
  input.config.expiry_policy = { ...input.config.expiry_policy };
  input.instruments.forEach((i) => { i.expiry_timestamp = "2026-11-17T10:00:00.000Z"; });
  inputs.futures = input;
}
{
  const input = inputSnapshot({ strikes: [95, 100] });
  input.config.carry = { TEST: { source: "verified test carry", as_of: "2026-10-01T00:00:00.000Z", version: "v1", convention: "continuous yield",
    verified: true, proportional: true, dividend_yield: .01, dividends: [], corporate_actions: [] } };
  input.spot = { value: 100, timestamp: new Date(NOW - 500).toISOString(), exchange_timestamp: new Date(NOW - 500).toISOString(),
    receive_timestamp: new Date(NOW - 400).toISOString(), freshness_basis: "exchange" };
  input.spot_provenance = { exchange_timestamp: input.spot.exchange_timestamp, receive_timestamp: input.spot.receive_timestamp, freshness_basis: "exchange" };
  inputs.carry = input;
}
{ const input = inputSnapshot(); input.config.curve = { ...input.config.curve, flat_rate: null, allow_flat_fallback: false }; inputs.noCurve = input; }
{ const input = inputSnapshot({ strikes: [80, 90, 100, 110, 120] }); inputs.small = input; }
out.pipeline = [];
const surfaces = {};
for (const [name, input] of Object.entries(inputs)) {
  let surfaceOut;
  try { surfaces[name] = pipelineM.buildSurface(input); surfaceOut = { out: js(surfaces[name]) }; } catch (e) { surfaceOut = { error: e.message }; }
  out.pipeline.push({ name, input, ...surfaceOut });
}
const request = (expiry = "2026-11-01T10:00:00Z", strike = 100, research_mode = false, side = "CE") => ({ underlying: "TEST", strike, expiry_timestamp: expiry, side, research_mode });
out.calculate = [];
const calcCase = (name, inputName, req, surface = surfaces[inputName]) => out.calculate.push({ name, input: inputName, request: req,
  ...attempt(() => calculatorM.calculate(inputs[inputName], surface, req)) });
calcCase("interpolated", "calendar", request());
calcCase("listed", "calendar", request(expiries3[1]));
calcCase("listedPut", "calendar", request(expiries3[1], 105, false, "PE"));
calcCase("hypotheticalStrike", "calendar", request(expiries3[1], 102));
calcCase("now", "calendar", request(new Date(NOW).toISOString()));
calcCase("skewInterp", "skewCalendar", request("2026-11-30T10:00:00Z", 93));
calcCase("skewListed", "skewCalendar", request(expiries3[0], 85, false, "PE"));
calcCase("longNoResearch", "research", request("2026-12-30T10:00:00Z"));
calcCase("long", "research", request("2026-12-30T10:00:00Z", 100, true));
calcCase("tooLong", "research", request("2027-06-30T10:00:00Z", 100, true));
calcCase("short", "research", request("2026-10-10T10:00:00Z", 100, true));
calcCase("strikeExtrap", "research", request(expiries3[1], 200, true));
calcCase("strikeExtrapNear", "research", request(expiries3[1], 128, true));
calcCase("unsupportedCarry", "default", request("2026-11-01T10:00:00Z"));
calcCase("wrongUnderlying", "calendar", { ...request(), underlying: "OTHER" });
calcCase("badRequest", "calendar", { ...request(), strike: "100" });
{
  const surface = structuredClone(surfaces.calendar);
  surface.slices[1].smile.nodes.forEach((n) => { n.w *= .1; });
  if (surface.slices[1].smile.parameters) { surface.slices[1].smile.parameters.a *= .1; surface.slices[1].smile.parameters.b *= .1; }
  surface.calendar_regions = maturityM.buildCalendarRegions(surface.slices, inputs.calendar);
  out.crossing = { regions: js(surface.calendar_regions) };
  calcCase("crossing", "calendar", request(), surface);
  const research = structuredClone(surfaces.research);
  const last = research.slices[2];
  last.smile.nodes.forEach((n) => { n.w *= .1; });
  if (last.smile.parameters) { last.smile.parameters.a *= .1; last.smile.parameters.b *= .1; }
  calcCase("negativeForwardVariance", "research", request("2026-12-30T10:00:00Z", 100, true), research);
}
{
  const [a, b] = surfaces.calendar.slices;
  const t = (a.t + b.t) / 2;
  out.totalVariance = [];
  for (const k of [-.2, -.05, 0, .03, .1, .4]) {
    const v = maturityM.totalVarianceBetween(a, b, t, k, inputs.calendar.config);
    out.totalVariance.push([h(t), h(k), v === null ? null : h(v)]);
  }
}
out.independent = [];
const indCase = (name, input, expiry, strike) => out.independent.push({ name, input, expiry, strike: h(strike),
  ...attempt(() => independentM.independentEstimate(input, expiry, strike)) });
indCase("default100", inputs.default, inputs.default.instruments[0].expiry, 100);
{
  const changed = structuredClone(inputs.default);
  const tokens = changed.instruments.filter((i) => i.strike === 100).map((i) => i.instrument_token);
  changed.quotes.filter((q) => tokens.includes(q.token)).forEach((q) => { q.bid *= 10; q.ask *= 10; });
  indCase("changed100", changed, changed.instruments[0].expiry, 100);
}
indCase("sparse", inputSnapshot({ strikes: [95, 100, 105] }), "2026-11-17", 100);
indCase("edge80", inputs.default, "2026-11-17", 80);
indCase("missing", inputs.default, "2026-11-17", 101);
indCase("badStrike", inputs.default, "2026-11-17", -1);
indCase("skew", inputs.skew, "2026-11-17", 85);
out.calculatorRequests = [];
for (const v of [request(), { ...request(), underlying: "nifty-50&co" }, { ...request(), input_snapshot_id: "abc-123" },
  { ...request(), input_snapshot_id: "bad id" }, { ...request(), input_snapshot_id: 5 }, { ...request(), side: "American" },
  { ...request(), strike: 0 }, { ...request(), research_mode: "false" }, { ...request(), expiry_timestamp: "2026-11-01" },
  { ...request(), underlying: "X".repeat(41) }, null, 5, [], "x"])
  out.calculatorRequests.push({ value: v, ...attempt(() => calculatorM.validateCalculatorRequest(v)) });

fs.writeFileSync(path.join(here, "model_golden.json"), JSON.stringify(out));
fs.rmSync(tmp, { recursive: true, force: true });
console.log("wrote model_golden.json", Object.fromEntries(Object.entries(out).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length])));
