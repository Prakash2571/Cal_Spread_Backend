/**
 * DETERMINISTIC PARTIAL-ENTRY RECOVERY.
 *
 * THE RULE THIS PRESERVES
 *
 * If all four legs do not reach their requested quantity, THERE IS NO VALID BOX. The trade
 * record is never opened as a completed Box. That rule is unchanged; what this module adds is
 * an EXPLICIT, ORDERED, TESTABLE recovery sequence instead of an implicit one.
 *
 * THE SEQUENCE, in order:
 *
 *   1. Stop submitting ENTRY roles that have not yet been submitted (when safe).
 *   2. Request cancellation of outstanding ENTRY orders.
 *   3. WAIT for authoritative terminal quantities from the broker.
 *   4. Compute exact confirmed exposure per role.
 *   5. Protectively unwind ONLY the confirmed exposure, at exact quantities.
 *   6. Persist the result.
 *   7. Carry any un-unwound remainder as durable residual exposure.
 *   8. Block new entry until that exposure is handled by the existing rules.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * THE THREE THINGS THIS MUST NEVER DO
 * ────────────────────────────────────────────────────────────────────────────────────────
 *
 *   - NEVER pretend unfilled quantity filled. A shortfall is a shortfall.
 *   - NEVER discard a known fill. A broker-confirmed fill is IRREVERSIBLE STATE.
 *   - NEVER "cancel" a filled quantity. Cancellation applies to the WORKING remainder only.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * A CANCEL REQUEST CAN RACE A FILL
 * ────────────────────────────────────────────────────────────────────────────────────────
 *
 * `cancelOrder` returning success does NOT mean the order was cancelled. The quantity may
 * have filled microseconds earlier, in which case the broker's cumulative filled quantity is
 * larger than it was when we asked. This module therefore NEVER sizes an unwind from a
 * pre-cancel snapshot: {@link planPartialEntryRecovery} refuses to plan an unwind at all
 * until every submitted leg is `terminal`, and sizes it from `confirmedFilled` read at that
 * terminal state. A raced fill is consequently unwound, not stranded.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * UNKNOWN BROKER STATE IS NOT ZERO
 * ────────────────────────────────────────────────────────────────────────────────────────
 *
 * A leg whose broker state is UNKNOWN or RECONCILIATION_REQUIRED has an unprovable filled
 * quantity. Treating it as zero would risk leaving real exposure naked; treating it as full
 * would risk unwinding quantity we never held (a NEW naked position in the opposite
 * direction). Neither is acceptable, so the plan reports `quantityUnknown` and directs the
 * caller to QUARANTINE — which is the existing behaviour, made explicit and testable here.
 *
 * PURE: no I/O, no clock, no broker. The caller executes the plan.
 */

import type { BoxLegRole, OrderSide } from "./types.js";

/** One entry leg's authoritative outcome, as observed from the broker. */
export interface EntryLegOutcome {
  readonly role: BoxLegRole;
  /** The side the ENTRY leg was working. The unwind reverses it. */
  readonly side: OrderSide;
  /** The quantity we asked for. Immutable. */
  readonly requested: number;
  /**
   * BROKER CUMULATIVE FILLED QUANTITY. The single fill authority.
   *
   * Not a depth-walk estimate, not a WebSocket-derived guess, not our own tally.
   */
  readonly confirmedFilled: number;
  /** True once the broker has reported a terminal state for this order. */
  readonly terminal: boolean;
  /** False when the leg was never submitted (e.g. we stopped early). */
  readonly submitted: boolean;
  /** False for UNKNOWN / RECONCILIATION_REQUIRED — the filled quantity is unprovable. */
  readonly brokerStateKnown: boolean;
}

/** One protective unwind order the plan calls for. */
export interface PlannedUnwind {
  readonly role: BoxLegRole;
  /** The REVERSED side. Entry BUY ⇒ unwind SELL. */
  readonly side: OrderSide;
  /** Exactly the confirmed filled quantity. Never rounded, never a lot multiple. */
  readonly quantity: number;
}

/** What the caller must do next. Mutually exclusive and exhaustive. */
export type PartialEntryAction =
  /** All four legs reached requested quantity. Proceed to final economics qualification. */
  | "qualify_complete_box"
  /** Nothing filled anywhere. Cancel outstanding work; there is no exposure to unwind. */
  | "no_exposure"
  /** Confirmed exposure exists and every submitted leg is terminal. Unwind exactly it. */
  | "unwind_confirmed_exposure"
  /** Submitted legs are still working. Cancel and re-plan once terminal. */
  | "await_terminal"
  /** A leg's filled quantity is unprovable. Quarantine; do NOT unwind, do NOT open. */
  | "quarantine_unknown";

