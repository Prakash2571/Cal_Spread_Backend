/**
 * DhanHQ v2 live-feed binary decoder. PURE — no sockets, no clock, no state.
 *
 * Kept free of I/O so the byte layout can be tested exhaustively offline, which
 * matters more here than anywhere else in the Dhan integration: a misread offset
 * does not throw, it silently yields a plausible-looking wrong price, and the Box
 * scanner would then trade on it.
 *
 * WIRE FORMAT
 * Dhan sends JSON upstream and BINARY downstream. Every packet begins with the
 * same 8-byte header and is LITTLE-ENDIAN throughout (the opposite of Kite's
 * big-endian ticker — mixing them up is the obvious failure mode):
 *
 *   offset 0  uint8   feed response code   (which packet type follows)
 *   offset 1  int16   message length       (whole packet, including this header)
 *   offset 3  uint8   exchange segment     (see segments.ts)
 *   offset 4  int32   security id
 *
 * Prices are IEEE-754 float32 RUPEES, not paise-integers. There is no divisor.
 *
 * A single frame may carry SEVERAL packets back to back, so decoding walks the
 * buffer by each packet's own declared length.
 */

import { dhanSegmentFromCode, type DhanExchangeSegment } from "./segments.js";

/** Dhan feed response codes. */
export const DHAN_FEED_CODE = {
  INDEX: 1,
  TICKER: 2,
  QUOTE: 4,
  OI: 5,
  PREV_CLOSE: 6,
  MARKET_STATUS: 7,
  FULL: 8,
  DISCONNECT: 50,
} as const;

/** Fixed packet sizes, used to reject truncated packets before reading them. */
export const DHAN_HEADER_BYTES = 8;
const TICKER_BYTES = 16;
const QUOTE_BYTES = 50;
const OI_BYTES = 12;
const PREV_CLOSE_BYTES = 16;
const FULL_BYTES = 162;
/** 5 levels × (bidQty4 + askQty4 + bidOrders2 + askOrders2 + bidPrice4 + askPrice4). */
const DEPTH_LEVEL_BYTES = 20;
const DEPTH_LEVELS = 5;

export interface DhanDepthLevel {
  price: number;
  qty: number;
  orders: number;
}

/**
 * One decoded packet, normalized but NOT yet merged into a quote.
 *
 * Fields are optional because Dhan's packet types are genuinely partial: a Ticker
 * carries only an LTP, an OI packet only open interest. Merging is the feed's job
 * (see feed.ts), not the decoder's — the decoder must never invent a field the wire
 * did not contain.
 */
export interface DhanFeedPacket {
  code: number;
  segment: DhanExchangeSegment | null;
  segmentCode: number;
  securityId: number;
  last_price?: number;
  last_quantity?: number;
  /**
   * Dhan's Last Trade Time (epoch ms), when present.
   *
   * DELIBERATELY NOT an order-book publication timestamp. It says when the last
   * TRADE printed, which for an illiquid option can be minutes before the current
   * book. The Box engine's cross-leg temporal-coherence check needs a book
   * timestamp, so this must never be fed to it as one — see `exchange_at` in
   * toTick(), which is always null.
   */
  last_trade_time?: number;
  average_price?: number;
  volume?: number;
  total_buy_quantity?: number;
  total_sell_quantity?: number;
  oi?: number;
  oi_day_high?: number;
  oi_day_low?: number;
  open?: number;
  close?: number;
  high?: number;
  low?: number;
  prev_close?: number;
  prev_oi?: number;
  bids?: DhanDepthLevel[];
  asks?: DhanDepthLevel[];
  /** Set for a server-disconnect packet so the caller can log the real reason. */
  disconnect_code?: number;
}

export interface DhanDecodeResult {
  packets: DhanFeedPacket[];
  /**
   * Packets that could not be decoded, with why.
   *
   * Surfaced rather than swallowed: a steady trickle of these means the wire format
   * has changed, and silently dropping them would present as a feed that is subtly
   * missing instruments instead of an obvious error.
   */
  errors: string[];
}

