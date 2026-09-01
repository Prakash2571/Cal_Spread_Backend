/**
 * The box engine: the one object that owns the module's lifecycle.
 *
 * It wires the shared market-data feed to the scanner and the position monitor,
 * maintains the ATM±3 strike windows and their subscriptions, performs the paper
 * fills, persists them, and publishes state to the UI.
 *
 * Two independent switches:
 *
 *   DISCOVERY  (RUN / STOP)  — opening NEW paper boxes.
 *   MONITORING (always on)   — managing and exiting boxes that are already open.
 *
 * STOP only turns discovery off. Positions never become unmanaged.
 */

import type { Response } from "express";
import type { Instrument, KiteClient } from "../kite.js";
import type { TickerHub } from "../hub.js";
import type { Tick } from "../ticker.js";
import {
  BOX_TUNING_KEYS,
  BOX_TUNING_LIMITS,
  clampStrikeLevel,
  configSnapshot,
  loadBoxConfig,
  prefilterGrossThreshold,
  readTuning,
  requiredNetProfit,
  validateTuning,
  type BoxConfig,
  type BoxTuning,
} from "./config.js";
import { BoxChargeEstimator, buildEntryChargeLegs, type BoxChargeLeg, type PriceChargeGroupsFn } from "./charges.js";
import { BoxChargeReconciler } from "./chargeReconciler.js";
import { BoxExecutionSimulator } from "./executionSimulator.js";
import { LocalChargeCalculator } from "./localCharges.js";
import { BoxMetrics } from "./metrics.js";
import {
  buildUnderlyingState,
  indexOptionChains,
  prioritiseUniverse,
  windowNeedsRebuild,
  windowTokens,
  type BoxBoardItem,
  type BoxChainIndex,
} from "./instruments.js";
import { buildCandidates, round2 } from "./math.js";
import { BoxPositionBook, type BoxOpenPosition } from "./positions.js";
import { BoxPositionMonitor } from "./positionMonitor.js";
import { BoxQuoteStore, SpotStore } from "./quotes.js";
import { initBoxConnection } from "../db.js";
import {
  appendBoxEvent,
  closeBoxTrade,
  insertBoxExecutionAttempt,
  insertBoxTrade,
  isBoxDbEnabled,
  loadBoxDailyPnlTradeIds,
  loadBoxExecutionAttempts,
  loadBoxSettings,
  loadBoxTradesClosedSince,
  loadOpenBoxTrades,
  saveBoxSettings,
  serializeBoxTrade,
  setBoxChargeReconciliation,
  setBoxTradeMargin,
  toEventLegs,
  tradeKey,
  updateBoxTradeLive,
  upsertBoxDailyPnl,
  type SerializedBoxTrade,
} from "./repository.js";
import { BoxClosedTradeCache, liteClosedTrade } from "./closedCache.js";
import { BoxPnlCache } from "./pnlCache.js";
import { BoxPnlArchiver, istDayStartMs } from "./pnlArchive.js";
import type {
  BoxDailyPnlSummary,
  ClosedPnlInput,
  OpenPnlInput,
} from "./pnlSnapshot.js";
import { BoxScanner } from "./scanner.js";
import {
  BOX_DIRECTIONS,
  BOX_LEG_ROLES,
  directionLabel,
  directionOf,
  type BoxCandidate,
  type BoxChargesWithOrigin,
  type BoxDirection,
  type BoxEntryDecision,
  type BoxEvaluation,
  type BoxExecutionRecord,
  type BoxExitMetrics,
  type BoxExitReason,
  type BoxLegRole,
  type BoxOpportunity,
  type BoxOptionInstrument,
  type BoxUnderlyingState,
  type IBoxExecutionAttempt,
  type IBoxLeg,
  type IBoxTrade,
  type PaperLeggingExecutionRecord,
} from "./types.js";
import type { BoxExecutionFailureReason } from "./types.js";
import { entrySideFor } from "./math.js";

export interface BoxEngineDeps {
  kite: KiteClient;
  tickerHub: TickerHub;
  getAllInstruments: () => Promise<Instrument[]>;
  getBoard: () => Promise<BoxBoardItem[]>;
  /** The calendar engine's Zerodha charge estimator, injected UNCHANGED. */
  priceChargeGroups: PriceChargeGroupsFn;
  istDayKey: (at?: number) => string;
  makeIdResolver: (all: Instrument[]) => (token: number) => string | null;
  /** NSE equity-derivatives hours, reused from the calendar engine. */
  isMarketOpen: () => boolean;
  /** Zerodha basket-margin API, reused unchanged from the calendar engine. */
  getBasketMargin: (
    orders: {
      exchange: string;
      tradingsymbol: string;
      transaction_type: "BUY" | "SELL";
      variety: string;
      product: string;
      order_type: string;
      quantity: number;
      price: number;
    }[],
  ) => Promise<{ initial: number; final: number; total: number }>;
}

