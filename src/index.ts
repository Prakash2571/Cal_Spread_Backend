import "dotenv/config";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { KiteClient, KiteError, type Instrument } from "./kite.js";
import { connectTicker } from "./ticker.js";
import { getDividendYields } from "./yahoo.js";

const PORT = Number(process.env.PORT ?? 3001);
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";

const kite = new KiteClient({
  apiKey: process.env.KITE_API_KEY ?? "",
  apiSecret: process.env.KITE_API_SECRET ?? "",
});

// In-memory cache of the instrument dump so we don't re-download the (large)
// CSV on every frontend request. Kite refreshes instruments once a day.
let instrumentCache: { at: number; data: Instrument[] } | null = null;
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour

// Dividend yields (%) from Yahoo, refreshed once a day.
let dividendCache: { at: number; data: Record<string, number> } | null = null;
const DIVIDEND_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

const app = express();

// --- CORS (so the Vite frontend can call this API) ---
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header("Access-Control-Allow-Origin", FRONTEND_URL);
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json());

// --- Health check ---
app.get("/", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    authenticated: kite.hasSession(),
    hint: "Visit /login to authenticate with Zerodha.",
  });
});

// --- Step 1: send the user to Zerodha's login page ---
app.get("/login", (_req: Request, res: Response) => {
  res.redirect(kite.getLoginUrl());
});

// --- Step 2/3 (frontend-driven): the frontend receives the request_token at
// its registered redirect URL (e.g. http://localhost:5173/zerodha/verify)
// and POSTs it here so the backend can do the secret checksum exchange. ---
app.post("/api/session", async (req: Request, res: Response) => {
  const requestToken = String(req.body?.request_token ?? "");
  if (!requestToken) {
    res.status(400).json({ error: "Missing request_token." });
    return;
  }
  try {
    const session = await kite.generateSession(requestToken);
    console.log(`Authenticated as ${session.user_name} (${session.user_id}).`);
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
    res.redirect(`${FRONTEND_URL}/?auth=success`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Session generation failed:", message);
    res.redirect(`${FRONTEND_URL}/?auth=failed`);
  }
});

// --- Logout: forget the stored Kite session. ---
app.post("/api/logout", (_req: Request, res: Response) => {
  kite.clearSession();
  res.json({ authenticated: false });
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

// --- Snapshot quotes (REST): last price + close for the given tokens.
// Works regardless of market hours, so prices/premiums show even after close. ---
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

  try {
    const all = await getAllInstrumentsCached();
    const byToken = new Map<number, string>();
    for (const inst of all) {
      byToken.set(inst.instrument_token, `${inst.exchange}:${inst.tradingsymbol}`);
    }
    const identifiers = tokens
      .map((t) => byToken.get(t))
      .filter((s): s is string => typeof s === "string");

    const quotes = await kite.getQuoteOhlc(identifiers);
    const ticks = quotes.map((q) => ({
      token: q.instrument_token,
      last_price: q.last_price,
      close_price: q.ohlc?.close ?? 0,
    }));
    res.json({ ticks });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Live data: Server-Sent Events stream of ticks for the given tokens. ---
// The backend opens a Kite WebSocket (using the stored access token), parses
// the binary ticks, and relays them to the browser as JSON SSE events.
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

  const ticker = connectTicker({
    apiKey: kite.getApiKey(),
    accessToken,
    tokens,
    onTick: (ticks) => {
      res.write(`data: ${JSON.stringify(ticks)}\n\n`);
    },
    onError: (message) => {
      // A WebSocket auth rejection means the token is dead — log out.
      kite.clearSession();
      res.write(`event: kite_error\ndata: ${JSON.stringify({ message })}\n\n`);
    },
  });

  // Keep the connection alive through proxies.
  const keepAlive = setInterval(() => res.write(`: ping\n\n`), 20000);

  req.on("close", () => {
    clearInterval(keepAlive);
    ticker.close();
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
    const symbols = deriveFnoBoard(all).map((b) => b.symbol);
    const yields = await getDividendYields(symbols);
    dividendCache = { at: Date.now(), data: yields };
    res.json({ yields, cachedAt: dividendCache.at });
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
}

/** Build the full F&O board: each underlying with its spot + 3 nearest futures. */
function deriveFnoBoard(all: Instrument[]): BoardItem[] {
  const futuresByUnderlying = new Map<string, Instrument[]>();
  const eqBySymbol = new Map<string, Instrument>();

  for (const i of all) {
    if (i.exchange === "NFO" && i.instrument_type === "FUT" && i.name) {
      const arr = futuresByUnderlying.get(i.name) ?? [];
      arr.push(i);
      futuresByUnderlying.set(i.name, arr);
    } else if (i.exchange === "NSE" && i.instrument_type === "EQ") {
      eqBySymbol.set(i.tradingsymbol, i);
    }
  }

  const out: BoardItem[] = [];
  for (const [symbol, futs] of futuresByUnderlying) {
    const eq = eqBySymbol.get(symbol);
    if (!eq) continue; // skip indices (no NSE equity)
    const futures = futs
      .sort((a, b) => a.expiry.localeCompare(b.expiry))
      .slice(0, 3)
      .map((f) => ({
        token: f.instrument_token,
        expiry: f.expiry,
        lot_size: f.lot_size,
      }));
    out.push({
      symbol,
      name: eq.name,
      spot_token: eq.instrument_token,
      futures,
    });
  }
  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return out;
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
    // An auth failure means the session is no longer valid — clear it so the
    // app reflects a logged-out state instead of staying half-broken.
    if (err.status === 401 || err.status === 403) kite.clearSession();
    res.status(err.status).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : "Unknown error";
  res.status(500).json({ error: message });
}

app.listen(PORT, () => {
  console.log(`Cal_Spread backend listening on http://localhost:${PORT}`);
  if (!process.env.KITE_API_KEY || !process.env.KITE_API_SECRET) {
    console.warn(
      "WARNING: KITE_API_KEY / KITE_API_SECRET are not set. Copy .env.example to .env and fill them in.",
    );
  }
});
