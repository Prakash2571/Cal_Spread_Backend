/**
 * ActiveBrokerManager — the single authority on which broker owns the system.
 *
 * THE INVARIANT IT EXISTS TO ENFORCE
 * Exactly ONE broker at a time owns the market-data feed, the scanner, Box
 * execution, positions, reconciliation, margins and charges. Historical trades from
 * both brokers coexist in the database forever; only one broker ever creates or
 * monitors new ones.
 *
 * That is not achievable by convention. Two feeds can physically both be connected,
 * two adapters can both hold a session, and stale depth from a previous broker looks
 * exactly like current depth to the scanner. So the rule is enforced structurally:
 *
 *   - Everything broker-specific is reachable only through `runtime()`, which
 *     returns ONE runtime. There is no way to ask for "the Dhan feed" while Zerodha
 *     is active.
 *   - A switch is a guarded, ordered transition (`switchBroker`) that refuses while
 *     exposure exists and, when it proceeds, TEARS DOWN the old broker before the
 *     new one is reachable.
 *   - Books never survive a switch. `stop()` on each feed discards its quote state,
 *     and the Box quote store is cleared, so Zerodha depth can never price a Dhan
 *     decision.
 *
 * WHY SWITCHING IS REFUSED RATHER THAN QUEUED
 * A switch while a box is open would leave a real position monitored by the wrong
 * feed and reconciled against the wrong order-id space. There is no safe automatic
 * resolution, so the operator is told what to close first (HTTP 409) instead of the
 * system guessing.
 */

import type { Instrument, KiteClient } from "../kite.js";
import type { TickerHub } from "../hub.js";
import type { BrokerAdapter } from "../box/brokerAdapter.js";
import type {
  BoxBasketMargin,
  BoxMarginOrder,
  BoxMarginProvider,
  BoxMarginSource,
  BoxMarketDataProvider,
  BoxRestQuote,
} from "../box/brokerContext.js";
import { BROKER_IDS, type BrokerHealthState, type BrokerId, type BrokerSessionState } from "./types.js";
import { createZerodhaLiveAdapter } from "./zerodha/liveAdapter.js";
import { DhanClient, extractIpv4Addresses, normalizeDhanMultiMargin } from "./dhan/client.js";
import { DhanHttp, dhanHttpConfigFromEnv } from "./dhan/http.js";
import { DhanFeed } from "./dhan/feed.js";
import { DhanInstrumentStore, dhanInternalToken, type DhanInstrument } from "./dhan/instruments.js";
import { DhanChargeCalculator } from "./dhan/charges.js";
import { DhanBrokerAdapter, dhanAdapterConfigFromBoxConfig } from "../box/dhanBrokerAdapter.js";
import {
  consumeDhanConsent,
  generateDhanConsent,
  isDhanTokenExpired,
  readDhanCredentials,
  type DhanAppCredentials,
} from "./dhan/auth.js";
import { dhanSegmentFor, type DhanExchangeSegment } from "./dhan/segments.js";
import {
  clearDhanSession,
  loadActiveBroker,
  loadDhanSession,
  saveActiveBroker,
  saveDhanSession,
} from "../db.js";
import type { BoxConfig } from "../box/config.js";
import { DhanError } from "./dhan/errors.js";

/** Why a broker switch was refused. Each maps to something the operator can fix. */
export type SwitchBlockReason =
  | "scanner_running"
  | "open_box_positions"
  | "working_orders"
  | "execution_in_flight"
  | "unresolved_reconciliation"
  | "residual_exposure"
  | "unknown_order_state"
  | "foreign_unresolved_intents"
  | "broker_not_configured";

export interface SwitchBlocker {
  reason: SwitchBlockReason;
  detail: string;
}

/**
 * What the manager needs to inspect before allowing a switch.
 *
 * Injected as a callback bundle rather than importing the engine, which would be a
 * circular dependency (the engine consumes the manager's providers).
 */
export interface ExposureProbe {
  scannerRunning: () => boolean;
  openPositionCount: () => number;
  /** Distinct brokers currently holding open positions. */
  brokersWithOpenPositions: () => BrokerId[];
  workingOrderCount: () => number;
  executionInFlight: () => boolean;
  reconciliationComplete: () => boolean;
  residualLegCount: () => number;
  unknownOrderCount: () => number;
  /**
   * Unresolved durable order intents belonging to a broker.
   *
   * Broker-scoped because an intent may only ever be reconciled through the broker
   * that created it — Dhan and Zerodha order ids are unrelated identifier spaces, so
   * a cross-broker lookup either 404s (misread as "never existed") or, far worse,
   * collides with an unrelated real order.
   */
  unresolvedIntentsFor: (broker: BrokerId) => Promise<number>;
}

/** Teardown/startup hooks the manager drives during a switch. */
export interface SwitchHooks {
  /** Stop discovery. Must not throw. */
  stopScanner: () => void;
  /** Drop every cached quote/depth book and bump the feed generation. */
  invalidateBooks: () => void;
  /** Reload the instrument universe for the newly active broker. */
  reloadUniverse: () => Promise<void>;
  /** Re-publish state to every SSE client. */
  publish: () => void;
}

export interface ActiveBrokerManagerDeps {
  kite: KiteClient;
  tickerHub: TickerHub;
  boxConfig: () => BoxConfig;
  istDayKey: (at?: number) => string;
  /** Applied to Dhan ticks so they reach the Box quote store and SSE consumers. */
  onDhanTicks: (ticks: Parameters<TickerHub["seed"]>[0]) => void;
  onDhanConnection?: (connected: boolean) => void;
  onSessionLost?: (broker: BrokerId, reason: string) => void;
}

