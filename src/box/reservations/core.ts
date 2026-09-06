/**
 * The DEPENDENCY-FREE half of the reservation subsystem.
 *
 * WHY THIS SPLIT EXISTS
 * `index.ts` assembles the real stack and therefore imports the Mongo adapter, which
 * imports mongoose, which imports `db.ts`. Anything that re-exports it inherits a
 * database driver in its module graph.
 *
 * That is fine for the engine, which is database-bound anyway. It is NOT fine for the
 * many callers that touch reservations only to name a type or to construct the
 * in-process tier — the Box test suite is deliberately offline, and several of its
 * files import the reservation path purely for types. Pulling mongoose in would stop
 * those modules loading at all.
 *
 * So: `core.ts` is everything that needs no external package, and `index.ts` is
 * `core.ts` plus the Mongo binding plus the factory. The barrel is imported by exactly
 * one production module (the engine); everything else uses this.
 */

export * from "./types.js";
export * from "./port.js";
export * from "./identity.js";
export { InProcessInstrumentReservations } from "./inProcess.js";
export { ChainedInstrumentReservations } from "./chained.js";
export { DurableInstrumentReservations, type DurableReservationsDeps } from "./durable.js";
export {
  InMemoryReservationDatabase,
  InMemoryReservationPort,
  type InMemoryReservationPortOptions,
} from "./memoryStore.js";
