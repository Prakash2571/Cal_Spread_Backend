// Loads the Node reference (src/ticker.ts, src/kite.ts, src/hub.ts) for the golden
// generators gen_csv.mjs, gen_parsebinary.mjs and gen_ticker_messages.mjs. Run each
// through scratch/go-migration/check.sh (Node 22):
//
//   scratch/go-migration/check.sh node internal/kite/testdata/gen_parsebinary.mjs
//
// src/ticker.ts is imported directly with Node's type stripping. src/kite.ts and
// src/hub.ts use constructor parameter properties, which strip-only mode rejects, and
// hub.ts imports "./ticker.js"; for those two the loader writes a COPY under
// scratch/go-migration/tmp/ with the minimal edit and imports the copy. The originals
// are only read. kite.ts's API root is pointed at a loopback server so nothing can reach
// api.kite.trade.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../../..");
export const srcDir = path.join(repoRoot, "src");
const tmpDir = path.join(repoRoot, "scratch/go-migration/tmp/kite_golden");

function mustReplace(text, from, to, what) {
  if (!text.includes(from)) throw new Error(`loader: cannot find ${what} in the reference source`);
  return text.replace(from, to);
}

/** Writes the edited copy, imports it and removes it again. */
async function importCopy(name, text) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, text);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

export async function loadTicker() {
  return import(pathToFileURL(path.join(srcDir, "ticker.ts")).href);
}

/** kite.ts with HistoricalGate's parameter properties expanded and the API root replaced. */
export async function loadKite(apiRoot) {
  let text = fs.readFileSync(path.join(srcDir, "kite.ts"), "utf8");
  text = mustReplace(
    text,
    `  constructor(
    private readonly minGapMs = HISTORICAL_MIN_GAP_MS,
    private readonly slotTimeoutMs = HISTORICAL_SLOT_TIMEOUT_MS,
  ) {}`,
    `  private readonly minGapMs: number;
  private readonly slotTimeoutMs: number;
  constructor(minGapMs = HISTORICAL_MIN_GAP_MS, slotTimeoutMs = HISTORICAL_SLOT_TIMEOUT_MS) {
    this.minGapMs = minGapMs;
    this.slotTimeoutMs = slotTimeoutMs;
  }`,
    "HistoricalGate constructor",
  );
  text = mustReplace(
    text,
    `const KITE_API_ROOT = "https://api.kite.trade";`,
    `const KITE_API_ROOT = ${JSON.stringify(apiRoot)};`,
    "KITE_API_ROOT",
  );
  if (apiRoot.startsWith("https://api.kite.trade")) throw new Error("loader: refusing the real Kite API root");
  return importCopy(`kite.${process.pid}.ts`, text);
}

/** hub.ts with TickerHub's parameter properties expanded and ticker.ts imported by path. */
export async function loadHub() {
  let text = fs.readFileSync(path.join(srcDir, "hub.ts"), "utf8");
  text = mustReplace(
    text,
    `  constructor(
    private getCreds: () => HubCreds,
    /** Called when Zerodha rejects the feed (dead/expired token). */
    private onDead: () => void,
  ) {}`,
    `  private getCreds: () => HubCreds;
  private onDead: () => void;
  constructor(getCreds: () => HubCreds, onDead: () => void) {
    this.getCreds = getCreds;
    this.onDead = onDead;
  }`,
    "TickerHub constructor",
  );
  text = mustReplace(
    text,
    `from "./ticker.js";`,
    `from ${JSON.stringify(pathToFileURL(path.join(srcDir, "ticker.ts")).href)};`,
    "ticker import",
  );
  return importCopy(`hub.${process.pid}.ts`, text);
}

/**
 * brokers/zerodha/feed.ts (ZerodhaFeed) with both parameter properties expanded (its
 * constructor and TickRateCounter's in brokers/marketDataLane.ts) and its imports pointed
 * at src/ticker.ts and the marketDataLane copy. Both copies are removed after import.
 */
export async function loadZerodhaFeed() {
  fs.mkdirSync(tmpDir, { recursive: true });
  let lane = fs.readFileSync(path.join(srcDir, "brokers/marketDataLane.ts"), "utf8");
  lane = mustReplace(lane, "constructor(private readonly seconds = 10) {",
    "private readonly seconds: number;\n  constructor(seconds = 10) {\n    this.seconds = seconds;", "TickRateCounter constructor");
  const laneFile = path.join(tmpDir, `marketDataLane.${process.pid}.ts`);
  fs.writeFileSync(laneFile, lane);
  let feed = fs.readFileSync(path.join(srcDir, "brokers/zerodha/feed.ts"), "utf8");
  feed = mustReplace(feed, "constructor(private readonly opts: ZerodhaFeedOptions) {",
    "private readonly opts: ZerodhaFeedOptions;\n  constructor(opts: ZerodhaFeedOptions) {\n    this.opts = opts;", "ZerodhaFeed constructor");
  feed = mustReplace(feed, `from "../../ticker.js";`, `from ${JSON.stringify(pathToFileURL(path.join(srcDir, "ticker.ts")).href)};`, "ticker import");
  feed = mustReplace(feed, `from "../marketDataLane.js";`, `from ${JSON.stringify(pathToFileURL(laneFile).href)};`, "marketDataLane import");
  try {
    return await importCopy(`zerodhaFeed.${process.pid}.ts`, feed);
  } finally {
    fs.rmSync(laneFile, { force: true });
  }
}

/** Deterministic PRNG (mulberry32) so regenerated goldens are byte-identical. */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    u32: () => Math.floor(next() * 4294967296),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
  };
}

/**
 * JSON.stringify replacer that keeps values JSON cannot carry: non-finite numbers
 * become {"$num":"NaN"|"Infinity"|"-Infinity"}, Maps become {"$map":[[k,v],…]}.
 */
export function replacer(_key, value) {
  if (typeof value === "number" && !Number.isFinite(value)) {
    return { $num: Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity" };
  }
  if (value instanceof Map) return { $map: [...value.entries()] };
  return value;
}

/** Top-level arrays are written one element per line so the files diff well. */
function serialize(obj) {
  const parts = Object.keys(obj).map((k) =>
    Array.isArray(obj[k])
      ? `${JSON.stringify(k)}:[\n${obj[k].map((e) => JSON.stringify(e, replacer)).join(",\n")}\n]`
      : `${JSON.stringify(k)}:${JSON.stringify(obj[k], replacer)}`,
  );
  return `{\n${parts.join(",\n")}\n}\n`;
}

export function writeGolden(file, obj) {
  const out = path.join(here, file);
  fs.writeFileSync(out, serialize(obj));
  return out;
}

export function writeGoldenTo(dir, file, obj) {
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, file);
  fs.writeFileSync(out, serialize(obj));
  return out;
}

export const hex = (buf) => Buffer.from(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf).toString("hex");
