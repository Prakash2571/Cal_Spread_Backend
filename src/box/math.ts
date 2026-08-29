/**
 * The Box arbitrage mathematical core.
 *
 * Every function here is PURE: no clock, no network, no database. The engine
 * feeds it quotes and configuration and it returns decisions. That is what makes
 * the trading rules deterministically testable.
 *
 * Two rules are absolute throughout this file:
 *
 *   1. Prices come from the EXECUTABLE TOUCH ONLY. A BUY fills at the best ask
 *      and a SELL fills at the best bid. LTP, mid-price and theoretical values
 *      are never used to size, qualify or close a trade.
 *   2. A leg is only executable if the ENTIRE lot is available AT that exact
 *      best price. V1 never walks deeper levels.
 */

import type { BoxConfig } from "./config.js";
import {
  BOX_ENTRY_SIDES,
  BOX_LEG_ROLES,
  type BoxCandidate,
  type BoxEvaluation,
  type BoxExitMetrics,
  type BoxExitReason,
  type BoxLegEvaluation,
  type BoxLegRole,
  type BoxOptionInstrument,
  type BoxQuote,
  type BoxRejectReason,
  type OrderSide,
} from "./types.js";

/** Round money to paise so float noise never reaches the ledger. */
export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/* -------------------------------------------------------------------------- */
/*  Touch prices                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The best price on one side of the book: highest bid, lowest ask.
 *
 * Computed rather than trusting array order, so a reordered or padded depth
 * payload can never hand back a worse level as if it were the touch. Returns
 * null when that side is empty, so callers refuse the trade instead of inventing
 * a fill from a last-traded price.
 */
export function bestPrice(
  levels: { price: number; qty: number }[],
  side: "bid" | "ask",
): number | null {
  let best: number | null = null;
  for (const lv of levels) {
    if (!(lv.price > 0)) continue;
    if (best === null) best = lv.price;
    else best = side === "bid" ? Math.max(best, lv.price) : Math.min(best, lv.price);
  }
  return best;
}

/**
 * Total quantity resting at EXACTLY the given price on one side.
 *
 * Summed across levels because an exchange can report the same price twice in a
 * padded depth payload. Quantity at deeper (worse) prices is deliberately
 * ignored: V1 does not walk the book.
 */
export function qtyAtPrice(
  levels: { price: number; qty: number }[],
  price: number,
): number {
  let qty = 0;
  for (const lv of levels) {
    if (lv.price === price && lv.qty > 0) qty += lv.qty;
  }
  return qty;
}

/**
 * The executable touch for one side of a trade, with the size available there.
 *
 * `bid`/`ask` fields on a tick are used only as a fallback when the five-level
 * depth is absent; the quantity then has to come from the depth, so a book with
 * no depth can never satisfy the one-lot test (which is the safe outcome).
 */
export function touchFor(
  quote: BoxQuote,
  side: OrderSide,
): { price: number | null; qty: number } {
  if (side === "BUY") {
    const price = bestPrice(quote.asks, "ask") ?? (quote.ask > 0 ? quote.ask : null);
    if (price === null) return { price: null, qty: 0 };
    const qty = qtyAtPrice(quote.asks, price) || (quote.ask === price ? quote.ask_qty : 0);
    return { price, qty };
  }
  const price = bestPrice(quote.bids, "bid") ?? (quote.bid > 0 ? quote.bid : null);
  if (price === null) return { price: null, qty: 0 };
  const qty = qtyAtPrice(quote.bids, price) || (quote.bid === price ? quote.bid_qty : 0);
  return { price, qty };
}

/* -------------------------------------------------------------------------- */
/*  Strike window: ATM ± 3                                                    */
/* -------------------------------------------------------------------------- */

/** The strike closest to spot. Ties resolve to the lower strike. */
export function atmStrikeFor(strikes: number[], spot: number): number | null {
  if (strikes.length === 0) return null;
  const sorted = [...strikes].sort((a, b) => a - b);
  let best = sorted[0]!;
  let bestDist = Math.abs(best - spot);
  for (const s of sorted) {
    const d = Math.abs(s - spot);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

/** Median gap between adjacent strikes — the chain's strike step. */
export function strikeStepOf(strikes: number[]): number {
  const sorted = [...new Set(strikes)].sort((a, b) => a - b);
  if (sorted.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i]! - sorted[i - 1]!);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)]!;
}

