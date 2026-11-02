// Goldens for the feed decoder (feedDecoder.ts), toTick and DhanFeed's merge/attribution
// (feed.ts handleFrame): decoder.json, totick.json, feed_merge.json.
import { loadDhan, rng, writeFixture, hex, withFakes } from "./gen_common.mjs";

const SEGMENTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 99, 255];
const SECURITY_IDS = [0, 1, 13, 438, 45678, 2147483647, -1, -2147483648, 99999999, 1000000000];

/** Float32 bit patterns worth hitting: zero, -0, subnormal, huge, NaN, infinities. */
const FLOAT_BITS = [
  0x00000000, 0x80000000, 0x00000001, 0x7f7fffff, 0x7fc00000, 0x7f800000, 0xff800000,
  0x3f800000, 0xbf800000, 0x42c80000, // 1, -1, 100
];

function packetBytes({ code, declared, segment, securityId, total, fill }) {
  const buf = new ArrayBuffer(total ?? declared);
  const v = new DataView(buf);
  v.setUint8(0, code);
  v.setInt16(1, declared, true);
  v.setUint8(3, segment);
  v.setInt32(4, securityId, true);
  if (fill) fill(v);
  return buf;
}

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

/** Random bytes for [from, to) with a bias towards the interesting float patterns. */
function randomFill(r, from, to) {
  return (v) => {
    for (let i = from; i < to; i++) v.setUint8(i, r.int(256));
    for (let i = from; i + 4 <= to; i += 4) {
      if (r() < 0.35) v.setUint32(i, r.pick(FLOAT_BITS), true);
    }
  };
}

const MIN_LEN = { 1: 16, 2: 16, 4: 50, 5: 12, 6: 16, 8: 162 };

function typical() {
  const out = [];
  const mk = (name, bytes) => out.push({ name, buf: bytes });
  mk("ticker typical", packetBytes({ code: 2, declared: 16, segment: 2, securityId: 45678, fill: (v) => { v.setFloat32(8, 250.75, true); v.setInt32(12, 1760000500, true); } }));
  mk("ticker zero ltt", packetBytes({ code: 2, declared: 16, segment: 2, securityId: 45678, fill: (v) => { v.setFloat32(8, 10, true); v.setInt32(12, 0, true); } }));
  mk("ticker negative ltt", packetBytes({ code: 2, declared: 16, segment: 2, securityId: 45678, fill: (v) => { v.setFloat32(8, 10, true); v.setInt32(12, -5, true); } }));
  mk("index typical", packetBytes({ code: 1, declared: 16, segment: 0, securityId: 13, fill: (v) => { v.setFloat32(8, 24500.35, true); v.setInt32(12, 1760000000, true); } }));
  mk("quote typical", packetBytes({ code: 4, declared: 50, segment: 2, securityId: 45678, fill: (v) => {
    v.setFloat32(8, 99.5, true); v.setInt16(12, 10, true); v.setInt32(14, 1760000000, true); v.setFloat32(18, 98.0, true);
    v.setInt32(22, 12345, true); v.setInt32(26, 200, true); v.setInt32(30, 300, true);
    v.setFloat32(34, 95, true); v.setFloat32(38, 94, true); v.setFloat32(42, 101, true); v.setFloat32(46, 93, true);
  } }));
  mk("oi typical", packetBytes({ code: 5, declared: 12, segment: 2, securityId: 45678, fill: (v) => v.setInt32(8, 987654, true) }));
  mk("oi negative", packetBytes({ code: 5, declared: 12, segment: 2, securityId: 45678, fill: (v) => v.setInt32(8, -7, true) }));
  mk("prev_close typical", packetBytes({ code: 6, declared: 16, segment: 2, securityId: 45678, fill: (v) => { v.setFloat32(8, 88.25, true); v.setInt32(12, 55555, true); } }));
  mk("market_status", packetBytes({ code: 7, declared: 8, segment: 1, securityId: 0 }));
  mk("market_status long", packetBytes({ code: 7, declared: 24, segment: 1, securityId: 0 }));
  mk("disconnect 805", packetBytes({ code: 50, declared: 10, segment: 2, securityId: 0, fill: (v) => v.setInt16(8, 805, true) }));
  mk("disconnect short", packetBytes({ code: 50, declared: 9, segment: 2, securityId: 0, fill: (v) => v.setUint8(8, 7) }));
  mk("disconnect header only", packetBytes({ code: 50, declared: 8, segment: 2, securityId: 0 }));
  mk("disconnect negative", packetBytes({ code: 50, declared: 12, segment: 2, securityId: 0, fill: (v) => v.setInt16(8, -3, true) }));
  mk("unknown 99", packetBytes({ code: 99, declared: 20, segment: 2, securityId: 555 }));
  mk("unknown 0", packetBytes({ code: 0, declared: 8, segment: 2, securityId: 555 }));
  mk("unknown segment oi", packetBytes({ code: 5, declared: 12, segment: 99, securityId: 45678, fill: (v) => v.setInt32(8, 5, true) }));
  mk("segment 6 oi", packetBytes({ code: 5, declared: 12, segment: 6, securityId: 45678, fill: (v) => v.setInt32(8, 5, true) }));
  return out;
}

