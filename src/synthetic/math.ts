/**
 * Futures vs SYNTHETIC futures: the pure core.
 *
 * WHAT IS BEING MEASURED
 * By put-call parity a call bought and a put sold at the same strike K and expiry
 * behave like a long future at K:
 *
 *     synthetic future  =  K + C(K) − P(K)
 *
 * When the listed future of the SAME expiry trades away from that value, the gap
 * can be locked in with three legs:
 *
 *   CONVERSION (the future is cheap):  BUY FUT, SELL CE(K), BUY PE(K)
 *       locked per unit = K + (CE.bid − PE.ask) − FUT.ask
 *   REVERSAL   (the future is rich):   SELL FUT, BUY CE(K), SELL PE(K)
 *       locked per unit = FUT.bid − K − (CE.ask − PE.bid)
 *
 * At expiry the option pair and the future offset exactly whatever the settlement
 * price is, so the locked figure is the gross profit per unit held to expiry.
 *
 * RULES CARRIED OVER FROM BOX (and .kiro/steering/trade-realism.md)
 *   - Prices are the executable TOUCH: a BUY pays the ask, a SELL receives the bid.
 *     LTP is never used as a fill price while the market is open.
 *   - A leg is executable only if a full lot rests at that touch. An empty side
 *     refuses the opportunity. A price is never invented.
 *   - The option expiry MUST equal the future's expiry. Otherwise the legs do not
 *     offset and there is nothing to lock.
 *   - The strike is restricted to ATM, ATM±1, ATM±2 or ATM±3 (the strike level).
 *     Deep strikes have wide books and are where parity "mispricings" are really
 *     just spread.
 *   - Charges are shown beside the gross figure, never silently netted.
 *
 * No clock, no I/O: `now` is always passed in, so every function is deterministic.
 */

import type { Instrument } from "../kite.js";
import type { BrokerId } from "../brokers/types.js";
import type { BoxMarginSource } from "../box/brokerContext.js";
import type { OrderSide } from "../box/types.js";
import { selectStrikeWindow, shouldRecentreWindow, strikeStepOf } from "../box/math.js";
import {
  calculateLegCharges,
  type BoxChargeOrder,
  type BoxChargeRates,
} from "../box/localCharges.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type SynthDirection = "CONVERSION" | "REVERSAL";
export const SYNTH_DIRECTIONS: readonly SynthDirection[] = ["CONVERSION", "REVERSAL"];

export type SynthLegRole = "fut" | "ce" | "pe";
export const SYNTH_LEG_ROLES: readonly SynthLegRole[] = ["fut", "ce", "pe"];

/** The entry side of every leg, per direction. */
export const SYNTH_ENTRY_SIDES: Record<SynthDirection, Record<SynthLegRole, OrderSide>> = {
  CONVERSION: { fut: "BUY", ce: "SELL", pe: "BUY" },
  REVERSAL: { fut: "SELL", ce: "BUY", pe: "SELL" },
};

export interface SynthInstrument {
  token: number;
  tradingsymbol: string;
  exchange: string;
  /** 0 for the future. */
  strike: number;
  instrument_type: "FUT" | "CE" | "PE";
  expiry: string;
  lot_size: number;
  tick_size?: number;
}

/** One underlying: its future and the option chain of the SAME expiry. */
export interface SynthChainIndex {
  underlying: string;
  expiry: string;
  lot_size: number;
  strike_step: number;
  future: SynthInstrument;
  /** Every strike with BOTH a CE and a PE, ascending. */
  strikes: number[];
  ce: Map<number, SynthInstrument>;
  pe: Map<number, SynthInstrument>;
}

/** The board fields this module reads. */
export interface SynthBoardItem {
  symbol: string;
  name: string;
  is_index?: boolean;
}

/** The monitored ATM±N window of one underlying. */
export interface SynthWindow {
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  lot_size: number;
  strike_step: number;
  atm_strike: number;
  strikes: number[];
  future: SynthInstrument;
  ce: Map<number, SynthInstrument>;
  pe: Map<number, SynthInstrument>;
  /** The reference price the window is centred on (future mid or last). */
  ref_price: number;
  window_at: number;
}

/** The book fields the evaluator reads. BoxQuote satisfies this. */
export interface SynthQuoteLike {
  bid: number;
  bid_qty: number;
  ask: number;
  ask_qty: number;
  last: number;
  at: number;
}

export type SynthRejectReason =
  | "no_quote"
  | "stale_quote"
  | "missing_bid"
  | "missing_ask"
  | "insufficient_qty"
  | "below_expected_net_profit"
  | "market_closed"
  /** Market shut and this leg did not trade in the latest session. */
  | "no_close"
  /**
   * Best bid ≥ best ask. Not a state continuous trading can hold, so the snapshot
   * is inconsistent and its touch is not a price that is really available.
   */
  | "crossed_book";

/** OPEN = this exact strike/direction is currently held as a paper position. */
export type SynthStatus = "ELIGIBLE" | "OPEN" | "WATCHING" | "REJECTED" | "INDICATIVE";

/** Why an ELIGIBLE opportunity is not being paper-entered right now. */
export type SynthEntryBlock =
  | "paper_off"
  | "no_db"
  | "feed_stale"
  | "position_open"
  | "entering"
  | "cooldown"
  | "expiry_cutoff"
  | "max_open"
  | "confirming";

export interface SynthLegEvaluation {
  role: SynthLegRole;
  side: OrderSide;
  token: number;
  tradingsymbol: string;
  strike: number;
  instrument_type: "FUT" | "CE" | "PE";
  /** Price used: touch while open (ask for BUY, bid for SELL), last close when shut. */
  price: number | null;
  qty_at_touch: number;
  bid: number;
  bid_qty: number;
  ask: number;
  ask_qty: number;
  last: number;
  age_ms: number | null;
  fresh: boolean;
  executable: boolean;
}

