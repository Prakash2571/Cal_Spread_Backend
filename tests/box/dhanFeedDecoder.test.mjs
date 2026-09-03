/**
 * DhanHQ v2 binary feed decoder.
 *
 * This is the most safety-critical decoder in the Dhan integration and the reason it
 * is a pure function: a misread offset does not throw, it yields a plausible-looking
 * WRONG price, and the Box scanner would then trade on it. So every packet type,
 * every boundary and every malformed case is asserted against bytes built here.
 *
 * Two things these tests specifically pin down, because they are the easy mistakes:
 *   - LITTLE-endian (Kite's ticker is big-endian; mixing them up yields garbage).
 *   - The Full packet's OHLC sits 12 bytes LATER than the Quote packet's, because
 *     Full inserts three OI fields first.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeDhanFeed,
  DHAN_FEED_CODE,
  DHAN_HEADER_BYTES,
} from "../../dist/brokers/dhan/feedDecoder.js";
import { toTick } from "../../dist/brokers/dhan/feed.js";

/** Build one packet with Dhan's 8-byte header. All writes little-endian. */
function packet(code, byteLength, segmentCode, securityId, fill) {
  const buf = new ArrayBuffer(byteLength);
  const view = new DataView(buf);
  view.setUint8(0, code);
  view.setInt16(1, byteLength, true);
  view.setUint8(3, segmentCode);
  view.setInt32(4, securityId, true);
  if (fill) fill(view);
  return buf;
}

/** Concatenate frames, as Dhan does when several packets share one message. */
function concat(...buffers) {
  const total = buffers.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of buffers) {
    out.set(new Uint8Array(b), at);
    at += b.byteLength;
  }
  return out.buffer;
}

const NSE_FNO = 2;
const SECURITY = 45678;

/** A FULL packet (162 bytes) with a known book. */
function fullPacket({
  ltp = 123.45,
  oi = 4321,
  volume = 9999,
  open = 120,
  close = 119,
  high = 130,
  low = 118,
  bids = [[100, 75, 3]],
  asks = [[101, 50, 2]],
  ltt = 1_760_000_000,
} = {}) {
  return packet(DHAN_FEED_CODE.FULL, 162, NSE_FNO, SECURITY, (v) => {
    v.setFloat32(8, ltp, true);
    v.setInt16(12, 25, true);          // last traded quantity
    v.setInt32(14, ltt, true);         // last trade time (epoch seconds)
    v.setFloat32(18, 122.0, true);     // average traded price
    v.setInt32(22, volume, true);
    v.setInt32(26, 500, true);         // total sell quantity
    v.setInt32(30, 700, true);         // total buy quantity
    v.setInt32(34, oi, true);
    v.setInt32(38, oi + 100, true);    // OI day high
    v.setInt32(42, oi - 100, true);    // OI day low
    v.setFloat32(46, open, true);
    v.setFloat32(50, close, true);
    v.setFloat32(54, high, true);
    v.setFloat32(58, low, true);
    // Five 20-byte depth levels from offset 62:
    //   int32 bidQty, int32 askQty, int16 bidOrders, int16 askOrders,
    //   float32 bidPrice, float32 askPrice
    for (let i = 0; i < 5; i++) {
      const at = 62 + i * 20;
      const bid = bids[i];
      const ask = asks[i];
      v.setInt32(at, bid ? bid[1] : 0, true);
      v.setInt32(at + 4, ask ? ask[1] : 0, true);
      v.setInt16(at + 8, bid ? bid[2] : 0, true);
      v.setInt16(at + 10, ask ? ask[2] : 0, true);
      v.setFloat32(at + 12, bid ? bid[0] : 0, true);
      v.setFloat32(at + 16, ask ? ask[0] : 0, true);
    }
  });
}

/* --------------------------------- ticker --------------------------------- */

test("decodes a TICKER packet", () => {
  const buf = packet(DHAN_FEED_CODE.TICKER, 16, NSE_FNO, SECURITY, (v) => {
    v.setFloat32(8, 250.75, true);
    v.setInt32(12, 1_760_000_500, true);
  });
  const { packets, errors } = decodeDhanFeed(buf);
  assert.deepEqual(errors, []);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].code, DHAN_FEED_CODE.TICKER);
  assert.equal(packets[0].segment, "NSE_FNO");
  assert.equal(packets[0].securityId, SECURITY);
  assert.ok(Math.abs(packets[0].last_price - 250.75) < 1e-4);
  assert.equal(packets[0].last_trade_time, 1_760_000_500 * 1000, "seconds → ms");
});

test("a zero last-trade-time stays ABSENT rather than becoming epoch 0", () => {
  // 0 means "no timestamp". Turning it into 1970 would make the tick look
  // catastrophically stale to every freshness check.
  const buf = packet(DHAN_FEED_CODE.TICKER, 16, NSE_FNO, SECURITY, (v) => {
    v.setFloat32(8, 10, true);
    v.setInt32(12, 0, true);
  });
  const { packets } = decodeDhanFeed(buf);
  assert.equal(packets[0].last_trade_time, undefined);
});

