/**
 * THE MONGO ADAPTER — the durable correctness authority.
 *
 * COLLECTION `box_instrument_reservations`
 *   _id          the globally unique owner id (so owner lookup is a primary-key hit,
 *                and owner uniqueness is enforced by the database rather than hoped for)
 *   deployment   lock namespace: production / staging / development
 *   broker       zerodha | dhan
 *   generation   broker generation this reservation was taken under
 *   keys         the COMPLETE instrument set, as an array
 *   fence        monotonic fencing token
 *   expires_at   authority-clock expiry
 *
 * INDEXES, AND WHY EACH EXISTS
 *   1. `{ deployment: 1, keys: 1 }` UNIQUE  ← the entire safety property.
 *      `keys` is an array, so this is a MULTIKEY index: Mongo writes one index entry
 *      per element. A unique constraint applies across documents, so no
 *      `(deployment, key)` pair can exist in two documents. That is literally "no
 *      contract is held by two live reservations". Only one array field appears in the
 *      compound key, which is the documented requirement for a compound multikey index.
 *      Scoping by `deployment` is what keeps a developer's laptop from contending with
 *      production in a shared cluster.
 *
 *   2. `{ expires_at: 1 }` with `expireAfterSeconds: 0` ← GARBAGE COLLECTION ONLY.
 *      Mongo's TTL monitor runs roughly once a minute, so a document routinely
 *      outlives its expiry. NOTHING in the algorithm depends on this index: expiry is
 *      decided logically from the stored timestamp (see `durable.ts`). This index only
 *      stops abandoned rows accumulating forever.
 *
 *   3. `{ deployment: 1, broker: 1, generation: 1 }` ← operator queries and
 *      generation-scoped housekeeping.
 *
 * `autoIndex` IS EXPLICITLY DISABLED.
 * Leaving index creation to Mongoose's `autoIndex` would mean the unique constraint
 * that provides the whole atomicity guarantee might silently not exist — most likely
 * in production, where `autoIndex` is exactly what people turn off. So indexes are
 * created deliberately in `ensureReady()` and then READ BACK AND VERIFIED. If the
 * unique index is absent or not actually unique, this adapter refuses to become ready,
 * and live Box entry fails closed rather than running without the protection it thinks
 * it has.
 *
 * TIME COMES FROM THE SERVER.
 * `serverTimeMs()` performs an aggregation-pipeline update that stamps `$$NOW` onto a
 * bookkeeping document and reads it back. `$$NOW` is the server's clock and is
 * identical for every member of the deployment, so every worker derives expiry from
 * ONE clock and worker-to-worker skew cannot cause two owners. A pipeline update is
 * used rather than the `hello` admin command because it needs only the write access
 * this collection already requires — no admin privilege, which some managed tiers
 * restrict.
 */

import mongoose from "mongoose";
import { boxConnection, isBoxConnectionReady } from "../../db.js";
import type {
  DurableReservationDoc,
  DurableReservationPort,
  InsertReservationResult,
} from "./port.js";

const COLLECTION = "box_instrument_reservations";
const FENCE_COLLECTION = "box_reservation_fences";

export const RESERVATION_UNIQUE_INDEX = "box_reservation_unique_contract";
export const RESERVATION_TTL_INDEX = "box_reservation_ttl";
export const RESERVATION_SCOPE_INDEX = "box_reservation_scope";

/** Mongo duplicate-key error code. */
const DUPLICATE_KEY = 11000;
/** The `_id` of the document `serverTimeMs()` stamps `$$NOW` onto. */
const CLOCK_DOC_ID = "__clock__";

interface ReservationRow {
  _id: string;
  deployment: string;
  broker: string;
  generation: number;
  mode: string;
  keys: string[];
  sides: { key: string; side: string }[];
  fence: number;
  instance: string;
  created_at: Date;
  expires_at: Date;
  renewed_at: Date;
}

const sideSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    side: { type: String, default: "" },
  },
  { _id: false },
);

/**
 * The reservation schema.
 *
 * `autoIndex: false` is the point: see the module docblock. Indexes are created and
 * verified explicitly, never implicitly.
 */
