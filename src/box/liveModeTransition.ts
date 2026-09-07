/**
 * EXECUTION-MODE TRANSITION SAFETY.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * THE PRECEDENCE MODEL (read this before adding any runtime switch)
 * ────────────────────────────────────────────────────────────────────────────────────────
 *
 * Two concepts that were previously entangled are separated here, permanently:
 *
 *   DEPLOYMENT CAPABILITY — decided at STARTUP, from the environment, and immutable for the
 *   life of the process:
 *       - `BOX_EXECUTION_MODE`      which execution engine was CONSTRUCTED
 *       - `BOX_LIVE_TRADING_ENABLED` whether live trading is permitted at all
 *       - whether a mutation-capable broker adapter was even instantiated
 *       - whether broker credentials exist
 *
 *   RUNTIME SESSION STATE — mutable, operator-driven, and always subordinate to capability:
 *       - which PAPER profile is active (`standard` ↔ `live_parity`)
 *       - whether live order handling is ARMED
 *       - whether new ENTRY is permitted
 *       - whether emergency flatten is permitted
 *
 * THERE IS EXACTLY ONE SOURCE OF TRUTH FOR EACH, AND THEY DO NOT OVERLAP. The environment
 * decides what this process *can* do; the operator decides what it *is currently doing*
 * within that envelope. Mongo never contradicts `.env` about liveness, because Mongo is not
 * consulted about liveness at all.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * WHY `BOX_EXECUTION_MODE` REMAINS STARTUP-ONLY
 * ────────────────────────────────────────────────────────────────────────────────────────
 *
 * Making LIVE runtime-selectable would require constructing a mutation-capable broker adapter
 * in EVERY deployment, including paper-only ones, so that it would be available if someone
 * clicked a button. That single change would destroy the strongest safety property this
 * system has: in a paper deployment there is no object in the process capable of placing a
 * real order. `tests/box/paperNeverReachesBroker.test.mjs` exists to defend exactly that.
 *
 * Trading a structural guarantee for a nicer selector is a bad trade. So:
 *
 *   - PAPER ↔ PAPER profile changes are permitted at runtime (no new capability is created).
 *   - PAPER → LIVE and LIVE → PAPER require an environment change and a RESTART, and the UI
 *     is told to say so, in those words.
 *
 * The UI therefore reports live mode HONESTLY rather than pretending to control it. A UI
 * toggle can never manufacture deployment authorisation, which is the property Part 8's kill
 * switch requires.
 *
 * PURE: no I/O, no clock, no mutation. The caller supplies a snapshot and applies the verdict.
 */

import type { BoxPaperProfile } from "./config.js";
import type { ExecutionMode } from "./types.js";

/** What an operator may ask to switch to. */
export type ExecutionModeSelection =
  /** Paper with a simulated-latency model. */
  | "paper_latency"
  /** Paper legging with the standard profile. */
  | "paper_legging"
  /** Paper legging calibrated to mirror live policy (`BOX_PAPER_EXECUTION_PROFILE=live_parity`). */
  | "paper_legging_live_parity"
  /** Real broker orders. */
  | "live";

/**
 * The UI-facing label for a selection.
 *
 * `paper_legging` is deliberately NOT labelled "live parity" unless the profile really is
 * `live_parity`. Presenting standard paper legging as live-parity would tell an operator that
 * a simulation reproduces live policy when it does not — the single most misleading thing this
 * screen could say.
 */
export function executionModeLabel(mode: ExecutionMode, profile: BoxPaperProfile, broker: string): string {
  if (mode === "live") return `LIVE · ${broker.trim().toUpperCase()}`;
  if (mode === "paper_legging") {
    return profile === "live_parity" ? "PAPER · LEGGING LIVE-PARITY" : "PAPER · LEGGING";
  }
  if (mode === "paper_touch") return "PAPER · TOUCH";
  return "PAPER · LATENCY";
}

/** The current selection implied by mode + profile. */
export function currentSelection(mode: ExecutionMode, profile: BoxPaperProfile): ExecutionModeSelection {
  if (mode === "live") return "live";
  if (mode === "paper_legging") return profile === "live_parity" ? "paper_legging_live_parity" : "paper_legging";
  return "paper_latency";
}

