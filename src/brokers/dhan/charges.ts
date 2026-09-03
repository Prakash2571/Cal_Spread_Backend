/**
 * Dhan's charge model for NSE equity OPTIONS.
 *
 * WHY THIS IS NOT `localCharges.ts` WITH A DIFFERENT NUMBER
 * The statutory heads (STT, exchange transaction charge, SEBI turnover fee, stamp
 * duty, GST) are set by the exchange and the government — identical at every broker.
 * BROKERAGE is not. Zerodha bills a flat ₹20 per executed option order; Dhan's plans
 * differ, and on a four-leg box the round trip is EIGHT orders, so a ₹5 per-order
 * difference moves the expected-net gate by ₹40. The Box entry gate is a ₹1,200
 * decision, and spending Zerodha's brokerage while trading at Dhan would make the
 * gate quietly wrong in the broker's favour.
 *
 * So the rate card is broker-specific and every produced record is labelled
 * `computed_by: "dhan_estimate"` with `broker: "dhan"` — never "local", which the UI
 * renders as the Zerodha local calculator.
 *
 * ROUNDING IS COPIED DELIBERATELY from localCharges.ts (per-head round2, STT to the
 * nearest rupee, GST on brokerage + exchange + SEBI only) so a Dhan contract note is
 * structurally interchangeable with a Zerodha one and the two are comparable.
 */

import type { BoxChargesWithOrigin, BoxLegCharges, OrderSide } from "../../box/types.js";

/** One order to be costed. */
export interface DhanChargeOrder {
  side: OrderSide;
  tradingsymbol: string;
  quantity: number;
  price: number;
}

/**
 * Dhan's NSE options rate card.
 *
 * Every value is env-overridable, because brokerage plans change and a statutory
 * rate change must not require a deploy. `rateVersion` is stamped onto every trade
 * so a historical record stays interpretable after a rate change.
 */
export interface DhanChargeRates {
  /** Flat brokerage per executed order (₹). */
  brokeragePerOrder: number;
  /** Cap as a percentage of turnover, when the plan has one. 0 = uncapped. */
  brokerageMaxPct: number;
  /** STT on the SELL side only, as a percentage of premium. */
  sttSellPct: number;
  /** STT is billed rounded to the nearest rupee. */
  sttRoundNearestRupee: boolean;
  /** NSE transaction charge on options premium (%). */
  exchangeTxnPct: number;
  /** Investor Protection Fund contribution, ₹ per crore of premium. */
  ipftPerCrore: number;
  /** SEBI turnover fee (%). */
  sebiPct: number;
  /** Stamp duty, BUY side only (%). */
  stampDutyBuyPct: number;
  /** GST on (brokerage + exchange + SEBI) only — never on STT or stamp duty. */
  gstPct: number;
  sttType: string;
  rateVersion: string;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return fallback;
}

/**
 * Load Dhan's rate card.
 *
 * The statutory defaults match the Zerodha card because they ARE the same statutory
 * rates — that is not duplication by accident. Only `brokeragePerOrder` is a genuine
 * broker choice, and it is the one an operator is most likely to need to change.
 */
