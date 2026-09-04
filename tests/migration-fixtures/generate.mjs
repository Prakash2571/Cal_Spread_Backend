/**
 * Generate the language-neutral Box golden fixtures.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────┐
 * │ THESE FIXTURES RECORD WHAT THE ENGINE DOES, NOT WHAT IT SHOULD DO.           │
 * │                                                                              │
 * │ Every `expected` value is PRODUCED BY the current TypeScript implementation,  │
 * │ never hand-written. That is the whole point: the Go rewrite must reproduce    │
 * │ today's behaviour bit for bit, including anything here that looks surprising. │
 * │                                                                              │
 * │ Consequently, REGENERATING THIS IS A DELIBERATE ACT. If a fixture changes,   │
 * │ trading behaviour changed — that is a finding, not a chore. Do not run this   │
 * │ to "fix" a failing test.                                                     │
 * └──────────────────────────────────────────────────────────────────────────────┘
 *
 * Usage (from the repo root, after `npm run build`):
 *
 *     node tests/migration-fixtures/generate.mjs
 *
 * Inputs are written out FULLY EXPLICIT — no defaults left implicit — so a Go
 * implementation can read the JSON without consulting any TypeScript.
 *
 * Scope is deliberately limited to PURE, DETERMINISTIC functions. The live execution
 * state machine (leg executor, execution gateway, emergency unwind, abort-after-fill)
 * needs a broker adapter and a database, so it is not fixture-driven here; it remains
 * covered by the existing TypeScript suites. See docs/GO_MIGRATION_BOUNDARIES.md.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  entrySideFor,
  exitSideFor,
  slippagePerUnit,
  round2,
  evaluateCandidate,
  projectedNetEdge,
  convergenceThreshold,
  exitNetCreditPerUnit,
} from "../../dist/box/math.js";
import {
  roundToTick,
  computeLimitPrice,
  buildOrderPricing,
  effectiveQty,
} from "../../dist/box/orderPricing.js";
import { calculateBoxCharges, calculateRoundTrip } from "../../dist/box/localCharges.js";
import {
  fullLotByRole,
  isBoxPositionFlat,
  deriveBoxPositionState,
  outstandingRoles,
} from "../../dist/box/positions.js";
import { BOX_LEG_ROLES } from "../../dist/box/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "box");

/* ------------------------------- input builders ------------------------------ */

/** A fully-explicit option leg. */
function leg(token, tradingsymbol, strike, type, lotSize = 50, tick = 0.05) {
  return {
    token,
    tradingsymbol,
    exchange: "NFO",
    strike,
    instrument_type: type,
    expiry: "2026-09-29",
    lot_size: lotSize,
    tick_size: tick,
  };
}

/** A fully-explicit four-leg candidate. */
function candidate({ direction = "LONG_BOX", lower = 25000, upper = 25200, lotSize = 50 } = {}) {
  const width = upper - lower;
  return {
    key: `NIFTY|2026-09-29|${lower}|${upper}|${direction}`,
    underlying: "NIFTY",
    name: "NIFTY 50",
    is_index: true,
    expiry: "2026-09-29",
    direction,
    lower_strike: lower,
    upper_strike: upper,
    box_width: width,
    lot_size: lotSize,
    legs: {
      k1_ce: leg(1001, `NIFTY26SEP${lower}CE`, lower, "CE", lotSize),
      k2_ce: leg(1002, `NIFTY26SEP${upper}CE`, upper, "CE", lotSize),
      k2_pe: leg(1003, `NIFTY26SEP${upper}PE`, upper, "PE", lotSize),
      k1_pe: leg(1004, `NIFTY26SEP${lower}PE`, lower, "PE", lotSize),
    },
  };
}

/** A fully-explicit five-level book. */
function quote({ token, bid, ask, at, version = 10, qty = 500, exchangeAt = null }) {
  const ladder = (base, step, sign) =>
    Array.from({ length: 5 }, (_, i) => ({
      price: round2(base + sign * step * i),
      qty,
      orders: 3,
    }));
  return {
    token,
    bid,
    bid_qty: qty,
    ask,
    ask_qty: qty,
    last: round2((bid + ask) / 2),
    bids: bid > 0 ? ladder(bid, 0.05, -1) : [],
    asks: ask > 0 ? ladder(ask, 0.05, +1) : [],
    version,
    at,
    exchange_at: exchangeAt,
    source: "ws",
  };
}

/** Quotes as a JSON-friendly array; the loader rebuilds the Map (Go builds a map too). */
function quoteList(entries) {
  return entries.map(quote);
}

