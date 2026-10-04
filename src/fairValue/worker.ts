import { parentPort } from "node:worker_threads";
import { buildSurface } from "./pipeline.js";
import { calculate } from "./calculator.js";
import { independentEstimate } from "./independent.js";
import type { CalculatorRequest, InputSnapshot, SurfaceSnapshot } from "./types.js";

parentPort?.on("message", (job: { id: number; kind: string; input: unknown }) => {
  try {
    let result: unknown;
    if (job.kind === "surface") result = buildSurface(job.input as InputSnapshot);
    else if (job.kind === "calculate") {
      const payload = job.input as { input: InputSnapshot; surface: SurfaceSnapshot; request: CalculatorRequest };
      result = calculate(payload.input, payload.surface, payload.request);
    } else if (job.kind === "independent") {
      const payload = job.input as { input: InputSnapshot; expiry: string; strike: number };
      result = independentEstimate(payload.input, payload.expiry, payload.strike);
    } else throw new Error("Unsupported analytics worker job.");
    parentPort?.postMessage({ id: job.id, ok: true, result });
  } catch (error) {
    parentPort?.postMessage({ id: job.id, ok: false, error: error instanceof Error ? error.message : "Analytics worker failed." });
  }
});
