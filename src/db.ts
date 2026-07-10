import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI ?? "";
const NSE_FNO_ARCHIVE_URI = process.env.NSE_FNO_ARCHIVE_URI ?? "";
const NSE_FNO_CURRENT_URI = process.env.NSE_FNO_CURRENT_URI ?? "";
const NSE_FNO_SPREAD_URI = process.env.NSE_FNO_SPREAD_URI ?? "";

// ============================================================================
//  Three separate Mongoose connections for the split nse_fno databases
// ============================================================================

/** Read-only connection for historical stock_futures (data up to Aug 31, 2025). */
export const archiveConnection = NSE_FNO_ARCHIVE_URI
  ? mongoose.createConnection(NSE_FNO_ARCHIVE_URI)
  : null;

/** Read-write connection for current stock_futures (data from Jan 1, 2026 onwards). */
export const currentConnection = NSE_FNO_CURRENT_URI
  ? mongoose.createConnection(NSE_FNO_CURRENT_URI)
  : null;

/** Read-write connection for spread_daily and spread_summary. */
export const spreadConnection = NSE_FNO_SPREAD_URI
  ? mongoose.createConnection(NSE_FNO_SPREAD_URI)
  : null;

/** One leg of a calendar-spread trade. */
export interface TradeLeg {
  token: number;
  expiry: string; // ISO YYYY-MM-DD
  entry: number; // price captured at trade time
}

/** A calendar-spread trade (buy the discount leg, sell the premium leg). */
export interface ITrade {
  symbol: string;
  name: string;
  is_index: boolean;
  lot_size: number;
  buy: TradeLeg;
  sell: TradeLeg;
  status: "open" | "closed";
  opened_at: Date;
  closed_at: Date | null;
  close_pnl: number | null;
  buy_close: number | null;
  sell_close: number | null;
  margin: number | null; // net basket margin (₹) captured at trade time
}

/** A plain trade record (lean / toObject) including the Mongo _id. */
export interface TradeRecord extends ITrade {
  _id: mongoose.Types.ObjectId;
}

const legSchema = new mongoose.Schema<TradeLeg>(
  {
    token: { type: Number, required: true },
    expiry: { type: String, required: true },
    entry: { type: Number, required: true },
  },
  { _id: false },
);

const tradeSchema = new mongoose.Schema<ITrade>({
  symbol: { type: String, required: true, index: true },
  name: { type: String, default: "" },
  is_index: { type: Boolean, default: false },
  lot_size: { type: Number, required: true },
  buy: { type: legSchema, required: true },
  sell: { type: legSchema, required: true },
  status: {
    type: String,
    enum: ["open", "closed"],
    default: "open",
    index: true,
  },
  opened_at: { type: Date, default: () => new Date() },
  closed_at: { type: Date, default: null },
  close_pnl: { type: Number, default: null },
  buy_close: { type: Number, default: null },
  sell_close: { type: Number, default: null },
  margin: { type: Number, default: null },
});

/** The Trade model (collection: "trades"). */
export const Trade = mongoose.model<ITrade>("Trade", tradeSchema);

/**
 * Connect to MongoDB using the connection string. The database is taken from
 * the connection string itself (no separate DB-name config). No-op if unset.
 */
export async function initDb(): Promise<void> {
  if (!MONGODB_URI) {
    console.warn(
      "MONGODB_URI is not set — trade persistence is DISABLED. Set it in .env to enable trades.",
    );
    return;
  }
  try {
    await mongoose.connect(MONGODB_URI);
    console.log(
      `Connected to MongoDB via Mongoose (database "${mongoose.connection.name}").`,
    );
  } catch (err) {
    console.error("Failed to connect to MongoDB:", err);
  }
}

/**
 * Connect to all three nse_fno MongoDB databases (archive, current, spread).
 * No-op for any connection whose env var is unset.
 */
