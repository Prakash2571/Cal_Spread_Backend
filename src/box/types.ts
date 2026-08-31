/**
 * Box-arbitrage domain types.
 *
 * This module is entirely SEPARATE from the calendar-spread engine: it shares
 * only the Kite client, the ticker hub, the instrument cache and the Zerodha
 * charge estimator. No calendar type, schema or collection is reused or
 * modified.
 *
 * A box on strikes K1 < K2 of the same underlying and expiry has TWO directions:
 *
 *   LONG_BOX   BUY  K1 CE / SELL K2 CE / BUY  K2 PE / SELL K1 PE
 *   SHORT_BOX  SELL K1 CE / BUY  K2 CE / SELL K2 PE / BUY  K1 PE
 *
 * Both settle at a fixed (K2 - K1) per unit whatever the underlying does: the
 * long box RECEIVES that width at expiry and the short box PAYS it. So the
 * arbitrage in either direction is the difference between the width and what the
 * four legs are actually worth right now — signed by the direction.
 */

/**
 * One order's charges, as billed by Zerodha's virtual contract note (or by the
 * local deterministic calculator that mirrors it).
 *
 * Structurally identical to the calendar ledger's `ILegCharges` so a box contract
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

/**
 * WHO produced these numbers.
 *
 * Deliberately a separate OPTIONAL field rather than a new `source` value: the
 * box charge record must stay structurally interchangeable with the calendar
 * ledger's (see the assignability assertions in model.ts), and widening `source`
 * would break that. It is the honest label the UI needs — a locally computed
 * contract note must never be displayed as if Zerodha had confirmed it.
 *
 *   "local"          computed synchronously from the centralized rate card
 *   "kite"           Zerodha's virtual contract note
 *   "local_verified" local figures that a Zerodha reconciliation has since agreed with
 */
export type BoxChargeOrigin = "local" | "kite" | "local_verified";

/** A charge record that also says where it came from. */
export interface BoxChargesWithOrigin extends BoxCharges {
  computed_by?: BoxChargeOrigin;
}

/**
 * The result of checking a locally calculated contract note against Zerodha's.
 *
 * Written asynchronously AFTER a paper fill, never before: the whole point of the
 * local calculator is that no decision waits on the network.
 */
export interface BoxChargeReconciliation {
  status: "pending" | "verified" | "failed";
  /** What the local calculator said (the figure the decision actually used). */
  local_total: number | null;
  /** What Zerodha's virtual contract note said, when it answered. */
  reconciled_total: number | null;
  /** |zerodha - local|, in ₹. */
  abs_diff: number | null;
  /** abs_diff / zerodha_total, as a percentage. */
  pct_diff: number | null;
  /**
   * Per-head local-minus-Zerodha differences (₹). When a discrepancy clusters on
   * one head this points straight at the wrong rate or rounding rule (e.g. STT),
   * instead of leaving a single opaque total to guess about.
   */
  head_diffs?: {
    brokerage: number;
    stt: number;
    exchange_txn: number;
    sebi: number;
    stamp_duty: number;
    gst: number;
  } | null;
  at: Date | null;
  error: string | null;
}

/**
 * How a paper fill is simulated.
 *
 *   "paper_touch"   — fills at the touch visible in the DETECTION snapshot.
 *                     Optimistic: it assumes the book cannot move between seeing
 *                     an opportunity and reaching the exchange. Kept for
 *                     comparison.
 *   "paper_latency" — fills from the first WebSocket book that arrives AT OR
 *                     AFTER a simulated decision + order-send delay, so the
 *                     price the simulator records is one the market actually
 *                     published after the order could have arrived.
 */
export type ExecutionMode = "paper_touch" | "paper_latency" | "paper_legging";
export const EXECUTION_MODES: readonly ExecutionMode[] = [
  "paper_touch",
  "paper_latency",
  "paper_legging",
] as const;
/** @deprecated Retained so older imports keep compiling. */
export const EXECUTION_MODE = "paper_touch" as const;

