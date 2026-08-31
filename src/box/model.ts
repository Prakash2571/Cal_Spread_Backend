/**
 * Box Mongo models — DELIBERATELY SEPARATE from the calendar-spread models.
 *
 * The calendar `Trade` document has exactly two legs (`buy`/`sell`); a box has
 * four. Rather than widening that schema (which would change the meaning of
 * every existing calendar document), boxes live in their own collections:
 *
 *   box_trades       the mutable position record
 *   box_trade_events an append-only ledger of decision snapshots
 *
 * Nothing here reads or writes the `trades` / `trade_log` collections.
 */

import mongoose from "mongoose";
import type { ILegCharges, ITradeCharges } from "../db.js";
import { boxConnection } from "../db.js";
import type {
  BoxCharges,
  BoxChargesWithOrigin,
  BoxDepthLevel,
  BoxDepthSnapshot,
  IBoxExecutionAttempt,
  BoxEventLeg,
  BoxLegCharges,
  IBoxLeg,
  IBoxTrade,
  IBoxTradeEvent,
} from "./types.js";
import type { BoxDailyPnlRow, BoxDailyPnlSummary } from "./pnlSnapshot.js";

/**
 * Compile-time proof that the box module's dependency-free charge types stay
 * interchangeable with the calendar ledger's.
 *
 * The box core declares its own copies so the trading logic needs no Mongoose,
 * but the numbers must remain the SAME shape the shared Zerodha charge estimator
 * produces. If either side ever drifts, this fails the build instead of silently
 * mis-storing a contract note.
 */
type AssertAssignable<A extends B, B> = A;
type _BoxLegChargesMatch = AssertAssignable<BoxLegCharges, ILegCharges>;
type _CalLegChargesMatch = AssertAssignable<ILegCharges, BoxLegCharges>;
type _BoxChargesMatch = AssertAssignable<BoxCharges, ITradeCharges>;
type _CalChargesMatch = AssertAssignable<ITradeCharges, BoxCharges>;

/* ----------------------------- shared subdocs ----------------------------- */

const depthLevelSchema = new mongoose.Schema<BoxDepthLevel>(
  {
    price: { type: Number, default: 0 },
    qty: { type: Number, default: 0 },
    orders: { type: Number, default: 0 },
  },
  { _id: false },
);

const depthSnapshotSchema = new mongoose.Schema<BoxDepthSnapshot>(
  {
    bids: { type: [depthLevelSchema], default: [] },
    asks: { type: [depthLevelSchema], default: [] },
  },
  { _id: false },
);

/**
 * Charge sub-schemas mirroring the calendar ledger's SHAPE so a box contract
 * note reads identically, while remaining independent Mongoose objects (a schema
 * instance cannot be shared across models without coupling them).
 */
const boxLegChargesSchema = new mongoose.Schema<BoxLegCharges>(
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

const boxChargesSchema = new mongoose.Schema<BoxChargesWithOrigin>(
  {
    legs: { type: [boxLegChargesSchema], default: [] },
    value: { type: Number, default: 0 },
    brokerage: { type: Number, default: 0 },
    stt: { type: Number, default: 0 },
    exchange_txn: { type: Number, default: 0 },
    sebi: { type: Number, default: 0 },
    stamp_duty: { type: Number, default: 0 },
    gst: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    source: { type: String, enum: ["kite", "kite_estimate"], default: "kite" },
    // Who produced the figures. Nullable/defaulted so old documents load; a value
    // of "local" makes clear the number was not Zerodha-confirmed.
    computed_by: { type: String, enum: ["local", "kite", "local_verified"], default: "local" },
    at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

/** The verdict of an asynchronous Zerodha reconciliation against local maths. */
const chargeReconciliationSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ["pending", "verified", "failed"], default: "pending" },
    local_total: { type: Number, default: null },
    reconciled_total: { type: Number, default: null },
    abs_diff: { type: Number, default: null },
    pct_diff: { type: Number, default: null },
    // PER-HEAD differences (brokerage, STT, exchange, IPFT, SEBI, GST, stamp).
    //
    // This field was previously MISSING from the schema, so every head_diffs
    // object the reconciler computed was silently dropped by Mongoose on write —
    // leaving only an opaque total and no way to see WHICH statutory rate had
    // drifted. Mixed rather than a strict subdoc so a future head can be added
    // without a migration.
    head_diffs: { type: mongoose.Schema.Types.Mixed, default: null },
    at: { type: Date, default: null },
    error: { type: String, default: null },
  },
  { _id: false },
);

