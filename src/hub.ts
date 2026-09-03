import type { Response } from "express";
import {
  connectTicker,
  type Tick,
  type TickerHandle,
  type DepthLevel,
} from "./ticker.js";

/**
 * A single shared Kite WebSocket that fans out ticks to every connected SSE
 * client. This keeps us to ONE upstream Zerodha connection no matter how many
 * visitors are watching (Zerodha caps WebSocket connections at ~3 per API key),
 * so the public live feed scales to many simultaneous viewers.
 */

interface HubClient {
  res: Response;
  tokens: Set<number>;
}

interface HubCreds {
  apiKey: string;
  accessToken: string | null;
}

export class TickerHub {
  private handle: TickerHandle | null = null;
  private clients = new Set<HubClient>();
  private subscribed = new Set<number>();
  /**
   * Headless consumers holding the upstream socket open.
   *
   * An SSE client is not the only legitimate reason to have a live feed: the box
   * scanner has to keep managing open paper positions with no browser attached.
   * A retainer keeps the connection (and therefore the cached books) alive while
   * that is true, without pretending to be a client that wants SSE frames.
   */
  private retainers = new Set<object>();
  /** Headless tick consumers (the box quote store). */
  private tickListeners = new Set<(ticks: Tick[]) => void>();
  /** Consumers that must invalidate stale books on every socket generation. */
  private connectionListeners = new Set<(connected: boolean) => void>();
  private connected = false;
  /** Last tick seen per token, so new clients get an instant snapshot. */
  private latest = new Map<number, Tick>();
  /** When each token's live tick was last received (for freshness checks). */
  private latestAt = new Map<number, number>();
  /** Latest full order book per token (kept internal, not broadcast). */
  private latestLadder = new Map<
    number,
    { last: number; bids: DepthLevel[]; asks: DepthLevel[] }
  >();
  private latestLadderAt = new Map<number, number>();

  constructor(
    private getCreds: () => HubCreds,
    /** Called when Zerodha rejects the feed (dead/expired token). */
    private onDead: () => void,
  ) {}

  /**
   * Register an SSE client. Returns a cleanup function to call when the client
   * disconnects. Immediately pushes the latest cached snapshot for its tokens.
   */
  /**
   * Attach a browser for FAN-OUT ONLY — never opens an upstream socket.
   *
   * The split matters: `addClient` used to both register the client AND call
   * `ensureSocket`, which meant opening a browser tab created a ZERODHA WebSocket even
   * when Dhan was the active broker. Upstream subscription is now the
   * SubscriptionCoordinator's job (see brokers/subscriptions.ts), and this hub is
   * purely the downstream cache/fan-out layer for whichever broker is active.
   */
  attachClient(res: Response, tokens: number[]): () => void {
    const client: HubClient = { res, tokens: new Set(tokens) };
    this.clients.add(client);

    // Instant snapshot so the visitor sees prices without waiting for a live tick.
    const snapshot = tokens
      .map((t) => this.latest.get(t))
      .filter((t): t is Tick => Boolean(t));
    if (snapshot.length) {
      res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    }

    return () => {
      this.clients.delete(client);
      // Deliberately does NOT stop the upstream feed. Whether a token is still needed
      // is the coordinator's decision, and tearing the socket down from here would
      // disconnect the scanner and every other client.
    };
  }

  /**
   * @deprecated Zerodha-only legacy path: attaches AND opens a Kite socket.
   * Retained for the Zerodha-only capture/recorder callers. New code must use
   * `attachClient` plus the SubscriptionCoordinator so the ACTIVE broker is honoured.
   */
  addClient(res: Response, tokens: number[]): () => void {
    const client: HubClient = { res, tokens: new Set(tokens) };
    this.clients.add(client);

    this.ensureSocket(tokens);

    // Send an instant snapshot so the visitor sees prices without waiting for
    // the next live tick (important after market hours / for late joiners).
    const snapshot = tokens
      .map((t) => this.latest.get(t))
      .filter((t): t is Tick => Boolean(t));
    if (snapshot.length) {
      res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    }

    return () => {
      this.clients.delete(client);
      // No listeners left → drop the upstream connection to free the quota.
      // A retainer (e.g. the box engine managing open positions) counts as a
      // listener: when one is held the feed must survive the last SSE client.
      if (this.clients.size === 0 && this.retainers.size === 0) this.stop();
    };
  }

