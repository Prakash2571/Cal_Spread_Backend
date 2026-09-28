/**
 * `synth_trades` persistence, behind the engine's `SynthTradeStore` seam.
 *
 * Two writes matter and both are atomic:
 *   - an entry is an insert that the unique partial index rejects when the
 *     underlying already has an open position;
 *   - an exit is a single `$set` guarded on `status: "open"`, so a manual close
 *     racing an automatic one can never close a position twice.
 */

import mongoose from "mongoose";
import { isBoxConnectionReady } from "../db.js";
import type { SynthTradeStore } from "./engine.js";
import type { SynthTrade } from "./math.js";
import { SynthTradeModel, type ISynthTrade } from "./model.js";

/** Mongo duplicate-key error code. */
const DUPLICATE_KEY = 11000;

type SynthTradeRecord = ISynthTrade & { _id: mongoose.Types.ObjectId };

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: number }).code === DUPLICATE_KEY
  );
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