export class ActiveBrokerManager {
  private active: BrokerId = "zerodha";
  private probe: ExposureProbe | null = null;
  private hooks: SwitchHooks | null = null;

  /* ---- Dhan runtime pieces, constructed once and reused ---- */
  private dhanHttp: DhanHttp;
  private dhanClient: DhanClient;
  private dhanInstruments = new DhanInstrumentStore();
  private dhanCharges = new DhanChargeCalculator();
  private dhanFeed: DhanFeed | null = null;
  private dhanAccessToken: string | null = null;
  private dhanTokenExpiry: number | null = null;
  private dhanSessionMeta: {
    clientId: string;
    clientName: string;
    clientUcc: string;
    powerOfAttorney: boolean;
    loginDay: string;
    loginAt: number;
  } | null = null;
  private dhanProblems: string[] = [];
  /** Provenance of the most recent margin figure, for the status endpoints. */
  private lastMarginSource: BoxMarginSource | null = null;
  /**
   * Static-IP verification verdict: true (matched), false (mismatch/unreachable),
   * null (never checked, or no IP configured to check).
   *
   * `null` is NOT treated as ready when an IP is configured — see dhanStaticIpReady.
   */
  private dhanIpVerified: boolean | null = null;
  private dhanIpPrimary: string | null = null;
  private dhanIpSecondary: string | null = null;
  private dhanIpCheckedAt: number | null = null;
  private dhanIpError: string | null = null;

  constructor(private deps: ActiveBrokerManagerDeps) {
    this.dhanHttp = new DhanHttp(
      dhanHttpConfigFromEnv({
        accessToken: () => this.usableDhanToken(),
        clientId: () => this.dhanSessionMeta?.clientId ?? process.env.DHAN_CLIENT_ID?.trim() ?? "",
      }),
    );
    this.dhanClient = new DhanClient(this.dhanHttp, () =>
      this.dhanSessionMeta?.clientId ?? process.env.DHAN_CLIENT_ID?.trim() ?? "",
    );
  }

  /** Wire the exposure probe and switch hooks (done once, after the engine exists). */
  attach(probe: ExposureProbe, hooks: SwitchHooks): void {
    this.probe = probe;
    this.hooks = hooks;
  }

  /* ------------------------------ identity ------------------------------- */

  get activeBroker(): BrokerId {
    return this.active;
  }

  /**
   * Restore the persisted broker selection at boot.
   *
   * Without this a restart would silently revert to Zerodha and begin pricing trades
   * from the wrong venue — the trades would even be stamped `broker: "zerodha"`,
   * making the mistake invisible afterwards.
   */
  async restore(): Promise<void> {
    const saved = await loadActiveBroker().catch(() => null);
    if (saved && (BROKER_IDS as readonly string[]).includes(saved)) {
      this.active = saved as BrokerId;
    }
    // Rehydrate a still-valid Dhan session so a restart does not force a re-login.
    const session = await loadDhanSession().catch(() => null);
    if (session) {
      if (isDhanTokenExpired(session.expiry_time)) {
        await clearDhanSession().catch(() => undefined);
        this.dhanProblems = ["Dhan session expired — reconnect Dhan"];
      } else {
        this.dhanAccessToken = session.access_token;
        this.dhanTokenExpiry = session.expiry_time;
        this.dhanSessionMeta = {
          clientId: session.dhan_client_id,
          clientName: session.dhan_client_name,
          clientUcc: session.dhan_client_ucc,
          powerOfAttorney: session.given_power_of_attorney,
          loginDay: session.login_date,
          loginAt: session.login_at ? new Date(session.login_at).getTime() : Date.now(),
        };
      }
    }
    if (this.active === "dhan") this.dhanProblems = this.computeDhanProblems();
  }

  /* -------------------------- Dhan session state ------------------------- */

  /** The token, or null when absent/expired. Expiry is enforced on every read. */
  private usableDhanToken(): string | null {
    if (!this.dhanAccessToken) return null;
    if (isDhanTokenExpired(this.dhanTokenExpiry)) return null;
    return this.dhanAccessToken;
  }

  dhanCredentials(): { ok: true; creds: DhanAppCredentials } | { ok: false; reason: string } {
    return readDhanCredentials();
  }

  /** STEP 1 of the Dhan login: a consent + the browser URL. */
  async beginDhanLogin(): Promise<{ consentAppId: string; loginUrl: string }> {
    const creds = readDhanCredentials();
    if (!creds.ok) throw new DhanError(creds.reason, 400, "CONFIG");
    return generateDhanConsent(creds.creds);
  }

