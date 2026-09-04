/**
 * Broker management HTTP surface: /api/broker/* and /api/dhan/*.
 *
 * SECURITY POSTURE
 * Every mutating route is FULL-ADMIN only. `DHAN_API_SECRET` never appears in any
 * response. Status and session routes publish only `redactedSession()` — account
 * identifiers and timestamps.
 *
 * The Dhan ACCESS TOKEN is returned by exactly two routes, both deliberate and both
 * named for it, so the exposure is auditable by grepping for them:
 *
 *   GET /api/dhan/access-token  full admin (a 24h admin session token)
 *   GET /api/dhan/token         a dedicated passcode, DHAN_TOKEN_ROUTE_SECRET
 *
 * The second exists because an admin session token expires daily and cannot be baked
 * into an unattended script, while sharing ADMIN_SECRET with another host would grant
 * it trade placement, deletion and broker switching. A separate passcode grants only
 * the token read. It mirrors /api/kite/token, but with its OWN secret so the two
 * brokers stay independently revocable.
 *
 * The consent and session-consumption routes are rate limited separately from the
 * global /api bucket because each one spends the app credentials.
 */

import type { Express, Request, RequestHandler, Response } from "express";
import { rateLimit } from "../ratelimit.js";
import { DhanError } from "./dhan/errors.js";
import { isDhanTokenExpired, redactedSession } from "./dhan/auth.js";
import { getDhanParseReport } from "./dhan/instruments.js";
import { checkKnownSymbols, diagnoseBoard } from "./boardDiagnostics.js";
import { loadDhanSession } from "../db.js";
import { checkTokenPasscode, readPasscode } from "../tokenRouteAuth.js";
import { parseBrokerId, type BrokerId } from "./types.js";
import type { ActiveBrokerManager } from "./registry.js";

export interface BrokerRouteDeps {
  manager: ActiveBrokerManager;
  requireAdmin: RequestHandler;
  requireFullAdmin: RequestHandler;
  getAdminRole: (token: string | undefined) => "full" | "trade" | null;
  /** Called after a successful broker switch so the Box SSE snapshot goes out. */
  onBrokerChanged?: (broker: BrokerId) => void;
  /** The app's underlying→index-spot-symbol map, for board diagnostics. */
  indexSpotMap?: Record<string, string>;
}

/** The auth flow spends the app credentials, so it gets its own tight bucket. */
const authRateLimit = rateLimit({
  windowMs: 5 * 60_000,
  max: 20,
  message: "Too many Dhan authentication attempts. Please wait a few minutes.",
});

/** Broker switching tears down a feed; it should not be spammable. */
const switchRateLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  message: "Too many broker switch attempts. Slow down.",
});

/**
 * The passcode token route is guessable-by-brute-force in principle, so it gets the
 * same tight bucket as its Zerodha counterpart.
 */
const tokenRouteRateLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  message: "Too many token requests. Slow down.",
});

