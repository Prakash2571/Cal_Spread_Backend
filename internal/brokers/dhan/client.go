package dhan

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"regexp"
	"strings"
)

// Client is DhanClient without the order endpoints (place/modify/cancel, the order
// book, order by id / by correlation id) and without the trade book: the Go service
// places no orders. Reads go through HTTP.Read (bounded retries).
//
// Responses keep Dhan's own field names. Their fields are Values, so an odd shape never
// fails a decode and consumers apply the same typeof/Number() reads the Node code does.
type Client struct {
	http     *HTTP
	clientID func() string
}

// NewClient is `new DhanClient(http, clientId)`.
func NewClient(h *HTTP, clientID func() string) *Client {
	if clientID == nil {
		clientID = func() string { return "" }
	}
	return &Client{http: h, clientID: clientID}
}

// APIRoot is the REST root, for logs and diagnostics only.
func (c *Client) APIRoot() string { return c.http.APIRoot() }

/* --------------------------------- account -------------------------------- */

// Profile is GET /profile (also the cheapest session health probe).
type Profile struct {
	DhanClientID  Value `json:"dhanClientId"`
	TokenValidity Value `json:"tokenValidity"`
	ActiveSegment Value `json:"activeSegment"`
	DDPI          Value `json:"ddpi"`
	MTF           Value `json:"mtf"`
	DataPlan      Value `json:"dataPlan"`
	DataValidity  Value `json:"dataValidity"`
}

// FundLimit is GET /fundlimit (`availabelBalance` is Dhan's spelling).
type FundLimit struct {
	DhanClientID        Value `json:"dhanClientId"`
	AvailabelBalance    Value `json:"availabelBalance"`
	SodLimit            Value `json:"sodLimit"`
	CollateralAmount    Value `json:"collateralAmount"`
	ReceiveableAmount   Value `json:"receiveableAmount"`
	UtilizedAmount      Value `json:"utilizedAmount"`
	BlockedPayoutAmount Value `json:"blockedPayoutAmount"`
	WithdrawableBalance Value `json:"withdrawableBalance"`
}

// GetProfile is getProfile.
func (c *Client) GetProfile(ctx context.Context) (Profile, error) {
	var out Profile
	return out, c.read(ctx, RequestOptions{Path: "/profile"}, &out)
}

// GetFundLimit is getFundLimit.
func (c *Client) GetFundLimit(ctx context.Context) (FundLimit, error) {
	var out FundLimit
	return out, c.read(ctx, RequestOptions{Path: "/fundlimit"}, &out)
}

/* -------------------------------- portfolio ------------------------------- */

// Position is one row of GET /positions.
type Position struct {
	DhanClientID     Value `json:"dhanClientId"`
	TradingSymbol    Value `json:"tradingSymbol"`
	SecurityID       Value `json:"securityId"`
	PositionType     Value `json:"positionType"`
	ExchangeSegment  Value `json:"exchangeSegment"`
	ProductType      Value `json:"productType"`
	BuyAvg           Value `json:"buyAvg"`
	BuyQty           Value `json:"buyQty"`
	SellAvg          Value `json:"sellAvg"`
	SellQty          Value `json:"sellQty"`
	NetQty           Value `json:"netQty"`
	RealizedProfit   Value `json:"realizedProfit"`
	UnrealizedProfit Value `json:"unrealizedProfit"`
	CostPrice        Value `json:"costPrice"`
	Multiplier       Value `json:"multiplier"`
	DrvExpiryDate    Value `json:"drvExpiryDate"`
	DrvOptionType    Value `json:"drvOptionType"`
	DrvStrikePrice   Value `json:"drvStrikePrice"`
}

// ListPositions is listPositions (bare array or {data: [...]}).
func (c *Client) ListPositions(ctx context.Context) ([]Position, error) {
	raw, err := c.http.Read(ctx, RequestOptions{Path: "/positions"})
	if err != nil {
		return nil, err
	}
	rows := unwrapArray(raw)
	out := make([]Position, len(rows))
	for i, r := range rows {
		r.Decode(&out[i])
	}
	return out, nil
}

/* --------------------------------- margin --------------------------------- */

// MarginLeg is one order leg of a margin request (DhanMultiMarginLeg), in the field
// order the registry builds it.
type MarginLeg struct {
	ExchangeSegment Segment  `json:"exchangeSegment"`
	TransactionType string   `json:"transactionType"` // BUY | SELL
	Quantity        float64  `json:"quantity"`
	ProductType     string   `json:"productType"` // CNC, INTRADAY, MARGIN, MTF, CO, BO
	SecurityID      string   `json:"securityId"`
	Price           float64  `json:"price"`
	TriggerPrice    *float64 `json:"triggerPrice,omitempty"`
}

