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
      throw new KiteError(
        json.message ?? `Failed to fetch profile (HTTP ${res.status}).`,
        res.status || 500,
      );
    }
    return json.data;
  }

  /**
   * Fetch the full instrument dump (CSV) for an exchange and parse it.
   * Pass an exchange (e.g. "NSE") to limit the dump, or omit for everything.
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