  /** Seed the tick cache from a REST snapshot (so late joiners get data fast). */
  seed(ticks: Tick[]): void {
    for (const t of ticks) this.latest.set(t.token, t);
  }

  /**
   * Hold the upstream connection open without being an SSE client.
   *
   * Returns a release function. While at least one retainer is held the socket
   * (and the cached books) survive even with no browser connected — which is what
   * lets a headless strategy keep monitoring its open positions.
   */
  retain(tokens: number[] = []): () => void {
    const key = {};
    this.retainers.add(key);
    if (tokens.length > 0) this.ensureSocket(tokens);
    else this.ensureSocket([]);
    return () => {
      this.retainers.delete(key);
      if (this.clients.size === 0 && this.retainers.size === 0) this.stop();
    };
  }

  /** Subscribe extra tokens for a headless consumer. */
  subscribeTokens(tokens: number[]): void {
    if (tokens.length === 0) return;
    this.ensureSocket(tokens);
  }

  /**
   * Stop streaming tokens no headless consumer needs any more.
   *
   * Tokens an SSE client still asks for are kept, so a scanner releasing a strike
   * window can never blank a chart someone is watching.
   */
  unsubscribeTokens(tokens: number[]): void {
    if (tokens.length === 0) return;
    const stillWanted = new Set<number>();
    for (const client of this.clients) {
      for (const t of client.tokens) stillWanted.add(t);
    }
    const drop = tokens.filter((t) => this.subscribed.has(t) && !stillWanted.has(t));
    if (drop.length === 0) return;
    for (const t of drop) {
      this.subscribed.delete(t);
      this.latest.delete(t);
      this.latestAt.delete(t);
      this.latestLadder.delete(t);
      this.latestLadderAt.delete(t);
    }
    this.handle?.unsubscribe(drop);
  }

  /** Register a headless tick consumer. Returns an unsubscribe function. */
  addTickListener(fn: (ticks: Tick[]) => void): () => void {
    this.tickListeners.add(fn);
    return () => {
      this.tickListeners.delete(fn);
    };
  }

  /**
   * Observe socket generations. The current state is delivered immediately so a
   * late subscriber cannot treat books cached before it attached as warm.
   */
  addConnectionListener(fn: (connected: boolean) => void): () => void {
    this.connectionListeners.add(fn);
    fn(this.connected);
    return () => {
      this.connectionListeners.delete(fn);
    };
  }

  /** True when the upstream socket has completed its WebSocket handshake. */
  isConnected(): boolean {
    return this.connected;
  }

  /** How many instrument tokens are currently subscribed upstream. */
  subscribedCount(): number {
    return this.subscribed.size;
  }

  private ensureSocket(tokens: number[]): void {
    const { apiKey, accessToken } = this.getCreds();
    if (!accessToken) return;

    const fresh = tokens.filter((t) => !this.subscribed.has(t));
    for (const t of fresh) this.subscribed.add(t);

    if (!this.handle) {
      let handle: TickerHandle;
      handle = connectTicker({
        apiKey,
        accessToken,
        tokens: [...this.subscribed],
        onTick: (ticks) => {
          if (this.handle !== handle) return;
          this.broadcast(ticks);
        },
        onOpen: () => {
          if (this.handle !== handle) return;
          this.notifyConnection(true);
        },
        onError: (message) => {
          if (this.handle !== handle) return;
          this.fail(message);
        },
        onClose: () => {
          // Ignore a late close from a superseded socket generation.
          if (this.handle !== handle) return;
          this.handle = null;
          this.notifyConnection(false);
        },
      });
      this.handle = handle;
    } else if (fresh.length) {
      this.handle.subscribe(fresh);
    }
  }

  /**
   * Freshest live bid/ask/last for a token from the WebSocket stream, or null
   * if we have no recent (within maxAgeMs) live tick. Used for real-time fills.
   */
  /** Freshest live full order book for a token (for real-time fills). */
  getFreshLadder(
    token: number,
    maxAgeMs = 5000,
  ): { last: number; bids: DepthLevel[]; asks: DepthLevel[] } | null {
    const l = this.latestLadder.get(token);
    const at = this.latestLadderAt.get(token);
    if (!l || at === undefined || Date.now() - at > maxAgeMs) return null;
    return l;
  }

  /** Public accessor: get the latest cached tick for a given token. */
  getLatestTick(token: number): Tick | undefined {
    return this.latest.get(token);
  }