export interface SynthOpportunity {
  key: string;
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  days_to_expiry: number;
  strike: number;
  atm_strike: number;
  /** Signed strike distance from ATM in listed strikes: −3..+3. */
  atm_offset: number;
  strike_step: number;
  lot_size: number;
  quantity: number;
  direction: SynthDirection;
  /** Price of the future leg used (ask for CONVERSION, bid for REVERSAL). */
  future_price: number | null;
  /** K + C − P at the prices actually used for the two option legs. */
  synthetic_price: number | null;
  /** Mid-to-mid basis F − (K + C − P), direction-independent. Informational. */
  mid_basis: number | null;
  /** Locked per unit before carry (the parity gap at the touch). */
  mispricing_per_unit: number | null;
  /** Financing of the net option premium to expiry, per unit (signed). */
  carry_per_unit: number;
  gross_per_unit: number | null;
  /** gross_per_unit × quantity (₹). */
  gross_edge: number | null;
  entry_charges: number | null;
  estimated_exit_charges: number | null;
  expected_slippage: number;
  safety_buffer: number;
  /** gross − entry − est. exit − slippage − safety (₹). The ELIGIBLE gate. */
  expected_net_profit: number | null;
  min_expected_net_profit: number;
  rf_pct: number;
  depth_ok: boolean;
  liquidity_ok: boolean;
  worst_age_ms: number | null;
  price_source: "touch" | "last_close";
  status: SynthStatus;
  reject: SynthRejectReason | null;
  /** Set by the engine on ELIGIBLE rows it is not entering, with the reason. */
  entry_blocked: SynthEntryBlock | null;
  /** The open paper position on this exact row (status OPEN), if any. */
  position_id: string | null;
  legs: SynthLegEvaluation[];
  updated_at: number;
}

/* -------------------------------------------------------------------------- */
/*  Universe                                                                  */
/* -------------------------------------------------------------------------- */

function toSynthInstrument(i: Instrument, type: "FUT" | "CE" | "PE"): SynthInstrument {
  const inst: SynthInstrument = {
    token: i.instrument_token,
    tradingsymbol: i.tradingsymbol,
    exchange: i.exchange,
    strike: type === "FUT" ? 0 : i.strike,
    instrument_type: type,
    expiry: i.expiry,
    lot_size: i.lot_size,
  };
  if (i.tick_size > 0) inst.tick_size = i.tick_size;
  return inst;
}

/**
 * For each underlying, pair the NEAREST live future with the option chain of the
 * SAME expiry.
 *
 * Futures are tried nearest-first. Index weeklies have no future, so for NIFTY this
 * lands on the monthly expiry, the only one where parity can be locked. An
 * underlying whose option lot differs from its future lot is skipped, because the
 * legs would not offset one for one.
 */
export function indexSyntheticChains(
  all: Instrument[],
  today: string,
): Map<string, SynthChainIndex> {
  const futures = new Map<string, Instrument[]>();
  // underlying -> expiry -> options
  const options = new Map<string, Map<string, Instrument[]>>();

  for (const i of all) {
    if (i.exchange !== "NFO" || !i.name || !i.expiry || i.expiry < today) continue;
    if (i.instrument_type === "FUT") {
      const arr = futures.get(i.name);
      if (arr) arr.push(i);
      else futures.set(i.name, [i]);
    } else if ((i.instrument_type === "CE" || i.instrument_type === "PE") && i.strike > 0) {
      let byExpiry = options.get(i.name);
      if (!byExpiry) {
        byExpiry = new Map();
        options.set(i.name, byExpiry);
      }
      const arr = byExpiry.get(i.expiry);
      if (arr) arr.push(i);
      else byExpiry.set(i.expiry, [i]);
    }
  }

  const out = new Map<string, SynthChainIndex>();
  for (const [underlying, futs] of futures) {
    const byExpiry = options.get(underlying);
    if (!byExpiry) continue;
    futs.sort((a, b) => a.expiry.localeCompare(b.expiry));
    for (const fut of futs) {
      if (!(fut.lot_size > 0)) continue;
      const contracts = byExpiry.get(fut.expiry);
      if (!contracts) continue;
      const ce = new Map<number, SynthInstrument>();
      const pe = new Map<number, SynthInstrument>();
      let lotMismatch = false;
      for (const c of contracts) {
        if (c.lot_size > 0 && c.lot_size !== fut.lot_size) lotMismatch = true;
        if (c.instrument_type === "CE") ce.set(c.strike, toSynthInstrument(c, "CE"));
        else pe.set(c.strike, toSynthInstrument(c, "PE"));
      }
      if (lotMismatch) break; // a mismatch on the nearest pair means the underlying is unusable
      const strikes = [...ce.keys()].filter((s) => pe.has(s)).sort((a, b) => a - b);
      if (strikes.length === 0) continue;
      out.set(underlying, {
        underlying,
        expiry: fut.expiry,
        lot_size: fut.lot_size,
        strike_step: strikeStepOf(strikes),
        future: toSynthInstrument(fut, "FUT"),
        strikes,
        ce,
        pe,
      });
      break;
    }
  }
  return out;
}

/** Build the ATM±eachSide window around `ref` (the future's price). */
export function buildSynthWindow(args: {
  board: SynthBoardItem;
  chain: SynthChainIndex;
  ref: number;
  eachSide: number;
  now: number;
}): SynthWindow | null {
  const { board, chain, ref, eachSide, now } = args;
  if (!(ref > 0)) return null;
  const picked = selectStrikeWindow(chain.strikes, ref, eachSide);
  if (!picked) return null;
  const ce = new Map<number, SynthInstrument>();
  const pe = new Map<number, SynthInstrument>();
  for (const s of picked.window) {
    const c = chain.ce.get(s);
    const p = chain.pe.get(s);
    if (c && p) {
      ce.set(s, c);
      pe.set(s, p);
    }
  }
  return {
    underlying: chain.underlying,
    name: board.name,
    is_index: board.is_index === true,
    expiry: chain.expiry,
    lot_size: chain.lot_size,
    strike_step: chain.strike_step,
    atm_strike: picked.atm,
    strikes: picked.window.filter((s) => ce.has(s)),
    future: chain.future,
    ce,
    pe,
    ref_price: ref,
    window_at: now,
  };
}

export function synthWindowNeedsRebuild(args: {
  window: SynthWindow;
  ref: number;
  now: number;
  hysteresis: number;
  minIntervalMs: number;
}): boolean {
  const { window, ref, now, hysteresis, minIntervalMs } = args;
  if (!(ref > 0)) return false;
  if (now - window.window_at < minIntervalMs) return false;
  return shouldRecentreWindow(window.atm_strike, ref, window.strike_step, hysteresis);
}

