/**
 * Atomic all-or-none reservation of a SET of option contracts.
 *
 * THE PROBLEM
 * Two Box executions can need overlapping contracts. If each grabbed its legs one
 * at a time, A could hold 1320 while waiting for 1340 exactly as B holds 1340 while
 * waiting for 1320 — a textbook deadlock. So no partial state is ever observable:
 * a reservation either takes every key it asked for, or takes none of them and
 * reports precisely which keys blocked it.
 *
 * WHY THE IN-PROCESS STORE IS GENUINELY ATOMIC
 * `tryAcquireAll` checks every key and then writes every key without an `await`
 * between the two passes. Node runs one turn of the event loop to completion, so no
 * other execution can interleave inside that window. This is exactly the property
 * `BoxPositionBook.reserve()` already documents and relies on ("two ticks arriving
 * in the same turn of the event loop cannot both begin an entry"). It is not a
 * weaker substitute for a distributed lock — for a single process it is strictly
 * stronger than one, because it cannot fail, time out, or be delayed by a network.
 *
 * WHY NOT REDIS AS THE PRIMARY TIER
 * `src/redis.ts` is Upstash over REST: one HTTP POST per call, an 8 second timeout,
 * and — by explicit documented design — it NEVER throws, returning `null` when
 * unreachable. Two things follow. First, a round trip costs more than the arbitrage
 * this coordinator protects is worth: the whole conflict-wait budget is a couple of
 * hundred milliseconds. Second, `null` meaning "carry on" is the exact inverse of
 * what a safety primitive needs, so it would have to be wrapped in a strict mode
 * that contradicts its own contract. The deployment is also PM2 fork mode, single
 * instance, so there is no second worker for a distributed lock to coordinate with
 * today.
 *
 * That is a statement about what is true NOW, not an argument against ever doing
 * it. `InstrumentReservationStore` exists precisely so a durable cross-process tier
 * can be added without the coordinator changing: implement the interface, chain it,
 * and set `requireDurableReservations` so live execution fails closed when it is
 * unavailable. `boxInstrumentRefs()` already emits keys in a total order so such a
 * tier can take locks one at a time without deadlocking.
 */

/** Why an acquire attempt failed, when it did. */
export interface ReservationConflictDetail {
  readonly key: string;
  readonly heldBy: string;
}

export type ReservationOutcome =
  | { readonly ok: true; readonly owner: string; readonly keys: readonly string[]; readonly expiresAt: number }
  | { readonly ok: false; readonly conflicts: readonly ReservationConflictDetail[] };

export interface AcquireArgs {
  /** Unique id of the execution attempting the reservation. */
  readonly owner: string;
  readonly keys: readonly string[];
  readonly ttlMs: number;
  readonly now: number;
  /**
   * Opaque per-key metadata the store carries back on a conflict, so a caller can
   * describe an overlap (e.g. the side the incumbent intended) without a second
   * lookup. Never interpreted by the store.
   */
  readonly sideByKey?: ReadonlyMap<string, string>;
}

export interface InstrumentReservationStore {
  /** Diagnostic name, surfaced in metrics and fail-closed messages. */
  readonly name: string;
  /** True when this tier survives process death (and so can be relied on across workers). */
  readonly durable: boolean;
  /** Take every key or none. */
  tryAcquireAll(args: AcquireArgs): ReservationOutcome;
  /**
   * Release keys held by `owner`. Returns how many were actually released.
   *
   * MUST NOT release a key owned by anyone else. This is the compare-owner-and-delete
   * that a naive `GET` then `DEL` would get wrong: between the two, the key can have
   * expired and been retaken by a different execution, and deleting it then would
   * strip an active reservation from its rightful owner.
   */
  release(args: { readonly owner: string; readonly keys?: readonly string[]; readonly now: number }): number;
  /** Extend an owner's existing keys. Returns false if any key is no longer theirs. */
  renew(args: { readonly owner: string; readonly keys: readonly string[]; readonly ttlMs: number; readonly now: number }): boolean;
  /** Current owner of a key, or null when free/expired. */
  ownerOf(key: string, now: number): string | null;
  /** The side metadata recorded with a key by its current owner, if any. */
  sideOf(key: string, now: number): string | null;
  /** Live (unexpired) reservation count. */
  activeCount(now: number): number;
  /** Every live key, for diagnostics. */
  activeKeys(now: number): string[];
  /** Drop everything. Used on broker switch, where keys change namespace wholesale. */
  clear(): void;
}

interface Entry {
  owner: string;
  expiresAt: number;
  side: string | null;
}

/**
 * The authoritative in-process store.
 *
 * Bounded by construction: entries are only created by an execution taking a
 * reservation, every entry carries an expiry, and expired entries are swept lazily
 * on every read plus eagerly on acquire. A crashed or wedged execution therefore
 * cannot hold a contract forever — the TTL is the recovery mechanism, which is the
 * same reason a distributed lock would need one.
 */
export class InProcessInstrumentReservations implements InstrumentReservationStore {
  readonly name = "in-process";
  readonly durable = false;

  private entries = new Map<string, Entry>();
  /** Waiters keyed by the key they are blocked on, so a release can wake them. */
  private waiters = new Map<string, Set<() => void>>();