function fullBytes(opts = {}) {
  const {
    code = 8, declared = 162, segment = 2, securityId = 45678, ltp = 123.45, oi = 4321, volume = 9999,
    open = 120, close = 119, high = 130, low = 118, ltt = 1760000000,
    bids = [[100, 75, 3]], asks = [[101, 50, 2]], total,
  } = opts;
  return packetBytes({ code, declared, segment, securityId, total, fill: (v) => {
    v.setFloat32(8, ltp, true); v.setInt16(12, 25, true); v.setInt32(14, ltt, true); v.setFloat32(18, 122.0, true);
    v.setInt32(22, volume, true); v.setInt32(26, 500, true); v.setInt32(30, 700, true);
    v.setInt32(34, oi, true); v.setInt32(38, oi + 100, true); v.setInt32(42, oi - 100, true);
    v.setFloat32(46, open, true); v.setFloat32(50, close, true); v.setFloat32(54, high, true); v.setFloat32(58, low, true);
    for (let i = 0; i < 5; i++) {
      const at = 62 + i * 20;
      if (at + 20 > v.byteLength) break;
      const bid = bids[i];
      const ask = asks[i];
      v.setInt32(at, bid ? bid[1] : 0, true);
      v.setInt32(at + 4, ask ? ask[1] : 0, true);
      v.setInt16(at + 8, bid ? bid[2] : 0, true);
      v.setInt16(at + 10, ask ? ask[2] : 0, true);
      v.setFloat32(at + 12, bid ? bid[0] : 0, true);
      v.setFloat32(at + 16, ask ? ask[0] : 0, true);
    }
  } });
}

