/**
 * Refcounted market-data subscription coordinator.
 *
 * THE PROBLEM IT SOLVES
 * One instrument token can be wanted simultaneously by several independent
 * consumers: two browser SSE clients, the Box scanner, an open Box position, and a
 * headless analytics job. Before this existed, `/api/stream` registered browser
 * tokens straight into the Kite hub, which meant two things went wrong at once:
 *
 *   1. The LAST consumer to disconnect could unsubscribe a token that others still
 *      needed — or, worse, `hub.stop()` tore down the whole feed.
 *   2. Browser subscriptions reached Kite DIRECTLY, so opening a browser tab while
 *      Dhan was the active broker opened a ZERODHA WebSocket.
 *
 * So subscriptions are now owned, counted, and diffed:
 *
 *   consumer (browser/scanner/strategy/analytics)
 *        -> SubscriptionCoordinator  (refcount per owner class)
 *        -> ActiveBrokerManager.subscribeTokens()
 *        -> the ACTIVE broker's socket only
 *
 * UPSTREAM SEES ONLY TRANSITIONS. A token is subscribed upstream when its total
 * refcount goes 0 -> 1 and unsubscribed when it returns to 0. Never more than once,
 * so there are no duplicate upstream subscriptions.
 *
 * GENERATION-SCOPED. Kite tokens and Dhan tokens are different namespaces, so a
 * broker switch invalidates every registration: `resetForBrokerSwitch()` drops the
 * whole table rather than trying to translate tokens that have no counterpart.
 */

/** Who wants a token. Kept coarse on purpose — one class per lifecycle. */
export type SubscriptionOwner = "browser" | "scanner" | "strategy" | "analytics";

const OWNERS: readonly SubscriptionOwner[] = ["browser", "scanner", "strategy", "analytics"];

interface TokenCounts {
  browser: number;
  scanner: number;
  strategy: number;
  analytics: number;
  total: number;
}

export interface SubscriptionTransport {
  /** Subscribe on the ACTIVE broker. Called only for 0 -> 1 transitions. */
  subscribeTokens(tokens: number[]): void;
  /** Unsubscribe on the ACTIVE broker. Called only for 1 -> 0 transitions. */
  unsubscribeTokens(tokens: number[]): void;
}

export class SubscriptionCoordinator {
  private counts = new Map<number, TokenCounts>();
  /**
   * Per-lease token sets, so a consumer can be released wholesale without having to
   * remember what it asked for. A browser tab that dies mid-request must not leak a
   * permanent subscription.
   */
  private leases = new Map<string, { owner: SubscriptionOwner; tokens: Set<number> }>();
  private leaseSeq = 0;

  constructor(private transport: SubscriptionTransport) {}

  private empty(): TokenCounts {
    return { browser: 0, scanner: 0, strategy: 0, analytics: 0, total: 0 };
  }

  /**
   * Acquire a lease on a set of tokens. Returns a release function.
   *
   * Idempotent within a lease: acquiring the same token twice under one lease counts
   * once, so a client that repeats a token in its query string does not inflate the
   * refcount and strand the subscription on release.
   */
  acquire(owner: SubscriptionOwner, tokens: number[]): { leaseId: string; release: () => void } {
    const unique = new Set(tokens.filter((t) => Number.isFinite(t) && t > 0));
    const leaseId = `${owner}:${++this.leaseSeq}`;
    this.leases.set(leaseId, { owner, tokens: unique });

    const toSubscribe: number[] = [];
    for (const token of unique) {
      const entry = this.counts.get(token) ?? this.empty();
      const wasZero = entry.total === 0;
      entry[owner] += 1;
      entry.total += 1;
      this.counts.set(token, entry);
      // Only a 0 -> 1 transition reaches upstream.
      if (wasZero) toSubscribe.push(token);
    }
    if (toSubscribe.length > 0) this.transport.subscribeTokens(toSubscribe);

    let released = false;
    return {
      leaseId,
      release: () => {
        // Guard against a double release (an SSE 'close' can fire more than once).
        if (released) return;
        released = true;
        this.releaseLease(leaseId);
      },
    };
  }

