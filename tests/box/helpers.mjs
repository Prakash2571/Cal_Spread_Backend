/**
 * Shared fixtures for the box tests.
 *
 * Plain ESM JavaScript against the COMPILED output in dist/, so the suite needs
 * no test framework, no transpiler and no extra dependency — `npm test` builds
 * and then runs it with Node's built-in test runner.
 */

import { loadBoxConfig } from "../../dist/box/config.js";
import { buildCandidates } from "../../dist/box/math.js";

/** A NIFTY-like lot size, taken from "instrument metadata" in every fixture. */
export const LOT = 75;

/** Config with the shipped defaults (₹1,200 / ₹150 / 1,500 ms / ATM±3). */
export function cfg(overrides = {}) {
  return { ...loadBoxConfig(), ...overrides };
}

/** One book level list from a single price/qty pair. */
function levels(price, qty) {
  return price > 0 ? [{ price, qty, orders: 1 }] : [];
}

/**
 * A quote with an explicit touch and the size resting at it.
 * `at` is the RECEIVE time the freshness gate is measured against.
 */
export function quote(token, { bid = 0, bidQty = 0, ask = 0, askQty = 0, last = 0, at = 0 }) {
  return {
    token,
    bid,
    bid_qty: bidQty,
    ask,
    ask_qty: askQty,
    last,
    bids: levels(bid, bidQty),
    asks: levels(ask, askQty),
    at,
    source: "ws",
  };
}

/** An option contract, as the instrument dump would describe it. */
export function option(token, strike, type, { expiry = "2026-09-24", lotSize = LOT } = {}) {
  return {
    token,
    tradingsymbol: `NIFTY26SEP${strike}${type}`,
    exchange: "NFO",
    strike,
    instrument_type: type,
    expiry,
    lot_size: lotSize,
  };
}

/**
 * A chain of `count` strikes stepping by `step` from `first`, with deterministic
 * tokens: CE = 1000 + i*2, PE = 1001 + i*2.
 */
export function chain({ first = 19700, step = 100, count = 11, expiry = "2026-09-24", lotSize = LOT } = {}) {
  const ce = new Map();
  const pe = new Map();
  const strikes = [];
  for (let i = 0; i < count; i++) {
    const strike = first + i * step;
    strikes.push(strike);
    ce.set(strike, option(1000 + i * 2, strike, "CE", { expiry, lotSize }));
    pe.set(strike, option(1001 + i * 2, strike, "PE", { expiry, lotSize }));
  }
  return { strikes, ce, pe, expiry, lotSize };
}

/** Candidates for a strike window of the given chain. */
export function candidatesFor(strikes, c = chain(), { underlying = "NIFTY" } = {}) {
  return buildCandidates({
    underlying,
    name: "NIFTY 50",
    is_index: true,
    expiry: c.expiry,
    lot_size: c.lotSize,
    strikes,
    ce: c.ce,
    pe: c.pe,
  });
}

/**
 * The canonical qualifying box used across the tests.
 *
 *   width  = 20100 - 19900 = 200
 *   cost   = 300 (K1 CE ask) - 220 (K2 CE bid) + 200 (K2 PE ask) - 105 (K1 PE bid) = 175
 *   gross  = (200 - 175) x 75 = ₹1,875
 */
export const GOOD_BOX = {
  k1: 19900,
  k2: 20100,
  width: 200,
  costPerUnit: 175,
  grossEdge: 1875,
  prices: {
    k1_ce: { ask: 300, askQty: 150, bid: 299, bidQty: 150 },
    k2_ce: { bid: 220, bidQty: 150, ask: 221, askQty: 150 },
    k2_pe: { ask: 200, askQty: 150, bid: 199, bidQty: 150 },
    k1_pe: { bid: 105, bidQty: 150, ask: 106, askQty: 150 },
  },
};

/** Quote map for a candidate, from a role → price overrides object. */
export function quotesFor(candidate, overrides = {}, { at = 1_000_000, base = GOOD_BOX.prices } = {}) {
  const map = new Map();
  for (const role of ["k1_ce", "k2_ce", "k2_pe", "k1_pe"]) {
    const spec = { ...base[role], ...(overrides[role] ?? {}) };
    const token = candidate.legs[role].token;
    map.set(token, quote(token, { ...spec, at: spec.at ?? at }));
  }
  return map;
}

/** The single qualifying candidate (K1=19900, K2=20100) from a 7-strike window. */
export function goodCandidate() {
  const c = chain();
  const window = [19700, 19800, 19900, 20000, 20100, 20200, 20300];
  const all = candidatesFor(window, c);
  const cand = all.find(
    (x) => x.lower_strike === GOOD_BOX.k1 && x.upper_strike === GOOD_BOX.k2,
  );
  if (!cand) throw new Error("fixture: qualifying candidate not found");
  return { candidate: cand, all, chain: c, window };
}

