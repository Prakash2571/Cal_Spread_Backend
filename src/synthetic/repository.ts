/**
 * `synth_trades` persistence, behind the engine's `SynthTradeStore` seam.
 *
 * Two writes matter and both are atomic:
 *   - an entry is an insert that the unique partial index rejects when the
 *     underlying already has an open position;
 *   - an exit is a single `$set` guarded on `status: "open"`, so a manual close
 *     racing an automatic one can never close a position twice.
 *
 * The unique index is created and verified by `ensureReady()` rather than left to
 * Mongoose's autoIndex (see model.ts); the engine allows no paper entry until it
 * has succeeded.
 */

import mongoose from "mongoose";
import { isBoxConnectionReady } from "../db.js";
import type { SynthTradeStore } from "./engine.js";
import type { SynthTrade } from "./math.js";
import { SynthTradeModel, type ISynthTrade } from "./model.js";

/** Mongo duplicate-key error code. */
const DUPLICATE_KEY = 11000;

/** The index the one-open-position-per-underlying guarantee rests on. */
export const SYNTH_OPEN_UNIQUE_INDEX = "synth_open_one_per_underlying";

type SynthTradeRecord = ISynthTrade & { _id: mongoose.Types.ObjectId };

interface SynthIndexDescription {
  name?: string;
  unique?: boolean;
  key?: Record<string, unknown>;
  partialFilterExpression?: Record<string, unknown>;
}

/** The two native-collection calls used, so index setup does not depend on autoIndex. */
interface RawSynthCollection {
  createIndexes(specs: Record<string, unknown>[]): Promise<unknown>;
  indexes(): Promise<SynthIndexDescription[]>;
}

function rawCollection(): RawSynthCollection {
  return SynthTradeModel.collection as unknown as RawSynthCollection;
}

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: number }).code === DUPLICATE_KEY
  );
}

function exactRecord(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, unknown>,
): boolean {
  if (!actual) return false;
  const keys = Object.keys(expected);
  return (
    Object.keys(actual).length === keys.length &&
    keys.every((k) => Object.prototype.hasOwnProperty.call(actual, k) && actual[k] === expected[k])
  );
}

/** Why the stored indexes cannot be trusted, or null when they can. Pure, for tests. */
export function synthIndexValidationError(indexes: readonly SynthIndexDescription[]): string | null {
  const index = indexes.find((i) => i.name === SYNTH_OPEN_UNIQUE_INDEX);
  if (!index) return `missing ${SYNTH_OPEN_UNIQUE_INDEX} index`;
  if (index.unique !== true) return `${SYNTH_OPEN_UNIQUE_INDEX} is not unique`;
  if (!exactRecord(index.key, { underlying: 1 })) {
    return `${SYNTH_OPEN_UNIQUE_INDEX} has incompatible keys`;
  }
  if (!exactRecord(index.partialFilterExpression, { status: "open" })) {
    return `${SYNTH_OPEN_UNIQUE_INDEX} has an incompatible partial filter`;
  }
  return null;
}

function toRecord(t: SynthTrade): SynthTradeRecord {
  const { id, opened_at, closed_at, ...rest } = t;
  return {
    ...rest,
    _id: new mongoose.Types.ObjectId(id),
    opened_at: new Date(opened_at),
    closed_at: closed_at === null ? null : new Date(closed_at),
  };
}

function fromRecord(r: SynthTradeRecord): SynthTrade {
  const { _id, opened_at, closed_at, __v: _version, ...rest } = r as SynthTradeRecord & {
    __v?: number;
  };
  return {
    ...rest,
    id: String(_id),
    opened_at: new Date(opened_at).getTime(),
    closed_at: closed_at ? new Date(closed_at).getTime() : null,
  };
}

export const mongoSynthTradeStore: SynthTradeStore = {
  enabled: () => isBoxConnectionReady(),

  newId: () => new mongoose.Types.ObjectId().toString(),

  /**
   * Create the indexes and read the unique one back.
   *
   * Fails (and the engine keeps paper entries off) when the index cannot be built,
   * typically because two open rows for one underlying already exist, or when an
   * incompatible index of the same name is in the way. Nothing is dropped or rebuilt
   * silently.
   */
  async ensureReady(): Promise<void> {
    const collection = rawCollection();
    try {
      await collection.createIndexes([
        {
          key: { underlying: 1 },
          name: SYNTH_OPEN_UNIQUE_INDEX,
          unique: true,
          partialFilterExpression: { status: "open" },
        },
        // The Closed-trades read path, newest first.
        { key: { status: 1, closed_at: -1 }, name: "synth_status_closed_at" },
        // Today's closed trades, for the day P&L after a restart.
        { key: { closed_day: 1 }, name: "synth_closed_day" },
      ]);
    } catch (err) {
      throw new Error(
        `failed to establish ${SYNTH_OPEN_UNIQUE_INDEX}; duplicate open rows or an incompatible ` +
          `index may exist: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const problem = synthIndexValidationError(await collection.indexes());
    if (problem) throw new Error(`synth_trades persistence is unsafe: ${problem}`);
  },

  async insertOpen(trade: SynthTrade): Promise<"ok" | "duplicate"> {
    try {
      await SynthTradeModel.create(toRecord(trade));
      return "ok";
    } catch (err) {
      if (isDuplicateKeyError(err)) return "duplicate";
      throw err;
    }
  },

  async close(trade: SynthTrade): Promise<boolean> {
    const { _id, ...fields } = toRecord(trade);
    const res = await SynthTradeModel.updateOne({ _id, status: "open" }, { $set: fields });
    return res.matchedCount === 1;
  },

  async get(id: string): Promise<SynthTrade | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const row = await SynthTradeModel.findById(id).lean<SynthTradeRecord>();
    return row ? fromRecord(row) : null;
  },

  async loadOpen(): Promise<SynthTrade[]> {
    const rows = await SynthTradeModel.find({ status: "open" })
      .sort({ opened_at: 1 })
      .lean<SynthTradeRecord[]>();
    return rows.map(fromRecord);
  },

  async loadClosed(opts: { limit: number; sinceDay?: string }): Promise<SynthTrade[]> {
    const filter: Record<string, unknown> = { status: "closed" };
    if (opts.sinceDay !== undefined) filter.closed_day = { $gte: opts.sinceDay };
    const rows = await SynthTradeModel.find(filter)
      .sort({ closed_at: -1 })
      .limit(opts.limit)
      .lean<SynthTradeRecord[]>();
    return rows.map(fromRecord);
  },
};
