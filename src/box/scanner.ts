/**
 * The box scanner: the event-driven discovery and paper-entry path.
 *
 *   Kite WebSocket → quote map → affected candidates → fast local calculation
 *   → liquidity/freshness validation → charge validation → paper trade
 *
 * Nothing in this path touches MongoDB, and nothing waits on the frontend. A
 * tick affects only the candidates that actually reference the token that moved:
 * a token is one leg of at most six of an underlying's 21 strike pairs, so a tick
 * costs six evaluations, not a chain scan.
 *
 * The scanner NEVER places a real order. It records simulated fills at the
 * executable touch that was visible in the snapshot it decided on.
 */

import type { BoxConfig } from "./config.js";
import { configSnapshot, prefilterGrossThreshold } from "./config.js";
import { BoxChargeEstimator, buildEntryChargeLegs, type BoxChargeLeg } from "./charges.js";
import {
  evaluateCandidate,
  passesGrossPrefilter,
  projectedNetEdge,
  qualifiesForEntry,
  round2,
} from "./math.js";
import type { BoxQuoteStore } from "./quotes.js";
import type { BoxPositionBook } from "./positions.js";
import {
  BOX_LEG_ROLES,
  type BoxCandidate,
  type BoxEvaluation,
  type BoxOpportunity,
} from "./types.js";

/** What the scanner needs from the outside world. */
export interface BoxScannerDeps {
  cfg: BoxConfig;
  quotes: BoxQuoteStore;
  charges: BoxChargeEstimator;
  positions: BoxPositionBook;
  /** Opens the paper trade. Returns the trade id, or null when it did not open. */
  openPaperTrade: (args: {
    candidate: BoxCandidate;
    evaluation: BoxEvaluation;
    entryLegs: BoxChargeLeg[];
    entryChargesTotal: number;
    estimatedExitChargesTotal: number;
    netEdge: number;
    charges: NonNullable<Awaited<ReturnType<BoxChargeEstimator["estimate"]>>>;
  }) => Promise<string | null>;
  /** Ledger hook for rejections and detections. */
  onEvent: (
    event:
      | "DETECTED"
      | "ENTRY_REJECTED_STALE"
      | "ENTRY_REJECTED_LIQUIDITY"
      | "ENTRY_REJECTED_FEES"
      | "ENTRY_REJECTED_DUPLICATE",
    candidate: BoxCandidate,
    evaluation: BoxEvaluation,
    detail?: string,
  ) => void;
}

/** Counters exposed by GET /api/box/status. */
export interface BoxScannerStats {
  ticksApplied: number;
  evaluations: number;
  prefilterPasses: number;
  chargeAttempts: number;
  entriesOpened: number;
  rejectedStale: number;
  rejectedLiquidity: number;
  rejectedFees: number;
  rejectedDuplicate: number;
  lastEvaluationAt: number | null;
}

/**
 * Rejection events are only worth writing once per candidate per cooldown —
 * otherwise a single thin book would produce thousands of identical ledger rows.
 */
const REJECT_LOG_COOLDOWN_MS = 60_000;

export class BoxScanner {
  private candidates = new Map<string, BoxCandidate>();
  /** token → candidate keys that reference it. The dependency index. */
  private tokenIndex = new Map<number, Set<string>>();
  /** The newest published view of each candidate. */
  private opportunities = new Map<string, BoxOpportunity>();
  /** Candidates with an entry pipeline in flight. */
  private entryInFlight = new Set<string>();
  private lastRejectLogAt = new Map<string, number>();

  /** Discovery of NEW boxes. Monitoring of open boxes never depends on this. */
  private discovering = false;

  private stats: BoxScannerStats = {
    ticksApplied: 0,
    evaluations: 0,
    prefilterPasses: 0,
    chargeAttempts: 0,
    entriesOpened: 0,
    rejectedStale: 0,
    rejectedLiquidity: 0,
    rejectedFees: 0,
    rejectedDuplicate: 0,
    lastEvaluationAt: null,
  };

  constructor(private deps: BoxScannerDeps) {}

