// Golden generator: src/brokers/zerodha/feed.ts ZerodhaFeed (one lane-scoped Kite socket)
// driven by scripted operations. The global WebSocket is a recorder, setTimeout and
// clearTimeout are replaced by a manual scheduler while a scenario runs (reconnects
// fire only on "fire"), and the feed's clock is injected.
//
//   scratch/go-migration/check.sh node internal/kite/testdata/gen_lanefeed.mjs
//
// Writes testdata/lanefeed.golden.json. Socket ticks are real Kite frames from
// parsebinary.golden.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadZerodhaFeed, writeGolden } from "./loader.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const { ZerodhaFeed } = await loadZerodhaFeed();
const frames = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(here, "parsebinary.golden.json"), "utf8")).cases
  .filter((c) => !c.error).map((c) => [c.name, c.hex]));
const ltp = (token, price) => {
  const b = Buffer.alloc(12);
  b.writeInt16BE(1, 0); b.writeInt16BE(8, 2); b.writeUInt32BE(token, 4); b.writeUInt32BE(Math.round(price * 100), 8);
  return b.toString("hex");
};

class FakeWebSocket {
  static instances = [];
  constructor(url) { this.url = url; this.sent = []; this.closes = 0; FakeWebSocket.instances.push(this); }
  send(payload) { this.sent.push(payload); }
  close() { this.closes++; }
}
globalThis.WebSocket = FakeWebSocket;

