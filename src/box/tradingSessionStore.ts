/**
 * THE DURABLE-BACKED TRADING SESSION MANAGER.
 *
 * `tradingSession.ts` holds the pure state machine and arithmetic. This module owns the
 * PERSISTENCE and the FAILURE POLICY around it, which is where the safety lives:
 *
 *   - a write failure ROLLS BACK the in-memory record, so the running counters and the durable
 *     ones can never disagree;
 *   - a READ failure at boot is NOT treated as "no session is armed" — it fails closed, because
 *     a transient Mongo error must not hand back a spent one-shot budget;
 *   - a cycle is consumed at establishment and completed at FLAT, and completions that happened
 *     while the process was down are reconciled from durable trade state at boot.
 *
 * Kept out of `engine.ts` deliberately: the engine is already very large, and a safety counter
 * whose whole purpose is to survive restarts deserves to be readable and testable on its own. The
 * persistence surface is injected, so tests drive it without Mongo.
 */

import { randomUUID } from "node:crypto";

import {
  armSession,
  canArm,
  completedCycles,
  consumedCycles,
  deriveSessionState,
  disarmSession,
  evaluateSessionEntry,
  idleSessionRecord,
  inFlightCycleIds,
  isArmed,
  recordAbortedAttempt,
  recordCompletedBox,
  recordEstablishedBox,
  reconcileCompletions,
  sessionStatus,
  type BoxSessionActivity,
  type BoxSessionBlockReason,
  type BoxSessionRecord,
} from "./tradingSession.js";

/** The durable surface this manager needs. Injected so tests need no database. */
export interface TradingSessionPersistence {
  load(): Promise<{ ok: true; record: BoxSessionRecord | null } | { ok: false; error: string }>;
  save(record: BoxSessionRecord): Promise<void>;
  /** Which of these trade ids are durably FLAT. Used for boot reconciliation. */
  flatTradeIds(tradeIds: readonly string[]): Promise<string[]>;
}

export interface TradingSessionManagerDeps {
  readonly persistence: TradingSessionPersistence;
  /** The configured cycle budget, used when an operator arms without specifying one. */
  readonly configuredMaxCompletedTrades: () => number;
  readonly now?: () => number;
  readonly newSessionId?: () => string;
  readonly log?: (message: string) => void;
}

/** Why the session layer refuses entry, including the load-failure case. */
export type SessionEntryRefusal = BoxSessionBlockReason | "session_state_unreadable";

export class BoxTradingSessionManager {
  private record: BoxSessionRecord;
  /**
   * True once durable state has been read successfully.
   *
   * Until it is, live entry is REFUSED. An unread session is not an unarmed session: assuming a
   * clean slate on a read error is precisely how "restart to get another trade" would work.
   */
  private loaded = false;
  private loadError: string | null = null;