  /** STEP 3: exchange the redirect's tokenId for a session and persist it. */
  async completeDhanLogin(tokenId: string): Promise<BrokerSessionState> {
    const creds = readDhanCredentials();
    if (!creds.ok) throw new DhanError(creds.reason, 400, "CONFIG");
    const session = await consumeDhanConsent(creds.creds, tokenId);

    this.dhanAccessToken = session.accessToken;
    this.dhanTokenExpiry = session.expiryTime;
    this.dhanSessionMeta = {
      clientId: session.dhanClientId,
      clientName: session.dhanClientName,
      clientUcc: session.dhanClientUcc,
      powerOfAttorney: session.givenPowerOfAttorney,
      loginDay: this.deps.istDayKey(),
      loginAt: Date.now(),
    };
    await saveDhanSession({
      access_token: session.accessToken,
      dhan_client_id: session.dhanClientId,
      dhan_client_name: session.dhanClientName,
      dhan_client_ucc: session.dhanClientUcc,
      given_power_of_attorney: session.givenPowerOfAttorney,
      expiry_time: session.expiryTime,
      login_date: this.deps.istDayKey(),
    }).catch((err) => console.warn("[Dhan] failed to persist the session:", err));

    this.dhanProblems = this.computeDhanProblems();
    // Warm the universe now so the first scan is not waiting on a multi-MB CSV.
    void this.dhanInstruments.load().catch((err) =>
      console.warn("[Dhan] instrument master load failed after login:", err),
    );
    return this.sessionFor("dhan");
  }

  /**
   * Drop the Dhan session and everything derived from it.
   *
   * Stops the feed and clears instruments as well as the token: a logged-out broker
   * must not keep publishing books that would look current to the scanner.
   */
  async logoutDhan(): Promise<void> {
    this.dhanAccessToken = null;
    this.dhanTokenExpiry = null;
    this.dhanSessionMeta = null;
    this.dhanFeed?.stop();
    this.dhanInstruments.clear();
    this.dhanProblems = ["Dhan is not connected"];
    await clearDhanSession().catch(() => undefined);
    if (this.active === "dhan") {
      this.hooks?.invalidateBooks();
      this.hooks?.publish();
    }
  }

  /**
   * Handle a Dhan session that has died mid-flight.
   *
   * FAIL CLOSED: the feed stops, books are invalidated (so nothing stale is treated
   * as executable) and live execution is blocked because `trading_ready` goes false.
   */
  async onDhanSessionLost(reason: string): Promise<void> {
    console.warn(`[Dhan] session lost: ${reason}`);
    this.dhanAccessToken = null;
    this.dhanTokenExpiry = null;
    this.dhanFeed?.stop();
    this.dhanProblems = ["Dhan session expired — reconnect Dhan"];
    await clearDhanSession().catch(() => undefined);
    if (this.active === "dhan") {
      this.hooks?.invalidateBooks();
      this.deps.onSessionLost?.("dhan", reason);
      this.hooks?.publish();
    }
  }

  /* ----------------------------- readiness ------------------------------- */

  /** The operator's manual declaration. Retained as an additional gate. */
  private dhanStaticIpDeclared(): boolean {
    const raw = process.env.DHAN_STATIC_IP_EXPECTED?.trim().toLowerCase() ?? "";
    return raw === "1" || raw === "true" || raw === "yes";
  }

  /** The server's public IP as the operator configured it, or "" when unset. */
  private dhanConfiguredIp(): string {
    return process.env.DHAN_STATIC_PUBLIC_IP?.trim() ?? "";
  }

  /**
   * Whether Dhan's static-IP requirement is satisfied.
   *
   * TWO SOURCES OF EVIDENCE, API-VERIFIED PREFERRED.
   *
   * Dhan refuses order placement from a non-whitelisted address, and it DOES expose
   * the whitelist (`GET /ip/getIP` → primaryIP / secondaryIP). So when the operator
   * configures `DHAN_STATIC_PUBLIC_IP`, readiness is decided by whether that address
   * actually appears in Dhan's own record — a checked precondition rather than a
   * hopeful boolean. `DHAN_STATIC_IP_EXPECTED` then acts only as an additional kill
   * switch: setting it false still blocks trading.
   *
   * Without a configured IP it falls back to the manual declaration alone, and the
   * health report says so, because a declaration is materially weaker evidence.
   *
   * FAIL CLOSED throughout: an unverified, mismatched or not-yet-checked state is not
   * ready. Synchronous by necessity (the order adapter calls it per submission), so it
   * reads a cached verification that `verifyDhanStaticIp()` refreshes.
   */
  dhanStaticIpReady(): boolean {
    const declared = this.dhanStaticIpDeclared();
    const configuredIp = this.dhanConfiguredIp();
    if (configuredIp === "") {
      // No IP to verify: the declaration is all the evidence there is.
      return declared;
    }
    // An explicit `false` remains an operator override that stops trading.
    if (process.env.DHAN_STATIC_IP_EXPECTED !== undefined && !declared) return false;
    // Otherwise require positive API confirmation. `null` (never checked) is NOT ready.
    return this.dhanIpVerified === true;
  }

