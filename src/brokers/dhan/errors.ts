/**
 * Typed DhanHQ errors.
 *
 * The point of typing these is that the ORDER path must be able to distinguish
 * three outcomes that all look like "the request failed":
 *
 *   1. DEFINITIVELY REJECTED — Dhan received it, understood it, and said no. Safe
 *      to record as REJECTED and move on.
 *   2. AMBIGUOUS — a timeout, a 5xx, or a 429. The order may or may not exist at
 *      the exchange. Re-submitting could create a DUPLICATE LEG, so it must never
 *      happen; the caller has to reconcile by correlation id instead.
 *   3. AUTH — the session is gone. Retrying is pointless until re-login.
 *
 * Collapsing (1) and (2) is the single most dangerous simplification available
 * here, so the distinction is a type rather than a convention (see `isDefinitive`).
 */

/** Base class for every Dhan transport/API failure. */
export class DhanError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when the request never produced a response. */
    readonly status: number,
    /** Dhan's own error code when the body carried one. */
    readonly code: string | null = null,
    /** The raw body, retained for logs. Never contains credentials. */
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "DhanError";
  }

  /**
   * Whether Dhan definitively processed and refused the request.
   *
   * A 4xx that is NOT 429 means Dhan understood the request and declined it. A
   * 429 is excluded deliberately: it means "not now", which tells us nothing about
   * whether an earlier identical attempt landed.
   */
  get isDefinitive(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

/** The session is missing, expired or rejected (401/403). */
export class DhanAuthError extends DhanError {
  constructor(message: string, status = 401, code: string | null = null, body: unknown = null) {
    super(message, status, code, body);
    this.name = "DhanAuthError";
  }
}

/** Rate limited (429). Ambiguous for writes; safe to retry for reads. */
export class DhanRateLimitError extends DhanError {
  constructor(
    message: string,
    /** Seconds Dhan asked us to wait, when it said. */
    readonly retryAfterSec: number | null = null,
    body: unknown = null,
  ) {
    super(message, 429, "RATE_LIMIT", body);
    this.name = "DhanRateLimitError";
  }
}

/**
 * The request never produced a usable response: timeout, abort, DNS, socket error.
 *
 * ALWAYS ambiguous for a write. This is the case that must never be blindly
 * retried on order submission.
 */
export class DhanNetworkError extends DhanError {
  constructor(message: string, body: unknown = null) {
    super(message, 0, "NETWORK", body);
    this.name = "DhanNetworkError";
  }
}

/**
 * Live trading is blocked by a configuration precondition — most importantly the
 * static-IP whitelist Dhan requires for order placement.
 *
 * Its own type so the order path FAILS CLOSED rather than attempting a call that
 * would be refused at the edge, and so the operator sees the real reason.
 */
export class DhanTradingBlockedError extends DhanError {
  constructor(message: string) {
    super(message, 0, "TRADING_BLOCKED", null);
    this.name = "DhanTradingBlockedError";
  }
}

/**
 * Normalize whatever Dhan returned into one of the classes above.
 *
 * Dhan is not perfectly consistent about error envelopes — some responses carry
 * `errorCode`/`errorMessage`, some `errorType`, some just an HTTP status — so this
 * probes the shapes it is known to use and falls back to the status alone.
 */
export function normalizeDhanError(status: number, body: unknown, fallback: string): DhanError {
  const record = (body ?? {}) as Record<string, unknown>;
  const code =
    typeof record.errorCode === "string"
      ? record.errorCode
      : typeof record.error_code === "string"
        ? record.error_code
        : typeof record.errorType === "string"
          ? record.errorType
          : null;
  const message =
    (typeof record.errorMessage === "string" && record.errorMessage) ||
    (typeof record.error_message === "string" && record.error_message) ||
    (typeof record.message === "string" && record.message) ||
    fallback;

  if (status === 401 || status === 403) {
    return new DhanAuthError(message, status, code, body);
  }
  if (status === 429) {
    return new DhanRateLimitError(message, null, body);
  }
  return new DhanError(message, status, code, body);
}

/**
 * Whether a failed request is safe to retry.
 *
 * Reads only. The caller decides; this just encodes the rule in one place so a
 * future endpoint cannot accidentally inherit write-unsafe retry behaviour.
 */
export function isRetryableRead(err: unknown): boolean {
  if (err instanceof DhanAuthError) return false;
  if (err instanceof DhanRateLimitError) return true;
  if (err instanceof DhanNetworkError) return true;
  if (err instanceof DhanError) return err.status >= 500;
  return false;
}
