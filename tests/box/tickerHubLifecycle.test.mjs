import assert from "node:assert/strict";
import test from "node:test";

import { TickerHub } from "../../dist/hub.js";

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.binaryType = "";
    this.sent = [];
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;
    FakeWebSocket.instances.push(this);
  }

  send(payload) {
    this.sent.push(payload);
  }

  open() {
    this.onopen?.();
  }

  close() {
    this.onclose?.();
  }

  error() {
    this.onerror?.();
  }

  tick(token, price = 100) {
    const frame = new ArrayBuffer(12);
    const view = new DataView(frame);
    view.setInt16(0, 1, false);
    view.setInt16(2, 8, false);
    view.setUint32(4, token, false);
    view.setUint32(8, Math.round(price * 100), false);
    this.onmessage?.({ data: frame });
  }
}

test("TickerHub emits every socket generation and ignores old warmth", () => {
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  try {
    let dead = 0;
    const hub = new TickerHub(
      () => ({ apiKey: "api-key", accessToken: "access-token" }),
      () => { dead++; },
    );
    const states = [];
    const ticks = [];
    const remove = hub.addConnectionListener((connected) => states.push(connected));
    const removeTicks = hub.addTickListener((batch) => ticks.push(...batch));
    const release = hub.retain([101]);

    assert.deepEqual(states, [false], "late listeners receive the current disconnected state");
    const first = FakeWebSocket.instances[0];
    first.open();
    assert.equal(hub.isConnected(), true);
    first.close();
    assert.equal(hub.isConnected(), false);

    hub.subscribeTokens([202]);
    const second = FakeWebSocket.instances[1];
    second.open();
    assert.equal(hub.isConnected(), true);
    assert.deepEqual(states, [false, true, false, true]);

    first.tick(999);
    first.error();
    first.close();
    assert.equal(ticks.length, 0, "a superseded socket cannot inject ticks into the current generation");
    assert.equal(dead, 0, "a superseded socket cannot invalidate the current Kite session");
    assert.equal(hub.isConnected(), true, "a superseded close cannot disconnect the replacement socket");

    remove();
    removeTicks();
    second.close();
    assert.deepEqual(states, [false, true, false, true], "removed listeners receive no later lifecycle events");
    release();
  } finally {
    globalThis.WebSocket = previous;
    FakeWebSocket.instances.length = 0;
  }
});
