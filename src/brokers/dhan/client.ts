/**
 * Typed DhanHQ v2 API surface.
 *
 * A thin, honest wrapper: every method maps to one documented endpoint and returns
 * Dhan's own field names. Normalization into Calspread's shapes happens in the
 * adapters (instruments.ts, dhanBrokerAdapter.ts, the history/charge providers), so
 * this file stays a faithful description of the remote API and the translation
 * logic stays testable on its own.
 *
 * Reads go through `http.read` (bounded retries). Order mutations go through
 * `http.write` (exactly one attempt, ever).
 */

import { DhanHttp, DHAN_API_ROOT } from "./http.js";
import type { DhanExchangeSegment } from "./segments.js";

/* --------------------------------- orders --------------------------------- */

/** Dhan's product types. `MARGIN` is the F&O carry-forward product. */
export type DhanProductType = "CNC" | "INTRADAY" | "MARGIN" | "MTF" | "CO" | "BO";
export type DhanOrderType = "LIMIT" | "MARKET" | "STOP_LOSS" | "STOP_LOSS_MARKET";
export type DhanValidity = "DAY" | "IOC";
export type DhanTransactionType = "BUY" | "SELL";

/**
 * Dhan's order lifecycle states.
 *
 * Normalized into Calspread's `BrokerOrderState` by the adapter; kept verbatim here
 * so the mapping table has a typed source rather than bare strings.
 */
export type DhanOrderStatus =
  | "TRANSIT"
  | "PENDING"
  | "TRADED"
  | "PART_TRADED"
  | "CANCELLED"
  | "CLOSED"
  | "REJECTED"
  | "EXPIRED";

export interface DhanPlaceOrderRequest {
  dhanClientId: string;
  /** Our bounded idempotency handle. Dhan caps this well below a Box client id. */
  correlationId: string;
  transactionType: DhanTransactionType;
  exchangeSegment: DhanExchangeSegment;
  productType: DhanProductType;
  orderType: DhanOrderType;
  validity: DhanValidity;
  securityId: string;
  quantity: number;
  disclosedQuantity?: number;
  price: number;
  triggerPrice?: number;
  afterMarketOrder?: boolean;
}

export interface DhanPlaceOrderResponse {
  orderId: string;
  orderStatus: DhanOrderStatus;
}

/** One row of the order book. */
export interface DhanOrder {
  dhanClientId: string;
  orderId: string;
  correlationId?: string | null;
  orderStatus: DhanOrderStatus;
  transactionType: DhanTransactionType;
  exchangeSegment: DhanExchangeSegment;
  productType: DhanProductType;
  orderType: DhanOrderType;
  validity: DhanValidity;
  tradingSymbol: string;
  securityId: string;
  quantity: number;
  disclosedQuantity?: number;
  price: number;
  triggerPrice?: number;
  /** Quantity still working. Dhan omits it on some terminal rows. */
  remainingQuantity?: number;
  averageTradedPrice?: number;
  filledQty?: number;
  omsErrorCode?: string | null;
  omsErrorDescription?: string | null;
  createTime?: string | null;
  updateTime?: string | null;
  exchangeTime?: string | null;
  exchangeOrderId?: string | null;
  legName?: string | null;
}

export interface DhanModifyOrderRequest {
  dhanClientId: string;
  orderId: string;
  orderType: DhanOrderType;
  legName?: string;
  quantity?: number;
  price?: number;
  disclosedQuantity?: number;
  triggerPrice?: number;
  validity?: DhanValidity;
}

/** One executed trade (fill). */
export interface DhanTrade {
  dhanClientId: string;
  orderId: string;
  exchangeOrderId?: string | null;
  exchangeTradeId?: string | null;
  transactionType: DhanTransactionType;
  exchangeSegment: DhanExchangeSegment;
  productType: DhanProductType;
  tradingSymbol: string;
  securityId: string;
  tradedQuantity: number;
  tradedPrice: number;
  createTime?: string | null;
  updateTime?: string | null;
  exchangeTime?: string | null;
}

