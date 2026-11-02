// Loads the NIFTY OI analytics of the ORIGINAL src/index.ts for the golden generator
// (gen_analytics.mjs). src/index.ts cannot be imported (it listens on a port, connects to
// MongoDB/Redis and registers signal handlers at load), so this copies the analytics
// segments VERBATIM into a module under scratch/go-migration/tmp/analytics/ with:
//
//   - the real src/redis.ts (a fresh instance per load), talking to an in-memory Upstash
//     emulation through a fake global fetch (only the fake URL is accepted);
//   - the real src/indexSpot.ts and src/trackedTimers.ts;
//   - stubs for brokerManager / kite / history / app / delay, provided by the generator;
//   - Date, setTimeout/setInterval and console replaced by controllable fakes.
//
// The segments are located by marker lines and the load fails if a marker is missing or
// ambiguous, so a changed src/index.ts cannot silently produce a different golden.
// src/ is only read. Run through scratch/go-migration/check.sh (Node 22 type stripping).
import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../../..");
const srcDir = path.join(repoRoot, "src");
const tmpDir = path.join(repoRoot, "scratch/go-migration/tmp/analytics");
export const FAKE_UPSTASH = "http://fake-upstash.invalid";

function segment(text, start, end, what) {
  const a = text.indexOf(start);
  if (a < 0 || text.indexOf(start, a + 1) >= 0) throw new Error(`harness: start marker of ${what} not found exactly once`);
  const b = text.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`harness: end marker of ${what} not found`);
  return text.slice(a, b);
}

const SEGMENTS = [
  ["requireMarketData + zerodhaCaptureAllowed", "function requireMarketData(res: Response, what: string): boolean {", "/**\n * Broker-neutral historical candles."],
  ["state, frames, Redis layer, chain snapshots, warm load", 'const OPTION_OI_UNDERLYING = "NIFTY";', "// Dividend yields (%) from Yahoo, refreshed once a day."],
  ["IST helpers", "/** Calendar day in IST (UTC+5:30) as YYYY-MM-DD — defaults to right now. */", "/** Simple delay helper to avoid rate-limiting on consecutive Kite API calls. */"],
  ["analytics routes", "interface OptionStrikeRow {", "// ============================================================================\n//  Spread stats"],
  ["capture, backfill, scheduler", "async function getAllInstrumentsCached(): Promise<Instrument[]> {", "/** Persist the Zerodha access token so it survives a restart (best-effort). */"],
];

const EXPORTS = `
export const H = {
  get optionOiDay() { return optionOiDay; }, set optionOiDay(v) { optionOiDay = v; },
  get optionPrevClose() { return optionPrevClose; }, set optionPrevClose(v) { optionPrevClose = v; },
  oiFrameStores, futOiFrameStores, futOiKnownContracts, partialRepairs, headRepairs, ttlRefreshedAt,
  get futOiContracts() { return futOiContracts; }, set futOiContracts(v) { futOiContracts = v; },
  get chainMinuteSnaps() { return chainMinuteSnaps; }, set chainMinuteSnaps(v) { chainMinuteSnaps = v; },
  get chainHourSnaps() { return chainHourSnaps; }, set chainHourSnaps(v) { chainHourSnaps = v; },
  get prevCloseAttempts() { return prevCloseAttempts; },
  get pendingHashWrites() { return pendingHashWrites; },
  get pendingPlainWrites() { return pendingPlainWrites; },
  get flushInFlight() { return flushInFlight; },
  get flushAgain() { return flushAgain; },
  get oiBackfillRunning() { return oiBackfillRunning; },
  get futOiBackfillRunning() { return futOiBackfillRunning; },
  get prevCloseBackfillRunning() { return prevCloseBackfillRunning; },
  get closedDayLogged() { return closedDayLogged; },
  OI_FRAMES, OI_FRAME_KEYS, redisKeys,
  istDayKey, istDateTime, istTimeOnDayMs, sessionOpenMs, sessionCloseMs, isPreOpenBucket, bucketEndMs,
  candleEndMs, isIstMarketHours, isQuoteFromToday, nearestStrikeIndex, pinStrikeWindow, inWindow, frameLadder,
  currentWindowAgg, appendOiFrameLive, downsampleAgg, mergeOiFrame, coarsenSourceFor, collapseToBuckets,
  persistWholeFrame, coarsenOiFrame, coarsenFutOiFrame, coarsenFrames, oiBackfillFromMs, partialRepairFromMs,
  missingHeadMs, backfillOiFrames, niftyMonthlyFutures, rememberFutContracts, appendFutOiFrameLive,
  mergeFutOiFrame, futOiBackfillFromMs, captureFuturesOi, backfillFutOiFrames, startOptionOiCapture,
  niftyNearestExpiryOptions, captureOptionOi, snapshotPrevClose, persistPrevClose, backfillPrevClose,
  upsertSnapshot, recordChainSnapshot, chainBaselineAt, chainSnapshotSpan, mergeWarmLoaded,
  mergeWarmLoadedSnaps, warmLoadFromRedis, queueHashField, queueHashDrop, queuePlainWrite, flushRedisWrites,
  startRedisFlushRetry, requeueFailedWrites, frameTtlSec, maxFrameRetentionMs, parseFrameKey, completedBuckets,
  triggerPostLoginBackfill, zerodhaCaptureAllowed, requireMarketData, sendError,
};
`;