  /**
   * Confirm the configured server IP against Dhan's whitelist.
   *
   * Called before live Dhan startup and on a switch to Dhan. Best-effort in the sense
   * that it never throws — but a failure sets the verdict to `false`, not to unknown,
   * so an unreachable check blocks trading instead of quietly permitting it.
   */
  async verifyDhanStaticIp(): Promise<{
    verified: boolean;
    configured_ip: string;
    primary_ip: string | null;
    secondary_ip: string | null;
    checked_at: number;
    error: string | null;
  }> {
    const configuredIp = this.dhanConfiguredIp();
    const checkedAt = Date.now();
    this.dhanIpCheckedAt = checkedAt;

    if (configuredIp === "") {
      // Nothing to compare. Leave the verdict UNKNOWN rather than false: readiness
      // then falls back to the manual declaration, which is the documented behaviour.
      this.dhanIpVerified = null;
      this.dhanIpPrimary = null;
      this.dhanIpSecondary = null;
      this.dhanIpError = null;
      return {
        verified: false,
        configured_ip: "",
        primary_ip: null,
        secondary_ip: null,
        checked_at: checkedAt,
        error: null,
      };
    }
    if (this.usableDhanToken() === null) {
      this.dhanIpVerified = false;
      this.dhanIpError = "Cannot verify the static IP without a Dhan session.";
      return {
        verified: false,
        configured_ip: configuredIp,
        primary_ip: null,
        secondary_ip: null,
        checked_at: checkedAt,
        error: this.dhanIpError,
      };
    }

    try {
      const res = await this.dhanClient.getStaticIp();
      // Scan the payload for IPv4 values rather than trusting one field spelling: the
      // previous named-field read missed Dhan's actual keys and reported the whitelist
      // as empty while the dashboard plainly showed an address.
      const addresses = extractIpv4Addresses(res);
      this.dhanIpPrimary = addresses[0] ?? null;
      this.dhanIpSecondary = addresses[1] ?? null;
      const matched = addresses.includes(configuredIp);
      this.dhanIpVerified = matched;
      if (matched) {
        this.dhanIpError = null;
      } else if (addresses.length === 0) {
        // Distinguish "Dhan reports no whitelist" from "it does not match", because the
        // operator actions are different — and name the keys we actually received so a
        // future shape change is diagnosable instead of mysterious.
        this.dhanIpError =
          `Dhan returned no IP address in its whitelist response, so ` +
          `DHAN_STATIC_PUBLIC_IP (${configuredIp}) could not be verified. ` +
          `Response fields: [${Object.keys((res ?? {}) as object).join(", ") || "none"}]. ` +
          `Add a Static IP under My Profile → Access DhanHQ APIs → Static IP Setting.`;
      } else {
        this.dhanIpError =
          `DHAN_STATIC_PUBLIC_IP (${configuredIp}) does not match Dhan's whitelist ` +
          `(${addresses.join(", ")}).`;
      }
      if (!matched) console.warn(`[Dhan] ${this.dhanIpError}`);
      this.dhanProblems = this.computeDhanProblems();
      return {
        verified: matched,
        configured_ip: configuredIp,
        primary_ip: this.dhanIpPrimary,
        secondary_ip: this.dhanIpSecondary,
        checked_at: checkedAt,
        error: this.dhanIpError,
      };
    } catch (err) {
      // FAIL CLOSED: an unreachable check is not permission to trade.
      this.dhanIpVerified = false;
      this.dhanIpError = `Static-IP verification failed: ${err instanceof Error ? err.message : String(err)}`;
      this.dhanProblems = this.computeDhanProblems();
      return {
        verified: false,
        configured_ip: configuredIp,
        primary_ip: null,
        secondary_ip: null,
        checked_at: checkedAt,
        error: this.dhanIpError,
      };
    }
  }

  /** The static-IP readiness detail, for the status endpoints. */
  dhanStaticIpState(): {
    ready: boolean;
    declared: boolean;
    configured_ip: string | null;
    api_verified: boolean | null;
    primary_ip: string | null;
    secondary_ip: string | null;
    checked_at: number | null;
    error: string | null;
  } {
    const configuredIp = this.dhanConfiguredIp();
    return {
      ready: this.dhanStaticIpReady(),
      declared: this.dhanStaticIpDeclared(),
      configured_ip: configuredIp === "" ? null : configuredIp,
      api_verified: this.dhanIpVerified,
      primary_ip: this.dhanIpPrimary,
      secondary_ip: this.dhanIpSecondary,
      checked_at: this.dhanIpCheckedAt,
      error: this.dhanIpError,
    };
  }

  private dhanDataEnabled(): boolean {
    const raw = process.env.DHAN_DATA_ENABLED?.trim().toLowerCase() ?? "";
    return raw === "" || raw === "1" || raw === "true" || raw === "yes";
  }

  private dhanLiveTradingEnabled(): boolean {
    const raw = process.env.DHAN_LIVE_TRADING_ENABLED?.trim().toLowerCase() ?? "";
    return raw === "1" || raw === "true" || raw === "yes";
  }

  private computeDhanProblems(): string[] {
    const problems: string[] = [];
    const creds = readDhanCredentials();
    if (!creds.ok) problems.push(creds.reason);
    if (!this.dhanAccessToken) problems.push("Dhan is not connected");
    else if (isDhanTokenExpired(this.dhanTokenExpiry)) problems.push("Dhan session expired — reconnect Dhan");
    if (!this.dhanDataEnabled()) problems.push("Dhan data API is disabled (DHAN_DATA_ENABLED=false)");
    if (!this.dhanStaticIpReady()) {
      // Say WHICH check failed: "not configured" and "configured but does not match
      // Dhan's whitelist" need completely different operator actions.
      if (this.dhanIpError) problems.push(this.dhanIpError);
      else if (this.dhanConfiguredIp() === "") {
        problems.push(
          "Static IP not configured — set DHAN_STATIC_PUBLIC_IP (preferred, API-verified) " +
            "or DHAN_STATIC_IP_EXPECTED=true. Dhan live order placement is blocked.",
        );
      } else {
        problems.push("Static IP not yet verified against Dhan — live order placement is blocked.");
      }
    } else if (!this.dhanLiveTradingEnabled()) {
      problems.push("Dhan live trading is disabled (DHAN_LIVE_TRADING_ENABLED=false)");
    } else if (this.dhanConfiguredIp() === "") {
      // Ready, but on the weaker evidence. Worth saying so.
      problems.push(
        "Static IP is accepted on the manual DHAN_STATIC_IP_EXPECTED flag only — " +
          "set DHAN_STATIC_PUBLIC_IP to have it verified against Dhan.",
      );
    }
    if (this.dhanFeed && !this.dhanFeed.isConnected() && this.dhanAccessToken) {
      problems.push("Feed reconnecting");
    }
    return problems;
  }

