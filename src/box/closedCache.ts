/**
 * Redis (Upstash) mirror of TODAY's closed box trades.
 *
 * WHY THIS EXISTS
 * The Closed-trades tab used to be served by one Mongo query over the WHOLE
 * closed book (`loadClosedBoxTrades`), sorted on `closed_at`. That query is both
 * slow and fragile — it is the only read on the page that can fail outright —
 * while the thing the operator actually wants the instant the page opens is a
 * small, bounded set: the trades closed TODAY. So today's trades are mirrored
 * here as they close and read back in one round trip; earlier days stay in Mongo,
 * where taking a moment to load is acceptable.
 *
 * BEST-EFFORT, LIKE EVERY OTHER REDIS USE (see redis.ts)
 * Every method is a no-op returning a neutral value when the feature is off or
 * Redis is unreachable, and the caller falls back to Mongo. A cache must never be
 * able to hide trades or take the app down.
 *
 * LAYOUT
 *   calspread:box:trades:closed:<YYYY-MM-DD>   hash  field=trade_id -> trade JSON
 *
 * HSET overwrites a trade's field, so re-mirroring an already-cached trade is
 * idempotent — which is what makes the boot seed and the per-close write safe to
 * run over each other.
 */

import type { BoxConfig } from "./config.js";
import { hGetAllJson, hashWriteCommands, isRedisEnabled, pipeline } from "../redis.js";
import type { SerializedBoxTrade } from "./serialize.js";

const dayKey = (day: string): string => `box:trades:closed:${day}`;

/**
 * Strip the audit blobs before caching.
 *
 * `entry_execution`, `entry_legging` and `exit_execution` are Mixed audit records
 * carrying per-leg depth snapshots, and each leg additionally holds its entry/exit
 * depth ladder. They dominate a document's size (tens of KB) and the Closed-trades
 * table renders none of them, so caching them would burn Redis memory and command
 * budget for data nothing reads. The full document is always still in Mongo for
 * anything that needs the audit trail.
 */
export function liteClosedTrade(trade: SerializedBoxTrade): SerializedBoxTrade {
  return {
    ...trade,
    entry_execution: null,
    entry_legging: null,
    exit_execution: null,
    legs: trade.legs.map((leg) => ({ ...leg, entry_depth: null, exit_depth: null })),
  };
}

/** Newest-closed first, matching the order the Mongo query returns. */
export function sortClosedNewestFirst(trades: SerializedBoxTrade[]): SerializedBoxTrade[] {
  return [...trades].sort((a, b) => {
    const at = a.closed_at ?? a.opened_at;
    const bt = b.closed_at ?? b.opened_at;
    return bt.localeCompare(at);
  });
}

export class BoxClosedTradeCache {
  constructor(private cfg: BoxConfig) {}

  /**
   * On when the feature is enabled AND an Upstash database is configured.
   *
   * Unlike the P&L cache this defaults to ON (see config.ts), because it is a
   * read-path accelerator for a view the operator opens constantly rather than an
   * opt-in reporting feature. With no Redis configured it simply reports false and
   * every read falls back to Mongo.
   */
  enabled(): boolean {
    return this.cfg.closedCacheEnabled && isRedisEnabled();
  }

  /** Mirror one closed trade. Returns false when disabled or the write missed. */
  async writeTrade(day: string, trade: SerializedBoxTrade): Promise<boolean> {
    return this.writeTrades(day, [trade]);
  }

  /** Mirror many closed trades in a single pipeline (used by the boot seed). */
  async writeTrades(day: string, trades: SerializedBoxTrade[]): Promise<boolean> {
    if (!this.enabled() || trades.length === 0) return false;
    const entries = new Map<string, unknown>();
    for (const trade of trades) entries.set(trade.id, liteClosedTrade(trade));
    const cmds = hashWriteCommands(dayKey(day), entries, [], this.cfg.closedCacheTtlSec);
    if (cmds.length === 0) return false;
    return (await pipeline(cmds)) !== null;
  }

  /**
   * Read a day's cached trades, newest-closed first.
   *
   * Returns an empty array both when the cache is off and when the day is simply
   * not cached — the caller cannot tell the difference and must not need to: it
   * falls back to Mongo either way.
   */
  async readDay(day: string): Promise<SerializedBoxTrade[]> {
    if (!this.enabled()) return [];
    const map = await hGetAllJson<SerializedBoxTrade>(dayKey(day));
    return sortClosedNewestFirst([...map.values()]);
  }
}
