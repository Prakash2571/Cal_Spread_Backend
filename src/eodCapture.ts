import {
  isNseFnoDbEnabled,
  isArchiveDbEnabled,
  StockFuture,
  StockFutureArchive,
  SpreadDaily,
  SpreadSummary,
} from "./db.js";
import type { IStockFuture, ISpreadDaily, ISpreadSummary } from "./db.js";
import type { KiteClient, Instrument } from "./kite.js";

// ============================================================================
//  Pending write queues (cache-first, drip-write to DB)
// ============================================================================

let pendingStockFutures: IStockFuture[] = [];
let pendingSpreadDaily: ISpreadDaily[] = [];
let drainingStockFutures = false;

// ============================================================================
//  Types
// ============================================================================

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

export interface EodSchedulerDeps {
  getBoard: () => Promise<BoardItem[]>;
  kite: KiteClient;
  getAllInstruments: () => Promise<Instrument[]>;
}

// ============================================================================
//  Helpers
// ============================================================================

/** Current IST Date (UTC+5:30). */
function istNow(): Date {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
}

/** YYYY-MM-DD in IST. */
function istDayKey(): string {
  return istNow().toISOString().slice(0, 10);
}

/** Small delay utility for rate limiting. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Check if a date string (YYYY-MM-DD) is a weekday. */
function isWeekday(dateStr: string): boolean {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = d.getUTCDay();
  return day !== 0 && day !== 6;
}

