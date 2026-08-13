import "dotenv/config";
import {
  hGetAllJson,
  hashWriteCommands,
  canSend,
  isRedisEnabled,
  logRedisStatus,
  pipeline,
  setJsonCommand,
  getJson as redisGetJson,
  ping as redisPing,
  type RedisCommand,
} from "./redis.js";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import {
  KiteClient,
  KiteError,
  type ChargeOrder,
  type Instrument,
  type OrderCharges,
} from "./kite.js";
import { TickerHub } from "./hub.js";
import type { Tick } from "./ticker.js";
import { rateLimit } from "./ratelimit.js";
import { getDividendYields } from "./yahoo.js";
import {
  initDb,
  isDbEnabled,
  isValidId,
  Trade,
  saveKiteSession,
  loadKiteSession,
  clearKiteSession,
  saveRfRate,
  loadRfRate,
  saveAdminSession,
  loadAdminSessions,
  deleteAdminSession,
  appendTradeLog,
  initTradeLogConnection,
} from "./db.js";
import type {
  ILegCharges,
  ITrade,
  ITradeCharges,
  ITradeLogLeg,
  TradeRecord,
} from "./db.js";
import { initNseFnoConnections } from "./db.js";
import { SpreadSummary } from "./db.js";
import { startHourlyScheduler, backfillMissedHours, startDayReviewScheduler } from "./hourlyCapture.js";
import { startEodScheduler, backfillStockFutures, checkAndRecomputeSummary } from "./eodCapture.js";

const PORT = Number(process.env.PORT ?? 3001);
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "";
// Separate password for the trade-only access route (/admin/access).
const ACCESS_SECRET = process.env.ACCESS_SECRET ?? "";
// Shared secret for the internal token-sharing endpoint used by the local
// market_data recorder to reuse this app's Zerodha session (no second API key).
const INTERNAL_TOKEN_SECRET = process.env.INTERNAL_TOKEN_SECRET ?? "";
// Passcode for the public, curl-friendly token route (GET /api/kite/token).
// Anyone who knows this passcode can fetch the current Zerodha access token
// once the admin has connected Zerodha — handy for scripts/tools without a UI.
const TOKEN_ROUTE_SECRET = process.env.TOKEN_ROUTE_SECRET ?? "";

const kite = new KiteClient({
  apiKey: process.env.KITE_API_KEY ?? "",
  apiSecret: process.env.KITE_API_SECRET ?? "",
});

// One shared Kite WebSocket fanned out to all SSE clients (keeps us within
// Zerodha's per-key connection limit no matter how many visitors watch).
const tickerHub = new TickerHub(
  () => ({ apiKey: kite.getApiKey(), accessToken: kite.getAccessToken() }),
  () => {
    // Token was rejected by Zerodha — clear both memory and the persisted copy
    // so we don't restore a dead token on the next restart.
    kite.clearSession();
    void clearKiteSession();
  },
);

// Capture-scheduler deps, held at module scope so a login (which happens after
// startup) can immediately trigger a backfill of any slots missed while down.
let hourlyBackfillDeps: Parameters<typeof backfillMissedHours>[0] | null = null;
let eodBackfillDeps: Parameters<typeof backfillStockFutures>[0] | null = null;

// The risk-free rate (%) the full admin last entered in the UI. Synced from the
// admin panel so it can be read back via GET /api/rf (same passcode as the
// token route). null until an admin has set it at least once.
let adminRfRate: number | null = null;

// In-memory store for admin sessions (token -> { expiry, role }).
// "full"  = full admin (Zerodha connect + trades), via /admin/verify
// "trade" = trade-only access (view/take/close trades), via /admin/access
type AdminRole = "full" | "trade";
interface AdminSession {
  expiry: number;
  role: AdminRole;
}
const adminSessions = new Map<string, AdminSession>();
const ADMIN_SESSION_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

function generateAdminToken(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

/** The role of a token, or null if missing/expired. */
function getAdminRole(token: string | undefined): AdminRole | null {
  if (!token) return null;
  const s = adminSessions.get(token);
  if (!s || Date.now() > s.expiry) {
    if (token) {
      adminSessions.delete(token);
      void deleteAdminSession(token); // best-effort cleanup of the persisted copy
    }
    return null;
  }
  return s.role;
}

function isAdminAuthenticated(token: string | undefined): boolean {
  return getAdminRole(token) !== null;
}

/** Any admin (full OR trade-access) — used for the shared trade endpoints. */
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const token = req.headers["x-admin-token"] as string | undefined;
  if (!isAdminAuthenticated(token)) {
    res.status(403).json({ error: "Admin authentication required" });
    return;
  }
  next();
}

/** Full admin only — used for Zerodha connect / session / logout. */
function requireFullAdmin(req: Request, res: Response, next: NextFunction) {
  const token = req.headers["x-admin-token"] as string | undefined;
  if (getAdminRole(token) !== "full") {
    res.status(403).json({ error: "Full admin access required." });
    return;
  }
  next();
}

// In-memory cache of the instrument dump so we don't re-download the (large)
// CSV on every frontend request. Kite refreshes instruments once a day.
let instrumentCache: { at: number; data: Instrument[] } | null = null;
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour

// ---------------------------------------------------------------------------
// Intraday option-OI cache (per-day, IN-MEMORY). We snapshot the nearest NIFTY
// option expiry's OI + LTP (and the index spot) once a minute during market
// hours so the frontend has a real 5m/15m baseline the moment it loads, at any
// time of day. It is keyed by the IST day and is discarded/rebuilt when the day
// rolls over (so yesterday's data is automatically removed).
// ---------------------------------------------------------------------------
const OPTION_OI_UNDERLYING = "NIFTY";
const OPTION_OI_INTERVAL_MS = 60 * 1000; // sample once a minute
/** How far before a bucket boundary to take the sample that represents it. */
const CAPTURE_LEAD_MS = 3 * 1000;

interface OiSample {
  t: number;
  oi: number;
  ltp: number;
}
interface OptionOiDay {
  day: string; // IST YYYY-MM-DD this cache belongs to
  expiry: string; // the option expiry being tracked (nearest)
  spotToken: number;
  meta: Map<number, { strike: number; type: "CE" | "PE" }>;
  series: Map<number, OiSample[]>; // option token -> per-minute samples
  spot: { t: number; ltp: number }[]; // index spot per-minute samples
}
let optionOiDay: OptionOiDay | null = null;

/**
 * Previous session's CLOSING OI + LTP per option token, used as the baseline for
 * the chain's "Day" change column.
 *
 * Filled two ways: snapshotted from the outgoing day's cache when the IST day
 * rolls over (the normal path), and reconstructed from Kite daily candles on a
 * cold start (so a restart or a first-ever run still has a baseline).
 */
interface OptionPrevClose {
  forDay: string; // the IST day this baseline is the "previous close" FOR
  closedOn: string; // the session the values were taken from
  expiry: string;
  // False when the daily-candle reconstruction couldn't cover the whole band
  // (a rate limit, an expired session, a mid-loop abort). Partial data is still
  // published — every covered strike gets a real change — but the periodic
  // gap-check is allowed to retry and fill in the rest.
  complete: boolean;
  tokens: Record<number, { oi: number; ltp: number }>;
}
let optionPrevClose: OptionPrevClose | null = null;

// ---------------------------------------------------------------------------
// Multi-timeframe Call/Put total-OI history (for the analytics OI chart).
// Each frame keeps aggregate points (total CE & PE OI over the 24↑/ATM/26↓
// window) at its own cadence and retention. Filled live once a minute and
// backfilled from Kite historical to recover any slots missed while the server
// was down. In-memory (rebuilt from Kite on restart).
// ---------------------------------------------------------------------------
type OiFrameKey = "1m" | "5m" | "15m" | "1h";
interface OiFrameCfg {
  intervalMin: number;
  retentionMs: number;
  kiteInterval: string; // Kite historical interval name
}
const OI_FRAMES: Record<OiFrameKey, OiFrameCfg> = {
  "1m": { intervalMin: 1, retentionMs: 1 * 24 * 60 * 60 * 1000, kiteInterval: "minute" },
  "5m": { intervalMin: 5, retentionMs: 3 * 24 * 60 * 60 * 1000, kiteInterval: "5minute" },
  "15m": { intervalMin: 15, retentionMs: 7 * 24 * 60 * 60 * 1000, kiteInterval: "15minute" },
  "1h": { intervalMin: 60, retentionMs: 4 * 24 * 60 * 60 * 1000, kiteInterval: "60minute" },
};
/** Frame keys in display order. Prefer this over Object.keys for stable order. */
const OI_FRAME_KEYS = Object.keys(OI_FRAMES) as OiFrameKey[];
/** Narrow a query-string frame to a known key, defaulting to 5m. */
function parseFrameKey(raw: unknown): OiFrameKey {
  const s = String(raw ?? "5m");
  return (OI_FRAME_KEYS as string[]).includes(s) ? (s as OiFrameKey) : "5m";
}
interface OiAggPoint {
  t: number; // epoch ms
  totalCe: number;
  totalPe: number;
  straddle: number; // auto-ATM straddle premium (ATM CE LTP + ATM PE LTP)
  spot: number; // NIFTY index spot at this bucket
  /**
   * Set when this reading is KNOWN to understate the window: a quote response that
   * didn't cover every strike in it, or a reconstruction whose historical call for
   * one of them failed. Such a bucket is published (a gap in the chart is worse
   * than a slightly low bar) but stays correctable — mergeOiFrame lets a complete
   * reconstruction replace it, and the gap detector keeps asking for it.
   *
   * Absent means trustworthy, which is what makes the flag safe to add to a schema
   * Redis already holds values for: everything written before it existed is read
   * back as complete, exactly as it was treated then.
   */
  partial?: 1;
}
const oiFrameStores: Record<OiFrameKey, { points: OiAggPoint[] }> = {
  "1m": { points: [] },
  "5m": { points: [] },
  "15m": { points: [] },
  "1h": { points: [] },
};
// How far around the current ATM to fetch strike OI when backfilling. Must be
// large enough to cover both the 26-below/24-above window AND intraday/multi-day
// ATM drift over the retention window.
const OI_BACKFILL_BAND = 45;

/**
 * Drop the still-forming bucket from a frame before serving it.
 *
 * Points are stamped with their bucket-END boundary, so the newest bucket carries
 * a timestamp that hasn't arrived yet until it closes. Publishing it would label a
 * partial reading with a future time and, on the change histograms, draw a
 * part-interval move as a completed bar. Serving only closed buckets means every
 * point on every chart is a real, finished interval — at the cost of the newest
 * data being up to one bucket old.
 */
function completedBuckets<T extends { t: number }>(points: T[]): T[] {
  const now = Date.now();
  // Stamps are ascending, so this only ever trims from the tail.
  let end = points.length;
  while (end > 0 && points[end - 1]!.t > now) end--;
  return end === points.length ? points : points.slice(0, end);
}

// ---------------------------------------------------------------------------
// Multi-timeframe NIFTY FUTURES open-interest history (current/next/far month).
// Reuses the OI_FRAMES cadence + retention (1m→1 day, 5m→3 days, 15m→1 week).
// Only 3 tokens are involved, so the live snapshot is a single cheap /quote and
// the Kite backfill is 3 historical calls. In-memory (rebuilt on restart).
// ---------------------------------------------------------------------------
const FUT_OI_UNDERLYING = "NIFTY";

/** One futures contract's OI + price at a point in time. */
interface FutOiLeg {
  expiry: string; // ISO YYYY-MM-DD — stable series key across a rollover
  oi: number;
  ltp: number;
}
interface FutOiPoint {
  t: number; // epoch ms
  legs: FutOiLeg[]; // one per tracked contract (nearest first)
}
/** A tracked NIFTY futures contract. */
interface FutContract {
  token: number;
  tradingsymbol: string;
  expiry: string;
  lot_size: number;
}
const futOiFrameStores: Record<OiFrameKey, { points: FutOiPoint[] }> = {
  "1m": { points: [] },
  "5m": { points: [] },
  "15m": { points: [] },
  "1h": { points: [] },
};
/** The contracts the futures-OI frames are currently tracking (nearest first). */
let futOiContracts: FutContract[] = [];
/**
 * Every contract we have ever captured, keyed by expiry. Retained points can
 * outlive a contract's presence in `futOiContracts` (the day after an expiry),
 * so the endpoint resolves labels from here to keep a series continuous across
 * a rollover instead of dropping up to a week of history.
 */
const futOiKnownContracts = new Map<string, FutContract>();

// ---------------------------------------------------------------------------
// Redis persistence for the analytics caches.
//
// Everything above is in-memory, which meant every deploy or crash threw away
// the whole session's history and paid for it with hundreds of Kite historical
// calls (and, when a backfill failed, a chart that started mid-session and never
// recovered). Redis is now the durable copy: memory stays the read path, and each
// mutation is mirrored so a restart warm-loads instead of re-fetching.
//
// Layout — one HASH per frame, field = bucket-end ms, value = the point as JSON:
//
//   calspread:oiframe:{1m,5m,15m,1h}      option Call/Put totals + straddle + spot
//   calspread:futoiframe:{1m,5m,15m,1h}   futures per-contract OI + LTP
//   calspread:futcontracts                contract metadata (labels across rollover)
//   calspread:prevclose                   previous-session close baseline
//   calspread:chainsnap:min:{IST day}     per-minute per-token OI/LTP (1 day)
//   calspread:chainsnap:hour              per-hour  per-token OI/LTP (4 days)
//
// A HASH keyed by bucket makes writes IDEMPOTENT — re-writing a bucket that a
// backfill corrected replaces the field instead of appending a duplicate, which a
// sorted set of JSON members could not do. Retention is enforced in Redis too:
// pruned buckets are HDEL'd and every key carries a TTL so an abandoned key
// disappears on its own.
// ---------------------------------------------------------------------------

/** Keep a key a day past its data's retention, so a paused process can resume. */
const REDIS_TTL_SLACK_MS = 24 * 60 * 60 * 1000;
const redisKeys = {
  oiFrame: (f: OiFrameKey) => `oiframe:${f}`,
  futFrame: (f: OiFrameKey) => `futoiframe:${f}`,
  futContracts: "futcontracts",
  prevClose: "prevclose",
  chainMinute: (day: string) => `chainsnap:min:${day}`,
  // Per-day, like the minute key. A single shared key could never be trimmed
  // correctly: fields are only HDEL'd when they're still in memory, so buckets
  // written before a restart became orphans, and the periodic EXPIRE refresh kept
  // resurrecting the key's lifetime. Per-day keys just age out.
  chainHour: (day: string) => `chainsnap:hour:${day}`,
};

/**
 * Writes are buffered and flushed once per capture cycle.
 *
 * Upstash bills per command, so the difference between flushing here and calling
 * out per store is ~10 requests a minute versus one. Fields are keyed, so a buffer
 * that is flushed late simply collapses repeated writes to the same bucket.
 */
interface PendingHashWrite {
  entries: Map<string, unknown>;
  stale: Set<string>;
  ttlSec: number;
  /** Backlog cap for THIS key. Fields differ enormously in size — a frame point is
   *  ~100 bytes, a chain snapshot is a whole token map at ~12KB — so one global
   *  field count would either wedge on body size or throw away frame history. */
  maxFields: number;
}
let pendingHashWrites = new Map<string, PendingHashWrite>();
let pendingPlainWrites = new Map<string, { value: unknown; ttlSec: number }>();
let flushInFlight = false;
/** A flush was requested while one was in flight — re-run it when that finishes. */
let flushAgain = false;
/**
 * Caps on buffered fields per key while Redis is unreachable. Beyond these the
 * OLDEST are dropped: the newest buckets are the ones a restart would miss, and
 * anything older is still reconstructible from Kite by the gap-aware backfill.
 * Sized so a full backlog stays well inside one REST body.
 */
const MAX_BUFFERED_FRAME_FIELDS = 3000; // ~100 bytes each
const MAX_BUFFERED_SNAPSHOT_FIELDS = 60; // ~12KB each
/** Last time each key's TTL was refreshed, so EXPIRE isn't re-sent every write. */
const ttlRefreshedAt = new Map<string, number>();
const TTL_REFRESH_EVERY_MS = 15 * 60 * 1000;

function pendingFor(key: string, ttlSec: number, maxFields: number): PendingHashWrite {
  let p = pendingHashWrites.get(key);
  if (!p) {
    p = { entries: new Map(), stale: new Set(), ttlSec, maxFields };
    pendingHashWrites.set(key, p);
  }
  p.ttlSec = ttlSec;
  p.maxFields = maxFields;
  return p;
}

/** Queue `field = value` on a hash. */
function queueHashField(
  key: string,
  field: string | number,
  value: unknown,
  ttlSec: number,
  maxFields: number = MAX_BUFFERED_FRAME_FIELDS,
): void {
  if (!isRedisEnabled()) return;
  const p = pendingFor(key, ttlSec, maxFields);
  const f = String(field);
  p.stale.delete(f); // a re-add supersedes a pending delete
  p.entries.set(f, value);
}

/** Queue the removal of retention-pruned fields from a hash. */
function queueHashDrop(key: string, fields: (string | number)[], ttlSec: number): void {
  if (!isRedisEnabled() || fields.length === 0) return;
  const p = pendingFor(key, ttlSec, MAX_BUFFERED_FRAME_FIELDS);
  for (const field of fields) {
    const f = String(field);
    p.entries.delete(f);
    p.stale.add(f);
  }
}

/** Queue a whole-key JSON write. */
function queuePlainWrite(key: string, value: unknown, ttlSec: number): void {
  if (!isRedisEnabled()) return;
  pendingPlainWrites.set(key, { value, ttlSec });
}

/**
 * Send everything buffered so far as one pipeline.
 *
 * Never throws and never awaits anything the caller depends on — a Redis outage
 * degrades to the pre-Redis behaviour (memory-only) rather than stalling capture.
 */
async function flushRedisWrites(): Promise<void> {
  if (!isRedisEnabled()) return;
  if (flushInFlight) {
    // Record the intent instead of dropping it: out of market hours the capture
    // tick isn't there to cover a skipped flush, so an overlapping chain's writes
    // would otherwise never be sent.
    flushAgain = true;
    return;
  }
  if (pendingHashWrites.size === 0 && pendingPlainWrites.size === 0) return;
  // Don't serialize megabytes of backlog just for `pipeline` to discard it while
  // cooling down — leave it buffered for the retry timer.
  if (!canSend()) return;
  flushInFlight = true;
  flushAgain = false;
  // Detach the batch so writes queued during the round-trip aren't lost, but keep
  // it so a FAILED batch can be put back — clearing before the await would have
  // discarded those buckets permanently, since `pipeline` swallows its errors and
  // nothing else ever re-queues a specific field.
  const hashes = pendingHashWrites;
  const plains = pendingPlainWrites;
  pendingHashWrites = new Map();
  pendingPlainWrites = new Map();
  try {
    const now = Date.now();
    const cmds: RedisCommand[] = [];
    const ttlSent: string[] = [];
    for (const [key, p] of hashes) {
      // EXPIRE is a billed command and the TTLs are days long, so refresh it
      // periodically rather than on every write — it was half the command budget.
      const last = ttlRefreshedAt.get(key) ?? 0;
      const withTtl = now - last > TTL_REFRESH_EVERY_MS;
      cmds.push(
        ...hashWriteCommands(
          key,
          p.entries,
          Array.from(p.stale),
          withTtl ? p.ttlSec : undefined,
        ),
      );
      if (withTtl) ttlSent.push(key);
    }
    for (const [key, p] of plains) cmds.push(setJsonCommand(key, p.value, p.ttlSec));
    const out = await pipeline(cmds);
    if (out === null) {
      requeueFailedWrites(hashes, plains);
    } else {
      // Only now, having actually observed the send: stamping at build time meant a
      // FAILED flush could mark a key as TTL'd, and the requeued HSET that created
      // it would then go out without an EXPIRE — a key with no expiry at all.
      for (const key of ttlSent) ttlRefreshedAt.set(key, now);
    }
  } catch (e) {
    requeueFailedWrites(hashes, plains);
    console.warn("[Redis] flush failed:", e instanceof Error ? e.message : e);
  } finally {
    flushInFlight = false;
    if (flushAgain) {
      flushAgain = false;
      void flushRedisWrites();
    }
  }
}

/**
 * Drive the write buffer independently of the capture tick.
 *
 * Every other flush trigger sits behind `isIstMarketHours()`, so a failure on the
 * session's LAST tick — a 60s cooldown is more than enough to swallow it — parked
 * the day's 15:30 closing buckets in memory until the next trading morning, and an
 * overnight deploy dropped them. This timer is deliberately not market-hours gated.
 */
function startRedisFlushRetry(): void {
  if (!isRedisEnabled()) return;
  setInterval(() => {
    if (pendingHashWrites.size === 0 && pendingPlainWrites.size === 0) return;
    void flushRedisWrites();
  }, 60 * 1000);
}

