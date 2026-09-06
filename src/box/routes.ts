/**
 * Box HTTP + SSE surface, mounted under /api/box.
 *
 * Uses the application's existing access pattern: the injected `requireAdmin`
 * middleware (full admin OR trade access, via the x-admin-token header), and the
 * same query-parameter token trick for the SSE endpoint, since EventSource
 * cannot send headers.
 *
 * Every route lives here rather than in index.ts, so the box module adds nothing
 * to that file beyond a single registration call.
 */

import type { Express, Request, RequestHandler, Response } from "express";
import { KiteError } from "../kite.js";
import { rateLimit } from "../ratelimit.js";
import type { BoxEngine } from "./engine.js";
import {
  isBoxDbEnabled,
  loadBoxEvents,
  loadBoxTrades,
  loadClosedBoxTrades,
  serializeBoxTrade,
} from "./repository.js";

export interface BoxRouteDeps {
  engine: BoxEngine;
  requireAdmin: RequestHandler;
  /** Resolves an admin role from a token — used for the SSE query-param auth. */
  getAdminRole: (token: string | undefined) => "full" | "trade" | null;
}

function fail(res: Response, err: unknown): void {
  if (err instanceof KiteError) {
    res.status(err.status || 502).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : "Unexpected server error.";
  console.error("[Box] request failed:", err);
  res.status(500).json({ error: message });
}

/**
 * A tight bucket for the destructive delete endpoint.
 *
 * Deliberately far below the global /api limit: deleting trades is a deliberate,
 * one-at-a-time operator action, so 20 a minute is generous for a human and still
 * stops a stuck client from walking the whole book.
 */
const deleteRateLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  message: "Too many delete requests. Slow down.",
});

