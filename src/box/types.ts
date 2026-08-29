/**
 * Box-arbitrage domain types.
 *
 * This module is entirely SEPARATE from the calendar-spread engine: it shares
 * only the Kite client, the ticker hub, the instrument cache and the Zerodha
 * charge estimator. No calendar type, schema or collection is reused or
 * modified.
 *
 * A LONG BOX on strikes K1 < K2 of the same underlying and expiry is:
 *
 *   BUY  K1 CE   (paid  at the best ASK)
 *   SELL K2 CE   (sold  at the best BID)
 *   BUY  K2 PE   (paid  at the best ASK)
 *   SELL K1 PE   (sold  at the best BID)
 *
 * Its payoff at expiry is a fixed (K2 - K1) per unit regardless of where the
 * underlying settles, so the arbitrage is the difference between that width and
 * what the four legs actually cost to put on.
 */

/**
 * One order's charges, as billed by Zerodha's virtual contract note.
 *
 * Structurally identical to the calendar ledger's `BoxLegCharges` so a box contract
 * note reads exactly like a calendar one — but declared here rather than imported
 * so the box trading core has NO dependency on Mongoose or Express. That keeps
 * the whole decision path (math, liquidity, fees, exits) importable and testable
 * on its own. `model.ts` asserts the two shapes stay compatible.
 */
export interface BoxLegCharges {
  side: OrderSide;
  tradingsymbol: string;
  quantity: number;
  price: number;
  value: number;
  brokerage: number;
  stt: number;
  stt_type: string;
  exchange_txn: number;
  sebi: number;
  stamp_duty: number;
  gst: number;
  total: number;
}

/** The charges of one side of a box (all four orders), with the summed heads. */
export interface BoxCharges {
  legs: BoxLegCharges[];
  value: number;
  brokerage: number;
  stt: number;
  exchange_txn: number;
  sebi: number;
  stamp_duty: number;
  gst: number;
  total: number;
  /** "kite" for the priced fills, "kite_estimate" for a projection. */
  source: "kite" | "kite_estimate";
  at: Date;
}

/** Every Box fill is simulated at the executable touch of a real Zerodha book. */
export const EXECUTION_MODE = "paper_touch" as const;
export type ExecutionMode = typeof EXECUTION_MODE;

/** The four legs of a long box, in a fixed order. */
export type BoxLegRole = "k1_ce" | "k2_ce" | "k2_pe" | "k1_pe";

/** Leg roles in canonical order — index 0..3 everywhere in this module. */
export const BOX_LEG_ROLES: readonly BoxLegRole[] = [
  "k1_ce",
  "k2_ce",
  "k2_pe",
  "k1_pe",
] as const;

/** Which side each leg trades on ENTRY for a long box. */
export const BOX_ENTRY_SIDES: Readonly<Record<BoxLegRole, "BUY" | "SELL">> = {
  k1_ce: "BUY",
  k2_ce: "SELL",
  k2_pe: "BUY",
  k1_pe: "SELL",
} as const;

export type OrderSide = "BUY" | "SELL";

/** One level of the order book. */
export interface BoxDepthLevel {
  price: number;
  qty: number;
  orders: number;
}

/**
 * A point-in-time view of one instrument's executable book.
 *
 * `at` is when this book was RECEIVED (not an exchange timestamp), which is
 * what the freshness gate is measured against.
 */
export interface BoxQuote {
  token: number;
  bid: number;
  bid_qty: number;
  ask: number;
  ask_qty: number;
  last: number;
  bids: BoxDepthLevel[];
  asks: BoxDepthLevel[];
  /** Epoch ms when this book was received. */
  at: number;
  /** Where the book came from — a live tick, or a REST snapshot. */
  source: "ws" | "rest";
}

/** An option contract in a monitored strike window. */
export interface BoxOptionInstrument {
  token: number;
  tradingsymbol: string;
  exchange: string;
  strike: number;
  instrument_type: "CE" | "PE";
  expiry: string;
  lot_size: number;
}

/** One underlying being scanned, with its resolved seven-strike window. */
export interface BoxUnderlyingState {
  underlying: string;
  name: string;
  is_index: boolean;
  spot_token: number;
  expiry: string;
  lot_size: number;
  /** Strike step of the chain (median gap between adjacent strikes). */
  strike_step: number;
  /** The ATM strike the current window is centred on. */
  atm_strike: number;
  /** Exactly the strikes ATM-3 .. ATM+3 that exist in the chain (max 7). */
  strikes: number[];
  /** CE/PE instrument per strike in the window. */
  ce: Map<number, BoxOptionInstrument>;
  pe: Map<number, BoxOptionInstrument>;
  /** Spot value the window was last centred with, and when. */
  spot: number;
  spot_at: number;
  /** When the window was last rebuilt (used to damp resubscription churn). */
  window_at: number;
}

/** One evaluable strike pair (at most C(7,2) = 21 per underlying). */
export interface BoxCandidate {
  /** Stable key: underlying|expiry|K1|K2. */
  key: string;
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  lower_strike: number;
  upper_strike: number;
  box_width: number;
  lot_size: number;
  /** The four contracts, keyed by role. */
  legs: Record<BoxLegRole, BoxOptionInstrument>;
}