/** Every token in a window: the future plus a CE and a PE per strike. */
export function synthWindowTokens(w: SynthWindow): number[] {
  const out = [w.future.token];
  for (const s of w.strikes) {
    out.push(w.ce.get(s)!.token, w.pe.get(s)!.token);
  }
  return out;
}

/** Tokens a window of `eachSide` would need, for budgeting before it exists. */
export function synthTokensFor(eachSide: number): number {
  return 1 + 2 * (2 * eachSide + 1);
}

/* -------------------------------------------------------------------------- */
/*  Pricing                                                                   */
/* -------------------------------------------------------------------------- */

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Fractional years from now to 15:30 IST on the expiry date (never negative). */
export function yearsToExpiry(expiry: string, now: number): number {
  const settle = Date.parse(`${expiry}T10:00:00Z`); // 15:30 IST
  if (!Number.isFinite(settle)) return 0;
  return Math.max(0, settle - now) / (365 * 24 * 60 * 60 * 1000);
}

export function candidateKeyFor(
  underlying: string,
  expiry: string,
  strike: number,
  direction: SynthDirection,
): string {
  return `${underlying}|${expiry}|${strike}|${direction}`;
}

/** The touch this side trades at: BUY lifts the ask, SELL hits the bid. */
function touch(q: SynthQuoteLike, side: OrderSide): { price: number; qty: number } {
  return side === "BUY" ? { price: q.ask, qty: q.ask_qty } : { price: q.bid, qty: q.bid_qty };
}

function evaluateLeg(args: {
  role: SynthLegRole;
  side: OrderSide;
  inst: SynthInstrument;
  quote: SynthQuoteLike | undefined;
  quantity: number;
  now: number;
  maxAgeMs: number;
}): { leg: SynthLegEvaluation; reject: SynthRejectReason | null } {
  const { role, side, inst, quote, quantity, now, maxAgeMs } = args;
  const base = {
    role,
    side,
    token: inst.token,
    tradingsymbol: inst.tradingsymbol,
    strike: inst.strike,
    instrument_type: inst.instrument_type,
  };
  if (!quote) {
    return {
      leg: {
        ...base, price: null, qty_at_touch: 0, bid: 0, bid_qty: 0, ask: 0, ask_qty: 0,
        last: 0, age_ms: null, fresh: false, executable: false,
      },
      reject: "no_quote",
    };
  }
  const age = Math.max(0, now - quote.at);
  const fresh = age <= maxAgeMs;
  const t = touch(quote, side);
  let reject: SynthRejectReason | null = null;
  if (!(t.price > 0)) reject = side === "BUY" ? "missing_ask" : "missing_bid";
  else if (quote.bid > 0 && quote.ask > 0 && quote.bid >= quote.ask) reject = "crossed_book";
  else if (t.qty < quantity) reject = "insufficient_qty";
  else if (!fresh) reject = "stale_quote";
  return {
    leg: {
      ...base,
      price: t.price > 0 ? t.price : null,
      qty_at_touch: t.qty,
      bid: quote.bid,
      bid_qty: quote.bid_qty,
      ask: quote.ask,
      ask_qty: quote.ask_qty,
      last: quote.last,
      age_ms: age,
      fresh,
      executable: reject === null,
    },
    reject,
  };
}

function mid(q: SynthQuoteLike | undefined): number | null {
  if (!q || !(q.bid > 0) || !(q.ask > 0)) return null;
  return (q.bid + q.ask) / 2;
}

/** One order to be costed: futures legs use the futures card, options the option card. */
export interface SynthChargeOrder {
  role: SynthLegRole;
  side: OrderSide;
  tradingsymbol: string;
  price: number;
}

function flipSide(side: OrderSide): OrderSide {
  return side === "BUY" ? "SELL" : "BUY";
}

/** Total charges (₹) for a set of orders at the given prices. */
export function synthOrderCharges(
  orders: SynthChargeOrder[],
  quantity: number,
  optionRates: BoxChargeRates,
  futuresRates: BoxChargeRates,
): number {
  let total = 0;
  for (const o of orders) {
    const order: BoxChargeOrder = {
      side: o.side,
      tradingsymbol: o.tradingsymbol,
      quantity,
      price: round2(o.price),
    };
    total += calculateLegCharges(order, o.role === "fut" ? futuresRates : optionRates).total;
  }
  return round2(total);
}

/** Entry charges for the three legs, and the estimated cost of unwinding them. */
export function synthCharges(
  legs: SynthChargeOrder[],
  quantity: number,
  optionRates: BoxChargeRates,
  futuresRates: BoxChargeRates,
): { entry: number; exit: number } {
  return {
    entry: synthOrderCharges(legs, quantity, optionRates, futuresRates),
    // Exit projected at the entry prices, the conservative convention Box uses.
    exit: synthOrderCharges(
      legs.map((l) => ({ ...l, side: flipSide(l.side) })),
      quantity,
      optionRates,
      futuresRates,
    ),
  };
}

export interface SynthEvalParams {
  quantity: number;
  now: number;
  quoteMaxAgeMs: number;
  /** Annual risk-free rate in percent, already resolved (admin value or default). */
  rfPct: number;
  includeCarry: boolean;
  minExpectedNetProfit: number;
  safetyBuffer: number;
  expectedSlippage: number;
  optionRates: BoxChargeRates;
  futuresRates: BoxChargeRates;
  /** Market shut: price from last closes, never ELIGIBLE. */
  indicative: boolean;
}

/**
 * Price one strike of a window in one direction.
 *
 * `quoteFor` returns the live book (open market) or a close-only quote
 * (bid = ask = 0, last = close) when `indicative`.
 */
