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
import {
  BoxChargeEstimator,
  buildChargeLegsFromEvaluations,
  sameChargeLegs,
  type BoxChargeLeg,
} from "./charges.js";
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
  /**
   * Whether the exchange is open.
   *
   * Metrics keep being refreshed when it is shut (so the UI stays informative),
   * but no exit is attempted: there is no executable book to close into, and
   * repeatedly "discovering" that would only spam the ledger.
   */
  isMarketOpen: () => boolean;
  /**
   * Whether the upstream tick feed is alive.
   *
   * Distinct from a single leg being quiet: an untouched book is still valid, but
   * a broken connection makes every cached book untrustworthy at once.
   */
  isFeedHealthy: () => boolean;
}

/** Market close in IST minutes-of-day (15:30). */
const IST_CLOSE_MINUTES = 15 * 60 + 30;

export class BoxPositionMonitor {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  /** One evaluator per position; a WS tick received during charge I/O queues a rerun. */
  private evaluationTasks = new Map<string, Promise<void>>();
  private pendingEvaluationIds = new Set<string>();
  private closingIds = new Set<string>();
  /** position id → the last liquidity-gap SHAPE written to the ledger. */
  private lastBlockedKey = new Map<string, string>();
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

  /**
   * Queue one position. If another WS packet lands while charge pricing is in
   * flight, the loop runs again and captures the newer four-leg touch before any
   * fill is persisted.
   */
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
        // Cover the narrow race where a tick queued work after the loop's final
        // delete but before this task left the map.
        if (this.pendingEvaluationIds.has(id) && this.deps.positions.get(id)) {
          void this.requestEvaluation(id);
        }
      }
    })();
    this.evaluationTasks.set(id, task);
    return task;
  }

  /** Re-price every open position as a watchdog; WS updates are the primary path. */
  async cycle(): Promise<void> {
    if (this.ticking) return; // never overlap watchdog cycles
    this.ticking = true;
    try {
      this.stats.cycles++;
      this.stats.lastCycleAt = Date.now();
      await Promise.all(this.deps.positions.list().map((pos) => this.requestEvaluation(pos.id)));
    } finally {
      this.ticking = false;
    }
  }

  /** Recompute the exit arithmetic for one position (no side effects). */
  measure(
    pos: BoxOpenPosition,
    now = Date.now(),
    exitChargesTotalOverride?: number | null,
  ): BoxExitMetrics {
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
    const exitChargesTotal =
      exitChargesTotalOverride !== undefined
        ? exitChargesTotalOverride
        : this.cachedExitChargesTotal(pos, legs);

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

    // Outside market hours there is nothing to close into. The position stays
    // open with its metrics refreshed, and no exit — or exit-refusal — is
    // recorded, because "the market is shut" is not a liquidity event.
    if (!this.deps.isMarketOpen()) return;
    // Same for a dead feed: acting on books of unknown age would be worse than
    // waiting, and it is not a liquidity event either.
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

    // Act on what the RULES say, not on whether the market can fill it. A box
    // that should close but cannot has to be recorded (EXIT_SKIPPED_LIQUIDITY)
    // rather than silently skipped, which is why `rule_reason` is consulted here
    // instead of the combined `exit_eligible`.
    if (metrics.rule_reason === null && !expirySafety) {
      if (pos.exit_blocked_reason) pos.exit_blocked_reason = null;
      return;
    }

    // Charge pricing is the only network work before an exit. If the touch moves
    // during it, price the new exact orders and capture all four WS books again.
    let chargeInput = this.exitChargeLegs(pos, metrics.legs);
    let pricedExitCharges: BoxCharges | null = null;
    let stable = false;
    const MAX_PRICE_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_PRICE_ATTEMPTS; attempt++) {
      pricedExitCharges = chargeInput
        ? await this.deps.charges.estimateExitOnly(`exitq:${pos.id}`, chargeInput)
        : null;

      if (pos.closing || this.closingIds.has(pos.id)) return;
      if (this.deps.positions.get(pos.id) !== pos) return;
      if (!this.deps.isMarketOpen() || !this.deps.isFeedHealthy()) return;

      const finalNow = Date.now();
      const finalLegs = evaluateExitLegs({
        legs: BOX_LEG_ROLES.map((role) => ({ role, inst: pos.legs[role] })),
        quotes: this.deps.quotes.view(),
        lotSize: pos.lot_size,
        now: finalNow,
        maxAgeMs: this.deps.cfg.quoteMaxAgeMs,
      });
      metrics = computeExitMetrics({
        boxWidth: pos.box_width,
        lotSize: pos.lot_size,
        entryBoxCostPerUnit: pos.entry_box_cost_per_unit,
        entryNetEdge: pos.entry_net_edge,
        entryChargesTotal: pos.entry_charges_total,
        currentExitChargesTotal: pricedExitCharges
          ? round2(pricedExitCharges.total)
          : this.cachedExitChargesTotal(pos, finalLegs),
        legs: finalLegs,
        now: finalNow,
        cfg: this.deps.cfg,
      });
      pos.metrics = metrics;

      const tentativeReason =
        metrics.rule_reason ?? (expirySafety ? "EXPIRY_SAFETY" : null);
      // No fill will be persisted, so fee/fill synchronization is irrelevant.
      if (!tentativeReason || !exitLiquidityOk(finalLegs)) {
        stable = true;
        break;
      }

      const finalChargeLegs = this.exitChargeLegs(pos, finalLegs);
      if (
        pricedExitCharges &&
        chargeInput &&
        finalChargeLegs &&
        !sameChargeLegs(chargeInput, finalChargeLegs)
      ) {
        if (attempt === MAX_PRICE_ATTEMPTS) return;
        chargeInput = finalChargeLegs;
        continue;
      }
      stable = true;
      break;
    }
    if (!stable) return;

    const reason: BoxExitReason | null =
      metrics.rule_reason ?? (expirySafety ? "EXPIRY_SAFETY" : null);
    if (!reason) return;

    // EXIT QUANTITY: all four reversed legs must again support one whole lot at
    // the touch. If they do not, the exit is NOT faked — the position stays open
    // and the condition is recorded.
    if (!exitLiquidityOk(metrics.legs)) {
      this.stats.exitsSkippedLiquidity++;
      const detail = describeLiquidityGap(metrics.legs, pos.lot_size);
      // Deduped on a STABLE key rather than the message: the human-readable
      // detail embeds the current age and size, which change every cycle, so
      // comparing messages would append a near-identical ledger row every second.
      const key = liquidityGapKey(metrics.legs, pos.lot_size);
      if (this.lastBlockedKey.get(pos.id) !== key) {
        this.lastBlockedKey.set(pos.id, key);
        pos.exit_blocked_reason = detail;
        this.deps.onEvent("EXIT_SKIPPED_LIQUIDITY", pos, metrics, detail);
      } else {
        // Keep the displayed reason current without writing to the ledger again.
        pos.exit_blocked_reason = detail;
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
    this.lastBlockedKey.delete(pos.id);

    await this.executeExit(pos, metrics, reason, pricedExitCharges);
  }

  /** Perform the paper exit at the current executable touch. */
  private async executeExit(
    pos: BoxOpenPosition,
    metrics: BoxExitMetrics,
    reason: BoxExitReason,
    exitCharges: BoxCharges | null,
    alreadyClaimed = false,
  ): Promise<void> {
    if (!alreadyClaimed) {
      if (this.closingIds.has(pos.id)) return;
      this.closingIds.add(pos.id);
      pos.closing = true;
    }
    try {
      this.stats.exitsTriggered++;
      this.deps.onEvent("EXIT_TRIGGERED", pos, metrics, reason);

      // `metrics` is the final immutable WS snapshot. Charge pricing happened
      // before it; there is deliberately no network await here before the engine
      // constructs and persists the paper fill.
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

    // Claim before charge I/O so an automatic evaluation cannot race this manual
    // request. The fill itself is still captured only after the I/O completes.
    this.closingIds.add(id);
    pos.closing = true;
    let handedToExecute = false;
    try {
      let metrics = first;
      let chargeInput = this.exitChargeLegs(pos, first.legs);
      let priced: BoxCharges | null = null;
      const MAX_PRICE_ATTEMPTS = 3;
      let stable = false;

      for (let attempt = 1; attempt <= MAX_PRICE_ATTEMPTS; attempt++) {
        priced = chargeInput
          ? await this.deps.charges.estimateExitOnly(`exitq:${pos.id}`, chargeInput)
          : null;

        if (!this.deps.isMarketOpen() || !this.deps.isFeedHealthy()) {
          return {
            ok: false,
            error: "Cannot close because the live WebSocket market data became unavailable. The position is still open.",
            metrics: pos.metrics,
            code: 409,
          };
        }

        metrics = this.measure(
          pos,
          Date.now(),
          priced ? round2(priced.total) : undefined,
        );
        pos.metrics = metrics;
        if (!exitLiquidityOk(metrics.legs)) {
          const detail = describeLiquidityGap(metrics.legs, pos.lot_size);
          pos.exit_blocked_reason = detail;
          this.deps.onEvent("EXIT_SKIPPED_LIQUIDITY", pos, metrics, `manual close refused after revalidation: ${detail}`);
          return {
            ok: false,
            error: `Cannot close at an executable price right now: ${detail}. The position is still open and being monitored.`,
            metrics,
            code: 409,
          };
        }

        const finalChargeLegs = this.exitChargeLegs(pos, metrics.legs);
        if (priced && chargeInput && finalChargeLegs && !sameChargeLegs(chargeInput, finalChargeLegs)) {
          if (attempt === MAX_PRICE_ATTEMPTS) {
            return {
              ok: false,
              error: "Cannot close because the executable touch is moving faster than charges can be priced. Please retry; the position remains monitored.",
              metrics,
              code: 409,
            };
          }
          chargeInput = finalChargeLegs;
          continue;
        }
        stable = true;
        break;
      }
      if (!stable) {
        return {
          ok: false,
          error: "Could not obtain a stable executable touch. The position remains monitored.",
          metrics,
          code: 409,
        };
      }

      // `metrics` and `priced` now describe the same exact order prices. There is
      // no further external await before the engine constructs the stored fill.
      handedToExecute = true;
      await this.executeExit(pos, metrics, "MANUAL", priced, true);
      return { ok: true };
    } finally {
      if (!handedToExecute) {
        pos.closing = false;
        this.closingIds.delete(id);
      }
    }
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

/**
 * A STABLE identity for the shape of a liquidity gap: which legs are blocked and
 * why, with no volatile numbers in it.
 *
 * Used to decide whether a blockage is genuinely new and worth another ledger
 * row, as opposed to the same problem reported a second later.
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
