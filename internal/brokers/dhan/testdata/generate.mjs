// Regenerates the golden fixtures in this directory from the ORIGINAL TypeScript in
// src/brokers/dhan/ (imported unmodified), so the Go port is checked against what Node
// actually computes. Run from the repository root:
//
//   scratch/go-migration/check.sh node internal/brokers/dhan/testdata/generate.mjs
//
// Several reference files use constructor parameter properties, which Node's plain type
// stripping rejects, so the script re-launches itself under
// --experimental-transform-types and registers ts_hooks.mjs (which maps the sources'
// "./x.js" imports onto the "./x.ts" files). No source file is edited or copied.
//
// Nothing here reaches a network: fetch, WebSocket, setTimeout and Date.now are replaced
// by recording fakes wherever the reference would use them, and every host is a loopback
// or a dummy name. Fixtures are deterministic (seeded PRNG, fixed clocks), so a rerun
// rewrites byte-identical files.
import { spawnSync } from "node:child_process";
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

register(pathToFileURL(fileURLToPath(new URL("./ts_hooks.mjs", import.meta.url))).href);

// REST request shapes (bodies, headers, chunking) are recorded end to end by
// internal/brokers/registry/testdata/gen_registry.mjs, which drives this client through
// the registry; gen_margin.mjs covers the payload helpers, gen_feed.mjs the socket
// lifecycle.
const sections = ["gen_decoder.mjs", "gen_helpers.mjs", "gen_instruments.mjs", "gen_margin.mjs", "gen_feed.mjs"];
const only = process.argv.slice(2);
for (const name of sections) {
  if (only.length > 0 && !only.some((o) => name.includes(o))) continue;
  const mod = await import(new URL(`./${name}`, import.meta.url).href);
  const result = await mod.run();
  console.log(`${name}: ${JSON.stringify(result.counts)} -> ${result.written.map((p) => p.split("/").pop()).join(", ")}`);
}
