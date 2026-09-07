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
  /** See Tick.depth_updated. False always fails closed for executable storage. */
  depth_updated?: boolean;
  exchange_ts?: number;
}

export interface BoxQuoteDiagnostics {
  authoritative_observations: number;
  usable_book_updates: number;
  depthless_ignored: number;
  empty_invalidations: number;
  malformed_levels_dropped: number;
  generation_invalidations: number;
  ready_books: number;
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
  /** Fixed-cardinality counters only: no token-labelled or unbounded diagnostics. */
  private authoritativeObservations = 0;
  private usableBookUpdates = 0;
  private depthlessIgnored = 0;
  private emptyInvalidations = 0;
  private malformedLevelsDropped = 0;
  private generationInvalidations = 0;

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

  diagnostics(): BoxQuoteDiagnostics {
    return {
      authoritative_observations: this.authoritativeObservations,
      usable_book_updates: this.usableBookUpdates,
      depthless_ignored: this.depthlessIgnored,
      empty_invalidations: this.emptyInvalidations,
      malformed_levels_dropped: this.malformedLevelsDropped,
      generation_invalidations: this.generationInvalidations,
      ready_books: this.quotes.size,
    };
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
   * Explicit production provenance wins. Legacy/custom ticks with no marker are
   * authoritative only when at least one ladder property was explicitly supplied;
   * this preserves structural compatibility without letting an LTP-only shape warm
   * execution readiness. Authoritative empty/fully-invalid books delete the prior
   * book and still notify observers so pending execution paths can fail closed.
   */
  applyTicks(ticks: BoxTickInput[], at = Date.now()): number[] {
    const changed: number[] = [];
    for (const t of ticks) {
      const suppliedBids = Object.prototype.hasOwnProperty.call(t, "bids");
      const suppliedAsks = Object.prototype.hasOwnProperty.call(t, "asks");
      const authoritative = t.depth_updated === true ||
        (t.depth_updated === undefined && (suppliedBids || suppliedAsks));
      if (!authoritative) {
        this.depthlessIgnored++;
        continue;
      }

      this.authoritativeObservations++;
      const bids = this.sanitizeLevels(t.bids ?? [], "BUY");
      const asks = this.sanitizeLevels(t.asks ?? [], "SELL");
      this.updates++;
      this.lastUpdate = at;
      changed.push(t.token);

      if (bids.length === 0 && asks.length === 0) {
        this.quotes.delete(t.token);
        this.emptyInvalidations++;
        // Consume a version for the invalidation event. A later usable snapshot
        // can never share identity with a pre-invalidation book.
        this.nextVersion++;
        continue;
      }

      const bid = bids[0]?.price ?? 0;
      const ask = asks[0]?.price ?? 0;
      this.quotes.set(t.token, {
        token: t.token,
        bid,
        bid_qty: bids.reduce((qty, l) => qty + (l.price === bid ? l.qty : 0), 0),
        ask,
        ask_qty: asks.reduce((qty, l) => qty + (l.price === ask ? l.qty : 0), 0),
        last: Number.isFinite(t.last_price) ? t.last_price : 0,
        bids,
        asks,
        version: this.nextVersion++,
        at,
        exchange_at: typeof t.exchange_ts === "number" &&
          Number.isFinite(t.exchange_ts) && t.exchange_ts > 0 ? t.exchange_ts : null,
        source: "ws",
      });
      this.usableBookUpdates++;
    }
    if (changed.length > 0 && this.listeners.size > 0) {
      for (const listener of this.listeners) {
        try {
          listener(changed, at);
        } catch (err) {
          console.warn("[Box] quote listener failed:", err);
        }
      }
    }
    return changed;
  }

  private sanitizeLevels(
    levels: { price: number; qty: number; orders: number }[],
    side: "BUY" | "SELL",
  ): { price: number; qty: number; orders: number }[] {
    const valid: { price: number; qty: number; orders: number }[] = [];
    for (const level of levels) {
      if (!Number.isFinite(level?.price) || level.price <= 0 ||
          !Number.isFinite(level?.qty) || !Number.isSafeInteger(level.qty) || level.qty <= 0) {
        this.malformedLevelsDropped++;
        continue;
      }
      const orders = Number.isFinite(level.orders) && level.orders >= 0
        ? Math.floor(level.orders)
        : 0;
      valid.push({ price: level.price, qty: level.qty, orders });
    }
    valid.sort((a, b) => side === "BUY" ? b.price - a.price : a.price - b.price);
    // Both production feeds are five-level feeds. Keep the executable store bounded
    // even when a custom producer supplies an unexpectedly large ladder.
    return valid.slice(0, 5);
  }

  /** Forget tokens that are no longer monitored, so the map cannot grow forever. */
  forget(tokens: Iterable<number>): void {
    for (const t of tokens) this.quotes.delete(t);
  }

  /** Drop every book without classifying why (shutdown/test compatibility). */
  clear(): void {
    this.quotes.clear();
    this.lastUpdate = null;
  }

  /** Drop every executable book at a socket-generation boundary. */
  invalidateGeneration(): void {
    this.generationInvalidations++;
    this.clear();
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
