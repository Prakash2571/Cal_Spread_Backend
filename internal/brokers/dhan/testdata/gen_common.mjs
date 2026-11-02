// Shared helpers for the golden generators (see generate.mjs).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../../../..");

/** Imports src/brokers/dhan/<name>.ts as it is (types stripped/transformed by Node). */
export function loadDhan(name) {
  return import(pathToFileURL(path.join(repoRoot, "src", "brokers", "dhan", `${name}.ts`)).href);
}

/** Small deterministic PRNG (mulberry32), so regenerated fixtures are byte-identical. */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (n) => Math.floor(next() * n);
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  return next;
}

/**
 * JSON with the numbers JSON cannot carry spelled out: NaN, ±Infinity and -0 become
 * {"$num": "NaN" | "Infinity" | "-Infinity" | "-0"}. The Go tests apply the same
 * canonicalisation, so the two sides compare exactly, bit for bit.
 */
function replacer(_key, value) {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { $num: "NaN" };
    if (value === Infinity) return { $num: "Infinity" };
    if (value === -Infinity) return { $num: "-Infinity" };
    if (Object.is(value, -0)) return { $num: "-0" };
  }
  return value;
}

export function canonicalJSON(value) {
  return JSON.stringify(value, replacer);
}

/** Writes {"meta": ..., "cases": [...]} with one case per line. */
export function writeFixture(file, meta, cases) {
  const out = path.join(here, file);
  const lines = cases.map((c) => "  " + canonicalJSON(c));
  fs.writeFileSync(out, `{\n "meta": ${canonicalJSON(meta)},\n "cases": [\n${lines.join(",\n")}\n ]\n}\n`);
  return out;
}

export function writeObject(file, value) {
  const out = path.join(here, file);
  fs.writeFileSync(out, canonicalJSON(value) + "\n");
  return out;
}

export const hex = (buf) => Buffer.from(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf).toString("hex");

/**
 * Replaces Date.now for the duration of fn (sync or async) with a fixed instant, and
 * silences + records console output.
 */
export async function withFakes({ now, tz }, fn) {
  const realNow = Date.now;
  const realTZ = process.env.TZ;
  const logs = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => logs.push(a.map(String).join(" "));
  console.warn = (...a) => logs.push(a.map(String).join(" "));
  console.error = (...a) => logs.push(a.map(String).join(" "));
  if (now !== undefined) Date.now = () => now;
  if (tz !== undefined) process.env.TZ = tz;
  try {
    return { value: await fn(), logs };
  } finally {
    Date.now = realNow;
    console.log = saved.log;
    console.warn = saved.warn;
    console.error = saved.error;
    if (tz !== undefined) {
      if (realTZ === undefined) delete process.env.TZ;
      else process.env.TZ = realTZ;
    }
  }
}
