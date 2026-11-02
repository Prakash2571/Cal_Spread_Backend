// Golden generator: src/hub.ts TickerHub driven by scripted operations, with the global
// WebSocket replaced by a recorder (the seam tests/box/tickerHubLifecycle.test.mjs uses)
// and Date.now replaced by a controllable clock.
//
//   scratch/go-migration/check.sh node internal/kite/testdata/gen_hub.mjs
//
// It writes internal/hub/testdata/hub.golden.json (the hub's Go test reads it there).
//
// For every operation it records what changed: SSE frames per client, socket urls /
// sent messages / closes, tick- and connection-listener calls, onDead calls, and (for
// "query") the hub's caches. Socket ticks are real Kite frames taken from
// parsebinary.golden.json, so the Go replay feeds the same bytes through ParseBinary.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHub, loadTicker, writeGoldenTo } from "./loader.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const { TickerHub } = await loadHub();
const { parseBinary } = await loadTicker();
const frames = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(here, "parsebinary.golden.json"), "utf8")).cases
  .filter((c) => !c.error).map((c) => [c.name, c.hex]));
const frame = (name) => {
  if (!frames[name]) throw new Error(`no parse golden frame ${name}`);
  return frames[name];
};
const tokensOf = (hex) => parseBinary(new Uint8Array(Buffer.from(hex, "hex")).buffer).map((t) => t.token);
const ltp = (token, price) => {
  const b = Buffer.alloc(12);
  b.writeInt16BE(1, 0); b.writeInt16BE(8, 2); b.writeUInt32BE(token, 4); b.writeUInt32BE(Math.round(price * 100), 8);
  return b.toString("hex");
};

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closes = 0;
    FakeWebSocket.instances.push(this);
  }
  send(payload) { this.sent.push(payload); }
  close() { this.closes++; }
}
globalThis.WebSocket = FakeWebSocket;
let clock = 1_790_000_000_000;
Date.now = () => clock;

const js = (v) => JSON.stringify(v); // what a client receives (NaN and the infinities as null)
const scenarios = [];