  /* ------------------------------ lifecycle ------------------------------ */

  /**
   * Enable/disable DISCOVERY only.
   *
   * STOP means: stop opening new boxes. It does not stop the position monitor,
   * which lives in its own module and keeps managing (and exiting) whatever is
   * already open.
   */
  setDiscovering(on: boolean): void {
    this.discovering = on;
  }

  isDiscovering(): boolean {
    return this.discovering;
  }

  getStats(): BoxScannerStats {
    return { ...this.stats };
  }

  /* ------------------------------ candidates ----------------------------- */

  /**
   * Replace the candidate set for one underlying (called when its ATM window is
   * built or re-centred) and rebuild that underlying's slice of the dependency
   * index.
   */
  setCandidatesForUnderlying(underlying: string, next: BoxCandidate[]): void {
    // Drop the old slice first so a shifted window cannot leave orphan entries.
    for (const [key, cand] of this.candidates) {
      if (cand.underlying !== underlying) continue;
      this.candidates.delete(key);
      this.opportunities.delete(key);
      for (const role of BOX_LEG_ROLES) {
        const set = this.tokenIndex.get(cand.legs[role].token);
        if (!set) continue;
        set.delete(key);
        if (set.size === 0) this.tokenIndex.delete(cand.legs[role].token);
      }
    }
    for (const cand of next) {
      this.candidates.set(cand.key, cand);
      for (const role of BOX_LEG_ROLES) {
        const token = cand.legs[role].token;
        let set = this.tokenIndex.get(token);
        if (!set) {
          set = new Set();
          this.tokenIndex.set(token, set);
        }
        set.add(cand.key);
      }
    }
  }

  /** Remove an underlying entirely (e.g. it fell outside the token budget). */
  removeUnderlying(underlying: string): void {
    this.setCandidatesForUnderlying(underlying, []);
  }

  get candidateCount(): number {
    return this.candidates.size;
  }

  get monitoredTokenCount(): number {
    return this.tokenIndex.size;
  }

  getCandidate(key: string): BoxCandidate | undefined {
    return this.candidates.get(key);
  }

  candidatesFor(underlying: string): BoxCandidate[] {
    return [...this.candidates.values()].filter((c) => c.underlying === underlying);
  }

  /* ------------------------------- hot path ------------------------------ */

  /**
   * Handle a batch of updated tokens.
   *
   * This is THE hot path. It is synchronous, allocation-light, and only ever
   * looks at candidates that reference one of the tokens that changed.
   */
  onTokensUpdated(tokens: number[]): void {
    if (tokens.length === 0) return;
    this.stats.ticksApplied += tokens.length;

    // Collect the affected candidates once, so a batch that touches several legs
    // of the same box evaluates that box a single time.
    let affected: Set<string> | null = null;
    for (const token of tokens) {
      const keys = this.tokenIndex.get(token);
      if (!keys) continue;
      if (!affected) affected = new Set();
      for (const k of keys) affected.add(k);
    }
    if (!affected) return;

    const now = Date.now();
    for (const key of affected) {
      const cand = this.candidates.get(key);
      if (!cand) continue;
      this.evaluateAndMaybeEnter(cand, now);
    }
  }

  /** Re-evaluate everything (used when the UI asks for a fresh snapshot). */
  refreshAll(): void {
    const now = Date.now();
    for (const cand of this.candidates.values()) {
      this.evaluateAndMaybeEnter(cand, now);
    }
  }