const scenarios = [];
function run(name, ops, { lane = "futures" } = {}) {
  FakeWebSocket.instances.length = 0;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (fn, delay) => { const t = { fn, delay, cancelled: false, unref() { return t; } }; timers.push(t); return t; };
  globalThis.clearTimeout = (t) => { if (t) t.cancelled = true; };
  const start = 1_790_000_000_000;
  let clock = start;
  let creds = { apiKey: "api-key", accessToken: "access-token" };
  let generation = 1;
  const ticks = [];
  const conns = [];
  const deads = [];
  const steps = [];
  try {
    const feed = new ZerodhaFeed({ lane, credentials: () => creds, onTicks: (t) => ticks.push(JSON.stringify(t)),
      onConnectionChange: (c) => conns.push(c), onDead: (m) => deads.push(m), generation: () => generation, now: () => clock });
    const marks = { sockets: [], ticks: 0, conns: 0, deads: 0, timers: 0, cancelled: 0 };
    for (const op of ops) {
      const socket = () => {
        const ws = FakeWebSocket.instances[op.socket];
        if (!ws) throw new Error(`${name}: no socket ${op.socket}`);
        return ws;
      };
      let query = null;
      let fired = null;
      switch (op.op) {
        case "creds": creds = { apiKey: "api-key", accessToken: op.accessToken }; break;
        case "generation": generation = op.value; break;
        case "setTokens": feed.setTokens(op.tokens); break;
        case "subscribe": feed.subscribeTokens(op.tokens); break;
        case "unsubscribe": feed.unsubscribeTokens(op.tokens); break;
        case "ensure": feed.ensureSocket(); break;
        case "open": socket().onopen?.(); break;
        case "frame": socket().onmessage?.({ data: new Uint8Array(Buffer.from(op.hex, "hex")).buffer }); break;
        case "error": socket().onerror?.(); break;
        case "close": socket().onclose?.(); break;
        case "fire": {
          const t = timers.find((x) => !x.cancelled && !x.fired);
          if (!t) throw new Error(`${name}: no pending timer to fire`);
          t.fired = true;
          fired = t.delay;
          t.fn();
          break;
        }
        case "advance": clock += op.ms; break;
        case "stop": feed.stop(); break;
        case "query":
          query = { connected: feed.isConnected(), wanted: feed.wantedCount(), subscribed: feed.subscribedCount(),
            stats: JSON.stringify(feed.stats()) };
          break;
        default: throw new Error(`${name}: unknown op ${op.op}`);
      }
      const step = { op, sockets: [], ticks: ticks.slice(marks.ticks), conns: conns.slice(marks.conns), deads: deads.slice(marks.deads),
        scheduled: timers.slice(marks.timers).map((t) => t.delay), cancelled: timers.filter((t) => t.cancelled).length - marks.cancelled,
        fired, query };
      FakeWebSocket.instances.forEach((ws, i) => {
        const m = marks.sockets[i] ?? { sent: 0, closes: 0, url: null };
        const s = { index: i, sent: ws.sent.slice(m.sent), closes: ws.closes - m.closes };
        if (m.url === null) s.url = ws.url;
        if (s.sent.length || s.closes || s.url) step.sockets.push(s);
        marks.sockets[i] = { sent: ws.sent.length, closes: ws.closes, url: ws.url };
      });
      marks.ticks = ticks.length; marks.conns = conns.length; marks.deads = deads.length;
      marks.timers = timers.length; marks.cancelled = timers.filter((t) => t.cancelled).length;
      steps.push(step);
    }
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
  scenarios.push({ name, lane, start, steps });
}

const full5 = frames["full 5 levels"];
const mixed = frames["mixed ltp quote full"];

run("connect, resubscribe on open, diffed token sets", [
  { op: "query" }, { op: "setTokens", tokens: [] }, { op: "query" },
  { op: "setTokens", tokens: [11, 12, 0, -5, 12, 13] }, { op: "query" }, { op: "setTokens", tokens: [12, 14] }, { op: "query" },
  { op: "open", socket: 0 }, { op: "query" },
  { op: "setTokens", tokens: [14, 15, 16] }, { op: "query" }, { op: "subscribe", tokens: [16, 17, 0, -1] }, { op: "subscribe", tokens: [] },
  { op: "unsubscribe", tokens: [15, 99] }, { op: "unsubscribe", tokens: [] }, { op: "query" }, { op: "ensure" }, { op: "query" },
]);

run("ticks, rate and last-tick age", [
  { op: "setTokens", tokens: [12335874, 408065] }, { op: "open", socket: 0 },
  { op: "frame", socket: 0, hex: full5 }, { op: "advance", ms: 300 }, { op: "frame", socket: 0, hex: mixed },
  { op: "advance", ms: 1000 }, { op: "frame", socket: 0, hex: ltp(408065, 1500.5) }, { op: "query" },
  { op: "advance", ms: 1000 }, { op: "frame", socket: 0, hex: "00" }, { op: "query" }, { op: "advance", ms: 15_000 }, { op: "query" },
]);

run("close: capped exponential reconnect, attempts reset on open", [
  { op: "setTokens", tokens: [1, 2] }, { op: "open", socket: 0 }, { op: "close", socket: 0 }, { op: "query" },
  { op: "fire" }, { op: "close", socket: 1 }, { op: "fire" }, { op: "close", socket: 2 }, { op: "fire" }, { op: "close", socket: 3 },
  { op: "fire" }, { op: "close", socket: 4 }, { op: "fire" }, { op: "close", socket: 5 }, { op: "fire" }, { op: "close", socket: 6 },
  { op: "fire" }, { op: "close", socket: 7 }, { op: "fire" }, { op: "query" }, { op: "open", socket: 8 }, { op: "close", socket: 8 },
  { op: "query" }, { op: "fire" }, { op: "query" },
]);

run("close with nothing wanted does not reconnect", [
  { op: "setTokens", tokens: [5] }, { op: "open", socket: 0 }, { op: "unsubscribe", tokens: [5] }, { op: "close", socket: 0 }, { op: "query" },
  { op: "subscribe", tokens: [6] }, { op: "query" },
]);

run("reconnect reads fresh credentials and generation", [
  { op: "setTokens", tokens: [7] }, { op: "open", socket: 0 }, { op: "close", socket: 0 }, { op: "creds", accessToken: "rotated/token" },
  { op: "generation", value: 2 }, { op: "fire" }, { op: "open", socket: 1 }, { op: "frame", socket: 1, hex: ltp(7, 10) }, { op: "query" },
  { op: "close", socket: 1 }, { op: "creds", accessToken: null }, { op: "fire" }, { op: "query" },
  { op: "creds", accessToken: "back" }, { op: "ensure" }, { op: "query" },
]);

run("generation guard drops ticks from an older namespace", [
  { op: "setTokens", tokens: [7] }, { op: "open", socket: 0 }, { op: "frame", socket: 0, hex: ltp(7, 10) }, { op: "generation", value: 2 },
  { op: "frame", socket: 0, hex: ltp(7, 11) }, { op: "query" }, { op: "generation", value: 1 }, { op: "frame", socket: 0, hex: ltp(7, 12) },
  { op: "query" },
]);

run("error is terminal: onDead, teardown, no reconnect", [
  { op: "setTokens", tokens: [8, 9] }, { op: "open", socket: 0 }, { op: "error", socket: 0 }, { op: "query" },
  { op: "close", socket: 0 }, { op: "frame", socket: 0, hex: ltp(8, 1) }, { op: "query" },
  { op: "subscribe", tokens: [10] }, { op: "error", socket: 1 }, { op: "query" },
]);

run("stop cancels a pending reconnect and forgets everything", [
  { op: "setTokens", tokens: [21, 22] }, { op: "open", socket: 0 }, { op: "frame", socket: 0, hex: ltp(21, 2) }, { op: "close", socket: 0 },
  { op: "query" }, { op: "stop" }, { op: "query" }, { op: "setTokens", tokens: [23] }, { op: "subscribe", tokens: [24] }, { op: "ensure" },
  { op: "query" },
]);

run("superseded socket events are ignored", [
  { op: "setTokens", tokens: [31] }, { op: "open", socket: 0 }, { op: "close", socket: 0 }, { op: "fire" }, { op: "open", socket: 1 },
  { op: "frame", socket: 0, hex: ltp(31, 5) }, { op: "open", socket: 0 }, { op: "error", socket: 0 }, { op: "close", socket: 0 }, { op: "query" },
]);

run("no session at first", [
  { op: "creds", accessToken: null }, { op: "setTokens", tokens: [41] }, { op: "query" }, { op: "creds", accessToken: "" },
  { op: "subscribe", tokens: [42] }, { op: "query" }, { op: "creds", accessToken: "tok" }, { op: "subscribe", tokens: [42] }, { op: "query" },
  { op: "open", socket: 0 }, { op: "query" },
], { lane: "box" });

const written = writeGolden("lanefeed.golden.json", { scenarios });
console.log(`lane feed: ${scenarios.length} scenarios, ${scenarios.reduce((n, s) => n + s.steps.length, 0)} steps -> ${written}`);
