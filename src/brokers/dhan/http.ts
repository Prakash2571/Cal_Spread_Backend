/**
 * DhanHQ v2 HTTP transport.
 *
 * Owns exactly four concerns, so no endpoint has to re-implement them:
 *   - bounded deadlines (AbortController; `fetch` has no timeout of its own)
 *   - request pacing / rate limiting
 *   - error normalization into the typed classes in errors.ts
 *   - retry policy — READS ONLY
 *
 * THE RETRY RULE IS THE IMPORTANT PART
 * `request()` never retries. `read()` retries a safe subset. `write()` exists as a
 * separate method purely so that "this is a mutation, do not retry it" is visible
 * at every call site rather than being a comment somebody might not read. Blindly
 * re-POSTing an order that timed out is how a four-leg box becomes an eight-leg
 * position, so the transport refuses to make that mistake possible.
 */

import {
  DhanAuthError,
  DhanError,
  DhanNetworkError,
  DhanRateLimitError,
  isRetryableRead,
  normalizeDhanError,
} from "./errors.js";

export const DHAN_API_ROOT = "https://api.dhan.co/v2";
export const DHAN_AUTH_ROOT = "https://auth.dhan.co";

/** The instrument master. Public (no auth), served as CSV. */
export const DHAN_SCRIP_MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master-detailed.csv";
/** Fallback layout, used when the detailed master is unavailable. */
export const DHAN_SCRIP_MASTER_FALLBACK_URL = "https://images.dhan.co/api-data/api-scrip-master.csv";

export interface DhanHttpConfig {
  /** Reads the current access token, or null when there is no session. */
  accessToken: () => string | null;
  /** The Dhan client id, required by several data endpoints. */
  clientId: () => string;
  /** Per-request deadline (ms). */
  timeoutMs: number;
  /** Minimum gap between requests (ms) — a simple, predictable pacer. */
  minIntervalMs: number;
  /** Attempts for a RETRYABLE READ, including the first. 1 disables retrying. */
  maxReadAttempts: number;
}

export function dhanHttpConfigFromEnv(overrides: Partial<DhanHttpConfig> = {}): DhanHttpConfig {
  const num = (name: string, fallback: number, min: number, max: number): number => {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const v = Number(raw);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, Math.round(v)));
  };
  return {
    accessToken: () => null,
    clientId: () => process.env.DHAN_CLIENT_ID?.trim() ?? "",
    timeoutMs: num("DHAN_HTTP_TIMEOUT_MS", 8_000, 500, 60_000),
    minIntervalMs: num("DHAN_MIN_INTERVAL_MS", 120, 0, 5_000),
    maxReadAttempts: num("DHAN_MAX_READ_ATTEMPTS", 3, 1, 6),
    ...overrides,
  };
}

interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  /**
   * Send the `client-id` header. Several data endpoints require it; the order
   * endpoints carry `dhanClientId` in the JSON body instead.
   */
  withClientId?: boolean;
  /** Absolute URL override (used for the auth host and the scrip master). */
  absoluteUrl?: string;
  /** Extra headers — used only by the auth flow's app_id/app_secret pair. */
  headers?: Record<string, string>;
  /** Skip the Authorization header (auth + public endpoints). */
  anonymous?: boolean;
}

export class DhanHttp {
  /**
   * Serialized pacing tail.
   *
   * Every request chains onto the previous one and then waits out the residual
   * interval, which gives a predictable request rate without a token bucket. Dhan
   * publishes per-endpoint limits; pacing conservatively at the transport keeps us
   * clear of them without each endpoint tracking its own budget.
   */
  private tail: Promise<unknown> = Promise.resolve();
  private lastAt = 0;

  constructor(private cfg: DhanHttpConfig) {}

  /** Swap in a new token reader (used when a session is established or cleared). */
  setAccessTokenReader(reader: () => string | null): void {
    this.cfg = { ...this.cfg, accessToken: reader };
  }