/** Which way round the four legs are traded. */
export type BoxDirection = "LONG_BOX" | "SHORT_BOX";
export const BOX_DIRECTIONS: readonly BoxDirection[] = ["LONG_BOX", "SHORT_BOX"] as const;

/** The four legs of a box, in a fixed order. */
export type BoxLegRole = "k1_ce" | "k2_ce" | "k2_pe" | "k1_pe";

/** Leg roles in canonical order — index 0..3 everywhere in this module. */
export const BOX_LEG_ROLES: readonly BoxLegRole[] = [
  "k1_ce",
  "k2_ce",
  "k2_pe",
  "k1_pe",
] as const;

export type OrderSide = "BUY" | "SELL";

/**
 * Which side each leg trades on ENTRY, per direction.
 *
 * SHORT_BOX is the exact mirror of LONG_BOX. Everything else in the module reads
 * its sides from here, so a direction can never be half-applied.
 */
export const BOX_ENTRY_SIDES_BY_DIRECTION: Readonly<
  Record<BoxDirection, Readonly<Record<BoxLegRole, OrderSide>>>
> = {
  LONG_BOX: { k1_ce: "BUY", k2_ce: "SELL", k2_pe: "BUY", k1_pe: "SELL" },
  SHORT_BOX: { k1_ce: "SELL", k2_ce: "BUY", k2_pe: "SELL", k1_pe: "BUY" },
} as const;

/** Long-box entry sides. Kept as a named export for compatibility. */
export const BOX_ENTRY_SIDES: Readonly<Record<BoxLegRole, OrderSide>> =
  BOX_ENTRY_SIDES_BY_DIRECTION.LONG_BOX;

/**
 * +1 for a long box, -1 for a short box.
 *
 * The ONE place the sign of the strike width lives. A long box receives the width
 * at expiry; a short box pays it. Every edge, P&L and convergence figure is
 * derived from this so the two directions cannot drift apart.
 */
export function directionSign(direction: BoxDirection): 1 | -1 {
  return direction === "LONG_BOX" ? 1 : -1;
}

/** One level of the order book. */
export interface BoxDepthLevel {
  price: number;
  qty: number;
  orders: number;
}

/**
 * A point-in-time view of one instrument's executable book.
 *
 * IMMUTABLE: the quote store replaces the whole object on every accepted packet
 * and never mutates one in place, so a stored reference is a permanent record of
 * that packet. `at` is when it was RECEIVED (not an exchange timestamp), which is
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
  /** Monotonic local sequence assigned when a WebSocket depth packet arrives. */
  version: number;
  /** Epoch ms when this book was received. */
  at: number;
  /** Executable Box books are accepted from the live WebSocket only. */
  source: "ws";
}

/**
 * The LIGHTWEIGHT execution view of one side of one book — what the hot path
 * needs and nothing more.
 *
 * The five-level ladder is deliberately absent: cloning four ladders for each of
 * up to 21 candidates on every tick was pure allocation churn, and none of the
 * qualification arithmetic looks past the touch. The full depth is captured
 * separately (see `captureDepth`) at the few moments that genuinely need an
 * audit record.
 */
