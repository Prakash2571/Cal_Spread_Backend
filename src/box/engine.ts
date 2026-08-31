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
  clampStrikeLevel,
  configSnapshot,
  loadBoxConfig,
  prefilterGrossThreshold,
  requiredNetProfit,
  type BoxConfig,
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
  loadBoxTradesClosedSince,
  loadOpenBoxTrades,
  serializeBoxTrade,
  setBoxChargeReconciliation,
  setBoxTradeMargin,
  toEventLegs,
  tradeKey,
  updateBoxTradeLive,
  upsertBoxDailyPnl,
  type SerializedBoxTrade,
} from "./repository.js";
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

  /** Running tally of trades CLOSED today, for the day-P&L view (no Mongo on read). */
  private closedTodayDay = "";
  private closedTodayCount = 0;
  private closedTodayNet = 0;
  private closedTodayGross = 0;
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
    this.marketOpen = this.deps.isMarketOpen();
    this.scanner.setMarketOpen(this.marketOpen);
    try {
      await this.adoptOpenPositions();
    } catch (err) {
      console.warn("[Box] failed to adopt open positions:", err);
    }
    this.monitor.start();
    // Seed the "closed today" tally from Mongo so the day-P&L view is correct
    // immediately after a restart, then start the P&L cache + nightly archiver.
    await this.refreshClosedTodayFromDb().catch((err) =>
      console.warn("[Box] closed-today seed failed:", err),
    );
    this.pnlArchiver.start();
    if (this.positions.size > 0) {
      // Open positions need live books even with the scanner stopped.
      this.ensureFeed();
      await this.refreshUniverse().catch((err) =>
        console.warn("[Box] universe refresh failed at boot:", err),
      );
    }
    console.log(
      `[Box] engine ready — ${this.positions.size} open paper box position(s), ` +
        `entry gate ₹${this.cfg.minGrossEdge} GROSS from the spread` +
        (this.cfg.minNetEdge > 0 ? ` (plus a ₹${this.cfg.minNetEdge} net floor)` : "") +
        `, safety ₹${this.cfg.safetyBuffer} (reported, not gated), ` +
        `freshness ${this.cfg.quoteMaxAgeMs}ms, ATM±${this.cfg.strikesEachSide}, ` +
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
    if (this.deps.kite.getAccessToken()) {
      try {
        await this.refreshUniverse();
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    }
    this.publish();
    return { ok: true, level: next };
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
          this.scanner.refreshAll();
        } else {
          void this.refreshIndicative();
        }
      }
    };
    if (!this.marketTimer) {
      this.marketTimer = setInterval(sync, 15_000);
      this.marketTimer.unref?.();
    }
    if (!this.indicativeTimer) {
      this.indicativeTimer = setInterval(() => {
        if (!this.running || this.marketOpen) return;
        void this.refreshIndicative();
      }, this.cfg.indicativeRefreshMs);
      this.indicativeTimer.unref?.();
    }
    sync();
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
    const tokens = [...this.subscribedOptionTokens];
    if (tokens.length === 0) return;
    try {
      const all = await this.deps.getAllInstruments();
      const resolve = this.deps.makeIdResolver(all);
      const ids = tokens
        .map(resolve)
        .filter((s): s is string => typeof s === "string");
      if (ids.length === 0) return;
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

      this.indicativeSessionDay = sessionDay || null;
      this.indicativeStaleLegs = stale;
      this.indicativePriced = this.scanner.publishIndicative(lastPrices);
      this.indicativeAt = Date.now();
      console.log(
        `[Box] last-close view: session ${sessionDay || "unknown"}, ` +
          `${lastPrices.size}/${quotes.length} legs traded in it (${stale} stale), ` +
          `${this.indicativePriced} box(es) with a coherent close.`,
      );
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
   * Rebuild the scanned universe: nearest live expiry per underlying, the ATM±3
   * window, its 21 candidates, and the subscription set.
   *
   * Windows are only re-centred when the underlying has genuinely drifted (see
   * windowNeedsRebuild), so this can run on a timer without churning
   * subscriptions.
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
    let used = 0;

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

      // Discovery is off and this underlying carries no position → do not spend
      // any of the token budget on it.
      if (!this.running && !mustKeep.has(item.symbol)) continue;

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
      // the window centred.
      const cost = tokens.length + 1;
      if (used + cost > budget && !mustKeep.has(item.symbol)) {
        skipped.push(item.symbol);
        continue;
      }
      used += cost;

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
      for (const t of tokens) wantOption.add(t);
      wantSpot.add(item.spot_token);
    }

    // Open positions' legs are subscribed unconditionally.
    for (const t of this.positions.tokens()) wantOption.add(t);

    // The forced rebuild (from a strike-level change) has now been applied.
    this.forceWindowRebuild = false;
    this.skippedForBudget = skipped;
    this.universeBuiltAt = now;
    this.applySubscriptions(wantOption, wantSpot);
    // Windows that dropped out of the universe must stop producing candidates.
    for (const underlying of [...this.windows.keys()]) {
      if (!wantSpot.has(this.windows.get(underlying)!.spot_token) && !mustKeep.has(underlying)) {
        this.windows.delete(underlying);
        this.scanner.removeUnderlying(underlying);
      }
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

    // Fold the realised result into the running day-P&L tally.
    this.rollClosedTodayDay();
    this.closedTodayCount++;
    this.closedTodayNet += netPnl ?? 0;
    this.closedTodayGross += grossPnl ?? 0;

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
    this.broadcast("exit", { trade: serializeBoxTrade(closed) });
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
   */
  private backfillMissingMargins(): void {
    if (!this.deps.kite.getAccessToken()) return;
    for (const pos of this.positions.list()) {
      if (pos.margin !== null) continue;
      if (this.marginInFlight.has(pos.id)) continue;
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
      max_candidates_per_underlying: 21,
      prefilter_gross_threshold: prefilterGrossThreshold(this.cfg),
      convergence_floor: this.cfg.convergenceFloor,
      convergence_pct: this.cfg.convergencePct,
      min_exit_net_pnl: this.cfg.minExitNetPnl,
      profit_capture_pct: this.cfg.profitCapturePct,
      expiry_safety_minutes: this.cfg.expirySafetyMinutesBeforeClose,
      max_subscribed_tokens: this.cfg.maxSubscribedTokens,
      lots: 1,
      universe: "NSE F&O options only — F&O stocks + supported indices",
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
      this.closedTodayDay = today;
      this.closedTodayCount = 0;
      this.closedTodayNet = 0;
      this.closedTodayGross = 0;
    }
  }

  /** Seed the closed-today tally from Mongo (called at boot and on day roll). */
  private async refreshClosedTodayFromDb(): Promise<void> {
    const day = this.deps.istDayKey();
    const rows = await loadBoxTradesClosedSince(istDayStartMs(day));
    let count = 0;
    let net = 0;
    let gross = 0;
    for (const r of rows) {
      count++;
      net += r.realised_net_pnl ?? r.net_pnl ?? 0;
      gross += r.gross_pnl ?? 0;
    }
    this.closedTodayDay = day;
    this.closedTodayCount = count;
    this.closedTodayNet = net;
    this.closedTodayGross = gross;
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
    for (const pos of this.positions.list()) {
      openCount++;
      const m = pos.metrics;
      if (m) {
        openNet += m.current_net_pnl ?? 0;
        openGross += m.gross_pnl_if_closed_now ?? 0;
      }
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
