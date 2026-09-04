/**
 * A TTL cache that cannot grow without bound.
 *
 * WHY THIS EXISTS
 * `POST /api/quotes` cached its response under a key derived from the CALLER'S token set
 * (`broker:generation:sortedTokens`). The TTL only decided whether an entry was *served* —
 * expired entries were never removed and there was no size cap. Since the route is
 * unauthenticated and accepts up to 4000 tokens, every distinct token permutation left a
 * permanent entry holding a full `Tick[]` including five-level depth ladders. The board,
 * a filtered board, a search result and each stock's detail page are all different
 * permutations, so this grew steadily in normal use and unboundedly under load until the
 * process OOM'd.
 *
 * The fix is a cache that evicts, not a bigger cache. Two independent bounds:
 *   1. TTL   — an entry past its age is deleted, not merely ignored.
 *   2. SIZE  — a hard entry cap with oldest-first eviction.
 *
 * Deliberately tiny and synchronous: no timers to leak, no dependencies, and the sweep is
 * amortised onto writes so there is nothing to shut down.
 */

export interface BoundedTtlCacheOptions {
  ttlMs: number;
  /** Hard ceiling on entries. Oldest insertions are evicted first. */
  maxEntries: number;
  now?: () => number;
}

export class BoundedTtlCache<V> {
  private readonly entries = new Map<string, { at: number; value: V }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: BoundedTtlCacheOptions) {
    this.ttlMs = opts.ttlMs;
    this.maxEntries = Math.max(1, opts.maxEntries);
    this.now = opts.now ?? Date.now;
  }

  /** A fresh value, or undefined. An expired entry is DELETED here, not just skipped. */
  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    // Re-inserting must move the key to the end of the insertion order, otherwise a
    // frequently refreshed key would keep its original eviction position and be dropped
    // while cold keys survive.
    this.entries.delete(key);
    this.entries.set(key, { at: this.now(), value });
    this.evict();
  }

  /**
   * Drop expired entries, then oldest-first until within the cap.
   *
   * Sweeping expired entries first means a burst of unique keys evicts dead weight before
   * it starts discarding anything still useful.
   */
  private evict(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.at <= cutoff) this.entries.delete(key);
    }
    // Map iterates in insertion order, so this removes the oldest first.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