function run(name, ops) {
  FakeWebSocket.instances.length = 0;
  let creds = { apiKey: "api-key", accessToken: "access-token" };
  let dead = 0;
  const hub = new TickerHub(() => creds, () => { dead++; });
  const clients = {}; // name -> {frames: [], detach}
  const retainers = {};
  const tickCalls = {}; // id -> [json]
  const connCalls = {}; // id -> [bool]
  const removers = {};
  const marks = { sockets: [], dead: 0, frames: {}, ticks: {}, conns: {} };
  const steps = [];
  for (const op of ops) {
    const socket = () => {
      const ws = FakeWebSocket.instances[op.socket];
      if (!ws) throw new Error(`${name}: no socket ${op.socket}`);
      return ws;
    };
    let query = null;
    switch (op.op) {
      case "creds": creds = { apiKey: op.apiKey ?? "api-key", accessToken: op.accessToken }; break;
      case "attach": case "addClient": {
        const c = { frames: [] };
        const res = { write: (s) => { c.frames.push(s); return true; } };
        c.detach = op.op === "attach" ? hub.attachClient(res, op.tokens) : hub.addClient(res, op.tokens);
        clients[op.client] = c;
        break;
      }
      case "detach": clients[op.client].detach(); break;
      case "seed": hub.seed(op.ticks); break;
      case "retain": retainers[op.id] = op.tokens === undefined ? hub.retain() : hub.retain(op.tokens); break;
      case "release": retainers[op.id](); break;
      case "retainFanout": retainers[op.id] = hub.retainFanout(); break;
      case "subscribe": hub.subscribeTokens(op.tokens); break;
      case "unsubscribe": hub.unsubscribeTokens(op.tokens); break;
      case "tickListener": tickCalls[op.id] = []; removers[op.id] = hub.addTickListener((t) => tickCalls[op.id].push(js(t))); break;
      case "connListener": connCalls[op.id] = []; removers[op.id] = hub.addConnectionListener((c) => connCalls[op.id].push(c)); break;
      case "remove": removers[op.id](); break;
      case "open": socket().onopen?.(); break;
      case "frame": socket().onmessage?.({ data: new Uint8Array(Buffer.from(op.hex, "hex")).buffer }); break;
      case "error": socket().onerror?.(); break;
      case "close": socket().onclose?.(); break;
      case "ingest": hub.ingestExternalTicks(op.ticks); break;
      case "external": hub.setExternalConnected(op.connected); break;
      case "stop": hub.stop(); break;
      case "advance": clock += op.ms; break;
      case "query": {
        query = { connected: hub.isConnected(), subscribed: hub.subscribedCount(), tokens: {} };
        for (const t of op.tokens) {
          query.tokens[t] = {
            latest: hub.getLatestTick(t) === undefined ? null : js(hub.getLatestTick(t)),
            snapshot: js(hub.getLadderSnapshot(t)),
            fresh: js(hub.getFreshLadder(t)),
            fresh1s: js(hub.getFreshLadder(t, 1000)),
          };
        }
        break;
      }
      default: throw new Error(`${name}: unknown op ${op.op}`);
    }
    // What this operation changed.
    const step = { sockets: [], frames: {}, ticks: {}, conns: {}, dead: dead - marks.dead, query };
    FakeWebSocket.instances.forEach((ws, i) => {
      const m = marks.sockets[i] ?? { sent: 0, closes: 0, url: null };
      const s = { index: i, sent: ws.sent.slice(m.sent), closes: ws.closes - m.closes };
      if (m.url === null) s.url = ws.url;
      if (s.sent.length || s.closes || s.url) step.sockets.push(s);
      marks.sockets[i] = { sent: ws.sent.length, closes: ws.closes, url: ws.url };
    });
    for (const [n, c] of Object.entries(clients)) {
      const from = marks.frames[n] ?? 0;
      if (c.frames.length > from) step.frames[n] = c.frames.slice(from);
      marks.frames[n] = c.frames.length;
    }
    for (const [id, calls] of Object.entries(tickCalls)) {
      const from = marks.ticks[id] ?? 0;
      if (calls.length > from) step.ticks[id] = calls.slice(from);
      marks.ticks[id] = calls.length;
    }
    for (const [id, calls] of Object.entries(connCalls)) {
      const from = marks.conns[id] ?? 0;
      if (calls.length > from) step.conns[id] = calls.slice(from);
      marks.conns[id] = calls.length;
    }
    marks.dead = dead;
    steps.push({ op, ...step });
  }
  scenarios.push({ name, start: 1_790_000_000_000, steps });
  clock = 1_790_000_000_000;
}

const full5 = frame("full 5 levels");
const emptyDepth = frame("full no depth (zero levels)");
const bidsOnly = frame("full bids only");
const mixed = frame("mixed ltp quote full");
const random19 = frame("random structured 19");
const gaps = frame("full gaps in depth (zero price levels dropped)");
const [t5] = tokensOf(full5);
const [tEmpty] = tokensOf(emptyDepth);
const [tBids] = tokensOf(bidsOnly);
const mixedTokens = tokensOf(mixed);
const r19 = tokensOf(random19);
const [tGaps] = tokensOf(gaps);

// tests/box/tickerHubLifecycle.test.mjs, step for step.
run("tickerHubLifecycle", [
  { op: "connListener", id: "states" }, { op: "tickListener", id: "ticks" }, { op: "retain", id: "r", tokens: [101] },
  { op: "open", socket: 0 }, { op: "query", tokens: [] }, { op: "close", socket: 0 }, { op: "query", tokens: [] },
  { op: "subscribe", tokens: [202] }, { op: "open", socket: 1 }, { op: "query", tokens: [] },
  { op: "frame", socket: 0, hex: ltp(999, 100) }, { op: "error", socket: 0 }, { op: "close", socket: 0 }, { op: "query", tokens: [999] },
  { op: "remove", id: "states" }, { op: "remove", id: "ticks" }, { op: "close", socket: 1 }, { op: "release", id: "r" },
]);