  tryAcquireAll(args: AcquireArgs): ReservationOutcome {
    const { owner, keys, now } = args;
    const ttl = Number.isFinite(args.ttlMs) && args.ttlMs > 0 ? args.ttlMs : 1000;

    // PASS 1 — pure inspection. Nothing is written, so a conflict leaves the store
    // exactly as it was and no partial reservation can be observed or leaked.
    const conflicts: ReservationConflictDetail[] = [];
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry === undefined) continue;
      if (entry.expiresAt <= now) continue; // expired: treated as free
      // Re-entrancy: a key this owner already holds is not a conflict with itself.
      if (entry.owner === owner) continue;
      conflicts.push({ key, heldBy: entry.owner });
    }
    if (conflicts.length > 0) return { ok: false, conflicts };

    // PASS 2 — commit. No await separates it from pass 1, so this whole method is
    // atomic with respect to every other execution in this process.
    const expiresAt = now + ttl;
    for (const key of keys) {
      this.entries.set(key, { owner, expiresAt, side: args.sideByKey?.get(key) ?? null });
    }
    return { ok: true, owner, keys: [...keys], expiresAt };
  }

  release(args: { readonly owner: string; readonly keys?: readonly string[]; readonly now: number }): number {
    const candidates = args.keys ?? [...this.entries.keys()];
    let released = 0;
    const woken: string[] = [];
    for (const key of candidates) {
      const entry = this.entries.get(key);
      if (entry === undefined) continue;
      // OWNER CHECK. Never release someone else's reservation — including the case
      // where this owner's entry expired and the key was legitimately retaken.
      if (entry.owner !== args.owner) continue;
      this.entries.delete(key);
      released++;
      woken.push(key);
    }
    for (const key of woken) this.notify(key);
    return released;
  }

  renew(args: { readonly owner: string; readonly keys: readonly string[]; readonly ttlMs: number; readonly now: number }): boolean {
    // All-or-none again: a partial renewal would leave an execution holding some of
    // its legs, which is the state this module exists to make unrepresentable.
    for (const key of args.keys) {
      const entry = this.entries.get(key);
      if (entry === undefined || entry.owner !== args.owner || entry.expiresAt <= args.now) return false;
    }
    const expiresAt = args.now + (args.ttlMs > 0 ? args.ttlMs : 1000);
    for (const key of args.keys) {
      const entry = this.entries.get(key);
      if (entry !== undefined) entry.expiresAt = expiresAt;
    }
    return true;
  }

  ownerOf(key: string, now: number): string | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      this.notify(key);
      return null;
    }
    return entry.owner;
  }

  sideOf(key: string, now: number): string | null {
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

  clear(): void {
    const keys = [...this.entries.keys()];
    this.entries.clear();
    for (const key of keys) this.notify(key);
  }

  /**
   * Register interest in a key being released.
   *
   * This is what makes waiting event-driven rather than a fixed sleep: the loser of
   * a conflict is woken by the winner's release, typically within a millisecond of
   * it happening, instead of burning a guessed 250 ms during which the opportunity
   * evaporates. The returned function must be called to deregister, so a waiter
   * that times out does not leak.
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

/**
 * A store that requires every tier to agree.
 *
 * Acquire order is fixed (primary first, then each durable tier in turn) and any
 * failure rolls back the tiers already taken, so the all-or-none guarantee holds
 * across tiers as well as across keys. Present so a Mongo- or Redis-backed durable
 * tier can be added without touching the coordinator.
 */
export class ChainedInstrumentReservations implements InstrumentReservationStore {
  readonly name: string;
  readonly durable: boolean;

  constructor(private readonly tiers: readonly InstrumentReservationStore[]) {
    if (tiers.length === 0) throw new Error("ChainedInstrumentReservations requires at least one tier");
    this.name = tiers.map((t) => t.name).join("+");
    this.durable = tiers.some((t) => t.durable);
  }

  tryAcquireAll(args: AcquireArgs): ReservationOutcome {
    const taken: InstrumentReservationStore[] = [];
    for (const tier of this.tiers) {
      const outcome = tier.tryAcquireAll(args);
      if (outcome.ok) {
        taken.push(tier);
        continue;
      }
      // Roll back, in reverse, only what this owner took.
      for (const done of taken.reverse()) done.release({ owner: args.owner, keys: args.keys, now: args.now });
      return outcome;
    }
    const ttl = Number.isFinite(args.ttlMs) && args.ttlMs > 0 ? args.ttlMs : 1000;
    return { ok: true, owner: args.owner, keys: [...args.keys], expiresAt: args.now + ttl };
  }

  release(args: { readonly owner: string; readonly keys?: readonly string[]; readonly now: number }): number {
    let released = 0;
    for (const tier of this.tiers) released = Math.max(released, tier.release(args));
    return released;
  }

  renew(args: { readonly owner: string; readonly keys: readonly string[]; readonly ttlMs: number; readonly now: number }): boolean {
    let ok = true;
    for (const tier of this.tiers) ok = tier.renew(args) && ok;
    return ok;
  }

  ownerOf(key: string, now: number): string | null {
    return this.tiers[0]?.ownerOf(key, now) ?? null;
  }

  sideOf(key: string, now: number): string | null {
    return this.tiers[0]?.sideOf(key, now) ?? null;
  }

  activeCount(now: number): number {
    return this.tiers[0]?.activeCount(now) ?? 0;
  }

  activeKeys(now: number): string[] {
    return this.tiers[0]?.activeKeys(now) ?? [];
  }

  clear(): void {
    for (const tier of this.tiers) tier.clear();
  }
}