  /** Session state for a broker — never derived from admin authentication. */
  sessionFor(broker: BrokerId): BrokerSessionState {
    if (broker === "zerodha") {
      const token = this.deps.kite.getAccessToken();
      return {
        broker: "zerodha",
        authenticated: token !== null,
        client_id: null,
        client_name: null,
        // Kite tokens die at the IST day boundary; there is no stated instant.
        token_expires_at: null,
        token_expired: false,
        login_day: null,
        login_at: null,
      };
    }
    const expired = isDhanTokenExpired(this.dhanTokenExpiry);
    return {
      broker: "dhan",
      authenticated: this.dhanAccessToken !== null && !expired,
      client_id: this.dhanSessionMeta?.clientId ?? null,
      client_name: this.dhanSessionMeta?.clientName ?? null,
      token_expires_at: this.dhanTokenExpiry,
      token_expired: expired,
      login_day: this.dhanSessionMeta?.loginDay ?? null,
      login_at: this.dhanSessionMeta?.loginAt ?? null,
    };
  }

  /** Capability readiness, split so data and trading fail independently. */
  healthFor(broker: BrokerId): BrokerHealthState {
    const session = this.sessionFor(broker);
    if (broker === "zerodha") {
      const connected = this.deps.tickerHub.isConnected();
      return {
        broker: "zerodha",
        authenticated: session.authenticated,
        token_expires_at: null,
        token_expired: false,
        data_ready: session.authenticated,
        // Zerodha has no static-IP requirement; live gating is the Box config's job.
        trading_ready: session.authenticated,
        static_ip_configured: null,
        feed_connected: connected,
        feed_age_ms: null,
        problems: session.authenticated ? [] : ["Zerodha is not connected"],
      };
    }
    const problems = this.computeDhanProblems();
    const dataReady = session.authenticated && this.dhanDataEnabled();
    return {
      broker: "dhan",
      authenticated: session.authenticated,
      token_expires_at: this.dhanTokenExpiry,
      token_expired: session.token_expired,
      data_ready: dataReady,
      // Three independent conditions. All must hold; any one failing blocks orders.
      trading_ready: dataReady && this.dhanStaticIpReady() && this.dhanLiveTradingEnabled(),
      static_ip_configured: this.dhanStaticIpReady(),
      feed_connected: this.dhanFeed?.isConnected() ?? false,
      feed_age_ms: this.dhanFeed?.feedAgeMs() ?? null,
      problems,
    };
  }

  /** The active broker's session + health, for the status endpoints. */
  activeSession(): BrokerSessionState {
    return this.sessionFor(this.active);
  }

  activeHealth(): BrokerHealthState {
    return this.healthFor(this.active);
  }

  /* ----------------------- broker-neutral providers ---------------------- */

  /**
   * Market data for the ACTIVE broker.
   *
   * Reads `this.active` on every call rather than capturing it, so a switch takes
   * effect immediately and a stale closure cannot keep serving the old broker.
   */
  marketData(): BoxMarketDataProvider {
    return {
      isAuthenticated: () =>
        this.active === "zerodha"
          ? this.deps.kite.getAccessToken() !== null
          : this.usableDhanToken() !== null && this.dhanDataEnabled(),
      getQuoteFull: (identifiers) =>
        this.active === "zerodha"
          ? this.deps.kite.getQuoteFull(identifiers)
          : this.dhanQuoteFull(identifiers),
    };
  }

  /**
   * REST snapshot quotes from Dhan, shaped like Kite's.
   *
   * Identifiers arrive as `EXCHANGE:TRADINGSYMBOL` (the app's internal form), so they
   * are resolved through the instrument store to Dhan's (segment, securityId).
   * Unresolvable identifiers are skipped rather than guessed.
   */
  private async dhanQuoteFull(identifiers: string[]): Promise<BoxRestQuote[]> {
    await this.dhanInstruments.load().catch(() => undefined);
    const bySymbol = new Map<string, DhanInstrument>();
    for (const inst of this.dhanInstruments.instruments) {
      bySymbol.set(`${inst.exchange}:${inst.tradingsymbol}`, inst);
    }

    const bySegment = new Map<DhanExchangeSegment, number[]>();
    const back = new Map<string, DhanInstrument>();
    for (const id of identifiers) {
      const inst = bySymbol.get(id);
      if (!inst) continue;
      const list = bySegment.get(inst.dhan_segment) ?? [];
      list.push(inst.dhan_security_id);
      bySegment.set(inst.dhan_segment, list);
      back.set(`${inst.dhan_segment}:${inst.dhan_security_id}`, inst);
    }
    if (bySegment.size === 0) return [];

    const out: BoxRestQuote[] = [];
    // Dhan caps a market-feed request at 1000 instruments per segment.
    for (const [segment, ids] of bySegment) {
      for (let i = 0; i < ids.length; i += 1000) {
        const chunk = ids.slice(i, i + 1000);
        try {
          const res = await this.dhanClient.marketFeedQuote({ [segment]: chunk });
          const entries = res.data?.[segment] ?? {};
          for (const [securityId, entry] of Object.entries(entries)) {
            const inst = back.get(`${segment}:${Number(securityId)}`);
            if (!inst) continue;
            out.push({
              instrument_token: inst.instrument_token,
              last_price: Number(entry.last_price) || 0,
              // The last-close view derives the trading SESSION from this date, so an
              // absent value must stay "" (treated as not comparable) rather than
              // becoming today and making a stale strike look current.
              last_trade_time: typeof entry.last_trade_time === "string" ? entry.last_trade_time : "",
            });
          }
        } catch (err) {
          console.warn(`[Dhan] market feed quote failed for ${segment}:`, err);
        }
      }
    }
    return out;
  }