/* --------------------------------- legs ---------------------------------- */

const boxLegSchema = new mongoose.Schema<IBoxLeg>(
  {
    role: {
      type: String,
      enum: ["k1_ce", "k2_ce", "k2_pe", "k1_pe"],
      required: true,
    },
    token: { type: Number, required: true },
    tradingsymbol: { type: String, required: true },
    exchange: { type: String, default: "NFO" },
    strike: { type: Number, required: true },
    instrument_type: { type: String, enum: ["CE", "PE"], required: true },
    side: { type: String, enum: ["BUY", "SELL"], required: true },

    // The touch the paper fill was taken at, and the book it came from.
    entry_price: { type: Number, required: true },
    entry_bid: { type: Number, default: 0 },
    entry_bid_qty: { type: Number, default: 0 },
    entry_ask: { type: Number, default: 0 },
    entry_ask_qty: { type: Number, default: 0 },
    entry_quote_at: { type: Date, default: null },
    entry_depth: { type: depthSnapshotSchema, default: null },
    // The touch DETECTED before the simulated latency, and the resulting slippage.
    detected_price: { type: Number, default: null },
    entry_slippage: { type: Number, default: null },

    exit_price: { type: Number, default: null },
    exit_bid: { type: Number, default: null },
    exit_bid_qty: { type: Number, default: null },
    exit_ask: { type: Number, default: null },
    exit_ask_qty: { type: Number, default: null },
    exit_quote_at: { type: Date, default: null },
    exit_depth: { type: depthSnapshotSchema, default: null },
    exit_detected_price: { type: Number, default: null },
    exit_slippage: { type: Number, default: null },
  },
  { _id: false },
);

const scannerConfigSchema = new mongoose.Schema(
  {
    min_gross_edge: { type: Number, default: 0 },
    min_net_edge: { type: Number, default: 0 },
    min_expected_net_profit: { type: Number, default: 0 },
    safety_buffer: { type: Number, default: 0 },
    expected_entry_slippage: { type: Number, default: 0 },
    expected_exit_slippage: { type: Number, default: 0 },
    quote_max_age_ms: { type: Number, default: 0 },
    strikes_each_side: { type: Number, default: 3 },
    convergence_floor: { type: Number, default: 0 },
    convergence_pct: { type: Number, default: 0 },
    min_exit_net_pnl: { type: Number, default: 0 },
    profit_capture_pct: { type: Number, default: 0 },
    min_captured_pct: { type: Number, default: 0 },
    execution_mode: { type: String, default: "paper_touch" },
    simulated_decision_ms: { type: Number, default: 0 },
    simulated_latency_ms: { type: Number, default: 0 },
  },
  { _id: false },
);

/* ------------------------------- box trade -------------------------------- */