  constructor(private readonly deps: TradingSessionManagerDeps) {
    this.record = idleSessionRecord(this.now());
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * A unique id for a newly-armed session.
   *
   * `randomUUID`, deliberately NOT `Math.random`: `src/box` bans `Math.random` outright (there is
   * a test asserting its absence) because execution decisions must be reproducible. The same
   * choice `reservations/identity.ts` makes for owner ids.
   */
  private mintSessionId(): string {
    if (this.deps.newSessionId) return this.deps.newSessionId();
    return `sess-${this.now().toString(36)}-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  }

  /** The current durable record. Read-only to callers. */
  snapshot(): BoxSessionRecord {
    return this.record;
  }

  /** Whether durable state was read. False ⇒ live entry must fail closed. */
  isReady(): boolean {
    return this.loaded;
  }

  lastLoadError(): string | null {
    return this.loadError;
  }

  /**
   * Load durable state and close out cycles that reached FLAT while the process was down.
   *
   * Call once during boot, after trade adoption. Never throws: a failure leaves `loaded` false,
   * which fails entry closed rather than crashing the boot path — the same trade-off the durable
   * reservation boot check makes, and for the same reason (refusing to boot would also refuse to
   * monitor, reconcile and flatten real exposure).
   */
  async initialise(): Promise<void> {
    const loaded = await this.deps.persistence.load();
    if (!loaded.ok) {
      this.loaded = false;
      this.loadError = loaded.error;
      this.deps.log?.(
        `[Box] could not read the durable trading session (${loaded.error}); ` +
          "live entry stays CLOSED until it is readable, because an unread session is not an unarmed one.",
      );
      return;
    }
    this.loaded = true;
    this.loadError = null;
    this.record = loaded.record ?? idleSessionRecord(this.now());

    // Cycles that went flat during downtime. Without this an exited Box would stay "in flight"
    // forever, the session would never report COMPLETED, and `canArm` would refuse to arm again
    // on the strength of exposure that no longer exists.
    const outstanding = inFlightCycleIds(this.record);
    if (outstanding.length === 0) return;
    const flat = await this.deps.persistence.flatTradeIds(outstanding);
    if (flat.length === 0) return;
    const next = reconcileCompletions(this.record, flat, this.now());
    await this.commit(next, "reconcile boot completions");
    this.deps.log?.(
      `[Box] session reconciliation closed ${flat.length} cycle(s) that reached FLAT while the ` +
        "process was down.",
    );
  }

  /**
   * Persist a candidate record, rolling back in memory if the write fails.
   *
   * THE ROLLBACK IS THE POINT. Applying in memory and hoping the write lands would let a consumed
   * cycle be forgotten by a restart. Refusing to apply unless the write succeeded keeps the two
   * in step; the cost is that a Mongo outage makes the counter refuse to move, which for a safety
   * budget is the correct direction to fail.
   */
  private async commit(next: BoxSessionRecord, what: string): Promise<boolean> {
    const previous = this.record;
    this.record = next;
    try {
      await this.deps.persistence.save(next);
      return true;
    } catch (error) {
      this.record = previous;
      this.deps.log?.(
        `[Box] failed to persist the trading session (${what}): ` +
          `${error instanceof Error ? error.message : String(error)}. In-memory state rolled back.`,
      );
      return false;
    }
  }

  /**
   * The ENTRY verdict. ENTRY ONLY — never consulted for an exit, cancel, flatten or reconciliation.
   *
   * `recoveryActive` is passed in rather than read, so the caller supplies the same recovery signal
   * the rest of the engine uses.
   */
  evaluateEntry(recoveryActive: boolean): {
    allowed: boolean;
    reason: SessionEntryRefusal | null;
    detail: string | null;
  } {
    if (!this.loaded) {
      return {
        allowed: false,
        reason: "session_state_unreadable",
        detail:
          `durable trading-session state could not be read (${this.loadError ?? "unknown error"}); ` +
          "entry is refused because an unread session cannot be proven to have budget left. " +
          "Exit, residual flattening and reconciliation are unaffected.",
      };
    }
    return evaluateSessionEntry({ record: this.record, recoveryActive });
  }

  /** Arm (or re-arm) a session. Refused while any consumed cycle still has live exposure. */
  async arm(args: {
    readonly maxCompletedTrades?: number;
    readonly armedBy: string | null;
    readonly openBoxes: number;
    readonly residualLegs: number;
    readonly recoveryActive: boolean;
  }): Promise<{ ok: true; record: BoxSessionRecord } | { ok: false; reason: string }> {
    if (!this.loaded) {
      return { ok: false, reason: `durable session state is unreadable (${this.loadError ?? "unknown"})` };
    }
    const permitted = canArm({
      record: this.record,
      openBoxes: args.openBoxes,
      residualLegs: args.residualLegs,
      recoveryActive: args.recoveryActive,
    });
    if (!permitted.ok) return { ok: false, reason: permitted.reason };

    const max = args.maxCompletedTrades ?? this.deps.configuredMaxCompletedTrades();
    const next = armSession({
      sessionId: this.mintSessionId(),
      maxCompletedTrades: max,
      armedBy: args.armedBy,
      previous: this.record,
      now: this.now(),
    });
    if (!(await this.commit(next, "arm"))) {
      return { ok: false, reason: "the session could not be persisted, so arming was refused" };
    }
    return { ok: true, record: this.record };
  }

  /** Disarm. Counters are preserved, so disarm-then-arm cannot skip the exposure guard. */
  async disarm(): Promise<boolean> {
    if (!this.loaded) return false;
    return this.commit(disarmSession(this.record, this.now()), "disarm");
  }

  /**
   * Record that a full four-leg Box was established. CONSUMES a cycle.
   *
   * Called ONLY from the successful-open path, never from the entry-attempt path: a rejected,
   * partially-filled or economics-aborted entry never established a Box and must not burn a cycle.
   */
  async recordEstablished(tradeId: string): Promise<void> {
    if (!this.loaded || !isArmed(this.record)) return;
    const next = recordEstablishedBox(this.record, tradeId, this.now());
    if (next === this.record) return; // idempotent: already counted
    await this.commit(next, `establish ${tradeId}`);
  }

  /** Record that an established Box reached fully FLAT. COMPLETES a cycle. */
  async recordCompleted(tradeId: string): Promise<void> {
    if (!this.loaded) return;
    const next = recordCompletedBox(this.record, tradeId, this.now());
    if (next === this.record) return;
    await this.commit(next, `complete ${tradeId}`);
  }

  /** Record an entry attempt that ended with no Box. Visibility only; consumes nothing. */
  async recordAborted(): Promise<void> {
    if (!this.loaded || !isArmed(this.record)) return;
    await this.commit(recordAbortedAttempt(this.record, this.now()), "aborted attempt");
  }

  /** The status projection, including the load-failure block reason. */
  status(activity: BoxSessionActivity): ReturnType<typeof sessionStatus> & { readable: boolean } {
    const verdict = this.evaluateEntry(activity.recoveryActive);
    return {
      ...sessionStatus(this.record, activity, verdict.reason),
      readable: this.loaded,
    };
  }

  /** Convenience accessors for diagnostics. */
  consumed(): number {
    return consumedCycles(this.record);
  }

  completed(): number {
    return completedCycles(this.record);
  }

  state(activity: BoxSessionActivity): ReturnType<typeof deriveSessionState> {
    return deriveSessionState(this.record, activity);
  }
}