  /** The ACTIVE broker's basket-margin provider. */
  margins(): BoxMarginProvider {
    return {
      broker: this.active,
      basketMargin: async (orders) => {
        if (this.active === "zerodha") {
          const res = await this.deps.kite.getBasketMargin(orders);
          this.lastMarginSource = "kite_basket";
          return { ...res, source: "kite_basket" as const };
        }
        return this.dhanBasketMargin(orders);
      },
    };
  }

  /**
   * Dhan basket margin for the four box legs.
   *
   * PREFERS the MULTI-ORDER calculator (`POST /margincalculator/multi`). A box is
   * margined as a BASKET: the offsetting legs earn a hedge benefit that is most of the
   * point of the structure, and summing four standalone margins ignores it entirely —
   * which can over-state the requirement several-fold and make the dashboard's margin
   * figures useless for comparison.
   *
   * All four orders go in one request carrying their REAL BUY/SELL direction and the
   * `MARGIN` (carry-forward) product; sending them one-directionally would defeat the
   * hedge recognition this call exists for.
   *
   * FALLBACK, clearly labelled: if the multi endpoint genuinely fails, the per-leg sum
   * is used and tagged `dhan_per_leg_fallback`. That is a conservative UPPER bound, so
   * a failed multi call can never produce an UNDERSTATED figure — the direction of the
   * error matters, and understating margin is the one outcome worth avoiding.
   */
  private async dhanBasketMargin(orders: BoxMarginOrder[]): Promise<BoxBasketMargin> {
    await this.dhanInstruments.load().catch(() => undefined);
    const bySymbol = new Map<string, DhanInstrument>();
    for (const inst of this.dhanInstruments.instruments) {
      bySymbol.set(`${inst.exchange}:${inst.tradingsymbol}`, inst);
    }

    // Resolve every leg first. A partially resolved basket must NOT be sent: the
    // hedge benefit of three legs is not the hedge benefit of four, and quietly
    // margining a subset would understate the requirement.
    const legs: {
      exchangeSegment: DhanExchangeSegment;
      transactionType: "BUY" | "SELL";
      quantity: number;
      productType: "MARGIN";
      securityId: string;
      price: number;
    }[] = [];
    for (const order of orders) {
      const inst = bySymbol.get(`${order.exchange}:${order.tradingsymbol}`);
      const segment = inst?.dhan_segment ?? dhanSegmentFor(order.exchange);
      if (!inst || !segment) continue;
      legs.push({
        exchangeSegment: segment,
        transactionType: order.transaction_type,
        quantity: order.quantity,
        // Carry-forward, matching what the Box actually trades. INTRADAY would be
        // margined differently AND auto-squared-off.
        productType: "MARGIN",
        securityId: String(inst.dhan_security_id),
        price: order.price > 0 ? order.price : 0.05,
      });
    }
    if (legs.length === 0) {
      return { initial: 0, final: 0, total: 0, source: "unavailable" };
    }

    const allResolved = legs.length === orders.length;

    // ---- preferred path: one hedge-aware multi-order request ----
    if (allResolved) {
      try {
        const raw = await this.dhanClient.calculateMultiMargin(legs);
        const normalized = normalizeDhanMultiMargin(raw);
        if (normalized) {
          this.lastMarginSource = "dhan_multi";
          return {
            initial: Math.round(normalized.span ?? 0),
            final: Math.round(normalized.total),
            total: Math.round(normalized.total),
            source: "dhan_multi",
            hedge_benefit: normalized.hedgeBenefit,
            span: normalized.span,
            exposure: normalized.exposure,
          };
        }
        console.warn(
          "[Dhan] multi-order margin returned no readable total — falling back to the per-leg sum.",
        );
      } catch (err) {
        console.warn("[Dhan] multi-order margin failed — falling back to the per-leg sum:", err);
      }
    } else {
      console.warn(
        `[Dhan] only ${legs.length}/${orders.length} basket legs resolved to a security id — ` +
          "using the conservative per-leg sum rather than margining a partial basket.",
      );
    }

    // ---- fallback: sum standalone legs. Conservative by construction. ----
    let total = 0;
    let span = 0;
    let priced = 0;
    for (const leg of legs) {
      try {
        const res = await this.dhanClient.calculateMargin(leg);
        total += Number(res.totalMargin) || 0;
        span += Number(res.spanMargin) || 0;
        priced++;
      } catch (err) {
        console.warn(`[Dhan] per-leg margin failed for securityId ${leg.securityId}:`, err);
      }
    }
    if (priced === 0) {
      // Nothing priced at all. Report UNAVAILABLE rather than ₹0, so the dashboard
      // counts it as unknown instead of treating the box as margin-free.
      this.lastMarginSource = "unavailable";
      return { initial: 0, final: 0, total: 0, source: "unavailable" };
    }
    this.lastMarginSource = "dhan_per_leg_fallback";
    return {
      initial: Math.round(span),
      final: Math.round(total),
      total: Math.round(total),
      source: "dhan_per_leg_fallback",
      // No hedge benefit is recognised in this path — that is precisely why it is a
      // fallback, and stating null is more honest than implying zero benefit exists.
      hedge_benefit: null,
      span,
      exposure: null,
    };
  }