const reservationSchema = new mongoose.Schema<ReservationRow>(
  {
    _id: { type: String },
    deployment: { type: String, required: true },
    broker: { type: String, required: true },
    generation: { type: Number, required: true },
    mode: { type: String, default: "" },
    keys: { type: [String], required: true },
    sides: { type: [sideSchema], default: [] },
    fence: { type: Number, required: true },
    instance: { type: String, default: "" },
    created_at: { type: Date, required: true },
    expires_at: { type: Date, required: true },
    renewed_at: { type: Date, required: true },
  },
  { collection: COLLECTION, versionKey: false, autoIndex: false },
);

interface FenceRow {
  _id: string;
  seq: number;
  at: Date;
}

const fenceSchema = new mongoose.Schema<FenceRow>(
  {
    _id: { type: String },
    seq: { type: Number, default: 0 },
    at: { type: Date, default: null },
  },
  { collection: FENCE_COLLECTION, versionKey: false, autoIndex: false },
);

/**
 * Bound to the dedicated box connection when `BOX_MONGODB_URI` is configured, and to
 * the main connection otherwise — the same rule every other box model follows, so the
 * lock always lives in the same database as the trades it protects.
 */
function boxModel<T>(name: string, schema: mongoose.Schema<T>): mongoose.Model<T> {
  return boxConnection ? boxConnection.model<T>(name, schema) : mongoose.model<T>(name, schema);
}

const ReservationModel = boxModel<ReservationRow>("BoxInstrumentReservation", reservationSchema);
const FenceModel = boxModel<FenceRow>("BoxReservationFence", fenceSchema);

/**
 * Which unique index rejected an insert?
 *
 * The two causes need different handling — an `_id` collision is our own re-entrant
 * row and is safely deleted, a `keys` collision is somebody else's live lease and must
 * not be touched — so guessing is not acceptable. `keyPattern` is the driver's
 * structured answer; the message parse is a fallback for older error shapes, and an
 * unrecognised duplicate is reported as a KEY conflict because that is the
 * conservative reading: it refuses the acquire instead of deleting a row.
 */
function duplicateTarget(error: unknown): "owner" | "key" | null {
  const err = error as { code?: number; keyPattern?: Record<string, unknown>; message?: string } | null;
  if (err?.code !== DUPLICATE_KEY) return null;
  const pattern = err.keyPattern;
  if (pattern && Object.prototype.hasOwnProperty.call(pattern, "_id")) return "owner";
  if (pattern && Object.prototype.hasOwnProperty.call(pattern, "keys")) return "key";
  const message = String(err.message ?? "");
  if (/index:\s*_id_/.test(message)) return "owner";
  if (message.includes(RESERVATION_UNIQUE_INDEX)) return "key";
  return "key";
}

function toDoc(row: ReservationRow): DurableReservationDoc {
  return {
    owner: row._id,
    deployment: row.deployment,
    broker: row.broker,
    generation: row.generation,
    mode: row.mode ?? "",
    keys: row.keys ?? [],
    sides: (row.sides ?? []).map((entry) => ({ key: entry.key, side: entry.side ?? "" })),
    fence: row.fence,
    instance: row.instance ?? "",
    createdAt: row.created_at instanceof Date ? row.created_at.getTime() : 0,
    expiresAt: row.expires_at instanceof Date ? row.expires_at.getTime() : 0,
    renewedAt: row.renewed_at instanceof Date ? row.renewed_at.getTime() : 0,
  };
}

export class MongoReservationPort implements DurableReservationPort {
  readonly name = "mongo";
  /** A shared database really is shared. */
  readonly crossProcess = true;

  private indexesVerified = false;

  /**
   * Ready only while the connection is up AND the indexes have been verified since the
   * last time it was up.
   *
   * The verification flag is CLEARED on any observed disconnect rather than latched
   * forever. Latching it would mean an index dropped during a maintenance window — or a
   * reconnect to a different cluster — was never re-detected: inserts would silently stop
   * being unique while this tier kept reporting itself healthy, which is the one failure
   * mode that turns the whole design into decoration.
   */
  get ready(): boolean {
    if (!isBoxConnectionReady()) {
      this.indexesVerified = false;
      return false;
    }
    return this.indexesVerified;
  }