  /**
   * The latest full book for a token WITH the instant it was received, so a
   * caller can apply its own freshness policy (the box engine's gate is much
   * tighter than getFreshLadder's 5s default).
   */
  getLadderSnapshot(
    token: number,
  ): { last: number; bids: DepthLevel[]; asks: DepthLevel[]; at: number } | null {
    const l = this.latestLadder.get(token);
    const at = this.latestLadderAt.get(token);
    if (!l || at === undefined) return null;
    return { ...l, at };
  }

  private broadcast(ticks: Tick[]): void {
    const now = Date.now();
    const slim: Tick[] = [];
    for (const t of ticks) {
      const s: Tick = {
        token: t.token,
        last_price: t.last_price,
        close_price: t.close_price,
        oi: t.oi,
        bid: t.bid,
        ask: t.ask,
        ...(t.bids ? { bids: t.bids } : {}),
        ...(t.asks ? { asks: t.asks } : {}),
        ...(t.exchange_ts ? { exchange_ts: t.exchange_ts } : {}),
      };
      this.latest.set(t.token, s);
      this.latestAt.set(t.token, now);
      if (t.bids && t.asks && (t.bids.length > 0 || t.asks.length > 0)) {
        this.latestLadder.set(t.token, {
          last: t.last_price,
          bids: t.bids,
          asks: t.asks,
        });
        this.latestLadderAt.set(t.token, now);
      }
      slim.push(s);
    }
    // Headless consumers first: a strategy's decision must not queue behind SSE
    // writes. Isolated so a listener throwing can never break the fan-out.
    for (const listener of this.tickListeners) {
      try {
        listener(slim);
      } catch (err) {
        console.warn("[Hub] tick listener failed:", err);
      }
    }
    const payload = `data: ${JSON.stringify(slim)}\n\n`;
    for (const client of this.clients) {
      try {
        client.res.write(payload);
      } catch {
        // Broken pipe — the client's own 'close' handler will clean it up.
      }
    }
  }

  /**
   * Publish ticks that came from ANOTHER broker's feed (currently Dhan).
   *
   * WHY REUSE THIS HUB RATHER THAN BUILD A SECOND FAN-OUT
   * Every consumer in the app already reads prices from here: the Box quote store via
   * `addTickListener`, browsers via `addClient`, analytics via `getLatestTick` /
   * `getFreshLadder`. Routing Dhan through the same caches and the same fan-out means
   * NO consumer needs to know which broker produced a tick — which is the whole point
   * of the broker-neutral design. A parallel hub would have duplicated the SSE
   * plumbing, the ladder cache and the freshness bookkeeping, and the two would have
   * drifted.
   *
   * This does NOT open a socket and does not touch `subscribed`: the Dhan feed owns
   * its own subscription state. This is purely the publish half.
   *
   * SAFETY: only ONE broker is ever active, and `stop()` clears `latest`/`latestLadder`
   * on a switch, so a Zerodha book can never survive into a Dhan session or vice
   * versa.
   */
  ingestExternalTicks(ticks: Tick[]): void {
    if (ticks.length === 0) return;
    this.broadcast(ticks);
  }

  /**
   * Report an external feed's connection state through the hub's own listeners.
   *
   * Lets the Box engine's existing connection listener invalidate its books on a Dhan
   * reconnect exactly as it does for Kite, with no broker-specific branch.
   */
  setExternalConnected(connected: boolean): void {
    this.notifyConnection(connected);
  }

  private fail(message: string): void {
    this.onDead();
    const frame = `event: kite_error\ndata: ${JSON.stringify({ message })}\n\n`;
    for (const client of this.clients) {
      try {
        client.res.write(frame);
      } catch {
        // ignore
      }
    }
    this.stop();
  }

  private notifyConnection(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    for (const listener of this.connectionListeners) {
      try {
        listener(connected);
      } catch (err) {
        console.warn("[Hub] connection listener failed:", err);
      }
    }
  }

  /**
   * Tear the socket down and DISCARD every cached book.
   *
   * Public because the broker registry must be able to stop this feed when switching
   * away from Zerodha. Dropping `subscribed` and `latest` is the point: a Zerodha
   * depth ladder must never survive into a Dhan session and be treated as executable.
   */
  stop(): void {
    const handle = this.handle;
    this.handle = null;
    handle?.close();
    this.notifyConnection(false);
    this.subscribed.clear();
    this.latest.clear();
  }
}
