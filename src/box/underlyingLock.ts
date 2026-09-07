/**
 * ONE ACTIVE BOX PER UNDERLYING — an OPTIONAL, additional entry restriction.
 *
 * WHAT PROBLEM THIS SOLVES
 *
 * The existing reservation layer locks EXACT CONTRACTS, which is precisely right for
 * preventing two executions from racing the same option. It deliberately does NOT prevent
 * two Boxes on the same underlying at different strikes — `RELIANCE 2500/2600` and
 * `RELIANCE 2550/2650` share no contract, so both may run concurrently today, and a test
 * (MP5) pins that as intended behaviour.
 *
 * Concurrent same-underlying Boxes are not an execution-safety problem; they are an
 * ACCOUNTING and RISK-ATTRIBUTION problem. Two Boxes on one underlying can hold opposite
 * option roles that economically offset each other, so the broker's net position per
 * contract no longer decomposes cleanly into "Box A's exposure" and "Box B's exposure".
 * Reconciliation, partial-exit accounting and residual attribution all become materially
 * harder to reason about at exactly the moment they matter most.
 *
 * So this module adds a SECOND, coarser layer, off by default:
 *
 *   Layer 1 (this module) — an underlying-level ENTRY restriction.
 *   Layer 2 (unchanged)   — the existing exact-contract durable reservation.
 *
 * Layer 2 is NOT replaced, weakened or bypassed. With the restriction disabled, behaviour is
 * byte-for-byte what it was.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * THE CENTRAL DESIGN DECISION: A TTL LEASE MUST NEVER REPRESENT AN OPEN POSITION
 * ────────────────────────────────────────────────────────────────────────────────────────
 *
 * The naive implementation takes a lease on `UNDERLYING:RELIANCE` for the duration of the
 * entry and releases it when the entry function returns. That is WRONG in both directions:
 *
 *   - Release on return ⇒ the lock vanishes while a Box is still OPEN, so a second
 *     RELIANCE Box enters immediately. The restriction would not restrict.
 *   - Hold until TTL ⇒ the lock is a lease with an expiry, so a long-held position outlives
 *     its own lock, and a crashed process' open position stops blocking after the TTL.
 *
 * Neither a lease nor durable state alone is sufficient, so this module composes BOTH and
 * blocks on the UNION:
 *
 *   Layer 1a — DURABLE POSITION OWNERSHIP. Derived from persisted Box state: open Boxes,
 *              partially-exited Boxes, RECOVERY Boxes, unresolved residual exposure, and
 *              unresolved order intents. It has no expiry, is reconstructed at boot from
 *              Mongo, and is authoritative for "a Box is live on this underlying".
 *
 *   Layer 1b — ENTRY PIPELINE OWNERSHIP. A short TTL lease in the existing durable
 *              reservation store, covering only the window between admission and the
 *              moment durable state exists. It exists solely to make the check
 *              cross-process safe; an in-process `Set` cannot do this job when live runs in
 *              more than one process.
 *
 * The lease may safely be released as soon as the entry settles, BECAUSE by then Layer 1a
 * has taken over. That is what makes the lock neither lost while a position is open nor
 * incorrectly retained once the position is fully flat: the two layers hand off, and
 * "fully flat" is defined by the same `isBoxPositionFlat` predicate the rest of the engine
 * uses. Both properties are pinned by tests.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * EXIT IMMUNITY
 * ────────────────────────────────────────────────────────────────────────────────────────
 *
 * This is an ENTRY restriction and nothing else. It is never consulted for an EXIT, a
 * PROTECTIVE_CANCEL, an EMERGENCY_RESIDUAL flatten, or a reconciliation-driven reduction.
 * Reducing exposure we already own must never be blocked by a gate whose purpose is to
 * limit how much new exposure we take on.
 *
 * Everything in this module is PURE. It performs no I/O, holds no state and reads no clock;
 * the caller supplies already-loaded state and owns the reservation store.
 */

import type { BoxLegRole, BoxOrderIntentState, BoxPositionState } from "./types.js";

/** The key class used for underlying-level reservations. */
export const UNDERLYING_KEY_CLASS = "UNDERLYING" as const;

