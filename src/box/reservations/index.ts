/**
 * Reservation tier assembly.
 *
 * One place decides what the chain looks like, so the engine does not have to know
 * whether a durable tier exists, and the coordinator never has to branch on it.
 */

import { ChainedInstrumentReservations } from "./chained.js";
import { DurableInstrumentReservations } from "./durable.js";
import { InProcessInstrumentReservations } from "./inProcess.js";
import { MongoReservationPort } from "./mongoStore.js";
import { createProcessIdentity, processOwnerPrefix, type ProcessIdentity } from "./identity.js";
import type { InstrumentReservationStore, ReservationContext } from "./types.js";

// The dependency-free half. Consumers that must NOT pull mongoose in should import
// `./core.js` (or `../instrumentReservations.js`) rather than this barrel.
export * from "./core.js";
export {
  MongoReservationPort,
  RESERVATION_UNIQUE_INDEX,
  RESERVATION_TTL_INDEX,
  RESERVATION_SCOPE_INDEX,
} from "./mongoStore.js";

export interface ReservationStackOptions {
  /** Build the durable tier at all. When false the stack is local-only. */
  readonly durableEnabled: boolean;
  /** Deployment/broker identity for durable documents. */
  readonly context: () => ReservationContext;
  readonly skewGraceMs?: number;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
  /** Injected by tests to stand in for Mongo. */
  readonly identity?: ProcessIdentity;
}

export interface ReservationStack {
  /** What the coordinator talks to. */
  readonly store: InstrumentReservationStore;
  /** The fast tier, kept separately because only it can offer event-driven wakeups. */
  readonly local: InProcessInstrumentReservations;
  /** Null when durable reservations are disabled. */
  readonly durable: DurableInstrumentReservations | null;
  readonly identity: ProcessIdentity;
  /**
   * Bring the durable tier up. Resolves to whether it is usable.
   *
   * NEVER throws: an unreachable database is a normal operating state that the
   * coordinator reports as `unavailable` and fails closed on, not an exception that
   * should prevent the engine from booting and managing existing exposure.
   */
  initialise(): Promise<boolean>;
}

/**
 * Assemble the reservation stack.
 *
 * Order is `[local, durable]`, which is the acquire order: the cheap process-local
 * filter first, the cross-process authority second. See `chained.ts` for why that
 * ordering — and the reverse release ordering — is the correct one.
 */
export function createReservationStack(options: ReservationStackOptions): ReservationStack {
  const identity = options.identity ?? createProcessIdentity();
  const local = new InProcessInstrumentReservations();

  if (!options.durableEnabled) {
    return {
      store: local,
      local,
      durable: null,
      identity,
      initialise: async () => false,
    };
  }

  const durable = new DurableInstrumentReservations({
    port: new MongoReservationPort(),
    context: options.context,
    ownerPrefix: processOwnerPrefix(identity),
    ...(options.skewGraceMs === undefined ? {} : { skewGraceMs: options.skewGraceMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });

  return {
    store: new ChainedInstrumentReservations([local, durable]),
    local,
    durable,
    identity,
    initialise: async () => {
      try {
        await durable.initialise();
        // Startup recovery: clean ONLY what has already lost its lease. Live
        // reservations belonging to other workers are authoritative and are left
        // alone, which is the entire point of making the store durable.
        await durable.reapExpired();
        return durable.ready;
      } catch (error) {
        options.log?.(
          `durable reservations unavailable at startup: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
    },
  };
}