/** True when a selection means real broker orders. */
export function selectionIsLive(selection: ExecutionModeSelection): boolean {
  return selection === "live";
}

/**
 * Everything that must be quiet before an execution-mode transition.
 *
 * Assembled by the engine from durable and manager state. Every field is a reason to refuse,
 * so a field that cannot be determined must be reported in its UNSAFE form, never defaulted
 * to the safe value.
 */
export interface ModeTransitionSnapshot {
  /** Whether this deployment was constructed live-capable. Immutable for the process. */
  readonly deploymentLiveCapable: boolean;
  /** Why not, when `deploymentLiveCapable` is false. Shown verbatim in the UI. */
  readonly liveCapabilityDetail: string;
  readonly openBoxes: number;
  readonly partiallyExitedBoxes: number;
  readonly recoveryBoxes: number;
  readonly residualLegs: number;
  readonly recoveryActive: boolean;
  /** Box-attributable orders still working at the broker. */
  readonly workingBrokerOrders: number;
  /** Queued operations in the order manager. */
  readonly queuedExecutions: number;
  /** Operations currently at the broker. */
  readonly inFlightExecutions: number;
  /** Durable intents that are neither terminal nor reconciled. */
  readonly unresolvedIntents: number;
  /** Orders whose broker state is UNKNOWN / ambiguous. */
  readonly unknownOrders: number;
  /** False when reconciliation has not completed or is unhealthy. */
  readonly reconciliationHealthy: boolean;
  /** True when an incident is open. */
  readonly reconciliationIncidentActive: boolean;
  /** Whether the scanner is still discovering. Must be STOPPED first. */
  readonly scannerRunning: boolean;
  /** A paper simulation with in-flight simulated executions must not be reconfigured. */
  readonly paperSimulationsInFlight: number;
}

/** One reason a transition is refused. */
export interface ModeTransitionBlocker {
  readonly code: string;
  readonly detail: string;
}

export type ModeTransitionVerdict =
  /** Safe to apply now, at runtime. */
  | { readonly outcome: "allowed"; readonly from: ExecutionModeSelection; readonly to: ExecutionModeSelection }
  /** Legal, but only via an environment change and a process restart. */
  | {
      readonly outcome: "restart_required";
      readonly from: ExecutionModeSelection;
      readonly to: ExecutionModeSelection;
      readonly detail: string;
      readonly envChanges: readonly string[];
      readonly blockers: readonly ModeTransitionBlocker[];
    }
  /** Refused. */
  | {
      readonly outcome: "refused";
      readonly from: ExecutionModeSelection;
      readonly to: ExecutionModeSelection;
      readonly blockers: readonly ModeTransitionBlocker[];
    };

/**
 * Collect every reason the process is too busy to change execution behaviour.
 *
 * Shared by the paper-profile switch and the (restart-gated) live transition, so the two can
 * never disagree about what "quiet" means.
 */
export function transitionBlockers(snapshot: ModeTransitionSnapshot): ModeTransitionBlocker[] {
  const blockers: ModeTransitionBlocker[] = [];
  const add = (code: string, detail: string): void => void blockers.push({ code, detail });

  if (snapshot.openBoxes > 0) add("open_box", `${snapshot.openBoxes} Box position(s) are open`);
  if (snapshot.partiallyExitedBoxes > 0) {
    add("partial_box", `${snapshot.partiallyExitedBoxes} Box position(s) are partially exited`);
  }
  if (snapshot.recoveryBoxes > 0) add("recovery_box", `${snapshot.recoveryBoxes} Box position(s) are in RECOVERY`);
  if (snapshot.residualLegs > 0) add("residual_exposure", `${snapshot.residualLegs} residual leg(s) are unresolved`);
  if (snapshot.recoveryActive) add("recovery_active", "recovery handling is active");
  if (snapshot.workingBrokerOrders > 0) {
    add("working_broker_order", `${snapshot.workingBrokerOrders} Box order(s) are still working at the broker`);
  }
  if (snapshot.queuedExecutions > 0) add("queued_execution", `${snapshot.queuedExecutions} operation(s) are queued`);
  if (snapshot.inFlightExecutions > 0) {
    add("in_flight_execution", `${snapshot.inFlightExecutions} operation(s) are in flight at the broker`);
  }
  if (snapshot.unresolvedIntents > 0) {
    add("unresolved_intent", `${snapshot.unresolvedIntents} durable order intent(s) are unresolved`);
  }
  if (snapshot.unknownOrders > 0) add("unknown_order", `${snapshot.unknownOrders} order(s) have unknown broker state`);
  if (!snapshot.reconciliationHealthy) add("reconciliation_unhealthy", "reconciliation is incomplete or unhealthy");
  if (snapshot.reconciliationIncidentActive) add("reconciliation_incident", "a reconciliation incident is open");
  if (snapshot.scannerRunning) add("scanner_running", "the scanner is still discovering; STOP it before a mode change");

  return blockers;
}