function toQuoteMap(list) {
  return new Map(list.map((q) => [q.token, q]));
}

const NOW = 1_760_000_000_000;

/**
 * The SHIPPED Zerodha option rate card (src/box/localCharges.ts loadBoxChargeRates
 * defaults), stated in full and explicitly rather than read from the environment.
 *
 * Every field the interface declares is present — including `ipftPct` and `sttType`,
 * which a partial object would leave `undefined` and quietly turn the exchange and GST
 * heads into NaN. The fixture must freeze the charge the engine really produces, so it
 * uses the real defaults, not a made-up card.
 */
const RATES = {
  brokeragePerOrder: 20,
  brokerageMaxPct: 0,
  sttSellPct: 0.15,
  sttRoundNearestRupee: true,
  exchangeTxnPct: 0.03503,
  ipftPerCrore: 50,
  ipftPct: 0,
  sebiPct: 0.0001,
  stampDutyBuyPct: 0.003,
  gstPct: 18,
  sttType: "stt",
  rateVersion: "zerodha-nse-options-2026-04-01",
};

/* --------------------------------- fixtures --------------------------------- */

const files = [];

/** Register one fixture file: `expected` is always computed, never written by hand. */
function fixture(file, category, operation, description, cases) {
  files.push({
    file,
    body: {
      category,
      operation,
      description,
      generated_from: "TypeScript reference implementation (src/box)",
      cases,
    },
  });
}

/* 1 ─ direction: which side each leg trades ---------------------------------- */

fixture(
  "direction.json",
  "box-direction",
  "entrySideFor / exitSideFor",
  "Which side each of the four legs trades on entry and on exit, per direction. " +
    "SHORT_BOX is the exact mirror of LONG_BOX; exit is always the reverse of entry.",
  ["LONG_BOX", "SHORT_BOX"].flatMap((direction) =>
    BOX_LEG_ROLES.map((role) => ({
      name: `${direction} ${role}`,
      input: { role, direction },
      expected: {
        entry_side: entrySideFor(role, direction),
        exit_side: exitSideFor(role, direction),
      },
    })),
  ),
);

/* 2 ─ order pricing: bounded marketable limits + tick rounding --------------- */

fixture(
  "order-pricing.json",
  "order-pricing",
  "computeLimitPrice / roundToTick / buildOrderPricing",
  "A marketable limit is the reference touch pushed AWAY from us by a whole number " +
    "of ticks — dearer for a BUY, cheaper for a SELL — then snapped to the tick grid.",
  [
    {
      name: "BUY bounded limit, 2 ticks of chase",
      input: { side: "BUY", referencePrice: 101.3, tickSize: 0.05, maxChaseTicks: 2 },
      expected: {
        limit_price: computeLimitPrice({
          side: "BUY",
          referencePrice: 101.3,
          tickSize: 0.05,
          maxChaseTicks: 2,
        }),
        pricing: buildOrderPricing({
          side: "BUY",
          quantity: 50,
          referencePrice: 101.3,
          tickSize: 0.05,
          maxChaseTicks: 2,
        }),
      },
    },
    {
      name: "SELL bounded limit, 2 ticks of chase",
      input: { side: "SELL", referencePrice: 101.3, tickSize: 0.05, maxChaseTicks: 2 },
      expected: {
        limit_price: computeLimitPrice({
          side: "SELL",
          referencePrice: 101.3,
          tickSize: 0.05,
          maxChaseTicks: 2,
        }),
        pricing: buildOrderPricing({
          side: "SELL",
          quantity: 50,
          referencePrice: 101.3,
          tickSize: 0.05,
          maxChaseTicks: 2,
        }),
      },
    },
    {
      name: "zero chase leaves the reference on the grid",
      input: { side: "BUY", referencePrice: 100.02, tickSize: 0.05, maxChaseTicks: 0 },
      expected: {
        limit_price: computeLimitPrice({
          side: "BUY",
          referencePrice: 100.02,
          tickSize: 0.05,
          maxChaseTicks: 0,
        }),
      },
    },
    {
      name: "tick rounding: halfway, below and above",
      input: {
        cases: [
          { price: 100.025, tick: 0.05 },
          { price: 100.024, tick: 0.05 },
          { price: 100.026, tick: 0.05 },
          { price: 100.01, tick: 0.1 },
          { price: 7.77, tick: 0.05 },
        ],
      },
      expected: {
        rounded: [
          roundToTick(100.025, 0.05),
          roundToTick(100.024, 0.05),
          roundToTick(100.026, 0.05),
          roundToTick(100.01, 0.1),
          roundToTick(7.77, 0.05),
        ],
      },
    },
    {
      name: "a non-positive tick falls back to 2dp rounding",
      input: { price: 100.126, tick: 0 },
      expected: { rounded: roundToTick(100.126, 0) },
    },
    {
      name: "queue haircut floors to whole contracts",
      input: {
        cases: [
          { displayed: 500, model: "none", haircutPct: 50 },
          { displayed: 500, model: "haircut", haircutPct: 50 },
          { displayed: 75, model: "haircut", haircutPct: 40 },
        ],
      },
      expected: {
        effective: [
          effectiveQty(500, "none", 50),
          effectiveQty(500, "haircut", 50),
          effectiveQty(75, "haircut", 40),
        ],
      },
    },
  ],
);