export async function initNseFnoConnections(): Promise<void> {
  interface NamedTask {
    name: string;
    promise: Promise<void>;
  }

  const tasks: NamedTask[] = [];

  if (archiveConnection) {
    tasks.push({
      name: "archive (NSE_FNO_ARCHIVE_URI)",
      promise: archiveConnection.asPromise().then(() => {
        console.log(
          `Connected to archive MongoDB (database "${archiveConnection!.name}") — historical stock_futures.`,
        );
      }),
    });
  } else {
    console.warn(
      "NSE_FNO_ARCHIVE_URI is not set — archive (historical stock_futures) is DISABLED.",
    );
  }

  if (currentConnection) {
    tasks.push({
      name: "current (NSE_FNO_CURRENT_URI)",
      promise: currentConnection.asPromise().then(() => {
        console.log(
          `Connected to current MongoDB (database "${currentConnection!.name}") — current stock_futures.`,
        );
      }),
    });
  } else {
    console.warn(
      "NSE_FNO_CURRENT_URI is not set — current stock_futures writes are DISABLED.",
    );
  }

  if (spreadConnection) {
    tasks.push({
      name: "spread (NSE_FNO_SPREAD_URI)",
      promise: spreadConnection.asPromise().then(() => {
        console.log(
          `Connected to spread MongoDB (database "${spreadConnection!.name}") — spread_daily & spread_summary.`,
        );
      }),
    });
  } else {
    console.warn(
      "NSE_FNO_SPREAD_URI is not set — spread data is DISABLED.",
    );
  }

  const results = await Promise.allSettled(tasks.map((t) => t.promise));

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === "rejected") {
      console.error(
        `Failed to connect to ${tasks[i]!.name}:`,
        result.reason,
      );
    }
  }
}

/** True once the current (write) and spread connections are active. */
export function isNseFnoDbEnabled(): boolean {
  const currentReady =
    currentConnection !== null && currentConnection.readyState === 1;
  const spreadReady =
    spreadConnection !== null && spreadConnection.readyState === 1;
  return currentReady && spreadReady;
}

/** True once the archive connection is active. */
export function isArchiveDbEnabled(): boolean {
  return archiveConnection !== null && archiveConnection.readyState === 1;
}

/** True once Mongoose has an active connection. */
export function isDbEnabled(): boolean {
  return mongoose.connection.readyState === 1;
}

/** Validate a string as a Mongo ObjectId. */
export function isValidId(id: string): boolean {
  return mongoose.isValidObjectId(id);
}

// ============================================================================
//  HourlyPrice — stores hourly closing prices per FNO stock (spread tracking).
// ============================================================================

/** One hourly snapshot of current vs mid month futures prices. */
export interface IHourlyPrice {
  symbol: string;
  date: string; // YYYY-MM-DD (IST)
  time: string; // HH:MM (IST, top of hour e.g. "10:00")
  month: string; // e.g. "2025-07"
  current_month_close: number;
  mid_month_close: number;
  far_month_close?: number | null;
  spread: number; // mid_month_close - current_month_close
}

const hourlyPriceSchema = new mongoose.Schema<IHourlyPrice>({
  symbol: { type: String, required: true },
  date: { type: String, required: true },
  time: { type: String, required: true },
  month: { type: String, required: true },
  current_month_close: { type: Number, required: true },
  mid_month_close: { type: Number, required: true },
  far_month_close: { type: Number, default: null },
  spread: { type: Number, required: true },
});

hourlyPriceSchema.index({ symbol: 1, date: 1, time: 1 }, { unique: true });

/** The HourlyPrice model (collection: "hourlyprices"). */
export const HourlyPrice = mongoose.model<IHourlyPrice>(
  "HourlyPrice",
  hourlyPriceSchema,
);

// ============================================================================
//  nse_fno models — registered on the separate connections
// ============================================================================

/** A stock futures document matching the existing MongoDB schema. */
export interface IStockFuture {
  trading_date: Date;
  symbol: string;
  instrument: string;
  expiry: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  settle_price: number;
  contracts: number;
  value_lakh: number;
  open_interest: number;
  change_in_oi: number;
}

