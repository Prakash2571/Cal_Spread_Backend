import crypto from "node:crypto";

/**
 * Minimal Kite Connect v3 client implemented with native `fetch` and
 * `node:crypto` so it needs no external dependencies.
 *
 * Docs: https://kite.trade/docs/connect/v3/
 */

const KITE_API_ROOT = "https://api.kite.trade";
const KITE_LOGIN_ROOT = "https://kite.zerodha.com/connect/login";

export interface KiteConfig {
  apiKey: string;
  apiSecret: string;
}

export interface SessionData {
  access_token: string;
  user_id: string;
  user_name: string;
  email: string;
  // The API returns many more fields; we keep it open.
  [key: string]: unknown;
}

export interface Instrument {
  instrument_token: number;
  exchange_token: number;
  tradingsymbol: string;
  name: string;
  last_price: number;
  expiry: string;
  strike: number;
  tick_size: number;
  lot_size: number;
  instrument_type: string;
  segment: string;
  exchange: string;
}

export interface OhlcQuote {
  instrument_token: number;
  last_price: number;
  ohlc: { open: number; high: number; low: number; close: number };
}

/** Full quote fields we use: last price, day close, and open interest. */
export interface FullQuote {
  instrument_token: number;
  last_price: number;
  close: number;
  oi: number;
  /**
   * Exchange's own "when did this last trade" stamp, "YYYY-MM-DD HH:MM:SS" in IST,
   * or "" when Kite didn't send one (it is absent for some instruments).
   *
   * This is the only field in a /quote response that reveals whether the market is
   * actually OPEN. On an exchange holiday /quote answers with the previous session's
   * prices and OI and looks entirely normal — see isQuoteFromToday.
   */
  last_trade_time: string;
}

/** Extended full quote that also includes OHLC for EOD capture. */
export interface FullQuoteOhlc {
  instrument_token: number;
  last_price: number;
  open: number;
  high: number;
  low: number;
  close: number;
  oi: number;
}

/** Full historical candle data (OHLCV + OI). */
export interface HistoricalCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi: number;
}

/** Raw shape of a /quote entry (only the fields we read). */
interface RawFullQuote {
  instrument_token: number;
  last_price?: number;
  ohlc?: { open?: number; high?: number; low?: number; close?: number };
  oi?: number;
  last_trade_time?: string;
  /** Indices carry no last_trade_time; this is the equivalent stamp for them. */
  exchange_timestamp?: string;
}

/** Raw /quote entry including market depth (5 levels of bid/ask). */
interface RawDepthQuote {
  instrument_token: number;
  last_price?: number;
  depth?: {
    buy?: { price?: number; quantity?: number }[];
    sell?: { price?: number; quantity?: number }[];
  };
}

/** Best-bid / best-ask (plus last) for an instrument. */
export interface QuoteDepth {
  last: number;
  bid: number; // best bid (you SELL into this)
  ask: number; // best ask (you BUY at this)
}

/** One price level of the order book. */
export interface DepthLevel {
  price: number;
  qty: number;
}

/** Full 5-level order book (best first) + last price. */
export interface QuoteLadder {
  last: number;
  bids: DepthLevel[]; // buy side, best first
  asks: DepthLevel[]; // sell side, best first
}

/** One order line for the basket-margin request. */
export interface BasketOrder {
  exchange: string;
  tradingsymbol: string;
  transaction_type: "BUY" | "SELL";
  variety: string;
  product: string;
  order_type: string;
  quantity: number;
  price: number;
}

/**
 * One order line for the virtual contract note (POST /charges/orders).
 * Same shape as a basket order except the fill price is `average_price` (the
 * charges are computed on the executed value, not on a limit price).
 */
export interface ChargeOrder {
  order_id: string;
  exchange: string;
  tradingsymbol: string;
  transaction_type: "BUY" | "SELL";
  variety: string;
  product: string;
  order_type: string;
  quantity: number;
  average_price: number;
}

