/**
 * SHADOW MODE — the real feed, the real strategy, simulated orders, and NO broker order. Ever.
 *
 * WHY (audit divergence D14)
 *
 * There is a gap between "paper looks right on recorded data" and "we are willing to send real
 * money through this". Shadow mode is the bridge: the live market feed and the real strategy run
 * exactly as they would in production, paper `live_parity` produces the orders it would have
 * produced, and nothing is ever submitted. That gives a continuous, zero-risk stream of
 * predictions which can later be compared against real executions once live trading is separately
 * enabled for an actual trade.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * THE DESIGN CONSTRAINT: IT MUST BE STRUCTURALLY UNABLE TO SUBMIT
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 * A flag that is merely CHECKED before submitting is not good enough. Checks get bypassed by new
 * code paths, refactors and error handlers. So shadow mode is enforced three ways, each
 * independently sufficient:
 *
 *  1. CONFIGURATION. `loadBoxConfig` REFUSES TO START if shadow mode is combined with
 *     `BOX_EXECUTION_MODE=live`. The contradiction is resolved by stopping, not by silently
 *     picking a winner — one choice places unwanted orders and the other silently disables
 *     trading somebody believed was on.
 *  2. NO ADAPTER EXISTS. Live adapters are only constructed when the execution mode is `live`,
 *     and shadow mode cannot coexist with that mode. In shadow mode there is no live adapter and
 *     no OrderManager, so there is no object capable of reaching a broker.
 *  3. THIS GUARD. A defence-in-depth wrapper that turns any attempt to submit into a loud,
 *     attributable throw, so a future code path that somehow acquires an adapter still cannot
 *     place an order — and the mistake is visible immediately instead of at the exchange.
 *
 * Layer 3 exists precisely because layers 1 and 2 are invariants that a future refactor could
 * weaken. It is cheap insurance against the single most expensive possible bug.
 */

import type {
  BrokerAdapter,
  BrokerModifyRequest,
  BrokerOrder,
  BrokerOrderRequest,
  BrokerPosition,
  BrokerHealth,
  BrokerMargin,
} from "./brokerAdapter.js";

/** Thrown when anything attempts a broker mutation while shadow mode is active. */
export class ShadowModeViolationError extends Error {
  constructor(operation: string, clientOrderId?: string) {
    super(
      `[Box] SHADOW MODE: refusing to ${operation}${clientOrderId ? ` for ${clientOrderId}` : ""}. ` +
        `Shadow mode runs the real strategy against the real feed but must NEVER submit a broker order. ` +
        `This is a defence-in-depth guard: reaching it means a code path acquired a live adapter that it should not have.`,
    );
    this.name = "ShadowModeViolationError";
  }
}

/**
 * Wrap an adapter so every MUTATION throws while every READ is still permitted.
 *
 * Reads stay open deliberately: shadow mode is a validation tool, and being able to read the
 * order book and positions is what makes an after-the-fact comparison possible. It is writes —
 * place, modify, cancel — that must be impossible. (A cancel is a mutation too: in shadow mode
 * there is nothing of ours to cancel, so an attempt indicates a genuine logic error.)
 */
export function shadowGuardedAdapter(adapter: BrokerAdapter): BrokerAdapter {
  const guarded: BrokerAdapter = {
    mode: adapter.mode,
    ...(adapter.prepareOrder ? { prepareOrder: (req: BrokerOrderRequest) => adapter.prepareOrder!(req) } : {}),

    submitOrder(req: BrokerOrderRequest): Promise<BrokerOrder> {
      throw new ShadowModeViolationError("submit a broker order", req.client_order_id);
    },
    cancelOrder(clientOrderId: string): Promise<BrokerOrder | undefined> {
      throw new ShadowModeViolationError("cancel a broker order", clientOrderId);
    },
    modifyOrder(clientOrderId: string, _request: BrokerModifyRequest): Promise<BrokerOrder> {
      throw new ShadowModeViolationError("modify a broker order", clientOrderId);
    },

    // Reads pass through untouched.
    getOrder: (clientOrderId: string): Promise<BrokerOrder | undefined> => adapter.getOrder(clientOrderId),
    listOrders: (): Promise<BrokerOrder[]> => adapter.listOrders(),
    listPositions: (): Promise<BrokerPosition[]> => adapter.listPositions(),
    ...(adapter.margins ? { margins: (): Promise<BrokerMargin | null> => adapter.margins!() } : {}),
    ...(adapter.health ? { health: (): Promise<BrokerHealth> => adapter.health!() } : {}),
    // adoptOrder is deliberately NOT forwarded: adopting a live order means taking ownership of
    // real exposure, which shadow mode has no business doing.
  };
  return guarded;
}

export interface ShadowModeStatus {
  readonly enabled: boolean;
  /** True when the configuration makes a broker submission structurally impossible. */
  readonly submissionImpossible: boolean;
  readonly reasons: string[];
}

/**
 * Describe why submission is (or is not) impossible, for the admin surface.
 *
 * Reports the ACTUAL structural reasons rather than just echoing the flag, so an operator can see
 * that safety rests on configuration invariants and not on a single boolean.
 */
export function shadowModeStatus(args: {
  shadowEnabled: boolean;
  executionMode: string;
  hasOrderManager: boolean;
}): ShadowModeStatus {
  const reasons: string[] = [];
  if (args.shadowEnabled) reasons.push("shadow mode is enabled");
  if (args.executionMode !== "live") {
    reasons.push(`execution mode is "${args.executionMode}", so no live adapter is constructed`);
  }
  if (!args.hasOrderManager) reasons.push("no OrderManager exists, so nothing can reach a broker");

  const impossible = args.executionMode !== "live" || !args.hasOrderManager;
  return { enabled: args.shadowEnabled, submissionImpossible: impossible, reasons };
}
