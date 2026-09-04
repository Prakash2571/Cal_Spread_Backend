/**
 * EXECUTABLE ORDER PRICING — the marketable-limit model, depth walking and the
 * conservative queue approximation.
 *
 * Every function here is PURE: no clock, no randomness, no I/O. Given the same
 * book and the same configuration it returns the same fills, byte for byte. That
 * determinism is load-bearing — the whole point of a paper simulator is that a
 * recorded market always reproduces the same result.
 *
 * THREE IDEAS
 *
 * 1. MARKETABLE LIMIT (not a market order). An order is priced against a REFERENCE
 *    touch and carries a LIMIT a bounded number of ticks past it. The book may be
 *    walked only down to that limit; anything worse is refused. This is the
 *    difference between "I'll pay up to ₹100.10" and "I'll pay whatever is
 *    showing" — real arbitrage execution is the former.
 *
 *       BUY : limit = reference + chaseTicks × tick   (willing to pay UP TO)
 *       SELL: limit = reference − chaseTicks × tick   (willing to sell DOWN TO)
 *
 * 2. DEPTH WALKING. A marketable-limit order fills across as many book levels as
 *    it needs, stopping at the limit. The average fill price is the
 *    quantity-weighted mean of the slices it took.
 *
 * 3. CONSERVATIVE QUEUE APPROXIMATION. We cannot see NSE order-level queue
 *    priority from level-2 depth, so we do NOT pretend the displayed quantity is
 *    all ours. With the "haircut" model only a configurable fraction of each
 *    displayed level is treated as executable for us. This is a transparent,
 *    deterministic stand-in — NOT a reconstruction of true queue position — and it
 *    is recorded (displayed vs effective) so a paper run can compare raw and
 *    conservative liquidity. Randomness is never used.
 */

import type { BoxDepthLevel, BoxQueueModel, OrderSide, PaperFillSlice, PaperOrderPricing } from "./types.js";

/** Float comparisons on prices tolerate a sub-paise epsilon. */
const EPS = 1e-9;

/** Round money to paise so float noise never reaches the ledger. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Snap a price to the nearest tick multiple, then to paise. */
export function roundToTick(price: number, tick: number): number {
  if (!(tick > 0)) return round2(price);
  return round2(Math.round(price / tick) * tick);
}

/**
 * The worst price a marketable-limit order will accept.
 *
 * The chase band widens the limit AWAY from us: dearer for a BUY, cheaper for a
 * SELL. Snapped to the tick grid so the limit is itself a tradable price.
 */
export function computeLimitPrice(args: {
  side: OrderSide;
  referencePrice: number;
  tickSize: number;
  maxChaseTicks: number;
}): number {
  const { side, referencePrice, tickSize, maxChaseTicks } = args;
  const chase = Math.max(0, Math.round(maxChaseTicks)) * (tickSize > 0 ? tickSize : 0);
  const raw = side === "BUY" ? referencePrice + chase : referencePrice - chase;
  return roundToTick(raw, tickSize);
}

/** Build the full pricing envelope for one order. */
export function buildOrderPricing(args: {
  side: OrderSide;
  quantity: number;
  referencePrice: number;
  tickSize: number;
  maxChaseTicks: number;
}): PaperOrderPricing {
  const tick = args.tickSize > 0 ? args.tickSize : 0.05;
  return {
    order_type: "MARKETABLE_LIMIT",
    side: args.side,
    quantity: args.quantity,
    reference_price: round2(args.referencePrice),
    tick_size: tick,
    max_chase_ticks: Math.max(0, Math.round(args.maxChaseTicks)),
    limit_price: computeLimitPrice({
      side: args.side,
      referencePrice: args.referencePrice,
      tickSize: tick,
      maxChaseTicks: args.maxChaseTicks,
    }),
  };
}

/**
 * The quantity at a displayed level that is treated as executable FOR US.
 *
 * "none": all of it. "haircut": the fraction not assumed to be queued ahead of us,
 * floored to whole contracts. Deterministic — the same displayed quantity and the
 * same configuration always yield the same effective quantity.
 */
export function effectiveQty(displayed: number, model: BoxQueueModel, haircutPct: number): number {
  if (!(displayed > 0)) return 0;
  if (model === "none") return Math.floor(displayed);
  const pct = Math.min(100, Math.max(0, haircutPct));
  return Math.floor(displayed * (1 - pct / 100));
}

