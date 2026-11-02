// Golden generator: src/ticker.ts parseBinary over many deterministic Kite frames.
import { loadTicker, rng, hex, writeGolden } from "./loader.mjs";

const { parseBinary } = await loadTicker();

const cases = [];

/** Run the reference parser; a thrown RangeError (DataView overrun) is recorded. */
function add(name, bytes) {
  const u8 = Uint8Array.from(bytes);
  const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  let ticks = null;
  let error = null;
  try {
    ticks = parseBinary(buf);
  } catch (e) {
    error = `${e.name}`;
  }
  cases.push({ name, hex: hex(u8), ticks, error });
}

// --- builders (big-endian) -------------------------------------------------------------
function w16(arr, off, v) {
  arr[off] = (v >> 8) & 0xff;
  arr[off + 1] = v & 0xff;
}
function w32(arr, off, v) {
  arr[off] = (v >>> 24) & 0xff;
  arr[off + 1] = (v >>> 16) & 0xff;
  arr[off + 2] = (v >>> 8) & 0xff;
  arr[off + 3] = v & 0xff;
}

/** One packet body of `len` bytes with the given fields written at the Kite offsets. */
function body(len, f = {}) {
  const b = new Array(len).fill(0);
  if (len >= 4) w32(b, 0, f.token ?? 0);
  if (len >= 8) w32(b, 4, f.ltp ?? 0);
  if (len >= 44 && f.close !== undefined) w32(b, 40, f.close);
  if (len >= 184) {
    if (f.oi !== undefined) w32(b, 48, f.oi);
    if (f.ts !== undefined) w32(b, 60, f.ts);
    (f.bids ?? []).forEach((l, i) => {
      w32(b, 64 + i * 12, l[1]);
      w32(b, 68 + i * 12, l[0]);
      w16(b, 72 + i * 12, l[2] ?? 0);
    });
    (f.asks ?? []).forEach((l, i) => {
      w32(b, 124 + i * 12, l[1]);
      w32(b, 128 + i * 12, l[0]);
      w16(b, 132 + i * 12, l[2] ?? 0);
    });
  }
  return b;
}

/** A frame: int16 packet count, then [int16 length][body] per packet. */
function frame(packets, count = packets.length) {
  const out = [0, 0];
  w16(out, 0, count);
  for (const p of packets) {
    const h = [0, 0];
    w16(h, 0, p.length);
    out.push(...h, ...p);
  }
  return out;
}

// Tokens: segment byte (low 8 bits) decides the divisor: 3 -> 1e7 (CDS), 7 -> 1e4 (BCD).
const NSE = 408065; // 0x63A01 -> segment 1
const NFO = 12335874; // low byte 2
const BIG = 0xfffffe02; // > 2^31, low byte 2: must stay unsigned
const CDS = 0x00011403; // low byte 3
const BCD = 0x00022107; // low byte 7
const MCX = 0x00f1f005; // low byte 5
const lvl = (price, qty, orders) => [price, qty, orders];

// --- heartbeat and truncation ----------------------------------------------------------
add("empty", []);
add("heartbeat 1 byte", [0]);
add("heartbeat 1 byte nonzero", [0x7f]);
add("zero packets", [0, 0]);
add("one packet announced, no header", [0, 1]);
add("one packet, header cut", [0, 1, 0]);
add("one packet, header only (len 8 missing body)", [0, 1, 0, 8]);
add("negative packet count", [0xff, 0xff, 0, 8, 0, 0, 0, 1, 0, 0, 0, 2]);
add("packet count 0x8000", [0x80, 0x00, 0, 8, 0, 0, 0, 1, 0, 0, 0, 2]);

// --- LTP (8 byte) -----------------------------------------------------------------------
add("ltp nse", frame([body(8, { token: NSE, ltp: 123456 })]));
add("ltp nfo", frame([body(8, { token: NFO, ltp: 2345000 })]));
add("ltp token above 2^31", frame([body(8, { token: BIG, ltp: 1 })]));
add("ltp token max uint32", frame([body(8, { token: 0xffffffff, ltp: 0xffffffff })]));
add("ltp cds divisor", frame([body(8, { token: CDS, ltp: 837125000 })]));
add("ltp bcd divisor", frame([body(8, { token: BCD, ltp: 837125 })]));
add("ltp mcx", frame([body(8, { token: MCX, ltp: 7204100 })]));
add("ltp zero", frame([body(8, { token: NSE, ltp: 0 })]));
add("ltp odd price", frame([body(8, { token: NSE, ltp: 1 })]));
add("ltp 3 digit price", frame([body(8, { token: NSE, ltp: 12345 })]));

