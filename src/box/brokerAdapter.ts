/**
 * BROKER ADAPTER — the execution boundary, prepared but PAPER ONLY.
 *
 * ============================ SAFETY NOTICE ================================
 * There is NO live-broker implementation in this module, and there must never
 * be one added here without an explicit, separate decision. Nothing in this file
 * calls Zerodha/Kite order-placement endpoints or submits a live order. The
 * `PaperBrokerAdapter` simulates fills from observed WebSocket books only.
 * ==========================================================================
 *
 * The purpose is architectural separation, not live trading: the strategy talks
 * to an ORDER interface, so the same strategy could one day be pointed at a
 * `KiteBrokerAdapter` without the box maths changing. That adapter does not exist
 * and is out of scope; this interface simply documents the seam and lets the paper
 * engine be described in the same vocabulary a real one would use.
 *
 * In this codebase the concrete paper "broker" is the LegExecutor (independent
 * per-order lifecycles) driven by the BoxExecutionSimulator. This adapter is a
 * thin, honest façade over that machinery rather than a second execution engine —
 * duplicating the lifecycle would be exactly the kind of over-abstraction the
 * brief warns against.
 */

import type {
  OrderSide,
  PaperLegExecution,
  PaperOrderPricing,
  ResidualLegExposure,
} from "./types.js";

/** A request to work one simulated order. */
export interface BrokerOrderRequest {
  client_order_id: string;
  tradingsymbol: string;
  token: number;
  side: OrderSide;
  quantity: number;
  pricing: PaperOrderPricing;
}

/** A simulated position the adapter is holding (paper). */
export interface BrokerPosition {
  token: number;
  tradingsymbol: string;
  side: OrderSide;
  quantity: number;
  average_price: number;
}

/**
 * The order interface a strategy would use against ANY broker.
 *
 * Deliberately small: the box strategy only ever needs to submit, cancel, and
 * inspect. A real implementation would map these onto the broker's REST/WS order
 * API; the paper implementation maps them onto the deterministic LegExecutor.
 */
export interface BrokerAdapter {
  /** A stable id for this adapter ("paper", or a live one that does not exist yet). */
  readonly kind: "paper";
  /** Submit one order and resolve when it reaches a terminal state. */
  submitOrder(req: BrokerOrderRequest): Promise<PaperLegExecution>;
  /** Cancel a working order by client id (paper: best-effort, no-op if resolved). */
  cancelOrder(clientOrderId: string): Promise<boolean>;
  /** Inspect a known order. */
  getOrder(clientOrderId: string): PaperLegExecution | undefined;
  /** All orders this adapter has produced this session. */
  listOrders(): PaperLegExecution[];
  /** Outstanding simulated positions the adapter still holds. */
  listPositions(): BrokerPosition[];
}

/**
 * Derive the residual positions still held from a set of resolved leg orders.
 *
 * A helper shared by the paper adapter and the simulator so "what am I still
 * holding" is computed one way: any leg with filled quantity that was not fully
 * unwound is outstanding exposure.
 */
export function residualFromLegs(legs: PaperLegExecution[], now: number): ResidualLegExposure[] {
  const out: ResidualLegExposure[] = [];
  for (const leg of legs) {
    const outstanding = leg.fill_qty - leg.unwound_qty;
    if (outstanding <= 0) continue;
    out.push({
      token: leg.token,
      tradingsymbol: leg.tradingsymbol,
      role: leg.role,
      side: leg.side,
      quantity: outstanding,
      average_price: leg.average_fill_price ?? leg.fill_price ?? 0,
      source: "partial_entry",
      created_at: now,
    });
  }
  return out;
}
