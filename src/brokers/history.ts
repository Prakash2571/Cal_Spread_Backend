/**
 * Broker-neutral historical candles.
 *
 * The existing chart endpoints (/api/history, /api/intraday, /api/minute,
 * /api/fivemin) called `kite.getHistorical*` directly. This module presents the SAME
 * signatures and the SAME return shapes, routed to the active broker, so those routes
 * — and therefore the frontend's response contracts — are unchanged. The UI does not
 * learn which broker produced a candle, which is the point.
 *
 * TWO REAL DIFFERENCES ARE HANDLED HERE
 *
 *  1. LAYOUT. Kite returns rows (one array per candle). Dhan returns COLUMNS
 *     (parallel arrays of open/high/low/close/volume/timestamp). Assuming Kite's
 *     shape for Dhan yields silently transposed data rather than an error, so the
 *     transposition is explicit and in one place.
 *
 *  2. RANGE LIMITS. Dhan bounds how much intraday history one request may cover, so
 *     long ranges are CHUNKED and stitched. Without chunking a multi-month minute
 *     request simply returns nothing useful.
 */

import type { HistoricalCandle, HistoricalPriority, Instrument, KiteClient } from "../kite.js";
import type { DhanClient } from "./dhan/client.js";
import type { DhanInstrumentStore } from "./dhan/instruments.js";
import type { BrokerId } from "./types.js";

/** Kite's `{ t, close }` minute series. */
export interface ClosePoint {
  t: string;
  close: number;
}

/** Kite's OI series point. */
export interface OiPoint {
  t: string;
  close: number;
  oi: number;
}

export interface HistoryProviderDeps {
  activeBroker: () => BrokerId;
  kite: KiteClient;
  dhan: DhanClient;
  dhanInstruments: DhanInstrumentStore;
}

/**
 * Maximum days per Dhan intraday request, by interval.
 *
 * Deliberately conservative. Requesting more than Dhan allows does not fail loudly —
 * it returns a truncated series — so the chunk sizes err small and the results are
 * stitched.
 */
const DHAN_INTRADAY_MAX_DAYS: Record<string, number> = {
  "1": 5,
  "5": 30,
  "15": 60,
  "25": 60,
  "60": 90,
};

/** Internal interval label → Dhan's minute string. `day` is not intraday. */
function dhanInterval(interval: string): string | null {
  switch (interval) {
    case "minute":
      return "1";
    case "3minute":
      return "5"; // Dhan has no 3-minute; 5 is the nearest supported bucket.
    case "5minute":
      return "5";
    case "15minute":
      return "15";
    case "30minute":
      return "25"; // nearest supported
    case "60minute":
    case "hour":
      return "60";
    default:
      return null;
  }
}

const ISO_DAY = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Format an epoch as the IST "YYYY-MM-DD HH:MM:SS" string Kite returns and the
 * frontend already parses. Keeping the exact textual shape is what makes this
 * substitution invisible to the UI.
 */
