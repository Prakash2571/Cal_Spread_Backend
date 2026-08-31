/**
 * The open-position monitor.
 *
 * BACKEND-OWNED and completely independent of the scanner's RUN state and of any
 * browser:
 *
 *   - it keeps running when the scanner is STOPPED
 *   - it keeps running when nobody is looking at /box
 *   - it keeps running when the browser is closed
 *
 * A position's lifecycle can never depend on React being mounted, so every exit
 * decision — and every refusal to exit — happens here.
 *
 * TWO THINGS CHANGED FROM THE ORIGINAL
 *
 *   1. Exit charges are now priced by the LOCAL calculator, synchronously, on the
 *      decision-critical path. There is no Zerodha round trip between measuring a
 *      position and deciding to close it; verification happens asynchronously
 *      elsewhere (chargeReconciler.ts).
 *   2. The fill itself goes through the execution simulator. In paper_latency mode
 *      the recorded exit prices come from the first WebSocket book published at or
 *      after a simulated arrival — never a stale pre-decision snapshot. In
 *      paper_touch mode it fills at the current touch, as before.
 */

import type { BoxConfig } from "./config.js";
import type { BoxExecutionSimulator } from "./executionSimulator.js";
import { LocalChargeCalculator, ordersFromLegs } from "./localCharges.js";
import {
  computeExitMetrics,
  evaluateExitLegs,
  exitLiquidityOk,
  round2,
} from "./math.js";
import type { BoxOpenPosition, BoxPositionBook } from "./positions.js";
import type { BoxQuoteStore } from "./quotes.js";
import {
  BOX_LEG_ROLES,
  type BoxChargesWithOrigin,
  type BoxExecutionRecord,
  type BoxExitMetrics,
  type BoxExitReason,
  type BoxLegEvaluation,
} from "./types.js";

