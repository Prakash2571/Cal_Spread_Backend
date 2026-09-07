/**
 * RESIDUAL-FLATTEN ATTEMPT IDENTITY.
 *
 * A residual leg is exposure we hold and did not want. The flatten loop works it every
 * `RESIDUAL_FLATTEN_MS` until the book is flat. That loop is a RETRY loop, and a retry loop
 * whose durable order identity never changes cannot retry.
 *
 * THE DEFECT THIS MODULE EXISTS TO PREVENT
 * The identity used to be `stableAttemptId(attemptId, residual.created_at, role)`, and
 * `created_at` is preserved when the shrunken residual is written back — so every pass
 * regenerated the SAME `client_order_id`:
 *
 *   - filled 0 (the normal reason a residual exists): the durable intent upsert returns the
 *     existing non-CREATED intent, `OrderManager.execute()` takes its "a prior submission
 *     exists" branch, re-reads the stale order and resolves. NO ORDER IS EVER SENT AGAIN and
 *     the residual stays naked indefinitely.
 *   - filled partially: the remaining quantity changed but the identity did not, so
 *     `assertIntentImmutableMatch` throws on `quantity` — and that error matched neither branch
 *     of the old catch, so it was swallowed. Every later pass threw the same way.
 *
 * THE INVARIANT
 *   SAME logical submission  => SAME identity   (so a retry/reconcile adopts, never duplicates)
 *   NEW attempt for still-outstanding quantity => NEW identity  (so a retry can actually retry)
 *
 * HOW THE GENERATION STAYS DURABLE AND CRASH-SAFE
 * The generation lives ON the residual record (`flatten_attempt`), which is persisted by the
 * SAME `updateBoxExecutionAttemptResidual` write that persists the new remaining quantity. One
 * document write carries both, so the pair can never be torn:
 *
 *   advance + shrink        -> one atomic `$set` of `residual_exposure`
 *   crash before that write -> the generation is UNCHANGED on restart, so the next pass reuses
 *                              the same identity, and the durable intent journal (one document
 *                              per `client_order_id`) decides what that means: a `CREATED`
 *                              intent is submitted (no POST had happened), anything later is
 *                              adopted through `adapter.getOrder`. Never a duplicate order.
 *   crash after that write  -> the previous generation reached a TERMINAL broker outcome before
 *                              we advanced (that is the only disposition that advances), so its
 *                              identity is spent and the new one is genuinely new.
 *
 * The generation is therefore never a loose in-memory counter, never `Date.now()` and never
 * random: each attempt is represented explicitly by its own row in `box_order_intents`.
 */

import { isBrokerOrderTerminal, type BrokerOrder } from "./brokerAdapter.js";
import type { ResidualLegExposure } from "./types.js";

/** The generation a residual carries before anything has been attempted. */
export const FIRST_RESIDUAL_FLATTEN_ATTEMPT = 1;

/**
 * Upper bound on how far the durable journal is probed when a residual arrives with no
 * generation of its own (crash-recovery exposure derived from the intent journal rather than
 * read from a persisted residual). Bounded so a pathological journal cannot spin.
 */
export const MAX_RESIDUAL_FLATTEN_ATTEMPT_PROBE = 64;

/**
 * What the last attempt on this residual established, and therefore whether the NEXT attempt
 * may reuse its identity.
 *
 * An enum rather than a pair of booleans because the four cases have genuinely different
 * safety meanings, and "advance" is only ever legal in one of them.
 */
