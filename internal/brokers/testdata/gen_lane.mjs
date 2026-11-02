// Generates lane_cases.json from the ORIGINAL src/brokers/marketDataLane.ts.
// Run from the repo root: scratch/go-migration/check.sh node internal/brokers/testdata/gen_lane.mjs
// The class uses a TypeScript parameter property, which Node's type stripping cannot erase,
// so a copy with that one constructor rewritten is imported (the original is untouched).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
let src = readFileSync(join(root, "src/brokers/marketDataLane.ts"), "utf8");
src = src.replace(
  /constructor\(private readonly seconds = 10\) \{/,
  "private readonly seconds: number;\n  constructor(seconds = 10) {\n    this.seconds = seconds;",
);
const tmpDir = join(root, "scratch", "go-migration", "tmp");
mkdirSync(tmpDir, { recursive: true });
const tmp = join(tmpDir, "marketDataLane.copy.ts");
writeFileSync(tmp, src);
const { TickRateCounter } = await import(pathToFileURL(tmp).href);

let s = 0x1234abcd;
const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x297a2d39) | 0), (s >>> 0) / 4294967296);

const scenarios = [];
for (let n = 0; n < 60; n++) {
  const seconds = [1, 3, 10, 10, 10, 30][Math.floor(rnd() * 6)];
  const start = 1_700_000_000_000 + Math.floor(rnd() * 5000);
  const c = new TickRateCounter(seconds);
  const ops = [];
  let t = start;
  const steps = 1 + Math.floor(rnd() * 80);
  for (let i = 0; i < steps; i++) {
    t += Math.floor(rnd() * (rnd() < 0.2 ? 5000 : 700));
    if (rnd() < 0.08) {
      ops.push({ op: "reset" });
      c.reset();
    } else if (rnd() < 0.75) {
      const count = Math.floor(rnd() * 400);
      ops.push({ op: "mark", count, now: t });
      c.mark(count, t);
    } else {
      ops.push({ op: "rate", now: t, expected: c.perSecond(t) });
    }
  }
  ops.push({ op: "rate", now: t + 1000, expected: c.perSecond(t + 1000) });
  ops.push({ op: "rate", now: t + 60_000, expected: c.perSecond(t + 60_000) });
  scenarios.push({ seconds, ops });
}
writeFileSync(join(here, "lane_cases.json"), JSON.stringify({ generated_from: "src/brokers/marketDataLane.ts", scenarios }) + "\n");
console.log(`wrote ${scenarios.length} scenarios`);