/** Get all weekdays between two dates (exclusive start, inclusive end). */
function getWeekdaysBetween(startDate: string, endDate: string): string[] {
  const days: string[] = [];
  const current = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");

  // Move to the day after start (exclusive).
  current.setUTCDate(current.getUTCDate() + 1);

  while (current <= end) {
    const dateStr = current.toISOString().slice(0, 10);
    if (isWeekday(dateStr)) {
      days.push(dateStr);
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return days;
}

// ============================================================================
//  Drain functions: write cached docs to DB one at a time with 50ms delay
// ============================================================================

/**
 * Drip-write pending stock_futures docs to MongoDB.
 * Peeks at the front of the queue and only removes after a successful write.
 * Breaks on error so the remaining docs can be retried on the next cycle.
 */
async function drainStockFutures(): Promise<void> {
  if (drainingStockFutures) return;
  drainingStockFutures = true;
  let drained = 0;
  try {
    while (pendingStockFutures.length > 0) {
      const doc = pendingStockFutures[0]!;
      try {
        await StockFuture.updateOne(
          { symbol: doc.symbol, trading_date: doc.trading_date, expiry: doc.expiry },
          { $set: doc },
          { upsert: true },
        );
        pendingStockFutures.shift();
        drained++;
      } catch (err) {
        console.error(`[EODCapture] Failed to upsert stock_futures ${doc.symbol}:`, err);
        break;
      }
      await delay(50);
    }
  } finally {
    drainingStockFutures = false;
  }
  if (drained > 0) {
    console.log(`[EODCapture] Drained ${drained} stock_futures docs to DB.`);
  }
}

/**
 * Drip-write pending spread_daily docs to MongoDB.
 * Same peek-then-shift pattern: breaks on failure for retry.
 */
async function drainSpreadDaily(): Promise<void> {
  let drained = 0;
  while (pendingSpreadDaily.length > 0) {
    const doc = pendingSpreadDaily[0]!;
    try {
      await SpreadDaily.updateOne(
        { symbol: doc.symbol, trading_date: doc.trading_date },
        { $set: doc },
        { upsert: true },
      );
      pendingSpreadDaily.shift();
      drained++;
    } catch (err) {
      console.error(`[EODCapture] Failed to upsert spread_daily ${doc.symbol}:`, err);
      break;
    }
    await delay(50);
  }
  if (drained > 0) {
    console.log(`[EODCapture] Drained ${drained} spread_daily docs to DB.`);
  }
}

// ============================================================================
//  EOD Capture: fetch today's closing data and store in stock_futures
// ============================================================================

let lastCapturedDay = "";

/**
 * Capture end-of-day data for all FNO stock futures.
 * Fetches full quotes (OHLC + OI) via the Kite quote API for today's session
 * and stores each futures contract as a stock_futures document.
 */
async function captureEodData(deps: EodSchedulerDeps): Promise<void> {
  const { getBoard, kite, getAllInstruments } = deps;

  if (!kite.hasSession()) {
    console.log("[EODCapture] No Kite session available. Skipping EOD capture.");
    return;
  }
  if (!isNseFnoDbEnabled()) {
    console.log("[EODCapture] nse_fno DB not connected. Skipping EOD capture.");
    return;
  }

  const today = istDayKey();
  if (!isWeekday(today)) {
    console.log("[EODCapture] Today is not a weekday. Skipping.");
    return;
  }

  const board = await getBoard();
  const allInstruments = await getAllInstruments();

  // Build a token -> instrument map for NFO FUT instruments.
  const tokenToInstrument = new Map<number, Instrument>();
  for (const inst of allInstruments) {
    if (inst.exchange === "NFO" && inst.instrument_type === "FUT") {
      tokenToInstrument.set(inst.instrument_token, inst);
    }
  }

  // Collect all futures tokens and their identifiers.
  const tokenToIdentifier = new Map<number, string>();
  for (const item of board) {
    if (item.is_index) continue; // Only stock futures
    for (const f of item.futures) {
      const inst = tokenToInstrument.get(f.token);
      if (inst) {
        tokenToIdentifier.set(f.token, `NFO:${inst.tradingsymbol}`);
      }
    }
  }

  const identifiers = Array.from(tokenToIdentifier.values());
  if (identifiers.length === 0) {
    console.log("[EODCapture] No FNO identifiers found. Skipping.");
    return;
  }

  // Fetch full OHLC quotes for all futures.
  const quotes = await kite.getQuoteFullOhlc(identifiers);
  const quoteByToken = new Map<number, (typeof quotes)[number]>();
  for (const q of quotes) {
    quoteByToken.set(q.instrument_token, q);
  }

  const tradingDate = new Date(today + "T00:00:00.000Z");
  let queuedCount = 0;

  for (const item of board) {
    if (item.is_index) continue;
    for (const f of item.futures) {
      const q = quoteByToken.get(f.token);
      if (!q || q.close === 0) continue;

      const doc: IStockFuture = {
        trading_date: tradingDate,
        symbol: item.symbol,
        instrument: "FUTSTK",
        expiry: new Date(f.expiry + "T00:00:00.000Z"),
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        settle_price: q.close,
        contracts: 0,
        value_lakh: 0,
        open_interest: q.oi,
        change_in_oi: 0,
      };

      pendingStockFutures.push(doc);
      queuedCount++;
    }
  }

  console.log(
    `[EODCapture] Queued ${queuedCount} stock_futures docs for ${today}. Draining to DB...`,
  );
  await drainStockFutures();

  // After capturing, compute spreads for today.
  await computeSpreads([today]);
}

// ============================================================================
//  Backfill: fill in missing weekdays using historical API
// ============================================================================

/**
 * On startup, find the latest trading_date in stock_futures and backfill
 * all missing weekdays up to yesterday using getHistoricalFull.
 */
export async function backfillStockFutures(deps: EodSchedulerDeps): Promise<void> {
  const { getBoard, kite, getAllInstruments } = deps;

  if (!kite.hasSession()) {
    console.log("[EODCapture] No Kite session. Skipping backfill.");
    return;
  }
  if (!isNseFnoDbEnabled()) {
    console.log("[EODCapture] nse_fno DB not connected. Skipping backfill.");
    return;
  }

  // Find the most recent trading_date in stock_futures.
  const latestDoc = await StockFuture.findOne()
    .sort({ trading_date: -1 })
    .lean();

  if (!latestDoc) {
    console.log(
      "[EODCapture] No existing stock_futures data. Backfill requires at least some seed data.",
    );
    return;
  }

  const lastDateStr = latestDoc.trading_date.toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() + 5.5 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  const missingDays = getWeekdaysBetween(lastDateStr, yesterdayStr);
  if (missingDays.length === 0) {
    console.log("[EODCapture] Backfill: no missing days found.");
    return;
  }

  console.log(
    `[EODCapture] Backfilling ${missingDays.length} missing day(s): ${missingDays[0]} to ${missingDays[missingDays.length - 1]}.`,
  );

  const board = await getBoard();
  const allInstruments = await getAllInstruments();

  // Build a token -> instrument map for NFO FUT instruments.
  const tokenToInstrument = new Map<number, Instrument>();
  for (const inst of allInstruments) {
    if (inst.exchange === "NFO" && inst.instrument_type === "FUT") {
      tokenToInstrument.set(inst.instrument_token, inst);
    }
  }

  const fromDate = missingDays[0]!;
  const toDate = missingDays[missingDays.length - 1]!;
  const missingDaySet = new Set(missingDays);
  let totalQueued = 0;

  for (const item of board) {
    if (item.is_index) continue; // Only stock futures

    for (const f of item.futures) {
      const inst = tokenToInstrument.get(f.token);
      if (!inst) continue;

      try {
        const candles = await kite.getHistoricalFull(f.token, fromDate, toDate);
        await delay(300); // Rate limit

        for (const candle of candles) {
          if (!missingDaySet.has(candle.date)) continue;
          if (candle.close === 0) continue;

          const doc: IStockFuture = {
            trading_date: new Date(candle.date + "T00:00:00.000Z"),
            symbol: item.symbol,
            instrument: "FUTSTK",
            expiry: new Date(f.expiry + "T00:00:00.000Z"),
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            settle_price: candle.close,
            contracts: 0,
            value_lakh: 0,
            open_interest: candle.oi,
            change_in_oi: 0,
          };

          pendingStockFutures.push(doc);
          totalQueued++;
        }
      } catch (err) {
        console.error(
          `[EODCapture] Backfill failed for ${item.symbol} token ${f.token}:`,
          err,
        );
        await delay(500);
      }
    }
  }

  console.log(
    `[EODCapture] Backfill queued ${totalQueued} stock_futures docs. Draining to DB...`,
  );
  await drainStockFutures();
  console.log("[EODCapture] Backfill drain complete.");

  // Compute spreads for all backfilled days.
  if (missingDays.length > 0) {
    await computeSpreads(missingDays);
  }
}

// ============================================================================
//  Spread Computation
// ============================================================================

/**
 * For each (symbol, trading_date) in the given dates, sort futures by expiry
 * ascending, take the two nearest, compute spread = mid_close - near_close,
 * and upsert into spread_daily.
 *
 * Queries both the archive DB (for dates before 2026-01-01) and the current DB
 * (for dates >= 2026-01-01), then merges results before grouping.
 */
export async function computeSpreads(dates: string[]): Promise<void> {
  if (!isNseFnoDbEnabled()) return;
  if (dates.length === 0) return;

  const CUTOFF = "2026-01-01";
  const archiveDates = dates.filter((d) => d < CUTOFF);
  const currentDates = dates.filter((d) => d >= CUTOFF);

  type StockFutureDoc = IStockFuture & { _id?: unknown };
  let records: StockFutureDoc[] = [];

  // Query current DB for dates >= 2026-01-01.
  if (currentDates.length > 0) {
    const currentDateObjects = currentDates.map((d) => new Date(d + "T00:00:00.000Z"));
    const currentRecords = await StockFuture.find({
      trading_date: { $in: currentDateObjects },
    }).lean();
    records = records.concat(currentRecords);
  }

  // Query archive DB for dates < 2026-01-01.
  // NOTE: The archive DB contains data up to Aug 31, 2025. Dates in Sep-Dec 2025
  // are expected to return no records -- this is an intentional gap in the dataset,
  // not a bug. The user simply does not have data for that period.
  if (archiveDates.length > 0) {
    if (isArchiveDbEnabled()) {
      const archiveDateObjects = archiveDates.map((d) => new Date(d + "T00:00:00.000Z"));
      const archiveRecords = await StockFutureArchive.find({
        trading_date: { $in: archiveDateObjects },
      }).lean();
      records = records.concat(archiveRecords);
    } else {
      console.warn(
        `[EODCapture] Archive DB is not connected but ${archiveDates.length} date(s) require archive data (pre-2026). Spread results will be incomplete for those dates.`,
      );
    }
  }

  // Group by (symbol, trading_date).
  const grouped = new Map<string, typeof records>();
  for (const rec of records) {
    const key = `${rec.symbol}_${rec.trading_date.toISOString().slice(0, 10)}`;
    const arr = grouped.get(key) ?? [];
    arr.push(rec);
    grouped.set(key, arr);
  }

  let queuedCount = 0;

  for (const [, contracts] of grouped) {
    if (contracts.length < 2) continue;

    // Sort by expiry ascending.
    contracts.sort(
      (a: { expiry: Date }, b: { expiry: Date }) => a.expiry.getTime() - b.expiry.getTime(),
    );

    const near = contracts[0]!;
    const mid = contracts[1]!;

    if (near.close === 0 || mid.close === 0) continue;

    const spread = mid.close - near.close;

    const doc: ISpreadDaily = {
      symbol: near.symbol,
      trading_date: near.trading_date,
      near_expiry: near.expiry,
      mid_expiry: mid.expiry,
      near_close: near.close,
      mid_close: mid.close,
      spread,
    };

    pendingSpreadDaily.push(doc);
    queuedCount++;
  }

  console.log(
    `[EODCapture] Queued ${queuedCount} spread_daily docs. Draining to DB...`,
  );
  await drainSpreadDaily();
}

// ============================================================================
//  Monthly Summary Recalculation
// ============================================================================

/**
 * Recompute the entire spread_summary collection from spread_daily.
 * Fetches all spread_daily records, groups by symbol, and computes per-symbol:
 *   observations, first_date, last_date, mean_spread, max_spread, min_spread,
 *   mean_deviation (avg of |spread - mean|), max_abs_spread (max of |spread|),
 *   std_dev_spread (standard deviation), percentile_95 (95th percentile value),
 *   mean_reversion_probability (% of times spread crossed back through mean).
 *
 * Processes symbols SERIALLY with a 200ms delay between each to avoid
 * overloading the DB. Uses bulkWrite with replaceOne + upsert per symbol.
 */
export async function recomputeSpreadSummary(): Promise<void> {
  if (!isNseFnoDbEnabled()) return;

  console.log("[EODCapture] Recomputing spread_summary...");

  // Fetch all spread_daily records.
  const allRecords = await SpreadDaily.find({}).lean();

  if (allRecords.length === 0) {
    console.log("[EODCapture] No spread_daily records found. Skipping summary.");
    return;
  }

  // Group by symbol.
  const grouped = new Map<string, typeof allRecords>();
  for (const rec of allRecords) {
    const arr = grouped.get(rec.symbol) ?? [];
    arr.push(rec);
    grouped.set(rec.symbol, arr);
  }

  const bulkOps: {
    replaceOne: {
      filter: { symbol: string };
      replacement: ISpreadSummary;
      upsert: boolean;
    };
  }[] = [];

  const symbols = Array.from(grouped.keys());

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i]!;
    const records = grouped.get(symbol)!;

    if (i > 0) await delay(200);

    const spreads = records.map((r) => r.spread);
    const n = spreads.length;

    // Basic stats.
    let sum = 0;
    let maxSpread = -Infinity;
    let minSpread = Infinity;
    let maxAbs = 0;
    let firstDate = records[0]!.trading_date;
    let lastDate = records[0]!.trading_date;

    for (const rec of records) {
      sum += rec.spread;
      if (rec.spread > maxSpread) maxSpread = rec.spread;
      if (rec.spread < minSpread) minSpread = rec.spread;
      const abs = Math.abs(rec.spread);
      if (abs > maxAbs) maxAbs = abs;
      if (rec.trading_date < firstDate) firstDate = rec.trading_date;
      if (rec.trading_date > lastDate) lastDate = rec.trading_date;
    }

    const mean = sum / n;

    // Mean deviation: average of |spread - mean|.
    let deviationSum = 0;
    for (const s of spreads) {
      deviationSum += Math.abs(s - mean);
    }
    const meanDeviation = deviationSum / n;

    // Standard deviation.
    let varianceSum = 0;
    for (const s of spreads) {
      varianceSum += (s - mean) ** 2;
    }
    const stdDev = Math.sqrt(varianceSum / n);

    // Percentile 95: sort ascending, take value at index ceil(0.95 * n) - 1.
    const sorted = spreads.slice().sort((a, b) => a - b);
    const p95Index = Math.ceil(0.95 * n) - 1;
    const percentile95 = sorted[Math.max(0, Math.min(p95Index, n - 1))]!;

    // Mean reversion probability: count of times spread crossed back through
    // the mean from a deviation, divided by total deviations from mean.
    let crossings = 0;
    let totalDeviations = 0;
    let prevAboveMean: boolean | null = null;

    for (const s of spreads) {
      const aboveMean = s > mean;
      const belowMean = s < mean;

      if (aboveMean || belowMean) {
        totalDeviations++;
        if (prevAboveMean !== null && aboveMean !== prevAboveMean) {
          // Crossed through mean (went from above to below or vice versa).
          crossings++;
        }
        prevAboveMean = aboveMean;
      }
      // If s === mean exactly, it's a crossing point but we don't change prevAboveMean.
    }

    const meanReversionProb =
      totalDeviations > 0
        ? Math.round((crossings / totalDeviations) * 10000) / 100
        : 0;

    const doc: ISpreadSummary = {
      symbol,
      observations: n,
      first_date: firstDate,
      last_date: lastDate,
      mean_spread: Math.round(mean * 10000) / 10000,
      max_spread: Math.round(maxSpread * 10000) / 10000,
      min_spread: Math.round(minSpread * 10000) / 10000,
      mean_deviation: Math.round(meanDeviation * 10000) / 10000,
      max_abs_spread: Math.round(maxAbs * 10000) / 10000,
      std_dev_spread: Math.round(stdDev * 10000) / 10000,
      percentile_95: Math.round(percentile95 * 10000) / 10000,
      mean_reversion_probability: meanReversionProb,
    };

    bulkOps.push({
      replaceOne: {
        filter: { symbol },
        replacement: doc,
        upsert: true,
      },
    });
  }

  await SpreadSummary.bulkWrite(bulkOps);

  // Remove symbols that no longer have spread_daily data.
  const activeSymbols = symbols;
  await SpreadSummary.deleteMany({ symbol: { $nin: activeSymbols } });

  console.log(
    `[EODCapture] Spread summary recomputed: ${symbols.length} symbols.`,
  );
}

