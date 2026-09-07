/**
 * Redis (Upstash) mirror of the day's box P&L.
 *
 * The running net P&L of the day's box trades is written here on a slow cadence
 * so it survives a restart and can be drained to Mongo overnight. Redis remains
 * best-effort; durable archive correctness is enforced independently in Mongo.
 */

import type { BoxConfig } from "./config.js";
import {
  hGetAllJson,
  hGetAllJsonWithStatus,
  hashWriteCommands,
  isRedisEnabled,
  pipeline,
  type RedisCommand,
} from "../redis.js";
import {
  SUMMARY_FIELD,
  type BoxDailyPnlRow,
  type BoxDailyPnlSummary,
  type DaySnapshot,
} from "./pnlSnapshot.js";

const dayKey = (day: string): string => `box:pnl:day:${day}`;
const INDEX_KEY = "box:pnl:days";

export interface CachedDay {
  rows: BoxDailyPnlRow[];
  summary: BoxDailyPnlSummary | null;
  /** True only when Redis returned an actual day-hash representation. */
  present: boolean;
}

export interface DayIndexEntry {
  day: string;
  archived: boolean;
  updated_at: string;
  archived_at: string | null;
  row_count: number;
  /** Per-field retention bound; unlike the hash TTL it is not refreshed by D3. */
  expires_at?: string;
}

export interface TradeEvictionPlan {
  days: string[];
  commands: RedisCommand[];
}

export interface TradeEvictionResult {
  days: string[];
  attempted_days: number;
  completed: boolean;
}

