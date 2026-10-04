import { createHash, randomUUID } from "node:crypto";
import type { Instrument } from "../kite.js";
import type { Tick } from "../ticker.js";
import { BoundedTtlCache } from "../boundedCache.js";
import { configVersion, defaultConfig, mergeConfig, MODEL_VERSION, validateConfig } from "./config.js";
import { resolveOptionMetadata, utcTimestamp } from "./metadata.js";
import { validateCalculatorRequest } from "./calculator.js";
import { AnalyticsWorkers } from "./workers.js";
import { SnapshotHistory, historySummary, type FairValueHistorySummary } from "./history.js";
import type { FairValueStore } from "./store.js";
import type { CalculatorResult, FairValueConfig, IndependentEstimate, InputSnapshot, MarketQuote, OptionMetadata, SurfaceSnapshot } from "./types.js";

export interface FairValueBoardItem { symbol: string; name: string; spot_token: number; is_index?: boolean }
export interface FairValueDeps {
  getAllInstruments: () => Promise<Instrument[]>;
  getBoard: () => Promise<FairValueBoardItem[]>;
  metadataVersion: () => string;
  activeBroker: () => string;
  brokerGeneration: () => number;
  dataReady: () => boolean;
  switching: () => boolean;
  forceDisabledReason?: string | null;
  setTokens: (tokens: number[]) => void;
  /** Headroom on the existing futures/data lane, after all other consumers. */
  tokenBudget: () => number;
  retainFeed: () => () => void;
  feedStatus: () => unknown;
  store: FairValueStore;
  config?: FairValueConfig;
  now?: () => number;
  workers?: AnalyticsWorkers;
}

