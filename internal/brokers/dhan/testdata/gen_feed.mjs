// Goldens for the DhanFeed socket lifecycle (src/brokers/dhan/feed.ts) -> feed_life.json.
//
// The feed runs against a scripted fake WebSocket (the test opens, messages and closes
// each socket by hand; send() on a socket that is not OPEN throws like the real one) and
// a manual timer queue (the reconnect timer only fires on a "fire" step). Each step
// records what the feed did: sockets opened (URL), frames sent, sockets closed by the
// feed, callbacks (onTicks / onConnection / onSessionLost), reconnect delays scheduled,
// and on "stats" steps the feed's counters. The Go test replays the same steps against
// dhan.Feed and a loopback WebSocket server.
import { loadDhan, writeFixture } from "./gen_common.mjs";

const NOW0 = Date.parse("2026-10-28T06:00:00.000Z");

/* ------------------------------- frames ---------------------------------- */

const hexOf = (u8) => Buffer.from(u8).toString("hex");
function packet(code, len, seg, sec) {
  const b = new DataView(new ArrayBuffer(len));
  b.setUint8(0, code);
  b.setInt16(1, len, true);
  b.setUint8(3, seg);
  b.setInt32(4, sec, true);
  return b;
}
const ticker = (seg, sec, ltp, ltt) => {
  const b = packet(2, 16, seg, sec);
  b.setFloat32(8, ltp, true);
  b.setInt32(12, ltt, true);
  return new Uint8Array(b.buffer);
};
const oiPacket = (seg, sec, oi) => {
  const b = packet(5, 12, seg, sec);
  b.setInt32(8, oi, true);
  return new Uint8Array(b.buffer);
};
const prevClose = (seg, sec, pc, poi) => {
  const b = packet(6, 16, seg, sec);
  b.setFloat32(8, pc, true);
  b.setInt32(12, poi, true);
  return new Uint8Array(b.buffer);
};
const full = (seg, sec, p) => {
  const b = packet(8, 162, seg, sec);
  b.setFloat32(8, p.ltp, true);
  b.setInt16(12, 75, true);
  b.setInt32(14, 1793167200, true);
  b.setFloat32(18, p.ltp, true);
  b.setInt32(22, 1000, true);
  b.setInt32(26, 300, true);
  b.setInt32(30, 400, true);
  b.setInt32(34, p.oi, true);
  b.setInt32(38, p.oi + 10, true);
  b.setInt32(42, p.oi - 10, true);
  b.setFloat32(46, 100, true);
  b.setFloat32(50, p.close, true);
  b.setFloat32(54, 110, true);
  b.setFloat32(58, 90, true);
  p.depth.forEach(([bq, aq, bo, ao, bid, ask], i) => {
    const o = 62 + 20 * i;
    b.setInt32(o, bq, true);
    b.setInt32(o + 4, aq, true);
    b.setInt16(o + 8, bo, true);
    b.setInt16(o + 10, ao, true);
    b.setFloat32(o + 12, bid, true);
    b.setFloat32(o + 16, ask, true);
  });
  return new Uint8Array(b.buffer);
};
const disconnect = (code) => {
  const b = packet(50, 10, 0, 0);
  b.setInt16(8, code, true);
  return new Uint8Array(b.buffer);
};
const marketStatus = () => new Uint8Array(packet(7, 8, 0, 0).buffer);
const frame = (...parts) => hexOf(Buffer.concat(parts.map((p) => Buffer.from(p))));

/* -------------------------------- fakes ---------------------------------- */

let LOG;
let SOCKETS = [];
let TIMER = null;
class FakeWebSocket {
  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this.index = SOCKETS.length;
    SOCKETS.push(this);
    LOG.sockets.push(this.url);
  }
  send(data) {
    if (this.readyState !== 1) throw new Error("InvalidStateError: the socket is not open");
    LOG.sent.push(`${this.index} ${data}`);
  }
  close() {
    LOG.closed.push(String(this.index));
    this.readyState = 3;
  }
}

/* ------------------------------ scenarios -------------------------------- */