export function registerBoxRoutes(app: Express, deps: BoxRouteDeps): void {
  const { engine, requireAdmin } = deps;
  const requireFull = (req: Request, res: Response): boolean => {
    const token = req.header("x-admin-token") ?? undefined;
    if (deps.getAdminRole(token) !== "full") {
      res.status(403).json({ error: "Full administrator access required." });
      return false;
    }
    return true;
  };

  /* ------------------------------- control ------------------------------- */

  app.get("/api/box/status", requireAdmin, (_req: Request, res: Response) => {
    res.json(engine.getStatus());
  });

  app.get("/api/box/config", requireAdmin, (_req: Request, res: Response) => {
    res.json(engine.getConfig());
  });

  /**
   * READ-ONLY execution diagnostics (Phase 32): calibration status per broker, measured latency
   * percentiles, event-loop health, what paper is actually running on, outcome/reject rates, the
   * advisory queue-haircut recommendation, and recent latency outliers.
   *
   * A GET with no side effects, behind the same admin auth as every other box route. It exposes
   * only latency numbers, counts, statuses and explicitly-configured labels — never a token, key
   * or session identifier.
   */
  app.get("/api/box/execution-diagnostics", requireAdmin, (_req: Request, res: Response) => {
    try {
      res.json(engine.getExecutionDiagnostics());
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * ADMIN control: how many strikes each side of ATM are monitored/traded (1, 2
   * or 3). Guarded by the same admin auth as every other box route.
   *
   * From the moment it is set, only boxes within ATM ±level are discovered and
   * entered. Positions ALREADY OPEN are never affected — they keep being
   * monitored and exit on their own rules regardless of the new width.
   */
  app.post("/api/box/strike-level", requireAdmin, async (req: Request, res: Response) => {
    try {
      const raw = (req.body ?? {}) as { level?: unknown };
      const level = Number(raw.level);
      if (!Number.isFinite(level) || ![1, 2, 3].includes(Math.round(level))) {
        res.status(400).json({ error: "level must be 1, 2 or 3." });
        return;
      }
      const result = await engine.setStrikeLevel(level);
      res.json({ ok: true, strike_level: result.level, status: engine.getStatus() });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * ADMIN control: the live entry gate (₹ expected net) and safety buffer (₹).
   *
   * Persisted to `box_settings`, so it survives a restart and is shared by every
   * browser. Takes effect on the next evaluation and applies to NEW boxes only —
   * positions already open are never re-judged against a changed threshold.
   *
   * Body: { min_expected_net_profit?: number, safety_buffer?: number }
   */
  app.post("/api/box/settings", requireAdmin, async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Attribute the change in the append-only ledger. This threshold governs
      // automatic entries, so "it moved" is not enough — the role that moved it
      // belongs in the audit trail alongside the values.
      const token = req.header("x-admin-token") ?? undefined;
      const actor = deps.getAdminRole(token) ?? "admin";
      const result = await engine.setTuning(
        {
          minExpectedNetProfit: body.min_expected_net_profit ?? body.minExpectedNetProfit,
          safetyBuffer: body.safety_buffer ?? body.safetyBuffer,
        },
        actor,
      );
      if (!result.ok) {
        res.status(result.code).json({ error: result.error });
        return;
      }
      res.json({ ok: true, config: engine.getConfig(), status: engine.getStatus() });
    } catch (err) {
      fail(res, err);
    }
  });

  /** RUN — begin discovering and auto-opening paper boxes. */
  app.post("/api/box/start", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const result = await engine.start();
      if (!result.ok) {
        res.status(400).json({ error: result.error, status: engine.getStatus() });
        return;
      }
      res.json({ ok: true, status: engine.getStatus() });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * STOP — stop discovering NEW boxes.
   *
   * Open positions keep being monitored and can still auto-exit; that is the
   * documented meaning of STOP and it is enforced by the engine, not here.
   */
  app.post("/api/box/stop", requireAdmin, (_req: Request, res: Response) => {
    engine.stop();
    res.json({ ok: true, status: engine.getStatus() });
  });

  for (const control of [
    "box_entry_enabled",
    "box_live_order_enabled",
    "box_emergency_flatten",
  ] as const) {
    app.post(`/api/box/controls/${control}`, requireAdmin, (req: Request, res: Response) => {
      if (!requireFull(req, res)) return;
      const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
      if (typeof enabled !== "boolean") {
        res.status(400).json({ error: "enabled must be a boolean." });
        return;
      }
      const result = engine.setLiveControl(control, enabled);
      if (!result.ok) {
        res.status(409).json({ error: result.error, status: engine.getStatus() });
        return;
      }
      res.json({ ok: true, status: engine.getStatus() });
    });
  }

  app.post("/api/box/live/reconcile", requireAdmin, async (req: Request, res: Response) => {
    if (!requireFull(req, res)) return;
    try {
      res.json({ ok: true, reconciliation: await engine.reconcileLive(), status: engine.getStatus() });
    } catch (err) { fail(res, err); }
  });

  app.post("/api/box/live/cancel-working", requireAdmin, async (req: Request, res: Response) => {
    if (!requireFull(req, res)) return;
    try {
      res.json({ ok: true, orders: await engine.cancelWorkingBoxOrders(), status: engine.getStatus() });
    } catch (err) { fail(res, err); }
  });

  app.post("/api/box/live/flatten", requireAdmin, async (req: Request, res: Response) => {
    if (!requireFull(req, res)) return;
    try {
      res.json({ ok: true, ...(await engine.flattenAttributedBoxExposure()), status: engine.getStatus() });
    } catch (err) { fail(res, err); }
  });

  /* ----------------------------- opportunities ---------------------------- */

  app.get("/api/box/opportunities", requireAdmin, (req: Request, res: Response) => {
    const raw = Number(req.query.limit ?? 0);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(300, Math.round(raw)) : undefined;
    res.json({
      opportunities: engine.getOpportunities(limit),
      status: engine.getStatus(),
    });
  });

  /** The ATM±3 chains being monitored (list form). */
  app.get("/api/box/chains", requireAdmin, (req: Request, res: Response) => {
    const underlying = String(req.query.underlying ?? "").trim();
    if (!underlying) {
      res.json({ chains: engine.listChainSymbols() });
      return;
    }
    const chain = engine.getChain(underlying);
    if (!chain) {
      res.status(404).json({
        error: `No monitored box window for "${underlying.toUpperCase()}". Start the scanner, or pick an underlying from GET /api/box/chains.`,
      });
      return;
    }
    res.json(chain);
  });

  /* -------------------------------- trades ------------------------------- */

  app.get("/api/box/trades", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const trades = await loadBoxTrades();
      res.json({
        dbEnabled: isBoxDbEnabled(),
        open: engine.getOpenPositions(),
        trades: trades.map(serializeBoxTrade),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  /** Live open positions with their current exit arithmetic (in-memory, fast). */
  app.get("/api/box/trades/open", requireAdmin, (_req: Request, res: Response) => {
    res.json({ dbEnabled: isBoxDbEnabled(), open: engine.getOpenPositions() });
  });

  /**
   * Closed box trades.
   *
   * `?scope=today` is the FAST path: today's trades come from memory (or Redis
   * after a restart), never from a full-book Mongo sort, so the Closed-trades tab
   * can render the session the operator actually cares about immediately. The
   * default `scope=all` is the whole closed book from Mongo and is the slower call
   * the UI makes second, in the background.
   */
  app.get("/api/box/trades/history", requireAdmin, async (req: Request, res: Response) => {
    try {
      const scope = String(req.query.scope ?? "all").trim().toLowerCase();
      if (scope === "today") {
        const { trades, source, day } = await engine.getClosedToday();
        res.json({
          dbEnabled: isBoxDbEnabled(),
          scope: "today",
          /** Which tier answered: memory | redis | mongo | none. */
          source,
          day,
          cacheEnabled: engine.isClosedCacheEnabled(),
          /**
           * These rows have their execution-audit blobs stripped (see
           * liteClosedTrade). Stated explicitly so a client can tell "stripped"
           * from "this trade genuinely has no execution record", and so the UI
           * knows not to let one overwrite a fuller row it already holds.
           */
          lite: true,
          trades,
        });
        return;
      }
      const raw = Number(req.query.limit ?? 0);
      const limit = Number.isFinite(raw) && raw > 0 ? Math.min(1000, Math.round(raw)) : 300;
      const trades = await loadClosedBoxTrades(limit);
      res.json({
        dbEnabled: isBoxDbEnabled(),
        scope: "all",
        source: "mongo",
        cacheEnabled: engine.isClosedCacheEnabled(),
        /**
         * The audit blobs are projected out of list queries — they are most of a
         * document's bytes and no list renders them. Carrying them made this
         * response large enough to hit a gateway timeout.
         */
        lite: true,
        trades: trades.map(serializeBoxTrade),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  /** paper_legging execution attempts that aborted (partial fill + unwind). */
  app.get("/api/box/execution-attempts", requireAdmin, async (req: Request, res: Response) => {
    try {
      const raw = Number(req.query.limit ?? 0);
      const limit = Number.isFinite(raw) && raw > 0 ? Math.min(500, Math.round(raw)) : 100;
      res.json({ dbEnabled: isBoxDbEnabled(), attempts: await engine.listExecutionAttempts(limit) });
    } catch (err) {
      fail(res, err);
    }
  });

  /** The append-only decision ledger. */
  app.get("/api/box/events", requireAdmin, async (req: Request, res: Response) => {
    try {
      const raw = Number(req.query.limit ?? 0);
      const limit = Number.isFinite(raw) && raw > 0 ? Math.min(1000, Math.round(raw)) : 200;
      res.json({ events: await loadBoxEvents(limit) });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * Manual close at the current executable touch.
   *
   * POST (not DELETE) so it rides the app's existing CORS allow-list. Refuses
   * with 409 when the four-leg one-lot market is unavailable — it will not invent
   * a price to satisfy the request.
   */
  app.post("/api/box/trades/:id/close", requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id ?? "");
      const result = await engine.closeManually(id);
      if (!result.ok) {
        res.status(result.code).json({ error: result.error, metrics: result.metrics ?? null });
        return;
      }
      res.json({ ok: true, open: engine.getOpenPositions() });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * PERMANENTLY delete a PAPER Box trade (open, closed or errored).
   *
   * FULL ADMIN ONLY. This is destructive and irreversible, so trade-access users
   * cannot reach it even though they can see every trade — viewing history and
   * rewriting it are different privileges.
   *
   * Rate limited separately from the global /api bucket: a destructive endpoint
   * should not be reachable at the same 150-per-minute rate as a price read, and a
   * runaway client (or a stuck retry loop in the UI) must not be able to walk the
   * whole book.
   *
   * The engine owns every safety decision and returns the status code to use, so
   * this handler stays a thin translation layer. LIVE trades are refused with 409.
   */
  app.delete(
    "/api/box/trades/:id",
    deleteRateLimit,
    requireAdmin,
    async (req: Request, res: Response) => {
      if (!requireFull(req, res)) return;
      try {
        const id = String(req.params.id ?? "");
        const body = (req.body ?? {}) as { reason?: unknown };
        const reason = typeof body.reason === "string" && body.reason.trim() !== ""
          ? body.reason.trim().slice(0, 500)
          : null;
        const token = req.header("x-admin-token") ?? undefined;
        const actor = deps.getAdminRole(token) ?? "admin";

        const result = await engine.deleteTrade(id, { actor, reason });
        if (!result.ok) {
          res.status(result.code).json({ error: result.error });
          return;
        }
        // Return the corrected state alongside the acknowledgement so the UI can
        // apply it immediately — no reload, and no second round trip to discover
        // the new counts, P&L and margin.
        const { trades, source, day } = await engine.getClosedToday();
        res.json({
          ok: true,
          deleted_id: id,
          status: engine.getStatus(),
          open: engine.getOpenPositions(),
          closed_today: { trades, source, day, lite: true },
        });
      } catch (err) {
        fail(res, err);
      }
    },
  );

  /* --------------------------------- SSE --------------------------------- */

  /**
   * Live box state: scanner state, opportunity changes, entries, open-position
   * updates and exits.
   *
   * EventSource cannot set headers, so the admin token arrives as a query
   * parameter here — exactly as GET /api/stream and /api/login already do.
   */
  app.get("/api/box/stream", (req: Request, res: Response) => {
    const token =
      (req.headers["x-admin-token"] as string | undefined) ??
      (typeof req.query["x-admin-token"] === "string"
        ? (req.query["x-admin-token"] as string)
        : undefined);
    if (deps.getAdminRole(token) === null) {
      res.status(403).json({ error: "Admin authentication required" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const remove = engine.addSseClient(res);
    const keepAlive = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {
        /* the close handler cleans up */
      }
    }, 20000);
    keepAlive.unref?.();

    req.on("close", () => {
      clearInterval(keepAlive);
      remove();
      res.end();
    });
  });
}