interface Watched {
  underlying: string; name: string; spot_token: number; touched: number;
  instruments: Instrument[]; universe: InputSnapshot["universe"];
  listing_catalog: OptionMetadata[]; metadata_version: string; center: number | null;
}
const WATCH_IDLE_MS = 180_000;

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export class FairValueEngine {
  private config: FairValueConfig;
  private version: string;
  private workers: AnalyticsWorkers;
  private watched = new Map<string, Watched>();
  private wanted = new Set<number>();
  private quotes = new Map<number, MarketQuote>();
  private spots = new Map<number, { value: number; timestamp: string; exchange_timestamp: string | null;
    receive_timestamp: string; freshness_basis: "exchange" | "receive" }>();
  private latest = new Map<string, SurfaceSnapshot>();
  private inputs = new Map<string, InputSnapshot>();
  private histories: SnapshotHistory;
  private pending = new Set<string>();
  private rebuilding: Promise<void> | null = null;
  private lastUniverseRefresh = 0;
  private updatingConfig = false;
  private feedGeneration = 1;
  private lastBrokerGeneration: number;
  private quoteVersion = 0;
  private publicationSequence = 0;
  private paused = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private releaseFeed: (() => void) | null = null;
  private lastError: string | null = null;
  private configPersisted = false;
  private persistenceError: string | null = null;
  private historyQueue: { snapshot: SurfaceSnapshot; input: InputSnapshot }[] = [];
  private persisting = false;
  private lastHistory = new Map<string, number>();
  private listeners = new Set<() => void>();
  private disposed = false;
  private independentCache: BoundedTtlCache<IndependentEstimate>;
  private retainedInputs: BoundedTtlCache<{ input: InputSnapshot; surface: SurfaceSnapshot }>;
  private independentPending = new Map<string, Promise<IndependentEstimate>>();
  private now: () => number;

  constructor(private deps: FairValueDeps) {
    this.config = structuredClone(deps.config ?? defaultConfig());
    validateConfig(this.config);
    if (deps.forceDisabledReason) { this.config.enabled = false; this.lastError = deps.forceDisabledReason; }
    this.version = configVersion(this.config);
    this.workers = deps.workers ?? this.makeWorkers();
    this.lastBrokerGeneration = deps.brokerGeneration();
    this.now = deps.now ?? Date.now;
    this.independentCache = new BoundedTtlCache({ maxEntries: this.config.independent_cache_limit,
      ttlMs: this.config.independent_cache_ttl_ms, now: this.now });
    this.retainedInputs = new BoundedTtlCache({ maxEntries: 8, ttlMs: this.config.surface_max_age_ms, now: this.now });
    this.histories = new SnapshotHistory({ maxBytes: this.config.history_memory_max_bytes, maxUnderlyings: 20, now: this.now });
  }

  private makeWorkers(): AnalyticsWorkers {
    return new AnalyticsWorkers({ concurrency: this.config.workers, maxQueue: this.config.max_queue, timeoutMs: this.config.worker_timeout_ms });
  }

  async boot(): Promise<void> {
    try {
      const saved = await this.deps.store.loadConfig();
      if (saved) {
        this.config = mergeConfig(this.config, saved);
        if (this.deps.forceDisabledReason) this.config.enabled = false;
        this.version = configVersion(this.config);
        await this.workers.dispose();
        this.workers = this.makeWorkers();
        this.configPersisted = true;
        this.independentCache = new BoundedTtlCache({ maxEntries: this.config.independent_cache_limit,
          ttlMs: this.config.independent_cache_ttl_ms, now: this.now });
        this.retainedInputs = new BoundedTtlCache({ maxEntries: 8, ttlMs: this.config.surface_max_age_ms, now: this.now });
        this.histories = new SnapshotHistory({ maxBytes: this.config.history_memory_max_bytes, maxUnderlyings: 20, now: this.now });
      }
    } catch (error) { this.persistenceError = error instanceof Error ? error.message : "Configuration restore failed."; }
    if (this.config.enabled) this.armTimer();
  }

  getConfig(): { config: FairValueConfig; version: string; persisted: boolean } {
    return { config: structuredClone(this.config), version: this.version, persisted: this.configPersisted };
  }

  async updateConfig(patch: unknown): Promise<{ version: string; persisted: boolean }> {
    if (this.updatingConfig) throw new Error("A Fair Value configuration update is already in progress.");
    this.updatingConfig = true;
    try { return await this.applyConfig(patch); }
    finally { this.updatingConfig = false; }
  }

  private async applyConfig(patch: unknown): Promise<{ version: string; persisted: boolean }> {
    const next = mergeConfig(this.config, patch);
    if (next.enabled && this.deps.forceDisabledReason) throw new Error(this.deps.forceDisabledReason);
    const nextVersion = configVersion(next);
    this.config = next;
    this.version = nextVersion;
    this.configPersisted = false;
    this.invalidate();
    await this.workers.dispose();
    this.workers = this.makeWorkers();
    this.independentCache = new BoundedTtlCache({ maxEntries: next.independent_cache_limit,
      ttlMs: next.independent_cache_ttl_ms, now: this.now });
    this.retainedInputs = new BoundedTtlCache({ maxEntries: 8, ttlMs: next.surface_max_age_ms, now: this.now });
    const oldHistory = this.histories;
    this.histories = new SnapshotHistory({ maxBytes: next.history_memory_max_bytes, maxUnderlyings: 20, now: this.now });
    for (const symbol of this.lastHistory.keys()) for (const snapshot of oldHistory.list(symbol, next.history_retention_days).reverse()) {
      this.histories.add(snapshot, next.history_limit, next.history_retention_days);
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (next.enabled && !this.paused) {
      this.armTimer();
      await this.rebuild();
    } else this.releaseSubscriptions();
    try {
      await this.deps.store.saveConfig(structuredClone(next), nextVersion);
      this.configPersisted = true;
      this.persistenceError = null;
    } catch (error) { this.persistenceError = error instanceof Error ? error.message : "Configuration persistence failed."; }
    this.notify();
    return { version: nextVersion, persisted: this.configPersisted };
  }

  async underlyings(): Promise<{ symbol: string; name: string; expiries: string[] }[]> {
    const generation = this.deps.brokerGeneration();
    const all = await this.deps.getAllInstruments();
    const board = await this.deps.getBoard();
    if (generation !== this.deps.brokerGeneration() || this.deps.switching()) throw new Error("Broker namespace changed while loading underlyings.");
    const exp = new Map<string, Set<string>>();
    const today = new Date(this.now() + 19800000).toISOString().slice(0, 10);
    for (const i of all) if (i.exchange === "NFO" && (i.instrument_type === "CE" || i.instrument_type === "PE") && i.expiry >= today) {
      const key = i.name.toUpperCase();
      const dates = exp.get(key) ?? new Set<string>();
      dates.add(i.expiry.slice(0, 10));
      exp.set(key, dates);
    }
    return board.filter((b) => exp.has(b.symbol.toUpperCase())).map((b) => ({ symbol: b.symbol.toUpperCase(), name: b.name,
      expiries: [...exp.get(b.symbol.toUpperCase())!].sort() })).sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  async watch(underlying: string): Promise<void> {
    this.assertAvailable();
    const symbol = underlying.trim().toUpperCase();
    if (!/^[A-Z0-9&._-]{1,40}$/.test(symbol)) throw new Error("Invalid underlying symbol.");
    const existing = this.watched.get(symbol);
    if (existing) { existing.touched = this.now(); return; }
    const generation = this.deps.brokerGeneration();
    const board = (await this.deps.getBoard()).find((b) => b.symbol.toUpperCase() === symbol);
    this.assertAvailable();
    if (generation !== this.deps.brokerGeneration()) throw new Error("Broker namespace changed while selecting the underlying.");
    if (!board) throw new Error("Underlying is not present in the existing instrument/spot universe.");
    while (this.watched.size >= this.config.max_underlyings) {
      const oldest = [...this.watched.values()].sort((a, b) => a.touched - b.touched)[0]!;
      this.watched.delete(oldest.underlying);
      this.latest.delete(oldest.underlying);
      this.inputs.delete(oldest.underlying);
    }
    this.watched.set(symbol, { underlying: symbol, name: board.name, spot_token: board.spot_token,
      touched: this.now(), instruments: [], listing_catalog: [], metadata_version: "unloaded", center: null,
      universe: { listed_contracts: 0, captured_contracts: 0, omitted_expiries: [], bounded: false } });
    await this.rebuild();
  }

  async refresh(underlying: string): Promise<{ snapshot: SurfaceSnapshot | null; pending: boolean }> {
    await this.watch(underlying);
    await this.capture(underlying.toUpperCase());
    return { snapshot: this.latest.get(underlying.toUpperCase()) ?? null, pending: this.pending.has(underlying.toUpperCase()) };
  }

  pause(paused: boolean): void {
    this.paused = paused;
    if (paused) { this.invalidate(); this.releaseSubscriptions(); }
    else if (this.config.enabled) { this.armTimer(); void this.rebuild().catch((error) => this.recordFailure(error)); }
    this.notify();
  }

  private assertAvailable(): void {
    if (!this.config.enabled) throw new Error("Fair Value analytics is disabled. Enable its independent configuration switch.");
    if (this.paused) throw new Error("Fair Value analytics is paused.");
    if (this.disposed) throw new Error("Fair Value analytics is stopped.");
    if (this.deps.forceDisabledReason) throw new Error(this.deps.forceDisabledReason);
    if (!this.deps.dataReady() || this.deps.switching()) throw new Error("Current broker market data is unavailable or switching.");
  }

  ingestTicks(ticks: Tick[], at = this.now()): void {
    if (!this.config.enabled || this.paused || this.disposed) return;
    if (this.deps.brokerGeneration() !== this.lastBrokerGeneration) { this.invalidateNamespace(); return; }
    for (const tick of ticks) {
      if (!this.wanted.has(tick.token)) continue;
      const exchangeTimestamp = tick.exchange_ts === undefined || tick.exchange_ts === 0 ? null
        : Number.isFinite(tick.exchange_ts) && tick.exchange_ts > 0 && tick.exchange_ts <= 8640000000000000
          ? new Date(tick.exchange_ts).toISOString() : "invalid_exchange_timestamp";
      const receiveTimestamp = new Date(at).toISOString();
      if (Number.isFinite(tick.last_price) && tick.last_price > 0) this.spots.set(tick.token,
        { value: tick.last_price, timestamp: exchangeTimestamp ?? receiveTimestamp,
          exchange_timestamp: exchangeTimestamp, receive_timestamp: receiveTimestamp,
          freshness_basis: exchangeTimestamp === null ? "receive" : "exchange" });
      const depth = tick.depth_updated === true || (tick.depth_updated === undefined && (tick.bids !== undefined || tick.asks !== undefined));
      if (!depth) continue; // LTP packets cannot refresh a retained bid/ask book.
      const bids = tick.bids ?? [];
      const asks = tick.asks ?? [];
      const bid = bids[0]?.price ?? (tick.bid === 0 ? 0 : null);
      const ask = asks[0]?.price ?? null;
      this.quotes.set(tick.token, {
        token: tick.token, bid, ask,
        bid_depth: bids.filter((b) => b.price === bid).reduce((sum, b) => sum + b.qty, 0),
        ask_depth: asks.filter((a) => a.price === ask).reduce((sum, a) => sum + a.qty, 0),
        exchange_timestamp: exchangeTimestamp,
        receive_timestamp: receiveTimestamp, source: "websocket", version: ++this.quoteVersion,
      });
    }
  }

  invalidate(): void {
    this.feedGeneration++;
    this.lastBrokerGeneration = this.deps.brokerGeneration();
    this.quotes.clear();
    this.spots.clear();
    this.latest.clear();
    this.inputs.clear();
    this.independentCache?.clear();
    this.retainedInputs?.clear();
    this.notify();
  }

  invalidateNamespace(): void {
    this.watched.clear();
    this.releaseSubscriptions();
    this.invalidate();
  }

  /** Synchronously yield low-priority capacity before protective consumers subscribe. */
  yieldToPriority(priority: Set<number>, laneReserveLimit = 2800): void {
    const spare = Math.max(0, laneReserveLimit - priority.size);
    const shared = [...this.wanted].filter((t) => priority.has(t));
    const exclusive = [...this.wanted].filter((t) => !priority.has(t)).slice(0, spare);
    const next = new Set([...shared, ...exclusive]);
    if (next.size === this.wanted.size) return;
    this.wanted = next;
    for (const token of this.quotes.keys()) if (!next.has(token)) this.quotes.delete(token);
    for (const token of this.spots.keys()) if (!next.has(token)) this.spots.delete(token);
    this.deps.setTokens([...next]);
    this.invalidate();
  }

  private armTimer(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => {
      void this.cycle().catch((error) => this.recordFailure(error));
    }, this.config.refresh_ms);
    this.timer.unref();
  }

  private async cycle(): Promise<void> {
    if (!this.config.enabled || this.paused || this.disposed) return;
    if (this.lastBrokerGeneration !== this.deps.brokerGeneration()) {
      this.invalidateNamespace();
    }
    if (!this.deps.dataReady() || this.deps.switching()) return;
    let changed = false;
    for (const [symbol, w] of this.watched) if (this.now() - w.touched > WATCH_IDLE_MS) {
      this.watched.delete(symbol); this.latest.delete(symbol); this.inputs.delete(symbol); changed = true;
    }
    const freshSpotMoved = [...this.watched.values()].some((w) => {
      const spot = this.spots.get(w.spot_token);
      return spot && this.now() - Date.parse(spot.timestamp) <= this.config.quote.max_age_ms &&
        (w.center === null || Math.abs(Math.log(spot.value / w.center)) > this.config.recenter_log_distance);
    });
    const due = this.now() - this.lastUniverseRefresh >= this.config.universe_refresh_ms;
    if (changed || this.wanted.size > this.deps.tokenBudget() || due ||
        (freshSpotMoved && this.now() - this.lastUniverseRefresh >= 15000)) await this.rebuild();
    if (this.historyQueue.length > 0) void this.drainHistory();
    for (const symbol of this.watched.keys()) if (!this.pending.has(symbol)) void this.capture(symbol).catch((error) => this.recordFailure(error));
  }

  private rebuild(): Promise<void> {
    if (this.rebuilding) return this.rebuilding;
    this.rebuilding = this.rebuildNow().finally(() => { this.rebuilding = null; });
    return this.rebuilding;
  }

  private async rebuildNow(): Promise<void> {
    if (!this.config.enabled || this.paused || this.deps.switching()) return;
    const generation = this.deps.brokerGeneration();
    const version = this.version;
    const all = await this.deps.getAllInstruments();
    if (generation !== this.deps.brokerGeneration() || this.deps.switching() || this.paused ||
        this.disposed || !this.config.enabled || this.version !== version) return;
    const tokens: number[] = [];
    const metadataVersion = this.deps.metadataVersion();
    const budget = Math.max(0, Math.min(this.config.max_tokens, this.deps.tokenBudget()));
    const perUnderlying = Math.floor(budget / Math.max(1, this.watched.size));
    const today = new Date(this.now() + 19800000).toISOString().slice(0, 10);
    for (const watched of this.watched.values()) {
      const chain = all.filter((i) => i.exchange === "NFO" && i.name.toUpperCase() === watched.underlying &&
        (i.instrument_type === "CE" || i.instrument_type === "PE") && i.expiry >= today);
      const expiries = [...new Set(chain.map((i) => i.expiry.slice(0, 10)))].sort();
      const supported = expiries.slice(0, this.config.max_expiries);
      const futureContracts = all.filter((i) => i.name.toUpperCase() === watched.underlying && i.exchange === "NFO" &&
        i.instrument_type === "FUT" && supported.includes(i.expiry.slice(0, 10)));
      const observedSpot = this.spots.get(watched.spot_token);
      const spot = observedSpot && Number.isFinite(Date.parse(observedSpot.timestamp)) &&
        this.now() - Date.parse(observedSpot.timestamp) <= this.config.quote.max_age_ms ? observedSpot.value : null;
      watched.center = spot;
      const listingCatalog = all.filter((i) => i.exchange === "NFO" && i.name.toUpperCase() === watched.underlying &&
        (i.instrument_type === "CE" || i.instrument_type === "PE"));
      if (listingCatalog.length > 20000) throw new Error("Underlying listing catalog exceeds the bounded metadata budget.");
      watched.listing_catalog = deepFreeze(listingCatalog.map((i) => resolveOptionMetadata(i, this.config.expiry_policy, metadataVersion))
        .flatMap((r) => r.ok ? [r.metadata] : []));
      watched.metadata_version = metadataVersion;
      const maxOptions = Math.max(0, perUnderlying - 1 - futureContracts.length);
      const eachExpiry = Math.floor(maxOptions / Math.max(1, supported.length));
      const selected: Instrument[] = [];
      for (const expiry of supported) {
        const eligible = chain.filter((i) => i.expiry.slice(0, 10) === expiry);
        const strikes = [...new Set(eligible.map((i) => i.strike))].sort((a, b) => a - b);
        const center = spot ?? strikes[Math.floor(strikes.length / 2)]!;
        const closest = strikes.slice().sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b)
          .slice(0, Math.floor(eachExpiry / 2));
        const keep = new Set(closest);
        selected.push(...eligible.filter((i) => keep.has(i.strike)));
      }
      watched.instruments = selected;
      watched.universe = { listed_contracts: chain.length, captured_contracts: selected.length,
        omitted_expiries: expiries.filter((e) => !supported.includes(e)), bounded: selected.length < chain.length };
      if (perUnderlying > 0) tokens.push(watched.spot_token, ...futureContracts.map((f) => f.instrument_token), ...selected.map((i) => i.instrument_token));
    }
    const next = new Set(tokens.slice(0, budget));
    for (const token of this.quotes.keys()) if (!next.has(token)) this.quotes.delete(token);
    for (const token of this.spots.keys()) if (!next.has(token)) this.spots.delete(token);
    this.wanted = next;
    this.lastUniverseRefresh = this.now();
    this.deps.setTokens([...next]);
    if (next.size > 0 && !this.releaseFeed) this.releaseFeed = this.deps.retainFeed();
    if (next.size === 0) this.releaseSubscriptions();
  }

  private async capture(symbol: string): Promise<void> {
    if (this.pending.has(symbol)) return;
    this.assertAvailable();
    const watched = this.watched.get(symbol);
    if (!watched) return;
    const brokerGeneration = this.deps.brokerGeneration();
    const feedGeneration = this.feedGeneration;
    const version = this.version;
    const all = await this.deps.getAllInstruments();
    if (this.pending.has(symbol) || brokerGeneration !== this.deps.brokerGeneration() || this.deps.switching() ||
        version !== this.version || feedGeneration !== this.feedGeneration || this.paused || !this.config.enabled) return;
    const now = this.now();
    const futures: InputSnapshot["futures"] = [];
    for (const i of all) if (i.exchange === "NFO" && i.instrument_type === "FUT" && i.name.toUpperCase() === symbol &&
      this.wanted.has(i.instrument_token) && Number.isSafeInteger(i.lot_size) && i.lot_size > 0 && Number.isFinite(i.tick_size) && i.tick_size > 0) {
      const quote = this.quotes.get(i.instrument_token);
      const exact = (i as Instrument & { expiry_timestamp?: string }).expiry_timestamp ??
        this.config.expiry_policy?.overrides[i.tradingsymbol] ??
        (this.config.expiry_policy ? `${i.expiry.slice(0, 10)}T${this.config.expiry_policy.local_time}+05:30` : i.expiry);
      const timestamp = utcTimestamp(exact);
      if (quote && timestamp) futures.push({ expiry_timestamp: timestamp, quote: structuredClone(quote), tick_size: i.tick_size });
    }
    const spot = this.spots.get(watched.spot_token);
    const spotAge = spot ? now - Date.parse(spot.timestamp) : Infinity;
    const freshSpot = spot && Number.isFinite(spotAge) && spotAge >= -this.config.quote.future_timestamp_tolerance_ms &&
      spotAge <= this.config.quote.max_age_ms && now - Date.parse(spot.receive_timestamp) <= this.config.quote.max_age_ms ? structuredClone(spot) : null;
    const input: InputSnapshot = {
      id: "", underlying: symbol, name: watched.name, broker: this.deps.activeBroker(), broker_generation: brokerGeneration,
      feed_generation: feedGeneration, valuation_time: new Date(now).toISOString(), metadata_version: watched.metadata_version,
      instruments: structuredClone(watched.instruments),
      quotes: watched.instruments.map((i) => this.quotes.get(i.instrument_token)).filter((q): q is MarketQuote => q !== undefined).map((q) => structuredClone(q)),
      spot: freshSpot, futures, config: structuredClone(this.config), config_version: version, universe: structuredClone(watched.universe),
      spot_provenance: freshSpot ? { exchange_timestamp: freshSpot.exchange_timestamp,
        receive_timestamp: freshSpot.receive_timestamp, freshness_basis: freshSpot.freshness_basis } : null,
    };
    input.id = createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 32);
    input.listing_catalog = watched.listing_catalog;
    this.pending.add(symbol);
    try {
      const result = await this.workers.surface(input);
      if (result.input_snapshot_id !== input.id || result.config_version !== version || result.broker_generation !== brokerGeneration ||
          result.feed_generation !== feedGeneration) throw new Error("Analytics worker returned an inconsistent snapshot identity.");
      if (this.disposed || this.paused || !this.config.enabled || this.version !== version || this.feedGeneration !== feedGeneration ||
          this.deps.brokerGeneration() !== brokerGeneration || this.deps.switching() || this.watched.get(symbol) !== watched ||
          this.deps.metadataVersion() !== input.metadata_version) return;
      result.sequence = ++this.publicationSequence;
      result.id = `${input.id}-${result.sequence}-${randomUUID().slice(0, 8)}`;
      result.published_at = new Date(this.now()).toISOString();
      const snapshot = deepFreeze(result);
      this.latest.set(symbol, snapshot);
      this.inputs.set(symbol, deepFreeze(input));
      this.retainedInputs.set(input.id, { input, surface: snapshot });
      this.lastError = null;
      this.recordHistory(snapshot, input);
      this.notify();
    } catch (error) { this.recordFailure(error); }
    finally { this.pending.delete(symbol); }
  }

  private recordHistory(snapshot: SurfaceSnapshot, input: InputSnapshot): void {
    const now = this.now();
    if (now - (this.lastHistory.get(snapshot.underlying) ?? 0) < this.config.history_interval_ms) return;
    this.lastHistory.set(snapshot.underlying, now);
    while (this.lastHistory.size > 20) this.lastHistory.delete(this.lastHistory.keys().next().value!);
    this.histories.add(snapshot, this.config.history_limit, this.config.history_retention_days);
    if (this.deps.store.enabled()) {
      this.historyQueue.push({ snapshot, input });
      if (this.historyQueue.length > this.config.max_queue) { this.historyQueue.shift(); this.persistenceError = "History persistence queue full; oldest pending analytics snapshot omitted."; }
      void this.drainHistory();
    }
  }

  private async drainHistory(): Promise<void> {
    if (this.persisting) return;
    this.persisting = true;
    try {
      while (this.historyQueue.length > 0 && !this.disposed) {
        const item = this.historyQueue.shift()!;
        try { await this.deps.store.append(item.snapshot, item.input, this.config.history_limit, this.config.history_retention_days); this.persistenceError = null; }
        catch (error) {
          this.persistenceError = error instanceof Error ? error.message : "History persistence failed.";
          this.historyQueue.unshift(item);
          break; // bounded retry on next cycle, never a hot failure loop
        }
      }
    } finally { this.persisting = false; }
  }

  getSnapshot(underlying: string): { snapshot: SurfaceSnapshot | null; surface_age_ms: number | null; stale: boolean; status: ReturnType<FairValueEngine["status"]> } {
    if (this.deps.brokerGeneration() !== this.lastBrokerGeneration) this.invalidateNamespace();
    const symbol = underlying.toUpperCase();
    const watched = this.watched.get(symbol);
    if (watched) watched.touched = this.now();
    const snapshot = this.latest.get(symbol) ?? null;
    const age = snapshot ? this.now() - Date.parse(snapshot.valuation_time) : null;
    return { snapshot, surface_age_ms: age, stale: age !== null && age > this.config.surface_max_age_ms, status: this.status() };
  }

  getInput(symbol: string): InputSnapshot | null { return this.inputs.get(symbol.toUpperCase()) ?? null; }

  private currentInputs(symbol: string, snapshotId?: string): { input: InputSnapshot; surface: SurfaceSnapshot } {
    this.assertAvailable();
    const retained = snapshotId ? this.retainedInputs.get(snapshotId) : undefined;
    const input = retained?.input ?? this.inputs.get(symbol), surface = retained?.surface ?? this.latest.get(symbol);
    if (!input || !surface) throw new Error("No published input/surface snapshot for the requested underlying.");
    if (input.underlying !== symbol || (snapshotId && input.id !== snapshotId)) throw new Error("Input snapshot is no longer retained; refresh the chain.");
    if (this.now() - Date.parse(input.valuation_time) > this.config.surface_max_age_ms ||
        input.broker_generation !== this.deps.brokerGeneration() || input.feed_generation !== this.feedGeneration ||
        input.config_version !== this.version) throw new Error("Surface is stale or its broker/feed/configuration changed; refresh first.");
    return { input, surface };
  }

  async calculate(value: unknown): Promise<CalculatorResult> {
    const request = validateCalculatorRequest(value);
    if (Date.parse(request.expiry_timestamp) <= this.now()) throw new Error("Calculator requires a future expiry timestamp.");
    const { input, surface } = this.currentInputs(request.underlying, request.input_snapshot_id);
    const requestedMetadata = input.listing_catalog?.filter((m) => m.strike === request.strike && m.side === request.side && m.expiry_timestamp === request.expiry_timestamp);
    const result = await this.workers.submit<CalculatorResult>("calculate", { input: { ...input, listing_catalog: requestedMetadata ?? [] }, surface, request });
    if (result.input_snapshot_id !== input.id || result.config_version !== input.config_version) throw new Error("Calculator worker returned inconsistent snapshot identity.");
    this.currentInputs(request.underlying, input.id);
    if (input.config_version !== this.version || input.feed_generation !== this.feedGeneration ||
        input.broker_generation !== this.deps.brokerGeneration()) throw new Error("Calculator snapshot was invalidated while computing.");
    if (Date.parse(request.expiry_timestamp) <= this.now()) throw new Error("Requested contract expired during calculation.");
    return result;
  }

  async independent(value: unknown): Promise<IndependentEstimate> {
    if (!value || typeof value !== "object") throw new Error("Independent estimate request must be an object.");
    const r = value as Record<string, unknown>;
    if (typeof r.underlying !== "string" || typeof r.expiry !== "string" || typeof r.strike !== "number" ||
        !Number.isFinite(r.strike) || r.strike <= 0 || typeof r.input_snapshot_id !== "string") throw new Error("Provide underlying, listed expiry, numeric strike and input_snapshot_id.");
    const symbol = r.underlying.toUpperCase();
    const { input, surface } = this.currentInputs(symbol, r.input_snapshot_id);
    if (input.id !== r.input_snapshot_id) throw new Error("Input snapshot changed; select a target from the current chain.");
    const targetExpiry = surface.slices.find((s) => s.expiry === r.expiry)?.expiry_timestamp;
    if (!targetExpiry || Date.parse(targetExpiry) <= this.now()) throw new Error("Independent estimate requires a verified unexpired listed expiry.");
    const key = `${input.id}:${r.expiry}:${r.strike}:${MODEL_VERSION}:${input.config_version}`;
    const cached = this.independentCache.get(key);
    if (cached) return cached;
    const existing = this.independentPending.get(key);
    if (existing) return existing;
    if (this.independentPending.size >= this.config.max_queue) throw new Error("Independent-estimate resource budget exceeded.");
    const { listing_catalog: _catalog, ...calibrationInput } = input;
    const promise = this.workers.submit<IndependentEstimate>("independent", { input: calibrationInput, expiry: r.expiry, strike: r.strike })
      .then((result) => {
        if (result.input_snapshot_id !== input.id || result.config_version !== input.config_version || result.strike !== r.strike || result.expiry !== r.expiry) throw new Error("Independent worker returned inconsistent snapshot identity.");
        this.currentInputs(symbol, input.id);
        if (input.config_version !== this.version || input.feed_generation !== this.feedGeneration ||
            input.broker_generation !== this.deps.brokerGeneration()) throw new Error("Independent estimate was invalidated while refitting.");
        if (Date.parse(targetExpiry) <= this.now()) throw new Error("Target contract expired during the independent refit.");
        this.independentCache.set(key, deepFreeze(result));
        return result;
      }).finally(() => { this.independentPending.delete(key); });
    this.independentPending.set(key, promise);
    return promise;
  }

  async history(underlying: string, limit: number): Promise<FairValueHistorySummary[]> {
    const symbol = underlying.toUpperCase();
    const memory = this.histories.list(symbol, this.config.history_retention_days).map(historySummary);
    const durable = await this.deps.store.history(symbol, Math.min(limit, this.config.history_limit)).catch((error) => {
      this.persistenceError = error instanceof Error ? error.message : "History read failed.";
      return [];
    });
    const merged = new Map([...durable, ...memory].map((s) => [s.id, s]));
    const cutoff = this.now() - this.config.history_retention_days * 86400000;
    return [...merged.values()].filter((s) => Date.parse(s.published_at) >= cutoff)
      .sort((a, b) => b.published_at.localeCompare(a.published_at)).slice(0, Math.min(Math.floor(limit), this.config.history_limit));
  }

  async historicalSnapshot(underlying: string, id: string): Promise<SurfaceSnapshot | null> {
    const memory = this.histories.get(underlying.toUpperCase(), id, this.config.history_retention_days);
    const snapshot = memory ?? await this.deps.store.snapshot(underlying.toUpperCase(), id);
    return snapshot && Date.parse(snapshot.published_at) >= this.now() - this.config.history_retention_days * 86400000 ? snapshot : null;
  }

  status() {
    if (this.deps.brokerGeneration() !== this.lastBrokerGeneration) this.invalidateNamespace();
    return {
      enabled: this.config.enabled, paused: this.paused, model_version: MODEL_VERSION, config_version: this.version,
      force_disabled_reason: this.deps.forceDisabledReason ?? null,
      surface_max_age_ms: this.config.surface_max_age_ms,
      config_persisted: this.configPersisted, expiry_policy_configured: this.config.expiry_policy !== null,
      curve_configured: this.config.curve.nodes.length > 0 || (this.config.curve.flat_rate !== null && this.config.curve.allow_flat_fallback),
      broker: this.deps.activeBroker(), broker_generation: this.deps.brokerGeneration(), feed_generation: this.feedGeneration,
      feed: this.deps.feedStatus(), data_ready: this.deps.dataReady(), subscribed_tokens: this.wanted.size,
      watched_underlyings: [...this.watched.keys()], workers: this.workers.stats(), last_error: this.lastError,
      storage: this.deps.store.enabled() ? "mongodb" : "memory_only", persistence_error: this.persistenceError,
      history_memory: this.histories.stats(),
      surfaces: [...this.latest.values()].map((s) => ({ underlying: s.underlying, id: s.id, sequence: s.sequence,
        age_ms: this.now() - Date.parse(s.valuation_time), valid_expiries: s.slices.filter((e) => e.smile.valid).length })),
    };
  }

  subscribe(listener: () => void): () => void {
    if (this.listeners.size >= 20) throw new Error("Fair Value subscription limit reached.");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify(): void { for (const fn of this.listeners) { try { fn(); } catch { /* downstream failure isolated */ } } }
  private recordFailure(error: unknown): void { this.lastError = error instanceof Error ? error.message : "Analytics failed."; this.notify(); }
  private releaseSubscriptions(): void {
    this.deps.setTokens([]); this.wanted.clear(); this.quotes.clear(); this.spots.clear();
    this.releaseFeed?.(); this.releaseFeed = null;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.releaseSubscriptions();
    this.listeners.clear();
    await this.workers.dispose();
  }
}