export interface PartialEntryPlan {
  readonly action: PartialEntryAction;
  /** True only when every leg's `confirmedFilled >= requested`. */
  readonly complete: boolean;
  /** True when any submitted leg has an unprovable filled quantity. */
  readonly quantityUnknown: boolean;
  /** Submitted, non-terminal legs whose working remainder must be cancelled. */
  readonly cancelRoles: readonly BoxLegRole[];
  /** Submitted legs we are still waiting on for an authoritative terminal quantity. */
  readonly awaitTerminalRoles: readonly BoxLegRole[];
  /** Roles never submitted, whose submission must be stopped. */
  readonly stopSubmitRoles: readonly BoxLegRole[];
  /** Exact per-role reversals. Empty unless `action === "unwind_confirmed_exposure"`. */
  readonly unwind: readonly PlannedUnwind[];
  /** Sum of confirmed filled quantity across all legs. */
  readonly totalConfirmedQuantity: number;
  /** Per-role confirmed filled quantity, for accounting and assertions. */
  readonly confirmedByRole: Readonly<Partial<Record<BoxLegRole, number>>>;
  readonly detail: string;
}

/** Reverse a side. The only place the entry→unwind inversion is expressed. */
export function reverseSide(side: OrderSide): OrderSide {
  return side === "BUY" ? "SELL" : "BUY";
}

/**
 * Build the recovery plan from authoritative broker outcomes.
 *
 * `expectedRoles` is the full set of ENTRY roles the Box asked for, so a role missing from
 * `legs` entirely is correctly reported as "never submitted" rather than silently ignored.
 */
export function planPartialEntryRecovery(args: {
  readonly legs: readonly EntryLegOutcome[];
  readonly expectedRoles: readonly BoxLegRole[];
}): PartialEntryPlan {
  const byRole = new Map<BoxLegRole, EntryLegOutcome>();
  for (const leg of args.legs) byRole.set(leg.role, leg);

  const confirmedByRole: Partial<Record<BoxLegRole, number>> = {};
  const cancelRoles: BoxLegRole[] = [];
  const awaitTerminalRoles: BoxLegRole[] = [];
  const stopSubmitRoles: BoxLegRole[] = [];
  let totalConfirmed = 0;
  let quantityUnknown = false;
  let allRequestedMet = true;

  for (const role of args.expectedRoles) {
    const leg = byRole.get(role);
    if (!leg || !leg.submitted) {
      stopSubmitRoles.push(role);
      allRequestedMet = false;
      confirmedByRole[role] = 0;
      continue;
    }
    // Clamp a nonsensical negative reading to 0 for accounting, but never upward: an
    // over-report is a real anomaly the ledger must see, not something to normalise away.
    const filled = Number.isFinite(leg.confirmedFilled) ? Math.max(0, leg.confirmedFilled) : 0;
    confirmedByRole[role] = filled;
    totalConfirmed += filled;
    if (!leg.brokerStateKnown) {
      quantityUnknown = true;
      allRequestedMet = false;
      continue;
    }
    if (!leg.terminal) {
      cancelRoles.push(role);
      awaitTerminalRoles.push(role);
      allRequestedMet = false;
      continue;
    }
    if (filled < leg.requested) allRequestedMet = false;
  }

  if (allRequestedMet && args.expectedRoles.length > 0) {
    return {
      action: "qualify_complete_box",
      complete: true,
      quantityUnknown: false,
      cancelRoles: [],
      awaitTerminalRoles: [],
      stopSubmitRoles: [],
      unwind: [],
      totalConfirmedQuantity: totalConfirmed,
      confirmedByRole,
      detail: "all four legs reached requested quantity",
    };
  }

  // UNKNOWN OUTRANKS EVERYTHING. Quarantine before cancelling or unwinding: acting on an
  // unprovable quantity is how a recovery turns into a new naked position.
  if (quantityUnknown) {
    return {
      action: "quarantine_unknown",
      complete: false,
      quantityUnknown: true,
      cancelRoles,
      awaitTerminalRoles,
      stopSubmitRoles,
      unwind: [],
      totalConfirmedQuantity: totalConfirmed,
      confirmedByRole,
      detail:
        "at least one leg's broker filled quantity is unprovable (UNKNOWN / RECONCILIATION_REQUIRED); " +
        "quarantining instead of unwinding, because unwinding an unproven quantity would create " +
        "opposite naked exposure",
    };
  }

  // Still working somewhere: cancel, then re-plan. Deliberately does NOT size an unwind from
  // the current snapshot, because a cancel can race a fill and the snapshot would be stale.
  if (awaitTerminalRoles.length > 0) {
    return {
      action: "await_terminal",
      complete: false,
      quantityUnknown: false,
      cancelRoles,
      awaitTerminalRoles,
      stopSubmitRoles,
      unwind: [],
      totalConfirmedQuantity: totalConfirmed,
      confirmedByRole,
      detail:
        `${awaitTerminalRoles.length} leg(s) are still working; cancellation requested and the plan will ` +
        "be rebuilt from authoritative terminal quantities, since a cancel can race a fill",
    };
  }

  if (totalConfirmed === 0) {
    return {
      action: "no_exposure",
      complete: false,
      quantityUnknown: false,
      cancelRoles,
      awaitTerminalRoles,
      stopSubmitRoles,
      unwind: [],
      totalConfirmedQuantity: 0,
      confirmedByRole,
      detail: "no leg filled any quantity; there is no exposure to unwind",
    };
  }

  const unwind: PlannedUnwind[] = [];
  for (const role of args.expectedRoles) {
    const leg = byRole.get(role);
    const filled = confirmedByRole[role] ?? 0;
    if (!leg || filled <= 0) continue;
    unwind.push({ role, side: reverseSide(leg.side), quantity: filled });
  }

  return {
    action: "unwind_confirmed_exposure",
    complete: false,
    quantityUnknown: false,
    cancelRoles,
    awaitTerminalRoles,
    stopSubmitRoles,
    unwind,
    totalConfirmedQuantity: totalConfirmed,
    confirmedByRole,
    detail:
      `entry incomplete; unwinding exactly the confirmed exposure on ${unwind.length} leg(s) ` +
      `(${totalConfirmedQuantity(unwind)} total units)`,
  };
}

