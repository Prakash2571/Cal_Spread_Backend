import { HourlyPrice } from "./db.js";
import type { IHourlyPrice } from "./db.js";
import type { KiteClient } from "./kite.js";
import type { Instrument } from "./kite.js";
import type { Tick } from "./ticker.js";

// ============================================================================
//  Types for the board structure passed in from index.ts
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

// ============================================================================
//  In-memory cache (drip-write buffer)
// ============================================================================

let pendingWrites: IHourlyPrice[] = [];
let draining = false;

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

/** HH:MM in IST (top of current hour, e.g. "10:00"). */
function istHourKey(): string {
  const ist = istNow();
  const hh = String(ist.getUTCHours()).padStart(2, "0");
  return `${hh}:00`;
}

/** The "month" field from a date string: YYYY-MM. */
function monthFromDate(date: string): string {
  return date.slice(0, 7);
}

/** True during NSE market hours: Mon-Fri, 09:15-15:30 IST. */
function isMarketOpen(): boolean {
  const ist = istNow();
  const day = ist.getUTCDay(); // 0 Sun ... 6 Sat
  if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

/** Market slots we capture: 10:00 through 15:30.
 *  NSE market hours are 9:15 AM to 3:30 PM IST.
 *  The first full-hour boundary after market open (9:15) is 10:00, and the
 *  last capture is at market close (15:30).
 */
const MARKET_HOURS = ["10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "15:30"];

/** Small delay utility. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Check if a date (YYYY-MM-DD) is a weekday. */
function isWeekday(dateStr: string): boolean {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = d.getUTCDay();
  return day !== 0 && day !== 6;
}

// ============================================================================
//  Core: capture hourly prices from live tick feed
// ============================================================================

/**
 * For each FNO stock on the board that has at least 2 futures, grab the last
 * price of futures[0] (current month) and futures[1] (mid month) from the tick
 * getter. If no live ticks are available (e.g. no SSE clients connected), falls
 * back to a REST LTP call via the Kite quote API. Compute spread = mid - current.
 * Push into the in-memory cache.
 */
export async function captureHourlyPrices(
  board: BoardItem[],
  getLatestTick: (token: number) => Tick | undefined,
  kite?: KiteClient,
  allInstruments?: Instrument[],
  slot?: string,
): Promise<void> {
  const date = istDayKey();
  const time = slot ?? istHourKey();
  const month = monthFromDate(date);

  // First pass: try to get prices from live ticks.
  interface PendingItem {
    item: BoardItem;
    currentToken: number;
    midToken: number;
    farToken: number | null;
  }
  const needsRestFallback: PendingItem[] = [];

  for (const item of board) {
    if (item.futures.length < 2) continue;

    const currentFut = item.futures[0]!;
    const midFut = item.futures[1]!;
    const farFut = item.futures.length >= 3 ? item.futures[2]! : null;

    const currentTick = getLatestTick(currentFut.token);
    const midTick = getLatestTick(midFut.token);
    const farTick = farFut ? getLatestTick(farFut.token) : undefined;

    const currentPrice = currentTick?.last_price;
    const midPrice = midTick?.last_price;
    const farPrice = farTick?.last_price ?? null;

    if (currentPrice && currentPrice > 0 && midPrice && midPrice > 0) {
      const spread = midPrice - currentPrice;
      pendingWrites.push({
        symbol: item.symbol,
        date,
        time,
        month,
        current_month_close: currentPrice,
        mid_month_close: midPrice,
        far_month_close: farPrice && farPrice > 0 ? farPrice : null,
        spread,
      });
    } else {
      // No live tick available; queue for REST fallback.
      needsRestFallback.push({
        item,
        currentToken: currentFut.token,
        midToken: midFut.token,
        farToken: farFut ? farFut.token : null,
      });
    }
  }

  // REST fallback: fetch LTP from Kite quote API for symbols with no live tick.
  if (needsRestFallback.length > 0 && kite && kite.hasSession() && allInstruments) {
    try {
      // Build a token -> NFO identifier map from the instruments list.
      const tokenToIdentifier = new Map<number, string>();
      for (const inst of allInstruments) {
        if (inst.exchange === "NFO" && inst.instrument_type === "FUT") {
          tokenToIdentifier.set(
            inst.instrument_token,
            `NFO:${inst.tradingsymbol}`,
          );
        }
      }

      // Collect all identifiers we need to fetch.
      const identifiersNeeded: string[] = [];
      for (const pending of needsRestFallback) {
        const curId = tokenToIdentifier.get(pending.currentToken);
        const midId = tokenToIdentifier.get(pending.midToken);
        const farId = pending.farToken ? tokenToIdentifier.get(pending.farToken) : undefined;
        if (curId) identifiersNeeded.push(curId);
        if (midId) identifiersNeeded.push(midId);
        if (farId) identifiersNeeded.push(farId);
      }

      if (identifiersNeeded.length > 0) {
        // Fetch OHLC quotes (includes last_price) from the REST API.
        const quotes = await kite.getQuoteOhlc(identifiersNeeded);

        // Build a token -> last_price map from the REST response.
        const restPrices = new Map<number, number>();
        for (const q of quotes) {
          if (q.last_price > 0) {
            restPrices.set(q.instrument_token, q.last_price);
          }
        }

        // Second pass: use REST prices for the symbols that had no live tick.
        for (const pending of needsRestFallback) {
          const currentPrice = restPrices.get(pending.currentToken);
          const midPrice = restPrices.get(pending.midToken);
          const farPrice = pending.farToken ? restPrices.get(pending.farToken) : undefined;

          if (currentPrice && currentPrice > 0 && midPrice && midPrice > 0) {
            const spread = midPrice - currentPrice;
            pendingWrites.push({
              symbol: pending.item.symbol,
              date,
              time,
              month,
              current_month_close: currentPrice,
              mid_month_close: midPrice,
              far_month_close: farPrice && farPrice > 0 ? farPrice : null,
              spread,
            });
          }
        }
      }
    } catch (err) {
      console.error("[HourlyCapture] REST fallback failed:", err);
    }
  }

  console.log(
    `[HourlyCapture] Captured ${pendingWrites.length} records at ${date} ${time}`,
  );
}

// ============================================================================
//  Drain cache to DB one at a time (drip-write)
// ============================================================================

/**
 * Takes items from the pending cache one at a time and upserts each to MongoDB,
 * with a 100ms delay between writes to avoid overloading the database.
 * Uses a peek-then-shift approach: only removes a record from the queue after
 * a successful write. On failure, breaks the loop and leaves the record for
 * the next drain cycle to retry.
 */
export async function drainCacheToDB(): Promise<void> {
  if (draining) return;
  draining = true;

  try {
    while (pendingWrites.length > 0) {
      const doc = pendingWrites[0]!;
      try {
        await HourlyPrice.updateOne(
          { symbol: doc.symbol, date: doc.date, time: doc.time },
          { $set: doc },
          { upsert: true },
        );
        // Only remove from the queue after a successful write.
        pendingWrites.shift();
      } catch (err) {
        // Leave the record in the queue for the next drain cycle.
        console.error(
          `[HourlyCapture] Failed to upsert ${doc.symbol} ${doc.date} ${doc.time}:`,
          err,
        );
        break;
      }
      await delay(100);
    }
  } finally {
    draining = false;
  }
}

// ============================================================================
//  Scheduler: fires hourly during market hours
// ============================================================================

export interface HourlySchedulerDeps {
  getBoard: () => Promise<BoardItem[]>;
  getLatestTick: (token: number) => Tick | undefined;
  kite: KiteClient;
  getAllInstruments: () => Promise<Instrument[]>;
}

let lastCapturedSlot = "";

/**
 * Given the current IST time, determine which MARKET_HOURS slot (if any)
 * we are within a 2-minute capture window of.
 * - For ":00" slots: fires when minutes are 0-2.
 * - For "15:30": fires when hour is 15 and minutes are 30-32.
 * Returns the matched slot string (e.g. "10:00" or "15:30") or null.
 */
function currentCaptureSlot(ist: Date): string | null {
  const hh = ist.getUTCHours();
  const mm = ist.getUTCMinutes();

  for (const slot of MARKET_HOURS) {
    const slotHour = parseInt(slot.slice(0, 2), 10);
    const slotMin = parseInt(slot.slice(3, 5), 10);

    if (hh === slotHour && mm >= slotMin && mm <= slotMin + 2) {
      return slot;
    }
  }
  return null;
}

/**
 * Sets up a setInterval (every 60s). On each tick, checks if we are within
 * a capture window of any MARKET_HOURS slot. If so, captures prices and
 * drains the cache.
 */
export function startHourlyScheduler(deps: HourlySchedulerDeps): void {
  const { getBoard, getLatestTick, kite, getAllInstruments } = deps;

  setInterval(() => {
    void (async () => {
      try {
        if (!isMarketOpen()) return;

        const ist = istNow();
        const slot = currentCaptureSlot(ist);
        if (!slot) return;

        const slotKey = `${istDayKey()}_${slot}`;
        if (slotKey === lastCapturedSlot) return;
        lastCapturedSlot = slotKey;

        const board = await getBoard();
        const instruments = await getAllInstruments();
        await captureHourlyPrices(board, getLatestTick, kite, instruments, slot);
        await drainCacheToDB();
      } catch (err) {
        console.error("[HourlyCapture] Scheduler error:", err);
      }
    })();
  }, 60_000);

  console.log("[HourlyCapture] Hourly scheduler started (checking every 60s).");
}

// ============================================================================
//  Backfill missed hours on startup
// ============================================================================

/**
 * On startup, for each FNO stock: find the latest HourlyPrice record, determine
 * which hourly slots are missing since then (during market hours on weekdays),
 * and backfill via the Kite historical API (60-minute candles).
 */
export async function backfillMissedHours(deps: HourlySchedulerDeps): Promise<void> {
  const { getBoard, kite, getAllInstruments } = deps;

  if (!kite.hasSession()) {
    console.log("[HourlyCapture] No Kite session available. Skipping backfill.");
    return;
  }

  let board: BoardItem[];
  try {
    board = await getBoard();
  } catch (err) {
    console.error("[HourlyCapture] Could not get board for backfill:", err);
    return;
  }

  const todayStr = istDayKey();
  const nowHour = istHourKey();

  for (const item of board) {
    if (item.futures.length < 2) continue;

    const currentFut = item.futures[0]!;
    const midFut = item.futures[1]!;
    const farFut = item.futures.length >= 3 ? item.futures[2]! : null;

    try {
      // Find the latest stored record for this symbol.
      const lastRecord = await HourlyPrice.findOne({ symbol: item.symbol })
        .sort({ date: -1, time: -1 })
        .lean();

      // Determine the starting point for backfill.
      let startDate: string;
      let startTime: string;

      if (lastRecord) {
        startDate = lastRecord.date;
        startTime = lastRecord.time;
      } else {
        // No records at all; backfill from 5 trading days ago.
        const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
        startDate = fiveDaysAgo.toISOString().slice(0, 10);
        startTime = "09:00";
      }

      // Build list of missing slots from startDate/startTime to now.
      const missingSlots = getMissingSlots(startDate, startTime, todayStr, nowHour);
      if (missingSlots.length === 0) continue;

      // Determine the date range for historical API calls.
      const fromDate = missingSlots[0]!.date;
      const toDate = missingSlots[missingSlots.length - 1]!.date;

      // Fetch 60-minute candles for both legs.
      const currentCandles = await kite.getHistorical(
        currentFut.token,
        fromDate,
        toDate,
        "60minute",
      );
      await delay(300); // rate limit
      const midCandles = await kite.getHistorical(
        midFut.token,
        fromDate,
        toDate,
        "60minute",
      );
      await delay(300); // rate limit

      // Fetch far month candles if available.
      let farCandles: { t: string; close: number }[] = [];
      if (farFut) {
        farCandles = await kite.getHistorical(
          farFut.token,
          fromDate,
          toDate,
          "60minute",
        );
        await delay(300); // rate limit
      }

      // Index candles by "YYYY-MM-DD_HH:00" for quick lookup.
      const currentBySlot = new Map<string, number>();
      for (const c of currentCandles) {
        const slotKey = candleToSlotKey(c.t);
        if (slotKey) currentBySlot.set(slotKey, c.close);
      }

      const midBySlot = new Map<string, number>();
      for (const c of midCandles) {
        const slotKey = candleToSlotKey(c.t);
        if (slotKey) midBySlot.set(slotKey, c.close);
      }

      const farBySlot = new Map<string, number>();
      for (const c of farCandles) {
        const slotKey = candleToSlotKey(c.t);
        if (slotKey) farBySlot.set(slotKey, c.close);
      }

      // Match missing slots to candle data.
      for (const slot of missingSlots) {
        const key = `${slot.date}_${slot.time}`;
        const currentPrice = currentBySlot.get(key);
        const midPrice = midBySlot.get(key);
        const farPrice = farBySlot.get(key);

        if (currentPrice && currentPrice > 0 && midPrice && midPrice > 0) {
          pendingWrites.push({
            symbol: item.symbol,
            date: slot.date,
            time: slot.time,
            month: monthFromDate(slot.date),
            current_month_close: currentPrice,
            mid_month_close: midPrice,
            far_month_close: farPrice && farPrice > 0 ? farPrice : null,
            spread: midPrice - currentPrice,
          });
        }
      }
    } catch (err) {
      // Skip this symbol on error (e.g. expired token, rate limit).
      console.error(
        `[HourlyCapture] Backfill failed for ${item.symbol}:`,
        err,
      );
      await delay(500);
    }
  }

  if (pendingWrites.length > 0) {
    console.log(
      `[HourlyCapture] Backfill queued ${pendingWrites.length} records. Draining...`,
    );
    await drainCacheToDB();
  } else {
    console.log("[HourlyCapture] Backfill: no missing records found.");
  }
}

// ============================================================================
//  Internal helpers for backfill
// ============================================================================

interface TimeSlot {
  date: string; // YYYY-MM-DD
  time: string; // HH:00
}

/**
 * Build the list of market-hour slots between (startDate, startTime) exclusive
 * and (endDate, endTime) inclusive that are missing.
 */
function getMissingSlots(
  startDate: string,
  startTime: string,
  endDate: string,
  endTime: string,
): TimeSlot[] {
  const slots: TimeSlot[] = [];

  // Iterate day by day from startDate to endDate.
  const current = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");

  while (current <= end) {
    const dateStr = current.toISOString().slice(0, 10);

    if (isWeekday(dateStr)) {
      for (const hour of MARKET_HOURS) {
        // Skip slots on or before the start point.
        if (dateStr === startDate && hour <= startTime) continue;
        // Skip slots after the current time on the end day.
        if (dateStr === endDate && hour > endTime) continue;

        slots.push({ date: dateStr, time: hour });
      }
    }

    current.setUTCDate(current.getUTCDate() + 1);
  }

  return slots;
}

/**
 * Convert a Kite candle timestamp to a MARKET_HOURS slot key.
 *
 * Kite 60-minute candles for NSE are timestamped at the candle START time,
 * which falls at :15 past the hour (e.g. "2025-07-08 09:15:00" covers
 * 09:15-10:15, "2025-07-08 10:15:00" covers 10:15-11:15, etc.).
 *
 * Our MARKET_HOURS slots represent capture points (10:00, 11:00, ..., 15:00,
 * 15:30). The top-of-hour slots correspond to candle END times rounded down.
 * So we map: "09:15" -> "10:00", "10:15" -> "11:00", ..., "14:15" -> "15:00".
 *
 * Additionally, Kite produces a shorter candle from 15:15-15:30 (market close).
 * The "15:15" candle maps to our "15:30" slot since its close price is the
 * market closing price at 15:30.
 *
 * Only return a slot key if the result is a valid MARKET_HOURS entry.
 */
function candleToSlotKey(timestamp: string): string | null {
  // The Kite API returns timestamps in IST.
  // Format: "2025-07-08T09:15:00+0530" or "2025-07-08 09:15:00"
  const clean = timestamp.replace("T", " ");
  const datePart = clean.slice(0, 10);
  const timePart = clean.slice(11, 16); // "HH:MM"

  if (!datePart || !timePart) return null;

  const hh = parseInt(timePart.slice(0, 2), 10);
  const mm = parseInt(timePart.slice(3, 5), 10);

  // Kite 60-min candles start at :15 past the hour. The candle ending at
  // the next top-of-hour is the slot we want.
  // e.g. candle starting at 09:15 ends at 10:15 -> slot "10:00"
  //      candle starting at 14:15 ends at 15:15 -> slot "15:00"
  // Special case: candle starting at 15:15 ends at 15:30 -> slot "15:30"
  if (mm === 15) {
    // For the 15:15 candle, it covers 15:15-15:30 (market close).
    if (hh === 15) {
      return `${datePart}_15:30`;
    }
    const slotHour = hh + 1;
    const slotKey = `${String(slotHour).padStart(2, "0")}:00`;
    if (MARKET_HOURS.includes(slotKey)) {
      return `${datePart}_${slotKey}`;
    }
  }

  // Fallback: for candles starting on the hour (e.g. "10:00:00"), map to
  // the next hour as the end-of-candle slot.
  if (mm === 0) {
    const slotHour = hh + 1;
    const slotKey = `${String(slotHour).padStart(2, "0")}:00`;
    if (MARKET_HOURS.includes(slotKey)) {
      return `${datePart}_${slotKey}`;
    }
    // Also check if the hour itself is a valid slot (direct match).
    const directKey = `${String(hh).padStart(2, "0")}:00`;
    if (MARKET_HOURS.includes(directKey)) {
      return `${datePart}_${directKey}`;
    }
  }

  return null;
}
