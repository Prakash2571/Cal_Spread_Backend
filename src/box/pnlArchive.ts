/**
 * The nightly box-P&L archiver.
 *
 * WHAT IT DOES
 *   - While the day is live, mirrors the running net P&L of the day's box trades
 *     (open positions + trades closed today) to Redis on a slow cadence.
 *   - At a configured hour (default 21:00 IST) drains that day's cached P&L into
 *     the `box_daily_pnl` Mongo collection, STREAMED — one document at a time with
 *     a small delay — so the transfer never lands as a single bulk write.
 *   - At later hours (default 22:00 and 23:00 IST) re-checks the day and finishes
 *     anything the first drain missed. Every upsert is idempotent, so re-draining
 *     a row that already made it across is harmless.
 *
 * WHAT IT IS NOT
 *   Not the source of truth for a trade — that is always `box_trades`, written on
 *   entry and exit exactly as before. This is a reporting mirror + archive of the
 *   day's P&L view, gated behind BOX_PNL_CACHE_ENABLED and entirely inert when off.
 *
 * All I/O is injected so the orchestration can be unit-tested without Redis, Mongo
 * or a clock, and so this file never imports the engine (which would be circular).
 */

import type { BoxConfig } from "./config.js";
import type { BoxPnlCache } from "./pnlCache.js";
import type { IBoxDailyPnl } from "./model.js";
import {
  SUMMARY_FIELD,
  buildDaySnapshot,
  missingRowIds,
  type BoxDailyPnlRow,
  type BoxDailyPnlSummary,
  type ClosedPnlInput,
  type DaySnapshot,
  type OpenPnlInput,
} from "./pnlSnapshot.js";

export interface BoxPnlArchiverDeps {
  cfg: BoxConfig;
  cache: BoxPnlCache;
  /** Live open positions' P&L, from the engine (in-memory, cheap). */
  getOpenPnl: () => OpenPnlInput[];
  /** Trades closed at or after `sinceMs` — the "closed today" set. */
  loadClosedSince: (sinceMs: number) => Promise<ClosedPnlInput[]>;
  /** Upsert one archived row (per-trade or the summary). */
  upsert: (doc: IBoxDailyPnl) => Promise<void>;
  /** Trade ids already archived for a day. */
  loadPersistedIds: (day: string) => Promise<string[]>;
  /** IST day key (YYYY-MM-DD), injected so the archiver keeps no clock of its own. */
  istDayKey: () => string;
  /** A Date whose UTC fields read as IST (i.e. now shifted by +5:30). */
  istNow: () => Date;
  /** True when the box Mongo connection is live. */
  isDbEnabled: () => boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Real epoch ms of IST-midnight for a YYYY-MM-DD day key. */
export function istDayStartMs(day: string): number {
  return new Date(`${day}T00:00:00.000+05:30`).getTime();
}

/** Flatten a snapshot into archive documents: one per row, then the summary. */
export function snapshotToDocs(
  day: string,
  rows: BoxDailyPnlRow[],
  summary: BoxDailyPnlSummary | null,
): IBoxDailyPnl[] {
  const docs: IBoxDailyPnl[] = rows.map((r) => ({
    day,
    trade_id: r.trade_id,
    underlying: r.underlying,
    direction: r.direction,
    lower_strike: r.lower_strike,
    upper_strike: r.upper_strike,
    expiry: r.expiry,
    status: r.status,
    gross_pnl: r.gross_pnl,
    net_pnl: r.net_pnl,
    realisable_net_pnl: r.realisable_net_pnl,
    realised_net_pnl: r.realised_net_pnl,
    opened_at: r.opened_at,
    closed_at: r.closed_at,
    updated_at: r.updated_at,
  }));
  if (summary) {
    // The summary is written LAST so a part-way drain never looks complete.
    docs.push({
      day,
      trade_id: SUMMARY_FIELD,
      status: "summary",
      summary,
      updated_at: summary.updated_at,
    });
  }
  return docs;
}

export class BoxPnlArchiver {
  private cacheTimer: NodeJS.Timeout | null = null;
  private schedulerTimer: NodeJS.Timeout | null = null;
  private lastArchivedDay = "";
  /** `${hour}:${day}` markers so each verify hour fires once per day. */
  private verifiedMarks = new Set<string>();
  private draining = false;
  private lastSummary: BoxDailyPnlSummary | null = null;

  constructor(private deps: BoxPnlArchiverDeps) {}

