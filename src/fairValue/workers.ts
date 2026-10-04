import { Worker } from "node:worker_threads";
import type { InputSnapshot, SurfaceSnapshot } from "./types.js";

interface Job {
  id: number;
  kind: string;
  input: unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}
interface Slot { worker: Worker; job: Job | null; timer: ReturnType<typeof setTimeout> | null }

/** CPU analytics runs off the execution event loop. Bounded queue, workers and wall-clock time; poison jobs kill only their worker. */
export class AnalyticsWorkers {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private sequence = 0;
  private disposed = false;
  private failures = 0;
  constructor(private options: { concurrency: number; maxQueue: number; timeoutMs: number; workerUrl?: URL }) {}

  surface(input: InputSnapshot): Promise<SurfaceSnapshot> {
    // Full listing catalog is an immutable metadata lookup on the main side.
    // Fitting needs only captured instruments; avoid repeated large transfers.
    const { listing_catalog: _catalog, ...captured } = input;
    return this.submit("surface", captured);
  }

  submit<T>(kind: string, input: unknown): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("Analytics workers disabled/disposed."));
    if (this.queue.length >= this.options.maxQueue) return Promise.reject(new Error("Analytics worker queue is full."));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ id: ++this.sequence, kind, input, resolve: (value) => resolve(value as T), reject });
      this.dispatch();
    });
  }

  stats(): { running: number; queued: number; failures: number; workers: number } {
    return { running: this.slots.filter((s) => s.job !== null).length, queued: this.queue.length,
      failures: this.failures, workers: this.slots.length };
  }

  private makeSlot(): Slot {
    const worker = new Worker(this.options.workerUrl ?? new URL("./worker.js", import.meta.url),
      { resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 } });
    worker.unref();
    const slot: Slot = { worker, job: null, timer: null };
    worker.on("message", (message: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      if (!slot.job || slot.job.id !== message.id) return;
      const job = slot.job;
      if (slot.timer) clearTimeout(slot.timer);
      slot.timer = null;
      slot.job = null;
      if (message.ok) job.resolve(message.result);
      else { this.failures++; job.reject(new Error(message.error ?? "Analytics failed.")); }
      this.dispatch();
    });
    worker.on("error", (error) => this.failSlot(slot, error));
    worker.on("exit", (code) => {
      if (this.slots.includes(slot)) this.failSlot(slot, new Error(`Analytics worker exited (${code}).`));
    });
    this.slots.push(slot);
    return slot;
  }

  private dispatch(): void {
    if (this.disposed) return;
    while (this.queue.length > 0) {
      const slot = this.slots.find((s) => s.job === null) ??
        (this.slots.length < this.options.concurrency ? this.makeSlot() : null);
      if (!slot) return;
      const job = this.queue.shift()!;
      slot.job = job;
      slot.timer = setTimeout(() => this.failSlot(slot, new Error("Analytics worker time budget exceeded.")), this.options.timeoutMs);
      slot.timer.unref();
      try { slot.worker.postMessage({ id: job.id, kind: job.kind, input: job.input }); }
      catch (error) { this.failSlot(slot, error instanceof Error ? error : new Error("Worker input serialization failed.")); }
    }
  }

  private failSlot(slot: Slot, error: Error): void {
    if (!this.slots.includes(slot)) return;
    this.failures++;
    this.slots = this.slots.filter((s) => s !== slot);
    if (slot.timer) clearTimeout(slot.timer);
    slot.job?.reject(error);
    slot.job = null;
    void slot.worker.terminate().catch(() => {});
    this.dispatch();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const job of this.queue.splice(0)) job.reject(new Error("Analytics workers stopped."));
    const slots = this.slots.splice(0);
    for (const slot of slots) {
      if (slot.timer) clearTimeout(slot.timer);
      slot.job?.reject(new Error("Analytics workers stopped."));
    }
    await Promise.all(slots.map((slot) => slot.worker.terminate().catch(() => 0)));
  }
}
