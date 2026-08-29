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

export function registerBoxRoutes(app: Express, deps: BoxRouteDeps): void {
  const { engine, requireAdmin } = deps;

  /* ------------------------------- control ------------------------------- */

  app.get("/api/box/status", requireAdmin, (_req: Request, res: Response) => {
    res.json(engine.getStatus());
  });

  app.get("/api/box/config", requireAdmin, (_req: Request, res: Response) => {
    res.json(engine.getConfig());
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

  app.get("/api/box/trades/history", requireAdmin, async (req: Request, res: Response) => {
    try {
      const raw = Number(req.query.limit ?? 0);
      const limit = Number.isFinite(raw) && raw > 0 ? Math.min(1000, Math.round(raw)) : 300;
      const trades = await loadClosedBoxTrades(limit);
      res.json({ dbEnabled: isBoxDbEnabled(), trades: trades.map(serializeBoxTrade) });
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