const stockFutureSchema = new mongoose.Schema<IStockFuture>(
  {
    trading_date: { type: Date, required: true },
    symbol: { type: String, required: true },
    instrument: { type: String, default: "FUTSTK" },
    expiry: { type: Date, required: true },
    open: { type: Number, required: true },
    high: { type: Number, required: true },
    low: { type: Number, required: true },
    close: { type: Number, required: true },
    settle_price: { type: Number, default: 0 },
    contracts: { type: Number, default: 0 },
    value_lakh: { type: Number, default: 0 },
    open_interest: { type: Number, default: 0 },
    change_in_oi: { type: Number, default: 0 },
  },
  { collection: "stock_futures" },
);

stockFutureSchema.index(
  { symbol: 1, trading_date: 1, expiry: 1 },
  { unique: true },
);

/** A daily calendar spread record. */
export interface ISpreadDaily {
  symbol: string;
  trading_date: Date;
  near_expiry: Date;
  mid_expiry: Date;
  near_close: number;
  mid_close: number;
  spread: number;
}

const spreadDailySchema = new mongoose.Schema<ISpreadDaily>(
  {
    symbol: { type: String, required: true },
    trading_date: { type: Date, required: true },
    near_expiry: { type: Date, required: true },
    mid_expiry: { type: Date, required: true },
    near_close: { type: Number, required: true },
    mid_close: { type: Number, required: true },
    spread: { type: Number, required: true },
  },
  { collection: "spread_daily" },
);

spreadDailySchema.index({ symbol: 1, trading_date: 1 }, { unique: true });

/** Per-symbol calendar spread summary statistics. */
export interface ISpreadSummary {
  symbol: string;
  observations: number;
  first_date: Date;
  last_date: Date;
  mean_spread: number;
  max_spread: number;
  min_spread: number;
  mean_deviation: number;
  max_abs_spread: number;
  std_dev_spread: number;
  percentile_95: number;
  mean_reversion_probability: number;
}

const spreadSummarySchema = new mongoose.Schema<ISpreadSummary>(
  {
    symbol: { type: String, required: true },
    observations: { type: Number, required: true },
    first_date: { type: Date, required: true },
    last_date: { type: Date, required: true },
    mean_spread: { type: Number, required: true },
    max_spread: { type: Number, required: true },
    min_spread: { type: Number, required: true },
    mean_deviation: { type: Number, required: true },
    max_abs_spread: { type: Number, required: true },
    std_dev_spread: { type: Number, required: true },
    percentile_95: { type: Number, required: true },
    mean_reversion_probability: { type: Number, required: true },
  },
  { collection: "spread_summary" },
);

spreadSummarySchema.index({ symbol: 1 }, { unique: true });

// ============================================================================
//  Model registration helpers
// ============================================================================

function registerModelOnConnection<T>(
  connection: mongoose.Connection | null,
  name: string,
  schema: mongoose.Schema<T>,
): mongoose.Model<T> {
  if (connection) {
    return connection.model<T>(name, schema);
  }
  // Fallback: register on default connection (will never be used if env var unset).
  return mongoose.model<T>(name, schema);
}

// --- Archive connection: StockFutureArchive (read-only, historical data pre-2026) ---
/** StockFutureArchive model (collection: stock_futures on archive DB). */
export const StockFutureArchive = registerModelOnConnection<IStockFuture>(
  archiveConnection,
  "StockFutureArchive",
  stockFutureSchema,
);

// --- Current connection: StockFuture (read-write, data from 2026 onwards) ---
/** StockFuture model (collection: stock_futures on current DB). */
export const StockFuture = registerModelOnConnection<IStockFuture>(
  currentConnection,
  "StockFuture",
  stockFutureSchema,
);

// --- Spread connection: SpreadDaily and SpreadSummary ---
/** SpreadDaily model (collection: spread_daily on spread DB). */
export const SpreadDaily = registerModelOnConnection<ISpreadDaily>(
  spreadConnection,
  "SpreadDaily",
  spreadDailySchema,
);

/** SpreadSummary model (collection: spread_summary on spread DB). */
export const SpreadSummary = registerModelOnConnection<ISpreadSummary>(
  spreadConnection,
  "SpreadSummary",
  spreadSummarySchema,
);
