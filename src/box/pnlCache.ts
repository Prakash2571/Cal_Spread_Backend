/**
 * Redis (Upstash) mirror of the day's box P&L.
 *
 * The running net P&L of the day's box trades is written here on a slow cadence
 * so it survives a restart and can be drained to Mongo overnight. Like every
 * other Redis use in this app (see redis.ts), it is BEST-EFFORT: every method is
 * a no-op that returns a neutral value when the feature is off or Redis is
 * unreachable, and the box module carries on exactly as before. A caching layer
 * must never be able to take the app down.
 *
 * LAYOUT
 *   calspread:box:pnl:day:<YYYY-MM-DD>   hash  field=trade_id -> row JSON,
 *                                              field=__summary__ -> summary JSON
 *   calspread:box:pnl:days               hash  field=<day> -> index entry JSON
 *
 * The day hash is rewritten each cycle; HSET overwrites a trade's field, so an
 * open row is replaced in place by its closed row when the trade exits. The index
 * lets the nightly archiver and the verify passes find which days still need
 * draining without scanning keys.
 */

import type { BoxConfig } from "./config.js";
import { hGetAllJson, hashWriteCommands, isRedisEnabled, pipeline } from "../redis.js";
import {
  SUMMARY_FIELD,
  type BoxDailyPnlRow,
  type BoxDailyPnlSummary,
  type DaySnapshot,
} from "./pnlSnapshot.js";

const dayKey = (day: string): string => `box:pnl:day:${day}`;
const INDEX_KEY = "box:pnl:days";

/** What the cache holds for one day. */
export interface CachedDay {
  rows: BoxDailyPnlRow[];
  summary: BoxDailyPnlSummary | null;
}

/** One entry of the pending-day index. */
export interface DayIndexEntry {
  day: string;
  archived: boolean;
  updated_at: string;
  archived_at: string | null;
  row_count: number;
}

export class BoxPnlCache {
  constructor(private cfg: BoxConfig) {}

  /** On only when the feature is enabled AND an Upstash database is configured. */
  enabled(): boolean {
    return this.cfg.pnlCacheEnabled && isRedisEnabled();
  }

  /**
   * Mirror one day's snapshot to Redis: every per-trade row, the summary, and the
   * index entry (marked not-yet-archived), in a single pipeline. Returns false
   * when disabled or the write did not land.
   */
  async writeSnapshot(snap: DaySnapshot): Promise<boolean> {
    if (!this.enabled()) return false;
    const ttl = this.cfg.pnlCacheTtlSec;
    const day = snap.summary.day;

    const entries = new Map<string, unknown>();
    for (const row of snap.rows) entries.set(row.trade_id, row);
    entries.set(SUMMARY_FIELD, snap.summary);

    const indexEntry: DayIndexEntry = {
      day,
      archived: false,
      updated_at: snap.summary.updated_at,
      archived_at: null,
      row_count: snap.rows.length,
    };

    const cmds = [
      ...hashWriteCommands(dayKey(day), entries, [], ttl),
      ...hashWriteCommands(INDEX_KEY, { [day]: indexEntry }, [], ttl),
    ];
    if (cmds.length === 0) return false;
    const res = await pipeline(cmds);
    return res !== null;
  }

  /** Read a day's cached rows + summary (empty when absent or disabled). */
  async readDay(day: string): Promise<CachedDay> {
    if (!this.enabled()) return { rows: [], summary: null };
    const map = await hGetAllJson<BoxDailyPnlRow | BoxDailyPnlSummary>(dayKey(day));
    const rows: BoxDailyPnlRow[] = [];
    let summary: BoxDailyPnlSummary | null = null;
    for (const [field, value] of map) {
      if (field === SUMMARY_FIELD) {
        summary = value as BoxDailyPnlSummary;
      } else {
        rows.push(value as BoxDailyPnlRow);
      }
    }
    return { rows, summary };
  }

  /** Every day still tracked in the index (archived or not). */
  async listDays(): Promise<DayIndexEntry[]> {
    if (!this.enabled()) return [];
    const map = await hGetAllJson<DayIndexEntry>(INDEX_KEY);
    return [...map.values()];
  }

  /** Days that still need draining to Mongo, oldest first. */
  async pendingDays(): Promise<DayIndexEntry[]> {
    const all = await this.listDays();
    return all
      .filter((d) => !d.archived)
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  /**
   * Evict one trade's row from a day's cached P&L (HDEL).
   *
   * The day hash is rewritten every cycle, but `writeSnapshot` only ever HSETs the
   * rows it currently knows about — it never removes fields that vanished. So a
   * deleted trade's row would SURVIVE indefinitely and, because the nightly
   * archiver prefers the cache over a fresh query, could later be drained into
   * `box_daily_pnl` as though the trade still existed. This closes that path.
   *
   * The summary field is deliberately left alone: the caller rewrites it from the
   * recomputed totals immediately afterwards, and deleting it here would briefly
   * make the day look summary-less to a concurrent reader.
   */
  async evictTrade(day: string, tradeId: string): Promise<boolean> {
    if (!this.enabled()) return false;
    const cmds = hashWriteCommands(dayKey(day), new Map(), [tradeId], this.cfg.pnlCacheTtlSec);
    if (cmds.length === 0) return false;
    return (await pipeline(cmds)) !== null;
  }

  /** Flag a day as archived in the index (keeps it readable for verify). */
  async markArchived(day: string, rowCount: number, nowIso: string): Promise<void> {
    if (!this.enabled()) return;
    const entry: DayIndexEntry = {
      day,
      archived: true,
      updated_at: nowIso,
      archived_at: nowIso,
      row_count: rowCount,
    };
    const cmds = hashWriteCommands(INDEX_KEY, { [day]: entry }, [], this.cfg.pnlCacheTtlSec);
    if (cmds.length > 0) await pipeline(cmds);
  }
}
