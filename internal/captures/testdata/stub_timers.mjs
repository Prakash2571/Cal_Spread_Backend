// Stand-in for src/trackedTimers.ts: records each tracked interval by name so the
// generator can invoke a scheduler's tick callback directly.
export const registry = {};
export function trackInterval(name, handle) {
  registry[name] = handle;
  return handle;
}