  private releaseLease(leaseId: string): void {
    const lease = this.leases.get(leaseId);
    if (!lease) return;
    this.leases.delete(leaseId);

    const toUnsubscribe: number[] = [];
    for (const token of lease.tokens) {
      const entry = this.counts.get(token);
      if (!entry) continue;
      entry[lease.owner] = Math.max(0, entry[lease.owner] - 1);
      entry.total = Math.max(0, entry.total - 1);
      if (entry.total === 0) {
        this.counts.delete(token);
        toUnsubscribe.push(token);
      } else {
        this.counts.set(token, entry);
      }
    }
    if (toUnsubscribe.length > 0) this.transport.unsubscribeTokens(toUnsubscribe);
  }

  /**
   * Replace an owner's ENTIRE token set in one atomic diff.
   *
   * This is what the Box scanner needs: its window moves as the underlying drifts, so
   * it declares "these are the tokens I want now" and the coordinator works out the
   * additions and removals. Doing it as one diff (rather than release-then-acquire)
   * matters because the naive order would briefly drop the total to zero for tokens
   * that are in BOTH sets, causing an unsubscribe/resubscribe flap upstream.
   */
  setOwnerTokens(owner: SubscriptionOwner, tokens: number[]): void {
    const want = new Set(tokens.filter((t) => Number.isFinite(t) && t > 0));

    // Drop this owner's existing leases from the counts without touching upstream yet.
    const previouslyHeld = new Set<number>();
    for (const [leaseId, lease] of [...this.leases]) {
      if (lease.owner !== owner) continue;
      for (const token of lease.tokens) previouslyHeld.add(token);
      this.leases.delete(leaseId);
    }

    const toSubscribe: number[] = [];
    const toUnsubscribe: number[] = [];

    for (const token of previouslyHeld) {
      if (want.has(token)) continue;
      const entry = this.counts.get(token);
      if (!entry) continue;
      entry[owner] = Math.max(0, entry[owner] - 1);
      entry.total = Math.max(0, entry.total - 1);
      if (entry.total === 0) {
        this.counts.delete(token);
        toUnsubscribe.push(token);
      } else {
        this.counts.set(token, entry);
      }
    }

    for (const token of want) {
      if (previouslyHeld.has(token)) continue; // already counted for this owner
      const entry = this.counts.get(token) ?? this.empty();
      const wasZero = entry.total === 0;
      entry[owner] += 1;
      entry.total += 1;
      this.counts.set(token, entry);
      if (wasZero) toSubscribe.push(token);
    }

    // Re-register the owner's holding as a single lease so a later reset is clean.
    if (want.size > 0) {
      this.leases.set(`${owner}:set`, { owner, tokens: want });
    }

    if (toUnsubscribe.length > 0) this.transport.unsubscribeTokens(toUnsubscribe);
    if (toSubscribe.length > 0) this.transport.subscribeTokens(toSubscribe);
  }

  /**
   * Drop EVERYTHING on a broker switch.
   *
   * No upstream unsubscribe is issued: the old broker's socket is being stopped
   * anyway, and its tokens have no meaning to the new broker. Attempting to translate
   * them would be the exact namespace leak the switch exists to prevent — a Kite
   * token is not a Dhan token even when the integers coincide.
   *
   * Consumers re-register afterwards with the NEW broker's token ids: the scanner via
   * its universe rebuild, browsers by refetching the board and reopening SSE.
   */
  resetForBrokerSwitch(): { droppedTokens: number; droppedLeases: number } {
    const droppedTokens = this.counts.size;
    const droppedLeases = this.leases.size;
    this.counts.clear();
    this.leases.clear();
    return { droppedTokens, droppedLeases };
  }

  /** Every token with at least one consumer. */
  activeTokens(): number[] {
    return [...this.counts.keys()];
  }

  get size(): number {
    return this.counts.size;
  }

  /** Refcounts for one token, or null when nobody wants it. */
  countsFor(token: number): TokenCounts | null {
    const entry = this.counts.get(token);
    return entry ? { ...entry } : null;
  }

  /** Per-owner totals, for the status endpoints. */
  stats(): Record<SubscriptionOwner, number> & { tokens: number; leases: number } {
    const out = { browser: 0, scanner: 0, strategy: 0, analytics: 0, tokens: 0, leases: 0 };
    for (const entry of this.counts.values()) {
      for (const owner of OWNERS) if (entry[owner] > 0) out[owner] += 1;
    }
    out.tokens = this.counts.size;
    out.leases = this.leases.size;
    return out;
  }
}
