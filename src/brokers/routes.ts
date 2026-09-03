/**
 * Broker management HTTP surface: /api/broker/* and /api/dhan/*.
 *
 * SECURITY POSTURE
 * Every mutating route is FULL-ADMIN only. `DHAN_API_SECRET` and the Dhan access
 * token never appear in a response — the only session data published is
 * `redactedSession()`, which is account identifiers and timestamps. The consent and
 * session-consumption routes are rate limited separately from the global /api
 * bucket because each one spends the app credentials.
 */

import type { Express, Request, RequestHandler, Response } from "express";
import { rateLimit } from "../ratelimit.js";
import { DhanError } from "./dhan/errors.js";
import { isDhanTokenExpired, redactedSession } from "./dhan/auth.js";
import { loadDhanSession } from "../db.js";
import { parseBrokerId, type BrokerId } from "./types.js";
import type { ActiveBrokerManager } from "./registry.js";

export interface BrokerRouteDeps {
  manager: ActiveBrokerManager;
  requireAdmin: RequestHandler;
  requireFullAdmin: RequestHandler;
  getAdminRole: (token: string | undefined) => "full" | "trade" | null;
  /** Called after a successful broker switch so the Box SSE snapshot goes out. */
  onBrokerChanged?: (broker: BrokerId) => void;
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
}