/**
 * The refusal reason recorded when the underlying-level restriction blocks an entry.
 *
 * DELIBERATELY DISTINCT from a contract-reservation conflict. Reporting an
 * underlying-level block as `contract_reserved` would tell an operator that two Boxes
 * wanted the same option when in fact they wanted the same UNDERLYING at different
 * strikes — a completely different situation with a different remedy.
 */
export const UNDERLYING_ALREADY_ACTIVE_REASON = "underlying_already_active" as const;

/**
 * The canonical reservation key for an underlying under one broker.
 *
 * Broker-namespaced like every other reservation key in this system, for three reasons that
 * are not stylistic:
 *
 *   1. Broker generation / fencing / deployment scoping in the reservation layer key off the
 *      leading namespace, and a key outside the convention would silently opt out of them.
 *   2. `safeErrorMessage` in reservations/types.ts redacts keys by matching the
 *      `\b(ZERODHA|DHAN):` prefix; an unprefixed key would leak into error strings.
 *   3. A broker switch must not have one broker's underlying lock block the other's, for
 *      the same reason an instrument token is namespaced.
 *
 * `UNDERLYING` occupies the position an EXCHANGE code occupies in a contract key
 * (`ZERODHA:NFO:RELIANCE25SEP2500CE`). No Indian exchange is named "UNDERLYING", so the two
 * key spaces cannot collide; {@link assertNoKeyClassCollision} pins that.
 */
export function underlyingReservationKey(broker: string, underlying: string): string {
  const ns = broker.trim().toUpperCase();
  const symbol = underlying.trim().toUpperCase();
  return `${ns}:${UNDERLYING_KEY_CLASS}:${symbol}`;
}

/** True when `key` is an underlying-level reservation key rather than a contract key. */
export function isUnderlyingReservationKey(key: string): boolean {
  return parseUnderlyingReservationKey(key) !== null;
}

/**
 * The underlying encoded in an underlying-level key, or null when `key` is not one.
 *
 * Total: never throws, so a malformed key from a legacy row degrades to "not an underlying
 * key" rather than crashing a diagnostics read.
 */
export function parseUnderlyingReservationKey(key: string): string | null {
  const parts = key.split(":");
  if (parts.length !== 3) return null;
  if (parts[1] !== UNDERLYING_KEY_CLASS) return null;
  const symbol = parts[2]?.trim();
  return symbol ? symbol : null;
}

/**
 * Guard that the underlying key class can never be mistaken for an exchange code.
 *
 * Called by the test suite rather than at runtime. If someone ever adds an exchange named
 * `UNDERLYING`, contract keys and underlying keys would alias and the underlying lock could
 * be satisfied by an unrelated contract reservation — a silent safety hole. Failing loudly
 * in CI is the cheapest possible defence.
 */
export function assertNoKeyClassCollision(exchanges: readonly string[]): void {
  for (const exchange of exchanges) {
    if (exchange.trim().toUpperCase() === UNDERLYING_KEY_CLASS) {
      throw new Error(
        `Exchange "${exchange}" collides with the UNDERLYING reservation key class; ` +
          "contract keys and underlying-level keys would alias.",
      );
    }
  }
}

/**
 * Why an underlying counts as active. Every kind here must block a new entry.
 *
 * The list is deliberately broader than "an open Box": anything that means we may hold, or
 * may be about to hold, attributable exposure on this underlying counts. An UNKNOWN order
 * intent is included precisely because we cannot prove we do not hold exposure.
 */
export type UnderlyingActivityKind =
  /** A fully-established four-leg Box is open. */
  | "open_box"
  /** Some legs have been exited; the position is asymmetric. */
  | "partially_exited"
  /** The position is quarantined pending reconciliation. */
  | "recovery"
  /** Unresolved residual legs from a partial entry, partial exit or failed unwind. */
  | "residual_exposure"
  /** A durable order intent exists that is neither terminal nor proven flat. */
  | "working_entry_order"
  /** A durable intent is UNKNOWN or RECONCILIATION_REQUIRED — exposure unprovable. */
  | "uncertain_intent"
  /** An entry pipeline holds the underlying lease right now (this or another process). */
  | "entry_in_flight";

