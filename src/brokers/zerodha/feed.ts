/**
 * ONE Zerodha (Kite) market-data socket, scoped to ONE lane.
 *
 * WHY THIS EXISTS
 * The Kite socket lifecycle used to live inside `TickerHub`, tangled together with the
 * shared quote caches and the SSE fan-out. That was fine while there was exactly one
 * connection, and became the blocker the moment a second lane was needed: there was no
 * Zerodha feed object to instantiate twice. This is that object — the socket, its
 * subscription set, and its reconnect policy, and nothing else. `TickerHub` keeps the
 * caches and the browser fan-out; the Box lane owns a second instance of this and
 * feeds its own quote store.
 *
 * IT ALSO ADDS RECONNECT, WHICH KITE DID NOT HAVE
 * The old hub's `onClose` merely nulled the handle: the socket came back only if
 * something later happened to call `subscribeTokens`. So a mid-session network blip
 * could silently leave the feed dead until the next strike-window move. Both lanes now
 * reconnect on a capped exponential backoff and resubscribe their OWN wanted set on
 * open, which is the behaviour the Dhan feed already had.
 *
 * SUBSCRIPTION STATE IS PER-LANE AND PRIVATE
 * `wanted` is what this lane has been asked for; `subscribed` is what it has actually
 * confirmed on the wire. They differ during a reconnect, and both are reported, because
 * "wanted 2800 / subscribed 0" is a completely different incident from "wanted 2800 /
 * subscribed 2800". Crucially, one lane can never unsubscribe another lane's token:
 * there is no shared set to get it wrong with.
 */

import { connectTicker, type Tick, type TickerHandle } from "../../ticker.js";
import { TickRateCounter, type LaneFeedStats, type MarketDataLane } from "../marketDataLane.js";

/** Backoff bounds. Same shape as the Dhan feed's, so the two lanes behave alike. */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;

export interface ZerodhaFeedOptions {
  lane: MarketDataLane;
  /** Read fresh on every connect: a reconnect must use the CURRENT access token. */
  credentials: () => { apiKey: string; accessToken: string | null };
  onTicks: (ticks: Tick[]) => void;
  onConnectionChange?: (connected: boolean) => void;
  /** Kite rejected the feed (dead or expired token). Not a reconnectable condition. */
  onDead?: (message: string) => void;
  /** The broker generation this feed belongs to, so stale ticks are identifiable. */
  generation: () => number;
  now?: () => number;
}

export class ZerodhaFeed {
  readonly lane: MarketDataLane;

  private handle: TickerHandle | null = null;
  private wanted = new Set<number>();
  private subscribed = new Set<number>();
  private connected = false;
  private disposed = false;
  private reconnectAttempts = 0;
  private reconnects = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTickAt: number | null = null;
  private rate = new TickRateCounter();
  /** The generation this socket was opened under, captured at open. */
  private socketGeneration: number;