  private evaluateAndMaybeEnter(cand: BoxCandidate, now: number): void {
    this.stats.evaluations++;
    this.stats.lastEvaluationAt = now;

    const evaluation = evaluateCandidate({
      candidate: cand,
      quotes: this.deps.quotes.view(),
      now,
      maxAgeMs: this.deps.cfg.quoteMaxAgeMs,
    });

    const openKeyTaken = this.deps.positions.getByKey(cand.key) !== undefined;
    const threshold = prefilterGrossThreshold(this.deps.cfg);

    // FAST LOCAL PREFILTER. A charge call is only ever considered for a box whose
    // gross executable edge already clears ₹1,200 + safety + a lower bound on
    // charges. Everything else is published (so the UI can show near-misses) and
    // costs nothing more.
    const passedPrefilter = passesGrossPrefilter(evaluation.gross_edge, threshold);
    if (passedPrefilter) this.stats.prefilterPasses++;

    this.publish(evaluation, {
      openKeyTaken,
      passedPrefilter,
      cachedNetEdge: this.cachedNetEdgeFor(evaluation),
    });

    if (!this.discovering) return;
    if (openKeyTaken) return;
    if (!evaluation.tradable) {
      this.noteRejection(cand, evaluation);
      return;
    }
    if (!passedPrefilter) return;
    if (this.entryInFlight.has(cand.key)) return;
    if (!this.deps.charges.hasCapacity()) return;

    void this.attemptEntry(cand, evaluation);
  }

  /**
   * A cached charge estimate for the CURRENT touch, if one happens to be warm.
   * Lets the published opportunity show real fees without triggering a call.
   */
  private cachedNetEdgeFor(evaluation: BoxEvaluation): {
    entry: number;
    exit: number;
    net: number;
  } | null {
    if (evaluation.gross_edge === null) return null;
    const legs = buildEntryChargeLegs(evaluation.candidate, evaluation.legs);
    if (!legs) return null;
    const cached = this.deps.charges.peek(evaluation.candidate.key, legs);
    if (!cached) return null;
    const net = projectedNetEdge({
      grossEdge: evaluation.gross_edge,
      entryCharges: cached.entry_total,
      estimatedExitCharges: cached.estimated_exit_total,
      safetyBuffer: this.deps.cfg.safetyBuffer,
    });
    return { entry: cached.entry_total, exit: cached.estimated_exit_total, net };
  }

  /* ------------------------------ entry path ----------------------------- */

  /**
   * The paper-entry pipeline.
   *
   *   1. snapshot the four quotes            (already done: `first`)
   *   2. estimate charges                    (async — the book can move here)
   *   3. RE-EVALUATE the four quotes         (`second`)
   *   4. require still-fresh, still-liquid, still-qualifying
   *   5. only then create the paper trade
   *
   * Step 3 is the whole point: a decision must never be executed on a quote
   * snapshot that was taken before an API round trip.
   */
  private async attemptEntry(cand: BoxCandidate, first: BoxEvaluation): Promise<void> {
    if (!this.deps.positions.reserve(cand.key)) {
      this.stats.rejectedDuplicate++;
      this.logRejection("ENTRY_REJECTED_DUPLICATE", cand, first, "strike pair already taken");
      return;
    }
    this.entryInFlight.add(cand.key);
    try {
      const entryLegs = buildEntryChargeLegs(cand, first.legs);
      if (!entryLegs) {
        this.deps.positions.release(cand.key);
        return;
      }

      this.stats.chargeAttempts++;
      const estimate = await this.deps.charges.estimate(cand.key, entryLegs);

      // Charges could not be determined → the opportunity stays visible as
      // UNPRICED but is NOT eligible for an automatic paper entry.
      if (!estimate) {
        this.stats.rejectedFees++;
        this.markStatus(cand.key, "UNPRICED");
        this.logRejection(
          "ENTRY_REJECTED_FEES",
          cand,
          first,
          "Zerodha could not price the eight box orders",
        );
        this.deps.positions.release(cand.key);
        return;
      }

      // ---- REVALIDATE against the book as it is NOW ----
      const now = Date.now();
      const second = evaluateCandidate({
        candidate: cand,
        quotes: this.deps.quotes.view(),
        now,
        maxAgeMs: this.deps.cfg.quoteMaxAgeMs,
      });

      if (!second.tradable || second.gross_edge === null) {
        this.noteRejection(cand, second, "book moved while charges were being priced");
        this.deps.positions.release(cand.key);
        return;
      }

      // Re-price the net edge on the CURRENT touch. The charge estimate is reused
      // (it is a function of turnover, which barely moves for a tick-sized price
      // change) but the EDGE is always recomputed from the live book.
      const netEdge = projectedNetEdge({
        grossEdge: second.gross_edge,
        entryCharges: estimate.entry_total,
        estimatedExitCharges: estimate.estimated_exit_total,
        safetyBuffer: this.deps.cfg.safetyBuffer,
      });

      if (!qualifiesForEntry(netEdge, this.deps.cfg.minNetEdge)) {
        this.markStatus(cand.key, "WATCHING");
        this.deps.positions.release(cand.key);
        return;
      }

      // The revalidated legs are what the paper fills are recorded at.
      const revalidatedLegs = buildEntryChargeLegs(cand, second.legs);
      if (!revalidatedLegs) {
        this.deps.positions.release(cand.key);
        return;
      }

      const id = await this.deps.openPaperTrade({
        candidate: cand,
        evaluation: second,
        entryLegs: revalidatedLegs,
        entryChargesTotal: estimate.entry_total,
        estimatedExitChargesTotal: estimate.estimated_exit_total,
        netEdge,
        charges: estimate,
      });

      if (id) {
        this.stats.entriesOpened++;
        this.markStatus(cand.key, "PAPER_OPENED");
      } else {
        // Either a duplicate was caught by the unique index, or persistence is
        // unavailable. Either way the reservation must not leak.
        this.deps.positions.release(cand.key);
      }
    } catch (err) {
      console.warn("[Box] entry attempt failed for", cand.key, err);
      this.deps.positions.release(cand.key);
    } finally {
      this.entryInFlight.delete(cand.key);
    }
  }