/**
 * Decode one binary frame into zero or more packets.
 *
 * Never throws. A malformed frame yields whatever prefix was valid plus an error
 * string, because a decoder that throws would take down the socket handler on a
 * single bad byte and lose the healthy packets in the same frame.
 */
export function decodeDhanFeed(buffer: ArrayBuffer): DhanDecodeResult {
  const packets: DhanFeedPacket[] = [];
  const errors: string[] = [];
  const view = new DataView(buffer);
  const total = view.byteLength;

  // A heartbeat/empty frame is not an error.
  if (total === 0) return { packets, errors };
  if (total < DHAN_HEADER_BYTES) {
    return { packets, errors: [`frame shorter than the 8-byte header (${total} bytes)`] };
  }

  let offset = 0;
  let guard = 0;
  while (offset + DHAN_HEADER_BYTES <= total) {
    // A declared length of 0 would loop forever; bound the walk regardless.
    if (++guard > 10_000) {
      errors.push("aborted decoding: implausible packet count in one frame");
      break;
    }
    const code = view.getUint8(offset);
    const declaredLength = view.getInt16(offset + 1, true);
    const segmentCode = view.getUint8(offset + 3);
    const securityId = view.getInt32(offset + 4, true);

    // A non-positive length is unrecoverable: we cannot know where the next packet
    // starts, so stop rather than guess and mis-frame everything after it.
    if (declaredLength <= 0) {
      errors.push(`packet at offset ${offset} declared a non-positive length (${declaredLength})`);
      break;
    }
    if (offset + declaredLength > total) {
      errors.push(
        `truncated packet at offset ${offset}: declared ${declaredLength} bytes, ${total - offset} available`,
      );
      break;
    }

    const base: DhanFeedPacket = {
      code,
      segment: dhanSegmentFromCode(segmentCode),
      segmentCode,
      securityId,
    };

    try {
      switch (code) {
        case DHAN_FEED_CODE.TICKER:
        case DHAN_FEED_CODE.INDEX: {
          // An index packet uses the ticker layout.
          if (declaredLength < TICKER_BYTES) {
            errors.push(`ticker packet too short (${declaredLength} < ${TICKER_BYTES})`);
            break;
          }
          base.last_price = view.getFloat32(offset + 8, true);
          // `exactOptionalPropertyTypes` forbids assigning `undefined` to an
          // optional property, and "absent" must stay absent rather than become 0.
          {
            const ltt = readEpochSeconds(view, offset + 12);
            if (ltt !== undefined) base.last_trade_time = ltt;
          }
          packets.push(base);
          break;
        }
        case DHAN_FEED_CODE.QUOTE: {
          if (declaredLength < QUOTE_BYTES) {
            errors.push(`quote packet too short (${declaredLength} < ${QUOTE_BYTES})`);
            break;
          }
          readQuoteCore(view, offset, base);
          // A Quote packet ends with the day's OHLC. A Full packet has the same
          // core but inserts three OI fields first, so its OHLC sits 12 bytes later
          // — that shift is exactly the kind of thing a fixed offset gets wrong.
          base.open = view.getFloat32(offset + 34, true);
          base.close = view.getFloat32(offset + 38, true);
          base.high = view.getFloat32(offset + 42, true);
          base.low = view.getFloat32(offset + 46, true);
          packets.push(base);
          break;
        }
        case DHAN_FEED_CODE.OI: {
          if (declaredLength < OI_BYTES) {
            errors.push(`OI packet too short (${declaredLength} < ${OI_BYTES})`);
            break;
          }
          base.oi = view.getInt32(offset + 8, true);
          packets.push(base);
          break;
        }
        case DHAN_FEED_CODE.PREV_CLOSE: {
          if (declaredLength < PREV_CLOSE_BYTES) {
            errors.push(`prev-close packet too short (${declaredLength} < ${PREV_CLOSE_BYTES})`);
            break;
          }
          base.prev_close = view.getFloat32(offset + 8, true);
          base.prev_oi = view.getInt32(offset + 12, true);
          packets.push(base);
          break;
        }
        case DHAN_FEED_CODE.FULL: {
          if (declaredLength < FULL_BYTES) {
            errors.push(`full packet too short (${declaredLength} < ${FULL_BYTES})`);
            break;
          }
          readQuoteCore(view, offset, base);
          base.oi = view.getInt32(offset + 34, true);
          base.oi_day_high = view.getInt32(offset + 38, true);
          base.oi_day_low = view.getInt32(offset + 42, true);
          base.open = view.getFloat32(offset + 46, true);
          base.close = view.getFloat32(offset + 50, true);
          base.high = view.getFloat32(offset + 54, true);
          base.low = view.getFloat32(offset + 58, true);
          const { bids, asks } = readDepth(view, offset + 62);
          base.bids = bids;
          base.asks = asks;
          packets.push(base);
          break;
        }
        case DHAN_FEED_CODE.MARKET_STATUS: {
          // No per-instrument payload we consume; recorded so callers can observe it.
          packets.push(base);
          break;
        }
        case DHAN_FEED_CODE.DISCONNECT: {
          base.disconnect_code =
            declaredLength >= 10 ? view.getInt16(offset + 8, true) : 0;
          packets.push(base);
          break;
        }
        default: {
          // An unknown code is skipped by its declared length, so one new packet
          // type from Dhan cannot break the packets around it.
          errors.push(`unknown Dhan feed response code ${code} (${declaredLength} bytes)`);
          break;
        }
      }
    } catch (err) {
      errors.push(
        `failed to decode code ${code} at offset ${offset}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    offset += declaredLength;
  }

  return { packets, errors };
}

/**
 * The 54-byte core shared by Quote and Full packets (header + 46 bytes of fields).
 * Offsets are relative to the packet start.
 */
function readQuoteCore(view: DataView, offset: number, out: DhanFeedPacket): void {
  out.last_price = view.getFloat32(offset + 8, true);
  out.last_quantity = view.getInt16(offset + 12, true);
  const ltt = readEpochSeconds(view, offset + 14);
  if (ltt !== undefined) out.last_trade_time = ltt;
  out.average_price = view.getFloat32(offset + 18, true);
  out.volume = view.getInt32(offset + 22, true);
  out.total_sell_quantity = view.getInt32(offset + 26, true);
  out.total_buy_quantity = view.getInt32(offset + 30, true);
}

/**
 * Five levels of bid/ask depth.
 *
 * Each 20-byte level interleaves both sides:
 *   int32 bidQty, int32 askQty, int16 bidOrders, int16 askOrders,
 *   float32 bidPrice, float32 askPrice
 *
 * Zero-priced levels are DROPPED rather than kept as 0: an empty level means "no
 * liquidity here", and a ₹0 bid would look like an executable price to the Box
 * liquidity check.
 */
function readDepth(view: DataView, start: number): { bids: DhanDepthLevel[]; asks: DhanDepthLevel[] } {
  const bids: DhanDepthLevel[] = [];
  const asks: DhanDepthLevel[] = [];
  for (let i = 0; i < DEPTH_LEVELS; i++) {
    const at = start + i * DEPTH_LEVEL_BYTES;
    if (at + DEPTH_LEVEL_BYTES > view.byteLength) break;
    const bidQty = view.getInt32(at, true);
    const askQty = view.getInt32(at + 4, true);
    const bidOrders = view.getInt16(at + 8, true);
    const askOrders = view.getInt16(at + 10, true);
    const bidPrice = view.getFloat32(at + 12, true);
    const askPrice = view.getFloat32(at + 16, true);
    if (bidPrice > 0) bids.push({ price: bidPrice, qty: Math.max(0, bidQty), orders: Math.max(0, bidOrders) });
    if (askPrice > 0) asks.push({ price: askPrice, qty: Math.max(0, askQty), orders: Math.max(0, askOrders) });
  }
  return { bids, asks };
}

/** Epoch SECONDS → ms. 0 means "absent" and stays absent (undefined). */
function readEpochSeconds(view: DataView, at: number): number | undefined {
  const seconds = view.getInt32(at, true);
  return seconds > 0 ? seconds * 1000 : undefined;
}