export interface BoxTouch {
  token: number;
  side: OrderSide;
  /** ask for BUY, bid for SELL — the only price a paper fill may use. */
  price: number | null;
  /** Quantity resting at EXACTLY that price. */
  qty: number;
  bid: number;
  bid_qty: number;
  ask: number;
  ask_qty: number;
  version: number;
  at: number;
  age_ms: number;
  fresh: boolean;
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

/**
 * One evaluable box: a strike pair AND a direction.
 *
 * At most C(7,2) x 2 = 42 candidates per underlying — 21 pairs each evaluated
 * long and short. The direction is part of the identity, so a long box and a
 * short box on the same strikes are different candidates and different positions.
 */
export interface BoxCandidate {
  /** Stable key: underlying|expiry|K1|K2|DIRECTION. */
  key: string;
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  direction: BoxDirection;
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
  /** The decisive gate: expected NET profit after all costs is too small. */
  | "below_expected_net_profit"
  /** The simulated execution after the latency delay could not fill. */
  | "execution_failed"
  | "unpriced_charges"
  | "duplicate_open"
  | "stale_underlying"
  /** The market is shut, so these figures are indicative and not executable. */
  | "market_closed"
  /**
   * The last-close prices do not form a coherent box, which means at least one
   * leg has not traded recently enough to be comparable.
   */
  | "implausible_close";

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
  /** WS sequence of the exact immutable book used for this leg. */
  quote_version?: number | null;
  /**
   * Five-level WS book — populated ONLY when the evaluation was asked to capture
   * depth (entry/exit snapshots, audit events, chain requests). Null on the hot
   * path by design.
   */
  depth?: BoxDepthSnapshot | null;
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
  /**
   * Net DEBIT per unit: sum of (+price for every BUY leg, -price for every SELL
   * leg) at the executable touch.
   *
   * Positive means the box costs money to put on (the usual long box); negative
   * means it pays a credit (the usual short box). One formula, both directions.
   */
  entry_net_debit_per_unit: number | null;
  /**
   * The long box's cost per unit. Same number as `entry_net_debit_per_unit`,
   * retained under its original name so existing consumers keep working.
   */
  entry_box_cost_per_unit: number | null;
  /** directionSign x width - netDebit, per unit. */
  gross_edge_per_unit: number | null;
  /** gross_edge_per_unit * lot_size. */
  gross_edge: number | null;
  /** All four legs quoted, fresh and one-lot executable. */
  tradable: boolean;
  /**
   * All four legs show a whole lot at the touch, IGNORING freshness.
   *
   * Reported separately from `tradable` so liquidity and staleness can be told
   * apart: "the book is thin" and "the book has not been pushed for a while" are
   * different problems with different fixes.
   */
  depth_ok: boolean;
  /** Oldest leg quote age in ms (the freshness that actually binds). */
  worst_age_ms: number | null;
  /** Highest WS version across the four legs — the snapshot's identity. */
  quote_version: number | null;
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

/**
 * The full arithmetic of an entry decision — every term visible, nothing hidden
 * behind a single number.
 *
 *   expected_net = gross
 *                - entry_charges
 *                - estimated_exit_charges
 *                - execution_cost      (measured slippage + exit allowance)
 *                - safety_buffer
 *
 * `qualifies` is expected_net >= min_expected_net_profit. That is THE entry
 * decision; the gross figure is only a cheap prefilter.
 */
export interface BoxEntryDecision {
  gross_edge: number | null;
  entry_charges: number | null;
  estimated_exit_charges: number | null;
  /**
   * The total execution/slippage cost actually DEDUCTED from expected net (₹) —
   * `entry_slippage_allowance + future_exit_slippage_allowance`.
   *
   * DELIBERATELY the sum of the two named allowances below, never the measured
   * entry slippage: at the FINAL qualification `gross_edge` is already the
   * executed gross edge (adverse entry movement is baked into it), so deducting
   * the measured entry slippage again would double-count it.
   */
  execution_cost: number;
  /**
   * PRE-EXECUTION only: the expected entry-slippage allowance deducted while
   * merely projecting whether an opportunity is worth starting. Zero at the final
   * qualification, where the executed gross edge already reflects real movement.
   */
  entry_slippage_allowance: number;
  /** The expected FUTURE exit-slippage allowance (₹) — always a forward cost. */
  future_exit_slippage_allowance: number;
  /**
   * ANALYTICS ONLY: the entry slippage actually measured against the detection
   * touch (₹, positive = worse). Recorded and exposed, but NOT subtracted from
   * expected net — the executed gross edge already contains it.
   */
  measured_entry_slippage: number | null;
  safety_buffer: number;
  expected_net_profit: number | null;
  min_expected_net_profit: number;
  /** True when the gross prefilter was cleared (cheap, first-pass). */
  passes_gross_prefilter: boolean;
  qualifies: boolean;
  reject: BoxRejectReason | null;
}

/** An opportunity as published to the UI. */
export interface BoxOpportunity {
  key: string;
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  direction: BoxDirection;
  lower_strike: number;
  upper_strike: number;
  box_width: number;
  lot_size: number;
  quantity: number;
  /** Signed net debit of the four entry orders (negative = credit received). */
  entry_box_cost: number | null;
  gross_edge: number | null;
  entry_charges: number | null;
  estimated_exit_charges: number | null;
  /** Expected execution/slippage cost carried in the projection (₹). */
  execution_cost: number;
  safety_buffer: number;
  /** gross - entryFees - estExitFees - executionCost - safetyBuffer. */
  projected_net_edge: number | null;
  /** Same figure under its decision-facing name. */
  expected_net_profit: number | null;
  min_expected_net_profit: number;
  /** Whether the charge figures behind this row are local or Zerodha-verified. */
  charge_origin: BoxChargeOrigin;
  /** The four entry orders, so the direction's sides are unambiguous in the UI. */
  entry_sides: { role: BoxLegRole; side: OrderSide; tradingsymbol: string }[];
  /** True when every leg is fresh AND one-lot executable at the touch. */
  liquidity_ok: boolean;
  /** One whole lot available on all four legs, ignoring how quiet the book is. */
  depth_ok: boolean;
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

/* -------------------------------------------------------------------------- */
/*  Execution simulation                                                      */
/* -------------------------------------------------------------------------- */

/** Why a simulated execution did not produce a fill. */
export type BoxExecutionFailureReason =
  | "price_moved"
  | "insufficient_quantity"
  | "missing_book"
  | "feed_unhealthy"
  | "market_closed"
  | "edge_disappeared"
  | "below_expected_net_profit"
  | "discovery_stopped"
  | "duplicate"
  /** paper_legging: at least one leg did not fill before the timeout. */
  | "legging_incomplete"
  /** paper_legging: a filled leg could not be unwound (no opposite liquidity). */
  | "unwind_failed"
  /**
   * paper_legging: ALL FOUR legs filled, but the final economics computed on the
   * EXECUTED prices no longer clear the required expected net profit.
   *
   * This is not a refusal — the orders really filled, so a real position existed.
   * The box is never opened; instead all four legs are immediately reversed and
   * the true cost of that round trip is booked as the abort P&L.
   */
  | "abort_after_fill";

/** One leg's detection → execution comparison. */
export interface BoxExecutionLeg {
  role: BoxLegRole;
  side: OrderSide;
  token: number;
  tradingsymbol: string;
  /** The touch that was visible when the box was DETECTED. */
  detected_price: number | null;
  detected_qty: number;
  detected_quote_version: number | null;
  detected_quote_at: number | null;
  /** The touch from the first WS book at/after the simulated arrival. */
  executed_price: number | null;
  executed_qty: number;
  executed_quote_version: number | null;
  executed_quote_at: number | null;
  /**
   * Cost of the move, per unit: positive means the market moved AGAINST us
   * (paying more on a BUY, receiving less on a SELL).
   */
  slippage_per_unit: number | null;
  /** slippage_per_unit x lot size. */
  slippage: number | null;
  /** Age (ms) of the book used, measured at the simulated arrival/fill instant. */
  executed_book_age_ms?: number | null;
  /** True when a newer book arrived during the latency (version changed). */
  book_changed?: boolean;
  /** Five-level book at execution — the audit record of the fill. */
  executed_depth: BoxDepthSnapshot | null;
}

/**
 * The complete record of one simulated execution: what was seen, what could
 * actually have been filled, and how far apart they were.
 */
export interface BoxExecutionRecord {
  mode: ExecutionMode;
  detected_at: number;
  /** detected_at + decision delay + send latency. */
  order_sent_at: number;
  executed_at: number | null;
  /** executed_at - detected_at: the real answer to "how late is the fill". */
  decision_to_fill_ms: number | null;
  simulated_decision_ms: number;
  simulated_latency_ms: number;
  detection_quote_version: number | null;
  execution_quote_version: number | null;
  /** Box value per unit at detection and at execution. */
  detected_net_debit_per_unit: number | null;
  executed_net_debit_per_unit: number | null;
  detected_gross_edge: number | null;
  executed_gross_edge: number | null;
  /** Sum of the four legs' slippage, in ₹ (positive = worse than detected). */
  total_slippage: number;
  legs: BoxExecutionLeg[];
  filled: boolean;
  failure_reason: BoxExecutionFailureReason | null;
  failure_detail: string | null;
}

/* -------------------------------------------------------------------------- */
/*  paper_legging — four independent orders, not one atomic box                */
/* -------------------------------------------------------------------------- */

/** How the four legs are submitted in paper_legging. */
export type BoxLegExecutionMode = "parallel" | "sequential";

/**
 * The lifecycle state of one simulated leg order.
 *
 * UNWIND_FAILED is distinct from FAILED: the leg DID fill, and the attempt to
 * reverse it found no opposite touch — so simulated exposure is still outstanding
 * and must be visible rather than folded into a generic failure.
 */
export type PaperLegStatus =
  | "PENDING"
  | "FILLED"
  | "FAILED"
  | "UNWOUND"
  | "UNWIND_FAILED";

/**
 * One leg's independent execution attempt under paper_legging.
 *
 * Every price here is an observed executable touch from a real WebSocket book at
 * the leg's own simulated arrival time — never invented.
 */
export interface PaperLegExecution {
  role: BoxLegRole;
  side: OrderSide;
  token: number;
  tradingsymbol: string;
  /** The touch visible when the box was detected. */
  detected_price: number | null;
  detected_qty: number;
  submit_at: number;
  /** submit + per-leg network/broker latency. */
  arrival_at: number;
  /** When the fill (or failure) resolved. */
  resolved_at: number | null;
  fill_price: number | null;
  quantity: number;
  quote_version: number | null;
  /** Book age at the leg's arrival (ms). */
  book_age_ms: number | null;
  /** fill − detected, signed so positive is always worse (₹, whole lot). */
  slippage: number | null;
  status: PaperLegStatus;
  /** If the leg had to be unwound, the opposite-touch price it was closed at. */
  unwind_price: number | null;
  unwind_slippage: number | null;
  fail_reason: string | null;
}

/**
 * The complete record of one paper_legging execution — whether it opened a box
 * (4/4 filled) or aborted (some legs filled, others failed → emergency unwind).
 *
 * When it aborts it still costs money: partial-entry charges on the filled legs
 * plus the charges and adverse touch of unwinding them. That legging loss is the
 * whole reason this model exists.
 */
export interface PaperLeggingExecutionRecord {
  mode: "paper_legging";
  leg_execution_mode: BoxLegExecutionMode;
  detected_at: number;
  order_sent_at: number;
  /** 0..4 */
  filled_leg_count: number;
  /** True only when all four legs filled and a box position was opened. */
  opened: boolean;
  /** Roles that failed to fill (empty on a clean 4/4). */
  failed_legs: BoxLegRole[];
  legs: PaperLegExecution[];
  /** Detection → last leg resolution (ms). */
  first_to_last_fill_ms: number | null;
  decision_to_complete_ms: number | null;
  /** Sum of per-leg entry slippage across FILLED legs (₹). */
  total_entry_slippage: number;
  /** ABORT accounting (all null / 0 on a clean open). */
  emergency_unwind: boolean;
  partial_entry_charges: number | null;
  unwind_charges: number | null;
  /** Gross loss from the round-trip of the partially-filled legs (₹, ≤ 0). */
  legging_gross_loss: number | null;
  /** legging_gross_loss − partial_entry_charges − unwind_charges (₹, ≤ 0). */
  legging_net_loss: number | null;
  /**
   * True when all four legs FILLED but the final qualification on the executed
   * prices failed, so the complete box had to be reversed straight away.
   *
   * Distinct from a partial-fill abort: there was no legging *risk* here (the box
   * was briefly complete and hedged), only an economics failure — the cost is the
   * round-trip spread and charges on all four legs.
   */
  abort_after_fill: boolean;
  /** Expected net profit recomputed on the EXECUTED prices (₹). */
  final_expected_net_profit: number | null;
  /** The gate that figure was tested against (₹). */
  required_expected_net_profit: number | null;
  failure_reason: BoxExecutionFailureReason | null;
  failure_detail: string | null;
}

/** A persisted record of an execution ATTEMPT that did not open a box. */
export interface IBoxExecutionAttempt {
  candidate_key: string;
  direction: BoxDirection;
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  lower_strike: number;
  upper_strike: number;
  lot_size: number;
  quantity: number;
  execution_mode: ExecutionMode;
  leg_execution_mode: BoxLegExecutionMode | null;
  detected_at: Date;
  resolved_at: Date;
  /** The gross edge that was detected. */
  detected_gross_edge: number | null;
  /** The expected net profit the entry was chasing. */
  expected_net_profit: number | null;
  /** The gate the attempt had to clear (₹) — so a miss can be sized, not guessed. */
  required_expected_net_profit?: number | null;
  /**
   * True for the EXECUTION_ABORT_AFTER_FILL case: 4/4 filled, economics failed on
   * the executed prices, whole box reversed immediately.
   */
  abort_after_fill?: boolean;
  filled_leg_count: number;
  failed_legs: BoxLegRole[];
  failure_reason: BoxExecutionFailureReason | null;
  failure_detail: string | null;
  legging: PaperLeggingExecutionRecord | null;
  /** ABORT accounting, hoisted for easy querying. */
  partial_entry_charges: number | null;
  unwind_charges: number | null;
  gross_abort_pnl: number | null;
  net_abort_pnl: number | null;
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
  /** The touch that was DETECTED, before the simulated latency (nullable). */
  detected_price?: number | null;
  /** entry_price - detected_price, signed so positive is always worse. */
  entry_slippage?: number | null;

