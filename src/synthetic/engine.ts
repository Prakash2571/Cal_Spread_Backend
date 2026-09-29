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
import type { BoxMarginProvider, BoxMarketDataProvider } from "../box/brokerContext.js";
import { BoxQuoteStore } from "../box/quotes.js";
import {
  SYNTH_SETTING_KEYS,
  SYNTH_TUNING_LIMITS,
  clampSynthStrikeLevel,
  loadSynthConfig,
  parseSynthSetting,
  type SynthConfig,
  type SynthSettingKey,
  type SynthSettings,
  type SynthStrikeLevel,
} from "./config.js";
import {
  SYNTH_DIRECTIONS,
  buildSynthWindow,
  closeTradeAtTouch,
  computeSynthDayPnl,
  depthOf,
  evaluateSynthExit,
  evaluateSynthetic,
  inExpirySafetyWindow,
  indexSyntheticChains,
  isPastSettlement,
  openTradeFromOpportunity,
  settleTradeAtExpiry,
  sortOpportunities,
  synthMarginOrders,
  synthTokensFor,
  synthWindowNeedsRebuild,
  synthWindowTokens,
  type SynthBoardItem,
  type SynthChainIndex,
  type SynthDayPnl,
  type SynthDepth,
  type SynthDirection,
  type SynthExitLeg,
  type SynthExitMetrics,
  type SynthExitRules,
  type SynthMarginSource,
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
  /**
   * Create and verify what the atomicity guarantees rest on (the unique index).
   * Throws when that cannot be established; paper entries stay off until it succeeds.
   */
  ensureReady?(): Promise<void>;
  newId(): string;
  /**
   * The stored row, used to reconcile a write whose outcome was ambiguous.
   * `deleted` is set when the row was soft-deleted (its status then reads "closed"),
   * with `deleted_from` saying whether it was open or closed when deleted.
   */
  get(id: string): Promise<(SynthTrade & { deleted?: boolean; deleted_from?: "open" | "closed" }) | null>;
  /** "duplicate" when the underlying already has an open position. */
  insertOpen(trade: SynthTrade): Promise<"ok" | "duplicate">;
  /** Atomic open → closed. False when it was not open (already closed elsewhere). */
  close(trade: SynthTrade): Promise<boolean>;
  /** Record a trade's margin figure. The only writer of the margin fields. */
  setMargin(id: string, patch: SynthMarginPatch): Promise<void>;
  /**
   * Soft-delete a trade whose status is still `from`. False when it no longer is
   * (closed or deleted in between). The row is kept as an audit record.
   */
  markDeleted(
    id: string,
    from: "open" | "closed",
    audit: { reason: string | null; actor: string; at: number },
  ): Promise<boolean>;
  loadOpen(): Promise<SynthTrade[]>;
  loadClosed(opts: { limit: number; sinceDay?: string }): Promise<SynthTrade[]>;
  /** Saved runtime settings (unvalidated). Keys never saved are absent. */
  loadSettings(): Promise<Partial<Record<SynthSettingKey, number>>>;
  /** Save every runtime setting at once. Throws on failure. */
  saveSettings(values: SynthSettings): Promise<void>;
}

