/**
 * SyntheticEngine: the futures-vs-synthetic arbitrage SCANNER.
 *
 * SCOPE: DETECTION ONLY. This engine never places, simulates or records an order.
 * It watches each underlying's nearest future together with the same-expiry
 * option pair at ATM, ATM±1, ATM±2 or ATM±3, prices a conversion and a reversal at
 * every strike from the executable touch, and publishes which ones clear the
 * expected-net threshold. Execution (paper, then live) is a separate, later
 * phase that would go through Box's durable execution gateway. Detection is
 * kept apart so a scanner bug can never become an order.
 *
 * MARKET DATA
 * Tokens are declared on the dedicated BOX lane under the "scanner" owner through
 * `setTokens` (ActiveBrokerManager.setSyntheticTokens). That lane carries full
 * 5-level depth on both brokers. It is refcounted per owner, so this scanner
 * can never unsubscribe a strike Box needs, and Box can never drop one of ours.
 * The budget is `SYNTH_MAX_TOKENS`, kept well inside the per-socket limit
 * alongside Box's own budget.
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
  evaluateSynthetic,
  indexSyntheticChains,
  sortOpportunities,
  synthTokensFor,
  synthWindowNeedsRebuild,
  synthWindowTokens,
  type SynthBoardItem,
  type SynthChainIndex,
  type SynthDirection,
  type SynthOpportunity,
  type SynthQuoteLike,
  type SynthWindow,
} from "./math.js";

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

export class SyntheticEngine {
  readonly cfg: SynthConfig;
  private running = false;
  private strikeLevel: SynthStrikeLevel;
  private minExpectedNetProfit: number;
  private safetyBuffer: number;

  private board = new Map<string, SynthBoardItem>();
  private chains = new Map<string, SynthChainIndex>();
  private windows = new Map<string, SynthWindow>();
  private watched = new Set<number>();
  private futureToUnderlying = new Map<number, string>();
  private quotes = new BoxQuoteStore();
  /** Latest-session closes, for the market-shut view. token -> close. */
  private closes = new Map<number, number>();
  /** REST-seeded future prices, used to centre a window before the first tick. */
  private seededRef = new Map<string, number>();
  private closeSessionDay: string | null = null;

  private opportunities: SynthOpportunity[] = [];
  private lastError: string | null = null;
  private universeAt: number | null = null;
  private evaluatedAt: number | null = null;
  private skippedForBudget = 0;
  private refreshing: Promise<void> | null = null;
  private lastMarketOpen: boolean | null = null;

  private evalTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private publishTimer: ReturnType<typeof setInterval> | null = null;
  private sseClients = new Set<SseClient>();

  constructor(private deps: SyntheticEngineDeps) {
    this.cfg = deps.config ?? loadSynthConfig();
    this.strikeLevel = this.cfg.strikeLevel;
    this.minExpectedNetProfit = this.cfg.minExpectedNetProfit;
    this.safetyBuffer = this.cfg.safetyBuffer;
  }

  /* ------------------------------- lifecycle ------------------------------ */

  async start(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.deps.marketData.isAuthenticated()) {
      return { ok: false, error: "No broker session: connect the active broker first." };
    }
    if (this.running) return { ok: true };
    this.running = true;
    this.lastError = null;
    try {
      await this.refreshUniverse();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
    this.evalTimer = setInterval(() => this.evaluate(), this.cfg.evalIntervalMs);
    this.evalTimer.unref?.();
    this.refreshTimer = setInterval(() => {
      void this.refreshUniverse().catch((err) => {
        this.lastError = err instanceof Error ? err.message : String(err);
      });
    }, this.cfg.universeRefreshMs);
    this.refreshTimer.unref?.();
    this.evaluate();
    this.publish();
    return { ok: true };
  }

  /** Stop watching. Idempotent. Releases every subscription this scanner holds. */
  stop(): void {
    this.running = false;
    if (this.evalTimer) clearInterval(this.evalTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.evalTimer = null;
    this.refreshTimer = null;
    this.windows.clear();
    this.watched.clear();
    this.futureToUnderlying.clear();
    this.quotes.clear();
    this.closes.clear();
    this.seededRef.clear();
    this.opportunities = [];
    this.lastMarketOpen = null;
    try {
      this.deps.setTokens([]);
    } catch (err) {
      console.warn("[Synthetic] releasing subscriptions failed:", err);
    }
    this.publish();
  }

  /** Close timers and SSE clients, for process shutdown. */
  dispose(): void {
    this.stop();
    if (this.publishTimer) clearInterval(this.publishTimer);
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

  /** A broker switch or lane reconnect: no cached book may be trusted any more. */
  invalidateBooks(): void {
    this.quotes.invalidateGeneration();
  }

  setStrikeLevel(level: unknown): { ok: true } | { ok: false; error: string } {
    const lvl = clampSynthStrikeLevel(level);
    if (lvl === null) return { ok: false, error: "level must be 1, 2 or 3" };
    if (lvl === this.strikeLevel) return { ok: true };
    this.strikeLevel = lvl;
    if (this.running) {
      // Rebuild every window at the new width around its current reference price.
      const now = Date.now();
      for (const [u, w] of [...this.windows]) {
        const chain = this.chains.get(u);
        const b = this.board.get(u);
        if (!chain || !b) continue;
        const next = buildSynthWindow({ board: b, chain, ref: this.refPriceFor(w), eachSide: lvl, now });
        if (next) this.windows.set(u, next);
      }
      this.applySubscriptions();
      this.evaluate();
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
    this.evaluate();
    return { ok: true };
  }

  /* -------------------------------- ticks --------------------------------- */

  /** Ticks from either lane. Only tokens this scanner watches are admitted. */
  onTicks(ticks: Tick[]): void {
    if (!this.running || this.watched.size === 0) return;
    const mine = ticks.filter((t) => this.watched.has(t.token));
    if (mine.length > 0) this.quotes.applyTicks(mine);
  }

  /* ------------------------------- universe ------------------------------- */

  /** Rebuild expiry pairing, strike windows and subscriptions. Single-flight. */
  refreshUniverse(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefreshUniverse().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefreshUniverse(): Promise<void> {
    if (!this.running) return;
    const now = Date.now();
    const today = this.deps.istDayKey(now);
    const [all, board] = await Promise.all([this.deps.getAllInstruments(), this.deps.getBoard()]);
    if (!this.running) return;

    this.chains = indexSyntheticChains(all, today);
    this.board = new Map(board.map((b) => [b.symbol, b]));

    // Indices first (deepest books), then stocks alphabetically, a stable
    // selection when the token budget binds.
    const ordered = board
      .filter((b) => this.chains.has(b.symbol))
      .filter((b) => !(this.cfg.skipExpiryDay && this.chains.get(b.symbol)!.expiry === today))
      .sort((a, b) =>
        (a.is_index === true) === (b.is_index === true)
          ? a.symbol.localeCompare(b.symbol)
          : a.is_index === true ? -1 : 1,
      );

    const perWindow = synthTokensFor(this.strikeLevel);
    const cap = this.cfg.maxUnderlyings > 0 ? this.cfg.maxUnderlyings : Infinity;
    const selected: SynthBoardItem[] = [];
    let budget = this.cfg.maxTokens;
    for (const b of ordered) {
      if (selected.length >= cap || budget < perWindow) break;
      selected.push(b);
      budget -= perWindow;
    }
    this.skippedForBudget = ordered.length - selected.length;

    const resolve = this.deps.makeIdResolver(all);
    await this.seedFromRest(selected, resolve);
    if (!this.running) return;

    const nextWindows = new Map<string, SynthWindow>();
    for (const b of selected) {
      const chain = this.chains.get(b.symbol)!;
      const existing = this.windows.get(b.symbol);
      const ref =
        (existing && existing.future.token === chain.future.token ? this.refPriceFor(existing) : 0) ||
        this.seededRef.get(b.symbol) ||
        0;
      const w = buildSynthWindow({ board: b, chain, ref, eachSide: this.strikeLevel, now });
      if (w) nextWindows.set(b.symbol, w);
    }
    this.windows = nextWindows;
    this.applySubscriptions();

    // The closes are for the market-shut view: fetch them for the chosen windows.
    if (!this.deps.isMarketOpen()) await this.seedCloses(resolve);
    this.universeAt = Date.now();
    console.log(
      `[Synthetic] universe: ${this.chains.size} paired underlyings, watching ` +
        `${this.windows.size} at ATM ±${this.strikeLevel} (${this.watched.size} tokens, ` +
        `${this.skippedForBudget} skipped for budget)`,
    );
  }

  /** One REST snapshot of every selected future, to centre windows before ticks. */
  private async seedFromRest(
    selected: SynthBoardItem[],
    resolve: (token: number) => string | null,
  ): Promise<void> {
    const byToken = new Map<number, string>();
    for (const b of selected) byToken.set(this.chains.get(b.symbol)!.future.token, b.symbol);
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

  private applySubscriptions(): void {
    const next = new Set<number>();
    this.futureToUnderlying.clear();
    for (const w of this.windows.values()) {
      for (const t of synthWindowTokens(w)) next.add(t);
      this.futureToUnderlying.set(w.future.token, w.underlying);
    }
    const dropped = [...this.watched].filter((t) => !next.has(t));
    this.watched = next;
    if (dropped.length > 0) this.quotes.forget(dropped);
    this.deps.setTokens([...next]);
  }

  /** Future mid when there is a live two-sided book, else its last, else the seed. */
  private refPriceFor(w: SynthWindow): number {
    const q = this.quotes.get(w.future.token);
    if (q && q.bid > 0 && q.ask > 0) return (q.bid + q.ask) / 2;
    if (q && q.last > 0) return q.last;
    return this.seededRef.get(w.underlying) ?? w.ref_price;
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

  /** Re-centre drifting windows, then re-price every strike in both directions. */
  evaluate(): void {
    if (!this.running) {
      this.opportunities = [];
      return;
    }
    const now = Date.now();
    const marketOpen = this.deps.isMarketOpen();
    // At the close, fetch the session's closes now rather than at the next refresh.
    if (this.lastMarketOpen === true && !marketOpen) {
      void this.refreshUniverse().catch(() => undefined);
    }
    this.lastMarketOpen = marketOpen;

    if (marketOpen) {
      let moved = false;
      for (const [u, w] of [...this.windows]) {
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
    for (const w of this.windows.values()) {
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
    this.opportunities = sortOpportunities(out);
    this.evaluatedAt = now;
  }

  /* -------------------------------- views --------------------------------- */

  getOpportunities(limit?: number): SynthOpportunity[] {
    return limit && limit > 0 ? this.opportunities.slice(0, limit) : this.opportunities;
  }

  getStatus() {
    const now = Date.now();
    const last = this.quotes.lastUpdateAt;
    const feedAge = last === null ? null : now - last;
    const marketOpen = this.deps.isMarketOpen();
    return {
      running: this.running,
      market_open: marketOpen,
      authenticated: this.deps.marketData.isAuthenticated(),
      broker: this.deps.activeBroker(),
      detection_only: true,
      strike_level: this.strikeLevel,
      paired_underlyings: this.chains.size,
      monitored_underlyings: this.windows.size,
      skipped_for_budget: this.skippedForBudget,
      subscribed_tokens: this.watched.size,
      ready_books: this.quotes.size,
      feed_age_ms: feedAge,
      feed_healthy:
        !this.running || !marketOpen || (feedAge !== null && feedAge <= this.cfg.feedMaxAgeMs),
      universe_at: this.universeAt,
      evaluated_at: this.evaluatedAt,
      close_session_day: marketOpen ? null : this.closeSessionDay,
      eligible_count: this.opportunities.filter((o) => o.status === "ELIGIBLE").length,
      opportunity_count: this.opportunities.length,
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
      max_underlyings: this.cfg.maxUnderlyings,
      enable_conversion: this.cfg.enableConversion,
      enable_reversal: this.cfg.enableReversal,
      skip_expiry_day: this.cfg.skipExpiryDay,
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
    return { status: this.getStatus(), opportunities: this.getOpportunities() };
  }

  publish(): void {
    if (this.sseClients.size === 0) return;
    const payload = this.snapshot();
    for (const c of this.sseClients) this.writeFrame(c, "snapshot", payload);
  }

  private writeFrame(client: SseClient, event: string, payload: unknown): void {
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      /* the request's close handler removes the client */
    }
  }
}