  constructor(private readonly opts: ZerodhaFeedOptions) {
    this.lane = opts.lane;
    this.socketGeneration = opts.generation();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Open the socket if credentials allow it. Idempotent. */
  ensureSocket(): void {
    if (this.disposed || this.handle) return;
    const { apiKey, accessToken } = this.opts.credentials();
    if (!accessToken) return;

    this.socketGeneration = this.opts.generation();
    let handle: TickerHandle;
    handle = connectTicker({
      apiKey,
      accessToken,
      tokens: [...this.wanted],
      // Every callback is guarded on socket identity, so a late event from a
      // superseded generation cannot touch current state.
      onTick: (ticks) => {
        if (this.handle !== handle || this.disposed) return;
        // GENERATION GUARD. A socket opened under an older broker generation must not
        // publish into the new one's stores: the token namespaces differ, so an
        // integer that means one contract on Zerodha means another on Dhan.
        if (this.socketGeneration !== this.opts.generation()) return;
        this.lastTickAt = this.now();
        this.rate.mark(ticks.length, this.lastTickAt);
        this.opts.onTicks(ticks);
      },
      onOpen: () => {
        if (this.handle !== handle || this.disposed) return;
        this.reconnectAttempts = 0;
        // Resubscribe THIS LANE's wanted set. `connectTicker` already sent the
        // constructor list, so only record what is now live.
        this.subscribed = new Set(this.wanted);
        this.setConnected(true);
      },
      onError: (message) => {
        if (this.handle !== handle || this.disposed) return;
        // A credential failure is terminal — retrying it would just spin.
        this.opts.onDead?.(message);
        this.teardown();
      },
      onClose: () => {
        if (this.handle !== handle || this.disposed) return;
        this.handle = null;
        this.subscribed.clear();
        this.setConnected(false);
        this.scheduleReconnect();
      },
    });
    this.handle = handle;
  }

  /** Declare this lane's ENTIRE token set. Diffs against what is already live. */
  setTokens(tokens: number[]): void {
    const want = new Set(tokens.filter((t) => Number.isFinite(t) && t > 0));
    const toAdd: number[] = [];
    const toDrop: number[] = [];
    for (const token of want) if (!this.wanted.has(token)) toAdd.push(token);
    for (const token of this.wanted) if (!want.has(token)) toDrop.push(token);
    this.wanted = want;

    if (!this.handle) {
      // Nothing live yet: the set is remembered and sent on open.
      if (want.size > 0) this.ensureSocket();
      return;
    }
    // Unsubscribe first, so a set that both adds and drops cannot momentarily exceed
    // the per-connection instrument allowance.
    if (toDrop.length > 0) {
      this.handle.unsubscribe(toDrop);
      for (const token of toDrop) this.subscribed.delete(token);
    }
    if (toAdd.length > 0) {
      this.handle.subscribe(toAdd);
      for (const token of toAdd) this.subscribed.add(token);
    }
  }

  subscribeTokens(tokens: number[]): void {
    if (tokens.length === 0) return;
    const fresh = tokens.filter((t) => Number.isFinite(t) && t > 0 && !this.wanted.has(t));
    for (const token of fresh) this.wanted.add(token);
    if (!this.handle) {
      this.ensureSocket();
      return;
    }
    if (fresh.length > 0) {
      this.handle.subscribe(fresh);
      for (const token of fresh) this.subscribed.add(token);
    }
  }

  unsubscribeTokens(tokens: number[]): void {
    const drop = tokens.filter((t) => this.wanted.has(t));
    if (drop.length === 0) return;
    for (const token of drop) {
      this.wanted.delete(token);
      this.subscribed.delete(token);
    }
    this.handle?.unsubscribe(drop);
  }

  isConnected(): boolean {
    return this.connected;
  }

  wantedCount(): number {
    return this.wanted.size;
  }

  subscribedCount(): number {
    return this.subscribed.size;
  }

  stats(): LaneFeedStats {
    const now = this.now();
    return {
      lane: this.lane,
      connected: this.connected,
      subscribedTokens: this.subscribed.size,
      wantedTokens: this.wanted.size,
      ticksPerSecond: this.rate.perSecond(now),
      lastTickAgeMs: this.lastTickAt === null ? null : Math.max(0, now - this.lastTickAt),
      reconnects: this.reconnects,
      generation: this.socketGeneration,
    };
  }

  /**
   * Tear the lane down and forget its subscriptions.
   *
   * Called on a broker switch and at shutdown. The token set MUST go: these are
   * Zerodha instrument tokens, and they are meaningless — worse, actively misleading —
   * to Dhan.
   */
  stop(): void {
    this.disposed = true;
    this.teardown();
    this.wanted.clear();
    this.rate.reset();
    this.lastTickAt = null;
  }

  private teardown(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const handle = this.handle;
    this.handle = null;
    this.subscribed.clear();
    handle?.close();
    this.setConnected(false);
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.opts.onConnectionChange?.(connected);
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    if (this.wanted.size === 0) return; // nothing to stream: do not hold a socket open
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts++;
    this.reconnects++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed) return;
      this.ensureSocket();
    }, delay);
    // Never let a reconnect timer keep the process alive on shutdown.
    this.reconnectTimer.unref?.();
  }
}