/* 3 ─ slippage sign normalisation -------------------------------------------- */

fixture(
  "slippage.json",
  "slippage",
  "slippagePerUnit",
  "POSITIVE always means WORSE FOR US: paying more on a BUY and receiving less on " +
    "a SELL are both adverse, so the sign is normalised here rather than per call site.",
  [
    {
      name: "BUY filled above detection is adverse",
      input: { side: "BUY", detected: 100.0, executed: 100.5 },
      expected: { slippage_per_unit: slippagePerUnit("BUY", 100.0, 100.5) },
    },
    {
      name: "BUY filled below detection is favourable",
      input: { side: "BUY", detected: 100.0, executed: 99.5 },
      expected: { slippage_per_unit: slippagePerUnit("BUY", 100.0, 99.5) },
    },
    {
      name: "SELL filled below detection is adverse",
      input: { side: "SELL", detected: 100.0, executed: 99.5 },
      expected: { slippage_per_unit: slippagePerUnit("SELL", 100.0, 99.5) },
    },
    {
      name: "a missing price yields null, never zero",
      input: { side: "BUY", detected: null, executed: 100.5 },
      expected: { slippage_per_unit: slippagePerUnit("BUY", null, 100.5) },
    },
  ],
);

/* 4 ─ quote quality and four-leg evaluation ---------------------------------- */

const freshQuotes = quoteList([
  { token: 1001, bid: 260.0, ask: 260.5, at: NOW - 100, exchangeAt: NOW - 120 },
  { token: 1002, bid: 130.0, ask: 130.5, at: NOW - 100, exchangeAt: NOW - 120 },
  { token: 1003, bid: 95.0, ask: 95.5, at: NOW - 100, exchangeAt: NOW - 120 },
  { token: 1004, bid: 30.0, ask: 30.5, at: NOW - 100, exchangeAt: NOW - 120 },
]);

const staleQuotes = quoteList([
  { token: 1001, bid: 260.0, ask: 260.5, at: NOW - 9000 },
  { token: 1002, bid: 130.0, ask: 130.5, at: NOW - 100 },
  { token: 1003, bid: 95.0, ask: 95.5, at: NOW - 100 },
  { token: 1004, bid: 30.0, ask: 30.5, at: NOW - 100 },
]);

const missingAsk = quoteList([
  { token: 1001, bid: 260.0, ask: 0, at: NOW - 100 },
  { token: 1002, bid: 130.0, ask: 130.5, at: NOW - 100 },
  { token: 1003, bid: 95.0, ask: 95.5, at: NOW - 100 },
  { token: 1004, bid: 30.0, ask: 30.5, at: NOW - 100 },
]);

const missingBid = quoteList([
  { token: 1001, bid: 260.0, ask: 260.5, at: NOW - 100 },
  { token: 1002, bid: 0, ask: 130.5, at: NOW - 100 },
  { token: 1003, bid: 95.0, ask: 95.5, at: NOW - 100 },
  { token: 1004, bid: 30.0, ask: 30.5, at: NOW - 100 },
]);

const thinQuotes = quoteList([
  { token: 1001, bid: 260.0, ask: 260.5, at: NOW - 100, qty: 10 },
  { token: 1002, bid: 130.0, ask: 130.5, at: NOW - 100, qty: 10 },
  { token: 1003, bid: 95.0, ask: 95.5, at: NOW - 100, qty: 10 },
  { token: 1004, bid: 30.0, ask: 30.5, at: NOW - 100, qty: 10 },
]);

