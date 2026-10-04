import type { SurfaceSnapshot } from "./types.js";

/** Memory history has count, time, underlying-count AND byte ceilings. */
export class SnapshotHistory {
  private entries = new Map<string, { snapshot: SurfaceSnapshot; bytes: number }>();
  private bytes = 0;
  constructor(private options: { maxBytes: number; maxUnderlyings: number; now: () => number }) {}
  add(snapshot: SurfaceSnapshot, perUnderlyingLimit: number, retentionDays: number): void {
    const bytes = Buffer.byteLength(JSON.stringify(snapshot));
    if (bytes > this.options.maxBytes) return;
    const previous = this.entries.get(snapshot.id);
    if (previous) this.bytes -= previous.bytes;
    this.entries.delete(snapshot.id);
    this.entries.set(snapshot.id, { snapshot, bytes });
    this.bytes += bytes;
    const cutoff = this.options.now() - retentionDays * 86400000;
    const byUnderlying = new Map<string, string[]>();
    for (const [id, entry] of [...this.entries].reverse()) {
      if (Date.parse(entry.snapshot.published_at) < cutoff) { this.remove(id); continue; }
      const ids = byUnderlying.get(entry.snapshot.underlying) ?? [];
      if (ids.length >= perUnderlyingLimit) { this.remove(id); continue; }
      ids.push(id); byUnderlying.set(entry.snapshot.underlying, ids);
    }
    for (const [underlying, ids] of [...byUnderlying].slice(this.options.maxUnderlyings)) {
      for (const id of ids) this.remove(id);
      byUnderlying.delete(underlying);
    }
    while (this.bytes > this.options.maxBytes && this.entries.size > 0) this.remove(this.entries.keys().next().value!);
  }
  list(underlying: string, retentionDays: number): SurfaceSnapshot[] {
    const cutoff = this.options.now() - retentionDays * 86400000;
    return [...this.entries.values()].filter((e) => e.snapshot.underlying === underlying && Date.parse(e.snapshot.published_at) >= cutoff)
      .map((e) => e.snapshot).reverse();
  }
  get(underlying: string, id: string, retentionDays: number): SurfaceSnapshot | null {
    const entry = this.entries.get(id);
    return entry?.snapshot.underlying === underlying && Date.parse(entry.snapshot.published_at) >= this.options.now() - retentionDays * 86400000 ? entry.snapshot : null;
  }
  stats(): { snapshots: number; bytes: number } { return { snapshots: this.entries.size, bytes: this.bytes }; }
  private remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.bytes -= entry.bytes; this.entries.delete(id);
  }
}

export function historySummary(snapshot: SurfaceSnapshot) {
  return { id: snapshot.id, input_snapshot_id: snapshot.input_snapshot_id, model_version: snapshot.model_version,
    config_version: snapshot.config_version, sequence: snapshot.sequence, underlying: snapshot.underlying,
    broker: snapshot.broker, valuation_time: snapshot.valuation_time, published_at: snapshot.published_at,
    slices: snapshot.slices.map((s) => ({ expiry: s.expiry, expiry_timestamp: s.expiry_timestamp, atm_iv: s.atm_iv,
      quality: s.quality, method: s.smile.method, observations: s.smile.calibration.observation_count })) };
}

export type FairValueHistorySummary = ReturnType<typeof historySummary>;