// --- index layouts (28 / 32 bytes) and other mid sizes -----------------------------------
const idx28 = body(28, { token: 256265, ltp: 2415565 });
[4, 8, 12, 20, 21].forEach((o, i) => w32(idx28, o, 100 + i)); // high/low/open/close/change
add("index 28 bytes (close not read)", frame([idx28]));
const idx32 = body(32, { token: 260105, ltp: 4900050 });
w32(idx32, 20, 4888000);
w32(idx32, 28, 1700000000);
add("index 32 bytes", frame([idx32]));
add("len 4 (price read from next bytes)", frame([body(4, { token: NSE }), body(8, { token: NFO, ltp: 99 })]));
add("len 0 packets", frame([[], []]));
add("len 1 packet", frame([[0xab], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]));
add("len 43 (no close)", frame([body(43, { token: NFO, ltp: 100000 })]));

// --- quote (44 / 8..183) -----------------------------------------------------------------
add("quote 44", frame([body(44, { token: NFO, ltp: 2345050, close: 2300000 })]));
add("quote 44 cds", frame([body(44, { token: CDS, ltp: 837125000, close: 836000000 })]));
add("quote 100 (close only)", frame([body(100, { token: NFO, ltp: 100, close: 90 })]));
add("quote 164", frame([body(164, { token: NFO, ltp: 100, close: 90 })]));
add("quote 183 (one short of full)", frame([body(183, { token: NFO, ltp: 100, close: 90 })]));
add("quote 44 max values", frame([body(44, { token: 0xffffffff, ltp: 0xffffffff, close: 0xffffffff })]));

// --- full (184) --------------------------------------------------------------------------
const bids5 = [lvl(234500, 75, 3), lvl(234450, 150, 2), lvl(234400, 225, 1), lvl(234350, 300, 4), lvl(234300, 75, 65535)];
const asks5 = [lvl(234550, 60, 5), lvl(234600, 120, 6), lvl(234650, 180, 7), lvl(234700, 240, 8), lvl(234750, 4294967295, 9)];
add("full 5 levels", frame([body(184, { token: NFO, ltp: 234525, close: 230000, oi: 1234500, ts: 1700000000, bids: bids5, asks: asks5 })]));
add("full no depth (zero levels)", frame([body(184, { token: NFO, ltp: 100, close: 90, oi: 5 })]));
add("full bids only", frame([body(184, { token: NFO, ltp: 100, close: 90, oi: 5, ts: 1, bids: bids5.slice(0, 2) })]));
add("full asks only", frame([body(184, { token: NFO, ltp: 100, close: 90, oi: 5, asks: asks5.slice(0, 3) })]));
add(
  "full gaps in depth (zero price levels dropped)",
  frame([
    body(184, {
      token: NFO,
      ltp: 100,
      bids: [lvl(0, 10, 1), lvl(500, 20, 2), lvl(0, 30, 3), lvl(490, 40, 4), lvl(480, 50, 5)],
      asks: [lvl(510, 10, 1), lvl(0, 20, 2), lvl(0, 30, 3), lvl(0, 40, 4), lvl(540, 50, 5)],
    }),
  ]),
);
add("full zero qty but priced level kept", frame([body(184, { token: NFO, ltp: 1, bids: [lvl(100, 0, 0)], asks: [lvl(101, 0, 0)] })]));
add("full ts 0", frame([body(184, { token: NFO, ltp: 100, ts: 0, bids: bids5.slice(0, 1) })]));
add("full ts 1", frame([body(184, { token: NFO, ltp: 100, ts: 1 })]));
add("full ts max", frame([body(184, { token: NFO, ltp: 100, ts: 0xffffffff })]));
add("full oi max", frame([body(184, { token: NFO, ltp: 100, oi: 0xffffffff })]));
add("full cds depth divisor", frame([body(184, { token: CDS, ltp: 837125000, close: 836000000, bids: [lvl(837100000, 1000, 2)], asks: [lvl(837150000, 2000, 3)] })]));
add("full bcd depth divisor", frame([body(184, { token: BCD, ltp: 837125, bids: [lvl(837100, 10, 2)], asks: [lvl(837150, 20, 3)] })]));
add("full big token", frame([body(184, { token: BIG, ltp: 100, bids: bids5, asks: asks5 })]));
add("full 200 bytes (extra tail)", frame([body(200, { token: NFO, ltp: 100, close: 90, oi: 3, ts: 5, bids: bids5, asks: asks5 })]));
add("full exactly 184 with tail bytes in buffer", [...frame([body(184, { token: NFO, ltp: 100, bids: bids5 })]), 9, 9, 9]);