function buildDecoderCases(decode) {
  const cases = [];
  const add = (name, buf, repeat) => {
    const frame = repeat ? new Uint8Array(buf) : null;
    let full = buf;
    if (repeat) {
      const out = new Uint8Array(frame.length * repeat);
      for (let i = 0; i < repeat; i++) out.set(frame, i * frame.length);
      full = out.buffer;
    }
    const { packets, errors } = decode(full);
    const c = { name, hex: hex(buf), errors };
    if (repeat) {
      // A repeated frame is summarised: the packet count plus the first and last packet.
      c.repeat = repeat;
      c.packetCount = packets.length;
      c.firstPacket = packets[0] ?? null;
      c.lastPacket = packets[packets.length - 1] ?? null;
    } else {
      c.packets = packets;
    }
    cases.push(c);
  };

  for (const t of typical()) add(t.name, t.buf);

  // FULL packets: the TS test's ladders plus every depth edge.
  add("full typical", fullBytes({ bids: [[100.5, 75, 3], [100.0, 150, 5]], asks: [[101.0, 50, 2], [101.5, 90, 4]] }));
  add("full bid only", fullBytes({ bids: [[100, 75, 3]], asks: [] }));
  add("full ask only", fullBytes({ bids: [], asks: [[101, 50, 2]] }));
  add("full empty depth", fullBytes({ bids: [], asks: [] }));
  add("full five levels", fullBytes({
    bids: [[100, 10, 1], [99.95, 20, 2], [99.9, 30, 3], [99.85, 40, 4], [99.8, 50, 5]],
    asks: [[100.05, 11, 1], [100.1, 21, 2], [100.15, 31, 3], [100.2, 41, 4], [100.25, 51, 5]],
  }));
  add("full gap level", fullBytes({ bids: [[100, 10, 1], [0, 99, 9], [99.9, 30, 3]], asks: [[0, 1, 1], [101, 5, 1]] }));
  add("full negative qty and orders", fullBytes({ bids: [[100, -50, -3]], asks: [[101, -2147483648, -32768]] }));
  add("full big qty", fullBytes({ bids: [[100, 2147483647, 32767]], asks: [[101, 1, 1]] }));
  add("full negative price dropped", fullBytes({ bids: [[-100, 5, 1]], asks: [[-0.05, 5, 1]] }));
  add("full infinite price kept", fullBytes({ bids: [[Infinity, 5, 1]], asks: [[1e-40, 5, 1]] }));
  add("full nan price dropped", fullBytes({ bids: [[NaN, 5, 1]], asks: [[NaN, 5, 1]] }));
  add("full minus zero price dropped", fullBytes({ bids: [[-0, 5, 1]], asks: [[0, 5, 1]] }));
  add("full oi extremes", fullBytes({ oi: 2147483647, volume: -1 }));
  add("full long packet", fullBytes({ declared: 170, total: 170 }));
  add("full ltt zero", fullBytes({ ltt: 0 }));
  add("full precision floats", fullBytes({ ltp: 101.05, open: 0.1, close: 1 / 3, high: 1e10, low: 123456.789 }));
  add("full too short 40", packetBytes({ code: 8, declared: 40, segment: 2, securityId: 45678 }));
  add("full too short 161", packetBytes({ code: 8, declared: 161, segment: 2, securityId: 45678 }));
  add("full truncated at 100", new Uint8Array(new Uint8Array(fullBytes()).slice(0, 100)).buffer);
  add("full truncated at 161", new Uint8Array(new Uint8Array(fullBytes()).slice(0, 161)).buffer);

  // Too-short and truncated variants of every sized type.
  for (const [code, min] of Object.entries(MIN_LEN)) {
    for (const len of [8, 9, min - 1, min, min + 1, min + 20]) {
      if (len < 8) continue;
      add(`type ${code} declared ${len}`, packetBytes({ code: Number(code), declared: len, segment: 2, securityId: 77, fill: randomFill(rng(1000 + Number(code) * 7 + len), 8, len) }));
    }
    add(`type ${code} truncated`, packetBytes({ code: Number(code), declared: min, total: min - 3, segment: 2, securityId: 77 }));
  }

  // Header and length edge cases.
  add("empty frame", new ArrayBuffer(0));
  for (let n = 1; n <= 7; n++) add(`frame of ${n} bytes`, new ArrayBuffer(n));
  add("zero header", new ArrayBuffer(8));
  add("zero header long", new ArrayBuffer(16));
  add("ticker length zero", packetBytes({ code: 2, declared: 0, segment: 2, securityId: 1, total: 16 }));
  add("ticker length negative", packetBytes({ code: 2, declared: -1, segment: 2, securityId: 1, total: 16 }));
  add("ticker length int16 min", packetBytes({ code: 2, declared: -32768, segment: 2, securityId: 1, total: 16 }));
  add("ticker length int16 max", packetBytes({ code: 2, declared: 32767, segment: 2, securityId: 1, total: 16 }));
  add("ticker length one beyond", packetBytes({ code: 2, declared: 17, segment: 2, securityId: 1, total: 16 }));
  add("ticker length seven", packetBytes({ code: 2, declared: 7, segment: 2, securityId: 1, total: 16 }));
  add("market status declared one", packetBytes({ code: 7, declared: 1, segment: 2, securityId: 1, total: 16 }));

  // Multi-packet frames, including the TS test's.
  add("three packets", concat(
    packetBytes({ code: 2, declared: 16, segment: 2, securityId: 111, fill: (v) => { v.setFloat32(8, 1.5, true); v.setInt32(12, 1760000000, true); } }),
    packetBytes({ code: 5, declared: 12, segment: 2, securityId: 222, fill: (v) => v.setInt32(8, 42, true) }),
    fullBytes({ ltp: 7.25 }),
  ));
  add("unknown then full", concat(packetBytes({ code: 99, declared: 20, segment: 2, securityId: 555 }), fullBytes({ ltp: 55.5 })));
  add("full then truncated tail", concat(fullBytes(), packetBytes({ code: 2, declared: 16, total: 11, segment: 2, securityId: 5 })));
  add("packets then zero length", concat(
    packetBytes({ code: 2, declared: 16, segment: 2, securityId: 1, fill: (v) => v.setFloat32(8, 3, true) }),
    packetBytes({ code: 2, declared: 0, segment: 2, securityId: 2, total: 16 }),
    packetBytes({ code: 2, declared: 16, segment: 2, securityId: 3 }),
  ));
  add("trailing seven bytes", concat(packetBytes({ code: 5, declared: 12, segment: 2, securityId: 9, fill: (v) => v.setInt32(8, 1, true) }), new Uint8Array([1, 2, 3, 4, 5, 6, 7]).buffer));
  add("trailing eight bytes", concat(packetBytes({ code: 5, declared: 12, segment: 2, securityId: 9, fill: (v) => v.setInt32(8, 1, true) }), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer));
  add("market status ten thousand", packetBytes({ code: 7, declared: 8, segment: 1, securityId: 5 }), 10000);
  add("market status guard", packetBytes({ code: 7, declared: 8, segment: 1, securityId: 5 }), 10001);
  add("tickers many", packetBytes({ code: 2, declared: 16, segment: 2, securityId: 5, fill: (v) => v.setFloat32(8, 2.5, true) }), 600);

  // Seeded random packets of every type.
  const r = rng(20261027);
  for (let i = 0; i < 360; i++) {
    const code = r.pick([1, 2, 4, 5, 6, 8, 8, 7, 50, 3, 9, 51, 99, 255]);
    const min = MIN_LEN[code] ?? 8;
    const declared = min + (r() < 0.6 ? 0 : r.int(40));
    add(`random packet ${i} code ${code}`, packetBytes({
      code, declared, segment: r.pick(SEGMENTS), securityId: r.pick(SECURITY_IDS), fill: randomFill(r, 8, declared),
    }));
  }
  // Seeded random multi-packet frames, some with a damaged tail.
  for (let i = 0; i < 160; i++) {
    const parts = [];
    const n = 2 + r.int(6);
    for (let k = 0; k < n; k++) {
      const code = r.pick([1, 2, 4, 5, 6, 8, 7, 50, 99]);
      const min = MIN_LEN[code] ?? 8;
      const declared = min + (r() < 0.7 ? 0 : r.int(24));
      parts.push(packetBytes({ code, declared, segment: r.pick(SEGMENTS), securityId: r.pick(SECURITY_IDS), fill: randomFill(r, 8, declared) }));
    }
    let frame = concat(...parts);
    const damage = r.int(5);
    if (damage === 1) frame = frame.slice(0, frame.byteLength - 1 - r.int(20));
    if (damage === 2) frame = concat(frame, new Uint8Array(1 + r.int(15)).buffer);
    add(`random frame ${i} damage ${damage}`, frame);
  }
  // Pure noise.
  for (let i = 0; i < 160; i++) {
    const len = r.int(300);
    const buf = new ArrayBuffer(len);
    const v = new DataView(buf);
    for (let k = 0; k < len; k++) v.setUint8(k, r.int(256));
    add(`noise ${i} len ${len}`, buf);
  }
  return cases;
}

