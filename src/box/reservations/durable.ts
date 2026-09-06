/**
 * THE DURABLE TIER — cross-process exclusion on exact contracts.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY ACQUISITION IS ATOMIC
 * ─────────────────────────────────────────────────────────────────────────────
 * One reservation is ONE DOCUMENT holding the complete instrument set:
 *
 *   { _id: <owner>, deployment, broker, generation, fence,
 *     keys: [ "ZERODHA:NFO:RELIANCE...2500CE", ...2550CE, ...2500PE, ...2550PE ],
 *     createdAt, expiresAt }
 *
 * against a UNIQUE COMPOUND MULTIKEY INDEX on `{ deployment: 1, keys: 1 }`.
 *
 * MongoDB indexes every element of an array field separately, and a unique index
 * applies its constraint ACROSS documents: per the multikey manual, "a document may
 * have array elements that result in repeating index key values as long as the index
 * key values for that document do not duplicate those of another document". So no
 * `(deployment, key)` pair can appear in two documents at once — which is precisely
 * "no contract is held by two live reservations".
 *
 * And because a single-document insert is atomic, inserting four keys either writes
 * all four index entries or, on the first collision, writes none and leaves no
 * document. Four contracts are therefore claimed TOGETHER or not at all. There is no
 * `insert key1; insert key2; ...` sequence anywhere in this file, because that would
 * reintroduce exactly the partial-reservation and deadlock problems the all-or-none
 * contract exists to eliminate.
 *
 * A duplicate-key error is a CONFLICT, not a crash. It is the mechanism, not a fault.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY MONGO AND NOT THE EXISTING REDIS HELPER
 * ─────────────────────────────────────────────────────────────────────────────
 * `src/redis.ts` is Upstash over REST and, by explicit documented design, NEVER
 * THROWS — it returns `null` when unreachable so a caching miss cannot take the app
 * down. For a cache that is correct. For a trading lock it is inverted: `null`
 * meaning "carry on" is a fail-OPEN safety primitive, which is worse than no lock at
 * all because it looks like one. Mongo is also already mandatory for this backend, so
 * the durable authority adds no new operational dependency and no new failure domain.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TIME: ONE CLOCK, AND AN ASYMMETRIC GRACE BAND
 * ─────────────────────────────────────────────────────────────────────────────
 * Expiry is the crash-recovery mechanism, so whose clock decides it matters enormously.
 * If each worker used its own `Date.now()`, a worker whose clock ran 10 seconds fast
 * would consider a perfectly live lease expired, delete it, and take the contracts —
 * two owners, one contract, which is the bug this module exists to prevent.
 *
 * So the AUTHORITY'S clock is the only clock. This tier measures the offset between
 * the local clock and the authority's at startup and periodically thereafter, stores
 * every timestamp in authority time, and converts at its boundary. Worker clock skew
 * then cannot affect the decision at all.
 *
 * On top of that, the expiry test is deliberately ASYMMETRIC, so that residual
 * measurement error can never produce two simultaneous owners:
 *
 *   holder     considers itself owner only while  now <  expiresAt - grace
 *   challenger may reclaim a lease only once      now >= expiresAt + grace
 *
 * That leaves a dead band of 2×grace in which nobody acts. Handing a contract to
 * nobody for 500 ms is a missed opportunity; handing it to two workers is a naked
 * position. The trade is not close.
 *
 * MONGO'S TTL MONITOR IS NOT PART OF THE ALGORITHM. It runs roughly every 60
 * seconds, so a document routinely outlives its `expiresAt`. This code therefore
 * decides expiry LOGICALLY, from the stored timestamp, and reclaims stale documents
 * itself. The TTL index exists only so abandoned rows are eventually garbage
 * collected rather than accumulating forever.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TTL IS NOT EXECUTION PERMISSION
 * ─────────────────────────────────────────────────────────────────────────────
 * The dangerous sequence is: worker A stalls on GC, A's lease expires, worker B
 * legitimately acquires the contracts, A wakes up and submits another leg. A's local
 * state still says "running", and that is not good enough. `verify()` exists so every
 * significant phase can re-ask the authority, and the fencing token exists so a lease
 * that was expired and retaken is recognisable rather than merely "gone".
 *
 * FENCING TOKEN — AND ITS HONEST LIMITATION
 * `fence` is a real monotonic counter: an atomic `$inc` on a per-deployment
 * document, so it strictly increases and cannot repeat or run backwards (a
 * timestamp-based token could do both under clock skew, which is why one is not used).
 * Its limitation is that Zerodha and Dhan accept no fencing token on an order, so it
 * CANNOT make the broker reject a stale worker's submission. It is used internally —
 * stale-owner detection in `verify`, renewal pinning, reconciliation, logs and
 * invariant checks. It narrows the window; it does not make the broker enforce it.
 */