/**
 * Evaluate a requested execution-mode transition.
 *
 * DECISION TABLE:
 *
 *   from == to                          → allowed (no-op)
 *   paper → paper                       → allowed IFF nothing is in flight
 *   * → live, deployment NOT capable    → REFUSED. No UI action can create authorisation.
 *   * → live, deployment capable        → restart_required (+ blockers must also be clear)
 *   live → paper                        → restart_required (+ blockers must be clear)
 *
 * A live transition is refused outright — never merely deferred — when the deployment kill
 * switch is off, because in that case there is no path by which it could become legal without
 * an environment change, and saying "restart required" would imply restarting alone suffices.
 */
export function evaluateModeTransition(args: {
  readonly from: ExecutionModeSelection;
  readonly to: ExecutionModeSelection;
  readonly snapshot: ModeTransitionSnapshot;
}): ModeTransitionVerdict {
  const { from, to, snapshot } = args;
  if (from === to) return { outcome: "allowed", from, to };

  const blockers = transitionBlockers(snapshot);
  const crossesLiveBoundary = selectionIsLive(from) !== selectionIsLive(to);

  if (!crossesLiveBoundary) {
    // PAPER ↔ PAPER. No new capability is created, so this is safe at runtime — but only
    // while no simulation is mid-flight, since changing the timing model under a running
    // simulated execution would corrupt its record.
    const paperBlockers = [...blockers];
    if (snapshot.paperSimulationsInFlight > 0) {
      paperBlockers.push({
        code: "paper_simulation_in_flight",
        detail: `${snapshot.paperSimulationsInFlight} simulated execution(s) are in flight`,
      });
    }
    if (paperBlockers.length > 0) return { outcome: "refused", from, to, blockers: paperBlockers };
    return { outcome: "allowed", from, to };
  }

  if (selectionIsLive(to) && !snapshot.deploymentLiveCapable) {
    return {
      outcome: "refused",
      from,
      to,
      blockers: [
        {
          code: "deployment_gate_disabled",
          detail:
            `LIVE UNAVAILABLE — deployment gate disabled: ${snapshot.liveCapabilityDetail}. ` +
            "This cannot be changed from the UI: it requires BOX_EXECUTION_MODE=live and " +
            "BOX_LIVE_TRADING_ENABLED=true in the deployment environment.",
        },
        ...blockers,
      ],
    };
  }

  return {
    outcome: "restart_required",
    from,
    to,
    detail:
      "BOX_EXECUTION_MODE is a startup-only construction boundary: a mutation-capable broker adapter is " +
      "instantiated only when the deployment is configured live, so crossing the paper/live boundary " +
      "requires an environment change and a process restart. This is deliberate — it is what guarantees a " +
      "paper deployment contains no object able to place a real order.",
    envChanges: selectionIsLive(to)
      ? ["BOX_EXECUTION_MODE=live", "BOX_LIVE_TRADING_ENABLED=true"]
      : ["BOX_EXECUTION_MODE=paper_legging (or paper_latency)"],
    blockers,
  };
}

/**
 * The preconditions for ARMING live order handling.
 *
 * Distinct from a mode transition: the deployment is already live: this is the operator
 * turning the key. Arming is deliberately decomposed so that no single action enables
 * everything — {@link LiveArmPermissions} stays independently controllable, and in particular
 * EMERGENCY FLATTEN is never implied by arming entry.
 */
