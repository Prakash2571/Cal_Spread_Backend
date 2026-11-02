// Stand-ins for the Box execution modules src/brokers/registry.ts imports at runtime.
// The Go service has no live adapters; nothing in the golden scenarios calls these.
export function createZerodhaLiveAdapter() {
  throw new Error("stub: live adapters are not part of the port");
}
export class DhanBrokerAdapter {
  constructor() {
    throw new Error("stub: live adapters are not part of the port");
  }
}
export function dhanAdapterConfigFromBoxConfig() {
  return {};
}
