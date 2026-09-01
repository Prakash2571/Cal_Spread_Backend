/**
 * EXECUTION POLICY — how a broker would work an order, kept SEPARATE from what
 * the strategy wants.
 *
 * The scanner/monitor (the strategy) decide the candidate, the direction, the
 * quantity and the economic requirement. They must NOT know how a broker chases a
 * price. This object owns exactly that: the reference price, the limit, the chase
 * band, the timeout, parallel vs sequential submission, the queue haircut and how
 * much wider an emergency unwind may reach. The executor asks the policy to price
 * an order; the policy never recomputes a box-strategy rule.
 *
 * That separation is what lets the same strategy later run against a different
 * execution profile (or, one day, a real BrokerAdapter) without touching the box
 * maths — and it keeps the chase/queue logic out of the hot scanner path.
 */

import type { BoxConfig } from "./config.js";
import { buildOrderPricing } from "./orderPricing.js";
import type { BoxLegExecutionMode, BoxOptionInstrument, BoxQueueModel, OrderSide, PaperOrderPricing } from "./types.js";

/** The phase an order is being priced for — entries and unwinds get different bands. */
export type ExecutionPhase = "entry" | "unwind";

export class BoxExecutionPolicy {
  constructor(private readonly cfg: BoxConfig) {}

  get legExecutionMode(): BoxLegExecutionMode {
    return this.cfg.legExecutionMode;
  }

  get legTimeoutMs(): number {
    return Math.max(0, this.cfg.legTimeoutMs);
  }

  get latencyMs(): number {
    return Math.max(0, this.cfg.simulatedLatencyMs);
  }

  get decisionMs(): number {
    return Math.max(0, this.cfg.simulatedDecisionMs);
  }

  get unwindLatencyMs(): number {
    return Math.max(0, this.cfg.legUnwindLatencyMs);
  }

  get queueModel(): BoxQueueModel {
    return this.cfg.queueModel;
  }

  get queueHaircutPct(): number {
    return this.cfg.queueLiquidityHaircutPct;
  }

  get maxCrossLegExchangeDispersionMs(): number {
    return Math.max(0, this.cfg.maxCrossLegExchangeDispersionMs);
  }

  get quoteMaxAgeMs(): number {
    return this.cfg.quoteMaxAgeMs;
  }

  get executionPollMs(): number {
    return Math.max(1, this.cfg.executionPollMs);
  }

  /** Ticks of chase allowed for a phase — unwinds may deliberately reach wider. */
  chaseTicksFor(phase: ExecutionPhase): number {
    return phase === "unwind" ? this.cfg.unwindMaxChaseTicks : this.cfg.legMaxChaseTicks;
  }

  /** The instrument's real tick size, falling back to the configured default. */
  tickSizeFor(inst: Pick<BoxOptionInstrument, "tick_size">): number {
    return inst.tick_size && inst.tick_size > 0 ? inst.tick_size : this.cfg.defaultTickSize;
  }

  /**
   * Price one order: a marketable limit against `referencePrice`, tick-sized to
   * the instrument, with the phase's chase band. This is the ONE place a chase
   * band is turned into a limit price.
   */
  priceOrder(args: {
    side: OrderSide;
    quantity: number;
    referencePrice: number;
    inst: Pick<BoxOptionInstrument, "tick_size">;
    phase: ExecutionPhase;
  }): PaperOrderPricing {
    return buildOrderPricing({
      side: args.side,
      quantity: args.quantity,
      referencePrice: args.referencePrice,
      tickSize: this.tickSizeFor(args.inst),
      maxChaseTicks: this.chaseTicksFor(args.phase),
    });
  }
}