/** `expected` keeps only the decision-relevant projection, not the whole object. */
function evalSummary(ev) {
  return {
    entry_net_debit_per_unit: ev.entry_net_debit_per_unit,
    gross_edge_per_unit: ev.gross_edge_per_unit,
    gross_edge: ev.gross_edge,
    tradable: ev.tradable,
    depth_ok: ev.depth_ok,
    worst_age_ms: ev.worst_age_ms,
    quote_version: ev.quote_version,
    reject: ev.reject,
    legs: ev.legs.map((l) => ({
      role: l.role,
      side: l.side,
      price: l.price,
      qty_at_touch: l.qty_at_touch,
      age_ms: l.age_ms,
      fresh: l.fresh,
      executable: l.executable,
    })),
  };
}

const MAX_AGE_MS = 1500;

fixture(
  "quotes-and-evaluation.json",
  "quotes",
  "evaluateCandidate",
  "Four-leg evaluation over one instant's books. Note the reject PRECEDENCE: the " +
    "first failing leg in role order (k1_ce, k2_ce, k2_pe, k1_pe) determines the reason.",
  [
    {
      name: "valid fresh four-leg book (LONG_BOX)",
      input: {
        candidate: candidate(),
        quotes: freshQuotes,
        now: NOW,
        maxAgeMs: MAX_AGE_MS,
      },
      expected: evalSummary(
        evaluateCandidate({
          candidate: candidate(),
          quotes: toQuoteMap(freshQuotes),
          now: NOW,
          maxAgeMs: MAX_AGE_MS,
        }),
      ),
    },
    {
      name: "same books, SHORT_BOX mirrors every side",
      input: {
        candidate: candidate({ direction: "SHORT_BOX" }),
        quotes: freshQuotes,
        now: NOW,
        maxAgeMs: MAX_AGE_MS,
      },
      expected: evalSummary(
        evaluateCandidate({
          candidate: candidate({ direction: "SHORT_BOX" }),
          quotes: toQuoteMap(freshQuotes),
          now: NOW,
          maxAgeMs: MAX_AGE_MS,
        }),
      ),
    },
    {
      name: "one stale leg rejects the candidate",
      input: { candidate: candidate(), quotes: staleQuotes, now: NOW, maxAgeMs: MAX_AGE_MS },
      expected: evalSummary(
        evaluateCandidate({
          candidate: candidate(),
          quotes: toQuoteMap(staleQuotes),
          now: NOW,
          maxAgeMs: MAX_AGE_MS,
        }),
      ),
    },
    {
      name: "missing ask on a leg we must BUY",
      input: { candidate: candidate(), quotes: missingAsk, now: NOW, maxAgeMs: MAX_AGE_MS },
      expected: evalSummary(
        evaluateCandidate({
          candidate: candidate(),
          quotes: toQuoteMap(missingAsk),
          now: NOW,
          maxAgeMs: MAX_AGE_MS,
        }),
      ),
    },
    {
      name: "missing bid on a leg we must SELL",
      input: { candidate: candidate(), quotes: missingBid, now: NOW, maxAgeMs: MAX_AGE_MS },
      expected: evalSummary(
        evaluateCandidate({
          candidate: candidate(),
          quotes: toQuoteMap(missingBid),
          now: NOW,
          maxAgeMs: MAX_AGE_MS,
        }),
      ),
    },
    {
      name: "insufficient depth for one lot",
      input: { candidate: candidate(), quotes: thinQuotes, now: NOW, maxAgeMs: MAX_AGE_MS },
      expected: evalSummary(
        evaluateCandidate({
          candidate: candidate(),
          quotes: toQuoteMap(thinQuotes),
          now: NOW,
          maxAgeMs: MAX_AGE_MS,
        }),
      ),
    },
    {
      name: "no quote at all for one leg",
      input: {
        candidate: candidate(),
        quotes: freshQuotes.filter((q) => q.token !== 1003),
        now: NOW,
        maxAgeMs: MAX_AGE_MS,
      },
      expected: evalSummary(
        evaluateCandidate({
          candidate: candidate(),
          quotes: toQuoteMap(freshQuotes.filter((q) => q.token !== 1003)),
          now: NOW,
          maxAgeMs: MAX_AGE_MS,
        }),
      ),
    },
  ],
);

/* 5 ─ candidate economics ---------------------------------------------------- */