export function evaluateSynthetic(args: {
  window: SynthWindow;
  strike: number;
  direction: SynthDirection;
  quoteFor: (token: number) => SynthQuoteLike | undefined;
  params: SynthEvalParams;
}): SynthOpportunity {
  const { window: w, strike, direction, quoteFor, params: p } = args;
  const sides = SYNTH_ENTRY_SIDES[direction];
  const insts: Record<SynthLegRole, SynthInstrument> = {
    fut: w.future,
    ce: w.ce.get(strike)!,
    pe: w.pe.get(strike)!,
  };
  const quotes: Record<SynthLegRole, SynthQuoteLike | undefined> = {
    fut: quoteFor(insts.fut.token),
    ce: quoteFor(insts.ce.token),
    pe: quoteFor(insts.pe.token),
  };

  const legs: SynthLegEvaluation[] = [];
  let reject: SynthRejectReason | null = null;
  let worstAge: number | null = null;
  const price: Partial<Record<SynthLegRole, number>> = {};

  for (const role of SYNTH_LEG_ROLES) {
    const inst = insts[role];
    const side = sides[role];
    const q = quotes[role];
    if (p.indicative) {
      const last = q?.last ?? 0;
      const leg: SynthLegEvaluation = {
        role, side, token: inst.token, tradingsymbol: inst.tradingsymbol,
        strike: inst.strike, instrument_type: inst.instrument_type,
        price: last > 0 ? last : null, qty_at_touch: 0, bid: 0, bid_qty: 0, ask: 0,
        ask_qty: 0, last, age_ms: null, fresh: false, executable: false,
      };
      legs.push(leg);
      if (last > 0) price[role] = last;
      else reject ??= "no_close";
      continue;
    }
    const r = evaluateLeg({
      role, side, inst, quote: q, quantity: p.quantity, now: p.now, maxAgeMs: p.quoteMaxAgeMs,
    });
    legs.push(r.leg);
    if (r.leg.price !== null) price[role] = r.leg.price;
    if (r.leg.age_ms !== null) worstAge = Math.max(worstAge ?? 0, r.leg.age_ms);
    reject ??= r.reject;
  }

  const years = yearsToExpiry(w.expiry, p.now);
  const fut = price.fut;
  const ce = price.ce;
  const pe = price.pe;

  let synthetic: number | null = null;
  let mispricing: number | null = null;
  let carry = 0;
  if (fut !== undefined && ce !== undefined && pe !== undefined) {
    // The net option premium: received on a conversion (sell CE, buy PE), paid on a
    // reversal (buy CE, sell PE). Either way it is financed until expiry.
    const netPremium = ce - pe;
    synthetic = strike + netPremium;
    mispricing = direction === "CONVERSION" ? synthetic - fut : fut - synthetic;
    if (p.includeCarry && p.rfPct !== 0) {
      const interest = netPremium * (p.rfPct / 100) * years;
      carry = direction === "CONVERSION" ? interest : -interest;
    }
  }

  const futMid = p.indicative ? (quotes.fut?.last || null) : mid(quotes.fut);
  const ceMid = p.indicative ? (quotes.ce?.last || null) : mid(quotes.ce);
  const peMid = p.indicative ? (quotes.pe?.last || null) : mid(quotes.pe);
  const midBasis =
    futMid !== null && ceMid !== null && peMid !== null
      ? round2(futMid - (strike + ceMid - peMid))
      : null;

  const gross = mispricing === null ? null : mispricing + carry;
  const grossEdge = gross === null ? null : round2(gross * p.quantity);

  let entryCharges: number | null = null;
  let exitCharges: number | null = null;
  if (fut !== undefined && ce !== undefined && pe !== undefined) {
    const c = synthCharges(
      [
        { role: "fut", side: sides.fut, tradingsymbol: insts.fut.tradingsymbol, price: fut },
        { role: "ce", side: sides.ce, tradingsymbol: insts.ce.tradingsymbol, price: ce },
        { role: "pe", side: sides.pe, tradingsymbol: insts.pe.tradingsymbol, price: pe },
      ],
      p.quantity,
      p.optionRates,
      p.futuresRates,
    );
    entryCharges = c.entry;
    exitCharges = c.exit;
  }

  const expectedNet =
    grossEdge === null || entryCharges === null || exitCharges === null
      ? null
      : round2(grossEdge - entryCharges - exitCharges - p.expectedSlippage - p.safetyBuffer);

  const depthOk = !p.indicative && legs.every((l) => l.price !== null && l.qty_at_touch >= p.quantity);
  const liquidityOk = !p.indicative && legs.every((l) => l.executable);

  let status: SynthStatus;
  if (p.indicative) {
    status = "INDICATIVE";
    reject ??= "market_closed";
  } else if (reject !== null) {
    status = "REJECTED";
  } else if (expectedNet !== null && expectedNet >= p.minExpectedNetProfit) {
    status = "ELIGIBLE";
  } else {
    status = "WATCHING";
    reject = "below_expected_net_profit";
  }

  const atmIdx = w.strikes.indexOf(w.atm_strike);
  const idx = w.strikes.indexOf(strike);

  return {
    key: candidateKeyFor(w.underlying, w.expiry, strike, direction),
    underlying: w.underlying,
    name: w.name,
    is_index: w.is_index,
    expiry: w.expiry,
    days_to_expiry: round2(years * 365),
    strike,
    atm_strike: w.atm_strike,
    atm_offset: atmIdx >= 0 && idx >= 0 ? idx - atmIdx : 0,
    strike_step: w.strike_step,
    lot_size: w.lot_size,
    quantity: p.quantity,
    direction,
    future_price: fut ?? null,
    synthetic_price: synthetic === null ? null : round2(synthetic),
    mid_basis: midBasis,
    mispricing_per_unit: mispricing === null ? null : round2(mispricing),
    carry_per_unit: round2(carry),
    gross_per_unit: gross === null ? null : round2(gross),
    gross_edge: grossEdge,
    entry_charges: entryCharges,
    estimated_exit_charges: exitCharges,
    expected_slippage: p.expectedSlippage,
    safety_buffer: p.safetyBuffer,
    expected_net_profit: expectedNet,
    min_expected_net_profit: p.minExpectedNetProfit,
    rf_pct: p.rfPct,
    depth_ok: depthOk,
    liquidity_ok: liquidityOk,
    worst_age_ms: worstAge,
    price_source: p.indicative ? "last_close" : "touch",
    status,
    reject,
    entry_blocked: null,
    position_id: null,
    legs,
    updated_at: p.now,
  };
}

const STATUS_RANK: Record<SynthStatus, number> = {
  ELIGIBLE: 0,
  OPEN: 1,
  WATCHING: 2,
  INDICATIVE: 3,
  REJECTED: 4,
};