// ============================================================================
//  Scheduler: checks at 15:35 IST for EOD capture and 16:00 IST for summary
// ============================================================================

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let lastComputedDay = "";

/**
 * Start the EOD scheduler. Checks every 60 seconds:
 *   - At 15:35-15:37 IST: triggers EOD data capture (closing data).
 *   - At 16:00-16:02 IST: triggers spread summary recomputation (ensures
 *     today's data is included).
 */
export function startEodScheduler(deps: EodSchedulerDeps): void {
  if (schedulerInterval) return; // Already started

  schedulerInterval = setInterval(() => {
    void (async () => {
      try {
        if (!isNseFnoDbEnabled()) return;

        const ist = istNow();
        const day = ist.getUTCDay();
        if (day === 0 || day === 6) return; // Weekend

        const hh = ist.getUTCHours();
        const mm = ist.getUTCMinutes();
        const today = istDayKey();

        // Trigger EOD capture at 15:35-15:37 IST (3-min window).
        if (hh === 15 && mm >= 35 && mm <= 37) {
          if (today !== lastCapturedDay) {
            lastCapturedDay = today;
            console.log("[EODCapture] Triggering EOD capture at 15:35 IST...");
            await captureEodData(deps);
          }
        }

        // Trigger summary recomputation at 16:00-16:02 IST (3-min window).
        if (hh === 16 && mm >= 0 && mm <= 2) {
          if (today !== lastComputedDay) {
            lastComputedDay = today;
            console.log("[EODCapture] Triggering spread summary recomputation at 16:00 IST...");
            await recomputeSpreadSummary();
          }
        }
      } catch (err) {
        console.error("[EODCapture] Scheduler error:", err);
      }
    })();
  }, 60_000);

  console.log("[EODCapture] EOD scheduler started (checking every 60s for 15:35 & 16:00 IST).");
}