import {
  BoundedSamples,
  dedupeKeys,
  normaliseTtl,
  safeErrorMessage,
  type AcquireArgs,
  type InstrumentReservationStore,
  type OwnershipVerdict,
  type ReleaseArgs,
  type RenewArgs,
  type RenewOutcome,
  type ReservationConflictDetail,
  type ReservationContext,
  type ReservationOutcome,
  type ReservationStoreDiagnostics,
  type VerifyArgs,
} from "./types.js";
import type { DurableReservationDoc, DurableReservationPort } from "./port.js";

export interface DurableReservationsDeps {
  port: DurableReservationPort;
  /** Deployment/broker identity for every document written and verified. */
  context: () => ReservationContext;
  /** `deployment:instance:pid:boot:` — the prefix identifying this process's owners. */
  ownerPrefix: string;
  /**
   * Clock-skew grace, in ms. Widens the dead band between a holder giving up and a
   * challenger reclaiming. 0 is legal and is what the deterministic tests use.
   */
  skewGraceMs?: number;
  /** How often to re-measure the offset against the authority's clock. */
  clockSyncIntervalMs?: number;
  /**
   * How stale an offset may get before an acquire BLOCKS to re-measure it — and
   * fails closed if it cannot. Without this a permanently failing background sync
   * would let the offset drift silently forever.
   */
  clockSyncMaxStaleMs?: number;
  /** Minimum gap between lazy reconnect attempts, so a dead Mongo is not hammered. */
  readyRetryMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

interface HeldLease {
  keys: string[];
  /** Local-clock expiry, for the synchronous process-local views. */
  expiresAt: number;
  fence: number;
}

export class DurableInstrumentReservations implements InstrumentReservationStore {
  readonly name: string;
  readonly durable: boolean;

  private readonly skewGraceMs: number;
  private readonly clockSyncIntervalMs: number;
  private readonly clockSyncMaxStaleMs: number;
  private readonly readyRetryMs: number;

  /** Authority clock minus local clock, in ms. */
  private clockOffsetMs = 0;
  private clockSyncedAt = 0;
  private clockSyncInFlight: Promise<void> | null = null;

  private lastReadyAttempt = 0;
  private readyPromise: Promise<void> | null = null;
  private initialised = false;

  /** What THIS process believes it holds, for the synchronous diagnostics views. */
  private held = new Map<string, HeldLease>();

  /**
   * Fencing tokens that were allocated but never used, available for reuse.
   *
   * `nextFence` is a shared per-deployment `$inc`. That is a WRITE, not a lock — two
   * workers incrementing it both succeed, so unrelated boxes are never excluded by it —
   * but it is still a round trip in front of the insert, and the conflict-wait loop would
   * otherwise burn one per retry round just to be told no again.
   *
   * A token is only ever consumed by a SUCCESSFUL insert, so a token from a failed
   * attempt is provably unissued and safe to hand to the next attempt. Bounded, so a long
   * run of failures cannot grow it without limit; the excess is simply discarded, which
   * costs nothing but a gap in the sequence.
   */
  private spareFences: number[] = [];
  private static readonly MAX_SPARE_FENCES = 8;

  private stats = {
    acquireAttempts: 0,
    acquireSuccess: 0,
    conflicts: 0,
    errors: 0,
    renewSuccess: 0,
    renewFailure: 0,
    ownershipLost: 0,
    expiredObserved: 0,
  };
  private latency = new BoundedSamples(256);
  private lastError: string | null = null;

  constructor(private readonly deps: DurableReservationsDeps) {
    this.name = deps.port.name;
    this.durable = deps.port.crossProcess;
    this.skewGraceMs = Math.max(0, deps.skewGraceMs ?? 250);
    this.clockSyncIntervalMs = Math.max(1000, deps.clockSyncIntervalMs ?? 15_000);
    this.clockSyncMaxStaleMs = Math.max(this.clockSyncIntervalMs, deps.clockSyncMaxStaleMs ?? 150_000);
    this.readyRetryMs = Math.max(100, deps.readyRetryMs ?? 1000);
  }

