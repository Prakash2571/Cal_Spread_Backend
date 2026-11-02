// Golden generator: src/ticker.ts connectTicker's URL and text frames, recorded through a
// fake global WebSocket (the same seam tests/box/tickerHubLifecycle.test.mjs uses).
import { loadTicker, writeGolden } from "./loader.mjs";

const { connectTicker } = await loadTicker();

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.binaryType = "";
    this.sent = [];
    this.closed = 0;
    FakeWebSocket.instances.push(this);
  }
  send(payload) {
    this.sent.push(payload);
  }
  close() {
    this.closed++;
  }
}

function run(name, { apiKey = "key", accessToken = "tok", tokens = [], ops }) {
  const prev = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  FakeWebSocket.instances.length = 0;
  try {
    const events = [];
    const handle = connectTicker({
      apiKey,
      accessToken,
      tokens,
      onTick: (t) => events.push(`tick:${t.length}`),
      onOpen: () => events.push("open"),
      onError: (m) => events.push(`error:${m}`),
      onClose: () => events.push("close"),
    });
    const ws = FakeWebSocket.instances[0];
    for (const op of ops) {
      if (op.op === "open") ws.onopen?.();
      else if (op.op === "subscribe") handle.subscribe(op.tokens);
      else if (op.op === "unsubscribe") handle.unsubscribe(op.tokens);
      else throw new Error(`unknown op ${op.op}`);
    }
    return { name, apiKey, accessToken, tokens, ops, url: ws.url, binaryType: ws.binaryType, sent: ws.sent, events };
  } finally {
    globalThis.WebSocket = prev;
  }
}

const cases = [
  run("basic", { tokens: [11, 22], ops: [{ op: "open" }] }),
  run("empty tokens send nothing", { tokens: [], ops: [{ op: "open" }] }),
  run("subscribe before open is queued", { tokens: [1], ops: [{ op: "subscribe", tokens: [2, 3] }, { op: "subscribe", tokens: [3, 4] }, { op: "open" }] }),
  run("subscribe after open", { tokens: [1], ops: [{ op: "open" }, { op: "subscribe", tokens: [5, 6] }, { op: "subscribe", tokens: [] }, { op: "subscribe", tokens: [7] }] }),
  run("unsubscribe before open drops from queue", { tokens: [1, 2, 3, 4], ops: [{ op: "unsubscribe", tokens: [2, 4, 99] }, { op: "open" }] }),
  run("unsubscribe drops every duplicate", { tokens: [1, 2, 2, 3], ops: [{ op: "subscribe", tokens: [2, 9] }, { op: "unsubscribe", tokens: [2] }, { op: "open" }] }),
  run("unsubscribe everything before open", { tokens: [1, 2], ops: [{ op: "unsubscribe", tokens: [1, 2] }, { op: "open" }] }),
  run("unsubscribe empty is a no-op", { tokens: [1], ops: [{ op: "open" }, { op: "unsubscribe", tokens: [] }] }),
  run("unsubscribe after open", { tokens: [1, 2], ops: [{ op: "open" }, { op: "unsubscribe", tokens: [2, 3] }, { op: "subscribe", tokens: [8] }, { op: "unsubscribe", tokens: [8] }] }),
  run("large tokens", { tokens: [4294967295, 9007199254740991, 12335874], ops: [{ op: "open" }, { op: "unsubscribe", tokens: [4294967295] }] }),
  run("api key and token are URL-encoded", { apiKey: "a b&c=d/é", accessToken: "x/y?z=é~!*'()", tokens: [], ops: [] }),
  run("plain credentials", { apiKey: "abcd1234", accessToken: "Zy9-_.tok", tokens: [], ops: [] }),
  run("empty credentials", { apiKey: "", accessToken: "", tokens: [], ops: [] }),
];

const written = writeGolden("ticker_messages.golden.json", { cases });
console.log(`ticker messages: ${cases.length} cases -> ${written}`);