export interface BoxMonitorDeps {
  cfg: BoxConfig;
  quotes: BoxQuoteStore;
  localCharges: LocalChargeCalculator;
  executionSim: BoxExecutionSimulator;
  positions: BoxPositionBook;
  /** Persists the close. Returns true when this call is the one that closed it. */
  closePaperTrade: (args: {
    position: BoxOpenPosition;
    metrics: BoxExitMetrics;
    exitCharges: BoxChargesWithOrigin | null;
    reason: BoxExitReason;
    execution: BoxExecutionRecord | null;
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
  isMarketOpen: () => boolean;
  isFeedHealthy: () => boolean;
}

/** Market close in IST minutes-of-day (15:30). */
const IST_CLOSE_MINUTES = 15 * 60 + 30;

export class BoxPositionMonitor {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private evaluationTasks = new Map<string, Promise<void>>();
  private pendingEvaluationIds = new Set<string>();
  private closingIds = new Set<string>();
  private lastBlockedKey = new Map<string, string>();
  private stats = {
    cycles: 0,
    exitsTriggered: 0,
    exitsSkippedLiquidity: 0,
    exitsFailedExecution: 0,
    lastCycleAt: null as number | null,
  };

  constructor(private deps: BoxMonitorDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.cycle();
    }, this.deps.cfg.monitorIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStats() {
    return { ...this.stats, running: this.timer !== null };
  }

  /**
   * Primary low-latency path: a WS depth update immediately re-evaluates only
   * open positions that contain one of the changed contracts.
   */
  onTokensUpdated(tokens: number[]): void {
    if (tokens.length === 0) return;
    const changed = new Set(tokens);
    for (const pos of this.deps.positions.list()) {
      const affected = BOX_LEG_ROLES.some((role) => changed.has(pos.legs[role].token));
      if (affected) void this.requestEvaluation(pos.id);
    }
  }

  private requestEvaluation(id: string): Promise<void> {
    this.pendingEvaluationIds.add(id);
    const existing = this.evaluationTasks.get(id);
    if (existing) return existing;

    const task = (async () => {
      try {
        while (this.pendingEvaluationIds.delete(id)) {
          const pos = this.deps.positions.get(id);
          if (!pos) break;
          try {
            await this.evaluatePosition(pos);
          } catch (err) {
            console.warn("[Box] monitor failed for", pos.id, err);
            this.deps.onEvent("ERROR", pos, pos.metrics, String(err));
          }
        }
      } finally {
        this.evaluationTasks.delete(id);
        if (this.pendingEvaluationIds.has(id) && this.deps.positions.get(id)) {
          void this.requestEvaluation(id);
        }
      }
    })();
    this.evaluationTasks.set(id, task);
    return task;
  }

  async cycle(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.stats.cycles++;
      this.stats.lastCycleAt = Date.now();
      await Promise.all(this.deps.positions.list().map((pos) => this.requestEvaluation(pos.id)));
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Total exit charges for a set of evaluated exit legs, from the LOCAL
   * calculator. Synchronous — this is the whole point.
   */
  private localExitChargesTotal(pos: BoxOpenPosition, legs: BoxLegEvaluation[]): number | null {
    const orders = ordersFromLegs(legs, pos.quantity);
    if (!orders) return pos.estimated_exit_charges_total;
    return this.deps.localCharges.legs(orders, "kite_estimate").total;
  }

  private localExitCharges(pos: BoxOpenPosition, legs: BoxLegEvaluation[]): BoxChargesWithOrigin | null {
    const orders = ordersFromLegs(legs, pos.quantity);
    if (!orders) return null;
    return this.deps.localCharges.legs(orders, "kite_estimate");
  }

  /** Recompute the exit arithmetic for one position (no side effects, no I/O). */
  measure(
    pos: BoxOpenPosition,
    now = Date.now(),
    exitChargesTotalOverride?: number | null,
    captureDepth = false,
  ): BoxExitMetrics {
    const direction = pos.direction ?? "LONG_BOX";
    const legs = evaluateExitLegs({
      legs: BOX_LEG_ROLES.map((role) => ({ role, inst: pos.legs[role] })),
      quotes: this.deps.quotes.view(),
      lotSize: pos.lot_size,
      now,
      maxAgeMs: this.deps.cfg.quoteMaxAgeMs,
      direction,
      captureDepth,
    });

    const exitChargesTotal =
      exitChargesTotalOverride !== undefined
        ? exitChargesTotalOverride
        : this.localExitChargesTotal(pos, legs);

    return computeExitMetrics({
      boxWidth: pos.box_width,
      lotSize: pos.lot_size,
      entryBoxCostPerUnit: pos.entry_box_cost_per_unit,
      entryNetEdge: pos.entry_net_edge,
      entryChargesTotal: pos.entry_charges_total,
      currentExitChargesTotal: exitChargesTotal,
      legs,
      now,
      direction,
      entryEdge: pos.entry_gross_edge,
      executionCost: this.deps.cfg.expectedExitSlippage,
      openedAt: pos.opened_at,
      expirySafety: this.isInExpirySafetyWindow(pos),
      cfg: this.deps.cfg,
    });
  }

  private async evaluatePosition(pos: BoxOpenPosition): Promise<void> {
    const now = Date.now();
    let metrics = this.measure(pos, now);
    pos.metrics = metrics;
    pos.current_captured_edge = metrics.captured_edge;
    pos.current_captured_pct = metrics.captured_pct;

    if (now - pos.last_persist_at >= this.deps.cfg.persistIntervalMs) {
      pos.last_persist_at = now;
      void this.deps.persistLive(pos);
    }

    if (pos.closing || this.closingIds.has(pos.id)) return;

    // Outside market hours / dead feed: refresh metrics, attempt nothing. Neither
    // is a liquidity event.
    if (!this.deps.isMarketOpen()) return;
    if (!this.deps.isFeedHealthy()) return;

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

    const decision = metrics.decision;
    // Nothing to do: no rule fired and we are not in the expiry window.
    if (decision.rule_reason === null && !expirySafety) {
      if (pos.exit_blocked_reason) pos.exit_blocked_reason = null;
      this.lastBlockedKey.delete(pos.id);
      return;
    }

    const reason: BoxExitReason | null =
      decision.rule_reason ?? (expirySafety ? "EXPIRY_SAFETY" : null);
    if (!reason) return;

    // The rules want to close. Does the CURRENT touch support one whole lot?
    if (!exitLiquidityOk(metrics.legs)) {
      this.recordLiquiditySkip(pos, metrics);
      return;
    }

    // For a convergence/profit exit the net P&L must still be genuinely positive.
    // Expiry safety overrides profitability but still refuses invented prices.
    if (reason !== "EXPIRY_SAFETY") {
      if (metrics.current_net_pnl === null || metrics.current_net_pnl <= 0) return;
      if (decision.rule_reason === null) return;
    }

    await this.runExit(pos, metrics, reason, expirySafety);
  }

  /**
   * Simulate the exit fill, then persist it.
   *
   * paper_latency: the simulator waits the decision + latency delay and fills from
   * the first post-arrival WS book, re-validating that the exit still makes sense
   * on those prices. paper_touch: it fills at the current touch immediately.
   */
  private async runExit(
    pos: BoxOpenPosition,
    detectionMetrics: BoxExitMetrics,
    reason: BoxExitReason,
    expirySafety: boolean,
  ): Promise<void> {
    if (this.closingIds.has(pos.id)) return;
    this.closingIds.add(pos.id);
    pos.closing = true;
    let handed = false;

    try {
      const result = await this.deps.executionSim.simulateExit({
        position: pos,
        detectionLegs: detectionMetrics.legs,
        detectedAt: detectionMetrics.at,
        stillWanted: () =>
          this.deps.positions.get(pos.id) !== undefined &&
          this.deps.isMarketOpen() &&
          this.deps.isFeedHealthy(),
        validate: (legs) => {
          // Re-derive the decision on the EXECUTED prices with local charges.
          const exitTotal = this.localExitChargesTotal(pos, legs);
          const m = computeExitMetrics({
            boxWidth: pos.box_width,
            lotSize: pos.lot_size,
            entryBoxCostPerUnit: pos.entry_box_cost_per_unit,
            entryNetEdge: pos.entry_net_edge,
            entryChargesTotal: pos.entry_charges_total,
            currentExitChargesTotal: exitTotal,
            legs,
            now: Date.now(),
            direction: pos.direction ?? "LONG_BOX",
            entryEdge: pos.entry_gross_edge,
            executionCost: this.deps.cfg.expectedExitSlippage,
            openedAt: pos.opened_at,
            expirySafety,
            cfg: this.deps.cfg,
          });
          if (!exitLiquidityOk(legs)) {
            return { ok: false as const, reason: "insufficient_quantity" as const, detail: "exit touch cannot fill one lot" };
          }
          if (!expirySafety) {
            const stillWants = m.decision.rule_reason !== null;
            const profitable = m.current_net_pnl !== null && m.current_net_pnl > 0;
            if (!stillWants || !profitable) {
              return { ok: false as const, reason: "edge_disappeared" as const, detail: "the exit no longer nets a profit at the executed touch" };
            }
          }
          return { ok: true as const };
        },
      });

      if (!result.ok) {
        // The fill could not happen at post-latency prices. In paper_touch this is
        // effectively immediate; in paper_latency the book moved away. Either way
        // the position stays open and the reason is recorded (deduped).
        this.stats.exitsFailedExecution++;
        const fresh = this.measure(pos, Date.now());
        pos.metrics = fresh;
        if (!exitLiquidityOk(fresh.legs)) this.recordLiquiditySkip(pos, fresh);
        pos.closing = false;
        return;
      }

      // The executed legs are the fill. Price them locally and build the final
      // metrics the trade is closed on.
      const exitCharges = this.localExitCharges(pos, result.legs);
      const exitTotal = exitCharges ? exitCharges.total : this.localExitChargesTotal(pos, result.legs);
      const finalMetrics = computeExitMetrics({
        boxWidth: pos.box_width,
        lotSize: pos.lot_size,
        entryBoxCostPerUnit: pos.entry_box_cost_per_unit,
        entryNetEdge: pos.entry_net_edge,
        entryChargesTotal: pos.entry_charges_total,
        currentExitChargesTotal: exitTotal,
        legs: result.legs,
        now: Date.now(),
        direction: pos.direction ?? "LONG_BOX",
        entryEdge: pos.entry_gross_edge,
        executionCost: this.deps.cfg.expectedExitSlippage,
        openedAt: pos.opened_at,
        expirySafety,
        cfg: this.deps.cfg,
      });
      pos.metrics = finalMetrics;

      pos.exit_blocked_reason = null;
      this.lastBlockedKey.delete(pos.id);
      this.stats.exitsTriggered++;
      this.deps.onEvent("EXIT_TRIGGERED", pos, finalMetrics, reason);

      handed = true;
      const closed = await this.deps.closePaperTrade({
        position: pos,
        metrics: finalMetrics,
        exitCharges,
        reason,
        execution: result.record,
      });
      if (!closed) pos.closing = false;
    } catch (err) {
      console.warn("[Box] exit failed for", pos.id, err);
      this.deps.onEvent("ERROR", pos, pos.metrics, `exit failed: ${String(err)}`);
      pos.closing = false;
    } finally {
      this.closingIds.delete(pos.id);
      if (!handed) pos.closing = false;
    }
  }

  private recordLiquiditySkip(pos: BoxOpenPosition, metrics: BoxExitMetrics): void {
    this.stats.exitsSkippedLiquidity++;
    const detail = describeLiquidityGap(metrics.legs, pos.lot_size);
    const key = liquidityGapKey(metrics.legs, pos.lot_size);
    if (this.lastBlockedKey.get(pos.id) !== key) {
      this.lastBlockedKey.set(pos.id, key);
      pos.exit_blocked_reason = detail;
      this.deps.onEvent("EXIT_SKIPPED_LIQUIDITY", pos, metrics, detail);
    } else {
      pos.exit_blocked_reason = detail;
    }
  }

  /**
   * Manual close, driven by the UI.
   *
   * Uses the same executable touch as an automatic close, priced with the local
   * calculator. Refuses rather than inventing prices when the four-leg one-lot
   * market is unavailable, and says why.
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
    if (!this.deps.isMarketOpen()) {
      return {
        ok: false,
        error: "Cannot close while the exchange is closed. The position is still monitored.",
        metrics: pos.metrics,
        code: 409,
      };
    }
    if (!this.deps.isFeedHealthy()) {
      return {
        ok: false,
        error: "Cannot close while the live WebSocket feed is unavailable. The position is still monitored.",
        metrics: pos.metrics,
        code: 409,
      };
    }

    const first = this.measure(pos);
    pos.metrics = first;
    if (!exitLiquidityOk(first.legs)) {
      const detail = describeLiquidityGap(first.legs, pos.lot_size);
      pos.exit_blocked_reason = detail;
      this.deps.onEvent("EXIT_SKIPPED_LIQUIDITY", pos, first, `manual close refused: ${detail}`);
      return {
        ok: false,
        error: `Cannot close at an executable price right now: ${detail}. The position is still open and being monitored.`,
        metrics: first,
        code: 409,
      };
    }

    // Claim before the simulated fill so an automatic evaluation cannot race it.
    this.closingIds.add(id);
    pos.closing = true;
    let handed = false;
    try {
      const result = await this.deps.executionSim.simulateExit({
        position: pos,
        detectionLegs: first.legs,
        detectedAt: first.at,
        stillWanted: () => this.deps.isMarketOpen() && this.deps.isFeedHealthy(),
        validate: (legs) =>
          exitLiquidityOk(legs)
            ? { ok: true as const }
            : { ok: false as const, reason: "insufficient_quantity" as const, detail: "exit touch cannot fill one lot" },
      });

      if (!result.ok) {
        const fresh = this.measure(pos, Date.now());
        pos.metrics = fresh;
        const detail = result.detail;
        if (!exitLiquidityOk(fresh.legs)) {
          pos.exit_blocked_reason = describeLiquidityGap(fresh.legs, pos.lot_size);
          this.deps.onEvent("EXIT_SKIPPED_LIQUIDITY", pos, fresh, `manual close refused: ${pos.exit_blocked_reason}`);
        }
        return {
          ok: false,
          error: `Cannot close at an executable price right now: ${detail}. The position is still open and being monitored.`,
          metrics: fresh,
          code: 409,
        };
      }

      const exitCharges = this.localExitCharges(pos, result.legs);
      const exitTotal = exitCharges ? exitCharges.total : this.localExitChargesTotal(pos, result.legs);
      const metrics = computeExitMetrics({
        boxWidth: pos.box_width,
        lotSize: pos.lot_size,
        entryBoxCostPerUnit: pos.entry_box_cost_per_unit,
        entryNetEdge: pos.entry_net_edge,
        entryChargesTotal: pos.entry_charges_total,
        currentExitChargesTotal: exitTotal,
        legs: result.legs,
        now: Date.now(),
        direction: pos.direction ?? "LONG_BOX",
        entryEdge: pos.entry_gross_edge,
        executionCost: this.deps.cfg.expectedExitSlippage,
        openedAt: pos.opened_at,
        expirySafety: this.isInExpirySafetyWindow(pos),
        cfg: this.deps.cfg,
      });
      pos.metrics = metrics;

      this.stats.exitsTriggered++;
      this.deps.onEvent("EXIT_TRIGGERED", pos, metrics, "MANUAL");
      handed = true;
      const closed = await this.deps.closePaperTrade({
        position: pos,
        metrics,
        exitCharges,
        reason: "MANUAL",
        execution: result.record,
      });
      if (!closed) {
        pos.closing = false;
        return {
          ok: false,
          error: "That box position was already closed.",
          metrics,
          code: 409,
        };
      }
      return { ok: true };
    } finally {
      this.closingIds.delete(id);
      if (!handed) pos.closing = false;
    }
  }

  private isInExpirySafetyWindow(pos: BoxOpenPosition): boolean {
    if (pos.expiry !== this.deps.istDayKey()) return false;
    const minutes = this.deps.istMinutesOfDay();
    return minutes >= IST_CLOSE_MINUTES - this.deps.cfg.expirySafetyMinutesBeforeClose;
  }
}

/**
 * A STABLE identity for the SHAPE of a liquidity gap: which legs are blocked and
 * why, with no volatile numbers in it.
 */
export function liquidityGapKey(legs: BoxLegEvaluation[], lotSize: number): string {
  const parts: string[] = [];
  for (const l of legs) {
    let cause: string | null = null;
    if (l.quote_at === null) cause = "no_book";
    else if (!l.fresh) cause = "stale";
    else if (l.price === null || !(l.price > 0)) cause = l.side === "BUY" ? "no_ask" : "no_bid";
    else if (l.qty_at_touch < lotSize) cause = "thin";
    if (cause) parts.push(`${l.role}:${cause}`);
  }
  return parts.join("|") || "ok";
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
      problems.push(`${l.tradingsymbol} has no ${l.side === "BUY" ? "ask" : "bid"}`);
    } else if (l.qty_at_touch < lotSize) {
      problems.push(`${l.tradingsymbol} shows ${l.qty_at_touch} at ${l.price} (needs ${lotSize})`);
    }
  }
  return problems.length > 0 ? problems.join("; ") : "insufficient touch liquidity";
}