  private headersFor(opts: RequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    };
    if (!opts.anonymous) {
      const token = this.cfg.accessToken();
      if (!token) {
        throw new DhanAuthError("No Dhan session: connect Dhan before calling its API.");
      }
      // Dhan v2 authenticates with a bare `access-token` header, not a Bearer scheme.
      headers["access-token"] = token;
    }
    if (opts.withClientId) {
      const clientId = this.cfg.clientId();
      if (!clientId) {
        throw new DhanError("DHAN_CLIENT_ID is not configured.", 0, "CONFIG");
      }
      headers["client-id"] = clientId;
    }
    return headers;
  }

  /**
   * One attempt. Never retries — the retry decision belongs to the caller, which
   * is the only place that knows whether the call is a read or a mutation.
   */
  async request<T>(opts: RequestOptions): Promise<T> {
    const headers = this.headersFor(opts);
    const url = opts.absoluteUrl ?? `${DHAN_API_ROOT}${opts.path}`;

    const run = async (): Promise<T> => {
      const gap = this.cfg.minIntervalMs - (Date.now() - this.lastAt);
      if (gap > 0) await sleep(gap);
      this.lastAt = Date.now();

      // `fetch` has no timeout, so an unresponsive socket would hang forever and
      // wedge the pacing tail behind it.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
      let res: Response;
      try {
        res = await fetch(url, {
          method: opts.method,
          headers,
          signal: controller.signal,
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        });
      } catch (err) {
        // Abort, DNS failure, socket reset — no response, so for a mutation the
        // outcome is genuinely UNKNOWN.
        const reason = err instanceof Error && err.name === "AbortError"
          ? `Dhan request timed out after ${this.cfg.timeoutMs}ms (${opts.method} ${opts.path})`
          : `Dhan request failed (${opts.method} ${opts.path}): ${err instanceof Error ? err.message : String(err)}`;
        throw new DhanNetworkError(reason);
      } finally {
        clearTimeout(timer);
      }

      const text = await res.text().catch(() => "");
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          // A non-JSON body on an error status is normal (gateway HTML, etc).
          parsed = { message: text.slice(0, 500) };
        }
      }

      if (!res.ok) {
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get("retry-after"));
          throw new DhanRateLimitError(
            `Dhan rate limit hit (${opts.method} ${opts.path}).`,
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
            parsed,
          );
        }
        throw normalizeDhanError(
          res.status,
          parsed,
          `Dhan API error ${res.status} (${opts.method} ${opts.path}).`,
        );
      }

      // Dhan sometimes wraps a failure in a 200 with a status field. Treat that as
      // an error rather than returning an empty success to the caller.
      const record = (parsed ?? {}) as Record<string, unknown>;
      if (typeof record.status === "string" && record.status.toLowerCase() === "failed") {
        throw normalizeDhanError(400, parsed, `Dhan API reported failure (${opts.path}).`);
      }
      return parsed as T;
    };

    // Chain onto the tail so requests are paced rather than bursting.
    const scheduled = this.tail.then(run, run);
    this.tail = scheduled.catch(() => undefined);
    return scheduled;
  }

  /**
   * A READ, with bounded retries for transient failures.
   *
   * Safe because a read has no side effects: repeating it can waste a request but
   * cannot create an order or move a position.
   */
  async read<T>(opts: Omit<RequestOptions, "method"> & { method?: "GET" | "POST" }): Promise<T> {
    const method = opts.method ?? "GET";
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= this.cfg.maxReadAttempts; attempt++) {
      try {
        return await this.request<T>({ ...opts, method });
      } catch (err) {
        lastErr = err;
        if (!isRetryableRead(err) || attempt === this.cfg.maxReadAttempts) throw err;
        // Honour Retry-After when Dhan supplied one; otherwise linear backoff.
        const waitMs = err instanceof DhanRateLimitError && err.retryAfterSec
          ? Math.min(10_000, err.retryAfterSec * 1000)
          : attempt * 300;
        await sleep(waitMs);
      }
    }
    throw lastErr;
  }

  /**
   * A MUTATION. Exactly one attempt, always.
   *
   * Named separately from `request` so that every order-placing call site reads as
   * a deliberate single shot. If this throws a `DhanNetworkError` or a
   * `DhanRateLimitError`, the outcome is UNKNOWN and the caller MUST reconcile
   * (by correlation id) rather than submit again.
   */
  async write<T>(opts: Omit<RequestOptions, "method"> & { method: "POST" | "PUT" | "DELETE" }): Promise<T> {
    return this.request<T>(opts);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
