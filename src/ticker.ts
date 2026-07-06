/**
 * Minimal Kite Connect v3 WebSocket ("ticker") client.
 *
 * Docs: https://kite.trade/docs/connect/v3/websocket/
 *
 * Uses the global `WebSocket` available in Node 21+ (undici). Connects to
 * wss://ws.kite.trade, subscribes to instrument tokens in "quote" mode, parses
 * the binary tick packets, and hands decoded ticks to a callback.
 */

const WS_ROOT = "wss://ws.kite.trade";

export interface Tick {
  token: number;
  last_price: number;
  close_price: number;
  oi: number; // open interest (F&O only; 0 for spot/index)
  bid: number; // best bid (0 if unavailable)
  ask: number; // best ask (0 if unavailable)
}

export interface TickerHandle {
  close: () => void;
  /** Subscribe to additional instrument tokens on the existing socket. */
  subscribe: (tokens: number[]) => void;
}

interface ConnectOptions {
  apiKey: string;
  accessToken: string;
  tokens: number[];
  onTick: (ticks: Tick[]) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
}

export function connectTicker(opts: ConnectOptions): TickerHandle {
  const url =
    `${WS_ROOT}?api_key=${encodeURIComponent(opts.apiKey)}` +
    `&access_token=${encodeURIComponent(opts.accessToken)}`;

  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  let isOpen = false;
  // Tokens requested before the socket finished opening are queued here and
  // flushed on open.
  let pendingTokens: number[] = [...opts.tokens];

  function sendSubscribe(tokens: number[]) {
    if (tokens.length === 0) return;
    ws.send(JSON.stringify({ a: "subscribe", v: tokens }));
    // "full" mode includes the day's close price AND open interest (oi).
    ws.send(JSON.stringify({ a: "mode", v: ["full", tokens] }));
  }

  ws.onopen = () => {
    isOpen = true;
    sendSubscribe(pendingTokens);
    pendingTokens = [];
  };

  ws.onmessage = (ev: MessageEvent) => {
    const data = ev.data;
    // Text frames are postbacks (order updates / error messages) — ignore.
    if (typeof data === "string") return;
    if (!(data instanceof ArrayBuffer)) return;
    const ticks = parseBinary(data);
    if (ticks.length) opts.onTick(ticks);
  };

  ws.onerror = () => opts.onError?.("Kite WebSocket error.");
  ws.onclose = () => opts.onClose?.();

  return {
    close: () => {
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
    subscribe: (tokens: number[]) => {
      if (isOpen) {
        sendSubscribe(tokens);
      } else {
        pendingTokens.push(...tokens);
      }
    },
  };
}

/**
 * Parse a Kite binary tick message.
 * Layout (big-endian): [int16 numberOfPackets][ for each: int16 length, bytes ].
 * Within a packet: int32 instrument_token, int32 last_price, ... int32 close.
 * Prices for NSE/NFO are in paise → divide by 100.
 */
export function parseBinary(buf: ArrayBuffer): Tick[] {
  const dv = new DataView(buf);
  if (dv.byteLength < 2) return []; // heartbeat (single byte) or empty

  const numPackets = dv.getInt16(0, false);
  let offset = 2;
  const ticks: Tick[] = [];

  for (let p = 0; p < numPackets; p++) {
    if (offset + 2 > dv.byteLength) break;
    const len = dv.getInt16(offset, false);
    offset += 2;
    if (offset + len > dv.byteLength) break;

    // Token MUST be read as UNSIGNED: NFO futures tokens exceed 2^31, and a
    // signed read would make them negative and never match the subscribed token.
    const token = dv.getUint32(offset, false);
    const divisor = priceDivisor(token);
    const lastPrice = dv.getUint32(offset + 4, false) / divisor;

    // "quote"/"full" packets (>= 44 bytes) carry the close price at offset 40.
    let closePrice = 0;
    if (len >= 44) {
      closePrice = dv.getUint32(offset + 40, false) / divisor;
    }

    // "full" packets (>= 184 bytes) carry open interest at offset 48 (a count,
    // not a price, so it is NOT divided) plus 5-level market depth from offset
    // 64: 5 bid packets then 5 ask packets, each 12 bytes (qty, price, ...).
    // Best bid price = offset 68, best ask price = offset 128.
    let oi = 0;
    let bid = 0;
    let ask = 0;
    if (len >= 184) {
      oi = dv.getUint32(offset + 48, false);
      bid = dv.getUint32(offset + 68, false) / divisor;
      ask = dv.getUint32(offset + 128, false) / divisor;
    }

    ticks.push({
      token,
      last_price: lastPrice,
      close_price: closePrice,
      oi,
      bid,
      ask,
    });
    offset += len;
  }

  return ticks;
}

/**
 * Price divisor by segment, derived from the instrument token's low 8 bits.
 * NSE/NFO (and most segments) use 100. Currency segments differ; we only
 * stream NSE equities + NFO futures here, so 100 is correct.
 */
function priceDivisor(token: number): number {
  const segment = token & 0xff;
  // 3 = CDS (currency) → 10^7 ; 7 = BCD → 10^4 ; everything else → 100.
  if (segment === 3) return 10000000;
  if (segment === 7) return 10000;
  return 100;
}
