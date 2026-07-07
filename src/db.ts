import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI ?? "";

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
  spread: number; // mid_month_close - current_month_close
}

const hourlyPriceSchema = new mongoose.Schema<IHourlyPrice>({
  symbol: { type: String, required: true },
  date: { type: String, required: true },
  time: { type: String, required: true },
  month: { type: String, required: true },
  current_month_close: { type: Number, required: true },
  mid_month_close: { type: Number, required: true },
  spread: { type: Number, required: true },
});

hourlyPriceSchema.index({ symbol: 1, date: 1, time: 1 }, { unique: true });

/** The HourlyPrice model (collection: "hourlyprices"). */
export const HourlyPrice = mongoose.model<IHourlyPrice>(
  "HourlyPrice",
  hourlyPriceSchema,
);