export function loadDhanChargeRates(): DhanChargeRates {
  return {
    // Dhan's headline F&O brokerage. Overridable per plan.
    brokeragePerOrder: num("DHAN_BROKERAGE_PER_ORDER", 20),
    brokerageMaxPct: num("DHAN_BROKERAGE_MAX_PCT", 0),
    sttSellPct: num("DHAN_STT_SELL_PCT", 0.1),
    sttRoundNearestRupee: bool("DHAN_STT_ROUND_NEAREST_RUPEE", true),
    exchangeTxnPct: num("DHAN_EXCHANGE_TXN_PCT", 0.03503),
    ipftPerCrore: num("DHAN_IPFT_PER_CRORE", 50),
    sebiPct: num("DHAN_SEBI_PCT", 0.0001),
    stampDutyBuyPct: num("DHAN_STAMP_DUTY_BUY_PCT", 0.003),
    gstPct: num("DHAN_GST_PCT", 18),
    sttType: "stt",
    rateVersion: process.env.DHAN_CHARGE_RATE_VERSION?.trim() || "dhan-nse-options-2026-04-01",
  };
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** STT is billed to the nearest rupee, unlike every other head. */
function roundStt(value: number, rates: DhanChargeRates): number {
  return rates.sttRoundNearestRupee ? Math.round(value) : round2(value);
}

/** IPFT folded into the exchange head, as the contract note presents it. */
function ipftFor(turnover: number, rates: DhanChargeRates): number {
  return (turnover * rates.ipftPerCrore) / 10_000_000;
}

/** Charges for ONE option order under Dhan's card. */
export function calculateDhanLegCharges(
  order: DhanChargeOrder,
  rates: DhanChargeRates,
): BoxLegCharges {
  const value = order.quantity * order.price;
  const capped =
    rates.brokerageMaxPct > 0
      ? Math.min(rates.brokeragePerOrder, (value * rates.brokerageMaxPct) / 100)
      : rates.brokeragePerOrder;
  const brokerage = round2(capped);
  // STT on the sell side only — buying an option incurs none.
  const stt = order.side === "SELL" ? roundStt((value * rates.sttSellPct) / 100, rates) : 0;
  const exchangeTxn = round2((value * rates.exchangeTxnPct) / 100 + ipftFor(value, rates));
  const sebi = round2((value * rates.sebiPct) / 100);
  // Stamp duty on the buy side only.
  const stampDuty = order.side === "BUY" ? round2((value * rates.stampDutyBuyPct) / 100) : 0;
  const gst = round2(((brokerage + exchangeTxn + sebi) * rates.gstPct) / 100);

  return {
    side: order.side,
    tradingsymbol: order.tradingsymbol,
    quantity: order.quantity,
    price: round2(order.price),
    value: round2(value),
    brokerage,
    stt,
    stt_type: rates.sttType,
    exchange_txn: exchangeTxn,
    sebi,
    stamp_duty: stampDuty,
    gst,
    // Sum of the ROUNDED heads, matching how a contract note actually adds up.
    total: round2(brokerage + stt + exchangeTxn + sebi + stampDuty + gst),
  };
}

/**
 * Charges for a set of orders, aggregated.
 *
 * `computed_by` is `"dhan_estimate"` and `broker` is `"dhan"`: this is Dhan's rate
 * card applied locally, NOT a figure Dhan confirmed. Labelling it "local" would let
 * the UI show it beside Zerodha-priced notes as if they were the same thing.
 */
export function calculateDhanCharges(
  orders: DhanChargeOrder[],
  rates: DhanChargeRates,
  at: Date = new Date(),
): BoxChargesWithOrigin {
  const legs = orders.map((o) => calculateDhanLegCharges(o, rates));
  const sum = (pick: (l: BoxLegCharges) => number): number =>
    round2(legs.reduce((acc, l) => acc + pick(l), 0));
  return {
    legs,
    value: sum((l) => l.value),
    brokerage: sum((l) => l.brokerage),
    stt: sum((l) => l.stt),
    exchange_txn: sum((l) => l.exchange_txn),
    sebi: sum((l) => l.sebi),
    stamp_duty: sum((l) => l.stamp_duty),
    gst: sum((l) => l.gst),
    total: sum((l) => l.total),
    // `source` stays within the union the calendar ledger's schema accepts; the
    // broker-specific truth is carried by `computed_by` + `broker`.
    source: "kite_estimate",
    computed_by: "dhan_estimate",
    broker: "dhan",
    at,
  };
}

/** Reverse a set of orders — the exit side of a round trip. */
export function reverseDhanOrders(orders: DhanChargeOrder[]): DhanChargeOrder[] {
  return orders.map((o) => ({ ...o, side: o.side === "BUY" ? "SELL" : "BUY" }));
}

/**
 * A full round trip under Dhan's card.
 *
 * The exit is projected at the ENTRY fills, which is deliberately conservative: the
 * true exit prices are unknown at entry, and over-stating the exit cost can only
 * make the gate stricter.
 */
export function dhanRoundTrip(
  entryOrders: DhanChargeOrder[],
  rates: DhanChargeRates,
  at: Date = new Date(),
): {
  entry: BoxChargesWithOrigin;
  estimated_exit: BoxChargesWithOrigin;
  entry_total: number;
  estimated_exit_total: number;
} {
  const entry = calculateDhanCharges(entryOrders, rates, at);
  const estimatedExit = calculateDhanCharges(reverseDhanOrders(entryOrders), rates, at);
  return {
    entry,
    estimated_exit: estimatedExit,
    entry_total: entry.total,
    estimated_exit_total: estimatedExit.total,
  };
}

/**
 * Dhan's charge calculator, matching `LocalChargeCalculator`'s surface.
 *
 * Same method names on purpose: the Box engine holds one of these behind an
 * interface, so swapping brokers swaps the object rather than adding a branch.
 */
export class DhanChargeCalculator {
  readonly rates: DhanChargeRates;

  constructor(rates?: DhanChargeRates) {
    this.rates = rates ?? loadDhanChargeRates();
  }

  legs(orders: DhanChargeOrder[]): BoxChargesWithOrigin {
    return calculateDhanCharges(orders, this.rates);
  }

  roundTrip(orders: DhanChargeOrder[]): ReturnType<typeof dhanRoundTrip> {
    return dhanRoundTrip(orders, this.rates);
  }

  totals(orders: DhanChargeOrder[]): number {
    return this.legs(orders).total;
  }
}