const boxTradeSchema = new mongoose.Schema<IBoxTrade>(
  {
    // Never "live" — this module never places an exchange order.
    execution_mode: {
      type: String,
      enum: ["paper_touch", "paper_latency", "paper_legging"],
      default: "paper_touch",
    },

    underlying: { type: String, required: true, index: true },
    name: { type: String, default: "" },
    is_index: { type: Boolean, default: false },
    expiry: { type: String, required: true },

    // Absent on documents written before short boxes existed → read as LONG_BOX.
    direction: { type: String, enum: ["LONG_BOX", "SHORT_BOX"], default: "LONG_BOX" },

    lower_strike: { type: Number, required: true },
    upper_strike: { type: Number, required: true },

    lot_size: { type: Number, required: true },
    quantity: { type: Number, required: true },

    status: {
      type: String,
      enum: ["open", "closed", "error"],
      default: "open",
      index: true,
    },

    legs: { type: [boxLegSchema], default: [] },

    box_width: { type: Number, required: true },

    margin: { type: Number, default: null },

    entry_box_cost: { type: Number, required: true },
    entry_gross_edge: { type: Number, required: true },

    entry_charges: { type: boxChargesSchema, default: null },
    estimated_exit_charges: { type: boxChargesSchema, default: null },
    safety_buffer: { type: Number, default: 0 },
    entry_net_edge: { type: Number, required: true },

    // The decisive entry figure and the cost terms behind it (all defaulted).
    expected_net_profit: { type: Number, default: null },
    entry_execution_cost: { type: Number, default: null },
    charge_origin: { type: String, enum: ["local", "kite", "local_verified"], default: "local" },
    entry_charge_reconciliation: { type: chargeReconciliationSchema, default: null },
    exit_charge_reconciliation: { type: chargeReconciliationSchema, default: null },
    // Full detection→execution audit records. Mixed keeps the rich nested shape
    // (per-leg slippage, both depth snapshots, quote versions) without a schema
    // the size of the type — it is an append-only audit blob, never queried on.
    entry_execution: { type: mongoose.Schema.Types.Mixed, default: null },
    entry_legging: { type: mongoose.Schema.Types.Mixed, default: null },
    exit_execution: { type: mongoose.Schema.Types.Mixed, default: null },

    opened_at: { type: Date, default: () => new Date() },

    current_remaining_edge: { type: Number, default: null },
    current_captured_edge: { type: Number, default: null },
    current_captured_pct: { type: Number, default: null },

    exit_box_value: { type: Number, default: null },
    exit_charges: { type: boxChargesSchema, default: null },

    gross_pnl: { type: Number, default: null },
    total_charges: { type: Number, default: null },
    net_pnl: { type: Number, default: null },
    realised_net_pnl: { type: Number, default: null },

    closed_at: { type: Date, default: null },
    exit_reason: {
      type: String,
      enum: ["EDGE_CONVERGED", "PROFIT_CAPTURE", "MANUAL", "EXPIRY_SAFETY", null],
      default: null,
    },

    exit_blocked_reason: { type: String, default: null },
    expiry_safety: { type: Boolean, default: false },

    scanner_config_snapshot: { type: scannerConfigSchema, default: () => ({}) },

    error: { type: String, default: null },
  },
  { collection: "box_trades" },
);

/**
 * One OPEN box per exact strike pair AND DIRECTION.
 *
 * The partial unique index is the atomic half of duplicate protection: even if
 * two ticks race past the in-memory guard, the second insert is rejected by Mongo
 * rather than creating a second position on the same box. Closed trades are
 * excluded so the same box can be traded again later.
 *
 * `direction` is part of the key so a LONG_BOX and a SHORT_BOX on the same strikes
 * are distinct positions. NOTE for existing deployments: an older
 * `box_open_unique_pair` index (without `direction`) should be dropped so the two
 * directions can be open at once; until it is, the second direction's insert is
 * safely rejected as a duplicate rather than causing any error.
 */
boxTradeSchema.index(
  { underlying: 1, expiry: 1, lower_strike: 1, upper_strike: 1, direction: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "open" },
    name: "box_open_unique_pair_dir",
  },
);

boxTradeSchema.index({ opened_at: -1 });

export interface BoxTradeRecord extends IBoxTrade {
  _id: mongoose.Types.ObjectId;
}

/**
 * Bind a box model to the dedicated box connection when BOX_MONGODB_URI is
 * configured, and to the main connection otherwise — but always in its own
 * collection, so the calendar trade book is never touched either way.
 */
function boxModel<T>(name: string, schema: mongoose.Schema<T>): mongoose.Model<T> {
  return boxConnection ? boxConnection.model<T>(name, schema) : mongoose.model<T>(name, schema);
}

/** The box position model (collection: "box_trades"). */
export const BoxTrade = boxModel<IBoxTrade>("BoxTrade", boxTradeSchema);

/* ------------------------------ event ledger ------------------------------ */