/* -------------------------------- positions ------------------------------- */

export interface DhanPosition {
  dhanClientId: string;
  tradingSymbol: string;
  securityId: string;
  positionType: "LONG" | "SHORT" | "CLOSED";
  exchangeSegment: DhanExchangeSegment;
  productType: DhanProductType;
  buyAvg: number;
  buyQty: number;
  sellAvg: number;
  sellQty: number;
  netQty: number;
  realizedProfit?: number;
  unrealizedProfit?: number;
  costPrice?: number;
  multiplier?: number;
  drvExpiryDate?: string | null;
  drvOptionType?: string | null;
  drvStrikePrice?: number | null;
}

export interface DhanFundLimit {
  dhanClientId: string;
  availabelBalance: number;
  sodLimit: number;
  collateralAmount: number;
  receiveableAmount: number;
  utilizedAmount: number;
  blockedPayoutAmount: number;
  withdrawableBalance: number;
}

/* --------------------------------- margin --------------------------------- */

export interface DhanMarginRequestLeg {
  dhanClientId: string;
  exchangeSegment: DhanExchangeSegment;
  transactionType: DhanTransactionType;
  quantity: number;
  productType: DhanProductType;
  securityId: string;
  price: number;
  triggerPrice?: number;
}

export interface DhanMarginResponse {
  totalMargin: number;
  spanMargin: number;
  exposureMargin: number;
  availableBalance: number;
  variableMargin: number;
  insufficientBalance: number;
  brokerage: number;
  leverage?: string;
}

/* --------------------------------- quotes --------------------------------- */

/** `POST /marketfeed/quote` request: segment → array of numeric security ids. */
export type DhanMarketFeedRequest = Partial<Record<DhanExchangeSegment, number[]>>;

export interface DhanQuoteDepthLevel {
  quantity: number;
  orders: number;
  price: number;
}

export interface DhanQuoteEntry {
  last_price: number;
  last_quantity?: number;
  last_trade_time?: string;
  average_price?: number;
  volume?: number;
  buy_quantity?: number;
  sell_quantity?: number;
  oi?: number;
  net_change?: number;
  ohlc?: { open: number; close: number; high: number; low: number };
  depth?: { buy: DhanQuoteDepthLevel[]; sell: DhanQuoteDepthLevel[] };
}

/** Response shape: `{ data: { NSE_FNO: { "12345": {...} } } }`. */
export interface DhanMarketFeedResponse {
  status?: string;
  data?: Partial<Record<DhanExchangeSegment, Record<string, DhanQuoteEntry>>>;
}

/* -------------------------------- charts ---------------------------------- */

/**
 * Dhan returns candles COLUMN-WISE (parallel arrays), not row-wise.
 *
 * Worth stating explicitly: it is the opposite of Kite's row-of-arrays layout, and
 * assuming Kite's shape here yields silently transposed data rather than an error.
 */
export interface DhanCandles {
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  /** Epoch SECONDS. */
  timestamp: number[];
  open_interest?: number[];
}

export interface DhanHistoricalRequest {
  securityId: string;
  exchangeSegment: DhanExchangeSegment;
  instrument: string;
  expiryCode?: number;
  oi?: boolean;
  fromDate: string; // YYYY-MM-DD
  toDate: string; // YYYY-MM-DD
}

export interface DhanIntradayRequest extends DhanHistoricalRequest {
  /** Minutes. Dhan supports 1, 5, 15, 25 and 60. */
  interval: string;
}

/* ------------------------------ option chain ------------------------------ */

export interface DhanOptionChainRequest {
  UnderlyingScrip: number;
  UnderlyingSeg: DhanExchangeSegment;
  Expiry: string;
}

export interface DhanOptionGreeks {
  delta?: number;
  theta?: number;
  gamma?: number;
  vega?: number;
}

