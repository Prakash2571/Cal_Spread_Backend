/**
 * THE REFERENCE PORT — an executable specification of what Mongo must do.
 *
 * NOT FOR PRODUCTION. It is `export`ed and typechecked rather than hidden in the test
 * folder for one reason: it is the written-down definition of the contract the Mongo
 * adapter has to keep, and a definition that the compiler checks is worth far more
 * than a comment describing it.
 *
 * WHY THIS IS NOT "FAKING ATOMICITY"
 * The distinction matters, so it is worth being precise. This class does not pretend
 * an operation is atomic that is not; it MODELS Mongo's actual documented behaviour
 * and it models the parts that make races possible:
 *
 *   • The unique compound multikey index is represented as a real index — a Map from
 *     `deployment \0 key` to the owning document. Uniqueness is enforced by insertion
 *     into that Map, exactly as a database enforces it, not by scanning documents and
 *     hoping.
 *
 *   • `insert` yields to the event loop BEFORE its critical section (`await gate()`),
 *     so two concurrent callers genuinely interleave — which is what makes the
 *     multi-worker race tests capable of failing. The critical section itself is then
 *     a single synchronous block, which is what makes a single-document insert atomic.
 *     Together those two properties reproduce the real hazard AND the real guarantee.
 *
 *   • A duplicate is reported as a duplicate, distinguishing the `_id` collision from
 *     the `keys` collision, because the algorithm treats them differently and a model
 *     that blurred them would let a bug through.
 *
 * What it cannot model is Mongo's replication, its TTL monitor's timing, or its wire
 * protocol. Those are exactly the things the env-gated integration test against a
 * real cluster covers, and the things the deliverable notes as unverified when no
 * cluster is available.
 */

import type {
  DurableReservationDoc,
  DurableReservationPort,
  InsertReservationResult,
} from "./port.js";

/** Index key for the unique compound multikey index `{ deployment: 1, keys: 1 }`. */
function indexKey(deployment: string, key: string): string {
  return `${deployment}\u0000${key}`;
}

export interface InMemoryReservationPortOptions {
  /**
   * Whether this port claims to be shared between processes.
   *
   * Defaults to TRUE because the whole point of the reference implementation is to
   * stand in for a shared database in tests. Set it false to exercise the
   * fail-closed path where a tier is present but is not genuinely cross-process.
   */
  readonly crossProcess?: boolean;
  /** Simulated authority clock. Defaults to `Date.now`. */
  readonly clock?: () => number;
  /** Await this many macrotask/microtask turns before each critical section. */
  readonly yieldBeforeWrite?: boolean;
  readonly name?: string;
}

/**
 * Shared state, so two `DurableInstrumentReservations` instances can be pointed at
 * ONE "database" and genuinely contend — the difference between a real multi-worker
 * test and two objects over two unrelated Maps.
 */
export class InMemoryReservationDatabase {
  readonly docs = new Map<string, DurableReservationDoc>();
  /** The unique compound multikey index. */
  readonly uniqueIndex = new Map<string, string>();
  readonly fences = new Map<string, number>();

  /** Force every operation to reject, for the database-outage tests. */
  failure: Error | null = null;
  /** Count operations, so a test can prove the fast path avoided the network. */
  operations = 0;

  reset(): void {
    this.docs.clear();
    this.uniqueIndex.clear();
    this.fences.clear();
    this.failure = null;
    this.operations = 0;
  }
}

export class InMemoryReservationPort implements DurableReservationPort {
  readonly name: string;
  readonly crossProcess: boolean;

  private isReady = false;
  private readonly clock: () => number;
  private readonly shouldYield: boolean;

  constructor(
    private readonly db: InMemoryReservationDatabase,
    options: InMemoryReservationPortOptions = {},
  ) {
    this.name = options.name ?? "memory";
    this.crossProcess = options.crossProcess ?? true;
    this.clock = options.clock ?? (() => Date.now());
    this.shouldYield = options.yieldBeforeWrite ?? true;
  }

  get ready(): boolean {
    return this.isReady && this.db.failure === null;
  }

  async ensureReady(): Promise<void> {
    this.guard();
    this.isReady = true;
  }

  async serverTimeMs(): Promise<number> {
    this.guard();
    return this.clock();
  }

  async nextFence(deployment: string): Promise<number> {
    await this.gate();
    // Atomic increment, modelled as one synchronous read-modify-write.
    const next = (this.db.fences.get(deployment) ?? 0) + 1;
    this.db.fences.set(deployment, next);
    return next;
  }

