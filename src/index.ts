import "dotenv/config";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { KiteClient, KiteError, type Instrument } from "./kite.js";
import { TickerHub } from "./hub.js";
import type { Tick } from "./ticker.js";
import { rateLimit } from "./ratelimit.js";
import { getDividendYields } from "./yahoo.js";
import {
  initDb,
  isDbEnabled,
  isValidId,
  Trade,
  saveKiteSession,
  loadKiteSession,
  clearKiteSession,
} from "./db.js";
import type { ITrade, TradeRecord } from "./db.js";
import { initNseFnoConnections } from "./db.js";
import { SpreadSummary } from "./db.js";
import { startHourlyScheduler, backfillMissedHours, startDayReviewScheduler } from "./hourlyCapture.js";
import { startEodScheduler, backfillStockFutures, checkAndRecomputeSummary } from "./eodCapture.js";

const PORT = Number(process.env.PORT ?? 3001);
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "";
// Separate password for the trade-only access route (/admin/access).
const ACCESS_SECRET = process.env.ACCESS_SECRET ?? "";
// Shared secret for the internal token-sharing endpoint used by the local
// market_data recorder to reuse this app's Zerodha session (no second API key).
const INTERNAL_TOKEN_SECRET = process.env.INTERNAL_TOKEN_SECRET ?? "";
// Passcode for the public, curl-friendly token route (GET /api/kite/token).
// Anyone who knows this passcode can fetch the current Zerodha access token
// once the admin has connected Zerodha — handy for scripts/tools without a UI.
const TOKEN_ROUTE_SECRET = process.env.TOKEN_ROUTE_SECRET ?? "";

const kite = new KiteClient({
  apiKey: process.env.KITE_API_KEY ?? "",
  apiSecret: process.env.KITE_API_SECRET ?? "",
});

// One shared Kite WebSocket fanned out to all SSE clients (keeps us within
// Zerodha's per-key connection limit no matter how many visitors watch).
const tickerHub = new TickerHub(
  () => ({ apiKey: kite.getApiKey(), accessToken: kite.getAccessToken() }),
  () => {
    // Token was rejected by Zerodha — clear both memory and the persisted copy
    // so we don't restore a dead token on the next restart.
    kite.clearSession();
    void clearKiteSession();
  },
);

// Capture-scheduler deps, held at module scope so a login (which happens after
// startup) can immediately trigger a backfill of any slots missed while down.
let hourlyBackfillDeps: Parameters<typeof backfillMissedHours>[0] | null = null;
let eodBackfillDeps: Parameters<typeof backfillStockFutures>[0] | null = null;

// In-memory store for admin sessions (token -> { expiry, role }).
// "full"  = full admin (Zerodha connect + trades), via /admin/verify
// "trade" = trade-only access (view/take/close trades), via /admin/access
type AdminRole = "full" | "trade";
interface AdminSession {
  expiry: number;
  role: AdminRole;
}
const adminSessions = new Map<string, AdminSession>();
const ADMIN_SESSION_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

function generateAdminToken(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

/** The role of a token, or null if missing/expired. */
function getAdminRole(token: string | undefined): AdminRole | null {
  if (!token) return null;
  const s = adminSessions.get(token);
  if (!s || Date.now() > s.expiry) {
    if (token) adminSessions.delete(token);
    return null;
  }
  return s.role;
}

function isAdminAuthenticated(token: string | undefined): boolean {
  return getAdminRole(token) !== null;
}

/** Any admin (full OR trade-access) — used for the shared trade endpoints. */
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const token = req.headers["x-admin-token"] as string | undefined;
  if (!isAdminAuthenticated(token)) {
    res.status(403).json({ error: "Admin authentication required" });
    return;
  }
  next();
}

/** Full admin only — used for Zerodha connect / session / logout. */
function requireFullAdmin(req: Request, res: Response, next: NextFunction) {
  const token = req.headers["x-admin-token"] as string | undefined;
  if (getAdminRole(token) !== "full") {
    res.status(403).json({ error: "Full admin access required." });
    return;
  }
  next();
}

// In-memory cache of the instrument dump so we don't re-download the (large)
// CSV on every frontend request. Kite refreshes instruments once a day.
let instrumentCache: { at: number; data: Instrument[] } | null = null;
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour

// Dividend yields (%) from Yahoo, refreshed once a day.
let dividendCache: { at: number; data: Record<string, number> } | null = null;
const DIVIDEND_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

const app = express();

// Live financial data must never be cached. Disable ETag generation so the
// backend never replies "304 Not Modified" (a 304 has an empty body, which
// would make the frontend's res.json() fail).
app.set("etag", false);

// --- CORS (so the Vite frontend can call this API) ---
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header("Access-Control-Allow-Origin", FRONTEND_URL);
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-admin-token");
  res.header("Access-Control-Allow-Credentials", "true");
  // Prevent browser/proxy caching of API responses (no 304 revalidation).
  res.header("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json());

// General per-IP rate limit for all API routes: guards the Kite quota and the
// server against rapid refreshing / deliberate abuse. 150 req/min comfortably
// covers a normal visitor (a page load is ~4 calls + a 15s status poll) while
// blocking abusive loops.
app.use("/api", rateLimit({ windowMs: 60_000, max: 150 }));

// --- Health check ---
app.get("/", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    authenticated: kite.hasSession(),
    hint: "Visit /api/login to authenticate with Zerodha.",
  });
});

// --- Status (under /api so it works behind a same-domain /api proxy) ---
app.get("/api/status", (_req: Request, res: Response) => {
  res.json({ status: "ok", authenticated: kite.hasSession() });
});

// --- Internal: share the current Zerodha session with the local market_data
// recorder so it can reuse THIS app's access token (Zerodha allows only one
// token per API key/day). Guarded by a shared secret header, never exposed to
// the public frontend. Returns the api_key + access_token only when a valid
// session exists. Rate-limited to blunt brute-force of the secret. ---
app.get(
  "/api/internal/kite-token",
  rateLimit({ windowMs: 60_000, max: 30 }),
  (req: Request, res: Response) => {
    if (!INTERNAL_TOKEN_SECRET) {
      res.status(503).json({ error: "Internal token sharing is not configured." });
      return;
    }
    const provided =
      (req.headers["x-internal-secret"] as string | undefined) ??
      (req.query.secret as string | undefined);
    if (provided !== INTERNAL_TOKEN_SECRET) {
      res.status(403).json({ error: "Forbidden." });
      return;
    }
    const accessToken = kite.getAccessToken();
    res.json({
      api_key: kite.getApiKey(),
      access_token: accessToken,
      authenticated: accessToken !== null,
    });
  },
);