fixture(
  "candidate-economics.json",
  "candidate-economics",
  "projectedNetEdge",
  "projectedNetEdge = grossEdge - entryCharges - estimatedExitCharges - " +
    "executionCost - safetyBuffer. Every term is deducted exactly once.",
  [
    {
      name: "clearly profitable",
      input: {
        grossEdge: 900,
        entryCharges: 120,
        estimatedExitCharges: 120,
        safetyBuffer: 50,
        executionCost: 60,
      },
      expected: {
        projected_net_edge: projectedNetEdge({
          grossEdge: 900,
          entryCharges: 120,
          estimatedExitCharges: 120,
          safetyBuffer: 50,
          executionCost: 60,
        }),
      },
    },
    {
      name: "unprofitable once costs are applied",
      input: {
        grossEdge: 200,
        entryCharges: 120,
        estimatedExitCharges: 120,
        safetyBuffer: 50,
        executionCost: 60,
      },
      expected: {
        projected_net_edge: projectedNetEdge({
          grossEdge: 200,
          entryCharges: 120,
          estimatedExitCharges: 120,
          safetyBuffer: 50,
          executionCost: 60,
        }),
      },
    },
    {
      name: "exactly break-even",
      input: {
        grossEdge: 350,
        entryCharges: 120,
        estimatedExitCharges: 120,
        safetyBuffer: 50,
        executionCost: 60,
      },
      expected: {
        projected_net_edge: projectedNetEdge({
          grossEdge: 350,
          entryCharges: 120,
          estimatedExitCharges: 120,
          safetyBuffer: 50,
          executionCost: 60,
        }),
      },
    },
    {
      name: "omitted executionCost defaults to zero",
      input: {
        grossEdge: 900,
        entryCharges: 120,
        estimatedExitCharges: 120,
        safetyBuffer: 50,
      },
      expected: {
        projected_net_edge: projectedNetEdge({
          grossEdge: 900,
          entryCharges: 120,
          estimatedExitCharges: 120,
          safetyBuffer: 50,
        }),
      },
    },
  ],
);

/* 6 ─ charges ---------------------------------------------------------------- */

const entryOrders = [
  { side: "BUY", tradingsymbol: "NIFTY26SEP25000CE", price: 260.5, quantity: 50 },
  { side: "SELL", tradingsymbol: "NIFTY26SEP25200CE", price: 130.0, quantity: 50 },
  { side: "BUY", tradingsymbol: "NIFTY26SEP25200PE", price: 95.5, quantity: 50 },
  { side: "SELL", tradingsymbol: "NIFTY26SEP25000PE", price: 30.0, quantity: 50 },
];

const FIXED_AT = new Date("2026-09-03T10:00:00.000Z");

/** Charges minus the timestamp, which is not a behavioural output. */
function chargesSummary(c) {
  const { at, ...rest } = c;
  return {
    ...rest,
    legs: c.legs.map((l) => ({ ...l })),
  };
}

fixture(
  "charges.json",
  "charges",
  "calculateBoxCharges / calculateRoundTrip",
  "Per-leg Indian F&O option charges and their sum. STT applies to SELLS only and " +
    "is rounded to the NEAREST RUPEE (a contract-note behaviour, not paise rounding). " +
    "Stamp duty applies to BUYS only. IPFT is per crore of turnover, folded into the " +
    "exchange head. GST applies to brokerage + exchange + sebi.",
  [
    {
      name: "four-leg long-box entry charges",
      input: { orders: entryOrders, rates: RATES },
      expected: chargesSummary(
        calculateBoxCharges(entryOrders, RATES, "kite", "local", FIXED_AT),
      ),
    },
    {
      name: "round trip: entry plus the reversed estimated exit",
      input: { orders: entryOrders, rates: RATES },
      expected: (() => {
        const rt = calculateRoundTrip(entryOrders, RATES, FIXED_AT);
        return {
          entry: chargesSummary(rt.entry),
          estimated_exit: chargesSummary(rt.estimated_exit),
          entry_total: rt.entry_total,
          estimated_exit_total: rt.estimated_exit_total,
        };
      })(),
    },
  ],
);

/* 7 ─ exit economics -------------------------------------------------------- */

const exitLegs = [
  { role: "k1_ce", side: "SELL", price: 262.0 },
  { role: "k2_ce", side: "BUY", price: 131.0 },
  { role: "k2_pe", side: "SELL", price: 96.0 },
  { role: "k1_pe", side: "BUY", price: 29.0 },
];

