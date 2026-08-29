/**
 * The open-position monitor.
 *
 * This is BACKEND-OWNED and completely independent of the scanner's RUN state
 * and of any browser:
 *
 *   - it keeps running when the scanner is STOPPED
 *   - it keeps running when nobody is looking at /box
 *   - it keeps running when the browser is closed
 *
 * A position's lifecycle can never depend on React being mounted, so every exit
 * decision — and every refusal to exit — happens here.
 */

import type { BoxConfig } from "./config.js";
import { BoxChargeEstimator, buildChargeLegsFromEvaluations, type BoxChargeLeg } from "./charges.js";
import { computeExitMetrics, evaluateExitLegs, exitLiquidityOk, round2 } from "./math.js";
import type { BoxOpenPosition, BoxPositionBook } from "./positions.js";
import type { BoxQuoteStore } from "./quotes.js";
import {
  BOX_LEG_ROLES,
  type BoxCharges,
  type BoxExitMetrics,
  type BoxExitReason,
  type BoxLegEvaluation,
} from "./types.js";

export interface BoxMonitorDeps {
  cfg: BoxConfig;
  quotes: BoxQuoteStore;
  charges: BoxChargeEstimator;
  positions: BoxPositionBook;
  /** Persists the close. Returns true when this call is the one that closed it. */
  closePaperTrade: (args: {
    position: BoxOpenPosition;
    metrics: BoxExitMetrics;
    exitCharges: BoxCharges | null;
    reason: BoxExitReason;
  }) => Promise<boolean>;
  /** Slow periodic flush of the live convergence figure. */
  persistLive: (position: BoxOpenPosition) => Promise<void>;
  /** Ledger hook. */
  onEvent: (
    event: "EXIT_TRIGGERED" | "EXIT_SKIPPED_LIQUIDITY" | "EXPIRY_SAFETY" | "ERROR",
    position: BoxOpenPosition,
    metrics: BoxExitMetrics | null,
    detail?: string,
  ) => void;
  /** IST trading-day key, injected so the monitor has no clock of its own. */
  istDayKey: () => string;
  /** Minutes past midnight IST, for the expiry-safety window. */
  istMinutesOfDay: () => number;
}

/** Market close in IST minutes-of-day (15:30). */
const IST_CLOSE_MINUTES = 15 * 60 + 30;

export class BoxPositionMonitor {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private closingIds = new Set<string>();
  private stats = {
    cycles: 0,
    exitsTriggered: 0,
    exitsSkippedLiquidity: 0,
    lastCycleAt: null as number | null,
  };