// singleMarginBody is `{...leg, dhanClientId}`.
type singleMarginBody struct {
	MarginLeg
	DhanClientID string `json:"dhanClientId"`
}

// MultiMarginRequest is the wire body of POST /margincalculator/multi. The legs MUST
// be named scripList and the client id belongs at the top level only.
type MultiMarginRequest struct {
	DhanClientID    string      `json:"dhanClientId"`
	IncludePosition bool        `json:"includePosition"`
	IncludeOrder    bool        `json:"includeOrder"`
	ScripList       []MarginLeg `json:"scripList"`
}

// MultiMarginOptions are the netting flags (both default false).
type MultiMarginOptions struct {
	IncludePosition bool
	IncludeOrder    bool
}

// MarginResponse is POST /margincalculator (the per-leg fallback).
type MarginResponse struct {
	TotalMargin         Value `json:"totalMargin"`
	SpanMargin          Value `json:"spanMargin"`
	ExposureMargin      Value `json:"exposureMargin"`
	AvailableBalance    Value `json:"availableBalance"`
	VariableMargin      Value `json:"variableMargin"`
	InsufficientBalance Value `json:"insufficientBalance"`
	Brokerage           Value `json:"brokerage"`
	Leverage            Value `json:"leverage"`
}

// CalculateMargin is calculateMargin: margin for ONE leg (fallback only).
func (c *Client) CalculateMargin(ctx context.Context, leg MarginLeg) (MarginResponse, error) {
	var out MarginResponse
	body := singleMarginBody{MarginLeg: leg, DhanClientID: c.clientID()}
	return out, c.read(ctx, RequestOptions{Method: http.MethodPost, Path: "/margincalculator", Body: body}, &out)
}

// CalculateMultiMargin is calculateMultiMargin: the hedge-aware basket margin. The
// raw payload is returned for NormalizeMultiMargin / DescribeMarginPayload.
func (c *Client) CalculateMultiMargin(ctx context.Context, legs []MarginLeg, opts MultiMarginOptions) (Value, error) {
	if legs == nil {
		legs = []MarginLeg{}
	}
	body := MultiMarginRequest{
		DhanClientID:    c.clientID(),
		IncludePosition: opts.IncludePosition,
		IncludeOrder:    opts.IncludeOrder,
		ScripList:       legs,
	}
	return c.readValue(ctx, RequestOptions{Method: http.MethodPost, Path: "/margincalculator/multi", Body: body})
}

// NormalizedMargin is NormalizedDhanMargin.
type NormalizedMargin struct {
	Total               float64  `json:"total"`
	Span                *float64 `json:"span"`
	Exposure            *float64 `json:"exposure"`
	FoMargin            *float64 `json:"foMargin"`
	HedgeBenefit        *float64 `json:"hedgeBenefit"`
	AvailableBalance    *float64 `json:"availableBalance"`
	InsufficientBalance *float64 `json:"insufficientBalance"`
}

// pickNumber is the first key whose value is finite under typeof-number-or-Number()
// (so null and "" read as 0, as in Node), or nil.
func pickNumber(source Value, keys ...string) *float64 {
	for _, k := range keys {
		raw := source.Get(k)
		n, ok := raw.Num()
		if !ok {
			n = raw.ToNumber()
		}
		if !math.IsNaN(n) && !math.IsInf(n, 0) {
			return &n
		}
	}
	return nil
}

// NormalizeMultiMargin is normalizeDhanMultiMargin: nil when no positive combined total
// can be read (the caller then falls back to the per-leg sum rather than record ₹0).
// A `data` wrapper is unwrapped.
func NormalizeMultiMargin(res Value) *NormalizedMargin {
	if !res.IsObjectLike() {
		return nil
	}
	body := res.Get("data")
	if body.IsNullish() {
		body = res
	}
	total := pickNumber(body, "totalMargin", "totalMarginRequired", "total_margin")
	if total == nil || !(*total > 0) {
		return nil
	}
	return &NormalizedMargin{
		Total:               *total,
		Span:                pickNumber(body, "spanMargin", "span_margin"),
		Exposure:            pickNumber(body, "exposureMargin", "exposure_margin"),
		FoMargin:            pickNumber(body, "foMargin", "fo_margin"),
		HedgeBenefit:        pickNumber(body, "marginBenefit", "margin_benefit", "hedgeBenefit", "hedge_benefit"),
		AvailableBalance:    pickNumber(body, "availableBalance", "available_balance"),
		InsufficientBalance: pickNumber(body, "insufficientBalance", "insufficient_balance"),
	}
}