/** One underlying's activity, with every reason it is active. */
export interface UnderlyingActivity {
  readonly underlying: string;
  readonly kinds: readonly UnderlyingActivityKind[];
  /** Short, low-cardinality explanation suitable for a refusal detail string. */
  readonly detail: string;
}

/** An open/partial/recovery Box, reduced to what this module needs. */
export interface UnderlyingPositionInput {
  readonly underlying: string;
  readonly position_state?: BoxPositionState;
  /** Per-role remaining quantity. A Box with every role at 0 is FLAT and does NOT block. */
  readonly remaining_qty_by_role?: Partial<Record<BoxLegRole, number>> | null;
}

/** Unresolved residual exposure, attributed to an underlying. */
export interface UnderlyingResidualInput {
  readonly underlying: string;
  readonly legs: number;
}

/** A durable order intent that has not proven itself harmless. */
export interface UnderlyingIntentInput {
  readonly underlying: string;
  readonly state: BoxOrderIntentState;
}

/** An entry pipeline currently holding (or attempting) the underlying lease. */
export interface UnderlyingPipelineInput {
  readonly underlying: string;
}

export interface UnderlyingActivityInput {
  readonly positions?: readonly UnderlyingPositionInput[];
  readonly residuals?: readonly UnderlyingResidualInput[];
  readonly intents?: readonly UnderlyingIntentInput[];
  readonly pipelines?: readonly UnderlyingPipelineInput[];
}

/**
 * Intent states that still imply possible, unproven exposure.
 *
 * `CREATED` counts: a durable intent exists whose broker outcome we have not yet observed,
 * so we cannot assert nothing reached the broker. `COMPLETE` also counts as a WORKING order
 * only when the position it belongs to is still open, which the position input already
 * covers — so `COMPLETE`/`CANCELLED`/`REJECTED` are excluded here to avoid a terminal,
 * fully-reconciled intent blocking the underlying forever.
 */
const UNRESOLVED_INTENT_STATES: ReadonlySet<BoxOrderIntentState> = new Set<BoxOrderIntentState>([
  "CREATED",
  "SUBMITTING",
  "ACKNOWLEDGED",
  "OPEN",
  "PARTIALLY_FILLED",
  "CANCEL_REQUESTED",
]);

/** Intent states whose exposure is genuinely UNKNOWN. Strictly worse than "working". */
const UNCERTAIN_INTENT_STATES: ReadonlySet<BoxOrderIntentState> = new Set<BoxOrderIntentState>([
  "UNKNOWN",
  "RECONCILIATION_REQUIRED",
]);

function normalise(underlying: string): string {
  return underlying.trim().toUpperCase();
}

/** True when every role's remaining quantity is exactly zero. Mirrors `isBoxPositionFlat`. */
function positionIsFlat(remaining: Partial<Record<BoxLegRole, number>> | null | undefined): boolean {
  if (!remaining) return false;
  const values = Object.values(remaining);
  if (values.length === 0) return false;
  return values.every((value) => value === 0);
}

/**
 * Derive the set of underlyings that must block a new Box entry.
 *
 * PURE and TOTAL. The caller assembles the inputs from already-loaded durable state, which
 * is what makes the answer survive a process restart: nothing here depends on a lease, a
 * timer, or in-process memory.
 *
 * A position that is FLAT (every role at zero) is deliberately NOT active. Retaining the
 * lock after a Box is fully flat would silently turn `BOX_ONE_ACTIVE_BOX_PER_UNDERLYING`
 * into "one Box per underlying per process lifetime", which is a different and unrequested
 * restriction. A `RECOVERY` position is active even when its remaining quantities look flat,
 * because RECOVERY means the quantities themselves are not trusted.
 */
