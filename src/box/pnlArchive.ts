/** Nightly Box P&L cache mirror and streamed durable archive. */

import type { BoxConfig } from "./config.js";
import type { BoxPnlCache } from "./pnlCache.js";
import type { IBoxDailyPnl } from "./model.js";
import {
  SUMMARY_FIELD,
  buildDaySnapshot,
  missingRowIds,
  summarizeDayRows,
  type BoxDailyPnlRow,
  type BoxDailyPnlSummary,
  type ClosedPnlInput,
  type DaySnapshot,
  type OpenPnlInput,
} from "./pnlSnapshot.js";

export interface BoxPnlArchiverDeps {
  cfg: BoxConfig;
  cache: BoxPnlCache;
  getOpenPnl: () => OpenPnlInput[];
  loadClosedSince: (sinceMs: number) => Promise<ClosedPnlInput[]>;
  upsert: (doc: IBoxDailyPnl) => Promise<void>;
  filterExistingTradeIds: (ids: string[]) => Promise<string[]>;
  /** Exact day-bounded durable representation. Errors must propagate. */
  loadPersistedDay: (day: string) => Promise<IBoxDailyPnl[]>;
  isPersistedDayComplete: (day: string, docs: IBoxDailyPnl[]) => Promise<boolean>;
  markPersistedDayIncomplete: (day: string) => Promise<void>;
  markPersistedDayComplete: (day: string, docs: IBoxDailyPnl[]) => Promise<void>;
  deletePersistedRows: (day: string, tradeIds: string[]) => Promise<number>;
  /** Finish pending deletion intents and remove source-less archive rows. */
  reconcileDurableOrphans: () => Promise<number>;
  istDayKey: () => string;
  istNow: () => Date;
  isDbEnabled: () => boolean;
  /** Deterministic scheduler seams; production uses the native timer and clock. */
  setReconcileTimeout?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearReconcileTimeout?: (timer: NodeJS.Timeout) => void;
  reconcileNowMs?: () => number;
}

const FULL_RECONCILE_INTERVAL_MS = 5 * 60_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function istDayStartMs(day: string): number {
  return new Date(`${day}T00:00:00.000+05:30`).getTime();
}

