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
  | "no_close";

export type SynthStatus = "ELIGIBLE" | "WATCHING" | "REJECTED" | "INDICATIVE";

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

/** Entry charges for the three legs, and the estimated cost of unwinding them. */
export function synthCharges(
  legs: { role: SynthLegRole; side: OrderSide; tradingsymbol: string; price: number }[],
  quantity: number,
  optionRates: BoxChargeRates,
  futuresRates: BoxChargeRates,
): { entry: number; exit: number } {
  let entry = 0;
  let exit = 0;
  for (const l of legs) {
    const rates = l.role === "fut" ? futuresRates : optionRates;
    const order: BoxChargeOrder = {
      side: l.side,
      tradingsymbol: l.tradingsymbol,
      quantity,
      price: round2(l.price),
    };
    entry += calculateLegCharges(order, rates).total;
    // Exit projected at the entry prices, the conservative convention Box uses.
    exit += calculateLegCharges({ ...order, side: l.side === "BUY" ? "SELL" : "BUY" }, rates).total;
  }
  return { entry: round2(entry), exit: round2(exit) };
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
    legs,
    updated_at: p.now,
  };
}

const STATUS_RANK: Record<SynthStatus, number> = {
  ELIGIBLE: 0,
  WATCHING: 1,
  INDICATIVE: 2,
  REJECTED: 3,
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
