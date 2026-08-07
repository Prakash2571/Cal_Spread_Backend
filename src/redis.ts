/**
 * Upstash Redis (REST) — the durable store behind the analytics caches.
 *
 * WHY REST OVER A CLIENT LIBRARY
 * Upstash's REST API is a single POST per pipeline, so the whole client is ~100
 * lines of `fetch` and the backend gains no dependency (and no TCP connection to
 * keep alive across PM2 restarts). Node 18+ ships global `fetch`; this project
 * runs Node 22.
 *
 * WHY IT NEVER THROWS
 * Every analytics cache still lives in memory and is still reconstructible from
 * Kite. Redis makes it survive a restart and lets multi-day history be served
 * without re-fetching hundreds of candles — it is not on the critical path. So
 * when it is unconfigured or unreachable, every call here returns a neutral value
 * and the caller carries on exactly as it did before Redis existed. A caching
 * layer must never be able to take the app down.
 *
 * COMMAND BUDGET
 * Upstash bills per command, and the free tier is a few hundred thousand a month.
 * Callers therefore batch (one pipeline per capture cycle, not one per key) and
 * only write buckets that have closed. See `pipeline()`.
 */

const REST_URL = (process.env.UPSTASH_REDIS_REST_URL ?? "").trim().replace(/\/+$/, "");
const REST_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN ?? "").trim();

/** Requests are best-effort: a slow Redis must not stall a capture tick. */
const TIMEOUT_MS = 8000;
/** After this many consecutive failures, stop trying for `COOLDOWN_MS`. */
const FAIL_THRESHOLD = 3;
const COOLDOWN_MS = 60 * 1000;
/** Keep a request body comfortably under Upstash's 1 MB REST limit. */
const MAX_BODY_BYTES = 800_000;

/** Every key this app owns is namespaced, so the database can be shared. */
export const KEY_PREFIX = "calspread:";

export type RedisCommand = (string | number)[];

let consecutiveFailures = 0;
let mutedUntil = 0;
let warnedDisabled = false;

/** Is an Upstash database configured? */
export function isRedisEnabled(): boolean {
  return Boolean(REST_URL && REST_TOKEN);
}

/**
 * Log the enabled/disabled state once, at boot.
 *
 * Silence here would be the worst outcome: an operator who typo'd the URL would
 * see a working app that quietly forgets everything on every deploy.
 */
export function logRedisStatus(): void {
  if (isRedisEnabled()) {
    let host = REST_URL;
    try {
      host = new URL(REST_URL).host;
    } catch {
      /* keep the raw string if it isn't a valid URL — the first call will fail
         loudly enough */
    }
    console.log(`[Redis] Enabled (${host}). Analytics caches will persist.`);
  } else if (!warnedDisabled) {
    warnedDisabled = true;
    console.warn(
      "[Redis] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — " +
        "analytics caches are in-memory only and will be rebuilt from Kite after " +
        "every restart.",
    );
  }
}

/**
 * Run a pipeline of commands. Returns one result per command, or null when Redis
 * is disabled, cooling down, or the request failed.
 *
 * Upstash's /pipeline endpoint takes `[[cmd, ...args], ...]` and answers
 * `[{result}|{error}, ...]` in the same order. Per-command errors do not fail the
 * request, so they are surfaced individually as null.
 */
export async function pipeline(cmds: RedisCommand[]): Promise<(unknown | null)[] | null> {
  if (!canSend() || cmds.length === 0) return null;
  // Upstash caps the REST request body (1 MB on the free tier). A backlog built up
  // during an outage can exceed that, and an over-size body fails permanently
  // rather than transiently — so split by serialized size and send in order. Any
  // chunk failing fails the whole call: the caller re-queues everything, and both
  // HSET and HDEL are idempotent, so re-sending an already-applied chunk is safe.
  const chunks = chunkBySize(cmds);
  const out: (unknown | null)[] = [];
  for (const chunk of chunks) {
    const res = await postPipeline(chunk);
    if (res === null) return null;
    out.push(...res);
  }
  return out;
}

/** Is Redis configured AND not in a failure cooldown? Cheap — no I/O. */
export function canSend(): boolean {
  return isRedisEnabled() && Date.now() >= mutedUntil;
}

