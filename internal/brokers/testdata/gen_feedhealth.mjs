// Generates feedhealth_cases.json from the ORIGINAL src/brokers/feedHealth.ts (pure, so
// Node 22 type stripping imports it directly).
// Run from the repo root: scratch/go-migration/check.sh node internal/brokers/testdata/gen_feedhealth.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const { computeFeedHealth } = await import(pathToFileURL(join(root, "src/brokers/feedHealth.ts")).href);

const now = 1_800_000_000_000;
const cases = [];
const bools = [false, true];
const subs = [0, 1, 7, 2200];
const universes = [null, 0, 18492];
const ticks = [null, now, now - 1, now - 250, now - 29_999, now - 30_000, now - 30_001, now - 45_678, now - 600_000, now + 5000];
const stales = [undefined, 5000, 120_000];
for (const authenticated of bools)
  for (const connected of bools)
    for (const connecting of [undefined, false, true])
      for (const subscribed of subs)
        for (const lastTickAt of ticks)
          for (const staleAfterMs of stales) {
            const universe = universes[(subscribed + (lastTickAt ?? 0)) % universes.length];
            const input = { connected, authenticated, subscribed, universe, lastTickAt, now };
            if (connecting !== undefined) input.connecting = connecting;
            if (staleAfterMs !== undefined) input.staleAfterMs = staleAfterMs;
            cases.push({ input, expected: computeFeedHealth(input) });
          }
writeFileSync(join(here, "feedhealth_cases.json"), JSON.stringify({ generated_from: "src/brokers/feedHealth.ts", cases }) + "\n");
console.log(`wrote ${cases.length} cases`);
