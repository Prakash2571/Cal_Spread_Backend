import {
  BOX_LEG_ROLES,
  type BoxCandidate,
  type BoxLegRole,
  type BoxOptionInstrument,
} from "./types.js";

/**
 * Box V1 deliberately supports exactly one exchange lot per entry.
 *
 * Partial exits are different: each remaining role may hold any whole-contract
 * quantity from zero through the original lot. Recovery may temporarily carry a
 * broker-confirmed overfill above that range, but it must never be classified as
 * an ordinary BOX position.
 */
export function singleLotCandidateViolation(
  candidate: Pick<BoxCandidate, "lot_size" | "legs">,
): string | null {
  return singleLotLegViolation(candidate.lot_size, candidate.legs);
}

/** Validate a proposed candidate before it can be emitted or submitted. */
export function singleLotLegViolation(
  lotSize: number,
  legs: Record<BoxLegRole, BoxOptionInstrument>,
): string | null {
  if (!isPositiveSafeInteger(lotSize)) {
    return "candidate lot size must be a positive safe integer";
  }
  for (const role of BOX_LEG_ROLES) {
    const legLot = legs[role]?.lot_size;
    if (!isPositiveSafeInteger(legLot)) {
      return `${role} instrument lot size must be a positive safe integer`;
    }
    if (legLot !== lotSize) {
      return `${role} instrument lot size ${legLot} does not match candidate lot size ${lotSize}`;
    }
  }
  return null;
}

/**
 * Validate the durable geometry of a normal one-lot position.
 *
 * Remainders need not be lot multiples: 35 contracts left from an original
 * 75-contract lot is valid. A value above the original lot is retained as broker
 * truth but returns a violation so callers quarantine it in RECOVERY.
 */
export function singleLotPositionViolation(position: {
  lot_size: number;
  quantity: number;
  remaining_qty_by_role: Partial<Record<BoxLegRole, unknown>>;
  legs?: Partial<Record<BoxLegRole, Pick<BoxOptionInstrument, "lot_size">>>;
}): string | null {
  if (!isPositiveSafeInteger(position.lot_size)) {
    return "position lot size must be a positive safe integer";
  }
  if (!Number.isSafeInteger(position.quantity) || position.quantity !== position.lot_size) {
    return `position quantity ${String(position.quantity)} must equal exactly one lot (${position.lot_size})`;
  }
  if (position.legs) {
    for (const role of BOX_LEG_ROLES) {
      const legLot = position.legs[role]?.lot_size;
      if (!isPositiveSafeInteger(legLot) || legLot !== position.lot_size) {
        return `${role} instrument lot size ${String(legLot)} does not match position lot size ${position.lot_size}`;
      }
    }
  }
  for (const role of BOX_LEG_ROLES) {
    const remaining = position.remaining_qty_by_role[role];
    if (!Number.isSafeInteger(remaining) || (remaining as number) < 0) {
      return `${role} remaining quantity must be a non-negative safe integer`;
    }
    if ((remaining as number) > position.lot_size) {
      return `${role} remaining quantity ${remaining} exceeds the one-lot maximum ${position.lot_size}`;
    }
  }
  return null;
}

/** A successful ordinary entry must acquire exactly one lot on every role. */
export function exactEntryFillViolation(
  lotSize: number,
  fills: Partial<Record<BoxLegRole, unknown>>,
): string | null {
  if (!isPositiveSafeInteger(lotSize)) return "entry lot size must be a positive safe integer";
  for (const role of BOX_LEG_ROLES) {
    const filled = fills[role];
    if (!Number.isSafeInteger(filled) || filled !== lotSize) {
      return `${role} entry fill ${String(filled)} must equal exactly one lot (${lotSize})`;
    }
  }
  return null;
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
