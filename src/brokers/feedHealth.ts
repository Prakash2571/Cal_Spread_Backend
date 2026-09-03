/**
 * A truthful feed-health state, replacing "the socket is connected".
 *
 * WHY "CONNECTED" WAS NOT GOOD ENOUGH
 * The broker panel showed `Feed: Live` because a WebSocket was open — while the board
 * behind it displayed `LTP -` for every instrument. Both were accurate and together
 * they were useless: the socket really was connected, and it really had nothing
 * subscribed. A health signal that reports success in that state actively misleads,
 * because it points the operator away from the actual problem.
 *
 * So liveness is decomposed into the three questions that can fail independently:
 * is there a connection, is anything subscribed, and is data arriving.
 */

/** Feed state, ordered roughly worst → best. */
export type FeedState =
  /** No socket, and nothing trying to open one (usually: no session). */
  | "DOWN"
  /** A socket is being established, or is reconnecting after a drop. */
  | "CONNECTING"
  /**
   * Connected with ZERO subscriptions.
   *
   * Its own state because it is the failure the old boolean hid: healthy transport,
   * no data, and no error anywhere to explain the empty screen.
   */
  | "CONNECTED_NO_SUBSCRIPTIONS"
  /** Connected, subscribed, and ticks are arriving within the freshness window. */
  | "LIVE"
  /**
   * Connected and subscribed, but nothing has arrived recently.
   *
   * Distinct from LIVE because a resting book is normal outside market hours, while
   * silence during a session means the feed has died without closing the socket.
   */
  | "STALE";

export interface FeedHealth {
  state: FeedState;
  connected: boolean;
  /** Tokens the coordinator currently wants upstream. */
  subscribed: number;
  /** Instruments in the active broker's universe, or null when not loaded. */
  universe: number | null;
  /** Age of the newest tick (ms), or null when none has arrived. */
  feed_age_ms: number | null;
  last_tick_at: number | null;
  /** Human-readable, safe to show verbatim. */
  detail: string;
}

export interface FeedHealthInput {
  connected: boolean;
  /** True while a connection attempt or reconnect is pending. */
  connecting?: boolean;
  /** Whether the broker session can serve data at all. */
  authenticated: boolean;
  subscribed: number;
  universe: number | null;
  lastTickAt: number | null;
  /**
   * How long without a tick before a subscribed feed is called STALE.
   *
   * Generous by default: a depth feed only sends a message when the book changes, so
   * silence on an illiquid instrument is not a fault. This is about detecting a dead
   * socket, not an idle one.
   */
  staleAfterMs?: number;
  now?: number;
}

export function computeFeedHealth(input: FeedHealthInput): FeedHealth {
  const now = input.now ?? Date.now();
  const staleAfterMs = input.staleAfterMs ?? 30_000;
  const lastTickAt = input.lastTickAt ?? null;
  const feedAgeMs = lastTickAt === null ? null : Math.max(0, now - lastTickAt);

  const base = {
    connected: input.connected,
    subscribed: input.subscribed,
    universe: input.universe,
    feed_age_ms: feedAgeMs,
    last_tick_at: lastTickAt,
  };

  if (!input.authenticated) {
    return { ...base, state: "DOWN", detail: "No broker session — connect the broker." };
  }
  if (!input.connected) {
    return input.connecting
      ? { ...base, state: "CONNECTING", detail: "Connecting to the broker feed…" }
      : { ...base, state: "DOWN", detail: "The broker feed is not connected." };
  }
  if (input.subscribed === 0) {
    // The specific lie the old boolean told.
    return {
      ...base,
      state: "CONNECTED_NO_SUBSCRIPTIONS",
      detail:
        "Feed connected but nothing is subscribed — open the board or start the scanner. " +
        "No prices will arrive until something asks for instruments.",
    };
  }
  if (lastTickAt === null) {
    return {
      ...base,
      state: "CONNECTING",
      detail: `Subscribed to ${input.subscribed} instrument(s), waiting for the first tick.`,
    };
  }
  if (feedAgeMs !== null && feedAgeMs > staleAfterMs) {
    return {
      ...base,
      state: "STALE",
      detail: `No tick for ${Math.round(feedAgeMs / 1000)}s across ${input.subscribed} subscribed instrument(s).`,
    };
  }
  return {
    ...base,
    state: "LIVE",
    detail: `${input.subscribed} instrument(s) subscribed, last tick ${feedAgeMs}ms ago.`,
  };
}

/**
 * Whether the feed is good enough to price a decision.
 *
 * LIVE only. CONNECTED_NO_SUBSCRIPTIONS and STALE are deliberately excluded: both mean
 * the books on hand are not being maintained, and treating either as usable is how a
 * strategy ends up trading a frozen order book.
 */
export function isFeedUsable(health: FeedHealth): boolean {
  return health.state === "LIVE";
}