let instance = 0;

/**
 * Builds the module text: imports, stubs bound to globalThis.__analyticsEnv, the verbatim
 * segments, and the H accessor object.
 */
function buildModule(n) {
  const text = fs.readFileSync(path.join(srcDir, "index.ts"), "utf8");
  const url = (f) => JSON.stringify(pathToFileURL(path.join(srcDir, f)).href);
  const head = `
import { hGetAllJson, hashWriteCommands, canSend, isRedisEnabled, logRedisStatus, pipeline, setJsonCommand,
  getJson as redisGetJson, ping as redisPing } from ${JSON.stringify(pathToFileURL(path.join(srcDir, "redis.ts")).href + "?instance=" + n)};
import { resolveIndexSpotSymbol } from ${url("indexSpot.ts")};
import { trackInterval } from ${url("trackedTimers.ts")};
const E = globalThis.__analyticsEnv;
const brokerManager = E.brokerManager;
const kite = E.kite;
const history = E.history;
const KiteError = E.KiteError;
const clearKiteSession = E.clearKiteSession;
const app = E.app;
const delay = E.delay;
let hourlyBackfillDeps = null;
let eodBackfillDeps = null;
const backfillMissedHours = async () => {};
const backfillStockFutures = async () => {};
const checkAndRecomputeSummary = async () => {};
`;
  const body = SEGMENTS.map(([what, a, b]) => `// ---- ${what} (src/index.ts, verbatim) ----\n` + segment(text, a, b, what)).join("\n");
  return head + body + EXPORTS;
}

/** Imports a fresh copy (its own module state and its own redis.ts state). */
export async function loadAnalytics(env) {
  const n = ++instance;
  globalThis.__analyticsEnv = env;
  fs.mkdirSync(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `index_analytics.${process.pid}.${n}.ts`);
  fs.writeFileSync(file, buildModule(n));
  try {
    return (await import(pathToFileURL(file).href)).H;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Fakes shared by every instance.

const RealDate = Date;
export const clock = { now: 0 };
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(clock.now);
    else super(...args);
  }
  static now() {
    return clock.now;
  }
}
globalThis.Date = FakeDate;

/** Recorded timers: setTimeout/setInterval never fire on their own. */
export const timers = { seq: 0, list: [] };
globalThis.setTimeout = (fn, ms, ...args) => {
  const id = { id: ++timers.seq, kind: "timeout", ms, fn: () => fn(...args), at: clock.now, unref() { return this; } };
  timers.list.push(id);
  return id;
};
globalThis.setInterval = (fn, ms, ...args) => {
  const id = { id: ++timers.seq, kind: "interval", ms, fn: () => fn(...args), at: clock.now, unref() { return this; } };
  timers.list.push(id);
  return id;
};
globalThis.clearTimeout = globalThis.clearInterval = (h) => {
  const i = timers.list.indexOf(h);
  if (i >= 0) timers.list.splice(i, 1);
};

