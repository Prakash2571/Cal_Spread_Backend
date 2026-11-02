// Generates testdata/leg_cases.json from the ORIGINAL Node implementation, so the Go
// port is checked against what Node actually computed. Run from the repository root while
// src/box/localCharges.ts still exists (Node 22.18+ strips types natively):
//
//   node internal/ratecard/testdata/gen_leg_cases.mjs
//
// The class at the end of the Node file uses a TypeScript parameter property, which type
// stripping cannot erase, and Box is gone from Go anyway, so the file is cut before it.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const src = readFileSync(join(root, "src/box/localCharges.ts"), "utf8");
const cut = src.slice(0, src.indexOf("export class LocalChargeCalculator"));
const tmpDir = join(root, "scratch", "go-migration", "tmp");
mkdirSync(tmpDir, { recursive: true });
const tmp = join(tmpDir, "localCharges.ref.ts");
writeFileSync(tmp, cut);
const m = await import(pathToFileURL(tmp).href);

// Deterministic PRNG so the file is reproducible.
let s = 0x9e3779b9;
const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x297a2d39) | 0), (s >>> 0) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const base = m.loadBoxChargeRates();
const cards = [
  base,
  { ...base, sttRoundNearestRupee: false },
  { ...base, brokerageMaxPct: 0.03 },
  { ...base, ipftPct: 0.0005, ipftPerCrore: 0 },
  { ...base, sttSellPct: 0.005, exchangeTxnPct: 0.0345, gstPct: 12.5, brokeragePerOrder: 15.5 },
  { ...base, sttSellPct: 0.0125, ipftPerCrore: 37.5, stampDutyBuyPct: 0.0015 }, // futures-style
];

const cases = [];
const add = (rates, order) => cases.push({ rates, order, expected: m.calculateLegCharges(order, rates) });

for (let i = 0; i < 700; i++) {
  const rates = pick(cards);
  const side = pick(["BUY", "SELL"]);
  const quantity = pick([1, 15, 25, 30, 50, 75, 150, 375, 1800, 100000, Math.floor(rnd() * 5000) + 1]);
  const dp = pick([0, 1, 2, 2, 2, 3, 4]);
  const price = Math.round(rnd() * 90000 * 10 ** dp) / 10 ** dp / pick([1, 1, 10, 100]);
  add(rates, { side, tradingsymbol: `SYM${i}`, quantity, price });
}
// Exact-half STT edges: 0.005% of 10000 = 0.5, 0.0125% of 80000 = 10 ... plus x.5 boundaries.
for (const value of [10000, 30000, 50000, 70000, 90000]) {
  add({ ...base, sttSellPct: 0.005 }, { side: "SELL", tradingsymbol: "HALF", quantity: 1, price: value });
}
add(base, { side: "SELL", tradingsymbol: "SMALL", quantity: 1, price: 0.05 });
add(base, { side: "BUY", tradingsymbol: "ZERO", quantity: 0, price: 100 });

writeFileSync(join(here, "leg_cases.json"), JSON.stringify({ generated_from: "src/box/localCharges.ts calculateLegCharges", cases }) + "\n");
console.log(`wrote ${cases.length} cases`);