  constructor(private deps: BoxMonitorDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.cycle();
    }, this.deps.cfg.monitorIntervalMs);
    // Unref so the monitor's timer never holds the process open by itself.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStats() {
    return { ...this.stats, running: this.timer !== null };
  }

  /** Re-price every open position and act on whatever became eligible. */
  async cycle(): Promise<void> {
    if (this.ticking) return; // never overlap cycles
    this.ticking = true;
    try {
      this.stats.cycles++;
      this.stats.lastCycleAt = Date.now();
      const positions = this.deps.positions.list();
      for (const pos of positions) {
        try {
          await this.evaluatePosition(pos);
        } catch (err) {
          console.warn("[Box] monitor failed for", pos.id, err);
          this.deps.onEvent("ERROR", pos, pos.metrics, String(err));
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Recompute the exit arithmetic for one position (no side effects). */
  measure(pos: BoxOpenPosition, now = Date.now()): BoxExitMetrics {
    const legs = evaluateExitLegs({
      legs: BOX_LEG_ROLES.map((role) => ({ role, inst: pos.legs[role] })),
      quotes: this.deps.quotes.view(),
      lotSize: pos.lot_size,
      now,
      maxAgeMs: this.deps.cfg.quoteMaxAgeMs,
    });

    // The exit charge estimate: the freshly priced one when the cache has it,
    // otherwise the conservative projection recorded at entry. Falling back to
    // the entry-time projection is deliberate — it is never cheaper than a real
    // unwind of the same size, so it cannot flatter the net P&L.
    const exitChargesTotal = this.cachedExitChargesTotal(pos, legs);

    return computeExitMetrics({
      boxWidth: pos.box_width,
      lotSize: pos.lot_size,
      entryBoxCostPerUnit: pos.entry_box_cost_per_unit,
      entryNetEdge: pos.entry_net_edge,
      entryChargesTotal: pos.entry_charges_total,
      currentExitChargesTotal: exitChargesTotal,
      legs,
      now,
      cfg: this.deps.cfg,
    });
  }

  private exitChargeLegs(
    pos: BoxOpenPosition,
    legs: BoxLegEvaluation[],
  ): BoxChargeLeg[] | null {
    return buildChargeLegsFromEvaluations(pos.legs, legs, pos.quantity);
  }

  private cachedExitChargesTotal(
    pos: BoxOpenPosition,
    legs: BoxLegEvaluation[],
  ): number | null {
    const chargeLegs = this.exitChargeLegs(pos, legs);
    if (chargeLegs) {
      const cached = this.deps.charges.peek(`exitq:${pos.id}`, chargeLegs);
      if (cached) return cached.entry_total;
    }
    return pos.estimated_exit_charges_total;
  }

  private async evaluatePosition(pos: BoxOpenPosition): Promise<void> {
    const now = Date.now();
    let metrics = this.measure(pos, now);
    pos.metrics = metrics;

    // Slow, non-hot-path persistence of the live convergence figure.
    if (now - pos.last_persist_at >= this.deps.cfg.persistIntervalMs) {
      pos.last_persist_at = now;
      void this.deps.persistLive(pos);
    }

    if (pos.closing || this.closingIds.has(pos.id)) return;

    const expirySafety = this.isInExpirySafetyWindow(pos);
    if (expirySafety && !pos.expiry_safety) {
      pos.expiry_safety = true;
      this.deps.onEvent(
        "EXPIRY_SAFETY",
        pos,
        metrics,
        "entered the expiry-safety window — attempting an executable close",
      );
    }

    // Act on what the RULES say, not on whether the market can fill it. A box
    // that should close but cannot has to be recorded (EXIT_SKIPPED_LIQUIDITY)
    // rather than silently skipped, which is why `rule_reason` is consulted here
    // instead of the combined `exit_eligible`.
    if (metrics.rule_reason === null && !expirySafety) {
      if (pos.exit_blocked_reason) pos.exit_blocked_reason = null;
      return;
    }

    // Before committing, price the exit for real at the CURRENT touch, then
    // re-measure. Charges move the net P&L, and the ≥₹600 / 75% tests must be
    // decided on priced charges rather than the entry-time projection.
    const chargeLegs = this.exitChargeLegs(pos, metrics.legs);
    if (chargeLegs) {
      const priced = await this.deps.charges.estimateExitOnly(`exitq:${pos.id}`, chargeLegs);
      if (priced) {
        metrics = computeExitMetrics({
          boxWidth: pos.box_width,
          lotSize: pos.lot_size,
          entryBoxCostPerUnit: pos.entry_box_cost_per_unit,
          entryNetEdge: pos.entry_net_edge,
          entryChargesTotal: pos.entry_charges_total,
          currentExitChargesTotal: round2(priced.total),
          legs: evaluateExitLegs({
            legs: BOX_LEG_ROLES.map((role) => ({ role, inst: pos.legs[role] })),
            quotes: this.deps.quotes.view(),
            lotSize: pos.lot_size,
            now: Date.now(),
            maxAgeMs: this.deps.cfg.quoteMaxAgeMs,
          }),
          now: Date.now(),
          cfg: this.deps.cfg,
        });
        pos.metrics = metrics;
      }
    }

    const reason: BoxExitReason | null =
      metrics.rule_reason ?? (expirySafety ? "EXPIRY_SAFETY" : null);
    if (!reason) return;

    // EXIT QUANTITY: all four reversed legs must again support one whole lot at
    // the touch. If they do not, the exit is NOT faked — the position stays open
    // and the condition is recorded.
    if (!exitLiquidityOk(metrics.legs)) {
      this.stats.exitsSkippedLiquidity++;
      const detail = describeLiquidityGap(metrics.legs, pos.lot_size);
      if (pos.exit_blocked_reason !== detail) {
        pos.exit_blocked_reason = detail;
        this.deps.onEvent("EXIT_SKIPPED_LIQUIDITY", pos, metrics, detail);
      }
      return;
    }

    // For a convergence/profit exit the net P&L must still be genuinely positive
    // after the freshly priced charges. Expiry safety is the one case where an
    // exit is attempted regardless of profitability — an abandoned box at expiry
    // is a far worse outcome — but it still refuses to invent prices.
    if (reason !== "EXPIRY_SAFETY") {
      if (metrics.current_net_pnl === null || metrics.current_net_pnl <= 0) return;
      if (!metrics.exit_eligible) return;
    }
    // Clear any earlier blockage now that the exit is actually going through.
    pos.exit_blocked_reason = null;

    await this.executeExit(pos, metrics, reason);
  }

  /** Perform the paper exit at the current executable touch. */
  private async executeExit(
    pos: BoxOpenPosition,
    metrics: BoxExitMetrics,
    reason: BoxExitReason,
  ): Promise<void> {
    if (this.closingIds.has(pos.id)) return;
    this.closingIds.add(pos.id);
    pos.closing = true;
    try {
      this.stats.exitsTriggered++;
      this.deps.onEvent("EXIT_TRIGGERED", pos, metrics, reason);

      const chargeLegs = this.exitChargeLegs(pos, metrics.legs);
      let exitCharges: BoxCharges | null = null;
      if (chargeLegs) {
        exitCharges = await this.deps.charges.estimateExitOnly(`exitfill:${pos.id}`, chargeLegs);
      }

      const closed = await this.deps.closePaperTrade({
        position: pos,
        metrics,
        exitCharges,
        reason,
      });
      if (!closed) {
        // Someone else closed it first (manual close). Leave the book to them.
        pos.closing = false;
      }
    } catch (err) {
      pos.closing = false;
      console.warn("[Box] exit failed for", pos.id, err);
      this.deps.onEvent("ERROR", pos, metrics, `exit failed: ${String(err)}`);
    } finally {
      this.closingIds.delete(pos.id);
    }
  }

  /**
   * Manual close, driven by the UI.
   *
   * Uses the same executable touch prices as an automatic close. When the
   * four-leg one-lot market is unavailable it REFUSES rather than inventing
   * prices, and says why.
   */
  async closeManually(
    id: string,
  ): Promise<
    | { ok: true }
    | { ok: false; error: string; metrics: BoxExitMetrics | null; code: number }
  > {
    const pos = this.deps.positions.get(id);
    if (!pos) {
      return { ok: false, error: "That box position is not open.", metrics: null, code: 404 };
    }
    if (pos.closing || this.closingIds.has(id)) {
      return {
        ok: false,
        error: "That box position is already being closed.",
        metrics: pos.metrics,
        code: 409,
      };
    }

    const metrics = this.measure(pos);
    pos.metrics = metrics;

    if (!exitLiquidityOk(metrics.legs)) {
      const detail = describeLiquidityGap(metrics.legs, pos.lot_size);
      pos.exit_blocked_reason = detail;
      this.deps.onEvent("EXIT_SKIPPED_LIQUIDITY", pos, metrics, `manual close refused: ${detail}`);
      return {
        ok: false,
        error: `Cannot close at an executable price right now: ${detail}. The position is still open and being monitored.`,
        metrics,
        code: 409,
      };
    }

    await this.executeExit(pos, metrics, "MANUAL");
    return { ok: true };
  }

  /**
   * True once a position is inside the expiry-safety window: its expiry is today
   * and the close is near. Positions must not be left to be abandoned at expiry.
   */
  private isInExpirySafetyWindow(pos: BoxOpenPosition): boolean {
    if (pos.expiry !== this.deps.istDayKey()) return false;
    const minutes = this.deps.istMinutesOfDay();
    return minutes >= IST_CLOSE_MINUTES - this.deps.cfg.expirySafetyMinutesBeforeClose;
  }
}

/** A human-readable description of which legs cannot fill one lot. */
export function describeLiquidityGap(legs: BoxLegEvaluation[], lotSize: number): string {
  const problems: string[] = [];
  for (const l of legs) {
    if (l.quote_at === null) {
      problems.push(`${l.tradingsymbol} has no live book`);
    } else if (!l.fresh) {
      problems.push(`${l.tradingsymbol} book is stale (${l.age_ms ?? "?"}ms)`);
    } else if (l.price === null || !(l.price > 0)) {
      problems.push(
        `${l.tradingsymbol} has no ${l.side === "BUY" ? "ask" : "bid"}`,
      );
    } else if (l.qty_at_touch < lotSize) {
      problems.push(
        `${l.tradingsymbol} shows ${l.qty_at_touch} at ${l.price} (needs ${lotSize})`,
      );
    }
  }
  return problems.length > 0 ? problems.join("; ") : "insufficient touch liquidity";
}
