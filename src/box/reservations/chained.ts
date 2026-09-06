/**
 * THE CHAIN — every tier must agree, and the durable tier is the final authority.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ACQUIRE ORDER: LOCAL FIRST, THEN DURABLE
 * ─────────────────────────────────────────────────────────────────────────────
 * The cheap tier goes first, and that ordering is a performance decision with a
 * correctness consequence worth being explicit about.
 *
 * Performance: two executions inside one process fighting over the same strike is
 * the COMMON case, because the scanner evaluates overlapping strike pairs on the
 * same tick. Rejecting that from a Map costs microseconds. Asking Mongo first would
 * put a network round trip in front of the most frequent conflict in the system, for
 * an answer the process already knew.
 *
 * Correctness: local success is necessary but NOT sufficient. Nothing is executable
 * until the durable tier has also said yes, because only the durable tier can speak
 * for the other workers. So the local tier is a filter, not an authority.
 *
 * If the durable tier refuses, the local reservation is ROLLED BACK IMMEDIATELY —
 * before returning — so a rejected attempt never leaves this process holding
 * contracts it does not own. Without that rollback a durable conflict would block
 * sibling executions in this process for a full TTL over a lease that was never granted.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RELEASE ORDER: DURABLE FIRST, THEN LOCAL (strict reverse of acquire)
 * ─────────────────────────────────────────────────────────────────────────────
 * Both orders are safe; this one is better, and here is the whole argument.
 *
 * Release DURABLE first. There is then a window where the contracts are free
 * globally but still marked held in this process. The only consequence is that this
 * process briefly declines its OWN next execution on those contracts. That is
 * over-restriction — conservative, never unsafe — and it clears within the same tick.
 * Meanwhile the workers that were actually blocked are unblocked as early as possible,
 * which is what matters, because the durable lease is the thing they are waiting on.
 *
 * Release LOCAL first instead, and the window inverts: the contracts look free
 * locally while the durable authority still records them as held. A second execution
 * in this process would pass the local filter, spend a round trip discovering the
 * durable conflict, and retry. Also safe, but it burns exactly the network call the
 * local tier exists to avoid, and it makes the fast path slowest precisely when the
 * system is busy.
 *
 * The failure mode settles it. If the durable release FAILS (Mongo down), the local
 * release still happens, and this process is then blocked by its own orphaned durable
 * lease until the TTL expires it. Conservative and self-healing. Under the reverse
 * order the same failure leaves the local tier free and the durable tier held, which
 * is the same end state reached more expensively.
 *
 * So: acquire local → durable; release durable → local. Strict LIFO nesting, the
 * classic correct lock discipline, and the authority is released as promptly as
 * possible.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO DUAL AUTHORITIES
 * ─────────────────────────────────────────────────────────────────────────────
 * There is exactly one correctness authority — the durable tier — and the chain
 * requires UNANIMITY to grant a lease. It never picks whichever tier gives the
 * convenient answer. Read-style questions (`ownerOf`, `sideOf`, `verify`) resolve
 * against the durable tier when one is present, precisely so that two tiers can
 * never be quoted as disagreeing about who owns a contract.
 */

import {
  dedupeKeys,
  normaliseTtl,
  type AcquireArgs,
  type InstrumentReservationStore,
  type OwnershipVerdict,
  type ReleaseArgs,
  type RenewArgs,
  type RenewOutcome,
  type ReservationDurability,
  type ReservationOutcome,
  type ReservationStoreDiagnostics,
  type VerifyArgs,
} from "./types.js";

export class ChainedInstrumentReservations implements InstrumentReservationStore {
  readonly name: string;

  /**
   * The fence EACH TIER issued, per owner.
   *
   * A fencing token is only meaningful to the tier that minted it. The in-process
   * tier's fence is a per-process counter; the durable tier's is a persisted
   * per-deployment `$inc`. They are unrelated number spaces that happen to both start
   * near 1 on a fresh process — which is exactly why conflating them is so easy and so
   * dangerous.
   *
   * The chain reports the DURABLE fence outward (it is the only one another worker
   * could reason about) and therefore MUST NOT hand that number back to the
   * in-process tier, which would compare it against its own counter and answer "this
   * belongs to a newer lease". That mistake fails closed rather than open — it aborts
   * legs mid-execution instead of permitting a double position — but it would break
   * every renewal and every pre-submit verification on any deployment where the two
   * counters have drifted apart, i.e. every real one.
   *
   * So the chain keeps the per-tier bookkeeping and dispatches each tier its own fence.
   * Bounded by the number of concurrent executions, and pruned on release and on any
   * verdict that says the lease is gone.
   */
  private fences = new Map<string, Map<string, number>>();