/** Whether a level's price is executable for a side against a limit. */
function withinLimit(side: OrderSide, price: number, limit: number): boolean {
  if (!(price > 0)) return false;
  return side === "BUY" ? price <= limit + EPS : price >= limit - EPS;
}

export interface DepthWalkResult {
  /** Quantity this walk could fill from the given book. */
  filled_qty: number;
  /** Quantity-weighted average price of the slices, or null if nothing filled. */
  average_price: number | null;
  slices: PaperFillSlice[];
  /**
   * Executable quantity available within the limit on THIS book, after the queue
   * model — i.e. the most this order could have taken here regardless of how much
   * it still wanted. Recorded for the "estimated vs realised executable" metric.
   */
  executable_within_limit: number;
}

/**
 * Walk the book for one order, up to `remainingQty`, never past `limitPrice`,
 * consuming only the queue-adjusted effective quantity at each level.
 *
 * Levels are visited best-price-first (lowest ask for a BUY, highest bid for a
 * SELL). The book is not mutated. Slices are stamped with the supplied book time
 * and version so a fill is always traceable to the exact packet it came from.
 */
export function walkDepth(args: {
  side: OrderSide;
  levels: BoxDepthLevel[];
  remainingQty: number;
  limitPrice: number;
  queueModel: BoxQueueModel;
  haircutPct: number;
  at: number;
  quoteVersion: number | null;
  /**
   * OPTIONAL, live-parity paper only: quantity already reserved by earlier concurrent
   * paper attempts at (price, version), subtracted from each level's queue-adjusted
   * effective quantity so two attempts cannot double-consume one observed level. When
   * omitted the walk is byte-identical to before — standard paper and the live precheck
   * never pass it.
   */
  reserved?: ((price: number, quoteVersion: number | null) => number) | undefined;
}): DepthWalkResult {
  const { side, levels, remainingQty, limitPrice, queueModel, haircutPct, at, quoteVersion, reserved } = args;
  const slices: PaperFillSlice[] = [];
  let remaining = Math.max(0, remainingQty);
  let filled = 0;
  let valueSum = 0;
  let executableWithinLimit = 0;

  // Best price first: ascending for a BUY (cheapest ask), descending for a SELL
  // (richest bid). Sorting a COPY leaves the caller's book untouched.
  const ordered = [...levels]
    .filter((l) => l.price > 0 && l.qty > 0)
    .sort((a, b) => (side === "BUY" ? a.price - b.price : b.price - a.price));

  for (const lv of ordered) {
    if (!withinLimit(side, lv.price, limitPrice)) break; // deeper levels are only worse
    const effectiveRaw = effectiveQty(lv.qty, queueModel, haircutPct);
    // Subtract liquidity earlier concurrent paper attempts already reserved at this
    // exact level+version. `reserved` is undefined outside live-parity paper, so this is
    // a no-op and the result is identical to before.
    const already = reserved ? Math.max(0, reserved(lv.price, quoteVersion)) : 0;
    const effective = Math.max(0, effectiveRaw - already);
    executableWithinLimit += effective;
    if (remaining <= 0 || effective <= 0) continue;
    const take = Math.min(remaining, effective);
    if (take <= 0) continue;
    slices.push({
      price: round2(lv.price),
      qty: take,
      displayed_qty: lv.qty,
      effective_qty: effective,
      at,
      quote_version: quoteVersion,
    });
    filled += take;
    valueSum += lv.price * take;
    remaining -= take;
  }

  return {
    filled_qty: filled,
    average_price: filled > 0 ? round2(valueSum / filled) : null,
    slices,
    executable_within_limit: executableWithinLimit,
  };
}

/** The best (touch) price on one side of a book: lowest ask for a BUY, highest bid for a SELL. */
export function touchPrice(side: OrderSide, bids: BoxDepthLevel[], asks: BoxDepthLevel[]): number | null {
  const levels = side === "BUY" ? asks : bids;
  let best: number | null = null;
  for (const l of levels) {
    if (!(l.price > 0)) continue;
    if (best === null) best = l.price;
    else best = side === "BUY" ? Math.min(best, l.price) : Math.max(best, l.price);
  }
  return best;
}