run("fan-out, snapshots and the ladder cache", [
  { op: "tickListener", id: "L" }, { op: "connListener", id: "C" },
  { op: "attach", client: "A", tokens: [t5, 5] }, { op: "retain", id: "r", tokens: [t5, tBids, ...mixedTokens] },
  { op: "open", socket: 0 }, { op: "frame", socket: 0, hex: full5 }, { op: "query", tokens: [t5] },
  { op: "attach", client: "B", tokens: [t5, 777] }, { op: "advance", ms: 1500 }, { op: "frame", socket: 0, hex: mixed },
  { op: "query", tokens: [t5, ...mixedTokens] }, { op: "advance", ms: 4000 }, { op: "query", tokens: [t5, ...mixedTokens] },
  { op: "frame", socket: 0, hex: bidsOnly }, { op: "frame", socket: 0, hex: random19 }, { op: "query", tokens: [tBids, ...r19] },
  { op: "advance", ms: 1001 }, { op: "query", tokens: [tBids, ...r19] },
  { op: "frame", socket: 0, hex: emptyDepth }, { op: "frame", socket: 0, hex: gaps }, { op: "query", tokens: [tEmpty, tGaps] },
  { op: "detach", client: "A" }, { op: "frame", socket: 0, hex: ltp(t5, 123.45) }, { op: "query", tokens: [t5] },
  { op: "stop" }, { op: "query", tokens: [t5, tBids, tGaps] },
]);

const depth = (side, ...levels) => levels.map(([price, qty, orders]) => ({ price, qty, orders }));
run("external ticks: depth provenance, exchange stamps, numbers", [
  { op: "tickListener", id: "L" }, { op: "connListener", id: "C" }, { op: "attach", client: "A", tokens: [1, 2, 3] },
  { op: "external", connected: true }, { op: "external", connected: true },
  { op: "ingest", ticks: [] },
  { op: "ingest", ticks: [{ token: 1, last_price: 100.05, close_price: 99, oi: 0, bid: 100, ask: 100.1,
    bids: depth("b", [100, 75, 1], [99.95, 150, 2]), asks: depth("a", [100.1, 75, 1]), depth_updated: true, exchange_ts: 1790000000000 }] },
  { op: "query", tokens: [1] },
  { op: "ingest", ticks: [{ token: 1, last_price: 100.1, close_price: 99, oi: 0, bid: 100.05, ask: 100.15,
    bids: depth("b", [100.05, 1, 1]), asks: depth("a", [100.15, 1, 1]), depth_updated: false }] },
  { op: "query", tokens: [1] },
  { op: "ingest", ticks: [{ token: 2, last_price: 50, close_price: 49.5, oi: 1200, bid: 49.95, ask: 50.05, bids: depth("b", [49.95, 10, 2]) }] },
  { op: "query", tokens: [2] },
  { op: "ingest", ticks: [{ token: 2, last_price: 50, close_price: 49.5, oi: 1200, bid: 0, ask: 0, bids: [], asks: [], depth_updated: true, exchange_ts: 0 }] },
  { op: "query", tokens: [2] },
  { op: "ingest", ticks: [{ token: 3, last_price: NaN, close_price: Infinity, oi: -Infinity, bid: 1e-7, ask: 1e21, exchange_ts: 1790000000123 },
    { token: 3, last_price: 0.30000000000000004, close_price: -0, oi: 123456789.125, bid: 5e-324, ask: 1.7976931348623157e308 }] },
  { op: "query", tokens: [3] },
  { op: "external", connected: false }, { op: "stop" }, { op: "query", tokens: [1, 2, 3] },
]);

run("seed and late joiners", [
  { op: "seed", ticks: [{ token: 11, last_price: 10, close_price: 9, oi: 5, bid: 0, ask: 0 },
    { token: 12, last_price: 20, close_price: 19, oi: 0, bid: 19.5, ask: 20.5, bids: depth("b", [19.5, 3, 1]), asks: depth("a", [20.5, 4, 2]) }] },
  { op: "attach", client: "A", tokens: [12, 99, 11, 12] }, { op: "attach", client: "B", tokens: [99] },
  { op: "query", tokens: [11, 12] },
  { op: "ingest", ticks: [{ token: 11, last_price: 10.5, close_price: 9, oi: 5, bid: 10.45, ask: 10.55 }] },
  { op: "attach", client: "C", tokens: [11] }, { op: "detach", client: "A" }, { op: "detach", client: "A" },
  { op: "ingest", ticks: [{ token: 12, last_price: 21, close_price: 19, oi: 0, bid: 0, ask: 0 }] },
]);