  /** The most recent summary written to the cache (for the status view). */
  getLastSummary(): BoxDailyPnlSummary | null {
    return this.lastSummary;
  }

  /** Start the cache-mirror timer and the archive/verify scheduler. */
  start(): void {
    if (!this.deps.cfg.pnlCacheEnabled) return;
    if (!this.cacheTimer) {
      this.cacheTimer = setInterval(() => {
        void this.writeCacheSnapshot().catch((e) =>
          console.warn("[BoxPnl] cache write failed:", e),
        );
      }, this.deps.cfg.pnlCacheIntervalMs);
      this.cacheTimer.unref?.();
    }
    if (!this.schedulerTimer) {
      this.schedulerTimer = setInterval(() => {
        void this.tick().catch((e) => console.warn("[BoxPnl] scheduler tick failed:", e));
      }, 60_000);
      this.schedulerTimer.unref?.();
    }
    // Cover a process that came up AFTER the archive hour: catch today (and any
    // still-pending earlier day) up immediately.
    void this.reconcileOnStartup().catch((e) =>
      console.warn("[BoxPnl] startup reconcile failed:", e),
    );
    console.log(
      `[BoxPnl] daily P&L cache enabled — mirroring every ${Math.round(
        this.deps.cfg.pnlCacheIntervalMs / 1000,
      )}s, archiving at ${this.deps.cfg.pnlArchiveHour}:00 IST, verifying at ` +
        `${this.deps.cfg.pnlVerifyHours.map((h) => `${h}:00`).join(", ")} IST.`,
    );
  }

  stop(): void {
    if (this.cacheTimer) clearInterval(this.cacheTimer);
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.cacheTimer = null;
    this.schedulerTimer = null;
  }

  /** Build today's snapshot and mirror it to Redis. Returns the summary. */
  async writeCacheSnapshot(): Promise<BoxDailyPnlSummary | null> {
    if (!this.deps.cfg.pnlCacheEnabled) return null;
    const snap = await this.buildSnapshot(this.deps.istDayKey());
    this.lastSummary = snap.summary;
    if (this.deps.cache.enabled()) await this.deps.cache.writeSnapshot(snap);
    return snap.summary;
  }

  /** Build the day's snapshot from live open positions + trades closed that day. */
  async buildSnapshot(day: string): Promise<DaySnapshot> {
    const sinceMs = istDayStartMs(day);
    const open = this.deps.getOpenPnl();
    const closed = await this.deps.loadClosedSince(sinceMs);
    return buildDaySnapshot({ day, open, closed, nowIso: new Date().toISOString() });
  }

  /**
   * Resolve the rows to archive for a day: the cache is authoritative (that is
   * what "transfer from cache to Mongo" means), but if the cache is empty or
   * unreachable we fall back to a freshly built snapshot so the day is never lost.
   */
  private async collectDay(day: string): Promise<{ docs: IBoxDailyPnl[]; source: "cache" | "fresh" }> {
    const cached = await this.deps.cache.readDay(day);
    if (cached.rows.length > 0 || cached.summary) {
      return { docs: snapshotToDocs(day, cached.rows, cached.summary), source: "cache" };
    }
    const snap = await this.buildSnapshot(day);
    return { docs: snapshotToDocs(day, snap.rows, snap.summary), source: "fresh" };
  }

  /**
   * Stream a set of archive documents into Mongo, one at a time with a delay.
   * Breaks on the first error so the remaining docs are retried on the next pass;
   * upserts are idempotent, so re-sending an already-written doc is safe.
   * Returns how many were written before stopping.
   */
  private async drain(docs: IBoxDailyPnl[]): Promise<{ written: number; complete: boolean }> {
    if (this.draining) return { written: 0, complete: false };
    this.draining = true;
    let written = 0;
    try {
      for (const doc of docs) {
        try {
          await this.deps.upsert(doc);
          written++;
        } catch (err) {
          console.error(`[BoxPnl] archive upsert failed for ${doc.day}/${doc.trade_id}:`, err);
          return { written, complete: false };
        }
        if (this.deps.cfg.pnlArchiveDrainDelayMs > 0) {
          await delay(this.deps.cfg.pnlArchiveDrainDelayMs);
        }
      }
      return { written, complete: true };
    } finally {
      this.draining = false;
    }
  }

