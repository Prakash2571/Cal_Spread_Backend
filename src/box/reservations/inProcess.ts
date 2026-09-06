/**
 * THE FAST TIER — in-process, and still genuinely atomic.
 *
 * WHY THIS SURVIVES THE ASYNC REFACTOR UNHARMED
 * The interface now returns promises, but every method here is `async` with NO
 * `await` in its body. A JavaScript async function runs synchronously up to its
 * first `await`, so the inspect-then-commit critical section of `tryAcquireAll`
 * still executes in a single, uninterruptible turn of the event loop — exactly as
 * before. The promise is a wrapper around an already-completed computation, not a
 * scheduling point. That property is load-bearing and is why there is a test
 * asserting two overlapping acquires resolve to one winner without any interleaving.
 *
 * WHY IT IS KEPT AT ALL, NOW THAT A DURABLE TIER EXISTS
 * Because it is free and the durable tier is not. Two executions inside one process
 * fighting over the same strike is the COMMON case — the scanner evaluates
 * overlapping strike pairs on the same tick — and rejecting that here costs a Map
 * lookup instead of a network round trip. The durable tier is only consulted once
 * this one has already agreed the contracts are locally free. Deleting this tier
 * would make the common conflict path 100× more expensive and would gain nothing:
 * the durable tier cannot be more correct about this process than this process is.
 *
 * It is NOT authoritative any more. It is a filter in front of the authority.
 */

import {
  BoundedSamples,
  dedupeKeys,
  normaliseTtl,
  type AcquireArgs,
  type InstrumentReservationStore,
  type OwnershipVerdict,
  type ReleaseArgs,
  type RenewArgs,
  type RenewOutcome,
  type ReservationConflictDetail,
  type ReservationOutcome,
  type ReservationStoreDiagnostics,
  type ReservationWaitable,
  type VerifyArgs,
} from "./types.js";

interface Entry {
  owner: string;
  expiresAt: number;
  side: string | null;
  fence: number;
}

/**
 * Bounded by construction: entries are only created by an execution taking a
 * reservation, every entry carries an expiry, and expired entries are swept lazily
 * on every read plus eagerly on acquire. A crashed or wedged execution cannot hold a
 * contract forever — the TTL is the recovery mechanism, which is the same reason the
 * durable tier needs one.
 */
export class InProcessInstrumentReservations implements InstrumentReservationStore, ReservationWaitable {
  readonly name = "in-process";
  /**
   * FALSE, and that is the whole point of this task.
   *
   * This tier does not survive process death and knows nothing about sibling
   * workers, so it can never satisfy `BOX_RESERVATION_REQUIRE_DURABLE`. Reporting
   * `true` here would make the fail-closed gate a lie.
   */
  readonly durable = false;
  /** Always consultable: it is a Map. */
  readonly ready = true;

  private entries = new Map<string, Entry>();
  /** Waiters keyed by the key they are blocked on, so a release can wake them. */
  private waiters = new Map<string, Set<() => void>>();
  /**
   * A process-local monotonic fence.
   *
   * Honest about its limits: it is unique and increasing WITHIN this process only, so
   * it cannot order two workers' acquisitions. When a durable tier is present the
   * chain reports the durable fence instead, which can. This one exists so a
   * local-only deployment still gets stale-lease detection inside its own process.
   */
  private fenceSeq = 0;
  private stats = {
    acquireAttempts: 0,
    acquireSuccess: 0,
    conflicts: 0,
    renewSuccess: 0,
    renewFailure: 0,
    ownershipLost: 0,
    expiredObserved: 0,
  };
  private latency = new BoundedSamples(256);