const FNO = (sec) => 2_000_000_000 + sec;
const A = FNO(45000);
const B = FNO(45001);
const C = FNO(45002);
const D = FNO(45003);
const E = FNO(45004);
const MANY = Array.from({ length: 250 }, (_, i) => FNO(50000 + i));
const IDX = 13;
const UNRESOLVABLE = 9_000_000_005;

const DEPTH = [
  [10, 20, 1, 2, 99.5, 100.5], [5, 6, 1, 1, 99, 101], [0, 0, 0, 0, 0, 0], [-3, 4, -1, 2, 98, 0], [7, 8, 2, 3, 97.25, 102.75],
];

const SCENARIOS = [
  {
    name: "connect, batches of 100, ticks, (un)subscribe, stop and restart, dispose",
    token: "tok&x=1", clientId: "C 1/2",
    steps: [
      { op: "stats" },
      { op: "subscribe", tokens: [...MANY, IDX, UNRESOLVABLE, MANY[0]] },
      { op: "stats" },
      { op: "subscribe", tokens: [A] },
      { op: "open", socket: 0 },
      { op: "stats" },
      { op: "message", socket: 0, frame: frame(ticker(2, 45000, 101.05, 1793167200), full(2, 50001, { ltp: 250.5, oi: 1200, close: 249, depth: DEPTH }), ticker(2, 99999, 1, 0), disconnect(805), marketStatus(), ticker(0, 13, 25000.15, 0)) },
      { op: "advance", ms: 250 },
      { op: "message", socket: 0, frame: frame(oiPacket(2, 45000, 777), prevClose(2, 50001, 248.5, 1100), prevClose(2, 45000, 100.5, 900), ticker(1, 45000, 5, 0)) },
      { op: "text", socket: 0 },
      { op: "message", socket: 0, frame: "" },
      { op: "message", socket: 0, frame: "01020304" },
      { op: "subscribe", tokens: [A, C, C] },
      { op: "unsubscribe", tokens: [MANY[1], UNRESOLVABLE + 1] },
      { op: "message", socket: 0, frame: frame(ticker(2, 50001, 300, 0), ticker(2, 50000, 301, 0)) },
      { op: "stats" },
      { op: "stop" },
      { op: "stats" },
      { op: "message", socket: 0, frame: frame(ticker(2, 45000, 1, 0)) },
      { op: "subscribe", tokens: [D] },
      { op: "stats" },
      { op: "dispose" },
      { op: "subscribe", tokens: [E] },
      { op: "ensure" },
      { op: "stats" },
    ],
  },
  {
    name: "close codes: back-off reconnects, resubscribe on open, auth close is terminal",
    token: "tok", clientId: "C1",
    steps: [
      { op: "subscribe", tokens: [A, B] },
      { op: "close", socket: 0, code: 1006 },
      { op: "stats" },
      { op: "fire" },
      { op: "close", socket: 1, code: 1006 },
      { op: "fire" },
      { op: "open", socket: 2 },
      { op: "message", socket: 2, frame: frame(ticker(2, 45001, 55.5, 0)) },
      { op: "stats" },
      { op: "close", socket: 2, code: 1001 },
      { op: "stats" },
      { op: "fire" },
      { op: "subscribe", tokens: [C] },
      { op: "open", socket: 3 },
      { op: "stats" },
      { op: "close", socket: 3, code: 4401 },
      { op: "stats" },
      { op: "fire" },
      { op: "ensure" },
      { op: "open", socket: 4 },
      { op: "close", socket: 4, code: 1008 },
      { op: "token", value: null },
      { op: "ensure" },
      { op: "subscribe", tokens: [D] },
      { op: "stats" },
    ],
  },
  {
    name: "repeated failures cap the delay at 30 s; stop cancels the pending reconnect",
    token: "tok", clientId: "C1",
    steps: [
      { op: "subscribe", tokens: [A] },
      ...Array.from({ length: 8 }, (_, i) => [{ op: "close", socket: i, code: 1006 }, { op: "fire" }]).flat(),
      { op: "open", socket: 8 },
      { op: "close", socket: 8, code: 4001 },
      { op: "ensure" },
      { op: "close", socket: 9, code: 1006 },
      { op: "stop" },
      { op: "fire" },
      { op: "stats" },
      { op: "clientId", value: "" },
      { op: "subscribe", tokens: [B] },
      { op: "stats" },
    ],
  },
  {
    name: "unsubscribing everything while connected, then a close: no reconnect target is kept",
    token: "tok", clientId: "C1",
    steps: [
      { op: "subscribe", tokens: [A, B] },
      { op: "open", socket: 0 },
      { op: "unsubscribe", tokens: [A, B, A] },
      { op: "stats" },
      { op: "close", socket: 0, code: 1000 },
      { op: "stats" },
      { op: "fire" },
      { op: "stats" },
    ],
  },
];