run("legacy addClient owns the socket", [
  { op: "connListener", id: "C" }, { op: "addClient", client: "A", tokens: [7, 8, 7] }, { op: "addClient", client: "B", tokens: [8, 9] },
  { op: "query", tokens: [] }, { op: "open", socket: 0 }, { op: "subscribe", tokens: [9, 10, 10] }, { op: "subscribe", tokens: [] },
  { op: "unsubscribe", tokens: [8, 10, 11] }, { op: "query", tokens: [] }, { op: "detach", client: "A" }, { op: "query", tokens: [] },
  { op: "detach", client: "B" }, { op: "query", tokens: [] },
  { op: "addClient", client: "C", tokens: [7] }, { op: "retainFanout", id: "f" }, { op: "detach", client: "C" }, { op: "query", tokens: [] },
]);

run("unsubscribe drops caches only for unwanted tokens", [
  { op: "attach", client: "A", tokens: [t5] }, { op: "subscribe", tokens: [t5, tBids] }, { op: "open", socket: 0 },
  { op: "frame", socket: 0, hex: full5 }, { op: "frame", socket: 0, hex: bidsOnly }, { op: "query", tokens: [t5, tBids] },
  { op: "unsubscribe", tokens: [t5, tBids, 424242] }, { op: "query", tokens: [t5, tBids] },
  { op: "unsubscribe", tokens: [] }, { op: "detach", client: "A" }, { op: "unsubscribe", tokens: [t5] }, { op: "query", tokens: [t5] },
]);

run("no session: nothing opens", [
  { op: "creds", accessToken: null }, { op: "retain", id: "r", tokens: [1] }, { op: "subscribe", tokens: [2] },
  { op: "addClient", client: "A", tokens: [3] }, { op: "query", tokens: [] },
  { op: "creds", accessToken: "" }, { op: "subscribe", tokens: [4] }, { op: "query", tokens: [] },
  { op: "creds", apiKey: "k e y", accessToken: "t/o+k" }, { op: "subscribe", tokens: [5] }, { op: "query", tokens: [] },
]);

run("dead token: onDead, kite_error frame, stop", [
  { op: "connListener", id: "C" }, { op: "tickListener", id: "L" }, { op: "attach", client: "A", tokens: [t5] },
  { op: "attach", client: "B", tokens: [] }, { op: "retain", id: "r", tokens: [t5] }, { op: "open", socket: 0 },
  { op: "frame", socket: 0, hex: full5 }, { op: "error", socket: 0 }, { op: "query", tokens: [t5] },
  { op: "close", socket: 0 }, { op: "frame", socket: 0, hex: full5 }, { op: "query", tokens: [t5] },
  { op: "subscribe", tokens: [t5] }, { op: "error", socket: 1 }, { op: "query", tokens: [] },
]);

run("subscriptions before and after open", [
  { op: "retain", id: "r", tokens: [1, 2] }, { op: "subscribe", tokens: [2, 3] }, { op: "unsubscribe", tokens: [1] },
  { op: "subscribe", tokens: [1] }, { op: "open", socket: 0 }, { op: "subscribe", tokens: [4] }, { op: "unsubscribe", tokens: [2, 3] },
  { op: "query", tokens: [] }, { op: "close", socket: 0 }, { op: "subscribe", tokens: [5] }, { op: "query", tokens: [] },
  { op: "release", id: "r" }, { op: "query", tokens: [] }, { op: "release", id: "r" },
]);

run("retain without tokens opens with the subscribed set", [
  { op: "subscribe", tokens: [31, 32] }, { op: "stop" }, { op: "retain", id: "r" }, { op: "query", tokens: [] },
  { op: "retain", id: "s", tokens: [33] }, { op: "release", id: "r" }, { op: "query", tokens: [] }, { op: "release", id: "s" },
]);

// Input ops go through the loader's replacer, so NaN/Infinity in scripted ticks survive.
const written = writeGoldenTo(path.join(here, "../../hub/testdata"), "hub.golden.json", { scenarios });
console.log(`hub: ${scenarios.length} scenarios, ${scenarios.reduce((n, s) => n + s.steps.length, 0)} steps -> ${written}`);