export function buildTradeEvictionPlan(
  memberDays: readonly Pick<DayIndexEntry, "day">[],
  tradeId: string,
  ttlSec: number,
): TradeEvictionPlan {
  const days = [...new Set(memberDays.map((entry) => entry.day).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  const commands = days.flatMap((day) =>
    hashWriteCommands(dayKey(day), {}, [tradeId, SUMMARY_FIELD], ttlSec),
  );
  return { days, commands };
}

/** Select only indexed days whose actual hash contains the trade. */
export function indexedTradeDays(
  indexedDays: readonly Pick<DayIndexEntry, "day">[],
  cachedDays: ReadonlyMap<string, Pick<CachedDay, "rows">>,
  tradeId: string,
): Pick<DayIndexEntry, "day">[] {
  return indexedDays
    .filter((entry) => cachedDays.get(entry.day)?.rows.some((row) => row.trade_id === tradeId))
    .map((entry) => ({ day: entry.day }));
}

/** Apply per-entry retention even while newer fields keep the index hash alive. */
export function partitionDayIndex(
  entries: readonly DayIndexEntry[],
  ttlSec: number,
  nowMs = Date.now(),
): { active: DayIndexEntry[]; expiredDays: string[] } {
  const active: DayIndexEntry[] = [];
  const expiredDays: string[] = [];
  for (const entry of entries) {
    const explicit = entry.expires_at ? Date.parse(entry.expires_at) : Number.NaN;
    const updated = Date.parse(entry.updated_at);
    const expiresAt = Number.isFinite(explicit)
      ? explicit
      : Number.isFinite(updated)
        ? updated + Math.max(0, ttlSec) * 1000
        : 0;
    if (expiresAt > nowMs) active.push(entry);
    else if (entry.day) expiredDays.push(entry.day);
  }
  return { active, expiredDays };
}

/** Bound the write-path pruning cadence independently of index reads/deletes. */
export function shouldPruneDayIndex(
  lastPruneAt: number,
  ttlSec: number,
  nowMs = Date.now(),
): boolean {
  const intervalMs = Math.max(60_000, Math.min(ttlSec * 250, 60 * 60 * 1000));
  return nowMs - lastPruneAt >= intervalMs;
}

export class BoxPnlCache {
  private lastIndexPruneAt = 0;

  constructor(private cfg: BoxConfig) {}

  enabled(): boolean {
    return this.cfg.pnlCacheEnabled && isRedisEnabled();
  }

  async writeSnapshot(snap: DaySnapshot): Promise<boolean> {
    if (!this.enabled()) return false;
    const ttl = this.cfg.pnlCacheTtlSec;
    const day = snap.summary.day;
    const now = Date.now();
    if (shouldPruneDayIndex(this.lastIndexPruneAt, ttl, now)) {
      this.lastIndexPruneAt = now;
      await this.listDays();
    }
    const prior = await this.readDay(day);

    const entries = new Map<string, unknown>();
    for (const row of snap.rows) entries.set(row.trade_id, row);
    entries.set(SUMMARY_FIELD, snap.summary);
    const nextIds = new Set(snap.rows.map((row) => row.trade_id));
    const staleFields = prior.rows
      .map((row) => row.trade_id)
      .filter((tradeId) => !nextIds.has(tradeId));

    const indexEntry: DayIndexEntry = {
      day,
      archived: false,
      updated_at: snap.summary.updated_at,
      archived_at: null,
      row_count: snap.rows.length,
      expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
    };
    const cmds = [
      ...hashWriteCommands(dayKey(day), entries, staleFields, ttl),
      ...hashWriteCommands(INDEX_KEY, { [day]: indexEntry }, [], ttl),
    ];
    const res = await pipeline(cmds);
    return res !== null && res.every((entry) => entry !== null);
  }

  async readDay(day: string): Promise<CachedDay> {
    if (!this.enabled()) return { rows: [], summary: null, present: false };
    const map = await hGetAllJson<BoxDailyPnlRow | BoxDailyPnlSummary>(dayKey(day));
    const rows: BoxDailyPnlRow[] = [];
    let summary: BoxDailyPnlSummary | null = null;
    for (const [field, value] of map) {
      if (field === SUMMARY_FIELD) summary = value as BoxDailyPnlSummary;
      else rows.push(value as BoxDailyPnlRow);
    }
    return { rows, summary, present: map.size > 0 };
  }

  async listDays(): Promise<DayIndexEntry[]> {
    if (!this.enabled()) return [];
    const result = await hGetAllJsonWithStatus<DayIndexEntry>(INDEX_KEY);
    if (!result.available) throw new Error("Box P&L Redis day index is unavailable");
    const { active, expiredDays } = partitionDayIndex(
      [...result.values.values()],
      this.cfg.pnlCacheTtlSec,
    );
    if (expiredDays.length > 0) {
      // Do not refresh the whole index TTL while pruning old fields.
      await pipeline(hashWriteCommands(INDEX_KEY, {}, expiredDays));
    }
    return active;
  }

  async pendingDays(): Promise<DayIndexEntry[]> {
    return (await this.listDays())
      .filter((entry) => !entry.archived)
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  /**
   * Discover membership before invalidating. An indexed but unrelated current day
   * is never manufactured into a known-empty historical snapshot.
   */
  async evictTradeEverywhere(tradeId: string): Promise<TradeEvictionResult> {
    if (!this.enabled()) return { days: [], attempted_days: 0, completed: false };
    const indexed = await this.listDays();
    const members: Pick<DayIndexEntry, "day">[] = [];
    // Read and discard one day at a time. Only compact day keys are retained, not
    // every historical hash payload.
    for (const entry of indexed) {
      const cached = await this.readDay(entry.day);
      if (cached.rows.some((row) => row.trade_id === tradeId)) {
        members.push({ day: entry.day });
      }
    }
    const days: string[] = [];
    let completed = true;
    const batchSize = 32;
    for (let index = 0; index < members.length; index += batchSize) {
      const plan = buildTradeEvictionPlan(
        members.slice(index, index + batchSize),
        tradeId,
        this.cfg.pnlCacheTtlSec,
      );
      days.push(...plan.days);
      const result = await pipeline(plan.commands);
      completed &&= result !== null && result.every((entry) => entry !== null);
    }
    return { days, attempted_days: days.length, completed };
  }

  async evictTrade(day: string, tradeId: string): Promise<boolean> {
    if (!this.enabled()) return false;
    const cached = await this.readDay(day);
    if (!cached.rows.some((row) => row.trade_id === tradeId)) return true;
    const { commands } = buildTradeEvictionPlan([{ day }], tradeId, this.cfg.pnlCacheTtlSec);
    const result = await pipeline(commands);
    return result !== null && result.every((entry) => entry !== null);
  }

  async markArchived(day: string, rowCount: number, nowIso: string): Promise<void> {
    if (!this.enabled()) return;
    const entry: DayIndexEntry = {
      day,
      archived: true,
      updated_at: nowIso,
      archived_at: nowIso,
      row_count: rowCount,
      expires_at: new Date(Date.now() + this.cfg.pnlCacheTtlSec * 1000).toISOString(),
    };
    await pipeline(hashWriteCommands(INDEX_KEY, { [day]: entry }, [], this.cfg.pnlCacheTtlSec));
  }
}