const boxEventLegSchema = new mongoose.Schema<BoxEventLeg>(
  {
    role: { type: String, required: true },
    side: { type: String, enum: ["BUY", "SELL"], required: true },
    token: { type: Number, default: 0 },
    tradingsymbol: { type: String, default: "" },
    price: { type: Number, default: null },
    bid: { type: Number, default: 0 },
    bid_qty: { type: Number, default: 0 },
    ask: { type: Number, default: 0 },
    ask_qty: { type: Number, default: 0 },
    quote_at: { type: Date, default: null },
    age_ms: { type: Number, default: null },
  },
  { _id: false },
);

const boxTradeEventSchema = new mongoose.Schema<IBoxTradeEvent>(
  {
    event: { type: String, required: true, index: true },
    at: { type: Date, default: () => new Date(), index: true },
    trade_id: { type: String, default: null, index: true },
    candidate_key: { type: String, default: "", index: true },
    underlying: { type: String, default: "" },
    expiry: { type: String, default: "" },
    direction: { type: String, enum: ["LONG_BOX", "SHORT_BOX"], default: "LONG_BOX" },
    lower_strike: { type: Number, default: 0 },
    upper_strike: { type: Number, default: 0 },
    lot_size: { type: Number, default: 0 },
    quantity: { type: Number, default: 0 },
    execution_mode: { type: String, default: "paper_touch" },

    box_width: { type: Number, default: null },
    box_cost: { type: Number, default: null },
    gross_edge: { type: Number, default: null },
    entry_charges_total: { type: Number, default: null },
    exit_charges_total: { type: Number, default: null },
    safety_buffer: { type: Number, default: null },
    net_edge: { type: Number, default: null },
    expected_net_profit: { type: Number, default: null },
    execution_cost: { type: Number, default: null },
    gross_pnl: { type: Number, default: null },
    net_pnl: { type: Number, default: null },
    remaining_edge: { type: Number, default: null },
    captured_edge: { type: Number, default: null },
    captured_pct: { type: Number, default: null },
    execution: { type: mongoose.Schema.Types.Mixed, default: null },

    legs: { type: [boxEventLegSchema], default: [] },
    reason: { type: String, default: null },
    detail: { type: String, default: null },
  },
  { collection: "box_trade_events" },
);

/**
 * The append-only box ledger, alongside the positions it describes (so a box
 * database is self-contained and can be exported on its own).
 */
export const BoxTradeEvent = boxModel<IBoxTradeEvent>("BoxTradeEvent", boxTradeEventSchema);

/** True once the box event ledger has a live connection to write to. */
export function isBoxEventLedgerEnabled(): boolean {
  return boxConnection
    ? boxConnection.readyState === 1
    : mongoose.connection.readyState === 1;
}

/* -------------------------- execution attempts ---------------------------- */

/**
 * A paper_legging execution ATTEMPT that did not open a box (some legs filled and
 * were emergency-unwound, incurring a legging loss). Its own collection — never
 * mixed into `box_trades` — so aborted-execution losses can be netted against
 * successful-box P&L in the strategy's analytics without polluting the trade book.
 */
const boxExecutionAttemptSchema = new mongoose.Schema(
  {
    candidate_key: { type: String, default: "", index: true },
    direction: { type: String, enum: ["LONG_BOX", "SHORT_BOX"], default: "LONG_BOX" },
    underlying: { type: String, default: "", index: true },
    name: { type: String, default: "" },
    is_index: { type: Boolean, default: false },
    expiry: { type: String, default: "" },
    lower_strike: { type: Number, default: 0 },
    upper_strike: { type: Number, default: 0 },
    lot_size: { type: Number, default: 0 },
    quantity: { type: Number, default: 0 },
    execution_mode: { type: String, default: "paper_legging" },
    leg_execution_mode: { type: String, default: null },
    detected_at: { type: Date, default: () => new Date() },
    resolved_at: { type: Date, default: () => new Date(), index: true },
    detected_gross_edge: { type: Number, default: null },
    expected_net_profit: { type: Number, default: null },
    filled_leg_count: { type: Number, default: 0 },
    failed_legs: { type: [String], default: [] },
    failure_reason: { type: String, default: null },
    failure_detail: { type: String, default: null },
    // EXECUTION_ABORT_AFTER_FILL: 4/4 filled, executed economics failed the gate,
    // whole box reversed immediately. Stored flat so it can be queried directly.
    abort_after_fill: { type: Boolean, default: false },
    required_expected_net_profit: { type: Number, default: null },
    // The full per-leg legging record: an append-only audit blob.
    legging: { type: mongoose.Schema.Types.Mixed, default: null },
    partial_entry_charges: { type: Number, default: null },
    unwind_charges: { type: Number, default: null },
    gross_abort_pnl: { type: Number, default: null },
    net_abort_pnl: { type: Number, default: null },
  },
  { collection: "box_execution_attempts" },
);

