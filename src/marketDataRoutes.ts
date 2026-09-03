/**
 * Market-data transport: REST snapshot quotes and the live SSE tick stream.
 *
 * THE BUG THIS FILE EXISTS TO FIX
 * The browser asked for the whole F&O board by listing every token in a query string:
 *
 *     GET /api/quotes?tokens=<816 ten-digit ids>   -> 9022 characters
 *     GET /api/stream?tokens=<816 ten-digit ids>   -> 9022 characters
 *
 * nginx caps a request LINE at one header buffer (`large_client_header_buffers`
 * defaults to `4 8k`) and answers 414 while parsing that first line, so Express never
 * ran the handler. `acquireBrowserTokens()` was therefore never called: the coordinator
 * held zero browser leases, nothing was subscribed upstream, no ticks arrived, and
 * every cell rendered "-". Measured locally: at an 8192-byte limit the request is
 * rejected and the handler does not run; at Node's 16 KB default the same request
 * succeeds — which is why the failure was invisible in the backend logs.
 *
 * So the token list never travels in a URL again:
 *
 *   REST   -> POST /api/quotes            { tokens: [...] }
 *   STREAM -> POST /api/stream/session    { tokens: [...] } -> { id }
 *             GET  /api/stream/session/:id                  -> SSE, constant-size URL
 *
 * WHY A SESSION RATHER THAN SEVERAL CHUNKED EventSource URLS
 * Chunking works, but a browser allows only ~6 concurrent HTTP/1.1 connections per
 * origin. At 100 tokens per stream an 816-token board needs 9 long-lived SSE
 * connections, so three would never open AND they would starve every other request to
 * the origin — including the Box stream. One session means one connection, a URL that
 * does not grow with the universe, and no dependence on HTTP/2 being negotiated. The
 * legacy `?tokens=` route is kept for small token lists (a single stock's detail view)
 * and as a fallback for a browser running against an older backend.
 */

import type { Express, Request, Response } from "express";
import type { Tick } from "./ticker.js";
import type { TickerHub } from "./hub.js";
import type { ActiveBrokerManager } from "./brokers/registry.js";
import { MarketDataSessionStore, parseTokenList, MAX_SESSION_TOKENS } from "./marketDataSession.js";

/** Cap for a single REST quote request. Generous, but bounded. */
const MAX_QUOTE_TOKENS = 4000;

const QUOTES_TTL_MS = 4000;

export interface MarketDataDeps {
  brokerManager: ActiveBrokerManager;
  tickerHub: TickerHub;
  sessions: MarketDataSessionStore;
  requireFullAdmin: import("express").RequestHandler;
  sendError: (res: Response, err: unknown) => void;
  /** Board size, for diagnostics. Never throws. */
  boardSize: () => Promise<number | null>;
}