/**
 * The V1 monitored window: the ATM strike plus up to three strikes each side,
 * taken from the strikes that ACTUALLY EXIST in the chain.
 *
 * At most seven strikes come back — never more. Near the end of a chain fewer
 * are returned rather than reaching further in the other direction, because a
 * lopsided window would silently change which strikes are monitored.
 */
export function selectStrikeWindow(
  strikes: number[],
  spot: number,
  eachSide = 3,
): { atm: number; window: number[] } | null {
  const sorted = [...new Set(strikes)].sort((a, b) => a - b);
  const atm = atmStrikeFor(sorted, spot);
  if (atm === null) return null;
  const idx = sorted.indexOf(atm);
  const lo = Math.max(0, idx - eachSide);
  const hi = Math.min(sorted.length - 1, idx + eachSide);
  return { atm, window: sorted.slice(lo, hi + 1) };
}

/**
 * Whether the ATM window should be re-centred.
 *
 * The spot must move PAST the midpoint between the current ATM and its
 * neighbour by an extra fraction of a strike step (the hysteresis band) before
 * the window moves. Without that band a price sitting exactly on a strike
 * boundary would resubscribe the whole window on alternating ticks.
 */
export function shouldRecentreWindow(
  currentAtm: number,
  spot: number,
  strikeStep: number,
  hysteresis: number,
): boolean {
  if (!(strikeStep > 0)) return false;
  const drift = Math.abs(spot - currentAtm);
  return drift > strikeStep * (0.5 + hysteresis);
}

/* -------------------------------------------------------------------------- */
/*  Candidate construction: at most C(7,2) = 21 pairs                         */
/* -------------------------------------------------------------------------- */

/** Stable identity of a box: one open box per exact strike pair. */
export function candidateKey(
  underlying: string,
  expiry: string,
  k1: number,
  k2: number,
): string {
  return `${underlying}|${expiry}|${k1}|${k2}`;
}

/**
 * Every distinct strike pair K1 < K2 in the window.
 *
 * Seven strikes give exactly C(7,2) = 21 pairs, which is the entire V1 search
 * space for one underlying. A pair is skipped when either strike is missing a CE
 * or a PE, since all four legs are required to form a box.
 */
