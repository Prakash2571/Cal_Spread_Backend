import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI ?? "";
const NSE_FNO_MONGODB_URI = process.env.NSE_FNO_MONGODB_URI ?? "";

// ============================================================================
//  Second Mongoose connection for the nse_fno database
// ============================================================================

/** Separate connection for nse_fno (stock_futures, spread_daily, spread_summary). */
export const nseFnoConnection = NSE_FNO_MONGODB_URI
  ? mongoose.createConnection(NSE_FNO_MONGODB_URI)
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
 * Connect to the nse_fno MongoDB database. No-op if NSE_FNO_MONGODB_URI is unset.
 */
export async function initNseFnoDb(): Promise<void> {
  if (!NSE_FNO_MONGODB_URI || !nseFnoConnection) {
    console.warn(
      "NSE_FNO_MONGODB_URI is not set — EOD capture is DISABLED. Set it in .env to enable.",
    );
    return;
  }
  try {
    await nseFnoConnection.asPromise();
    console.log(
      `Connected to nse_fno MongoDB (database "${nseFnoConnection.name}").`,
    );
  } catch (err) {
    console.error("Failed to connect to nse_fno MongoDB:", err);
  }
}

/** True once the nse_fno connection is active. */
export function isNseFnoDbEnabled(): boolean {
  return nseFnoConnection !== null && nseFnoConnection.readyState === 1;
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
//  nse_fno models — registered on the separate nseFnoConnection
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
  },
  { collection: "spread_summary" },
);

spreadSummarySchema.index({ symbol: 1 }, { unique: true });

// Register models on the nseFnoConnection (NOT the default mongoose connection).
// If nseFnoConnection is null (env var not set), create dummy models on the
// default connection that will never be used (prevents null checks everywhere).

function registerNseFnoModel<T>(
  name: string,
  schema: mongoose.Schema<T>,
): mongoose.Model<T> {
  if (nseFnoConnection) {
    return nseFnoConnection.model<T>(name, schema);
  }
  return mongoose.model<T>(name, schema);
}

/** StockFutures model (collection: stock_futures on nse_fno DB). */
export const StockFuture = registerNseFnoModel<IStockFuture>(
  "StockFuture",
  stockFutureSchema,
);

/** SpreadDaily model (collection: spread_daily on nse_fno DB). */
export const SpreadDaily = registerNseFnoModel<ISpreadDaily>(
  "SpreadDaily",
  spreadDailySchema,
);

/** SpreadSummary model (collection: spread_summary on nse_fno DB). */
export const SpreadSummary = registerNseFnoModel<ISpreadSummary>(
  "SpreadSummary",
  spreadSummarySchema,
);