function istStamp(epochMs: number): string {
  const ist = new Date(epochMs + 5.5 * 60 * 60 * 1000);
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${ist.getUTCFullYear()}-${p(ist.getUTCMonth() + 1)}-${p(ist.getUTCDate())} ` +
    `${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())}:${p(ist.getUTCSeconds())}`
  );
}

/** Transpose Dhan's column-wise candles into rows, oldest first. */
export function dhanCandlesToRows(candles: {
  open?: number[];
  high?: number[];
  low?: number[];
  close?: number[];
  volume?: number[];
  timestamp?: number[];
  open_interest?: number[];
}): HistoricalCandle[] {
  const ts = candles.timestamp ?? [];
  const out: HistoricalCandle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const epochSec = ts[i];
    if (typeof epochSec !== "number" || !Number.isFinite(epochSec)) continue;
    out.push({
      date: istStamp(epochSec * 1000),
      open: numAt(candles.open, i),
      high: numAt(candles.high, i),
      low: numAt(candles.low, i),
      close: numAt(candles.close, i),
      volume: numAt(candles.volume, i),
      oi: numAt(candles.open_interest, i),
    });
  }
  // Oldest first, matching Kite's ordering.
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function numAt(arr: number[] | undefined, i: number): number {
  const v = arr?.[i];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Split [from, to] into chunks of at most `maxDays`. */
export function chunkDateRange(
  from: Date,
  to: Date,
  maxDays: number,
): { from: Date; to: Date }[] {
  const out: { from: Date; to: Date }[] = [];
  const dayMs = 24 * 60 * 60 * 1000;
  let cursor = from.getTime();
  const end = to.getTime();
  if (!(maxDays > 0) || end <= cursor) return [{ from, to }];
  while (cursor < end) {
    const next = Math.min(end, cursor + maxDays * dayMs);
    out.push({ from: new Date(cursor), to: new Date(next) });
    cursor = next;
  }
  return out.length > 0 ? out : [{ from, to }];
}

export class HistoryProvider {
  constructor(private deps: HistoryProviderDeps) {}

  private isDhan(): boolean {
    return this.deps.activeBroker() === "dhan";
  }

  /**
   * Resolve an internal token to what Dhan's charts API needs.
   *
   * `instrument` is Dhan's own classification string, required by the charts
   * endpoints. Returns null when the master has not loaded or the token is unknown,
   * and the caller then returns an empty series rather than inventing candles.
   */
  private dhanTarget(token: number): {
    securityId: string;
    segment: string;
    instrument: string;
  } | null {
    const inst = this.deps.dhanInstruments.get(token);
    if (inst) {
      return {
        securityId: String(inst.dhan_security_id),
        segment: inst.dhan_segment,
        instrument: dhanInstrumentClass(inst),
      };
    }
    const identity = this.deps.dhanInstruments.identify(token);
    if (!identity) return null;
    return {
      securityId: String(identity.securityId),
      segment: identity.segment,
      instrument: identity.segment === "NSE_FNO" ? "FUTIDX" : "EQUITY",
    };
  }

  /** Full OHLCV+OI candles. Same signature and shape as `kite.getHistoricalFull`. */
  async getHistoricalFull(
    token: number,
    from: string,
    to: string,
    interval = "day",
    prio: HistoricalPriority = "interactive",
  ): Promise<HistoricalCandle[]> {
    if (!this.isDhan()) {
      return this.deps.kite.getHistoricalFull(token, from, to, interval, prio);
    }
    return this.dhanCandles(token, from, to, interval);
  }

  /** `{ t, close }` series. Same signature and shape as `kite.getHistorical`. */
  async getHistorical(
    token: number,
    from: string,
    to: string,
    interval: string,
    prio: HistoricalPriority = "interactive",
  ): Promise<ClosePoint[]> {
    if (!this.isDhan()) {
      return this.deps.kite.getHistorical(token, from, to, interval, prio);
    }
    const rows = await this.dhanCandles(token, from, to, interval);
    return rows.map((c) => ({ t: c.date, close: c.close }));
  }

  /** Daily close + OI. Same shape as `kite.getHistoricalOi`. */
  async getHistoricalOi(
    token: number,
    from: string,
    to: string,
    prio: HistoricalPriority = "interactive",
  ): Promise<{ date: string; close: number; oi: number }[]> {
    if (!this.isDhan()) {
      return this.deps.kite.getHistoricalOi(token, from, to, prio);
    }
    const rows = await this.dhanCandles(token, from, to, "day");
    return rows.map((c) => ({ date: c.date, close: c.close, oi: c.oi }));
  }

  /** Minute-resolution close + OI. Same shape as `kite.getHistoricalOiSeries`. */
  async getHistoricalOiSeries(
    token: number,
    from: string,
    to: string,
    interval: string,
    prio: HistoricalPriority = "interactive",
  ): Promise<OiPoint[]> {
    if (!this.isDhan()) {
      return this.deps.kite.getHistoricalOiSeries(token, from, to, interval, prio);
    }
    const rows = await this.dhanCandles(token, from, to, interval);
    return rows.map((c) => ({ t: c.date, close: c.close, oi: c.oi }));
  }

  /**
   * Fetch Dhan candles for a range, chunking when the interval requires it.
   *
   * Failures are logged and the partial series returned rather than thrown: a chart
   * with a gap is far better than an endpoint that 500s, and these routes are all
   * read-only display paths.
   */
  private async dhanCandles(
    token: number,
    from: string,
    to: string,
    interval: string,
  ): Promise<HistoricalCandle[]> {
    await this.deps.dhanInstruments.load().catch(() => undefined);
    const target = this.dhanTarget(token);
    if (!target) return [];

    const fromDate = new Date(from.slice(0, 10));
    const toDate = new Date(to.slice(0, 10));
    const minutes = dhanInterval(interval);

    // Daily candles: one request, no chunking needed.
    if (minutes === null) {
      try {
        const res = await this.deps.dhan.historicalCandles({
          securityId: target.securityId,
          exchangeSegment: target.segment as never,
          instrument: target.instrument,
          oi: true,
          fromDate: ISO_DAY(fromDate),
          toDate: ISO_DAY(toDate),
        });
        return dhanCandlesToRows(res);
      } catch (err) {
        console.warn(`[Dhan] daily candles failed for token ${token}:`, err);
        return [];
      }
    }

    const maxDays = DHAN_INTRADAY_MAX_DAYS[minutes] ?? 5;
    const chunks = chunkDateRange(fromDate, toDate, maxDays);
    const merged: HistoricalCandle[] = [];
    for (const chunk of chunks) {
      try {
        const res = await this.deps.dhan.intradayCandles({
          securityId: target.securityId,
          exchangeSegment: target.segment as never,
          instrument: target.instrument,
          interval: minutes,
          oi: true,
          fromDate: ISO_DAY(chunk.from),
          toDate: ISO_DAY(chunk.to),
        });
        merged.push(...dhanCandlesToRows(res));
      } catch (err) {
        console.warn(
          `[Dhan] intraday candles failed for token ${token} (${ISO_DAY(chunk.from)}→${ISO_DAY(chunk.to)}):`,
          err,
        );
      }
    }
    // Overlapping chunk boundaries can duplicate a candle; de-duplicate by timestamp.
    const seen = new Set<string>();
    return merged
      .filter((c) => (seen.has(c.date) ? false : (seen.add(c.date), true)))
      .sort((a, b) => a.date.localeCompare(b.date));
  }
}

/** Dhan's `instrument` classification for the charts API. */
function dhanInstrumentClass(inst: Instrument & { dhan_segment?: string }): string {
  const type = inst.instrument_type;
  const isIndexUnderlying = inst.segment === "INDICES" || inst.dhan_segment === "IDX_I";
  if (type === "CE" || type === "PE") return isIndexUnderlying ? "OPTIDX" : "OPTSTK";
  if (type === "FUT") return isIndexUnderlying ? "FUTIDX" : "FUTSTK";
  if (type === "INDEX") return "INDEX";
  return "EQUITY";
}