export type ResidualFlattenDisposition =
  /** Nothing is left. The residual is gone. */
  | "flattened"
  /**
   * This identity reached a TERMINAL broker outcome (COMPLETE / CANCELLED / REJECTED) and
   * quantity remains. The identity is SPENT: the remainder needs a NEW generation, otherwise
   * the durable intent's immutable `quantity` blocks it forever.
   */
  | "retire_attempt"
  /**
   * Nothing reached the broker under this identity (no executable book, or a manager gate
   * refused before the POST). The identity is still unused, so the next pass MUST reuse it —
   * advancing here would burn generations and, worse, could POST a second reduction while the
   * first is still reserved.
   */
  | "reuse_attempt"
  /**
   * The broker's outcome for this identity is WORKING or UNKNOWN. Keep the identity so the next
   * pass reconciles/adopts it. Never advance and never resubmit: an ambiguous submission must
   * not become a duplicate POST.
   */
  | "adopt_attempt";

/** Why a flatten attempt did not flatten. Fixed, low-cardinality set — safe for telemetry. */
export type ResidualFlattenFailureKind =
  /** No book, or no executable touch price on the reducing side. Nothing was sent. */
  | "no_executable_book"
  /** A manager control/limit refused the order before it reached the broker. */
  | "gate_refused"
  /** The identity is already queued or in flight in this process. */
  | "already_in_flight"
  /** The broker refused the order and said so. A known outcome. */
  | "broker_rejected"
  /** The broker filled it but the durable snapshot failed. Broker truth wins. */
  | "persistence_after_fill"
  /** Ambiguous/timed-out submission, or an intent needing reconciliation. Quarantine. */
  | "broker_state_unknown"
  /**
   * A previous attempt's immutable durable fields collided with this one. Should be impossible
   * now that the generation is part of the identity; if it happens it is a bug, not a market
   * outcome, so it is surfaced and the generation is retired to unblock the exposure.
   */
  | "identity_conflict"
  /** Anything unclassified. Treated as "nothing proven sent", i.e. the identity is kept. */
  | "unexpected";

/** One residual leg's outcome for one flatten pass. */
export interface ResidualFlattenPass {
  readonly residual: ResidualLegExposure;
  /** Generation actually used for this pass. */
  readonly attempt: number;
  /** The broker order, when one exists (including one carried by an error). */
  readonly order: BrokerOrder | null;
  readonly disposition: ResidualFlattenDisposition;
  readonly failure: ResidualFlattenFailureKind | null;
  readonly detail: string | null;
}

/**
 * The generation to use for this residual's next submission.
 *
 * Legacy rows (written before this field existed) and any corrupt value read as the first
 * attempt, which is the safe reading: the first attempt's identity is adopted rather than
 * duplicated if it happens to already exist durably.
 */
export function residualFlattenAttempt(residual: ResidualLegExposure): number {
  const raw = residual.flatten_attempt;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return FIRST_RESIDUAL_FLATTEN_ATTEMPT;
  const floored = Math.floor(raw);
  return floored >= FIRST_RESIDUAL_FLATTEN_ATTEMPT ? floored : FIRST_RESIDUAL_FLATTEN_ATTEMPT;
}

/**
 * Compose the durable attempt id from the residual's stable scope and its generation.
 *
 * `base` keeps the pre-existing stable scoping (attempt id + residual origin + role), so two
 * different residuals still cannot collide; the `attempt-N` suffix is what makes a RETRY a new
 * logical order. The resulting `client_order_id` reads
 * `BOX:<trade>:EMERGENCY_RESIDUAL:<role>:residual-<role>-<hash>-attempt-<N>`.
 */
export function residualFlattenAttemptId(base: string, attempt: number): string {
  return `${base}-attempt-${Math.max(FIRST_RESIDUAL_FLATTEN_ATTEMPT, Math.floor(attempt))}`;
}

/**
 * Carry a residual forward to the next pass with the generation implied by its disposition.
 *
 * ONLY `retire_attempt` advances. Everything else keeps the identity so the durable journal can
 * adopt whatever the broker actually has.
 */
export function carryResidualForward(
  residual: ResidualLegExposure,
  quantity: number,
  attempt: number,
  disposition: ResidualFlattenDisposition,
): ResidualLegExposure {
  return {
    ...residual,
    quantity,
    flatten_attempt: disposition === "retire_attempt" ? attempt + 1 : attempt,
  };
}