/** Split commands so each request body stays under `MAX_BODY_BYTES`. */
function chunkBySize(cmds: RedisCommand[]): RedisCommand[][] {
  const chunks: RedisCommand[][] = [];
  let cur: RedisCommand[] = [];
  let bytes = 2; // the enclosing [] 
  for (const cmd of cmds) {
    const size = JSON.stringify(cmd).length + 1;
    // Never emit an empty chunk: a single oversized command still has to be tried
    // (and will fail loudly) rather than be silently dropped.
    if (cur.length > 0 && bytes + size > MAX_BODY_BYTES) {
      chunks.push(cur);
      cur = [];
      bytes = 2;
    }
    cur.push(cmd);
    bytes += size;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

async function postPipeline(
  cmds: RedisCommand[],
): Promise<(unknown | null)[] | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${REST_URL}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(cmds),
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as ({ result?: unknown; error?: string } | null)[];
    consecutiveFailures = 0;
    return json.map((entry, i) => {
      if (entry && typeof entry === "object" && "error" in entry && entry.error) {
        console.warn(`[Redis] ${cmds[i]?.[0]} failed: ${entry.error}`);
        return null;
      }
      return entry?.result ?? null;
    });
  } catch (e) {
    consecutiveFailures++;
    const msg = e instanceof Error ? e.message : String(e);
    if (consecutiveFailures >= FAIL_THRESHOLD) {
      mutedUntil = Date.now() + COOLDOWN_MS;
      console.warn(
        `[Redis] ${consecutiveFailures} consecutive failures (${msg}) — ` +
          `pausing for ${COOLDOWN_MS / 1000}s; caches stay in memory.`,
      );
      consecutiveFailures = 0;
    } else {
      console.warn(`[Redis] command failed: ${msg}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Run one command. Returns its result, or null on any failure. */
export async function command(cmd: RedisCommand): Promise<unknown | null> {
  const out = await pipeline([cmd]);
  return out ? (out[0] ?? null) : null;
}

// ---------------------------------------------------------------------------
// Typed helpers
// ---------------------------------------------------------------------------

/** Whole-value JSON get. */
export async function getJson<T>(key: string): Promise<T | null> {
  const raw = await command(["GET", KEY_PREFIX + key]);
  if (typeof raw !== "string") return null;
  return parseJson<T>(raw);
}

/** Whole-value JSON set, with an optional TTL in seconds. */
export async function setJson(
  key: string,
  value: unknown,
  ttlSec?: number,
): Promise<void> {
  const cmd: RedisCommand = ["SET", KEY_PREFIX + key, JSON.stringify(value)];
  if (ttlSec && ttlSec > 0) cmd.push("EX", Math.floor(ttlSec));
  await command(cmd);
}

export async function del(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await command(["DEL", ...keys.map((k) => KEY_PREFIX + k)]);
}

/**
 * Read a whole hash as `field -> parsed JSON`.
 *
 * Upstash returns HGETALL either as a flat [field, value, ...] array or as an
 * object depending on the deployment, so both shapes are accepted.
 */
export async function hGetAllJson<T>(key: string): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  const raw = await command(["HGETALL", KEY_PREFIX + key]);
  if (!raw) return out;
  const put = (field: unknown, value: unknown) => {
    if (typeof field !== "string" || typeof value !== "string") return;
    const parsed = parseJson<T>(value);
    if (parsed !== null) out.set(field, parsed);
  };
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) put(raw[i], raw[i + 1]);
  } else if (typeof raw === "object") {
    for (const [f, v] of Object.entries(raw as Record<string, unknown>)) put(f, v);
  }
  return out;
}

/**
 * Build (but do not run) the commands that write `entries` into a hash, drop
 * `staleFields`, and refresh the key's TTL.
 *
 * Returned rather than executed so a caller can put several hashes into ONE
 * pipeline — the difference between ~30 requests a minute and one.
 */
export function hashWriteCommands(
  key: string,
  entries: Map<string, unknown> | Record<string, unknown>,
  staleFields: string[] = [],
  ttlSec?: number | undefined,
): RedisCommand[] {
  const full = KEY_PREFIX + key;
  const cmds: RedisCommand[] = [];
  const pairs: (string | number)[] = [];
  const push = (field: string, value: unknown) => {
    pairs.push(field, JSON.stringify(value));
  };
  if (entries instanceof Map) {
    for (const [f, v] of entries) push(f, v);
  } else {
    for (const [f, v] of Object.entries(entries)) push(f, v);
  }
  if (pairs.length > 0) cmds.push(["HSET", full, ...pairs]);
  if (staleFields.length > 0) cmds.push(["HDEL", full, ...staleFields]);
  // Only worth refreshing when we touched the key; an untouched key should be
  // allowed to expire.
  if (cmds.length > 0 && ttlSec && ttlSec > 0) {
    cmds.push(["EXPIRE", full, Math.floor(ttlSec)]);
  }
  return cmds;
}

/** `SET key json EX ttl` as a command, for batching alongside hash writes. */
export function setJsonCommand(
  key: string,
  value: unknown,
  ttlSec?: number,
): RedisCommand {
  const cmd: RedisCommand = ["SET", KEY_PREFIX + key, JSON.stringify(value)];
  if (ttlSec && ttlSec > 0) cmd.push("EX", Math.floor(ttlSec));
  return cmd;
}

/** Liveness probe used at boot. Returns false when disabled or unreachable. */
export async function ping(): Promise<boolean> {
  if (!isRedisEnabled()) return false;
  const out = await command(["PING"]);
  return typeof out === "string" && out.toUpperCase() === "PONG";
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt value is worse than a missing one, so drop it rather than let a
    // parse error bubble into a capture tick.
    return null;
  }
}
