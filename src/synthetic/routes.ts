/**
 * HTTP + SSE surface of the synthetic-futures scanner, mounted under /api/synthetic.
 *
 * Same access pattern as Box: every route needs an admin token (full OR trade
 * access) in `x-admin-token`, and the SSE endpoint accepts it as a query
 * parameter because EventSource cannot set headers. Nothing here can send a real
 * order: positions are paper fills at the observed touch.
 */

import type { Express, Request, RequestHandler, Response } from "express";
import { rateLimit } from "../ratelimit.js";
import { toTradeView, type SyntheticEngine } from "./engine.js";

export interface SyntheticRouteDeps {
  engine: SyntheticEngine;
  requireAdmin: RequestHandler;
  getAdminRole: (token: string | undefined) => "full" | "trade" | null;
}

function fail(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : "Unexpected server error.";
  console.error("[Synthetic] request failed:", err);
  res.status(500).json({ error: message });
}

/**
 * A tight bucket for the destructive delete, far below the global /api limit, as for
 * Box: deleting trades is a one-at-a-time operator action.
 */
const deleteRateLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  message: "Too many delete requests. Slow down.",
});

export function registerSyntheticRoutes(app: Express, deps: SyntheticRouteDeps): void {
  const { engine, requireAdmin } = deps;
  const requireFull = (req: Request, res: Response): boolean => {
    const token = req.header("x-admin-token") ?? undefined;
    if (deps.getAdminRole(token) !== "full") {
      res.status(403).json({ error: "Full administrator access required." });
      return false;
    }
    return true;
  };

  app.get("/api/synthetic/status", requireAdmin, (_req: Request, res: Response) => {
    res.json(engine.getStatus());
  });

  app.post("/api/synthetic/start", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const r = await engine.start();
      if (!r.ok) {
        res.status(400).json({ error: r.error, status: engine.getStatus() });
        return;
      }
      res.json({ ok: true, status: engine.getStatus() });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/synthetic/stop", requireAdmin, (_req: Request, res: Response) => {
    engine.stop();
    res.json({ ok: true, status: engine.getStatus() });
  });

  /** Body: { level: 1 | 2 | 3 }: the synthetic uses ATM ± level strikes only. */
  app.post("/api/synthetic/strike-level", requireAdmin, (req: Request, res: Response) => {
    const r = engine.setStrikeLevel(req.body?.level);
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    res.json({ ok: true, strike_level: engine.getStatus().strike_level, status: engine.getStatus() });
  });

  /** Body: { min_expected_net_profit?, safety_buffer? }. In memory; resets on restart. */
  app.post("/api/synthetic/settings", requireAdmin, (req: Request, res: Response) => {
    const r = engine.updateSettings(req.body ?? {});
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    res.json({ ok: true, status: engine.getStatus() });
  });

  app.get("/api/synthetic/opportunities", requireAdmin, (req: Request, res: Response) => {
    const limit = Number(req.query.limit);
    res.json({
      opportunities: engine.getOpportunities(Number.isFinite(limit) ? limit : undefined),
      status: engine.getStatus(),
    });
  });

  /* ----------------------------- paper trades ----------------------------- */

  /** Open paper positions with their live marks (in memory, so this is cheap). */
  app.get("/api/synthetic/trades/open", requireAdmin, (_req: Request, res: Response) => {
    res.json({ db_enabled: engine.getStatus().db_enabled, open: engine.getOpenPositions() });
  });

  /** Closed paper trades, newest first. `scope=today` is served from memory. */
  app.get("/api/synthetic/trades/history", requireAdmin, async (req: Request, res: Response) => {
    const scope = req.query.scope === "today" ? "today" : "all";
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 2000) : 500;
    try {
      res.json(await engine.getHistory(scope, limit));
    } catch (err) {
      fail(res, err);
    }
  });

  /** Close one open paper position now, at the executable touch. */
  app.post("/api/synthetic/trades/:id/close", requireAdmin, async (req: Request, res: Response) => {
    try {
      const r = await engine.closeManually(String(req.params.id ?? ""));
      if (!r.ok) {
        res.status(r.status).json({ error: r.error });
        return;
      }
      res.json({
        ok: true,
        trade: toTradeView(r.trade),
        open: engine.getOpenPositions(),
        status: engine.getStatus(),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * Delete a PAPER trade (open or closed). Full admin only, like Box.
   * Body: { reason?, expected_status?: "open" | "closed" }. A soft delete, kept as an
   * audit record; retrying one is safe. Returns the corrected state so the page
   * updates without a reload.
   */
  app.delete(
    "/api/synthetic/trades/:id",
    deleteRateLimit,
    requireAdmin,
    async (req: Request, res: Response) => {
      if (!requireFull(req, res)) return;
      try {
        const id = String(req.params.id ?? "");
        const body = (req.body ?? {}) as { reason?: unknown; expected_status?: unknown };
        const reason =
          typeof body.reason === "string" && body.reason.trim() !== ""
            ? body.reason.trim().slice(0, 500)
            : null;
        // The status the operator saw when confirming. A trade that changed state in
        // the meantime is refused, not deleted.
        const expected =
          body.expected_status === "open" || body.expected_status === "closed"
            ? body.expected_status
            : undefined;
        const actor = deps.getAdminRole(req.header("x-admin-token") ?? undefined) ?? "admin";
        const r = await engine.deleteTrade(id, {
          reason,
          actor,
          ...(expected === undefined ? {} : { expected }),
        });
        if (!r.ok) {
          res.status(r.status).json({ error: r.error });
          return;
        }
        const today = await engine.getHistory("today", 2000);
        res.json({
          ok: true,
          deleted_id: id,
          deleted_from: r.from,
          already_deleted: r.already,
          status: engine.getStatus(),
          open: engine.getOpenPositions(),
          closed_today: today.trades,
        });
      } catch (err) {
        fail(res, err);
      }
    },
  );

  app.get("/api/synthetic/chain/:underlying", requireAdmin, (req: Request, res: Response) => {
    const u = String(req.params.underlying ?? "").toUpperCase();
    const chain = engine.getChain(u);
    if (!chain) {
      res.status(404).json({ error: `${u} is not being monitored.` });
      return;
    }
    res.json(chain);
  });

  app.get("/api/synthetic/stream", (req: Request, res: Response) => {
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