function buildToTickCases(toTick) {
  const r = rng(77);
  const levels = (n) => Array.from({ length: n }, (_, i) => ({ price: 100 + i * 0.05, qty: 10 * (i + 1), orders: i + 1 }));
  const states = [];
  const add = (name, state, depthUpdated) => {
    const tick = depthUpdated === "default" ? toTick(state) : toTick(state, depthUpdated);
    states.push({ name, state, depthUpdated, tick });
  };
  const base = { token: 2000045678, last_price: 123.45, close_price: 119, oi: 4321 };
  add("both sides", { ...base, bids: levels(2), asks: levels(3) }, true);
  add("both sides partial", { ...base, bids: levels(2), asks: levels(3) }, false);
  add("both sides default", { ...base, bids: levels(2), asks: levels(3) }, "default");
  add("bid empty", { ...base, bids: [], asks: levels(1) }, true);
  add("ask empty", { ...base, bids: levels(1), asks: [] }, false);
  add("both empty", { ...base, bids: [], asks: [] }, true);
  add("zero state", { token: 1, last_price: 0, close_price: 0, oi: 0, bids: [], asks: [] }, false);
  add("nan best price", { ...base, bids: [{ price: NaN, qty: 1, orders: 1 }], asks: [{ price: Infinity, qty: 1, orders: 1 }] }, true);
  add("negative zero", { ...base, last_price: -0, bids: [{ price: -0, qty: 1, orders: 1 }], asks: [] }, true);
  add("float32 widened", { ...base, last_price: Math.fround(101.05), bids: [{ price: Math.fround(100.95), qty: 3, orders: 1 }], asks: [{ price: Math.fround(101.1), qty: 2, orders: 1 }] }, true);
  add("big token", { ...base, token: 8000099999, bids: levels(1), asks: levels(1) }, true);
  for (let i = 0; i < 40; i++) {
    add(`random ${i}`, {
      token: r.pick([13, 438, 2000045678, 4000001333, 8000050000]),
      last_price: Math.fround(r() * 500),
      close_price: r() < 0.3 ? 0 : Math.fround(r() * 500),
      oi: r.int(100000),
      bids: levels(r.int(6)),
      asks: levels(r.int(6)),
    }, r.pick([true, false, "default"]));
  }
  return states;
}

