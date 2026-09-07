/**
 * RUNNING P&L FOR A PARTIALLY EXITED BOX.
 *
 * THE DEFECT
 * `pos.quantity` and `pos.lot_size` are never decremented by a partial exit — only
 * `remaining_qty_by_role` is. So `measure()` re-marked ALL FOUR roles at the current touch and
 * priced a fresh FULL-LOT FOUR-LEG exit estimate, while the exit charges already paid on the
 * closed legs (`cumulative_exit_charges`) were not passed in at all. Consequences:
 *
 *   - every ₹1/unit move in an ALREADY-FLAT leg moved the reported figure by a full lot;
 *   - the exit-charge estimate double-counted: it re-estimated closing legs that were already
 *     closed AND paid for.
 *
 * That flowed into `open_running_net_pnl`, the status endpoint, the UI and the archived day total
 * for as long as the position stayed partial.
 *
 * THE MODEL
 * Realised and unrealised are separated, which is the only coherent way to mark a position that
 * is partly closed:
 *
 *   running gross  = Σ realised gross on quantity already closed        (FROZEN per attempt)
 *                  + Σ mark-to-market gross on quantity still open      (marked now)
 *
 *   running charges = entry charges already incurred
 *                   + exit charges already incurred (cumulative, exact)
 *                   + estimated exit charges for the REMAINING quantity only
 *
 * The realised component is frozen when an exit fill becomes durable: it is the sum of
 * `exit_attempts[].gross_pnl`, each computed at the price that leg actually closed at. Nothing a
 * closed leg's quote does afterwards can move it, because it is no longer marked.
 *
 * WHAT IS DELIBERATELY NOT CHANGED
 * The EDGE family (`entry_edge`, `remaining_edge`, `captured_edge`, `captured_pct`,
 * `convergence_threshold`, `profit_capture_target`) and the exit DECISION remain whole-box,
 * full-lot reference figures. They describe a box, and a partially exited position is no longer
 * one — which is exactly why `evaluatePosition` short-circuits a `PARTIALLY_EXITED` position
 * straight to flattening and never consults `metrics.decision`. Rescaling a convergence threshold
 * to a half-closed box would be inventing a rule that does not exist.
 *
 * Pure: no clock, no I/O, no config.
 */

import { entrySideFor, round2 } from "./math.js";
import { BOX_LEG_ROLES, type BoxDirection, type BoxLegEvaluation, type BoxLegRole } from "./types.js";
import type { BoxOpenPosition } from "./positions.js";

/** Per-role quantity still open, tolerating documents written before the field existed. */
export function remainingByRoleOf(pos: BoxOpenPosition): Record<BoxLegRole, number> {
  const out = {} as Record<BoxLegRole, number>;
  for (const role of BOX_LEG_ROLES) {
    const raw = pos.remaining_qty_by_role?.[role];
    // A legacy/adopted document with no per-role map is a WHOLE box: every role is fully open.
    out[role] = typeof raw === "number" && Number.isFinite(raw)
      ? Math.max(0, raw)
      : Math.max(0, pos.quantity);
  }
  return out;
}

/**
 * Is any quantity already closed?
 *
 * Deliberately conservative: only a position that has genuinely closed something takes the
 * partial-aware path, so a whole box keeps the pre-existing arithmetic byte-for-byte (including
 * its rounding) and every pinned full-box figure is untouched.
 */
export function isPartialBox(pos: BoxOpenPosition): boolean {
  const remaining = remainingByRoleOf(pos);
  return BOX_LEG_ROLES.some((role) => remaining[role] < pos.quantity);
}

/** Realised gross across every exit attempt so far (₹). Frozen at each attempt's fill prices. */
export function realisedExitGross(pos: BoxOpenPosition): number {
  return round2(pos.exit_attempts.reduce((sum, attempt) => sum + (attempt.gross_pnl ?? 0), 0));
}

/** The closing-side orders needed to exit ONLY what is still open, for charge estimation. */
export function remainingExitChargeOrders(
  pos: BoxOpenPosition,
  legs: readonly BoxLegEvaluation[],
): { side: "BUY" | "SELL"; tradingsymbol: string; quantity: number; price: number }[] | null {
  const remaining = remainingByRoleOf(pos);
  const out: { side: "BUY" | "SELL"; tradingsymbol: string; quantity: number; price: number }[] = [];
  for (const leg of legs) {
    const quantity = remaining[leg.role] ?? 0;
    if (quantity <= 0) continue;             // already flat: nothing left to pay for
    if (leg.price === null || !(leg.price > 0)) return null;   // cannot price what is left
    out.push({ side: leg.side, tradingsymbol: leg.tradingsymbol, quantity, price: round2(leg.price) });
  }
  return out;
}

