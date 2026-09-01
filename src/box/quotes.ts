/**
 * The box quote store.
 *
 * A single Map<token, BoxQuote> holding the newest executable book per
 * instrument, stamped with the instant it was RECEIVED. Every trading decision
 * reads from here. Executable books come exclusively from the shared Kite
 * WebSocket; REST quotes are never admitted to this store or its feed-health
 * clock. Freshness is measured from the WS receive timestamp.
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
  exchange_ts?: number;
}

/** Notified after every accepted batch of WS depth packets. */
export type BoxQuoteListener = (changed: number[], at: number) => void;

export class BoxQuoteStore {
  private quotes = new Map<number, BoxQuote>();
  private updates = 0;
  private lastUpdate: number | null = null;
  /** Monotonic sequence for immutable WS execution snapshots. */
  private nextVersion = 1;
  /** Execution simulators waiting for a post-arrival book. */
  private listeners = new Set<BoxQuoteListener>();

  /** Number of tokens with a book. */
  get size(): number {
    return this.quotes.size;
  }

  /** Total tick applications since start (for the status endpoint). */
  get updateCount(): number {
    return this.updates;
  }

  /**
   * When ANY book in the universe last updated.
   *
   * This is the feed-liveness signal: with hundreds of instruments subscribed,
   * something is always trading during market hours, so this going quiet means
   * the connection is broken rather than the market being calm.
   */
  get lastUpdateAt(): number | null {
    return this.lastUpdate;
  }

  get(token: number): BoxQuote | undefined {
    return this.quotes.get(token);
  }

  /** The live map, for read-only use by the evaluator. */
  view(): Map<number, BoxQuote> {
    return this.quotes;
  }

  /**
   * Observe accepted depth updates.
   *
   * The execution simulator uses this to capture the FIRST book a leg publishes at
   * or after its simulated order-arrival time. Polling the map alone could miss an
   * intermediate packet and silently fill at a later, different book — which is
   * precisely the kind of quiet inaccuracy this module exists to avoid.
   *
   * Returns an unsubscribe function; the simulator always calls it, so the set
   * cannot grow.
   */
  subscribe(listener: BoxQuoteListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** How many execution pipelines are currently observing the store. */
  get listenerCount(): number {
    return this.listeners.size;
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
      // Clone the arrays: the evaluator and persisted fill must retain the exact
      // WebSocket ladder from this packet even after a later packet replaces it.
      const frozenBids = bids.map((l) => ({ ...l }));
      const frozenAsks = asks.map((l) => ({ ...l }));
      const bestBid = frozenBids.reduce(
        (best, l) => (l.price > best ? l.price : best),
        0,
      );
      const bestAsk = frozenAsks.reduce(
        (best, l) => (l.price > 0 && (best === 0 || l.price < best) ? l.price : best),
        0,
      );
      const bid = bestBid > 0 ? bestBid : (t.bid > 0 ? t.bid : 0);
      const ask = bestAsk > 0 ? bestAsk : (t.ask > 0 ? t.ask : 0);
      this.quotes.set(t.token, {
        token: t.token,
        bid,
        bid_qty: frozenBids.reduce(
          (qty, l) => qty + (l.price === bid && l.qty > 0 ? l.qty : 0),
          0,
        ),
        ask,
        ask_qty: frozenAsks.reduce(
          (qty, l) => qty + (l.price === ask && l.qty > 0 ? l.qty : 0),
          0,
        ),
        last: t.last_price,
        bids: frozenBids,
        asks: frozenAsks,
        version: this.nextVersion++,
        at,
        // Preserve the EXCHANGE timestamp alongside the receive time when the feed
        // supplied one. Receive time still drives freshness/feed-health; the
        // exchange timestamp is what makes cross-leg temporal coherence meaningful.
        exchange_at: typeof t.exchange_ts === "number" && t.exchange_ts > 0 ? t.exchange_ts : null,
        source: "ws",
      });
      this.updates++;
      this.lastUpdate = at;
      changed.push(t.token);
    }
    if (changed.length > 0 && this.listeners.size > 0) {
      for (const listener of this.listeners) {
        try {
          listener(changed, at);
        } catch (err) {
          // A misbehaving observer must never break market-data intake.
          console.warn("[Box] quote listener failed:", err);
        }
      }
    }
    return changed;
  }

  /** Forget tokens that are no longer monitored, so the map cannot grow forever. */
  forget(tokens: Iterable<number>): void {
    for (const t of tokens) this.quotes.delete(t);
  }

  /** Drop every book (e.g. when the Zerodha session dies). */
  clear(): void {
    this.quotes.clear();
    this.lastUpdate = null;
  }

  /**
   * Replay a recorded batch of ticks as if it had arrived from the WebSocket.
   *
   * The seam the deterministic replay harness needs: identical code path,
   * identical listener notifications, no live Zerodha connection.
   */
  replay(ticks: BoxTickInput[], at: number): number[] {
    return this.applyTicks(ticks, at);
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