  /** Drain the whole day (9 PM pass). */
  async archiveDay(day: string): Promise<{ ok: boolean; written: number; total: number }> {
    if (!this.deps.isDbEnabled()) {
      console.warn(`[BoxPnl] archive skipped for ${day}: box DB not connected.`);
      return { ok: false, written: 0, total: 0 };
    }
    const { docs, source } = await this.collectDay(day);
    if (docs.length === 0) {
      console.log(`[BoxPnl] nothing to archive for ${day}.`);
      await this.deps.cache.markArchived(day, 0, new Date().toISOString());
      return { ok: true, written: 0, total: 0 };
    }
    console.log(`[BoxPnl] archiving ${docs.length} P&L row(s) for ${day} (from ${source}), streaming...`);
    const { written, complete } = await this.drain(docs);
    if (complete) {
      await this.deps.cache.markArchived(day, docs.length, new Date().toISOString());
      console.log(`[BoxPnl] archived ${written}/${docs.length} P&L row(s) for ${day}.`);
    } else {
      console.warn(
        `[BoxPnl] archive for ${day} incomplete (${written}/${docs.length}) — will finish on the next verify pass.`,
      );
    }
    return { ok: complete, written, total: docs.length };
  }

  /** Re-check a day and drain only what is still missing (10/11 PM passes). */
  async verifyDay(day: string): Promise<{ ok: boolean; written: number; missing: number }> {
    if (!this.deps.isDbEnabled()) return { ok: false, written: 0, missing: 0 };
    const { docs } = await this.collectDay(day);
    if (docs.length === 0) return { ok: true, written: 0, missing: 0 };

    const persisted = await this.deps.loadPersistedIds(day);
    const missing = missingRowIds(docs.map((d) => d.trade_id), persisted);
    if (missing.length === 0) {
      await this.deps.cache.markArchived(day, docs.length, new Date().toISOString());
      console.log(`[BoxPnl] verify ${day}: complete, ${docs.length} row(s) already archived.`);
      return { ok: true, written: 0, missing: 0 };
    }
    console.warn(`[BoxPnl] verify ${day}: ${missing.length} row(s) missing — draining them now.`);
    const missingSet = new Set(missing);
    const { written, complete } = await this.drain(docs.filter((d) => missingSet.has(d.trade_id)));
    if (complete) await this.deps.cache.markArchived(day, docs.length, new Date().toISOString());
    return { ok: complete, written, missing: missing.length };
  }

  /** The 60-second scheduler tick — fires the archive and verify passes by IST hour. */
  private async tick(): Promise<void> {
    if (!this.deps.cfg.pnlCacheEnabled) return;
    const ist = this.deps.istNow();
    const hh = ist.getUTCHours();
    const mm = ist.getUTCMinutes();
    const day = this.deps.istDayKey();

    if (hh === this.deps.cfg.pnlArchiveHour && mm <= 2) {
      if (this.lastArchivedDay !== day) {
        this.lastArchivedDay = day;
        console.log(`[BoxPnl] triggering ${this.deps.cfg.pnlArchiveHour}:00 IST archive for ${day}.`);
        await this.archiveDay(day);
      }
    }

    if (this.deps.cfg.pnlVerifyHours.includes(hh) && mm <= 2) {
      const mark = `${hh}:${day}`;
      if (!this.verifiedMarks.has(mark)) {
        this.verifiedMarks.add(mark);
        console.log(`[BoxPnl] triggering ${hh}:00 IST verify for ${day}.`);
        await this.verifyDay(day);
      }
    }
  }

  /**
   * On boot, if the process is starting AFTER the archive hour, make sure today
   * is archived, and finish any earlier day the cache still lists as pending.
   */
  async reconcileOnStartup(): Promise<void> {
    if (!this.deps.cfg.pnlCacheEnabled || !this.deps.isDbEnabled()) return;
    const day = this.deps.istDayKey();
    const hh = this.deps.istNow().getUTCHours();

    // Earlier pending days first (a process that was down overnight).
    const pending = await this.deps.cache.pendingDays();
    for (const entry of pending) {
      if (entry.day < day) {
        console.log(`[BoxPnl] startup: finishing pending archive for ${entry.day}.`);
        await this.verifyDay(entry.day);
      }
    }

    // Today, only if we are already past the archive hour.
    if (hh >= this.deps.cfg.pnlArchiveHour) {
      console.log(`[BoxPnl] startup after archive hour — reconciling ${day}.`);
      this.lastArchivedDay = day;
      await this.verifyDay(day);
    }
  }
}