export function activeUnderlyings(input: UnderlyingActivityInput): Map<string, UnderlyingActivity> {
  const kinds = new Map<string, Set<UnderlyingActivityKind>>();

  const add = (underlying: string, kind: UnderlyingActivityKind): void => {
    const key = normalise(underlying);
    if (!key) return;
    const existing = kinds.get(key);
    if (existing) existing.add(kind);
    else kinds.set(key, new Set([kind]));
  };

  for (const position of input.positions ?? []) {
    const state = position.position_state ?? "BOX";
    if (state === "RECOVERY") {
      // Quarantined: quantities are not trusted, so flatness cannot clear it.
      add(position.underlying, "recovery");
      continue;
    }
    if (state === "FLAT" || positionIsFlat(position.remaining_qty_by_role)) continue;
    add(position.underlying, state === "PARTIALLY_EXITED" ? "partially_exited" : "open_box");
  }

  for (const residual of input.residuals ?? []) {
    if (residual.legs > 0) add(residual.underlying, "residual_exposure");
  }

  for (const intent of input.intents ?? []) {
    if (UNCERTAIN_INTENT_STATES.has(intent.state)) add(intent.underlying, "uncertain_intent");
    else if (UNRESOLVED_INTENT_STATES.has(intent.state)) add(intent.underlying, "working_entry_order");
  }

  for (const pipeline of input.pipelines ?? []) {
    add(pipeline.underlying, "entry_in_flight");
  }

  const result = new Map<string, UnderlyingActivity>();
  for (const [underlying, set] of kinds) {
    // Stable, deterministic ordering so a refusal detail string is reproducible and a
    // snapshot test does not depend on insertion order.
    const ordered = ([...set] as UnderlyingActivityKind[]).sort();
    result.set(underlying, {
      underlying,
      kinds: ordered,
      detail: `${underlying} is already active (${ordered.join(", ")})`,
    });
  }
  return result;
}

/** The verdict of the underlying-level entry gate. */
export type UnderlyingAdmission =
  | { readonly allowed: true; readonly enabled: boolean }
  | {
      readonly allowed: false;
      readonly enabled: true;
      readonly reason: typeof UNDERLYING_ALREADY_ACTIVE_REASON;
      readonly underlying: string;
      readonly activity: UnderlyingActivity;
      readonly detail: string;
    };

/**
 * Evaluate the underlying-level restriction for one candidate.
 *
 * When `enabled` is false this always admits, which is what keeps the default
 * (`BOX_ONE_ACTIVE_BOX_PER_UNDERLYING=false`) a genuine no-op.
 *
 * Applies REGARDLESS of strike pair, expiry and Box direction — that breadth is the whole
 * point. `RELIANCE 2500/2600` active blocks `RELIANCE 2550/2650` even though they share no
 * contract.
 */
export function evaluateUnderlyingAdmission(args: {
  readonly enabled: boolean;
  readonly underlying: string;
  readonly active: ReadonlyMap<string, UnderlyingActivity>;
}): UnderlyingAdmission {
  if (!args.enabled) return { allowed: true, enabled: false };
  const key = normalise(args.underlying);
  const activity = args.active.get(key);
  if (!activity) return { allowed: true, enabled: true };
  return {
    allowed: false,
    enabled: true,
    reason: UNDERLYING_ALREADY_ACTIVE_REASON,
    underlying: key,
    activity,
    detail:
      `${activity.detail}; BOX_ONE_ACTIVE_BOX_PER_UNDERLYING is enabled, so a second ${key} Box ` +
      "may not enter regardless of strike pair, expiry or direction. This is NOT a contract " +
      "reservation conflict.",
  };
}

/**
 * Whether the entry-pipeline LEASE for an underlying may be released now.
 *
 * The lease is a bridge, not the lock. It may be dropped once durable state proves the
 * underlying is (or is not) carrying exposure — because from that point Layer 1a blocks.
 * It must be RETAINED while the outcome is uncertain, since neither layer can then prove
 * safety, and an expired lease plus unprovable durable state would let a second Box in.
 *
 * Returns false for `uncertain`, mirroring the coordinator's existing behaviour of holding
 * a contract reservation on an ambiguous terminal state rather than releasing it.
 */
export function mayReleaseUnderlyingLease(outcome: "clean" | "uncertain"): boolean {
  return outcome === "clean";
}