export async function run() {
  const { DhanFeed } = await import(new URL("../../../../src/brokers/dhan/feed.ts", import.meta.url).href);
  const { dhanIdentityFromToken } = await import(new URL("../../../../src/brokers/dhan/instruments.ts", import.meta.url).href);
  const realWS = globalThis.WebSocket;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realNow = Date.now;
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  globalThis.WebSocket = FakeWebSocket;
  globalThis.setTimeout = (fn, delay) => {
    const h = { fn, delay, cleared: false, unref() {} };
    TIMER = h;
    LOG.timers.push(delay);
    return h;
  };
  globalThis.clearTimeout = (h) => {
    if (h) h.cleared = true;
    if (TIMER === h) TIMER = null;
  };
  const cases = [];
  try {
    for (const sc of SCENARIOS) {
      let now = NOW0;
      Date.now = () => now;
      SOCKETS = [];
      TIMER = null;
      const S = { token: sc.token, clientId: sc.clientId };
      const fresh = () => ({ sockets: [], sent: [], closed: [], calls: [], timers: [] });
      LOG = fresh();
      const feed = new DhanFeed({
        accessToken: () => S.token,
        clientId: () => S.clientId,
        onTicks: (t) => LOG.calls.push(`ticks ${JSON.stringify(t)}`),
        onConnection: (c) => LOG.calls.push(`connection ${c}`),
        onSessionLost: (r) => LOG.calls.push(`sessionLost ${r}`),
        resolve: (token) => dhanIdentityFromToken(token),
        depthLevel: 5,
      });
      const results = [];
      for (const step of sc.steps) {
        LOG = fresh();
        let stats;
        const ws = SOCKETS[step.socket];
        switch (step.op) {
          case "subscribe":
            feed.subscribeTokens(step.tokens);
            break;
          case "unsubscribe":
            feed.unsubscribeTokens(step.tokens);
            break;
          case "ensure":
            feed.ensureSocket();
            break;
          case "open":
            ws.readyState = 1;
            ws.onopen?.();
            break;
          case "message": {
            const bytes = Buffer.from(step.frame, "hex");
            ws.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
            break;
          }
          case "text":
            ws.onmessage?.({ data: "{\"type\":\"info\"}" });
            break;
          case "close":
            ws.readyState = 3;
            ws.onclose?.({ code: step.code });
            break;
          case "fire": {
            const t = TIMER;
            TIMER = null;
            if (t && !t.cleared) t.fn();
            break;
          }
          case "stop":
            feed.stop();
            break;
          case "dispose":
            feed.dispose();
            break;
          case "advance":
            now += step.ms;
            break;
          case "token":
            S.token = step.value;
            break;
          case "clientId":
            S.clientId = step.value;
            break;
          case "stats":
            stats = {
              connected: feed.isConnected(),
              wanted: feed.wantedCount(),
              subscribed: feed.subscribedCount(),
              lastTickAt: feed.lastTickAtMs(),
              feedAge: feed.feedAgeMs(),
              generation: feed.feedGeneration(),
            };
            break;
          default:
            throw new Error(`unknown op ${step.op}`);
        }
        results.push({ ...LOG, ...(stats ? { stats } : {}) });
      }
      cases.push({ name: sc.name, token: sc.token, clientId: sc.clientId, nowMs: NOW0, steps: sc.steps, results });
    }
  } finally {
    globalThis.WebSocket = realWS;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    Date.now = realNow;
    console.log = saved.log;
    console.warn = saved.warn;
    console.error = saved.error;
  }
  const written = [writeFixture("feed_life.json", { generator: "gen_feed.mjs" }, cases)];
  return { counts: { scenarios: cases.length, steps: cases.reduce((n, c) => n + c.steps.length, 0) }, written };
}