  async insert(doc: DurableReservationDoc): Promise<InsertReservationResult> {
    await this.gate();

    // ── CRITICAL SECTION. Synchronous from here to the end: this is the single
    // ── document write, and nothing may interleave inside it.
    if (this.db.docs.has(doc.owner)) return "owner_exists";

    // Index-key uniqueness is checked across ALL of the document's keys before any
    // are written, so a collision on the fourth leg leaves the first three unwritten.
    // That is the all-or-none property, and it is why partial reservation is not
    // representable.
    const entries = new Set(doc.keys.map((key) => indexKey(doc.deployment, key)));
    for (const entry of entries) {
      if (this.db.uniqueIndex.has(entry)) return "key_conflict";
    }
    for (const entry of entries) this.db.uniqueIndex.set(entry, doc.owner);
    this.db.docs.set(doc.owner, { ...doc, keys: [...doc.keys], sides: doc.sides.map((s) => ({ ...s })) });
    return "inserted";
    // ── END CRITICAL SECTION
  }

  async deleteExpired(args: {
    readonly deployment: string;
    readonly keys?: readonly string[];
    readonly notAfter: number;
  }): Promise<number> {
    await this.gate();
    const wanted = args.keys === undefined ? null : new Set(args.keys);
    let deleted = 0;
    for (const doc of [...this.db.docs.values()]) {
      if (doc.deployment !== args.deployment) continue;
      // The predicate is evaluated per document against the CURRENT stored value, so a
      // lease renewed since the caller last looked simply no longer matches.
      if (doc.expiresAt > args.notAfter) continue;
      if (wanted !== null && !doc.keys.some((key) => wanted.has(key))) continue;
      this.removeDoc(doc);
      deleted++;
    }
    return deleted;
  }

  async findLiveByKeys(args: {
    readonly deployment: string;
    readonly keys: readonly string[];
    readonly now: number;
  }): Promise<DurableReservationDoc[]> {
    await this.gate();
    const wanted = new Set(args.keys);
    const out: DurableReservationDoc[] = [];
    for (const doc of this.db.docs.values()) {
      if (doc.deployment !== args.deployment) continue;
      if (doc.expiresAt <= args.now) continue;
      if (!doc.keys.some((key) => wanted.has(key))) continue;
      out.push(doc);
    }
    return out;
  }

  async findByOwner(owner: string): Promise<DurableReservationDoc | null> {
    await this.gate();
    return this.db.docs.get(owner) ?? null;
  }

  async deleteOwned(args: { readonly owner: string; readonly fence?: number }): Promise<number> {
    await this.gate();
    const doc = this.db.docs.get(args.owner);
    if (doc === undefined) return 0;
    if (args.fence !== undefined && doc.fence !== args.fence) return 0;
    this.removeDoc(doc);
    return 1;
  }

  async renewOwned(args: {
    readonly owner: string;
    readonly fence?: number;
    readonly broker?: string;
    readonly generation?: number;
    readonly now: number;
    readonly expiresAt: number;
  }): Promise<DurableReservationDoc | null> {
    await this.gate();
    const doc = this.db.docs.get(args.owner);
    if (doc === undefined) return null;
    if (args.fence !== undefined && doc.fence !== args.fence) return null;
    // Part of the match, exactly as it is in the Mongo filter: a superseded lease must not
    // be extended and only then rejected.
    if (args.broker !== undefined && doc.broker !== args.broker) return null;
    if (args.generation !== undefined && doc.generation !== args.generation) return null;
    // Only the CURRENT owner of a still-live lease may extend it. A lease already past
    // its expiry is not renewable: it has been lost, and pretending otherwise would let
    // a stalled worker resurrect ownership a challenger may already have taken.
    if (doc.expiresAt <= args.now) return null;
    const updated: DurableReservationDoc = { ...doc, expiresAt: args.expiresAt, renewedAt: args.now };
    this.db.docs.set(doc.owner, updated);
    return updated;
  }

  async deleteByOwnerPrefix(prefix: string): Promise<number> {
    await this.gate();
    let deleted = 0;
    for (const doc of [...this.db.docs.values()]) {
      if (!doc.owner.startsWith(prefix)) continue;
      this.removeDoc(doc);
      deleted++;
    }
    return deleted;
  }

  async countLive(args: { readonly deployment: string; readonly now: number }): Promise<number> {
    await this.gate();
    let count = 0;
    for (const doc of this.db.docs.values()) {
      if (doc.deployment !== args.deployment) continue;
      if (doc.expiresAt <= args.now) continue;
      count++;
    }
    return count;
  }

  private removeDoc(doc: DurableReservationDoc): void {
    this.db.docs.delete(doc.owner);
    for (const key of doc.keys) {
      const entry = indexKey(doc.deployment, key);
      // Only drop an index entry this document actually owns, mirroring how a real
      // index is maintained per document.
      if (this.db.uniqueIndex.get(entry) === doc.owner) this.db.uniqueIndex.delete(entry);
    }
  }

  private guard(): void {
    this.db.operations++;
    if (this.db.failure !== null) throw this.db.failure;
  }

  /**
   * The interleaving point.
   *
   * Yielding here is what lets two concurrent callers actually race, so a test can
   * discover an ordering bug instead of accidentally serialising every operation.
   */
  private async gate(): Promise<void> {
    if (this.shouldYield) await Promise.resolve();
    this.guard();
  }
}