  exit_price: number | null;
  exit_bid: number | null;
  exit_bid_qty: number | null;
  exit_ask: number | null;
  exit_ask_qty: number | null;
  exit_quote_at: Date | null;
  exit_depth: BoxDepthSnapshot | null;
  exit_detected_price?: number | null;
  exit_slippage?: number | null;
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

/** Why an exit that the rules wanted did not happen. */
export type BoxExitBlockedReason =
  | "insufficient_exit_liquidity"
  | "net_below_floor"
  | "unpriced_charges"
  | "market_closed"
  | "feed_unhealthy"
  | null;

/** The scanner settings a trade was taken under (frozen onto the document). */
export interface BoxScannerConfigSnapshot {
  /** The gross PREFILTER (₹) this trade cleared before costs were considered. */
  min_gross_edge: number;
  /** Legacy net floor (0 = none). Superseded by min_expected_net_profit. */
  min_net_edge: number;
  /** THE ENTRY GATE: minimum expected NET profit (₹) after every cost. */
  min_expected_net_profit?: number;
  safety_buffer: number;
  /** Allowances used when a real measurement was not available yet (₹). */
  expected_entry_slippage?: number;
  expected_exit_slippage?: number;
  quote_max_age_ms: number;
  strikes_each_side: number;
  convergence_floor: number;
  convergence_pct: number;
  min_exit_net_pnl: number;
  profit_capture_pct: number;
  /** Fraction of the ORIGINAL edge that alone justifies taking profit. */
  min_captured_pct?: number;
  execution_mode: ExecutionMode;
  simulated_decision_ms?: number;
  simulated_latency_ms?: number;
}

/** A persisted box paper trade. */
export interface IBoxTrade {
  execution_mode: ExecutionMode;

  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;