export interface DhanOptionSide {
  last_price?: number;
  oi?: number;
  previous_oi?: number;
  volume?: number;
  implied_volatility?: number;
  top_bid_price?: number;
  top_bid_quantity?: number;
  top_ask_price?: number;
  top_ask_quantity?: number;
  greeks?: DhanOptionGreeks;
  previous_close_price?: number;
  previous_volume?: number;
}

export interface DhanOptionChainResponse {
  status?: string;
  data?: {
    last_price?: number;
    oc?: Record<string, { ce?: DhanOptionSide; pe?: DhanOptionSide }>;
  };
}

export interface DhanProfile {
  dhanClientId: string;
  tokenValidity?: string;
  activeSegment?: string;
  ddpi?: string;
  mtf?: string;
  dataPlan?: string;
  dataValidity?: string;
}

/* ================================== client ================================ */

export class DhanClient {
  constructor(
    private http: DhanHttp,
    private clientId: () => string,
  ) {}

  /* ---- account ---- */

  /**
   * The user profile.
   *
   * Doubles as the session health probe: it is the cheapest authenticated call, and
   * a 401 from it is the definitive signal that the token has expired.
   */
  getProfile(): Promise<DhanProfile> {
    return this.http.read<DhanProfile>({ path: "/profile" });
  }

  getFundLimit(): Promise<DhanFundLimit> {
    return this.http.read<DhanFundLimit>({ path: "/fundlimit" });
  }

  /* ---- orders ---- */

  /**
   * Place an order. EXACTLY ONE ATTEMPT.
   *
   * On a network/timeout/429 failure the outcome is UNKNOWN: the order may be live
   * at the exchange. The caller MUST reconcile via `getOrderByCorrelationId` and
   * must NEVER call this again with the same correlation id in the hope of a
   * cleaner answer.
   */
  placeOrder(req: DhanPlaceOrderRequest): Promise<DhanPlaceOrderResponse> {
    return this.http.write<DhanPlaceOrderResponse>({ method: "POST", path: "/orders", body: req });
  }

  modifyOrder(req: DhanModifyOrderRequest): Promise<DhanPlaceOrderResponse> {
    return this.http.write<DhanPlaceOrderResponse>({
      method: "PUT",
      path: `/orders/${encodeURIComponent(req.orderId)}`,
      body: req,
    });
  }

  cancelOrder(orderId: string): Promise<DhanPlaceOrderResponse> {
    return this.http.write<DhanPlaceOrderResponse>({
      method: "DELETE",
      path: `/orders/${encodeURIComponent(orderId)}`,
    });
  }

  async listOrders(): Promise<DhanOrder[]> {
    const res = await this.http.read<DhanOrder[] | { data?: DhanOrder[] }>({ path: "/orders" });
    return unwrapArray<DhanOrder>(res);
  }

  async getOrder(orderId: string): Promise<DhanOrder | null> {
    const res = await this.http.read<DhanOrder | DhanOrder[] | { data?: DhanOrder[] }>({
      path: `/orders/${encodeURIComponent(orderId)}`,
    });
    return unwrapFirst<DhanOrder>(res);
  }