/* ---------------------------------- quote --------------------------------- */

test("decodes a QUOTE packet including its OHLC block", () => {
  const buf = packet(DHAN_FEED_CODE.QUOTE, 50, NSE_FNO, SECURITY, (v) => {
    v.setFloat32(8, 99.5, true);
    v.setInt16(12, 10, true);
    v.setInt32(14, 1_760_000_000, true);
    v.setFloat32(18, 98.0, true);
    v.setInt32(22, 12_345, true);
    v.setInt32(26, 200, true);
    v.setInt32(30, 300, true);
    v.setFloat32(34, 95, true);   // open
    v.setFloat32(38, 94, true);   // close
    v.setFloat32(42, 101, true);  // high
    v.setFloat32(46, 93, true);   // low
  });
  const { packets, errors } = decodeDhanFeed(buf);
  assert.deepEqual(errors, []);
  const p = packets[0];
  assert.ok(Math.abs(p.last_price - 99.5) < 1e-4);
  assert.equal(p.volume, 12_345);
  assert.equal(p.total_sell_quantity, 200);
  assert.equal(p.total_buy_quantity, 300);
  assert.ok(Math.abs(p.open - 95) < 1e-4);
  assert.ok(Math.abs(p.close - 94) < 1e-4);
  assert.ok(Math.abs(p.high - 101) < 1e-4);
  assert.ok(Math.abs(p.low - 93) < 1e-4);
  assert.equal(p.bids, undefined, "a quote packet carries no depth");
});

/* ----------------------------------- OI ----------------------------------- */

test("decodes an OI packet", () => {
  const buf = packet(DHAN_FEED_CODE.OI, 12, NSE_FNO, SECURITY, (v) => {
    v.setInt32(8, 987_654, true);
  });
  const { packets, errors } = decodeDhanFeed(buf);
  assert.deepEqual(errors, []);
  assert.equal(packets[0].oi, 987_654);
  assert.equal(packets[0].last_price, undefined, "an OI packet carries no price");
});

test("decodes a PREV_CLOSE packet", () => {
  const buf = packet(DHAN_FEED_CODE.PREV_CLOSE, 16, NSE_FNO, SECURITY, (v) => {
    v.setFloat32(8, 88.25, true);
    v.setInt32(12, 55_555, true);
  });
  const { packets } = decodeDhanFeed(buf);
  assert.ok(Math.abs(packets[0].prev_close - 88.25) < 1e-4);
  assert.equal(packets[0].prev_oi, 55_555);
});

/* ---------------------------------- full ---------------------------------- */

test("decodes a FULL packet: price, OI, volume, OHLC and the depth ladder", () => {
  const buf = fullPacket({
    ltp: 123.45,
    oi: 4321,
    volume: 9999,
    bids: [[100.5, 75, 3], [100.0, 150, 5]],
    asks: [[101.0, 50, 2], [101.5, 90, 4]],
  });
  const { packets, errors } = decodeDhanFeed(buf);
  assert.deepEqual(errors, []);
  const p = packets[0];
  assert.ok(Math.abs(p.last_price - 123.45) < 1e-3);
  assert.equal(p.oi, 4321);
  assert.equal(p.oi_day_high, 4421);
  assert.equal(p.oi_day_low, 4221);
  assert.equal(p.volume, 9999);

  // The Full packet's OHLC sits 12 bytes after the Quote packet's, because three
  // OI fields precede it. This assertion is what catches that shift.
  assert.ok(Math.abs(p.open - 120) < 1e-4);
  assert.ok(Math.abs(p.close - 119) < 1e-4);
  assert.ok(Math.abs(p.high - 130) < 1e-4);
  assert.ok(Math.abs(p.low - 118) < 1e-4);

  assert.equal(p.bids.length, 2);
  assert.ok(Math.abs(p.bids[0].price - 100.5) < 1e-4);
  assert.equal(p.bids[0].qty, 75);
  assert.equal(p.bids[0].orders, 3);
  assert.equal(p.asks.length, 2);
  assert.ok(Math.abs(p.asks[0].price - 101.0) < 1e-4);
  assert.equal(p.asks[0].qty, 50);
  assert.equal(p.asks[0].orders, 2);
});

test("zero-priced depth levels are DROPPED, not reported as ₹0 liquidity", () => {
  // An empty level means "no liquidity here". A ₹0 bid would look executable to the
  // Box liquidity check, which is the whole reason these are filtered.
  const buf = fullPacket({ bids: [[100, 75, 3]], asks: [] });
  const { packets } = decodeDhanFeed(buf);
  assert.equal(packets[0].bids.length, 1);
  assert.equal(packets[0].asks.length, 0);
});

/* -------------------------------- framing --------------------------------- */

