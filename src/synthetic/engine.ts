/**
 * SyntheticEngine: the futures-vs-synthetic arbitrage scanner and PAPER trader.
 *
 * WHAT IT DOES
 * Watches each underlying's nearest future together with the same-expiry option
 * pair at ATM, ATM±1, ATM±2 or ATM±3, prices a conversion and a reversal at every
 * strike from the executable touch, and, while RUN is on, opens a one-lot PAPER
 * position whenever an opportunity is ELIGIBLE. Open positions are monitored on
 * their own: they keep being marked and can still auto-exit with the scanner
 * stopped, exactly like Box. Nothing here can send a real order.
 *
 * TWO JOBS, ONE LOOP
 *   discovery   (`running`)          windows, opportunities, automatic entries
 *   monitoring  (open positions)     marks, exit rules, expiry settlement
 * A single timer drives both from `boot()`, so a position adopted after a restart
 * is managed from the moment the process is up.
 *
 * MARKET DATA AND THE TOKEN BUDGET
 * Tokens are declared on the dedicated BOX lane under the "scanner" owner. That
 * lane carries full depth on both brokers and is refcounted per owner, so this
 * scanner can never unsubscribe a strike Box needs, and Box can never drop one of
 * ours. The budget is `SYNTH_MAX_TOKENS` while Box is running. While the Box
 * scanner is STOPPED, the part of Box's own budget it is not using for open
 * positions is borrowed as well. Box always has priority: `yieldToBox()` is
 * called synchronously before Box declares its tokens, so this scanner shrinks
 * first and the socket never exceeds `SYNTH_LANE_TOKEN_LIMIT`. Open positions'
 * legs are never dropped to make room.
 *
 * Books live in this engine's OWN BoxQuoteStore, so nothing here can warm or
 * invalidate a Box book.
 */

import type { Response } from "express";
import type { Instrument } from "../kite.js";
import type { Tick } from "../ticker.js";
import type { BrokerId } from "../brokers/types.js";
import type { BoxMarketDataProvider } from "../box/brokerContext.js";
import { BoxQuoteStore } from "../box/quotes.js";
import {
  SYNTH_TUNING_LIMITS,
  clampSynthStrikeLevel,
  loadSynthConfig,
  type SynthConfig,
  type SynthStrikeLevel,
} from "./config.js";
import {
  SYNTH_DIRECTIONS,
  buildSynthWindow,
  closeTradeAtTouch,
  computeSynthDayPnl,
  evaluateSynthExit,
  evaluateSynthetic,
  inExpirySafetyWindow,
  indexSyntheticChains,
  isPastSettlement,
  openTradeFromOpportunity,
  settleTradeAtExpiry,
  sortOpportunities,
  synthTokensFor,
  synthWindowNeedsRebuild,
  synthWindowTokens,
  type SynthBoardItem,
  type SynthChainIndex,
  type SynthDayPnl,
  type SynthDirection,
  type SynthExitLeg,
  type SynthExitMetrics,
  type SynthExitRules,
  type SynthOpportunity,
  type SynthQuoteLike,
  type SynthTrade,
  type SynthTradeLeg,
  type SynthWindow,
} from "./math.js";

/** Persistence seam: Mongo in production (repository.ts), anything else in tests. */
export interface SynthTradeStore {
  /** Whether trades can be read and written right now. */
  enabled(): boolean;
  newId(): string;
  /** "duplicate" when the underlying already has an open position. */
  insertOpen(trade: SynthTrade): Promise<"ok" | "duplicate">;
  /** Atomic open → closed. False when it was not open (already closed elsewhere). */
  close(trade: SynthTrade): Promise<boolean>;
  loadOpen(): Promise<SynthTrade[]>;
  loadClosed(opts: { limit: number; sinceDay?: string }): Promise<SynthTrade[]>;
}

/** How Box is using the shared lane right now. */
export interface BoxLaneUsage {
  /** Box scanner running: it may grow to its full budget at any refresh. */
  running: boolean;
  /** Tokens Box holds on the lane now (open positions' legs when stopped). */
  heldTokens: number;
  /** Box's own budget on this lane (0 when Box is not on the dedicated lane). */
  budget: number;
}

export interface SyntheticEngineDeps {
  getAllInstruments: () => Promise<Instrument[]>;
  getBoard: () => Promise<SynthBoardItem[]>;
  marketData: BoxMarketDataProvider;
  isMarketOpen: () => boolean;
  istDayKey: (at?: number) => string;
  makeIdResolver: (all: Instrument[]) => (token: number) => string | null;
  /** The admin-entered risk-free rate (%), or null when unset. */
  getRfPct: () => number | null;
  activeBroker: () => BrokerId;
  /** Declare this scanner's ENTIRE token set (one diff on the Box lane). */
  setTokens: (tokens: number[]) => void;
  store: SynthTradeStore;
  /** Box's use of the lane. Without it the budget is fixed at SYNTH_MAX_TOKENS. */
  boxLane?: () => BoxLaneUsage;
  config?: SynthConfig;
}

interface SseClient {
  res: Response;
}

export interface SynthChainView {
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  lot_size: number;
  atm_strike: number;
  strike_step: number;
  future: SynthChainSide;
  strikes: { strike: number; is_atm: boolean; ce: SynthChainSide; pe: SynthChainSide }[];
}

export interface SynthChainSide {
  token: number;
  tradingsymbol: string;
  bid: number;
  bid_qty: number;
  ask: number;
  ask_qty: number;
  last: number;
  age_ms: number | null;
}

/** A trade as the API returns it: ISO times instead of epoch ms. */
export type SynthTradeView = Omit<SynthTrade, "opened_at" | "closed_at"> & {
  opened_at: string;
  closed_at: string | null;
};

/** An open position with its live marks, as the Open tab renders it. */
export type SynthOpenView = SynthTradeView & {
  /** False until the legs are resolved on the active broker (after a restart/switch). */
  linked: boolean;
  closing: boolean;
  exit_legs: SynthExitLeg[];
  mtm_ltp: number | null;
  current_exit_charges: number | null;
  remaining_edge: number | null;
  captured_edge: number | null;
  captured_pct: number | null;
  convergence_threshold: number;
  profit_capture_target: number;
  min_exit_net_pnl: number;
  expiry_safety: boolean;
  exit_eligible: boolean;
  exit_rule_reason: SynthExitMetrics["rule_reason"];
  exit_blocked_reason: SynthExitMetrics["blocked_reason"];
};

/** Tokens reserved per open position (future + CE + PE). */
const POSITION_TOKENS = 3;
const FIRST_REFRESH_RETRY_MS = 10_000;
const REFRESH_DEBOUNCE_MS = 5_000;
/** Windows that could not be built (no future price) are retried this often. */
const UNBUILT_RETRY_MS = 60_000;
const CLOSE_RETRY_MS = 5_000;
/** Adopting open positions is retried this often until the store answers. */
const LOAD_RETRY_MS = 30_000;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function toTradeView(t: SynthTrade): SynthTradeView {
  return {
    ...t,
    legs: t.legs.map((l) => ({ ...l })),
    opened_at: iso(t.opened_at),
    closed_at: t.closed_at === null ? null : iso(t.closed_at),
  };
}