/** Console capture. */
export const logs = [];
console.log = console.warn = console.error = (...a) => logs.push(util.format(...a));

/** In-memory Upstash /pipeline emulation with Redis semantics for the commands used. */
export class FakeRedis {
  constructor() {
    this.keys = new Map(); // key -> {hash: Map|undefined, value: string|undefined, expiresAt: number|null}
    this.bodies = [];
    this.failNext = 0;
  }
  live(key) {
    const k = this.keys.get(key);
    if (k && k.expiresAt !== null && clock.now >= k.expiresAt) {
      this.keys.delete(key);
      return undefined;
    }
    return k;
  }
  exec(cmd) {
    const [op, key, ...args] = cmd;
    switch (op) {
      case "PING": return { result: "PONG" };
      case "GET": {
        const k = this.live(key);
        return { result: k && k.value !== undefined ? k.value : null };
      }
      case "SET": {
        let expiresAt = null;
        if (args[1] === "EX") expiresAt = clock.now + Number(args[2]) * 1000;
        this.keys.set(key, { value: String(args[0]), expiresAt });
        return { result: "OK" };
      }
      case "HSET": {
        let k = this.live(key);
        if (!k || !k.hash) {
          k = { hash: new Map(), expiresAt: k ? k.expiresAt : null };
          this.keys.set(key, k);
        }
        let added = 0;
        for (let i = 0; i + 1 < args.length; i += 2) {
          if (!k.hash.has(String(args[i]))) added++;
          k.hash.set(String(args[i]), String(args[i + 1]));
        }
        return { result: added };
      }
      case "HDEL": {
        const k = this.live(key);
        if (!k || !k.hash) return { result: 0 };
        let n = 0;
        for (const f of args) if (k.hash.delete(String(f))) n++;
        if (k.hash.size === 0) this.keys.delete(key);
        return { result: n };
      }
      case "EXPIRE": {
        const k = this.live(key);
        if (!k) return { result: 0 };
        k.expiresAt = clock.now + Number(args[0]) * 1000;
        return { result: 1 };
      }
      case "HGETALL": {
        const k = this.live(key);
        const out = [];
        if (k && k.hash) for (const [f, v] of k.hash) out.push(f, v);
        return { result: out };
      }
    }
    return { error: `ERR unknown command ${op}` };
  }
  /** Seeds a hash or a plain value directly (not through the pipeline). */
  seed(key, { fields, value, ttlSec }) {
    const expiresAt = ttlSec ? clock.now + ttlSec * 1000 : null;
    if (fields) this.keys.set(key, { hash: new Map(fields), expiresAt });
    else this.keys.set(key, { value, expiresAt });
  }
  dump() {
    const out = [];
    for (const key of [...this.keys.keys()].sort()) {
      const k = this.live(key);
      if (!k) continue;
      out.push([key, {
        ttlMs: k.expiresAt === null ? null : k.expiresAt - clock.now,
        ...(k.hash ? { fields: [...k.hash.entries()].sort(fieldOrder) } : { value: k.value }),
      }]);
    }
    return out;
  }
}

/** Numeric fields ascending, then the non-numeric ones by code unit (a total order). */
function fieldOrder(a, b) {
  const x = Number(a[0]);
  const y = Number(b[0]);
  const nx = Number.isNaN(x);
  const ny = Number.isNaN(y);
  if (nx || ny) return nx - ny || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return x - y;
}

export const redis = { current: new FakeRedis() };
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith(FAKE_UPSTASH)) throw new Error(`harness: refusing to fetch ${url}`);
  const cmds = JSON.parse(init.body);
  const r = redis.current;
  r.bodies.push(cmds);
  if (r.failNext > 0) {
    r.failNext--;
    return { ok: false, status: 503, text: async () => "fake outage", json: async () => ({}) };
  }
  const out = cmds.map((c) => r.exec(c));
  return { ok: true, status: 200, json: async () => out };
};
process.env.UPSTASH_REDIS_REST_URL = FAKE_UPSTASH;
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";

/** Lets every pending promise chain run (all fakes resolve without timers). */
export async function drain(rounds = 200) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
