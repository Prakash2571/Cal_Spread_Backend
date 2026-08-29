/**
 * The box quote store.
 *
 * A single Map<token, BoxQuote> holding the newest executable book per
 * instrument, stamped with the instant it was RECEIVED. Every trading decision
 * reads from here, and the freshness gate is measured against those stamps — so
 * a book that stopped updating can never be traded on.
 *
 * Ticks arrive from the SHARED Kite WebSocket (see hub.ts). A REST snapshot is
 * only used to seed instruments that have not ticked yet, and is stamped exactly
 * like a live tick because it is equally a real book at a real instant.
 */

import type { BoxQuote } from "./types.js";

/**
 * The parsed-tick shape this store consumes.
 *
 * Declared structurally rather than imported from the ticker so the quote store —
 * and everything downstream of it — stays free of third-party dependencies. The
 * shared ticker's `Tick` satisfies it exactly.
 */
export interface BoxTickInput {
  token: number;
  last_price: number;
  bid: number;
  ask: number;
  bids?: { price: number; qty: number; orders: number }[];
  asks?: { price: number; qty: number; orders: number }[];
}

export class BoxQuoteStore {
  private quotes = new Map<number, BoxQuote>();
  private updates = 0;

  /** Number of tokens with a book. */
  get size(): number {
    return this.quotes.size;
  }

  /** Total tick applications since start (for the status endpoint). */
  get updateCount(): number {
    return this.updates;
  }

  get(token: number): BoxQuote | undefined {
    return this.quotes.get(token);
  }

  /** The live map, for read-only use by the evaluator. */
  view(): Map<number, BoxQuote> {
    return this.quotes;
  }

  /** True when a token has a book no older than maxAgeMs. */
  isFresh(token: number, maxAgeMs: number, now = Date.now()): boolean {
    const q = this.quotes.get(token);
    if (!q) return false;
    return now - q.at <= maxAgeMs;
  }

  /**
   * Apply a batch of live ticks.
   *
   * Only ticks that actually carry depth update the book: a "full" packet
   * without depth arrays would otherwise blank a good book and make a tradable
   * leg look unquoted. `bid`/`ask` scalars are kept as a fallback for the touch.
   */
  applyTicks(ticks: BoxTickInput[], at = Date.now()): number[] {
    const changed: number[] = [];
    for (const t of ticks) {
      const bids = t.bids ?? [];
      const asks = t.asks ?? [];
      const hasDepth = bids.length > 0 || asks.length > 0;
      const prev = this.quotes.get(t.token);
      if (!hasDepth && prev) {
        // Keep the existing book but do NOT refresh its timestamp: nothing new
        // about the executable touch arrived, so it must keep ageing out.
        continue;
      }
      this.quotes.set(t.token, {
        token: t.token,
        bid: t.bid > 0 ? t.bid : (bids[0]?.price ?? 0),
        bid_qty: bids[0]?.qty ?? 0,
        ask: t.ask > 0 ? t.ask : (asks[0]?.price ?? 0),
        ask_qty: asks[0]?.qty ?? 0,
        last: t.last_price,
        bids,
        asks,
        at,
        source: "ws",
      });
      this.updates++;
      changed.push(t.token);
    }
    return changed;
  }

  /** Apply a REST ladder snapshot (used to seed tokens that have not ticked). */
  applyLadder(
    token: number,
    ladder: { last: number; bids: { price: number; qty: number }[]; asks: { price: number; qty: number }[] },
    at = Date.now(),
  ): void {
    const bids = ladder.bids.map((l) => ({ price: l.price, qty: l.qty, orders: 0 }));
    const asks = ladder.asks.map((l) => ({ price: l.price, qty: l.qty, orders: 0 }));
    this.quotes.set(token, {
      token,
      bid: bids[0]?.price ?? 0,
      bid_qty: bids[0]?.qty ?? 0,
      ask: asks[0]?.price ?? 0,
      ask_qty: asks[0]?.qty ?? 0,
      last: ladder.last,
      bids,
      asks,
      at,
      source: "rest",
    });
    this.updates++;
  }

  /** Forget tokens that are no longer monitored, so the map cannot grow forever. */
  forget(tokens: Iterable<number>): void {
    for (const t of tokens) this.quotes.delete(t);
  }

  /** Drop every book (e.g. when the Zerodha session dies). */
  clear(): void {
    this.quotes.clear();
  }
}

/** The last value + timestamp of an underlying, used to place the ATM window. */
export class SpotStore {
  private spots = new Map<number, { value: number; at: number }>();

  set(token: number, value: number, at = Date.now()): void {
    if (!(value > 0)) return;
    this.spots.set(token, { value, at });
  }

  get(token: number): { value: number; at: number } | undefined {
    return this.spots.get(token);
  }

  /** True when the underlying value is recent enough to trust the ATM window. */
  isFresh(token: number, maxAgeMs: number, now = Date.now()): boolean {
    const s = this.spots.get(token);
    if (!s) return false;
    return now - s.at <= maxAgeMs;
  }

  clear(): void {
    this.spots.clear();
  }
}