function totalConfirmedQuantity(unwind: readonly PlannedUnwind[]): number {
  return unwind.reduce((sum, item) => sum + item.quantity, 0);
}

/** A conservation violation. Any of these is a safety event, not a warning. */
export interface ConservationViolation {
  readonly role: BoxLegRole;
  readonly kind:
    /** We unwound more than the broker confirmed we held. Creates opposite exposure. */
    | "unwound_more_than_confirmed"
    /** Residual came out negative, which is arithmetically impossible from valid inputs. */
    | "negative_residual"
    /** The broker reported more filled than requested. Real, and must reach RECOVERY. */
    | "overfill";
  readonly confirmed: number;
  readonly unwound: number;
  readonly requested: number;
  readonly detail: string;
}

export interface ConservationResult {
  readonly conserved: boolean;
  readonly violations: readonly ConservationViolation[];
  /** Exposure still held per role after the unwind: confirmed - unwound. Never negative. */
  readonly residualByRole: Readonly<Partial<Record<BoxLegRole, number>>>;
  readonly totalResidual: number;
  /** True when any role shows a broker overfill, which must trigger RECOVERY. */
  readonly requiresRecovery: boolean;
}

/**
 * Verify exact quantity conservation across an entry and its unwind.
 *
 * THE INVARIANT: for every role,
 *
 *     residual = confirmed_entry_fill - confirmed_unwind_fill,  and  residual >= 0
 *
 * A negative residual means we sold something we never bought — a brand-new naked position
 * created by the very code meant to remove one. That is reported as a violation and must trip
 * RECOVERY rather than being clamped silently.
 *
 * An overfill (`confirmed > requested`) is NOT clamped away either. It is real broker truth
 * that proves our quantity model is wrong, so every downstream exposure number is suspect and
 * RECOVERY is the only correct response.
 */
export function verifyQuantityConservation(args: {
  readonly entry: readonly EntryLegOutcome[];
  readonly unwoundByRole: Readonly<Partial<Record<BoxLegRole, number>>>;
}): ConservationResult {
  const violations: ConservationViolation[] = [];
  const residualByRole: Partial<Record<BoxLegRole, number>> = {};
  let totalResidual = 0;
  let requiresRecovery = false;

  for (const leg of args.entry) {
    const confirmed = Number.isFinite(leg.confirmedFilled) ? leg.confirmedFilled : 0;
    const unwound = args.unwoundByRole[leg.role] ?? 0;
    const residual = confirmed - unwound;

    if (confirmed > leg.requested) {
      requiresRecovery = true;
      violations.push({
        role: leg.role,
        kind: "overfill",
        confirmed,
        unwound,
        requested: leg.requested,
        detail:
          `broker confirmed ${confirmed} filled against a requested ${leg.requested}: broker truth proves ` +
          "an overfill, so the quantity model is wrong and RECOVERY must trigger",
      });
    }

    if (unwound > confirmed) {
      requiresRecovery = true;
      violations.push({
        role: leg.role,
        kind: "unwound_more_than_confirmed",
        confirmed,
        unwound,
        requested: leg.requested,
        detail:
          `unwound ${unwound} against a confirmed ${confirmed}: this creates opposite naked exposure and ` +
          "must never happen",
      });
    }

    if (residual < 0) {
      requiresRecovery = true;
      violations.push({
        role: leg.role,
        kind: "negative_residual",
        confirmed,
        unwound,
        requested: leg.requested,
        detail: `residual ${residual} is negative; exposure accounting is inconsistent`,
      });
    }

    const safeResidual = Math.max(0, residual);
    residualByRole[leg.role] = safeResidual;
    totalResidual += safeResidual;
  }

  return {
    conserved: violations.length === 0,
    violations,
    residualByRole,
    totalResidual,
    requiresRecovery,
  };
}
