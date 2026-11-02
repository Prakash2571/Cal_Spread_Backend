// Records V8's Math.exp / Math.log / ** / Math.hypot results so internal/fairvalue/jsmath
// can be checked bit for bit. Run from the repository root:
//
//   scratch/go-migration/check.sh node internal/fairvalue/testdata/gen_jsmath.mjs
//
// Inputs come from a xorshift32 generator that the Go test reproduces exactly. For each
// function the file stores the SHA-256 of every output's IEEE-754 bits (big-endian) plus
// the first outputs verbatim (hex) so a mismatch can be located.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const view = new DataView(new ArrayBuffer(8));
const bitsOf = (x) => { view.setFloat64(0, x); return view.getBigUint64(0).toString(16).padStart(16, "0"); };
const fromWords = (h, l) => { view.setUint32(0, h); view.setUint32(4, l); return view.getFloat64(0); };

function generator(seed) {
  let s = seed >>> 0;
  const u32 = () => {
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >>> 17)) >>> 0;
    s = (s ^ (s << 5)) >>> 0;
    return s;
  };
  const unit = () => { const a = u32(); const b = u32(); return (a * 4294967296 + b) / 18446744073709551616; };
  const positiveBits = () => {
    for (;;) {
      const h = u32() & 0x7fffffff;
      const l = u32();
      if ((h >>> 20) !== 0x7ff) return fromWords(h, l);
    }
  };
  return { u32, unit, positiveBits };
}

const COUNT = 200000;
const KEEP = 1500;
const specs = {
  exp: { seed: 11, args: (g, i) => [i % 4 === 0 ? g.unit() * 1455 - 745 : i % 4 === 1 ? g.unit() * 4 - 2 : i % 4 === 2 ? g.unit() * 100 - 50 : (g.unit() - 0.5) * 1e-6], f: (x) => Math.exp(x) },
  log: { seed: 22, args: (g, i) => [i % 3 === 0 ? g.positiveBits() : i % 3 === 1 ? 1 + (g.unit() - 0.5) * 0.01 : g.unit() * 1000], f: (x) => Math.log(x) },
  cube: { seed: 33, args: (g, i) => [i % 2 === 0 ? g.unit() * 10 : g.positiveBits()], f: (x) => x ** 3 },
  pow: { seed: 44, args: (g) => [g.unit() * 100, g.unit() * 10 - 5], f: (x, y) => x ** y },
  hypot: { seed: 55, args: (g, i) => i % 2 === 0 ? [g.unit() * 4 - 2, g.unit() * 0.5] : [g.positiveBits(), g.positiveBits()], f: (a, b) => Math.hypot(a, b) },
};

const out = { generated_by: "internal/fairvalue/testdata/gen_jsmath.mjs", node: process.version, count: COUNT, functions: {} };
for (const [name, spec] of Object.entries(specs)) {
  const g = generator(spec.seed);
  const hash = createHash("sha256");
  const first = [];
  const buf = Buffer.alloc(8);
  for (let i = 0; i < COUNT; i++) {
    const args = spec.args(g, i);
    const y = spec.f(...args);
    buf.writeDoubleBE(y);
    hash.update(buf);
    if (i < KEEP) first.push([...args.map(bitsOf), bitsOf(y)]);
  }
  out.functions[name] = { seed: spec.seed, sha256: hash.digest("hex"), first };
}
// Edge values, readable.
const edges = [0, -0, 1, -1, 0.5, 2, 1e-300, 5e-324, 1e300, 709.782712893384, 709.79, -745.13321910194, -746,
  0.34657359027997264, 0.3465735902799727, 1.0397207708399179, 1.039720770839918, Infinity, -Infinity, NaN];
out.edges = {
  exp: edges.map((x) => [bitsOf(x), bitsOf(Math.exp(x))]),
  log: edges.map((x) => [bitsOf(x), bitsOf(Math.log(x))]),
  cube: edges.map((x) => [bitsOf(x), bitsOf(x ** 3)]),
  hypot: [[0, 0], [-0, 0], [1e200, 1e200], [1e-200, 1e-200], [Infinity, NaN], [NaN, Infinity], [NaN, 1], [3, 4], [-3, 4], [5e-324, 0]]
    .map(([a, b]) => [bitsOf(a), bitsOf(b), bitsOf(Math.hypot(a, b))]),
  pow: [[1, Infinity], [-1, -Infinity], [2, NaN], [NaN, 0], [0, -1], [-0, -1], [-8, 1 / 3], [-2, 3], [2, 1024], [2, -1075], [0.5, 2], [4, 0.5]]
    .map(([a, b]) => [bitsOf(a), bitsOf(b), bitsOf(a ** b)]),
};
writeFileSync(join(here, "jsmath.json"), JSON.stringify(out));
console.log("wrote jsmath.json", Object.fromEntries(Object.entries(out.functions).map(([k, v]) => [k, v.sha256.slice(0, 12)])));
