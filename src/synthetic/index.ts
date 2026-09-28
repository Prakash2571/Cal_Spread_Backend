/**
 * Futures-vs-synthetic arbitrage module: the single entry point index.ts uses.
 *
 * Wired by dependency injection like Box, so it reuses the active broker's
 * instrument cache, REST quotes and Box market-data lane without importing
 * index.ts. See engine.ts for scope (scanner + paper trading) and math.ts for the
 * maths. Paper trades persist in `synth_trades` (repository.ts).
 */

import type { Express } from "express";
import { SyntheticEngine, type SyntheticEngineDeps, type SynthTradeStore } from "./engine.js";
import { mongoSynthTradeStore } from "./repository.js";
import { registerSyntheticRoutes, type SyntheticRouteDeps } from "./routes.js";

export interface SyntheticModuleDeps extends Omit<SyntheticEngineDeps, "store"> {
  /** Defaults to the Mongo store on the Box connection. */
  store?: SynthTradeStore;
  requireAdmin: SyntheticRouteDeps["requireAdmin"];
  getAdminRole: SyntheticRouteDeps["getAdminRole"];
}

export interface SyntheticModule {
  engine: SyntheticEngine;
  /** Adopt open paper positions and start the monitor loop. Call once the DB is up. */
  boot: () => Promise<void>;
}

export function registerSyntheticModule(app: Express, deps: SyntheticModuleDeps): SyntheticModule {
  const { requireAdmin, getAdminRole, store, ...engineDeps } = deps;
  const engine = new SyntheticEngine({ ...engineDeps, store: store ?? mongoSynthTradeStore });
  registerSyntheticRoutes(app, { engine, requireAdmin, getAdminRole });
  return { engine, boot: () => engine.boot() };
}

export { SyntheticEngine };