  /**
   * Which way the box was traded. OPTIONAL on purpose: documents written before
   * short boxes existed have no such field and must keep loading — they are all
   * long boxes, and `directionOf()` resolves them to LONG_BOX.
   */
  direction?: BoxDirection;

  lower_strike: number;
  upper_strike: number;

  lot_size: number;
  quantity: number;

  status: BoxTradeStatus;

  legs: IBoxLeg[];

  box_width: number;

  /**
   * Net span (SPAN + exposure) margin the four legs block together, from
   * Zerodha's basket-margin API priced for all four one-lot orders at once.
   *
   * `null` when it could not be fetched — captured best-effort at entry, exactly
   * like the calendar trade's margin, and never gates a trade.
   */
  margin: number | null;

  /** Signed net debit of the four entry fills (negative = credit received). */
  entry_box_cost: number;
  entry_gross_edge: number;

  entry_charges: BoxChargesWithOrigin | null;
  estimated_exit_charges: BoxChargesWithOrigin | null;
  safety_buffer: number;
  entry_net_edge: number;

  /** The decisive figure at entry: expected net profit after every cost. */
  expected_net_profit?: number | null;
  /** Execution/slippage cost carried into that decision (₹). */
  entry_execution_cost?: number | null;
  /** Where the entry charge numbers came from. */
  charge_origin?: BoxChargeOrigin;
  /** Zerodha's verdict on the local entry/exit charge calculation. */
  entry_charge_reconciliation?: BoxChargeReconciliation | null;
  exit_charge_reconciliation?: BoxChargeReconciliation | null;