/**
 * The charge heads Zerodha bills per order, exactly as the virtual contract
 * note reports them. Every value is in rupees and already sided: Zerodha only
 * levies STT on the SELL leg of a futures trade and stamp duty only on the BUY
 * leg, so the zeroes in this breakdown are meaningful, not missing data.
 */
export interface OrderChargeBreakdown {
  /** STT (equity/F&O) or CTT (commodities). */
  transaction_tax: number;
  /** Which of the two the above is, as reported by Kite ("stt" / "ctt"). */
  transaction_tax_type: string;
  exchange_turnover_charge: number;
  sebi_turnover_charge: number;
  brokerage: number;
  stamp_duty: number;
  /** GST is 18% of (brokerage + exchange + SEBI), split igst / cgst+sgst. */
  gst: { igst: number; cgst: number; sgst: number; total: number };
  total: number;
}

/** A single order's charges, tied back to the order line we asked about. */
export interface OrderCharges {
  order_id: string;
  tradingsymbol: string;
  transaction_type: "BUY" | "SELL";
  quantity: number;
  price: number;
  charges: OrderChargeBreakdown;
  /**
   * The untouched `charges` object Kite returned. Persisted alongside the
   * parsed numbers so a new charge head Zerodha introduces is still on record
   * even though this parser doesn't know about it yet.
   */
  raw: unknown;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Read Kite's per-order charge object defensively.
 *
 * Every head is optional as far as this parser is concerned: charges are money,
 * so a shape change must degrade to "0 for that head" rather than NaN poisoning
 * the trade's P&L. `total` is taken from the response when present (Zerodha's
 * own rounding is the authority) and otherwise recomputed from the heads.
 */
function parseCharges(raw: unknown): OrderChargeBreakdown {
  const c = (raw ?? {}) as Record<string, unknown>;
  const gstRaw = (c.gst ?? {}) as Record<string, unknown>;

  const igst = num(gstRaw.igst);
  const cgst = num(gstRaw.cgst);
  const sgst = num(gstRaw.sgst);
  const gstTotal = num(gstRaw.total) || igst + cgst + sgst;

  const transaction_tax = num(c.transaction_tax);
  const exchange_turnover_charge = num(c.exchange_turnover_charge);
  const sebi_turnover_charge = num(c.sebi_turnover_charge);
  const brokerage = num(c.brokerage);
  const stamp_duty = num(c.stamp_duty);

  const total =
    num(c.total) ||
    transaction_tax +
      exchange_turnover_charge +
      sebi_turnover_charge +
      brokerage +
      stamp_duty +
      gstTotal;

  return {
    transaction_tax,
    transaction_tax_type:
      typeof c.transaction_tax_type === "string" ? c.transaction_tax_type : "",
    exchange_turnover_charge,
    sebi_turnover_charge,
    brokerage,
    stamp_duty,
    gst: { igst, cgst, sgst, total: gstTotal },
    total,
  };
}

export class KiteError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "KiteError";
    this.status = status;
  }
}

export class KiteClient {
  private apiKey: string;
  private apiSecret: string;
  private accessToken: string | null = null;

  constructor(config: KiteConfig) {
    if (!config.apiKey || !config.apiSecret) {
      throw new KiteError(
        "KITE_API_KEY and KITE_API_SECRET must be set in the environment (.env).",
        500,
      );
    }
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
  }

  /** Step 1: URL the user must visit to log in to Zerodha. */
  getLoginUrl(): string {
    const params = new URLSearchParams({ api_key: this.apiKey, v: "3" });
    return `${KITE_LOGIN_ROOT}?${params.toString()}`;
  }

