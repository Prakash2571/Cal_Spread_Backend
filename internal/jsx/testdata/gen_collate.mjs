// Records Node's String.prototype.localeCompare (ICU root collation, Node 22) on ASCII
// strings, so internal/jsx.LocaleCompare can be checked. Run from the repository root:
//
//   scratch/go-migration/check.sh node internal/jsx/testdata/gen_collate.mjs
//
// Cases: realistic NSE symbols / Synthetic keys / ISO dates, plus random strings over all
// printable ASCII and the whitespace controls, compared pairwise. Stored as [a, b, sign].
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let s = 0x1234abcd;
const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const alphabet = [];
for (let c = 32; c < 127; c++) alphabet.push(String.fromCharCode(c));
alphabet.push("\t", "\n", "\r", "\u0001", "\u007f");
const randomString = (n, chars = alphabet) => Array.from({ length: n }, () => chars[Math.floor(rnd() * chars.length)]).join("");
const realistic = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50", "M&M", "M&MFIN", "LT", "LTF", "LTIM", "BAJAJ-AUTO",
  "BAJAJFINSV", "BAJFINANCE", "L&TFH", "MCDOWELL-N", "NAM-INDIA", "J&KBANK", "ABC_X", "ABCX", "ABC.X", "ABC-X", "abc", "ABC", "Abc",
  "LT|2026-11-27|3500|CONVERSION", "LTF|2026-11-27|150|REVERSAL", "M&M|2026-11-27|3000|CONVERSION", "M&MFIN|2026-11-27|300|REVERSAL",
  "2026-10-01T06:00:10.000Z", "2026-10-01T06:00:09.999Z", "2026-11-27", "2026-11-27 ", "A B", "A-B", "A_B", "AB", "A1", "A10", "A2", ""];
const pairs = [];
for (const a of realistic) for (const b of realistic) pairs.push([a, b, Math.sign(a.localeCompare(b))]);
for (let i = 0; i < 20000; i++) {
  const a = randomString(1 + Math.floor(rnd() * 6));
  const b = rnd() < 0.3 ? a.slice(0, Math.floor(rnd() * a.length)) + randomString(1 + Math.floor(rnd() * 3)) : randomString(1 + Math.floor(rnd() * 6));
  pairs.push([a, b, Math.sign(a.localeCompare(b))]);
}
const symbolChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789&._-|".split("");
for (let i = 0; i < 20000; i++) {
  const a = randomString(1 + Math.floor(rnd() * 8), symbolChars);
  const b = rnd() < 0.5 ? a.slice(0, Math.floor(rnd() * a.length)) + randomString(1 + Math.floor(rnd() * 4), symbolChars) : randomString(1 + Math.floor(rnd() * 8), symbolChars);
  pairs.push([a, b, Math.sign(a.localeCompare(b))]);
}
writeFileSync(join(here, "collate.json"), JSON.stringify({ generated_by: "internal/jsx/testdata/gen_collate.mjs", node: process.version,
  icu: process.versions.icu, pairs }));
console.log("wrote collate.json", pairs.length, "pairs, ICU", process.versions.icu);
