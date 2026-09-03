/**
 * Broker identity and the broker-neutral runtime contracts.
 *
 * THE ONE CANONICAL BROKER TYPE
 * `BrokerId` is the single discriminator used everywhere a record, a request or a
 * runtime needs to say WHICH venue it belongs to. It is deliberately declared
 * here — outside both `src/kite.ts` and `src/brokers/dhan/*` — so neither broker
 * implementation is the definition of "broker", and so the Box strategy can
 * import the identity without importing a transport.
 *
 * THE CENTRAL ARCHITECTURAL RULE
 * Exactly ONE broker may own the active market-data feed, the scanner, Box
 * execution, the order manager and reconciliation at any instant. Historical
 * trades from both brokers coexist in the database forever; only one broker ever
 * creates or monitors new ones. That rule is enforced by ActiveBrokerManager
 * (see registry.ts), not by convention.
 *
 * LEGACY DATA
 * Every document written before broker identity existed was, by construction, a
 * Zerodha trade — that is the only broker the application ever had. So an absent
 * `broker` field resolves to "zerodha" (`brokerOf`), exactly as an absent
 * `direction` resolves to LONG_BOX. No destructive migration is needed to boot.
 */

/** The only two brokers this application knows about. */
export type BrokerId = "zerodha" | "dhan";

export const BROKER_IDS: readonly BrokerId[] = ["zerodha", "dhan"] as const;

/**
 * The broker every record written before broker identity existed belongs to.
 *
 * Zerodha was the only integration that had ever run, so this is a statement of
 * historical fact rather than a convenient default.
 */
export const LEGACY_BROKER: BrokerId = "zerodha";

export function isBrokerId(value: unknown): value is BrokerId {
  return value === "zerodha" || value === "dhan";
}

/**
 * Resolve the broker of a record that may predate broker identity.
 *
 * The single reader used by serializers, adoption and reconciliation, so the
 * legacy default lives in exactly one place.
 */
export function brokerOf(record: { broker?: BrokerId | null } | null | undefined): BrokerId {
  const value = record?.broker;
  return isBrokerId(value) ? value : LEGACY_BROKER;
}

/** Human-facing label for badges and log lines. */
export function brokerLabel(broker: BrokerId): string {
  return broker === "dhan" ? "DHAN" : "ZERODHA";
}

/**
 * Parse a broker supplied by an API client.
 *
 * Returns null for anything unrecognised so the caller can answer 400 rather
 * than silently falling back to a broker the operator did not ask for. Silently
 * defaulting here is precisely how a request meant for Dhan would end up placing
 * Zerodha orders.
 */
export function parseBrokerId(value: unknown): BrokerId | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return isBrokerId(v) ? v : null;
}

/* ---------------------------- runtime contracts ---------------------------- */

/**
 * Session/authentication state of one broker, as the UI and the guards see it.
 *
 * `authenticated` means THE BROKER SESSION IS USABLE — never merely that an
 * admin password was accepted. Showing "Connected" for a verified admin with no
 * broker session is the specific lie this shape exists to prevent.
 */
export interface BrokerSessionState {
  broker: BrokerId;
  authenticated: boolean;
  /** Broker-side account identity, when the session exposes one. */
  client_id: string | null;
  client_name: string | null;
  /** Epoch ms at which the access token stops working, when the broker tells us. */
  token_expires_at: number | null;
  /** True once the token is known to be past its expiry. */
  token_expired: boolean;
  /** IST day the session was established, for daily-token brokers. */
  login_day: string | null;
  login_at: number | null;
}

/**
 * Readiness of one broker, split by CAPABILITY rather than reported as a single
 * boolean.
 *
 * Data and trading fail independently: Dhan order placement requires static-IP
 * whitelisting that market data does not, so a deployment can legitimately be
 * data-ready and trading-blocked. Collapsing these would either block harmless
 * reads or — far worse — let live orders through on a box that cannot place them.
 */
export interface BrokerHealthState {
  broker: BrokerId;
  authenticated: boolean;
  token_expires_at: number | null;
  token_expired: boolean;
  /** Quote/history/instrument access is usable. */
  data_ready: boolean;
  /** Live order placement is permitted AND possible. */
  trading_ready: boolean;
  /**
   * Whether the broker's static-IP requirement is satisfied.
   *
   * `null` for brokers that have no such requirement (Zerodha), so "not
   * applicable" is never confused with "not configured".
   */
  static_ip_configured: boolean | null;
  /** Live feed connection state. */
  feed_connected: boolean;
  /** Newest tick age (ms) across the active subscription set, or null. */
  feed_age_ms: number | null;
  /** Operator-facing reasons, e.g. "Static IP not configured". */
  problems: string[];
}

/** Interval identifiers the history provider accepts, broker-neutral. */
export type HistoryInterval = "minute" | "3minute" | "5minute" | "15minute" | "30minute" | "60minute" | "day";

/**
 * A single broker's fully-assembled runtime.
 *
 * The Box strategy and the HTTP layer consume THIS, never a concrete broker
 * client. Swapping the active broker is swapping this object — which is why the
 * mutual-exclusion rule is enforceable at all.
 */
export interface BrokerRuntime {
  readonly id: BrokerId;
  /** Session/authentication state. */
  session(): BrokerSessionState;
  /** Capability readiness. */
  health(): BrokerHealthState;
  /** Stop the feed, drop subscriptions and release broker-specific caches. */
  shutdown(): Promise<void>;
}
