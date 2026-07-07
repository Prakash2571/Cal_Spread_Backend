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
      if (this.clients.size === 0) this.stop();
    };
  }

  /** Seed the tick cache from a REST snapshot (so late joiners get data fast). */
  seed(ticks: Tick[]): void {
    for (const t of ticks) this.latest.set(t.token, t);
  }

  private ensureSocket(tokens: number[]): void {
    const { apiKey, accessToken } = this.getCreds();
    if (!accessToken) return;

    const fresh = tokens.filter((t) => !this.subscribed.has(t));
    for (const t of fresh) this.subscribed.add(t);

    if (!this.handle) {
      this.handle = connectTicker({
        apiKey,
        accessToken,
        tokens: [...this.subscribed],
        onTick: (ticks) => this.broadcast(ticks),
        onError: (message) => this.fail(message),
        onClose: () => {
          this.handle = null;
        },
      });
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
    const payload = `data: ${JSON.stringify(slim)}\n\n`;
    for (const client of this.clients) {
      try {
        client.res.write(payload);
      } catch {
        // Broken pipe — the client's own 'close' handler will clean it up.
      }
    }
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

  private stop(): void {
    this.handle?.close();
    this.handle = null;
    this.subscribed.clear();
    this.latest.clear();
  }
}