/**
 * Classify a broker order returned by a residual submission.
 *
 * Terminal is the ONLY state that spends an identity, because it is the only state in which the
 * broker can no longer add quantity to that order. A working or unknown order must keep its
 * identity: issuing a second reduction while the first may still fill is how a flatten becomes
 * an over-reduction.
 */
export function classifyResidualOrder(
  order: BrokerOrder,
  requested: number,
): ResidualFlattenDisposition {
  if (!isBrokerOrderTerminal(order.state)) return "adopt_attempt";
  return order.filled_quantity >= requested ? "flattened" : "retire_attempt";
}

/**
 * Classify a thrown residual submission into a fixed failure kind.
 *
 * Deliberately message-based for the manager's own gate/identity errors: those are plain
 * `Error`s today, and the alternative (typed errors for every gate) is a far larger change to
 * the live order path than this fix should carry. `OrderPersistenceAfterFillError` and the
 * ambiguous-submit family are matched by the caller, which has the class in scope.
 */
export function classifyResidualFlattenErrorMessage(message: string): ResidualFlattenFailureKind {
  if (/reused with different immutable field/i.test(message)) return "identity_conflict";
  if (/already queued or active/i.test(message)) return "already_in_flight";
  if (/unknown|ambiguous|reconcil|timed? ?out/i.test(message)) return "broker_state_unknown";
  if (
    /quantity limits|exposure management|controls or limits|exposure changed while|disabled while/i
      .test(message)
  ) {
    return "gate_refused";
  }
  return "unexpected";
}

/** The disposition implied by a failure kind. Only `identity_conflict` may advance. */
export function dispositionForFailure(kind: ResidualFlattenFailureKind): ResidualFlattenDisposition {
  switch (kind) {
    case "no_executable_book":
    case "gate_refused":
    case "already_in_flight":
      // Nothing reached the broker. The identity is untouched and must be reused.
      return "reuse_attempt";
    case "broker_rejected":
      // The broker terminally refused this order. The identity is spent.
      return "retire_attempt";
    case "identity_conflict":
      // A stale immutable snapshot must never be able to strand exposure. Retire past it.
      return "retire_attempt";
    case "persistence_after_fill":
    case "broker_state_unknown":
      // The broker may hold quantity under this identity. Adopt it; never duplicate it.
      return "adopt_attempt";
    case "unexpected":
      // Nothing is proven. Keeping the identity is the safe default: the durable upsert will
      // adopt an existing submission and only submit when the intent is still CREATED.
      return "adopt_attempt";
  }
}

/**
 * Stable human phrase per failure kind, used in the invariant/operator message.
 *
 * Fixed wording so the operator-facing text is a contract rather than an accident of whatever
 * an exception happened to say — and so the message stays greppable across refactors.
 */
export function residualFailurePhrase(kind: ResidualFlattenFailureKind): string {
  switch (kind) {
    case "no_executable_book": return "no executable book on the reducing side";
    case "gate_refused": return "an order-manager gate refused the reduction before the broker";
    case "already_in_flight": return "the same attempt is already queued or in flight";
    case "broker_rejected": return "the broker terminally rejected the reduction";
    case "persistence_after_fill": return "filled but its durable snapshot failed";
    case "broker_state_unknown": return "uncertain broker terminal quantity; quarantined for reconciliation";
    case "identity_conflict": return "a stale durable intent blocked this attempt; the generation was retired past it";
    case "unexpected": return "an unclassified internal fault";
  }
}

/**
 * True when a failure kind must be raised as an invariant violation rather than counted as a
 * routine market outcome. A technical fault is not a market outcome.
 */
export function residualFailureIsInvariant(kind: ResidualFlattenFailureKind): boolean {
  return kind === "persistence_after_fill" ||
    kind === "broker_state_unknown" ||
    kind === "identity_conflict" ||
    kind === "unexpected";
}