export function registerMarketDataRoutes(app: Express, deps: MarketDataDeps): void {
  const { brokerManager, tickerHub, sessions, sendError } = deps;

  /**
   * Short-lived cache of the REST quote snapshot.
   *
   * Keyed by BROKER and GENERATION as well as the token set: the same integer means a
   * different instrument at each broker, so a shared key would serve Zerodha prices
   * for Dhan tokens after a switch.
   */
  const quotesCache = new Map<string, { at: number; ticks: Tick[] }>();

  /** The one path both quote transports take, so they cannot diverge. */
  async function serveQuotes(tokens: number[], res: Response): Promise<void> {
    const quoteHealth = brokerManager.activeHealth();
    if (!quoteHealth.data_ready) {
      res.status(401).json({
        error: `Quotes require a ${brokerManager.activeBroker} session.`,
        broker: brokerManager.activeBroker,
        problems: quoteHealth.problems,
      });
      return;
    }

    // Refuse the previous broker's namespace instead of pricing it. A browser holding
    // a stale board would otherwise be served whatever the integers happen to mean now.
    const foreign = tokens.filter(
      (t) => !brokerManager.assertActiveBrokerToken(t, "POST /api/quotes"),
    );
    if (foreign.length > 0) {
      res.status(409).json({
        error:
          `${foreign.length} requested token(s) do not belong to the active broker ` +
          `(${brokerManager.activeBroker}). Refetch the board.`,
        broker: brokerManager.activeBroker,
        generation: brokerManager.generation,
        stale_tokens: foreign.slice(0, 10),
      });
      return;
    }

    const cacheKey =
      `${brokerManager.activeBroker}:${brokerManager.generation}:` +
      tokens.slice().sort((a, b) => a - b).join(",");
    const cached = quotesCache.get(cacheKey);
    if (cached && Date.now() - cached.at < QUOTES_TTL_MS) {
      res.json({ ticks: cached.ticks, broker: brokerManager.activeBroker, cached: true });
      return;
    }

    try {
      // Routed to the ACTIVE broker. Dhan's REST quote also carries depth, so bid/ask
      // arrive here rather than only from the socket.
      const ticks = await brokerManager.quoteProvider.quotesByToken(tokens);
      quotesCache.set(cacheKey, { at: Date.now(), ticks });
      // Warm the shared hub cache so late-joining SSE clients get instant data.
      tickerHub.seed(ticks);
      console.log(
        `[Quotes] broker=${brokerManager.activeBroker} requested=${tokens.length} ` +
          `returned=${ticks.length}`,
      );
      res.json({ ticks, broker: brokerManager.activeBroker, cached: false });
    } catch (err) {
      sendError(res, err);
    }
  }

  /* ------------------------------ REST quotes ------------------------------ */

  /**
   * The transport the frontend uses. A body has no practical size limit, so the whole
   * board fits in one request and adding stocks can never break it.
   */
  app.post("/api/quotes", async (req: Request, res: Response) => {
    const parsed = parseTokenList((req.body as { tokens?: unknown } | undefined)?.tokens, MAX_QUOTE_TOKENS);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    await serveQuotes(parsed.tokens, res);
  });

  /**
   * Legacy query-string form.
   *
   * Retained for small token lists and for any client not yet updated. It is the shape
   * that could not carry a full board, so it is no longer what the board uses.
   */
  app.get("/api/quotes", async (req: Request, res: Response) => {
    const tokens = [
      ...new Set(
        String(req.query.tokens ?? "")
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && Number.isInteger(n) && n > 0),
      ),
    ];
    if (tokens.length === 0) {
      res.status(400).json({
        error: "Provide ?tokens=token1,token2,... or POST { tokens: [...] } for large sets.",
      });
      return;
    }
    if (tokens.length > MAX_QUOTE_TOKENS) {
      res.status(400).json({ error: `Too many tokens; POST /api/quotes instead.` });
      return;
    }
    await serveQuotes(tokens, res);
  });

  /* ------------------------------- SSE stream ------------------------------ */

  /**
   * Attach a browser to the live tick stream.
   *
   * Ordering matters. Validation happens BEFORE any SSE header is written, because
   * once headers are out an error can no longer be reported as a status code — the
   * browser would see an open stream that never delivers anything.
   */
  function openTickStream(
    req: Request,
    res: Response,
    tokens: number[],
    label: string,
    onClose?: () => void,
  ): void {
    const streamHealth = brokerManager.activeHealth();
    if (!streamHealth.data_ready) {
      const brokerLabel = brokerManager.activeBroker === "dhan" ? "Dhan" : "Zerodha";
      res.status(401).json({
        error: `Live prices require a ${brokerLabel} session. Connect ${brokerLabel}.`,
        broker: brokerManager.activeBroker,
        problems: streamHealth.problems,
      });
      onClose?.();
      return;
    }

    const foreign = tokens.filter(
      (t) => !brokerManager.assertActiveBrokerToken(t, label),
    );
    if (foreign.length > 0) {
      res.status(409).json({
        error:
          `${foreign.length} requested token(s) do not belong to the active broker ` +
          `(${brokerManager.activeBroker}). Refetch the board.`,
        broker: brokerManager.activeBroker,
        generation: brokerManager.generation,
        stale_tokens: foreign.slice(0, 10),
      });
      onClose?.();
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    // Proxies that buffer would defeat SSE entirely; nginx honours this header.
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    // TWO SEPARATE CONCERNS, deliberately split.
    //
    // 1. Attach to the hub's fan-out and snapshot cache. The hub is purely downstream:
    //    it distributes ticks from WHICHEVER broker is active (Dhan ticks are injected
    //    via ingestExternalTicks), so this does not imply Zerodha.
    const detach = tickerHub.attachClient(res, tokens);
    //
    // 2. Register the browser's interest with the refcounted coordinator, the ONLY
    //    thing allowed to touch an upstream socket. `hub.addClient` used to do both,
    //    which meant opening a tab called `connectTicker` — a ZERODHA WebSocket —
    //    regardless of the active broker.
    const releaseTokens = brokerManager.acquireBrowserTokens(tokens);

    console.log(
      `[SSE] client opened ${label} tokens=${tokens.length} broker=${brokerManager.activeBroker} ` +
        `generation=${brokerManager.generation}`,
    );

    const keepAlive = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {
        // The socket is gone; `close` will have fired and cleaned up.
      }
    }, 20_000);

    // IDEMPOTENT CLEANUP. `close` can fire on both the request and the response, and a
    // second release would decrement a refcount this connection no longer owns —
    // unsubscribing a token another client still needs.
    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(keepAlive);
      // Release refcounts FIRST: a token the scanner or another tab still wants must
      // survive this disconnect.
      releaseTokens();
      detach();
      onClose?.();
      console.log(`[SSE] client closed ${label} tokens=${tokens.length}`);
      try {
        res.end();
      } catch {
        /* already destroyed */
      }
    };

    // Both, deliberately: `req` fires when the client goes away, `res` when the socket
    // is destroyed. `finish` is NOT used — an SSE response never finishes normally, so
    // wiring cleanup to it would either never run or run at the wrong time.
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
  }

  /**
   * Exchange a token list for a session id.
   *
   * PUBLIC, like the board itself. The store is bounded and TTL'd precisely because
   * unauthenticated callers can reach it.
   */
  app.post("/api/stream/session", (req: Request, res: Response) => {
    const parsed = parseTokenList((req.body as { tokens?: unknown } | undefined)?.tokens, MAX_SESSION_TOKENS);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const streamHealth = brokerManager.activeHealth();
    if (!streamHealth.data_ready) {
      const brokerLabel = brokerManager.activeBroker === "dhan" ? "Dhan" : "Zerodha";
      res.status(401).json({
        error: `Live prices require a ${brokerLabel} session. Connect ${brokerLabel}.`,
        broker: brokerManager.activeBroker,
        problems: streamHealth.problems,
      });
      return;
    }

    // Validate the namespace HERE, so a stale board is rejected at session creation
    // rather than after an SSE connection is already open and cannot report a status.
    const foreign = parsed.tokens.filter(
      (t) => !brokerManager.assertActiveBrokerToken(t, "POST /api/stream/session"),
    );
    if (foreign.length > 0) {
      res.status(409).json({
        error:
          `${foreign.length} requested token(s) do not belong to the active broker ` +
          `(${brokerManager.activeBroker}). Refetch the board.`,
        broker: brokerManager.activeBroker,
        generation: brokerManager.generation,
        stale_tokens: foreign.slice(0, 10),
      });
      return;
    }

    const session = sessions.create(
      parsed.tokens,
      brokerManager.activeBroker,
      brokerManager.generation,
    );
    console.log(
      `[SSE] session created id=${session.id.slice(0, 8)}… tokens=${session.tokens.length} ` +
        `broker=${session.broker} generation=${session.generation}`,
    );
    res.json({
      id: session.id,
      tokens: session.tokens.length,
      broker: session.broker,
      generation: session.generation,
    });
  });

  /**
   * The live stream for a session.
   *
   * The URL is a constant ~60 bytes however large the board grows, which is the whole
   * point: no proxy limit is anywhere near it.
   */
  app.get("/api/stream/session/:id", (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const resolved = sessions.resolve(id, brokerManager.activeBroker, brokerManager.generation);

    if (!resolved.ok && resolved.reason === "not_found") {
      // 404 tells the browser to mint a new session rather than retry this one. Sent
      // as JSON before any SSE header, so it is a readable status and not a dead stream.
      res.status(404).json({
        error: "Unknown or expired market-data session. Create a new one.",
        broker: brokerManager.activeBroker,
        generation: brokerManager.generation,
      });
      return;
    }
    if (!resolved.ok) {
      res.status(409).json({
        error:
          "This market-data session belongs to a previous broker selection. Refetch the board.",
        broker: brokerManager.activeBroker,
        generation: brokerManager.generation,
      });
      return;
    }

    const { session } = resolved;
    sessions.open(session.id);
    openTickStream(req, res, session.tokens, `session ${session.id.slice(0, 8)}…`, () =>
      sessions.close(session.id),
    );
  });

  /**
   * Legacy query-string stream.
   *
   * Fine for a handful of tokens (one stock's detail view). A full board must use a
   * session — that is the request line nginx refuses.
   */
  app.get("/api/stream", (req: Request, res: Response) => {
    const tokens = [
      ...new Set(
        String(req.query.tokens ?? "")
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && Number.isInteger(n) && n > 0),
      ),
    ];
    if (tokens.length === 0) {
      res.status(400).json({
        error:
          "Provide ?tokens=token1,token2,... — or POST /api/stream/session for a full board.",
      });
      return;
    }
    openTickStream(req, res, tokens, "GET /api/stream");
  });

  /* ----------------------------- observability ---------------------------- */

  /** The numbers needed to tell "nothing subscribed" from "no data arriving". */
  function marketDataSnapshot(): Record<string, unknown> {
    const feed = brokerManager.feedHealth();
    const subs = brokerManager.subscriptions.stats();
    return {
      broker: brokerManager.activeBroker,
      generation: brokerManager.generation,
      subscriptions: subs,
      sessions: sessions.stats(),
      feed: {
        state: feed.state,
        connected: feed.connected,
        subscribed: feed.subscribed,
        universe: feed.universe,
        feed_age_ms: feed.feed_age_ms,
        last_tick_at: feed.last_tick_at,
        detail: feed.detail,
      },
      upstream: brokerManager.upstreamFeedStats(),
    };
  }

  /**
   * PUBLIC market-data health.
   *
   * Public on purpose: it contains no secrets, and the banner it drives has to be
   * truthful for ordinary visitors, not just admins.
   */
  app.get("/api/market-data/status", (_req: Request, res: Response) => {
    res.json(marketDataSnapshot());
  });

  /**
   * Full diagnostics, including board size.
   *
   * Distinguishes the failure cases that all look identical on screen:
   *   subscriptions.browser === 0                  -> the browser never reached /api/stream
   *   browser > 0 but upstream.wanted === 0        -> broker routing
   *   wanted > 0 but subscribed === 0              -> the subscribe frame
   *   subscribed > 0 but last_tick_at === null     -> the feed/protocol
   *   ticks arriving but the UI shows "-"          -> frontend token mapping
   */
  app.get("/api/market-data/diagnostics", deps.requireFullAdmin, async (_req: Request, res: Response) => {
    const snapshot = marketDataSnapshot();
    const boardSize = await deps.boardSize().catch(() => null);
    const subs = snapshot.subscriptions as { browser: number; tokens: number };
    const upstream = snapshot.upstream as { wanted: number | null; subscribed: number | null };
    const feed = snapshot.feed as { last_tick_at: number | null };

    // Name the diagnosis rather than leaving it to be re-derived by eye each time.
    let diagnosis: string;
    if (subs.browser === 0) {
      diagnosis =
        "CASE A — no browser subscriptions. The browser never successfully reached the " +
        "stream endpoint (historically: a ~9 KB request URL rejected by nginx with 414).";
    } else if ((upstream.wanted ?? 0) === 0) {
      diagnosis = "CASE B — browser leases exist but nothing reached the broker: routing bug.";
    } else if ((upstream.subscribed ?? 0) === 0) {
      diagnosis = "CASE C — tokens wanted but none confirmed upstream: subscribe-send bug.";
    } else if (feed.last_tick_at === null) {
      diagnosis = "CASE D — subscribed upstream but no tick ever arrived: feed/protocol issue.";
    } else {
      diagnosis = "HEALTHY — ticks are arriving. A blank cell now implies frontend token mapping.";
    }

    res.json({ ...snapshot, board_size: boardSize, diagnosis });
  });
}