  /** The full detection → execution audit record for the entry. */
  entry_execution?: BoxExecutionRecord | null;
  /** The per-leg legging record when the entry used paper_legging (4/4 fill). */
  entry_legging?: PaperLeggingExecutionRecord | null;
  /** The same for the exit. */
  exit_execution?: BoxExecutionRecord | null;

  opened_at: Date;

  /** Latest computed residual convergence, refreshed by the monitor. */
  current_remaining_edge: number | null;
  /** Latest captured edge and percentage, refreshed by the monitor. */
  current_captured_edge?: number | null;
  current_captured_pct?: number | null;

  exit_box_value: number | null;
  exit_charges: BoxChargesWithOrigin | null;

  gross_pnl: number | null;
  total_charges: number | null;
  net_pnl: number | null;
  /**
   * The REALISED net P&L of a closed trade: actual simulated gross from the
   * recorded fills, minus actual entry and exit charges. No expected-slippage
   * allowance — that forward estimate disappears once the real exit price is
   * known. On an OPEN trade this is null. Mirrors `net_pnl` for closed trades,
   * named explicitly so "expected / current / realisable / realised" never blur.
   */
  realised_net_pnl?: number | null;

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
  /** The expected-net-profit gate refused it. */
  | "ENTRY_REJECTED_NET_PROFIT"
  /** The simulated execution after the latency delay could not fill. */
  | "ENTRY_REJECTED_EXECUTION"
  | "EXIT_TRIGGERED"
  | "EXIT"
  | "EXIT_SKIPPED_LIQUIDITY"
  | "EXPIRY_SAFETY"
  | "CHARGES_RECONCILED"
  /** paper_legging: some legs filled, the box aborted and was unwound. */
  | "EXECUTION_ABORTED"
  | "SCANNER_STARTED"
  | "SCANNER_STOPPED"
  | "ERROR";

/** One immutable decision snapshot in the box ledger. */
export interface IBoxTradeEvent {
  event: BoxEventType;
  at: Date;
  /** Set once a trade document exists. */
  trade_id: string | null;
  /** underlying|expiry|K1|K2|DIRECTION — present even for rejections. */
  candidate_key: string;
  underlying: string;
  expiry: string;
  direction?: BoxDirection;
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
  expected_net_profit?: number | null;
  execution_cost?: number | null;
  gross_pnl: number | null;
  net_pnl: number | null;
  remaining_edge: number | null;
  captured_edge?: number | null;
  captured_pct?: number | null;
  /** Simulated-execution audit for entry/exit events. */
  execution?: BoxExecutionRecord | null;

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

/* -------------------------------------------------------------------------- */
/*  Exit / convergence                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The structured verdict of the exit rules — ONE decision object instead of a
 * handful of scattered booleans.
 *
 * `rule_reason` is what the arithmetic concludes; `should_exit` additionally
 * requires an executable four-leg market. Keeping them apart is what lets the
 * monitor record "should close but cannot" (EXIT_SKIPPED_LIQUIDITY) rather than
 * silently doing nothing.
 */
export interface BoxExitDecision {
  should_exit: boolean;
  reason: BoxExitReason | null;
  rule_reason: BoxExitReason | null;
  /** Mispricing still outstanding (₹). Falls towards 0 as the box converges. */
  remaining_edge: number | null;
  /** entryEdge - remainingEdge: how much of the original edge has been earned. */
  captured_edge: number | null;
  /** captured_edge / |entry edge|. */
  captured_pct: number | null;
  gross_pnl: number | null;
  net_pnl: number | null;
  /** All four reversed legs fresh and one-lot fillable right now. */
  executable: boolean;
  blocked_reason: BoxExitBlockedReason;
}

/** Live exit metrics for an open trade, recomputed from the executable book. */
export interface BoxExitMetrics {
  at: number;
  direction: BoxDirection;
  legs: BoxLegEvaluation[];
  /**
   * Net CREDIT per unit received by unwinding: sum of (+price for every closing
   * SELL, -price for every closing BUY). For a long box this is the familiar
   * Bid(K1CE) - Ask(K2CE) + Bid(K2PE) - Ask(K1PE).
   */
  exit_net_credit_per_unit: number | null;
  /** Same number under its original name. */
  exit_box_value_per_unit: number | null;
  exit_box_value: number | null;
  gross_pnl_if_closed_now: number | null;
  estimated_exit_charges: number | null;
  total_round_trip_charges: number | null;
  current_net_pnl: number | null;
  /** Execution/slippage allowance for the unwind carried in the decision (₹). */
  estimated_execution_cost: number;
  /** Net P&L after the execution allowance — what an exit realistically nets. */
  realisable_net_pnl: number | null;
  /** Mispricing still outstanding (₹). */
  remaining_edge: number | null;
  /** Original entry edge (₹), the reference every capture figure is against. */
  entry_edge: number;
  captured_edge: number | null;
  captured_pct: number | null;
  /** max(floor, pct * entry expected net edge). */
  convergence_threshold: number;
  min_exit_net_pnl: number;
  profit_capture_target: number;
  min_captured_pct: number;
  time_in_trade_ms: number | null;
  liquidity_ok: boolean;
  worst_age_ms: number | null;
  /** What the EXIT ARITHMETIC alone concludes, ignoring fillability. */
  rule_reason: BoxExitReason | null;
  /** rule_reason AND a fresh, one-lot-executable four-leg market. */
  exit_eligible: boolean;
  exit_reason: BoxExitReason | null;
  /** Why the rules are holding, or why an eligible exit is blocked. */
  blocked_reason: BoxExitBlockedReason;
  /** The full structured decision this metrics object was derived from. */
  decision: BoxExitDecision;
}

/**
 * The direction of a stored document.
 *
 * Old box documents predate short boxes and carry no `direction`. They are all
 * long boxes, so an absent field resolves to LONG_BOX rather than failing to
 * load — that is the whole backwards-compatibility contract.
 */
export function directionOf(doc: { direction?: BoxDirection | null }): BoxDirection {
  return doc.direction === "SHORT_BOX" ? "SHORT_BOX" : "LONG_BOX";
}

/** Human label for a direction, used in logs and the UI. */
export function directionLabel(direction: BoxDirection): string {
  return direction === "SHORT_BOX" ? "SHORT BOX" : "LONG BOX";
}
