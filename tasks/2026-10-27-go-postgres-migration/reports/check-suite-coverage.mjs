// Validate the kept-case accounting and Go references in the audited report.
// This is a document-completeness check, not a substitute for assertion review
// or go test. It reads the original Node suites without modifying them.
// Run from the backend root:
//   scratch/go-migration/check.sh node tasks/2026-10-27-go-postgres-migration/reports/check-suite-coverage.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const report = fs.readFileSync(path.join(here, "2026-11-02-kept-suite-audit.md"), "utf8");
const aliases = new Map([...report.matchAll(/^\| ([A-Z0-9]+) \| `(internal\/[\w/.-]+_test\.go)` \|$/gm)].map((m) => [m[1], m[2]]));
const fv = ["auth", "hardening", "independent", "market", "maturity", "pipeline", "pricing", "service", "storage", "svi"];
const box = ["adminToken", "boundedCache", "brokerIdentity", "dhanActiveNoKite", "dhanBoardJoin", "dhanFeedDecoder", "dhanMarginAndIp", "dhanSupport", "indexSpot", "localCharges", "marketDataLanes", "marketDataTransport", "shutdown", "singleBroker", "subscriptionCoordinator", "tickerHubLifecycle", "tokenRouteAuth", "trackedTimers", "math", "migrationFixtures", "depthReadiness", "serialize"];
const expected = new Map();
const sourceTests = (file) => {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  const cases = [];
  for (const [index, line] of text.split("\n").entries()) {
    const m = /^test\((['"])(.*?)\1/.exec(line);
    if (m) cases.push({ title: m[2], line: index + 1 });
  }
  return cases;
};
for (const suite of fv) {
  const file = `tests/fairValue/${suite}.test.mjs`;
  expected.set(file, sourceTests(file).map((c) => c.title));
}
for (const suite of box) {
  const file = `tests/box/${suite}.test.mjs`;
  let cases = sourceTests(file);
  switch (suite) {
    case "brokerIdentity": cases = cases.filter((c) => !c.title.startsWith("serializeBoxTrade")); break;
    case "dhanActiveNoKite": cases = cases.filter((c) => !c.title.startsWith("createLiveAdapter")); break;
    case "dhanSupport": cases = cases.filter((c) => c.line < 179 || c.line > 246); break;
    case "localCharges": cases = cases.filter((c) => !c.title.startsWith("totals()")); break;
    case "singleBroker": cases = cases.filter((c) => !/^(switching is REFUSED|ALL blockers|createLiveAdapter)/.test(c.title)); break;
    case "math": cases = cases.filter((c) => c.line <= 90); break;
    case "depthReadiness": cases = cases.filter((c) => !/^(walkDepth|queued feed stamp|engine reconnect)/.test(c.title)); break;
    case "serialize": cases = cases.filter((c) => c.line >= 230); break;
    case "migrationFixtures": {
      const fixture = JSON.parse(fs.readFileSync(path.join(root, "tests/migration-fixtures/box/charges.json"), "utf8"));
      if (!Array.isArray(fixture.cases) || fixture.cases.length !== 2) throw new Error("charges.json must retain its two original cases");
      cases = [{ title: `charges.json: ${fixture.cases.length} case(s) match the current implementation` }];
      break;
    }
  }
  expected.set(file, cases.map((c) => c.title));
}

const rows = new Map();
let current;
for (const line of report.split("\n")) {
  const heading = /^## `(tests\/.*\.test\.mjs)`/.exec(line);
  if (heading) {
    current = heading[1];
    if (!expected.has(current) || rows.has(current)) throw new Error(`unexpected or duplicate suite: ${current}`);
    rows.set(current, new Map());
    continue;
  }
  if (!current || !line.startsWith('| "')) continue;
  const [titleCell, status, evidence, reason] = line.split("|").slice(1, 5).map((cell) => cell.trim());
  const title = titleCell.slice(1, -1);
  if (!titleCell.endsWith('"') || rows.get(current).has(title)) throw new Error(`bad or duplicate title: ${current}: ${title}`);
  if (!["COVERED", "PORTED", "N/A"].includes(status)) throw new Error(`unfinished classification: ${current}: ${title}`);
  const refs = [...evidence.matchAll(/(internal\/[\w/.-]+_test\.go|[A-Z0-9]+)::(Test\w+)/g)];
  if (status !== "N/A" && refs.length === 0) throw new Error(`missing Go evidence: ${current}: ${title}`);
  if (status === "N/A" && reason.length < 30) throw new Error(`missing N/A rationale: ${current}: ${title}`);
  for (const [, ref, fn] of refs) {
    const file = aliases.get(ref) ?? ref;
    const text = fs.readFileSync(path.join(root, file), "utf8");
    if (!new RegExp(`^func ${fn}\\(`, "m").test(text)) throw new Error(`Go reference does not exist: ${file}::${fn}`);
  }
  rows.get(current).set(title, status);
}
const totals = { COVERED: 0, PORTED: 0, "N/A": 0 };
let fvCount = 0, boxCount = 0;
for (const [file, titles] of expected) {
  const listed = rows.get(file);
  if (!listed || listed.size !== titles.length) throw new Error(`case count mismatch: ${file}: listed ${listed?.size ?? 0}, expected ${titles.length}`);
  for (const title of titles) {
    if (!listed.has(title)) throw new Error(`missing original case: ${file}: ${title}`);
    totals[listed.get(title)]++;
  }
  if (file.startsWith("tests/fairValue/")) fvCount += titles.length;
  else boxCount += titles.length;
}
if (fvCount !== 42 || boxCount !== 290) throw new Error(`inventory drift: Fair Value ${fvCount}, shared suites ${boxCount}`);
console.log(`32 suites, ${fvCount + boxCount} kept cases accounted for (Fair Value ${fvCount}, shared ${boxCount}).`);
console.log(`${totals.COVERED} already covered; ${totals.PORTED} completed/strengthened in this session; ${totals["N/A"]} explicitly N/A. All referenced Go tests exist.`);

// Freeze the already verified source specification before the approved Node
// retirement. The output is generated reference data, never an edited test.
if (process.argv.includes("--freeze")) {
  const revision = execFileSync("git", ["rev-parse", "1ea1d95"], { cwd: root, encoding: "utf8" }).trim();
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const pinned = (file) => {
    const bytes = fs.readFileSync(path.join(root, file));
    const original = execFileSync("git", ["show", `${revision}:${file}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    if (!bytes.equals(original)) throw new Error(`reference source changed: ${file}`);
    return bytes;
  };
  const suites = [...expected].map(([file, titles]) => ({ file, sha256: digest(pinned(file)), titles }));
  const output = path.join(root, "internal/parity/testdata");
  const save = (name, value) => {
    const file = path.join(output, name);
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  };
  save("kept-suites.json", { reference_commit: revision, fair_value_cases: fvCount, shared_cases: boxCount, totals, suites });

  const index = pinned("src/index.ts").toString("utf8");
  const start = index.indexOf("new ShutdownCoordinator({");
  const end = index.indexOf("\n});", start);
  if (start < 0 || end < 0) throw new Error("the reference shutdown coordinator is missing");
  const steps = [...index.slice(start, end).matchAll(/name: "([^"]+)"/g)].map((m) => m[1]);
  save("shutdown.json", { reference_commit: revision, source: "src/index.ts", source_sha256: digest(Buffer.from(index)), steps });

  const routes = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (path.relative(root, full) === "src/box") continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        const source = path.relative(root, full);
        const text = pinned(source).toString("utf8");
        const mount = text.match(/app\.use\(\s*["'`]([^"'`]+)["'`]\s*,\s*router\s*\)/);
        for (const m of text.matchAll(/\b(app|router|r)\.(get|post|patch|put|delete)\(\s*(\[[^\]]*\]|["'`][^"'`]*["'`])/g)) {
          for (const [, route] of m[3].matchAll(/["'`]([^"'`]*)["'`]/g)) {
            if (!route.startsWith("/")) continue;
            const fullRoute = m[1] === "router" && mount ? mount[1] + (route === "/" ? "" : route) : route;
            routes.push({ method: m[2].toUpperCase(), path: fullRoute, source });
          }
        }
      }
    }
  };
  walk(path.join(root, "src"));
  if (routes.length !== 83) throw new Error(`reference route count is ${routes.length}, expected 83`);
  save("routes.json", { reference_commit: revision, routes });
  console.log("Frozen original retained suites, 83 routes and shutdown contract under internal/parity/testdata.");
}