/** Put a failed batch back, letting anything queued since take precedence. */
function requeueFailedWrites(
  hashes: Map<string, PendingHashWrite>,
  plains: Map<string, { value: unknown; ttlSec: number }>,
): void {
  for (const [key, old] of hashes) {
    const cur = pendingHashWrites.get(key);
    if (!cur) {
      pendingHashWrites.set(key, old);
      continue;
    }
    for (const [f, v] of old.entries) {
      if (!cur.entries.has(f) && !cur.stale.has(f)) cur.entries.set(f, v);
    }
    for (const f of old.stale) if (!cur.entries.has(f)) cur.stale.add(f);
  }
  for (const [key, p] of plains) {
    if (!pendingPlainWrites.has(key)) pendingPlainWrites.set(key, p);
  }
  // Bound the backlog of a long outage. Fields are bucket timestamps, so sorting
  // numerically drops the oldest — the ones the Kite backfill can still rebuild.
  for (const [key, p] of pendingHashWrites) {
    const over = p.entries.size - p.maxFields;
    if (over <= 0) continue;
    const oldest = Array.from(p.entries.keys())
      .sort((a, b) => Number(a) - Number(b))
      .slice(0, over);
    for (const f of oldest) p.entries.delete(f);
    console.warn(
      `[Redis] ${key}: dropped ${over} buffered buckets (Redis unreachable; ` +
        `they stay recoverable from Kite).`,
    );
  }
}

/** TTL (seconds) for a frame's key: its retention plus a day of slack. */
function frameTtlSec(cfg: OiFrameCfg): number {
  return Math.floor((cfg.retentionMs + REDIS_TTL_SLACK_MS) / 1000);
}

// ---------------------------------------------------------------------------
// Per-token chain snapshots — the source for the chain's OI Δ% / buildup windows.
//
// The windows used to be resolved from `optionOiDay.series`, which is memory-only:
// a restart erased every baseline and the columns showed dashes until enough new
// minutes accumulated. A 1-hour window would have been unusable. These snapshots
// are the same readings keyed by bucket instead of by token, which makes them one
// small blob per bucket — cheap enough to mirror to Redis every minute, where a
// per-token key would have been hundreds of writes a minute.
//
// Two cadences: MINUTE snapshots for a day (they serve 1m/5m/15m/1h) and HOUR
// snapshots for four days (multi-day lookback without keeping 4×375 minutes).
// ---------------------------------------------------------------------------

/** `[oi, ltp]` per option token — a tuple purely to keep the blob small. */
type ChainSnapTokens = Record<number, [number, number]>;
interface ChainSnapshot {
  t: number; // bucket-end ms
  expiry: string;
  tokens: ChainSnapTokens;
}
const CHAIN_MINUTE_RETENTION_MS = 1 * 24 * 60 * 60 * 1000; // "1m cached for a day"
const CHAIN_HOUR_RETENTION_MS = 4 * 24 * 60 * 60 * 1000; // "1h cached for 4 days"
/** Ascending by `t`. Written through to Redis, warm-loaded at boot. */
let chainMinuteSnaps: ChainSnapshot[] = [];
let chainHourSnaps: ChainSnapshot[] = [];

/** Insert/replace a snapshot in an ascending-by-`t` list. */
function upsertSnapshot(list: ChainSnapshot[], snap: ChainSnapshot): void {
  for (let i = list.length - 1; i >= 0; i--) {
    const cur = list[i]!;
    if (cur.t === snap.t) {
      list[i] = snap;
      return;
    }
    if (cur.t < snap.t) {
      list.splice(i + 1, 0, snap);
      return;
    }
  }
  list.unshift(snap);
}

/**
 * Record this capture's readings into both snapshot cadences and mirror them.
 *
 * The hour bucket is deliberately overwritten by every minute inside it, so it
 * always holds that hour's CLOSING reading — the same "bucket end" contract the
 * frames use.
 */
function recordChainSnapshot(store: OptionOiDay, t: number): void {
  const tokens: ChainSnapTokens = {};
  let n = 0;
  for (const [token, arr] of store.series) {
    const last = arr[arr.length - 1];
    if (!last || last.oi <= 0) continue; // never got a real reading for this strike
    tokens[token] = [last.oi, last.ltp];
    n++;
  }
  if (n === 0) return;

  const minuteT = bucketEndMs(t, 60 * 1000);
  const hourT = bucketEndMs(t, 60 * 60 * 1000);
  const minuteSnap: ChainSnapshot = { t: minuteT, expiry: store.expiry, tokens };
  const hourSnap: ChainSnapshot = { t: hourT, expiry: store.expiry, tokens };
  upsertSnapshot(chainMinuteSnaps, minuteSnap);
  upsertSnapshot(chainHourSnaps, hourSnap);

  const minuteTtl = Math.floor((CHAIN_MINUTE_RETENTION_MS + REDIS_TTL_SLACK_MS) / 1000);
  const hourTtl = Math.floor((CHAIN_HOUR_RETENTION_MS + REDIS_TTL_SLACK_MS) / 1000);
  queueHashField(
    redisKeys.chainMinute(store.day),
    minuteT,
    minuteSnap,
    minuteTtl,
    MAX_BUFFERED_SNAPSHOT_FIELDS,
  );
  queueHashField(
    redisKeys.chainHour(store.day),
    hourT,
    hourSnap,
    hourTtl,
    MAX_BUFFERED_SNAPSHOT_FIELDS,
  );

  // In-memory pruning only. Both keys are per-day and carry a TTL, so Redis-side
  // eviction is the TTL's job — there is no shared key to leak fields into.
  const minCutoff = t - CHAIN_MINUTE_RETENTION_MS;
  while (chainMinuteSnaps.length && chainMinuteSnaps[0]!.t < minCutoff) {
    chainMinuteSnaps.shift();
  }
  const hourCutoff = t - CHAIN_HOUR_RETENTION_MS;
  while (chainHourSnaps.length && chainHourSnaps[0]!.t < hourCutoff) {
    chainHourSnaps.shift();
  }
}

/**
 * The snapshot to compare against for a window of `minutes`, or null when the
 * cache doesn't reach back that far.
 *
 * Deliberately returns nothing rather than the oldest snapshot it has. Serving a
 * 20-minute-old reading as a "1 hour" baseline would render a plausible but wrong
 * percentage; a dash is the honest answer, and the client already handles it.
 */
function chainBaselineAt(cutoff: number): ChainSnapshot | null {
  // TODAY only, both cadences. Bounding to today is the important part: it is what
  // stops a reading from a previous session ever standing in for this one, which an
  // unbounded search would do every morning before the cache has filled.
  //
  // The answer carries `baseT`, and the client grades that against the window it
  // asked for — so an hourly fallback that is an hour older than a 5-minute cutoff
  // is rejected there rather than being silently presented as a 5-minute change.
  const dayStart = istTimeOnDayMs(Date.now(), 0);
  const pick = (list: ChainSnapshot[]): ChainSnapshot | null => {
    let best: ChainSnapshot | null = null;
    for (const s of list) {
      if (s.t > cutoff) break;
      if (s.t >= dayStart) best = s;
    }
    return best;
  };
  // Prefer the dense minute cadence; the hourly one is the fallback for a session
  // whose minute snapshots were lost (a restart while Redis was unreachable). Both
  // are bounded to TODAY, which is what keeps an hourly reading from ever standing
  // in for a session it doesn't belong to.
  return pick(chainMinuteSnaps) ?? pick(chainHourSnaps);
}

/** Oldest/newest snapshot that could serve a window today (drives availability). */
function chainSnapshotSpan(): { oldest: number | null; newest: number | null } {
  const dayStart = istTimeOnDayMs(Date.now(), 0);
  let oldest: number | null = null;
  let newest: number | null = null;
  for (const s of [...chainMinuteSnaps, ...chainHourSnaps]) {
    if (s.t < dayStart) continue;
    if (oldest === null || s.t < oldest) oldest = s.t;
    if (newest === null || s.t > newest) newest = s.t;
  }
  return { oldest, newest };
}

/**
 * Warm-load every persisted cache from Redis.
 *
 * MUST complete before `startOptionOiCapture()`, which snapshots the backfill
 * windows from whatever the stores hold at that instant: running it afterwards
 * would make the gap detector fetch from Kite everything Redis already had.
 */
/**
 * Fold warm-loaded points into a store, keeping anything already there.
 *
 * Assigning over the store would be a race: a Zerodha session restored earlier in
 * the same boot chain can fire triggerPostLoginBackfill(), and its reconstruction
 * is newer than what Redis holds. Live/backfilled values therefore win, and Redis
 * only supplies buckets nothing else has. Returns how many it added.
 */
function mergeWarmLoaded<T extends { t: number }>(
  store: { points: T[] },
  loaded: T[],
): number {
  if (loaded.length === 0) return 0;
  const existing = new Set(store.points.map((p) => p.t));
  const byBucket = new Map<number, T>();
  for (const p of loaded) byBucket.set(p.t, p);
  for (const p of store.points) byBucket.set(p.t, p); // existing wins
  store.points = Array.from(byBucket.values()).sort((a, b) => a.t - b.t);
  let added = 0;
  for (const t of byBucket.keys()) if (!existing.has(t)) added++;
  return added;
}

/**
 * The same fold for the chain snapshots, which are a list rather than a store.
 *
 * These were being ASSIGNED over, and the warm load is ~16 sequential REST
 * round-trips (up to 8s each): a Zerodha session restored earlier in the boot chain
 * fires a capture inside that window, and the assignment then dropped the readings
 * it had just recorded. In memory that is unrecoverable — Redis kept them, but
 * nothing re-reads it — so the chain's OI Δ% columns lost their baseline for the
 * rest of the session. Mutates in place; returns how many it added.
 */
function mergeWarmLoadedSnaps(
  list: ChainSnapshot[],
  loaded: ChainSnapshot[],
): number {
  const have = new Set(list.map((s) => s.t));
  let added = 0;
  for (const s of loaded) {
    if (have.has(s.t)) continue; // a live reading beats the persisted copy
    upsertSnapshot(list, s);
    have.add(s.t);
    added++;
  }
  return added;
}

async function warmLoadFromRedis(): Promise<void> {
  logRedisStatus();
  if (!isRedisEnabled()) return;
  if (!(await redisPing())) {
    console.warn("[Redis] PING failed — starting with empty in-memory caches.");
    return;
  }
  const now = Date.now();
  let loaded = 0;
  try {
    for (const key of OI_FRAME_KEYS) {
      const cfg = OI_FRAMES[key];
      const cutoff = now - cfg.retentionMs;

      const opt = await hGetAllJson<OiAggPoint>(redisKeys.oiFrame(key));
      loaded += mergeWarmLoaded(
        oiFrameStores[key],
        Array.from(opt.values()).filter(
          (p) => p && typeof p.t === "number" && p.t >= cutoff,
        ),
      );

      const fut = await hGetAllJson<FutOiPoint>(redisKeys.futFrame(key));
      loaded += mergeWarmLoaded(
        futOiFrameStores[key],
        Array.from(fut.values()).filter(
          (p) => p && typeof p.t === "number" && Array.isArray(p.legs) && p.t >= cutoff,
        ),
      );
    }

    // Futures contract metadata, so a retained series keeps its label after a
    // rollover even on the first request after a restart.
    const contracts = await redisGetJson<FutContract[]>(redisKeys.futContracts);
    if (Array.isArray(contracts)) {
      for (const c of contracts) {
        if (c && typeof c.expiry === "string") futOiKnownContracts.set(c.expiry, c);
      }
    }

    // Previous-session close: worth ~240 Kite historical calls on every restart.
    const prev = await redisGetJson<OptionPrevClose>(redisKeys.prevClose);
    if (prev && prev.forDay === istDayKey() && prev.tokens) {
      optionPrevClose = prev;
      console.log(
        `[Redis] Restored previous-close baseline (${Object.keys(prev.tokens).length} ` +
          `tokens from ${prev.closedOn}) — no Kite backfill needed.`,
      );
    }

    // Chain snapshots for the OI Δ% / buildup windows. The minute cadence only
    // needs today (its whole retention is a day); the hourly cadence spans 4 days,
    // so read a key per day.
    const minute = await hGetAllJson<ChainSnapshot>(redisKeys.chainMinute(istDayKey()));
    mergeWarmLoadedSnaps(
      chainMinuteSnaps,
      Array.from(minute.values()).filter(
        (s) => s && typeof s.t === "number" && s.t >= now - CHAIN_MINUTE_RETENTION_MS,
      ),
    );
    for (let d = 0; d <= 4; d++) {
      const day = istDayKey(now - d * 24 * 60 * 60 * 1000);
      const hour = await hGetAllJson<ChainSnapshot>(redisKeys.chainHour(day));
      mergeWarmLoadedSnaps(
        chainHourSnaps,
        Array.from(hour.values()).filter(
          (s) => s && typeof s.t === "number" && s.t >= now - CHAIN_HOUR_RETENTION_MS,
        ),
      );
    }

    console.log(
      `[Redis] Warm-loaded ${loaded} frame points, ${chainMinuteSnaps.length} minute ` +
        `and ${chainHourSnaps.length} hourly chain snapshots.`,
    );
  } catch (e) {
    // A partial warm load is fine: the gap-aware backfill fills whatever is
    // missing from Kite, exactly as it did before Redis existed.
    console.warn(
      "[Redis] warm load failed:",
      e instanceof Error ? e.message : e,
    );
  }
}

// Dividend yields (%) from Yahoo, refreshed once a day.
let dividendCache: { at: number; data: Record<string, number> } | null = null;
const DIVIDEND_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

const app = express();

// Live financial data must never be cached. Disable ETag generation so the
// backend never replies "304 Not Modified" (a 304 has an empty body, which
// would make the frontend's res.json() fail).
app.set("etag", false);

// --- CORS (so the Vite frontend can call this API) ---
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header("Access-Control-Allow-Origin", FRONTEND_URL);
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-admin-token");
  res.header("Access-Control-Allow-Credentials", "true");
  // Prevent browser/proxy caching of API responses (no 304 revalidation).
  res.header("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json());

// General per-IP rate limit for all API routes: guards the Kite quota and the
// server against rapid refreshing / deliberate abuse. 150 req/min comfortably
// covers a normal visitor (a page load is ~4 calls + a 15s status poll) while
// blocking abusive loops.
app.use("/api", rateLimit({ windowMs: 60_000, max: 150 }));

// --- Health check ---
app.get("/", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    authenticated: kite.hasSession(),
    hint: "Visit /api/login to authenticate with Zerodha.",
  });
});

// --- Status (under /api so it works behind a same-domain /api proxy) ---
app.get("/api/status", (_req: Request, res: Response) => {
  res.json({ status: "ok", authenticated: kite.hasSession() });
});

// --- Internal: share the current Zerodha session with the local market_data
// recorder so it can reuse THIS app's access token (Zerodha allows only one
// token per API key/day). Guarded by a shared secret header, never exposed to
// the public frontend. Returns the api_key + access_token only when a valid
// session exists. Rate-limited to blunt brute-force of the secret. ---
app.get(
  "/api/internal/kite-token",
  rateLimit({ windowMs: 60_000, max: 30 }),
  (req: Request, res: Response) => {
    if (!INTERNAL_TOKEN_SECRET) {
      res.status(503).json({ error: "Internal token sharing is not configured." });
      return;
    }
    const provided =
      (req.headers["x-internal-secret"] as string | undefined) ??
      (req.query.secret as string | undefined);
    if (provided !== INTERNAL_TOKEN_SECRET) {
      res.status(403).json({ error: "Forbidden." });
      return;
    }
    const accessToken = kite.getAccessToken();
    res.json({
      api_key: kite.getApiKey(),
      access_token: accessToken,
      authenticated: accessToken !== null,
    });
  },
);

// --- Public, curl-friendly access-token route (passcode-protected). ---
// Once the admin has connected Zerodha, anyone holding the route passcode can
// fetch the day's access token with a simple curl (no admin login / cookies):
//
//   curl "https://<host>/api/kite/token?passcode=YOUR_PASSCODE"
//   curl -H "x-token-passcode: YOUR_PASSCODE" https://<host>/api/kite/token
//
// The passcode is a dedicated secret (TOKEN_ROUTE_SECRET), separate from the
// admin secret, so it can be shared with scripts without granting admin access.
// Rate-limited to blunt brute-forcing of the passcode.
app.get(
  "/api/kite/token",
  rateLimit({ windowMs: 60_000, max: 30 }),
  (req: Request, res: Response) => {
    if (!TOKEN_ROUTE_SECRET) {
      res.status(503).json({
        error: "Token route is not configured. Set TOKEN_ROUTE_SECRET on the server.",
      });
      return;
    }
    const provided =
      (req.headers["x-token-passcode"] as string | undefined) ??
      (req.query.passcode as string | undefined);
    if (provided !== TOKEN_ROUTE_SECRET) {
      res.status(403).json({ error: "Invalid or missing passcode." });
      return;
    }
    const accessToken = kite.getAccessToken();
    if (!accessToken) {
      res.status(409).json({
        authenticated: false,
        error: "No active Zerodha session. The admin must connect to Zerodha first.",
      });
      return;
    }
    res.json({
      authenticated: true,
      api_key: kite.getApiKey(),
      access_token: accessToken,
      login_date: istDayKey(),
    });
  },
);

// --- Sync the admin-entered risk-free rate (%). Full admin only. ---
// The admin panel POSTs here whenever the rf field changes, so the value can be
// read back over the API (e.g. via curl) with the passcode route below.
app.post("/api/rf", requireFullAdmin, (req: Request, res: Response) => {
  const rf = Number(req.body?.rf);
  if (!Number.isFinite(rf)) {
    res.status(400).json({ error: "Provide a numeric rf (percent)." });
    return;
  }
  adminRfRate = rf;
  // Persist so the value survives restarts and is shared across browsers.
  void saveRfRate(rf).catch((e) => console.warn("[rf] persist failed:", e));
  res.json({ rf: adminRfRate });
});

// --- Public read of the current risk-free rate (%) for the frontend. ---
// Unauthenticated: rf is a non-sensitive display setting, and every visitor's
// fair-value math must use the SAME admin-entered value. Returns { rf: null }
// when the admin hasn't set one yet (frontend falls back to its default).
app.get("/api/rf/current", (_req: Request, res: Response) => {
  res.json({ rf: adminRfRate });
});

// --- Public, curl-friendly read of the admin's risk-free rate. ---
// Protected by the SAME passcode as the token route (TOKEN_ROUTE_SECRET):
//
//   curl "https://<host>/api/rf?passcode=YOUR_PASSCODE"
//   curl -H "x-token-passcode: YOUR_PASSCODE" https://<host>/api/rf
//
// Returns 409 until the admin has entered an rf value in the panel at least once.
app.get(
  "/api/rf",
  rateLimit({ windowMs: 60_000, max: 30 }),
  (req: Request, res: Response) => {
    if (!TOKEN_ROUTE_SECRET) {
      res.status(503).json({
        error: "Token route is not configured. Set TOKEN_ROUTE_SECRET on the server.",
      });
      return;
    }
    const provided =
      (req.headers["x-token-passcode"] as string | undefined) ??
      (req.query.passcode as string | undefined);
    if (provided !== TOKEN_ROUTE_SECRET) {
      res.status(403).json({ error: "Invalid or missing passcode." });
      return;
    }
    if (adminRfRate === null) {
      res.status(409).json({
        error: "No risk-free rate set yet. The admin must enter it in the panel first.",
      });
      return;
    }
    res.json({ rf: adminRfRate });
  },
);

// --- Admin verification endpoint ---
// Stricter limit so the secret can't be brute-forced: 10 attempts / 5 min / IP.
app.post(
  "/api/admin/verify",
  rateLimit({
    windowMs: 5 * 60_000,
    max: 10,
    message: "Too many attempts. Try again in a few minutes.",
  }),
  (req: Request, res: Response) => {
  const { secret } = req.body;
  
  if (!ADMIN_SECRET) {
    res.status(500).json({ error: "Admin secret not configured on server" });
    return;
  }
  
  if (secret !== ADMIN_SECRET) {
    res.status(401).json({ error: "Invalid admin secret" });
    return;
  }
  
  const token = generateAdminToken();
  const expiry = Date.now() + ADMIN_SESSION_TTL_MS;
  adminSessions.set(token, { expiry, role: "full" });
  void saveAdminSession(token, "full", expiry); // survive backend restarts

  res.json({
    success: true,
    token,
    role: "full",
    expiresIn: ADMIN_SESSION_TTL_MS,
  });
});

// --- Trade-access verification (/admin/access): trade-only role. ---
app.post(
  "/api/access/verify",
  rateLimit({
    windowMs: 5 * 60_000,
    max: 10,
    message: "Too many attempts. Try again in a few minutes.",
  }),
  (req: Request, res: Response) => {
    const { secret } = req.body;

    if (!ACCESS_SECRET) {
      res.status(500).json({ error: "Access secret not configured on server" });
      return;
    }
    if (secret !== ACCESS_SECRET) {
      res.status(401).json({ error: "Invalid access code" });
      return;
    }

    const token = generateAdminToken();
    const expiry = Date.now() + ADMIN_SESSION_TTL_MS;
    adminSessions.set(token, { expiry, role: "trade" });
    void saveAdminSession(token, "trade", expiry); // survive backend restarts

    res.json({
      success: true,
      token,
      role: "trade",
      expiresIn: ADMIN_SESSION_TTL_MS,
    });
  },
);