/** ELIGIBLE first, then by expected net (best first); unpriced last. */
export function sortOpportunities(list: SynthOpportunity[]): SynthOpportunity[] {
  return list.sort((a, b) => {
    const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (r !== 0) return r;
    const an = a.expected_net_profit ?? -Infinity;
    const bn = b.expected_net_profit ?? -Infinity;
    if (an !== bn) return bn - an;
    return a.key.localeCompare(b.key);
  });
}


/* -------------------------------------------------------------------------- */
/*  Paper positions                                                           */
/* -------------------------------------------------------------------------- */
/*
 * A paper position is filled at the touch observed at the decision (BUY at the
 * ask, SELL at the bid, one lot) and closed the same way: the long legs are sold
 * into the bid and the short legs bought back at the ask. No mid, no LTP fill.
 *
 * Held to expiry, the three legs offset exactly (European options), so the
 * position is worth its entry lock whatever the settlement price is. Before
 * expiry its value moves with the basis. The exit rules are Box's, expressed on
 * the same quantities:
 *
 *   entry edge      = entry lock per unit × quantity   (the hold-to-expiry gross)
 *   gross now       = what closing all three legs at the touch returns
 *   remaining edge  = entry edge − gross now           (what holding would still add)
 *   captured        = gross now / |entry edge|
 */

export type SynthExitReason =
  | "EDGE_CONVERGED"
  | "PROFIT_CAPTURE"
  | "EXPIRY_SAFETY"
  /** Still open at expiry: settled at the parity lock. */
  | "EXPIRED"
  | "MANUAL";

export const SYNTH_EXIT_REASONS: readonly SynthExitReason[] = [
  "EDGE_CONVERGED",
  "PROFIT_CAPTURE",
  "EXPIRY_SAFETY",
  "EXPIRED",
  "MANUAL",
];

export type SynthExitBlockedReason =
  | "unpriced"
  | "net_below_floor"
  | "insufficient_exit_liquidity"
  | null;

/** Top of the book at the moment of a fill: up to five levels a side, best first. */
export interface SynthDepth {
  bids: { price: number; qty: number }[];
  asks: { price: number; qty: number }[];
}

/**
 * Every paper leg is a LIMIT order priced at the touch (best ask to buy, best bid
 * to sell) and is only sent when at least one lot rests at that price, so it fills
 * in full at its limit. The `*_bid*`, `*_ask*`, `*_qty_at_touch`, `*_age_ms` and
 * `*_depth` fields record the book that decision was taken on, so a fill can be
 * checked against it. They are optional: trades stored before they existed lack them.
 */
export interface SynthTradeLeg {
  role: SynthLegRole;
  /** The ENTRY side. The closing side is always the opposite. */
  side: OrderSide;
  instrument_type: "FUT" | "CE" | "PE";
  strike: number;
  tradingsymbol: string;
  /**
   * Token in the namespace of the broker that last priced this leg. Informational
   * only: after a restart or broker switch the engine re-resolves the leg by
   * (underlying, expiry, strike, type), never by this number.
   */
  token: number;
  /** Entry fill = the LIMIT price: the best ask for a BUY, the best bid for a SELL. */
  entry_price: number;
  entry_bid: number;
  entry_ask: number;
  entry_bid_qty?: number | null;
  entry_ask_qty?: number | null;
  /** Quantity resting at the entry limit price (always ≥ one lot). */
  entry_qty_at_touch?: number | null;
  /** How long the book had been unchanged when the order was priced (ms). */
  entry_age_ms?: number | null;
  entry_depth?: SynthDepth | null;
  /** Exit fill = the closing LIMIT price: the best bid to sell, the best ask to buy back. */
  exit_price: number | null;
  exit_bid: number | null;
  exit_ask: number | null;
  exit_bid_qty?: number | null;
  exit_ask_qty?: number | null;
  exit_qty_at_touch?: number | null;
  exit_age_ms?: number | null;
  exit_depth?: SynthDepth | null;
}

/** Where a margin figure came from: the active broker's basket-margin calculator. */
export type SynthMarginSource = BoxMarginSource;

/** One paper trade, open or closed. Times are epoch ms; days are IST YYYY-MM-DD. */
export interface SynthTrade {
  id: string;
  status: "open" | "closed";
  key: string;
  broker: BrokerId;
  execution_mode: "paper_touch";
  /** Every leg is a limit order at the touch (see SynthTradeLeg). */
  order_type: "LIMIT";
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  strike: number;
  atm_strike: number;
  atm_offset: number;
  direction: SynthDirection;
  lot_size: number;
  quantity: number;
  opened_at: number;
  opened_day: string;
  legs: SynthTradeLeg[];
  entry_future_price: number;
  entry_synthetic_price: number;
  /** The parity gap locked at the entry touch, per unit (legs only). */
  entry_lock_per_unit: number;
  entry_carry_per_unit: number;
  /** entry_lock_per_unit × quantity: the gross if held to expiry. */
  entry_edge: number;
  /** Including carry: the figure the entry gate used. */
  entry_gross_edge: number;
  entry_charges: number;
  estimated_exit_charges: number;
  /** entry_edge − entry charges − estimated exit charges. The exit thresholds scale on this. */
  entry_net_edge: number;
  expected_net_profit: number;
  min_expected_net_profit: number;
  safety_buffer: number;
  expected_slippage: number;
  rf_pct: number;
  option_rate_version: string;
  futures_rate_version: string;
  closed_at: number | null;
  closed_day: string | null;
  exit_reason: SynthExitReason | null;
  /** Price move only (legs), before charges. */
  gross_pnl: number | null;
  exit_charges: number | null;
  /** Entry + exit charges. */
  total_charges: number | null;
  /** gross − total charges ("after charges"). */
  net_pnl: number | null;
  exit_note: string | null;
  /**
   * Margin the three legs block together (₹), from the broker's basket-margin
   * calculator (hedge benefit included), captured just after entry. Null until the
   * broker has answered, or when it could not be obtained.
   */
  margin: number | null;
  margin_source: SynthMarginSource | null;
  /** Hedge benefit the broker recognised for the basket (₹), when it reports one. */
  margin_hedge_benefit: number | null;
  margin_at: number | null;
  /** Why the margin is missing, when a fetch failed. */
  margin_error: string | null;
}