// --- multi packet frames ------------------------------------------------------------------
add(
  "mixed ltp quote full",
  frame([
    body(8, { token: NSE, ltp: 100 }),
    body(44, { token: NFO, ltp: 200, close: 190 }),
    body(184, { token: BIG, ltp: 300, close: 290, oi: 7, ts: 1700000001, bids: bids5, asks: asks5 }),
    body(8, { token: CDS, ltp: 837125000 }),
    body(28, { token: 256265, ltp: 2415565 }),
  ]),
);
add("many ltp packets", frame(Array.from({ length: 60 }, (_, i) => body(8, { token: 100000 + i * 256 + 2, ltp: 100 + i }))));
add("announced more than present (stops)", frame([body(8, { token: NSE, ltp: 1 }), body(8, { token: NFO, ltp: 2 })], 5));
add("announced fewer than present (ignores rest)", frame([body(8, { token: NSE, ltp: 1 }), body(8, { token: NFO, ltp: 2 })], 1));
add("last packet body overruns buffer (dropped, earlier kept)", [...frame([body(8, { token: NSE, ltp: 1 })], 2), 0, 44, 1, 2, 3]);
add("header of next packet cut", [...frame([body(8, { token: NSE, ltp: 1 })], 2), 0]);
add("trailing garbage after count satisfied", [...frame([body(8, { token: NSE, ltp: 1 })]), 1, 2, 3, 4, 5, 6]);

// --- malformed: RangeError territory (Node lost the whole frame) --------------------------
add("len 2 at end (price read past buffer)", [0, 1, 0, 2, 0, 0]);
add("len 4 at end", [0, 1, 0, 4, 0, 0, 0, 1]);
add("len 7 at end (price cut)", [0, 1, 0, 7, 0, 0, 0, 1, 0, 0, 0]);
add("len 0 at end", [0, 1, 0, 0]);
add("negative length", [0, 1, 0xff, 0xfe, 0, 0, 0, 1, 0, 0, 0, 2]);
add("negative length walks backwards", [0, 2, 0xff, 0xf8, 0, 0, 0, 1, 0, 0, 0, 2, 0, 8, 0, 0, 0, 3, 0, 0, 0, 4]);
add("negative length before start", [0, 3, 0xff, 0x00, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 0]);
add("earlier good packet then RangeError", [0, 2, ...[0, 8, 0, 0, 1, 2, 0, 0, 0, 100], 0, 2, 0, 0]);
add("44 byte packet short of buffer via negative", [0, 1, 0x80, 0x00]);

// --- randomised --------------------------------------------------------------------------
const r = rng(20261027);
const lens = [8, 8, 8, 28, 32, 44, 64, 100, 164, 184, 184, 184, 200];
for (let n = 0; n < 160; n++) {
  const packets = [];
  const count = 1 + r.int(6);
  for (let i = 0; i < count; i++) {
    const len = r.pick(lens);
    const token = (r.u32() & 0xffffff00) | r.pick([0, 1, 2, 3, 4, 5, 6, 7, 8, 0x12, 0xff]);
    const bids = Array.from({ length: 5 }, () => lvl(r.int(4) === 0 ? 0 : r.int(5_000_000), r.u32() % 100000, r.int(70000)));
    const asks = Array.from({ length: 5 }, () => lvl(r.int(4) === 0 ? 0 : r.int(5_000_000), r.u32() % 100000, r.int(70000)));
    packets.push(body(len, { token: token >>> 0, ltp: r.int(10_000_000), close: r.int(10_000_000), oi: r.u32(), ts: r.int(3) === 0 ? 0 : r.u32(), bids, asks }));
  }
  const announce = r.int(8) === 0 ? count + r.int(3) : count;
  add(`random structured ${n}`, frame(packets, announce));
}
for (let n = 0; n < 120; n++) {
  const len = r.int(300);
  const bytes = Array.from({ length: len }, () => r.int(256));
  if (len >= 4 && r.int(2) === 0) w16(bytes, 0, 1 + r.int(3)); // plausible counts
  add(`random bytes ${n}`, bytes);
}
for (let n = 0; n < 60; n++) {
  // Structured frame with a corrupted length field.
  const p = body(r.pick([8, 44, 184]), { token: r.u32(), ltp: r.u32(), close: r.u32() });
  const f = frame([p, body(8, { token: r.u32(), ltp: r.u32() })]);
  w16(f, 2, r.int(70000));
  add(`random corrupt length ${n}`, f);
}

const written = writeGolden("parsebinary.golden.json", { cases });
const thrown = cases.filter((c) => c.error).length;
console.log(`parsebinary: ${cases.length} cases (${thrown} RangeError) -> ${written}`);
