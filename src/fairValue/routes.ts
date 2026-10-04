import { Router } from "express";
import type { Express, Request, RequestHandler, Response } from "express";
import { rateLimit } from "../ratelimit.js";
import type { FairValueEngine } from "./engine.js";

export interface FairValueRouteDeps {
  engine: FairValueEngine;
  requireFullAdmin: RequestHandler;
  getAdminRole: (token: string | undefined) => "full" | "trade" | null;
  streamIntervalMs?: number;
}

export function registerFairValueRoutes(app: Express, deps: FairValueRouteDeps): void {
  const router = Router();
  const { engine } = deps;
  // Router-wide guard includes status, settings, calculator, historical rows and
  // exports. EventSource may carry a token in its query, checked independently.
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (req.path === "/stream" && req.method === "GET") {
      const token = req.header("x-admin-token") ?? (typeof req.query["x-admin-token"] === "string" ? req.query["x-admin-token"] : undefined);
      if (deps.getAdminRole(token) !== "full") { res.status(403).json({ error: "Full admin access required." }); return; }
      next();
    } else {
      const original = res.json;
      const token = req.header("x-admin-token");
      res.json = function (body: unknown) {
        if (deps.getAdminRole(token) !== "full") return original.call(this.status(403), { error: "Full admin access required." });
        return original.call(this, body);
      };
      deps.requireFullAdmin(req, res, next);
    }
  });
  const workLimit = rateLimit({ windowMs: 60_000, max: 30, message: "Fair Value analytics request budget exceeded." });
  const fail = (res: Response, error: unknown, status = 400): void => { res.status(status).json({ error: error instanceof Error ? error.message : "Fair Value analytics unavailable." }); };

  router.get("/status", (_req, res) => res.json(engine.status()));
  router.get("/config", (_req, res) => res.json(engine.getConfig()));
  router.patch("/config", workLimit, async (req, res) => {
    try { res.json({ ...await engine.updateConfig(req.body), status: engine.status() }); }
    catch (error) { fail(res, error); }
  });
  router.get("/underlyings", async (_req, res) => {
    try { res.json({ underlyings: await engine.underlyings(), status: engine.status() }); }
    catch (error) { fail(res, error, 503); }
  });
  router.get("/snapshot/:underlying", (req, res) => res.json(engine.getSnapshot(String(req.params.underlying))));
  router.post("/refresh", workLimit, async (req, res) => {
    if (typeof req.body?.underlying !== "string") { fail(res, new Error("underlying is required.")); return; }
    try { res.json({ ...await engine.refresh(req.body.underlying), status: engine.status() }); }
    catch (error) { fail(res, error, 503); }
  });
  router.post("/pause", (req, res) => {
    if (typeof req.body?.paused !== "boolean") { fail(res, new Error("paused must be boolean.")); return; }
    engine.pause(req.body.paused);
    res.json({ status: engine.status() });
  });
  router.post("/calculate", workLimit, async (req, res) => {
    try { res.json(await engine.calculate(req.body)); }
    catch (error) { fail(res, error); }
  });
  router.post("/independent", workLimit, async (req, res) => {
    try { res.json(await engine.independent(req.body)); }
    catch (error) { fail(res, error); }
  });
  router.get("/history/:underlying", async (req, res) => {
    try {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
      const snapshots = await engine.history(String(req.params.underlying), limit);
      res.json({ historical: true, snapshots, storage: engine.status().storage });
    } catch (error) { fail(res, error, 503); }
  });
  router.get("/history/:underlying/:id", async (req, res) => {
    try {
      const snapshot = await engine.historicalSnapshot(String(req.params.underlying), String(req.params.id));
      if (!snapshot) { res.status(404).json({ error: "Historical snapshot unavailable or outside retention." }); return; }
      res.json({ historical: true, snapshot });
    } catch (error) { fail(res, error, 503); }
  });
  router.get("/export/:underlying", (req, res) => {
    const result = engine.getSnapshot(String(req.params.underlying));
    if (!result.snapshot) { res.status(404).json({ error: "No current Fair Value snapshot." }); return; }
    res.setHeader("Content-Disposition", 'attachment; filename="fair-value-snapshot.json"');
    res.json(result);
  });
  router.get("/stream", (req: Request, res: Response) => {
    const token = req.header("x-admin-token") ?? (typeof req.query["x-admin-token"] === "string" ? req.query["x-admin-token"] : undefined);
    const symbol = typeof req.query.underlying === "string" ? req.query.underlying.toUpperCase() : "";
    let closed = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let detach: (() => void) | null = null;
    let dirty = true;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      detach?.();
      res.end();
    };
    try { detach = engine.subscribe(() => { dirty = true; }); }
    catch (error) { fail(res, error, 429); return; }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const publish = (): void => {
      // Revalidate role on EVERY emission/heartbeat. Expired/revoked tokens cannot
      // retain historical/live access on a long-lived subscription.
      if (deps.getAdminRole(token) !== "full") { cleanup(); return; }
      if (res.writableLength > 256000) { cleanup(); return; }
      try {
        if (dirty) { res.write(`event: snapshot\ndata: ${JSON.stringify(symbol ? engine.getSnapshot(symbol) : engine.status())}\n\n`); dirty = false; }
        else res.write(": heartbeat\n\n");
      } catch { cleanup(); }
    };
    publish();
    if (!closed) {
      timer = setInterval(publish, deps.streamIntervalMs ?? 5000);
      timer.unref();
    }
    res.on("close", cleanup);
    res.on("error", cleanup);
  });
  app.use("/api/fair-value", router);
}