/** Copy the top of a book (at most five levels a side). */
export function depthOf(q: {
  bids?: { price: number; qty: number }[];
  asks?: { price: number; qty: number }[];
} | undefined): SynthDepth | null {
  if (!q) return null;
  const pick = (levels: { price: number; qty: number }[] | undefined) =>
    (levels ?? []).slice(0, 5).map((l) => ({ price: l.price, qty: l.qty }));
  return { bids: pick(q.bids), asks: pick(q.asks) };
}

/** Open a paper trade at exactly the touch the opportunity was priced at. */
export function openTradeFromOpportunity(args: {
  opp: SynthOpportunity;
  id: string;
  broker: BrokerId;
  now: number;
  day: string;
  optionRateVersion: string;
  futuresRateVersion: string;
  /** The book behind each leg at this instant, recorded as evidence of the fill. */
  depthFor?: (token: number) => SynthDepth | null;
}): SynthTrade | null {
  const { opp } = args;
  if (
    opp.price_source !== "touch" ||
    opp.future_price === null ||
    opp.synthetic_price === null ||
    opp.mispricing_per_unit === null ||
    opp.gross_edge === null ||
    opp.entry_charges === null ||
    opp.estimated_exit_charges === null ||
    opp.expected_net_profit === null
  ) {
    return null;
  }
  const legs: SynthTradeLeg[] = [];
  for (const l of opp.legs) {
    // Never invent a fill: every leg must have had a real touch.
    if (l.price === null || !(l.price > 0) || !l.executable) return null;
    legs.push({
      role: l.role,
      side: l.side,
      instrument_type: l.instrument_type,
      strike: l.strike,
      tradingsymbol: l.tradingsymbol,
      token: l.token,
      entry_price: l.price,
      entry_bid: l.bid,
      entry_ask: l.ask,
      entry_bid_qty: l.bid_qty,
      entry_ask_qty: l.ask_qty,
      entry_qty_at_touch: l.qty_at_touch,
      entry_age_ms: l.age_ms,
      entry_depth: args.depthFor?.(l.token) ?? null,
      exit_price: null,
      exit_bid: null,
      exit_ask: null,
    });
  }
  const entryEdge = round2(opp.mispricing_per_unit * opp.quantity);
  return {
    id: args.id,
    status: "open",
    key: opp.key,
    broker: args.broker,
    execution_mode: "paper_touch",
    order_type: "LIMIT",
    underlying: opp.underlying,
    name: opp.name,
    is_index: opp.is_index,
    expiry: opp.expiry,
    strike: opp.strike,
    atm_strike: opp.atm_strike,
    atm_offset: opp.atm_offset,
    direction: opp.direction,
    lot_size: opp.lot_size,
    quantity: opp.quantity,
    opened_at: args.now,
    opened_day: args.day,
    legs,
    entry_future_price: opp.future_price,
    entry_synthetic_price: opp.synthetic_price,
    entry_lock_per_unit: opp.mispricing_per_unit,
    entry_carry_per_unit: opp.carry_per_unit,
    entry_edge: entryEdge,
    entry_gross_edge: opp.gross_edge,
    entry_charges: opp.entry_charges,
    estimated_exit_charges: opp.estimated_exit_charges,
    entry_net_edge: round2(entryEdge - opp.entry_charges - opp.estimated_exit_charges),
    expected_net_profit: opp.expected_net_profit,
    min_expected_net_profit: opp.min_expected_net_profit,
    safety_buffer: opp.safety_buffer,
    expected_slippage: opp.expected_slippage,
    rf_pct: opp.rf_pct,
    option_rate_version: args.optionRateVersion,
    futures_rate_version: args.futuresRateVersion,
    closed_at: null,
    closed_day: null,
    exit_reason: null,
    gross_pnl: null,
    exit_charges: null,
    total_charges: null,
    net_pnl: null,
    exit_note: null,
    margin: null,
    margin_source: null,
    margin_hedge_benefit: null,
    margin_at: null,
    margin_error: null,
  };
}

export interface SynthExitRules {
  convergenceFloor: number;
  convergencePct: number;
  minExitNetPnl: number;
  profitCapturePct: number;
  minCapturedPct: number;
}

/** One leg as it would be CLOSED now. */
export interface SynthExitLeg {
  role: SynthLegRole;
  /** The closing side (opposite of entry). */
  side: OrderSide;
  tradingsymbol: string;
  token: number;
  entry_price: number;
  /** Closing touch: bid for a SELL, ask for a BUY. */
  price: number | null;
  qty_at_touch: number;
  bid: number;
  bid_qty: number;
  ask: number;
  ask_qty: number;
  /** LTP used for the broker-screen mark (live last, or the last close when shut). */
  ltp: number | null;
  age_ms: number | null;
  fresh: boolean;
  executable: boolean;
  /** Why this leg cannot be closed at the touch right now, or null when it can. */
  reject: SynthRejectReason | null;
}

export interface SynthExitMetrics {
  legs: SynthExitLeg[];
  executable: boolean;
  /** Open P&L marked to LTP, price move only — what a broker screen shows. */
  mtm_ltp: number | null;
  /** Closing all three legs at the touch now, price move only. */
  gross_pnl: number | null;
  exit_charges: number | null;
  total_charges: number | null;
  /** gross_pnl − entry charges − exit charges ("net if closed now"). */
  net_pnl: number | null;
  remaining_edge: number | null;
  captured_edge: number | null;
  captured_pct: number | null;
  convergence_threshold: number;
  profit_capture_target: number;
  min_exit_net_pnl: number;
  expiry_safety: boolean;
  /** The arithmetic says close AND all three legs can be closed. */
  should_exit: boolean;
  reason: SynthExitReason | null;
  /** What the arithmetic concluded before asking whether it is executable. */
  rule_reason: SynthExitReason | null;
  blocked_reason: SynthExitBlockedReason;
}

function instrumentOf(t: SynthTrade, leg: SynthTradeLeg): SynthInstrument {
  return {
    token: leg.token,
    tradingsymbol: leg.tradingsymbol,
    exchange: "NFO",
    strike: leg.strike,
    instrument_type: leg.instrument_type,
    expiry: t.expiry,
    lot_size: t.lot_size,
  };
}

/**
 * Price the unwind of an open paper position and decide whether to close it.
 *
 * Mirrors Box's `evaluateExitDecision`: an early exit needs the net after every
 * charge to clear `minExitNetPnl`, and either the edge to have converged or
 * enough of it to have been captured. A converged position that would close at a
 * loss is held (the lock pays at expiry). Expiry safety overrides profitability
 * but never invents a price.
 */