  /**
   * Build the LIVE execution adapter for the active broker.
   *
   * REFUSES to build an adapter for a broker that is not active — that is the
   * structural half of the single-broker rule. It would otherwise be possible to
   * hold a Dhan adapter during a Zerodha session and place orders at the wrong venue.
   */
  createLiveAdapter(ctx: { broker: BrokerId; cfg: BoxConfig }): BrokerAdapter {
    if (ctx.broker !== this.active) {
      throw new Error(
        `[Box] refusing to build a ${ctx.broker} execution adapter while ${this.active} is the active broker.`,
      );
    }
    if (ctx.broker === "zerodha") {
      return createZerodhaLiveAdapter(this.deps.kite, ctx.cfg);
    }
    if (!this.dhanLiveTradingEnabled()) {
      throw new Error(
        "[Box] Dhan live execution blocked: set DHAN_LIVE_TRADING_ENABLED=true to permit real Dhan orders.",
      );
    }
    return new DhanBrokerAdapter(
      this.dhanClient,
      dhanAdapterConfigFromBoxConfig(ctx.cfg, {
        staticIpReady: () => this.dhanStaticIpReady(),
        dhanClientId: () => this.dhanSessionMeta?.clientId ?? process.env.DHAN_CLIENT_ID?.trim() ?? "",
        identify: (token) => this.dhanInstruments.identify(token),
      }),
    );
  }

  /** The active broker's charge calculator (Dhan's own rate card when Dhan is active). */
  dhanChargeCalculator(): DhanChargeCalculator {
    return this.dhanCharges;
  }

  /** Instruments for the active broker, in the internal shape. */
  async instruments(): Promise<Instrument[]> {
    if (this.active === "zerodha") return [];
    const rows = await this.dhanInstruments.load();
    return rows;
  }

  get dhanInstrumentStore(): DhanInstrumentStore {
    return this.dhanInstruments;
  }

  get dhan(): DhanClient {
    return this.dhanClient;
  }

  /* ------------------------------- the feed ------------------------------ */

  /** The Dhan feed, constructed lazily so a Zerodha-only deployment never makes one. */
  private ensureDhanFeed(): DhanFeed {
    if (!this.dhanFeed) {
      this.dhanFeed = new DhanFeed({
        accessToken: () => this.usableDhanToken(),
        clientId: () => this.dhanSessionMeta?.clientId ?? process.env.DHAN_CLIENT_ID?.trim() ?? "",
        onTicks: (ticks) => this.deps.onDhanTicks(ticks),
        onConnection: (connected) => {
          this.dhanProblems = this.computeDhanProblems();
          this.deps.onDhanConnection?.(connected);
          this.hooks?.publish();
        },
        onSessionLost: (reason) => void this.onDhanSessionLost(reason),
        resolve: (token) => this.dhanInstruments.identify(token),
        depthLevel: 5,
      });
    }
    return this.dhanFeed;
  }

  /** Subscribe tokens on the ACTIVE broker's feed. */
  subscribeTokens(tokens: number[]): void {
    if (tokens.length === 0) return;
    if (this.active === "zerodha") {
      this.deps.tickerHub.subscribeTokens(tokens);
      return;
    }
    this.ensureDhanFeed().subscribeTokens(tokens);
  }

  unsubscribeTokens(tokens: number[]): void {
    if (tokens.length === 0) return;
    if (this.active === "zerodha") {
      this.deps.tickerHub.unsubscribeTokens(tokens);
      return;
    }
    this.dhanFeed?.unsubscribeTokens(tokens);
  }

  feedConnected(): boolean {
    return this.active === "zerodha"
      ? this.deps.tickerHub.isConnected()
      : (this.dhanFeed?.isConnected() ?? false);
  }

  subscribedCount(): number {
    return this.active === "zerodha"
      ? this.deps.tickerHub.subscribedCount()
      : (this.dhanFeed?.subscribedCount() ?? 0);
  }

  /** Start the ACTIVE broker's feed. Never starts the inactive one. */
  startActiveFeed(): void {
    if (this.active === "dhan") this.ensureDhanFeed().ensureSocket();
    // Zerodha's hub connects lazily on subscribe/retain, so there is nothing to do.
  }

  /* ------------------------------ switching ------------------------------ */