/** The realised / unrealised split and the charge stack for a partially exited box. */
export interface PartialExitMark {
  /** Gross already booked on closed quantity. Frozen; a closed leg's quote cannot move it. */
  realised_gross: number;
  /** Mark-to-market gross on quantity still open. Null when a remaining leg cannot be priced. */
  unrealised_gross: number | null;
  /** realised + unrealised. */
  gross: number | null;
  /** Exit charges genuinely already paid (exact, from cumulative_exit_charges). */
  exit_charges_incurred: number;
  /** Estimated exit charges for the REMAINING quantity only. */
  estimated_remaining_exit_charges: number | null;
  /** incurred + remaining estimate. */
  exit_charges_total: number | null;
  /** entry + exit_charges_total. */
  round_trip_charges: number | null;
  net: number | null;
  realisable_net: number | null;
  /** Quantity still marked, per role — the audit trail for the figure above. */
  marked_quantity_by_role: Record<BoxLegRole, number>;
}

/**
 * Mark a partially exited box.
 *
 * `unrealisedGross` uses the same per-leg identity the realised path uses when an exit fill is
 * booked (`positionMonitor.applyLeggingExitResult`), so realised and unrealised are the same
 * arithmetic applied to different quantities — which is what makes them add up, and what makes
 * the final close equal the sum of the attempts.
 */
export function markPartialExit(args: {
  direction: BoxDirection;
  remainingByRole: Record<BoxLegRole, number>;
  entryPrices: Record<BoxLegRole, number>;
  /** Current exit-side marks, as produced by `evaluateExitLegs`. */
  legs: readonly BoxLegEvaluation[];
  realisedGross: number;
  exitChargesIncurred: number;
  entryChargesTotal: number | null;
  estimatedRemainingExitCharges: number | null;
  /** Expected exit-slippage allowance (₹) applied to produce the realisable figure. */
  executionCost: number;
}): PartialExitMark {
  let unrealised = 0;
  let markable = true;

  for (const leg of args.legs) {
    const quantity = args.remainingByRole[leg.role] ?? 0;
    // A FLAT ROLE IS NOT MARKED. This single line is the defect: previously every role was
    // re-valued at the current touch, so a leg that had been closed hours ago still moved the
    // reported P&L by a full lot on every tick.
    if (quantity <= 0) continue;
    if (leg.price === null || !(leg.price > 0)) {
      markable = false;
      continue;
    }
    const entrySide = entrySideFor(leg.role, args.direction);
    const entryPrice = args.entryPrices[leg.role] ?? 0;
    const perUnit = entrySide === "BUY" ? leg.price - entryPrice : entryPrice - leg.price;
    unrealised += perUnit * quantity;
  }

  const unrealisedGross = markable ? round2(unrealised) : null;
  const gross = unrealisedGross === null ? null : round2(args.realisedGross + unrealisedGross);
  const exitChargesTotal = args.estimatedRemainingExitCharges === null
    ? null
    : round2(args.exitChargesIncurred + args.estimatedRemainingExitCharges);
  const roundTrip = args.entryChargesTotal === null || exitChargesTotal === null
    ? null
    : round2(args.entryChargesTotal + exitChargesTotal);
  const net = gross === null || roundTrip === null ? null : round2(gross - roundTrip);
  const realisable = net === null ? null : round2(net - round2(args.executionCost));

  return {
    realised_gross: round2(args.realisedGross),
    unrealised_gross: unrealisedGross,
    gross,
    exit_charges_incurred: round2(args.exitChargesIncurred),
    estimated_remaining_exit_charges: args.estimatedRemainingExitCharges,
    exit_charges_total: exitChargesTotal,
    round_trip_charges: roundTrip,
    net,
    realisable_net: realisable,
    marked_quantity_by_role: { ...args.remainingByRole },
  };
}

/**
 * Total quantity still open across all four roles, and the original total.
 *
 * Used only for the charge fallback below, where a proportional share of the stored full-lot
 * estimate is the honest answer of last resort.
 */
export function openQuantityFraction(pos: BoxOpenPosition): number {
  const total = pos.quantity * BOX_LEG_ROLES.length;
  if (!(total > 0)) return 0;
  const remaining = remainingByRoleOf(pos);
  const open = BOX_LEG_ROLES.reduce((sum, role) => sum + (remaining[role] ?? 0), 0);
  return Math.min(1, Math.max(0, open / total));
}