  /**
   * Look an order up by OUR correlation id — the reconciliation primitive.
   *
   * This is what makes an ambiguous submission recoverable without risking a
   * duplicate: the correlation id is deterministic from the Box client order id, so
   * after any uncertain POST we can ask Dhan whether that exact intent exists.
   *
   * Returns null when Dhan reports no such order, which is the "the submission
   * genuinely never landed" answer.
   */
  async getOrderByCorrelationId(correlationId: string): Promise<DhanOrder | null> {
    try {
      const res = await this.http.read<DhanOrder | DhanOrder[] | { data?: DhanOrder[] }>({
        path: `/orders/external/${encodeURIComponent(correlationId)}`,
      });
      return unwrapFirst<DhanOrder>(res);
    } catch (err) {
      // A 404 here is a real answer ("no such order"), not a failure to get one.
      if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 404) {
        return null;
      }
      throw err;
    }
  }

  async listTrades(): Promise<DhanTrade[]> {
    const res = await this.http.read<DhanTrade[] | { data?: DhanTrade[] }>({ path: "/trades" });
    return unwrapArray<DhanTrade>(res);
  }

  /** The fills of one order — the authoritative per-fill record. */
  async getTradesForOrder(orderId: string): Promise<DhanTrade[]> {
    const res = await this.http.read<DhanTrade[] | { data?: DhanTrade[] }>({
      path: `/trades/${encodeURIComponent(orderId)}`,
    });
    return unwrapArray<DhanTrade>(res);
  }

  /* ---- portfolio ---- */

  async listPositions(): Promise<DhanPosition[]> {
    const res = await this.http.read<DhanPosition[] | { data?: DhanPosition[] }>({
      path: "/positions",
    });
    return unwrapArray<DhanPosition>(res);
  }

  /* ---- margin ---- */

  /** Margin for ONE order leg. */
  calculateMargin(leg: Omit<DhanMarginRequestLeg, "dhanClientId">): Promise<DhanMarginResponse> {
    return this.http.read<DhanMarginResponse>({
      method: "POST",
      path: "/margincalculator",
      body: { ...leg, dhanClientId: this.clientId() },
    });
  }

  /* ---- market data ---- */

  /** Full quote incl. 5-level depth and OI. */
  marketFeedQuote(req: DhanMarketFeedRequest): Promise<DhanMarketFeedResponse> {
    return this.http.read<DhanMarketFeedResponse>({
      method: "POST",
      path: "/marketfeed/quote",
      body: req,
      withClientId: true,
    });
  }

  marketFeedLtp(req: DhanMarketFeedRequest): Promise<DhanMarketFeedResponse> {
    return this.http.read<DhanMarketFeedResponse>({
      method: "POST",
      path: "/marketfeed/ltp",
      body: req,
      withClientId: true,
    });
  }

  /* ---- charts ---- */

  /** Daily candles. */
  historicalCandles(req: DhanHistoricalRequest): Promise<DhanCandles> {
    return this.http.read<DhanCandles>({
      method: "POST",
      path: "/charts/historical",
      body: req,
    });
  }

  /** Intraday candles (1, 5, 15, 25 or 60 minute). */
  intradayCandles(req: DhanIntradayRequest): Promise<DhanCandles> {
    return this.http.read<DhanCandles>({
      method: "POST",
      path: "/charts/intraday",
      body: req,
    });
  }

  /* ---- option chain ---- */

  optionChain(req: DhanOptionChainRequest): Promise<DhanOptionChainResponse> {
    return this.http.read<DhanOptionChainResponse>({
      method: "POST",
      path: "/optionchain",
      body: req,
    });
  }

  async expiryList(underlyingScrip: number, underlyingSeg: DhanExchangeSegment): Promise<string[]> {
    const res = await this.http.read<{ data?: string[] } | string[]>({
      method: "POST",
      path: "/optionchain/expirylist",
      body: { UnderlyingScrip: underlyingScrip, UnderlyingSeg: underlyingSeg },
    });
    return unwrapArray<string>(res);
  }

  /** The REST root, exposed for logging/diagnostics only. */
  get apiRoot(): string {
    return DHAN_API_ROOT;
  }
}

/**
 * Dhan is inconsistent about whether a list arrives bare or wrapped in `data`.
 * Accepting both is not laziness — it is what stops a wrapper change from
 * presenting as "no orders exist", which on the reconciliation path would be
 * read as "the order never landed".
 */
function unwrapArray<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  const data = (res as { data?: unknown } | null)?.data;
  if (Array.isArray(data)) return data as T[];
  return [];
}

function unwrapFirst<T>(res: unknown): T | null {
  if (Array.isArray(res)) return (res[0] as T) ?? null;
  const data = (res as { data?: unknown } | null)?.data;
  if (Array.isArray(data)) return (data[0] as T) ?? null;
  if (res && typeof res === "object" && "orderId" in (res as object)) return res as T;
  return null;
}