const SEG_NAME = { 0: "IDX_I", 1: "NSE_EQ", 2: "NSE_FNO", 3: "NSE_CURRENCY", 4: "BSE_EQ", 5: "MCX_COMM", 7: "BSE_CURRENCY", 8: "BSE_FNO" };

async function buildMergeScenarios(DhanFeed) {
  const scenarios = [];
  const r = rng(424242);
  const pool = [0, 0, 100.05, 101.5, 0.05, 250.75, 7.25];

  function randomPacket(inst) {
    const kind = r.pick(["ticker", "quote", "oi", "prev", "full", "full", "status", "disconnect"]);
    const seg = inst.segCode;
    const sec = inst.securityId;
    const f = () => r.pick(pool);
    switch (kind) {
      case "ticker":
        return packetBytes({ code: 2, declared: 16, segment: seg, securityId: sec, fill: (v) => { v.setFloat32(8, f(), true); v.setInt32(12, r() < 0.5 ? 1760000000 : 0, true); } });
      case "quote":
        return packetBytes({ code: 4, declared: 50, segment: seg, securityId: sec, fill: (v) => {
          v.setFloat32(8, f(), true); v.setInt32(22, r.int(5000), true); v.setFloat32(38, f(), true);
        } });
      case "oi":
        return packetBytes({ code: 5, declared: 12, segment: seg, securityId: sec, fill: (v) => v.setInt32(8, r() < 0.3 ? 0 : r.int(100000), true) });
      case "prev":
        return packetBytes({ code: 6, declared: 16, segment: seg, securityId: sec, fill: (v) => { v.setFloat32(8, f(), true); v.setInt32(12, r() < 0.4 ? 0 : r.int(100000), true); } });
      case "full": {
        const bids = Array.from({ length: r.int(6) }, (_, i) => [r() < 0.15 ? 0 : 100 - i * 0.05, r.int(500), r.int(9)]);
        const asks = Array.from({ length: r.int(6) }, (_, i) => [r() < 0.15 ? 0 : 100.05 + i * 0.05, r.int(500), r.int(9)]);
        return fullBytes({ segment: seg, securityId: sec, ltp: f(), close: f(), oi: r() < 0.3 ? 0 : r.int(100000), volume: r.int(9000), bids, asks });
      }
      case "status":
        return packetBytes({ code: 7, declared: 8, segment: seg, securityId: sec });
      default:
        return packetBytes({ code: 50, declared: 10, segment: seg, securityId: sec, fill: (v) => v.setInt16(8, 805, true) });
    }
  }

  async function run(name, tokens, frames) {
    const batches = [];
    const resolveMap = new Map(tokens.map((t) => [t.token, t.segment === null ? null : { segment: t.segment, securityId: t.securityId }]));
    const feed = new DhanFeed({
      accessToken: () => null,
      clientId: () => "",
      onTicks: (ticks) => batches.push(ticks),
      resolve: (token) => resolveMap.get(token) ?? null,
    });
    for (const t of tokens) feed.wanted.add(t.token);
    const out = [];
    for (const fr of frames) {
      const before = batches.length;
      const { logs } = await withFakes({ now: fr.now }, () => feed.handleFrame(new Uint8Array(Buffer.from(fr.hex, "hex")).buffer));
      out.push({
        ticks: batches.length > before ? batches[batches.length - 1] : null,
        wanted: feed.wantedCount(),
        subscribed: feed.subscribedCount(),
        lastTickAt: feed.lastTickAtMs(),
        logs,
      });
    }
    scenarios.push({ name, tokens, frames, out });
  }

  const insts = [
    { token: 2000045678, segment: "NSE_FNO", securityId: 45678, segCode: 2 },
    { token: 1000000438, segment: "NSE_EQ", securityId: 438, segCode: 1 },
    { token: 13, segment: "IDX_I", securityId: 13, segCode: 0 },
  ];
  const frameFor = (parts, now) => ({ hex: hex(concat(...parts)), now });

  // Random single-instrument and multi-instrument streams.
  for (let s = 0; s < 8; s++) {
    const frames = [];
    for (let i = 0; i < 40; i++) {
      const parts = [];
      for (let k = 0; k < 1 + r.int(4); k++) parts.push(randomPacket(r.pick(insts)));
      frames.push(frameFor(parts, 1760000000000 + i * 137 + s));
    }
    await run(`random stream ${s}`, s % 2 === 0 ? insts : insts.slice(0, 1), frames);
  }

  // Attribution edge cases.
  const stranger = { segCode: 2, securityId: 99999 };
  const sameIdOtherSegment = { segCode: 4, securityId: 45678 };
  await run("attribution", [
    { token: 2000045678, segment: "NSE_FNO", securityId: 45678 },
    { token: 7777, segment: "NSE_FNO", securityId: 45678 }, // duplicate identity: first wins
    { token: 5555, segment: null }, // unresolvable
    { token: 8000000001, segment: "BSE_FNO", securityId: 1 },
  ], [
    frameFor([randomPacket(insts[0])], 1000),
    frameFor([randomPacket(stranger), randomPacket(sameIdOtherSegment)], 2000),
    frameFor([randomPacket({ segCode: 8, securityId: 1 }), packetBytes({ code: 5, declared: 12, segment: 77, securityId: 45678, fill: (v) => v.setInt32(8, 4, true) })], 3000),
    frameFor([packetBytes({ code: 7, declared: 8, segment: 2, securityId: 45678 }), packetBytes({ code: 50, declared: 10, segment: 2, securityId: 45678, fill: (v) => v.setInt16(8, 1, true) })], 4000),
    { hex: "", now: 5000 },
    { hex: "0102", now: 6000 },
  ]);

  // The TS test: FULL authoritative, then a partial TICKER retains the ladders.
  await run("full then ticker", [{ token: 7654321, segment: "NSE_FNO", securityId: 45678 }], [
    { hex: hex(fullBytes({ bids: [[100, 75, 3]], asks: [[101, 50, 2]] })), now: 1000 },
    { hex: hex(packetBytes({ code: 2, declared: 16, segment: 2, securityId: 45678, fill: (v) => { v.setFloat32(8, 102.5, true); v.setInt32(12, 1760000500, true); } })), now: 2000 },
    { hex: hex(fullBytes({ bids: [], asks: [] })), now: 3000 },
    { hex: hex(packetBytes({ code: 5, declared: 12, segment: 2, securityId: 45678, fill: (v) => v.setInt32(8, 0, true) })), now: 4000 },
    { hex: hex(packetBytes({ code: 6, declared: 16, segment: 2, securityId: 45678, fill: (v) => { v.setFloat32(8, 55, true); v.setInt32(12, 66, true); } })), now: 5000 },
  ]);
  return scenarios;
}

export async function run() {
  const decoder = await loadDhan("feedDecoder");
  const feedMod = await loadDhan("feed");
  const written = [];

  const decoderCases = buildDecoderCases(decoder.decodeDhanFeed);
  written.push(writeFixture("decoder.json", { generator: "gen_decoder.mjs", source: "src/brokers/dhan/feedDecoder.ts" }, decoderCases));

  const tickCases = buildToTickCases(feedMod.toTick);
  written.push(writeFixture("totick.json", { generator: "gen_decoder.mjs", source: "src/brokers/dhan/feed.ts toTick" }, tickCases));

  const merge = await buildMergeScenarios(feedMod.DhanFeed);
  written.push(writeFixture("feed_merge.json", { generator: "gen_decoder.mjs", source: "src/brokers/dhan/feed.ts handleFrame" }, merge));
  return { written, counts: { decoder: decoderCases.length, toTick: tickCases.length, merge: merge.length } };
}