/** The margin fields of a trade, written together. */
export interface SynthMarginPatch {
  margin: number | null;
  margin_source: SynthMarginSource | null;
  margin_hedge_benefit: number | null;
  margin_at: number | null;
  margin_error: string | null;
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
  /**
   * The ACTIVE broker's basket-margin calculator (the same one Box uses). Without it
   * trades carry no margin figure.
   */
  margins?: BoxMarginProvider;
  /** Box's use of the lane. Without it the budget is fixed at SYNTH_MAX_TOKENS. */
  boxLane?: () => BoxLaneUsage;
  /**
   * True while a broker switch is in progress. No refresh or re-link starts then:
   * the universe still belongs to the outgoing broker until the switch's own
   * `reloadUniverse()` runs.
   */
  switching?: () => boolean;
  /** The broker generation. A refresh that sees it change mid-flight is discarded. */
  brokerGeneration?: () => number;
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
export type SynthTradeView = Omit<SynthTrade, "opened_at" | "closed_at" | "margin_at"> & {
  opened_at: string;
  closed_at: string | null;
  margin_at: string | null;
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
/** Unlinked positions are re-resolved this often (instrument dump only, no REST). */
const RELINK_RETRY_MS = 10_000;
/** Attempts per margin capture, with a growing pause between them. */
const MARGIN_ATTEMPTS = 3;
/** Open positions still lacking margin are retried this often, a few times at most. */
const MARGIN_BACKFILL_MS = 60_000;
const MAX_MARGIN_BACKFILLS = 3;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The margin fields of a trade, to copy between records of the same trade. */
function marginOf(t: SynthTrade): SynthMarginPatch {
  return {
    margin: t.margin,
    margin_source: t.margin_source,
    margin_hedge_benefit: t.margin_hedge_benefit,
    margin_at: t.margin_at,
    margin_error: t.margin_error,
  };
}

export function toTradeView(t: SynthTrade): SynthTradeView {
  return {
    ...t,
    legs: t.legs.map((l) => ({ ...l })),
    opened_at: iso(t.opened_at),
    closed_at: t.closed_at === null ? null : iso(t.closed_at),
    margin_at: t.margin_at === null ? null : iso(t.margin_at),
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
  /** The store's uniqueness guarantee is verified. Only ENTRIES wait for it. */
  private indexReady = false;
  private loading = false;
  private lastLoadAttemptAt = 0;
  private strikeLevel: SynthStrikeLevel;
  private minExpectedNetProfit: number;
  private safetyBuffer: number;
  /** Open paper positions at most; 0 = no limit. Runtime-tunable and saved. */
  private maxOpenPositions: number;
  /** Saved settings have been read and applied (entries wait for this). */
  private settingsLoaded = false;
  /** Changed here while storage was unavailable: saved when it connects. */
  private settingsDirty = false;
  /**
   * Settings loads and saves run one at a time, in order, so a slow boot-time load
   * can never overwrite a newer admin change and a failed save can never make the
   * load skip the stored values.
   */
  private settingsLock: Promise<void> = Promise.resolve();

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
  /** The book versions each ELIGIBLE key was last confirmed on. */
  private eligibleSig = new Map<string, string>();
  private evaluatedAt: number | null = null;

  /* ---------------------------- paper positions ---------------------------- */
  private positions = new Map<string, SynthTrade>();
  private metrics = new Map<string, SynthExitMetrics>();
  /** Positions whose legs are not (yet) resolved on the active broker. */
  private unlinked = new Set<string>();
  private exitStreak = new Map<string, number>();
  private exitSig = new Map<string, string>();
  /** Ids this process has closed, so an in-flight load can never re-adopt one. */
  private closedIds = new Set<string>();
  /** Ids deleted by this process, so no in-flight load or late write can bring one back. */
  private deletedIds = new Set<string>();
  private marginInFlight = new Set<string>();
  private marginBackfills = new Map<string, number>();
  private lastMarginSweepAt = 0;
  private relinking = false;
  private lastRelinkAt = 0;
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
    this.maxOpenPositions = this.cfg.maxOpenPositions;
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
   * Adopt open positions and today's closed trades, then verify the store's
   * uniqueness index.
   *
   * Retried from the loop until both succeed. Automatic entries wait for both: an
   * entry made before the book is known could not respect the one-per-underlying
   * and max-open limits, and without the verified index nothing stops two processes
   * opening the same underlying. Monitoring and exits need only the load, so a bad
   * index never leaves an open position unmanaged.
   */
  private async loadFromStore(): Promise<void> {
    if (this.loading || this.storeReady()) return;
    this.lastLoadAttemptAt = Date.now();
    if (!this.deps.store.enabled()) return;
    this.loading = true;
    try {
      // Settings first: an entry must never be taken under the env defaults when the
      // operator has saved different ones (e.g. a lower max open, a higher gate).
      if (!this.settingsLoaded) await this.loadSettings();
      if (!this.loaded) await this.loadTrades();
      if (!this.indexReady) {
        await this.deps.store.ensureReady?.();
        this.indexReady = true;
      }
    } catch (err) {
      this.lastError = `Paper-trade storage is not ready: ${message(err)}`;
      console.warn("[Synthetic] paper-trade storage not ready:", err);
    } finally {
      this.loading = false;
    }
  }

  /** Settings, trades and the uniqueness index are all ready: entries may proceed. */
  private storeReady(): boolean {
    return this.settingsLoaded && this.loaded && this.indexReady;
  }

  /** Run settings work after any already queued, never interleaved with it. */
  private withSettingsLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.settingsLock.then(fn, fn);
    this.settingsLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Apply the saved settings over the env defaults. A change the admin made while
   * storage was down is newer and wins; it is saved now instead.
   */
  private loadSettings(): Promise<void> {
    return this.withSettingsLock(() => this.loadSettingsNow());
  }

  private async loadSettingsNow(): Promise<void> {
    if (this.settingsLoaded) return;
    const stored = await this.deps.store.loadSettings();
    if (!this.settingsDirty) {
      const next = this.settingsSnapshot();
      const applied: string[] = [];
      for (const key of SYNTH_SETTING_KEYS) {
        const raw = stored[key];
        if (raw === undefined) continue;
        const r = parseSynthSetting(key, raw);
        if (r.ok) {
          next[key] = r.value;
          applied.push(`${key}=${r.value}`);
        } else {
          console.warn(`[Synthetic] ignoring saved ${key}: ${r.error}`);
        }
      }
      this.applySettings(next);
      if (applied.length > 0) console.log(`[Synthetic] applied saved settings: ${applied.join(", ")}`);
    }
    if (this.settingsDirty) {
      await this.deps.store.saveSettings(this.settingsSnapshot());
      this.settingsDirty = false;
    }
    this.settingsLoaded = true;
  }

  private settingsSnapshot(): SynthSettings {
    return {
      min_expected_net_profit: this.minExpectedNetProfit,
      safety_buffer: this.safetyBuffer,
      max_open_positions: this.maxOpenPositions,
    };
  }

  private applySettings(v: SynthSettings): void {
    this.minExpectedNetProfit = v.min_expected_net_profit;
    this.safetyBuffer = v.safety_buffer;
    this.maxOpenPositions = v.max_open_positions;
  }

  /** True when another position may be opened under the max-open setting (0 = no limit). */
  private underMaxOpen(): boolean {
    return this.maxOpenPositions <= 0 || this.positions.size + this.pendingEntries.size < this.maxOpenPositions;
  }

  /**
   * True when the token budget can carry one more position's three legs. Open legs
   * are never dropped, so a position may only be opened while they fit (only binds
   * when SYNTH_MAX_TOKENS is set very low).
   */
  private roomForAnotherPosition(budget: number): boolean {
    return (this.positions.size + this.pendingEntries.size + 1) * POSITION_TOKENS <= budget;
  }

  private async loadTrades(): Promise<void> {
    const open = await this.deps.store.loadOpen();
    this.adopt(open);
    const today = this.deps.istDayKey();
    const closed = await this.deps.store.loadClosed({ limit: 2000, sinceDay: today });
    const known = new Set(this.closedToday.map((t) => t.id));
    const fresh = closed.filter((t) => !known.has(t.id) && !this.deletedIds.has(t.id));
    this.closedToday = [...this.closedToday, ...fresh].sort(
      (a, b) => (b.closed_at ?? 0) - (a.closed_at ?? 0),
    );
    this.closedDay = today;
    this.loaded = true;
    if (open.length > 0) {
      console.log(`[Synthetic] adopted ${open.length} open paper position(s)`);
    }
  }

  /**
   * Take stored open rows into memory. Each one starts unlinked: its entry-time
   * tokens may belong to another broker, so nothing is subscribed until the legs
   * have been re-resolved in the active namespace (next tick, see `relinkNow`).
   */
  private adopt(rows: SynthTrade[]): void {
    let added = 0;
    for (const t of rows) {
      if (t.status !== "open" || this.positions.has(t.id) || this.closedIds.has(t.id)) continue;
      if (this.deletedIds.has(t.id)) continue;
      this.positions.set(t.id, t);
      this.unlinked.add(t.id);
      added++;
    }
    if (added > 0) this.lastRelinkAt = 0;
  }

  async start(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.deps.marketData.isAuthenticated()) {
      return { ok: false, error: "No broker session: connect the active broker first." };
    }
    if (this.deps.switching?.()) {
      return { ok: false, error: "A broker switch is in progress. Try again in a moment." };
    }
    if (this.running) return { ok: true };
    this.running = true;
    this.lastError = null;
    this.ensureLoop();
    await this.loadFromStore();
    try {
      // A refresh already in flight was planned without discovery: let it finish,
      // then build the windows with RUN on.
      if (this.refreshing) await this.refreshing.catch(() => undefined);
      await this.refreshUniverse();
    } catch (err) {
      this.lastError = message(err);
    }
    this.evaluate(Date.now(), this.deps.isMarketOpen(), false);
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
    // Release the whole lease first. After a broker switch the coordinator is already
    // empty and this does nothing; after a lost or logged-out session it is what stops
    // the old set being replayed onto the next socket, where yieldToBox could not shed it.
    try {
      this.deps.setTokens([]);
    } catch (err) {
      console.warn("[Synthetic] releasing subscriptions failed:", err);
    }
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
    this.eligibleSig.clear();
    this.exitStreak.clear();
    this.exitSig.clear();
    this.universeAt = null;
    for (const id of this.positions.keys()) this.unlinked.add(id);
  }

  /**
   * After a broker switch: rebuild in the new namespace and re-link open positions.
   *
   * Bumping the epoch first discards any refresh still in flight, whichever broker's
   * dump it loaded. This is the only refresh allowed to run while the registry still
   * reports the switch as in progress.
   */
  async reloadUniverse(): Promise<void> {
    this.namespaceEpoch++;
    if (this.refreshing) await this.refreshing.catch(() => undefined);
    this.universeAt = null;
    if (this.active()) await this.refreshUniverse(true);
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
      this.evaluate(now, this.deps.isMarketOpen(), false);
    }
    return { ok: true };
  }

  /**
   * ADMIN: change the entry gate, the safety buffer and/or the max open positions
   * (0 = no limit). Takes effect on the next evaluation and is SAVED, so it survives a
   * restart. If the save fails the change is rolled back and reported, so the page
   * never shows a value that would revert. With storage not connected the change
   * applies to this process only (`persisted: false`) and is saved once it connects.
   *
   * Only NEW entries are affected: lowering max open never closes an open position.
   */
  updateSettings(
    body: Partial<Record<SynthSettingKey, unknown>>,
  ): Promise<{ ok: true; persisted: boolean } | { ok: false; status: number; error: string }> {
    return this.withSettingsLock(() => this.updateSettingsNow(body));
  }

  private async updateSettingsNow(
    body: Partial<Record<SynthSettingKey, unknown>>,
  ): Promise<{ ok: true; persisted: boolean } | { ok: false; status: number; error: string }> {
    const next = this.settingsSnapshot();
    let changed = false;
    for (const key of SYNTH_SETTING_KEYS) {
      if (body[key] === undefined) continue;
      const r = parseSynthSetting(key, body[key]);
      if (!r.ok) return { ok: false, status: 400, error: r.error };
      next[key] = r.value;
      changed = true;
    }
    if (!changed) {
      return {
        ok: false,
        status: 400,
        error: `Nothing to change: send any of ${SYNTH_SETTING_KEYS.join(", ")}.`,
      };
    }
    const before = this.settingsSnapshot();
    this.applySettings(next);
    if (this.deps.store.enabled()) {
      try {
        await this.deps.store.saveSettings(next);
        this.settingsDirty = false;
      } catch (err) {
        this.applySettings(before);
        return { ok: false, status: 503, error: `Could not save the settings: ${message(err)}` };
      }
    } else {
      this.settingsDirty = true;
    }
    console.log(
      `[Synthetic] settings ${this.settingsDirty ? "changed (not saved: storage unavailable)" : "saved"}: ` +
        `gate ₹${before.min_expected_net_profit} → ₹${next.min_expected_net_profit}, ` +
        `safety ₹${before.safety_buffer} → ₹${next.safety_buffer}, max open ` +
        `${before.max_open_positions || "no limit"} → ${next.max_open_positions || "no limit"}`,
    );
    // Not an observation: the books are the same, so it must not confirm a signal.
    this.evaluate(Date.now(), this.deps.isMarketOpen(), false);
    this.publish();
    return { ok: true, persisted: !this.settingsDirty };
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

  /**
   * Rebuild expiry pairing, strike windows, position links and subscriptions. Single-flight.
   *
   * `allowDuringSwitch` is set only by `reloadUniverse()`, the switch's own hook.
   */
  refreshUniverse(allowDuringSwitch = false): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefreshUniverse(allowDuringSwitch).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private generation(): number {
    return this.deps.brokerGeneration?.() ?? 0;
  }

  /** A closure that says whether work begun now belongs to a superseded namespace. */
  private staleCheck(): () => boolean {
    const epoch = this.namespaceEpoch;
    const gen = this.generation();
    return () => epoch !== this.namespaceEpoch || gen !== this.generation();
  }

  private async doRefreshUniverse(allowDuringSwitch: boolean): Promise<void> {
    if (!this.active() || !this.deps.marketData.isAuthenticated()) return;
    if (!allowDuringSwitch && this.deps.switching?.()) return;
    const superseded = this.staleCheck();
    this.lastRefreshAttemptAt = Date.now();
    const today = this.deps.istDayKey();
    const [all, board] = await Promise.all([this.deps.getAllInstruments(), this.deps.getBoard()]);
    if (superseded() || !this.active()) return;

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
    // Only windows that do not exist yet need a REST price to be centred on.
    const unseeded = picked.filter((u) => !this.windows.has(u));
    if (unseeded.length > 0) {
      await this.seedFromRest(unseeded, resolve, superseded);
      if (superseded() || !this.active()) return;
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
      await this.seedCloses(resolve, superseded);
      if (superseded()) return;
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

  /**
   * Re-resolve unlinked positions from the (cached) instrument dump and subscribe
   * them. Much cheaper than a refresh (no REST), so it is retried every few seconds
   * while any position is unlinked: an unlinked position cannot be priced or exited.
   */
  private async relinkNow(): Promise<void> {
    if (this.relinking) return;
    this.relinking = true;
    this.lastRelinkAt = Date.now();
    const superseded = this.staleCheck();
    try {
      const all = await this.deps.getAllInstruments();
      if (superseded() || this.namespaceStale || this.deps.switching?.()) return;
      this.relinkPositions(all);
      this.applySubscriptions();
    } catch (err) {
      console.warn("[Synthetic] re-linking open positions failed:", err);
    } finally {
      this.relinking = false;
    }
  }

  /** One REST snapshot of every picked future, to centre windows before ticks. */
  private async seedFromRest(
    picked: string[],
    resolve: (token: number) => string | null,
    superseded: () => boolean,
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
      if (superseded()) return;
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
  private async seedCloses(
    resolve: (token: number) => string | null,
    superseded: () => boolean,
  ): Promise<void> {
    const ids = [...this.watched]
      .map((t) => resolve(t))
      .filter((s): s is string => typeof s === "string");
    if (ids.length === 0) return;
    try {
      const quotes = await this.deps.marketData.getQuoteFull(ids);
      if (superseded()) return;
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
      if (!this.storeReady() && now - this.lastLoadAttemptAt >= LOAD_RETRY_MS) {
        void this.loadFromStore();
      }
      this.rollDay(now);
      if (this.lastMarketOpen === true && !marketOpen) this.closeViewPending = true;
      this.lastMarketOpen = marketOpen;
      this.maybeRefreshUniverse(now);
      this.backfillMargins(now);
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
    // Only needed while a load could still return a row closed or deleted moments ago.
    this.closedIds.clear();
    this.deletedIds.clear();
  }

  private maybeRefreshUniverse(now: number): void {
    if (!this.active() || !this.deps.marketData.isAuthenticated()) return;
    // Mid-switch the dump still belongs to the outgoing broker: the switch reloads.
    if (this.deps.switching?.()) return;
    // Independent of any refresh in flight: that refresh may have re-linked BEFORE a
    // position was adopted, and an unlinked position cannot be priced or exited.
    if (
      this.unlinked.size > 0 &&
      !this.namespaceStale &&
      !this.relinking &&
      now - this.lastRelinkAt >= RELINK_RETRY_MS
    ) {
      void this.relinkNow();
    }
    if (this.refreshing) return;
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

    // A signal must hold across N evaluations on NEW books before it is entered: an
    // evaluation over the same books (a settings change, a quiet tick) confirms nothing.
    if (observe) {
      const streak = new Map<string, number>();
      const sigs = new Map<string, string>();
      for (const o of out) {
        if (o.status !== "ELIGIBLE") continue;
        const sig = this.bookSig(o.legs.map((l) => l.token));
        const prev = this.eligibleStreak.get(o.key) ?? 0;
        streak.set(o.key, this.eligibleSig.get(o.key) === sig ? Math.max(prev, 1) : prev + 1);
        sigs.set(o.key, sig);
      }
      this.eligibleStreak = streak;
      this.eligibleSig = sigs;
    }
    this.annotate(out, now, marketOpen);
    this.opportunities = sortOpportunities(out);
    this.evaluatedAt = now;
  }

  /** The book versions of these tokens: changes whenever any of their books does. */
  private bookSig(tokens: number[]): string {
    return tokens.map((t) => this.quotes.get(t)?.version ?? 0).join(":");
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
    const db = this.deps.store.enabled() && this.storeReady();
    const feedOk = this.feedHealthy(now, marketOpen);
    const full = !this.underMaxOpen();
    const tokensFull = !this.roomForAnotherPosition(this.tokenBudget());
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
                      : tokensFull
                        ? "token_budget"
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
    if (!this.deps.store.enabled() || !this.storeReady()) return;
    if (!this.feedHealthy(now, marketOpen)) return;
    const budget = this.tokenBudget();
    for (const o of this.opportunities) {
      if (o.status !== "ELIGIBLE") break; // sorted: every ELIGIBLE row comes first
      if (o.entry_blocked !== null) continue;
      // Each entry adds to pendingEntries synchronously, so these re-check per row.
      if (!this.underMaxOpen() || !this.roomForAnotherPosition(budget)) break;
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
        // Same instant as the pricing above: the book each limit order was filled against.
        depthFor: (token) => this.depthFor(token),
      });
      if (!trade) return;
      const res = await this.deps.store.insertOpen(trade);
      this.cooldownUntil.set(u, Date.now() + this.cfg.reentryCooldownMs);
      if (res === "duplicate") {
        // The underlying is already open in the store: another process's position, or
        // this insert itself landing twice (a retried write whose first ack was lost).
        // Never open it twice; adopt whatever is stored so it is monitored here too.
        this.adopt(await this.deps.store.loadOpen());
        return;
      }
      this.positions.set(trade.id, trade);
      // The namespace changed while the insert was in flight: re-link before subscribing.
      if (epoch !== this.namespaceEpoch) {
        this.unlinked.add(trade.id);
        this.lastRelinkAt = 0;
      }
      this.eligibleStreak.delete(o.key);
      this.fitToBudget(this.tokenBudget(), true);
      console.log(
        `[Synthetic] paper ENTRY ${trade.direction} ${u} ${trade.expiry} K=${trade.strike} ` +
          `lock ₹${trade.entry_edge} expected net ₹${trade.expected_net_profit}`,
      );
      this.broadcast("entry", { trade: toTradeView(trade) });
      this.refreshRows();
      this.publish();
      // Off the fill path: the trade already exists, margin is enrichment.
      void this.captureMargin(trade.id);
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
      // Rule exits must hold across N evaluations on new books; expiry safety acts at once.
      if (m.rule_reason !== null && m.executable) {
        const sig = this.bookSig(t.legs.map((l) => l.token));
        if (this.exitSig.get(t.id) !== sig) {
          this.exitStreak.set(t.id, (this.exitStreak.get(t.id) ?? 0) + 1);
          this.exitSig.set(t.id, sig);
        }
      } else {
        this.exitStreak.delete(t.id);
        this.exitSig.delete(t.id);
      }
      const streak = this.exitStreak.get(t.id) ?? 0;
      if (!marketOpen || !feedOk || !linked || !m.should_exit || m.reason === null) continue;
      if (m.reason !== "EXPIRY_SAFETY" && streak < this.cfg.signalConfirmations) continue;
      const closed = closeTradeAtTouch(t, m, m.reason, now, today, (tok) => this.depthFor(tok));
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
      this.closedIds.add(open.id);
      this.positions.delete(open.id);
      this.metrics.delete(open.id);
      this.exitStreak.delete(open.id);
      this.exitSig.delete(open.id);
      this.retryAt.delete(open.id);
      this.unlinked.delete(open.id);
      this.cooldownUntil.set(open.underlying, Date.now() + this.cfg.reentryCooldownMs);
      if (!won) {
        // Closed elsewhere (a racing request or another process): never close twice,
        // but do count the close that DID land, so today's P&L is not short of it.
        this.applySubscriptions();
        const stored = await this.deps.store.get(open.id).catch(() => null);
        if (
          stored &&
          !stored.deleted &&
          stored.status === "closed" &&
          stored.closed_day === this.closedDay &&
          !this.closedToday.some((c) => c.id === stored.id)
        ) {
          this.closedToday.unshift(stored);
        }
        return { ok: false, error: "This position was already closed." };
      }
      // A margin figure may have landed on the open record while the close was in
      // flight (the store keeps margin out of closes, so the database has it too).
      if (closed.margin === null && open.margin !== null) Object.assign(closed, marginOf(open));
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

  /** The top of a token's current book, as evidence of what a fill was priced on. */
  private depthFor(token: number): SynthDepth | null {
    return depthOf(this.quotes.get(token));
  }

  /* -------------------------------- margin -------------------------------- */

  /**
   * Ask the active broker what the trade's three legs block TOGETHER, and store it.
   *
   * One basket request with the real sides, so the hedge between the future and the
   * option pair is recognised; margining the legs one by one would overstate it.
   * Only for trades opened on the ACTIVE broker: their stored tradingsymbols are in
   * that broker's naming. Best-effort, retried, and never on the fill path.
   */
  private async captureMargin(id: string): Promise<void> {
    const provider = this.deps.margins;
    if (!provider || this.marginInFlight.has(id)) return;
    const t = this.positions.get(id);
    if (!t || t.margin !== null) return;
    if (t.broker !== this.deps.activeBroker() || !this.deps.marketData.isAuthenticated()) return;
    this.marginInFlight.add(id);
    const orders = synthMarginOrders(t);
    let lastError = "no response";
    try {
      for (let attempt = 1; attempt <= MARGIN_ATTEMPTS; attempt++) {
        // Deleted meanwhile: nothing left to enrich.
        if (this.deletedIds.has(id)) return;
        try {
          // STANDALONE basket: a paper trade must not be netted against whatever real
          // positions the broker account holds, which could shrink the figure.
          const res = await provider.basketMargin(orders, { considerPositions: false });
          if (res.source === "unavailable" || !Number.isFinite(res.total)) {
            throw new Error("the broker's margin calculator returned no figure");
          }
          const patch: SynthMarginPatch = {
            // A hedged basket can legitimately need little margin: accept a small figure.
            margin: Math.max(0, Math.round(res.total)),
            margin_source: res.source,
            margin_hedge_benefit:
              typeof res.hedge_benefit === "number" && Number.isFinite(res.hedge_benefit)
                ? Math.round(res.hedge_benefit)
                : null,
            margin_at: Date.now(),
            margin_error: null,
          };
          if (res.source === "dhan_per_leg_fallback") {
            console.warn(
              `[Synthetic] margin for ${t.underlying} is a PER-LEG SUM (₹${patch.margin}), not a ` +
                "netted basket figure: it OVERSTATES a hedged conversion/reversal.",
            );
          }
          if (this.deletedIds.has(id)) return;
          this.applyMargin(id, patch);
          await this.deps.store.setMargin(id, patch).catch((err) => {
            console.warn(`[Synthetic] storing margin for ${t.underlying} failed:`, err);
          });
          this.publish();
          return;
        } catch (err) {
          lastError = message(err);
          if (attempt < MARGIN_ATTEMPTS) await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
      console.warn(`[Synthetic] basket margin for ${t.underlying} unavailable: ${lastError}`);
      if (this.deletedIds.has(id)) return;
      // Stored too, so the reason survives a restart and shows on the closed row.
      const failed: SynthMarginPatch = { ...marginOf(t), margin: null, margin_error: lastError };
      this.applyMargin(id, failed);
      await this.deps.store.setMargin(id, failed).catch(() => undefined);
      this.publish();
    } finally {
      this.marginInFlight.delete(id);
    }
  }

  /** Patch margin onto whichever in-memory copy of the trade exists. */
  private applyMargin(id: string, patch: SynthMarginPatch): void {
    const open = this.positions.get(id);
    if (open) Object.assign(open, patch);
    const closed = this.closedToday.find((c) => c.id === id);
    if (closed) Object.assign(closed, patch);
  }

  /**
   * Retry margin for open positions that still lack it: adopted after a restart,
   * opened while the session was down, or whose capture failed. A few rounds each.
   */
  private backfillMargins(now: number): void {
    if (!this.deps.margins || now - this.lastMarginSweepAt < MARGIN_BACKFILL_MS) return;
    this.lastMarginSweepAt = now;
    const active = this.deps.activeBroker();
    const authed = this.deps.marketData.isAuthenticated();
    for (const t of this.positions.values()) {
      if (t.margin !== null || this.marginInFlight.has(t.id)) continue;
      if (t.broker !== active) {
        // Its tradingsymbols use the other broker's naming, so it is not re-margined here.
        // Say so, rather than showing "fetching…" for ever.
        t.margin_error ??= `Opened on ${t.broker}; margin is only asked from the broker a trade was opened on.`;
        continue;
      }
      // Session down (or mid-switch): nothing would be asked, so it is not a round.
      if (!authed || this.namespaceStale) continue;
      const tries = this.marginBackfills.get(t.id) ?? 0;
      if (tries >= MAX_MARGIN_BACKFILLS) continue;
      this.marginBackfills.set(t.id, tries + 1);
      void this.captureMargin(t.id);
    }
  }

  /* -------------------------------- delete -------------------------------- */

  /**
   * Delete a PAPER trade, open or closed, from every list and P&L figure.
   *
   * A soft delete: the row stays in `synth_trades` as `status: "deleted"` with the
   * admin role, when and why. An open position stops being monitored and its tokens
   * are released; its underlying then waits out the re-entry cooldown, so the scanner
   * does not immediately open the same trade again.
   *
   * `expected` is the status the operator SAW when they confirmed. A position that
   * closed while the confirmation was open is refused (409) rather than deleted along
   * with the realised P&L it just booked.
   *
   * Safe to retry: a delete whose write landed but whose answer was lost is
   * reconciled from the stored row, so the retry succeeds instead of leaving a
   * position that is deleted in the database but still monitored here.
   */
  async deleteTrade(
    id: string,
    opts: { reason: string | null; actor: string; expected?: "open" | "closed" },
  ): Promise<
    | { ok: true; from: "open" | "closed"; already: boolean }
    | { ok: false; status: number; error: string }
  > {
    if (!this.deps.store.enabled()) {
      return { ok: false, status: 503, error: "Paper-trade storage is not connected." };
    }
    const audit = { reason: opts.reason, actor: opts.actor, at: Date.now() };

    const open = this.positions.get(id);
    if (open) {
      if (opts.expected === "closed") {
        return { ok: false, status: 409, error: "This trade is open, not closed. Reload the page and try again." };
      }
      if (this.closing.has(id)) {
        return {
          ok: false,
          status: 409,
          error: "This position is being closed right now. Wait for the exit, then delete it.",
        };
      }
      // Hold it like a close, so the monitor cannot exit it while the delete is in flight.
      this.closing.add(id);
      let outcome: "deleted" | "open" | "closed" | "missing";
      try {
        outcome = await this.markDeletedReconciled(id, "open", audit);
        if (outcome === "deleted") this.forgetOpen(open);
      } finally {
        this.closing.delete(id);
      }
      if (outcome === "closed") {
        return {
          ok: false,
          status: 409,
          error:
            "This position closed while the delete was in flight. Nothing was deleted: it is " +
            "under Closed trades now, and can be deleted there.",
        };
      }
      if (outcome !== "deleted") return { ok: false, status: 409, error: "The trade could not be deleted." };
      this.afterDelete(id, open, "open", opts.reason);
      return { ok: true, from: "open", already: false };
    }

    const stored = await this.deps.store.get(id);
    if (!stored) return { ok: false, status: 404, error: "No such paper trade." };
    if (stored.deleted) {
      // Already deleted, e.g. by an earlier attempt whose answer was lost, or elsewhere.
      // Make memory agree and report success, so retrying a delete is safe.
      const listed = this.forgetClosed(id);
      if (listed) this.afterDelete(id, stored, "closed", opts.reason);
      return { ok: true, from: stored.deleted_from ?? "closed", already: true };
    }
    if (stored.status === "open") {
      // Open in the store but not in this process: another process is managing it.
      return {
        ok: false,
        status: 409,
        error: "This position is open but not managed by this server process; it cannot be deleted here.",
      };
    }
    if (opts.expected === "open") {
      return {
        ok: false,
        status: 409,
        error:
          `This position closed while the confirmation was open (${stored.exit_reason ?? "closed"}, ` +
          `net ₹${Math.round(stored.net_pnl ?? 0).toLocaleString("en-IN")} after charges). Nothing was ` +
          "deleted: it is under Closed trades now, and can be deleted there if you still want to.",
      };
    }
    const outcome = await this.markDeletedReconciled(id, "closed", audit);
    if (outcome !== "deleted") return { ok: false, status: 409, error: "The trade could not be deleted." };
    this.forgetClosed(id);
    this.afterDelete(id, stored, "closed", opts.reason);
    return { ok: true, from: "closed", already: false };
  }

  /**
   * Soft-delete, and when the write fails or matches nothing, read the row back to
   * learn what really happened: an acknowledgement can be lost after the write landed.
   */
  private async markDeletedReconciled(
    id: string,
    from: "open" | "closed",
    audit: { reason: string | null; actor: string; at: number },
  ): Promise<"deleted" | "open" | "closed" | "missing"> {
    let writeError: unknown = null;
    try {
      if (await this.deps.store.markDeleted(id, from, audit)) return "deleted";
    } catch (err) {
      writeError = err;
    }
    let stored: Awaited<ReturnType<SynthTradeStore["get"]>>;
    try {
      stored = await this.deps.store.get(id);
    } catch (err) {
      throw writeError ?? err;
    }
    if (stored?.deleted) return "deleted";
    if (writeError) throw writeError;
    return stored ? stored.status : "missing";
  }

  /** Drop a deleted open position from memory and release its legs. */
  private forgetOpen(t: SynthTrade): void {
    const id = t.id;
    this.deletedIds.add(id);
    this.closedIds.add(id);
    this.positions.delete(id);
    this.metrics.delete(id);
    this.exitStreak.delete(id);
    this.exitSig.delete(id);
    this.retryAt.delete(id);
    this.unlinked.delete(id);
    this.marginBackfills.delete(id);
    this.cooldownUntil.set(t.underlying, Date.now() + this.cfg.reentryCooldownMs);
    this.applySubscriptions();
  }

  /** Drop a deleted closed trade from today's list. True when it was listed. */
  private forgetClosed(id: string): boolean {
    this.deletedIds.add(id);
    const before = this.closedToday.length;
    this.closedToday = this.closedToday.filter((c) => c.id !== id);
    return this.closedToday.length !== before;
  }

  private afterDelete(id: string, t: SynthTrade, from: "open" | "closed", reason: string | null): void {
    console.log(
      `[Synthetic] paper trade DELETED (${from}) ${t.direction} ${t.underlying} K=${t.strike}` +
        (reason ? ` — ${reason}` : ""),
    );
    this.broadcast("trade_deleted", { id, from });
    this.refreshRows();
    this.publish();
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
    const closed = closeTradeAtTouch(t, m, "MANUAL", now, today, (tok) => this.depthFor(tok));
    if (!closed) {
      const thin = m.legs
        .filter((l) => !l.executable)
        .map((l) =>
          `${l.tradingsymbol} (${
            l.price === null
              ? `no ${l.side === "BUY" ? "ask" : "bid"}`
              : l.reject === "crossed_book"
                ? "crossed book: best bid ≥ best ask"
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
   * The rows pushed to the browser: every ELIGIBLE row that could still be entered
   * (not on an underlying already held), then the best row of each underlying, then
   * the next best, up to the cap. Held rows (OPEN, or ELIGIBLE on a held underlying)
   * compete for the cap like any other, so the stream stays bounded however many
   * positions are open; the Open tab lists every one. Counts in the status always
   * describe the full evaluated set.
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
    for (const o of all) {
      if (o.status === "ELIGIBLE" && o.entry_blocked !== "position_open") take(o);
    }
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
          margin: t.margin,
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
      paper_trading: this.cfg.paperTrading && db && this.storeReady(),
      paper_blocked_reason: !this.cfg.paperTrading
        ? "disabled"
        : !db
          ? "no_db"
          : !this.settingsLoaded || !this.loaded
            ? "loading"
            : !this.indexReady
              ? "unsafe_index"
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
      /** 0 = no limit (only one open position per underlying). */
      max_open_positions: this.maxOpenPositions,
      /** Whether trades get a margin figure (a basket-margin calculator is wired). */
      margin_enabled: this.deps.margins !== undefined,
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
      max_open_positions: this.maxOpenPositions,
      /** The env default (SYNTH_MAX_OPEN_POSITIONS) a saved value overrides. */
      default_max_open_positions: this.cfg.maxOpenPositions,
      /** False when a change could not be saved yet (storage unavailable). */
      settings_persisted: !this.settingsDirty,
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
