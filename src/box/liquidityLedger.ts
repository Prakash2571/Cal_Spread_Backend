/**
 * Shared paper liquidity reservation ledger (live-parity paper only).
 *
 * THE PROBLEM
 * Paper fills walk the current book with a queue haircut, but the book is never
 * mutated. So two simultaneous Box attempts that both want the same displayed level can
 * each "take" the full displayed quantity — 75 lots of displayed depth becomes 150 lots
 * of simulated fills. That flatters results precisely when the strategy is most
 * contended. This ledger makes displayed liquidity a shared, finite resource across
 * concurrent paper attempts, so the SECOND attempt at a level only sees what the FIRST
 * left behind.
 *
 * IDENTITY. A reservation is keyed by (generation, token, side, price, quoteVersion):
 *   - generation  — the feed/broker generation; a broker switch invalidates everything.
 *   - token+side  — a level is a resource for one direction of one instrument.
 *   - price       — reservations are per price level, not per book.
 *   - quoteVersion— THE crucial field. Displayed depth is only a finite resource WITHIN
 *                   one observed book. When a genuinely new book version arrives, the
 *                   exchange has re-published depth, so reservations against the previous
 *                   version must not suppress the newly observed liquidity.
 *
 * PURITY & DETERMINISM. No clock, no randomness, no I/O. Given the same reserve/observe
 * calls in the same order it produces identical numbers every run — which is what lets
 * two concurrent paper attempts resolve deterministically (their fill listeners fire in
 * a fixed subscription order per tick) and lets a Go port reproduce it exactly.
 *
 * IT DOES NOT MUTATE THE QUOTE STORE. The book is read-only shared state; consumption
 * lives here, alongside the paper simulation, never in the feed.
 *
 * WHAT IT DELIBERATELY DOES NOT MODEL. It does not claim true NSE queue position, hidden
 * liquidity, or other participants' consumption — only that OUR OWN concurrent paper
 * attempts cannot double-spend one observed level. That is a conservative, honest bound,
 * not a market-impact model.
 */

/** Composite key for one reservable level. Stable across processes (pure string). */
function levelKey(
  generation: number,
  token: number,
  side: "BUY" | "SELL",
  price: number,
  quoteVersion: number,
): string {
  // Price is rounded to paise so 100.10 and 100.1000001 map to one level.
  return `${generation}|${token}|${side}|${Math.round(price * 100)}|${quoteVersion}`;
}

export interface LiquidityLedgerOptions {
  /**
   * Cap on tracked (token,side) series. Bounded memory on a long-running process; the
   * oldest series is dropped when exceeded. Generous — a full board is ~200 underlyings
   * × a handful of legs.
   */
  maxSeries?: number;
}

const DEFAULT_MAX_SERIES = 4096;

export class PaperLiquidityLedger {
  /**
   * key → reserved quantity. Only the CURRENT quote version per (gen,token,side,price)
   * is retained; a newer version prunes the older keys for that level so stale
   * reservations can never suppress freshly published depth.
   */
  private reserved = new Map<string, number>();
  /**
   * (gen|token|side|price) → the latest quoteVersion seen, so we can prune superseded
   * versions in O(1) rather than scanning.
   */
  private latestVersion = new Map<string, number>();
  private readonly maxSeries: number;

  constructor(opts: LiquidityLedgerOptions = {}) {
    this.maxSeries = Math.max(1, opts.maxSeries ?? DEFAULT_MAX_SERIES);
  }

  private priceSeriesKey(
    generation: number,
    token: number,
    side: "BUY" | "SELL",
    price: number,
  ): string {
    return `${generation}|${token}|${side}|${Math.round(price * 100)}`;
  }

  /**
   * Quantity already reserved at this exact level+version by earlier attempts.
   *
   * Returns 0 for a level whose version has been superseded — a new book version is
   * fresh liquidity, so nothing carries over. This is the read used to shrink a level's
   * effective quantity before a walk.
   */
  reservedAt(
    generation: number,
    token: number,
    side: "BUY" | "SELL",
    price: number,
    quoteVersion: number,
  ): number {
    const series = this.priceSeriesKey(generation, token, side, price);
    const latest = this.latestVersion.get(series);
    // Only the latest observed version carries reservations; older ones are stale.
    if (latest !== undefined && quoteVersion < latest) return 0;
    return this.reserved.get(levelKey(generation, token, side, price, quoteVersion)) ?? 0;
  }

  /**
   * Effective quantity still available to a NEW attempt at this level: the
   * queue-haircut effective quantity minus what earlier concurrent attempts reserved on
   * the same observed version. Never negative.
   *
   * `effectiveForLevel` is the queue-adjusted quantity the caller already computed with
   * the existing `effectiveQty()` — the ledger only subtracts prior reservations; it
   * does not re-apply the haircut.
   */
  availableAt(
    generation: number,
    token: number,
    side: "BUY" | "SELL",
    price: number,
    quoteVersion: number,
    effectiveForLevel: number,
  ): number {
    const already = this.reservedAt(generation, token, side, price, quoteVersion);
    return Math.max(0, effectiveForLevel - already);
  }

  /**
   * Record that `qty` was consumed at a level. A new quoteVersion for the level resets
   * that level's reservations (fresh book), and bumps the tracked latest version.
   *
   * Returns the new total reserved at the level, for assertions/tests.
   */
  reserve(
    generation: number,
    token: number,
    side: "BUY" | "SELL",
    price: number,
    quoteVersion: number,
    qty: number,
  ): number {
    if (!(qty > 0)) return this.reservedAt(generation, token, side, price, quoteVersion);

    const series = this.priceSeriesKey(generation, token, side, price);
    const latest = this.latestVersion.get(series);

    if (latest === undefined || quoteVersion > latest) {
      // First sighting of this level, or a newer book: previous-version reservations
      // for this level are now stale and must not suppress the fresh depth.
      if (latest !== undefined) {
        this.reserved.delete(levelKey(generation, token, side, price, latest));
      }
      this.latestVersion.set(series, quoteVersion);
      this.evictIfNeeded();
    } else if (quoteVersion < latest) {
      // A reservation against an already-superseded version is meaningless — ignore it
      // rather than corrupt the current version's accounting.
      return 0;
    }

    const key = levelKey(generation, token, side, price, quoteVersion);
    const next = (this.reserved.get(key) ?? 0) + qty;
    this.reserved.set(key, next);
    return next;
  }

  /**
   * Drop everything for a broker/feed generation (a switch invalidates all books).
   * Also the natural reset seam for a fresh simulation run in tests.
   */
  clearGeneration(generation: number): void {
    const prefix = `${generation}|`;
    for (const key of this.reserved.keys()) {
      if (key.startsWith(prefix)) this.reserved.delete(key);
    }
    for (const key of this.latestVersion.keys()) {
      if (key.startsWith(prefix)) this.latestVersion.delete(key);
    }
  }

  /** Forget everything. */
  clear(): void {
    this.reserved.clear();
    this.latestVersion.clear();
  }

  get size(): number {
    return this.reserved.size;
  }

  /** Bound memory: when too many series accrue, drop oldest-inserted ones. */
  private evictIfNeeded(): void {
    while (this.latestVersion.size > this.maxSeries) {
      const oldest = this.latestVersion.keys().next();
      if (oldest.done) break;
      const series = oldest.value;
      const version = this.latestVersion.get(series);
      this.latestVersion.delete(series);
      if (version !== undefined) this.reserved.delete(`${series}|${version}`);
    }
  }
}
