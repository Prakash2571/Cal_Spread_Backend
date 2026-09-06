/**
 * THE NARROW PORT the durable tier speaks to its authority through.
 *
 * WHY A PORT AND NOT `import mongoose` INSIDE THE ALGORITHM
 * Two reasons, both practical rather than architectural taste.
 *
 * 1. The correctness of the acquire algorithm — all-or-none, logical expiry,
 *    owner-verified release, monotonic fencing, clock-skew handling — is
 *    independently testable only if it can be driven without a live database. The
 *    Box test suite is deliberately offline (no Mongo, no network, no credentials);
 *    a durable store that could only be exercised against a real cluster would
 *    simply never be exercised.
 *
 * 2. It forces the exact set of database capabilities being relied on to be written
 *    down. Every method below is a promise the Mongo adapter has to keep, and the
 *    one that matters most is `insert`: ONE document, atomically, rejected in its
 *    entirety if ANY of its keys is already claimed. If a future backend cannot
 *    honour that, it cannot implement this interface, and that is the point.
 *
 * This is NOT a generic repository abstraction and must not grow into one. It has no
 * query builder, no partial updates, no cursors — only the operations the lock needs.
 */

/**
 * One durable reservation: a complete instrument set held by one execution.
 *
 * Timestamps are milliseconds ON THE AUTHORITY'S CLOCK, never the caller's. The
 * durable tier converts at its boundary; see the clock discussion in `durable.ts`.
 */
export interface DurableReservationDoc {
  /** The globally unique owner id. Also the document's primary key. */
  readonly owner: string;
  readonly deployment: string;
  readonly broker: string;
  readonly generation: number;
  /** Execution mode, diagnostics only. */
  readonly mode: string;
  /** Canonical broker-namespaced contract keys. Deduplicated by the caller. */
  readonly keys: readonly string[];
  /** Side metadata per key, for describing a conflict. Never a correctness input. */
  readonly sides: readonly { readonly key: string; readonly side: string }[];
  /** Monotonic fencing token. */
  readonly fence: number;
  /** `instance:pid:boot` of the owning process, for operator diagnostics. */
  readonly instance: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly renewedAt: number;
}

/**
 * Why an insert did not happen.
 *
 * The two duplicate causes MUST be distinguishable. `key_conflict` means another
 * execution holds one of the contracts — a legitimate, expected outcome. `owner_exists`
 * means this very owner already has a document, which is a re-entrancy artefact and is
 * safely resolved by deleting our OWN row. Collapsing them into one "duplicate" would
 * either mask a real conflict or make the store delete a stranger's lease.
 */
export type InsertReservationResult = "inserted" | "key_conflict" | "owner_exists";

export interface DurableReservationPort {
  /** Diagnostic name, e.g. `mongo`. Appears in fail-closed messages. */
  readonly name: string;
  /**
   * True when this port really is shared between processes.
   *
   * The in-memory reference implementation used by the tests sets this explicitly so
   * a test double can never accidentally satisfy `BOX_RESERVATION_REQUIRE_DURABLE`
   * in production code paths by looking durable when it is not.
   */
  readonly crossProcess: boolean;
  /** False until `ensureReady()` has succeeded, or after a hard failure. */
  readonly ready: boolean;

  /**
   * Connect (if needed), CREATE THE INDEXES, and prove the authority answers.
   *
   * Index creation belongs here and must be explicit: relying on Mongoose's
   * `autoIndex` would mean the unique constraint that provides the entire atomicity
   * guarantee might silently not exist in production.
   */
  ensureReady(): Promise<void>;

  /** The authority's current wall clock, in ms. The single source of time. */
  serverTimeMs(): Promise<number>;

  /**
   * Allocate the next fencing token for a deployment. Strictly increasing.
   *
   * Must be a genuine atomic increment against shared state, not a local counter and
   * not a timestamp: a token that can repeat or go backwards cannot identify a stale
   * owner, which is the only reason it exists.
   */
  nextFence(deployment: string): Promise<number>;

  /**
   * Insert ONE document, atomically, all keys or none.
   *
   * The whole design rests on this call. It must be a single-document write whose
   * unique-index check covers every element of `keys`, so that four contracts are
   * claimed together or not at all.
   */
  insert(doc: DurableReservationDoc): Promise<InsertReservationResult>;

  /**
   * Delete documents in `deployment` that overlap `keys` AND whose `expiresAt` is at
   * or before `notAfter`. Returns how many were removed.
   *
   * Race-safe by construction: the predicate is evaluated per document by the
   * authority, and a lease can only be renewed while it is still unexpired, so
   * anything matching this filter has already lost ownership. It can never delete a
   * live lease.
   */
  deleteExpired(args: {
    readonly deployment: string;
    readonly keys?: readonly string[];
    readonly notAfter: number;
  }): Promise<number>;

  /** Documents in `deployment` overlapping `keys` and still live at `now`. */
  findLiveByKeys(args: {
    readonly deployment: string;
    readonly keys: readonly string[];
    readonly now: number;
  }): Promise<DurableReservationDoc[]>;

  findByOwner(owner: string): Promise<DurableReservationDoc | null>;

  /**
   * Delete a document by owner, optionally pinned to a fence. Returns 1 or 0.
   *
   * Owner-scoped and never key-scoped. A `deleteMany({keys: {$in: keys}})` would
   * remove whoever currently holds those contracts, which after an expiry and
   * reacquisition is somebody else.
   */
  deleteOwned(args: { readonly owner: string; readonly fence?: number }): Promise<number>;

  /**
   * Extend a lease, but only if `owner` (and `fence`, when given) still matches AND
   * it has not already expired on the authority's clock. Returns the updated
   * document, or null when ownership was not confirmed.
   */
  renewOwned(args: {
    readonly owner: string;
    readonly fence?: number;
    /**
     * The broker and generation the caller believes are active.
     *
     * Part of the FILTER, not a check the caller performs afterwards: a superseded lease
     * must not have its expiry extended and only then be rejected, because that locks the
     * contract for another full TTL on behalf of a worker that may not trade it.
     */
    readonly broker?: string;
    readonly generation?: number;
    readonly now: number;
    readonly expiresAt: number;
  }): Promise<DurableReservationDoc | null>;

  /**
   * Delete every document whose owner starts with `prefix`. Returns the count.
   *
   * Used on broker switch to drop THIS PROCESS's now-meaningless reservations. The
   * prefix encodes deployment, host, pid and boot token, so it cannot match a
   * sibling worker — deleting those would be the very violation being fixed.
   */
  deleteByOwnerPrefix(prefix: string): Promise<number>;

  /** Live document count in a deployment, for diagnostics. */
  countLive(args: { readonly deployment: string; readonly now: number }): Promise<number>;

  /** Release any resources. Optional; the Mongo adapter shares the app's connection. */
  close?(): Promise<void>;
}
