/**
 * Futures-vs-synthetic arbitrage module: the single entry point index.ts uses.
 *
 * Wired by dependency injection like Box, so it reuses the active broker's
 * instrument cache, REST quotes and Box market-data lane without importing
 * index.ts. See engine.ts for scope (detection only) and math.ts for the maths.
 */

import type { Express } from "express";
import { SyntheticEngine, type SyntheticEngineDeps } from "./engine.js";
import { registerSyntheticRoutes, type SyntheticRouteDeps } from "./routes.js";

export interface SyntheticModuleDeps extends SyntheticEngineDeps {
  requireAdmin: SyntheticRouteDeps["requireAdmin"];
  getAdminRole: SyntheticRouteDeps["getAdminRole"];
}

export interface SyntheticModule {
  engine: SyntheticEngine;
}

export function registerSyntheticModule(app: Express, deps: SyntheticModuleDeps): SyntheticModule {
  const { requireAdmin, getAdminRole, ...engineDeps } = deps;
  const engine = new SyntheticEngine(engineDeps);
  registerSyntheticRoutes(app, { engine, requireAdmin, getAdminRole });
  return { engine };
}

export { SyntheticEngine };