  /* -------------------------------- events -------------------------------- */

  private noteRejection(
    cand: BoxCandidate,
    evaluation: BoxEvaluation,
    detail?: string,
  ): void {
    const reason = evaluation.reject;
    if (reason === "stale_quote" || reason === "no_quote") {
      this.stats.rejectedStale++;
      this.logRejection("ENTRY_REJECTED_STALE", cand, evaluation, detail);
      return;
    }
    if (
      reason === "insufficient_qty" ||
      reason === "missing_bid" ||
      reason === "missing_ask"
    ) {
      this.stats.rejectedLiquidity++;
      this.logRejection("ENTRY_REJECTED_LIQUIDITY", cand, evaluation, detail);
    }
  }

  /**
   * Write a rejection to the ledger at most once per candidate per cooldown.
   *
   * Only candidates that already cleared the gross prefilter are logged: a thin
   * book on a box with no edge is not an interesting audit record, whereas a box
   * that WOULD have qualified but was blocked by liquidity or staleness is.
   */
  private logRejection(
    event:
      | "ENTRY_REJECTED_STALE"
      | "ENTRY_REJECTED_LIQUIDITY"
      | "ENTRY_REJECTED_FEES"
      | "ENTRY_REJECTED_DUPLICATE",
    cand: BoxCandidate,
    evaluation: BoxEvaluation,
    detail?: string,
  ): void {
    if (!passesGrossPrefilter(evaluation.gross_edge, prefilterGrossThreshold(this.deps.cfg))) {
      return;
    }
    const logKey = `${event}|${cand.key}`;
    const last = this.lastRejectLogAt.get(logKey) ?? 0;
    const now = Date.now();
    if (now - last < REJECT_LOG_COOLDOWN_MS) return;
    this.lastRejectLogAt.set(logKey, now);
    this.deps.onEvent(event, cand, evaluation, detail);
  }

  /* ----------------------------- publication ----------------------------- */

  private markStatus(key: string, status: BoxOpportunity["status"]): void {
    const opp = this.opportunities.get(key);
    if (opp) this.opportunities.set(key, { ...opp, status, updated_at: Date.now() });
  }