  /**
   * Everything that would make a switch unsafe.
   *
   * Deliberately reports ALL blockers, not the first: an operator who has to clear
   * three things should see three, not discover them one 409 at a time.
   */
  async switchBlockers(target: BrokerId): Promise<SwitchBlocker[]> {
    const blockers: SwitchBlocker[] = [];
    if (target === "dhan") {
      const creds = readDhanCredentials();
      if (!creds.ok) blockers.push({ reason: "broker_not_configured", detail: creds.reason });
    }
    const probe = this.probe;
    if (!probe) return blockers;

    if (probe.scannerRunning()) {
      blockers.push({
        reason: "scanner_running",
        detail: "The Box scanner is running. Press STOP before changing broker.",
      });
    }
    const openCount = probe.openPositionCount();
    if (openCount > 0) {
      const brokers = probe.brokersWithOpenPositions().join(", ");
      blockers.push({
        reason: "open_box_positions",
        detail: `${openCount} open Box position(s) (${brokers}). Close, flatten or delete them first.`,
      });
    }
    const working = probe.workingOrderCount();
    if (working > 0) {
      blockers.push({
        reason: "working_orders",
        detail: `${working} broker order(s) still working. Cancel them before changing broker.`,
      });
    }
    if (probe.executionInFlight()) {
      blockers.push({
        reason: "execution_in_flight",
        detail: "An entry or exit is in flight. Wait for it to finish.",
      });
    }
    if (!probe.reconciliationComplete()) {
      blockers.push({
        reason: "unresolved_reconciliation",
        detail: "Broker reconciliation is incomplete. Run reconcile and resolve it first.",
      });
    }
    const residual = probe.residualLegCount();
    if (residual > 0) {
      blockers.push({
        reason: "residual_exposure",
        detail: `${residual} residual leg(s) of exposure outstanding. Flatten them first.`,
      });
    }
    const unknown = probe.unknownOrderCount();
    if (unknown > 0) {
      blockers.push({
        reason: "unknown_order_state",
        detail: `${unknown} order(s) are in an unknown state. Reconcile before changing broker.`,
      });
    }
    // Unresolved intents on the broker we are LEAVING can only ever be reconciled
    // through that broker, and after the switch its adapter is gone.
    const leaving = this.active;
    if (leaving !== target) {
      const outstanding = await probe.unresolvedIntentsFor(leaving).catch(() => 0);
      if (outstanding > 0) {
        blockers.push({
          reason: "foreign_unresolved_intents",
          detail:
            `${outstanding} unresolved ${leaving} order intent(s) remain. They can only be reconciled ` +
            `through ${leaving}, so resolve them before switching to ${target}.`,
        });
      }
    }
    return blockers;
  }

  /**
   * Switch the active broker, or refuse.
   *
   * THE ORDER OF OPERATIONS IS THE SAFETY PROPERTY. The old broker is fully torn
   * down — scanner stopped, feed stopped, subscriptions dropped, books invalidated —
   * BEFORE `this.active` moves, and the new feed is only started afterwards. There is
   * therefore no instant at which two feeds could both drive a Box decision, and no
   * way for a book produced by one broker to price a decision for the other.
   */
  async switchBroker(
    target: BrokerId,
    actor: string,
  ): Promise<{ ok: true; broker: BrokerId } | { ok: false; blockers: SwitchBlocker[] }> {
    if (target === this.active) {
      // Idempotent: re-selecting the current broker is a no-op success, so a repeated
      // admin verify does not error.
      return { ok: true, broker: this.active };
    }
    const blockers = await this.switchBlockers(target);
    if (blockers.length > 0) return { ok: false, blockers };

    const previous = this.active;
    const hooks = this.hooks;

    // 1. stop discovery on the outgoing broker
    hooks?.stopScanner();

    // 2 + 3. stop the outgoing feed and DROP its subscriptions and books
    if (previous === "zerodha") {
      // The Kite hub clears `subscribed` and `latest` on stop, so no Zerodha depth
      // survives into the Dhan session.
      this.deps.tickerHub.stop();
    } else {
      this.dhanFeed?.stop();
    }

    // 4. clear broker-specific runtime caches
    if (previous === "dhan") this.dhanInstruments.clear();
    // The Box quote store and feed generation are the engine's; the hook clears them.
    hooks?.invalidateBooks();

    // 5. the switch itself — nothing before this point could touch the new broker,
    //    and nothing after it can touch the old one.
    this.active = target;
    await saveActiveBroker(target, actor).catch((err) =>
      console.warn("[Broker] failed to persist the active broker:", err),
    );

    // 6 + 7. bring the new broker up, then start ONLY its feed
    try {
      if (target === "dhan") {
        await this.dhanInstruments.load(true);
        // Confirm the whitelist against Dhan now, so `trading_ready` is truthful the
        // moment the switch completes rather than at the first order attempt.
        await this.verifyDhanStaticIp().catch(() => undefined);
      }
      await hooks?.reloadUniverse();
    } catch (err) {
      console.warn(`[Broker] switched to ${target} but the universe reload failed:`, err);
    }
    this.startActiveFeed();
    this.dhanProblems = this.computeDhanProblems();
    hooks?.publish();

    console.log(`[Broker] active broker switched ${previous} → ${target} by ${actor}.`);
    return { ok: true, broker: target };
  }

  /** Diagnostics for the status endpoints. */
  snapshot(): {
    broker: BrokerId;
    session: BrokerSessionState;
    health: BrokerHealthState;
    dhan_configured: boolean;
    dhan_instruments: number;
    dhan_instruments_loaded_at: number | null;
    dhan_static_ip: ReturnType<ActiveBrokerManager["dhanStaticIpState"]>;
    last_margin_source: BoxMarginSource | null;
  } {
    return {
      broker: this.active,
      session: this.activeSession(),
      health: this.activeHealth(),
      dhan_configured: readDhanCredentials().ok,
      dhan_instruments: this.dhanInstruments.size,
      dhan_instruments_loaded_at: this.dhanInstruments.lastLoadedAt,
      dhan_static_ip: this.dhanStaticIpState(),
      /** Which margin calculation produced the most recent figure. */
      last_margin_source: this.lastMarginSource,
    };
  }
}

export { dhanInternalToken };