/** Why a candidate could not be paper-traded. */
export type BoxRejectReason =
  | "no_quote"
  | "stale_quote"
  | "missing_bid"
  | "missing_ask"
  | "insufficient_qty"
  | "below_gross_prefilter"
  | "below_net_edge"
  | "unpriced_charges"
  | "duplicate_open"
  | "stale_underlying"
  /** The market is shut, so these figures are indicative and not executable. */
  | "market_closed";

/** Per-leg liquidity/freshness detail for an evaluation. */
export interface BoxLegEvaluation {
  role: BoxLegRole;
  side: OrderSide;
  token: number;
  tradingsymbol: string;
  strike: number;
  instrument_type: "CE" | "PE";
  /** The executable price for this side: ask for BUY, bid for SELL. */
  price: number | null;
  /** Quantity available AT that exact touch price. */
  qty_at_touch: number;
  bid: number;
  bid_qty: number;
  ask: number;
  ask_qty: number;
  quote_at: number | null;
  age_ms: number | null;
  fresh: boolean;
  /** True when price > 0 and qty_at_touch >= lot size. */
  executable: boolean;
}

/**
 * A fully evaluated candidate at one instant, computed only from executable
 * bid/ask (never LTP, never mid).
 */
export interface BoxEvaluation {
  candidate: BoxCandidate;
  at: number;
  legs: BoxLegEvaluation[];
  /** Ask(K1CE) - Bid(K2CE) + Ask(K2PE) - Bid(K1PE), per unit. */
  entry_box_cost_per_unit: number | null;
  /** (K2 - K1) - entry cost, per unit. */
  gross_edge_per_unit: number | null;
  /** gross_edge_per_unit * lot_size. */
  gross_edge: number | null;
  /** All four legs quoted, fresh and one-lot executable. */
  tradable: boolean;
  /** Oldest leg quote age in ms (the freshness that actually binds). */
  worst_age_ms: number | null;
  reject: BoxRejectReason | null;
}

/** Charge estimate for a box (four entry orders + four exit orders). */
export interface BoxChargeEstimate {
  entry: BoxCharges;
  /** Conservative projection of the cost to unwind. */
  estimated_exit: BoxCharges;
  entry_total: number;
  estimated_exit_total: number;
  /** Per-leg rows kept for the audit ledger. */
  entry_legs: BoxLegCharges[];
  exit_legs: BoxLegCharges[];
}

/** An opportunity as published to the UI. */
export interface BoxOpportunity {
  key: string;
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  lower_strike: number;
  upper_strike: number;
  box_width: number;
  lot_size: number;
  quantity: number;
  entry_box_cost: number | null;
  gross_edge: number | null;
  entry_charges: number | null;
  estimated_exit_charges: number | null;
  safety_buffer: number;
  /** grossEdge - entryFees - estExitFees - safetyBuffer, when priced. */
  projected_net_edge: number | null;
  /** True when every leg is fresh and one-lot executable at the touch. */
  liquidity_ok: boolean;
  worst_age_ms: number | null;
  /**
   * Where the prices behind this row came from.
   *
   * "touch"     — executable best bid/ask. The only source that can be traded.
   * "last_close"— last traded / closing prices, shown while the market is shut.
   */
  price_source: "touch" | "last_close";
  /**
   * "INDICATIVE" — the market is closed, so this is a last-close view only.
   * "UNPRICED"   — charges could not be determined.
   * Neither is ever auto-traded.
   */
  status:
    | "WATCHING"
    | "INDICATIVE"
    | "UNPRICED"
    | "ELIGIBLE"
    | "PAPER_OPENED"
    | "OPEN"
    | "REJECTED";
  reject: BoxRejectReason | null;
  legs: BoxLegEvaluation[];
  updated_at: number;
}

/** One leg of a persisted box trade. */
export interface IBoxLeg {
  role: BoxLegRole;
  token: number;
  tradingsymbol: string;
  exchange: string;
  strike: number;
  instrument_type: "CE" | "PE";
  side: OrderSide;

  entry_price: number;
  entry_bid: number;
  entry_bid_qty: number;
  entry_ask: number;
  entry_ask_qty: number;
  entry_quote_at: Date | null;
  entry_depth: BoxDepthSnapshot | null;

  exit_price: number | null;
  exit_bid: number | null;
  exit_bid_qty: number | null;
  exit_ask: number | null;
  exit_ask_qty: number | null;
  exit_quote_at: Date | null;
  exit_depth: BoxDepthSnapshot | null;
}

/** The five-level book recorded at a decision instant. */
export interface BoxDepthSnapshot {
  bids: BoxDepthLevel[];
  asks: BoxDepthLevel[];
}

export type BoxTradeStatus = "open" | "closed" | "error";

export type BoxExitReason =
  | "EDGE_CONVERGED"
  | "PROFIT_CAPTURE"
  | "MANUAL"
  | "EXPIRY_SAFETY";

