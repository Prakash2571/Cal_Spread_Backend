/**
 * Broker-neutral instrument universe + F&O board.
 *
 * WHY THIS EXISTS
 * `getAllInstrumentsCached()` called `kite.getInstruments()` unconditionally, so the
 * ordinary calendar-spread board was built from ZERODHA instruments even when Dhan
 * was the active broker. Every token on that board then belonged to the wrong
 * namespace: REST quotes could not resolve them, the feed could not subscribe them,
 * and the homepage showed `LTP -` with no error anywhere.
 *
 * TOKEN NAMESPACE IS THE WHOLE POINT
 * A Kite instrument token and a Dhan internal token are unrelated identifier spaces
 * that happen to both be integers. So the board must be built from the ACTIVE
 * broker's universe and expose only that broker's tokens. This provider guarantees
 * that by construction: there is one cache per broker, and reading it takes the
 * active broker as an argument rather than defaulting to Kite.
 *
 * The wire contract to the frontend is unchanged — `{ symbol, spot_token, futures }` —
 * because the frontend does not need to know which broker minted the ids. It just
 * must not receive a mixture.
 */

import type { Instrument, KiteClient } from "../kite.js";
import type { DhanInstrumentStore } from "./dhan/instruments.js";
import type { BrokerId } from "./types.js";

/** How long a broker's instrument dump is reused. Both change about once a day. */
const CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  at: number;
  data: Instrument[];
  /** The broker the cached dump belongs to — asserted on read. */
  broker: BrokerId;
}

export interface InstrumentProviderDeps {
  activeBroker: () => BrokerId;
  kite: KiteClient;
  dhanInstruments: DhanInstrumentStore;
  /** Bumped on every broker switch; a cache from an older generation is discarded. */
  generation: () => number;
}

export class InstrumentProvider {
  /** One cache PER BROKER, so a switch can never serve the other broker's dump. */
  private caches = new Map<BrokerId, CacheEntry>();
  private generationAt = new Map<BrokerId, number>();
  private inFlight = new Map<BrokerId, Promise<Instrument[]>>();

  constructor(private deps: InstrumentProviderDeps) {}

  /**
   * The ACTIVE broker's instrument universe.
   *
   * Concurrent callers share one load: the Kite dump is a multi-megabyte CSV and the
   * Dhan master is larger still, so a cold cache with ten simultaneous requests must
   * not become ten downloads.
   */
  async load(force = false): Promise<Instrument[]> {
    const broker = this.deps.activeBroker();
    const generation = this.deps.generation();
    const cached = this.caches.get(broker);
    const cachedGeneration = this.generationAt.get(broker);

    const fresh =
      cached !== undefined &&
      cached.broker === broker &&
      cachedGeneration === generation &&
      Date.now() - cached.at < CACHE_TTL_MS &&
      cached.data.length > 0;
    if (fresh && !force) return cached.data;

    const existing = this.inFlight.get(broker);
    if (existing && !force) return existing;

    const task = this.fetchFor(broker)
      .then((data) => {
        this.caches.set(broker, { at: Date.now(), data, broker });
        this.generationAt.set(broker, generation);
        return data;
      })
      .finally(() => {
        this.inFlight.delete(broker);
      });
    this.inFlight.set(broker, task);
    return task;
  }

  private async fetchFor(broker: BrokerId): Promise<Instrument[]> {
    if (broker === "dhan") {
      // Dhan instruments already normalize to the internal `Instrument` shape, with
      // Zerodha-style exchange labels (NFO/NSE/INDICES) and instrument types
      // (FUT/CE/PE/EQ), so every downstream consumer — including deriveFnoBoard —
      // works unchanged. See dhan/instruments.ts.
      const rows = await this.deps.dhanInstruments.load();
      console.log(`[Broker] Dhan universe loaded: ${rows.length.toLocaleString()} instruments`);
      return rows;
    }
    const rows = await this.deps.kite.getInstruments();
    console.log(`[Broker] Zerodha universe loaded: ${rows.length.toLocaleString()} instruments`);
    return rows;
  }

  /** How many instruments the active broker's universe currently holds. */
  size(): number {
    const broker = this.deps.activeBroker();
    return this.caches.get(broker)?.data.length ?? 0;
  }

  loadedAt(): number | null {
    const broker = this.deps.activeBroker();
    return this.caches.get(broker)?.at ?? null;
  }

  /**
   * Drop a broker's cached universe.
   *
   * Called on a broker switch. Dropping rather than keeping is deliberate: a stale
   * dump would let the previous broker's tokens keep resolving, which is exactly the
   * cross-namespace leak the switch exists to prevent.
   */
  invalidate(broker?: BrokerId): void {
    if (broker) {
      this.caches.delete(broker);
      this.generationAt.delete(broker);
      return;
    }
    this.caches.clear();
    this.generationAt.clear();
  }

  /**
   * Whether a token belongs to the ACTIVE broker's universe.
   *
   * The runtime assertion behind `assertActiveBrokerToken`. Returns null when the
   * universe has not loaded, so "cannot tell" stays distinguishable from "wrong
   * broker" — refusing a token because a CSV is still downloading would be its own
   * bug.
   */
  ownsToken(token: number): boolean | null {
    const broker = this.deps.activeBroker();
    const cached = this.caches.get(broker);
    if (!cached || cached.data.length === 0) return null;
    // Built lazily and memoized per cache entry; the universe is large and this is
    // called on hot paths.
    let index = this.tokenIndexes.get(broker);
    if (!index || index.at !== cached.at) {
      index = { at: cached.at, tokens: new Set(cached.data.map((i) => i.instrument_token)) };
      this.tokenIndexes.set(broker, index);
    }
    return index.tokens.has(token);
  }

  private tokenIndexes = new Map<BrokerId, { at: number; tokens: Set<number> }>();
}