export function evaluateSynthExit(args: {
  trade: SynthTrade;
  quoteFor: (token: number) => SynthQuoteLike | undefined;
  ltpFor: (token: number) => number | null;
  now: number;
  quoteMaxAgeMs: number;
  expirySafety: boolean;
  rules: SynthExitRules;
  optionRates: BoxChargeRates;
  futuresRates: BoxChargeRates;
}): SynthExitMetrics {
  const { trade: t, rules } = args;
  const legs: SynthExitLeg[] = [];
  const closing: SynthChargeOrder[] = [];
  let gross = 0;
  let priced = true;
  let mtm = 0;
  let marked = true;

  for (const leg of t.legs) {
    const side = flipSide(leg.side);
    const r = evaluateLeg({
      role: leg.role,
      side,
      inst: instrumentOf(t, leg),
      quote: args.quoteFor(leg.token),
      quantity: t.quantity,
      now: args.now,
      maxAgeMs: args.quoteMaxAgeMs,
    });
    const ltp = args.ltpFor(leg.token);
    legs.push({
      role: leg.role,
      side,
      tradingsymbol: leg.tradingsymbol,
      token: leg.token,
      entry_price: leg.entry_price,
      price: r.leg.price,
      qty_at_touch: r.leg.qty_at_touch,
      bid: r.leg.bid,
      bid_qty: r.leg.bid_qty,
      ask: r.leg.ask,
      ask_qty: r.leg.ask_qty,
      ltp,
      age_ms: r.leg.age_ms,
      fresh: r.leg.fresh,
      executable: r.leg.executable,
      reject: r.reject,
    });
    // A long leg (entered BUY) gains when its price rises, a short leg when it falls.
    const sign = leg.side === "BUY" ? 1 : -1;
    if (r.leg.price === null) priced = false;
    else {
      gross += sign * (r.leg.price - leg.entry_price);
      closing.push({ role: leg.role, side, tradingsymbol: leg.tradingsymbol, price: r.leg.price });
    }
    if (ltp === null || !(ltp > 0)) marked = false;
    else mtm += sign * (ltp - leg.entry_price);
  }

  const grossPnl = priced ? round2(gross * t.quantity) : null;
  const exitCharges = priced
    ? synthOrderCharges(closing, t.quantity, args.optionRates, args.futuresRates)
    : null;
  const totalCharges = exitCharges === null ? null : round2(t.entry_charges + exitCharges);
  const netPnl = grossPnl === null || totalCharges === null ? null : round2(grossPnl - totalCharges);
  const remaining = grossPnl === null ? null : round2(t.entry_edge - grossPnl);
  const capturedPct =
    grossPnl === null || !(Math.abs(t.entry_edge) > 0)
      ? null
      : round2(grossPnl / Math.abs(t.entry_edge));
  const threshold = round2(Math.max(rules.convergenceFloor, rules.convergencePct * t.entry_net_edge));
  const captureTarget = round2(rules.profitCapturePct * t.entry_net_edge);
  const executable = legs.length === 3 && legs.every((l) => l.executable);

  let ruleReason: SynthExitReason | null = null;
  let blocked: SynthExitBlockedReason = null;
  if (netPnl === null) {
    blocked = "unpriced";
  } else if (netPnl > 0 && remaining !== null) {
    const clearsFloor = netPnl >= rules.minExitNetPnl;
    const converged = remaining <= threshold;
    const capturedEnough =
      netPnl >= captureTarget || (capturedPct !== null && capturedPct >= rules.minCapturedPct);
    if (converged && clearsFloor) ruleReason = "EDGE_CONVERGED";
    else if (clearsFloor && capturedEnough) ruleReason = "PROFIT_CAPTURE";
    else if (converged || capturedEnough) blocked = "net_below_floor";
  } else if (remaining !== null && remaining <= threshold) {
    // Converged into a loss: hold, the lock still pays at expiry.
    blocked = "net_below_floor";
  }

  const reason: SynthExitReason | null = executable
    ? (ruleReason ?? (args.expirySafety ? "EXPIRY_SAFETY" : null))
    : null;
  if ((ruleReason !== null || args.expirySafety) && !executable) {
    blocked = "insufficient_exit_liquidity";
  }

  return {
    legs,
    executable,
    mtm_ltp: marked ? round2(mtm * t.quantity) : null,
    gross_pnl: grossPnl,
    exit_charges: exitCharges,
    total_charges: totalCharges,
    net_pnl: netPnl,
    remaining_edge: remaining,
    captured_edge: grossPnl,
    captured_pct: capturedPct,
    convergence_threshold: threshold,
    profit_capture_target: captureTarget,
    min_exit_net_pnl: rules.minExitNetPnl,
    expiry_safety: args.expirySafety,
    should_exit: reason !== null,
    reason,
    rule_reason: ruleReason,
    blocked_reason: blocked,
  };
}

/**
 * Close a trade at the touch priced in `m` (which must be executable): each leg is a
 * closing LIMIT order at the best bid (to sell) or best ask (to buy back).
 */
export function closeTradeAtTouch(
  t: SynthTrade,
  m: SynthExitMetrics,
  reason: SynthExitReason,
  now: number,
  day: string,
  depthFor?: (token: number) => SynthDepth | null,
): SynthTrade | null {
  if (!m.executable || m.gross_pnl === null || m.exit_charges === null) return null;
  const byRole = new Map(m.legs.map((l) => [l.role, l]));
  return {
    ...t,
    status: "closed",
    legs: t.legs.map((leg) => {
      const ex = byRole.get(leg.role);
      return {
        ...leg,
        exit_price: ex?.price ?? null,
        exit_bid: ex ? ex.bid : null,
        exit_ask: ex ? ex.ask : null,
        exit_bid_qty: ex ? ex.bid_qty : null,
        exit_ask_qty: ex ? ex.ask_qty : null,
        exit_qty_at_touch: ex ? ex.qty_at_touch : null,
        exit_age_ms: ex ? ex.age_ms : null,
        exit_depth: ex ? (depthFor?.(ex.token) ?? null) : null,
      };
    }),
    closed_at: now,
    closed_day: day,
    exit_reason: reason,
    gross_pnl: m.gross_pnl,
    exit_charges: m.exit_charges,
    total_charges: round2(t.entry_charges + m.exit_charges),
    net_pnl: round2(m.gross_pnl - t.entry_charges - m.exit_charges),
    exit_note: null,
  };
}