/** Minutes past IST midnight, right now. */
function istMinutesOfDay(at: number = Date.now()): number {
  const ist = new Date(at + 5.5 * 60 * 60 * 1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

interface SseClient {
  res: Response;
}

export class BoxEngine {
  private cfg: BoxConfig;
  private quotes = new BoxQuoteStore();
  private spots = new SpotStore();
  private positions = new BoxPositionBook();
  private charges: BoxChargeEstimator;
  private localCharges: LocalChargeCalculator;
  private executionSim: BoxExecutionSimulator;
  private reconciler: BoxChargeReconciler;
  private metrics: BoxMetrics;
  private scanner: BoxScanner;
  private monitor: BoxPositionMonitor;
  private pnlCache: BoxPnlCache;
  private pnlArchiver: BoxPnlArchiver;

  private closedCache: BoxClosedTradeCache;

  /** Running tally of trades CLOSED today, for the day-P&L view (no Mongo on read). */
  private closedTodayDay = "";
  private closedTodayCount = 0;
  private closedTodayNet = 0;
  private closedTodayGross = 0;
  /** Total basket margin that today's closed boxes had blocked while they were on. */
  private closedTodayMargin = 0;
  /** How many of today's closed boxes never got a margin figure back from Zerodha. */
  private closedTodayMarginUnknown = 0;
  /**
   * TODAY's closed trades, newest first — the Closed-trades tab's fast path.
   *
   * Held in process so the view costs nothing to read: seeded from Mongo at boot,
   * appended to on every close, and mirrored to Redis so a restart mid-session
   * refills it in one round trip instead of re-querying the whole closed book.
   */
  private closedTodayTrades: SerializedBoxTrade[] = [];
  /**
   * The IST day `closedTodayTrades` has actually been LOADED for, or null.
   *
   * Deliberately a day key rather than a boolean. A boolean flipped by the day-roll
   * helper would mark the list authoritative whenever the day field merely became
   * current — including the `"" → today` roll that happens on the first request
   * after a FAILED boot seed. That would answer "no closed trades" from memory for
   * the rest of the day without ever consulting Redis or Mongo: precisely the
   * empty-Closed-tab bug this whole change exists to fix.
   */
  private closedTodayLoadedFor: string | null = null;
  /** Where the in-process set last came from, surfaced for the operator. */
  private closedTodaySource: "memory" | "redis" | "mongo" | "none" = "none";
  /** The directions the scanner builds candidates for. */
  private directions: readonly BoxDirection[];
  /**
   * The ACTIVE strikes-each-side level (1, 2 or 3), admin-adjustable at runtime.
   *
   * Never above the config cap (ATM ±3). Narrowing it changes only which NEW
   * boxes are discovered — open positions keep their own legs and are managed
   * independently, so a level change can never affect a trade already on.
   */
  private strikeLevel: 1 | 2 | 3;
  /** Forces every window to rebuild on the next refresh (set by setStrikeLevel). */
  private forceWindowRebuild = false;
  /**
   * The CONFIGURED gross prefilter (MIN_BOX_GROSS_EDGE), before any gate-driven
   * narrowing. Captured once at construction so applyTuning can re-derive the live
   * prefilter from a fixed baseline instead of clamping the running value, which
   * would only ever ratchet downwards.
   */
  private readonly baseMinGrossEdge: number;

  /** Underlying → its current seven-strike window. */
  private windows = new Map<string, BoxUnderlyingState>();
  /** Underlying → nearest live expiry chain index. */
  private chains = new Map<string, BoxChainIndex>();
  private board: BoxBoardItem[] = [];
  /** Every option token we have asked the hub to stream for the box module. */
  private subscribedOptionTokens = new Set<number>();
  private subscribedSpotTokens = new Set<number>();
  private skippedForBudget: string[] = [];

  private releaseRetainer: (() => void) | null = null;
  private removeTickListener: (() => void) | null = null;
  private universeTimer: NodeJS.Timeout | null = null;
  private publishTimer: NodeJS.Timeout | null = null;

  private running = false;
  private started = false;
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;
  private lastError: string | null = null;
  private universeBuiltAt: number | null = null;
  private sseClients = new Set<SseClient>();

  /** Cached exchange-hours state, refreshed on the market timer. */
  private marketOpen = false;
  private feedHealthy = false;
  private marketTimer: NodeJS.Timeout | null = null;
  private indicativeTimer: NodeJS.Timeout | null = null;
  private indicativeAt: number | null = null;
  private indicativePriced = 0;
  /** Positions whose margin fetch is currently in flight (dedupe guard). */
  private marginInFlight = new Set<string>();
  /** Backfill rounds spent per position, so a hopeless one is not retried forever. */
  private marginBackfillTries = new Map<string, number>();
  private static readonly MAX_MARGIN_BACKFILLS = 5;
  /** Rolling ring of (receive time − exchange timestamp) samples, in ms. */
  private exchangeLagSamples: number[] = [];
  private exchangeLagCursor = 0;
  private static readonly EXCHANGE_LAG_WINDOW = 500;
  /** The trading day the last-close view was built from. */
  private indicativeSessionDay: string | null = null;
  /** Legs discarded because they last traded in an EARLIER session. */
  private indicativeStaleLegs = 0;

  constructor(private deps: BoxEngineDeps) {
    this.cfg = loadBoxConfig();
    this.charges = new BoxChargeEstimator(deps.priceChargeGroups, this.cfg);
    this.localCharges = new LocalChargeCalculator();
    this.metrics = new BoxMetrics(this.cfg.metricsWindow);
    this.directions = this.cfg.enableShortBox ? BOX_DIRECTIONS : (["LONG_BOX"] as const);
    this.strikeLevel = this.cfg.defaultStrikeLevel;
    this.baseMinGrossEdge = this.cfg.minGrossEdge;

    this.executionSim = new BoxExecutionSimulator({
      cfg: this.cfg,
      quotes: this.quotes,
      metrics: this.metrics,
      isMarketOpen: () => this.marketOpen,
      isFeedHealthy: () => this.isFeedHealthy(),
      // The local charge calculator prices paper_legging partial-entry and unwind
      // charges synchronously — never a network call inside the fill.
      chargeTotal: (orders) => this.localCharges.legs(orders).total,
    });

    this.reconciler = new BoxChargeReconciler({
      cfg: this.cfg,
      charges: this.charges,
      metrics: this.metrics,
      isAuthenticated: () => this.deps.kite.getAccessToken() !== null,
      persist: (tradeId, phase, verdict) =>
        setBoxChargeReconciliation(tradeId, phase, verdict),
      onReconciled: (tradeId, phase, verdict, warned) => {
        void appendBoxEvent({
          event: "CHARGES_RECONCILED",
          trade_id: tradeId,
          candidate_key: "",
          underlying: "",
          expiry: "",
          lower_strike: 0,
          upper_strike: 0,
          lot_size: 0,
          quantity: 0,
          execution_mode: this.cfg.executionMode,
          reason: warned ? "discrepancy_over_threshold" : "verified",
          detail:
            `${phase}: local ₹${verdict.local_total} vs Zerodha ₹${verdict.reconciled_total} ` +
            `(${verdict.pct_diff}%)`,
        });
      },
    });

    this.scanner = new BoxScanner({
      cfg: this.cfg,
      quotes: this.quotes,
      charges: this.charges,
      localCharges: this.localCharges,
      executionSim: this.executionSim,
      metrics: this.metrics,
      positions: this.positions,
      openPaperTrade: (args) => this.openPaperTrade(args),
      onExecutionAttempt: (candidate, legging, reason, detail) =>
        void this.persistExecutionAttempt(candidate, legging, reason, detail),
      onEvent: (event, candidate, evaluation, detail) => {
        void appendBoxEvent({
          event,
          candidate_key: candidate.key,
          underlying: candidate.underlying,
          expiry: candidate.expiry,
          direction: candidate.direction,
          lower_strike: candidate.lower_strike,
          upper_strike: candidate.upper_strike,
          lot_size: candidate.lot_size,
          quantity: candidate.lot_size,
          execution_mode: this.cfg.executionMode,
          box_width: candidate.box_width,
          box_cost:
            evaluation.entry_net_debit_per_unit === null
              ? null
              : round2(evaluation.entry_net_debit_per_unit * candidate.lot_size),
          gross_edge: evaluation.gross_edge,
          safety_buffer: this.cfg.safetyBuffer,
          legs: toEventLegs(evaluation.legs),
          reason: evaluation.reject,
          detail: detail ?? null,
        });
      },
    });

    this.monitor = new BoxPositionMonitor({
      cfg: this.cfg,
      quotes: this.quotes,
      localCharges: this.localCharges,
      executionSim: this.executionSim,
      positions: this.positions,
      closePaperTrade: (args) => this.closePaperTrade(args),
      persistLive: (pos) =>
        updateBoxTradeLive(pos.id, {
          current_remaining_edge: pos.metrics?.remaining_edge ?? null,
          current_captured_edge: pos.metrics?.captured_edge ?? null,
          current_captured_pct: pos.metrics?.captured_pct ?? null,
          exit_blocked_reason: pos.exit_blocked_reason,
          expiry_safety: pos.expiry_safety,
        }),
      onEvent: (event, pos, metrics, detail) => {
        void appendBoxEvent({
          event,
          trade_id: pos.id,
          candidate_key: pos.key,
          underlying: pos.underlying,
          expiry: pos.expiry,
          direction: pos.direction ?? "LONG_BOX",
          lower_strike: pos.lower_strike,
          upper_strike: pos.upper_strike,
          lot_size: pos.lot_size,
          quantity: pos.quantity,
          execution_mode: this.cfg.executionMode,
          box_width: pos.box_width,
          box_cost: round2(pos.entry_box_cost_per_unit * pos.lot_size),
          gross_edge: pos.entry_gross_edge,
          entry_charges_total: pos.entry_charges_total,
          exit_charges_total: metrics?.estimated_exit_charges ?? null,
          safety_buffer: pos.safety_buffer,
          net_edge: pos.entry_net_edge,
          gross_pnl: metrics?.gross_pnl_if_closed_now ?? null,
          net_pnl: metrics?.current_net_pnl ?? null,
          remaining_edge: metrics?.remaining_edge ?? null,
          captured_edge: metrics?.captured_edge ?? null,
          captured_pct: metrics?.captured_pct ?? null,
          legs: metrics ? toEventLegs(metrics.legs) : [],
          reason: metrics?.exit_reason ?? null,
          detail: detail ?? null,
        });
      },
      istDayKey: () => this.deps.istDayKey(),
      istMinutesOfDay: () => istMinutesOfDay(),
      isMarketOpen: () => this.marketOpen,
      isFeedHealthy: () => this.isFeedHealthy(),
    });

    // Read-path cache for today's closed trades (inert without Upstash).
    this.closedCache = new BoxClosedTradeCache(this.cfg);

    // Live P&L cache + nightly archive (inert unless BOX_PNL_CACHE_ENABLED and
    // Upstash are both configured — see pnlArchive.ts).
    this.pnlCache = new BoxPnlCache(this.cfg);
    this.pnlArchiver = new BoxPnlArchiver({
      cfg: this.cfg,
      cache: this.pnlCache,
      getOpenPnl: () => this.openPnlInputs(),
      loadClosedSince: (sinceMs) => this.closedPnlInputs(sinceMs),
      upsert: (doc) => upsertBoxDailyPnl(doc),
      loadPersistedIds: (day) => loadBoxDailyPnlTradeIds(day),
      istDayKey: () => this.deps.istDayKey(),
      // A Date whose UTC fields read as IST, matching the EOD scheduler's clock.
      istNow: () => new Date(Date.now() + 5.5 * 60 * 60 * 1000),
      isDbEnabled: () => isBoxDbEnabled(),
    });

    this.metrics.startSampling();
    this.marketOpen = this.deps.isMarketOpen();
    this.scanner.setMarketOpen(this.marketOpen);
  }

  /* ------------------------------- lifecycle ------------------------------ */

  /**
   * Boot the module.
   *
   * Adopts any box that was open before the restart and starts the MONITOR
   * immediately — a position taken yesterday must be managed today whether or not
   * anyone presses RUN. Discovery stays off until RUN.
   */
  async boot(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // Open the box database first (BOX_MONGODB_URI when set, otherwise the main
    // one) so the positions below are read from the right place.
    await initBoxConnection();
    // Admin-saved thresholds override the env defaults, before anything can be
    // judged against them.
    await this.loadPersistedTuning();
    this.marketOpen = this.deps.isMarketOpen();
    this.scanner.setMarketOpen(this.marketOpen);
    try {
      await this.adoptOpenPositions();
    } catch (err) {
      console.warn("[Box] failed to adopt open positions:", err);
    }
    this.monitor.start();
    // Seed the "closed today" tally AND the closed-today trade list from Mongo, so
    // both the day-P&L figures and the Closed-trades tab are correct and instant
    // immediately after a restart. Then start the P&L cache + nightly archiver.
    await this.refreshClosedTodayFromDb().catch((err) =>
      console.warn("[Box] closed-today seed failed:", err),
    );
    this.pnlArchiver.start();
    // Open positions need live books even with the scanner stopped.
    if (this.positions.size > 0) this.ensureFeed();
    // Track market hours from boot, not only from RUN. Two things depend on it
    // whether or not anyone presses RUN: the monitor's view of tradability, and
    // the last-close view — which is the ONLY way to see how boxes were priced at
    // the close, and used to be unreachable with the scanner stopped.
    this.startMarketWatch();
    // Exactly ONE universe pass at boot. refreshClosedMarketView performs its own,
    // so calling refreshUniverse first as well would double the instrument, board
    // and spot-seed fetches on every startup.
    if (!this.marketOpen) {
      await this.refreshClosedMarketView().catch((err) =>
        console.warn("[Box] last-close view failed at boot:", err),
      );
    } else if (this.positions.size > 0) {
      await this.refreshUniverse().catch((err) =>
        console.warn("[Box] universe refresh failed at boot:", err),
      );
    }
    console.log(
      `[Box] engine ready — ${this.positions.size} open paper box position(s), ` +
        `entry gate ₹${requiredNetProfit(this.cfg)} EXPECTED NET after every cost ` +
        `(gross prefilter ₹${this.cfg.minGrossEdge})` +
        (this.cfg.minNetEdge > 0 ? ` (plus a ₹${this.cfg.minNetEdge} net floor)` : "") +
        `, safety ₹${this.cfg.safetyBuffer} (deducted inside that net figure), ` +
        `freshness ${this.cfg.quoteMaxAgeMs}ms, ATM±${this.strikeLevel} of max ±${this.cfg.strikesEachSide}, ` +
        `market ${this.marketOpen ? "OPEN" : "CLOSED"}.`,
    );
  }

  /** The active strikes-each-side level (1, 2 or 3). */
  getStrikeLevel(): 1 | 2 | 3 {
    return this.strikeLevel;
  }

  /**
   * Admin control: set how many strikes each side of ATM are monitored/traded.
   *
   * Only 1, 2 or 3 (never wider than the ATM ±3 cap). The change rebuilds every
   * strike window at the new width and re-derives the candidate set, so from this
   * point only boxes within ATM ±level are discovered and entered.
   *
   * OPEN POSITIONS ARE UNTOUCHED. They hold their own legs, their tokens stay
   * subscribed unconditionally, and the monitor manages and exits them exactly as
   * before — a leg now outside the narrower window keeps streaming and the trade
   * is unaffected. Only NEW discovery is constrained.
   */
  async setStrikeLevel(level: number): Promise<{ ok: boolean; level: 1 | 2 | 3; error?: string }> {
    const next = clampStrikeLevel(level);
    if (next === this.strikeLevel) return { ok: true, level: next };
    this.strikeLevel = next;
    this.forceWindowRebuild = true;
    console.log(`[Box] strike level set to ATM ±${next} — new discovery is limited to this window; open positions are unaffected.`);
    // Rebuild windows now if the feed is up; otherwise the next scheduled refresh
    // (or the next RUN) picks up the flag.
    //
    // The clear happens ONLY on the path that can rebuild. Clearing unconditionally
    // would empty the page when Zerodha is disconnected, with nothing able to
    // repopulate it — a control documented as affecting only new discovery should
    // not be able to blank the view.
    if (this.deps.kite.getAccessToken()) {
      try {
        // The published list describes the OLD window, so it has to go: leaving it
        // up would show boxes at strikes that are no longer monitored, which is
        // exactly the "nothing changes when I pick 2" symptom.
        this.scanner.clearOpportunities();
        await this.refreshUniverse();
        // Re-price the new candidate set immediately, so the change is visible at
        // once instead of on the next tick (market open) or the next 60s indicative
        // pass (market shut). With the exchange closed there are no ticks at all,
        // so without this the list would simply stay empty.
        if (this.marketOpen) this.scanner.refreshAll();
        else await this.refreshIndicative();
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    }
    this.publish();
    return { ok: true, level: next };
  }

  /* ------------------------------ live tuning ------------------------------ */

  /** The admin-tunable thresholds as they currently stand. */
  getTuning(): BoxTuning {
    return readTuning(this.cfg);
  }

  /**
   * Apply persisted admin thresholds over the env defaults at boot.
   *
   * Best-effort: an unreachable settings store leaves the env-configured values in
   * place rather than blocking the boot.
   */
  private async loadPersistedTuning(): Promise<void> {
    const saved = await loadBoxSettings();
    if (saved.size === 0) return;
    const patch: Partial<Record<keyof BoxTuning, unknown>> = {};
    for (const [field, key] of Object.entries(BOX_TUNING_KEYS) as [keyof BoxTuning, string][]) {
      const value = saved.get(key);
      if (value !== undefined) patch[field] = value;
    }
    const parsed = validateTuning(patch);
    if (!parsed.ok) {
      console.warn(`[Box] ignoring persisted settings — ${parsed.error}`);
      return;
    }
    this.applyTuning(parsed.values);
    console.log(
      `[Box] applied saved thresholds: entry gate ₹${this.cfg.minExpectedNetProfit}, ` +
        `safety ₹${this.cfg.safetyBuffer}.`,
    );
  }

  /**
   * Write validated tunables onto the live config.
   *
   * The gross prefilter is derived, never mutated in place. It is only ever a cheap
   * LOWER bound (see config.ts) and must under-state the real requirement: leaving
   * it at ₹1,200 while an admin lowered the gate to ₹800 would silently discard
   * boxes that now qualify, making the gate change look inert.
   *
   * It is recomputed from the CONFIGURED baseline every time, which makes this
   * idempotent: clamping in place would ratchet the prefilter down for the life of
   * the process, so lowering the gate to ₹800 and putting it back to ₹1,200 would
   * leave the prefilter at ₹800 — quietly running full qualification on candidates
   * it used to reject, and freezing that drifted number onto every later trade's
   * config snapshot.
   */
  private applyTuning(values: Partial<BoxTuning>): void {
    if (values.minExpectedNetProfit !== undefined) {
      this.cfg.minExpectedNetProfit = values.minExpectedNetProfit;
    }
    if (values.safetyBuffer !== undefined) {
      this.cfg.safetyBuffer = values.safetyBuffer;
    }
    this.cfg.minGrossEdge = Math.min(this.baseMinGrossEdge, requiredNetProfit(this.cfg));
  }

  /**
   * ADMIN control: set the entry gate and/or the safety buffer at runtime.
   *
   * Takes effect on the very next evaluation, and is persisted so it survives a
   * restart. Affects only which NEW boxes qualify:
   *
   *   - positions ALREADY OPEN are never re-judged. Their exit rules are driven by
   *     the edge they were entered on, and each carries the
   *     `scanner_config_snapshot` of the settings it was actually taken under, so
   *     yesterday's trades stay interpretable after today's change;
   *   - the safety buffer is deducted INSIDE the expected-net figure the gate tests
   *     (see math.ts), so raising it makes the gate strictly harder to clear —
   *     it is part of the decision, not merely a reported number.
   */
  async setTuning(
    patch: Partial<Record<keyof BoxTuning, unknown>>,
    /** Who made the change, for the append-only ledger (e.g. the admin role). */
    actor?: string,
  ): Promise<{ ok: true; tuning: BoxTuning } | { ok: false; code: number; error: string }> {
    const parsed = validateTuning(patch);
    if (!parsed.ok) return { ok: false, code: 400, error: parsed.error };

    const before = readTuning(this.cfg);
    this.applyTuning(parsed.values);

    // Persist AFTER applying but report a failure honestly: the admin must not be
    // told a threshold was saved when it will revert on the next restart. The live
    // values are rolled back so what is running matches what is stored — and
    // because applyTuning re-derives the prefilter from a fixed baseline, restoring
    // the two tunables restores the prefilter exactly too.
    try {
      const entries = new Map<string, number>();
      for (const [field, key] of Object.entries(BOX_TUNING_KEYS) as [keyof BoxTuning, string][]) {
        const value = parsed.values[field];
        if (value !== undefined) entries.set(key, value);
      }
      await saveBoxSettings(entries);
    } catch (err) {
      this.applyTuning(before);
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: 503, error: `Could not save the settings: ${message}` };
    }

    console.log(
      `[Box] thresholds updated${actor ? ` by ${actor}` : ""} — entry gate ` +
        `₹${before.minExpectedNetProfit} → ₹${this.cfg.minExpectedNetProfit}, safety ` +
        `₹${before.safetyBuffer} → ₹${this.cfg.safetyBuffer} ` +
        `(gross prefilter ₹${this.cfg.minGrossEdge}). ` +
        `New entries only — open positions are unaffected.`,
    );

    void appendBoxEvent({
      event: "SCANNER_CONFIG",
      candidate_key: "",
      underlying: "",
      expiry: "",
      lower_strike: 0,
      upper_strike: 0,
      lot_size: 0,
      quantity: 0,
      safety_buffer: this.cfg.safetyBuffer,
      detail:
        `min_expected_net_profit=${this.cfg.minExpectedNetProfit} ` +
        `safety_buffer=${this.cfg.safetyBuffer} min_gross_edge=${this.cfg.minGrossEdge}` +
        (actor ? ` by=${actor}` : ""),
    });

    // Re-price the published list so the new gate is reflected: an opportunity's
    // ELIGIBLE/WATCHING verdict is computed against it.
    //
    // NOT awaited on the closed-market path. The setting is already applied and
    // persisted, and repricing after hours means a whole-universe REST quote pass —
    // holding the admin's HTTP request open for it risks a proxy timeout reporting
    // failure for a change that in fact succeeded.
    if (this.marketOpen) {
      this.scanner.refreshAll();
    } else {
      void this.refreshIndicative().catch(() => {/* view only */});
    }
    this.publish();

    return { ok: true, tuning: readTuning(this.cfg) };
  }

  /** RUN: start discovering and opening new paper boxes. */
  async start(): Promise<{ ok: boolean; error?: string }> {
    if (!this.deps.kite.getAccessToken()) {
      return { ok: false, error: "Connect to Zerodha before starting the box scanner." };
    }
    if (!isBoxDbEnabled()) {
      return {
        ok: false,
        error: "Box persistence is not configured (set MONGODB_URI).",
      };
    }
    if (this.running) return { ok: true };

    this.running = true;
    this.startedAt = Date.now();
    this.lastError = null;
    this.scanner.setDiscovering(true);
    this.ensureFeed();
    this.startMarketWatch();

    try {
      await this.refreshUniverse();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }

    // Shut market: populate the last-close view straight away so pressing RUN
    // after hours still shows whatever opportunities existed at the close.
    if (!this.marketOpen) {
      await this.refreshIndicative().catch(() => {});
    }

    if (!this.universeTimer) {
      this.universeTimer = setInterval(() => {
        void this.refreshUniverse().catch((err) => {
          this.lastError = err instanceof Error ? err.message : String(err);
        });
      }, this.cfg.universeRefreshMs);
      this.universeTimer.unref?.();
    }

    void appendBoxEvent({
      event: "SCANNER_STARTED",
      candidate_key: "",
      underlying: "",
      expiry: "",
      lower_strike: 0,
      upper_strike: 0,
      lot_size: 0,
      quantity: 0,
      detail: `min_net_edge=${this.cfg.minNetEdge} safety=${this.cfg.safetyBuffer}`,
    });
    this.publish();
    return { ok: true };
  }

  /**
   * STOP: stop discovering/opening NEW boxes.
   *
   * Deliberately does NOT stop the monitor, does not drop open positions, and
   * does not release the feed while positions are open.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.stoppedAt = Date.now();
    this.scanner.setDiscovering(false);

    if (this.universeTimer) {
      clearInterval(this.universeTimer);
      this.universeTimer = null;
    }

    // Release everything except what the open positions still need.
    this.shrinkToOpenPositions();

    void appendBoxEvent({
      event: "SCANNER_STOPPED",
      candidate_key: "",
      underlying: "",
      expiry: "",
      lower_strike: 0,
      upper_strike: 0,
      lot_size: 0,
      quantity: 0,
      detail: `open_positions=${this.positions.size} (still monitored)`,
    });
    // shrinkToOpenPositions has just cleared the published list. With the market
    // shut, rebuild the read-only last-close view rather than leaving the operator
    // staring at an empty page until the next 60s pass.
    if (!this.marketOpen) {
      void this.refreshClosedMarketView().catch(() => {/* view only */});
    }
    this.publish();
  }

  /**
   * Keep the cached market-hours state current, and drive the last-close view
   * while the exchange is shut.
   *
   * The transition matters: on close the live books stop arriving, so the
   * indicative refresh takes over; on open it is dropped and the tick path
   * resumes as the only source of truth.
   */
  private startMarketWatch(): void {
    const sync = () => {
      // Feed health has to be re-evaluated on a timer as well as on a tick: going
      // FROM healthy TO dead is signalled precisely by ticks no longer arriving,
      // so nothing else would ever notice.
      const healthy = this.isFeedHealthy();
      if (healthy !== this.feedHealthy) {
        this.feedHealthy = healthy;
        this.scanner.setFeedHealthy(healthy);
        if (!healthy && this.marketOpen) {
          console.warn(
            `[Box] tick feed has gone quiet (>${this.cfg.feedMaxAgeMs}ms) — entries and automatic exits are paused until it recovers.`,
          );
        }
      }
      // Enrich any open position still missing its margin (adopted-on-restart
      // trades, or entries whose margin call had failed).
      this.backfillMissingMargins();
      const open = this.deps.isMarketOpen();
      if (open !== this.marketOpen) {
        this.marketOpen = open;
        this.scanner.setMarketOpen(open);
        console.log(
          `[Box] market ${open ? "OPEN — live executable prices" : "CLOSED — last-close view only, no entries"}.`,
        );
        if (open) {
          // Live books supersede the closing snapshot immediately.
          this.scanner.clearOpportunities();
          if (this.running) {
            this.scanner.refreshAll();
          } else {
            // Discard the indicative-only windows built while the market was shut.
            // They are priced from last close and nothing is streaming them, so
            // keeping them would leave stale closing prices on screen during live
            // hours — and leave candidates nothing will ever evaluate.
            this.shrinkToOpenPositions();
          }
        } else {
          void this.refreshClosedMarketView();
        }
      }
    };
    if (!this.marketTimer) {
      this.marketTimer = setInterval(sync, 15_000);
      this.marketTimer.unref?.();
    }
    if (!this.indicativeTimer) {
      // NOT gated on `running`. The last-close view is a read-only view of how the
      // session ended; refusing to build it unless discovery is on made the closing
      // prices unreachable precisely when they are the only prices there are.
      this.indicativeTimer = setInterval(() => {
        if (this.marketOpen) return;
        void this.refreshClosedMarketView();
      }, this.cfg.indicativeRefreshMs);
      this.indicativeTimer.unref?.();
    }
    sync();
  }

  /**
   * Build and price the last-close view while the exchange is shut.
   *
   * Two steps, because with the scanner stopped there may be nothing to price:
   * `refreshUniverse` places the strike windows (and with `indicativeDiscovery` on
   * it does so for the whole universe, not just underlyings carrying a position),
   * then `refreshIndicative` prices them from last traded prices over REST.
   *
   * Costs no feed subscription: see the subscription gating in refreshUniverse.
   */
  private async refreshClosedMarketView(): Promise<void> {
    if (this.marketOpen) return;
    if (!this.deps.kite.getAccessToken()) return;
    try {
      await this.refreshUniverse();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
    await this.refreshIndicative();
  }

  /**
   * Rebuild the opportunity list from LAST TRADED / CLOSING prices.
   *
   * Only ever runs while the market is shut. One REST /quote call per 500
   * instruments, so the whole monitored universe costs a handful of requests a
   * minute — and the result is explicitly marked `last_close`, so it can be read
   * but never traded.
   */
  async refreshIndicative(): Promise<void> {
    if (!this.deps.kite.getAccessToken()) return;
    // Price every leg of every monitored WINDOW, not just the tokens that happen to
    // be streaming. With discovery off the feed carries only open positions' legs,
    // so keying off subscriptions meant the last-close view could see almost
    // nothing — while the windows themselves were sitting right there. Position
    // legs are unioned in so a leg that has aged out of its window is still priced.
    const tokens = new Set<number>();
    for (const state of this.windows.values()) {
      for (const t of windowTokens(state)) tokens.add(t);
    }
    for (const t of this.subscribedOptionTokens) tokens.add(t);
    if (tokens.size === 0) return;
    try {
      const all = await this.deps.getAllInstruments();
      const resolve = this.deps.makeIdResolver(all);
      const ids = [...tokens]
        .map(resolve)
        .filter((s): s is string => typeof s === "string");
      if (ids.length === 0) return;
      // Chunked at 500 identifiers per request inside the client.
      const quotes = await this.deps.kite.getQuoteFull(ids);

      // Only legs that traded in the LATEST session may be compared.
      //
      // `last_price` is the price of the last trade, not "the close": a strike
      // that has not traded for days carries a price struck when the underlying
      // was somewhere else, and four legs each stale from a different session
      // produce a fictional edge. The session is derived from the data itself —
      // the newest trade date across the whole universe — so no holiday calendar
      // is needed and a long weekend resolves correctly.
      const sessionDay = quotes.reduce((latest, q) => {
        const day = q.last_trade_time.slice(0, 10);
        return day > latest ? day : latest;
      }, "");

      const lastPrices = new Map<number, number>();
      let stale = 0;
      for (const q of quotes) {
        if (!(q.last_price > 0)) continue;
        if (sessionDay && q.last_trade_time.slice(0, 10) !== sessionDay) {
          stale++;
          continue; // last traded in an earlier session — not comparable
        }
        lastPrices.set(q.instrument_token, q.last_price);
      }

      // The market may have OPENED while those REST round trips were in flight. A
      // whole-universe pass takes several requests, so one starting at 09:14:40 can
      // land after 09:15 — after the open transition has already cleared the list
      // for live books. Publishing here would put last-close prices on screen during
      // live hours, undoing the very handler meant to prevent that.
      if (this.marketOpen) {
        console.log("[Box] discarding a last-close pass that finished after the open.");
        return;
      }

      this.indicativeSessionDay = sessionDay || null;
      this.indicativeStaleLegs = stale;
      this.indicativePriced = this.scanner.publishIndicative(lastPrices);
      this.indicativeAt = Date.now();
      console.log(
        `[Box] last-close view: session ${sessionDay || "unknown"}, ` +
          `${lastPrices.size}/${quotes.length} legs traded in it (${stale} stale), ` +
          `${this.indicativePriced} box(es) with a coherent close.`,
      );
      // Push it out now. With the scanner stopped there is no publish loop running,
      // so without this the freshly priced view would sit unseen until something
      // else happened to publish.
      this.publish();
    } catch (err) {
      console.warn("[Box] indicative (last-close) refresh failed:", err);
    }
  }

  /** Attach to the shared feed (tick listener + retainer + publish loop). */
  private ensureFeed(): void {
    if (!this.removeTickListener) {
      this.removeTickListener = this.deps.tickerHub.addTickListener((ticks) =>
        this.onTicks(ticks),
      );
    }
    if (!this.releaseRetainer) {
      this.releaseRetainer = this.deps.tickerHub.retain();
    }
    if (!this.publishTimer) {
      this.publishTimer = setInterval(() => this.publish(), this.cfg.publishIntervalMs);
      this.publishTimer.unref?.();
    }
  }

  /** Let the feed go when neither discovery nor any open position needs it. */
  private maybeReleaseFeed(): void {
    if (this.running || this.positions.size > 0) return;
    if (this.releaseRetainer) {
      this.releaseRetainer();
      this.releaseRetainer = null;
    }
    if (this.removeTickListener) {
      this.removeTickListener();
      this.removeTickListener = null;
    }
    if (this.publishTimer && this.sseClients.size === 0) {
      clearInterval(this.publishTimer);
      this.publishTimer = null;
    }
  }

  /* --------------------------- market-data intake -------------------------- */

  /**
   * THE HOT PATH. Ticks land here from the shared WebSocket.
   *
   * Apply → find affected candidates → evaluate. No database, no HTTP, no
   * frontend round trip. The UI is updated separately on its own slow cadence.
   */
  private onTicks(ticks: Tick[]): void {
    const now = Date.now();
    // Underlying values first: the strike window depends on them.
    for (const t of ticks) {
      if (this.subscribedSpotTokens.has(t.token) && t.last_price > 0) {
        this.spots.set(t.token, t.last_price, now);
      }
      // Sample how far behind the exchange we are, when a packet carries an
      // exchange timestamp. It is a Unix SECOND, so the estimate is coarse (and
      // sensitive to any skew between our clock and the exchange's), hence it is
      // kept as a rolling distribution and clearly labelled approximate.
      if (t.exchange_ts && t.exchange_ts > 0) this.sampleExchangeLag(now - t.exchange_ts);
    }
    this.metrics.ticks.mark(ticks.length, now);
    const changed = this.quotes.applyTicks(ticks, now);
    if (changed.length > 0) {
      this.metrics.wsUpdates.mark(changed.length, now);
      // A tick arriving IS the feed-liveness signal, so the gate reopens here
      // rather than waiting for the next timer.
      if (!this.feedHealthy) {
        this.feedHealthy = true;
        this.scanner.setFeedHealthy(true);
      }
      // Open-position exits get first look at every changed WS book. This is the
      // primary exit path; the monitor timer is only a watchdog.
      this.monitor.onTokensUpdated(changed);
      this.scanner.onTokensUpdated(changed, now);
    }
  }

  /**
   * Whether the upstream feed is alive: has ANY book in the universe updated
   * recently?
   *
   * With hundreds of instruments subscribed something is always trading during
   * market hours, so silence across all of them means the connection is broken —
   * whereas one quiet strike means nothing at all.
   */
  private isFeedHealthy(): boolean {
    if (!this.marketOpen) return false;
    const at = this.quotes.lastUpdateAt;
    if (at === null) return false;
    return Date.now() - at <= this.cfg.feedMaxAgeMs;
  }

  /** Age (ms) of the newest tick anywhere in the box universe. */
  private feedAgeMs(): number | null {
    const at = this.quotes.lastUpdateAt;
    return at === null ? null : Date.now() - at;
  }

  /** Record one exchange-lag sample into the ring, clamping clock-skew negatives. */
  private sampleExchangeLag(lagMs: number): void {
    // A negative lag means our clock is behind the exchange's — clock skew, not a
    // real "arrived before it was sent". Clamp so it never flatters the figure.
    const v = lagMs < 0 ? 0 : lagMs;
    if (this.exchangeLagSamples.length < BoxEngine.EXCHANGE_LAG_WINDOW) {
      this.exchangeLagSamples.push(v);
    } else {
      this.exchangeLagSamples[this.exchangeLagCursor] = v;
      this.exchangeLagCursor = (this.exchangeLagCursor + 1) % BoxEngine.EXCHANGE_LAG_WINDOW;
    }
  }

  /**
   * The exchange-lag distribution, or null when no timestamped packet has been
   * seen yet.
   *
   * APPROXIMATE by construction: the exchange stamp is second-resolution and the
   * figure includes any skew between our clock and the exchange's. It answers
   * "roughly how far behind NSE is the book we are acting on", not a precise
   * network latency.
   */
  private exchangeLag(): {
    median_ms: number;
    p95_ms: number;
    last_ms: number;
    samples: number;
  } | null {
    const n = this.exchangeLagSamples.length;
    if (n === 0) return null;
    const sorted = [...this.exchangeLagSamples].sort((a, b) => a - b);
    const at = (frac: number) => sorted[Math.min(n - 1, Math.floor(frac * n))]!;
    return {
      median_ms: at(0.5),
      p95_ms: at(0.95),
      // Newest sample: the most recently written ring slot.
      last_ms:
        n < BoxEngine.EXCHANGE_LAG_WINDOW
          ? this.exchangeLagSamples[n - 1]!
          : this.exchangeLagSamples[
              (this.exchangeLagCursor - 1 + BoxEngine.EXCHANGE_LAG_WINDOW) %
                BoxEngine.EXCHANGE_LAG_WINDOW
            ]!,
      samples: n,
    };
  }

  /* ------------------------------- universe ------------------------------- */

  /**
   * Rebuild the scanned universe: nearest live expiry per underlying, the ATM
   * ±(active level) window, its candidate strike pairs, and the subscription set.
   *
   * Windows are only re-centred when the underlying has genuinely drifted (see
   * windowNeedsRebuild), so this can run on a timer without churning
   * subscriptions.
   *
   * TWO REASONS a window gets built, and they are not the same thing:
   *   - to STREAM (discovery is on, or the underlying carries an open position):
   *     costs a slice of the subscription budget;
   *   - to LOOK AT while the exchange is shut (`indicativeDiscovery`): priced from
   *     last-close prices over REST and subscribed to nothing.
   */
  async refreshUniverse(): Promise<void> {
    if (!this.deps.kite.getAccessToken()) return;
    const now = Date.now();
    const today = this.deps.istDayKey();

    const [all, board] = await Promise.all([
      this.deps.getAllInstruments(),
      this.deps.getBoard(),
    ]);
    this.chains = indexOptionChains(all, today);
    this.board = prioritiseUniverse(board.filter((b) => this.chains.has(b.symbol)));

    // Underlyings of open positions must always be in the universe, whatever the
    // budget says, so their legs keep streaming.
    const mustKeep = new Set(this.positions.list().map((p) => p.underlying));

    // Seed the spot values we do not have yet, so a first window can be placed.
    await this.seedSpots(all);

    const budget = this.cfg.maxSubscribedTokens;
    const wantOption = new Set<number>();
    const wantSpot = new Set<number>();
    const skipped: string[] = [];
    /** Underlyings that have a live window after this pass (subscribed or not). */
    const liveWindows = new Set<string>();
    let used = 0;

    /**
     * Whether windows are built for the whole universe.
     *
     * True while discovering, and ALSO while the market is shut with
     * `indicativeDiscovery` on: with the exchange closed the windows are wanted
     * purely to be priced from last-close prices and looked at, which costs REST
     * calls but no feed subscription (see the gating below).
     */
    const discoveryAllowed =
      this.running || (!this.marketOpen && this.cfg.indicativeDiscovery);
    /** True when a window is wanted for STREAMING, not merely for the closed view. */
    const streams = (symbol: string): boolean => this.running || mustKeep.has(symbol);
    /**
     * Indicative-only windows built this pass, against their own cap.
     *
     * They spend none of the subscription budget, so `budget` does not bound them.
     * Without this counter a stopped engine after hours would hold a window and a
     * full candidate set for every underlying with a chain, and re-quote the lot
     * every minute until the market opened.
     */
    const indicativeCap = this.cfg.indicativeMaxUnderlyings;
    let indicativeUsed = 0;

    const ordered = [
      ...this.board.filter((b) => mustKeep.has(b.symbol)),
      ...this.board.filter((b) => !mustKeep.has(b.symbol)),
    ];
    const cap =
      this.cfg.maxUnderlyings > 0 ? Math.min(this.cfg.maxUnderlyings, ordered.length) : ordered.length;

    for (const [i, item] of ordered.entries()) {
      if (i >= cap && !mustKeep.has(item.symbol)) {
        skipped.push(item.symbol);
        continue;
      }
      const chain = this.chains.get(item.symbol);
      if (!chain) continue;

      const spot = this.spots.get(item.spot_token);
      const existing = this.windows.get(item.symbol);

      // Nothing wants this underlying: discovery is off (and the market is open, so
      // there is no closed view to build) and it carries no position.
      if (!discoveryAllowed && !mustKeep.has(item.symbol)) continue;

      let state = existing;
      const needsBuild =
        // A strike-level change forces every window to rebuild at the new width.
        this.forceWindowRebuild ||
        !state ||
        state.expiry !== chain.expiry ||
        (spot !== undefined &&
          windowNeedsRebuild({
            state,
            spot: spot.value,
            now,
            hysteresis: this.cfg.atmHysteresis,
            minIntervalMs: this.cfg.windowMinIntervalMs,
          }));

      if (needsBuild && spot !== undefined) {
        const built = buildUnderlyingState({
          board: item,
          chain,
          spot: spot.value,
          spotAt: spot.at,
          // The ACTIVE admin-selected level, never above the ATM ±3 cap.
          eachSide: this.strikeLevel,
          now,
        });
        if (built) state = built;
      }
      if (!state) continue;

      const tokens = windowTokens(state);
      // The budget counts the option legs plus the one underlying we need to keep
      // the window centred. It is a SUBSCRIPTION budget, so it only binds windows
      // that will actually stream — an indicative-only window costs no slot.
      const cost = tokens.length + 1;
      if (streams(item.symbol)) {
        if (used + cost > budget && !mustKeep.has(item.symbol)) {
          skipped.push(item.symbol);
          continue;
        }
        used += cost;
      } else {
        // Indicative-only: bounded by its own cap, not by the token budget.
        if (indicativeCap > 0 && indicativeUsed >= indicativeCap) {
          skipped.push(item.symbol);
          continue;
        }
        indicativeUsed++;
      }
      liveWindows.add(item.symbol);

      if (state !== existing) {
        this.windows.set(item.symbol, state);
        this.scanner.setCandidatesForUnderlying(
          item.symbol,
          buildCandidates({
            underlying: state.underlying,
            name: state.name,
            is_index: state.is_index,
            expiry: state.expiry,
            lot_size: state.lot_size,
            strikes: state.strikes,
            ce: state.ce,
            pe: state.pe,
            directions: this.directions,
          }),
        );
      }
      // Only stream what is actually being traded or monitored. An indicative
      // window built for the closed-market view is priced over REST, so it must not
      // put the hub anywhere near its subscription budget — and must not still be
      // subscribed when the market reopens with discovery still off.
      if (streams(item.symbol)) {
        for (const t of tokens) wantOption.add(t);
        wantSpot.add(item.spot_token);
      }
    }

    // Open positions' legs are subscribed unconditionally.
    for (const t of this.positions.tokens()) wantOption.add(t);

    // The forced rebuild (from a strike-level change) has now been applied.
    this.forceWindowRebuild = false;
    this.skippedForBudget = skipped;
    this.universeBuiltAt = now;
    this.applySubscriptions(wantOption, wantSpot);
    // Windows that dropped out of the universe must stop producing candidates.
    // Keyed on what this pass actually built, NOT on the subscription set: an
    // indicative window is deliberately unsubscribed, and testing `wantSpot` would
    // therefore delete every window the closed-market view had just placed.
    for (const underlying of [...this.windows.keys()]) {
      if (liveWindows.has(underlying) || mustKeep.has(underlying)) continue;
      this.windows.delete(underlying);
      this.scanner.removeUnderlying(underlying);
    }
    this.charges.prune();
  }

  /**
   * Fetch the underlying values we are missing.
   *
   * Index spot instruments have no market depth, so the WebSocket alone can take
   * a while to place a first window; one REST call gets every window opened
   * immediately.
   */
  private async seedSpots(all: Instrument[]): Promise<void> {
    const missing = this.board
      .filter((b) => this.spots.get(b.spot_token) === undefined)
      .slice(0, 500);
    if (missing.length === 0) return;
    const resolve = this.deps.makeIdResolver(all);
    const ids = missing
      .map((b) => resolve(b.spot_token))
      .filter((s): s is string => typeof s === "string");
    if (ids.length === 0) return;
    try {
      const quotes = await this.deps.kite.getQuoteFull(ids);
      const at = Date.now();
      const bySymbol = new Map(quotes.map((q) => [q.instrument_token, q]));
      for (const b of missing) {
        const q = bySymbol.get(b.spot_token);
        if (q && q.last_price > 0) this.spots.set(b.spot_token, q.last_price, at);
      }
    } catch (err) {
      console.warn("[Box] spot seed failed:", err);
    }
  }

  /** Reconcile the hub subscription with what the engine now wants. */
  private applySubscriptions(wantOption: Set<number>, wantSpot: Set<number>): void {
    const toAdd: number[] = [];
    for (const t of wantOption) if (!this.subscribedOptionTokens.has(t)) toAdd.push(t);
    for (const t of wantSpot) if (!this.subscribedSpotTokens.has(t)) toAdd.push(t);

    const toDrop: number[] = [];
    for (const t of this.subscribedOptionTokens) if (!wantOption.has(t)) toDrop.push(t);
    for (const t of this.subscribedSpotTokens) if (!wantSpot.has(t)) toDrop.push(t);

    this.subscribedOptionTokens = wantOption;
    this.subscribedSpotTokens = wantSpot;

    if (toAdd.length > 0) this.deps.tickerHub.subscribeTokens(toAdd);
    if (toDrop.length > 0) {
      this.deps.tickerHub.unsubscribeTokens(toDrop);
      this.quotes.forget(toDrop);
    }
  }

  /** After STOP: keep only what the open positions need. */
  private shrinkToOpenPositions(): void {
    const keepUnderlyings = new Set(this.positions.list().map((p) => p.underlying));
    for (const underlying of [...this.windows.keys()]) {
      if (keepUnderlyings.has(underlying)) continue;
      this.windows.delete(underlying);
      this.scanner.removeUnderlying(underlying);
    }
    this.scanner.clearOpportunities();

    const wantOption = new Set<number>(this.positions.tokens());
    const wantSpot = new Set<number>();
    for (const underlying of keepUnderlyings) {
      const w = this.windows.get(underlying);
      if (w) wantSpot.add(w.spot_token);
    }
    this.applySubscriptions(wantOption, wantSpot);
    this.maybeReleaseFeed();
  }

  /* ------------------------------ paper fills ------------------------------ */

  /**
   * Create the paper trade.
   *
   * PAPER ONLY: no Zerodha order-placement API is called anywhere in this path.
   * The fills recorded are the executable touch prices that were visible in the
   * revalidated snapshot.
   */
  /**
   * Persist a paper_legging execution ATTEMPT that did not open a box.
   *
   * A failed four-leg execution can itself cost money (partial fill + emergency
   * unwind), so it must not vanish as though nothing happened. Stored in its own
   * `box_execution_attempts` collection — never mixed into `box_trades` — so the
   * strategy's true P&L can later net successful boxes against abort losses.
   */
  private async persistExecutionAttempt(
    candidate: BoxCandidate,
    legging: PaperLeggingExecutionRecord,
    reason: BoxExecutionFailureReason,
    detail: string,
  ): Promise<void> {
    const direction = candidate.direction ?? "LONG_BOX";
    const grossAbort = legging.legging_gross_loss ?? null;
    const netAbort = legging.legging_net_loss ?? null;
    const attempt: IBoxExecutionAttempt = {
      candidate_key: candidate.key,
      direction,
      underlying: candidate.underlying,
      name: candidate.name,
      is_index: candidate.is_index,
      expiry: candidate.expiry,
      lower_strike: candidate.lower_strike,
      upper_strike: candidate.upper_strike,
      lot_size: candidate.lot_size,
      quantity: candidate.lot_size,
      execution_mode: "paper_legging",
      leg_execution_mode: legging.leg_execution_mode,
      detected_at: new Date(legging.detected_at),
      resolved_at: new Date(),
      detected_gross_edge: null,
      // The economics recomputed on the EXECUTED prices, and the gate they were
      // tested against — so an abort can be sized rather than guessed at.
      expected_net_profit: legging.final_expected_net_profit,
      required_expected_net_profit: legging.required_expected_net_profit,
      abort_after_fill: legging.abort_after_fill,
      charge_rate_version: this.localCharges.rates.rateVersion,
      filled_leg_count: legging.filled_leg_count,
      failed_legs: legging.failed_legs,
      failure_reason: reason,
      failure_detail: detail,
      legging,
      partial_entry_charges: legging.partial_entry_charges,
      unwind_charges: legging.unwind_charges,
      gross_abort_pnl: grossAbort,
      net_abort_pnl: netAbort,
    };
    await insertBoxExecutionAttempt(attempt);

    void appendBoxEvent({
      event: "EXECUTION_ABORTED",
      candidate_key: candidate.key,
      underlying: candidate.underlying,
      expiry: candidate.expiry,
      direction,
      lower_strike: candidate.lower_strike,
      upper_strike: candidate.upper_strike,
      lot_size: candidate.lot_size,
      quantity: candidate.lot_size,
      execution_mode: "paper_legging",
      net_pnl: netAbort,
      gross_pnl: grossAbort,
      reason,
      detail: `${detail} — legging net loss ₹${netAbort ?? 0}`,
    });

    console.log(
      `[Box] ${legging.abort_after_fill ? "ABORT AFTER FILL" : "LEGGING ABORT"} ` +
        `${directionLabel(direction)} ${candidate.underlying} ` +
        `${candidate.lower_strike}→${candidate.upper_strike}: ${legging.filled_leg_count}/4 filled, ` +
        `net loss ₹${netAbort ?? 0} (${reason})` +
        (legging.abort_after_fill
          ? ` — executed net ₹${legging.final_expected_net_profit ?? "?"} < required ₹${legging.required_expected_net_profit ?? "?"}`
          : ""),
    );
    this.broadcast("execution_attempt", { attempt });
  }

  private async openPaperTrade(args: {
    candidate: BoxCandidate;
    evaluation: BoxEvaluation;
    entryLegs: BoxChargeLeg[];
    entryChargesTotal: number | null;
    estimatedExitChargesTotal: number | null;
    chargeOrigin: BoxChargesWithOrigin["computed_by"];
    decision: BoxEntryDecision;
    execution: BoxExecutionRecord | null;
    legging?: PaperLeggingExecutionRecord | null;
  }): Promise<string | null> {
    const { candidate, evaluation, decision, execution } = args;
    const direction = candidate.direction ?? "LONG_BOX";
    const byRole = new Map(evaluation.legs.map((l) => [l.role, l]));
    const execByRole = new Map((execution?.legs ?? []).map((l) => [l.role, l]));
    // Total measured entry slippage for the log/ledger — from the latency record
    // or the legging record, whichever produced this fill.
    const entrySlippageForLog = execution?.total_slippage ?? args.legging?.total_entry_slippage ?? 0;

    // The local contract note for the executed fills, and its reversed projection.
    const orders = args.entryLegs.map((l) => ({
      side: l.side,
      tradingsymbol: l.tradingsymbol,
      quantity: l.quantity,
      price: l.price,
    }));
    const localRoundTrip = this.localCharges.roundTrip(orders);

    const legs: IBoxLeg[] = [];
    for (const role of BOX_LEG_ROLES) {
      const ev = byRole.get(role);
      const inst = candidate.legs[role];
      if (!ev || ev.price === null) return null;
      const execLeg = execByRole.get(role);
      legs.push({
        role,
        token: inst.token,
        tradingsymbol: inst.tradingsymbol,
        exchange: inst.exchange,
        strike: inst.strike,
        instrument_type: inst.instrument_type,
        side: entrySideFor(role, direction),
        entry_price: round2(ev.price),
        entry_bid: ev.bid,
        entry_bid_qty: ev.bid_qty,
        entry_ask: ev.ask,
        entry_ask_qty: ev.ask_qty,
        entry_quote_at: ev.quote_at === null ? null : new Date(ev.quote_at),
        entry_depth: ev.depth ?? null,
        detected_price: execLeg?.detected_price ?? null,
        entry_slippage: execLeg?.slippage ?? null,
        exit_price: null,
        exit_bid: null,
        exit_bid_qty: null,
        exit_ask: null,
        exit_ask_qty: null,
        exit_quote_at: null,
        exit_depth: null,
        exit_detected_price: null,
        exit_slippage: null,
      });
    }

    const costPerUnit = evaluation.entry_net_debit_per_unit!;
    // The recorded net edge is the expected NET profit the entry qualified on.
    const recordedNetEdge =
      decision.expected_net_profit ?? round2(evaluation.gross_edge! - this.cfg.safetyBuffer);
    const payload: IBoxTrade = {
      execution_mode: this.cfg.executionMode,
      underlying: candidate.underlying,
      name: candidate.name,
      is_index: candidate.is_index,
      expiry: candidate.expiry,
      direction,
      lower_strike: candidate.lower_strike,
      upper_strike: candidate.upper_strike,
      lot_size: candidate.lot_size,
      quantity: candidate.lot_size,
      status: "open",
      legs,
      box_width: candidate.box_width,
      margin: null,
      entry_box_cost: round2(costPerUnit * candidate.lot_size),
      entry_gross_edge: evaluation.gross_edge!,
      entry_charges: localRoundTrip.entry,
      estimated_exit_charges: localRoundTrip.estimated_exit,
      safety_buffer: this.cfg.safetyBuffer,
      entry_net_edge: recordedNetEdge,
      expected_net_profit: decision.expected_net_profit,
      entry_execution_cost: decision.execution_cost,
      charge_origin: args.chargeOrigin ?? "local",
      // Stamp the rate card so this trade stays interpretable after statutory rates
      // change (option STT moved on 1 April 2026).
      charge_rate_version: this.localCharges.rates.rateVersion,
      entry_charge_reconciliation: {
        status: "pending",
        local_total: localRoundTrip.entry_total,
        reconciled_total: null,
        abs_diff: null,
        pct_diff: null,
        at: null,
        error: null,
      },
      exit_charge_reconciliation: null,
      entry_execution: execution,
      entry_legging: args.legging ?? null,
      exit_execution: null,
      opened_at: new Date(),
      current_remaining_edge: evaluation.gross_edge,
      current_captured_edge: 0,
      current_captured_pct: 0,
      exit_box_value: null,
      exit_charges: null,
      gross_pnl: null,
      total_charges: null,
      net_pnl: null,
      closed_at: null,
      exit_reason: null,
      exit_blocked_reason: null,
      expiry_safety: false,
      scanner_config_snapshot: configSnapshot(this.cfg),
      error: null,
    };

    const doc = await insertBoxTrade(payload);
    if (!doc) {
      // The unique partial index refused it: this box is already open.
      return null;
    }
    const id = doc._id.toString();

    const entryPrices = {} as Record<BoxLegRole, number>;
    for (const l of legs) entryPrices[l.role] = l.entry_price;

    const position: BoxOpenPosition = {
      id,
      key: candidate.key,
      underlying: candidate.underlying,
      name: candidate.name,
      is_index: candidate.is_index,
      expiry: candidate.expiry,
      direction,
      lower_strike: candidate.lower_strike,
      upper_strike: candidate.upper_strike,
      box_width: candidate.box_width,
      lot_size: candidate.lot_size,
      quantity: candidate.lot_size,
      entry_box_cost_per_unit: costPerUnit,
      entry_gross_edge: evaluation.gross_edge!,
      entry_net_edge: recordedNetEdge,
      entry_charges_total: localRoundTrip.entry_total,
      estimated_exit_charges_total: localRoundTrip.estimated_exit_total,
      safety_buffer: this.cfg.safetyBuffer,
      expected_net_profit: decision.expected_net_profit,
      entry_execution_cost: decision.execution_cost,
      charge_origin: args.chargeOrigin ?? "local",
      entry_execution: execution,
      margin: null,
      opened_at: Date.now(),
      legs: candidate.legs,
      entry_prices: entryPrices,
      metrics: null,
      exit_blocked_reason: null,
      expiry_safety: false,
      closing: false,
      last_persist_at: Date.now(),
      config: configSnapshot(this.cfg),
    };
    this.positions.add(position);

    // Margin is captured AFTER the fill is recorded, off the hot path.
    void this.captureMargin(id, candidate.legs, candidate.lot_size, candidate.key, direction);

    // Verify the local entry charges against Zerodha — asynchronously, never
    // blocking the fill and never hammering the API.
    this.reconciler.submit({
      tradeId: id,
      phase: "entry",
      localTotal: localRoundTrip.entry_total,
      legs: args.entryLegs,
      localCharges: localRoundTrip.entry,
      label: `${candidate.underlying} ${candidate.lower_strike}→${candidate.upper_strike} ${direction}`,
    });

    void appendBoxEvent({
      event: "ENTRY",
      trade_id: id,
      candidate_key: candidate.key,
      underlying: candidate.underlying,
      expiry: candidate.expiry,
      direction,
      lower_strike: candidate.lower_strike,
      upper_strike: candidate.upper_strike,
      lot_size: candidate.lot_size,
      quantity: candidate.lot_size,
      execution_mode: this.cfg.executionMode,
      box_width: candidate.box_width,
      box_cost: round2(costPerUnit * candidate.lot_size),
      gross_edge: evaluation.gross_edge,
      entry_charges_total: localRoundTrip.entry_total,
      exit_charges_total: localRoundTrip.estimated_exit_total,
      safety_buffer: this.cfg.safetyBuffer,
      net_edge: recordedNetEdge,
      expected_net_profit: decision.expected_net_profit,
      execution_cost: decision.execution_cost,
      execution,
      legs: toEventLegs(evaluation.legs),
      reason: `${this.cfg.executionMode} fill; expected net ₹${decision.expected_net_profit}`,
      detail: `1 lot (${candidate.lot_size} qty), slippage ₹${entrySlippageForLog}`,
    });

    console.log(
      `[Box] PAPER ENTRY ${directionLabel(direction)} ${candidate.underlying} ` +
        `${candidate.lower_strike}→${candidate.upper_strike} ${candidate.expiry} ` +
        `gross ₹${evaluation.gross_edge} expected-net ₹${decision.expected_net_profit} ` +
        `(slippage ₹${entrySlippageForLog})`,
    );
    this.broadcast("entry", { trade: serializeBoxTrade(doc) });
    return id;
  }

  /** Persist a paper exit at the executed touch. */
  private async closePaperTrade(args: {
    position: BoxOpenPosition;
    metrics: BoxExitMetrics;
    exitCharges: BoxChargesWithOrigin | null;
    reason: BoxExitReason;
    execution: BoxExecutionRecord | null;
  }): Promise<boolean> {
    const { position, metrics, exitCharges, reason, execution } = args;
    const byRole = new Map(metrics.legs.map((l) => [l.role, l]));
    const execByRole = new Map((execution?.legs ?? []).map((l) => [l.role, l]));

    const exitChargesTotal = exitCharges ? round2(exitCharges.total) : metrics.estimated_exit_charges;
    const totalCharges =
      position.entry_charges_total === null || exitChargesTotal === null
        ? null
        : round2(position.entry_charges_total + exitChargesTotal);
    const grossPnl = metrics.gross_pnl_if_closed_now;
    const netPnl =
      grossPnl === null || totalCharges === null ? null : round2(grossPnl - totalCharges);

    // Only the exit half of each leg is written, so the stored entry snapshot
    // (which is an execution record) is never overwritten.
    const setFields: Record<string, unknown> = {
      status: "closed",
      closed_at: new Date(),
      exit_reason: reason,
      exit_box_value: metrics.exit_box_value,
      exit_charges: exitCharges,
      exit_execution: execution,
      exit_charge_reconciliation: exitCharges
        ? {
            status: "pending",
            local_total: round2(exitCharges.total),
            reconciled_total: null,
            abs_diff: null,
            pct_diff: null,
            at: null,
            error: null,
          }
        : null,
      gross_pnl: grossPnl,
      total_charges: totalCharges,
      net_pnl: netPnl,
      // The REALISED net: actual simulated gross from the recorded fills minus
      // actual charges. No expected-slippage allowance — that forward estimate
      // is gone now the real exit price is known (Task 6).
      realised_net_pnl: netPnl,
      current_remaining_edge: metrics.remaining_edge,
      current_captured_edge: metrics.captured_edge,
      current_captured_pct: metrics.captured_pct,
      exit_blocked_reason: null,
    };
    // Track how far the eventual realised net landed from the expected net at
    // entry — the honest measure of the projection's quality.
    if (netPnl !== null && position.expected_net_profit !== null && position.expected_net_profit !== undefined) {
      this.metrics.recordRealisedVsExpected(round2(position.expected_net_profit - netPnl));
    }
    for (const [i, role] of BOX_LEG_ROLES.entries()) {
      const ev = byRole.get(role);
      const execLeg = execByRole.get(role);
      setFields[`legs.${i}.exit_price`] = ev?.price ?? null;
      setFields[`legs.${i}.exit_bid`] = ev?.bid ?? null;
      setFields[`legs.${i}.exit_bid_qty`] = ev?.bid_qty ?? null;
      setFields[`legs.${i}.exit_ask`] = ev?.ask ?? null;
      setFields[`legs.${i}.exit_ask_qty`] = ev?.ask_qty ?? null;
      setFields[`legs.${i}.exit_quote_at`] = ev?.quote_at ? new Date(ev.quote_at) : null;
      setFields[`legs.${i}.exit_depth`] = ev?.depth ?? null;
      setFields[`legs.${i}.exit_detected_price`] = execLeg?.detected_price ?? null;
      setFields[`legs.${i}.exit_slippage`] = execLeg?.slippage ?? null;
    }

    const closed = await closeBoxTrade(position.id, setFields as never);
    if (!closed) return false;

    this.positions.remove(position.id);
    this.marginBackfillTries.delete(position.id);

    // Fold the realised result into the running day-P&L tally.
    this.rollClosedTodayDay();
    this.closedTodayCount++;
    this.closedTodayNet += netPnl ?? 0;
    this.closedTodayGross += grossPnl ?? 0;
    if (position.margin === null || position.margin === undefined) this.closedTodayMarginUnknown++;
    else this.closedTodayMargin += position.margin;

    const serialized = serializeBoxTrade(closed);
    // Add to today's fast list and mirror it, so the Closed-trades tab shows this
    // trade instantly and keeps showing it across a restart without a full-book
    // Mongo query. The audit blobs are stripped for both: the list never renders
    // them, and holding a session's worth of depth ladders in memory would cost
    // tens of MB for data nothing reads. Fire-and-forget on Redis — the trade is
    // already durably in Mongo, so a cache failure costs only the acceleration.
    const lite = liteClosedTrade(serialized);
    this.recordClosedToday(lite);
    void this.closedCache
      .writeTrade(this.closedTodayDay, lite)
      .catch(() => {/* best-effort accelerator */});

    // Verify the exit charges asynchronously, exactly like the entry.
    if (exitCharges) {
      const exitOrders: BoxChargeLeg[] = metrics.legs
        .filter((l) => l.price !== null && l.price > 0)
        .map((l) => ({
          side: l.side,
          token: l.token,
          expiry: position.expiry,
          tradingsymbol: l.tradingsymbol,
          exchange: position.legs[l.role].exchange,
          quantity: position.quantity,
          price: round2(l.price!),
        }));
      if (exitOrders.length === BOX_LEG_ROLES.length) {
        this.reconciler.submit({
          tradeId: position.id,
          phase: "exit",
          localTotal: round2(exitCharges.total),
          legs: exitOrders,
          localCharges: exitCharges,
          label: `${position.underlying} ${position.lower_strike}→${position.upper_strike}`,
        });
      }
    }

    void appendBoxEvent({
      event: "EXIT",
      trade_id: position.id,
      candidate_key: position.key,
      underlying: position.underlying,
      expiry: position.expiry,
      direction: position.direction ?? "LONG_BOX",
      lower_strike: position.lower_strike,
      upper_strike: position.upper_strike,
      lot_size: position.lot_size,
      quantity: position.quantity,
      execution_mode: this.cfg.executionMode,
      box_width: position.box_width,
      box_cost: round2(position.entry_box_cost_per_unit * position.lot_size),
      gross_edge: position.entry_gross_edge,
      entry_charges_total: position.entry_charges_total,
      exit_charges_total: exitChargesTotal,
      safety_buffer: position.safety_buffer,
      net_edge: position.entry_net_edge,
      gross_pnl: grossPnl,
      net_pnl: netPnl,
      remaining_edge: metrics.remaining_edge,
      captured_edge: metrics.captured_edge,
      captured_pct: metrics.captured_pct,
      execution,
      legs: toEventLegs(metrics.legs),
      reason,
      detail: `${this.cfg.executionMode} exit — ${reason} (slippage ₹${execution?.total_slippage ?? 0})`,
    });

    console.log(
      `[Box] PAPER EXIT ${directionLabel(position.direction ?? "LONG_BOX")} ${position.underlying} ` +
        `${position.lower_strike}→${position.upper_strike} ${reason} net ₹${netPnl ?? "?"}`,
    );
    this.broadcast("exit", { trade: serialized });
    this.maybeReleaseFeed();
    return true;
  }

  /**
   * Fetch the net basket margin for the four legs and patch it onto the live
   * position and the stored document.
   *
   * Deliberately off the entry critical path: it runs after the trade exists, so
   * its network latency never delays the fill. Best-effort — a failure just
   * leaves margin null, exactly like the calendar trade.
   */
  private async captureMargin(
    id: string,
    legs: Record<BoxLegRole, BoxOptionInstrument>,
    lotSize: number,
    key: string,
    direction: BoxDirection = "LONG_BOX",
  ): Promise<void> {
    if (this.marginInFlight.has(id)) return;
    this.marginInFlight.add(id);
    // The sides depend on the direction: a short box blocks a different basket
    // margin from a long box on the same strikes.
    const orders = BOX_LEG_ROLES.map((role) => ({
      exchange: legs[role].exchange,
      tradingsymbol: legs[role].tradingsymbol,
      transaction_type: entrySideFor(role, direction),
      variety: "regular",
      product: "NRML",
      order_type: "MARKET",
      quantity: lotSize,
      price: 0,
    }));

    // Retry a few times: the margin API can transiently 5xx or rate-limit, and a
    // single failure used to leave margin permanently blank. The trade already
    // exists, so this is pure enrichment — retrying is safe.
    const MAX_ATTEMPTS = 4;
    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const res = await this.deps.getBasketMargin(orders);
          // Accept whatever the API returns, INCLUDING a small or zero figure: a
          // long box is a hedged position, so Zerodha's position-aware margin can
          // legitimately be low. Only a thrown error (network / auth / rate
          // limit) is a miss worth retrying — a successful small number is real.
          if (!Number.isFinite(res.total)) {
            throw new Error(`basket margin returned a non-numeric total`);
          }
          const margin = Math.max(0, Math.round(res.total));
          const pos = this.positions.get(id);
          if (pos) pos.margin = margin;
          await setBoxTradeMargin(id, margin);
          if (attempt > 1) {
            console.log(`[Box] margin for ${key} captured on attempt ${attempt}: ₹${margin}`);
          }
          return;
        } catch (err) {
          const last = attempt === MAX_ATTEMPTS;
          console.warn(
            `[Box] basket margin fetch failed for ${key} (attempt ${attempt}/${MAX_ATTEMPTS})${last ? " — will retry later on the backfill sweep" : ", retrying"}:`,
            err instanceof Error ? err.message : err,
          );
          if (last) return;
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
    } finally {
      this.marginInFlight.delete(id);
    }
  }

  /**
   * Fill in margin for any open position that still lacks it.
   *
   * Covers three cases the entry-time capture misses: a trade adopted from a
   * previous process (opened before margin existed), an entry whose margin call
   * failed every retry, and a session that only came up after entry. Runs on the
   * slow market-watch timer, so it is nowhere near the hot path.
   *
   * BOUNDED per position. The market-watch timer now runs from boot rather than
   * only while scanning, so an unbackfillable position (a delisted leg, say) would
   * otherwise re-attempt its four-try margin call every 15 seconds for the entire
   * life of the process. Margin is enrichment, not a trading input — after a few
   * rounds it is left null and reported as unknown.
   */
  private backfillMissingMargins(): void {
    if (!this.deps.kite.getAccessToken()) return;
    for (const pos of this.positions.list()) {
      if (pos.margin !== null) continue;
      if (this.marginInFlight.has(pos.id)) continue;
      const tried = this.marginBackfillTries.get(pos.id) ?? 0;
      if (tried >= BoxEngine.MAX_MARGIN_BACKFILLS) continue;
      this.marginBackfillTries.set(pos.id, tried + 1);
      void this.captureMargin(pos.id, pos.legs, pos.lot_size, pos.key, pos.direction ?? "LONG_BOX");
    }
  }

  /** Manual close from the API. */
  async closeManually(id: string) {
    return this.monitor.closeManually(id);
  }

  /* --------------------------- restart adoption ---------------------------- */

  /** Re-adopt boxes that were open before a restart so they stay managed. */
  private async adoptOpenPositions(): Promise<void> {
    const open = await loadOpenBoxTrades();
    if (open.length === 0) return;
    for (const doc of open) {
      const legs = {} as Record<BoxLegRole, BoxOptionInstrument>;
      const entryPrices = {} as Record<BoxLegRole, number>;
      let complete = true;
      for (const role of BOX_LEG_ROLES) {
        const l = doc.legs.find((x) => x.role === role);
        if (!l) {
          complete = false;
          break;
        }
        legs[role] = {
          token: l.token,
          tradingsymbol: l.tradingsymbol,
          exchange: l.exchange,
          strike: l.strike,
          instrument_type: l.instrument_type,
          expiry: doc.expiry,
          lot_size: doc.lot_size,
        };
        entryPrices[role] = l.entry_price;
      }
      if (!complete) {
        console.warn("[Box] skipping malformed open trade", doc._id.toString());
        continue;
      }
      this.positions.add({
        id: doc._id.toString(),
        key: tradeKey(doc),
        underlying: doc.underlying,
        name: doc.name,
        is_index: doc.is_index,
        expiry: doc.expiry,
        // Old documents carry no direction; directionOf() resolves them to LONG_BOX.
        direction: directionOf(doc),
        lower_strike: doc.lower_strike,
        upper_strike: doc.upper_strike,
        box_width: doc.box_width,
        lot_size: doc.lot_size,
        quantity: doc.quantity,
        entry_box_cost_per_unit:
          doc.lot_size > 0 ? doc.entry_box_cost / doc.lot_size : doc.entry_box_cost,
        entry_gross_edge: doc.entry_gross_edge,
        entry_net_edge: doc.entry_net_edge,
        entry_charges_total: doc.entry_charges ? doc.entry_charges.total : null,
        estimated_exit_charges_total: doc.estimated_exit_charges
          ? doc.estimated_exit_charges.total
          : null,
        safety_buffer: doc.safety_buffer,
        expected_net_profit: doc.expected_net_profit ?? null,
        entry_execution_cost: doc.entry_execution_cost ?? null,
        charge_origin: doc.charge_origin ?? "local",
        entry_execution: doc.entry_execution ?? null,
        margin: doc.margin ?? null,
        opened_at: doc.opened_at.getTime(),
        legs,
        entry_prices: entryPrices,
        metrics: null,
        exit_blocked_reason: doc.exit_blocked_reason,
        expiry_safety: doc.expiry_safety,
        closing: false,
        last_persist_at: Date.now(),
        config: doc.scanner_config_snapshot,
      });
    }
    console.log(`[Box] adopted ${this.positions.size} open paper box position(s).`);
  }

  /* --------------------------------- views -------------------------------- */

  getConfig() {
    return {
      /** THE ENTRY GATE — minimum expected NET profit (₹) after every cost. */
      min_expected_net_profit: requiredNetProfit(this.cfg),
      /** A cheap gross prefilter (₹), never the decision. */
      min_gross_edge: this.cfg.minGrossEdge,
      /** Legacy extra net floor; 0 means it does not raise the gate. */
      min_net_edge: this.cfg.minNetEdge,
      /** Execution model and its simulated delays. */
      execution_mode: this.cfg.executionMode,
      simulated_decision_ms: this.cfg.simulatedDecisionMs,
      simulated_latency_ms: this.cfg.simulatedLatencyMs,
      expected_entry_slippage: this.cfg.expectedEntrySlippage,
      expected_exit_slippage: this.cfg.expectedExitSlippage,
      enable_short_box: this.cfg.enableShortBox,
      directions: this.directions,
      min_captured_pct: this.cfg.minCapturedPct,
      reconcile_charges: this.cfg.reconcileCharges,
      charge_reconcile_warn_pct: this.cfg.chargeReconcileWarnPct,
      require_priced_charges: this.cfg.requirePricedCharges,
      safety_buffer: this.cfg.safetyBuffer,
      /** How long an UNCHANGED book is still trusted. */
      quote_max_age_ms: this.cfg.quoteMaxAgeMs,
      /** Feed-liveness limit: newest tick across the whole universe. */
      feed_max_age_ms: this.cfg.feedMaxAgeMs,
      underlying_max_age_ms: this.cfg.underlyingMaxAgeMs,
      /** The MAXIMUM strikes each side (the cap). */
      strikes_each_side: this.cfg.strikesEachSide,
      /** The ACTIVE admin-selected level (1, 2 or 3), never above the cap. */
      strike_level: this.strikeLevel,
      max_strikes: this.strikeLevel * 2 + 1,
      /**
       * Strike PAIRS in the active window: C(n,2) for n = 2·level+1 strikes.
       * ±3 → 7 strikes → 21 pairs, ±2 → 5 → 10, ±1 → 3 → 3. Was hard-coded at 21,
       * which over-stated the monitored set at every level but the widest.
       */
      max_candidates_per_underlying: (() => {
        const n = this.strikeLevel * 2 + 1;
        return (n * (n - 1)) / 2;
      })(),
      prefilter_gross_threshold: prefilterGrossThreshold(this.cfg),
      convergence_floor: this.cfg.convergenceFloor,
      convergence_pct: this.cfg.convergencePct,
      min_exit_net_pnl: this.cfg.minExitNetPnl,
      profit_capture_pct: this.cfg.profitCapturePct,
      expiry_safety_minutes: this.cfg.expirySafetyMinutesBeforeClose,
      max_subscribed_tokens: this.cfg.maxSubscribedTokens,
      lots: 1,
      universe: "NSE F&O options only — F&O stocks + supported indices",
      /** Whether the last-close view covers the whole universe with RUN off. */
      indicative_discovery: this.cfg.indicativeDiscovery,
      /** Whether today's closed trades are mirrored to Redis for a fast read. */
      closed_cache_enabled: this.closedCache.enabled(),
      /** The thresholds an admin may change from the UI, and their bounds. */
      tunable: {
        min_expected_net_profit: BOX_TUNING_LIMITS.minExpectedNetProfit,
        safety_buffer: BOX_TUNING_LIMITS.safetyBuffer,
      },
    };
  }

  getStatus() {
    const scanner = this.scanner.getStats();
    return {
      running: this.running,
      state: this.running
        ? this.marketOpen
          ? ("SCANNING" as const)
          : ("MARKET_CLOSED" as const)
        : ("STOPPED" as const),
      monitoring: true,
      /** False → prices shown are last-close and NOTHING can be entered. */
      market_open: this.marketOpen,
      /** When the last-close view was last rebuilt, and how many boxes it priced. */
      indicative_at: this.indicativeAt,
      indicative_priced: this.indicativePriced,
      /** The session the last-close prices come from, and legs dropped as stale. */
      indicative_session_day: this.indicativeSessionDay,
      indicative_stale_legs: this.indicativeStaleLegs,
      execution_mode: this.cfg.executionMode,
      authenticated: this.deps.kite.getAccessToken() !== null,
      db_enabled: isBoxDbEnabled(),
      started_at: this.startedAt,
      stopped_at: this.stoppedAt,
      universe_built_at: this.universeBuiltAt,
      /** The active strikes-each-side level (1, 2 or 3). */
      strike_level: this.strikeLevel,
      underlyings: this.windows.size,
      candidates: this.scanner.candidateCount,
      monitored_tokens: this.scanner.monitoredTokenCount,
      subscribed_option_tokens: this.subscribedOptionTokens.size,
      subscribed_spot_tokens: this.subscribedSpotTokens.size,
      hub_subscribed: this.deps.tickerHub.subscribedCount(),
      hub_connected: this.deps.tickerHub.isConnected(),
      quotes: this.quotes.size,
      quote_updates: this.quotes.updateCount,
      /** Feed liveness: age of the newest tick anywhere, and the verdict. */
      feed_age_ms: this.feedAgeMs(),
      feed_healthy: this.isFeedHealthy(),
      /**
       * APPROXIMATE lag behind the exchange, from Kite's second-resolution
       * exchange_timestamp. Distinct from feed_age_ms (a liveness heartbeat):
       * this estimates how stale the data itself is versus NSE. null until a
       * timestamped packet has been seen.
       */
      exchange_lag_ms: this.exchangeLag(),
      open_positions: this.positions.size,
      /** Running day P&L: open positions' current net + today's realised net. */
      day_pnl: this.computeDayPnl(),
      skipped_for_budget: this.skippedForBudget.length,
      skipped_symbols: this.skippedForBudget.slice(0, 25),
      scanner: {
        ...scanner,
        // Execution simulation headline figures the operator watches.
        simulated_entries_attempted: scanner.executionsAttempted,
        simulated_entries_filled: scanner.entriesOpened,
        simulated_entries_failed:
          scanner.rejectedExecution + scanner.rejectedLiquidity + scanner.rejectedNetProfit,
        active_execution_pipelines: this.executionSim.activeCount,
      },
      monitor: this.monitor.getStats(),
      charges: this.charges.getStats(),
      reconciliation: this.reconciler.getStats(),
      /** Rolling latency / slippage / throughput distributions (bounded rings). */
      metrics: this.metrics.snapshot(),
      last_error: this.lastError,
      config: this.getConfig(),
    };
  }

  getOpportunities(limit?: number): BoxOpportunity[] {
    return this.scanner.listOpportunities(limit ?? this.cfg.maxPublishedOpportunities);
  }

  /** Recent paper_legging execution attempts that did not open a box. */
  async listExecutionAttempts(limit = 100) {
    return loadBoxExecutionAttempts(limit);
  }

  /* ------------------------------- day P&L -------------------------------- */

  /** Reset the closed-today tally when the IST trading day rolls over. */
  private rollClosedTodayDay(): void {
    const today = this.deps.istDayKey();
    if (this.closedTodayDay !== today) {
      const previous = this.closedTodayDay;
      this.closedTodayDay = today;
      this.closedTodayCount = 0;
      this.closedTodayNet = 0;
      this.closedTodayGross = 0;
      this.closedTodayMargin = 0;
      this.closedTodayMarginUnknown = 0;
      // Yesterday's trades are history now: they belong to the Mongo-backed view,
      // not to today's fast list.
      this.closedTodayTrades = [];
      // NOT marked loaded. A genuine midnight roll starts an empty day, but this
      // same branch runs on the first request after a failed boot seed, where an
      // empty list means "not read yet" and the read tiers must still be tried.
      // Only a real load sets closedTodayLoadedFor.
      this.closedTodayLoadedFor = previous === "" ? this.closedTodayLoadedFor : today;
      this.closedTodaySource = "memory";
    }
  }

  /** Put one just-closed trade at the head of today's fast list, de-duplicated. */
  private recordClosedToday(trade: SerializedBoxTrade): void {
    this.closedTodayTrades = [
      trade,
      ...this.closedTodayTrades.filter((t) => t.id !== trade.id),
    ];
    this.closedTodaySource = "memory";
  }

  /**
   * Seed the closed-today tally AND today's fast trade list from Mongo (called at
   * boot and on a day roll).
   *
   * This is the one full read of today's closed set; from here on the list is
   * maintained incrementally, so the Closed-trades tab never queries Mongo again
   * for today.
   */
  private async refreshClosedTodayFromDb(): Promise<void> {
    const day = this.deps.istDayKey();
    const rows = await loadBoxTradesClosedSince(istDayStartMs(day));
    let count = 0;
    let net = 0;
    let gross = 0;
    let margin = 0;
    let marginUnknown = 0;
    for (const r of rows) {
      count++;
      net += r.realised_net_pnl ?? r.net_pnl ?? 0;
      gross += r.gross_pnl ?? 0;
      if (r.margin === null || r.margin === undefined) marginUnknown++;
      else margin += r.margin;
    }
    this.closedTodayDay = day;
    this.closedTodayCount = count;
    this.closedTodayNet = net;
    this.closedTodayGross = gross;
    this.closedTodayMargin = margin;
    this.closedTodayMarginUnknown = marginUnknown;

    this.closedTodayTrades = rows.map((r) => liteClosedTrade(serializeBoxTrade(r)));
    this.closedTodayLoadedFor = day;
    this.closedTodaySource = "mongo";
    // Mirror the seed so a later restart can skip this query entirely.
    if (this.closedTodayTrades.length > 0) {
      void this.closedCache
        .writeTrades(day, this.closedTodayTrades)
        .catch(() => {/* best-effort accelerator */});
    }
  }

  /**
   * TODAY's closed trades — the Closed-trades tab's fast path.
   *
   * Three tiers, fastest first:
   *   1. in process (the normal case: seeded at boot, appended to on every close);
   *   2. Redis (a restart mid-session: one round trip, no Mongo);
   *   3. Mongo, narrowed to `closed_at >= IST midnight` (the fallback, and still
   *      far cheaper than the whole-book query this replaced).
   *
   * Earlier days are deliberately NOT served here — they stay on the full-history
   * route, where a slower load is acceptable.
   */
  async getClosedToday(): Promise<{
    trades: SerializedBoxTrade[];
    source: "memory" | "redis" | "mongo" | "none";
    day: string;
  }> {
    this.rollClosedTodayDay();
    const day = this.closedTodayDay;

    if (this.closedTodayLoadedFor === day) {
      return { trades: this.closedTodayTrades, source: this.closedTodaySource, day };
    }

    // Redis holds whatever was mirrored, which after a partially-applied pipeline
    // may be a SUBSET of the day. Trust it only when it is at least as complete as
    // the tally says the day is; otherwise fall through to Mongo, which is the one
    // source that is definitionally complete.
    try {
      const cached = await this.closedCache.readDay(day);
      if (cached.length > 0 && cached.length >= this.closedTodayCount) {
        this.closedTodayTrades = cached;
        this.closedTodayLoadedFor = day;
        this.closedTodaySource = "redis";
        return { trades: cached, source: "redis", day };
      }
      if (cached.length > 0) {
        console.warn(
          `[Box] closed-today cache holds ${cached.length} of ${this.closedTodayCount} ` +
            `trade(s) for ${day} — falling back to Mongo.`,
        );
      }
    } catch (err) {
      console.warn("[Box] closed-today cache read failed:", err);
    }

    // The SAME query the boot seed uses: narrowed to today and deliberately
    // UNLIMITED. A cap here could truncate the list while the tally kept counting,
    // recreating the "the strip says 164, the tab shows fewer" disagreement.
    const rows = await loadBoxTradesClosedSince(istDayStartMs(day));
    const fromDb = rows.map((r) => liteClosedTrade(serializeBoxTrade(r)));

    // Only ADOPT the database's answer if it is at least as complete as what is
    // already held. With the box connection down this query returns [] rather than
    // throwing, and overwriting the in-process list with that would DELETE trades
    // closed in this session from the view — a cache miss must never lose data.
    if (fromDb.length >= this.closedTodayTrades.length) {
      this.closedTodayTrades = fromDb;
      this.closedTodaySource = "mongo";
      // Only trust it as "loaded for today" when the store was actually readable;
      // otherwise leave the tiers to be retried on the next request.
      if (isBoxDbEnabled()) this.closedTodayLoadedFor = day;
      // Re-mirror, so the next restart gets the fast path back.
      if (fromDb.length > 0) {
        void this.closedCache
          .writeTrades(day, fromDb)
          .catch(() => {/* best-effort accelerator */});
      }
    }
    return { trades: this.closedTodayTrades, source: this.closedTodaySource, day };
  }

  /** Whether the Redis accelerator for today's closed trades is live. */
  isClosedCacheEnabled(): boolean {
    return this.closedCache.enabled();
  }

  /**
   * The running day P&L: open positions' current net + today's realised net.
   *
   * Cheap — the open side reads each position's already-computed metrics and the
   * closed side is an in-memory tally, so no database is touched on a status read.
   */
  private computeDayPnl() {
    this.rollClosedTodayDay();
    let openNet = 0;
    let openGross = 0;
    let openCount = 0;
    let openMargin = 0;
    let openMarginUnknown = 0;
    for (const pos of this.positions.list()) {
      openCount++;
      const m = pos.metrics;
      if (m) {
        openNet += m.current_net_pnl ?? 0;
        openGross += m.gross_pnl_if_closed_now ?? 0;
      }
      // Zerodha's basket margin for the four legs, captured just after entry. Null
      // when that call never succeeded, which must be reported rather than counted
      // as zero — otherwise a failed margin fetch silently understates the total.
      if (pos.margin === null || pos.margin === undefined) openMarginUnknown++;
      else openMargin += pos.margin;
    }
    const cachedSummary = this.pnlArchiver.getLastSummary();
    return {
      day: this.closedTodayDay,
      open_count: openCount,
      open_running_net_pnl: round2(openNet),
      open_running_gross_pnl: round2(openGross),
      closed_count: this.closedTodayCount,
      closed_realised_net_pnl: round2(this.closedTodayNet),
      closed_realised_gross_pnl: round2(this.closedTodayGross),
      /** Open running net + today's realised net — the day's running total (₹). */
      total_net_pnl: round2(openNet + this.closedTodayNet),
      total_gross_pnl: round2(openGross + this.closedTodayGross),
      /**
       * MARGIN DEPLOYED TODAY (₹) — the basket margin Zerodha blocked for these
       * boxes, summed.
       *
       * `open_margin_used` is currently blocked; `closed_margin_used` is what
       * today's already-closed boxes had blocked while they were on. Their sum is
       * the margin the day's box trading consumed in total — note it is a SUM over
       * the day, not a peak concurrent figure: boxes that opened and closed at
       * different times never held their margin simultaneously, so the total is an
       * upper bound on what was blocked at any one instant.
       */
      open_margin_used: round2(openMargin),
      closed_margin_used: round2(this.closedTodayMargin),
      total_margin_used: round2(openMargin + this.closedTodayMargin),
      /** Boxes whose margin call never returned, so they are absent from the sums. */
      margin_unknown_count: openMarginUnknown + this.closedTodayMarginUnknown,
      /** Whether the Redis P&L cache is actively mirroring this figure. */
      cache_enabled: this.pnlCache.enabled(),
      last_cached_at: cachedSummary ? cachedSummary.updated_at : null,
    };
  }

  /** Map the live open positions to the P&L cache's input shape. */
  private openPnlInputs(): OpenPnlInput[] {
    return this.positions.list().map((pos) => {
      const m = pos.metrics ?? this.monitor.measure(pos);
      return {
        id: pos.id,
        underlying: pos.underlying,
        direction: pos.direction ?? "LONG_BOX",
        lower_strike: pos.lower_strike,
        upper_strike: pos.upper_strike,
        expiry: pos.expiry,
        opened_at: new Date(pos.opened_at).toISOString(),
        gross_pnl: m.gross_pnl_if_closed_now,
        net_pnl: m.current_net_pnl,
        realisable_net_pnl: m.realisable_net_pnl,
      };
    });
  }

  /** Map trades closed since `sinceMs` to the P&L cache's input shape. */
  private async closedPnlInputs(sinceMs: number): Promise<ClosedPnlInput[]> {
    const rows = await loadBoxTradesClosedSince(sinceMs);
    return rows.map((doc) => ({
      id: doc._id.toString(),
      underlying: doc.underlying,
      direction: directionOf(doc),
      lower_strike: doc.lower_strike,
      upper_strike: doc.upper_strike,
      expiry: doc.expiry,
      opened_at: doc.opened_at.toISOString(),
      closed_at: doc.closed_at ? doc.closed_at.toISOString() : null,
      gross_pnl: doc.gross_pnl ?? null,
      net_pnl: doc.net_pnl ?? null,
      realised_net_pnl: doc.realised_net_pnl ?? null,
    }));
  }

  /**
   * The ATM±3 option chain of one underlying with the box legs marked.
   *
   * Only the seven monitored strikes are returned — this is not a general option
   * chain endpoint.
   */
  getChain(underlying: string) {
    const state = this.windows.get(underlying.toUpperCase());
    if (!state) return null;
    const now = Date.now();
    const openKeys = this.positions.openKeys();

    // Which legs belong to a detected/open box, so the UI can mark them.
    const marks = new Map<string, Set<string>>();
    const addMark = (token: number, label: string) => {
      const key = String(token);
      const set = marks.get(key) ?? new Set<string>();
      set.add(label);
      marks.set(key, set);
    };
    for (const opp of this.scanner.opportunitiesFor(state.underlying)) {
      const isOpen = openKeys.has(opp.key);
      const relevant =
        isOpen || opp.status === "ELIGIBLE" || opp.status === "PAPER_OPENED" || opp.status === "UNPRICED";
      if (!relevant) continue;
      for (const leg of opp.legs) {
        addMark(leg.token, `${leg.side}_${leg.instrument_type}`);
      }
    }

    const rows = state.strikes.map((strike) => {
      const ce = state.ce.get(strike);
      const pe = state.pe.get(strike);
      const ceQ = ce ? this.quotes.get(ce.token) : undefined;
      const peQ = pe ? this.quotes.get(pe.token) : undefined;
      return {
        strike,
        is_atm: strike === state.atm_strike,
        ce: ce
          ? {
              token: ce.token,
              tradingsymbol: ce.tradingsymbol,
              bid: ceQ?.bid ?? 0,
              bid_qty: ceQ?.bid_qty ?? 0,
              ask: ceQ?.ask ?? 0,
              ask_qty: ceQ?.ask_qty ?? 0,
              last: ceQ?.last ?? 0,
              age_ms: ceQ ? now - ceQ.at : null,
              marks: [...(marks.get(String(ce.token)) ?? [])],
            }
          : null,
        pe: pe
          ? {
              token: pe.token,
              tradingsymbol: pe.tradingsymbol,
              bid: peQ?.bid ?? 0,
              bid_qty: peQ?.bid_qty ?? 0,
              ask: peQ?.ask ?? 0,
              ask_qty: peQ?.ask_qty ?? 0,
              last: peQ?.last ?? 0,
              age_ms: peQ ? now - peQ.at : null,
              marks: [...(marks.get(String(pe.token)) ?? [])],
            }
          : null,
      };
    });

    return {
      underlying: state.underlying,
      name: state.name,
      is_index: state.is_index,
      expiry: state.expiry,
      lot_size: state.lot_size,
      quantity: state.lot_size,
      atm_strike: state.atm_strike,
      strike_step: state.strike_step,
      spot: state.spot,
      spot_age_ms: now - state.spot_at,
      strikes: rows,
    };
  }

  /** Underlyings that currently have a monitored window. */
  listChainSymbols(): { underlying: string; name: string; is_index: boolean; expiry: string }[] {
    return [...this.windows.values()].map((w) => ({
      underlying: w.underlying,
      name: w.name,
      is_index: w.is_index,
      expiry: w.expiry,
    }));
  }

  /** Live view of the open positions, with the current exit arithmetic. */
  getOpenPositions() {
    return this.positions.list().map((pos) => {
      const m = pos.metrics ?? this.monitor.measure(pos);
      const direction = pos.direction ?? "LONG_BOX";
      return {
        id: pos.id,
        key: pos.key,
        execution_mode: this.cfg.executionMode,
        underlying: pos.underlying,
        name: pos.name,
        is_index: pos.is_index,
        expiry: pos.expiry,
        direction,
        lower_strike: pos.lower_strike,
        upper_strike: pos.upper_strike,
        box_width: pos.box_width,
        lot_size: pos.lot_size,
        quantity: pos.quantity,
        opened_at: new Date(pos.opened_at).toISOString(),
        margin: pos.margin,
        entry_box_cost: round2(pos.entry_box_cost_per_unit * pos.lot_size),
        entry_gross_edge: pos.entry_gross_edge,
        entry_charges: pos.entry_charges_total,
        estimated_exit_charges_at_entry: pos.estimated_exit_charges_total,
        safety_buffer: pos.safety_buffer,
        entry_net_edge: pos.entry_net_edge,
        expected_net_profit: pos.expected_net_profit ?? null,
        entry_execution_cost: pos.entry_execution_cost ?? null,
        charge_origin: pos.charge_origin ?? "local",
        entry_legs: BOX_LEG_ROLES.map((role) => ({
          role,
          side: entrySideFor(role, direction),
          tradingsymbol: pos.legs[role].tradingsymbol,
          strike: pos.legs[role].strike,
          instrument_type: pos.legs[role].instrument_type,
          entry_price: pos.entry_prices[role],
        })),
        exit_legs: m.legs.map((l) => ({
          role: l.role,
          side: l.side,
          tradingsymbol: l.tradingsymbol,
          price: l.price,
          bid: l.bid,
          bid_qty: l.bid_qty,
          ask: l.ask,
          ask_qty: l.ask_qty,
          age_ms: l.age_ms,
          executable: l.executable,
          fresh: l.fresh,
        })),
        exit_box_value: m.exit_box_value,
        gross_pnl: m.gross_pnl_if_closed_now,
        current_exit_charges: m.estimated_exit_charges,
        total_charges: m.total_round_trip_charges,
        net_pnl: m.current_net_pnl,
        realisable_net_pnl: m.realisable_net_pnl,
        estimated_execution_cost: m.estimated_execution_cost,
        remaining_edge: m.remaining_edge,
        /** Convergence progress the UI shows to make "is it converging" obvious. */
        entry_edge: m.entry_edge,
        captured_edge: m.captured_edge,
        captured_pct: m.captured_pct,
        time_in_trade_ms: m.time_in_trade_ms,
        convergence_threshold: m.convergence_threshold,
        min_exit_net_pnl: m.min_exit_net_pnl,
        profit_capture_target: m.profit_capture_target,
        min_captured_pct: m.min_captured_pct,
        liquidity_ok: m.liquidity_ok,
        worst_age_ms: m.worst_age_ms,
        exit_eligible: m.exit_eligible,
        exit_reason: m.exit_reason,
        /** What the rules say even when the market cannot currently fill it. */
        exit_rule_reason: m.rule_reason,
        /** Why it is being held, or why an eligible exit is blocked. */
        blocked_reason: m.blocked_reason,
        exit_blocked_reason: pos.exit_blocked_reason,
        expiry_safety: pos.expiry_safety,
        status: "open" as const,
      };
    });
  }

  /* ---------------------------------- SSE --------------------------------- */

  addSseClient(res: Response): () => void {
    const client: SseClient = { res };
    this.sseClients.add(client);
    if (!this.publishTimer) {
      this.publishTimer = setInterval(() => this.publish(), this.cfg.publishIntervalMs);
      this.publishTimer.unref?.();
    }
    this.writeFrame(client, "snapshot", this.snapshot());
    return () => {
      this.sseClients.delete(client);
      if (this.sseClients.size === 0 && !this.running && this.positions.size === 0) {
        this.maybeReleaseFeed();
      }
    };
  }

  private snapshot() {
    return {
      status: this.getStatus(),
      opportunities: this.getOpportunities(),
      open_trades: this.getOpenPositions(),
    };
  }

  /**
   * Push the current state to the UI on a slow cadence (a few times a second).
   * The frontend is a visualization surface — it never participates in a trading
   * decision, so it does not need every exchange tick.
   */
  private publish(): void {
    if (this.sseClients.size === 0) return;
    const payload = this.snapshot();
    for (const client of this.sseClients) this.writeFrame(client, "snapshot", payload);
  }

  private broadcast(event: string, payload: unknown): void {
    for (const client of this.sseClients) this.writeFrame(client, event, payload);
  }

  private writeFrame(client: SseClient, event: string, payload: unknown): void {
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      // Broken pipe — the request's own close handler removes the client.
    }
  }

  /** Called when the Zerodha session dies: drop live state, keep positions. */
  onSessionLost(): void {
    this.quotes.clear();
    this.spots.clear();
    this.scanner.clearOpportunities();
    this.lastError = "The Zerodha session ended — live box data is unavailable.";
  }

  /** Test/diagnostic accessors. */
  get scannerRef(): BoxScanner {
    return this.scanner;
  }
  get monitorRef(): BoxPositionMonitor {
    return this.monitor;
  }
  get quotesRef(): BoxQuoteStore {
    return this.quotes;
  }
  get positionsRef(): BoxPositionBook {
    return this.positions;
  }
}

export type { SerializedBoxTrade };
