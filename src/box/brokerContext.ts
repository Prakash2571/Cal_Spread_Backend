/**
 * The broker-neutral dependencies the Box strategy is allowed to know about.
 *
 * WHY THIS FILE EXISTS
 * BoxEngine used to import `KiteClient` and construct `KiteBrokerAdapter` /
 * `KiteHttpTransport` itself. That made the strategy structurally dependent on
 * one venue: adding a second broker would have meant either a second engine (two
 * copies of the box maths — unacceptable) or `if (broker === "dhan")` branches
 * threaded through the decision path (worse).
 *
 * So the engine now depends only on the three narrow interfaces below. Concrete
 * brokers are assembled OUTSIDE the strategy and injected. The engine cannot name
 * Zerodha or Dhan, and therefore cannot accidentally prefer one.
 *
 * The surface is deliberately tiny — it is exactly what the engine actually used
 * from `KiteClient`, no more:
 *   - an authentication predicate
 *   - REST snapshot quotes (for the last-close view and the spot seed)
 *   - a basket-margin call
 *   - a factory for the live order adapter
 */

import type { BrokerId } from "../brokers/types.js";
import type { BrokerAdapter } from "./brokerAdapter.js";
import type { BoxConfig } from "./config.js";
import type { BoxChargesWithOrigin, OrderSide } from "./types.js";

/**
 * One instrument's REST snapshot, broker-neutral.
 *
 * `last_trade_time` is an IST "YYYY-MM-DD HH:MM:SS" string because the last-close
 * view derives the trading SESSION from its date part — that is the only way to
 * tell a strike that genuinely closed today from one whose last print is days old.
 * A provider that cannot supply it must return an empty string, which the caller
 * already treats as "not comparable" rather than as today.
 */
export interface BoxRestQuote {
  instrument_token: number;
  last_price: number;
  last_trade_time: string;
}

/**
 * Read-only market data, as the strategy consumes it.
 *
 * Note there is no `broker` field here: the engine asks the registry which broker
 * is active. Putting it on the provider too would create two answers to one
 * question and invite them to disagree.
 */
export interface BoxMarketDataProvider {
  /**
   * Whether the ACTIVE broker's session can currently serve data.
   *
   * Must reflect the broker session, never an admin password. `getStatus()`
   * publishes this as `authenticated`, and the UI must not print "Connected" for
   * an operator who merely typed the admin secret.
   */
  isAuthenticated(): boolean;
  /**
   * Snapshot quotes for "EXCHANGE:TRADINGSYMBOL" identifiers.
   *
   * Implementations are responsible for their own request chunking and rate
   * limiting; the engine passes the whole universe and expects one array back.
   */
  getQuoteFull(identifiers: string[]): Promise<BoxRestQuote[]>;
}

/** One leg of a basket-margin request, broker-neutral. */
export interface BoxMarginOrder {
  exchange: string;
  tradingsymbol: string;
  transaction_type: "BUY" | "SELL";
  variety: string;
  product: string;
  order_type: string;
  quantity: number;
  price: number;
}

/**
 * Net basket margin for a set of orders priced together.
 *
 * A four-leg box is margined as a BASKET, not as four independent positions — the
 * offsetting legs are most of the point — so this must always be asked about all
 * four legs at once, whichever broker answers.
 */
export interface BoxMarginProvider {
  /** Which broker's margin model produced the figure (for provenance display). */
  readonly broker: BrokerId;
  basketMargin(orders: BoxMarginOrder[]): Promise<{ initial: number; final: number; total: number }>;
}

/**
 * Builds the LIVE order adapter for a broker.
 *
 * A FACTORY rather than an instance because live adapters hold sockets, pacing
 * queues and session-local idempotency maps: switching broker must construct a
 * fresh one and discard the old, never mutate a shared object. The engine calls it
 * at most once, only when `executionMode === "live"`.
 *
 * Throwing here is the correct way to fail closed — a missing API key or an
 * unsatisfied static-IP requirement must stop live startup, not degrade to paper
 * silently.
 */
export type BoxLiveAdapterFactory = (ctx: {
  broker: BrokerId;
  cfg: BoxConfig;
}) => BrokerAdapter;


/**
 * The live feed, as the strategy uses it.
 *
 * Abstracts the six calls BoxEngine made directly on the Kite `TickerHub`. With this
 * in place the engine subscribes, unsubscribes and reads liveness without knowing
 * whether a Kite or a Dhan socket is behind it — which is what lets the registry
 * swap feeds on a broker switch without touching the strategy.
 */
export interface BoxFeedProvider {
  /** Register a tick listener. Returns a remover. */
  addTickListener(fn: (ticks: import("../ticker.js").Tick[]) => void): () => void;
  /**
   * Register a connection-state listener. Returns a remover.
   *
   * Implementations MUST deliver the current state immediately on subscribe, so a
   * late listener cannot mistake books gathered before it attached for warm ones.
   */
  addConnectionListener(fn: (connected: boolean) => void): () => void;
  /** Hold the feed open with no browser attached. Returns a release function. */
  retain(): () => void;
  subscribeTokens(tokens: number[]): void;
  unsubscribeTokens(tokens: number[]): void;
  subscribedCount(): number;
  isConnected(): boolean;
}

/**
 * A charge calculator, as the strategy uses it.
 *
 * `LocalChargeCalculator` (Zerodha) and `DhanChargeCalculator` both satisfy this, so
 * the active broker's fee schedule is injected rather than branched on. This is the
 * seam that stops a Dhan trade from being costed with Zerodha brokerage — the Box
 * expected-net gate spends whatever this object says, so it must be the right one.
 */
export interface BoxChargeCalculatorLike {
  legs(orders: BoxChargeCalcOrder[]): BoxChargesWithOrigin;
  roundTrip(orders: BoxChargeCalcOrder[]): {
    entry: BoxChargesWithOrigin;
    estimated_exit: BoxChargesWithOrigin;
    entry_total: number;
    estimated_exit_total: number;
  };
  /** Total charges for a set of orders — the hot-path helper the simulator uses. */
  totals(orders: BoxChargeCalcOrder[]): number;
  /** The stamped rate-card version, so a historical trade stays interpretable. */
  readonly rates: { rateVersion: string };
}

/** One order to be costed, broker-neutral. */
export interface BoxChargeCalcOrder {
  side: OrderSide;
  tradingsymbol: string;
  quantity: number;
  price: number;
}
