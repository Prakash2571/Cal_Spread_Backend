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
  BoxDepthLevel,
  BoxDepthSnapshot,
  BoxEventLeg,
  BoxLegCharges,
  IBoxLeg,
  IBoxTrade,
  IBoxTradeEvent,
} from "./types.js";

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

const boxChargesSchema = new mongoose.Schema<BoxCharges>(
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
    at: { type: Date, default: () => new Date() },
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

    exit_price: { type: Number, default: null },
    exit_bid: { type: Number, default: null },
    exit_bid_qty: { type: Number, default: null },
    exit_ask: { type: Number, default: null },
    exit_ask_qty: { type: Number, default: null },
    exit_quote_at: { type: Date, default: null },
    exit_depth: { type: depthSnapshotSchema, default: null },
  },
  { _id: false },
);

const scannerConfigSchema = new mongoose.Schema(
  {
    min_gross_edge: { type: Number, default: 0 },
    min_net_edge: { type: Number, default: 0 },
    safety_buffer: { type: Number, default: 0 },
    quote_max_age_ms: { type: Number, default: 0 },
    strikes_each_side: { type: Number, default: 3 },
    convergence_floor: { type: Number, default: 0 },
    convergence_pct: { type: Number, default: 0 },
    min_exit_net_pnl: { type: Number, default: 0 },
    profit_capture_pct: { type: Number, default: 0 },
    execution_mode: { type: String, default: "paper_touch" },
  },
  { _id: false },
);

/* ------------------------------- box trade -------------------------------- */

const boxTradeSchema = new mongoose.Schema<IBoxTrade>(
  {
    // Never "live" — this module never places an exchange order.
    execution_mode: { type: String, enum: ["paper_touch"], default: "paper_touch" },

    underlying: { type: String, required: true, index: true },
    name: { type: String, default: "" },
    is_index: { type: Boolean, default: false },
    expiry: { type: String, required: true },

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

    opened_at: { type: Date, default: () => new Date() },

    current_remaining_edge: { type: Number, default: null },

    exit_box_value: { type: Number, default: null },
    exit_charges: { type: boxChargesSchema, default: null },

    gross_pnl: { type: Number, default: null },
    total_charges: { type: Number, default: null },
    net_pnl: { type: Number, default: null },

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
 * One OPEN box per exact strike pair.
 *
 * The partial unique index is the atomic half of duplicate protection: even if
 * two ticks race past the in-memory guard, the second insert is rejected by
 * Mongo rather than creating a second position on the same box. Closed trades
 * are excluded so the same strike pair can be traded again later.
 */
boxTradeSchema.index(
  { underlying: 1, expiry: 1, lower_strike: 1, upper_strike: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "open" },
    name: "box_open_unique_pair",
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
    gross_pnl: { type: Number, default: null },
    net_pnl: { type: Number, default: null },
    remaining_edge: { type: Number, default: null },

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
