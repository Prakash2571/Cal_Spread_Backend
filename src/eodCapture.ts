import {
  isNseFnoDbEnabled,
  StockFuture,
  SpreadDaily,
  SpreadSummary,
} from "./db.js";
import type { IStockFuture } from "./db.js";
import type { KiteClient, Instrument } from "./kite.js";

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
  let insertCount = 0;

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

      try {
        await StockFuture.updateOne(
          {
            symbol: doc.symbol,
            trading_date: doc.trading_date,
            expiry: doc.expiry,
          },
          { $set: doc },
          { upsert: true },
        );
        insertCount++;
      } catch (err) {
        console.error(
          `[EODCapture] Failed to upsert ${item.symbol} expiry ${f.expiry}:`,
          err,
        );
      }
    }
  }

  console.log(
    `[EODCapture] Captured ${insertCount} stock_futures records for ${today}.`,
  );

  // After capturing, compute spreads for today and check if we need monthly summary.
  await computeSpreads([today]);
  await checkAndRecomputeMonthly();
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
  let totalInserted = 0;

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

          try {
            await StockFuture.updateOne(
              {
                symbol: doc.symbol,
                trading_date: doc.trading_date,
                expiry: doc.expiry,
              },
              { $set: doc },
              { upsert: true },
            );
            totalInserted++;
          } catch {
            // Duplicate key errors are fine (already exists)
          }
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

  console.log(`[EODCapture] Backfill complete: ${totalInserted} records upserted.`);

  // Compute spreads for all backfilled days.
  if (missingDays.length > 0) {
    await computeSpreads(missingDays);
    await checkAndRecomputeMonthly();
  }
}

// ============================================================================
//  Spread Computation
// ============================================================================

/**
 * For each (symbol, trading_date) in the given dates, sort futures by expiry
 * ascending, take the two nearest, compute spread = mid_close - near_close,
 * and upsert into spread_daily.
 */
export async function computeSpreads(dates: string[]): Promise<void> {
  if (!isNseFnoDbEnabled()) return;
  if (dates.length === 0) return;

  const dateObjects = dates.map((d) => new Date(d + "T00:00:00.000Z"));

  // Fetch all stock_futures records for the given dates.
  const records = await StockFuture.find({
    trading_date: { $in: dateObjects },
  }).lean();

  // Group by (symbol, trading_date).
  const grouped = new Map<string, typeof records>();
  for (const rec of records) {
    const key = `${rec.symbol}_${rec.trading_date.toISOString().slice(0, 10)}`;
    const arr = grouped.get(key) ?? [];
    arr.push(rec);
    grouped.set(key, arr);
  }

  let upsertCount = 0;

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

    try {
      await SpreadDaily.updateOne(
        {
          symbol: near.symbol,
          trading_date: near.trading_date,
        },
        {
          $set: {
            symbol: near.symbol,
            trading_date: near.trading_date,
            near_expiry: near.expiry,
            mid_expiry: mid.expiry,
            near_close: near.close,
            mid_close: mid.close,
            spread,
          },
        },
        { upsert: true },
      );
      upsertCount++;
    } catch (err) {
      console.error(
        `[EODCapture] Failed to upsert spread for ${near.symbol}:`,
        err,
      );
    }
  }

  console.log(`[EODCapture] Computed ${upsertCount} spread_daily records.`);
}

// ============================================================================
//  Monthly Summary Recalculation
// ============================================================================

/**
 * Recompute the entire spread_summary collection from spread_daily.
 * Groups all spread_daily records by symbol and computes:
 *   observations, first_date, last_date, mean_spread, max_spread, min_spread,
 *   mean_deviation (avg of |spread - mean|), max_abs_spread (max of |spread|).
 */
export async function recomputeSpreadSummary(): Promise<void> {
  if (!isNseFnoDbEnabled()) return;

  console.log("[EODCapture] Recomputing spread_summary...");

  // Use MongoDB aggregation pipeline (mirrors the Python script logic).
  const pipeline = [
    {
      $group: {
        _id: "$symbol",
        spreads: { $push: "$spread" },
        mean_spread: { $avg: "$spread" },
        max_spread: { $max: "$spread" },
        min_spread: { $min: "$spread" },
        observations: { $sum: 1 },
        first_date: { $min: "$trading_date" },
        last_date: { $max: "$trading_date" },
      },
    },
    {
      $addFields: {
        mean_deviation: {
          $avg: {
            $map: {
              input: "$spreads",
              as: "s",
              in: { $abs: { $subtract: ["$$s", "$mean_spread"] } },
            },
          },
        },
        max_abs_spread: {
          $max: {
            $map: {
              input: "$spreads",
              as: "s",
              in: { $abs: "$$s" },
            },
          },
        },
      },
    },
    {
      $project: {
        _id: 0,
        symbol: "$_id",
        observations: 1,
        first_date: 1,
        last_date: 1,
        mean_spread: { $round: ["$mean_spread", 4] },
        max_spread: { $round: ["$max_spread", 4] },
        min_spread: { $round: ["$min_spread", 4] },
        mean_deviation: { $round: ["$mean_deviation", 4] },
        max_abs_spread: { $round: ["$max_abs_spread", 4] },
      },
    },
  ];

  const results = await SpreadDaily.aggregate(pipeline);

  // Replace the entire spread_summary collection.
  await SpreadSummary.deleteMany({});

  if (results.length > 0) {
    await SpreadSummary.insertMany(results);
  }

  console.log(
    `[EODCapture] Spread summary recomputed: ${results.length} symbols.`,
  );
}

/**
 * Check if we should recompute the monthly summary.
 * Triggers if the latest spread_summary last_date is from a previous month
 * compared to the latest spread_daily trading_date.
 */
async function checkAndRecomputeMonthly(): Promise<void> {
  if (!isNseFnoDbEnabled()) return;

  // Get the latest date in spread_daily.
  const latestDaily = await SpreadDaily.findOne()
    .sort({ trading_date: -1 })
    .lean();
  if (!latestDaily) return;

  // Get any existing summary record to check the last update.
  const existingSummary = await SpreadSummary.findOne()
    .sort({ last_date: -1 })
    .lean();

  const latestDailyMonth = latestDaily.trading_date.toISOString().slice(0, 7);

  if (!existingSummary) {
    // No summary exists at all, compute it.
    await recomputeSpreadSummary();
    return;
  }

  const summaryMonth = existingSummary.last_date.toISOString().slice(0, 7);

  // Recompute if we are in a new month or if the summary is outdated.
  if (latestDailyMonth !== summaryMonth) {
    await recomputeSpreadSummary();
  }
}

// ============================================================================
//  Scheduler: checks at 15:35 IST and triggers EOD capture
// ============================================================================

let schedulerInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the EOD capture scheduler. Checks every 60 seconds, and at 15:35 IST
 * on weekdays triggers the EOD capture (5 minutes after market close at 15:30).
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

        // Trigger at 15:35-15:37 IST (3-min window).
        if (hh === 15 && mm >= 35 && mm <= 37) {
          const today = istDayKey();
          if (today === lastCapturedDay) return; // Already captured today
          lastCapturedDay = today;

          console.log("[EODCapture] Triggering EOD capture at 15:35 IST...");
          await captureEodData(deps);
        }
      } catch (err) {
        console.error("[EODCapture] Scheduler error:", err);
      }
    })();
  }, 60_000);

  console.log("[EODCapture] EOD scheduler started (checking every 60s for 15:35 IST).");
}