test("decodes SEVERAL packets from one frame", () => {
  const frame = concat(
    packet(DHAN_FEED_CODE.TICKER, 16, NSE_FNO, 111, (v) => {
      v.setFloat32(8, 1.5, true);
      v.setInt32(12, 1_760_000_000, true);
    }),
    packet(DHAN_FEED_CODE.OI, 12, NSE_FNO, 222, (v) => v.setInt32(8, 42, true)),
    fullPacket({ ltp: 7.25 }),
  );
  const { packets, errors } = decodeDhanFeed(frame);
  assert.deepEqual(errors, []);
  assert.equal(packets.length, 3);
  assert.deepEqual(packets.map((p) => p.securityId), [111, 222, SECURITY]);
});

test("an UNKNOWN response code is skipped by its declared length, sparing its neighbours", () => {
  // One new packet type from Dhan must not break the packets around it.
  const unknown = packet(99, 20, NSE_FNO, 555, () => {});
  const frame = concat(unknown, fullPacket({ ltp: 55.5 }));
  const { packets, errors } = decodeDhanFeed(frame);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown Dhan feed response code 99/);
  assert.equal(packets.length, 1, "the following FULL packet still decoded");
  assert.ok(Math.abs(packets[0].last_price - 55.5) < 1e-3);
});

test("a TRUNCATED packet is reported and does not throw", () => {
  const full = fullPacket();
  // Declare 162 bytes but deliver only 100.
  const truncated = new Uint8Array(new Uint8Array(full).slice(0, 100)).buffer;
  const { packets, errors } = decodeDhanFeed(truncated);
  assert.equal(packets.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /truncated packet/);
});

test("a packet whose declared length is too short for its type is reported", () => {
  // Header says FULL but only 40 bytes: reading OHLC/depth would run off the end.
  const buf = packet(DHAN_FEED_CODE.FULL, 40, NSE_FNO, SECURITY, () => {});
  const { packets, errors } = decodeDhanFeed(buf);
  assert.equal(packets.length, 0);
  assert.match(errors[0], /full packet too short/);
});

test("a non-positive declared length stops the walk instead of looping forever", () => {
  const buf = new ArrayBuffer(16);
  const v = new DataView(buf);
  v.setUint8(0, DHAN_FEED_CODE.TICKER);
  v.setInt16(1, 0, true); // a length of 0 would never advance the cursor
  const { packets, errors } = decodeDhanFeed(buf);
  assert.equal(packets.length, 0);
  assert.match(errors[0], /non-positive length/);
});

test("an empty frame is a heartbeat, not an error", () => {
  const { packets, errors } = decodeDhanFeed(new ArrayBuffer(0));
  assert.deepEqual(packets, []);
  assert.deepEqual(errors, []);
});

test("a frame shorter than the header is reported", () => {
  const { packets, errors } = decodeDhanFeed(new ArrayBuffer(DHAN_HEADER_BYTES - 1));
  assert.equal(packets.length, 0);
  assert.match(errors[0], /shorter than the 8-byte header/);
});

test("a server DISCONNECT packet is surfaced with its code", () => {
  const buf = packet(DHAN_FEED_CODE.DISCONNECT, 10, NSE_FNO, 0, (v) => {
    v.setInt16(8, 805, true);
  });
  const { packets } = decodeDhanFeed(buf);
  assert.equal(packets[0].code, DHAN_FEED_CODE.DISCONNECT);
  assert.equal(packets[0].disconnect_code, 805);
});

test("an unknown segment code yields a null segment rather than a wrong one", () => {
  // Attributing a price to the wrong exchange segment is worse than not attributing it.
  const buf = packet(DHAN_FEED_CODE.OI, 12, 99, SECURITY, (v) => v.setInt32(8, 5, true));
  const { packets } = decodeDhanFeed(buf);
  assert.equal(packets[0].segment, null);
  assert.equal(packets[0].segmentCode, 99);
});

/* ------------------------------ normalization ----------------------------- */

test("toTick uses executable bid/ask and NEVER invents an exchange timestamp", () => {
  const tick = toTick({
    token: 2_000_045_678,
    last_price: 123.45,
    close_price: 119,
    oi: 4321,
    bids: [{ price: 100.5, qty: 75, orders: 3 }],
    asks: [{ price: 101.0, qty: 50, orders: 2 }],
  });
  assert.equal(tick.token, 2_000_045_678);
  assert.equal(tick.bid, 100.5, "best bid comes from the ladder, not the LTP");
  assert.equal(tick.ask, 101.0);
  assert.equal(tick.oi, 4321);
  assert.equal(tick.close_price, 119);

  // Dhan's Last Trade Time is NOT a book publication timestamp. Passing it as
  // `exchange_ts` would corrupt the Box cross-leg temporal-coherence check, so the
  // field is deliberately absent and the engine falls back to receive time.
  assert.equal(tick.exchange_ts, undefined);
  assert.ok(!("exchange_ts" in tick) || tick.exchange_ts === undefined);
});

test("toTick reports a missing side as 0 rather than guessing a price", () => {
  const tick = toTick({
    token: 1,
    last_price: 5,
    close_price: 4,
    oi: 0,
    bids: [],
    asks: [{ price: 6, qty: 10, orders: 1 }],
  });
  assert.equal(tick.bid, 0);
  assert.equal(tick.ask, 6);
});
