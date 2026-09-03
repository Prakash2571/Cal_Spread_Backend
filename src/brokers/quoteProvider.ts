/**
 * Broker-neutral REST quotes, keyed by internal instrument token.
 *
 * `/api/quotes` called `kite.getQuoteFull()` directly, so with Dhan active it both
 * demanded a Zerodha session (401) and, had it got one, would have looked up Kite
 * tokens that mean nothing to Dhan. This provider takes tokens in the ACTIVE broker's
 * namespace and returns the same `Tick` shape the frontend already consumes, so the
 * endpoint needs no broker branch and the browser needs no second endpoint.
 */

import type { Instrument, KiteClient } from "../kite.js";
import type { Tick } from "../ticker.js";
import type { DhanClient } from "./dhan/client.js";
import type { DhanInstrument, DhanInstrumentStore } from "./dhan/instruments.js";
import type { DhanExchangeSegment } from "./dhan/segments.js";
import type { BrokerId } from "./types.js";

export interface QuoteProviderDeps {
  activeBroker: () => BrokerId;
  kite: KiteClient;
  dhan: DhanClient;
  dhanInstruments: DhanInstrumentStore;
  /** The ACTIVE broker's instrument universe, for token → identifier resolution. */
  instruments: () => Promise<Instrument[]>;
}

export class QuoteProvider {
  constructor(private deps: QuoteProviderDeps) {}

  /**
   * Snapshot quotes for internal tokens.
   *
   * Returns whatever could be resolved rather than failing the batch: a board request
   * covers hundreds of tokens and one unknown instrument must not blank the page.
   */
  async quotesByToken(tokens: number[]): Promise<Tick[]> {
    if (tokens.length === 0) return [];
    return this.deps.activeBroker() === "dhan"
      ? this.dhanQuotes(tokens)
      : this.kiteQuotes(tokens);
  }

  /** Zerodha path — unchanged behaviour, just relocated behind the interface. */
  private async kiteQuotes(tokens: number[]): Promise<Tick[]> {
    const all = await this.deps.instruments();
    const byToken = new Map<number, Instrument>();
    for (const inst of all) byToken.set(inst.instrument_token, inst);

    const identifiers: string[] = [];
    for (const token of tokens) {
      const inst = byToken.get(token);
      if (inst) identifiers.push(`${inst.exchange}:${inst.tradingsymbol}`);
    }
    if (identifiers.length === 0) return [];

    const quotes = await this.deps.kite.getQuoteFull(identifiers);
    return quotes.map((q) => ({
      token: q.instrument_token,
      last_price: q.last_price,
      close_price: q.close,
      oi: q.oi,
      // Kite's /quote does not carry depth; the live feed supplies bid/ask. Reporting
      // 0 is honest here — inventing the LTP as a two-sided price would make an
      // unquoted instrument look executable.
      bid: 0,
      ask: 0,
    }));
  }

  /**
   * Dhan path — `POST /marketfeed/quote`, batched per exchange segment.
   *
   * Dhan groups a request by segment and caps it at 1000 instruments per segment, so
   * tokens are bucketed and chunked. Depth IS available here (unlike Kite's REST
   * quote), so the best bid/ask are carried through and the Box liquidity view gets
   * real two-sided prices from a snapshot rather than only from the socket.
   */
  private async dhanQuotes(tokens: number[]): Promise<Tick[]> {
    await this.deps.dhanInstruments.load().catch(() => undefined);

    const bySegment = new Map<DhanExchangeSegment, number[]>();
    const back = new Map<string, DhanInstrument>();
    for (const token of tokens) {
      const inst = this.deps.dhanInstruments.get(token);
      if (!inst) continue;
      const list = bySegment.get(inst.dhan_segment) ?? [];
      list.push(inst.dhan_security_id);
      bySegment.set(inst.dhan_segment, list);
      back.set(`${inst.dhan_segment}:${inst.dhan_security_id}`, inst);
    }
    if (bySegment.size === 0) return [];

    const out: Tick[] = [];
    for (const [segment, ids] of bySegment) {
      for (let i = 0; i < ids.length; i += 1000) {
        const chunk = ids.slice(i, i + 1000);
        try {
          const res = await this.deps.dhan.marketFeedQuote({ [segment]: chunk });
          const entries = res.data?.[segment] ?? {};
          for (const [securityId, entry] of Object.entries(entries)) {
            const inst = back.get(`${segment}:${Number(securityId)}`);
            if (!inst) continue;
            const bids = entry.depth?.buy ?? [];
            const asks = entry.depth?.sell ?? [];
            out.push({
              // The INTERNAL token, so the browser's tick map keys match the board it
              // was given. Returning Dhan's raw security id here would silently fail
              // to match anything on the page.
              token: inst.instrument_token,
              last_price: Number(entry.last_price) || 0,
              close_price: Number(entry.ohlc?.close) || 0,
              oi: Number(entry.oi) || 0,
              bid: Number(bids[0]?.price) || 0,
              ask: Number(asks[0]?.price) || 0,
              ...(bids.length > 0
                ? {
                    bids: bids
                      .filter((l) => Number(l.price) > 0)
                      .map((l) => ({
                        price: Number(l.price),
                        qty: Number(l.quantity) || 0,
                        orders: Number(l.orders) || 0,
                      })),
                  }
                : {}),
              ...(asks.length > 0
                ? {
                    asks: asks
                      .filter((l) => Number(l.price) > 0)
                      .map((l) => ({
                        price: Number(l.price),
                        qty: Number(l.quantity) || 0,
                        orders: Number(l.orders) || 0,
                      })),
                  }
                : {}),
            });
          }
        } catch (err) {
          console.warn(`[Dhan] REST quote failed for ${segment} (${chunk.length} ids):`, err);
        }
      }
    }
    return out;
  }
}
