/**
 * Box arbitrage module — the single entry point index.ts talks to.
 *
 * The whole module is wired by dependency injection so it can reuse the
 * application's Kite session, shared WebSocket, instrument cache and Zerodha
 * charge estimator WITHOUT index.ts having to export its internals or the box
 * code having to import from it (which would be a circular import).
 *
 * PAPER TRADING ONLY. Nothing in this module calls a Zerodha order-placement
 * API. Fills are simulated at the executable market touch that was visible in
 * the snapshot the decision was made on, and are stored with
 * execution_mode: "paper_touch".
 */

import type { Express, RequestHandler } from "express";
import type { Instrument, KiteClient } from "../kite.js";
import type { TickerHub } from "../hub.js";
import { BoxEngine } from "./engine.js";
import type { PriceChargeGroupsFn } from "./charges.js";
import type { BoxBoardItem } from "./instruments.js";
import { registerBoxRoutes } from "./routes.js";

export interface BoxModuleDeps {
  kite: KiteClient;
  tickerHub: TickerHub;
  /** The shared, cached instrument dump. */
  getAllInstruments: () => Promise<Instrument[]>;
  /** The F&O board (underlying → spot token), reused for the box universe. */
  getBoard: () => Promise<BoxBoardItem[]>;
  /** The EXISTING calendar charge estimator, injected unchanged. */
  priceChargeGroups: PriceChargeGroupsFn;
  istDayKey: (at?: number) => string;
  makeIdResolver: (all: Instrument[]) => (token: number) => string | null;
  /** NSE equity-derivatives hours, reused from the calendar engine. */
  isMarketOpen: () => boolean;
  /** Zerodha basket-margin API, reused unchanged from the calendar engine. */
  getBasketMargin: (
    orders: {
      exchange: string;
      tradingsymbol: string;
      transaction_type: "BUY" | "SELL";
      variety: string;
      product: string;
      order_type: string;
      quantity: number;
      price: number;
    }[],
  ) => Promise<{ initial: number; final: number; total: number }>;
  requireAdmin: RequestHandler;
  getAdminRole: (token: string | undefined) => "full" | "trade" | null;
}

export interface BoxModule {
  /** Adopt open positions and start the (always-on) position monitor. */
  boot: () => Promise<void>;
  engine: BoxEngine;
}

/**
 * Register the box module: routes now, background work on boot().
 *
 * Returns a handle whose `boot()` should be called once the database connection
 * is up, so any box left open by a previous process is adopted and monitored
 * again immediately.
 */
export function registerBoxModule(app: Express, deps: BoxModuleDeps): BoxModule {
  const engine = new BoxEngine({
    kite: deps.kite,
    tickerHub: deps.tickerHub,
    getAllInstruments: deps.getAllInstruments,
    getBoard: deps.getBoard,
    priceChargeGroups: deps.priceChargeGroups,
    istDayKey: deps.istDayKey,
    makeIdResolver: deps.makeIdResolver,
    isMarketOpen: deps.isMarketOpen,
    getBasketMargin: deps.getBasketMargin,
  });

  registerBoxRoutes(app, {
    engine,
    requireAdmin: deps.requireAdmin,
    getAdminRole: deps.getAdminRole,
  });

  return {
    boot: () => engine.boot(),
    engine,
  };
}

export { BoxEngine };
export type { BoxBoardItem };