export function snapshotToDocs(
  day: string,
  rows: BoxDailyPnlRow[],
  summary: BoxDailyPnlSummary | null,
): IBoxDailyPnl[] {
  const docs: IBoxDailyPnl[] = rows.map((row) => ({
    day,
    trade_id: row.trade_id,
    underlying: row.underlying,
    direction: row.direction,
    lower_strike: row.lower_strike,
    upper_strike: row.upper_strike,
    expiry: row.expiry,
    status: row.status,
    gross_pnl: row.gross_pnl,
    net_pnl: row.net_pnl,
    realisable_net_pnl: row.realisable_net_pnl,
    realised_net_pnl: row.realised_net_pnl,
    opened_at: row.opened_at,
    closed_at: row.closed_at,
    updated_at: row.updated_at,
  }));
  if (summary) {
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

function persistedRows(docs: IBoxDailyPnl[]): BoxDailyPnlRow[] {
  return docs.flatMap((doc) =>
    doc.trade_id !== SUMMARY_FIELD && (doc.status === "open" || doc.status === "closed")
      ? [doc as BoxDailyPnlRow]
      : [],
  );
}

export class BoxPnlArchiver {
  private cacheTimer: NodeJS.Timeout | null = null;
  private schedulerTimer: NodeJS.Timeout | null = null;
  private durableRetryTimer: NodeJS.Timeout | null = null;
  private durableRetryDueAt: number | null = null;
  private durableReconcileInFlight: Promise<void> | null = null;
  private queuedReconcileDelayMs: number | null = null;
  private started = false;
  private stopped = false;
  private lastArchivedDay = "";
  private verifiedMarks = new Set<string>();
  private deletedTradeIds = new Set<string>();
  private lifecycleTail: Promise<void> = Promise.resolve();
  private lastSummary: BoxDailyPnlSummary | null = null;

  constructor(private deps: BoxPnlArchiverDeps) {}

  /** Serialize snapshots and the complete collect→drain lifecycle in-process. */
  private runLifecycle<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTail;
    let release!: () => void;
    this.lifecycleTail = new Promise<void>((resolve) => { release = resolve; });
    return (async () => {
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    })();
  }

  /**
   * Install the local fast-path tombstone immediately, then run deletion cleanup
   * between complete archive lifecycles. Durable fencing is enforced separately
   * by the repository so this is not relied on across processes.
   */
  async withTradeDeletion<T>(tradeId: string, cleanup: () => Promise<T>): Promise<T> {
    this.deletedTradeIds.add(tradeId);
    try {
      return await this.runLifecycle(cleanup);
    } finally {
      // The durable fence and source checks take over after local cleanup.
      this.deletedTradeIds.delete(tradeId);
    }
  }

  /** Compatibility helper for callers/tests that only need the local barrier. */
  async tombstoneTrade(tradeId: string): Promise<void> {
    await this.withTradeDeletion(tradeId, async () => undefined);
  }

  /** Schedule or accelerate one deduplicated bounded full reconciliation pass. */
  requestFullReconcile(delayMs = 30_000): void {
    if (this.stopped || !this.deps.isDbEnabled()) return;
    const boundedDelay = Math.min(FULL_RECONCILE_INTERVAL_MS, Math.max(0, delayMs));
    if (this.durableReconcileInFlight) {
      this.queuedReconcileDelayMs = this.queuedReconcileDelayMs === null
        ? boundedDelay
        : Math.min(this.queuedReconcileDelayMs, boundedDelay);
      return;
    }

    const now = this.deps.reconcileNowMs?.() ?? Date.now();
    const dueAt = now + boundedDelay;
    if (this.durableRetryTimer && this.durableRetryDueAt !== null) {
      if (this.durableRetryDueAt <= dueAt) return;
      (this.deps.clearReconcileTimeout ?? clearTimeout)(this.durableRetryTimer);
    }
    const schedule = this.deps.setReconcileTimeout ?? setTimeout;
    this.durableRetryDueAt = dueAt;
    this.durableRetryTimer = schedule(() => {
      this.durableRetryTimer = null;
      this.durableRetryDueAt = null;
      if (this.stopped) return;
      void this.reconcileOnStartup().catch((err) => {
        console.warn("[BoxPnl] full reconciliation retry failed:", err);
      });
    }, boundedDelay);
    this.durableRetryTimer.unref?.();
  }

  /** Compatibility name retained for the engine deletion path. */
  requestDurableReconcile(delayMs = 30_000): void {
    this.requestFullReconcile(delayMs);
  }

  getLastSummary(): BoxDailyPnlSummary | null {
    return this.lastSummary;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    // Durable deletion intents exist independently of Redis/cache enablement.
    if (this.deps.isDbEnabled()) {
      void this.reconcileOnStartup().catch((err) => {
        console.warn("[BoxPnl] startup reconcile failed:", err);
        this.requestFullReconcile();
      });
    }
    if (!this.deps.cfg.pnlCacheEnabled) return;
    if (!this.cacheTimer) {
      this.cacheTimer = setInterval(() => {
        void this.writeCacheSnapshot().catch((err) =>
          console.warn("[BoxPnl] cache write failed:", err),
        );
      }, this.deps.cfg.pnlCacheIntervalMs);
      this.cacheTimer.unref?.();
    }
    if (!this.schedulerTimer) {
      this.schedulerTimer = setInterval(() => {
        void this.tick().catch((err) => console.warn("[BoxPnl] scheduler tick failed:", err));
      }, 60_000);
      this.schedulerTimer.unref?.();
    }
    console.log(
      `[BoxPnl] daily P&L cache enabled — mirroring every ${Math.round(
        this.deps.cfg.pnlCacheIntervalMs / 1000,
      )}s, archiving at ${this.deps.cfg.pnlArchiveHour}:00 IST, verifying at ` +
        `${this.deps.cfg.pnlVerifyHours.map((hour) => `${hour}:00`).join(", ")} IST.`,
    );
  }

  stop(): void {
    this.started = false;
    this.stopped = true;
    if (this.cacheTimer) clearInterval(this.cacheTimer);
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    if (this.durableRetryTimer) {
      (this.deps.clearReconcileTimeout ?? clearTimeout)(this.durableRetryTimer);
    }
    this.cacheTimer = null;
    this.schedulerTimer = null;
    this.durableRetryTimer = null;
    this.durableRetryDueAt = null;
    this.queuedReconcileDelayMs = null;
  }

  async writeCacheSnapshot(): Promise<BoxDailyPnlSummary | null> {
    return this.runLifecycle(async () => {
      if (!this.deps.cfg.pnlCacheEnabled) return null;
      const day = this.deps.istDayKey();
      const snap = await this.buildSnapshot(day);
      const rows = snap.rows.filter((row) => !this.deletedTradeIds.has(row.trade_id));
      const summary = summarizeDayRows({ day, rows, nowIso: new Date().toISOString() });
      const safeSnap = { day, rows, summary };
      this.lastSummary = summary;
      if (this.deps.cache.enabled()) await this.deps.cache.writeSnapshot(safeSnap);
      return summary;
    });
  }

  async buildSnapshot(day: string): Promise<DaySnapshot> {
    const sinceMs = istDayStartMs(day);
    const open = this.deps.getOpenPnl();
    const closed = await this.deps.loadClosedSince(sinceMs);
    return buildDaySnapshot({ day, open, closed, nowIso: new Date().toISOString() });
  }

  private async collectDay(day: string): Promise<{
    docs: IBoxDailyPnl[];
    source: "cache" | "fresh" | "durable";
  }> {
    const cached = await this.deps.cache.readDay(day);
    const cachePresent = cached.present ?? (cached.rows.length > 0 || cached.summary !== null);
    if (cachePresent) {
      const existingIds = new Set(
        await this.deps.filterExistingTradeIds(cached.rows.map((row) => row.trade_id)),
      );
      const rows = cached.rows.filter(
        (row) => existingIds.has(row.trade_id) && !this.deletedTradeIds.has(row.trade_id),
      );
      const summary = summarizeDayRows({ day, rows, nowIso: new Date().toISOString() });
      return { docs: snapshotToDocs(day, rows, summary), source: "cache" };
    }

    if (day !== this.deps.istDayKey()) {
      // A historical miss/outage must never be synthesized from current-open plus
      // every close since D1. Only a completed, exact-day durable snapshot is safe.
      let durable = await this.deps.loadPersistedDay(day);
      let complete = await this.deps.isPersistedDayComplete(day, durable);
      if (complete) {
        // Legacy migration and concurrent cleanup may have rewritten the day.
        // Reload and revalidate so callers never drain the pre-migration snapshot.
        durable = await this.deps.loadPersistedDay(day);
        complete = await this.deps.isPersistedDayComplete(day, durable);
      }
      const candidates = persistedRows(durable);
      if (!complete || !durable.some((doc) => doc.trade_id === SUMMARY_FIELD)) {
        throw new Error(`historical Box P&L snapshot for ${day} is unavailable or incomplete`);
      }
      const existingIds = new Set(
        await this.deps.filterExistingTradeIds(candidates.map((row) => row.trade_id)),
      );
      const rows = candidates.filter(
        (row) => existingIds.has(row.trade_id) && !this.deletedTradeIds.has(row.trade_id),
      );
      const summary = summarizeDayRows({ day, rows, nowIso: new Date().toISOString() });
      return { docs: snapshotToDocs(day, rows, summary), source: "durable" };
    }

    const snap = await this.buildSnapshot(day);
    const rows = snap.rows.filter((row) => !this.deletedTradeIds.has(row.trade_id));
    const summary = summarizeDayRows({ day, rows, nowIso: new Date().toISOString() });
    return { docs: snapshotToDocs(day, rows, summary), source: "fresh" };
  }

  private async drain(
    docs: IBoxDailyPnl[],
    fullDayDocs: IBoxDailyPnl[] = docs,
  ): Promise<{ written: number; complete: boolean }> {
    let written = 0;
    for (const doc of docs) {
      const deletedRow = doc.trade_id !== SUMMARY_FIELD && this.deletedTradeIds.has(doc.trade_id);
      const staleSummary = doc.trade_id === SUMMARY_FIELD && fullDayDocs.some(
        (row) => row.trade_id !== SUMMARY_FIELD && this.deletedTradeIds.has(row.trade_id),
      );
      if (deletedRow || staleSummary) continue;
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
  }

  async archiveDay(day: string): Promise<{ ok: boolean; written: number; total: number }> {
    return this.runLifecycle(() => this.archiveDayUnlocked(day));
  }

  private async archiveDayUnlocked(
    day: string,
  ): Promise<{ ok: boolean; written: number; total: number }> {
    if (!this.deps.isDbEnabled()) {
      console.warn(`[BoxPnl] archive skipped for ${day}: box DB not connected.`);
      return { ok: false, written: 0, total: 0 };
    }
    const { docs, source } = await this.collectDay(day);
    await this.deps.markPersistedDayIncomplete(day);
    console.log(`[BoxPnl] archiving ${docs.length} P&L row(s) for ${day} (from ${source}), streaming...`);
    const { written, complete } = await this.drain(docs);
    if (complete) {
      await this.deps.markPersistedDayComplete(day, docs);
      await this.deps.cache.markArchived(day, docs.length, new Date().toISOString());
      console.log(`[BoxPnl] archived ${written}/${docs.length} P&L row(s) for ${day}.`);
    } else {
      console.warn(
        `[BoxPnl] archive for ${day} incomplete (${written}/${docs.length}) — will finish on verify.`,
      );
    }
    return { ok: complete, written, total: docs.length };
  }

  async verifyDay(day: string): Promise<{ ok: boolean; written: number; missing: number }> {
    return this.runLifecycle(() => this.verifyDayUnlocked(day));
  }

  private async verifyDayUnlocked(
    day: string,
  ): Promise<{ ok: boolean; written: number; missing: number }> {
    if (!this.deps.isDbEnabled()) return { ok: false, written: 0, missing: 0 };
    const { docs } = await this.collectDay(day);
    const desiredRows = docs.filter((doc) => doc.trade_id !== SUMMARY_FIELD);
    const desiredIds = desiredRows.map((doc) => doc.trade_id);
    await this.deps.markPersistedDayIncomplete(day);
    const persisted = await this.deps.loadPersistedDay(day);
    const persistedIds = persisted
      .map((doc) => doc.trade_id)
      .filter((id) => id !== SUMMARY_FIELD);
    const desiredSet = new Set(desiredIds);
    const extras = persistedIds.filter((id) => !desiredSet.has(id));
    if (extras.length > 0) await this.deps.deletePersistedRows(day, extras);

    const missingRows = missingRowIds(desiredIds, persistedIds);
    // Re-upsert every survivor, not just missing ids: otherwise an existing stale
    // row would make the repository's survivor-derived summary stale as well.
    const toWrite = [...desiredRows];
    const summary = docs.find((doc) => doc.trade_id === SUMMARY_FIELD);
    if (summary) toWrite.push(summary);

    const { written, complete } = await this.drain(toWrite, docs);
    if (complete) {
      await this.deps.markPersistedDayComplete(day, docs);
      await this.deps.cache.markArchived(day, docs.length, new Date().toISOString());
    }
    return { ok: complete, written, missing: missingRows.length + extras.length };
  }

  private async tick(): Promise<void> {
    if (!this.deps.cfg.pnlCacheEnabled) return;
    const ist = this.deps.istNow();
    const hh = ist.getUTCHours();
    const mm = ist.getUTCMinutes();
    const day = this.deps.istDayKey();

    if (hh === this.deps.cfg.pnlArchiveHour && mm <= 2 && this.lastArchivedDay !== day) {
      this.lastArchivedDay = day;
      await this.archiveDay(day);
    }
    if (this.deps.cfg.pnlVerifyHours.includes(hh) && mm <= 2) {
      const mark = `${hh}:${day}`;
      if (!this.verifiedMarks.has(mark)) {
        this.verifiedMarks.add(mark);
        await this.verifyDay(day);
      }
    }
  }

  async reconcileOnStartup(): Promise<void> {
    if (!this.deps.isDbEnabled() || this.stopped) return;
    if (this.durableReconcileInFlight) return this.durableReconcileInFlight;

    let needsRetry = true;
    const run = (async () => {
      needsRetry = await this.runReconcilePass();
    })();
    this.durableReconcileInFlight = run;
    try {
      await run;
    } finally {
      if (this.durableReconcileInFlight === run) this.durableReconcileInFlight = null;
      if (!this.stopped) {
        const queued = this.queuedReconcileDelayMs;
        this.queuedReconcileDelayMs = null;
        if (queued !== null || needsRetry || this.started) {
          this.requestFullReconcile(
            queued ?? (needsRetry ? 30_000 : FULL_RECONCILE_INTERVAL_MS),
          );
        }
      }
    }
  }

  private async runReconcilePass(): Promise<boolean> {
    let needsRetry = false;
    try {
      const repaired = await this.deps.reconcileDurableOrphans();
      if (repaired > 0) console.warn(`[BoxPnl] startup repaired ${repaired} durable item(s).`);
    } catch (err) {
      needsRetry = true;
      console.warn("[BoxPnl] startup orphan reconciliation failed:", err);
    }

    if (this.deps.cfg.pnlCacheEnabled) {
      const day = this.deps.istDayKey();
      let pending: Awaited<ReturnType<BoxPnlCache["pendingDays"]>> = [];
      try {
        pending = await this.deps.cache.pendingDays();
      } catch (err) {
        needsRetry = true;
        console.warn("[BoxPnl] could not list pending archive days:", err);
      }
      for (const entry of pending) {
        if (entry.day >= day) continue;
        try {
          await this.verifyDay(entry.day);
        } catch (err) {
          needsRetry = true;
          console.warn(`[BoxPnl] startup reconcile failed for historical day ${entry.day}:`, err);
        }
      }
      if (this.deps.istNow().getUTCHours() >= this.deps.cfg.pnlArchiveHour) {
        this.lastArchivedDay = day;
        try {
          await this.verifyDay(day);
        } catch (err) {
          needsRetry = true;
          console.warn(`[BoxPnl] startup reconcile failed for current day ${day}:`, err);
        }
      }
    }

    return needsRetry;
  }
}