  async tryAcquireAll(args: AcquireArgs): Promise<ReservationOutcome> {
    const started = Date.now();
    this.stats.acquireAttempts++;
    const { owner, now } = args;
    const keys = dedupeKeys(args.keys);
    const ttl = normaliseTtl(args.ttlMs);

    // PASS 1 — pure inspection. Nothing is written, so a conflict leaves the store
    // exactly as it was and no partial reservation can be observed or leaked.
    const conflicts: ReservationConflictDetail[] = [];
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry === undefined) continue;
      if (entry.expiresAt <= now) {
        // Expired: treated as free. Counted, because a nonzero rate here means
        // executions are dying without releasing.
        this.stats.expiredObserved++;
        continue;
      }
      // Re-entrancy: a key this owner already holds is not a conflict with itself.
      if (entry.owner === owner) continue;
      conflicts.push({ key, heldBy: entry.owner, heldSide: entry.side, tier: this.name });
    }
    if (conflicts.length > 0) {
      this.stats.conflicts++;
      this.latency.add(Date.now() - started);
      return { ok: false, reason: "conflict", conflicts };
    }

    // PASS 2 — commit. No `await` separates it from pass 1, so this whole method is
    // atomic with respect to every other execution in this process.
    const expiresAt = now + ttl;
    this.fenceSeq += 1;
    const fence = this.fenceSeq;
    for (const key of keys) {
      this.entries.set(key, {
        owner,
        expiresAt,
        side: args.sideByKey?.get(key) ?? null,
        fence,
      });
    }
    this.stats.acquireSuccess++;
    this.latency.add(Date.now() - started);
    return { ok: true, owner, keys, expiresAt, fence, durability: "local_only" };
  }

  async release(args: ReleaseArgs): Promise<number> {
    const candidates = args.keys ?? [...this.entries.keys()];
    let released = 0;
    const woken: string[] = [];
    for (const key of candidates) {
      const entry = this.entries.get(key);
      if (entry === undefined) continue;
      // OWNER CHECK. Never release someone else's reservation — including the case
      // where this owner's entry expired and the key was legitimately retaken.
      if (entry.owner !== args.owner) continue;
      // FENCE CHECK. Redundant given owner ids are never reused, and kept anyway: it
      // makes "a stale owner cannot release a successor's lease" true by construction
      // rather than true by convention.
      if (args.fence !== undefined && entry.fence !== args.fence) continue;
      this.entries.delete(key);
      released++;
      woken.push(key);
    }
    for (const key of woken) this.notify(key);
    return released;
  }

  async renew(args: RenewArgs): Promise<RenewOutcome> {
    const keys = dedupeKeys(args.keys);
    // All-or-none again: a partial renewal would leave an execution holding some of
    // its legs, which is the state this module exists to make unrepresentable.
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry === undefined || entry.owner !== args.owner) {
        this.stats.renewFailure++;
        this.stats.ownershipLost++;
        return { ok: false, reason: "lost", detail: `${this.name}: ${key} is no longer held by this owner` };
      }
      if (entry.expiresAt <= args.now) {
        this.stats.renewFailure++;
        this.stats.ownershipLost++;
        return { ok: false, reason: "expired", detail: `${this.name}: ${key} expired before renewal` };
      }
      if (args.fence !== undefined && entry.fence !== args.fence) {
        this.stats.renewFailure++;
        this.stats.ownershipLost++;
        return { ok: false, reason: "lost", detail: `${this.name}: ${key} belongs to a newer lease` };
      }
    }
    const expiresAt = args.now + normaliseTtl(args.ttlMs);
    let fence = 0;
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry !== undefined) {
        entry.expiresAt = expiresAt;
        fence = entry.fence;
      }
    }
    this.stats.renewSuccess++;
    return { ok: true, expiresAt, fence };
  }

  async verify(args: VerifyArgs): Promise<OwnershipVerdict> {
    const keys = dedupeKeys(args.keys);
    let expiresAt = Number.POSITIVE_INFINITY;
    let fence = 0;
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry === undefined || entry.owner !== args.owner) {
        return { owned: false, reason: "lost", detail: `${this.name}: ${key} is not held by this owner` };
      }
      if (entry.expiresAt <= args.now) {
        return { owned: false, reason: "expired", detail: `${this.name}: ${key} has expired` };
      }
      if (args.fence !== undefined && entry.fence !== args.fence) {
        return { owned: false, reason: "lost", detail: `${this.name}: ${key} belongs to a newer lease` };
      }
      expiresAt = Math.min(expiresAt, entry.expiresAt);
      fence = entry.fence;
    }
    if (keys.length === 0) return { owned: false, reason: "lost", detail: `${this.name}: no keys to verify` };
    return { owned: true, expiresAt, fence };
  }

  async ownerOf(key: string, now: number): Promise<string | null> {
    return this.ownerOfSync(key, now);
  }

  /**
   * The synchronous read, kept because the conflict-classification path inside one
   * process genuinely has no reason to await a Map lookup.
   */
  ownerOfSync(key: string, now: number): string | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      this.notify(key);
      return null;
    }
    return entry.owner;
  }

  async sideOf(key: string, now: number): Promise<string | null> {
    return this.sideOfSync(key, now);
  }

  sideOfSync(key: string, now: number): string | null {
    const entry = this.entries.get(key);
    if (entry === undefined || entry.expiresAt <= now) return null;
    return entry.side;
  }

  activeCount(now: number): number {
    this.sweep(now);
    return this.entries.size;
  }

  activeKeys(now: number): string[] {
    this.sweep(now);
    return [...this.entries.keys()];
  }

  async clear(): Promise<void> {
    const keys = [...this.entries.keys()];
    this.entries.clear();
    for (const key of keys) this.notify(key);
  }

  diagnostics(): ReservationStoreDiagnostics {
    return {
      name: this.name,
      durable: this.durable,
      ready: this.ready,
      activeReservations: this.entries.size,
      acquireAttempts: this.stats.acquireAttempts,
      acquireSuccess: this.stats.acquireSuccess,
      conflicts: this.stats.conflicts,
      errors: 0,
      acquireLatencyP50Ms: this.latency.percentile(0.5),
      acquireLatencyP95Ms: this.latency.percentile(0.95),
      acquireLatencyP99Ms: this.latency.percentile(0.99),
      renewSuccess: this.stats.renewSuccess,
      renewFailure: this.stats.renewFailure,
      ownershipLost: this.stats.ownershipLost,
      expiredReservationsObserved: this.stats.expiredObserved,
      clockOffsetMs: null,
      lastError: null,
    };
  }

  /**
   * Register interest in a key being released.
   *
   * This is what makes waiting event-driven rather than a fixed sleep: the loser of
   * a conflict is woken by the winner's release, typically within a millisecond of
   * it happening, instead of burning a guessed 250 ms during which the opportunity
   * evaporates. The returned function must be called to deregister, so a waiter
   * that times out does not leak.
   *
   * IN-PROCESS ONLY. It cannot observe another worker's release, which is why the
   * coordinator races this against a bounded timer rather than trusting it alone.
   */
  onRelease(keys: readonly string[], cb: () => void): () => void {
    for (const key of keys) {
      let set = this.waiters.get(key);
      if (set === undefined) {
        set = new Set();
        this.waiters.set(key, set);
      }
      set.add(cb);
    }
    return () => {
      for (const key of keys) {
        const set = this.waiters.get(key);
        if (set === undefined) continue;
        set.delete(cb);
        if (set.size === 0) this.waiters.delete(key);
      }
    };
  }

  private notify(key: string): void {
    const set = this.waiters.get(key);
    if (set === undefined) return;
    // Snapshot before calling: a callback will deregister itself, which mutates the set.
    for (const cb of [...set]) {
      try {
        cb();
      } catch {
        /* a waiter's own failure must not stop the others being woken */
      }
    }
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        this.notify(key);
      }
    }
  }
}