/** The scanner settings a trade was taken under (frozen onto the document). */
export interface BoxScannerConfigSnapshot {
  /** The gross-spread entry gate (₹) this trade qualified under. */
  min_gross_edge: number;
  /** Optional additional net floor (0 = none). */
  min_net_edge: number;
  safety_buffer: number;
  quote_max_age_ms: number;
  strikes_each_side: number;
  convergence_floor: number;
  convergence_pct: number;
  min_exit_net_pnl: number;
  profit_capture_pct: number;
  execution_mode: ExecutionMode;
}

/** A persisted box paper trade. */
export interface IBoxTrade {
  execution_mode: ExecutionMode;

  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;

  lower_strike: number;
  upper_strike: number;

  lot_size: number;
  quantity: number;

  status: BoxTradeStatus;

  legs: IBoxLeg[];

  box_width: number;

  entry_box_cost: number;
  entry_gross_edge: number;

  entry_charges: BoxCharges | null;
  estimated_exit_charges: BoxCharges | null;
  safety_buffer: number;
  entry_net_edge: number;

  opened_at: Date;

  /** Latest computed residual convergence, refreshed by the monitor. */
  current_remaining_edge: number | null;

  exit_box_value: number | null;
  exit_charges: BoxCharges | null;

  gross_pnl: number | null;
  total_charges: number | null;
  net_pnl: number | null;

  closed_at: Date | null;
  exit_reason: BoxExitReason | null;

  /** Set when an automatic close was wanted but the touch could not fill it. */
  exit_blocked_reason: string | null;
  /** True once the expiry-safety window has been entered. */
  expiry_safety: boolean;

  scanner_config_snapshot: BoxScannerConfigSnapshot;

  error: string | null;
}

/** Append-only audit event kinds. */
export type BoxEventType =
  | "DETECTED"
  | "ENTRY"
  | "ENTRY_REJECTED_STALE"
  | "ENTRY_REJECTED_LIQUIDITY"
  | "ENTRY_REJECTED_FEES"
  | "ENTRY_REJECTED_DUPLICATE"
  | "EXIT_TRIGGERED"
  | "EXIT"
  | "EXIT_SKIPPED_LIQUIDITY"
  | "EXPIRY_SAFETY"
  | "SCANNER_STARTED"
  | "SCANNER_STOPPED"
  | "ERROR";

/** One immutable decision snapshot in the box ledger. */
export interface IBoxTradeEvent {
  event: BoxEventType;
  at: Date;
  /** Set once a trade document exists. */
  trade_id: string | null;
  /** underlying|expiry|K1|K2 — present even for rejections. */
  candidate_key: string;
  underlying: string;
  expiry: string;
  lower_strike: number;
  upper_strike: number;
  lot_size: number;
  quantity: number;
  execution_mode: ExecutionMode;

  box_width: number | null;
  box_cost: number | null;
  gross_edge: number | null;
  entry_charges_total: number | null;
  exit_charges_total: number | null;
  safety_buffer: number | null;
  net_edge: number | null;
  gross_pnl: number | null;
  net_pnl: number | null;
  remaining_edge: number | null;

  /** The quote snapshot the decision was made on. */
  legs: BoxEventLeg[];
  reason: string | null;
  detail: string | null;
}

/** Per-leg quote snapshot stored on an event. */
export interface BoxEventLeg {
  role: BoxLegRole;
  side: OrderSide;
  token: number;
  tradingsymbol: string;
  price: number | null;
  bid: number;
  bid_qty: number;
  ask: number;
  ask_qty: number;
  quote_at: Date | null;
  age_ms: number | null;
}

/** Live exit metrics for an open trade, recomputed from the executable book. */
export interface BoxExitMetrics {
  at: number;
  legs: BoxLegEvaluation[];
  /** Bid(K1CE) - Ask(K2CE) + Bid(K2PE) - Ask(K1PE), per unit. */
  exit_box_value_per_unit: number | null;
  exit_box_value: number | null;
  gross_pnl_if_closed_now: number | null;
  estimated_exit_charges: number | null;
  total_round_trip_charges: number | null;
  current_net_pnl: number | null;
  /** (K2 - K1 - exitBoxValue) * lotSize — convergence still outstanding. */
  remaining_edge: number | null;
  /** max(floor, pct * entryNetEdge). */
  convergence_threshold: number;
  min_exit_net_pnl: number;
  profit_capture_target: number;
  liquidity_ok: boolean;
  worst_age_ms: number | null;
  /**
   * What the EXIT ARITHMETIC alone concludes, ignoring whether the market can
   * currently fill it.
   *
   * Kept separate from `exit_eligible` on purpose: a box whose rules say "close"
   * but whose touch cannot supply a whole lot must be recorded as
   * EXIT_SKIPPED_LIQUIDITY and left open — not quietly forgotten because the
   * combined flag happened to be false.
   */
  rule_reason: BoxExitReason | null;
  /** rule_reason AND a fresh, one-lot-executable four-leg market. */
  exit_eligible: boolean;
  exit_reason: BoxExitReason | null;
}