export function buildCandidates(args: {
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  lot_size: number;
  strikes: number[];
  ce: Map<number, BoxOptionInstrument>;
  pe: Map<number, BoxOptionInstrument>;
}): BoxCandidate[] {
  const sorted = [...new Set(args.strikes)].sort((a, b) => a - b);
  const out: BoxCandidate[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const k1 = sorted[i]!;
      const k2 = sorted[j]!;
      const k1ce = args.ce.get(k1);
      const k2ce = args.ce.get(k2);
      const k2pe = args.pe.get(k2);
      const k1pe = args.pe.get(k1);
      if (!k1ce || !k2ce || !k2pe || !k1pe) continue;
      out.push({
        key: candidateKey(args.underlying, args.expiry, k1, k2),
        underlying: args.underlying,
        name: args.name,
        is_index: args.is_index,
        expiry: args.expiry,
        lower_strike: k1,
        upper_strike: k2,
        box_width: round2(k2 - k1),
        lot_size: args.lot_size,
        legs: { k1_ce: k1ce, k2_ce: k2ce, k2_pe: k2pe, k1_pe: k1pe },
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Entry evaluation                                                          */
/* -------------------------------------------------------------------------- */

function evaluateLeg(args: {
  role: BoxLegRole;
  side: OrderSide;
  inst: BoxOptionInstrument;
  quote: BoxQuote | undefined;
  lotSize: number;
  now: number;
  maxAgeMs: number;
  /** Reverse the entry side — used to price an exit. */
}): BoxLegEvaluation {
  const { role, side, inst, quote, lotSize, now, maxAgeMs } = args;
  if (!quote) {
    return {
      role,
      side,
      token: inst.token,
      tradingsymbol: inst.tradingsymbol,
      strike: inst.strike,
      instrument_type: inst.instrument_type,
      price: null,
      qty_at_touch: 0,
      bid: 0,
      bid_qty: 0,
      ask: 0,
      ask_qty: 0,
      quote_at: null,
      age_ms: null,
      fresh: false,
      executable: false,
    };
  }
  const age = now - quote.at;
  const fresh = age >= 0 ? age <= maxAgeMs : false;
  const touch = touchFor(quote, side);
  return {
    role,
    side,
    token: inst.token,
    tradingsymbol: inst.tradingsymbol,
    strike: inst.strike,
    instrument_type: inst.instrument_type,
    price: touch.price,
    qty_at_touch: touch.qty,
    bid: quote.bid,
    bid_qty: quote.bid_qty,
    ask: quote.ask,
    ask_qty: quote.ask_qty,
    quote_at: quote.at,
    age_ms: age,
    fresh,
    // One ENTIRE lot must rest at the exact touch price.
    executable: touch.price !== null && touch.price > 0 && touch.qty >= lotSize,
  };
}

/** The first blocking reason across the four legs, in priority order. */
function firstRejectReason(
  legs: BoxLegEvaluation[],
  lotSize: number,
): BoxRejectReason | null {
  for (const l of legs) if (l.quote_at === null) return "no_quote";
  for (const l of legs) if (!l.fresh) return "stale_quote";
  for (const l of legs) {
    if (l.price === null || !(l.price > 0)) {
      return l.side === "BUY" ? "missing_ask" : "missing_bid";
    }
  }
  for (const l of legs) if (l.qty_at_touch < lotSize) return "insufficient_qty";
  return null;
}

/**
 * Evaluate one candidate from the executable book.
 *
 *   entryBoxCostPerUnit = Ask(K1 CE) - Bid(K2 CE) + Ask(K2 PE) - Bid(K1 PE)
 *   grossEdgePerUnit    = (K2 - K1) - entryBoxCostPerUnit
 *   grossEdge           = grossEdgePerUnit * lotSize
 *
 * The cost and the edge are reported whenever all four prices exist, even if a
 * leg is stale or too thin, so the UI can show a near-miss. `tradable` is what
 * gates a paper entry.
 */
export function evaluateCandidate(args: {
  candidate: BoxCandidate;
  quotes: Map<number, BoxQuote>;
  now: number;
  maxAgeMs: number;
}): BoxEvaluation {
  const { candidate, quotes, now, maxAgeMs } = args;
  const lotSize = candidate.lot_size;

  const legs: BoxLegEvaluation[] = BOX_LEG_ROLES.map((role) =>
    evaluateLeg({
      role,
      side: BOX_ENTRY_SIDES[role],
      inst: candidate.legs[role],
      quote: quotes.get(candidate.legs[role].token),
      lotSize,
      now,
      maxAgeMs,
    }),
  );

  const byRole = new Map(legs.map((l) => [l.role, l]));
  const k1ce = byRole.get("k1_ce")!;
  const k2ce = byRole.get("k2_ce")!;
  const k2pe = byRole.get("k2_pe")!;
  const k1pe = byRole.get("k1_pe")!;

  const havePrices =
    k1ce.price !== null && k2ce.price !== null && k2pe.price !== null && k1pe.price !== null;

  const costPerUnit = havePrices
    ? round2(k1ce.price! - k2ce.price! + k2pe.price! - k1pe.price!)
    : null;
  const grossPerUnit = costPerUnit === null ? null : round2(candidate.box_width - costPerUnit);
  const grossEdge = grossPerUnit === null ? null : round2(grossPerUnit * lotSize);

  const ages = legs.map((l) => l.age_ms).filter((a): a is number => a !== null);
  const worstAge = ages.length === 4 ? Math.max(...ages) : null;

  const reject = firstRejectReason(legs, lotSize);
  const tradable = reject === null && grossEdge !== null;

  return {
    candidate,
    at: now,
    legs,
    entry_box_cost_per_unit: costPerUnit,
    gross_edge_per_unit: grossPerUnit,
    gross_edge: grossEdge,
    tradable,
    worst_age_ms: worstAge,
    reject,
  };
}

/**
 * The after-cost picture, reported on every opportunity and stored on every
 * trade:
 *
 *   projectedNetEdge = grossEdge - entryFees - estimatedExitFees - safetyBuffer
 *
 * This is INFORMATIONAL by default. The entry gate is the gross spread (see
 * qualifiesForEntry) — fees are shown so they can be managed, not deducted
 * before deciding to trade, unless an explicit net floor is configured.
 */
export function projectedNetEdge(args: {
  grossEdge: number;
  entryCharges: number;
  estimatedExitCharges: number;
  safetyBuffer: number;
}): number {
  return round2(
    args.grossEdge - args.entryCharges - args.estimatedExitCharges - args.safetyBuffer,
  );
}

/**
 * THE ENTRY GATE: ₹1,200 from the SPREAD alone.
 *
 *   qualifies = grossEdge >= minGrossEdge
 *               AND (minNetEdge <= 0 OR projectedNetEdge >= minNetEdge)
 *
 * The comparison is `>=`, so exactly ₹1,200 gross qualifies and ₹1,199.99 does
 * not. The net floor is OPTIONAL and disabled by default (minNetEdge = 0): the
 * charges are still estimated, stored and displayed, they simply do not raise the
 * bar the spread has to clear.
 *
 * `netEdge` may be null (charges unavailable); that only matters when a net floor
 * is actually configured.
 */
export function qualifiesForEntry(
  grossEdge: number | null,
  netEdge: number | null,
  cfg: Pick<BoxConfig, "minGrossEdge" | "minNetEdge">,
): boolean {
  if (grossEdge === null) return false;
  if (grossEdge < cfg.minGrossEdge) return false;
  if (cfg.minNetEdge > 0) {
    if (netEdge === null) return false;
    if (netEdge < cfg.minNetEdge) return false;
  }
  return true;
}

/** Whether a candidate's gross edge justifies a (slow) charge estimation. */
export function passesGrossPrefilter(grossEdge: number | null, threshold: number): boolean {
  return grossEdge !== null && grossEdge >= threshold;
}

/* -------------------------------------------------------------------------- */
/*  Indicative evaluation (market closed)                                     */
/* -------------------------------------------------------------------------- */

/**
 * Evaluate a box from LAST TRADED / CLOSING prices instead of the touch.
 *
 * Used only while the market is shut, so an opportunity that existed at the close
 * can still be inspected. This is deliberately a SEPARATE function from
 * evaluateCandidate: there is no bid/ask and therefore no executable price, so
 * the result is always marked `tradable: false` and can never reach the entry
 * path. It is a read-only view, not a trading signal.
 *
 *   indicativeCostPerUnit = Last(K1 CE) - Last(K2 CE) + Last(K2 PE) - Last(K1 PE)
 */
export function evaluateCandidateIndicative(args: {
  candidate: BoxCandidate;
  /** token → last traded / closing price. */
  lastPrices: Map<number, number>;
  now: number;
}): BoxEvaluation {
  const { candidate, lastPrices, now } = args;
  const lotSize = candidate.lot_size;

  const legs: BoxLegEvaluation[] = BOX_LEG_ROLES.map((role) => {
    const inst = candidate.legs[role];
    const last = lastPrices.get(inst.token) ?? 0;
    return {
      role,
      side: BOX_ENTRY_SIDES[role],
      token: inst.token,
      tradingsymbol: inst.tradingsymbol,
      strike: inst.strike,
      instrument_type: inst.instrument_type,
      // The closing price, NOT an executable touch — hence executable: false.
      price: last > 0 ? last : null,
      qty_at_touch: 0,
      bid: 0,
      bid_qty: 0,
      ask: 0,
      ask_qty: 0,
      quote_at: null,
      age_ms: null,
      fresh: false,
      executable: false,
    };
  });

  const havePrices = legs.every((l) => l.price !== null);
  const byRole = new Map(legs.map((l) => [l.role, l]));
  const rawCost = havePrices
    ? round2(
        byRole.get("k1_ce")!.price! -
          byRole.get("k2_ce")!.price! +
          byRole.get("k2_pe")!.price! -
          byRole.get("k1_pe")!.price!,
      )
    : null;

  // PLAUSIBILITY BOUND — the reason this function cannot simply do the arithmetic
  // and publish it.
  //
  // A long box always costs money and can never cost more than it pays, so its
  // cost per unit must sit strictly inside (0, width). Outside that range the
  // inputs are not a coherent snapshot: a NEGATIVE cost implies free money of
  // unlimited size, which no exchange offers, and a cost above the width implies
  // paying more than the guaranteed payoff.
  //
  // It happens because a last-traded price is NOT a closing price for an illiquid
  // option: a strike that has not traded for days carries a price struck when the
  // underlying was somewhere else entirely, and combining four legs each stale
  // from a different session produces an enormous fictional edge. Reporting no
  // edge is the honest answer.
  const plausible =
    rawCost !== null && rawCost > 0 && rawCost < candidate.box_width;

  const costPerUnit = plausible ? rawCost : null;
  const grossPerUnit = costPerUnit === null ? null : round2(candidate.box_width - costPerUnit);
  const grossEdge = grossPerUnit === null ? null : round2(grossPerUnit * lotSize);

  let reject: BoxRejectReason;
  if (!havePrices) reject = "no_quote";
  else if (!plausible) reject = "implausible_close";
  else reject = "market_closed";

  return {
    candidate,
    at: now,
    legs,
    // Deliberately null rather than the raw figure when implausible: a number
    // that cannot be true must not be displayed as though it were.
    entry_box_cost_per_unit: costPerUnit,
    gross_edge_per_unit: grossPerUnit,
    gross_edge: grossEdge,
    // Never tradable: there is no executable book behind these numbers.
    tradable: false,
    worst_age_ms: null,
    reject,
  };
}

/* -------------------------------------------------------------------------- */
/*  Exit evaluation                                                           */
/* -------------------------------------------------------------------------- */

/** The side that CLOSES a leg — the exact reverse of how it was opened. */
export function exitSideFor(role: BoxLegRole): OrderSide {
  return BOX_ENTRY_SIDES[role] === "BUY" ? "SELL" : "BUY";
}

/**
 * Price the unwind of an open box from the executable book.
 *
 * Entry bought K1 CE and K2 PE and sold K2 CE and K1 PE, so the exit sells the
 * two longs into the BID and buys the two shorts back at the ASK:
 *
 *   exitBoxValuePerUnit = Bid(K1 CE) - Ask(K2 CE) + Bid(K2 PE) - Ask(K1 PE)
 *
 * No LTP, no midpoint, no theoretical price.
 */
export function evaluateExitLegs(args: {
  legs: { role: BoxLegRole; inst: BoxOptionInstrument }[];
  quotes: Map<number, BoxQuote>;
  lotSize: number;
  now: number;
  maxAgeMs: number;
}): BoxLegEvaluation[] {
  return args.legs.map(({ role, inst }) =>
    evaluateLeg({
      role,
      side: exitSideFor(role),
      inst,
      quote: args.quotes.get(inst.token),
      lotSize: args.lotSize,
      now: args.now,
      maxAgeMs: args.maxAgeMs,
    }),
  );
}

/** The convergence threshold: max(floor, pct × original entry net edge). */
export function convergenceThreshold(
  entryNetEdge: number,
  cfg: Pick<BoxConfig, "convergenceFloor" | "convergencePct">,
): number {
  return round2(Math.max(cfg.convergenceFloor, cfg.convergencePct * entryNetEdge));
}

/**
 * Full exit arithmetic plus the automatic-close decision for one open box.
 *
 *   exitBoxValue   = exitBoxValuePerUnit * lotSize
 *   grossPnL       = (exitBoxValuePerUnit - entryBoxCostPerUnit) * lotSize
 *   roundTrip      = entryCharges + currentEstimatedExitCharges
 *   currentNetPnL  = grossPnL - roundTrip
 *   remainingEdge  = (boxWidth - exitBoxValuePerUnit) * lotSize
 *
 * A trade auto-closes when EITHER
 *
 *   A) remainingEdge <= max(₹200, 20% of entryNetEdge)  AND  currentNetPnL >= ₹600
 *   B) currentNetPnL >= 75% of entryNetEdge
 *
 * and in BOTH cases only when all four reversed legs have fresh one-lot touch
 * liquidity AND currentNetPnL is strictly positive. Convergence alone never
 * closes a losing or break-even box.
 */
export function computeExitMetrics(args: {
  boxWidth: number;
  lotSize: number;
  entryBoxCostPerUnit: number;
  entryNetEdge: number;
  entryChargesTotal: number | null;
  /** Charges to unwind, priced now; falls back to the stored estimate. */
  currentExitChargesTotal: number | null;
  legs: BoxLegEvaluation[];
  now: number;
  cfg: Pick<
    BoxConfig,
    "convergenceFloor" | "convergencePct" | "minExitNetPnl" | "profitCapturePct"
  >;
}): BoxExitMetrics {
  const { boxWidth, lotSize, entryBoxCostPerUnit, entryNetEdge, legs, now, cfg } = args;

  const byRole = new Map(legs.map((l) => [l.role, l]));
  const k1ce = byRole.get("k1_ce");
  const k2ce = byRole.get("k2_ce");
  const k2pe = byRole.get("k2_pe");
  const k1pe = byRole.get("k1_pe");

  const havePrices =
    !!k1ce?.price && !!k2ce?.price && !!k2pe?.price && !!k1pe?.price;

  // Exit sides: k1_ce and k2_pe are SOLD (bid), k2_ce and k1_pe are BOUGHT (ask).
  const exitValuePerUnit = havePrices
    ? round2(k1ce!.price! - k2ce!.price! + k2pe!.price! - k1pe!.price!)
    : null;
  const exitBoxValue = exitValuePerUnit === null ? null : round2(exitValuePerUnit * lotSize);

  const grossPnl =
    exitValuePerUnit === null
      ? null
      : round2((exitValuePerUnit - entryBoxCostPerUnit) * lotSize);

  const entryCharges = args.entryChargesTotal;
  const exitCharges = args.currentExitChargesTotal;
  const roundTrip =
    entryCharges === null || exitCharges === null
      ? null
      : round2(entryCharges + exitCharges);
  const netPnl = grossPnl === null || roundTrip === null ? null : round2(grossPnl - roundTrip);

  const remainingEdge =
    exitValuePerUnit === null ? null : round2((boxWidth - exitValuePerUnit) * lotSize);

  const threshold = convergenceThreshold(entryNetEdge, cfg);
  const captureTarget = round2(cfg.profitCapturePct * entryNetEdge);

  const liquidityOk = legs.length === 4 && legs.every((l) => l.fresh && l.executable);
  const ages = legs.map((l) => l.age_ms).filter((a): a is number => a !== null);
  const worstAge = ages.length === legs.length && ages.length > 0 ? Math.max(...ages) : null;

  // What the rules conclude from the arithmetic alone.
  //
  // The CRITICAL rule is enforced here: never close on convergence alone. Every
  // automatic exit must be genuinely profitable on the simulated fills after all
  // charges, so a null or non-positive net P&L can never produce a reason.
  let ruleReason: BoxExitReason | null = null;
  if (netPnl !== null && netPnl > 0 && remainingEdge !== null) {
    if (remainingEdge <= threshold && netPnl >= cfg.minExitNetPnl) {
      ruleReason = "EDGE_CONVERGED";
    } else if (netPnl >= captureTarget) {
      ruleReason = "PROFIT_CAPTURE";
    }
  }
  // Whether it can actually be done right now. Deliberately a separate flag: the
  // caller must be able to see "should close but cannot" and record it.
  const eligible = ruleReason !== null && liquidityOk;

  return {
    at: now,
    legs,
    exit_box_value_per_unit: exitValuePerUnit,
    exit_box_value: exitBoxValue,
    gross_pnl_if_closed_now: grossPnl,
    estimated_exit_charges: exitCharges,
    total_round_trip_charges: roundTrip,
    current_net_pnl: netPnl,
    remaining_edge: remainingEdge,
    convergence_threshold: threshold,
    min_exit_net_pnl: cfg.minExitNetPnl,
    profit_capture_target: captureTarget,
    liquidity_ok: liquidityOk,
    worst_age_ms: worstAge,
    rule_reason: ruleReason,
    exit_eligible: eligible,
    exit_reason: eligible ? ruleReason : null,
  };
}

/**
 * Whether all four reversed legs can actually be filled for one whole lot right
 * now. A paper exit is refused rather than faked when this is false.
 */
export function exitLiquidityOk(legs: BoxLegEvaluation[]): boolean {
  return legs.length === 4 && legs.every((l) => l.fresh && l.executable);
}