export interface LiveArmPreconditions {
  readonly deploymentLiveCapable: boolean;
  readonly brokerAuthenticated: boolean;
  readonly reconciliationHealthy: boolean;
  readonly reconciliationComplete: boolean;
  readonly feedHealthy: boolean;
  readonly feedWarmedUp: boolean;
  readonly circuitClosed: boolean;
  readonly recoveryActive: boolean;
  readonly unknownOrders: number;
  readonly durableReservationsAvailable: boolean;
}

/** The three independently-armed live permissions. */
export interface LiveArmPermissions {
  /** May open NEW exposure. The most dangerous, and never implied by the others. */
  readonly entryEnabled: boolean;
  /** May manage (reduce) existing exposure: exits, cancels, residual flatten. */
  readonly liveOrderEnabled: boolean;
  /** May run an operator-triggered emergency flatten. Separate on purpose. */
  readonly emergencyFlatten: boolean;
}

/**
 * Evaluate whether a specific live permission may be turned ON.
 *
 * ASYMMETRY IS THE POINT. Enabling ENTRY demands every precondition. Enabling exposure
 * MANAGEMENT and EMERGENCY FLATTEN demand far less, because refusing them is itself dangerous:
 * a feed hiccup or an open circuit must never be the reason a position cannot be closed. This
 * mirrors the coordinator's existing entry/exit asymmetry rather than inventing a new policy.
 *
 * Turning a permission OFF is always allowed and is never routed through this function.
 */
export function evaluateLiveArm(args: {
  readonly permission: keyof LiveArmPermissions;
  readonly pre: LiveArmPreconditions;
}): { readonly ok: true } | { readonly ok: false; readonly blockers: readonly ModeTransitionBlocker[] } {
  const blockers: ModeTransitionBlocker[] = [];
  const add = (code: string, detail: string): void => void blockers.push({ code, detail });

  if (!args.pre.deploymentLiveCapable) {
    add(
      "deployment_gate_disabled",
      "LIVE UNAVAILABLE — deployment gate disabled: BOX_EXECUTION_MODE=live and BOX_LIVE_TRADING_ENABLED=true " +
        "are required, and cannot be set from the UI.",
    );
    // Nothing else matters: without capability no live permission is meaningful.
    return { ok: false, blockers };
  }

  if (args.permission === "emergencyFlatten") {
    // A protective capability. Requires only that the broker can be reached at all; making it
    // conditional on feed health or a closed circuit would withhold the emergency brake in
    // precisely the circumstances it exists for.
    if (!args.pre.brokerAuthenticated) add("broker_unauthenticated", "the broker session is not authenticated");
    return blockers.length === 0 ? { ok: true } : { ok: false, blockers };
  }

  if (args.permission === "liveOrderEnabled") {
    // Exposure management. Needs an authenticated broker and finished reconciliation so that
    // reductions are attributed to the right positions, but not a warm feed or a closed circuit.
    if (!args.pre.brokerAuthenticated) add("broker_unauthenticated", "the broker session is not authenticated");
    if (!args.pre.reconciliationComplete) add("reconciliation_incomplete", "reconciliation has not completed");
    return blockers.length === 0 ? { ok: true } : { ok: false, blockers };
  }

  // entryEnabled — the full gauntlet.
  if (!args.pre.brokerAuthenticated) add("broker_unauthenticated", "the broker session is not authenticated");
  if (!args.pre.reconciliationHealthy) add("reconciliation_unhealthy", "reconciliation is unhealthy");
  if (!args.pre.reconciliationComplete) add("reconciliation_incomplete", "reconciliation has not completed");
  if (!args.pre.feedHealthy) add("feed_unhealthy", "the market-data feed is unhealthy");
  if (!args.pre.feedWarmedUp) add("feed_warming", "the feed is still inside its reconnect warm-up window");
  if (!args.pre.circuitClosed) add("circuit_open", "the live circuit breaker is tripped");
  if (args.pre.recoveryActive) add("recovery_active", "recovery handling is active");
  if (args.pre.unknownOrders > 0) add("unknown_order", `${args.pre.unknownOrders} order(s) have unknown broker state`);
  if (!args.pre.durableReservationsAvailable) {
    add("durable_reservations_unavailable", "the durable reservation authority is unavailable; live entry fails closed");
  }
  return blockers.length === 0 ? { ok: true } : { ok: false, blockers };
}