boxExecutionAttemptSchema.index({ resolved_at: -1 });

export interface BoxExecutionAttemptRecord extends IBoxExecutionAttempt {
  _id: mongoose.Types.ObjectId;
}

/** The aborted-execution ledger (collection: "box_execution_attempts"). */
export const BoxExecutionAttempt = boxModel<IBoxExecutionAttempt>(
  "BoxExecutionAttempt",
  boxExecutionAttemptSchema as unknown as mongoose.Schema<IBoxExecutionAttempt>,
);

/* --------------------------- daily P&L archive ---------------------------- */

/**
 * One archived row of a day's box P&L.
 *
 * Two record kinds share the collection, distinguished by `trade_id`:
 *   - a per-trade row (real trade id): the running net of an open position or the
 *     realised net of a trade closed that day, as it stood when the day was
 *     archived;
 *   - the day summary (`trade_id: "__summary__"`), carrying the aggregate in
 *     `summary`.
 *
 * This is a REPORTING artifact drained nightly from the Redis cache — never the
 * source of truth for a trade (that stays in `box_trades`). It exists so the
 * day's running-P&L view survives beyond the Redis TTL and can be exported.
 */
export interface IBoxDailyPnl extends Partial<Omit<BoxDailyPnlRow, "status">> {
  day: string;
  trade_id: string;
  /** "open" / "closed" for a per-trade row, "summary" for the day aggregate. */
  status?: "open" | "closed" | "summary";
  summary?: BoxDailyPnlSummary | null;
  archived_at?: Date;
}

// Untyped schema + cast at the model, exactly like box_execution_attempts: the
// mixed record kinds and the nested summary would otherwise fight tsc's strict
// Schema<T> field-type checking for no runtime benefit.
const boxDailyPnlSchema = new mongoose.Schema(
  {
    day: { type: String, required: true, index: true },
    trade_id: { type: String, required: true },
    underlying: { type: String, default: "" },
    direction: { type: String, default: "LONG_BOX" },
    lower_strike: { type: Number, default: 0 },
    upper_strike: { type: Number, default: 0 },
    expiry: { type: String, default: "" },
    // Plain String (not an enum): a summary row carries status "summary".
    status: { type: String, default: "open" },
    gross_pnl: { type: Number, default: null },
    net_pnl: { type: Number, default: null },
    realisable_net_pnl: { type: Number, default: null },
    realised_net_pnl: { type: Number, default: null },
    opened_at: { type: String, default: null },
    closed_at: { type: String, default: null },
    updated_at: { type: String, default: null },
    // The per-day aggregate, present only on the "__summary__" document.
    summary: { type: mongoose.Schema.Types.Mixed, default: null },
    archived_at: { type: Date, default: () => new Date() },
  },
  { collection: "box_daily_pnl" },
);

// One document per (day, trade). The upsert key that makes re-draining idempotent:
// a verify pass can safely re-write a row the 9 PM drain already wrote.
boxDailyPnlSchema.index({ day: 1, trade_id: 1 }, { unique: true, name: "box_daily_pnl_day_trade" });

export interface BoxDailyPnlRecord extends IBoxDailyPnl {
  _id: mongoose.Types.ObjectId;
}

/** The daily-P&L archive model (collection: "box_daily_pnl"). */
export const BoxDailyPnl = boxModel<IBoxDailyPnl>(
  "BoxDailyPnl",
  boxDailyPnlSchema as unknown as mongoose.Schema<IBoxDailyPnl>,
);
