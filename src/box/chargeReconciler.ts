/**
 * Asynchronous charge RECONCILIATION.
 *
 * The decision path uses the local deterministic calculator (localCharges.ts) so
 * that nothing waits on Zerodha. That raises an obvious question: how do we know
 * the local arithmetic is right?
 *
 * This module answers it, after the fact. Once a paper trade exists, its exact
 * order lines are queued here; a bounded worker pool asks Zerodha's virtual
 * contract note what it would have charged, and the difference is recorded on the
 * trade and aggregated into the metrics.
 *
 * Three properties matter:
 *
 *   1. IT NEVER DELAYS A FILL. Work is queued after persistence and nothing awaits
 *      the result.
 *   2. IT NEVER HAMMERS ZERODHA. A small worker pool (BOX_CHARGE_RECONCILE_
 *      CONCURRENCY) plus the estimator's own cache and in-flight de-duplication.
 *   3. IT NEVER OVERWRITES THE DECISION. The local total stays exactly as recorded
 *      — the reconciliation is stored ALONGSIDE it, labelled, so the audit trail
 *      shows both what the simulator believed and what Zerodha said.
 *
 * When the two disagree by more than BOX_CHARGE_RECONCILE_WARN_PCT, it logs a
 * warning: that is the signal that a statutory rate in the rate card needs
 * updating, and until it is, the discrepancy is visible in /api/box/status rather
 * than silently mispricing every trade.
 */

import type { BoxChargeEstimator, BoxChargeLeg } from "./charges.js";
import type { BoxConfig } from "./config.js";
import type { BoxMetrics } from "./metrics.js";
import { round2 } from "./math.js";
import type { BoxCharges, BoxChargeReconciliation, BoxChargesWithOrigin } from "./types.js";

export type BoxChargePhase = "entry" | "exit";

export interface BoxChargeReconcilerDeps {
  cfg: BoxConfig;
  charges: BoxChargeEstimator;
  metrics?: BoxMetrics;
  /** Persist the verdict onto the trade document. Best-effort. */
  persist: (
    tradeId: string,
    phase: BoxChargePhase,
    verdict: BoxChargeReconciliation,
  ) => Promise<void>;
  /** Optional ledger hook, so a discrepancy is auditable and not just a log line. */
  onReconciled?: (
    tradeId: string,
    phase: BoxChargePhase,
    verdict: BoxChargeReconciliation,
    warned: boolean,
  ) => void;
  /** Zerodha must be reachable; skipped entirely when it is not. */
  isAuthenticated: () => boolean;
}

interface QueueItem {
  tradeId: string;
  phase: BoxChargePhase;
  localTotal: number;
  legs: BoxChargeLeg[];
  label: string;
  /** The local charge heads, for a head-by-head comparison against Zerodha. */
  localCharges: BoxChargesWithOrigin | null;
  /** How many times this verification has already been tried (0 on first pass). */
  attempt: number;
}

/** local − Zerodha per head, so a persistent bias points at one rate/rounding rule. */
export function headDiffs(
  local: BoxCharges | null,
  zerodha: BoxCharges | null,
): NonNullable<BoxChargeReconciliation["head_diffs"]> | null {
  if (!local || !zerodha) return null;
  return {
    brokerage: round2(local.brokerage - zerodha.brokerage),
    stt: round2(local.stt - zerodha.stt),
    exchange_txn: round2(local.exchange_txn - zerodha.exchange_txn),
    sebi: round2(local.sebi - zerodha.sebi),
    stamp_duty: round2(local.stamp_duty - zerodha.stamp_duty),
    gst: round2(local.gst - zerodha.gst),
  };
}

export class BoxChargeReconciler {
  private queue: QueueItem[] = [];
  private workers = 0;
  /** tradeId|phase already queued or done — a job is never repeated. */
  private seen = new Set<string>();
  private stats = {
    queued: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    warnings: 0,
    retries: 0,
    max_abs_diff: 0,
    last_abs_diff: null as number | null,
    last_pct_diff: null as number | null,
    last_at: null as number | null,
  };

  constructor(private deps: BoxChargeReconcilerDeps) {}

  getStats() {
    return {
      ...this.stats,
      pending: this.queue.length,
      in_flight: this.workers,
      enabled: this.deps.cfg.reconcileCharges,
      warn_pct: this.deps.cfg.chargeReconcileWarnPct,
    };
  }

