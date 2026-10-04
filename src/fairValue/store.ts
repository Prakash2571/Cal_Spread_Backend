import mongoose from "mongoose";
import { isDbEnabled } from "../db.js";
import type { FairValueConfig, InputSnapshot, SurfaceSnapshot } from "./types.js";
import { historySummary, type FairValueHistorySummary } from "./history.js";

export interface FairValueStore {
  enabled(): boolean;
  loadConfig(): Promise<FairValueConfig | null>;
  saveConfig(config: FairValueConfig, version: string): Promise<void>;
  append(snapshot: SurfaceSnapshot, input: InputSnapshot, limit: number, retentionDays: number): Promise<void>;
  history(underlying: string, limit: number): Promise<FairValueHistorySummary[]>;
  snapshot(underlying: string, id: string): Promise<SurfaceSnapshot | null>;
}

const settingsSchema = new mongoose.Schema({
  _id: String, version: String, config: mongoose.Schema.Types.Mixed, updated_at: Date,
}, { collection: "fair_value_settings", bufferCommands: false });
const snapshotSchema = new mongoose.Schema({
  _id: String, underlying: { type: String, index: true }, input_snapshot_id: String,
  model_version: String, config_version: String, at: { type: Date, index: true },
  expires_at: { type: Date, expires: 0 }, snapshot: mongoose.Schema.Types.Mixed,
  input: mongoose.Schema.Types.Mixed,
}, { collection: "fair_value_snapshots", bufferCommands: false });
const settings = mongoose.model("FairValueSettings", settingsSchema);
const snapshots = mongoose.model("FairValueSnapshot", snapshotSchema);

/** Dedicated collections on the existing app connection; unconfigured Mongo is explicit memory-only analytics. */
export class MongoFairValueStore implements FairValueStore {
  enabled(): boolean { return isDbEnabled(); }
  async loadConfig(): Promise<FairValueConfig | null> {
    if (!this.enabled()) return null;
    const row = await settings.findById("current").maxTimeMS(3000).lean();
    return (row?.config as FairValueConfig | undefined) ?? null;
  }
  async saveConfig(config: FairValueConfig, version: string): Promise<void> {
    if (!this.enabled()) throw new Error("Fair Value configuration is memory-only: MongoDB is not available.");
    await settings.updateOne({ _id: "current" }, { $set: { config, version, updated_at: new Date() } }, { upsert: true, maxTimeMS: 3000 });
  }
  async append(snapshot: SurfaceSnapshot, input: InputSnapshot, limit: number, retentionDays: number): Promise<void> {
    if (!this.enabled()) return;
    const at = new Date(snapshot.published_at);
    const { listing_catalog: _catalog, ...calibrationInput } = input;
    await snapshots.updateOne({ _id: snapshot.id }, { $setOnInsert: {
      underlying: snapshot.underlying, input_snapshot_id: input.id,
      model_version: snapshot.model_version, config_version: snapshot.config_version, at,
      expires_at: new Date(at.getTime() + retentionDays * 86400000), snapshot, input: calibrationInput,
    } }, { upsert: true, maxTimeMS: 3000 });
    // Only this module's bounded analytics history is pruned; trade/input collections
    // are not referenced. TTL is a second bound for unvisited underlyings.
    const old = await snapshots.find({ underlying: snapshot.underlying }).sort({ at: -1 }).skip(limit)
      .select({ _id: 1 }).limit(500).maxTimeMS(3000).lean();
    if (old.length) await snapshots.deleteMany({ _id: { $in: old.map((r) => r._id) } }).maxTimeMS(3000);
  }
  async history(underlying: string, limit: number): Promise<FairValueHistorySummary[]> {
    if (!this.enabled()) return [];
    const rows = await snapshots.find({ underlying, expires_at: { $gt: new Date() } }).sort({ at: -1 })
      .limit(limit).select({
        "snapshot.id": 1, "snapshot.input_snapshot_id": 1, "snapshot.model_version": 1,
        "snapshot.config_version": 1, "snapshot.sequence": 1, "snapshot.underlying": 1,
        "snapshot.broker": 1, "snapshot.valuation_time": 1, "snapshot.published_at": 1,
        "snapshot.slices.expiry": 1, "snapshot.slices.expiry_timestamp": 1,
        "snapshot.slices.atm_iv": 1, "snapshot.slices.quality": 1, "snapshot.slices.smile.method": 1,
        "snapshot.slices.smile.calibration.observation_count": 1,
      }).maxTimeMS(3000).lean();
    // Projection excludes rows, quotes, listing metadata and calibration payloads
    // from summary reads, keeping history-list memory/I/O proportional to slices.
    return rows.map((r) => historySummary(r.snapshot as SurfaceSnapshot));
  }
  async snapshot(underlying: string, id: string): Promise<SurfaceSnapshot | null> {
    if (!this.enabled()) return null;
    const row = await snapshots.findOne({ _id: id, underlying, expires_at: { $gt: new Date() } })
      .maxTimeMS(3000).lean();
    return (row?.snapshot as SurfaceSnapshot | undefined) ?? null;
  }
}
