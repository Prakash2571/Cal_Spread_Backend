import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI ?? "";
const NSE_FNO_ARCHIVE_URI = process.env.NSE_FNO_ARCHIVE_URI ?? "";
const NSE_FNO_CURRENT_URI = process.env.NSE_FNO_CURRENT_URI ?? "";
const NSE_FNO_SPREAD_URI = process.env.NSE_FNO_SPREAD_URI ?? "";
const TRADE_LOG_URI = process.env.TRADE_LOG_URI ?? "";
/**
 * Dedicated database for the BOX arbitrage module (box_trades,
 * box_trade_events). Optional: with it unset the box collections live in the
 * MONGODB_URI database instead, so the feature works out of the box.
 */
const BOX_MONGODB_URI = process.env.BOX_MONGODB_URI ?? "";

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

/**
 * One order's worth of charges, as billed by Zerodha's virtual contract note.
 * Flattened from Kite's nested shape (gst.total collapses to `gst`) so the
 * breakdown reads like a contract note line.
 */
export interface ILegCharges {
  side: "BUY" | "SELL";
  tradingsymbol: string;
  quantity: number;
  price: number; // fill price the charges were computed on
  value: number; // quantity * price (contract value / turnover)
  brokerage: number;
  stt: number; // securities transaction tax (sell side only, for futures)
  stt_type: string; // "stt" / "ctt", as Kite labels it
  exchange_txn: number; // exchange transaction charge
  sebi: number; // SEBI turnover charge
  stamp_duty: number; // buy side only
  gst: number; // 18% of (brokerage + exchange + SEBI)
  total: number;
}

/**
 * The charges for one side of a trade (both legs together): the per-leg
 * breakdown plus the summed heads.
 *
 * `source` records where the numbers came from. "kite" is the real virtual
 * contract note for the actual fills; "kite_estimate" is the same API priced at
 * the entry fills to project the exit cost of a still-open trade, so the live
 * P&L can be shown net of the full round trip before it is closed.
 */
