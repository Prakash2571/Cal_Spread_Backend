/**
 * Atomic all-or-none reservation of a SET of option contracts.
 *
 * THIS FILE IS NOW A RE-EXPORT. The implementation moved to `./reservations/`, split
 * by tier, when the durable cross-process tier was added:
 *
 *   reservations/types.ts        the contract (now asynchronous, and why)
 *   reservations/identity.ts     globally unique owner ids and the lock namespace
 *   reservations/inProcess.ts    the fast process-local filter
 *   reservations/port.ts         the narrow set of database capabilities relied on
 *   reservations/durable.ts      the cross-process algorithm and its atomicity proof
 *   reservations/mongoStore.ts   the Mongo adapter, indexes, and server clock
 *   reservations/memoryStore.ts  the executable specification the tests run against
 *   reservations/chained.ts      tier composition, acquire/release ordering
 *
 * The path stays because it is the import every existing caller and test already uses,
 * and a durable tier is not a reason to churn them.
 *
 * IT RE-EXPORTS `reservations/core.js`, NOT `reservations/index.js`, AND THAT MATTERS.
 * `reservations/index.js` includes the Mongo adapter, which imports mongoose, which
 * imports `db.ts`. Re-exporting it here would drag a database driver into the module
 * graph of every consumer of this path — including several offline unit tests that
 * import it only to name a type, and which would then fail to load at all. `core.js` is
 * the dependency-free half; only the engine, which is already database-bound, imports
 * the barrel that can reach Mongo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT CHANGED, AND WHY THE OLD ARGUMENT NO LONGER SUFFICES
 * ─────────────────────────────────────────────────────────────────────────────
 * This module used to argue — correctly — that `InProcessInstrumentReservations` is
 * genuinely atomic because `tryAcquireAll` inspects every key and then writes every
 * key with no `await` between the two passes, and Node runs one turn of the event loop
 * to completion. That argument is still true, and it is still relied on. It is simply
 * not ENOUGH, because it is a statement about one process.
 *
 * Under PM2 cluster mode, multiple backend workers, several EC2 instances, Kubernetes
 * replicas, or a separate Box execution service, each process owns a different Map.
 * Both see RELIANCE 2550CE as free. Both reserve it. Both send an order. Same-leg
 * protection was therefore process-local, not deployment-wide — and the old docblock
 * said so, anticipating exactly this change: "implement the interface, chain it, and
 * set `requireDurableReservations` so live execution fails closed when it is
 * unavailable."
 *
 * That is what happened. The in-process tier was NOT thrown away — it is a free filter
 * that rejects the most common conflicts before any network call — but it is no longer
 * authoritative. MongoDB is, via a unique multikey index that makes a four-leg claim
 * atomic. See `reservations/durable.ts` for the full argument.
 */

export {
  // The contract.
  type AcquireArgs,
  type InstrumentReservationStore,
  type OwnershipVerdict,
  type ReleaseArgs,
  type RenewArgs,
  type RenewOutcome,
  type ReservationConflictDetail,
  type ReservationContext,
  type ReservationDurability,
  type ReservationLease,
  type ReservationOutcome,
  type ReservationStoreDiagnostics,
  type ReservationWaitable,
  type VerifyArgs,
  isWaitable,
  BoundedSamples,
  dedupeKeys,
  normaliseTtl,
  safeErrorMessage,
  // Tiers.
  InProcessInstrumentReservations,
  DurableInstrumentReservations,
  ChainedInstrumentReservations,
  // The durable authority's port contract, and the reference implementation the tests
  // drive it with.
  type DurableReservationDoc,
  type DurableReservationPort,
  type InsertReservationResult,
  InMemoryReservationDatabase,
  InMemoryReservationPort,
  // Identity.
  type ProcessIdentity,
  createProcessIdentity,
  mintOwnerId,
  isOwnedByProcess,
  processOwnerPrefix,
  resolveDeploymentId,
  isDeploymentIdExplicit,
} from "./reservations/core.js";
