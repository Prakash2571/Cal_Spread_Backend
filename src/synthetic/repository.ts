/**
 * `synth_trades` persistence, behind the engine's `SynthTradeStore` seam.
 *
 * The writes that matter are all atomic:
 *   - an entry is an insert that the unique partial index rejects when the
 *     underlying already has an open position;
 *   - an exit is a single `$set` guarded on `status: "open"`, so a manual close
 *     racing an automatic one can never close a position twice;
 *   - a delete is a SOFT delete (`status: "deleted"`), guarded on the status the
 *     caller saw, so it can never swallow a close that landed in between;
 *   - margin is written only by `setMargin`. A close never carries margin fields,
 *     so a close cannot overwrite a margin figure that arrived while it was in flight.
 *
 * The unique index is created and verified by `ensureReady()` rather than left to
 * Mongoose's autoIndex (see model.ts); the engine allows no paper entry until it
 * has succeeded.
 */

import mongoose from "mongoose";
import { isBoxConnectionReady } from "../db.js";
import { SYNTH_SETTING_KEYS, type SynthSettingKey, type SynthSettings } from "./config.js";
import type { SynthMarginPatch, SynthTradeStore } from "./engine.js";
import type { SynthTrade } from "./math.js";
import {
  SynthSettingModel,
  SynthTradeModel,
  type ISynthSetting,
  type ISynthTrade,
} from "./model.js";

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
  const { id, opened_at, closed_at, margin_at, ...rest } = t;
  return {
    ...rest,
    _id: new mongoose.Types.ObjectId(id),
    opened_at: new Date(opened_at),
    closed_at: closed_at === null ? null : new Date(closed_at),
    margin_at: margin_at === null ? null : new Date(margin_at),
  };
}

function fromRecord(r: SynthTradeRecord): SynthTrade {
  const {
    _id,
    opened_at,
    closed_at,
    margin_at,
    status,
    deleted_at: _deletedAt,
    deleted_from: _deletedFrom,
    delete_reason: _deleteReason,
    deleted_by: _deletedBy,
    __v: _version,
    ...rest
  } = r as SynthTradeRecord & { __v?: number };
  return {
    ...rest,
    // Rows written before these fields existed read as "no figure yet".
    order_type: "LIMIT",
    margin: rest.margin ?? null,
    margin_source: rest.margin_source ?? null,
    margin_hedge_benefit: rest.margin_hedge_benefit ?? null,
    margin_error: rest.margin_error ?? null,
    id: String(_id),
    status: status === "open" ? "open" : "closed",
    opened_at: new Date(opened_at).getTime(),
    closed_at: closed_at ? new Date(closed_at).getTime() : null,
    margin_at: margin_at ? new Date(margin_at).getTime() : null,
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
    // Margin is owned by setMargin: never written here, so a close cannot clobber it.
    const {
      _id,
      margin: _m,
      margin_source: _ms,
      margin_hedge_benefit: _mh,
      margin_at: _ma,
      margin_error: _me,
      ...fields
    } = toRecord(trade);
    const res = await SynthTradeModel.updateOne({ _id, status: "open" }, { $set: fields });
    return res.matchedCount === 1;
  },

  async setMargin(id: string, patch: SynthMarginPatch): Promise<void> {
    if (!mongoose.isValidObjectId(id)) return;
    await SynthTradeModel.updateOne(
      // Open or closed rows only: a deleted row is an audit record and stays as it was.
      { _id: new mongoose.Types.ObjectId(id), status: { $ne: "deleted" } },
      {
        $set: {
          margin: patch.margin,
          margin_source: patch.margin_source,
          margin_hedge_benefit: patch.margin_hedge_benefit,
          margin_at: patch.margin_at === null ? null : new Date(patch.margin_at),
          margin_error: patch.margin_error,
        },
      },
    );
  },

  async markDeleted(
    id: string,
    from: "open" | "closed",
    audit: { reason: string | null; actor: string; at: number },
  ): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;
    const res = await SynthTradeModel.updateOne(
      { _id: new mongoose.Types.ObjectId(id), status: from },
      {
        $set: {
          status: "deleted",
          deleted_at: new Date(audit.at),
          deleted_from: from,
          delete_reason: audit.reason,
          deleted_by: audit.actor,
        },
      },
    );
    return res.matchedCount === 1;
  },

  async get(id: string): Promise<(SynthTrade & { deleted?: boolean; deleted_from?: "open" | "closed" }) | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const row = await SynthTradeModel.findById(id).lean<SynthTradeRecord>();
    if (!row) return null;
    if (row.status !== "deleted") return fromRecord(row);
    return { ...fromRecord(row), deleted: true, deleted_from: row.deleted_from === "open" ? "open" : "closed" };
  },

  async loadOpen(): Promise<SynthTrade[]> {
    const rows = await SynthTradeModel.find({ status: "open" })
      .sort({ opened_at: 1 })
      .lean<SynthTradeRecord[]>();
    return rows.map(fromRecord);
  },

  /** The saved settings (raw, validated by the engine). Keys never saved are absent. */
  async loadSettings(): Promise<Partial<Record<SynthSettingKey, number>>> {
    const rows = await SynthSettingModel.find().lean<ISynthSetting[]>();
    const out: Partial<Record<SynthSettingKey, number>> = {};
    for (const row of rows) {
      const key = SYNTH_SETTING_KEYS.find((k) => k === row._id);
      if (key && typeof row.value === "number" && Number.isFinite(row.value)) out[key] = row.value;
    }
    return out;
  },

  /**
   * Save every setting in ONE command. Throws on failure: the admin is told the value
   * was saved, so a silent failure would show a setting that reverts on restart.
   */
  async saveSettings(values: SynthSettings): Promise<void> {
    const now = new Date();
    await SynthSettingModel.bulkWrite(
      SYNTH_SETTING_KEYS.map((key) => ({
        updateOne: {
          filter: { _id: key },
          update: { $set: { value: values[key], updated_at: now } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
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