  private publish(
    evaluation: BoxEvaluation,
    ctx: {
      openKeyTaken: boolean;
      passedPrefilter: boolean;
      cachedNetEdge: { entry: number; exit: number; net: number } | null;
    },
  ): void {
    const cand = evaluation.candidate;
    const previous = this.opportunities.get(cand.key);
    const cfg = this.deps.cfg;

    let status: BoxOpportunity["status"];
    if (ctx.openKeyTaken) status = "OPEN";
    else if (previous?.status === "PAPER_OPENED" && !ctx.openKeyTaken) status = "PAPER_OPENED";
    else if (!evaluation.tradable) status = ctx.passedPrefilter ? "REJECTED" : "WATCHING";
    else if (ctx.cachedNetEdge && qualifiesForEntry(ctx.cachedNetEdge.net, cfg.minNetEdge)) {
      status = "ELIGIBLE";
    } else if (previous?.status === "UNPRICED" && ctx.passedPrefilter) status = "UNPRICED";
    else status = "WATCHING";

    this.opportunities.set(cand.key, {
      key: cand.key,
      underlying: cand.underlying,
      name: cand.name,
      is_index: cand.is_index,
      expiry: cand.expiry,
      lower_strike: cand.lower_strike,
      upper_strike: cand.upper_strike,
      box_width: cand.box_width,
      lot_size: cand.lot_size,
      quantity: cand.lot_size,
      entry_box_cost:
        evaluation.entry_box_cost_per_unit === null
          ? null
          : round2(evaluation.entry_box_cost_per_unit * cand.lot_size),
      gross_edge: evaluation.gross_edge,
      entry_charges: ctx.cachedNetEdge ? ctx.cachedNetEdge.entry : null,
      estimated_exit_charges: ctx.cachedNetEdge ? ctx.cachedNetEdge.exit : null,
      safety_buffer: cfg.safetyBuffer,
      projected_net_edge: ctx.cachedNetEdge ? ctx.cachedNetEdge.net : null,
      liquidity_ok: evaluation.tradable,
      worst_age_ms: evaluation.worst_age_ms,
      status,
      reject: evaluation.reject,
      legs: evaluation.legs,
      updated_at: evaluation.at,
    });
  }

  /**
   * Opportunities worth showing: anything tradable-and-interesting, anything that
   * cleared the gross prefilter, and anything already open. The scanner does NOT
   * dump every F&O box into the UI — 200 underlyings × 21 pairs is 4,200 rows of
   * noise, and the operator only cares about the ones near a trade.
   */
  listOpportunities(limit: number): BoxOpportunity[] {
    const threshold = prefilterGrossThreshold(this.deps.cfg);
    // Show boxes within reach of the requirement as well as the qualifying ones,
    // so a near-miss is visible rather than silently discarded.
    const visibilityFloor = Math.min(0, this.deps.cfg.minNetEdge * -1);
    const rows: BoxOpportunity[] = [];
    for (const opp of this.opportunities.values()) {
      const interesting =
        opp.status === "OPEN" ||
        opp.status === "PAPER_OPENED" ||
        opp.status === "ELIGIBLE" ||
        opp.status === "UNPRICED" ||
        (opp.gross_edge !== null && opp.gross_edge >= Math.min(threshold, 0)) ||
        (opp.projected_net_edge !== null && opp.projected_net_edge >= visibilityFloor);
      if (!interesting) continue;
      // Only ever show a box with a real, positive executable edge — a negative
      // edge is not an "opportunity", it is just a box that costs more than it
      // pays.
      if (
        opp.status !== "OPEN" &&
        opp.status !== "PAPER_OPENED" &&
        (opp.gross_edge === null || opp.gross_edge <= 0)
      ) {
        continue;
      }
      rows.push(opp);
    }
    rows.sort((a, b) => {
      const an = a.projected_net_edge ?? a.gross_edge ?? Number.NEGATIVE_INFINITY;
      const bn = b.projected_net_edge ?? b.gross_edge ?? Number.NEGATIVE_INFINITY;
      return bn - an;
    });
    return rows.slice(0, limit);
  }

  /** Opportunity rows for one underlying (for the chain view's leg marking). */
  opportunitiesFor(underlying: string): BoxOpportunity[] {
    return [...this.opportunities.values()].filter((o) => o.underlying === underlying);
  }

  /** Drop published state (e.g. when the session dies). */
  clearOpportunities(): void {
    this.opportunities.clear();
  }
}