// DescribeMarginPayload is describeDhanMarginPayload: the top-level field NAMES of
// `data ?? res` (never values, which carry balances).
func DescribeMarginPayload(res Value) string {
	switch res.Kind() {
	case KindUndefined:
		return "undefined"
	case KindNull:
		return "null"
	case KindBool:
		return "<boolean>"
	case KindNumber:
		return "<number>"
	case KindString:
		return "<string>"
	}
	body := res.Get("data")
	if body.IsNullish() {
		body = res
	}
	if !body.IsObjectLike() {
		return "<non-object data>"
	}
	keys := body.Keys()
	if len(keys) == 0 {
		return "<no fields>"
	}
	return strings.Join(keys, ", ")
}

/* --------------------------------- static IP ------------------------------- */

// GetStaticIP is getStaticIp: GET /ip/getIP, returned raw for ExtractIPv4Addresses.
func (c *Client) GetStaticIP(ctx context.Context) (Value, error) {
	return c.readValue(ctx, RequestOptions{Path: "/ip/getIP"})
}

var ipv4Re = regexp.MustCompile(`^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$`)

// ExtractIPv4Addresses is extractIpv4Addresses: every strict dotted-quad string
// anywhere in the payload (depth-bounded at 6), trimmed, skipping "" and "NA",
// de-duplicated, in JavaScript traversal order.
func ExtractIPv4Addresses(payload Value) []string {
	found := []string{}
	seen := map[string]bool{}
	var walk func(node Value, depth int)
	walk = func(node Value, depth int) {
		if depth > 6 || node.IsNullish() {
			return
		}
		switch node.Kind() {
		case KindString:
			s, _ := node.Str()
			v := jsTrim(s)
			if v == "" || asciiEqualFold(v, "NA") {
				return
			}
			if ipv4Re.MatchString(v) && !seen[v] {
				seen[v] = true
				found = append(found, v)
			}
		case KindArray, KindObject:
			for _, child := range node.Values() {
				walk(child, depth+1)
			}
		}
	}
	walk(payload, 0)
	return found
}

/* --------------------------------- quotes --------------------------------- */

// MarketFeedRequest is segment → numeric security ids. JSON keys are written sorted
// (Node writes them in insertion order; callers send one segment per request).
type MarketFeedRequest map[Segment][]int64

// QuoteDepthLevel is one depth level of a REST quote.
type QuoteDepthLevel struct {
	Quantity Value `json:"quantity"`
	Orders   Value `json:"orders"`
	Price    Value `json:"price"`
}

// QuoteOHLC is the day's OHLC of a REST quote.
type QuoteOHLC struct {
	Open  Value `json:"open"`
	Close Value `json:"close"`
	High  Value `json:"high"`
	Low   Value `json:"low"`
}

// QuoteDepth is the 5-level book of a REST quote.
type QuoteDepth struct {
	Buy  []QuoteDepthLevel `json:"buy"`
	Sell []QuoteDepthLevel `json:"sell"`
}

// QuoteEntry is one instrument of POST /marketfeed/quote (or /ltp).
type QuoteEntry struct {
	LastPrice     Value       `json:"last_price"`
	LastQuantity  Value       `json:"last_quantity"`
	LastTradeTime Value       `json:"last_trade_time"`
	AveragePrice  Value       `json:"average_price"`
	Volume        Value       `json:"volume"`
	BuyQuantity   Value       `json:"buy_quantity"`
	SellQuantity  Value       `json:"sell_quantity"`
	OI            Value       `json:"oi"`
	NetChange     Value       `json:"net_change"`
	OHLC          *QuoteOHLC  `json:"ohlc"`
	Depth         *QuoteDepth `json:"depth"`
}

// MarketFeedResponse is `{status, data: {<SEG>: {"<secId>": entry}}}`.
type MarketFeedResponse struct {
	Status Value `json:"status"`
	Data   Value `json:"data"`
}

// MarketFeedEntry is one [securityId, entry] pair of Object.entries(data[segment]).
type MarketFeedEntry struct {
	SecurityID string
	Quote      QuoteEntry
}

// Entries is `Object.entries(res.data?.[segment] ?? {})` decoded into QuoteEntry, in
// JavaScript key order (numeric security ids ascending).
func (r MarketFeedResponse) Entries(segment Segment) []MarketFeedEntry {
	book := r.Data.Get(string(segment))
	if !book.IsObjectLike() {
		return nil
	}
	keys := book.Keys()
	vals := book.Values()
	out := make([]MarketFeedEntry, len(keys))
	for i, k := range keys {
		out[i].SecurityID = k
		vals[i].Decode(&out[i].Quote)
	}
	return out
}

// MarketFeedQuote is marketFeedQuote: full quote incl. 5-level depth and OI.
func (c *Client) MarketFeedQuote(ctx context.Context, req MarketFeedRequest) (MarketFeedResponse, error) {
	var out MarketFeedResponse
	return out, c.read(ctx, RequestOptions{Method: http.MethodPost, Path: "/marketfeed/quote", Body: req, WithClientID: true}, &out)
}