  constructor(private readonly tiers: readonly InstrumentReservationStore[]) {
    if (tiers.length === 0) throw new Error("ChainedInstrumentReservations requires at least one tier");
    this.name = tiers.map((t) => t.name).join("+");
  }

  /** Durable only if some tier really is cross-process. */
  get durable(): boolean {
    return this.tiers.some((t) => t.durable);
  }

  /**
   * Ready only if EVERY tier is ready.
   *
   * Unanimity again: if the durable tier is down, the chain cannot grant a lease that
   * means anything across workers, so reporting the chain as ready would misrepresent
   * what a successful acquire proves.
   */
  get ready(): boolean {
    return this.tiers.every((t) => t.ready);
  }

  /** The tier that speaks for other workers, when there is one. */
  private get authority(): InstrumentReservationStore | undefined {
    return [...this.tiers].reverse().find((t) => t.durable) ?? this.tiers[0];
  }

  async tryAcquireAll(args: AcquireArgs): Promise<ReservationOutcome> {
    const keys = dedupeKeys(args.keys);
    const taken: InstrumentReservationStore[] = [];
    const issued = new Map<string, number>();
    let durability: ReservationDurability = "local_only";
    let fence = 0;
    let expiresAt = args.now + normaliseTtl(args.ttlMs);

    for (const tier of this.tiers) {
      let outcome: ReservationOutcome;
      try {
        outcome = await tier.tryAcquireAll(args);
      } catch (error) {
        // A tier that throws is a tier that cannot be trusted to have NOT written.
        // Roll back and report unavailable, never conflict.
        await this.rollback(taken, args, keys);
        this.fences.delete(args.owner);
        return {
          ok: false,
          reason: "unavailable",
          tier: tier.name,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      if (outcome.ok) {
        taken.push(tier);
        issued.set(tier.name, outcome.fence);
        // The DURABLE tier's fence and expiry are what is reported OUTWARD: they are the
        // only ones another worker could reason about. Each tier's own fence is kept in
        // `issued` and is what that tier will be given back.
        if (tier.durable || durability === "local_only") {
          fence = outcome.fence;
          expiresAt = outcome.expiresAt;
        }
        if (outcome.durability === "durable") durability = "durable";
        continue;
      }
      // Roll back, in reverse, only what THIS owner took.
      await this.rollback(taken, args, keys);
      this.fences.delete(args.owner);
      return outcome;
    }

    this.fences.set(args.owner, issued);
    return { ok: true, owner: args.owner, keys, expiresAt, fence, durability };
  }

  /**
   * The fence to hand a specific tier for this owner.
   *
   * `undefined` when the chain has no record — after a process restart, say — in which
   * case the tier falls back to its owner-only check. That is still safe: owner ids are
   * globally unique per execution and never reused, so an owner match already implies a
   * lease match. The fence is defence in depth, not the primary guard.
   */
  private fenceFor(owner: string, tier: InstrumentReservationStore): number | undefined {
    return this.fences.get(owner)?.get(tier.name);
  }

  /**
   * Is the caller quoting the fence the AUTHORITY actually issued?
   *
   * A mismatch means the caller is holding a lease the chain has since replaced, which
   * is a stale-owner attempt and must not be allowed to renew, verify or release.
   */
  private authorityFenceMismatch(owner: string, quoted: number | undefined): boolean {
    if (quoted === undefined) return false;
    const authority = this.authority;
    if (authority === undefined) return false;
    const issued = this.fences.get(owner)?.get(authority.name);
    return issued !== undefined && issued !== quoted;
  }

  /**
   * Rewrite an args object so it carries the fence THIS tier issued.
   *
   * The key is removed entirely rather than set to `undefined`, because
   * `exactOptionalPropertyTypes` distinguishes "absent" from "explicitly undefined", and
   * because a tier reads `args.fence !== undefined` to decide whether to check at all.
   */
  private retarget<T extends { readonly owner: string; readonly fence?: number }>(
    args: T,
    tier: InstrumentReservationStore,
  ): T {
    const fence = this.fenceFor(args.owner, tier);
    if (fence !== undefined) return { ...args, fence };
    const { fence: _unused, ...rest } = args;
    return rest as T;
  }

  /**
   * Undo the tiers already taken, newest first.
   *
   * Every release is individually guarded: one tier failing to roll back must not
   * abandon the others, or a rejected acquire could leave a reservation stranded for a
   * full TTL in a tier nobody is looking at.
   */
  private async rollback(
    taken: readonly InstrumentReservationStore[],
    args: AcquireArgs,
    keys: readonly string[],
  ): Promise<void> {
    for (const tier of [...taken].reverse()) {
      try {
        await tier.release({ owner: args.owner, keys, now: args.now });
      } catch {
        /* the TTL is the backstop; a rollback failure must not mask the real outcome */
      }
    }
  }

  /** Durable first, then local. See the module docblock for why. */
  async release(args: ReleaseArgs): Promise<number> {
    if (this.authorityFenceMismatch(args.owner, args.fence)) {
      // A stale lease may not release the successor's reservation.
      return 0;
    }
    let released = 0;
    for (const tier of [...this.tiers].reverse()) {
      try {
        released = Math.max(released, await tier.release(this.retarget(args, tier)));
      } catch {
        /* a failed release must never propagate into an execution's cleanup path */
      }
    }
    this.fences.delete(args.owner);
    return released;
  }

  /**
   * Renew every tier. ANY failure is a failure of the whole renewal.
   *
   * Partial renewal is not a state an execution may proceed in: if the durable lease
   * lapsed, this worker no longer owns the contracts no matter how healthy its local
   * Map looks. The most severe reason is reported, with `unavailable` outranking
   * `lost` because unknown ownership needs a different operator response from
   * confirmed loss.
   */
  async renew(args: RenewArgs): Promise<RenewOutcome> {
    if (this.authorityFenceMismatch(args.owner, args.fence)) {
      // Refused, but the bookkeeping is KEPT. The caller is quoting a superseded token;
      // the lease the chain actually holds is untouched, and forgetting it here would
      // leave the real owner unable to renew or release it with its correct fence.
      return { ok: false, reason: "lost", detail: `${this.name}: the lease has been superseded` };
    }
    let expiresAt = Number.POSITIVE_INFINITY;
    let fence = 0;
    let failure: RenewOutcome | null = null;
    for (const tier of this.tiers) {
      let outcome: RenewOutcome;
      try {
        outcome = await tier.renew(this.retarget(args, tier));
      } catch (error) {
        outcome = {
          ok: false,
          reason: "unavailable",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      if (!outcome.ok) {
        if (failure === null || (outcome.reason === "unavailable" && failure.reason !== "unavailable")) {
          failure = outcome;
        }
        continue;
      }
      // The shortest surviving lease governs: an execution is only protected for as
      // long as its weakest tier says it is.
      expiresAt = Math.min(expiresAt, outcome.expiresAt);
      // Each tier's own (possibly re-issued) fence is recorded back, so a tier that
      // rotates its token on renewal stays in step.
      this.fences.get(args.owner)?.set(tier.name, outcome.fence);
      if (tier.durable || fence === 0) fence = outcome.fence;
    }
    if (failure !== null) {
      // The lease is gone or unknown; drop the bookkeeping so a later call cannot quote
      // a fence for a reservation that no longer exists.
      if (failure.reason !== "unavailable") this.fences.delete(args.owner);
      return failure;
    }
    return { ok: true, expiresAt: Number.isFinite(expiresAt) ? expiresAt : args.now, fence };
  }

  /** Owned only if EVERY tier agrees. The strictest verdict wins. */
  async verify(args: VerifyArgs): Promise<OwnershipVerdict> {
    if (this.authorityFenceMismatch(args.owner, args.fence)) {
      return { owned: false, reason: "lost", detail: `${this.name}: the lease has been superseded` };
    }
    let expiresAt = Number.POSITIVE_INFINITY;
    let fence = 0;
    let failure: OwnershipVerdict | null = null;
    for (const tier of this.tiers) {
      let verdict: OwnershipVerdict;
      try {
        verdict = await tier.verify(this.retarget(args, tier));
      } catch (error) {
        verdict = {
          owned: false,
          reason: "unavailable",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      if (!verdict.owned) {
        // `superseded` and `unavailable` are the reasons an operator must act on, so
        // they are preferred over a bare `lost` when several tiers disagree.
        const rank = (reason: string): number =>
          reason === "unavailable" ? 3 : reason === "superseded" ? 2 : 1;
        if (failure === null || rank(verdict.reason) > rank(failure.reason)) failure = verdict;
        continue;
      }
      expiresAt = Math.min(expiresAt, verdict.expiresAt);
      if (tier.durable || fence === 0) fence = verdict.fence;
    }
    if (failure !== null) return failure;
    return { owned: true, expiresAt: Number.isFinite(expiresAt) ? expiresAt : args.now, fence };
  }

  /** Answered by the authority, so two tiers can never be quoted as disagreeing. */
  async ownerOf(key: string, now: number): Promise<string | null> {
    const tier = this.authority;
    if (tier === undefined) return null;
    const owner = await tier.ownerOf(key, now);
    if (owner !== null) return owner;
    // Fall back to the local tier: a reservation this process holds is real even if
    // the durable tier is momentarily unreachable.
    const local = this.tiers[0];
    return local === undefined || local === tier ? null : local.ownerOf(key, now);
  }

  async sideOf(key: string, now: number): Promise<string | null> {
    const tier = this.authority;
    if (tier === undefined) return null;
    const side = await tier.sideOf(key, now);
    if (side !== null) return side;
    const local = this.tiers[0];
    return local === undefined || local === tier ? null : local.sideOf(key, now);
  }

  /**
   * Process-local, and taken from the LOCAL tier on purpose.
   *
   * This is the "how many contracts is this worker holding" number a diagnostics
   * route wants. A deployment-wide count needs I/O and is exposed separately, so a
   * synchronous status read can never accidentally become a database query.
   */
  activeCount(now: number): number {
    return this.tiers[0]?.activeCount(now) ?? 0;
  }

  activeKeys(now: number): string[] {
    return this.tiers[0]?.activeKeys(now) ?? [];
  }

  async clear(): Promise<void> {
    this.fences.clear();
    // Reverse order, mirroring release: the authority lets go first.
    for (const tier of [...this.tiers].reverse()) {
      try {
        await tier.clear();
      } catch {
        /* best effort; a tier that cannot be cleared expires by TTL */
      }
    }
  }

  /** Per-tier health, so an operator can see WHICH tier is degraded. */
  tierDiagnostics(): ReservationStoreDiagnostics[] {
    return this.tiers.map((tier) => tier.diagnostics());
  }

  diagnostics(): ReservationStoreDiagnostics {
    const parts = this.tierDiagnostics();
    const authority = parts.find((p) => p.durable) ?? parts[0];
    const sum = (pick: (p: ReservationStoreDiagnostics) => number): number =>
      parts.reduce((acc, p) => acc + pick(p), 0);
    return {
      name: this.name,
      durable: this.durable,
      ready: this.ready,
      activeReservations: parts[0]?.activeReservations ?? 0,
      // Attempt counts are per tier and would double count; the AUTHORITY's numbers
      // are the ones that describe cross-process contention.
      acquireAttempts: authority?.acquireAttempts ?? 0,
      acquireSuccess: authority?.acquireSuccess ?? 0,
      conflicts: sum((p) => p.conflicts),
      errors: sum((p) => p.errors),
      acquireLatencyP50Ms: authority?.acquireLatencyP50Ms ?? null,
      acquireLatencyP95Ms: authority?.acquireLatencyP95Ms ?? null,
      acquireLatencyP99Ms: authority?.acquireLatencyP99Ms ?? null,
      renewSuccess: authority?.renewSuccess ?? 0,
      renewFailure: authority?.renewFailure ?? 0,
      ownershipLost: sum((p) => p.ownershipLost),
      expiredReservationsObserved: sum((p) => p.expiredReservationsObserved),
      clockOffsetMs: authority?.clockOffsetMs ?? null,
      lastError: parts.find((p) => p.lastError !== null)?.lastError ?? null,
    };
  }
}
