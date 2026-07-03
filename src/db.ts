import { MongoClient, ObjectId } from "mongodb";
import type { Collection, Db } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI ?? "";
const DB_NAME = process.env.MONGODB_DB ?? "cal_spread";

let client: MongoClient | null = null;
let db: Db | null = null;

/** One leg of a calendar-spread trade. */
export interface TradeLeg {
  token: number;
  expiry: string; // ISO YYYY-MM-DD
  entry: number; // price captured at trade time
}

/** A persisted calendar-spread trade (buy the discount leg, sell the premium leg). */
export interface TradeDoc {
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

/** Connect to MongoDB. Safe to call once at startup; no-op if URI is unset. */
export async function initDb(): Promise<void> {
  if (!MONGODB_URI) {
    console.warn(
      "MONGODB_URI is not set — trade persistence is DISABLED. Set it in .env to enable trades.",
    );
    return;
  }
  try {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DB_NAME);
    await tradesCollection()?.createIndex({ opened_at: -1 });
    console.log(`Connected to MongoDB (database "${DB_NAME}").`);
  } catch (err) {
    console.error("Failed to connect to MongoDB:", err);
    db = null;
  }
}

export function isDbEnabled(): boolean {
  return db !== null;
}

export function tradesCollection(): Collection<TradeDoc> | null {
  if (!db) return null;
  return db.collection<TradeDoc>("trades");
}

export { ObjectId };