// --- Public, curl-friendly access-token route (passcode-protected). ---
// Once the admin has connected Zerodha, anyone holding the route passcode can
// fetch the day's access token with a simple curl (no admin login / cookies):
//
//   curl "https://<host>/api/kite/token?passcode=YOUR_PASSCODE"
//   curl -H "x-token-passcode: YOUR_PASSCODE" https://<host>/api/kite/token
//
// The passcode is a dedicated secret (TOKEN_ROUTE_SECRET), separate from the
// admin secret, so it can be shared with scripts without granting admin access.
// Rate-limited to blunt brute-forcing of the passcode.
app.get(
  "/api/kite/token",
  rateLimit({ windowMs: 60_000, max: 30 }),
  (req: Request, res: Response) => {
    if (!TOKEN_ROUTE_SECRET) {
      res.status(503).json({
        error: "Token route is not configured. Set TOKEN_ROUTE_SECRET on the server.",
      });
      return;
    }
    const provided =
      (req.headers["x-token-passcode"] as string | undefined) ??
      (req.query.passcode as string | undefined);
    if (provided !== TOKEN_ROUTE_SECRET) {
      res.status(403).json({ error: "Invalid or missing passcode." });
      return;
    }
    const accessToken = kite.getAccessToken();
    if (!accessToken) {
      res.status(409).json({
        authenticated: false,
        error: "No active Zerodha session. The admin must connect to Zerodha first.",
      });
      return;
    }
    res.json({
      authenticated: true,
      api_key: kite.getApiKey(),
      access_token: accessToken,
      login_date: istDayKey(),
    });
  },
);

// --- Admin verification endpoint ---
// Stricter limit so the secret can't be brute-forced: 10 attempts / 5 min / IP.
app.post(
  "/api/admin/verify",
  rateLimit({
    windowMs: 5 * 60_000,
    max: 10,
    message: "Too many attempts. Try again in a few minutes.",
  }),
  (req: Request, res: Response) => {
  const { secret } = req.body;
  
  if (!ADMIN_SECRET) {
    res.status(500).json({ error: "Admin secret not configured on server" });
    return;
  }
  
  if (secret !== ADMIN_SECRET) {
    res.status(401).json({ error: "Invalid admin secret" });
    return;
  }
  
  const token = generateAdminToken();
  adminSessions.set(token, { expiry: Date.now() + ADMIN_SESSION_TTL_MS, role: "full" });

  res.json({
    success: true,
    token,
    role: "full",
    expiresIn: ADMIN_SESSION_TTL_MS,
  });
});

// --- Trade-access verification (/admin/access): trade-only role. ---
app.post(
  "/api/access/verify",
  rateLimit({
    windowMs: 5 * 60_000,
    max: 10,
    message: "Too many attempts. Try again in a few minutes.",
  }),
  (req: Request, res: Response) => {
    const { secret } = req.body;

    if (!ACCESS_SECRET) {
      res.status(500).json({ error: "Access secret not configured on server" });
      return;
    }
    if (secret !== ACCESS_SECRET) {
      res.status(401).json({ error: "Invalid access code" });
      return;
    }

    const token = generateAdminToken();
    adminSessions.set(token, {
      expiry: Date.now() + ADMIN_SESSION_TTL_MS,
      role: "trade",
    });

    res.json({
      success: true,
      token,
      role: "trade",
      expiresIn: ADMIN_SESSION_TTL_MS,
    });
  },
);

// --- Check admin session status (returns the role too). ---
app.get("/api/admin/status", (req: Request, res: Response) => {
  const token = req.headers["x-admin-token"] as string | undefined;
  const role = getAdminRole(token);
  res.json({ authenticated: role !== null, role });
});

// --- Step 1: send the user to Zerodha's login page ---
// Registered at both /login and /api/login so it works whether the backend is
// on its own origin or behind a same-domain "/api" reverse proxy.
app.get(["/login", "/api/login"], (req: Request, res: Response) => {
  // Accept admin token from query param (browser navigation can't send headers)
  const tokenFromQuery = req.query["x-admin-token"] as string | undefined;
  const tokenFromHeader = req.headers["x-admin-token"] as string | undefined;
  if (getAdminRole(tokenFromQuery || tokenFromHeader) !== "full") {
    res.status(403).json({ error: "Full admin access required." });
    return;
  }
  res.redirect(kite.getLoginUrl());
});

// --- Step 2/3 (frontend-driven): the frontend receives the request_token at
// its registered redirect URL (e.g. http://localhost:5173/zerodha/verify)
// and POSTs it here so the backend can do the secret checksum exchange. ---
app.post("/api/session", requireFullAdmin, async (req: Request, res: Response) => {
  const requestToken = String(req.body?.request_token ?? "");
  if (!requestToken) {
    res.status(400).json({ error: "Missing request_token." });
    return;
  }
  try {
    const session = await kite.generateSession(requestToken);
    console.log(`Authenticated as ${session.user_name} (${session.user_id}).`);
    persistKiteSession(session);
    triggerPostLoginBackfill();
    res.json({
      authenticated: true,
      user_id: session.user_id,
      user_name: session.user_name,
    });
  } catch (err) {
    // Do NOT use sendError here: a failed (or duplicate) request_token
    // exchange must not clear an already-valid session.
    const status = err instanceof KiteError ? err.status : 500;
    const message = err instanceof Error ? err.message : "Login failed.";
    res.status(status).json({ error: message });
  }
});