/**
 * A position still open at expiry settles at its parity lock: at settlement the
 * option pair and the future offset exactly, whatever the settlement price.
 *
 * The exit cost is the unwind estimate recorded at entry, used as a conservative
 * stand-in. Exercise STT and physical-delivery charges are not modelled.
 */
export function settleTradeAtExpiry(t: SynthTrade, now: number, day: string): SynthTrade {
  const exitCharges = t.estimated_exit_charges;
  const total = round2(t.entry_charges + exitCharges);
  return {
    ...t,
    status: "closed",
    closed_at: now,
    closed_day: day,
    exit_reason: "EXPIRED",
    gross_pnl: t.entry_edge,
    exit_charges: exitCharges,
    total_charges: total,
    net_pnl: round2(t.entry_edge - total),
    exit_note:
      "Held to expiry and settled at the parity lock. Exit charges are the unwind estimate " +
      "recorded at entry; exercise and delivery charges are not modelled.",
  };
}

export const IST_CLOSE_MINUTES = 15 * 60 + 30;

/** Minutes since IST midnight. */
export function istMinutesOfDay(now: number): number {
  const ist = new Date(now + 5.5 * 60 * 60 * 1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

/** On expiry day, from `minutes` before 15:30 IST. */
export function inExpirySafetyWindow(
  expiry: string,
  today: string,
  now: number,
  minutes: number,
): boolean {
  return expiry === today && istMinutesOfDay(now) >= IST_CLOSE_MINUTES - minutes;
}

/** Past expiry, or expiry day after the close with the market shut. */
export function isPastSettlement(
  expiry: string,
  today: string,
  now: number,
  marketOpen: boolean,
): boolean {
  if (expiry < today) return true;
  return expiry === today && !marketOpen && istMinutesOfDay(now) >= IST_CLOSE_MINUTES;
}

export interface SynthDayPnl {
  day: string;
  open_count: number;
  /** Σ open P&L at LTP, price move only (the broker-screen figure). */
  open_mtm_ltp: number;
  /** Open positions whose LTP mark is incomplete, excluded from the sum above. */
  open_unmarked_count: number;
  /** Σ closing-now gross at the touch. */
  open_running_gross_pnl: number;
  /** Σ closing-now net after entry + exit charges. */
  open_running_net_pnl: number;
  /** Open positions with no closing price on some leg, excluded from the two sums above. */
  open_unpriced_count: number;
  closed_count: number;
  closed_realised_gross_pnl: number;
  closed_charges: number;
  closed_realised_net_pnl: number;
  /** open running net + closed realised net. */
  total_net_pnl: number;
  /** open running gross + closed realised gross (before charges). */
  total_gross_pnl: number;
  /** Σ margin the open positions block now (₹); positions without a figure are excluded. */
  open_margin: number;
  open_margin_unknown: number;
  /** Σ margin of the positions closed today (₹). A day SUM, not a concurrent peak. */
  closed_margin: number;
  closed_margin_unknown: number;
}

export function computeSynthDayPnl(args: {
  day: string;
  open: {
    mtm_ltp: number | null;
    gross_pnl: number | null;
    net_pnl: number | null;
    margin: number | null;
  }[];
  closedToday: SynthTrade[];
}): SynthDayPnl {
  let mtm = 0;
  let unmarked = 0;
  let openGross = 0;
  let openNet = 0;
  let unpriced = 0;
  let openMargin = 0;
  let openMarginUnknown = 0;
  for (const o of args.open) {
    if (o.margin === null) openMarginUnknown++;
    else openMargin += o.margin;
    if (o.mtm_ltp === null) unmarked++;
    else mtm += o.mtm_ltp;
    if (o.gross_pnl === null || o.net_pnl === null) unpriced++;
    else {
      openGross += o.gross_pnl;
      openNet += o.net_pnl;
    }
  }
  let gross = 0;
  let charges = 0;
  let net = 0;
  let closedMargin = 0;
  let closedMarginUnknown = 0;
  for (const t of args.closedToday) {
    gross += t.gross_pnl ?? 0;
    charges += t.total_charges ?? 0;
    net += t.net_pnl ?? 0;
    // `?? null` because trades stored before margin existed have no field at all.
    const m = t.margin ?? null;
    if (m === null) closedMarginUnknown++;
    else closedMargin += m;
  }
  return {
    day: args.day,
    open_count: args.open.length,
    open_mtm_ltp: round2(mtm),
    open_unmarked_count: unmarked,
    open_running_gross_pnl: round2(openGross),
    open_running_net_pnl: round2(openNet),
    open_unpriced_count: unpriced,
    closed_count: args.closedToday.length,
    closed_realised_gross_pnl: round2(gross),
    closed_charges: round2(charges),
    closed_realised_net_pnl: round2(net),
    total_net_pnl: round2(openNet + net),
    total_gross_pnl: round2(openGross + gross),
    open_margin: Math.round(openMargin),
    open_margin_unknown: openMarginUnknown,
    closed_margin: Math.round(closedMargin),
    closed_margin_unknown: closedMarginUnknown,
  };
}

/**
 * The basket-margin orders for a trade's three ENTRY legs.
 *
 * All three go in ONE request with their real sides, so the broker recognises the
 * hedge between the future and the option pair. They are the exact LIMIT orders the
 * paper fill assumed (entry price, one lot, carry-forward product), so the figure is
 * reproducible. Margining the legs one by one would overstate the requirement.
 */
export function synthMarginOrders(t: SynthTrade): {
  exchange: string;
  tradingsymbol: string;
  transaction_type: OrderSide;
  variety: string;
  product: string;
  order_type: string;
  quantity: number;
  price: number;
  reference_price: number;
}[] {
  return t.legs.map((l) => ({
    exchange: "NFO",
    tradingsymbol: l.tradingsymbol,
    transaction_type: l.side,
    variety: "regular",
    product: "NRML",
    order_type: "LIMIT",
    quantity: t.quantity,
    price: round2(l.entry_price),
    reference_price: round2(l.entry_price),
  }));
}
