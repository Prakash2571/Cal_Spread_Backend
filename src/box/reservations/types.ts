/**
 * THE RESERVATION CONTRACT — one contract, one execution, across every worker.
 *
 * WHAT CHANGED AND WHY IT HAD TO
 * The in-process store is genuinely atomic inside ONE Node process: it inspects
 * every key and then writes every key with no `await` between the two passes, so no
 * other execution in that process can interleave. That argument is airtight and it
 * is also entirely local. Under PM2 cluster mode, two EC2 instances, Kubernetes
 * replicas or a separate Box execution service, each process has its OWN Map, both
 * see RELIANCE 2550CE as free, both reserve it, and both send an order. The
 * same-leg protection was therefore process-local, not deployment-wide.
 *
 * Closing that gap forces this interface to become ASYNCHRONOUS. A shared
 * correctness authority is a database, a database is I/O, and I/O is a promise.
 * There is no honest way around it: pretending a Mongo round trip is synchronous
 * would mean either blocking the event loop or firing-and-forgetting the very write
 * that establishes exclusion. So `tryAcquireAll`, `release`, `renew` and `verify`
 * all return promises, and the atomicity argument moves from "no await in the
 * critical section" to "the database rejects the second writer" — see
 * `durable.ts` for why a single-document insert against a unique multikey index
 * gives exactly that.
 *
 * WHAT DELIBERATELY STAYED SYNCHRONOUS
 * `activeCount`, `activeKeys` and `diagnostics` are process-local, do no I/O, and
 * are read from a synchronous diagnostics object literal
 * (`engine.getExecutionDiagnostics()`). Making them async would turn a cold
 * read-only status route into an async cascade for no safety gain, so instead they
 * answer for what THIS process holds and say so.
 *
 * THREE OUTCOMES, NOT TWO
 * A reservation attempt can conflict, or the authority can be UNREACHABLE, and
 * conflating those is how a safety primitive fails open. `reason: "unavailable"`
 * exists so the coordinator can refuse a live entry (`fail closed`) instead of
 * mistaking a dead database for an empty lock table.
 */

/** Whether a lease is backed by a cross-process authority, or only by this process. */
export type ReservationDurability = "durable" | "local_only";

/** Why an acquire attempt failed, when it failed because someone else holds a key. */
export interface ReservationConflictDetail {
  readonly key: string;
  readonly heldBy: string;
  /**
   * The side the incumbent recorded for this key, when the reporting tier knows it.
   *
   * Carried on the conflict itself rather than fetched afterwards: a second lookup
   * would be a fresh read against a table that can change between the two calls, so
   * the classification could describe a holder that no longer exists.
   */
  readonly heldSide: string | null;
  /** Which tier reported the conflict, for logs and metrics. */
  readonly tier: string;
}

/**
 * A granted reservation.
 *
 * `fence` is the fencing token. It is monotonic where a durable authority can make
 * it so (see `durable.ts`), and it is what lets a stale worker be recognised after
 * its lease expired and someone else reacquired the same contracts.
 */
export interface ReservationLease {
  readonly owner: string;
  readonly keys: readonly string[];
  readonly expiresAt: number;
  readonly fence: number;
  readonly durability: ReservationDurability;
}

export type ReservationOutcome =
  | ({ readonly ok: true } & ReservationLease)
  | {
      readonly ok: false;
      readonly reason: "conflict";
      readonly conflicts: readonly ReservationConflictDetail[];
    }
  | {
      readonly ok: false;
      /**
       * The authority could not be consulted. NOT a conflict, and never to be
       * treated as "free": live entry must fail closed on this.
       */
      readonly reason: "unavailable";
      readonly tier: string;
      readonly detail: string;
    };

/**
 * The deployment/broker identity a reservation belongs to.
 *
 * Recorded on the durable document and re-verified before execution. A worker from
 * broker generation 13 must not keep trading once generation 14 is active, and a
 * staging worker must never contend with production for the same lock.
 */
export interface ReservationContext {
  readonly deployment: string;
  readonly broker: string;
  readonly generation: number;
  /** Execution mode, for diagnostics only. Never a correctness input. */
  readonly mode: string;
}