  get ready(): boolean {
    return this.deps.port.ready && this.initialised;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private log(message: string): void {
    if (this.deps.log) this.deps.log(message);
    else console.warn(`[BoxReservations/${this.name}] ${message}`);
  }

  /* ------------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------------ */

  /**
   * Connect, create indexes, and measure the clock offset.
   *
   * Safe to call repeatedly and concurrently: a single in-flight promise is shared,
   * so a burst of executions arriving while Mongo is reconnecting produces ONE
   * attempt rather than one per execution.
   */
  async initialise(): Promise<void> {
    if (this.readyPromise !== null) return this.readyPromise;
    this.lastReadyAttempt = this.now();
    const attempt = (async () => {
      await this.deps.port.ensureReady();
      await this.syncClock();
      this.initialised = true;
      this.lastError = null;
    })();
    this.readyPromise = attempt;
    try {
      await attempt;
    } finally {
      // Cleared either way, so a later call can retry rather than replaying a
      // rejected promise forever.
      this.readyPromise = null;
    }
  }

  /**
   * Ensure the tier is usable, at most one attempt per `readyRetryMs`.
   *
   * Returns false rather than throwing, because "the authority is down" is a normal
   * operating state that must be reported as `unavailable`, not as an exception
   * escaping into the scanner.
   */
  private async ensureUsable(): Promise<boolean> {
    if (this.ready) return true;
    if (this.readyPromise !== null) {
      try {
        await this.readyPromise;
      } catch {
        /* reported below */
      }
      return this.ready;
    }
    if (this.now() - this.lastReadyAttempt < this.readyRetryMs) return false;
    try {
      await this.initialise();
    } catch (error) {
      this.stats.errors++;
      this.lastError = safeErrorMessage(error);
    }
    return this.ready;
  }

  /* ------------------------------------------------------------------ *
   * Clock
   * ------------------------------------------------------------------ */

  private toAuthority(localMs: number): number {
    return localMs + this.clockOffsetMs;
  }

  private toLocal(authorityMs: number): number {
    return authorityMs - this.clockOffsetMs;
  }

  private async syncClock(): Promise<void> {
    if (this.clockSyncInFlight !== null) return this.clockSyncInFlight;
    const run = (async () => {
      const before = this.now();
      const serverMs = await this.deps.port.serverTimeMs();
      const after = this.now();
      // Midpoint of the round trip is the best single estimate of the local instant
      // the server reading corresponds to; the residual error is bounded by RTT/2,
      // which the grace band then covers.
      const localMidpoint = before + (after - before) / 2;
      this.clockOffsetMs = Math.round(serverMs - localMidpoint);
      this.clockSyncedAt = after;
    })();
    this.clockSyncInFlight = run;
    try {
      await run;
    } finally {
      this.clockSyncInFlight = null;
    }
  }

  /**
   * Keep the offset fresh without putting a round trip on the acquire path.
   *
   * Normal staleness triggers a BACKGROUND refresh and the acquire proceeds on the
   * existing offset — it is at most `clockSyncIntervalMs` of drift old, which the
   * grace band covers. Extreme staleness (the background refresh has been failing)
   * blocks, because continuing to trust an offset of unknown age would silently
   * reintroduce the skew hazard this exists to remove.
   */
  private async refreshClockIfNeeded(): Promise<void> {
    const age = this.now() - this.clockSyncedAt;
    if (age < this.clockSyncIntervalMs) return;
    if (age >= this.clockSyncMaxStaleMs) {
      await this.syncClock();
      return;
    }
    // Never allow a background rejection to become an unhandled promise rejection.
    void this.syncClock().catch((error: unknown) => {
      this.stats.errors++;
      this.lastError = safeErrorMessage(error);
    });
  }

  /* ------------------------------------------------------------------ *
   * Acquire
   * ------------------------------------------------------------------ */

  async tryAcquireAll(args: AcquireArgs): Promise<ReservationOutcome> {
    const started = this.now();
    this.stats.acquireAttempts++;
    const keys = dedupeKeys(args.keys);

    // An empty instrument set cannot be "reserved". Treating it as success would hand
    // out a lease protecting nothing, so it fails closed instead. Unreachable from the
    // coordinator, which always presents four legs.
    if (keys.length === 0) {
      return {
        ok: false,
        reason: "unavailable",
        tier: this.name,
        detail: "refusing to reserve an empty instrument set",
      };
    }

    if (!(await this.ensureUsable())) {
      return {
        ok: false,
        reason: "unavailable",
        tier: this.name,
        detail: this.lastError ?? `${this.name} reservation authority is not ready`,
      };
    }

    const ctx = args.context ?? this.deps.context();
    const ttl = normaliseTtl(args.ttlMs);

    try {
      await this.refreshClockIfNeeded();
      const authNow = this.toAuthority(args.now);
      const authExpiresAt = authNow + ttl;
      const fence = this.spareFences.pop() ?? (await this.deps.port.nextFence(ctx.deployment));
      const doc: DurableReservationDoc = {
        owner: args.owner,
        deployment: ctx.deployment,
        broker: ctx.broker,
        generation: ctx.generation,
        mode: ctx.mode,
        keys,
        sides: keys.map((key) => ({ key, side: args.sideByKey?.get(key) ?? "" })),
        fence,
        instance: this.deps.ownerPrefix,
        createdAt: authNow,
        expiresAt: authExpiresAt,
        renewedAt: authNow,
      };

      let result = await this.deps.port.insert(doc);

      // Our OWN row already exists — a re-entrancy artefact, never another worker's
      // lease. Deleting it is owner-verified and therefore always safe.
      if (result === "owner_exists") {
        await this.deps.port.deleteOwned({ owner: args.owner });
        result = await this.deps.port.insert(doc);
      }

      if (result === "key_conflict") {
        // Reclaim only what has DEFINITELY lost its lease: expired on the authority's
        // clock by more than the grace band. A live lease cannot match this filter,
        // and a lease that gets renewed between our read and this delete no longer
        // matches it either, because the predicate is evaluated per document by the
        // authority rather than by us.
        const reclaimed = await this.deps.port.deleteExpired({
          deployment: ctx.deployment,
          keys,
          notAfter: authNow - this.skewGraceMs,
        });
        if (reclaimed > 0) {
          this.stats.expiredObserved += reclaimed;
          result = await this.deps.port.insert(doc);
        }
      }

      if (result === "inserted") {
        const localExpiresAt = this.toLocal(authExpiresAt);
        this.held.set(args.owner, { keys, expiresAt: localExpiresAt, fence });
        this.stats.acquireSuccess++;
        this.latency.add(this.now() - started);
        return {
          ok: true,
          owner: args.owner,
          keys,
          expiresAt: localExpiresAt,
          fence,
          durability: "durable",
        };
      }

      // Name the holders so the log is actionable.
      const live = await this.deps.port.findLiveByKeys({
        deployment: ctx.deployment,
        keys,
        now: authNow,
      });

      // SELF-CONFLICT: our own insert actually committed.
      //
      // Reachable when a retryable write is retried after the first attempt landed but
      // before its acknowledgement arrived. The retry raises a duplicate-key error, and
      // the offending index is not guaranteed to be reported as `_id` — so it can arrive
      // classified as a key conflict against a document WE own. Waiting out the conflict
      // window against ourselves would be absurd, and `deleteExpired` cannot reclaim it
      // because the lease is live. Recognise it and treat the acquisition as the success
      // it really was.
      const mine = live.find((doc) => doc.owner === args.owner);
      if (mine !== undefined && live.every((doc) => doc.owner === args.owner)) {
        const localExpiresAt = this.toLocal(mine.expiresAt);
        this.held.set(args.owner, { keys: [...mine.keys], expiresAt: localExpiresAt, fence: mine.fence });
        this.stats.acquireSuccess++;
        this.latency.add(this.now() - started);
        return {
          ok: true,
          owner: args.owner,
          keys: [...mine.keys],
          expiresAt: localExpiresAt,
          fence: mine.fence,
          durability: "durable",
        };
      }

      const conflicts = this.describeConflicts(keys, live);
      this.stats.conflicts++;
      this.recycleFence(fence);
      this.latency.add(this.now() - started);
      return { ok: false, reason: "conflict", conflicts };
    } catch (error) {
      this.stats.errors++;
      this.lastError = safeErrorMessage(error);
      this.latency.add(this.now() - started);
      // FAIL CLOSED. An unreachable authority is not an empty lock table.
      return {
        ok: false,
        reason: "unavailable",
        tier: this.name,
        detail: this.lastError,
      };
    }
  }

  /** Return an unissued token to the pool, bounded. */
  private recycleFence(fence: number): void {
    if (this.spareFences.length >= DurableInstrumentReservations.MAX_SPARE_FENCES) return;
    this.spareFences.push(fence);
  }

  private describeConflicts(
    keys: readonly string[],
    live: readonly DurableReservationDoc[],
  ): ReservationConflictDetail[] {
    const wanted = new Set(keys);
    const conflicts: ReservationConflictDetail[] = [];
    const seen = new Set<string>();
    for (const doc of live) {
      for (const key of doc.keys) {
        if (!wanted.has(key) || seen.has(key)) continue;
        seen.add(key);
        const side = doc.sides.find((entry) => entry.key === key)?.side ?? "";
        conflicts.push({
          key,
          heldBy: doc.owner,
          heldSide: side === "" ? null : side,
          tier: this.name,
        });
      }
    }
    return conflicts;
  }

  /* ------------------------------------------------------------------ *
   * Release / renew / verify
   * ------------------------------------------------------------------ */

  async release(args: ReleaseArgs): Promise<number> {
    // Deliberately owner-scoped and never key-scoped. `deleteMany({keys: {$in: keys}})`
    // would delete whoever holds those contracts NOW, which after an expiry and a
    // legitimate reacquisition is a different execution.
    this.held.delete(args.owner);
    if (!this.ready) {
      // Nothing to do that could succeed. The lease expires on its own TTL, which is
      // exactly the crashed-worker recovery path — conservative, never unsafe.
      //
      // Counted and recorded, though: an unreleased lease blocks every worker on those
      // contracts for a full TTL, so it is an operational fact, not a no-op.
      this.stats.errors++;
      this.lastError = `${this.name}: release skipped while the authority was unavailable; the lease will expire by TTL`;
      return 0;
    }
    try {
      const deleted = await this.deps.port.deleteOwned(
        args.fence === undefined ? { owner: args.owner } : { owner: args.owner, fence: args.fence },
      );
      return deleted;
    } catch (error) {
      this.stats.errors++;
      this.lastError = safeErrorMessage(error);
      // Swallowed on purpose: a failed release must not propagate into an execution's
      // cleanup path. The TTL is the backstop.
      this.log(`release failed for a reservation; it will expire by TTL instead: ${this.lastError}`);
      return 0;
    }
  }

  async renew(args: RenewArgs): Promise<RenewOutcome> {
    if (!(await this.ensureUsable())) {
      this.stats.renewFailure++;
      return {
        ok: false,
        reason: "unavailable",
        detail: this.lastError ?? `${this.name} reservation authority is not ready`,
      };
    }
    const ctx = args.context ?? this.deps.context();
    try {
      // The offset decides whether this lease is still live, so its age matters here just
      // as much as on acquire. Without this, a long execution renews for its whole life
      // against an offset of unbounded age.
      await this.refreshClockIfNeeded();
      const authNow = this.toAuthority(args.now);
      const authExpiresAt = authNow + normaliseTtl(args.ttlMs);
      // Broker and generation are part of the FILTER, not a check afterwards.
      //
      // Comparing them after the update would mean a superseded lease had already had its
      // expiry pushed forward before being rejected — locking the contract for another
      // full TTL on behalf of a worker that is not allowed to trade it.
      const updated = await this.deps.port.renewOwned({
        owner: args.owner,
        ...(args.fence === undefined ? {} : { fence: args.fence }),
        broker: ctx.broker,
        generation: ctx.generation,
        now: authNow,
        expiresAt: authExpiresAt,
      });
      if (updated === null) {
        // Zero matched rows means ownership is not confirmed: gone, expired, or stamped
        // with a broker generation that is no longer active. All are safety events, never
        // "retry and carry on". One extra read classifies it, on a cold path, because
        // "lost" and "superseded" call for different operator responses.
        this.stats.renewFailure++;
        this.stats.ownershipLost++;
        this.held.delete(args.owner);
        const existing = await this.deps.port.findByOwner(args.owner).catch(() => null);
        if (existing !== null && (existing.broker !== ctx.broker || existing.generation !== ctx.generation)) {
          return {
            ok: false,
            reason: "lost",
            detail:
              `${this.name}: reservation belongs to ${existing.broker} generation ${existing.generation}, ` +
              `active is ${ctx.broker} generation ${ctx.generation}`,
          };
        }
        return {
          ok: false,
          reason: existing === null ? "lost" : "expired",
          detail: `${this.name}: renewal matched no live reservation for this owner and fence`,
        };
      }
      const localExpiresAt = this.toLocal(updated.expiresAt);
      this.held.set(args.owner, {
        keys: [...updated.keys],
        expiresAt: localExpiresAt,
        fence: updated.fence,
      });
      this.stats.renewSuccess++;
      return { ok: true, expiresAt: localExpiresAt, fence: updated.fence };
    } catch (error) {
      this.stats.errors++;
      this.stats.renewFailure++;
      this.lastError = safeErrorMessage(error);
      // UNKNOWN, not lost. The caller must treat unknown ownership as not-owned for
      // the purpose of opening new exposure, but it must NOT conclude the lease is
      // free and release it.
      return { ok: false, reason: "unavailable", detail: this.lastError };
    }
  }

  async verify(args: VerifyArgs): Promise<OwnershipVerdict> {
    if (!(await this.ensureUsable())) {
      return {
        owned: false,
        reason: "unavailable",
        detail: this.lastError ?? `${this.name} reservation authority is not ready`,
      };
    }
    const ctx = args.context ?? this.deps.context();
    try {
      // Same reasoning as `renew`: this call decides ownership, so it must not run on an
      // offset of unknown age.
      await this.refreshClockIfNeeded();
      const doc = await this.deps.port.findByOwner(args.owner);
      if (doc === null) {
        return { owned: false, reason: "lost", detail: `${this.name}: no reservation for this owner` };
      }
      if (args.fence !== undefined && doc.fence !== args.fence) {
        return {
          owned: false,
          reason: "lost",
          detail: `${this.name}: reservation fence ${doc.fence} supersedes ${args.fence}`,
        };
      }
      const authNow = this.toAuthority(args.now);
      // PESSIMISTIC. Not "has it expired" but "is it close enough to expiry that a
      // challenger might legitimately be about to take it".
      if (doc.expiresAt - this.skewGraceMs <= authNow) {
        return { owned: false, reason: "expired", detail: `${this.name}: reservation has expired or is within its skew grace` };
      }
      if (doc.deployment !== ctx.deployment) {
        return {
          owned: false,
          reason: "superseded",
          detail: `${this.name}: reservation belongs to deployment ${doc.deployment}, active is ${ctx.deployment}`,
        };
      }
      if (doc.broker !== ctx.broker || doc.generation !== ctx.generation) {
        return {
          owned: false,
          reason: "superseded",
          detail:
            `${this.name}: reservation belongs to ${doc.broker} generation ${doc.generation}, ` +
            `active is ${ctx.broker} generation ${ctx.generation}`,
        };
      }
      const covered = new Set(doc.keys);
      for (const key of dedupeKeys(args.keys)) {
        if (!covered.has(key)) {
          return { owned: false, reason: "lost", detail: `${this.name}: reservation does not cover ${key}` };
        }
      }
      return { owned: true, expiresAt: this.toLocal(doc.expiresAt), fence: doc.fence };
    } catch (error) {
      this.stats.errors++;
      this.lastError = safeErrorMessage(error);
      return { owned: false, reason: "unavailable", detail: this.lastError };
    }
  }

  /* ------------------------------------------------------------------ *
   * Reads
   * ------------------------------------------------------------------ */

  async ownerOf(key: string, now: number): Promise<string | null> {
    if (!this.ready) return null;
    const ctx = this.deps.context();
    try {
      const live = await this.deps.port.findLiveByKeys({
        deployment: ctx.deployment,
        keys: [key],
        now: this.toAuthority(now),
      });
      return live[0]?.owner ?? null;
    } catch (error) {
      this.stats.errors++;
      this.lastError = safeErrorMessage(error);
      return null;
    }
  }

  async sideOf(key: string, now: number): Promise<string | null> {
    if (!this.ready) return null;
    const ctx = this.deps.context();
    try {
      const live = await this.deps.port.findLiveByKeys({
        deployment: ctx.deployment,
        keys: [key],
        now: this.toAuthority(now),
      });
      const side = live[0]?.sides.find((entry) => entry.key === key)?.side ?? "";
      return side === "" ? null : side;
    } catch (error) {
      this.stats.errors++;
      this.lastError = safeErrorMessage(error);
      return null;
    }
  }

  /** Process-local by contract: what THIS worker holds, with no I/O. */
  activeCount(now: number): number {
    this.pruneHeld(now);
    return this.held.size;
  }

  activeKeys(now: number): string[] {
    this.pruneHeld(now);
    const out: string[] = [];
    for (const lease of this.held.values()) out.push(...lease.keys);
    return dedupeKeys(out);
  }

  private pruneHeld(now: number): void {
    for (const [owner, lease] of this.held) {
      if (lease.expiresAt <= now) this.held.delete(owner);
    }
  }

  /* ------------------------------------------------------------------ *
   * Housekeeping
   * ------------------------------------------------------------------ */

  /**
   * Drop the reservations THIS PROCESS owns.
   *
   * Called on broker switch, where every key is in the outgoing broker's namespace
   * and is meaningless under the new one. Scoped to this process's owner prefix, NOT
   * to the whole collection: a sibling worker's live reservations are authoritative
   * and deleting them would be the exact multi-process violation this tier exists to
   * prevent.
   */
  async clear(): Promise<void> {
    const owners = [...this.held.keys()];
    this.held.clear();
    if (!this.ready) return;
    try {
      const deleted = await this.deps.port.deleteByOwnerPrefix(this.deps.ownerPrefix);
      if (deleted > 0) {
        this.log(`cleared ${deleted} reservation(s) owned by this process`);
      }
    } catch (error) {
      this.stats.errors++;
      this.lastError = safeErrorMessage(error);
      this.log(
        `failed to clear ${owners.length} reservation(s) owned by this process; ` +
          `they will expire by TTL: ${this.lastError}`,
      );
    }
  }

  /**
   * Reclaim logically-expired documents across the deployment.
   *
   * Used at startup and as periodic housekeeping. It deletes ONLY documents that have
   * already lost their lease on the authority's clock — never a live one — so a
   * freshly started worker respects reservations another worker legitimately holds
   * instead of wiping the table, which is the entire point of making the store
   * durable.
   */
  async reapExpired(): Promise<number> {
    if (!(await this.ensureUsable())) return 0;
    const ctx = this.deps.context();
    try {
      await this.refreshClockIfNeeded();
      const notAfter = this.toAuthority(this.now()) - this.skewGraceMs;
      const removed = await this.deps.port.deleteExpired({ deployment: ctx.deployment, notAfter });
      if (removed > 0) {
        this.stats.expiredObserved += removed;
        this.log(`reaped ${removed} expired reservation(s)`);
      }
      return removed;
    } catch (error) {
      this.stats.errors++;
      this.lastError = safeErrorMessage(error);
      return 0;
    }
  }

  /** Live reservation count across the whole deployment. Diagnostics only. */
  async countLive(now: number): Promise<number | null> {
    if (!this.ready) return null;
    const ctx = this.deps.context();
    try {
      return await this.deps.port.countLive({
        deployment: ctx.deployment,
        now: this.toAuthority(now),
      });
    } catch (error) {
      this.stats.errors++;
      this.lastError = safeErrorMessage(error);
      return null;
    }
  }

  diagnostics(): ReservationStoreDiagnostics {
    return {
      name: this.name,
      durable: this.durable,
      ready: this.ready,
      activeReservations: this.held.size,
      acquireAttempts: this.stats.acquireAttempts,
      acquireSuccess: this.stats.acquireSuccess,
      conflicts: this.stats.conflicts,
      errors: this.stats.errors,
      acquireLatencyP50Ms: this.latency.percentile(0.5),
      acquireLatencyP95Ms: this.latency.percentile(0.95),
      acquireLatencyP99Ms: this.latency.percentile(0.99),
      renewSuccess: this.stats.renewSuccess,
      renewFailure: this.stats.renewFailure,
      ownershipLost: this.stats.ownershipLost,
      expiredReservationsObserved: this.stats.expiredObserved,
      clockOffsetMs: this.clockSyncedAt === 0 ? null : this.clockOffsetMs,
      lastError: this.lastError,
    };
  }
}