  /**
   * Step 2/3: exchange the `request_token` returned on the redirect URL for an
   * `access_token`. The checksum is SHA-256(api_key + request_token + api_secret).
   */
  async generateSession(requestToken: string): Promise<SessionData> {
    if (!requestToken) {
      throw new KiteError("Missing request_token.", 400);
    }

    const checksum = crypto
      .createHash("sha256")
      .update(this.apiKey + requestToken + this.apiSecret)
      .digest("hex");

    const body = new URLSearchParams({
      api_key: this.apiKey,
      request_token: requestToken,
      checksum,
    });

    const res = await fetch(`${KITE_API_ROOT}/session/token`, {
      method: "POST",
      headers: {
        "X-Kite-Version": "3",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const json = (await res.json()) as {
      status: string;
      data?: SessionData;
      message?: string;
    };

    if (!res.ok || json.status !== "success" || !json.data) {
      throw new KiteError(
        json.message ?? `Failed to generate session (HTTP ${res.status}).`,
        res.status || 500,
      );
    }

    this.accessToken = json.data.access_token;
    return json.data;
  }

  /** Allow restoring a previously obtained access token (e.g. from a store). */
  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  hasSession(): boolean {
    return this.accessToken !== null;
  }

  /** The app's API key (public; needed for the WebSocket URL). */
  getApiKey(): string {
    return this.apiKey;
  }

  /** The current access token, or null if not yet authenticated. */
  getAccessToken(): string | null {
    return this.accessToken;
  }

  /** Forget the current session (logout). Subsequent calls require re-login. */
  clearSession(): void {
    this.accessToken = null;
  }

  private authHeader(): Record<string, string> {
    if (!this.accessToken) {
      throw new KiteError(
        "Not authenticated. Complete the Zerodha login flow first (/login).",
        401,
      );
    }
    return {
      "X-Kite-Version": "3",
      Authorization: `token ${this.apiKey}:${this.accessToken}`,
    };
  }

  /** Authenticated user profile (the /user/ docs endpoint). */
  async getProfile(): Promise<Record<string, unknown>> {
    const res = await fetch(`${KITE_API_ROOT}/user/profile`, {
      headers: this.authHeader(),
    });
    const json = (await res.json()) as {
      status: string;
      data?: Record<string, unknown>;
      message?: string;
    };
    if (!res.ok || json.status !== "success" || !json.data) {
      // A rejected/expired token means the session is dead — drop it.
      if (res.status === 401 || res.status === 403) this.clearSession();
      throw new KiteError(
        json.message ?? `Failed to fetch profile (HTTP ${res.status}).`,
        res.status || 500,
      );
    }
    return json.data;
  }

  /**
   * Fetch OHLC + last price for a set of instruments via REST.
   * Identifiers are "exchange:tradingsymbol" (e.g. "NSE:INFY", "NFO:INFY24JULFUT").
   * Works regardless of market hours (returns the latest available snapshot),
   * and handles the 500-instruments-per-request limit by chunking.
   */
  async getQuoteOhlc(identifiers: string[]): Promise<OhlcQuote[]> {
    const out: OhlcQuote[] = [];
    for (let i = 0; i < identifiers.length; i += 500) {
      const chunk = identifiers.slice(i, i + 500);
      const qs = chunk.map((id) => `i=${encodeURIComponent(id)}`).join("&");
      const res = await fetch(`${KITE_API_ROOT}/quote/ohlc?${qs}`, {
        headers: this.authHeader(),
      });
      const json = (await res.json()) as {
        status: string;
        data?: Record<string, OhlcQuote>;
        message?: string;
      };
      if (!res.ok || json.status !== "success" || !json.data) {
        if (res.status === 401 || res.status === 403) this.clearSession();
        throw new KiteError(
          json.message ?? `Failed to fetch quotes (HTTP ${res.status}).`,
          res.status || 500,
        );
      }
      for (const v of Object.values(json.data)) {
        if (v && typeof v.instrument_token === "number") out.push(v);
      }
    }
    return out;
  }

  /**
   * Full quote (/quote): includes last price, OHLC close AND open interest (oi)
   * for F&O instruments. Chunked at 500 identifiers per request.
   */
  async getQuoteFull(identifiers: string[]): Promise<FullQuote[]> {
    const out: FullQuote[] = [];
    for (let i = 0; i < identifiers.length; i += 500) {
      const chunk = identifiers.slice(i, i + 500);
      const qs = chunk.map((id) => `i=${encodeURIComponent(id)}`).join("&");
      const res = await fetch(`${KITE_API_ROOT}/quote?${qs}`, {
        headers: this.authHeader(),
      });
      const json = (await res.json()) as {
        status: string;
        data?: Record<string, RawFullQuote>;
        message?: string;
      };
      if (!res.ok || json.status !== "success" || !json.data) {
        if (res.status === 401 || res.status === 403) this.clearSession();
        throw new KiteError(
          json.message ?? `Failed to fetch quotes (HTTP ${res.status}).`,
          res.status || 500,
        );
      }
      for (const v of Object.values(json.data)) {
        if (v && typeof v.instrument_token === "number") {
          out.push({
            instrument_token: v.instrument_token,
            last_price: v.last_price ?? 0,
            close: v.ohlc?.close ?? 0,
            oi: v.oi ?? 0,
            // Prefer the trade stamp; fall back to the exchange stamp, which is
            // what an INDEX carries (the NIFTY spot has no "last trade").
            last_trade_time: v.last_trade_time ?? v.exchange_timestamp ?? "",
          });
        }
      }
    }
    return out;
  }

  /**
   * Full quote with OHLC (/quote): includes last price, full OHLC, and open
   * interest (oi) for F&O instruments. Used by the EOD capture scheduler.
   * Chunked at 500 identifiers per request.
   */
  async getQuoteFullOhlc(identifiers: string[]): Promise<FullQuoteOhlc[]> {
    const out: FullQuoteOhlc[] = [];
    for (let i = 0; i < identifiers.length; i += 500) {
      const chunk = identifiers.slice(i, i + 500);
      const qs = chunk.map((id) => `i=${encodeURIComponent(id)}`).join("&");
      const res = await fetch(`${KITE_API_ROOT}/quote?${qs}`, {
        headers: this.authHeader(),
      });
      const json = (await res.json()) as {
        status: string;
        data?: Record<string, RawFullQuote>;
        message?: string;
      };
      if (!res.ok || json.status !== "success" || !json.data) {
        if (res.status === 401 || res.status === 403) this.clearSession();
        throw new KiteError(
          json.message ?? `Failed to fetch quotes (HTTP ${res.status}).`,
          res.status || 500,
        );
      }
      for (const v of Object.values(json.data)) {
        if (v && typeof v.instrument_token === "number") {
          out.push({
            instrument_token: v.instrument_token,
            last_price: v.last_price ?? 0,
            open: v.ohlc?.open ?? 0,
            high: v.ohlc?.high ?? 0,
            low: v.ohlc?.low ?? 0,
            close: v.ohlc?.close ?? 0,
            oi: v.oi ?? 0,
          });
        }
      }
    }
    return out;
  }

  /**
   * Best bid/ask (market depth) per instrument, keyed by instrument_token.
   * Used to fill trades realistically: buy at ask, sell at bid.
   */
  async getQuoteDepth(identifiers: string[]): Promise<Map<number, QuoteDepth>> {
    const out = new Map<number, QuoteDepth>();
    for (let i = 0; i < identifiers.length; i += 500) {
      const chunk = identifiers.slice(i, i + 500);
      const qs = chunk.map((id) => `i=${encodeURIComponent(id)}`).join("&");
      const res = await fetch(`${KITE_API_ROOT}/quote?${qs}`, {
        headers: this.authHeader(),
      });
      const json = (await res.json()) as {
        status: string;
        data?: Record<string, RawDepthQuote>;
        message?: string;
      };
      if (!res.ok || json.status !== "success" || !json.data) {
        if (res.status === 401 || res.status === 403) this.clearSession();
        throw new KiteError(
          json.message ?? `Failed to fetch quotes (HTTP ${res.status}).`,
          res.status || 500,
        );
      }
      for (const v of Object.values(json.data)) {
        if (v && typeof v.instrument_token === "number") {
          const last = v.last_price ?? 0;
          const bid = v.depth?.buy?.[0]?.price ?? last;
          const ask = v.depth?.sell?.[0]?.price ?? last;
          out.set(v.instrument_token, { last, bid, ask });
        }
      }
    }
    return out;
  }

  /**
   * Full 5-level order book per instrument. Fills are taken at the touch (best
   * bid / best ask); the deeper levels are kept because they show the size
   * behind the quote.
   */
  async getQuoteLadder(identifiers: string[]): Promise<Map<number, QuoteLadder>> {
    const out = new Map<number, QuoteLadder>();
    for (let i = 0; i < identifiers.length; i += 500) {
      const chunk = identifiers.slice(i, i + 500);
      const qs = chunk.map((id) => `i=${encodeURIComponent(id)}`).join("&");
      const res = await fetch(`${KITE_API_ROOT}/quote?${qs}`, {
        headers: this.authHeader(),
      });
      const json = (await res.json()) as {
        status: string;
        data?: Record<string, RawDepthQuote>;
        message?: string;
      };
      if (!res.ok || json.status !== "success" || !json.data) {
        if (res.status === 401 || res.status === 403) this.clearSession();
        throw new KiteError(
          json.message ?? `Failed to fetch quotes (HTTP ${res.status}).`,
          res.status || 500,
        );
      }
      for (const v of Object.values(json.data)) {
        if (v && typeof v.instrument_token === "number") {
          const toLevels = (arr?: { price?: number; quantity?: number }[]) =>
            (arr ?? [])
              .map((l) => ({ price: l.price ?? 0, qty: l.quantity ?? 0 }))
              .filter((l) => l.price > 0);
          out.set(v.instrument_token, {
            last: v.last_price ?? 0,
            bids: toLevels(v.depth?.buy),
            asks: toLevels(v.depth?.sell),
          });
        }
      }
    }
    return out;
  }

  /**
   * Basket margin (/margins/basket): net margin for a set of orders, factoring
   * in hedge/spread benefits. Used to size a calendar spread's capital.
   */
  async getBasketMargin(
    orders: BasketOrder[],
  ): Promise<{ initial: number; final: number; total: number }> {
    const res = await fetch(
      `${KITE_API_ROOT}/margins/basket?consider_positions=true`,
      {
        method: "POST",
        headers: { ...this.authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify(orders),
      },
    );
    const json = (await res.json()) as {
      status: string;
      data?: { initial?: { total?: number }; final?: { total?: number } };
      message?: string;
    };
    if (!res.ok || json.status !== "success" || !json.data) {
      if (res.status === 401 || res.status === 403) this.clearSession();
      throw new KiteError(
        json.message ?? `Failed to fetch basket margin (HTTP ${res.status}).`,
        res.status || 500,
      );
    }
    const initial = json.data.initial?.total ?? 0;
    const final = json.data.final?.total ?? 0;
    return { initial, final, total: final || initial };
  }

  /**
   * Virtual contract note (/charges/orders): the exact brokerage and statutory
   * charges Zerodha would bill for a set of executed orders.
   *
   * This is the ONLY source of charge numbers in this app — we never reimplement
   * Zerodha's rate card locally, because the rates change (STT, stamp duty and
   * exchange slabs have all moved in recent years) and a stale local formula
   * would silently misstate every trade's P&L.
   *
   * Results come back in request order; we still carry each request's order_id
   * across so a caller can match a response to its leg without trusting order.
   */
  async getOrderCharges(orders: ChargeOrder[]): Promise<OrderCharges[]> {
    if (orders.length === 0) return [];

    const res = await fetch(`${KITE_API_ROOT}/charges/orders`, {
      method: "POST",
      headers: { ...this.authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify(orders),
    });

    const json = (await res.json()) as {
      status: string;
      data?: unknown;
      message?: string;
    };

    if (!res.ok || json.status !== "success" || !Array.isArray(json.data)) {
      if (res.status === 401 || res.status === 403) this.clearSession();
      throw new KiteError(
        json.message ?? `Failed to fetch order charges (HTTP ${res.status}).`,
        res.status || 500,
      );
    }

    const rows = json.data as Record<string, unknown>[];
    return rows.map((row, i) => {
      const req = orders[i];
      const chargesRaw = row?.charges;
      return {
        order_id:
          typeof row?.order_id === "string" && row.order_id
            ? row.order_id
            : (req?.order_id ?? String(i)),
        tradingsymbol:
          typeof row?.tradingsymbol === "string"
            ? row.tradingsymbol
            : (req?.tradingsymbol ?? ""),
        transaction_type:
          row?.transaction_type === "SELL" || row?.transaction_type === "BUY"
            ? row.transaction_type
            : (req?.transaction_type ?? "BUY"),
        quantity: num(row?.quantity) || (req?.quantity ?? 0),
        price: num(row?.price) || (req?.average_price ?? 0),
        charges: parseCharges(chargesRaw),
        raw: chargesRaw ?? null,
      };
    });
  }

  /**
   * Historical daily candles WITH open interest (oi=1) for one instrument.
   * Returns the day's close price and closing open interest per trading day.
   * `from`/`to` are "yyyy-mm-dd". Requires the historical-data subscription.
   */
  async getHistoricalOi(
    token: number,
    from: string,
    to: string,
  ): Promise<{ date: string; close: number; oi: number }[]> {
    const url =
      `${KITE_API_ROOT}/instruments/historical/${token}/day` +
      `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&oi=1`;
    const res = await fetch(url, { headers: this.authHeader() });
    const json = (await res.json()) as {
      status: string;
      data?: { candles?: unknown[][] };
      message?: string;
    };
    if (!res.ok || json.status !== "success" || !json.data?.candles) {
      if (res.status === 401 || res.status === 403) this.clearSession();
      throw new KiteError(
        json.message ?? `Failed to fetch historical data (HTTP ${res.status}).`,
        res.status || 500,
      );
    }
    return json.data.candles.map((c) => ({
      date: String(c[0] ?? "").slice(0, 10),
      close: Number(c[4] ?? 0),
      oi: Number(c[6] ?? 0),
    }));
  }

  /**
   * Historical daily candles with full OHLCV + OI data for one instrument.
   * Kite candle format: [timestamp, open, high, low, close, volume, oi].
   * `from`/`to` are "yyyy-mm-dd". Requires the historical-data subscription.
   */
  async getHistoricalFull(
    token: number,
    from: string,
    to: string,
    interval = "day",
  ): Promise<HistoricalCandle[]> {
    const url =
      `${KITE_API_ROOT}/instruments/historical/${token}/${interval}` +
      `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&oi=1`;
    const res = await fetch(url, { headers: this.authHeader() });
    const json = (await res.json()) as {
      status: string;
      data?: { candles?: unknown[][] };
      message?: string;
    };
    if (!res.ok || json.status !== "success" || !json.data?.candles) {
      if (res.status === 401 || res.status === 403) this.clearSession();
      throw new KiteError(
        json.message ?? `Failed to fetch historical data (HTTP ${res.status}).`,
        res.status || 500,
      );
    }
    return json.data.candles.map((c) => ({
      date: String(c[0] ?? "").slice(0, 10),
      open: Number(c[1] ?? 0),
      high: Number(c[2] ?? 0),
      low: Number(c[3] ?? 0),
      close: Number(c[4] ?? 0),
      volume: Number(c[5] ?? 0),
      oi: Number(c[6] ?? 0),
    }));
  }

  /**
   * Historical candles at any interval (e.g. "60minute" for hourly).
   * Returns the full timestamp + close price per candle.
   */
  async getHistorical(
    token: number,
    from: string,
    to: string,
    interval: string,
  ): Promise<{ t: string; close: number }[]> {
    const url =
      `${KITE_API_ROOT}/instruments/historical/${token}/${interval}` +
      `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const res = await fetch(url, { headers: this.authHeader() });
    const json = (await res.json()) as {
      status: string;
      data?: { candles?: unknown[][] };
      message?: string;
    };
    if (!res.ok || json.status !== "success" || !json.data?.candles) {
      if (res.status === 401 || res.status === 403) this.clearSession();
      throw new KiteError(
        json.message ?? `Failed to fetch historical data (HTTP ${res.status}).`,
        res.status || 500,
      );
    }
    return json.data.candles.map((c) => ({
      t: String(c[0] ?? ""),
      close: Number(c[4] ?? 0),
    }));
  }

  /**
   * Historical candles at any interval, keeping the FULL candle timestamp AND
   * open interest (oi=1). Unlike getHistoricalOi/getHistoricalFull (which slice
   * the timestamp down to the day), this preserves minute-resolution time so we
   * can reconstruct intraday OI series across days for the analytics frames.
   * Kite candle format: [timestamp, open, high, low, close, volume, oi].
   */
  async getHistoricalOiSeries(
    token: number,
    from: string,
    to: string,
    interval: string,
  ): Promise<{ t: string; close: number; oi: number }[]> {
    const url =
      `${KITE_API_ROOT}/instruments/historical/${token}/${interval}` +
      `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&oi=1`;
    const res = await fetch(url, { headers: this.authHeader() });
    const json = (await res.json()) as {
      status: string;
      data?: { candles?: unknown[][] };
      message?: string;
    };
    if (!res.ok || json.status !== "success" || !json.data?.candles) {
      if (res.status === 401 || res.status === 403) this.clearSession();
      throw new KiteError(
        json.message ?? `Failed to fetch historical data (HTTP ${res.status}).`,
        res.status || 500,
      );
    }
    return json.data.candles.map((c) => ({
      t: String(c[0] ?? ""),
      close: Number(c[4] ?? 0),
      oi: Number(c[6] ?? 0),
    }));
  }

  /**
   *
   * The instruments master is a static daily file. We try WITHOUT an access
   * token first (so you can get the stock list with no login). If Zerodha
   * rejects the unauthenticated request and we do have a session, we retry
   * with the Authorization header.
   */
  async getInstruments(exchange?: string): Promise<Instrument[]> {
    const url = exchange
      ? `${KITE_API_ROOT}/instruments/${encodeURIComponent(exchange)}`
      : `${KITE_API_ROOT}/instruments`;

    // Attempt 1: no access token (works for the public instruments dump).
    let res = await fetch(url, { headers: { "X-Kite-Version": "3" } });

    // Attempt 2: if blocked and we have a session, retry authenticated.
    if (!res.ok && this.accessToken) {
      res = await fetch(url, { headers: this.authHeader() });
    }

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401 || res.status === 403) {
        this.clearSession(); // token rejected → log out so state stays clean
        throw new KiteError(
          "Zerodha would not serve the instruments list without a session. " +
            "A one-time login is required (click “Connect to Zerodha”).",
          res.status,
        );
      }
      throw new KiteError(
        `Failed to fetch instruments (HTTP ${res.status}): ${text.slice(0, 200)}`,
        res.status || 500,
      );
    }

    const csv = await res.text();
    return parseInstrumentsCsv(csv);
  }
}

/** Parse the Kite instruments CSV into typed rows. */
export function parseInstrumentsCsv(csv: string): Instrument[] {
  const lines = csv.trim().split("\n");
  if (lines.length <= 1) return [];

  const header = splitCsvLine(lines[0]!);
  const idx = (key: string) => header.indexOf(key);

  const iToken = idx("instrument_token");
  const eToken = idx("exchange_token");
  const tSymbol = idx("tradingsymbol");
  const name = idx("name");
  const lastPrice = idx("last_price");
  const expiry = idx("expiry");
  const strike = idx("strike");
  const tickSize = idx("tick_size");
  const lotSize = idx("lot_size");
  const iType = idx("instrument_type");
  const segment = idx("segment");
  const exchange = idx("exchange");

  const rows: Instrument[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = splitCsvLine(line);
    rows.push({
      instrument_token: Number(c[iToken] ?? 0),
      exchange_token: Number(c[eToken] ?? 0),
      tradingsymbol: c[tSymbol] ?? "",
      name: c[name] ?? "",
      last_price: Number(c[lastPrice] ?? 0),
      expiry: c[expiry] ?? "",
      strike: Number(c[strike] ?? 0),
      tick_size: Number(c[tickSize] ?? 0),
      lot_size: Number(c[lotSize] ?? 0),
      instrument_type: c[iType] ?? "",
      segment: c[segment] ?? "",
      exchange: c[exchange] ?? "",
    });
  }
  return rows;
}

/** Split a single CSV line, honouring simple double-quote quoting. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
