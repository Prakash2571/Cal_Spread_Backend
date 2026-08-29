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
import { configSnapshot, loadBoxConfig, prefilterGrossThreshold, type BoxConfig } from "./config.js";
import { BoxChargeEstimator, type PriceChargeGroupsFn } from "./charges.js";
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
import {
  appendBoxEvent,
  closeBoxTrade,
  insertBoxTrade,
  isBoxDbEnabled,
  loadOpenBoxTrades,
  serializeBoxTrade,
  toEventLegs,
  tradeKey,
  updateBoxTradeLive,
  type SerializedBoxTrade,
} from "./repository.js";
import { BoxScanner } from "./scanner.js";
import {
  BOX_ENTRY_SIDES,
  BOX_LEG_ROLES,
  type BoxCandidate,
  type BoxDepthSnapshot,
  type BoxEvaluation,
  type BoxCharges,
  type BoxExitMetrics,
  type BoxExitReason,
  type BoxLegRole,
  type BoxOpportunity,
  type BoxOptionInstrument,
  type BoxUnderlyingState,
  type IBoxLeg,
  type IBoxTrade,
} from "./types.js";

export interface BoxEngineDeps {
  kite: KiteClient;
  tickerHub: TickerHub;
  getAllInstruments: () => Promise<Instrument[]>;
  getBoard: () => Promise<BoxBoardItem[]>;
  /** The calendar engine's Zerodha charge estimator, injected UNCHANGED. */
  priceChargeGroups: PriceChargeGroupsFn;
  istDayKey: (at?: number) => string;
  makeIdResolver: (all: Instrument[]) => (token: number) => string | null;
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
  private scanner: BoxScanner;
  private monitor: BoxPositionMonitor;

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
  private restSeedAt = 0;

  private running = false;
  private started = false;
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;
  private lastError: string | null = null;
  private universeBuiltAt: number | null = null;
  private sseClients = new Set<SseClient>();

