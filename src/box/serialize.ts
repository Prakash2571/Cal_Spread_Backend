/**
 * Pure serialization for box documents.
 *
 * Kept apart from repository.ts (which opens Mongo) so the wire format can be
 * unit-tested on its own: given a document, the API shape it produces is a
 * deterministic function with no database, no clock and no network.
 */

import { candidateKey } from "./math.js";
import { directionOf, type BoxEventLeg, type BoxLegEvaluation, type IBoxTrade } from "./types.js";

/** A stored box document plus whatever id shape the driver returned. */
export interface BoxTradeDocLike extends IBoxTrade {
  _id: { toString(): string };
}

/** The API shape of a box trade: string id, ISO dates, no Mongo internals. */
export function serializeBoxTrade(doc: BoxTradeDocLike) {
  return {
    id: doc._id.toString(),
    execution_mode: doc.execution_mode,
    underlying: doc.underlying,
    name: doc.name,
    is_index: doc.is_index,
    expiry: doc.expiry,
    // Old documents have no direction: they are all long boxes.
    direction: directionOf(doc),
    lower_strike: doc.lower_strike,
    upper_strike: doc.upper_strike,
    lot_size: doc.lot_size,
    quantity: doc.quantity,
    status: doc.status,
    legs: doc.legs.map((l) => ({
      role: l.role,
      token: l.token,
      tradingsymbol: l.tradingsymbol,
      exchange: l.exchange,
      strike: l.strike,
      instrument_type: l.instrument_type,
      side: l.side,
      entry_price: l.entry_price,
      entry_bid: l.entry_bid,
      entry_bid_qty: l.entry_bid_qty,
      entry_ask: l.entry_ask,
      entry_ask_qty: l.entry_ask_qty,
      entry_quote_at: l.entry_quote_at ? l.entry_quote_at.toISOString() : null,
      entry_depth: l.entry_depth ?? null,
      detected_price: l.detected_price ?? null,
      entry_slippage: l.entry_slippage ?? null,
      exit_price: l.exit_price,
      exit_bid: l.exit_bid,
      exit_bid_qty: l.exit_bid_qty,
      exit_ask: l.exit_ask,
      exit_ask_qty: l.exit_ask_qty,
      exit_quote_at: l.exit_quote_at ? l.exit_quote_at.toISOString() : null,
      exit_depth: l.exit_depth ?? null,
      exit_detected_price: l.exit_detected_price ?? null,
      exit_slippage: l.exit_slippage ?? null,
    })),
    box_width: doc.box_width,
    margin: doc.margin ?? null,
    entry_box_cost: doc.entry_box_cost,
    entry_gross_edge: doc.entry_gross_edge,
    entry_charges: doc.entry_charges ?? null,
    estimated_exit_charges: doc.estimated_exit_charges ?? null,
    safety_buffer: doc.safety_buffer,
    entry_net_edge: doc.entry_net_edge,
    expected_net_profit: doc.expected_net_profit ?? null,
    entry_execution_cost: doc.entry_execution_cost ?? null,
    charge_origin: doc.charge_origin ?? "local",
    entry_charge_reconciliation: doc.entry_charge_reconciliation ?? null,
    exit_charge_reconciliation: doc.exit_charge_reconciliation ?? null,
    entry_execution: doc.entry_execution ?? null,
    entry_legging: doc.entry_legging ?? null,
    exit_execution: doc.exit_execution ?? null,
    opened_at: doc.opened_at.toISOString(),
    current_remaining_edge: doc.current_remaining_edge,
    current_captured_edge: doc.current_captured_edge ?? null,
    current_captured_pct: doc.current_captured_pct ?? null,
    exit_box_value: doc.exit_box_value,
    exit_charges: doc.exit_charges ?? null,
    gross_pnl: doc.gross_pnl,
    total_charges: doc.total_charges,
    net_pnl: doc.net_pnl,
    realised_net_pnl: doc.realised_net_pnl ?? null,
    closed_at: doc.closed_at ? doc.closed_at.toISOString() : null,
    exit_reason: doc.exit_reason,
    exit_blocked_reason: doc.exit_blocked_reason,
    expiry_safety: doc.expiry_safety,
    scanner_config_snapshot: doc.scanner_config_snapshot,
    error: doc.error,
  };
}

export type SerializedBoxTrade = ReturnType<typeof serializeBoxTrade>;

/** The candidate key of a stored trade (underlying|expiry|K1|K2|DIRECTION). */
export function tradeKey(t: {
  underlying: string;
  expiry: string;
  lower_strike: number;
  upper_strike: number;
  direction?: string | null;
}): string {
  return candidateKey(t.underlying, t.expiry, t.lower_strike, t.upper_strike, directionOf(t as never));
}

/** Per-leg quote snapshot for the append-only ledger. */
export function toEventLegs(legs: BoxLegEvaluation[]): BoxEventLeg[] {
  return legs.map((l) => ({
    role: l.role,
    side: l.side,
    token: l.token,
    tradingsymbol: l.tradingsymbol,
    price: l.price,
    bid: l.bid,
    bid_qty: l.bid_qty,
    ask: l.ask,
    ask_qty: l.ask_qty,
    quote_at: l.quote_at === null ? null : new Date(l.quote_at),
    age_ms: l.age_ms,
  }));
}