export interface AcquireArgs {
  /** Globally unique id of the execution attempting the reservation. */
  readonly owner: string;
  readonly keys: readonly string[];
  readonly ttlMs: number;
  readonly now: number;
  /**
   * Opaque per-key metadata carried back on a conflict, so an overlap can be
   * described (e.g. the side the incumbent intended) without a second lookup.
   * Never interpreted as a correctness input by any tier.
   */
  readonly sideByKey?: ReadonlyMap<string, string>;
  readonly context?: ReservationContext;
}

export interface ReleaseArgs {
  readonly owner: string;
  readonly keys?: readonly string[];
  readonly now: number;
  /**
   * The fence of the lease being released, when the caller holds one.
   *
   * Belt and braces on top of owner identity: owners are minted per execution and
   * never reused, so an owner match already implies a lease match, but a release
   * that also pins the fence cannot possibly delete a successor's document.
   */
  readonly fence?: number;
}

export interface RenewArgs {
  readonly owner: string;
  readonly keys: readonly string[];
  readonly ttlMs: number;
  readonly now: number;
  readonly fence?: number;
  /**
   * Overrides the store's own context. A renewal checks it, because a broker switch
   * during a long execution must surface as lost ownership rather than a quiet
   * extension of a lease nobody should be trading on any more.
   */
  readonly context?: ReservationContext;
}

export type RenewOutcome =
  | { readonly ok: true; readonly expiresAt: number; readonly fence: number }
  | {
      readonly ok: false;
      /**
       * `lost` — the lease is gone or belongs to someone else now.
       * `expired` — it was still there but already past its expiry.
       * `unavailable` — the authority could not be reached; ownership is UNKNOWN,
       *   which for live trading must be treated as not-owned.
       */
      readonly reason: "lost" | "expired" | "unavailable";
      readonly detail: string;
    };

export type OwnershipVerdict =
  | { readonly owned: true; readonly expiresAt: number; readonly fence: number }
  | {
      readonly owned: false;
      /**
       * `superseded` is the broker-generation / deployment mismatch: the lease is
       * intact but the world moved on, so continuing to trade on it is wrong.
       */
      readonly reason: "expired" | "lost" | "superseded" | "unavailable";
      readonly detail: string;
    };

export interface VerifyArgs {
  readonly owner: string;
  readonly keys: readonly string[];
  readonly now: number;
  readonly fence?: number;
  readonly context?: ReservationContext;
}

/** Bounded, low-cardinality health for one tier. Safe to serialise into an API. */
export interface ReservationStoreDiagnostics {
  readonly name: string;
  readonly durable: boolean;
  readonly ready: boolean;
  /** Reservations THIS process currently holds in this tier. */
  readonly activeReservations: number;
  readonly acquireAttempts: number;
  readonly acquireSuccess: number;
  readonly conflicts: number;
  /** Failures to reach the authority. Distinct from conflicts, on purpose. */
  readonly errors: number;
  readonly acquireLatencyP50Ms: number | null;
  readonly acquireLatencyP95Ms: number | null;
  readonly acquireLatencyP99Ms: number | null;
  readonly renewSuccess: number;
  readonly renewFailure: number;
  readonly ownershipLost: number;
  /** Logically-expired documents this tier has observed and reclaimed. */
  readonly expiredReservationsObserved: number;
  /**
   * Measured offset between this process's clock and the authority's, in ms.
   * Null for a tier that has no external clock.
   */
  readonly clockOffsetMs: number | null;
  /** Last error message, truncated. Never contains a credential or a URI. */
  readonly lastError: string | null;
}

export interface InstrumentReservationStore {
  /** Diagnostic name, surfaced in metrics and fail-closed messages. */
  readonly name: string;
  /** True when this tier is authoritative ACROSS PROCESSES. */
  readonly durable: boolean;
  /** True when the tier can currently be consulted at all. */
  readonly ready: boolean;

  /**
   * Take every key or none.
   *
   * All-or-none is not a convenience, it is deadlock avoidance. If A held 1320 while
   * waiting for 1340 exactly as B held 1340 while waiting for 1320, neither would
   * ever proceed. No partial state is observable: a reservation either takes every
   * key it asked for, or takes none and reports what blocked it.
   */
  tryAcquireAll(args: AcquireArgs): Promise<ReservationOutcome>;

  /**
   * Release keys held by `owner`. Returns how many were actually released.
   *
   * MUST NOT release a key owned by anyone else. This is a compare-owner-and-delete,
   * not a `GET` then `DEL`: between those two the key can have expired and been
   * retaken by a different execution, and deleting it then would strip an active
   * reservation from its rightful owner.
   */
  release(args: ReleaseArgs): Promise<number>;