export interface ITradeCharges {
  legs: ILegCharges[];
  value: number; // total contract value both legs
  brokerage: number;
  stt: number;
  exchange_txn: number;
  sebi: number;
  stamp_duty: number;
  gst: number;
  total: number;
  source: "kite" | "kite_estimate";
  at: Date;
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
  /** GROSS realized P&L (price move only) — charges are held separately. */
  close_pnl: number | null;
  buy_close: number | null;
  sell_close: number | null;
  margin: number | null; // net basket margin (₹) captured at trade time
  // --- Charges & value (Zerodha virtual contract note) ---
  entry_charges: ITradeCharges | null; // real, for the entry fills
  exit_charges: ITradeCharges | null; // real, set when the trade is closed
  /** Projected exit charges, priced at the entry fills while the trade is open. */
  est_exit_charges: ITradeCharges | null;
  entry_value: number | null; // contract value transacted on entry
  exit_value: number | null; // contract value transacted on exit
  total_charges: number | null; // entry + exit, once the trade is closed
  net_pnl: number | null; // close_pnl - total_charges
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

const legChargesSchema = new mongoose.Schema<ILegCharges>(
  {
    side: { type: String, enum: ["BUY", "SELL"], required: true },
    tradingsymbol: { type: String, default: "" },
    quantity: { type: Number, default: 0 },
    price: { type: Number, default: 0 },
    value: { type: Number, default: 0 },
    brokerage: { type: Number, default: 0 },
    stt: { type: Number, default: 0 },
    stt_type: { type: String, default: "" },
    exchange_txn: { type: Number, default: 0 },
    sebi: { type: Number, default: 0 },
    stamp_duty: { type: Number, default: 0 },
    gst: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
  },
  { _id: false },
);

const tradeChargesSchema = new mongoose.Schema<ITradeCharges>(
  {
    legs: { type: [legChargesSchema], default: [] },
    value: { type: Number, default: 0 },
    brokerage: { type: Number, default: 0 },
    stt: { type: Number, default: 0 },
    exchange_txn: { type: Number, default: 0 },
    sebi: { type: Number, default: 0 },
    stamp_duty: { type: Number, default: 0 },
    gst: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    source: { type: String, enum: ["kite", "kite_estimate"], default: "kite" },
    at: { type: Date, default: () => new Date() },
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
  // Nullable throughout: trades taken before charges existed, and trades where
  // the charges call failed, must still load and price normally.
  entry_charges: { type: tradeChargesSchema, default: null },
  exit_charges: { type: tradeChargesSchema, default: null },
  est_exit_charges: { type: tradeChargesSchema, default: null },
  entry_value: { type: Number, default: null },
  exit_value: { type: Number, default: null },
  total_charges: { type: Number, default: null },
  net_pnl: { type: Number, default: null },
});

/** The Trade model (collection: "trades"). */
export const Trade = mongoose.model<ITrade>("Trade", tradeSchema);

// ============================================================================
//  TradeLog — an append-only ledger of what each trade actually transacted:
//  the contract value and the full tax/brokerage breakdown, one document per
//  EVENT (entry, exit) rather than per trade.
//
//  Why a separate collection instead of only the fields on `trades`: the trade
//  document is mutable (it is updated on close) and gets deleted from history by
//  the UI, whereas charges are accounting records. Keeping them append-only
//  means the tax record of a trade survives editing or deleting the trade, and
//  the collection can be exported for book-keeping as-is.
//
//  It lives on its own connection (TRADE_LOG_URI) so the ledger can be pointed
//  at a dedicated cluster/database. With that unset it falls back to the main
//  connection (MONGODB_URI), so the feature works out of the box.
// ============================================================================

/** Dedicated ledger connection, or null when TRADE_LOG_URI is unset. */
export const tradeLogConnection = TRADE_LOG_URI
  ? mongoose.createConnection(TRADE_LOG_URI)
  : null;

/** One leg of a logged event, including the raw Kite charge payload. */
export interface ITradeLogLeg extends ILegCharges {
  token: number;
  exchange: string;
  expiry: string;
  /** Kite's untouched `charges` object for this leg (audit trail). */
  raw: unknown;
}

export interface ITradeLog {
  trade_id: string; // the Trade document this event belongs to
  symbol: string;
  name: string;
  is_index: boolean;
  lot_size: number;
  event: "entry" | "exit";
  at: Date;
  legs: ITradeLogLeg[];
  /** Contract value transacted by this event (both legs). */
  value: number;
  /** Summed charge heads for this event. */
  charges: {
    brokerage: number;
    stt: number;
    exchange_txn: number;
    sebi: number;
    stamp_duty: number;
    gst: number;
    total: number;
  };
  /**
   * Where the charge numbers came from. "unpriced" means Kite could not price
   * the orders (expired session, API error): the value and fills are still on
   * record but every charge head is zero, and must not be read as a free trade.
   */
  source: "kite" | "kite_estimate" | "unpriced";
  margin: number | null;
  // Exit events only — the round-trip result.
  gross_pnl: number | null;
  total_charges: number | null; // entry + exit charges
  net_pnl: number | null; // gross_pnl - total_charges
}

const tradeLogLegSchema = new mongoose.Schema<ITradeLogLeg>(
  {
    side: { type: String, enum: ["BUY", "SELL"], required: true },
    token: { type: Number, default: 0 },
    tradingsymbol: { type: String, default: "" },
    exchange: { type: String, default: "" },
    expiry: { type: String, default: "" },
    quantity: { type: Number, default: 0 },
    price: { type: Number, default: 0 },
    value: { type: Number, default: 0 },
    brokerage: { type: Number, default: 0 },
    stt: { type: Number, default: 0 },
    stt_type: { type: String, default: "" },
    exchange_txn: { type: Number, default: 0 },
    sebi: { type: Number, default: 0 },
    stamp_duty: { type: Number, default: 0 },
    gst: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const tradeLogSchema = new mongoose.Schema<ITradeLog>(
  {
    trade_id: { type: String, required: true, index: true },
    symbol: { type: String, required: true, index: true },
    name: { type: String, default: "" },
    is_index: { type: Boolean, default: false },
    lot_size: { type: Number, default: 0 },
    event: { type: String, enum: ["entry", "exit"], required: true },
    at: { type: Date, default: () => new Date(), index: true },
    legs: { type: [tradeLogLegSchema], default: [] },
    value: { type: Number, default: 0 },
    charges: {
      brokerage: { type: Number, default: 0 },
      stt: { type: Number, default: 0 },
      exchange_txn: { type: Number, default: 0 },
      sebi: { type: Number, default: 0 },
      stamp_duty: { type: Number, default: 0 },
      gst: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },
    source: {
      type: String,
      enum: ["kite", "kite_estimate", "unpriced"],
      default: "kite",
    },
    margin: { type: Number, default: null },
    gross_pnl: { type: Number, default: null },
    total_charges: { type: Number, default: null },
    net_pnl: { type: Number, default: null },
  },
  { collection: "trade_log" },
);

/**
 * The ledger model (collection: "trade_log"), bound to the dedicated ledger
 * connection when one is configured and to the main connection otherwise.
 */
export const TradeLog = (tradeLogConnection ?? mongoose.connection).model<ITradeLog>(
  "TradeLog",
  tradeLogSchema,
);

/** True once the ledger has a live connection to write to. */
export function isTradeLogEnabled(): boolean {
  return tradeLogConnection
    ? tradeLogConnection.readyState === 1
    : mongoose.connection.readyState === 1;
}

/**
 * Append one event to the charges ledger. Best-effort by design: the ledger is
 * a record OF a trade, never a precondition for taking one, so a write failure
 * is logged and swallowed rather than failing the request.
 */
export async function appendTradeLog(entry: ITradeLog): Promise<void> {
  if (!isTradeLogEnabled()) return;
  try {
    await TradeLog.create(entry);
  } catch (err) {
    console.warn("[TradeLog] failed to append", entry.event, "event:", err);
  }
}

// ============================================================================
//  Box arbitrage storage (box_trades, box_trade_events)
//
//  Box positions are a different strategy with a four-leg shape, so they get
//  their own collections — and optionally their own DATABASE via BOX_MONGODB_URI,
//  which keeps the Box strategy book completely separate from the calendar
//  trade book. With the variable unset everything falls back to MONGODB_URI.
// ============================================================================

/** Dedicated box connection, or null when BOX_MONGODB_URI is unset. */
export const boxConnection = BOX_MONGODB_URI
  ? mongoose.createConnection(BOX_MONGODB_URI)
  : null;

/** True once the box collections have a live connection to read/write. */
export function isBoxConnectionReady(): boolean {
  return boxConnection
    ? boxConnection.readyState === 1
    : mongoose.connection.readyState === 1;
}

/** Open the dedicated box connection, if one is configured. */
export async function initBoxConnection(): Promise<void> {
  if (!boxConnection) {
    if (!MONGODB_URI) {
      console.warn(
        "BOX_MONGODB_URI and MONGODB_URI are both unset — Box trades cannot be stored, so the Box scanner will refuse to start.",
      );
      return;
    }
    console.log(
      "BOX_MONGODB_URI is not set — box_trades / box_trade_events fall back to the main MONGODB_URI database.",
    );
    return;
  }
  try {
    await boxConnection.asPromise();
    console.log(
      `Connected to box MongoDB (database "${boxConnection.name}") — box_trades + box_trade_events.`,
    );
  } catch (err) {
    console.error("Failed to connect to the box MongoDB:", err);
  }
}

/** Open the dedicated ledger connection, if one is configured. */
export async function initTradeLogConnection(): Promise<void> {
  if (!tradeLogConnection) {
    console.warn(
      "TRADE_LOG_URI is not set — the trade/charges ledger falls back to the main MONGODB_URI database.",
    );
    return;
  }
  try {
    await tradeLogConnection.asPromise();
    console.log(
      `Connected to trade-log MongoDB (database "${tradeLogConnection.name}") — trade_log ledger.`,
    );
  } catch (err) {
    console.error("Failed to connect to the trade-log MongoDB:", err);
  }
}

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
//  KiteSession — persist the daily Zerodha access token so it survives a
//  backend restart/redeploy (Kite tokens are valid for the trading day, so we
//  only ever restore a token that was generated on the SAME IST day).
// ============================================================================

export interface IKiteSession {
  _id: string; // fixed "current" — single-document store
  access_token: string;
  user_id: string;
  user_name: string;
  login_date: string; // IST YYYY-MM-DD the token was generated on
  updated_at: Date;
}

const kiteSessionSchema = new mongoose.Schema<IKiteSession>(
  {
    _id: { type: String },
    access_token: { type: String, required: true },
    user_id: { type: String, default: "" },
    user_name: { type: String, default: "" },
    login_date: { type: String, required: true },
    updated_at: { type: Date, default: () => new Date() },
  },
  { collection: "kite_session" },
);

/** Single-doc model for the persisted Zerodha session. */
export const KiteSession = mongoose.model<IKiteSession>("KiteSession", kiteSessionSchema);

/** Persist (upsert) the current Zerodha access token. No-op if DB is disabled. */
export async function saveKiteSession(data: {
  access_token: string;
  user_id: string;
  user_name: string;
  login_date: string;
}): Promise<void> {
  if (!isDbEnabled()) return;
  await KiteSession.updateOne(
    { _id: "current" },
    { $set: { ...data, _id: "current", updated_at: new Date() } },
    { upsert: true },
  );
}

/** Load the persisted Zerodha session (or null). No-op if DB is disabled. */
export async function loadKiteSession(): Promise<IKiteSession | null> {
  if (!isDbEnabled()) return null;
  return KiteSession.findById("current").lean<IKiteSession>();
}

/** Remove the persisted Zerodha session (on logout / auth failure). */
export async function clearKiteSession(): Promise<void> {
  if (!isDbEnabled()) return;
  await KiteSession.deleteOne({ _id: "current" });
}

// ============================================================================
//  DhanSession — the persisted DhanHQ v2 session.
//
//  SEPARATE COLLECTION, not a `broker` field on kite_session. The two brokers'
//  sessions have genuinely different shapes (Dhan carries a client UCC and a
//  power-of-attorney flag; Zerodha carries a user id and name) and — more
//  importantly — different EXPIRY RULES. A Zerodha token is discarded unless it
//  was generated on the same IST day; Dhan states an explicit `expiry_time`, so
//  it is honoured directly rather than guessed at from a login date.
//
//  Both may be stored at once: only one broker is ACTIVE, but keeping the
//  inactive broker's session lets an operator switch back without re-logging in
//  while it is still valid.
// ============================================================================

export interface IDhanSession {
  _id: string; // fixed "current" — single-document store
  access_token: string;
  dhan_client_id: string;
  dhan_client_name: string;
  dhan_client_ucc: string;
  given_power_of_attorney: boolean;
  /**
   * When Dhan says the token stops working (epoch ms), or null when it did not say.
   *
   * Null must be treated as "unknown expiry", never as "never expires": the token
   * is then validated by using it, and a 401 is what retires it.
   */
  expiry_time: number | null;
  login_at: Date;
  login_date: string; // IST YYYY-MM-DD, for display and day-roll reporting
  updated_at: Date;
}

const dhanSessionSchema = new mongoose.Schema<IDhanSession>(
  {
    _id: { type: String },
    access_token: { type: String, required: true },
    dhan_client_id: { type: String, default: "" },
    dhan_client_name: { type: String, default: "" },
    dhan_client_ucc: { type: String, default: "" },
    given_power_of_attorney: { type: Boolean, default: false },
    expiry_time: { type: Number, default: null },
    login_at: { type: Date, default: () => new Date() },
    login_date: { type: String, required: true },
    updated_at: { type: Date, default: () => new Date() },
  },
  { collection: "dhan_session" },
);

/** Single-doc model for the persisted Dhan session. */
export const DhanSession = mongoose.model<IDhanSession>("DhanSession", dhanSessionSchema);

/** Persist (upsert) the current Dhan session. No-op if DB is disabled. */
export async function saveDhanSession(data: {
  access_token: string;
  dhan_client_id: string;
  dhan_client_name: string;
  dhan_client_ucc: string;
  given_power_of_attorney: boolean;
  expiry_time: number | null;
  login_date: string;
}): Promise<void> {
  if (!isDbEnabled()) return;
  await DhanSession.updateOne(
    { _id: "current" },
    {
      $set: {
        ...data,
        _id: "current",
        login_at: new Date(),
        updated_at: new Date(),
      },
    },
    { upsert: true },
  );
}

/** Load the persisted Dhan session (or null). No-op if DB is disabled. */
export async function loadDhanSession(): Promise<IDhanSession | null> {
  if (!isDbEnabled()) return null;
  return DhanSession.findById("current").lean<IDhanSession>();
}

/** Remove the persisted Dhan session (on logout / auth failure / expiry). */
export async function clearDhanSession(): Promise<void> {
  if (!isDbEnabled()) return;
  await DhanSession.deleteOne({ _id: "current" });
}

// ============================================================================
//  ActiveBroker — which broker owns the feed, scanner and execution.
//
//  Persisted so a restart resumes the broker the operator selected rather than
//  silently reverting to Zerodha and starting to price trades from the wrong
//  venue. A single document, exactly like the session stores.
// ============================================================================

export interface IActiveBroker {
  _id: string; // fixed "current"
  broker: string; // BrokerId; validated on read, never trusted blindly
  selected_at: Date;
  selected_by: string;
}

const activeBrokerSchema = new mongoose.Schema<IActiveBroker>(
  {
    _id: { type: String },
    broker: { type: String, required: true },
    selected_at: { type: Date, default: () => new Date() },
    selected_by: { type: String, default: "admin" },
  },
  { collection: "active_broker" },
);

export const ActiveBrokerDoc = mongoose.model<IActiveBroker>("ActiveBroker", activeBrokerSchema);

export async function saveActiveBroker(broker: string, selectedBy: string): Promise<void> {
  if (!isDbEnabled()) return;
  await ActiveBrokerDoc.updateOne(
    { _id: "current" },
    { $set: { _id: "current", broker, selected_by: selectedBy, selected_at: new Date() } },
    { upsert: true },
  );
}

export async function loadActiveBroker(): Promise<string | null> {
  if (!isDbEnabled()) return null;
  const doc = await ActiveBrokerDoc.findById("current").lean<IActiveBroker>();
  return doc?.broker ?? null;
}

// ============================================================================
//  AdminSession — persist admin/trade-access sessions so an admin who logged
//  in for the day stays logged in across backend restarts/redeploys (rather
//  than the in-memory session map being wiped and forcing a fresh secret entry).
// ============================================================================

export interface IAdminSession {
  _id: string; // the admin token
  role: "full" | "trade";
  expiry: number; // epoch ms
}

const adminSessionSchema = new mongoose.Schema<IAdminSession>(
  {
    _id: { type: String },
    role: { type: String, enum: ["full", "trade"], required: true },
    expiry: { type: Number, required: true },
  },
  { collection: "admin_sessions" },
);

/** Model for persisted admin sessions (collection: "admin_sessions"). */
export const AdminSession = mongoose.model<IAdminSession>(
  "AdminSession",
  adminSessionSchema,
);

/** Persist (upsert) an admin session token. No-op if DB is disabled. */
export async function saveAdminSession(
  token: string,
  role: "full" | "trade",
  expiry: number,
): Promise<void> {
  if (!isDbEnabled()) return;
  await AdminSession.updateOne(
    { _id: token },
    { $set: { role, expiry } },
    { upsert: true },
  );
}

/** Load all still-valid (non-expired) admin sessions. Empty if DB disabled. */
export async function loadAdminSessions(): Promise<IAdminSession[]> {
  if (!isDbEnabled()) return [];
  return AdminSession.find({ expiry: { $gt: Date.now() } }).lean<IAdminSession[]>();
}

/** Remove a persisted admin session (on expiry / logout). */
export async function deleteAdminSession(token: string): Promise<void> {
  if (!isDbEnabled()) return;
  await AdminSession.deleteOne({ _id: token });
}

// ============================================================================
//  AppSetting — small single-collection key/value store for app-wide settings
//  the admin controls (currently the risk-free rate). Persisted so the value
//  survives restarts and is shared across every browser/visitor.
// ============================================================================

export interface IAppSetting {
  _id: string; // the setting key, e.g. "rf_rate"
  value: number;
  updated_at: Date;
}

const appSettingSchema = new mongoose.Schema<IAppSetting>(
  {
    _id: { type: String },
    value: { type: Number, required: true },
    updated_at: { type: Date, default: () => new Date() },
  },
  { collection: "app_settings" },
);

/** Key/value model for admin-controlled app settings. */
export const AppSetting = mongoose.model<IAppSetting>("AppSetting", appSettingSchema);

const RF_KEY = "rf_rate";

/** Persist (upsert) the admin's risk-free rate (%). No-op if DB is disabled. */
export async function saveRfRate(rf: number): Promise<void> {
  if (!isDbEnabled()) return;
  await AppSetting.updateOne(
    { _id: RF_KEY },
    { $set: { value: rf, updated_at: new Date() } },
    { upsert: true },
  );
}

/** Load the persisted risk-free rate (or null if unset). No-op if DB disabled. */
export async function loadRfRate(): Promise<number | null> {
  if (!isDbEnabled()) return null;
  const doc = await AppSetting.findById(RF_KEY).lean<IAppSetting>();
  return doc ? doc.value : null;
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


/**
 * Close every Mongo connection this module owns, for process shutdown.
 *
 * There are up to six: the default connection plus the five created with
 * `createConnection` (archive, current, spread, trade-log, box). Closing only
 * `mongoose.connection` — the obvious thing to write — would leave the other five open
 * and the process would not exit.
 *
 * `force: false` lets in-flight operations drain rather than being cut mid-write, which
 * matters because the position monitor's retry queues may be persisting a confirmed
 * fill at exactly this moment.
 *
 * Each close is independent: one failing connection must not prevent the rest from
 * closing. Errors are logged and swallowed for that reason — at this point in shutdown
 * there is nothing useful left to do with them, and throwing would abort the remaining
 * closes.
 */
export async function closeDbConnections(): Promise<void> {
  const named: { name: string; conn: mongoose.Connection | null }[] = [
    { name: "default", conn: mongoose.connection },
    { name: "archive", conn: archiveConnection },
    { name: "current", conn: currentConnection },
    { name: "spread", conn: spreadConnection },
    { name: "trade_log", conn: tradeLogConnection },
    { name: "box", conn: boxConnection },
  ];

  await Promise.all(
    named.map(async ({ name, conn }) => {
      // readyState 0 === disconnected: nothing to close, and calling close() on an
      // unused createConnection handle would otherwise log a spurious failure.
      if (!conn || conn.readyState === 0) return;
      try {
        await conn.close(false);
        console.log(`[shutdown] Mongo connection "${name}" closed.`);
      } catch (err) {
        console.warn(`[shutdown] Mongo connection "${name}" failed to close:`, err);
      }
    }),
  );
}