  /**
   * Queue a verification. Returns immediately — by design.
   *
   * The queue is bounded by the number of trades actually taken, and each
   * trade/phase is admitted once, so it cannot grow without limit.
   */
  submit(args: {
    tradeId: string;
    phase: BoxChargePhase;
    localTotal: number;
    legs: BoxChargeLeg[];
    label?: string;
    /** The local charge heads, for a head-by-head comparison. */
    localCharges?: BoxChargesWithOrigin | null;
  }): void {
    if (!this.deps.cfg.reconcileCharges) return;
    if (args.legs.length === 0) return;
    const key = `${args.tradeId}|${args.phase}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.stats.queued++;
    this.queue.push({
      tradeId: args.tradeId,
      phase: args.phase,
      localTotal: round2(args.localTotal),
      legs: args.legs,
      label: args.label ?? args.tradeId,
      localCharges: args.localCharges ?? null,
      attempt: 0,
    });
    this.pump();
  }

  /** Start workers up to the configured concurrency. */
  private pump(): void {
    const limit = Math.max(1, this.deps.cfg.chargeReconcileConcurrency);
    while (this.workers < limit && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.workers++;
      void this.run(item).finally(() => {
        this.workers--;
        // Drain whatever arrived while this one was in flight.
        if (this.queue.length > 0) this.pump();
      });
    }
  }

  private async run(item: QueueItem): Promise<void> {
    if (!this.deps.isAuthenticated()) {
      // No session: keep the local figure, record that it is unverified, and do
      // NOT retry in a loop. The backfill happens naturally on the next trade.
      this.stats.skipped++;
      await this.safePersist(item, {
        status: "failed",
        local_total: item.localTotal,
        reconciled_total: null,
        abs_diff: null,
        pct_diff: null,
        at: new Date(),
        error: "no Zerodha session available to verify the local charge calculation",
      });
      return;
    }

    try {
      const priced = await this.deps.charges.priceOrders(
        `reconcile:${item.tradeId}:${item.phase}`,
        item.legs,
      );
      if (!priced) {
        await this.retryOrFail(item, "Zerodha could not price the box orders");
        return;
      }

      const reconciled = round2(priced.total);
      const absDiff = round2(Math.abs(reconciled - item.localTotal));
      const pctDiff = reconciled > 0 ? round2((absDiff / reconciled) * 100) : 0;
      const warned = pctDiff > this.deps.cfg.chargeReconcileWarnPct;

      this.stats.completed++;
      this.stats.last_abs_diff = absDiff;
      this.stats.last_pct_diff = pctDiff;
      this.stats.last_at = Date.now();
      if (absDiff > this.stats.max_abs_diff) this.stats.max_abs_diff = absDiff;
      if (warned) this.stats.warnings++;
      this.deps.metrics?.recordReconciliation(absDiff, pctDiff, warned);

      if (warned) {
        console.warn(
          `[Box] charge reconciliation mismatch on ${item.label} (${item.phase}): ` +
            `local ₹${item.localTotal} vs Zerodha ₹${reconciled} — ` +
            `₹${absDiff} (${pctDiff}%) over the ${this.deps.cfg.chargeReconcileWarnPct}% threshold. ` +
            `Check the rate card in localCharges.ts (BOX_STT_SELL_PCT, BOX_EXCHANGE_TXN_PCT, …).`,
        );
      }

      const verdict: BoxChargeReconciliation = {
        status: "verified",
        local_total: item.localTotal,
        reconciled_total: reconciled,
        abs_diff: absDiff,
        pct_diff: pctDiff,
        head_diffs: headDiffs(item.localCharges, priced as BoxCharges),
        at: new Date(),
        error: null,
      };
      await this.safePersist(item, verdict);
      this.deps.onReconciled?.(item.tradeId, item.phase, verdict, warned);
    } catch (err) {
      await this.retryOrFail(item, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * A transient verification failure: retry with bounded backoff, or give up and
   * record the charges as unverified.
   *
   * Why retry at all: the Zerodha charge API can rate-limit or 5xx briefly, and a
   * single blip used to mark a trade's charges permanently unverified — which
   * matters now that head_diffs is the tool for spotting a drifted statutory rate.
   *
   * Why BOUNDED: this must never become a hot loop against the broker. Attempts
   * are capped and spaced linearly, and the trade is already open either way —
   * reconciliation is an audit, never a precondition for execution.
   */
  private async retryOrFail(item: QueueItem, error: string): Promise<void> {
    const maxAttempts = Math.max(1, this.deps.cfg.chargeReconcileMaxAttempts);
    const next = item.attempt + 1;
    if (next < maxAttempts) {
      this.stats.retries++;
      const delay = Math.max(0, this.deps.cfg.chargeReconcileRetryBaseMs) * next;
      console.warn(
        `[Box] charge reconciliation for ${item.label} (${item.phase}) failed ` +
          `(attempt ${next}/${maxAttempts}: ${error}) — retrying in ${Math.round(delay / 1000)}s.`,
      );
      const timer = setTimeout(() => {
        this.queue.push({ ...item, attempt: next });
        this.pump();
      }, delay);
      timer.unref?.();
      return;
    }
    this.stats.failed++;
    this.deps.metrics?.recordReconciliationFailure();
    await this.safePersist(item, {
      status: "failed",
      local_total: item.localTotal,
      reconciled_total: null,
      abs_diff: null,
      pct_diff: null,
      at: new Date(),
      error: `${error} (gave up after ${maxAttempts} attempt(s))`,
    });
  }

  private async safePersist(
    item: QueueItem,
    verdict: BoxChargeReconciliation,
  ): Promise<void> {
    try {
      await this.deps.persist(item.tradeId, item.phase, verdict);
    } catch (err) {
      console.warn("[Box] could not store charge reconciliation for", item.label, err);
    }
  }
}