function fail(res: Response, err: unknown): void {
  if (err instanceof DhanError) {
    // Dhan's own message is the useful one; status 0 means no response at all.
    res.status(err.status && err.status >= 400 ? err.status : 502).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : "Unexpected server error.";
  console.error("[Broker] request failed:", err);
  res.status(500).json({ error: message });
}

export function registerBrokerRoutes(app: Express, deps: BrokerRouteDeps): void {
  const { manager, requireAdmin, requireFullAdmin } = deps;

  /* ------------------------------- broker -------------------------------- */

  /**
   * The active broker plus its session and capability readiness.
   *
   * Readable by ANY admin role: trade-access users inherit the active broker and need
   * to see which one they are looking at — they simply cannot change it.
   */
  app.get("/api/broker/status", requireAdmin, (_req: Request, res: Response) => {
    res.json(manager.snapshot());
  });

  /** Why a switch would be refused, without attempting it. Lets the UI pre-warn. */
  app.get("/api/broker/switch-blockers", requireAdmin, async (req: Request, res: Response) => {
    try {
      const target = parseBrokerId(req.query.broker) ?? manager.activeBroker;
      res.json({ broker: target, blockers: await manager.switchBlockers(target) });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * Switch the active broker.
   *
   * Refuses with 409 and the FULL list of blockers when exposure exists — an operator
   * clearing three problems should see three, not discover them one at a time.
   */
  app.post(
    "/api/broker/select",
    switchRateLimit,
    requireFullAdmin,
    async (req: Request, res: Response) => {
      try {
        const broker = parseBrokerId((req.body as { broker?: unknown } | undefined)?.broker);
        if (!broker) {
          res.status(400).json({ error: 'broker must be "zerodha" or "dhan".' });
          return;
        }
        const token = req.header("x-admin-token") ?? undefined;
        const actor = deps.getAdminRole(token) ?? "admin";
        const result = await manager.switchBroker(broker, actor);
        if (!result.ok) {
          res.status(409).json({
            error: "Cannot change broker while Box exposure or in-flight work exists.",
            blockers: result.blockers,
            broker: manager.activeBroker,
          });
          return;
        }
        deps.onBrokerChanged?.(result.broker);
        res.json({ ok: true, ...manager.snapshot() });
      } catch (err) {
        fail(res, err);
      }
    },
  );

  /* -------------------------------- Dhan --------------------------------- */

  /**
   * STEP 1 — begin the Dhan browser login.
   *
   * Returns the login URL for the frontend to navigate to. The consent call happens
   * server-side because it requires `app_secret`, which must never reach a browser.
   */
  app.post("/api/dhan/login", authRateLimit, requireFullAdmin, async (_req: Request, res: Response) => {
    try {
      const { consentAppId, loginUrl } = await manager.beginDhanLogin();
      res.json({ ok: true, consent_app_id: consentAppId, login_url: loginUrl });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * STEP 3 — consume the redirect's `tokenId`.
   *
   * The tokenId is SINGLE-USE, so the frontend must guard against React StrictMode's
   * double effect invocation (it does, mirroring the Zerodha flow). A second call
   * legitimately fails, and that failure is surfaced rather than masked.
   */
  app.post("/api/dhan/session", authRateLimit, requireFullAdmin, async (req: Request, res: Response) => {
    try {
      const tokenId = String((req.body as { tokenId?: unknown } | undefined)?.tokenId ?? "").trim();
      if (!tokenId) {
        res.status(400).json({ error: "Missing tokenId." });
        return;
      }
      const session = await manager.completeDhanLogin(tokenId);
      // Selecting Dhan is a SEPARATE, guarded step: connecting a session must not
      // silently switch the active broker while Zerodha exposure is open.
      res.json({
        ok: true,
        authenticated: session.authenticated,
        broker: manager.activeBroker,
        client_id: session.client_id,
        client_name: session.client_name,
        token_expires_at: session.token_expires_at,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  /** Dhan session + readiness. Never includes the token or the app secret. */
  app.get("/api/dhan/status", requireAdmin, async (_req: Request, res: Response) => {
    try {
      // Resolve a pending static-IP verification before reporting. The check is cached
      // and nothing else in the ordinary connect flow triggers it, so reading the
      // status is what turns "not yet verified" into a real verdict — which makes the
      // broker panel's Refresh button do the obvious thing.
      await manager.ensureDhanStaticIpVerified();
      const health = manager.healthFor("dhan");
      const stored = await loadDhanSession().catch(() => null);
      res.json({
        broker: "dhan",
        active: manager.activeBroker === "dhan",
        configured: manager.dhanCredentials().ok,
        authenticated: health.authenticated,
        token_expired: health.token_expired,
        token_expires_at: health.token_expires_at,
        data_ready: health.data_ready,
        trading_ready: health.trading_ready,
        static_ip_configured: health.static_ip_configured,
        /** The full static-IP picture: declared vs API-verified against Dhan. */
        static_ip: manager.dhanStaticIpState(),
        feed_connected: health.feed_connected,
        feed_age_ms: health.feed_age_ms,
        problems: health.problems,
        instruments: manager.dhanInstrumentStore.size,
        session: stored ? redactedSession(stored) : null,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * Re-verify the configured server IP against Dhan's whitelist.
   *
   * Exists so an operator who has just whitelisted an address can confirm it without
   * restarting the process — otherwise the cached verdict would keep blocking trading
   * until the next switch or boot.
   */
  app.post("/api/dhan/verify-ip", requireFullAdmin, async (_req: Request, res: Response) => {
    try {
      const result = await manager.verifyDhanStaticIp();
      res.json({ ok: result.verified, ...result, static_ip: manager.dhanStaticIpState() });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * What the Dhan instrument-master parse actually saw.
   *
   * Exists because Dhan's CSV column names are not something to keep guessing at. When
   * the board looks wrong (empty, or full of exchange TEST scrips) this reports which
   * columns were FOUND, which were missing, how many rows were skipped and why, and
   * sample parsed futures — turning a mystery into a five-second diagnosis.
   *
   * Full admin: it echoes the master's header layout.
   */
  app.get("/api/dhan/instruments/diagnostics", requireFullAdmin, async (_req: Request, res: Response) => {
    try {
      // Force a parse so the report reflects the CURRENT master, not a cached one.
      await manager.dhanInstrumentStore.load(true).catch(() => undefined);
      const report = getDhanParseReport();
      if (!report) {
        res.status(503).json({
          error: "The Dhan instrument master has not been parsed yet.",
          hint: "Connect Dhan, then retry.",
        });
        return;
      }
      // Reproduce the board join so the report explains WHY a large universe becomes a
      // small board — the stage that was previously invisible.
      const universe = manager.dhanInstrumentStore.instruments;
      const board = diagnoseBoard(universe, deps.indexSpotMap ?? {});
      const known = checkKnownSymbols(universe);

      res.json({
        broker: "dhan",
        active_broker: manager.activeBroker,
        generation: manager.generation,
        healthy:
          report.fnoFutures >= 100 &&
          report.distinctFutureUnderlyings >= 50 &&
          board.boardSize >= 50 &&
          report.missingColumns.length === 0,
        instrument_universe_size: universe.length,
        parser_report: {
          ...report,
          // The header is the single most useful field when a column name has moved.
          header_line: report.header.join(","),
          // Cap the raw header echo; the rest of the report is already summarised.
          header: report.header.slice(0, 40),
        },
        board,
        known_symbols: known,
        subscriptions: manager.subscriptions.stats(),
        feed: manager.feedHealth(),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/dhan/logout", requireFullAdmin, async (_req: Request, res: Response) => {
    try {
      await manager.logoutDhan();
      res.json({ ok: true, ...manager.snapshot() });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * Dhan's configured postback endpoint.
   *
   * Treated strictly as a HINT that accelerates state updates — never as the source
   * of truth. REST reconciliation remains authoritative, because a postback can be
   * lost, duplicated, delivered out of order, or (as here) arrive unauthenticated.
   * So this route deliberately does NOT mutate order state: it validates the shape,
   * logs it, and lets the existing durable reconciliation converge. Trusting an
   * unauthenticated webhook to move a live order's state would be a second state
   * machine and a security hole at once.
   */
  app.post("/api/dhan/postback", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const orderId = typeof body.orderId === "string" ? body.orderId : null;
    const status = typeof body.orderStatus === "string" ? body.orderStatus : null;
    if (!orderId) {
      // Always 200: a webhook endpoint that 4xxs invites the sender to retry
      // forever. The payload is simply ignored.
      res.status(200).json({ ok: true, ignored: "no orderId" });
      return;
    }
    const correlation = typeof body.correlationId === "string" ? body.correlationId : null;
    console.log(
      `[Dhan postback] order ${orderId} status ${status ?? "unknown"}` +
        (correlation ? ` correlation ${correlation}` : "") +
        " — recorded as a hint; REST reconciliation remains authoritative.",
    );
    res.status(200).json({ ok: true });
  });

  /**
   * The raw access token, full-admin only.
   *
   * Exists to match the existing `/api/kite/access-token` route so an operator can
   * drive Dhan's own tooling. Not reachable by trade-access users, and never returned
   * by any status endpoint.
   */
  app.get("/api/dhan/access-token", requireFullAdmin, async (_req: Request, res: Response) => {
    try {
      const stored = await loadDhanSession().catch(() => null);
      if (!stored || isDhanTokenExpired(stored.expiry_time)) {
        res.status(409).json({ error: "No live Dhan session. Connect Dhan first." });
        return;
      }
      res.json({
        authenticated: true,
        client_id: stored.dhan_client_id,
        access_token: stored.access_token,
        expires_at: stored.expiry_time,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * The same token, for an unattended script on another host.
   *
   *   curl "https://<host>/api/dhan/token?passcode=YOUR_PASSCODE"
   *   curl -H "x-token-passcode: YOUR_PASSCODE" https://<host>/api/dhan/token
   *
   * Mirrors /api/kite/token, with its OWN secret (DHAN_TOKEN_ROUTE_SECRET) so revoking
   * one broker's passcode does not touch the other. The env var is read per request
   * rather than at import time, so rotating it takes a restart of nothing but the
   * process that owns it — and so tests can set it.
   *
   * NOT full admin on purpose: the point is to grant a token READ without granting
   * trade placement, deletion or broker switching.
   */
  app.get("/api/dhan/token", tokenRouteRateLimit, async (req: Request, res: Response) => {
    const passcode = readPasscode(req.headers["x-token-passcode"], req.query.passcode);
    const check = checkTokenPasscode(process.env.DHAN_TOKEN_ROUTE_SECRET, passcode);
    if (check === "not_configured") {
      // Fails CLOSED: an unset secret disables the route rather than opening it.
      res.status(503).json({
        error:
          "Dhan token route is not configured. Set DHAN_TOKEN_ROUTE_SECRET on the server.",
      });
      return;
    }
    if (check === "forbidden") {
      res.status(403).json({ error: "Invalid or missing passcode." });
      return;
    }
    try {
      const stored = await loadDhanSession().catch(() => null);
      // An expired token is worse than none: a caller would use it and get opaque 401s
      // from Dhan rather than being told to reconnect.
      if (!stored || isDhanTokenExpired(stored.expiry_time)) {
        res.status(409).json({
          authenticated: false,
          error: "No live Dhan session. The admin must connect Dhan first.",
        });
        return;
      }
      res.json({
        authenticated: true,
        client_id: stored.dhan_client_id,
        access_token: stored.access_token,
        expires_at: stored.expiry_time,
        login_date: stored.login_date,
      });
    } catch (err) {
      fail(res, err);
    }
  });
}