// MarketFeedLTP is marketFeedLtp.
func (c *Client) MarketFeedLTP(ctx context.Context, req MarketFeedRequest) (MarketFeedResponse, error) {
	var out MarketFeedResponse
	return out, c.read(ctx, RequestOptions{Method: http.MethodPost, Path: "/marketfeed/ltp", Body: req, WithClientID: true}, &out)
}

/* --------------------------------- charts --------------------------------- */

// Candles are Dhan's COLUMN-wise candles (timestamps are epoch SECONDS).
type Candles struct {
	Open         []Value `json:"open"`
	High         []Value `json:"high"`
	Low          []Value `json:"low"`
	Close        []Value `json:"close"`
	Volume       []Value `json:"volume"`
	Timestamp    []Value `json:"timestamp"`
	OpenInterest []Value `json:"open_interest"`
}

// HistoricalRequest is POST /charts/historical (dates YYYY-MM-DD).
type HistoricalRequest struct {
	SecurityID      string  `json:"securityId"`
	ExchangeSegment Segment `json:"exchangeSegment"`
	Instrument      string  `json:"instrument"`
	ExpiryCode      *int    `json:"expiryCode,omitempty"`
	OI              *bool   `json:"oi,omitempty"`
	FromDate        string  `json:"fromDate"`
	ToDate          string  `json:"toDate"`
}

// IntradayRequest is POST /charts/intraday; Interval is "1", "5", "15", "25" or "60".
type IntradayRequest struct {
	SecurityID      string  `json:"securityId"`
	ExchangeSegment Segment `json:"exchangeSegment"`
	Instrument      string  `json:"instrument"`
	Interval        string  `json:"interval"`
	ExpiryCode      *int    `json:"expiryCode,omitempty"`
	OI              *bool   `json:"oi,omitempty"`
	FromDate        string  `json:"fromDate"`
	ToDate          string  `json:"toDate"`
}

// HistoricalCandles is historicalCandles (daily).
func (c *Client) HistoricalCandles(ctx context.Context, req HistoricalRequest) (Candles, error) {
	var out Candles
	return out, c.read(ctx, RequestOptions{Method: http.MethodPost, Path: "/charts/historical", Body: req}, &out)
}

// IntradayCandles is intradayCandles.
func (c *Client) IntradayCandles(ctx context.Context, req IntradayRequest) (Candles, error) {
	var out Candles
	return out, c.read(ctx, RequestOptions{Method: http.MethodPost, Path: "/charts/intraday", Body: req}, &out)
}

/* ------------------------------ option chain ------------------------------ */

// OptionChainRequest is POST /optionchain.
type OptionChainRequest struct {
	UnderlyingScrip int64   `json:"UnderlyingScrip"`
	UnderlyingSeg   Segment `json:"UnderlyingSeg"`
	Expiry          string  `json:"Expiry"`
}

// OptionChain is optionChain; the response ({status, data: {last_price, oc}}) is raw.
func (c *Client) OptionChain(ctx context.Context, req OptionChainRequest) (Value, error) {
	return c.readValue(ctx, RequestOptions{Method: http.MethodPost, Path: "/optionchain", Body: req})
}

type expiryListRequest struct {
	UnderlyingScrip int64   `json:"UnderlyingScrip"`
	UnderlyingSeg   Segment `json:"UnderlyingSeg"`
}

// ExpiryList is expiryList (bare array or {data: [...]}).
func (c *Client) ExpiryList(ctx context.Context, underlyingScrip int64, underlyingSeg Segment) ([]Value, error) {
	raw, err := c.http.Read(ctx, RequestOptions{
		Method: http.MethodPost, Path: "/optionchain/expirylist",
		Body: expiryListRequest{UnderlyingScrip: underlyingScrip, UnderlyingSeg: underlyingSeg},
	})
	if err != nil {
		return nil, err
	}
	return unwrapArray(raw), nil
}

/* --------------------------------- helpers -------------------------------- */

func (c *Client) read(ctx context.Context, opts RequestOptions, out any) error {
	raw, err := c.http.Read(ctx, opts)
	if err != nil {
		return err
	}
	decodeLoose(raw, out)
	return nil
}

func (c *Client) readValue(ctx context.Context, opts RequestOptions) (Value, error) {
	raw, err := c.http.Read(ctx, opts)
	if err != nil {
		return Value{}, err
	}
	v, err := ParseJSON(raw)
	if err != nil {
		return Value{}, err
	}
	return v, nil
}

// unwrapArray accepts a bare array or {data: [...]}; anything else is empty.
func unwrapArray(raw json.RawMessage) []Value {
	v, err := ParseJSON(raw)
	if err != nil {
		return []Value{}
	}
	if v.IsArray() {
		return v.Array()
	}
	if d := v.Get("data"); d.IsArray() {
		return d.Array()
	}
	return []Value{}
}