  /** Extend an owner's existing lease. Only the current owner may renew. */
  renew(args: RenewArgs): Promise<RenewOutcome>;

  /**
   * Does `owner` still hold this lease RIGHT NOW, under this broker generation?
   *
   * Called before a significant execution phase. A lease that expired, was taken by
   * someone else, or belongs to a superseded broker generation is not permission to
   * trade — see the `TTL != EXECUTION PERMISSION` argument in `durable.ts`.
   */
  verify(args: VerifyArgs): Promise<OwnershipVerdict>;

  /**
   * Current owner of a key, or null when free/expired.
   *
   * DIAGNOSTIC ONLY, and it FAILS OPEN: a tier that cannot reach its authority answers
   * `null`, which reads as "free". That is acceptable precisely because no decision is
   * made from it — conflict details arrive on the acquire outcome itself, so the
   * execution path never needs this. Do not introduce a caller that gates execution on
   * it without first making it fail closed.
   */
  ownerOf(key: string, now: number): Promise<string | null>;
  /** The side metadata recorded with a key by its current owner, if any. Diagnostic only. */
  sideOf(key: string, now: number): Promise<string | null>;

  /**
   * Live reservations THIS PROCESS holds. Synchronous and I/O-free by contract, so
   * the cold diagnostics route stays synchronous.
   */
  activeCount(now: number): number;
  /** Every live key this process holds, for diagnostics. */
  activeKeys(now: number): string[];

  /**
   * Drop the reservations THIS PROCESS owns.
   *
   * Used on broker switch, where keys change namespace wholesale. Deliberately NOT
   * "delete every document": another worker may legitimately own reservations, and
   * wiping them would be the exact failure this tier exists to prevent.
   */
  clear(): Promise<void>;

  diagnostics(): ReservationStoreDiagnostics;
}

/**
 * Event-driven release notification, for tiers that can offer it.
 *
 * Only meaningful WITHIN a process: an in-memory emitter cannot know that a
 * different worker released a contract. Cross-process waiters fall back to bounded
 * retry — see the hybrid wait strategy in `executionCoordinator.ts`.
 */
export interface ReservationWaitable {
  onRelease(keys: readonly string[], cb: () => void): () => void;
}

export function isWaitable(store: unknown): store is ReservationWaitable {
  return typeof (store as ReservationWaitable | null)?.onRelease === "function";
}

/** Percentiles over a bounded sample window — no unbounded arrays on a hot path. */
export class BoundedSamples {
  private buf: number[] = [];
  constructor(private readonly max = 256) {}
  add(v: number): void {
    if (!Number.isFinite(v)) return;
    if (this.buf.length >= this.max) this.buf.shift();
    this.buf.push(v);
  }
  percentile(p: number): number | null {
    if (this.buf.length === 0) return null;
    const sorted = [...this.buf].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return sorted[idx] ?? null;
  }
  get samples(): number {
    return this.buf.length;
  }
}

/** Distinct keys, order preserved. Deduplication matters: see `durable.ts`. */
export function dedupeKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Clamp a TTL to something a lock can actually mean. */
export function normaliseTtl(ttlMs: number): number {
  return Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : 1000;
}

/**
 * Truncate an error for diagnostics without leaking a credential or a contract.
 *
 * Two redactions, both earning their place. A Mongo driver error reliably embeds the
 * CONNECTION STRING, which carries a password. A duplicate-key error embeds the
 * OFFENDING KEY VALUE, which is a broker-namespaced instrument — high-cardinality data
 * that must not reach a metrics field or an operator-facing log line. Errors from this
 * subsystem end up in an admin API response, so both are scrubbed at the source rather
 * than at each call site.
 */
export function safeErrorMessage(error: unknown, max = 200): string {
  const raw = error instanceof Error ? error.message : String(error);
  const scrubbed = raw
    .replace(/mongodb(\+srv)?:\/\/[^\s,)]+/gi, "mongodb://<redacted>")
    .replace(/\b(ZERODHA|DHAN):[A-Za-z0-9:._-]+/gi, "$1:<contract>");
  return scrubbed.length > max ? `${scrubbed.slice(0, max)}…` : scrubbed;
}