  constructor(private deps: BoxEngineDeps) {
    this.cfg = loadBoxConfig();
    this.charges = new BoxChargeEstimator(deps.priceChargeGroups, this.cfg);

    this.scanner = new BoxScanner({
      cfg: this.cfg,
      quotes: this.quotes,
      charges: this.charges,
      positions: this.positions,
      openPaperTrade: (args) => this.openPaperTrade(args),
      onEvent: (event, candidate, evaluation, detail) => {
        void appendBoxEvent({
          event,
          candidate_key: candidate.key,
          underlying: candidate.underlying,
          expiry: candidate.expiry,
          lower_strike: candidate.lower_strike,
          upper_strike: candidate.upper_strike,
          lot_size: candidate.lot_size,
          quantity: candidate.lot_size,
          box_width: candidate.box_width,
          box_cost:
            evaluation.entry_box_cost_per_unit === null
              ? null
              : round2(evaluation.entry_box_cost_per_unit * candidate.lot_size),
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
      charges: this.charges,
      positions: this.positions,
      closePaperTrade: (args) => this.closePaperTrade(args),
      persistLive: (pos) =>
        updateBoxTradeLive(pos.id, {
          current_remaining_edge: pos.metrics?.remaining_edge ?? null,
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
          lower_strike: pos.lower_strike,
          upper_strike: pos.upper_strike,
          lot_size: pos.lot_size,
          quantity: pos.quantity,
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
          legs: metrics ? toEventLegs(metrics.legs) : [],
          reason: metrics?.exit_reason ?? null,
          detail: detail ?? null,
        });
      },
      istDayKey: () => this.deps.istDayKey(),
      istMinutesOfDay: () => istMinutesOfDay(),
    });
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
    try {
      await this.adoptOpenPositions();
    } catch (err) {
      console.warn("[Box] failed to adopt open positions:", err);
    }
    this.monitor.start();
    if (this.positions.size > 0) {
      // Open positions need live books even with the scanner stopped.
      this.ensureFeed();
      await this.refreshUniverse().catch((err) =>
        console.warn("[Box] universe refresh failed at boot:", err),
      );
    }
    console.log(
      `[Box] engine ready — ${this.positions.size} open paper box position(s), ` +
        `min net edge ₹${this.cfg.minNetEdge}, safety ₹${this.cfg.safetyBuffer}, ` +
        `freshness ${this.cfg.quoteMaxAgeMs}ms, ATM±${this.cfg.strikesEachSide}.`,
    );
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

    try {
      await this.refreshUniverse();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
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
    }
    const changed = this.quotes.applyTicks(ticks, now);
    if (changed.length > 0) this.scanner.onTokensUpdated(changed);
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
          eachSide: this.cfg.strikesEachSide,
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
          }),
        );
      }
      for (const t of tokens) wantOption.add(t);
      wantSpot.add(item.spot_token);
    }

    // Open positions' legs are subscribed unconditionally.
    for (const t of this.positions.tokens()) wantOption.add(t);

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

  /**
   * Top up the books of open positions over REST when the WebSocket has nothing
   * fresh. Rate-limited, and never on the tick path.
   */
  async topUpPositionBooks(): Promise<void> {
    const now = Date.now();
    if (now - this.restSeedAt < 5000) return;
    const stale: number[] = [];
    for (const pos of this.positions.list()) {
      for (const role of BOX_LEG_ROLES) {
        const token = pos.legs[role].token;
        if (!this.quotes.isFresh(token, this.cfg.quoteMaxAgeMs, now)) stale.push(token);
      }
    }
    if (stale.length === 0) return;
    this.restSeedAt = now;
    try {
      const all = await this.deps.getAllInstruments();
      const resolve = this.deps.makeIdResolver(all);
      const ids = [...new Set(stale)]
        .map(resolve)
        .filter((s): s is string => typeof s === "string");
      if (ids.length === 0) return;
      const ladders = await this.deps.kite.getQuoteLadder(ids);
      const at = Date.now();
      for (const [token, l] of ladders) this.quotes.applyLadder(token, l, at);
    } catch (err) {
      console.warn("[Box] REST top-up failed:", err);
    }
  }

  /* ------------------------------ paper fills ------------------------------ */

  /** Depth snapshot of a leg at the decision instant. */
  private depthOf(token: number): BoxDepthSnapshot | null {
    const q = this.quotes.get(token);
    if (!q) return null;
    return { bids: q.bids, asks: q.asks };
  }

  /**
   * Create the paper trade.
   *
   * PAPER ONLY: no Zerodha order-placement API is called anywhere in this path.
   * The fills recorded are the executable touch prices that were visible in the
   * revalidated snapshot.
   */
  private async openPaperTrade(args: {
    candidate: BoxCandidate;
    evaluation: BoxEvaluation;
    entryChargesTotal: number;
    estimatedExitChargesTotal: number;
    netEdge: number;
    charges: { entry: BoxCharges; estimated_exit: BoxCharges };
  }): Promise<string | null> {
    const { candidate, evaluation, netEdge } = args;
    const byRole = new Map(evaluation.legs.map((l) => [l.role, l]));

    const legs: IBoxLeg[] = [];
    for (const role of BOX_LEG_ROLES) {
      const ev = byRole.get(role);
      const inst = candidate.legs[role];
      if (!ev || ev.price === null) return null;
      legs.push({
        role,
        token: inst.token,
        tradingsymbol: inst.tradingsymbol,
        exchange: inst.exchange,
        strike: inst.strike,
        instrument_type: inst.instrument_type,
        side: BOX_ENTRY_SIDES[role],
        entry_price: round2(ev.price),
        entry_bid: ev.bid,
        entry_bid_qty: ev.bid_qty,
        entry_ask: ev.ask,
        entry_ask_qty: ev.ask_qty,
        entry_quote_at: ev.quote_at === null ? null : new Date(ev.quote_at),
        entry_depth: this.depthOf(inst.token),
        exit_price: null,
        exit_bid: null,
        exit_bid_qty: null,
        exit_ask: null,
        exit_ask_qty: null,
        exit_quote_at: null,
        exit_depth: null,
      });
    }

    const costPerUnit = evaluation.entry_box_cost_per_unit!;
    const payload: IBoxTrade = {
      execution_mode: "paper_touch",
      underlying: candidate.underlying,
      name: candidate.name,
      is_index: candidate.is_index,
      expiry: candidate.expiry,
      lower_strike: candidate.lower_strike,
      upper_strike: candidate.upper_strike,
      lot_size: candidate.lot_size,
      quantity: candidate.lot_size,
      status: "open",
      legs,
      box_width: candidate.box_width,
      entry_box_cost: round2(costPerUnit * candidate.lot_size),
      entry_gross_edge: evaluation.gross_edge!,
      entry_charges: args.charges.entry,
      estimated_exit_charges: args.charges.estimated_exit,
      safety_buffer: this.cfg.safetyBuffer,
      entry_net_edge: netEdge,
      opened_at: new Date(),
      current_remaining_edge: evaluation.gross_edge,
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
      // The unique partial index refused it: this strike pair is already open.
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
      lower_strike: candidate.lower_strike,
      upper_strike: candidate.upper_strike,
      box_width: candidate.box_width,
      lot_size: candidate.lot_size,
      quantity: candidate.lot_size,
      entry_box_cost_per_unit: costPerUnit,
      entry_gross_edge: evaluation.gross_edge!,
      entry_net_edge: netEdge,
      entry_charges_total: args.entryChargesTotal,
      estimated_exit_charges_total: args.estimatedExitChargesTotal,
      safety_buffer: this.cfg.safetyBuffer,
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

    void appendBoxEvent({
      event: "ENTRY",
      trade_id: id,
      candidate_key: candidate.key,
      underlying: candidate.underlying,
      expiry: candidate.expiry,
      lower_strike: candidate.lower_strike,
      upper_strike: candidate.upper_strike,
      lot_size: candidate.lot_size,
      quantity: candidate.lot_size,
      box_width: candidate.box_width,
      box_cost: round2(costPerUnit * candidate.lot_size),
      gross_edge: evaluation.gross_edge,
      entry_charges_total: args.entryChargesTotal,
      exit_charges_total: args.estimatedExitChargesTotal,
      safety_buffer: this.cfg.safetyBuffer,
      net_edge: netEdge,
      legs: toEventLegs(evaluation.legs),
      reason: "paper_touch fills at the revalidated executable touch",
      detail: `1 lot (${candidate.lot_size} qty)`,
    });

    console.log(
      `[Box] PAPER ENTRY ${candidate.underlying} ${candidate.lower_strike}→${candidate.upper_strike} ` +
        `${candidate.expiry} net edge ₹${netEdge} (gross ₹${evaluation.gross_edge})`,
    );
    this.broadcast("entry", { trade: serializeBoxTrade(doc) });
    return id;
  }

  /** Persist a paper exit at the executable touch. */
  private async closePaperTrade(args: {
    position: BoxOpenPosition;
    metrics: BoxExitMetrics;
    exitCharges: BoxCharges | null;
    reason: BoxExitReason;
  }): Promise<boolean> {
    const { position, metrics, exitCharges, reason } = args;
    const byRole = new Map(metrics.legs.map((l) => [l.role, l]));

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
      gross_pnl: grossPnl,
      total_charges: totalCharges,
      net_pnl: netPnl,
      current_remaining_edge: metrics.remaining_edge,
      exit_blocked_reason: null,
    };
    for (const [i, role] of BOX_LEG_ROLES.entries()) {
      const ev = byRole.get(role);
      setFields[`legs.${i}.exit_price`] = ev?.price ?? null;
      setFields[`legs.${i}.exit_bid`] = ev?.bid ?? null;
      setFields[`legs.${i}.exit_bid_qty`] = ev?.bid_qty ?? null;
      setFields[`legs.${i}.exit_ask`] = ev?.ask ?? null;
      setFields[`legs.${i}.exit_ask_qty`] = ev?.ask_qty ?? null;
      setFields[`legs.${i}.exit_quote_at`] = ev?.quote_at ? new Date(ev.quote_at) : null;
      setFields[`legs.${i}.exit_depth`] = this.depthOf(position.legs[role].token);
    }

    const closed = await closeBoxTrade(position.id, setFields as never);
    if (!closed) return false;

    this.positions.remove(position.id);

    void appendBoxEvent({
      event: "EXIT",
      trade_id: position.id,
      candidate_key: position.key,
      underlying: position.underlying,
      expiry: position.expiry,
      lower_strike: position.lower_strike,
      upper_strike: position.upper_strike,
      lot_size: position.lot_size,
      quantity: position.quantity,
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
      legs: toEventLegs(metrics.legs),
      reason,
      detail: `paper_touch exit — ${reason}`,
    });

    console.log(
      `[Box] PAPER EXIT ${position.underlying} ${position.lower_strike}→${position.upper_strike} ` +
        `${reason} net ₹${netPnl ?? "?"}`,
    );
    this.broadcast("exit", { trade: serializeBoxTrade(closed) });
    this.maybeReleaseFeed();
    return true;
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
      min_net_edge: this.cfg.minNetEdge,
      safety_buffer: this.cfg.safetyBuffer,
      quote_max_age_ms: this.cfg.quoteMaxAgeMs,
      underlying_max_age_ms: this.cfg.underlyingMaxAgeMs,
      strikes_each_side: this.cfg.strikesEachSide,
      max_strikes: this.cfg.strikesEachSide * 2 + 1,
      max_candidates_per_underlying: 21,
      prefilter_gross_threshold: prefilterGrossThreshold(this.cfg),
      convergence_floor: this.cfg.convergenceFloor,
      convergence_pct: this.cfg.convergencePct,
      min_exit_net_pnl: this.cfg.minExitNetPnl,
      profit_capture_pct: this.cfg.profitCapturePct,
      expiry_safety_minutes: this.cfg.expirySafetyMinutesBeforeClose,
      max_subscribed_tokens: this.cfg.maxSubscribedTokens,
      lots: 1,
      execution_mode: "paper_touch" as const,
      universe: "NSE F&O (stocks + supported indices)",
    };
  }

  getStatus() {
    const scanner = this.scanner.getStats();
    return {
      running: this.running,
      state: this.running ? ("SCANNING" as const) : ("STOPPED" as const),
      monitoring: true,
      execution_mode: "paper_touch" as const,
      authenticated: this.deps.kite.getAccessToken() !== null,
      db_enabled: isBoxDbEnabled(),
      started_at: this.startedAt,
      stopped_at: this.stoppedAt,
      universe_built_at: this.universeBuiltAt,
      underlyings: this.windows.size,
      candidates: this.scanner.candidateCount,
      monitored_tokens: this.scanner.monitoredTokenCount,
      subscribed_option_tokens: this.subscribedOptionTokens.size,
      subscribed_spot_tokens: this.subscribedSpotTokens.size,
      hub_subscribed: this.deps.tickerHub.subscribedCount(),
      hub_connected: this.deps.tickerHub.isConnected(),
      quotes: this.quotes.size,
      quote_updates: this.quotes.updateCount,
      open_positions: this.positions.size,
      skipped_for_budget: this.skippedForBudget.length,
      skipped_symbols: this.skippedForBudget.slice(0, 25),
      scanner,
      monitor: this.monitor.getStats(),
      charges: this.charges.getStats(),
      last_error: this.lastError,
      config: this.getConfig(),
    };
  }

  getOpportunities(limit?: number): BoxOpportunity[] {
    return this.scanner.listOpportunities(limit ?? this.cfg.maxPublishedOpportunities);
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
      return {
        id: pos.id,
        key: pos.key,
        execution_mode: "paper_touch" as const,
        underlying: pos.underlying,
        name: pos.name,
        is_index: pos.is_index,
        expiry: pos.expiry,
        lower_strike: pos.lower_strike,
        upper_strike: pos.upper_strike,
        box_width: pos.box_width,
        lot_size: pos.lot_size,
        quantity: pos.quantity,
        opened_at: new Date(pos.opened_at).toISOString(),
        entry_box_cost: round2(pos.entry_box_cost_per_unit * pos.lot_size),
        entry_gross_edge: pos.entry_gross_edge,
        entry_charges: pos.entry_charges_total,
        estimated_exit_charges_at_entry: pos.estimated_exit_charges_total,
        safety_buffer: pos.safety_buffer,
        entry_net_edge: pos.entry_net_edge,
        entry_legs: BOX_LEG_ROLES.map((role) => ({
          role,
          side: BOX_ENTRY_SIDES[role],
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
        remaining_edge: m.remaining_edge,
        convergence_threshold: m.convergence_threshold,
        min_exit_net_pnl: m.min_exit_net_pnl,
        profit_capture_target: m.profit_capture_target,
        liquidity_ok: m.liquidity_ok,
        worst_age_ms: m.worst_age_ms,
        exit_eligible: m.exit_eligible,
        exit_reason: m.exit_reason,
        /** What the rules say even when the market cannot currently fill it. */
        exit_rule_reason: m.rule_reason,
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