fixture(
  "exit-economics.json",
  "exit-economics",
  "exitNetCreditPerUnit / convergenceThreshold",
  "The credit received by unwinding the four legs now, and the convergence " +
    "threshold the exit must clear: max(floor, pct * entryNetEdge).",
  [
    {
      name: "net credit from unwinding a long box",
      input: { legs: exitLegs },
      expected: { exit_net_credit_per_unit: exitNetCreditPerUnit(exitLegs) },
    },
    {
      name: "an unpriced leg makes the credit null, never zero",
      input: { legs: [...exitLegs.slice(0, 3), { role: "k1_pe", side: "BUY", price: null }] },
      expected: {
        exit_net_credit_per_unit: exitNetCreditPerUnit([
          ...exitLegs.slice(0, 3),
          { role: "k1_pe", side: "BUY", price: null },
        ]),
      },
    },
    {
      name: "convergence threshold: percentage dominates the floor",
      input: { entryNetEdge: 1000, convergenceFloor: 50, convergencePct: 0.6 },
      expected: {
        threshold: convergenceThreshold(1000, {
          convergenceFloor: 50,
          convergencePct: 0.6,
        }),
      },
    },
    {
      name: "convergence threshold: floor dominates the percentage",
      input: { entryNetEdge: 50, convergenceFloor: 100, convergencePct: 0.6 },
      expected: {
        threshold: convergenceThreshold(50, {
          convergenceFloor: 100,
          convergencePct: 0.6,
        }),
      },
    },
  ],
);

/* 8 ─ position state -------------------------------------------------------- */

const fullBox = { k1_ce: 50, k2_ce: 50, k2_pe: 50, k1_pe: 50 };
const residual = { k1_ce: 50, k2_ce: 0, k2_pe: 50, k1_pe: 0 };
const flat = { k1_ce: 0, k2_ce: 0, k2_pe: 0, k1_pe: 0 };
const uneven = { k1_ce: 50, k2_ce: 25, k2_pe: 50, k1_pe: 50 };

fixture(
  "position-state.json",
  "position-state",
  "deriveBoxPositionState / isBoxPositionFlat / outstandingRoles",
  "A box is CLOSED only when EVERY role is flat — a 1/4, 2/4 or 3/4 exit is not a " +
    "closed box. RECOVERY is sticky until the exposure is genuinely flat.",
  [
    {
      name: "all four legs at full lot is a BOX",
      input: { remaining_qty_by_role: fullBox },
      expected: {
        state: deriveBoxPositionState(fullBox),
        flat: isBoxPositionFlat(fullBox),
        outstanding: outstandingRoles({ remaining_qty_by_role: fullBox }),
      },
    },
    {
      name: "two legs exited leaves residual exposure",
      input: { remaining_qty_by_role: residual },
      expected: {
        state: deriveBoxPositionState(residual),
        flat: isBoxPositionFlat(residual),
        outstanding: outstandingRoles({ remaining_qty_by_role: residual }),
      },
    },
    {
      name: "unequal quantities are PARTIALLY_EXITED, not a BOX",
      input: { remaining_qty_by_role: uneven },
      expected: {
        state: deriveBoxPositionState(uneven),
        flat: isBoxPositionFlat(uneven),
        outstanding: outstandingRoles({ remaining_qty_by_role: uneven }),
      },
    },
    {
      name: "every role zero is FLAT",
      input: { remaining_qty_by_role: flat },
      expected: {
        state: deriveBoxPositionState(flat),
        flat: isBoxPositionFlat(flat),
        outstanding: outstandingRoles({ remaining_qty_by_role: flat }),
      },
    },
    {
      name: "RECOVERY is sticky while exposure remains",
      input: { remaining_qty_by_role: residual, current: "RECOVERY" },
      expected: { state: deriveBoxPositionState(residual, "RECOVERY") },
    },
    {
      name: "RECOVERY still becomes FLAT once genuinely flat",
      input: { remaining_qty_by_role: flat, current: "RECOVERY" },
      expected: { state: deriveBoxPositionState(flat, "RECOVERY") },
    },
    {
      name: "fullLotByRole spreads one quantity across all four roles",
      input: { quantity: 50 },
      expected: { by_role: fullLotByRole(50) },
    },
  ],
);

/* ---------------------------------- write ----------------------------------- */

mkdirSync(OUT_DIR, { recursive: true });
let total = 0;
for (const { file, body } of files) {
  writeFileSync(join(OUT_DIR, file), `${JSON.stringify(body, null, 2)}\n`, "utf8");
  total += body.cases.length;
  console.log(`wrote box/${file}  (${body.cases.length} cases)`);
}
console.log(`\n${files.length} files, ${total} cases total.`);
