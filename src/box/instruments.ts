/**
 * Box universe construction: which underlyings are scanned, which expiry each
 * one uses, and which seven strikes are monitored.
 *
 * Everything comes from the SHARED instrument cache (the same dump the calendar
 * board is derived from), so lot sizes and strikes are always current instrument
 * metadata and never hard-coded.
 */

import type { Instrument } from "../kite.js";
import { selectStrikeWindow, shouldRecentreWindow, strikeStepOf } from "./math.js";
import type { BoxOptionInstrument, BoxUnderlyingState } from "./types.js";

/** The board rows the box module needs (a subset of index.ts's BoardItem). */
export interface BoxBoardItem {
  symbol: string;
  name: string;
  spot_token: number;
  is_index?: boolean;
}

/** The option chain of one underlying, grouped for fast window selection. */
export interface BoxChainIndex {
  underlying: string;
  expiry: string;
  lot_size: number;
  strike_step: number;
  /** Every strike that has BOTH a CE and a PE for this expiry, ascending. */
  strikes: number[];
  ce: Map<number, BoxOptionInstrument>;
  pe: Map<number, BoxOptionInstrument>;
}

function toBoxInstrument(i: Instrument): BoxOptionInstrument {
  return {
    token: i.instrument_token,
    tradingsymbol: i.tradingsymbol,
    exchange: i.exchange,
    strike: i.strike,
    instrument_type: i.instrument_type === "CE" ? "CE" : "PE",
    expiry: i.expiry,
    lot_size: i.lot_size,
  };
}

/**
 * Index the NFO option chains by underlying, keeping only the NEAREST
 * non-expired expiry for each.
 *
 * "Non-expired" is evaluated against the IST trading day, so an expiry dated
 * today is still live (it trades until the close).
 */
export function indexOptionChains(
  all: Instrument[],
  today: string,
): Map<string, BoxChainIndex> {
  // underlying -> expiry -> strike -> { ce, pe }
  const byUnderlying = new Map<string, Map<string, Instrument[]>>();

  for (const i of all) {
    if (i.exchange !== "NFO") continue;
    if (i.instrument_type !== "CE" && i.instrument_type !== "PE") continue;
    if (!i.name || !i.expiry || !(i.strike > 0)) continue;
    if (i.expiry < today) continue; // expired
    let byExpiry = byUnderlying.get(i.name);
    if (!byExpiry) {
      byExpiry = new Map();
      byUnderlying.set(i.name, byExpiry);
    }
    const arr = byExpiry.get(i.expiry);
    if (arr) arr.push(i);
    else byExpiry.set(i.expiry, [i]);
  }

  const out = new Map<string, BoxChainIndex>();
  for (const [underlying, byExpiry] of byUnderlying) {
    // ISO dates sort chronologically, so the first is the nearest live expiry.
    const expiries = [...byExpiry.keys()].sort();
    const expiry = expiries[0];
    if (!expiry) continue;
    const contracts = byExpiry.get(expiry)!;

    const ce = new Map<number, BoxOptionInstrument>();
    const pe = new Map<number, BoxOptionInstrument>();
    let lotSize = 0;
    for (const c of contracts) {
      const inst = toBoxInstrument(c);
      if (inst.instrument_type === "CE") ce.set(inst.strike, inst);
      else pe.set(inst.strike, inst);
      if (!lotSize && c.lot_size > 0) lotSize = c.lot_size;
    }
    // A box needs all four legs, so only strikes with BOTH a call and a put can
    // ever take part.
    const strikes = [...ce.keys()].filter((s) => pe.has(s)).sort((a, b) => a - b);
    if (strikes.length === 0 || lotSize <= 0) continue;

    out.set(underlying, {
      underlying,
      expiry,
      lot_size: lotSize,
      strike_step: strikeStepOf(strikes),
      strikes,
      ce,
      pe,
    });
  }
  return out;
}

/**
 * Build (or re-centre) the seven-strike window for one underlying.
 *
 * Returns null when the chain cannot support a window at this spot. The returned
 * state carries at most seven strikes — ATM and up to three either side.
 */
export function buildUnderlyingState(args: {
  board: BoxBoardItem;
  chain: BoxChainIndex;
  spot: number;
  spotAt: number;
  eachSide: number;
  now: number;
}): BoxUnderlyingState | null {
  const { board, chain, spot, spotAt, eachSide, now } = args;
  const picked = selectStrikeWindow(chain.strikes, spot, eachSide);
  if (!picked) return null;

  const ce = new Map<number, BoxOptionInstrument>();
  const pe = new Map<number, BoxOptionInstrument>();
  for (const s of picked.window) {
    const c = chain.ce.get(s);
    const p = chain.pe.get(s);
    if (c) ce.set(s, c);
    if (p) pe.set(s, p);
  }

  return {
    underlying: board.symbol,
    name: board.name,
    is_index: board.is_index === true,
    spot_token: board.spot_token,
    expiry: chain.expiry,
    lot_size: chain.lot_size,
    strike_step: chain.strike_step,
    atm_strike: picked.atm,
    strikes: picked.window,
    ce,
    pe,
    spot,
    spot_at: spotAt,
    window_at: now,
  };
}

/**
 * Whether an existing window should be rebuilt for a new spot.
 *
 * Two damps are applied so a drifting price cannot cause continuous
 * resubscription: the spot must clear the ATM hysteresis band, AND the window
 * must not have been rebuilt too recently.
 */
export function windowNeedsRebuild(args: {
  state: BoxUnderlyingState;
  spot: number;
  now: number;
  hysteresis: number;
  minIntervalMs: number;
}): boolean {
  const { state, spot, now, hysteresis, minIntervalMs } = args;
  if (!(spot > 0)) return false;
  if (now - state.window_at < minIntervalMs) return false;
  return shouldRecentreWindow(state.atm_strike, spot, state.strike_step, hysteresis);
}

/** Every option token in a window (14 for a full seven-strike window). */
export function windowTokens(state: BoxUnderlyingState): number[] {
  const out: number[] = [];
  for (const inst of state.ce.values()) out.push(inst.token);
  for (const inst of state.pe.values()) out.push(inst.token);
  return out;
}

/**
 * Order the universe so that, when the token budget binds, the most useful
 * underlyings are the ones that get subscribed: indices first (they are the most
 * liquid option books on the exchange), then stocks alphabetically for a stable,
 * predictable selection.
 */
export function prioritiseUniverse(board: BoxBoardItem[]): BoxBoardItem[] {
  const indices = board.filter((b) => b.is_index === true);
  const stocks = board.filter((b) => b.is_index !== true);
  indices.sort((a, b) => a.symbol.localeCompare(b.symbol));
  stocks.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return [...indices, ...stocks];
}

/** True when `expiry` (YYYY-MM-DD) is the current IST trading day. */
export function isExpiryToday(expiry: string, today: string): boolean {
  return expiry === today;
}