  /**
   * Create the indexes, VERIFY them, and prove the server answers.
   *
   * Ordering matters: the indexes must exist before a single reservation is written,
   * because a document inserted without the unique index in place would establish a
   * duplicate that then prevents the index from ever being built.
   */
  async ensureReady(): Promise<void> {
    if (!isBoxConnectionReady()) {
      throw new Error("box MongoDB connection is not ready");
    }
    const collection = ReservationModel.collection;
    try {
      await collection.createIndexes([
        // THE safety property. Unique + multikey over `keys`, namespaced by deployment.
        { key: { deployment: 1, keys: 1 }, name: RESERVATION_UNIQUE_INDEX, unique: true },
        // Garbage collection only — never relied on for correctness.
        { key: { expires_at: 1 }, name: RESERVATION_TTL_INDEX, expireAfterSeconds: 0 },
        { key: { deployment: 1, broker: 1, generation: 1 }, name: RESERVATION_SCOPE_INDEX },
      ]);
    } catch (error) {
      // An options conflict means an index of this NAME already exists with different
      // options — most dangerously, a non-unique one from an earlier deployment. That
      // must be surfaced, not swallowed: continuing would run without exclusion.
      throw new Error(
        `failed to create ${COLLECTION} indexes (an incompatible index may already exist; ` +
          `drop it and restart): ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // VERIFY rather than assume. `createIndexes` succeeding is good evidence, reading
    // the index back is proof — and this is the one guarantee the whole design rests on.
    const indexes = (await collection.indexes()) as {
      name?: string;
      unique?: boolean;
      key?: Record<string, unknown>;
    }[];
    const unique = indexes.find((index) => index.name === RESERVATION_UNIQUE_INDEX);
    if (unique === undefined) {
      throw new Error(`${COLLECTION} is missing the ${RESERVATION_UNIQUE_INDEX} index`);
    }
    if (unique.unique !== true) {
      throw new Error(
        `${COLLECTION} index ${RESERVATION_UNIQUE_INDEX} exists but is NOT unique; ` +
          `contract exclusion would not be enforced`,
      );
    }
    const key = unique.key ?? {};
    if (!("deployment" in key) || !("keys" in key)) {
      throw new Error(
        `${COLLECTION} index ${RESERVATION_UNIQUE_INDEX} does not cover (deployment, keys)`,
      );
    }

    // Prove the server answers AND that the clock path works, before anything relies on it.
    await this.serverTimeMs();
    this.indexesVerified = true;
  }

  /**
   * The authority's clock.
   *
   * `$currentDate` stamps the SERVER's current date onto a bookkeeping document and the
   * updated document is read back. Every worker therefore derives expiry from one clock,
   * and worker-to-worker skew cannot produce two simultaneous owners.
   *
   * `$currentDate` rather than an aggregation-pipeline `$$NOW`: it is a plain update
   * operator supported on every server version this backend could meet, it needs no
   * privilege beyond writing to this collection (unlike the `hello` admin command, which
   * some managed tiers restrict), and it avoids any question of how the ODM casts a
   * pipeline expression into a `Date` field.
   */
  async serverTimeMs(): Promise<number> {
    const row = await FenceModel.findOneAndUpdate(
      { _id: CLOCK_DOC_ID },
      { $currentDate: { at: true } },
      { upsert: true, returnDocument: "after", projection: { at: 1 } },
    ).lean<FenceRow>();
    const at = row?.at;
    if (!(at instanceof Date)) {
      throw new Error("MongoDB did not return a server timestamp");
    }
    return at.getTime();
  }

  /**
   * A genuinely monotonic fencing token.
   *
   * `$inc` on a single document is atomic, so concurrent callers receive distinct,
   * strictly increasing values. Deliberately NOT derived from a timestamp: two
   * workers with skewed clocks could produce the same or a decreasing token, and a
   * token that can go backwards cannot identify a stale owner.
   */
  async nextFence(deployment: string): Promise<number> {
    const row = await FenceModel.findOneAndUpdate(
      { _id: `fence:${deployment}` },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after", projection: { seq: 1 } },
    ).lean<FenceRow>();
    const seq = row?.seq;
    if (typeof seq !== "number" || !Number.isFinite(seq)) {
      throw new Error("MongoDB did not return a fencing token");
    }
    return seq;
  }

  /**
   * ONE document, atomically. All keys or none.
   *
   * The native driver is used directly rather than a Mongoose document so the raw
   * duplicate-key error shape reaches `duplicateTarget()` unmodified.
   */
  async insert(doc: DurableReservationDoc): Promise<InsertReservationResult> {
    const row: ReservationRow = {
      _id: doc.owner,
      deployment: doc.deployment,
      broker: doc.broker,
      generation: doc.generation,
      mode: doc.mode,
      keys: [...doc.keys],
      sides: doc.sides.map((entry) => ({ key: entry.key, side: entry.side })),
      fence: doc.fence,
      instance: doc.instance,
      created_at: new Date(doc.createdAt),
      expires_at: new Date(doc.expiresAt),
      renewed_at: new Date(doc.renewedAt),
    };
    try {
      await ReservationModel.collection.insertOne(row);
      return "inserted";
    } catch (error) {
      const target = duplicateTarget(error);
      if (target === "owner") return "owner_exists";
      if (target === "key") return "key_conflict";
      // Not a duplicate: a real failure. It must propagate so the tier reports
      // `unavailable` and live entry fails closed, rather than being read as "free".
      throw error;
    }
  }

  async deleteExpired(args: {
    readonly deployment: string;
    readonly keys?: readonly string[];
    readonly notAfter: number;
  }): Promise<number> {
    const filter: Record<string, unknown> = {
      deployment: args.deployment,
      expires_at: { $lte: new Date(args.notAfter) },
    };
    if (args.keys !== undefined) filter.keys = { $in: [...args.keys] };
    const result = await ReservationModel.collection.deleteMany(filter);
    return result.deletedCount ?? 0;
  }

  async findLiveByKeys(args: {
    readonly deployment: string;
    readonly keys: readonly string[];
    readonly now: number;
  }): Promise<DurableReservationDoc[]> {
    const rows = await ReservationModel.find({
      deployment: args.deployment,
      keys: { $in: [...args.keys] },
      expires_at: { $gt: new Date(args.now) },
    }).lean<ReservationRow[]>();
    return rows.map(toDoc);
  }

  async findByOwner(owner: string): Promise<DurableReservationDoc | null> {
    const row = await ReservationModel.findById(owner).lean<ReservationRow>();
    return row === null || row === undefined ? null : toDoc(row);
  }

  /** Owner-scoped, optionally fence-pinned. Never key-scoped. */
  async deleteOwned(args: { readonly owner: string; readonly fence?: number }): Promise<number> {
    const filter: Record<string, unknown> = { _id: args.owner };
    if (args.fence !== undefined) filter.fence = args.fence;
    const result = await ReservationModel.collection.deleteOne(filter);
    return result.deletedCount ?? 0;
  }

  /**
   * Extend a lease only if the owner (and fence) still match AND it has not already
   * expired on the server's clock.
   *
   * The `expires_at: { $gt: now }` predicate is what makes renewal a genuine ownership
   * test rather than a blind write: a lease that already lapsed cannot be resurrected,
   * because a challenger may legitimately have taken the contracts by then.
   */
  async renewOwned(args: {
    readonly owner: string;
    readonly fence?: number;
    readonly broker?: string;
    readonly generation?: number;
    readonly now: number;
    readonly expiresAt: number;
  }): Promise<DurableReservationDoc | null> {
    const filter: Record<string, unknown> = {
      _id: args.owner,
      expires_at: { $gt: new Date(args.now) },
    };
    if (args.fence !== undefined) filter.fence = args.fence;
    // In the filter, so a superseded lease is never extended before being rejected.
    if (args.broker !== undefined) filter.broker = args.broker;
    if (args.generation !== undefined) filter.generation = args.generation;
    const row = await ReservationModel.findOneAndUpdate(
      filter,
      { $set: { expires_at: new Date(args.expiresAt), renewed_at: new Date(args.now) } },
      { returnDocument: "after" },
    ).lean<ReservationRow>();
    return row === null || row === undefined ? null : toDoc(row);
  }

  /**
   * Delete every reservation owned by ONE process.
   *
   * The prefix carries deployment, host, pid and per-boot token, so it cannot match a
   * sibling worker. Anchored with `^` and fully escaped, so a prefix can never be
   * interpreted as a pattern.
   */
  async deleteByOwnerPrefix(prefix: string): Promise<number> {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const result = await ReservationModel.collection.deleteMany({
      _id: { $regex: `^${escaped}` },
    });
    return result.deletedCount ?? 0;
  }

  async countLive(args: { readonly deployment: string; readonly now: number }): Promise<number> {
    return ReservationModel.countDocuments({
      deployment: args.deployment,
      expires_at: { $gt: new Date(args.now) },
    });
  }
}
