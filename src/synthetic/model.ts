/**
 * Mongo model for synthetic-futures PAPER trades (collection: `synth_trades`).
 *
 * Bound to the Box connection (BOX_MONGODB_URI, falling back to MONGODB_URI) so
 * the arbitrage books live together, but in a collection of its own: nothing here
 * reads or writes `box_trades` or the calendar collections.
 *
 * `autoIndex` IS DISABLED. The one-open-position-per-underlying guarantee rests on
 * a unique index, so it is created deliberately and READ BACK by
 * `ensureSynthTradeIndexes()` (repository.ts) before any paper entry is allowed,
 * the same way the Box reservation store treats its atomicity-critical index.
 */

import mongoose from "mongoose";
import { boxConnection } from "../db.js";
import { BROKER_IDS } from "../brokers/types.js";
import { SYNTH_EXIT_REASONS, type SynthTrade, type SynthTradeLeg } from "./math.js";

/** The stored shape: SynthTrade with Date times, and the id held as `_id`. */
export interface ISynthTrade extends Omit<SynthTrade, "id" | "opened_at" | "closed_at"> {
  opened_at: Date;
  closed_at: Date | null;
}

const synthLegSchema = new mongoose.Schema<SynthTradeLeg>(
  {
    role: { type: String, enum: ["fut", "ce", "pe"], required: true },
    side: { type: String, enum: ["BUY", "SELL"], required: true },
    instrument_type: { type: String, enum: ["FUT", "CE", "PE"], required: true },
    strike: { type: Number, default: 0 },
    tradingsymbol: { type: String, required: true },
    token: { type: Number, default: 0 },
    entry_price: { type: Number, required: true },
    entry_bid: { type: Number, default: 0 },
    entry_ask: { type: Number, default: 0 },
    exit_price: { type: Number, default: null },
    exit_bid: { type: Number, default: null },
    exit_ask: { type: Number, default: null },
  },
  { _id: false },
);

const synthTradeSchema = new mongoose.Schema<ISynthTrade>(
  {
    status: { type: String, enum: ["open", "closed"], default: "open" },
    key: { type: String, required: true },
    broker: { type: String, enum: BROKER_IDS, default: "zerodha" },
    execution_mode: { type: String, enum: ["paper_touch"], default: "paper_touch" },
    underlying: { type: String, required: true },
    name: { type: String, default: "" },
    is_index: { type: Boolean, default: false },
    expiry: { type: String, required: true },
    strike: { type: Number, required: true },
    atm_strike: { type: Number, default: 0 },
    atm_offset: { type: Number, default: 0 },
    direction: { type: String, enum: ["CONVERSION", "REVERSAL"], required: true },
    lot_size: { type: Number, required: true },
    quantity: { type: Number, required: true },
    opened_at: { type: Date, required: true },
    opened_day: { type: String, required: true },
    legs: { type: [synthLegSchema], default: [] },

    entry_future_price: { type: Number, required: true },
    entry_synthetic_price: { type: Number, required: true },
    entry_lock_per_unit: { type: Number, required: true },
    entry_carry_per_unit: { type: Number, default: 0 },
    entry_edge: { type: Number, required: true },
    entry_gross_edge: { type: Number, required: true },
    entry_charges: { type: Number, required: true },
    estimated_exit_charges: { type: Number, required: true },
    entry_net_edge: { type: Number, required: true },
    expected_net_profit: { type: Number, required: true },
    min_expected_net_profit: { type: Number, default: 0 },
    safety_buffer: { type: Number, default: 0 },
    expected_slippage: { type: Number, default: 0 },
    rf_pct: { type: Number, default: 0 },
    option_rate_version: { type: String, default: "" },
    futures_rate_version: { type: String, default: "" },

    closed_at: { type: Date, default: null },
    closed_day: { type: String, default: null },
    exit_reason: { type: String, enum: [...SYNTH_EXIT_REASONS, null], default: null },
    gross_pnl: { type: Number, default: null },
    exit_charges: { type: Number, default: null },
    total_charges: { type: Number, default: null },
    net_pnl: { type: Number, default: null },
    exit_note: { type: String, default: null },
  },
  // Indexes are created and verified explicitly (see the module docblock).
  { collection: "synth_trades", autoIndex: false },
);

export const SynthTradeModel: mongoose.Model<ISynthTrade> = boxConnection
  ? boxConnection.model<ISynthTrade>("SynthTrade", synthTradeSchema)
  : mongoose.model<ISynthTrade>("SynthTrade", synthTradeSchema);
