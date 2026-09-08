/**
 * HEDGE-FIRST ENTRY TRANSPORT ORDER — the single, pure definition.
 *
 * THE DEFECT THIS CLOSES. The canonical role array {@link BOX_LEG_ROLES} is
 * `[k1_ce, k2_ce, k2_pe, k1_pe]`, and the live entry path used to build (and therefore POST)
 * its four requests in exactly that order. For a SHORT_BOX the entry sides are
 * `k1_ce SELL, k2_ce BUY, k2_pe SELL, k1_pe BUY`, so the FIRST order to reach the broker was
 * a naked SELL, and the BUY that hedges it went second. Between those two POSTs — a broker
 * round trip apart, and further apart under pacing — the account held uncovered short option
 * exposure. If the second POST then failed, that uncovered leg was the position.
 *
 * THE RULE. Every BUY leg becomes eligible for transport before any SELL leg. A BUY can only
 * ever lose the premium paid; an uncovered SELL is the leg with unbounded risk, so it must
 * never be the one left outstanding while its hedge is still in flight.
 *
 * WHAT THIS DELIBERATELY DOES NOT CHANGE:
 *
 *   - the four ROLE IDENTITIES, their instruments, sides or quantities;
 *   - the resulting four-leg economics, which are a property of the set and not of the order
 *     in which the set was transmitted;
 *   - any accounting, which is keyed BY ROLE everywhere downstream and never by array index.
 *
 * It is therefore a pure TRANSPORT-ORDER decision: the same four orders, sequenced so that the
 * riskier half is never exposed first.
 *
 * PURE and total: no clock, no config, no I/O. Both directions are enumerated by test.
 */

import {
  BOX_ENTRY_SIDES_BY_DIRECTION,
  BOX_LEG_ROLES,
  type BoxDirection,
  type BoxLegRole,
  type OrderSide,
} from "./types.js";

/** One leg's place in the hedge-first transport sequence. */
export interface EntrySubmissionSlot {
  readonly role: BoxLegRole;
  /** The ENTRY side for this role under the attempt's direction. */
  readonly side: OrderSide;
  /**
   * 0-based transport rank. Rank `n` may not POST until every rank `< n` of the same attempt
   * has reached a decided outcome (posted, or terminalized without a POST).
   */
  readonly rank: number;
  /**
   * True for a BUY leg. Uncovered SELL legs of the same attempt depend on these, so a definitive
   * hedge failure must stop the dependent SELL before it POSTs.
   */
  readonly hedge: boolean;
}

/**
 * The four legs in hedge-first transport order: BUYs first, then SELLs.
 *
 * STABLE within each group — the canonical {@link BOX_LEG_ROLES} order is preserved among the
 * BUYs and among the SELLs — so the sequence is fully deterministic and diffable, not merely
 * "some order that happens to put buys first".
 *
 *   LONG_BOX   →  k1_ce BUY,  k2_pe BUY,  k2_ce SELL, k1_pe SELL
 *   SHORT_BOX  →  k2_ce BUY,  k1_pe BUY,  k1_ce SELL, k2_pe SELL
 */
export function entrySubmissionOrder(direction: BoxDirection): readonly EntrySubmissionSlot[] {
  const sides = BOX_ENTRY_SIDES_BY_DIRECTION[direction];
  const buys: BoxLegRole[] = [];
  const sells: BoxLegRole[] = [];
  for (const role of BOX_LEG_ROLES) {
    if (sides[role] === "BUY") buys.push(role);
    else sells.push(role);
  }
  return [...buys, ...sells].map((role, index) => ({
    role,
    side: sides[role],
    rank: index,
    hedge: sides[role] === "BUY",
  }));
}

/** Just the roles, in hedge-first transport order. */
export function entrySubmissionRoles(direction: BoxDirection): readonly BoxLegRole[] {
  return entrySubmissionOrder(direction).map((slot) => slot.role);
}

/**
 * The transport rank of one role, or -1 if the role is not part of a box (unreachable for the
 * four real roles; kept total so a caller can never index `undefined`).
 */
export function entryTransportRank(direction: BoxDirection, role: BoxLegRole): number {
  return entrySubmissionOrder(direction).find((slot) => slot.role === role)?.rank ?? -1;
}

/**
 * True when the hedge-first invariant holds for a transmitted sequence of sides.
 *
 * Used by the tests as an independent oracle: it restates the property ("no BUY appears after
 * a SELL") without reusing the ordering function under test, so a bug in the ordering cannot
 * also mark itself correct.
 */
export function isHedgeFirstSequence(sides: readonly OrderSide[]): boolean {
  let seenSell = false;
  for (const side of sides) {
    if (side === "SELL") seenSell = true;
    else if (seenSell) return false;
  }
  return true;
}
