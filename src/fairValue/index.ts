import type { Express } from "express";
import { FairValueEngine, type FairValueDeps } from "./engine.js";
import { MongoFairValueStore } from "./store.js";
import { registerFairValueRoutes, type FairValueRouteDeps } from "./routes.js";
import { defaultConfig } from "./config.js";

export function registerFairValueModule(app: Express, deps: Omit<FairValueDeps, "store"> &
  Pick<FairValueRouteDeps, "requireFullAdmin" | "getAdminRole">) {
  let config = deps.config;
  let disabledReason = process.env.FAIR_VALUE_DISABLED === "true" ? "Fair Value disabled by FAIR_VALUE_DISABLED deployment switch." : null;
  try { config ??= defaultConfig(); }
  catch (error) {
    config = defaultConfig({});
    disabledReason = `Fair Value configuration invalid; analytics disabled: ${error instanceof Error ? error.message : "invalid config"}`;
    console.warn(disabledReason);
  }
  const engine = new FairValueEngine({ ...deps, config, forceDisabledReason: disabledReason, store: new MongoFairValueStore() });
  registerFairValueRoutes(app, { engine, requireFullAdmin: deps.requireFullAdmin, getAdminRole: deps.getAdminRole });
  return { engine, boot: () => engine.boot() };
}