function legKey(t: SynthTrade, leg: SynthTradeLeg): string {
  return `${t.underlying}|${t.expiry}|${leg.instrument_type}|${leg.instrument_type === "FUT" ? 0 : leg.strike}`;
}

function sameSet(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export class SyntheticEngine {
  readonly cfg: SynthConfig;
  private running = false;
  private booted = false;
  /** Open positions and today's closed trades have been read from the store. */
  private loaded = false;
  private loading = false;
  private lastLoadAttemptAt = 0;
  private strikeLevel: SynthStrikeLevel;
  private minExpectedNetProfit: number;
  private safetyBuffer: number;

  /* ------------------------------- universe ------------------------------- */
  private board = new Map<string, SynthBoardItem>();
  private chains = new Map<string, SynthChainIndex>();
  private windows = new Map<string, SynthWindow>();
  /** Watched underlyings in priority order. The tail is dropped first when Box needs room. */
  private selection: string[] = [];
  private watched = new Set<number>();
  private quotes = new BoxQuoteStore();
  /** Latest-session closes, for the market-shut view and marks. token -> close. */
  private closes = new Map<number, number>();
  /** REST-seeded future prices, used to centre a window before the first tick. */
  private seededRef = new Map<string, number>();
  private closeSessionDay: string | null = null;
  private universeAt: number | null = null;
  private lastRefreshAttemptAt = 0;
  private refreshing: Promise<void> | null = null;
  /** Candidates left out because the token budget was full (never counts build failures). */
  private skippedForBudget = 0;
  /** Candidates the current selection reserved budget for, built or not. */
  private reservedCount = 0;
  /** Reserved candidates whose window could not be built (no future price yet). */
  private unbuiltCount = 0;
  private budgetGrowPending = false;
  private closeViewPending = false;
  /** Bumped on every namespace change: a refresh started before one is discarded. */
  private namespaceEpoch = 0;
  /** From a namespace change until the universe is reloaded: nothing is subscribed. */
  private namespaceStale = false;
  /** Socket liveness: the newest tick seen on the lane while active. */
  private lastRawTickAt: number | null = null;
  private lastMarketOpen: boolean | null = null;

  /* ---------------------------- opportunities ----------------------------- */
  private opportunities: SynthOpportunity[] = [];
  private eligibleStreak = new Map<string, number>();
  private evaluatedAt: number | null = null;

  /* ---------------------------- paper positions ---------------------------- */
  private positions = new Map<string, SynthTrade>();
  private metrics = new Map<string, SynthExitMetrics>();
  /** Positions whose legs are not (yet) resolved on the active broker. */
  private unlinked = new Set<string>();
  private exitStreak = new Map<string, number>();
  private pendingEntries = new Set<string>();
  private closing = new Set<string>();
  private retryAt = new Map<string, number>();
  private cooldownUntil = new Map<string, number>();
  private closedToday: SynthTrade[] = [];
  private closedDay: string;

  private lastError: string | null = null;
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  private publishTimer: ReturnType<typeof setInterval> | null = null;
  private sseClients = new Set<SseClient>();

  constructor(private deps: SyntheticEngineDeps) {
    this.cfg = deps.config ?? loadSynthConfig();
    this.strikeLevel = this.cfg.strikeLevel;
    this.minExpectedNetProfit = this.cfg.minExpectedNetProfit;
    this.safetyBuffer = this.cfg.safetyBuffer;
    this.closedDay = deps.istDayKey();
  }

  /* ------------------------------- lifecycle ------------------------------ */

  /** Adopt open paper positions and start the loop. Call once, after the DB is up. */
  async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    this.ensureLoop();
    await this.loadFromStore();
  }

  /**
   * Adopt open positions and today's closed trades from the store.
   *
   * Retried from the loop until it succeeds, and automatic entries wait for it: an
   * entry made before the book is known could not respect the one-per-underlying
   * and max-open limits.
   */
  private async loadFromStore(): Promise<void> {
    if (this.loaded || this.loading) return;
    this.lastLoadAttemptAt = Date.now();
    if (!this.deps.store.enabled()) return;
    this.loading = true;
    try {
      const open = await this.deps.store.loadOpen();
      for (const t of open) {
        if (this.positions.has(t.id)) continue;
        this.positions.set(t.id, t);
        // Entry-time tokens may belong to another broker. Nothing is subscribed until
        // the next universe refresh has re-resolved every leg in the active namespace.
        this.unlinked.add(t.id);
      }
      const today = this.deps.istDayKey();
      const closed = await this.deps.store.loadClosed({ limit: 2000, sinceDay: today });
      const known = new Set(this.closedToday.map((t) => t.id));
      this.closedToday = [...this.closedToday, ...closed.filter((t) => !known.has(t.id))].sort(
        (a, b) => (b.closed_at ?? 0) - (a.closed_at ?? 0),
      );
      this.closedDay = today;
      this.loaded = true;
      if (open.length > 0) {
        console.log(`[Synthetic] adopted ${open.length} open paper position(s)`);
        // Re-link and subscribe them without waiting for the next scheduled refresh.
        this.universeAt = null;
        this.lastRefreshAttemptAt = 0;
      }
    } catch (err) {
      this.lastError = `Could not load paper trades: ${message(err)}`;
      console.warn("[Synthetic] loading paper trades failed:", err);
    } finally {
      this.loading = false;
    }
  }

  async start(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.deps.marketData.isAuthenticated()) {
      return { ok: false, error: "No broker session: connect the active broker first." };
    }
    if (this.running) return { ok: true };
    this.running = true;
    this.lastError = null;
    this.ensureLoop();
    await this.loadFromStore();
    try {
      await this.refreshUniverse();
    } catch (err) {
      this.lastError = message(err);
    }
    this.evaluate(Date.now(), this.deps.isMarketOpen());
    this.publish();
    return { ok: true };
  }

  /**
   * STOP discovery: no new paper positions, and every window token is released.
   * Open positions stay subscribed, keep being marked, and can still auto-exit.
   */
  stop(): void {
    this.running = false;
    this.windows.clear();
    this.selection = [];
    this.opportunities = [];
    this.eligibleStreak.clear();
    this.skippedForBudget = 0;
    this.reservedCount = 0;
    this.unbuiltCount = 0;
    this.budgetGrowPending = false;
    this.applySubscriptions();
    this.publish();
  }

  /** Close timers and SSE clients, for process shutdown. Positions stay open (durable). */
  dispose(): void {
    this.stop();
    if (this.loopTimer) clearInterval(this.loopTimer);
    if (this.publishTimer) clearInterval(this.publishTimer);
    this.loopTimer = null;
    this.publishTimer = null;
    for (const c of this.sseClients) {
      try {
        c.res.end();
      } catch {
        /* already gone */
      }
    }
    this.sseClients.clear();
  }

  /** The lane reconnected: no cached book may be trusted any more. */
  invalidateBooks(): void {
    this.quotes.invalidateGeneration();
  }

  /**
   * The broker's token namespace is being replaced (switch, logout, lost session).
   *
   * Every token this engine knows is forgotten and nothing is subscribed again until
   * the universe has been reloaded and every open leg re-resolved. Otherwise an old
   * Kite token could be subscribed on a Dhan socket as a different instrument.
   */
  invalidateNamespace(): void {
    this.namespaceEpoch++;
    this.namespaceStale = true;
    this.quotes.invalidateGeneration();
    this.closes.clear();
    this.seededRef.clear();
    this.windows.clear();
    this.selection = [];
    this.reservedCount = 0;
    this.unbuiltCount = 0;
    this.watched.clear();
    this.opportunities = [];
    this.eligibleStreak.clear();
    this.exitStreak.clear();
    this.universeAt = null;
    for (const id of this.positions.keys()) this.unlinked.add(id);
  }

  /** After a broker switch: rebuild in the new namespace and re-link open positions. */
  async reloadUniverse(): Promise<void> {
    if (this.refreshing) await this.refreshing.catch(() => undefined);
    this.universeAt = null;
    if (this.active()) await this.refreshUniverse();
  }

  setStrikeLevel(level: unknown): { ok: true } | { ok: false; error: string } {
    const lvl = clampSynthStrikeLevel(level);
    if (lvl === null) return { ok: false, error: "level must be 1, 2 or 3" };
    if (lvl === this.strikeLevel) return { ok: true };
    this.strikeLevel = lvl;
    if (this.running) {
      // Rebuild every window at the new width around its current reference price.
      const now = Date.now();
      for (const u of this.selection) {
        const w = this.windows.get(u);
        const chain = this.chains.get(u);
        const b = this.board.get(u);
        if (!w || !chain || !b) continue;
        const next = buildSynthWindow({ board: b, chain, ref: this.refPriceFor(w), eachSide: lvl, now });
        if (next) this.windows.set(u, next);
      }
      this.fitToBudget(this.tokenBudget(), true);
      this.evaluate(now, this.deps.isMarketOpen());
    }
    return { ok: true };
  }

  updateSettings(body: {
    min_expected_net_profit?: unknown;
    safety_buffer?: unknown;
  }): { ok: true } | { ok: false; error: string } {
    const next = { min: this.minExpectedNetProfit, buf: this.safetyBuffer };
    if (body.min_expected_net_profit !== undefined) {
      const v = Number(body.min_expected_net_profit);
      const lim = SYNTH_TUNING_LIMITS.min_expected_net_profit;
      if (!Number.isFinite(v) || v < lim.min || v > lim.max) {
        return { ok: false, error: `min_expected_net_profit must be ${lim.min}..${lim.max}` };
      }
      next.min = v;
    }
    if (body.safety_buffer !== undefined) {
      const v = Number(body.safety_buffer);
      const lim = SYNTH_TUNING_LIMITS.safety_buffer;
      if (!Number.isFinite(v) || v < lim.min || v > lim.max) {
        return { ok: false, error: `safety_buffer must be ${lim.min}..${lim.max}` };
      }
      next.buf = v;
    }
    this.minExpectedNetProfit = next.min;
    this.safetyBuffer = next.buf;
    this.evaluate(Date.now(), this.deps.isMarketOpen());
    return { ok: true };
  }

  /* -------------------------------- ticks --------------------------------- */

  /** Box-lane ticks. Only tokens this engine watches reach its books. */
  onTicks(ticks: Tick[]): void {
    if (ticks.length === 0 || !this.active()) return;
    this.lastRawTickAt = Date.now();
    if (this.watched.size === 0) return;
    const mine = ticks.filter((t) => this.watched.has(t.token));
    if (mine.length > 0) this.quotes.applyTicks(mine);
  }

  /* ----------------------------- token budget ----------------------------- */

  /**
   * Tokens this engine may hold on the Box lane now.
   *
   * `boxIncoming` is the size of the set Box is ABOUT to declare, when called from
   * `yieldToBox`, so the budget is computed against Box's next state, not its last.
   */
  tokenBudget(boxIncoming?: number): number {
    const base = this.cfg.maxTokens;
    const lane = this.deps.boxLane?.();
    if (!lane) return base;
    const held = boxIncoming ?? lane.heldTokens;
    // A running Box may grow to its full budget at its next refresh, so reserve all of it.
    const reserve = lane.running ? Math.max(held, lane.budget) : held;
    const budget =
      this.cfg.shareBoxBudget && !lane.running ? base + Math.max(0, lane.budget - held) : base;
    return Math.max(0, Math.min(budget, this.cfg.laneTokenLimit - reserve));
  }

  /**
   * Box is about to declare `boxTokens` on the shared lane.
   *
   * Called synchronously BEFORE Box's set goes upstream, so when Box starts this
   * engine drops windows first and the socket never exceeds the lane limit. When Box
   * stops, the freed budget is picked up by the next universe refresh.
   */
  yieldToBox(boxTokens: number): void {
    if (!this.active() || this.namespaceStale) return;
    this.fitToBudget(this.tokenBudget(boxTokens));
  }

  /** Underlyings (in order) whose windows fit in `budget` after the open positions. */
  private pickWithinBudget(order: string[], budget: number): string[] {
    const perWindow = synthTokensFor(this.strikeLevel);
    const cap = this.cfg.maxUnderlyings > 0 ? this.cfg.maxUnderlyings : Infinity;
    let used = this.positions.size * POSITION_TOKENS;
    const out: string[] = [];
    for (const u of order) {
      if (out.length >= cap || used + perWindow > budget) break;
      out.push(u);
      used += perWindow;
    }
    return out;
  }

  /** Drop the lowest-priority windows until they fit. Never drops an open position's legs. */
  private fitToBudget(budget: number, forceApply = false): void {
    const keep = this.pickWithinBudget(this.selection, budget);
    const dropped = this.selection.length - keep.length;
    if (dropped > 0) {
      for (const u of this.selection.slice(keep.length)) this.windows.delete(u);
      this.selection = keep;
      // Unbuilt reservations lose their slot too: both are now out for budget.
      this.skippedForBudget += dropped + this.unbuiltCount;
      this.reservedCount = keep.length;
      this.unbuiltCount = 0;
    } else if (this.running && this.skippedForBudget > 0) {
      // Room for one more RESERVED candidate (not one more built window): a window
      // that failed to build must not keep re-arming the refresh.
      const perWindow = synthTokensFor(this.strikeLevel);
      const cap = this.cfg.maxUnderlyings > 0 ? this.cfg.maxUnderlyings : Infinity;
      const room =
        this.positions.size * POSITION_TOKENS + (this.reservedCount + 1) * perWindow <= budget;
      if (room && this.reservedCount < cap) this.budgetGrowPending = true;
    }
    if (dropped > 0 || forceApply) this.applySubscriptions();
  }

  /* ------------------------------- universe ------------------------------- */

  private active(): boolean {
    return this.running || this.positions.size > 0;
  }

  /** Rebuild expiry pairing, strike windows, position links and subscriptions. Single-flight. */
  refreshUniverse(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefreshUniverse().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefreshUniverse(): Promise<void> {
    if (!this.active() || !this.deps.marketData.isAuthenticated()) return;
    const epoch = this.namespaceEpoch;
    this.lastRefreshAttemptAt = Date.now();
    const today = this.deps.istDayKey();
    const [all, board] = await Promise.all([this.deps.getAllInstruments(), this.deps.getBoard()]);
    if (epoch !== this.namespaceEpoch || !this.active()) return;

    this.chains = indexSyntheticChains(all, today);
    this.board = new Map(board.map((b) => [b.symbol, b]));
    this.relinkPositions(all);
    const resolve = this.deps.makeIdResolver(all);

    // Indices first (deepest books), then stocks alphabetically: a stable
    // selection when the token budget binds.
    const ordered = this.running
      ? board
          .filter((b) => this.chains.has(b.symbol))
          .filter((b) => !(this.cfg.skipExpiryDay && this.chains.get(b.symbol)!.expiry === today))
          .sort((a, b) =>
            (a.is_index === true) === (b.is_index === true)
              ? a.symbol.localeCompare(b.symbol)
              : a.is_index === true ? -1 : 1,
          )
      : [];
    const picked = this.pickWithinBudget(
      ordered.map((b) => b.symbol),
      this.tokenBudget(),
    );
    if (picked.length > 0) {
      await this.seedFromRest(picked, resolve);
      if (epoch !== this.namespaceEpoch || !this.active()) return;
    }

    const now = Date.now();
    const nextWindows = new Map<string, SynthWindow>();
    const order: string[] = [];
    if (this.running) {
      for (const u of picked) {
        const chain = this.chains.get(u);
        const b = this.board.get(u);
        if (!chain || !b) continue;
        const existing = this.windows.get(u);
        const ref =
          (existing && existing.future.token === chain.future.token ? this.refPriceFor(existing) : 0) ||
          this.seededRef.get(u) ||
          0;
        const w = buildSynthWindow({ board: b, chain, ref, eachSide: this.strikeLevel, now });
        if (w) {
          nextWindows.set(u, w);
          order.push(u);
        }
      }
    }
    this.windows = nextWindows;
    this.selection = order;
    this.skippedForBudget = ordered.length - picked.length;
    this.reservedCount = this.running ? picked.length : 0;
    this.unbuiltCount = this.running ? picked.length - order.length : 0;
    this.namespaceStale = false;
    this.budgetGrowPending = false;
    // The budget may have moved while this refresh was awaiting (Box started): honour
    // it before anything is subscribed.
    this.fitToBudget(this.tokenBudget(), true);

    if (!this.deps.isMarketOpen()) {
      await this.seedCloses(resolve);
      if (epoch !== this.namespaceEpoch) return;
      this.closeViewPending = false;
    }
    this.universeAt = Date.now();
    console.log(
      `[Synthetic] universe: ${this.chains.size} paired underlyings, watching ` +
        `${this.selection.length} at ATM ±${this.strikeLevel} + ${this.positions.size} open ` +
        `position(s) (${this.watched.size}/${this.tokenBudget()} tokens, ` +
        `${this.skippedForBudget} skipped for budget)`,
    );
  }

  /**
   * Resolve every open leg in the ACTIVE broker's instrument dump.
   *
   * A position is an exchange position (underlying, expiry, strike, type), so after
   * a broker switch or a restart its legs are looked up again rather than trusting a
   * token from another namespace. A leg that cannot be found keeps the position
   * unlinked: it is shown, never subscribed, and settles at expiry.
   */
  private relinkPositions(all: Instrument[]): void {
    if (this.positions.size === 0) return;
    const wanted = new Set<string>();
    for (const t of this.positions.values()) for (const leg of t.legs) wanted.add(legKey(t, leg));
    const found = new Map<string, number>();
    for (const i of all) {
      if (i.exchange !== "NFO" || !i.name || !i.expiry) continue;
      const type = i.instrument_type;
      if (type !== "FUT" && type !== "CE" && type !== "PE") continue;
      const k = `${i.name}|${i.expiry}|${type}|${type === "FUT" ? 0 : i.strike}`;
      if (wanted.has(k)) found.set(k, i.instrument_token);
    }
    for (const t of this.positions.values()) {
      let ok = true;
      for (const leg of t.legs) {
        const token = found.get(legKey(t, leg));
        if (token === undefined) ok = false;
        else leg.token = token;
      }
      if (ok) this.unlinked.delete(t.id);
      else this.unlinked.add(t.id);
    }
  }

  /** One REST snapshot of every picked future, to centre windows before ticks. */
  private async seedFromRest(
    picked: string[],
    resolve: (token: number) => string | null,
  ): Promise<void> {
    const byToken = new Map<number, string>();
    for (const u of picked) {
      const chain = this.chains.get(u);
      if (chain) byToken.set(chain.future.token, u);
    }
    const ids = [...byToken.keys()]
      .map((t) => resolve(t))
      .filter((s): s is string => typeof s === "string");
    if (ids.length === 0) return;
    try {
      const quotes = await this.deps.marketData.getQuoteFull(ids);
      for (const q of quotes) {
        const u = byToken.get(q.instrument_token);
        if (u && q.last_price > 0) this.seededRef.set(u, q.last_price);
      }
    } catch (err) {
      console.warn("[Synthetic] future price seed failed:", err);
      this.lastError = "Could not fetch futures prices to centre the strike windows.";
    }
  }

  /**
   * Last-session closes for every watched token.
   *
   * Only prints from the LATEST session are kept (the same rule Box's last-close
   * view uses), so a strike that has not traded for days cannot pair with today's
   * future and fake a mispricing.
   */
  private async seedCloses(resolve: (token: number) => string | null): Promise<void> {
    const ids = [...this.watched]
      .map((t) => resolve(t))
      .filter((s): s is string => typeof s === "string");
    if (ids.length === 0) return;
    try {
      const quotes = await this.deps.marketData.getQuoteFull(ids);
      const sessionDay = quotes.reduce((latest, q) => {
        const d = q.last_trade_time.slice(0, 10);
        return d > latest ? d : latest;
      }, "");
      this.closes.clear();
      for (const q of quotes) {
        if (q.last_price > 0 && sessionDay && q.last_trade_time.slice(0, 10) === sessionDay) {
          this.closes.set(q.instrument_token, q.last_price);
        }
      }
      this.closeSessionDay = sessionDay || null;
    } catch (err) {
      console.warn("[Synthetic] close seed failed:", err);
    }
  }

  /** Declare windows ∪ open legs as this engine's whole token set. */
  private applySubscriptions(): void {
    if (this.namespaceStale) return;
    const next = new Set<number>();
    for (const t of this.positions.values()) {
      if (this.unlinked.has(t.id)) continue;
      for (const leg of t.legs) next.add(leg.token);
    }
    for (const u of this.selection) {
      const w = this.windows.get(u);
      if (w) for (const tok of synthWindowTokens(w)) next.add(tok);
    }
    if (sameSet(next, this.watched)) return;
    const dropped = [...this.watched].filter((t) => !next.has(t));
    this.watched = next;
    if (dropped.length > 0) {
      this.quotes.forget(dropped);
      for (const t of dropped) this.closes.delete(t);
    }
    this.deps.setTokens([...next]);
  }

  /** Future mid when there is a live two-sided book, else its last, else the seed. */
  private refPriceFor(w: SynthWindow): number {
    const q = this.quotes.get(w.future.token);
    if (q && q.bid > 0 && q.ask > 0) return (q.bid + q.ask) / 2;
    if (q && q.last > 0) return q.last;
    return this.seededRef.get(w.underlying) ?? w.ref_price;
  }

  /** LTP for the broker-screen mark: the live last, else the last session's close. */
  private ltpFor(token: number): number | null {
    const q = this.quotes.get(token);
    if (q && q.last > 0) return q.last;
    const c = this.closes.get(token);
    return c !== undefined && c > 0 ? c : null;
  }

  /* --------------------------------- loop --------------------------------- */

  private ensureLoop(): void {
    if (this.loopTimer) return;
    this.loopTimer = setInterval(() => this.tick(), this.cfg.evalIntervalMs);
    this.loopTimer.unref?.();
  }

  private tick(): void {
    try {
      const now = Date.now();
      const marketOpen = this.deps.isMarketOpen();
      if (!this.loaded && now - this.lastLoadAttemptAt >= LOAD_RETRY_MS) void this.loadFromStore();
      this.rollDay(now);
      if (this.lastMarketOpen === true && !marketOpen) this.closeViewPending = true;
      this.lastMarketOpen = marketOpen;
      this.maybeRefreshUniverse(now);
      if (this.active() && !this.namespaceStale) this.fitToBudget(this.tokenBudget());
      this.evaluate(now, marketOpen);
      this.monitorPositions(now, marketOpen);
      this.autoEnter(now, marketOpen);
    } catch (err) {
      this.lastError = message(err);
      console.warn("[Synthetic] loop failed:", err);
    }
  }

  /** At IST midnight, today's closed list starts empty. */
  private rollDay(now: number): void {
    const today = this.deps.istDayKey(now);
    if (today === this.closedDay) return;
    this.closedDay = today;
    this.closedToday = this.closedToday.filter((t) => t.closed_day === today);
  }

  private maybeRefreshUniverse(now: number): void {
    if (!this.active() || this.refreshing || !this.deps.marketData.isAuthenticated()) return;
    const sinceAttempt = now - this.lastRefreshAttemptAt;
    const due =
      this.universeAt === null
        ? sinceAttempt >= FIRST_REFRESH_RETRY_MS
        : now - this.universeAt >= this.cfg.universeRefreshMs ||
          (this.closeViewPending && sinceAttempt >= REFRESH_DEBOUNCE_MS) ||
          (this.budgetGrowPending && this.running && sinceAttempt >= REFRESH_DEBOUNCE_MS) ||
          (this.unbuiltCount > 0 && this.running && sinceAttempt >= UNBUILT_RETRY_MS);
    if (!due) return;
    void this.refreshUniverse().catch((err) => {
      this.lastError = message(err);
    });
  }

  private feedHealthy(now: number, marketOpen: boolean): boolean {
    return (
      marketOpen &&
      this.lastRawTickAt !== null &&
      now - this.lastRawTickAt <= this.cfg.feedMaxAgeMs
    );
  }

  /* ------------------------------ evaluation ------------------------------ */

  private rfPct(): number {
    const rf = this.deps.getRfPct();
    return rf !== null && Number.isFinite(rf) ? rf : this.cfg.defaultRfPct;
  }

  private directions(): SynthDirection[] {
    return SYNTH_DIRECTIONS.filter((d) =>
      d === "CONVERSION" ? this.cfg.enableConversion : this.cfg.enableReversal,
    );
  }

  private exitRules(): SynthExitRules {
    return {
      convergenceFloor: this.cfg.convergenceFloor,
      convergencePct: this.cfg.convergencePct,
      minExitNetPnl: this.cfg.minExitNetPnl,
      profitCapturePct: this.cfg.profitCapturePct,
      minCapturedPct: this.cfg.minCapturedPct,
    };
  }

  /**
   * Re-centre drifting windows, then re-price every strike in both directions.
   *
   * `observe` is false for the refresh after an entry or exit: that re-prices the
   * same books, so it must not count as another confirmation of a signal.
   */
  private evaluate(now: number, marketOpen: boolean, observe = true): void {
    if (!this.running || this.namespaceStale) {
      this.opportunities = [];
      this.eligibleStreak.clear();
      return;
    }

    if (marketOpen) {
      let moved = false;
      for (const u of this.selection) {
        const w = this.windows.get(u);
        if (!w) continue;
        const ref = this.refPriceFor(w);
        if (
          synthWindowNeedsRebuild({
            window: w,
            ref,
            now,
            hysteresis: this.cfg.atmHysteresis,
            minIntervalMs: this.cfg.windowMinIntervalMs,
          })
        ) {
          const chain = this.chains.get(u);
          const b = this.board.get(u);
          const next = chain && b
            ? buildSynthWindow({ board: b, chain, ref, eachSide: this.strikeLevel, now })
            : null;
          if (next) {
            this.windows.set(u, next);
            moved = true;
          }
        }
      }
      if (moved) this.applySubscriptions();
    }

    const quoteFor = marketOpen
      ? (token: number): SynthQuoteLike | undefined => this.quotes.get(token)
      : (token: number): SynthQuoteLike | undefined => {
          const last = this.closes.get(token);
          return last === undefined
            ? undefined
            : { bid: 0, bid_qty: 0, ask: 0, ask_qty: 0, last, at: now };
        };

    const rfPct = this.rfPct();
    const dirs = this.directions();
    const out: SynthOpportunity[] = [];
    for (const u of this.selection) {
      const w = this.windows.get(u);
      if (!w) continue;
      for (const strike of w.strikes) {
        for (const direction of dirs) {
          out.push(
            evaluateSynthetic({
              window: w,
              strike,
              direction,
              quoteFor,
              params: {
                quantity: w.lot_size,
                now,
                quoteMaxAgeMs: this.cfg.quoteMaxAgeMs,
                rfPct,
                includeCarry: this.cfg.includeCarry,
                minExpectedNetProfit: this.minExpectedNetProfit,
                safetyBuffer: this.safetyBuffer,
                expectedSlippage: this.cfg.expectedSlippage,
                optionRates: this.cfg.optionRates,
                futuresRates: this.cfg.futuresRates,
                indicative: !marketOpen,
              },
            }),
          );
        }
      }
    }

    // A signal must hold for N consecutive evaluations before it is entered.
    if (observe) {
      const streak = new Map<string, number>();
      for (const o of out) {
        if (o.status === "ELIGIBLE") streak.set(o.key, (this.eligibleStreak.get(o.key) ?? 0) + 1);
      }
      this.eligibleStreak = streak;
    }
    this.annotate(out, now, marketOpen);
    this.opportunities = sortOpportunities(out);
    this.evaluatedAt = now;
  }

  /** Mark the rows that are held, and say why an ELIGIBLE row is not being entered. */
  private annotate(out: SynthOpportunity[], now: number, marketOpen: boolean): void {
    const openByKey = new Map<string, string>();
    const openUnderlyings = new Set<string>();
    for (const t of this.positions.values()) {
      openByKey.set(t.key, t.id);
      openUnderlyings.add(t.underlying);
    }
    const today = this.deps.istDayKey(now);
    const db = this.deps.store.enabled() && this.loaded;
    const feedOk = this.feedHealthy(now, marketOpen);
    const full = this.positions.size + this.pendingEntries.size >= this.cfg.maxOpenPositions;
    for (const o of out) {
      const pid = openByKey.get(o.key);
      if (pid !== undefined) {
        o.status = "OPEN";
        o.position_id = pid;
        continue;
      }
      if (o.status !== "ELIGIBLE") continue;
      o.entry_blocked = !this.cfg.paperTrading
        ? "paper_off"
        : !db
          ? "no_db"
          : !feedOk
            ? "feed_stale"
            : openUnderlyings.has(o.underlying)
              ? "position_open"
              : this.pendingEntries.has(o.underlying)
                ? "entering"
                : (this.cooldownUntil.get(o.underlying) ?? 0) > now
                  ? "cooldown"
                  : inExpirySafetyWindow(o.expiry, today, now, this.cfg.expirySafetyMinutes)
                    ? "expiry_cutoff"
                    : full
                      ? "max_open"
                      : (this.eligibleStreak.get(o.key) ?? 0) < this.cfg.signalConfirmations
                        ? "confirming"
                        : null;
    }
  }

  /* ---------------------------- paper trading ----------------------------- */

  /** Re-price after an entry or exit so the rows show OPEN / blocked at once. */
  private refreshRows(): void {
    if (this.running) this.evaluate(Date.now(), this.deps.isMarketOpen(), false);
  }

  private hasOpen(underlying: string): boolean {
    for (const t of this.positions.values()) if (t.underlying === underlying) return true;
    return false;
  }

  /** Paper-enter every ELIGIBLE, unblocked opportunity, best first. */
  private autoEnter(now: number, marketOpen: boolean): void {
    if (!this.running || !this.cfg.paperTrading || !marketOpen || this.namespaceStale) return;
    if (!this.deps.store.enabled() || !this.loaded || !this.feedHealthy(now, marketOpen)) return;
    for (const o of this.opportunities) {
      if (o.status !== "ELIGIBLE") break; // sorted: every ELIGIBLE row comes first
      if (o.entry_blocked !== null) continue;
      if (this.positions.size + this.pendingEntries.size >= this.cfg.maxOpenPositions) break;
      if (this.pendingEntries.has(o.underlying) || this.hasOpen(o.underlying)) continue;
      void this.enter(o);
    }
  }

  /** Open one paper position at the touch the opportunity was priced at. */
  private async enter(o: SynthOpportunity): Promise<void> {
    const u = o.underlying;
    // Synchronous, before any await: a second row for the same underlying in this
    // pass sees the pending entry and is skipped.
    this.pendingEntries.add(u);
    const epoch = this.namespaceEpoch;
    try {
      const now = Date.now();
      const trade = openTradeFromOpportunity({
        opp: o,
        id: this.deps.store.newId(),
        broker: this.deps.activeBroker(),
        now,
        day: this.deps.istDayKey(now),
        optionRateVersion: this.cfg.optionRates.rateVersion,
        futuresRateVersion: this.cfg.futuresRates.rateVersion,
      });
      if (!trade) return;
      const res = await this.deps.store.insertOpen(trade);
      this.cooldownUntil.set(u, Date.now() + this.cfg.reentryCooldownMs);
      // Another process already holds this underlying: never open it twice.
      if (res === "duplicate") return;
      this.positions.set(trade.id, trade);
      // The namespace changed while the insert was in flight: re-link before subscribing.
      if (epoch !== this.namespaceEpoch) this.unlinked.add(trade.id);
      this.eligibleStreak.delete(o.key);
      this.fitToBudget(this.tokenBudget(), true);
      console.log(
        `[Synthetic] paper ENTRY ${trade.direction} ${u} ${trade.expiry} K=${trade.strike} ` +
          `lock ₹${trade.entry_edge} expected net ₹${trade.expected_net_profit}`,
      );
      this.broadcast("entry", { trade: toTradeView(trade) });
      this.refreshRows();
      this.publish();
    } catch (err) {
      this.cooldownUntil.set(u, Date.now() + this.cfg.reentryCooldownMs);
      this.lastError = `Paper entry on ${u} failed: ${message(err)}`;
      console.warn("[Synthetic] paper entry failed:", err);
    } finally {
      this.pendingEntries.delete(u);
    }
  }

  /** Price every open position and act on exits and expiry settlement. */
  private monitorPositions(now: number, marketOpen: boolean): void {
    if (this.positions.size === 0) return;
    const today = this.deps.istDayKey(now);
    const feedOk = this.feedHealthy(now, marketOpen);
    for (const t of [...this.positions.values()]) {
      if (this.closing.has(t.id) || (this.retryAt.get(t.id) ?? 0) > now) continue;
      if (isPastSettlement(t.expiry, today, now, marketOpen)) {
        void this.finalize(t, settleTradeAtExpiry(t, now, today));
        continue;
      }
      const linked = !this.namespaceStale && !this.unlinked.has(t.id);
      const m = this.priceExit(t, now, today, marketOpen, linked);
      this.metrics.set(t.id, m);
      // Rule exits must hold for N evaluations; expiry safety acts at once.
      const streak = m.rule_reason !== null && m.executable ? (this.exitStreak.get(t.id) ?? 0) + 1 : 0;
      this.exitStreak.set(t.id, streak);
      if (!marketOpen || !feedOk || !linked || !m.should_exit || m.reason === null) continue;
      if (m.reason !== "EXPIRY_SAFETY" && streak < this.cfg.signalConfirmations) continue;
      const closed = closeTradeAtTouch(t, m, m.reason, now, today);
      if (closed) void this.finalize(t, closed);
    }
  }

  private priceExit(
    t: SynthTrade,
    now: number,
    today: string,
    marketOpen: boolean,
    linked: boolean,
  ): SynthExitMetrics {
    return evaluateSynthExit({
      trade: t,
      // No touch while the market is shut: nothing is executable then.
      quoteFor: (tok) => (linked && marketOpen ? this.quotes.get(tok) : undefined),
      ltpFor: (tok) => (linked ? this.ltpFor(tok) : null),
      now,
      quoteMaxAgeMs: this.cfg.quoteMaxAgeMs,
      expirySafety: inExpirySafetyWindow(t.expiry, today, now, this.cfg.expirySafetyMinutes),
      rules: this.exitRules(),
      optionRates: this.cfg.optionRates,
      futuresRates: this.cfg.futuresRates,
    });
  }

  /** Persist a close, atomically. The position leaves memory only once that succeeded. */
  private async finalize(
    open: SynthTrade,
    closed: SynthTrade,
  ): Promise<{ ok: true; trade: SynthTrade } | { ok: false; error: string }> {
    if (this.closing.has(open.id)) return { ok: false, error: "This position is already closing." };
    this.closing.add(open.id);
    try {
      if (!this.deps.store.enabled()) {
        throw new Error("paper-trade storage is unavailable, so the close cannot be recorded");
      }
      const won = await this.deps.store.close(closed);
      this.positions.delete(open.id);
      this.metrics.delete(open.id);
      this.exitStreak.delete(open.id);
      this.retryAt.delete(open.id);
      this.unlinked.delete(open.id);
      this.cooldownUntil.set(open.underlying, Date.now() + this.cfg.reentryCooldownMs);
      if (!won) {
        // Closed elsewhere (a racing request or another process): never close twice.
        this.applySubscriptions();
        return { ok: false, error: "This position was already closed." };
      }
      if (closed.closed_day === this.closedDay) this.closedToday.unshift(closed);
      this.applySubscriptions();
      console.log(
        `[Synthetic] paper EXIT ${closed.exit_reason} ${closed.direction} ${closed.underlying} ` +
          `K=${closed.strike} gross ₹${closed.gross_pnl} charges ₹${closed.total_charges} ` +
          `net ₹${closed.net_pnl}`,
      );
      this.broadcast("exit", { trade: toTradeView(closed) });
      this.refreshRows();
      this.publish();
      return { ok: true, trade: closed };
    } catch (err) {
      // The position stays open and monitored; the close is retried shortly.
      this.retryAt.set(open.id, Date.now() + CLOSE_RETRY_MS);
      this.lastError = `Closing ${open.underlying} failed: ${message(err)}`;
      console.warn("[Synthetic] close failed:", err);
      return { ok: false, error: message(err) };
    } finally {
      this.closing.delete(open.id);
    }
  }

  /** Close an open paper position now, at the executable touch. */
  async closeManually(
    id: string,
  ): Promise<{ ok: true; trade: SynthTrade } | { ok: false; status: number; error: string }> {
    const t = this.positions.get(id);
    if (!t) return { ok: false, status: 404, error: "No open paper position with that id." };
    const now = Date.now();
    const marketOpen = this.deps.isMarketOpen();
    if (!marketOpen) {
      return {
        ok: false,
        status: 409,
        error: "The market is closed. A paper position can only be closed at a live touch.",
      };
    }
    if (this.namespaceStale || this.unlinked.has(id)) {
      return {
        ok: false,
        status: 409,
        error: "This position's contracts are not resolved on the active broker yet.",
      };
    }
    const today = this.deps.istDayKey(now);
    const m = this.priceExit(t, now, today, marketOpen, true);
    this.metrics.set(id, m);
    const closed = closeTradeAtTouch(t, m, "MANUAL", now, today);
    if (!closed) {
      const thin = m.legs
        .filter((l) => !l.executable)
        .map((l) =>
          `${l.tradingsymbol} (${
            l.price === null
              ? `no ${l.side === "BUY" ? "ask" : "bid"}`
              : !l.fresh
                ? "stale book"
                : "under one lot at the touch"
          })`,
        );
      return {
        ok: false,
        status: 409,
        error:
          `Cannot close at the touch right now: ${thin.join(", ") || "legs are not executable"}. ` +
          "No fill is invented; the position stays open.",
      };
    }
    const r = await this.finalize(t, closed);
    return r.ok ? r : { ok: false, status: 409, error: r.error };
  }

  /* -------------------------------- views --------------------------------- */

  /**
   * The best `limit` rows of the full sorted list, or, without a limit, the same
   * capped set the stream publishes. With Box's budget borrowed the full list can
   * run to thousands of rows, too large to send on every page load.
   */
  getOpportunities(limit?: number): SynthOpportunity[] {
    return limit && limit > 0
      ? this.opportunities.slice(0, limit)
      : this.publishedOpportunities();
  }

  /**
   * The rows pushed to the browser: every ELIGIBLE and OPEN row, then the best row
   * of each underlying, then the next best, up to the cap. Counts in the status
   * always describe the full evaluated set.
   */
  private publishedOpportunities(): SynthOpportunity[] {
    const cap = this.cfg.maxPublishedOpportunities;
    const all = this.opportunities;
    if (all.length <= cap) return all;
    const picked: SynthOpportunity[] = [];
    const taken = new Set<string>();
    const seen = new Set<string>();
    const take = (o: SynthOpportunity) => {
      picked.push(o);
      taken.add(o.key);
      seen.add(o.underlying);
    };
    for (const o of all) if (o.status === "ELIGIBLE" || o.status === "OPEN") take(o);
    for (const o of all) {
      if (picked.length >= cap) break;
      if (!taken.has(o.key) && !seen.has(o.underlying)) take(o);
    }
    for (const o of all) {
      if (picked.length >= cap) break;
      if (!taken.has(o.key)) take(o);
    }
    return sortOpportunities(picked);
  }

  getOpenPositions(): SynthOpenView[] {
    return [...this.positions.values()]
      .sort((a, b) => a.opened_at - b.opened_at)
      .map((t) => this.openView(t));
  }

  private openView(t: SynthTrade): SynthOpenView {
    const m = this.metrics.get(t.id);
    const rules = this.exitRules();
    return {
      ...toTradeView(t),
      linked: !this.namespaceStale && !this.unlinked.has(t.id),
      closing: this.closing.has(t.id),
      exit_legs: m?.legs ?? [],
      mtm_ltp: m?.mtm_ltp ?? null,
      // "If closed now" figures, labelled as such in the UI. `exit_charges` stays null
      // until the trade is actually closed.
      gross_pnl: m?.gross_pnl ?? null,
      current_exit_charges: m?.exit_charges ?? null,
      total_charges: m?.total_charges ?? null,
      net_pnl: m?.net_pnl ?? null,
      remaining_edge: m?.remaining_edge ?? null,
      captured_edge: m?.captured_edge ?? null,
      captured_pct: m?.captured_pct ?? null,
      convergence_threshold:
        m?.convergence_threshold ??
        Math.max(rules.convergenceFloor, rules.convergencePct * t.entry_net_edge),
      profit_capture_target: m?.profit_capture_target ?? rules.profitCapturePct * t.entry_net_edge,
      min_exit_net_pnl: rules.minExitNetPnl,
      expiry_safety: m?.expiry_safety ?? false,
      exit_eligible: m?.should_exit ?? false,
      exit_rule_reason: m?.rule_reason ?? null,
      exit_blocked_reason: m?.blocked_reason ?? null,
    };
  }

  /** Closed paper trades, newest first: today from memory, or the whole book from Mongo. */
  async getHistory(
    scope: "today" | "all",
    limit: number,
  ): Promise<{ db_enabled: boolean; scope: "today" | "all"; trades: SynthTradeView[] }> {
    const db = this.deps.store.enabled();
    if (scope === "today" || !db) {
      return { db_enabled: db, scope, trades: this.closedToday.map(toTradeView) };
    }
    const rows = await this.deps.store.loadClosed({ limit });
    const byId = new Map<string, SynthTrade>();
    for (const t of rows) byId.set(t.id, t);
    for (const t of this.closedToday) byId.set(t.id, t);
    const trades = [...byId.values()]
      .sort((a, b) => (b.closed_at ?? 0) - (a.closed_at ?? 0))
      .slice(0, limit);
    return { db_enabled: db, scope, trades: trades.map(toTradeView) };
  }

  private dayPnl(): SynthDayPnl {
    return computeSynthDayPnl({
      day: this.closedDay,
      open: [...this.positions.values()].map((t) => {
        const m = this.metrics.get(t.id);
        return {
          mtm_ltp: m?.mtm_ltp ?? null,
          gross_pnl: m?.gross_pnl ?? null,
          net_pnl: m?.net_pnl ?? null,
        };
      }),
      closedToday: this.closedToday,
    });
  }

  getStatus() {
    const now = Date.now();
    const marketOpen = this.deps.isMarketOpen();
    const feedAge = this.lastRawTickAt === null ? null : now - this.lastRawTickAt;
    const lane = this.deps.boxLane?.() ?? null;
    const budget = this.tokenBudget();
    const db = this.deps.store.enabled();
    return {
      running: this.running,
      market_open: marketOpen,
      authenticated: this.deps.marketData.isAuthenticated(),
      broker: this.deps.activeBroker(),
      detection_only: !this.cfg.paperTrading,
      execution_mode: "paper_touch" as const,
      paper_trading: this.cfg.paperTrading && db && this.loaded,
      paper_blocked_reason: !this.cfg.paperTrading
        ? "disabled"
        : !db
          ? "no_db"
          : !this.loaded
            ? "loading"
            : null,
      db_enabled: db,
      strike_level: this.strikeLevel,
      paired_underlyings: this.chains.size,
      monitored_underlyings: this.selection.length,
      skipped_for_budget: this.skippedForBudget,
      /** Budgeted underlyings whose window could not be built yet (no future price). */
      unbuilt_windows: this.unbuiltCount,
      subscribed_tokens: this.watched.size,
      ready_books: this.quotes.size,
      token_budget: budget,
      base_token_budget: this.cfg.maxTokens,
      borrowed_from_box: Math.max(0, budget - this.cfg.maxTokens),
      box_scanner_running: lane ? lane.running : null,
      box_lane_tokens: lane ? lane.heldTokens : null,
      feed_age_ms: feedAge,
      feed_healthy:
        !this.active() || !marketOpen || (feedAge !== null && feedAge <= this.cfg.feedMaxAgeMs),
      universe_at: this.universeAt,
      evaluated_at: this.evaluatedAt,
      close_session_day: marketOpen ? null : this.closeSessionDay,
      eligible_count: this.opportunities.filter((o) => o.status === "ELIGIBLE").length,
      opportunity_count: this.opportunities.length,
      open_count: this.positions.size,
      max_open_positions: this.cfg.maxOpenPositions,
      unlinked_positions: [...this.positions.keys()].filter((id) => this.unlinked.has(id)).length,
      day_pnl: this.dayPnl(),
      rf_pct: this.rfPct(),
      rf_source: this.deps.getRfPct() !== null ? "admin" : "default",
      last_error: this.lastError,
      config: this.getConfigView(),
    };
  }

  getConfigView() {
    return {
      strike_level: this.strikeLevel,
      min_expected_net_profit: this.minExpectedNetProfit,
      safety_buffer: this.safetyBuffer,
      expected_slippage: this.cfg.expectedSlippage,
      include_carry: this.cfg.includeCarry,
      default_rf_pct: this.cfg.defaultRfPct,
      quote_max_age_ms: this.cfg.quoteMaxAgeMs,
      feed_max_age_ms: this.cfg.feedMaxAgeMs,
      max_tokens: this.cfg.maxTokens,
      share_box_budget: this.cfg.shareBoxBudget,
      lane_token_limit: this.cfg.laneTokenLimit,
      max_underlyings: this.cfg.maxUnderlyings,
      max_published_opportunities: this.cfg.maxPublishedOpportunities,
      enable_conversion: this.cfg.enableConversion,
      enable_reversal: this.cfg.enableReversal,
      skip_expiry_day: this.cfg.skipExpiryDay,
      paper_trading: this.cfg.paperTrading,
      max_open_positions: this.cfg.maxOpenPositions,
      signal_confirmations: this.cfg.signalConfirmations,
      reentry_cooldown_ms: this.cfg.reentryCooldownMs,
      convergence_floor: this.cfg.convergenceFloor,
      convergence_pct: this.cfg.convergencePct,
      min_exit_net_pnl: this.cfg.minExitNetPnl,
      profit_capture_pct: this.cfg.profitCapturePct,
      min_captured_pct: this.cfg.minCapturedPct,
      expiry_safety_minutes: this.cfg.expirySafetyMinutes,
      option_rate_version: this.cfg.optionRates.rateVersion,
      futures_rate_version: this.cfg.futuresRates.rateVersion,
      tunable: SYNTH_TUNING_LIMITS,
    };
  }

  /** The watched window of one underlying with live books, for the chain view. */
  getChain(underlying: string): SynthChainView | null {
    const w = this.windows.get(underlying);
    if (!w) return null;
    const now = Date.now();
    const marketOpen = this.deps.isMarketOpen();
    const side = (token: number, tradingsymbol: string): SynthChainSide => {
      const q = this.quotes.get(token);
      const close = this.closes.get(token) ?? 0;
      return {
        token,
        tradingsymbol,
        bid: q?.bid ?? 0,
        bid_qty: q?.bid_qty ?? 0,
        ask: q?.ask ?? 0,
        ask_qty: q?.ask_qty ?? 0,
        last: q?.last || (marketOpen ? 0 : close),
        age_ms: q ? now - q.at : null,
      };
    };
    return {
      underlying: w.underlying,
      name: w.name,
      is_index: w.is_index,
      expiry: w.expiry,
      lot_size: w.lot_size,
      atm_strike: w.atm_strike,
      strike_step: w.strike_step,
      future: side(w.future.token, w.future.tradingsymbol),
      strikes: w.strikes.map((s) => ({
        strike: s,
        is_atm: s === w.atm_strike,
        ce: side(w.ce.get(s)!.token, w.ce.get(s)!.tradingsymbol),
        pe: side(w.pe.get(s)!.token, w.pe.get(s)!.tradingsymbol),
      })),
    };
  }

  /* --------------------------------- SSE ---------------------------------- */

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
      if (this.sseClients.size === 0 && this.publishTimer) {
        clearInterval(this.publishTimer);
        this.publishTimer = null;
      }
    };
  }

  private snapshot() {
    return {
      status: this.getStatus(),
      opportunities: this.publishedOpportunities(),
      open_trades: this.getOpenPositions(),
    };
  }

  publish(): void {
    if (this.sseClients.size === 0) return;
    const payload = this.snapshot();
    for (const c of this.sseClients) this.writeFrame(c, "snapshot", payload);
  }

  private broadcast(event: string, payload: unknown): void {
    for (const c of this.sseClients) this.writeFrame(c, event, payload);
  }

  private writeFrame(client: SseClient, event: string, payload: unknown): void {
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      /* the request's close handler removes the client */
    }
  }
}