/**
 * A charge estimator stub standing in for Zerodha's virtual contract note.
 * Returns a flat total per group so the arithmetic under test stays exact.
 */
export function chargeStub({ entryTotal = 150, exitTotal = 150, fail = false, onCall } = {}) {
  const calls = [];
  const fn = async (groups) => {
    calls.push(groups);
    onCall?.(groups);
    if (fail) return null;
    return groups.map((g, i) => ({
      charges: {
        legs: g.legs.map((l) => ({
          side: l.side,
          tradingsymbol: l.tradingsymbol,
          quantity: l.quantity,
          price: l.price,
          value: l.quantity * l.price,
          brokerage: 20,
          stt: 0,
          stt_type: "stt",
          exchange_txn: 0,
          sebi: 0,
          stamp_duty: 0,
          gst: 0,
          total: (i === 0 ? entryTotal : exitTotal) / g.legs.length,
        })),
        value: 0,
        brokerage: 80,
        stt: 0,
        exchange_txn: 0,
        sebi: 0,
        stamp_duty: 0,
        gst: 0,
        total: i === 0 ? entryTotal : exitTotal,
        source: i === 0 ? "kite" : "kite_estimate",
        at: new Date(0),
      },
      logLegs: [],
    }));
  };
  return { fn, calls };
}

/** A position as the monitor holds it in memory. */
export function positionFrom(candidate, overrides = {}) {
  const legs = candidate.legs;
  return {
    id: "box1",
    key: candidate.key,
    underlying: candidate.underlying,
    name: candidate.name,
    is_index: candidate.is_index,
    expiry: candidate.expiry,
    lower_strike: candidate.lower_strike,
    upper_strike: candidate.upper_strike,
    box_width: candidate.box_width,
    lot_size: candidate.lot_size,
    quantity: candidate.lot_size,
    entry_box_cost_per_unit: GOOD_BOX.costPerUnit,
    entry_gross_edge: GOOD_BOX.grossEdge,
    entry_net_edge: 1425,
    entry_charges_total: 150,
    estimated_exit_charges_total: 150,
    safety_buffer: 150,
    opened_at: 0,
    legs,
    entry_prices: { k1_ce: 300, k2_ce: 220, k2_pe: 200, k1_pe: 105 },
    metrics: null,
    exit_blocked_reason: null,
    expiry_safety: false,
    closing: false,
    last_persist_at: Date.now(),
    config: {},
    ...overrides,
  };
}

/**
 * Exit-side quotes producing a chosen exit box value per unit.
 *
 *   exitValue = Bid(K1 CE) - Ask(K2 CE) + Bid(K2 PE) - Ask(K1 PE)
 *
 * K2 CE ask and K1 PE ask are pinned, so the requested value is reached by
 * moving the two BIDs the exit sells into.
 */
export function exitQuotes(candidate, exitValuePerUnit, { at = 1_000_000, qty = 150 } = {}) {
  const k2ceAsk = 221;
  const k1peAsk = 106;
  // exitValue = k1ceBid - k2ceAsk + k2peBid - k1peAsk, split evenly across bids.
  const bidSum = exitValuePerUnit + k2ceAsk + k1peAsk;
  const k1ceBid = Math.round((bidSum * 2) / 3);
  const k2peBid = bidSum - k1ceBid;
  const map = new Map();
  const put = (role, spec) => {
    const token = candidate.legs[role].token;
    map.set(token, quote(token, { ...spec, at }));
  };
  put("k1_ce", { bid: k1ceBid, bidQty: qty, ask: k1ceBid + 1, askQty: qty });
  put("k2_ce", { ask: k2ceAsk, askQty: qty, bid: k2ceAsk - 1, bidQty: qty });
  put("k2_pe", { bid: k2peBid, bidQty: qty, ask: k2peBid + 1, askQty: qty });
  put("k1_pe", { ask: k1peAsk, askQty: qty, bid: k1peAsk - 1, bidQty: qty });
  return map;
}

/** A quote store pre-loaded with a fixed map (the engine's store, but seeded). */
export function storeFrom(map) {
  return {
    view: () => map,
    get: (t) => map.get(t),
    isFresh: (t, maxAge, now = Date.now()) => {
      const q = map.get(t);
      return !!q && now - q.at <= maxAge;
    },
    size: map.size,
    updateCount: 0,
  };
}