// --- Check admin session status (returns the role too). ---
app.get("/api/admin/status", (req: Request, res: Response) => {
  const token = req.headers["x-admin-token"] as string | undefined;
  const role = getAdminRole(token);
  res.json({ authenticated: role !== null, role });
});

// --- Step 1: send the user to Zerodha's login page ---
// Registered at both /login and /api/login so it works whether the backend is
// on its own origin or behind a same-domain "/api" reverse proxy.
app.get(["/login", "/api/login"], (req: Request, res: Response) => {
  // Accept admin token from query param (browser navigation can't send headers)
  const tokenFromQuery = req.query["x-admin-token"] as string | undefined;
  const tokenFromHeader = req.headers["x-admin-token"] as string | undefined;
  if (getAdminRole(tokenFromQuery || tokenFromHeader) !== "full") {
    res.status(403).json({ error: "Full admin access required." });
    return;
  }
  res.redirect(kite.getLoginUrl());
});

// --- Step 2/3 (frontend-driven): the frontend receives the request_token at
// its registered redirect URL (e.g. http://localhost:5173/zerodha/verify)
// and POSTs it here so the backend can do the secret checksum exchange. ---
app.post("/api/session", requireFullAdmin, async (req: Request, res: Response) => {
  const requestToken = String(req.body?.request_token ?? "");
  if (!requestToken) {
    res.status(400).json({ error: "Missing request_token." });
    return;
  }
  try {
    const session = await kite.generateSession(requestToken);
    console.log(`Authenticated as ${session.user_name} (${session.user_id}).`);
    persistKiteSession(session);
    triggerPostLoginBackfill();
    res.json({
      authenticated: true,
      user_id: session.user_id,
      user_name: session.user_name,
    });
  } catch (err) {
    // Do NOT use sendError here: a failed (or duplicate) request_token
    // exchange must not clear an already-valid session.
    const status = err instanceof KiteError ? err.status : 500;
    const message = err instanceof Error ? err.message : "Login failed.";
    res.status(status).json({ error: message });
  }
});

