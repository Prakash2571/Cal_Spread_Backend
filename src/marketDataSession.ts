/**
 * Server-side market-data subscription sessions.
 *
 * WHY THIS EXISTS
 * The board needs live prices for ~204 underlyings x (1 spot + 3 futures) = ~816
 * tokens. A Dhan internal token is 10 digits, so listing them in a query string
 * produces a ~9 KB request line. nginx caps a request line at ONE header buffer
 * (`large_client_header_buffers` defaults to `4 8k`) and answers 414 during parsing of
 * the first line — before Express sees anything. So `acquireBrowserTokens()` never
 * ran, the coordinator held zero browser leases, the feed had nothing subscribed, and
 * every cell rendered "-". The URL was the bug; the feed was fine.
 *
 * `EventSource` cannot send a request body, so the token list is POSTed once and
 * exchanged for a short opaque id. The SSE URL is then a constant ~60 bytes regardless
 * of how many instruments the board holds, which also removes the failure mode where
 * simply adding stocks to the universe silently breaks live prices.
 *
 * A SESSION MUST SURVIVE RECONNECTS.
 * `EventSource` reconnects by itself, and a single-use id would kill the stream
 * permanently at the first network hiccup — turning a 3-second blip into a dead board.
 * Sessions are therefore LOOKED UP, never consumed, and reaped only once they have
 * been idle with no live connection for `ttlMs`.
 *
 * BOUND TO A BROKER GENERATION.
 * A Kite token and a Dhan token are different namespaces that happen to both be
 * integers. A session minted before a broker switch must be REFUSED afterwards, not
 * resubscribed against the new broker — that is exactly the cross-broker token leak
 * the generation counter exists to catch. The frontend responds to the refusal by
 * refetching the board and minting a new session.
 */

import { randomBytes } from "node:crypto";
import type { BrokerId } from "./brokers/types.js";

/** How long an idle session with no live connection survives. */
const DEFAULT_TTL_MS = 5 * 60_000;

/**
 * Hard ceiling on stored sessions.
 *
 * Sessions are created by unauthenticated visitors (the board is public), so the store
 * is attacker-reachable and MUST be bounded. When full, the least-recently-used idle
 * session is evicted; a session with a live connection is never evicted.
 */
const MAX_SESSIONS = 500;

/** Upper bound on tokens in one session. Generous, but not unbounded. */
export const MAX_SESSION_TOKENS = 4000;

export interface MarketDataSession {
  id: string;
  tokens: number[];
  broker: BrokerId;
  /** The broker generation this session's tokens belong to. */
  generation: number;
  createdAt: number;
  lastUsedAt: number;
  /** Live SSE connections currently reading this session. */
  connections: number;
}

export type SessionRejection =
  | { ok: true; session: MarketDataSession }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "stale_generation"; session: MarketDataSession };

export interface MarketDataSessionStoreOptions {
  ttlMs?: number;
  maxSessions?: number;
  now?: () => number;
}

export class MarketDataSessionStore {
  private sessions = new Map<string, MarketDataSession>();
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly now: () => number;

  constructor(opts: MarketDataSessionStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxSessions = opts.maxSessions ?? MAX_SESSIONS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Mint a session for a token list.
   *
   * Tokens are deduplicated here as well as in the browser: the coordinator refcounts
   * per lease, so a repeated token would otherwise inflate the count and strand an
   * upstream subscription when the lease is released.
   */
  create(tokens: number[], broker: BrokerId, generation: number): MarketDataSession {
    this.sweep();
    this.evictIfFull();

    const unique = [...new Set(tokens)];
    const at = this.now();
    // 128 bits from a CSPRNG: session ids are bearer capabilities for a token list,
    // so they must not be guessable.
    const id = randomBytes(16).toString("hex");
    const session: MarketDataSession = {
      id,
      tokens: unique,
      broker,
      generation,
      createdAt: at,
      lastUsedAt: at,
      connections: 0,
    };
    this.sessions.set(id, session);
    return session;
  }

  /**
   * Resolve a session for streaming, rejecting one minted for a previous broker.
   *
   * Returns a discriminated result rather than null so the caller can answer 404 and
   * 409 differently: "unknown id, mint a new one" and "your board is from the previous
   * broker, refetch it" need different frontend responses.
   */
  resolve(id: string, broker: BrokerId, generation: number): SessionRejection {
    this.sweep();
    const session = this.sessions.get(id);
    if (!session) return { ok: false, reason: "not_found" };
    if (session.broker !== broker || session.generation !== generation) {
      // Drop it: it can never become valid again.
      this.sessions.delete(id);
      return { ok: false, reason: "stale_generation", session };
    }
    session.lastUsedAt = this.now();
    return { ok: true, session };
  }

  /** Mark a live connection. Prevents reaping while the browser is attached. */
  open(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.connections += 1;
    session.lastUsedAt = this.now();
  }

  /**
   * Release a live connection.
   *
   * The session is deliberately KEPT so `EventSource`'s automatic reconnect can reuse
   * it; the TTL sweep removes it if the browser really has gone away.
   */
  close(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.connections = Math.max(0, session.connections - 1);
    session.lastUsedAt = this.now();
  }

  /** Reap idle sessions with no live connection. */
  sweep(): number {
    const cutoff = this.now() - this.ttlMs;
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (session.connections === 0 && session.lastUsedAt < cutoff) {
        this.sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Drop every session on a broker switch.
   *
   * No attempt is made to translate tokens: a Kite token has no Dhan counterpart even
   * when the integers coincide, so translation IS the leak.
   */
  dropAll(): number {
    const dropped = this.sessions.size;
    this.sessions.clear();
    return dropped;
  }

  /** Evict the least-recently-used session that has no live connection. */
  private evictIfFull(): void {
    if (this.sessions.size < this.maxSessions) return;
    let oldest: MarketDataSession | null = null;
    for (const session of this.sessions.values()) {
      if (session.connections > 0) continue;
      if (!oldest || session.lastUsedAt < oldest.lastUsedAt) oldest = session;
    }
    // Every session is live: refuse to grow rather than evicting a working stream.
    if (oldest) this.sessions.delete(oldest.id);
  }

  stats(): { sessions: number; connections: number; tokens: number } {
    let connections = 0;
    let tokens = 0;
    for (const session of this.sessions.values()) {
      connections += session.connections;
      tokens += session.tokens.length;
    }
    return { sessions: this.sessions.size, connections, tokens };
  }

  get size(): number {
    return this.sessions.size;
  }
}

/**
 * Validate and normalize a client-supplied token list.
 *
 * Shared by `POST /api/quotes` and `POST /api/stream/session` so the two transports
 * cannot drift into accepting different things.
 */
export function parseTokenList(
  input: unknown,
  limit = MAX_SESSION_TOKENS,
): { ok: true; tokens: number[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) {
    return { ok: false, error: "Provide a JSON body of the form { \"tokens\": [123, 456] }." };
  }
  if (input.length === 0) {
    return { ok: false, error: "`tokens` must contain at least one instrument token." };
  }
  if (input.length > limit) {
    return {
      ok: false,
      error: `Too many tokens: ${input.length} requested, limit is ${limit}.`,
    };
  }
  const tokens: number[] = [];
  for (const raw of input) {
    // Accept only real numbers. A numeric STRING is rejected rather than coerced:
    // silent coercion is how a malformed board ends up subscribing garbage.
    if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
      return {
        ok: false,
        error: "`tokens` must contain positive integers only.",
      };
    }
    tokens.push(raw);
  }
  return { ok: true, tokens: [...new Set(tokens)] };
}
