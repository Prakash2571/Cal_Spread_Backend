/**
 * The canonical execution identity of ONE option contract.
 *
 * WHY THIS EXISTS
 * Every duplicate guard in the Box engine is keyed on the whole strike pair —
 * `underlying|expiry|K1|K2|DIRECTION` (see `candidateKey` in math.ts). That is the
 * right key for "has this exact strategy already been taken", and the wrong key for
 * "is another execution already working this contract". A 1300/1320 box and a
 * 1320/1340 box have different candidate keys and share the 1320 strike: under the
 * pair key they look completely unrelated, so both can be submitted in the same
 * instant, and each one assumes the full displayed size resting at 1320.
 *
 * This module supplies the missing granularity: a stable string naming one
 * contract, so a reservation can exclude exactly the contracts a Box needs and
 * nothing more.
 *
 * BROKER NAMESPACING IS MANDATORY, NOT DECORATIVE
 * A Zerodha instrument token and a Dhan security id are different namespaces that
 * happily collide as integers — the same number means two unrelated contracts. The
 * broker is therefore the first component of every key, so a stale Zerodha
 * reservation can never be mistaken for a Dhan one across a broker switch. This is
 * the same reason `SubscriptionCoordinator.resetForBrokerSwitch()` drops its whole
 * table rather than translating tokens.
 *
 * WHY exchange + tradingsymbol RATHER THAN THE RAW TOKEN
 * Both are reliable, but the numeric token is meaningless in a log line and the
 * tradingsymbol is self-describing (`NFO:RELIANCE24SEP2550CE`). Since these keys
 * appear in operator-facing conflict logs and diagnostics, readability wins. The
 * token is still carried on the descriptor for correlation with the quote store.
 */

import type { BoxLegRole, BoxOptionInstrument, OrderSide } from "./types.js";

/** The broker namespace of a key. Kept local so this module has no import cycle. */
export type InstrumentKeyBroker = "zerodha" | "dhan";

/**
 * One contract an execution intends to work, with the side it intends to work it on.
 *
 * The side is carried because the coordinator must be able to DESCRIBE a conflict
 * as same-direction or opposite-direction, even though (by deliberate default) both
 * are treated identically: serialise and re-evaluate. Recording the distinction
 * without acting on it is what makes it possible to add netting later behind a flag
 * and prove it correct against real observed conflicts first.
 */
export interface InstrumentLegRef {
  readonly key: string;
  readonly role: BoxLegRole;
  readonly side: OrderSide;
  readonly token: number;
  readonly tradingsymbol: string;
  readonly exchange: string;
}

function normaliseBroker(broker: string): string {
  return broker.trim().toUpperCase();
}

/**
 * The canonical key for one contract under one broker.
 *
 * Deliberately total: an instrument with no tradingsymbol still yields a usable,
 * collision-free key from its token rather than throwing or returning null. A
 * reservation layer that can be defeated by a missing display field would be worse
 * than one that occasionally logs an ugly key.
 */
export function instrumentKey(
  broker: InstrumentKeyBroker | string,
  inst: Pick<BoxOptionInstrument, "token" | "tradingsymbol" | "exchange">,
): string {
  const ns = normaliseBroker(broker);
  const symbol = inst.tradingsymbol?.trim();
  if (symbol) return `${ns}:${(inst.exchange || "NFO").trim().toUpperCase()}:${symbol}`;
  // No symbol: fall back to the numeric identity, still namespaced by broker so it
  // cannot collide with the other broker's identical integer.
  return `${ns}:TOKEN:${inst.token}`;
}

/**
 * The four contracts of one Box, in a DETERMINISTIC order.
 *
 * Sorted, and the sort is not cosmetic. Two properties depend on it:
 *
 *   1. A conflict log for the same overlapping pair reads identically every time,
 *      so operators can diff incidents.
 *   2. Any future store that must take locks one at a time (a Redis/Mongo tier
 *      without a genuine multi-key atomic primitive) has a total order to take them
 *      in, which is what makes the classic A-waits-B / B-waits-A deadlock
 *      impossible. The in-process store does not need this — it commits all-or-none
 *      inside a single synchronous pass — but the ordering is established HERE so a
 *      later tier cannot forget it.
 */
export function boxInstrumentRefs(
  broker: InstrumentKeyBroker | string,
  legs: Record<BoxLegRole, BoxOptionInstrument>,
  sideFor: (role: BoxLegRole) => OrderSide,
  roles: readonly BoxLegRole[],
): InstrumentLegRef[] {
  const refs = roles.map((role) => {
    const inst = legs[role];
    return {
      key: instrumentKey(broker, inst),
      role,
      side: sideFor(role),
      token: inst.token,
      tradingsymbol: inst.tradingsymbol,
      exchange: inst.exchange,
    };
  });
  refs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return refs;
}

/** Distinct keys from a ref list, order preserved. */
export function keysOf(refs: readonly InstrumentLegRef[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of refs) {
    if (seen.has(ref.key)) continue;
    seen.add(ref.key);
    out.push(ref.key);
  }
  return out;
}

/**
 * How two executions overlap on one contract.
 *
 * `same_side` and `opposite_side` are reported separately because they are
 * genuinely different risks — opposite sides could in principle net internally,
 * same sides cannot — even though both currently take the identical safe path.
 */
export type InstrumentConflictKind = "same_side" | "opposite_side";

export interface InstrumentConflict {
  readonly key: string;
  readonly kind: InstrumentConflictKind;
  readonly heldBy: string;
}

/** Classify an overlap, given what the incumbent holder intended on that contract. */
export function classifyConflict(
  key: string,
  heldBy: string,
  incumbentSide: OrderSide | null,
  challengerSide: OrderSide,
): InstrumentConflict {
  // An unknown incumbent side is treated as same-side: the more restrictive of the
  // two classifications, since same-side can never be netted.
  const kind: InstrumentConflictKind =
    incumbentSide !== null && incumbentSide !== challengerSide ? "opposite_side" : "same_side";
  return { key, kind, heldBy };
}