// --- Legacy/alternative: Zerodha redirects straight to the backend with
// ?request_token=... (used only if the app's Redirect URL points here). ---
app.get("/callback", async (req: Request, res: Response) => {
  const requestToken = String(req.query.request_token ?? "");
  const status = String(req.query.status ?? "");

  if (status !== "success" || !requestToken) {
    res.redirect(`${FRONTEND_URL}/?auth=failed`);
    return;
  }

  try {
    const session = await kite.generateSession(requestToken);
    console.log(`Authenticated as ${session.user_name} (${session.user_id}).`);
    persistKiteSession(session);
    triggerPostLoginBackfill();
    res.redirect(`${FRONTEND_URL}/?auth=success`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Session generation failed:", message);
    res.redirect(`${FRONTEND_URL}/?auth=failed`);
  }
});

// --- Logout: forget the stored Kite session (full admin only). ---
app.post("/api/logout", requireFullAdmin, (_req: Request, res: Response) => {
  kite.clearSession();
  void clearKiteSession();
  res.json({ authenticated: false });
});

// --- Current Zerodha access token (full admin only). ---
// Lets the admin copy the day's access token straight from the admin panel so
// it can be reused in other tools (e.g. the local market_data recorder) without
// a second Zerodha login. Zerodha issues one token per API key per day.
app.get("/api/kite/access-token", requireFullAdmin, (_req: Request, res: Response) => {
  const accessToken = kite.getAccessToken();
  if (!accessToken) {
    res.status(409).json({
      error: "No active Zerodha session. Connect to Zerodha first.",
    });
    return;
  }
  res.json({
    api_key: kite.getApiKey(),
    access_token: accessToken,
    login_date: istDayKey(),
  });
});

// --- Authenticated user profile (the /user/ docs endpoint) ---
app.get("/api/profile", async (_req: Request, res: Response) => {
  try {
    const profile = await kite.getProfile();
    res.json(profile);
  } catch (err) {
    sendError(res, err);
  }
});

// --- All stocks: instrument dump, filtered to equities by default ---
// Query params:
//   exchange   default "NSE"  (set to "" to fetch every exchange)
//   type       default "EQ"   (instrument_type filter; set to "" to disable)
//   q          optional text search over symbol/name
app.get("/api/instruments", async (req: Request, res: Response) => {
  const exchange = req.query.exchange === undefined ? "NSE" : String(req.query.exchange);
  const type = req.query.type === undefined ? "EQ" : String(req.query.type);
  const q = String(req.query.q ?? "").trim().toLowerCase();

  try {
    let data = await getAllInstrumentsCached();

    if (exchange) {
      data = data.filter((i) => i.exchange === exchange);
    }
    if (type) {
      data = data.filter((i) => i.instrument_type === type);
    }
    if (q) {
      data = data.filter(
        (i) =>
          i.tradingsymbol.toLowerCase().includes(q) ||
          i.name.toLowerCase().includes(q),
      );
    }

    res.json({ count: data.length, instruments: data });
  } catch (err) {
    sendError(res, err);
  }
});

// --- F&O stocks only: underlyings that have stock futures on NSE (NFO). ---
// Index F&O (NIFTY, BANKNIFTY, ...) is excluded because indices are not NSE
// equities. Each row is the NSE equity enriched with its F&O lot size.
//   q   optional text search over symbol/name
app.get("/api/fno-stocks", async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim().toLowerCase();

  try {
    const all = await getAllInstrumentsCached();
    let data = deriveFnoStocks(all);

    if (q) {
      data = data.filter(
        (i) =>
          i.tradingsymbol.toLowerCase().includes(q) ||
          i.name.toLowerCase().includes(q),
      );
    }

    res.json({ count: data.length, instruments: data });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Detail for one F&O stock: spot instrument + the 3 nearest futures. ---
app.get("/api/fno-stocks/:symbol", async (req: Request, res: Response) => {
  const symbol = String(req.params.symbol).toUpperCase();
  try {
    const all = await getAllInstrumentsCached();

    const spot = all.find(
      (i) =>
        i.exchange === "NSE" &&
        i.instrument_type === "EQ" &&
        i.tradingsymbol === symbol,
    );
    if (!spot) {
      res.status(404).json({ error: `No NSE equity found for "${symbol}".` });
      return;
    }

    const futures = all
      .filter(
        (i) =>
          i.exchange === "NFO" &&
          i.instrument_type === "FUT" &&
          i.name === symbol,
      )
      .sort((a, b) => a.expiry.localeCompare(b.expiry)) // ISO dates sort chronologically
      .slice(0, 3)
      .map((f) => ({
        instrument_token: f.instrument_token,
        tradingsymbol: f.tradingsymbol,
        expiry: f.expiry,
        lot_size: f.lot_size,
      }));

    res.json({
      symbol,
      spot: {
        instrument_token: spot.instrument_token,
        tradingsymbol: spot.tradingsymbol,
        name: spot.name,
      },
      futures,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// Short-lived cache of the REST quote snapshot, keyed by the requested token
// set. This means that no matter how many visitors load/refresh the page, we
// hit Zerodha's rate-limited quote API at most once every QUOTES_TTL_MS —
// protecting the API quota from repeated refreshes or deliberate abuse.
const quotesCache = new Map<string, { at: number; ticks: Tick[] }>();
const QUOTES_TTL_MS = 4000;

// --- Snapshot quotes (REST): last price + close for the given tokens.
// Works regardless of market hours, so prices/premiums show even after close.
// PUBLIC: anyone can read the data once an admin has connected Zerodha. ---
app.get("/api/quotes", async (req: Request, res: Response) => {
  const tokens = String(req.query.tokens ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (tokens.length === 0) {
    res.status(400).json({ error: "Provide ?tokens=token1,token2,..." });
    return;
  }
  if (!kite.getAccessToken()) {
    res.status(401).json({
      error: "Quotes require a one-time Zerodha login.",
    });
    return;
  }

  // Serve from the short-lived cache when fresh (protects the Kite quota).
  const cacheKey = tokens.slice().sort((a, b) => a - b).join(",");
  const cached = quotesCache.get(cacheKey);
  if (cached && Date.now() - cached.at < QUOTES_TTL_MS) {
    res.json({ ticks: cached.ticks });
    return;
  }

  try {
    const all = await getAllInstrumentsCached();
    const byToken = new Map<number, string>();
    for (const inst of all) {
      byToken.set(inst.instrument_token, `${inst.exchange}:${inst.tradingsymbol}`);
    }
    const identifiers = tokens
      .map((t) => byToken.get(t))
      .filter((s): s is string => typeof s === "string");

    const quotes = await kite.getQuoteFull(identifiers);
    const ticks = quotes.map((q) => ({
      token: q.instrument_token,
      last_price: q.last_price,
      close_price: q.close,
      oi: q.oi,
      bid: 0, // filled by the live full-mode stream
      ask: 0,
    }));
    quotesCache.set(cacheKey, { at: Date.now(), ticks });
    // Warm the shared hub cache so late-joining SSE clients get instant data.
    tickerHub.seed(ticks);
    res.json({ ticks });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Live data: Server-Sent Events stream of ticks for the given tokens. ---
// The backend opens a Kite WebSocket (using the stored access token), parses
// the binary ticks, and relays them to the browser as JSON SSE events.
// PUBLIC: anyone can subscribe to the live stream once an admin has connected
// Zerodha. The stream only emits data while a valid Zerodha session exists.
//   tokens   comma-separated instrument tokens
app.get("/api/stream", (req: Request, res: Response) => {
  const tokens = String(req.query.tokens ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (tokens.length === 0) {
    res.status(400).json({ error: "Provide ?tokens=token1,token2,..." });
    return;
  }

  const accessToken = kite.getAccessToken();
  if (!accessToken) {
    res.status(401).json({
      error:
        "Live prices require a one-time Zerodha login. Click “Connect to Zerodha”.",
    });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // Register with the shared hub (one upstream Zerodha WS for all viewers).
  const unsubscribe = tickerHub.addClient(res, tokens);

  // Keep the connection alive through proxies.
  const keepAlive = setInterval(() => res.write(`: ping\n\n`), 20000);

  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
    res.end();
  });
});

// --- Dividend yields (%) per F&O stock, sourced from Yahoo Finance.
// Cached for 24h. Works without a Zerodha login. Failures map to 0%. ---
app.get("/api/dividends", async (_req: Request, res: Response) => {
  try {
    if (dividendCache && Date.now() - dividendCache.at < DIVIDEND_TTL_MS) {
      res.json({ yields: dividendCache.data, cachedAt: dividendCache.at });
      return;
    }
    const all = await getAllInstrumentsCached();
    const symbols = deriveFnoBoard(all)
      .filter((b) => !b.is_index) // indices have no Yahoo dividend yield
      .map((b) => b.symbol);
    const yields = await getDividendYields(symbols);
    dividendCache = { at: Date.now(), data: yields };
    res.json({ yields, cachedAt: dividendCache.at });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Debug: inspect how indices are detected (helps diagnose deployments). ---
app.get("/api/debug/indices", async (_req: Request, res: Response) => {
  try {
    const all = await getAllInstrumentsCached();
    const indexInstruments = all
      .filter((i) => i.segment === "INDICES")
      .map((i) => i.tradingsymbol);
    const futNames = new Set(
      all
        .filter((i) => i.exchange === "NFO" && i.instrument_type === "FUT")
        .map((i) => i.name),
    );
    const resolved = Object.entries(INDEX_SPOT_MAP).map(([underlying, spot]) => ({
      underlying,
      hasFutures: futNames.has(underlying),
      spotSymbol: spot,
      spotFound: indexInstruments.includes(spot),
    }));
    const board = deriveFnoBoard(all);
    res.json({
      totalIndexInstruments: indexInstruments.length,
      sampleIndexTradingSymbols: indexInstruments.slice(0, 25),
      resolved,
      indexRowsInBoard: board.filter((b) => b.is_index).map((b) => ({
        symbol: b.symbol,
        name: b.name,
        futures: b.futures.length,
      })),
      totalBoardRows: board.length,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Historical daily open interest + close (last ~3 months) for a symbol's futures. ---
// Returns each future's closing OI + price per trading day, for the detail-page chart.
// PUBLIC (needs a Zerodha session + historical-data subscription).
//
// Daily closing OI is fixed for a given calendar day, so we cache per symbol
// for the whole trading day (IST) and only refetch once the date rolls over.
const historyCache = new Map<string, { day: string; data: unknown }>();

/** Calendar day in IST (UTC+5:30) as YYYY-MM-DD — defaults to right now. */
function istDayKey(at: number = Date.now()): string {
  const ist = new Date(at + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

/** A Date as an IST "YYYY-MM-DD HH:MM:SS" string (Kite expects exchange time). */
function istDateTime(d: Date): string {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 19).replace("T", " ");
}

/** True during NSE market hours: Mon-Fri, 09:15-15:30 IST. */
function isMarketOpen(): boolean {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const day = ist.getUTCDay(); // 0 Sun ... 6 Sat (on the IST-shifted date)
  if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

/** Simple delay helper to avoid rate-limiting on consecutive Kite API calls. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build a token -> "EXCHANGE:TRADINGSYMBOL" resolver from the instrument dump. */
function makeIdResolver(all: Instrument[]): (token: number) => string | null {
  const byToken = new Map<number, string>();
  for (const inst of all) {
    byToken.set(inst.instrument_token, `${inst.exchange}:${inst.tradingsymbol}`);
  }
  return (token: number) => byToken.get(token) ?? null;
}

app.get("/api/history/:symbol", async (req: Request, res: Response) => {
  if (!kite.getAccessToken()) {
    res.status(401).json({ error: "Historical data requires a Zerodha login." });
    return;
  }
  const symbol = String(req.params.symbol).toUpperCase();

  const today = istDayKey();
  const cached = historyCache.get(symbol);
  if (cached && cached.day === today) {
    res.json(cached.data);
    return;
  }

  try {
    const all = await getAllInstrumentsCached();
    const item = deriveFnoBoard(all).find((b) => b.symbol.toUpperCase() === symbol);
    if (!item) {
      res.status(404).json({ error: `No F&O instrument found for "${symbol}".` });
      return;
    }

    const to = new Date();
    const from = new Date();
    // Three months of daily candles: the Price/Spread "3M" view is the widest
    // daily window the detail page offers, so this endpoint has to reach that far.
    from.setMonth(from.getMonth() - 3);
    const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

    const futures: {
      token: number;
      expiry: string;
      points: { date: string; oi: number; close: number }[];
    }[] = [];
    for (const f of item.futures) {
      const candles = await kite.getHistoricalOi(f.token, fmtDate(from), fmtDate(to));
      futures.push({
        token: f.token,
        expiry: f.expiry,
        points: candles.map((c) => ({ date: c.date, oi: c.oi, close: c.close })),
      });
    }

    const data = {
      symbol: item.symbol,
      name: item.name,
      is_index: !!item.is_index,
      futures,
    };
    historyCache.set(symbol, { day: today, data });
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

// --- Spread history: combined calendar-spread (next - current close) for ~2 years. ---
// Fetches daily candles directly from Kite for each pair of consecutive futures
// and merges their overlapping-date spreads into a single timeline with stats.
const spreadHistoryCache = new Map<string, { day: string; data: unknown }>();

app.get("/api/spread-history/:symbol", async (req: Request, res: Response) => {
  if (!kite.getAccessToken()) {
    res.status(401).json({ error: "Historical data requires a Zerodha login." });
    return;
  }
  const symbol = String(req.params.symbol).toUpperCase();

  const today = istDayKey();
  const cached = spreadHistoryCache.get(symbol);
  if (cached && cached.day === today) {
    res.json(cached.data);
    return;
  }

  try {
    const all = await getAllInstrumentsCached();
    const item = deriveFnoBoard(all).find((b) => b.symbol.toUpperCase() === symbol);
    if (!item) {
      res.status(404).json({ error: `No F&O instrument found for "${symbol}".` });
      return;
    }

    // Date range: 2 years back to today.
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setFullYear(fromDate.getFullYear() - 2);
    const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
    const fromStr = fmtDate(fromDate);
    const toStr = fmtDate(toDate);

    // Fetch daily candles for each future (with 200ms delay between calls).
    const futureCandles: Map<string, number>[] = []; // date -> close per future
    for (let i = 0; i < item.futures.length; i++) {
      if (i > 0) await delay(200);
      const candles = await kite.getHistorical(item.futures[i]!.token, fromStr, toStr, "day");
      const map = new Map<string, number>();
      for (const c of candles) {
        map.set(c.t.slice(0, 10), c.close);
      }
      futureCandles.push(map);
    }

    // For each consecutive pair, compute spread = next_close - current_close
    // on dates where both have data.
    const spreadMap = new Map<string, number>(); // date -> spread (prefer earlier pair)
    for (let p = 0; p < item.futures.length - 1; p++) {
      const currentMap = futureCandles[p]!;
      const nextMap = futureCandles[p + 1]!;
      for (const [date, nextClose] of nextMap) {
        const currentClose = currentMap.get(date);
        if (currentClose !== undefined && !spreadMap.has(date)) {
          spreadMap.set(date, nextClose - currentClose);
        }
      }
    }

    // Sort chronologically.
    const points = Array.from(spreadMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, spread]) => ({ date, spread: Math.round(spread * 100) / 100 }));

    // Compute stats.
    let sum = 0;
    let max = -Infinity;
    let min = Infinity;
    for (const pt of points) {
      sum += pt.spread;
      if (pt.spread > max) max = pt.spread;
      if (pt.spread < min) min = pt.spread;
    }
    const count = points.length;
    const mean = count > 0 ? Math.round((sum / count) * 100) / 100 : 0;
    if (count === 0) {
      max = 0;
      min = 0;
    }

    const dataRange = {
      from: points.length > 0 ? points[0]!.date : fromStr,
      to: points.length > 0 ? points[points.length - 1]!.date : toStr,
    };

    const data = {
      symbol: item.symbol,
      name: item.name,
      is_index: !!item.is_index,
      dataRange,
      points,
      stats: { mean, max, min, count },
    };

    spreadHistoryCache.set(symbol, { day: today, data });
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

// --- Hourly closing price for the last ~1 week, per future. Cached per day. ---
const intradayCache = new Map<string, { day: string; data: unknown }>();

app.get("/api/intraday/:symbol", async (req: Request, res: Response) => {
  if (!kite.getAccessToken()) {
    res.status(401).json({ error: "Historical data requires a Zerodha login." });
    return;
  }
  const symbol = String(req.params.symbol).toUpperCase();

  const today = istDayKey();
  const cached = intradayCache.get(symbol);
  if (cached && cached.day === today) {
    res.json(cached.data);
    return;
  }

  try {
    const all = await getAllInstrumentsCached();
    const item = deriveFnoBoard(all).find((b) => b.symbol.toUpperCase() === symbol);
    if (!item) {
      res.status(404).json({ error: `No F&O instrument found for "${symbol}".` });
      return;
    }

    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 7);
    const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

    const futures: {
      token: number;
      expiry: string;
      points: { t: string; close: number }[];
    }[] = [];
    for (const f of item.futures) {
      const candles = await kite.getHistorical(
        f.token,
        fmtDate(from),
        fmtDate(to),
        "60minute",
      );
      futures.push({
        token: f.token,
        expiry: f.expiry,
        points: candles.map((c) => ({ t: c.t, close: c.close })),
      });
    }

    const data = {
      symbol: item.symbol,
      name: item.name,
      is_index: !!item.is_index,
      futures,
    };
    intradayCache.set(symbol, { day: today, data });
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

// --- Minute-by-minute closing price for the last 2 hours, per future. ---
// Short-lived cache (60s) since this is near-real-time intraday data.
const minuteCache = new Map<string, { at: number; data: unknown }>();
const MINUTE_TTL_MS = 60 * 1000;

app.get("/api/minute/:symbol", async (req: Request, res: Response) => {
  if (!kite.getAccessToken()) {
    res.status(401).json({ error: "Historical data requires a Zerodha login." });
    return;
  }
  const symbol = String(req.params.symbol).toUpperCase();

  const cached = minuteCache.get(symbol);
  if (cached && Date.now() - cached.at < MINUTE_TTL_MS) {
    res.json(cached.data);
    return;
  }

  try {
    const all = await getAllInstrumentsCached();
    const item = deriveFnoBoard(all).find((b) => b.symbol.toUpperCase() === symbol);
    if (!item) {
      res.status(404).json({ error: `No F&O instrument found for "${symbol}".` });
      return;
    }

    const toD = new Date();
    const fromD = new Date(Date.now() - 2 * 60 * 60 * 1000);

    const futures: {
      token: number;
      expiry: string;
      points: { t: string; close: number }[];
    }[] = [];
    for (const f of item.futures) {
      const candles = await kite.getHistorical(
        f.token,
        istDateTime(fromD),
        istDateTime(toD),
        "minute",
      );
      futures.push({
        token: f.token,
        expiry: f.expiry,
        points: candles.map((c) => ({ t: c.t, close: c.close })),
      });
    }

    const data = {
      symbol: item.symbol,
      name: item.name,
      is_index: !!item.is_index,
      futures,
    };
    minuteCache.set(symbol, { at: Date.now(), data });
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

// --- 5-minute closing price for the current day, per future (5-min cache). ---
const fiveMinCache = new Map<string, { at: number; data: unknown }>();
const FIVEMIN_TTL_MS = 5 * 60 * 1000;

app.get("/api/fivemin/:symbol", async (req: Request, res: Response) => {
  if (!kite.getAccessToken()) {
    res.status(401).json({ error: "Historical data requires a Zerodha login." });
    return;
  }
  const symbol = String(req.params.symbol).toUpperCase();

  const cached = fiveMinCache.get(symbol);
  if (cached && Date.now() - cached.at < FIVEMIN_TTL_MS) {
    res.json(cached.data);
    return;
  }

  try {
    const all = await getAllInstrumentsCached();
    const item = deriveFnoBoard(all).find((b) => b.symbol.toUpperCase() === symbol);
    if (!item) {
      res.status(404).json({ error: `No F&O instrument found for "${symbol}".` });
      return;
    }

    const today = istDayKey();
    const futures: {
      token: number;
      expiry: string;
      points: { t: string; close: number }[];
    }[] = [];
    for (const f of item.futures) {
      const candles = await kite.getHistorical(f.token, today, today, "5minute");
      futures.push({
        token: f.token,
        expiry: f.expiry,
        points: candles.map((c) => ({ t: c.t, close: c.close })),
      });
    }

    const data = {
      symbol: item.symbol,
      name: item.name,
      is_index: !!item.is_index,
      futures,
    };
    fiveMinCache.set(symbol, { at: Date.now(), data });
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

// --- F&O board: every F&O stock with its spot token + 3 nearest futures,
// so the frontend can render them all stacked and stream every token live. ---
app.get("/api/fno-board", async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim().toLowerCase();
  try {
    const all = await getAllInstrumentsCached();
    let board = deriveFnoBoard(all);
    if (q) {
      board = board.filter(
        (b) =>
          b.symbol.toLowerCase().includes(q) ||
          b.name.toLowerCase().includes(q),
      );
    }
    res.json({ count: board.length, board });
  } catch (err) {
    sendError(res, err);
  }
});

// ============================================================================
//  Options analytics: live option chain (ATM-centered band) for an index/stock.
//  Returns the CE/PE instrument tokens for a band of strikes around the ATM so
//  the frontend can stream LTP + OI per strike and compute the chain live.
//  PUBLIC (data flows once an admin has connected Zerodha).
// ============================================================================

interface OptionStrikeRow {
  strike: number;
  ce_token: number;
  pe_token: number;
  ce_symbol: string;
  pe_symbol: string;
}

app.get("/api/option-chain/:underlying", async (req: Request, res: Response) => {
  const underlying = String(req.params.underlying).toUpperCase();
  const expiryParam = String(req.query.expiry ?? "").trim();
  // Strikes on EACH side of ATM to return. We return a generous band (default
  // 40) so the ATM can drift intraday while the frontend still shows ATM ± 30.
  const band = Math.min(80, Math.max(5, Number(req.query.band ?? 40)));

  if (!kite.getAccessToken()) {
    res.status(401).json({
      error: "Option chain requires a one-time Zerodha login.",
    });
    return;
  }

  try {
    const all = await getAllInstrumentsCached();

    // All option contracts (CE/PE) for this underlying on NFO.
    const opts = all.filter(
      (i) =>
        i.exchange === "NFO" &&
        (i.instrument_type === "CE" || i.instrument_type === "PE") &&
        i.name === underlying,
    );
    if (opts.length === 0) {
      res.status(404).json({ error: `No options found for "${underlying}".` });
      return;
    }

    const today = istDayKey();
    // Live (non-expired) expiries, ascending. ISO dates sort chronologically.
    const expiries = Array.from(
      new Set(opts.map((o) => o.expiry).filter((e) => e && e >= today)),
    ).sort();
    if (expiries.length === 0) {
      res.status(404).json({ error: `No live expiries for "${underlying}".` });
      return;
    }
    const expiry =
      expiryParam && expiries.includes(expiryParam) ? expiryParam : expiries[0]!;

    // Resolve the underlying spot instrument (index or equity) to find the ATM.
    const spotSymbol = INDEX_SPOT_MAP[underlying];
    const spotInst = spotSymbol
      ? all.find((i) => i.segment === "INDICES" && i.tradingsymbol === spotSymbol)
      : all.find(
          (i) =>
            i.exchange === "NSE" &&
            i.instrument_type === "EQ" &&
            i.tradingsymbol === underlying,
        );
    if (!spotInst) {
      res.status(404).json({ error: `No spot instrument for "${underlying}".` });
      return;
    }

    // Current spot last price (used only to center the band; frontend recomputes
    // the live ATM from the streamed spot tick).
    let spot = 0;
    try {
      const [q] = await kite.getQuoteFull([
        `${spotInst.exchange}:${spotInst.tradingsymbol}`,
      ]);
      spot = q?.last_price ?? 0;
    } catch {
      /* non-fatal: fall back to the median strike below */
    }

    // Group the chosen expiry's contracts by strike.
    const byStrike = new Map<number, { ce?: Instrument; pe?: Instrument }>();
    let lotSize = 0;
    for (const o of opts) {
      if (o.expiry !== expiry || !o.strike) continue;
      const entry = byStrike.get(o.strike) ?? {};
      if (o.instrument_type === "CE") entry.ce = o;
      else entry.pe = o;
      byStrike.set(o.strike, entry);
      if (!lotSize) lotSize = o.lot_size;
    }
    const allStrikes = Array.from(byStrike.keys()).sort((a, b) => a - b);
    if (allStrikes.length === 0) {
      res.status(404).json({ error: `No strikes for expiry ${expiry}.` });
      return;
    }

    // ATM = strike closest to spot (fallback: median strike when spot missing).
    let atmStrike = allStrikes[Math.floor(allStrikes.length / 2)]!;
    if (spot > 0) {
      atmStrike = allStrikes.reduce(
        (best, s) => (Math.abs(s - spot) < Math.abs(best - spot) ? s : best),
        allStrikes[0]!,
      );
    }
    const atmIdx = allStrikes.indexOf(atmStrike);
    const lo = Math.max(0, atmIdx - band);
    const hi = Math.min(allStrikes.length - 1, atmIdx + band);

    const strikes: OptionStrikeRow[] = [];
    for (let i = lo; i <= hi; i++) {
      const s = allStrikes[i]!;
      const entry = byStrike.get(s)!;
      if (!entry.ce || !entry.pe) continue; // need both legs to show the row
      strikes.push({
        strike: s,
        ce_token: entry.ce.instrument_token,
        pe_token: entry.pe.instrument_token,
        ce_symbol: entry.ce.tradingsymbol,
        pe_symbol: entry.pe.tradingsymbol,
      });
    }

    res.json({
      underlying,
      name: spotInst.tradingsymbol,
      spot_token: spotInst.instrument_token,
      spot,
      atm_strike: atmStrike,
      expiry,
      expiries,
      lot_size: lotSize,
      strikes,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Option-OI baseline: per-token OI + LTP as of `minutes` ago.
// Powers the chain's OI-change % and buildup columns for the 1m/5m/15m/1h windows
// with a real baseline immediately on load. Served from the Redis-backed chain
// snapshots, so it survives a restart instead of starting from nothing. ---
app.get("/api/option-oi-baseline/:underlying", (req: Request, res: Response) => {
  const requested = Number(req.query.minutes ?? 5);
  const minutes = Number.isFinite(requested)
    ? Math.min(240, Math.max(1, Math.round(requested)))
    : 5;
  const day = istDayKey();
  const { oldest, newest } = chainSnapshotSpan();
  const snap = chainBaselineAt(Date.now() - minutes * 60 * 1000);
  if (!snap) {
    // No reading that old. Reporting empty (rather than the oldest we hold) is
    // what stops a 20-minute-old value being presented as a 1-hour change.
    res.json({ day, expiry: null, minutes, oldest, newest, baseT: null, tokens: {} });
    return;
  }
  const tokens: Record<number, { oi: number; ltp: number; t: number }> = {};
  for (const [token, pair] of Object.entries(snap.tokens)) {
    tokens[Number(token)] = { oi: pair[0], ltp: pair[1], t: snap.t };
  }
  res.json({
    day,
    expiry: snap.expiry,
    minutes,
    // What the cache actually spans, so the client can offer only the windows it
    // can serve rather than showing a column of dashes.
    oldest,
    newest,
    baseT: snap.t,
    tokens,
  });
});

// --- Option previous-session CLOSE: per-token OI + LTP at the last session's
// close, the baseline for the chain's "Day" change column. Snapshotted at the IST
// day rollover and reconstructed from Kite daily candles on a cold start. ---
app.get("/api/option-prev-close/:underlying", (_req: Request, res: Response) => {
  const today = istDayKey();
  // A stale baseline (from an earlier day) would silently mislabel the change, so
  // report empty until the rollover snapshot or the backfill refreshes it.
  if (!optionPrevClose || optionPrevClose.forDay !== today) {
    res.json({
      forDay: today,
      closedOn: null,
      expiry: null,
      complete: false,
      tokens: {},
    });
    return;
  }
  res.json(optionPrevClose);
});

// --- Option-OI intraday series: full-day per-minute aggregates (today only).
// Returns total Call/Put OI (24↑/ATM/26↓ window) and the ATM straddle for each
// captured minute so the frontend charts show the whole day right on load. ---
app.get("/api/option-oi-series/:underlying", (_req: Request, res: Response) => {
  const day = istDayKey();
  if (!optionOiDay || optionOiDay.day !== day) {
    res.json({ day, expiry: null, points: [] });
    return;
  }
  const store = optionOiDay;

  // Strike -> token maps, and the sorted strike ladder.
  const ceByStrike = new Map<number, number>();
  const peByStrike = new Map<number, number>();
  for (const [tok, m] of store.meta) {
    (m.type === "CE" ? ceByStrike : peByStrike).set(m.strike, tok);
  }
  const strikes = Array.from(
    new Set(Array.from(store.meta.values()).map((m) => m.strike)),
  ).sort((a, b) => a - b);

  const points: {
    t: number;
    totalCe: number;
    totalPe: number;
    straddle: number;
  }[] = [];
  const n = store.spot.length;
  for (let i = 0; i < n; i++) {
    const sp = store.spot[i];
    if (!sp) continue;
    // ATM for this minute from the captured spot.
    let atmIdx = 0;
    let bestD = Infinity;
    for (let k = 0; k < strikes.length; k++) {
      const d = Math.abs(strikes[k]! - sp.ltp);
      if (d < bestD) {
        bestD = d;
        atmIdx = k;
      }
    }
    const lo = Math.max(0, atmIdx - 26);
    const hi = Math.min(strikes.length - 1, atmIdx + 24);
    let totalCe = 0;
    let totalPe = 0;
    for (let k = lo; k <= hi; k++) {
      const ceTok = ceByStrike.get(strikes[k]!);
      const peTok = peByStrike.get(strikes[k]!);
      if (ceTok != null) totalCe += store.series.get(ceTok)?.[i]?.oi ?? 0;
      if (peTok != null) totalPe += store.series.get(peTok)?.[i]?.oi ?? 0;
    }
    const atmStrike = strikes[atmIdx]!;
    const ceAtm = ceByStrike.get(atmStrike);
    const peAtm = peByStrike.get(atmStrike);
    const ceLtp = ceAtm != null ? store.series.get(ceAtm)?.[i]?.ltp ?? 0 : 0;
    const peLtp = peAtm != null ? store.series.get(peAtm)?.[i]?.ltp ?? 0 : 0;
    points.push({
      t: sp.t,
      totalCe,
      totalPe,
      straddle: ceLtp > 0 && peLtp > 0 ? ceLtp + peLtp : 0,
    });
  }
  res.json({ day, expiry: store.expiry, points });
});

// --- Multi-timeframe Call/Put total-OI history for the analytics OI chart.
// Returns the retained aggregate series for a frame: 1m (last 1 day), 5m (last
// 3 days) or 15m (last 1 week). Points are { t, totalCe, totalPe } over the
// 24↑/ATM/26↓ window. Filled live + backfilled from Kite on downtime. ---
app.get("/api/option-oi-frame/:underlying", (req: Request, res: Response) => {
  const frame = parseFrameKey(req.query.frame);
  res.json({
    frame,
    intervalMin: OI_FRAMES[frame].intervalMin,
    retentionMs: OI_FRAMES[frame].retentionMs,
    points: completedBuckets(oiFrameStores[frame].points),
  });
});

// --- Multi-timeframe NIFTY FUTURES open-interest history (3 monthly contracts).
// Same frame contract as /api/option-oi-frame: 1m (last 1 day), 5m (last 3 days)
// or 15m (last 1 week). Each point carries one leg per contract, keyed by expiry
// so the client can plot current/next/far month as three series. ---
app.get("/api/futures-oi-frame/:underlying", (req: Request, res: Response) => {
  const frame = parseFrameKey(req.query.frame);
  const points = completedBuckets(futOiFrameStores[frame].points);
  // Report every contract this frame still holds data for (not just the ones
  // currently being captured), so a just-expired month keeps its line until it
  // falls out of the retention window.
  const expiries = new Set<string>();
  for (const p of points) {
    for (const l of p.legs) expiries.add(l.expiry);
  }
  for (const c of futOiContracts) expiries.add(c.expiry);
  const contracts = Array.from(expiries)
    .sort()
    .map(
      (expiry) =>
        futOiKnownContracts.get(expiry) ?? {
          token: 0,
          tradingsymbol: "",
          expiry,
          lot_size: 0,
        },
    );

  res.json({
    frame,
    intervalMin: OI_FRAMES[frame].intervalMin,
    retentionMs: OI_FRAMES[frame].retentionMs,
    contracts,
    points,
  });
});

// ============================================================================
//  Spread stats: per-symbol summary from the spread_summary collection.
// ============================================================================

app.get("/api/spread-stats/:symbol", async (req: Request, res: Response) => {
  const symbol = String(req.params.symbol).toUpperCase();
  try {
    const doc = await SpreadSummary.findOne({ symbol }).lean();
    if (!doc) {
      res.status(404).json({ error: `No spread summary found for "${symbol}".` });
      return;
    }
    res.json(doc);
  } catch (err) {
    sendError(res, err);
  }
});

// ============================================================================
//  Calendar-spread trades (P&L) — admin only, persisted in MongoDB.
//  A trade BUYS the discount leg and SELLS the premium leg, using the current
//  and next month futures, for exactly 1 lot.
// ============================================================================

/**
 * Volume-weighted fill price for a market order of `quantity`, walking the
 * given order-book side (best level first). This reproduces a real market
 * order: it fills at the touch when there's enough size, and slips into deeper
 * levels when the lot is larger than what's available — exactly like a broker.
 */
interface Ladder {
  last: number;
  bids: { price: number; qty: number }[];
  asks: { price: number; qty: number }[];
}

/**
 * Resolve the order book for tokens, preferring the freshest LIVE book from the
 * WebSocket hub (lowest latency) and falling back to a REST /quote snapshot for
 * anything the hub doesn't have fresh (e.g. index spot has no depth).
 */
async function resolveLadder(tokens: number[]): Promise<Map<number, Ladder>> {
  const out = new Map<number, Ladder>();
  const missing: number[] = [];
  for (const tk of tokens) {
    const fresh = tickerHub.getFreshLadder(tk);
    if (fresh && (fresh.bids.length > 0 || fresh.asks.length > 0)) {
      out.set(tk, fresh);
    } else {
      missing.push(tk);
    }
  }
  if (missing.length > 0) {
    const all = await getAllInstrumentsCached();
    const resolveId = makeIdResolver(all);
    const ids = missing
      .map(resolveId)
      .filter((s): s is string => typeof s === "string");
    const rest = await kite.getQuoteLadder(ids);
    for (const [tk, v] of rest) out.set(tk, v);
  }
  return out;
}

function vwapFill(
  levels: { price: number; qty: number }[],
  quantity: number,
  fallback: number,
): number {
  let remaining = quantity;
  let cost = 0;
  let filled = 0;
  for (const lv of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lv.qty);
    if (take <= 0) continue;
    cost += take * lv.price;
    filled += take;
    remaining -= take;
  }
  if (remaining > 0) {
    // Not enough visible depth — fill the remainder at the deepest known price.
    const lastPx = levels.length > 0 ? levels[levels.length - 1]!.price : fallback;
    cost += remaining * lastPx;
    filled += remaining;
  }
  return filled > 0 ? cost / filled : fallback;
}

// ---------------------------------------------------------------------------
// Charges (brokerage + statutory taxes)
//
// Every number here comes from Zerodha's virtual contract note API
// (POST /charges/orders) priced at the ACTUAL fill we simulated. Nothing is
// computed from a local rate card on purpose: STT, stamp duty and the exchange
// turnover slabs change, and a hardcoded formula would quietly misstate the
// P&L of every trade after the next rate revision.
//
// The fills themselves already walk the order book (see vwapFill), so a trade's
// net P&L is now "spread paid + charges paid" — the two real costs of the round
// trip — rather than a mid-price fantasy.
// ---------------------------------------------------------------------------

/** A leg to price charges for: the instrument plus the fill it executed at. */
interface ChargeLeg {
  side: "BUY" | "SELL";
  token: number;
  expiry: string;
  tradingsymbol: string;
  exchange: string;
  quantity: number;
  price: number;
}

/** Round money to paise so float noise never reaches the ledger. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Fold Kite's per-order charge object into this app's flat per-leg record. */
function toLegCharges(leg: ChargeLeg, oc: OrderCharges): ILegCharges {
  const c = oc.charges;
  const brokerage = round2(c.brokerage);
  const stt = round2(c.transaction_tax);
  const exchange_txn = round2(c.exchange_turnover_charge);
  const sebi = round2(c.sebi_turnover_charge);
  const stamp_duty = round2(c.stamp_duty);
  const gst = round2(c.gst.total);
  return {
    side: leg.side,
    tradingsymbol: leg.tradingsymbol,
    quantity: leg.quantity,
    price: round2(leg.price),
    value: round2(leg.quantity * leg.price),
    brokerage,
    stt,
    stt_type: c.transaction_tax_type,
    exchange_txn,
    sebi,
    stamp_duty,
    gst,
    // Sum of the ROUNDED heads rather than Kite's own total, so a leg's total
    // always equals the heads shown for it (a client can sum heads OR totals and
    // land on the same figure). Kite's authoritative total stays in `raw`.
    total: round2(brokerage + stt + exchange_txn + sebi + stamp_duty + gst),
  };
}

/** Sum a set of legs into the charges record stored on the trade. */
function aggregateCharges(
  legs: ILegCharges[],
  source: "kite" | "kite_estimate",
): ITradeCharges {
  const sum = (pick: (l: ILegCharges) => number) =>
    round2(legs.reduce((acc, l) => acc + pick(l), 0));
  return {
    legs,
    value: sum((l) => l.value),
    brokerage: sum((l) => l.brokerage),
    stt: sum((l) => l.stt),
    exchange_txn: sum((l) => l.exchange_txn),
    sebi: sum((l) => l.sebi),
    stamp_duty: sum((l) => l.stamp_duty),
    gst: sum((l) => l.gst),
    total: sum((l) => l.total),
    source,
    at: new Date(),
  };
}

interface PricedCharges {
  charges: ITradeCharges;
  /** Per-leg rows for the ledger, carrying Kite's raw charge payload. */
  logLegs: ITradeLogLeg[];
}

/** The charge heads of a trade side, or zeros when it couldn't be priced. */
function chargeTotals(c: ITradeCharges | null) {
  return {
    brokerage: c?.brokerage ?? 0,
    stt: c?.stt ?? 0,
    exchange_txn: c?.exchange_txn ?? 0,
    sebi: c?.sebi ?? 0,
    stamp_duty: c?.stamp_duty ?? 0,
    gst: c?.gst ?? 0,
    total: c?.total ?? 0,
  };
}

/**
 * Ledger rows for legs Kite couldn't price. What was transacted (instrument,
 * quantity, fill, contract value) is still recorded — the ledger's `source`
 * field says "unpriced" so the zeroed charge heads can't be mistaken for a
 * genuinely free trade.
 */
function unpricedLogLegs(legs: ChargeLeg[]): ITradeLogLeg[] {
  return legs.map((leg) => ({
    side: leg.side,
    tradingsymbol: leg.tradingsymbol,
    quantity: leg.quantity,
    price: round2(leg.price),
    value: round2(leg.quantity * leg.price),
    brokerage: 0,
    stt: 0,
    stt_type: "",
    exchange_txn: 0,
    sebi: 0,
    stamp_duty: 0,
    gst: 0,
    total: 0,
    token: leg.token,
    exchange: leg.exchange,
    expiry: leg.expiry,
    raw: null,
  }));
}

/** The same legs with both sides reversed — i.e. the order that closes them. */
function reverseLegs(legs: ChargeLeg[]): ChargeLeg[] {
  return legs.map((l) => ({
    ...l,
    side: l.side === "BUY" ? ("SELL" as const) : ("BUY" as const),
  }));
}

/**
 * Price one or more GROUPS of legs in a single /charges/orders call.
 *
 * Batching is deliberate: the virtual contract note endpoint shares Kite's
 * order-rate quota, so taking a trade asks for the entry pair and the projected
 * exit pair together (four order lines, one request) instead of twice.
 *
 * Returns null — never throws — when Kite can't price the orders. Charges are a
 * record of a trade, not a precondition for it, so the trade still goes through
 * with charges left null and the UI falls back to showing gross P&L.
 */
async function priceChargeGroups(
  groups: { legs: ChargeLeg[]; source: "kite" | "kite_estimate" }[],
): Promise<PricedCharges[] | null> {
  const orders: ChargeOrder[] = [];
  for (const [gi, g] of groups.entries()) {
    for (const [li, leg] of g.legs.entries()) {
      orders.push({
        // Synthetic ids: these are simulated fills, so there is no broker order
        // to reference. They also let us map responses back to legs by value
        // instead of relying on the response preserving request order.
        order_id: `calspread-${gi}-${li}`,
        exchange: leg.exchange,
        tradingsymbol: leg.tradingsymbol,
        transaction_type: leg.side,
        variety: "regular",
        product: "NRML",
        order_type: "MARKET",
        quantity: leg.quantity,
        average_price: round2(leg.price),
      });
    }
  }
  if (orders.length === 0) return null;

  let priced: OrderCharges[];
  try {
    priced = await kite.getOrderCharges(orders);
  } catch (err) {
    console.warn("[Charges] virtual contract note fetch failed:", err);
    return null;
  }
  if (priced.length !== orders.length) {
    console.warn(
      `[Charges] expected ${orders.length} priced orders, got ${priced.length} — skipping.`,
    );
    return null;
  }

  const byId = new Map(priced.map((p) => [p.order_id, p]));
  const out: PricedCharges[] = [];
  let cursor = 0;
  for (const [gi, g] of groups.entries()) {
    const legCharges: ILegCharges[] = [];
    const logLegs: ITradeLogLeg[] = [];
    for (const [li, leg] of g.legs.entries()) {
      // Prefer the id round-trip; fall back to positional order.
      const oc = byId.get(`calspread-${gi}-${li}`) ?? priced[cursor + li]!;
      const lc = toLegCharges(leg, oc);
      legCharges.push(lc);
      logLegs.push({
        ...lc,
        token: leg.token,
        exchange: leg.exchange,
        expiry: leg.expiry,
        raw: oc.raw,
      });
    }
    cursor += g.legs.length;
    out.push({ charges: aggregateCharges(legCharges, g.source), logLegs });
  }
  return out;
}

/** Serialize a trade record to the API shape (string id, ISO dates). */
function serializeTrade(doc: TradeRecord) {
  return {
    id: doc._id.toString(),
    symbol: doc.symbol,
    name: doc.name,
    is_index: doc.is_index,
    lot_size: doc.lot_size,
    buy: doc.buy,
    sell: doc.sell,
    status: doc.status,
    opened_at: doc.opened_at.toISOString(),
    closed_at: doc.closed_at ? doc.closed_at.toISOString() : null,
    close_pnl: doc.close_pnl,
    buy_close: doc.buy_close,
    sell_close: doc.sell_close,
    margin: doc.margin,
    entry_charges: doc.entry_charges ?? null,
    exit_charges: doc.exit_charges ?? null,
    est_exit_charges: doc.est_exit_charges ?? null,
    entry_value: doc.entry_value ?? null,
    exit_value: doc.exit_value ?? null,
    total_charges: doc.total_charges ?? null,
    net_pnl: doc.net_pnl ?? null,
  };
}

// --- Take a trade: buy the discount leg, sell the premium leg (current+next). ---
app.post("/api/trades", requireAdmin, async (req: Request, res: Response) => {
  if (!isDbEnabled()) {
    res.status(503).json({ error: "Trade persistence is not configured (set MONGODB_URI)." });
    return;
  }
  if (!kite.getAccessToken()) {
    res.status(401).json({ error: "Connect to Zerodha before taking a trade." });
    return;
  }
  if (!isMarketOpen()) {
    res.status(400).json({
      error: "Trades can only be taken during market hours (Mon–Fri, 9:15–15:30 IST).",
    });
    return;
  }

  const symbol = String(req.body?.symbol ?? "").trim().toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: "Provide a symbol." });
    return;
  }

  try {
    const all = await getAllInstrumentsCached();
    const item = deriveFnoBoard(all).find((b) => b.symbol.toUpperCase() === symbol);
    if (!item) {
      res.status(404).json({ error: `No F&O instrument found for "${symbol}".` });
      return;
    }
    if (item.futures.length < 2) {
      res.status(400).json({
        error: "Need both current and next month futures to place a calendar spread.",
      });
      return;
    }

    const current = item.futures[0]!;
    const next = item.futures[1]!;

    // Guard against an already-open trade on the same symbol.
    const existing = await Trade.findOne({ symbol: item.symbol, status: "open" }).lean();
    if (existing) {
      res.status(409).json({ error: `A trade for ${item.symbol} is already open.` });
      return;
    }

    // Live 5-level order book for spot + both legs (WebSocket first, REST fallback).
    const ladders = await resolveLadder([item.spot_token, current.token, next.token]);

    const spot = ladders.get(item.spot_token)?.last;
    const curL = ladders.get(current.token);
    const nextL = ladders.get(next.token);

    if (!spot || !curL || !nextL || !curL.last || !nextL.last) {
      res.status(502).json({
        error: "Could not fetch live prices for all legs right now. Try again shortly.",
      });
      return;
    }

    // Premium/discount vs spot (using last price). Buy the cheaper (lower
    // premium) leg, sell the richer one.
    const premCurrent = curL.last - spot;
    const premNext = nextL.last - spot;

    const currentLeg = { token: current.token, expiry: current.expiry, ladder: curL };
    const nextLeg = { token: next.token, expiry: next.expiry, ladder: nextL };

    const [buyLeg, sellLeg] =
      premCurrent <= premNext ? [currentLeg, nextLeg] : [nextLeg, currentLeg];

    // Realistic market-order fills: BUY walks the ask side, SELL walks the bid
    // side, for the full lot quantity (captures slippage/partial fills).
    const buyEntry = vwapFill(buyLeg.ladder.asks, current.lot_size, buyLeg.ladder.last);
    const sellEntry = vwapFill(sellLeg.ladder.bids, current.lot_size, sellLeg.ladder.last);

    // Look up tradingsymbol + exchange for each leg (needed by the margin API).
    const instByToken = new Map<number, { tradingsymbol: string; exchange: string }>();
    for (const inst of all) {
      instByToken.set(inst.instrument_token, {
        tradingsymbol: inst.tradingsymbol,
        exchange: inst.exchange,
      });
    }
    const buyInst = instByToken.get(buyLeg.token);
    const sellInst = instByToken.get(sellLeg.token);

    // Fetch the net basket margin for [BUY 1 lot, SELL 1 lot]. Non-fatal: if it
    // fails, we still record the trade with margin = null.
    let margin: number | null = null;
    if (buyInst && sellInst) {
      try {
        const res = await kite.getBasketMargin([
          {
            exchange: buyInst.exchange,
            tradingsymbol: buyInst.tradingsymbol,
            transaction_type: "BUY",
            variety: "regular",
            product: "NRML",
            order_type: "MARKET",
            quantity: current.lot_size,
            price: 0,
          },
          {
            exchange: sellInst.exchange,
            tradingsymbol: sellInst.tradingsymbol,
            transaction_type: "SELL",
            variety: "regular",
            product: "NRML",
            order_type: "MARKET",
            quantity: current.lot_size,
            price: 0,
          },
        ]);
        margin = Math.round(res.total);
      } catch (marginErr) {
        console.warn("Basket margin fetch failed:", marginErr);
      }
    }

    // --- Charges: Zerodha's virtual contract note for the entry fills, plus a
    // projection of the exit priced at those same fills.
    //
    // The projection exists so an OPEN trade can be shown net of the FULL round
    // trip: you pay entry charges now and exit charges later, and a P&L that
    // only subtracts the entry half would flatter every open position. It is
    // overwritten with the real contract note when the trade is closed. ---
    const entryLegs: ChargeLeg[] =
      buyInst && sellInst
        ? [
            {
              side: "BUY",
              token: buyLeg.token,
              expiry: buyLeg.expiry,
              tradingsymbol: buyInst.tradingsymbol,
              exchange: buyInst.exchange,
              quantity: current.lot_size,
              price: buyEntry,
            },
            {
              side: "SELL",
              token: sellLeg.token,
              expiry: sellLeg.expiry,
              tradingsymbol: sellInst.tradingsymbol,
              exchange: sellInst.exchange,
              quantity: current.lot_size,
              price: sellEntry,
            },
          ]
        : [];

    let entryCharges: ITradeCharges | null = null;
    let estExitCharges: ITradeCharges | null = null;
    let entryLogLegs: ITradeLogLeg[] = unpricedLogLegs(entryLegs);

    if (entryLegs.length > 0) {
      const priced = await priceChargeGroups([
        { legs: entryLegs, source: "kite" },
        { legs: reverseLegs(entryLegs), source: "kite_estimate" },
      ]);
      if (priced) {
        entryCharges = priced[0]!.charges;
        entryLogLegs = priced[0]!.logLegs;
        estExitCharges = priced[1]!.charges;
      }
    }

    // Contract value transacted, derived from the fills rather than from the
    // charge legs: it must be recorded even when the instrument lookup or the
    // charges call fails.
    const entryValue = round2(current.lot_size * (buyEntry + sellEntry));
    const openedAt = new Date();

    const payload: ITrade = {
      symbol: item.symbol,
      name: item.name,
      is_index: !!item.is_index,
      lot_size: current.lot_size,
      buy: { token: buyLeg.token, expiry: buyLeg.expiry, entry: buyEntry },
      sell: { token: sellLeg.token, expiry: sellLeg.expiry, entry: sellEntry },
      status: "open",
      opened_at: openedAt,
      closed_at: null,
      close_pnl: null,
      buy_close: null,
      sell_close: null,
      margin,
      entry_charges: entryCharges,
      exit_charges: null,
      est_exit_charges: estExitCharges,
      entry_value: entryValue,
      exit_value: null,
      total_charges: null,
      net_pnl: null,
    };

    const created = await Trade.create(payload);

    // Append the entry to the charges ledger (best-effort, never blocks).
    void appendTradeLog({
      trade_id: created._id.toString(),
      symbol: item.symbol,
      name: item.name,
      is_index: !!item.is_index,
      lot_size: current.lot_size,
      event: "entry",
      at: openedAt,
      legs: entryLogLegs,
      value: entryValue,
      charges: chargeTotals(entryCharges),
      source: entryCharges ? "kite" : "unpriced",
      margin,
      gross_pnl: null,
      total_charges: null,
      net_pnl: null,
    });

    res.json({ trade: serializeTrade(created.toObject() as TradeRecord) });
  } catch (err) {
    sendError(res, err);
  }
});

// --- List all trades (open + closed), newest first. ---
app.get("/api/trades", requireAdmin, async (_req: Request, res: Response) => {
  if (!isDbEnabled()) {
    res.json({ dbEnabled: false, trades: [] });
    return;
  }
  try {
    const docs = await Trade.find()
      .sort({ opened_at: -1 })
      .limit(200)
      .lean<TradeRecord[]>();
    res.json({ dbEnabled: true, trades: docs.map(serializeTrade) });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Close a trade: lock in final P&L using current prices. ---
app.post("/api/trades/:id/close", requireAdmin, async (req: Request, res: Response) => {
  if (!isDbEnabled()) {
    res.status(503).json({ error: "Trade persistence is not configured (set MONGODB_URI)." });
    return;
  }

  const id = String(req.params.id);
  if (!isValidId(id)) {
    res.status(400).json({ error: "Invalid trade id." });
    return;
  }

  try {
    const trade = await Trade.findById(id);
    if (!trade) {
      res.status(404).json({ error: "Trade not found." });
      return;
    }
    if (trade.status === "closed") {
      res.json({ trade: serializeTrade(trade.toObject() as TradeRecord) });
      return;
    }
    if (!kite.getAccessToken()) {
      res.status(401).json({ error: "Connect to Zerodha to close a trade." });
      return;
    }

    // Realistic market-order exit walking the live book for the lot (WebSocket
    // first, REST fallback): sell the long leg into the BIDS, buy back the
    // short leg from the ASKS.
    const ladders = await resolveLadder([trade.buy.token, trade.sell.token]);

    const buyL = ladders.get(trade.buy.token);
    const sellL = ladders.get(trade.sell.token);
    const curBuy = buyL
      ? vwapFill(buyL.bids, trade.lot_size, buyL.last)
      : trade.buy.entry;
    const curSell = sellL
      ? vwapFill(sellL.asks, trade.lot_size, sellL.last)
      : trade.sell.entry;

    // GROSS P&L: the price move only. Charges come off it below.
    const pnl =
      trade.lot_size *
      ((curBuy - trade.buy.entry) + (trade.sell.entry - curSell));

    // --- Charges for the exit fills: the real virtual contract note for the
    // orders that actually close the spread (sell the long, buy back the short).
    //
    // The instrument lookup is the ONLY thing here that can throw (stale-cache
    // refresh hits Kite and a dead session raises KiteError), and it exists
    // purely to name the legs for the charges call — so it must not be able to
    // block the close itself. On failure we skip real exit charges (the code
    // below falls back to the entry-fill projection) and still mark the trade
    // closed. Charges are a record of the trade, never a precondition for it. ---
    let longInst: { tradingsymbol: string; exchange: string } | undefined;
    let shortInst: { tradingsymbol: string; exchange: string } | undefined;
    try {
      const allInst = await getAllInstrumentsCached();
      const closeInstByToken = new Map<
        number,
        { tradingsymbol: string; exchange: string }
      >();
      for (const inst of allInst) {
        closeInstByToken.set(inst.instrument_token, {
          tradingsymbol: inst.tradingsymbol,
          exchange: inst.exchange,
        });
      }
      longInst = closeInstByToken.get(trade.buy.token);
      shortInst = closeInstByToken.get(trade.sell.token);
    } catch (instErr) {
      console.warn(
        "[Charges] instrument lookup for exit legs failed; closing with the entry-fill charge estimate:",
        instErr,
      );
    }

    const exitLegs: ChargeLeg[] =
      longInst && shortInst
        ? [
            {
              side: "SELL", // closing the long leg
              token: trade.buy.token,
              expiry: trade.buy.expiry,
              tradingsymbol: longInst.tradingsymbol,
              exchange: longInst.exchange,
              quantity: trade.lot_size,
              price: curBuy,
            },
            {
              side: "BUY", // buying back the short leg
              token: trade.sell.token,
              expiry: trade.sell.expiry,
              tradingsymbol: shortInst.tradingsymbol,
              exchange: shortInst.exchange,
              quantity: trade.lot_size,
              price: curSell,
            },
          ]
        : [];

    let exitLogLegs: ITradeLogLeg[] = unpricedLogLegs(exitLegs);
    let exitCharges: ITradeCharges | null = null;
    if (exitLegs.length > 0) {
      const priced = await priceChargeGroups([{ legs: exitLegs, source: "kite" }]);
      if (priced) {
        exitCharges = priced[0]!.charges;
        exitLogLegs = priced[0]!.logLegs;
      }
    }

    // If Kite couldn't price the exit right now, fall back to the projection
    // taken at entry (also a Kite contract note, just priced at the entry
    // fills). Its `source` says "kite_estimate", so the trade never silently
    // claims a precision it doesn't have — but the P&L still carries a real
    // charge figure instead of dropping back to gross.
    // Read the stored charges as plain objects (not live subdocuments) so the
    // fallback is copied into exit_charges rather than re-parented.
    const before = trade.toObject() as TradeRecord;
    const exitChargesFinal = exitCharges ?? before.est_exit_charges ?? null;
    const entryTotal = before.entry_charges?.total ?? null;
    const exitTotal = exitChargesFinal?.total ?? null;
    const totalCharges =
      entryTotal !== null && exitTotal !== null ? round2(entryTotal + exitTotal) : null;
    const closedAt = new Date();
    const grossPnl = round2(pnl);
    // Net off the ROUNDED gross so a client showing gross, charges and net can't
    // have them disagree by a stray paisa (net == gross - total_charges exactly).
    const netPnl = totalCharges !== null ? round2(grossPnl - totalCharges) : null;

    trade.status = "closed";
    trade.closed_at = closedAt;
    trade.close_pnl = grossPnl;
    trade.buy_close = curBuy;
    trade.sell_close = curSell;
    trade.exit_charges = exitChargesFinal;
    trade.exit_value =
      exitLegs.length > 0 ? round2(trade.lot_size * (curBuy + curSell)) : null;
    trade.total_charges = totalCharges;
    trade.net_pnl = netPnl;
    await trade.save();

    // Append the exit (and the round-trip result) to the charges ledger.
    void appendTradeLog({
      trade_id: trade._id.toString(),
      symbol: trade.symbol,
      name: trade.name,
      is_index: trade.is_index,
      lot_size: trade.lot_size,
      event: "exit",
      at: closedAt,
      legs: exitLogLegs,
      value: trade.exit_value ?? 0,
      charges: chargeTotals(exitChargesFinal),
      source: exitCharges
        ? "kite"
        : exitChargesFinal
          ? "kite_estimate"
          : "unpriced",
      margin: trade.margin,
      gross_pnl: grossPnl,
      total_charges: totalCharges,
      net_pnl: netPnl,
    });

    res.json({ trade: serializeTrade(trade.toObject() as TradeRecord) });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Delete a CLOSED trade from history (admin only). ---
app.delete("/api/trades/:id", requireAdmin, async (req: Request, res: Response) => {
  if (!isDbEnabled()) {
    res.status(503).json({ error: "Trade persistence is not configured (set MONGODB_URI)." });
    return;
  }
  const id = String(req.params.id);
  if (!isValidId(id)) {
    res.status(400).json({ error: "Invalid trade id." });
    return;
  }
  try {
    const trade = await Trade.findById(id);
    if (!trade) {
      res.status(404).json({ error: "Trade not found." });
      return;
    }
    if (trade.status !== "closed") {
      res.status(400).json({ error: "Only closed trades can be deleted." });
      return;
    }
    await Trade.deleteOne({ _id: trade._id });
    res.json({ success: true, id });
  } catch (err) {
    sendError(res, err);
  }
});

interface BoardFuture {
  token: number;
  expiry: string;
  lot_size: number;
}

interface BoardItem {
  symbol: string;
  name: string;
  spot_token: number;
  futures: BoardFuture[];
  is_index?: boolean;
}

// F&O index underlyings (as they appear on NFO futures `name`) mapped to their
// NSE spot index tradingsymbol (in the INDICES segment of the instrument dump).
const INDEX_SPOT_MAP: Record<string, string> = {
  NIFTY: "NIFTY 50",
  BANKNIFTY: "NIFTY BANK",
  FINNIFTY: "NIFTY FIN SERVICE",
  MIDCPNIFTY: "NIFTY MID SELECT",
  NIFTYNXT50: "NIFTY NEXT 50",
};

/** Build the full F&O board: each underlying with its spot + 3 nearest futures. */
function deriveFnoBoard(all: Instrument[]): BoardItem[] {
  const futuresByUnderlying = new Map<string, Instrument[]>();
  const eqBySymbol = new Map<string, Instrument>();
  const indexBySymbol = new Map<string, Instrument>();

  for (const i of all) {
    if (i.exchange === "NFO" && i.instrument_type === "FUT" && i.name) {
      const arr = futuresByUnderlying.get(i.name) ?? [];
      arr.push(i);
      futuresByUnderlying.set(i.name, arr);
    } else if (i.segment === "INDICES") {
      // Spot index instruments (e.g. "NIFTY 50", "NIFTY BANK"). Checked BEFORE
      // the equity branch because indices may also carry instrument_type "EQ".
      indexBySymbol.set(i.tradingsymbol, i);
    } else if (i.exchange === "NSE" && i.instrument_type === "EQ") {
      eqBySymbol.set(i.tradingsymbol, i);
    }
  }

  const stocks: BoardItem[] = [];
  const indices: BoardItem[] = [];

  for (const [symbol, futs] of futuresByUnderlying) {
    const futures = futs
      .sort((a, b) => a.expiry.localeCompare(b.expiry))
      .slice(0, 3)
      .map((f) => ({
        token: f.instrument_token,
        expiry: f.expiry,
        lot_size: f.lot_size,
      }));

    const eq = eqBySymbol.get(symbol);
    if (eq) {
      stocks.push({
        symbol,
        name: eq.name,
        spot_token: eq.instrument_token,
        futures,
      });
      continue;
    }

    // Not an equity — try to resolve it as an index underlying.
    const indexTradingSymbol = INDEX_SPOT_MAP[symbol];
    const idx = indexTradingSymbol ? indexBySymbol.get(indexTradingSymbol) : undefined;
    if (idx) {
      indices.push({
        symbol,
        name: idx.tradingsymbol, // e.g. "NIFTY 50"
        spot_token: idx.instrument_token,
        futures,
        is_index: true,
      });
    }
    // else: unknown underlying with no spot → skip
  }

  stocks.sort((a, b) => a.symbol.localeCompare(b.symbol));
  indices.sort((a, b) => a.symbol.localeCompare(b.symbol));
  // Indices first, then stocks alphabetically.
  return [...indices, ...stocks];
}

interface FnoStock extends Instrument {
  fno_lot_size: number;
}

/**
 * Derive the list of F&O *stocks* from the full instrument dump.
 * Logic: every NFO futures contract's `name` is an underlying symbol. Match it
 * to an NSE EQ `tradingsymbol` to get the equity. Indices have no EQ row, so
 * they drop out, leaving only stocks.
 */
function deriveFnoStocks(all: Instrument[]): FnoStock[] {
  const underlyingLot = new Map<string, number>();
  const eqBySymbol = new Map<string, Instrument>();

  for (const i of all) {
    if (i.exchange === "NFO" && i.instrument_type === "FUT" && i.name) {
      // Prefer the nearest contract's lot size; keep the first seen.
      if (!underlyingLot.has(i.name)) underlyingLot.set(i.name, i.lot_size);
    } else if (i.exchange === "NSE" && i.instrument_type === "EQ") {
      eqBySymbol.set(i.tradingsymbol, i);
    }
  }

  const out: FnoStock[] = [];
  for (const [symbol, lot] of underlyingLot) {
    const eq = eqBySymbol.get(symbol);
    if (eq) out.push({ ...eq, fno_lot_size: lot });
  }
  out.sort((a, b) => a.tradingsymbol.localeCompare(b.tradingsymbol));
  return out;
}

async function getAllInstrumentsCached(): Promise<Instrument[]> {
  const fresh = instrumentCache && Date.now() - instrumentCache.at < CACHE_TTL_MS;
  if (fresh && instrumentCache) {
    return instrumentCache.data;
  }
  const data = await kite.getInstruments(); // full multi-exchange dump
  instrumentCache = { at: Date.now(), data };
  return data;
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof KiteError) {
    // An auth failure means the session is no longer valid — clear it (memory +
    // persisted) so the app reflects a logged-out state instead of restoring a
    // dead token on the next restart.
    if (err.status === 401 || err.status === 403) {
      kite.clearSession();
      void clearKiteSession();
    }
    res.status(err.status).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : "Unknown error";
  res.status(500).json({ error: message });
}

/**
 * After a login, immediately backfill any hourly/EOD slots missed while the
 * system was down. This is what guarantees a gap is recovered whenever the app
 * is turned on and logged in (the startup backfill is skipped when there is no
 * session yet, so this post-login trigger covers the "logged in later" case).
 */
function triggerPostLoginBackfill(): void {
  if (hourlyBackfillDeps) {
    console.log("[HourlyCapture] Login detected — backfilling any missed slots.");
    void backfillMissedHours(hourlyBackfillDeps).catch((e) =>
      console.error("[HourlyCapture] post-login backfill failed:", e),
    );
  }
  if (eodBackfillDeps) {
    void backfillStockFutures(eodBackfillDeps).catch((e) =>
      console.error("[EODCapture] post-login backfill failed:", e),
    );
    void checkAndRecomputeSummary();
  }
  // Seed the intraday option-OI cache right away so a baseline exists soon
  // after connecting Zerodha (rather than waiting for the next minute tick).
  // Snapshot the backfill windows FIRST: the captures below stamp every frame
  // at `now`, which would otherwise make the gap detector believe there is
  // nothing left to recover.
  const optFrom = oiBackfillFromMs(Date.now());
  const futFrom = futOiBackfillFromMs(Date.now());
  // Sequential: shares Kite's quote/historical rate budget with the futures
  // pipeline and the periodic capture tick.
  void (async () => {
    await captureOptionOi();
    await captureFuturesOi();
    // Recover any OI-chart frame slots missed while we had no session/were down.
    await backfillOiFrames(optFrom);
    await backfillFutOiFrames(futFrom);
    // Baseline for the chain's "Day" column (no-op once today's is cached).
    await backfillPrevClose();
    // Persist everything the backfills reconstructed, so the next restart
    // warm-loads it instead of paying for the same Kite calls again.
    await flushRedisWrites();
  })();
}

// ---------------------------------------------------------------------------
// Intraday option-OI capture
// ---------------------------------------------------------------------------

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Epoch ms of an IST wall-clock minute-of-day on the day containing `t`. */
function istTimeOnDayMs(t: number, minutesOfDay: number): number {
  const ist = new Date(t + IST_OFFSET_MS);
  const istMidnight = Date.UTC(
    ist.getUTCFullYear(),
    ist.getUTCMonth(),
    ist.getUTCDate(),
  );
  return istMidnight + minutesOfDay * 60 * 1000 - IST_OFFSET_MS;
}

/** Epoch ms of the 09:15 IST session open on the day containing `t`. */
function sessionOpenMs(t: number): number {
  return istTimeOnDayMs(t, 9 * 60 + 15);
}

/** Epoch ms of the 15:30 IST session close on the day containing `t`. */
function sessionCloseMs(t: number): number {
  return istTimeOnDayMs(t, 15 * 60 + 30);
}

/**
 * True if a bucket ending at `bEnd` covers only pre-open time.
 *
 * We start capturing at 09:10 so a baseline is ready at the open, but Kite's
 * minute candles only begin at 09:15 — so a purely pre-open bucket could never be
 * reproduced by backfill, and the day's first bar would appear or disappear
 * depending on whether the server happened to be up before the open. Dropping
 * those buckets on BOTH paths keeps the two fills identical.
 */
function isPreOpenBucket(bEnd: number): boolean {
  return bEnd <= sessionOpenMs(bEnd);
}

/**
 * The bucket-END boundary a sample belongs to — i.e. the timestamp the frame
 * point is stamped with.
 *
 * Frames used to be stamped with the LAST SAMPLE that landed in a bucket, which
 * is why the 5m axis read 15:29 and the 15m axis 15:29/15:14: the last
 * once-a-minute capture inside 15:25–15:30 is the 15:29 one. Stamping the
 * boundary instead makes every label a real interval edge (…15:20, 15:25, 15:30)
 * and matches the "bucket end" contract the client already assumes.
 *
 * Boundaries are aligned to the IST CALENDAR, not to the epoch. For 1m/5m/15m the
 * two are identical (IST's +05:30 offset is a whole number of those intervals), but
 * for the 1h frame epoch alignment would put every boundary on the IST half-hour
 * (…10:30, 11:30) instead of the hour. A sample exactly on a boundary closes that
 * bucket rather than opening the next.
 */
function bucketEndMs(t: number, bsize: number): number {
  const close = sessionCloseMs(t);
  // We keep sampling until 15:35, after the 15:30 close. Those readings belong to
  // the closing bucket — so the day's last bar carries the true closing value
  // instead of opening a bucket that never traded.
  if (t >= close) return close;
  const aligned = Math.ceil((t + IST_OFFSET_MS) / bsize) * bsize - IST_OFFSET_MS;
  return Math.min(aligned, close);
}

/**
 * Bucket-end boundary for a Kite CANDLE, which is stamped with its START.
 *
 * The candle labelled 09:20 describes 09:20–09:21, so its closing state is 09:21
 * and it belongs to the bucket ending at 09:25 — not the one ending at 09:20.
 * Without the shift every backfilled bucket would carry data one minute later
 * than its own label and disagree with the same bucket captured live.
 */
function candleEndMs(candleStart: number, bsize: number): number {
  return bucketEndMs(candleStart + 60 * 1000, bsize);
}

/** Is it a weekday within (roughly) NSE market hours, in IST? */
function isIstMarketHours(): boolean {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const dow = ist.getUTCDay(); // 0 = Sun ... 6 = Sat
  if (dow === 0 || dow === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 + 10 && mins <= 15 * 60 + 35; // 09:10–15:35 IST
}

/** Resolve the nearest NIFTY option expiry's tokens + strike/type metadata. */
function niftyNearestExpiryOptions(all: Instrument[]): {
  expiry: string;
  spotToken: number;
  meta: Map<number, { strike: number; type: "CE" | "PE" }>;
  ids: string[];
  spotId: string;
} | null {
  const opts = all.filter(
    (i) =>
      i.exchange === "NFO" &&
      (i.instrument_type === "CE" || i.instrument_type === "PE") &&
      i.name === OPTION_OI_UNDERLYING,
  );
  if (opts.length === 0) return null;

  const today = istDayKey();
  const expiries = Array.from(
    new Set(opts.map((o) => o.expiry).filter((e) => e && e >= today)),
  ).sort();
  if (expiries.length === 0) return null;
  const expiry = expiries[0]!;

  const spotSymbol = INDEX_SPOT_MAP[OPTION_OI_UNDERLYING];
  const spotInst = spotSymbol
    ? all.find((i) => i.segment === "INDICES" && i.tradingsymbol === spotSymbol)
    : undefined;
  if (!spotInst) return null;

  const meta = new Map<number, { strike: number; type: "CE" | "PE" }>();
  const ids: string[] = [];
  for (const o of opts) {
    if (o.expiry !== expiry || !o.strike) continue;
    meta.set(o.instrument_token, {
      strike: o.strike,
      type: o.instrument_type as "CE" | "PE",
    });
    ids.push(`${o.exchange}:${o.tradingsymbol}`);
  }
  return {
    expiry,
    spotToken: spotInst.instrument_token,
    meta,
    ids,
    spotId: `${spotInst.exchange}:${spotInst.tradingsymbol}`,
  };
}

/**
 * Snapshot the nearest NIFTY expiry's option OI/LTP (+ index spot) into the
 * per-day cache. A single /quote call (chunked) covers the whole chain. Resets
 * the cache when the IST day (or the nearest expiry) changes.
 */
async function captureOptionOi(): Promise<void> {
  if (!kite.getAccessToken()) return;
  try {
    // Stamp the instant the tick fired, BEFORE any await. Everything after this
    // is latency to be excluded: the instruments cache expires hourly and that
    // refetch alone can outlast the pre-boundary capture lead, which would push
    // the sample into the next bucket and leave this one empty.
    const now = Date.now();
    const all = await getAllInstrumentsCached();
    const sel = niftyNearestExpiryOptions(all);
    if (!sel) return;

    const day = istDayKey();
    if (!optionOiDay || optionOiDay.day !== day || optionOiDay.expiry !== sel.expiry) {
      // Rolling into a NEW DAY: keep the outgoing day's final readings as today's
      // comparison baseline before the cache is discarded. An expiry change
      // within the same day must not clobber it, and the morning after an expiry
      // the outgoing day tracked contracts that no longer exist — those tokens
      // are worthless as a baseline, so leave it to the daily-candle backfill.
      if (optionOiDay && optionOiDay.day !== day && optionOiDay.expiry === sel.expiry) {
        snapshotPrevClose(optionOiDay, day);
      }
      optionOiDay = {
        day,
        expiry: sel.expiry,
        spotToken: sel.spotToken,
        meta: sel.meta,
        series: new Map(),
        spot: [],
      };
    }
    const store = optionOiDay;

    const quotes = await kite.getQuoteFull([sel.spotId, ...sel.ids]);
    const qmap = new Map(quotes.map((q) => [q.instrument_token, q]));

    // Push one aligned sample for EVERY tracked token (carry forward if a
    // particular strike is missing from this response) so all series + spot
    // stay index-aligned by capture cycle.
    //
    // `unseeded` collects the tokens where even the carry-forward had nothing to
    // fall back on — absent from this response AND with no earlier sample — so the
    // 0 written for them is an absence of data, not a reading of zero. That is the
    // case the frames have to know about: it is how the first bucket after a
    // restart, taken from a partial /quote, ends up understating the window.
    const unseeded = new Set<number>();
    for (const [token] of store.meta) {
      const q = qmap.get(token);
      const arr = store.series.get(token) ?? [];
      const prev = arr[arr.length - 1];
      if (q === undefined && prev === undefined) unseeded.add(token);
      arr.push({
        t: now,
        oi: q?.oi ?? prev?.oi ?? 0,
        ltp: q?.last_price ?? prev?.ltp ?? 0,
      });
      store.series.set(token, arr);
    }
    const sq = qmap.get(store.spotToken);
    store.spot.push({
      t: now,
      ltp: sq?.last_price ?? store.spot[store.spot.length - 1]?.ltp ?? 0,
    });

    // Feed the multi-timeframe OI chart caches with this minute's aggregate.
    const agg = currentWindowAgg(store, unseeded);
    if (agg) appendOiFrameLive(now, agg);

    // Record the per-token readings that back the chain's comparison windows.
    recordChainSnapshot(store, now);

    // Make sure the day has a "previous close" baseline even when the rollover
    // snapshot couldn't provide one (cold start, expiry roll, a process that was
    // up overnight without a session) — otherwise the chain's Day column stays
    // blank until the 30-minute gap check. Deferred to a minute tick rather than
    // fired from the rollover branch so it never overlaps the frame backfills:
    // all three pace historical calls at ~220ms and share one rate budget.
    if (
      optionPrevClose?.forDay !== day &&
      !prevCloseBackfillRunning &&
      !oiBackfillRunning &&
      !futOiBackfillRunning
    ) {
      void backfillPrevClose();
    }
  } catch (e) {
    // Non-fatal: a missed minute just leaves a small gap in the day's series.
    console.warn("[OptionOI] capture failed:", e instanceof Error ? e.message : e);
  }
}

// ---- OI-frame aggregation helpers -----------------------------------------

/** Keep the outgoing day's last reading per token as `forDay`'s close baseline. */
function snapshotPrevClose(prev: OptionOiDay, forDay: string): void {
  // The capture gate only knows about weekends, so a mid-week exchange holiday
  // still builds a full day of carried-forward quotes. Its values are last
  // session's close, but stamping it as that day's close would mislabel the
  // baseline AND (being "complete") stop the daily-candle path from correcting
  // it. A day the index never moved on wasn't a session: leave it to the
  // backfill, which reads real candle dates.
  let spotLo = Infinity;
  let spotHi = -Infinity;
  for (const s of prev.spot) {
    if (s.ltp <= 0) continue;
    spotLo = Math.min(spotLo, s.ltp);
    spotHi = Math.max(spotHi, s.ltp);
  }
  if (!(spotHi > spotLo)) {
    console.log(
      `[OptionOI] ${prev.day} had no index movement — not using it as ${forDay}'s baseline.`,
    );
    return;
  }

  const tokens: Record<number, { oi: number; ltp: number }> = {};
  for (const [token, arr] of prev.series) {
    const last = arr[arr.length - 1];
    // A zero OI means we never got a real reading for that strike.
    if (last && last.oi > 0) tokens[token] = { oi: last.oi, ltp: last.ltp };
  }
  if (Object.keys(tokens).length === 0) return;
  optionPrevClose = {
    forDay,
    closedOn: prev.day,
    expiry: prev.expiry,
    complete: true, // live capture covered every tracked strike
    tokens,
  };
  persistPrevClose();
  console.log(
    `[OptionOI] Captured ${prev.day} close for ${Object.keys(tokens).length} tokens (baseline for ${forDay}).`,
  );
}

/**
 * Mirror the previous-close baseline to Redis and flush immediately.
 *
 * Not batched with the capture flush: this is the one cache that costs ~240 Kite
 * historical calls to rebuild, so it should be durable the moment it exists rather
 * than at the next minute tick.
 */
function persistPrevClose(): void {
  if (!optionPrevClose || !isRedisEnabled()) return;
  // Two days: long enough to survive an overnight restart, short enough that a
  // stale baseline can't linger (the endpoint gates on `forDay` regardless).
  queuePlainWrite(redisKeys.prevClose, optionPrevClose, 2 * 24 * 60 * 60);
  void flushRedisWrites();
}

let prevCloseBackfillRunning = false;
// Wider than OI_BACKFILL_BAND: the chain endpoint serves ATM±40 around the LIVE
// spot, and this baseline has to still cover it after a day's worth of drift —
// 60 strikes is 1000 NIFTY points of room. Cheap to be generous, because the
// values are fixed and a retry only fetches what's missing.
const PREV_CLOSE_BAND = 60;
// A token can fail forever (delisted contract, no historical entitlement), which
// would otherwise keep `complete` false and re-scan the remainder every 30
// minutes for the rest of the session. Give up after a few passes instead.
const PREV_CLOSE_MAX_ATTEMPTS = 4;
let prevCloseAttempts = { day: "", n: 0 };

/**
 * Reconstruct the previous session's closing OI + LTP from Kite DAILY candles.
 *
 * Needed on a cold start and the morning after an expiry roll — once the process
 * survives an IST midnight on an unchanged expiry the rollover snapshot takes
 * over. One call per token in the band the chain can actually display, paced for
 * the rate limit, and skipped once today's baseline is complete for the expiry
 * being traded. Callers must not run it alongside the frame backfills: all three
 * pace historical calls at ~220ms against one shared budget.
 */
async function backfillPrevClose(): Promise<void> {
  const today = istDayKey();
  if (prevCloseBackfillRunning || !kite.getAccessToken()) return;
  prevCloseBackfillRunning = true;
  try {
    const all = await getAllInstrumentsCached();
    const sel = niftyNearestExpiryOptions(all);
    if (!sel) return;
    // Already covered: right day, right expiry, and nothing left to fill in. A
    // PARTIAL baseline is deliberately not a stop condition — a rate-limited run
    // would otherwise be locked in for the rest of the session — but the retries
    // are capped so a permanently failing token can't re-scan all session.
    const have =
      optionPrevClose && optionPrevClose.forDay === today
        ? optionPrevClose
        : null;
    if (have && have.expiry === sel.expiry && have.complete) return;
    if (prevCloseAttempts.day !== today) prevCloseAttempts = { day: today, n: 0 };
    if (prevCloseAttempts.n >= PREV_CLOSE_MAX_ATTEMPTS) return;
    prevCloseAttempts.n++;

    const to = new Date();
    // 10 days covers a long weekend plus holidays.
    const from = new Date(to.getTime() - 10 * 24 * 60 * 60 * 1000);
    const fromStr = istDateTime(from);
    const toStr = istDateTime(to);

    /** Last completed daily candle strictly before today. */
    const lastPrevSession = (
      candles: { t: string; close: number; oi: number }[],
    ): { t: string; close: number; oi: number } | null => {
      let prev: { t: string; close: number; oi: number } | null = null;
      for (const c of candles) {
        if (c.t.slice(0, 10) < today) prev = c;
      }
      return prev;
    };

    // Only the strikes the client can ask about are worth fetching. That set is
    // the chain endpoint's ATM±40 around TODAY's spot, so centre the band on
    // today's spot too — the same reference backfillOiFrames uses — not on the
    // session the values come from.
    const { strikes, ceByStrike, peByStrike } = frameLadder(sel.meta);
    if (strikes.length === 0) return;
    let ref = optionOiDay?.spot[optionOiDay.spot.length - 1]?.ltp ?? 0;
    if (!ref) {
      try {
        const q = await kite.getQuoteFull([sel.spotId]);
        ref = q[0]?.last_price ?? 0;
      } catch {
        /* fall through to the previous session's close */
      }
    }
    if (!ref) {
      try {
        const spotDaily = await kite.getHistoricalOiSeries(
          sel.spotToken,
          fromStr,
          toStr,
          "day",
        );
        ref = lastPrevSession(spotDaily)?.close ?? 0;
      } catch {
        /* no reference: bail and let the next check retry */
      }
    }
    if (!ref) {
      console.warn("[OptionOI] Previous-close backfill: no spot reference.");
      return;
    }
    let atm = 0;
    let bestD = Infinity;
    for (let k = 0; k < strikes.length; k++) {
      const d = Math.abs(strikes[k]! - ref);
      if (d < bestD) {
        bestD = d;
        atm = k;
      }
    }
    const bLo = Math.max(0, atm - PREV_CLOSE_BAND);
    const bHi = Math.min(strikes.length - 1, atm + PREV_CLOSE_BAND);
    const wanted: number[] = [];
    for (let k = bLo; k <= bHi; k++) {
      const ce = ceByStrike.get(strikes[k]!);
      const pe = peByStrike.get(strikes[k]!);
      if (ce != null) wanted.push(ce);
      if (pe != null) wanted.push(pe);
    }

    // Keep anything an earlier partial run already resolved for this same
    // day + expiry, so retries only ever add coverage.
    const tokens: Record<number, { oi: number; ltp: number }> =
      have && have.expiry === sel.expiry ? { ...have.tokens } : {};
    // Which session the values came from — by majority, so one newly listed
    // strike with a shorter history can't mislabel the whole baseline.
    const dayVotes = new Map<string, number>();
    let failed = 0;
    for (const token of wanted) {
      // A previous close never changes, so a retry only fetches what's missing.
      if (tokens[token]) continue;
      try {
        const candles = await kite.getHistoricalOiSeries(token, fromStr, toStr, "day");
        const prev = lastPrevSession(candles);
        if (prev && prev.oi > 0) {
          tokens[token] = { oi: prev.oi, ltp: prev.close };
          const d = prev.t.slice(0, 10);
          dayVotes.set(d, (dayVotes.get(d) ?? 0) + 1);
        }
        // No candle is a legitimate answer for a strike that never traded, so it
        // doesn't count against completeness.
      } catch {
        // A real failure (rate limit, expired session): the run is incomplete and
        // must stay retryable, but the rest of the band still gets a baseline.
        failed++;
      }
      await delay(220); // stay within Kite historical rate limits
    }

    if (Object.keys(tokens).length === 0) {
      console.warn(
        `[OptionOI] Previous-close backfill found no data ` +
          `(attempt ${prevCloseAttempts.n}/${PREV_CLOSE_MAX_ATTEMPTS}).`,
      );
      return;
    }
    let closedOn = have?.closedOn ?? "";
    let topVotes = 0;
    for (const [d, n] of dayVotes) {
      if (n > topVotes) {
        topVotes = n;
        closedOn = d;
      }
    }
    optionPrevClose = {
      forDay: today,
      closedOn: closedOn || "unknown",
      expiry: sel.expiry,
      complete: failed === 0,
      tokens,
    };
    persistPrevClose();
    console.log(
      `[OptionOI] Backfilled ${closedOn} close for ${Object.keys(tokens).length}/${wanted.length} band tokens ` +
        `(baseline for ${today}${failed ? `, ${failed} failed — will retry` : ""}).`,
    );
  } catch (e) {
    console.warn(
      "[OptionOI] previous-close backfill failed:",
      e instanceof Error ? e.message : e,
    );
  } finally {
    prevCloseBackfillRunning = false;
  }
}

/** Sorted strike ladder + strike→token maps for a captured day. */
function frameLadder(meta: OptionOiDay["meta"]): {
  strikes: number[];
  ceByStrike: Map<number, number>;
  peByStrike: Map<number, number>;
} {
  const ceByStrike = new Map<number, number>();
  const peByStrike = new Map<number, number>();
  for (const [tok, m] of meta) {
    (m.type === "CE" ? ceByStrike : peByStrike).set(m.strike, tok);
  }
  const strikes = Array.from(
    new Set(Array.from(meta.values()).map((m) => m.strike)),
  ).sort((a, b) => a - b);
  return { strikes, ceByStrike, peByStrike };
}

/**
 * Total CE/PE OI over the 26-below / ATM / 24-above window at the LATEST snapshot.
 *
 * `unseeded` lists tokens this cycle has no reading for AT ALL (see captureOptionOi).
 * They contribute 0 to the totals, so if any of them falls inside the window the
 * result understates it and the point is flagged `partial`. Note this is
 * deliberately NOT "oi === 0": a deep-OTM strike legitimately carries no open
 * interest, and treating that as suspect would flag almost every bucket and send
 * the backfill re-fetching the session all day.
 */
function currentWindowAgg(
  store: OptionOiDay,
  unseeded?: ReadonlySet<number>,
): OiAggPoint | null {
  if (store.spot.length === 0) return null;
  const spot = store.spot[store.spot.length - 1]!.ltp;
  if (!(spot > 0)) return null;
  const { strikes, ceByStrike, peByStrike } = frameLadder(store.meta);
  if (strikes.length === 0) return null;

  let atmIdx = 0;
  let bestD = Infinity;
  for (let k = 0; k < strikes.length; k++) {
    const d = Math.abs(strikes[k]! - spot);
    if (d < bestD) {
      bestD = d;
      atmIdx = k;
    }
  }
  const lo = Math.max(0, atmIdx - 26);
  const hi = Math.min(strikes.length - 1, atmIdx + 24);
  let totalCe = 0;
  let totalPe = 0;
  const lastOf = (tok: number | undefined): { oi: number; ltp: number } => {
    if (tok == null) return { oi: 0, ltp: 0 };
    const arr = store.series.get(tok);
    const s = arr && arr.length ? arr[arr.length - 1]! : null;
    return { oi: s?.oi ?? 0, ltp: s?.ltp ?? 0 };
  };
  let missing = 0;
  for (let k = lo; k <= hi; k++) {
    const ce = ceByStrike.get(strikes[k]!);
    const pe = peByStrike.get(strikes[k]!);
    totalCe += lastOf(ce).oi;
    totalPe += lastOf(pe).oi;
    if (unseeded && ((ce != null && unseeded.has(ce)) || (pe != null && unseeded.has(pe)))) {
      missing++;
    }
  }
  // Auto-ATM straddle: ATM Call LTP + ATM Put LTP (0 if either leg missing).
  const ceAtm = lastOf(ceByStrike.get(strikes[atmIdx]!)).ltp;
  const peAtm = lastOf(peByStrike.get(strikes[atmIdx]!)).ltp;
  const straddle = ceAtm > 0 && peAtm > 0 ? ceAtm + peAtm : 0;
  const point: OiAggPoint = { t: Date.now(), totalCe, totalPe, straddle, spot };
  if (missing > 0) point.partial = 1;
  return point;
}

/**
 * Append/refresh one live aggregate into all three frames.
 *
 * Points are keyed AND stamped by their bucket-end boundary, so a bucket keeps
 * the newest reading inside it while still being labelled with a real interval
 * edge.
 */
function appendOiFrameLive(t: number, agg: OiAggPoint): void {
  for (const key of OI_FRAME_KEYS) {
    const cfg = OI_FRAMES[key];
    const store = oiFrameStores[key];
    const bsize = cfg.intervalMin * 60 * 1000;
    const bEnd = bucketEndMs(t, bsize);
    // The per-day baseline cache still records the sample; only the frames skip it.
    if (isPreOpenBucket(bEnd)) continue;
    const last = store.points[store.points.length - 1];
    if (last && last.t === bEnd) {
      // Same bucket → keep the latest value for it.
      last.totalCe = agg.totalCe;
      last.totalPe = agg.totalPe;
      last.straddle = agg.straddle;
      last.spot = agg.spot;
      // The flag tracks the value, both ways: a later complete reading clears an
      // earlier bucket's caveat, and it must not be left stale on the way in.
      if (agg.partial) last.partial = 1;
      else delete last.partial;
    } else {
      const point: OiAggPoint = {
        t: bEnd,
        totalCe: agg.totalCe,
        totalPe: agg.totalPe,
        straddle: agg.straddle,
        spot: agg.spot,
      };
      if (agg.partial) point.partial = 1;
      store.points.push(point);
    }
    const cutoff = t - cfg.retentionMs;
    const dropped: number[] = [];
    while (store.points.length && store.points[0]!.t < cutoff) {
      dropped.push(store.points.shift()!.t);
    }
    // Mirror CLOSED buckets (and the pruning) into Redis — never the forming one.
    // A forming bucket holds only the part of its interval that has elapsed, yet
    // nothing in the stored shape distinguishes it from a finished one: `partial`
    // marks a bucket whose STRIKE COVERAGE was incomplete, not its time span. So a
    // persisted forming bucket would warm-load looking authoritative and win over
    // the backfill's correct version (up to 59 minutes of it on the 1h frame).
    // Leaving it out costs nothing — the backfill reconstructs it properly.
    // Only the tail can have newly closed, so this stays O(1) per capture.
    const ttl = frameTtlSec(cfg);
    const rk = redisKeys.oiFrame(key);
    for (const p of store.points.slice(-2)) {
      if (p.t <= t) queueHashField(rk, p.t, p, ttl);
    }
    queueHashDrop(rk, dropped, ttl);
  }
}

/**
 * Collapse per-minute CANDLE points to one-per-bucket (last wins), re-stamped
 * with the bucket-end boundary.
 *
 * Kite stamps a minute candle with its START, so the candle labelled 09:20 is
 * really the state at 09:21 — see candleEndMs.
 */
function downsampleAgg(points: OiAggPoint[], intervalMin: number): OiAggPoint[] {
  const bsize = intervalMin * 60 * 1000;
  const byBucket = new Map<number, OiAggPoint>();
  for (const p of points) {
    const bEnd = candleEndMs(p.t, bsize);
    if (isPreOpenBucket(bEnd)) continue;
    byBucket.set(bEnd, { ...p, t: bEnd });
  }
  return Array.from(byBucket.values()).sort((a, b) => a.t - b.t);
}

/**
 * Merge backfilled points into a frame without overwriting buckets we already
 * trust — but DO replace ones flagged `partial`.
 *
 * A bucket that exists still wins by default: it was measured live, at the tick,
 * from /quote, which is a better reading than one inferred from candles. The
 * exception matters because of Redis. While the frames were memory-only, a wrong
 * bucket lasted until the next restart and was then rebuilt correctly from Kite;
 * now that boot warm-loads, "never overwrite" would freeze that bucket for the
 * frame's whole retention (7 days on 15m) with nothing able to repair it. So a
 * reading that admitted it was incomplete yields to one that is complete.
 */
function mergeOiFrame(key: OiFrameKey, backfilled: OiAggPoint[]): void {
  const cfg = OI_FRAMES[key];
  const store = oiFrameStores[key];
  // Both sides are already bucket-end stamped, so the stamp IS the bucket key.
  const byBucket = new Map<number, OiAggPoint>();
  for (const p of store.points) byBucket.set(p.t, p);
  for (const p of downsampleAgg(backfilled, cfg.intervalMin)) {
    const cur = byBucket.get(p.t);
    if (!cur || (cur.partial && !p.partial)) byBucket.set(p.t, p);
  }
  const cutoff = Date.now() - cfg.retentionMs;
  const before = new Set(store.points.map((p) => p.t));
  store.points = Array.from(byBucket.values())
    .filter((p) => p.t >= cutoff)
    .sort((a, b) => a.t - b.t);
  // Persist the whole merged frame: a backfill both ADDS buckets and prunes past
  // the retention edge, so field-by-field tracking would miss one or the other.
  const ttl = frameTtlSec(cfg);
  const rk = redisKeys.oiFrame(key);
  const kept = new Set<number>();
  for (const p of store.points) {
    kept.add(p.t);
    queueHashField(rk, p.t, p, ttl);
  }
  queueHashDrop(
    rk,
    Array.from(before).filter((t) => !kept.has(t)),
    ttl,
  );
}

/**
 * The earliest timestamp we still NEED for any frame. The overall backfill `from`
 * is the min across frames, so a warm cache only fetches the gap.
 *
 * Two kinds of gap matter:
 *  - the TAIL: everything after the newest point we hold.
 *  - the HEAD of the newest session we hold. A process that first captured at,
 *    say, 12:22 has a newest point at ~now, so tail-only detection reports "fully
 *    covered" and 09:15–12:22 is never fetched — which is exactly how a chart ends
 *    up permanently starting mid-session. If the oldest point we hold begins after
 *    its own session's open, that session's head is missing and we ask for it.
 */
function oiBackfillFromMs(now: number): number {
  let from = now; // if everything is fully covered, this stays ~now (no work)
  for (const key of OI_FRAME_KEYS) {
    const cfg = OI_FRAMES[key];
    const retentionStart = now - cfg.retentionMs;
    const pts = oiFrameStores[key].points;
    if (pts.length === 0) {
      from = Math.min(from, retentionStart);
      continue;
    }
    // Need data from where this frame's coverage ends (but no earlier than its
    // retention window).
    let need = Math.max(retentionStart, pts[pts.length - 1]!.t);
    const headNeed = missingHeadMs("opt", pts[0]!.t, cfg, retentionStart);
    if (headNeed !== null) need = Math.min(need, headNeed);
    const partialNeed = partialRepairFromMs(pts, cfg, retentionStart);
    if (partialNeed !== null) need = Math.min(need, partialNeed);
    from = Math.min(from, need);
  }
  return from;
}

/**
 * `from` needed to rebuild the oldest bucket still flagged `partial`, or null when
 * there is none.
 *
 * Without this the flag would be decoration. The tail detector only looks at the
 * NEWEST point, so an understated bucket sitting inside an otherwise-covered
 * session reads as "nothing to do" and is never asked for again — which is the
 * same blind spot that left the head of a session missing all afternoon.
 *
 * Rate-limited like the head repair, and for the same reason: when a strike is
 * genuinely unavailable from Kite, the bucket cannot be completed, and retrying it
 * every 30 minutes would re-fetch the session all day to reach the same answer.
 */
const PARTIAL_REPAIR_MAX_ATTEMPTS = 3;
const partialRepairs = new Map<string, { n: number; at: number }>();
function partialRepairFromMs(
  pts: OiAggPoint[],
  cfg: OiFrameCfg,
  retentionStart: number,
): number | null {
  const oldest = pts.find((p) => p.partial); // points are ascending
  if (!oldest) return null;
  // Points are stamped with their bucket END, so reach back one interval to be
  // sure the candles that make up the bucket are inside the window.
  const from = Math.max(retentionStart, oldest.t - cfg.intervalMin * 60 * 1000);
  const key = `${cfg.intervalMin}:${istDayKey(oldest.t)}`;
  const seen = partialRepairs.get(key);
  const now = Date.now();
  if (seen) {
    if (seen.n >= PARTIAL_REPAIR_MAX_ATTEMPTS) return null;
    // Same cycle (or 25-minute window): reuse without spending an attempt, since
    // several callers recompute this window per cycle.
    if (now - seen.at < HEAD_REPAIR_MIN_GAP_MS) return from;
    partialRepairs.set(key, { n: seen.n + 1, at: now });
  } else {
    partialRepairs.set(key, { n: 1, at: now });
    console.log(
      `[OptionOI] ${cfg.intervalMin}m frame has an incomplete bucket at ` +
        `${new Date(oldest.t).toISOString()} — reconstructing it again from Kite.`,
    );
  }
  return from;
}

/**
 * `from` needed to repair a missing session head, or null when there is none.
 *
 * Rate-limited per (family, frame, session): when the head genuinely cannot be
 * reconstructed — the strikes we track now weren't listed then, or Kite has no
 * candles that far back — an unbounded check would re-fetch hundreds of candles
 * every 30 minutes for the rest of the day and never succeed. The counter is
 * time-based as well as capped because the window is recomputed by several callers
 * per cycle, and a plain per-call counter would be spent before a backfill ever
 * ran with it.
 */
const HEAD_REPAIR_MAX_ATTEMPTS = 4;
const HEAD_REPAIR_MIN_GAP_MS = 25 * 60 * 1000;
const headRepairs = new Map<string, { n: number; at: number }>();
function missingHeadMs(
  family: "opt" | "fut",
  oldest: number,
  cfg: OiFrameCfg,
  retentionStart: number,
): number | null {
  const open = sessionOpenMs(oldest);
  // One bucket of slack: a frame legitimately has no point before its first
  // boundary after the open.
  if (oldest <= open + cfg.intervalMin * 60 * 1000) return null;
  if (open < retentionStart) return null; // outside what we'd keep anyway
  const key = `${family}:${cfg.intervalMin}:${istDayKey(open)}`;
  const seen = headRepairs.get(key);
  const now = Date.now();
  if (seen) {
    if (seen.n >= HEAD_REPAIR_MAX_ATTEMPTS) return null;
    // Same cycle (or the same 25-minute window): reuse without spending a try.
    if (now - seen.at < HEAD_REPAIR_MIN_GAP_MS) return open;
    headRepairs.set(key, { n: seen.n + 1, at: now });
  } else {
    headRepairs.set(key, { n: 1, at: now });
    console.log(
      `[OptionOI] ${family} ${cfg.intervalMin}m frame is missing the head of ` +
        `${istDayKey(open)} (oldest point ${new Date(oldest).toISOString()}) — ` +
        `backfilling from the open.`,
    );
  }
  return open;
}

let oiBackfillRunning = false;

/**
 * Reconstruct the Call/Put total-OI frames from Kite historical to recover any
 * slots missed while the server was down (and to populate the caches on a cold
 * start). Gap-aware: only fetches from the earliest still-missing slot. Uses the
 * CURRENT nearest expiry's strikes, so periods before those contracts were
 * listed (e.g. an already-expired earlier weekly) cannot be reconstructed.
 */
async function backfillOiFrames(fromMsOverride?: number): Promise<void> {
  if (oiBackfillRunning || !kite.getAccessToken()) return;
  oiBackfillRunning = true;
  try {
    const now = Date.now();
    // See backfillFutOiFrames: callers that capture first must snapshot the
    // window beforehand, because a live point sets `newest` to `now`.
    const fromMs = fromMsOverride ?? oiBackfillFromMs(now);
    // A minute of slack; if we're essentially current, skip the historical hit.
    if (now - fromMs < 90 * 1000) return;

    const all = await getAllInstrumentsCached();
    const sel = niftyNearestExpiryOptions(all);
    if (!sel) return;
    const { strikes, ceByStrike, peByStrike } = frameLadder(sel.meta);
    if (strikes.length === 0) return;

    const fromStr = istDateTime(new Date(fromMs));
    const toStr = istDateTime(new Date(now));

    // 1) Spot minute candles → close per minute (drives ATM per timestamp).
    const spotCandles = await kite.getHistorical(
      sel.spotToken,
      fromStr,
      toStr,
      "minute",
    );
    if (spotCandles.length === 0) return;
    const minuteKey = (t: string) => t.slice(0, 16); // "YYYY-MM-DDTHH:MM"
    const spotByMin = new Map<string, number>();
    // Keep the ORIGINAL candle timestamp (which carries the +0530 offset) per
    // minute so we compute a correct epoch, aligned with live Date.now() points.
    const tsByMin = new Map<string, string>();
    for (const c of spotCandles) {
      const k = minuteKey(c.t);
      spotByMin.set(k, c.close);
      tsByMin.set(k, c.t);
    }

    // Band of strikes around the current ATM to fetch OI candles for.
    const lastSpot = spotCandles[spotCandles.length - 1]!.close;
    let atmNow = 0;
    let bestD = Infinity;
    for (let k = 0; k < strikes.length; k++) {
      const d = Math.abs(strikes[k]! - lastSpot);
      if (d < bestD) {
        bestD = d;
        atmNow = k;
      }
    }
    const bLo = Math.max(0, atmNow - OI_BACKFILL_BAND);
    const bHi = Math.min(strikes.length - 1, atmNow + OI_BACKFILL_BAND);

    // 2) OI + close minute candles per band token → per-token minute maps.
    const oiByToken = new Map<number, Map<string, number>>();
    const closeByToken = new Map<number, Map<string, number>>();
    /**
     * Tokens whose history we could NOT get. They still count as 0 in the window
     * sum — there is nothing else to put there — but every bucket that includes one
     * is flagged `partial` so it can be reconstructed again later.
     *
     * This used to be silent: one `catch` treated a rate-limited strike exactly
     * like a strike with no candles, so a 429 blip during a cold start wrote an
     * understated total for every reconstructed minute and, once Redis made that
     * survive a restart, nothing could ever correct it. (backfillFutOiFrames faces
     * the same problem with 3 contracts and answers it by aborting the run; with
     * ~180 option tokens, abandoning everything because one strike failed would
     * mean a flaky afternoon produced no chart at all.)
     */
    const unfetched = new Set<number>();
    const fetchTok = async (tok: number | undefined) => {
      if (tok == null || oiByToken.has(tok)) return;
      let candles: { t: string; close: number; oi: number }[] = [];
      try {
        candles = await kite.getHistoricalOiSeries(tok, fromStr, toStr, "minute");
      } catch {
        // A rate-limit blip is the likely cause and one absent strike skews every
        // minute of the window, so pay for a single retry before giving up on it.
        await delay(1200);
        try {
          candles = await kite.getHistoricalOiSeries(tok, fromStr, toStr, "minute");
        } catch (e) {
          unfetched.add(tok);
          console.warn(
            `[OptionOI] backfill: no history for token ${tok} ` +
              `(${e instanceof Error ? e.message : e}) — affected buckets stay partial.`,
          );
        }
      }
      const mOi = new Map<string, number>();
      const mClose = new Map<string, number>();
      for (const c of candles) {
        const k = minuteKey(c.t);
        mOi.set(k, c.oi);
        mClose.set(k, c.close);
      }
      oiByToken.set(tok, mOi);
      closeByToken.set(tok, mClose);
      await delay(220); // stay within Kite historical rate limits
    };
    for (let k = bLo; k <= bHi; k++) {
      await fetchTok(ceByStrike.get(strikes[k]!));
      await fetchTok(peByStrike.get(strikes[k]!));
    }

    // 3) Walk minutes in order; carry forward last-known OI per token; compute
    //    the moving 26↓/ATM/24↑ window aggregate per minute.
    const sortedMins = Array.from(spotByMin.keys()).sort();
    const lastOi = new Map<number, number>();
    const lastClose = new Map<number, number>();
    const perMinute: OiAggPoint[] = [];
    for (const mk of sortedMins) {
      const spot = spotByMin.get(mk)!;
      if (!(spot > 0)) continue;
      let atmIdx = 0;
      let bd = Infinity;
      for (let k = 0; k < strikes.length; k++) {
        const d = Math.abs(strikes[k]! - spot);
        if (d < bd) {
          bd = d;
          atmIdx = k;
        }
      }
      const lo = Math.max(0, atmIdx - 26);
      const hi = Math.min(strikes.length - 1, atmIdx + 24);
      let totalCe = 0;
      let totalPe = 0;
      // Carry-forward OI for the window sum.
      const sumOi = (tok: number | undefined): number => {
        if (tok == null) return 0;
        const v = oiByToken.get(tok)?.get(mk);
        if (v !== undefined) lastOi.set(tok, v);
        return lastOi.get(tok) ?? 0;
      };
      // Carry-forward close (LTP proxy) for the ATM straddle.
      const closeOf = (tok: number | undefined): number => {
        if (tok == null) return 0;
        const v = closeByToken.get(tok)?.get(mk);
        if (v !== undefined) lastClose.set(tok, v);
        return lastClose.get(tok) ?? 0;
      };
      // A window token we have no series for at all: either its fetch failed, or
      // the ATM drifted out of the band we fetched (the band is centred on the LAST
      // spot in the range, so on a multi-day catch-up the early days can reach past
      // it). Either way this minute's total is short and must say so.
      const unknownTok = (tok: number | undefined): boolean =>
        tok != null && (!oiByToken.has(tok) || unfetched.has(tok));
      let missing = 0;
      for (let k = lo; k <= hi; k++) {
        const ce = ceByStrike.get(strikes[k]!);
        const pe = peByStrike.get(strikes[k]!);
        totalCe += sumOi(ce);
        totalPe += sumOi(pe);
        if (unknownTok(ce) || unknownTok(pe)) missing++;
      }
      const ceAtm = closeOf(ceByStrike.get(strikes[atmIdx]!));
      const peAtm = closeOf(peByStrike.get(strikes[atmIdx]!));
      const straddle = ceAtm > 0 && peAtm > 0 ? ceAtm + peAtm : 0;
      const t = new Date(tsByMin.get(mk) ?? `${mk}:00`).getTime();
      if (Number.isFinite(t)) {
        const point: OiAggPoint = { t, totalCe, totalPe, straddle, spot };
        if (missing > 0) point.partial = 1;
        perMinute.push(point);
      }
    }

    for (const key of OI_FRAME_KEYS) {
      mergeOiFrame(key, perMinute);
    }
    const partialMins = perMinute.reduce((n, p) => n + (p.partial ? 1 : 0), 0);
    console.log(
      `[OptionOI] Backfilled frames from ${fromStr} (${perMinute.length} minutes reconstructed` +
        (partialMins
          ? `, ${partialMins} partial — ${unfetched.size} token(s) unavailable, will retry`
          : "") +
        `).`,
    );
  } catch (e) {
    console.warn("[OptionOI] frame backfill failed:", e instanceof Error ? e.message : e);
  } finally {
    oiBackfillRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Intraday NIFTY futures-OI capture (current / next / far month)
// ---------------------------------------------------------------------------

/**
 * Resolve the 3 nearest NIFTY monthly futures contracts (nearest first). Only
 * contracts expiring today or later are considered, and duplicate expiries are
 * collapsed, so a rollover day still yields distinct current/next/far months.
 */
function niftyMonthlyFutures(
  all: Instrument[],
): { contracts: FutContract[]; ids: string[] } | null {
  const today = istDayKey();
  const futs = all
    .filter(
      (i) =>
        i.exchange === "NFO" &&
        i.instrument_type === "FUT" &&
        i.name === FUT_OI_UNDERLYING &&
        i.expiry &&
        i.expiry >= today,
    )
    .sort((a, b) => a.expiry.localeCompare(b.expiry)); // ISO dates sort chronologically
  if (futs.length === 0) return null;

  const contracts: FutContract[] = [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const f of futs) {
    if (seen.has(f.expiry)) continue;
    seen.add(f.expiry);
    contracts.push({
      token: f.instrument_token,
      tradingsymbol: f.tradingsymbol,
      expiry: f.expiry,
      lot_size: f.lot_size,
    });
    ids.push(`${f.exchange}:${f.tradingsymbol}`);
    if (contracts.length === 3) break;
  }
  rememberFutContracts(contracts);
  return { contracts, ids };
}

/**
 * Track the contracts we've seen and mirror them, so a retained series keeps its
 * label after a rollover even on the first request following a restart.
 */
function rememberFutContracts(contracts: FutContract[]): void {
  let changed = false;
  for (const c of contracts) {
    const known = futOiKnownContracts.get(c.expiry);
    if (!known || known.token !== c.token) {
      futOiKnownContracts.set(c.expiry, c);
      changed = true;
    }
  }
  if (!changed || !isRedisEnabled()) return;
  queuePlainWrite(
    redisKeys.futContracts,
    Array.from(futOiKnownContracts.values()),
    Math.floor((OI_FRAMES["15m"].retentionMs + REDIS_TTL_SLACK_MS) / 1000),
  );
}

/** Deep-copy a futures point so each frame owns its own mutable objects. */
function cloneFutOiPoint(p: FutOiPoint): FutOiPoint {
  return { t: p.t, legs: p.legs.map((l) => ({ ...l })) };
}

/**
 * Append/refresh one live futures-OI point into all three frames, keyed and
 * stamped by the bucket-end boundary (see bucketEndMs).
 */
function appendFutOiFrameLive(t: number, point: FutOiPoint): void {
  for (const key of OI_FRAME_KEYS) {
    const cfg = OI_FRAMES[key];
    const store = futOiFrameStores[key];
    const bsize = cfg.intervalMin * 60 * 1000;
    const bEnd = bucketEndMs(t, bsize);
    if (isPreOpenBucket(bEnd)) continue;
    const last = store.points[store.points.length - 1];
    // Each frame gets its OWN copy: the same-bucket branch below mutates the
    // stored point in place, and a shared object would corrupt other frames
    // (notably the last backfilled minute, which every frame holds).
    if (last && last.t === bEnd) {
      // Same bucket → keep the latest value for it.
      last.legs = point.legs.map((l) => ({ ...l }));
    } else {
      store.points.push(cloneFutOiPoint({ t: bEnd, legs: point.legs }));
    }
    const cutoff = t - cfg.retentionMs;
    const dropped: number[] = [];
    while (store.points.length && store.points[0]!.t < cutoff) {
      dropped.push(store.points.shift()!.t);
    }
    // Closed buckets only — see appendOiFrameLive for why the forming one is
    // deliberately not persisted.
    const ttl = frameTtlSec(cfg);
    const rk = redisKeys.futFrame(key);
    for (const p of store.points.slice(-2)) {
      if (p.t <= t) queueHashField(rk, p.t, p, ttl);
    }
    queueHashDrop(rk, dropped, ttl);
  }
}

/** Merge backfilled futures points into a frame WITHOUT overwriting live buckets. */
function mergeFutOiFrame(key: OiFrameKey, backfilled: FutOiPoint[]): void {
  const cfg = OI_FRAMES[key];
  const store = futOiFrameStores[key];
  const bsize = cfg.intervalMin * 60 * 1000;
  // Both sides are bucket-end stamped, so the stamp IS the bucket key.
  const byBucket = new Map<number, FutOiPoint>();
  for (const p of store.points) byBucket.set(p.t, p);
  // Collapse per-minute points to one-per-bucket (last wins), then fill gaps.
  const collapsed = new Map<number, FutOiPoint>();
  for (const p of backfilled) {
    // Candle-derived, so shift by the candle length — see candleEndMs.
    const bEnd = candleEndMs(p.t, bsize);
    if (isPreOpenBucket(bEnd)) continue;
    collapsed.set(bEnd, { ...p, t: bEnd });
  }
  for (const [bEnd, p] of collapsed) {
    // Clone: the caller shares `backfilled` across all three frames, and the
    // live append path mutates stored points in place.
    if (!byBucket.has(bEnd)) byBucket.set(bEnd, cloneFutOiPoint(p));
  }
  const cutoff = Date.now() - cfg.retentionMs;
  const before = new Set(store.points.map((p) => p.t));
  store.points = Array.from(byBucket.values())
    .filter((p) => p.t >= cutoff)
    .sort((a, b) => a.t - b.t);
  const ttl = frameTtlSec(cfg);
  const rk = redisKeys.futFrame(key);
  const kept = new Set<number>();
  for (const p of store.points) {
    kept.add(p.t);
    queueHashField(rk, p.t, p, ttl);
  }
  queueHashDrop(
    rk,
    Array.from(before).filter((t) => !kept.has(t)),
    ttl,
  );
}

/** Earliest timestamp still needed across the futures frames (tail + head gaps). */
function futOiBackfillFromMs(now: number): number {
  let from = now;
  for (const key of OI_FRAME_KEYS) {
    const cfg = OI_FRAMES[key];
    const retentionStart = now - cfg.retentionMs;
    const pts = futOiFrameStores[key].points;
    if (pts.length === 0) {
      from = Math.min(from, retentionStart);
      continue;
    }
    let need = Math.max(retentionStart, pts[pts.length - 1]!.t);
    const headNeed = missingHeadMs("fut", pts[0]!.t, cfg, retentionStart);
    if (headNeed !== null) need = Math.min(need, headNeed);
    from = Math.min(from, need);
  }
  return from;
}

/**
 * Snapshot the 3 nearest NIFTY futures' OI + LTP into every frame. One /quote
 * call covers all three contracts; a leg with no usable value carries forward
 * its last known one so a whole contract's series never gains a hole.
 */
async function captureFuturesOi(): Promise<void> {
  if (!kite.getAccessToken()) return;
  try {
    // Stamped before any await — see captureOptionOi. This capture is awaited
    // after the option one, so it has even less of the lead left.
    const now = Date.now();
    const all = await getAllInstrumentsCached();
    const sel = niftyMonthlyFutures(all);
    if (!sel) return;
    futOiContracts = sel.contracts;

    const quotes = await kite.getQuoteFull(sel.ids);
    const qmap = new Map(quotes.map((q) => [q.instrument_token, q]));

    // Carry-forward source: the newest 1m point (finest cadence we keep).
    const finest = futOiFrameStores["1m"].points;
    const prev = finest[finest.length - 1];
    const prevByExpiry = new Map((prev?.legs ?? []).map((l) => [l.expiry, l]));

    // NOTE: getQuoteFull already coalesces a missing oi/last_price to 0, so we
    // must test for a POSITIVE value rather than null-ish — otherwise a
    // present-but-empty quote (pre-open, or an untraded far month) would write a
    // hard 0 and the client would drop that contract's point entirely.
    const legs: FutOiLeg[] = sel.contracts.map((c) => {
      const q = qmap.get(c.token);
      const p = prevByExpiry.get(c.expiry);
      return {
        expiry: c.expiry,
        oi: q && q.oi > 0 ? q.oi : p?.oi ?? 0,
        ltp: q && q.last_price > 0 ? q.last_price : p?.ltp ?? 0,
      };
    });
    appendFutOiFrameLive(now, { t: now, legs });
  } catch (e) {
    // Non-fatal: a missed minute just leaves a small gap in the series.
    console.warn("[FuturesOI] capture failed:", e instanceof Error ? e.message : e);
  }
}

let futOiBackfillRunning = false;

/**
 * Reconstruct the futures-OI frames from Kite historical to recover slots missed
 * while the server was down (and to populate the caches on a cold start).
 * Gap-aware: only fetches from the earliest still-missing slot.
 */
async function backfillFutOiFrames(fromMsOverride?: number): Promise<void> {
  if (futOiBackfillRunning || !kite.getAccessToken()) return;
  futOiBackfillRunning = true;
  try {
    const now = Date.now();
    // The gap detector reads the newest stored point, and a single live capture
    // stamps every frame at `now` — so callers that capture first MUST pass a
    // window snapshotted before that capture, or nothing would ever be
    // recovered.
    const fromMs = fromMsOverride ?? futOiBackfillFromMs(now);
    // A minute of slack; if we're essentially current, skip the historical hit.
    if (now - fromMs < 90 * 1000) return;

    const all = await getAllInstrumentsCached();
    const sel = niftyMonthlyFutures(all);
    if (!sel) return;
    futOiContracts = sel.contracts;

    const fromStr = istDateTime(new Date(fromMs));
    const toStr = istDateTime(new Date(now));
    const minuteKey = (t: string) => t.slice(0, 16); // "YYYY-MM-DDTHH:MM"

    // Per-expiry minute maps of OI + close, plus the union of minutes seen.
    const byExpiry = new Map<string, Map<string, { oi: number; close: number }>>();
    const tsByMin = new Map<string, string>();
    for (const c of sel.contracts) {
      const candles = await kite.getHistoricalOiSeries(
        c.token,
        fromStr,
        toStr,
        "minute",
      );
      // Deliberately NOT caught per contract: merged buckets are never revisited,
      // so writing a zeroed leg here would hide that contract for the whole
      // retention window. Let the error abort this run and retry on the next
      // gap-check instead.
      const m = new Map<string, { oi: number; close: number }>();
      for (const cd of candles) {
        const k = minuteKey(cd.t);
        m.set(k, { oi: cd.oi, close: cd.close });
        // Keep the ORIGINAL candle timestamp (carries the +0530 offset) so the
        // epoch matches live Date.now() points.
        tsByMin.set(k, cd.t);
      }
      byExpiry.set(c.expiry, m);
      await delay(220); // stay within Kite historical rate limits
    }

    // Walk minutes in order, carrying forward each leg's last known values.
    const lastOi = new Map<string, number>();
    const lastLtp = new Map<string, number>();
    const perMinute: FutOiPoint[] = [];
    for (const mk of Array.from(tsByMin.keys()).sort()) {
      const legs: FutOiLeg[] = sel.contracts.map((c) => {
        const v = byExpiry.get(c.expiry)?.get(mk);
        if (v) {
          lastOi.set(c.expiry, v.oi);
          lastLtp.set(c.expiry, v.close);
        }
        return {
          expiry: c.expiry,
          oi: lastOi.get(c.expiry) ?? 0,
          ltp: lastLtp.get(c.expiry) ?? 0,
        };
      });
      const t = new Date(tsByMin.get(mk) ?? `${mk}:00`).getTime();
      if (Number.isFinite(t)) perMinute.push({ t, legs });
    }

    for (const key of OI_FRAME_KEYS) {
      mergeFutOiFrame(key, perMinute);
    }
    console.log(
      `[FuturesOI] Backfilled frames from ${fromStr} (${perMinute.length} minutes reconstructed).`,
    );
  } catch (e) {
    console.warn(
      "[FuturesOI] frame backfill failed:",
      e instanceof Error ? e.message : e,
    );
  } finally {
    futOiBackfillRunning = false;
  }
}

/**
 * Start the once-a-minute intraday option + futures OI capture (market hours
 * only). The two pipelines are awaited in sequence rather than fired in
 * parallel: Kite allows ~1 quote/s and ~3 historical/s, and the option backfill
 * already paces itself to the edge of that budget.
 */
function startOptionOiCapture(): void {
  // Cold-start windows, snapshotted before the first tick writes a live point
  // (which would collapse the detected gap to zero).
  const coldOptFrom = oiBackfillFromMs(Date.now());
  const coldFutFrom = futOiBackfillFromMs(Date.now());

  const tick = () => {
    if (isIstMarketHours()) {
      void (async () => {
        await captureOptionOi();
        await captureFuturesOi();
        // One pipeline for everything both captures touched. Flushing here rather
        // than inside each store keeps Redis to a single request per minute.
        await flushRedisWrites();
      })();
    }
    scheduleNextTick();
  };
  /**
   * Re-arm shortly BEFORE the next minute boundary rather than on a fixed 60s
   * interval.
   *
   * Two reasons. A plain interval drifts by the Kite round-trip each cycle, and
   * once the phase crosses a minute boundary a 1m bucket gets no sample at all —
   * which the client's change histograms then have to drop. And because buckets
   * are stamped with their END, the reading that represents a bucket should be
   * taken near that end: sampling at 10:00:57 gives the 10:01 bucket its closing
   * state, where sampling at 10:00:00 would give it the opening one.
   */
  const scheduleNextTick = () => {
    const now = Date.now();
    const step = OPTION_OI_INTERVAL_MS;
    let target = Math.ceil((now + CAPTURE_LEAD_MS) / step) * step - CAPTURE_LEAD_MS;
    // Never re-arm immediately (which would happen when we just fired).
    if (target - now < 1000) target += step;
    setTimeout(tick, target - now);
  };
  tick();

  // Cold-start backfill of the OI-chart frames, then a periodic gap-check that
  // only hits Kite when there is an actual gap (e.g. after downtime).
  void (async () => {
    await backfillOiFrames(coldOptFrom);
    await backfillFutOiFrames(coldFutFrom);
    await backfillPrevClose();
    await flushRedisWrites();
  })();
  setInterval(() => {
    if (!isIstMarketHours()) return;
    // Snapshot both windows up front. The option backfill can pace hundreds of
    // historical calls, and a minute-tick capture landing before the futures run
    // starts would otherwise collapse its window to zero — on the only retry
    // path an aborted futures backfill has.
    const optFrom = oiBackfillFromMs(Date.now());
    const futFrom = futOiBackfillFromMs(Date.now());
    void (async () => {
      await backfillOiFrames(optFrom);
      await backfillFutOiFrames(futFrom);
      // Covers a process that started mid-session without a baseline.
      await backfillPrevClose();
      await flushRedisWrites();
    })();
  }, 30 * 60 * 1000);
}

/** Persist the Zerodha access token so it survives a restart (best-effort). */
function persistKiteSession(session: {
  access_token: string;
  user_id: string;
  user_name: string;
}): void {
  void saveKiteSession({
    access_token: session.access_token,
    user_id: session.user_id,
    user_name: session.user_name,
    login_date: istDayKey(),
  }).catch((e) => console.warn("[Session] persist failed:", e));
}

/**
 * On startup, restore a persisted Zerodha session — but only if it was created
 * on the SAME IST day (Kite tokens expire daily, so a token from a previous day
 * is useless and is discarded). This is what keeps hourly/EOD capture and the
 * market_data recorder working after a restart/redeploy without re-login.
 */
async function restoreSessionOnStartup(): Promise<void> {
  try {
    const saved = await loadKiteSession();
    if (!saved) {
      console.log("[Session] No persisted Zerodha session found.");
      return;
    }
    if (saved.login_date !== istDayKey()) {
      console.log(
        `[Session] Persisted token is from ${saved.login_date} (stale) — daily Zerodha login required.`,
      );
      await clearKiteSession();
      return;
    }
    kite.setAccessToken(saved.access_token);
    console.log(
      `[Session] Restored today's Zerodha session for ${saved.user_name} (${saved.user_id}) — no re-login needed.`,
    );
  } catch (e) {
    console.warn("[Session] restore failed:", e);
  }
}

app.listen(PORT, () => {
  console.log(`Cal_Spread backend listening on http://localhost:${PORT}`);
  if (!process.env.KITE_API_KEY || !process.env.KITE_API_SECRET) {
    console.warn(
      "WARNING: KITE_API_KEY / KITE_API_SECRET are not set. Copy .env.example to .env and fill them in.",
    );
  }
  // Connect to MongoDB for trade persistence (no-op if MONGODB_URI is unset).
  void initDb().then(async () => {
    // Restore a same-day Zerodha session BEFORE the schedulers run, so hourly
    // capture / backfill have a session immediately after a restart.
    await restoreSessionOnStartup();
    // Restore persisted admin/trade sessions so an admin who logged in earlier
    // today stays logged in across a backend restart (no re-entering the secret).
    try {
      const sessions = await loadAdminSessions();
      for (const s of sessions) {
        adminSessions.set(s._id, { role: s.role, expiry: s.expiry });
      }
      if (sessions.length > 0) {
        console.log(`[Admin] Restored ${sessions.length} persisted admin session(s).`);
      }
    } catch (e) {
      console.warn("[Admin] session restore failed:", e);
    }
    // Restore the admin's persisted risk-free rate so GET /api/rf and the
    // frontend show the latest value immediately after a restart.
    try {
      const savedRf = await loadRfRate();
      if (savedRf !== null) {
        adminRfRate = savedRf;
        console.log(`[rf] Restored persisted risk-free rate: ${savedRf}%`);
      }
    } catch (e) {
      console.warn("[rf] restore failed:", e);
    }
    // Start hourly price capture scheduler and backfill missed hours.
    hourlyBackfillDeps = {
      getBoard: async () => deriveFnoBoard(await getAllInstrumentsCached()),
      getLatestTick: (token: number) => tickerHub.getLatestTick(token),
      kite,
      getAllInstruments: getAllInstrumentsCached,
    };
    startHourlyScheduler(hourlyBackfillDeps);
    void backfillMissedHours(hourlyBackfillDeps);
    // End-of-day review (default 16:30 IST): verify today's full day is stored;
    // backfill the gaps if not.
    startDayReviewScheduler(hourlyBackfillDeps);
    // Restore the analytics caches from Redis BEFORE the capture scheduler runs:
    // startOptionOiCapture() snapshots its backfill windows from whatever the
    // stores hold at that instant, so loading afterwards would make the gap
    // detector re-fetch from Kite everything Redis already had.
    await warmLoadFromRedis();
    // Not market-hours gated — see startRedisFlushRetry.
    startRedisFlushRetry();
    // Intraday NIFTY option-OI capture so the Analytics page has a real
    // 1m/5m/15m/1h baseline at any time of day.
    startOptionOiCapture();
  });

  // Open the dedicated trade/charges ledger connection (no-op when TRADE_LOG_URI
  // is unset — the ledger then rides on the main connection).
  void initTradeLogConnection();

  // Connect to the split nse_fno databases (archive, current, spread) and start EOD capture scheduler + backfill.
  void initNseFnoConnections().then(() => {
    eodBackfillDeps = {
      getBoard: async () => deriveFnoBoard(await getAllInstrumentsCached()),
      kite,
      getAllInstruments: getAllInstrumentsCached,
    };
    startEodScheduler(eodBackfillDeps);
    void backfillStockFutures(eodBackfillDeps);
    // Startup reconciliation: recompute summary if spread_daily has newer data.
    void checkAndRecomputeSummary();
  });
});