// --- Legacy/alternative: Zerodha redirects straight to the backend with
// ?request_token=... (used only if the app's Redirect URL points here). ---
app.get("/callback", async (req: Request, res: Response) => {
  const requestToken = String(req.query.request_token ?? "");
  const status = String(req.query.status ?? "");

  if (status !== "success" || !requestToken) {
    res.redirect(`${FRONTEND_URL}/?auth=failed`);
    return;
  }

  try {
    const session = await kite.generateSession(requestToken);
    console.log(`Authenticated as ${session.user_name} (${session.user_id}).`);
    persistKiteSession(session);
    triggerPostLoginBackfill();
    res.redirect(`${FRONTEND_URL}/?auth=success`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Session generation failed:", message);
    res.redirect(`${FRONTEND_URL}/?auth=failed`);
  }
});

// --- Logout: forget the stored Kite session (full admin only). ---
app.post("/api/logout", requireFullAdmin, (_req: Request, res: Response) => {
  kite.clearSession();
  void clearKiteSession();
  res.json({ authenticated: false });
});

// --- Current Zerodha access token (full admin only). ---
// Lets the admin copy the day's access token straight from the admin panel so
// it can be reused in other tools (e.g. the local market_data recorder) without
// a second Zerodha login. Zerodha issues one token per API key per day.
app.get("/api/kite/access-token", requireFullAdmin, (_req: Request, res: Response) => {
  const accessToken = kite.getAccessToken();
  if (!accessToken) {
    res.status(409).json({
      error: "No active Zerodha session. Connect to Zerodha first.",
    });
    return;
  }
  res.json({
    api_key: kite.getApiKey(),
    access_token: accessToken,
    login_date: istDayKey(),
  });
});

// --- Authenticated user profile (the /user/ docs endpoint) ---
app.get("/api/profile", async (_req: Request, res: Response) => {
  try {
    const profile = await kite.getProfile();
    res.json(profile);
  } catch (err) {
    sendError(res, err);
  }
});

// --- All stocks: instrument dump, filtered to equities by default ---
// Query params:
//   exchange   default "NSE"  (set to "" to fetch every exchange)
//   type       default "EQ"   (instrument_type filter; set to "" to disable)
//   q          optional text search over symbol/name
app.get("/api/instruments", async (req: Request, res: Response) => {
  const exchange = req.query.exchange === undefined ? "NSE" : String(req.query.exchange);
  const type = req.query.type === undefined ? "EQ" : String(req.query.type);
  const q = String(req.query.q ?? "").trim().toLowerCase();

  try {
    let data = await getAllInstrumentsCached();

    if (exchange) {
      data = data.filter((i) => i.exchange === exchange);
    }
    if (type) {
      data = data.filter((i) => i.instrument_type === type);
    }
    if (q) {
      data = data.filter(
        (i) =>
          i.tradingsymbol.toLowerCase().includes(q) ||
          i.name.toLowerCase().includes(q),
      );
    }

    res.json({ count: data.length, instruments: data });
  } catch (err) {
    sendError(res, err);
  }
});

// --- F&O stocks only: underlyings that have stock futures on NSE (NFO). ---
// Index F&O (NIFTY, BANKNIFTY, ...) is excluded because indices are not NSE
// equities. Each row is the NSE equity enriched with its F&O lot size.
//   q   optional text search over symbol/name
app.get("/api/fno-stocks", async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim().toLowerCase();

  try {
    const all = await getAllInstrumentsCached();
    let data = deriveFnoStocks(all);

    if (q) {
      data = data.filter(
        (i) =>
          i.tradingsymbol.toLowerCase().includes(q) ||
          i.name.toLowerCase().includes(q),
      );
    }

    res.json({ count: data.length, instruments: data });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Detail for one F&O stock: spot instrument + the 3 nearest futures. ---
app.get("/api/fno-stocks/:symbol", async (req: Request, res: Response) => {
  const symbol = String(req.params.symbol).toUpperCase();
  try {
    const all = await getAllInstrumentsCached();

    const spot = all.find(
      (i) =>
        i.exchange === "NSE" &&
        i.instrument_type === "EQ" &&
        i.tradingsymbol === symbol,
    );
    if (!spot) {
      res.status(404).json({ error: `No NSE equity found for "${symbol}".` });
      return;
    }

    const futures = all
      .filter(
        (i) =>
          i.exchange === "NFO" &&
          i.instrument_type === "FUT" &&
          i.name === symbol,
      )
      .sort((a, b) => a.expiry.localeCompare(b.expiry)) // ISO dates sort chronologically
      .slice(0, 3)
      .map((f) => ({
        instrument_token: f.instrument_token,
        tradingsymbol: f.tradingsymbol,
        expiry: f.expiry,
        lot_size: f.lot_size,
      }));

    res.json({
      symbol,
      spot: {
        instrument_token: spot.instrument_token,
        tradingsymbol: spot.tradingsymbol,
        name: spot.name,
      },
      futures,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// Short-lived cache of the REST quote snapshot, keyed by the requested token
// set. This means that no matter how many visitors load/refresh the page, we
// hit Zerodha's rate-limited quote API at most once every QUOTES_TTL_MS —
// protecting the API quota from repeated refreshes or deliberate abuse.
const quotesCache = new Map<string, { at: number; ticks: Tick[] }>();
const QUOTES_TTL_MS = 4000;

// --- Snapshot quotes (REST): last price + close for the given tokens.
// Works regardless of market hours, so prices/premiums show even after close.
// PUBLIC: anyone can read the data once an admin has connected Zerodha. ---
app.get("/api/quotes", async (req: Request, res: Response) => {
  const tokens = String(req.query.tokens ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (tokens.length === 0) {
    res.status(400).json({ error: "Provide ?tokens=token1,token2,..." });
    return;
  }
  if (!kite.getAccessToken()) {
    res.status(401).json({
      error: "Quotes require a one-time Zerodha login.",
    });
    return;
  }

  // Serve from the short-lived cache when fresh (protects the Kite quota).
  const cacheKey = tokens.slice().sort((a, b) => a - b).join(",");
  const cached = quotesCache.get(cacheKey);
  if (cached && Date.now() - cached.at < QUOTES_TTL_MS) {
    res.json({ ticks: cached.ticks });
    return;
  }

  try {
    const all = await getAllInstrumentsCached();
    const byToken = new Map<number, string>();
    for (const inst of all) {
      byToken.set(inst.instrument_token, `${inst.exchange}:${inst.tradingsymbol}`);
    }
    const identifiers = tokens
      .map((t) => byToken.get(t))
      .filter((s): s is string => typeof s === "string");

    const quotes = await kite.getQuoteFull(identifiers);
    const ticks = quotes.map((q) => ({
      token: q.instrument_token,
      last_price: q.last_price,
      close_price: q.close,
      oi: q.oi,
      bid: 0, // filled by the live full-mode stream
      ask: 0,
    }));
    quotesCache.set(cacheKey, { at: Date.now(), ticks });
    // Warm the shared hub cache so late-joining SSE clients get instant data.
    tickerHub.seed(ticks);
    res.json({ ticks });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Live data: Server-Sent Events stream of ticks for the given tokens. ---
// The backend opens a Kite WebSocket (using the stored access token), parses
// the binary ticks, and relays them to the browser as JSON SSE events.
// PUBLIC: anyone can subscribe to the live stream once an admin has connected
// Zerodha. The stream only emits data while a valid Zerodha session exists.
//   tokens   comma-separated instrument tokens
app.get("/api/stream", (req: Request, res: Response) => {
  const tokens = String(req.query.tokens ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (tokens.length === 0) {
    res.status(400).json({ error: "Provide ?tokens=token1,token2,..." });
    return;
  }

  const accessToken = kite.getAccessToken();
  if (!accessToken) {
    res.status(401).json({
      error:
        "Live prices require a one-time Zerodha login. Click “Connect to Zerodha”.",
    });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // Register with the shared hub (one upstream Zerodha WS for all viewers).
  const unsubscribe = tickerHub.addClient(res, tokens);

  // Keep the connection alive through proxies.
  const keepAlive = setInterval(() => res.write(`: ping\n\n`), 20000);

  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
    res.end();
  });
});

// --- Dividend yields (%) per F&O stock, sourced from Yahoo Finance.
// Cached for 24h. Works without a Zerodha login. Failures map to 0%. ---
app.get("/api/dividends", async (_req: Request, res: Response) => {
  try {
    if (dividendCache && Date.now() - dividendCache.at < DIVIDEND_TTL_MS) {
      res.json({ yields: dividendCache.data, cachedAt: dividendCache.at });
      return;
    }
    const all = await getAllInstrumentsCached();
    const symbols = deriveFnoBoard(all)
      .filter((b) => !b.is_index) // indices have no Yahoo dividend yield
      .map((b) => b.symbol);
    const yields = await getDividendYields(symbols);
    dividendCache = { at: Date.now(), data: yields };
    res.json({ yields, cachedAt: dividendCache.at });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Debug: inspect how indices are detected (helps diagnose deployments). ---
app.get("/api/debug/indices", async (_req: Request, res: Response) => {
  try {
    const all = await getAllInstrumentsCached();
    const indexInstruments = all
      .filter((i) => i.segment === "INDICES")
      .map((i) => i.tradingsymbol);
    const futNames = new Set(
      all
        .filter((i) => i.exchange === "NFO" && i.instrument_type === "FUT")
        .map((i) => i.name),
    );
    const resolved = Object.entries(INDEX_SPOT_MAP).map(([underlying, spot]) => ({
      underlying,
      hasFutures: futNames.has(underlying),
      spotSymbol: spot,
      spotFound: indexInstruments.includes(spot),
    }));
    const board = deriveFnoBoard(all);
    res.json({
      totalIndexInstruments: indexInstruments.length,
      sampleIndexTradingSymbols: indexInstruments.slice(0, 25),
      resolved,
      indexRowsInBoard: board.filter((b) => b.is_index).map((b) => ({
        symbol: b.symbol,
        name: b.name,
        futures: b.futures.length,
      })),
      totalBoardRows: board.length,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Historical daily open interest (last ~1 month) for a symbol's futures. ---
// Returns each future's closing OI per trading day, for the detail-page chart.
// PUBLIC (needs a Zerodha session + historical-data subscription).
//
// Daily closing OI is fixed for a given calendar day, so we cache per symbol
// for the whole trading day (IST) and only refetch once the date rolls over.
const historyCache = new Map<string, { day: string; data: unknown }>();

/** Current calendar day in IST (UTC+5:30) as YYYY-MM-DD. */
function istDayKey(): string {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

/** A Date as an IST "YYYY-MM-DD HH:MM:SS" string (Kite expects exchange time). */
function istDateTime(d: Date): string {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 19).replace("T", " ");
}

/** True during NSE market hours: Mon-Fri, 09:15-15:30 IST. */
function isMarketOpen(): boolean {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const day = ist.getUTCDay(); // 0 Sun ... 6 Sat (on the IST-shifted date)
  if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

/** Simple delay helper to avoid rate-limiting on consecutive Kite API calls. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build a token -> "EXCHANGE:TRADINGSYMBOL" resolver from the instrument dump. */
function makeIdResolver(all: Instrument[]): (token: number) => string | null {
  const byToken = new Map<number, string>();
  for (const inst of all) {
    byToken.set(inst.instrument_token, `${inst.exchange}:${inst.tradingsymbol}`);
  }
  return (token: number) => byToken.get(token) ?? null;
}

app.get("/api/history/:symbol", async (req: Request, res: Response) => {
  if (!kite.getAccessToken()) {
    res.status(401).json({ error: "Historical data requires a Zerodha login." });
    return;
  }
  const symbol = String(req.params.symbol).toUpperCase();

  const today = istDayKey();
  const cached = historyCache.get(symbol);
  if (cached && cached.day === today) {
    res.json(cached.data);
    return;
  }

  try {
    const all = await getAllInstrumentsCached();
    const item = deriveFnoBoard(all).find((b) => b.symbol.toUpperCase() === symbol);
    if (!item) {
      res.status(404).json({ error: `No F&O instrument found for "${symbol}".` });
      return;
    }

    const to = new Date();
    const from = new Date();
    from.setMonth(from.getMonth() - 1);
    const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

    const futures: {
      token: number;
      expiry: string;
      points: { date: string; oi: number; close: number }[];
    }[] = [];
    for (const f of item.futures) {
      const candles = await kite.getHistoricalOi(f.token, fmtDate(from), fmtDate(to));
      futures.push({
        token: f.token,
        expiry: f.expiry,
        points: candles.map((c) => ({ date: c.date, oi: c.oi, close: c.close })),
      });
    }

    const data = {
      symbol: item.symbol,
      name: item.name,
      is_index: !!item.is_index,
      futures,
    };
    historyCache.set(symbol, { day: today, data });
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

// --- Spread history: combined calendar-spread (next - current close) for ~2 years. ---
// Fetches daily candles directly from Kite for each pair of consecutive futures
// and merges their overlapping-date spreads into a single timeline with stats.
const spreadHistoryCache = new Map<string, { day: string; data: unknown }>();

app.get("/api/spread-history/:symbol", async (req: Request, res: Response) => {
  if (!kite.getAccessToken()) {
    res.status(401).json({ error: "Historical data requires a Zerodha login." });
    return;
  }
  const symbol = String(req.params.symbol).toUpperCase();

  const today = istDayKey();
  const cached = spreadHistoryCache.get(symbol);
  if (cached && cached.day === today) {
    res.json(cached.data);
    return;
  }

  try {
    const all = await getAllInstrumentsCached();
    const item = deriveFnoBoard(all).find((b) => b.symbol.toUpperCase() === symbol);
    if (!item) {
      res.status(404).json({ error: `No F&O instrument found for "${symbol}".` });
      return;
    }

    // Date range: 2 years back to today.
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setFullYear(fromDate.getFullYear() - 2);
    const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
    const fromStr = fmtDate(fromDate);
    const toStr = fmtDate(toDate);

    // Fetch daily candles for each future (with 200ms delay between calls).
    const futureCandles: Map<string, number>[] = []; // date -> close per future
    for (let i = 0; i < item.futures.length; i++) {
      if (i > 0) await delay(200);
      const candles = await kite.getHistorical(item.futures[i]!.token, fromStr, toStr, "day");
      const map = new Map<string, number>();
      for (const c of candles) {
        map.set(c.t.slice(0, 10), c.close);
      }
      futureCandles.push(map);
    }

    // For each consecutive pair, compute spread = next_close - current_close
    // on dates where both have data.
    const spreadMap = new Map<string, number>(); // date -> spread (prefer earlier pair)
    for (let p = 0; p < item.futures.length - 1; p++) {
      const currentMap = futureCandles[p]!;
      const nextMap = futureCandles[p + 1]!;
      for (const [date, nextClose] of nextMap) {
        const currentClose = currentMap.get(date);
        if (currentClose !== undefined && !spreadMap.has(date)) {
          spreadMap.set(date, nextClose - currentClose);
        }
      }
    }

    // Sort chronologically.
    const points = Array.from(spreadMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, spread]) => ({ date, spread: Math.round(spread * 100) / 100 }));

    // Compute stats.
    let sum = 0;
    let max = -Infinity;
    let min = Infinity;
    for (const pt of points) {
      sum += pt.spread;
      if (pt.spread > max) max = pt.spread;
      if (pt.spread < min) min = pt.spread;
    }
    const count = points.length;
    const mean = count > 0 ? Math.round((sum / count) * 100) / 100 : 0;
    if (count === 0) {
      max = 0;
      min = 0;
    }

    const dataRange = {
      from: points.length > 0 ? points[0]!.date : fromStr,
      to: points.length > 0 ? points[points.length - 1]!.date : toStr,
    };

    const data = {
      symbol: item.symbol,
      name: item.name,
      is_index: !!item.is_index,
      dataRange,
      points,
      stats: { mean, max, min, count },
    };

    spreadHistoryCache.set(symbol, { day: today, data });
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

// --- Hourly closing price for the last ~1 week, per future. Cached per day. ---
const intradayCache = new Map<string, { day: string; data: unknown }>();

app.get("/api/intraday/:symbol", async (req: Request, res: Response) => {
  if (!kite.getAccessToken()) {
    res.status(401).json({ error: "Historical data requires a Zerodha login." });
    return;
  }
  const symbol = String(req.params.symbol).toUpperCase();

  const today = istDayKey();
  const cached = intradayCache.get(symbol);
  if (cached && cached.day === today) {
    res.json(cached.data);
    return;
  }

  try {
    const all = await getAllInstrumentsCached();
    const item = deriveFnoBoard(all).find((b) => b.symbol.toUpperCase() === symbol);
    if (!item) {
      res.status(404).json({ error: `No F&O instrument found for "${symbol}".` });
      return;
    }

    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 7);
    const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

    const futures: {
      token: number;
      expiry: string;
      points: { t: string; close: number }[];
    }[] = [];
    for (const f of item.futures) {
      const candles = await kite.getHistorical(
        f.token,
        fmtDate(from),
        fmtDate(to),
        "60minute",
      );
      futures.push({
        token: f.token,
        expiry: f.expiry,
        points: candles.map((c) => ({ t: c.t, close: c.close })),
      });
    }

    const data = {
      symbol: item.symbol,
      name: item.name,
      is_index: !!item.is_index,
      futures,
    };
    intradayCache.set(symbol, { day: today, data });
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

// --- Minute-by-minute closing price for the last 2 hours, per future. ---
// Short-lived cache (60s) since this is near-real-time intraday data.
const minuteCache = new Map<string, { at: number; data: unknown }>();
const MINUTE_TTL_MS = 60 * 1000;

app.get("/api/minute/:symbol", async (req: Request, res: Response) => {
  if (!kite.getAccessToken()) {
    res.status(401).json({ error: "Historical data requires a Zerodha login." });
    return;
  }
  const symbol = String(req.params.symbol).toUpperCase();

  const cached = minuteCache.get(symbol);
  if (cached && Date.now() - cached.at < MINUTE_TTL_MS) {
    res.json(cached.data);
    return;
  }

  try {
    const all = await getAllInstrumentsCached();
    const item = deriveFnoBoard(all).find((b) => b.symbol.toUpperCase() === symbol);
    if (!item) {
      res.status(404).json({ error: `No F&O instrument found for "${symbol}".` });
      return;
    }

    const toD = new Date();
    const fromD = new Date(Date.now() - 2 * 60 * 60 * 1000);

    const futures: {
      token: number;
      expiry: string;
      points: { t: string; close: number }[];
    }[] = [];
    for (const f of item.futures) {
      const candles = await kite.getHistorical(
        f.token,
        istDateTime(fromD),
        istDateTime(toD),
        "minute",
      );
      futures.push({
        token: f.token,
        expiry: f.expiry,
        points: candles.map((c) => ({ t: c.t, close: c.close })),
      });
    }

    const data = {
      symbol: item.symbol,
      name: item.name,
      is_index: !!item.is_index,
      futures,
    };
    minuteCache.set(symbol, { at: Date.now(), data });
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

// --- 5-minute closing price for the current day, per future (5-min cache). ---
const fiveMinCache = new Map<string, { at: number; data: unknown }>();
const FIVEMIN_TTL_MS = 5 * 60 * 1000;

app.get("/api/fivemin/:symbol", async (req: Request, res: Response) => {
  if (!kite.getAccessToken()) {
    res.status(401).json({ error: "Historical data requires a Zerodha login." });
    return;
  }
  const symbol = String(req.params.symbol).toUpperCase();

  const cached = fiveMinCache.get(symbol);
  if (cached && Date.now() - cached.at < FIVEMIN_TTL_MS) {
    res.json(cached.data);
    return;
  }

  try {
    const all = await getAllInstrumentsCached();
    const item = deriveFnoBoard(all).find((b) => b.symbol.toUpperCase() === symbol);
    if (!item) {
      res.status(404).json({ error: `No F&O instrument found for "${symbol}".` });
      return;
    }

    const today = istDayKey();
    const futures: {
      token: number;
      expiry: string;
      points: { t: string; close: number }[];
    }[] = [];
    for (const f of item.futures) {
      const candles = await kite.getHistorical(f.token, today, today, "5minute");
      futures.push({
        token: f.token,
        expiry: f.expiry,
        points: candles.map((c) => ({ t: c.t, close: c.close })),
      });
    }

    const data = {
      symbol: item.symbol,
      name: item.name,
      is_index: !!item.is_index,
      futures,
    };
    fiveMinCache.set(symbol, { at: Date.now(), data });
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

// --- F&O board: every F&O stock with its spot token + 3 nearest futures,
// so the frontend can render them all stacked and stream every token live. ---
app.get("/api/fno-board", async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim().toLowerCase();
  try {
    const all = await getAllInstrumentsCached();
    let board = deriveFnoBoard(all);
    if (q) {
      board = board.filter(
        (b) =>
          b.symbol.toLowerCase().includes(q) ||
          b.name.toLowerCase().includes(q),
      );
    }
    res.json({ count: board.length, board });
  } catch (err) {
    sendError(res, err);
  }
});

// ============================================================================
//  Spread stats: per-symbol summary from the spread_summary collection.
// ============================================================================

app.get("/api/spread-stats/:symbol", async (req: Request, res: Response) => {
  const symbol = String(req.params.symbol).toUpperCase();
  try {
    const doc = await SpreadSummary.findOne({ symbol }).lean();
    if (!doc) {
      res.status(404).json({ error: `No spread summary found for "${symbol}".` });
      return;
    }
    res.json(doc);
  } catch (err) {
    sendError(res, err);
  }
});

// ============================================================================
//  Calendar-spread trades (P&L) — admin only, persisted in MongoDB.
//  A trade BUYS the discount leg and SELLS the premium leg, using the current
//  and next month futures, for exactly 1 lot.
// ============================================================================

/**
 * Volume-weighted fill price for a market order of `quantity`, walking the
 * given order-book side (best level first). This reproduces a real market
 * order: it fills at the touch when there's enough size, and slips into deeper
 * levels when the lot is larger than what's available — exactly like a broker.
 */
interface Ladder {
  last: number;
  bids: { price: number; qty: number }[];
  asks: { price: number; qty: number }[];
}

/**
 * Resolve the order book for tokens, preferring the freshest LIVE book from the
 * WebSocket hub (lowest latency) and falling back to a REST /quote snapshot for
 * anything the hub doesn't have fresh (e.g. index spot has no depth).
 */
async function resolveLadder(tokens: number[]): Promise<Map<number, Ladder>> {
  const out = new Map<number, Ladder>();
  const missing: number[] = [];
  for (const tk of tokens) {
    const fresh = tickerHub.getFreshLadder(tk);
    if (fresh && (fresh.bids.length > 0 || fresh.asks.length > 0)) {
      out.set(tk, fresh);
    } else {
      missing.push(tk);
    }
  }
  if (missing.length > 0) {
    const all = await getAllInstrumentsCached();
    const resolveId = makeIdResolver(all);
    const ids = missing
      .map(resolveId)
      .filter((s): s is string => typeof s === "string");
    const rest = await kite.getQuoteLadder(ids);
    for (const [tk, v] of rest) out.set(tk, v);
  }
  return out;
}

function vwapFill(
  levels: { price: number; qty: number }[],
  quantity: number,
  fallback: number,
): number {
  let remaining = quantity;
  let cost = 0;
  let filled = 0;
  for (const lv of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lv.qty);
    if (take <= 0) continue;
    cost += take * lv.price;
    filled += take;
    remaining -= take;
  }
  if (remaining > 0) {
    // Not enough visible depth — fill the remainder at the deepest known price.
    const lastPx = levels.length > 0 ? levels[levels.length - 1]!.price : fallback;
    cost += remaining * lastPx;
    filled += remaining;
  }
  return filled > 0 ? cost / filled : fallback;
}

/** Serialize a trade record to the API shape (string id, ISO dates). */
function serializeTrade(doc: TradeRecord) {
  return {
    id: doc._id.toString(),
    symbol: doc.symbol,
    name: doc.name,
    is_index: doc.is_index,
    lot_size: doc.lot_size,
    buy: doc.buy,
    sell: doc.sell,
    status: doc.status,
    opened_at: doc.opened_at.toISOString(),
    closed_at: doc.closed_at ? doc.closed_at.toISOString() : null,
    close_pnl: doc.close_pnl,
    buy_close: doc.buy_close,
    sell_close: doc.sell_close,
    margin: doc.margin,
  };
}

// --- Take a trade: buy the discount leg, sell the premium leg (current+next). ---
app.post("/api/trades", requireAdmin, async (req: Request, res: Response) => {
  if (!isDbEnabled()) {
    res.status(503).json({ error: "Trade persistence is not configured (set MONGODB_URI)." });
    return;
  }
  if (!kite.getAccessToken()) {
    res.status(401).json({ error: "Connect to Zerodha before taking a trade." });
    return;
  }
  if (!isMarketOpen()) {
    res.status(400).json({
      error: "Trades can only be taken during market hours (Mon–Fri, 9:15–15:30 IST).",
    });
    return;
  }

  const symbol = String(req.body?.symbol ?? "").trim().toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: "Provide a symbol." });
    return;
  }

  try {
    const all = await getAllInstrumentsCached();
    const item = deriveFnoBoard(all).find((b) => b.symbol.toUpperCase() === symbol);
    if (!item) {
      res.status(404).json({ error: `No F&O instrument found for "${symbol}".` });
      return;
    }
    if (item.futures.length < 2) {
      res.status(400).json({
        error: "Need both current and next month futures to place a calendar spread.",
      });
      return;
    }

    const current = item.futures[0]!;
    const next = item.futures[1]!;

    // Guard against an already-open trade on the same symbol.
    const existing = await Trade.findOne({ symbol: item.symbol, status: "open" }).lean();
    if (existing) {
      res.status(409).json({ error: `A trade for ${item.symbol} is already open.` });
      return;
    }

    // Live 5-level order book for spot + both legs (WebSocket first, REST fallback).
    const ladders = await resolveLadder([item.spot_token, current.token, next.token]);

    const spot = ladders.get(item.spot_token)?.last;
    const curL = ladders.get(current.token);
    const nextL = ladders.get(next.token);

    if (!spot || !curL || !nextL || !curL.last || !nextL.last) {
      res.status(502).json({
        error: "Could not fetch live prices for all legs right now. Try again shortly.",
      });
      return;
    }

    // Premium/discount vs spot (using last price). Buy the cheaper (lower
    // premium) leg, sell the richer one.
    const premCurrent = curL.last - spot;
    const premNext = nextL.last - spot;

    const currentLeg = { token: current.token, expiry: current.expiry, ladder: curL };
    const nextLeg = { token: next.token, expiry: next.expiry, ladder: nextL };

    const [buyLeg, sellLeg] =
      premCurrent <= premNext ? [currentLeg, nextLeg] : [nextLeg, currentLeg];

    // Realistic market-order fills: BUY walks the ask side, SELL walks the bid
    // side, for the full lot quantity (captures slippage/partial fills).
    const buyEntry = vwapFill(buyLeg.ladder.asks, current.lot_size, buyLeg.ladder.last);
    const sellEntry = vwapFill(sellLeg.ladder.bids, current.lot_size, sellLeg.ladder.last);

    // Look up tradingsymbol + exchange for each leg (needed by the margin API).
    const instByToken = new Map<number, { tradingsymbol: string; exchange: string }>();
    for (const inst of all) {
      instByToken.set(inst.instrument_token, {
        tradingsymbol: inst.tradingsymbol,
        exchange: inst.exchange,
      });
    }
    const buyInst = instByToken.get(buyLeg.token);
    const sellInst = instByToken.get(sellLeg.token);

    // Fetch the net basket margin for [BUY 1 lot, SELL 1 lot]. Non-fatal: if it
    // fails, we still record the trade with margin = null.
    let margin: number | null = null;
    if (buyInst && sellInst) {
      try {
        const res = await kite.getBasketMargin([
          {
            exchange: buyInst.exchange,
            tradingsymbol: buyInst.tradingsymbol,
            transaction_type: "BUY",
            variety: "regular",
            product: "NRML",
            order_type: "MARKET",
            quantity: current.lot_size,
            price: 0,
          },
          {
            exchange: sellInst.exchange,
            tradingsymbol: sellInst.tradingsymbol,
            transaction_type: "SELL",
            variety: "regular",
            product: "NRML",
            order_type: "MARKET",
            quantity: current.lot_size,
            price: 0,
          },
        ]);
        margin = Math.round(res.total);
      } catch (marginErr) {
        console.warn("Basket margin fetch failed:", marginErr);
      }
    }

    const payload: ITrade = {
      symbol: item.symbol,
      name: item.name,
      is_index: !!item.is_index,
      lot_size: current.lot_size,
      buy: { token: buyLeg.token, expiry: buyLeg.expiry, entry: buyEntry },
      sell: { token: sellLeg.token, expiry: sellLeg.expiry, entry: sellEntry },
      status: "open",
      opened_at: new Date(),
      closed_at: null,
      close_pnl: null,
      buy_close: null,
      sell_close: null,
      margin,
    };

    const created = await Trade.create(payload);
    res.json({ trade: serializeTrade(created.toObject() as TradeRecord) });
  } catch (err) {
    sendError(res, err);
  }
});

// --- List all trades (open + closed), newest first. ---
app.get("/api/trades", requireAdmin, async (_req: Request, res: Response) => {
  if (!isDbEnabled()) {
    res.json({ dbEnabled: false, trades: [] });
    return;
  }
  try {
    const docs = await Trade.find()
      .sort({ opened_at: -1 })
      .limit(200)
      .lean<TradeRecord[]>();
    res.json({ dbEnabled: true, trades: docs.map(serializeTrade) });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Close a trade: lock in final P&L using current prices. ---
app.post("/api/trades/:id/close", requireAdmin, async (req: Request, res: Response) => {
  if (!isDbEnabled()) {
    res.status(503).json({ error: "Trade persistence is not configured (set MONGODB_URI)." });
    return;
  }

  const id = String(req.params.id);
  if (!isValidId(id)) {
    res.status(400).json({ error: "Invalid trade id." });
    return;
  }

  try {
    const trade = await Trade.findById(id);
    if (!trade) {
      res.status(404).json({ error: "Trade not found." });
      return;
    }
    if (trade.status === "closed") {
      res.json({ trade: serializeTrade(trade.toObject() as TradeRecord) });
      return;
    }
    if (!kite.getAccessToken()) {
      res.status(401).json({ error: "Connect to Zerodha to close a trade." });
      return;
    }

    // Realistic market-order exit walking the live book for the lot (WebSocket
    // first, REST fallback): sell the long leg into the BIDS, buy back the
    // short leg from the ASKS.
    const ladders = await resolveLadder([trade.buy.token, trade.sell.token]);

    const buyL = ladders.get(trade.buy.token);
    const sellL = ladders.get(trade.sell.token);
    const curBuy = buyL
      ? vwapFill(buyL.bids, trade.lot_size, buyL.last)
      : trade.buy.entry;
    const curSell = sellL
      ? vwapFill(sellL.asks, trade.lot_size, sellL.last)
      : trade.sell.entry;

    const pnl =
      trade.lot_size *
      ((curBuy - trade.buy.entry) + (trade.sell.entry - curSell));

    trade.status = "closed";
    trade.closed_at = new Date();
    trade.close_pnl = pnl;
    trade.buy_close = curBuy;
    trade.sell_close = curSell;
    await trade.save();

    res.json({ trade: serializeTrade(trade.toObject() as TradeRecord) });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Delete a CLOSED trade from history (admin only). ---
app.delete("/api/trades/:id", requireAdmin, async (req: Request, res: Response) => {
  if (!isDbEnabled()) {
    res.status(503).json({ error: "Trade persistence is not configured (set MONGODB_URI)." });
    return;
  }
  const id = String(req.params.id);
  if (!isValidId(id)) {
    res.status(400).json({ error: "Invalid trade id." });
    return;
  }
  try {
    const trade = await Trade.findById(id);
    if (!trade) {
      res.status(404).json({ error: "Trade not found." });
      return;
    }
    if (trade.status !== "closed") {
      res.status(400).json({ error: "Only closed trades can be deleted." });
      return;
    }
    await Trade.deleteOne({ _id: trade._id });
    res.json({ success: true, id });
  } catch (err) {
    sendError(res, err);
  }
});

interface BoardFuture {
  token: number;
  expiry: string;
  lot_size: number;
}

interface BoardItem {
  symbol: string;
  name: string;
  spot_token: number;
  futures: BoardFuture[];
  is_index?: boolean;
}

// F&O index underlyings (as they appear on NFO futures `name`) mapped to their
// NSE spot index tradingsymbol (in the INDICES segment of the instrument dump).
const INDEX_SPOT_MAP: Record<string, string> = {
  NIFTY: "NIFTY 50",
  BANKNIFTY: "NIFTY BANK",
  FINNIFTY: "NIFTY FIN SERVICE",
  MIDCPNIFTY: "NIFTY MID SELECT",
  NIFTYNXT50: "NIFTY NEXT 50",
};

/** Build the full F&O board: each underlying with its spot + 3 nearest futures. */
function deriveFnoBoard(all: Instrument[]): BoardItem[] {
  const futuresByUnderlying = new Map<string, Instrument[]>();
  const eqBySymbol = new Map<string, Instrument>();
  const indexBySymbol = new Map<string, Instrument>();

  for (const i of all) {
    if (i.exchange === "NFO" && i.instrument_type === "FUT" && i.name) {
      const arr = futuresByUnderlying.get(i.name) ?? [];
      arr.push(i);
      futuresByUnderlying.set(i.name, arr);
    } else if (i.segment === "INDICES") {
      // Spot index instruments (e.g. "NIFTY 50", "NIFTY BANK"). Checked BEFORE
      // the equity branch because indices may also carry instrument_type "EQ".
      indexBySymbol.set(i.tradingsymbol, i);
    } else if (i.exchange === "NSE" && i.instrument_type === "EQ") {
      eqBySymbol.set(i.tradingsymbol, i);
    }
  }

  const stocks: BoardItem[] = [];
  const indices: BoardItem[] = [];

  for (const [symbol, futs] of futuresByUnderlying) {
    const futures = futs
      .sort((a, b) => a.expiry.localeCompare(b.expiry))
      .slice(0, 3)
      .map((f) => ({
        token: f.instrument_token,
        expiry: f.expiry,
        lot_size: f.lot_size,
      }));

    const eq = eqBySymbol.get(symbol);
    if (eq) {
      stocks.push({
        symbol,
        name: eq.name,
        spot_token: eq.instrument_token,
        futures,
      });
      continue;
    }

    // Not an equity — try to resolve it as an index underlying.
    const indexTradingSymbol = INDEX_SPOT_MAP[symbol];
    const idx = indexTradingSymbol ? indexBySymbol.get(indexTradingSymbol) : undefined;
    if (idx) {
      indices.push({
        symbol,
        name: idx.tradingsymbol, // e.g. "NIFTY 50"
        spot_token: idx.instrument_token,
        futures,
        is_index: true,
      });
    }
    // else: unknown underlying with no spot → skip
  }

  stocks.sort((a, b) => a.symbol.localeCompare(b.symbol));
  indices.sort((a, b) => a.symbol.localeCompare(b.symbol));
  // Indices first, then stocks alphabetically.
  return [...indices, ...stocks];
}

interface FnoStock extends Instrument {
  fno_lot_size: number;
}

/**
 * Derive the list of F&O *stocks* from the full instrument dump.
 * Logic: every NFO futures contract's `name` is an underlying symbol. Match it
 * to an NSE EQ `tradingsymbol` to get the equity. Indices have no EQ row, so
 * they drop out, leaving only stocks.
 */
function deriveFnoStocks(all: Instrument[]): FnoStock[] {
  const underlyingLot = new Map<string, number>();
  const eqBySymbol = new Map<string, Instrument>();

  for (const i of all) {
    if (i.exchange === "NFO" && i.instrument_type === "FUT" && i.name) {
      // Prefer the nearest contract's lot size; keep the first seen.
      if (!underlyingLot.has(i.name)) underlyingLot.set(i.name, i.lot_size);
    } else if (i.exchange === "NSE" && i.instrument_type === "EQ") {
      eqBySymbol.set(i.tradingsymbol, i);
    }
  }

  const out: FnoStock[] = [];
  for (const [symbol, lot] of underlyingLot) {
    const eq = eqBySymbol.get(symbol);
    if (eq) out.push({ ...eq, fno_lot_size: lot });
  }
  out.sort((a, b) => a.tradingsymbol.localeCompare(b.tradingsymbol));
  return out;
}

async function getAllInstrumentsCached(): Promise<Instrument[]> {
  const fresh = instrumentCache && Date.now() - instrumentCache.at < CACHE_TTL_MS;
  if (fresh && instrumentCache) {
    return instrumentCache.data;
  }
  const data = await kite.getInstruments(); // full multi-exchange dump
  instrumentCache = { at: Date.now(), data };
  return data;
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof KiteError) {
    // An auth failure means the session is no longer valid — clear it (memory +
    // persisted) so the app reflects a logged-out state instead of restoring a
    // dead token on the next restart.
    if (err.status === 401 || err.status === 403) {
      kite.clearSession();
      void clearKiteSession();
    }
    res.status(err.status).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : "Unknown error";
  res.status(500).json({ error: message });
}

/**
 * After a login, immediately backfill any hourly/EOD slots missed while the
 * system was down. This is what guarantees a gap is recovered whenever the app
 * is turned on and logged in (the startup backfill is skipped when there is no
 * session yet, so this post-login trigger covers the "logged in later" case).
 */
function triggerPostLoginBackfill(): void {
  if (hourlyBackfillDeps) {
    console.log("[HourlyCapture] Login detected — backfilling any missed slots.");
    void backfillMissedHours(hourlyBackfillDeps).catch((e) =>
      console.error("[HourlyCapture] post-login backfill failed:", e),
    );
  }
  if (eodBackfillDeps) {
    void backfillStockFutures(eodBackfillDeps).catch((e) =>
      console.error("[EODCapture] post-login backfill failed:", e),
    );
    void checkAndRecomputeSummary();
  }
}

/** Persist the Zerodha access token so it survives a restart (best-effort). */
function persistKiteSession(session: {
  access_token: string;
  user_id: string;
  user_name: string;
}): void {
  void saveKiteSession({
    access_token: session.access_token,
    user_id: session.user_id,
    user_name: session.user_name,
    login_date: istDayKey(),
  }).catch((e) => console.warn("[Session] persist failed:", e));
}

/**
 * On startup, restore a persisted Zerodha session — but only if it was created
 * on the SAME IST day (Kite tokens expire daily, so a token from a previous day
 * is useless and is discarded). This is what keeps hourly/EOD capture and the
 * market_data recorder working after a restart/redeploy without re-login.
 */
async function restoreSessionOnStartup(): Promise<void> {
  try {
    const saved = await loadKiteSession();
    if (!saved) {
      console.log("[Session] No persisted Zerodha session found.");
      return;
    }
    if (saved.login_date !== istDayKey()) {
      console.log(
        `[Session] Persisted token is from ${saved.login_date} (stale) — daily Zerodha login required.`,
      );
      await clearKiteSession();
      return;
    }
    kite.setAccessToken(saved.access_token);
    console.log(
      `[Session] Restored today's Zerodha session for ${saved.user_name} (${saved.user_id}) — no re-login needed.`,
    );
  } catch (e) {
    console.warn("[Session] restore failed:", e);
  }
}

app.listen(PORT, () => {
  console.log(`Cal_Spread backend listening on http://localhost:${PORT}`);
  if (!process.env.KITE_API_KEY || !process.env.KITE_API_SECRET) {
    console.warn(
      "WARNING: KITE_API_KEY / KITE_API_SECRET are not set. Copy .env.example to .env and fill them in.",
    );
  }
  // Connect to MongoDB for trade persistence (no-op if MONGODB_URI is unset).
  void initDb().then(async () => {
    // Restore a same-day Zerodha session BEFORE the schedulers run, so hourly
    // capture / backfill have a session immediately after a restart.
    await restoreSessionOnStartup();
    // Start hourly price capture scheduler and backfill missed hours.
    hourlyBackfillDeps = {
      getBoard: async () => deriveFnoBoard(await getAllInstrumentsCached()),
      getLatestTick: (token: number) => tickerHub.getLatestTick(token),
      kite,
      getAllInstruments: getAllInstrumentsCached,
    };
    startHourlyScheduler(hourlyBackfillDeps);
    void backfillMissedHours(hourlyBackfillDeps);
    // End-of-day review (default 16:30 IST): verify today's full day is stored;
    // backfill the gaps if not.
    startDayReviewScheduler(hourlyBackfillDeps);
  });

  // Connect to the split nse_fno databases (archive, current, spread) and start EOD capture scheduler + backfill.
  void initNseFnoConnections().then(() => {
    eodBackfillDeps = {
      getBoard: async () => deriveFnoBoard(await getAllInstrumentsCached()),
      kite,
      getAllInstruments: getAllInstrumentsCached,
    };
    startEodScheduler(eodBackfillDeps);
    void backfillStockFutures(eodBackfillDeps);
    // Startup reconciliation: recompute summary if spread_daily has newer data.
    void checkAndRecomputeSummary();
  });
});
