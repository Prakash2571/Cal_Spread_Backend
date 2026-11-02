// Package kite is the Zerodha Kite Connect v3 integration: the REST client (src/kite.ts),
// the lane-scoped market-data socket (src/brokers/zerodha/feed.ts, lanefeed.go) and, in
// the ticker sub-package, the WebSocket ticker and its binary decoder (src/ticker.ts).
//
// It places no orders. Every URL is injectable (Config), so tests run against httptest
// servers and never contact api.kite.trade, kite.zerodha.com or ws.kite.trade.
package kite

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

const (
	// DefaultAPIRoot is kite.ts KITE_API_ROOT.
	DefaultAPIRoot = "https://api.kite.trade"
	// DefaultLoginRoot is kite.ts KITE_LOGIN_ROOT.
	DefaultLoginRoot = "https://kite.zerodha.com/connect/login"
	// QuoteChunk is how many identifiers one /quote request carries.
	QuoteChunk = 500

	notAuthenticated   = "Not authenticated. Complete the Zerodha login flow first (/login)."
	instrumentsNoLogin = "Zerodha would not serve the instruments list without a session. " +
		"A one-time login is required (click “Connect to Zerodha”)."
)

// Config configures a Client. APIRoot, LoginRoot, HTTPClient and HistoricalGate default to
// production values when empty.
type Config struct {
	APIKey    string
	APISecret string
	// APIRoot replaces https://api.kite.trade (no trailing slash).
	APIRoot string
	// LoginRoot replaces https://kite.zerodha.com/connect/login.
	LoginRoot string
	// HTTPClient defaults to a client with undici's 300 s response-header timeout and no
	// overall deadline: kite.ts set no timeout of its own, and the historical gate's
	// 20 s watchdog is the only other bound, as in Node.
	HTTPClient *http.Client
	// HistoricalGate defaults to the process-wide gate.
	HistoricalGate *HistoricalGate
}

// Client is kite.ts KiteClient. It is safe for concurrent use; the access token is
// guarded by a mutex because logins, restores and any 401/403 clear it from many
// goroutines.
type Client struct {
	apiKey    string
	apiSecret string
	apiRoot   string
	loginRoot string
	http      *http.Client
	gate      *HistoricalGate

	mu          sync.RWMutex
	accessToken *string // nil = no session (Node null)
}

// HeadersTimeout is how long the default HTTP client waits for response headers: the
// 300 s default of undici, the HTTP stack behind Node's fetch (which kite.ts relied on:
// it set no timeout of its own). There is no overall deadline, as in Node.
const HeadersTimeout = 300 * time.Second

func defaultHTTPClient() *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.ResponseHeaderTimeout = HeadersTimeout
	return &http.Client{Transport: tr}
}

// NewClient builds a client. Like the Node constructor it refuses an empty key or secret
// with KiteError 500.
func NewClient(cfg Config) (*Client, error) {
	if cfg.APIKey == "" || cfg.APISecret == "" {
		return nil, newKiteError("KITE_API_KEY and KITE_API_SECRET must be set in the environment (.env).", 500)
	}
	c := &Client{
		apiKey:    cfg.APIKey,
		apiSecret: cfg.APISecret,
		apiRoot:   strings.TrimSuffix(cfg.APIRoot, "/"),
		loginRoot: cfg.LoginRoot,
		http:      cfg.HTTPClient,
		gate:      cfg.HistoricalGate,
	}
	if c.apiRoot == "" {
		c.apiRoot = DefaultAPIRoot
	}
	if c.loginRoot == "" {
		c.loginRoot = DefaultLoginRoot
	}
	if c.http == nil {
		c.http = defaultHTTPClient()
	}
	if c.gate == nil {
		c.gate = defaultGate
	}
	return c, nil
}

// ---------------------------------------------------------------------------
// Session

// LoginURL is the URL the operator visits to log in (getLoginUrl).
func (c *Client) LoginURL() string {
	return c.loginRoot + "?" + searchParams([2]string{"api_key", c.apiKey}, [2]string{"v", "3"})
}

// SessionData is the /session/token result. Raw is the whole `data` object as
// JSON.stringify would write it (Kite sends many more fields).
type SessionData struct {
	AccessToken string
	UserID      string
	UserName    string
	Email       string
	Raw         json.RawMessage
}

// GenerateSession exchanges a request_token for an access token
// (checksum = hex(sha256(api_key + request_token + api_secret))) and keeps the token in
// memory. A failure never clears an existing session.
func (c *Client) GenerateSession(ctx context.Context, requestToken string) (SessionData, error) {
	if requestToken == "" {
		return SessionData{}, newKiteError("Missing request_token.", 400)
	}
	sum := sha256.Sum256([]byte(c.apiKey + requestToken + c.apiSecret))
	body := searchParams(
		[2]string{"api_key", c.apiKey},
		[2]string{"request_token", requestToken},
		[2]string{"checksum", hex.EncodeToString(sum[:])},
	)
	req, err := c.newRequest(ctx, http.MethodPost, c.apiRoot+"/session/token", []byte(body), http.Header{
		"X-Kite-Version": {"3"},
		"Content-Type":   {"application/x-www-form-urlencoded"},
	})
	if err != nil {
		return SessionData{}, err
	}
	data, err := c.callJSON(req, "Failed to generate session", false, (*jsjson.Value).Truthy)
	if err != nil {
		return SessionData{}, err
	}
	token := looseString(data.Get("access_token"))
	c.mu.Lock()
	c.accessToken = &token
	c.mu.Unlock()
	return SessionData{
		AccessToken: token,
		UserID:      looseString(data.Get("user_id")),
		UserName:    looseString(data.Get("user_name")),
		Email:       looseString(data.Get("email")),
		Raw:         jsjson.Marshal(data),
	}, nil
}

// SetAccessToken restores a previously obtained token.
func (c *Client) SetAccessToken(token string) {
	c.mu.Lock()
	c.accessToken = &token
	c.mu.Unlock()
}

// HasSession reports whether a token is held (even an empty one, as in Node).
func (c *Client) HasSession() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.accessToken != nil
}

// APIKey is the app's public API key (needed for the WebSocket URL).
func (c *Client) APIKey() string { return c.apiKey }

// AccessToken is the current token, "" when there is none.
func (c *Client) AccessToken() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.accessToken == nil {
		return ""
	}
	return *c.accessToken
}

// ClearSession forgets the token (logout, or a 401/403 from Kite).
func (c *Client) ClearSession() {
	c.mu.Lock()
	c.accessToken = nil
	c.mu.Unlock()
}

func (c *Client) authHeader() (http.Header, error) {
	tok := c.AccessToken()
	if tok == "" {
		return nil, newKiteError(notAuthenticated, 401)
	}
	return http.Header{
		"X-Kite-Version": {"3"},
		"Authorization":  {"token " + c.apiKey + ":" + tok},
	}, nil
}

// ---------------------------------------------------------------------------
// Transport

func (c *Client) newRequest(ctx context.Context, method, url string, body []byte, hdr http.Header) (*http.Request, error) {
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, r)
	if err != nil {
		return nil, &FetchError{Err: err}
	}
	for k, v := range hdr {
		req.Header[k] = v
	}
	return req, nil
}

func (c *Client) send(req *http.Request) (*http.Response, []byte, error) {
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, nil, &FetchError{Err: err}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, nil, &FetchError{Err: err}
	}
	return resp, body, nil
}

// bodyText decodes a body the way Response.text()/json() do: UTF-8 with the BOM dropped
// and invalid sequences replaced.
func bodyText(b []byte) string {
	b = bytes.TrimPrefix(b, []byte{0xEF, 0xBB, 0xBF})
	if utf8.Valid(b) {
		return string(b)
	}
	return strings.ToValidUTF8(string(b), "\uFFFD")
}

func okStatus(code int) bool { return code >= 200 && code <= 299 }

// callJSON performs one JSON request with kite.ts's uniform handling: the body is parsed
// first (a non-JSON body is a ResponseError, with no session change), then the call fails
// unless the HTTP status is 2xx, `status` is "success" and valid(data) holds. On failure a
// 401/403 clears the session (when clearOnAuth) and the error is
// KiteError(message ?? "<failText> (HTTP n).", status).
func (c *Client) callJSON(req *http.Request, failText string, clearOnAuth bool, valid func(*jsjson.Value) bool) (*jsjson.Value, error) {
	resp, body, err := c.send(req)
	if err != nil {
		return nil, err
	}
	root, perr := jsjson.Parse(bodyText(body))
	if perr != nil {
		return nil, &ResponseError{Message: perr.Error(), HTTPStatus: resp.StatusCode}
	}
	if root.Kind() == jsjson.Null {
		// A JSON `null` body: Node evaluated `!res.ok || json.status …`, so a non-2xx
		// response got as far as the 401/403 session drop and then threw reading
		// `json.message`; a 2xx one threw reading `json.status`.
		prop := "status"
		if !okStatus(resp.StatusCode) {
			prop = "message"
			if clearOnAuth && (resp.StatusCode == 401 || resp.StatusCode == 403) {
				c.ClearSession()
			}
		}
		return nil, &ResponseError{Message: "Cannot read properties of null (reading '" + prop + "')", HTTPStatus: resp.StatusCode}
	}
	data := root.Get("data")
	status := root.Get("status")
	if !okStatus(resp.StatusCode) || !status.IsString() || status.Str() != "success" || !valid(data) {
		if clearOnAuth && (resp.StatusCode == 401 || resp.StatusCode == 403) {
			c.ClearSession()
		}
		msg := fmt.Sprintf("%s (HTTP %d).", failText, resp.StatusCode)
		if m := root.Get("message"); !m.Nullish() {
			msg = jsjson.ToString(m)
		}
		return nil, newKiteError(msg, resp.StatusCode)
	}
	return data, nil
}

// looseString reads a field Node used as a string: strings as-is, null/undefined as "",
// anything else through String().
func looseString(v *jsjson.Value) string {
	if v.Nullish() {
		return ""
	}
	return jsjson.ToString(v)
}

// numOr is `v ?? def` for a field Node used as a number. Non-numbers that Node would
// have passed through untouched are converted with Number() (Go fields are typed).
func numOr(v *jsjson.Value, def float64) float64 {
	if v.Nullish() {
		return def
	}
	if v.IsNumber() {
		return v.Num()
	}
	return jsjson.ToNumber(v)
}

// num is kite.ts num(): a finite number, else 0.
func num(v *jsjson.Value) float64 {
	if v.IsNumber() && jsx.Finite(v.Num()) {
		return v.Num()
	}
	return 0
}

// ---------------------------------------------------------------------------
// Profile

// GetProfile is GET /user/profile; the `data` object is returned as JSON.stringify would
// write it, for the route to pass through verbatim.
func (c *Client) GetProfile(ctx context.Context) (json.RawMessage, error) {
	hdr, err := c.authHeader()
	if err != nil {
		return nil, err
	}
	req, err := c.newRequest(ctx, http.MethodGet, c.apiRoot+"/user/profile", nil, hdr)
	if err != nil {
		return nil, err
	}
	data, err := c.callJSON(req, "Failed to fetch profile", true, (*jsjson.Value).Truthy)
	if err != nil {
		return nil, err
	}
	return jsjson.Marshal(data), nil
}

// ---------------------------------------------------------------------------
// Quotes

// OHLC is a quote's day open/high/low/close.
type OHLC struct {
	Open  float64 `json:"open"`
	High  float64 `json:"high"`
	Low   float64 `json:"low"`
	Close float64 `json:"close"`
}

// OhlcQuote is one /quote/ohlc entry.
type OhlcQuote struct {
	InstrumentToken int64   `json:"instrument_token"`
	LastPrice       float64 `json:"last_price"`
	OHLC            OHLC    `json:"ohlc"`
}

// FullQuote is the part of a /quote entry the board uses.
type FullQuote struct {
	InstrumentToken int64   `json:"instrument_token"`
	LastPrice       float64 `json:"last_price"`
	Close           float64 `json:"close"`
	OI              float64 `json:"oi"`
	// LastTradeTime is "YYYY-MM-DD HH:MM:SS" IST (last_trade_time, else
	// exchange_timestamp for indices), or "".
	LastTradeTime string `json:"last_trade_time"`
}

// FullQuoteOhlc is a /quote entry with the full OHLC (EOD capture).
type FullQuoteOhlc struct {
	InstrumentToken int64   `json:"instrument_token"`
	LastPrice       float64 `json:"last_price"`
	Open            float64 `json:"open"`
	High            float64 `json:"high"`
	Low             float64 `json:"low"`
	Close           float64 `json:"close"`
	OI              float64 `json:"oi"`
}

// QuoteDepth is best bid/ask plus last.
type QuoteDepth struct {
	Last float64 `json:"last"`
	Bid  float64 `json:"bid"`
	Ask  float64 `json:"ask"`
}

// QuoteLadder is the 5-level book (best first) plus last. Levels carry price and qty;
// Orders is always 0 (the REST ladder had no order count).
type QuoteLadder struct {
	Last float64             `json:"last"`
	Bids []market.DepthLevel `json:"bids"`
	Asks []market.DepthLevel `json:"asks"`
}

// quoteEntries fetches path?i=<id>&i=<id>… in sequential chunks of 500 and calls each for
// every entry of Object.values(data) that has a numeric instrument_token.
func (c *Client) quoteEntries(ctx context.Context, path string, ids []string, each func(v *jsjson.Value)) error {
	for i := 0; i < len(ids); i += QuoteChunk {
		end := i + QuoteChunk
		if end > len(ids) {
			end = len(ids)
		}
		parts := make([]string, 0, end-i)
		for _, id := range ids[i:end] {
			parts = append(parts, "i="+EncodeURIComponent(id))
		}
		hdr, err := c.authHeader()
		if err != nil {
			return err
		}
		req, err := c.newRequest(ctx, http.MethodGet, c.apiRoot+path+"?"+strings.Join(parts, "&"), nil, hdr)
		if err != nil {
			return err
		}
		data, err := c.callJSON(req, "Failed to fetch quotes", true, (*jsjson.Value).Truthy)
		if err != nil {
			return err
		}
		for _, v := range data.Values() {
			if v.Get("instrument_token").IsNumber() {
				each(v)
			}
		}
	}
	return nil
}

func tokenOf(v *jsjson.Value) int64 { return toInt64(v.Get("instrument_token").Num()) }

// GetQuoteOhlc is GET /quote/ohlc for "EXCHANGE:TRADINGSYMBOL" identifiers.
func (c *Client) GetQuoteOhlc(ctx context.Context, identifiers []string) ([]OhlcQuote, error) {
	out := []OhlcQuote{}
	err := c.quoteEntries(ctx, "/quote/ohlc", identifiers, func(v *jsjson.Value) {
		o := v.Get("ohlc")
		out = append(out, OhlcQuote{
			InstrumentToken: tokenOf(v),
			LastPrice:       numOr(v.Get("last_price"), 0),
			OHLC: OHLC{
				Open:  numOr(o.Get("open"), 0),
				High:  numOr(o.Get("high"), 0),
				Low:   numOr(o.Get("low"), 0),
				Close: numOr(o.Get("close"), 0),
			},
		})
	})
	return out, err
}

// GetQuoteFull is GET /quote: last price, day close, OI and the last-trade stamp.
func (c *Client) GetQuoteFull(ctx context.Context, identifiers []string) ([]FullQuote, error) {
	out := []FullQuote{}
	err := c.quoteEntries(ctx, "/quote", identifiers, func(v *jsjson.Value) {
		ltt := v.Get("last_trade_time")
		if ltt.Nullish() {
			ltt = v.Get("exchange_timestamp")
		}
		out = append(out, FullQuote{
			InstrumentToken: tokenOf(v),
			LastPrice:       numOr(v.Get("last_price"), 0),
			Close:           numOr(v.Get("ohlc").Get("close"), 0),
			OI:              numOr(v.Get("oi"), 0),
			LastTradeTime:   looseString(ltt),
		})
	})
	return out, err
}

// GetQuoteFullOhlc is GET /quote with the full OHLC.
func (c *Client) GetQuoteFullOhlc(ctx context.Context, identifiers []string) ([]FullQuoteOhlc, error) {
	out := []FullQuoteOhlc{}
	err := c.quoteEntries(ctx, "/quote", identifiers, func(v *jsjson.Value) {
		o := v.Get("ohlc")
		out = append(out, FullQuoteOhlc{
			InstrumentToken: tokenOf(v),
			LastPrice:       numOr(v.Get("last_price"), 0),
			Open:            numOr(o.Get("open"), 0),
			High:            numOr(o.Get("high"), 0),
			Low:             numOr(o.Get("low"), 0),
			Close:           numOr(o.Get("close"), 0),
			OI:              numOr(v.Get("oi"), 0),
		})
	})
	return out, err
}

// GetQuoteDepth is best bid/ask per token from GET /quote (bid/ask fall back to last).
func (c *Client) GetQuoteDepth(ctx context.Context, identifiers []string) (map[int64]QuoteDepth, error) {
	out := map[int64]QuoteDepth{}
	err := c.quoteEntries(ctx, "/quote", identifiers, func(v *jsjson.Value) {
		last := numOr(v.Get("last_price"), 0)
		depth := v.Get("depth")
		out[tokenOf(v)] = QuoteDepth{
			Last: last,
			Bid:  numOr(depth.Get("buy").Get("0").Get("price"), last),
			Ask:  numOr(depth.Get("sell").Get("0").Get("price"), last),
		}
	})
	return out, err
}

// GetQuoteLadder is the 5-level book per token from GET /quote; levels with price <= 0
// are dropped.
func (c *Client) GetQuoteLadder(ctx context.Context, identifiers []string) (map[int64]QuoteLadder, error) {
	out := map[int64]QuoteLadder{}
	levels := func(arr *jsjson.Value) []market.DepthLevel {
		res := []market.DepthLevel{}
		for _, l := range arr.Elems() {
			p := numOr(l.Get("price"), 0)
			if p > 0 {
				res = append(res, market.DepthLevel{Price: p, Qty: numOr(l.Get("quantity"), 0)})
			}
		}
		return res
	}
	err := c.quoteEntries(ctx, "/quote", identifiers, func(v *jsjson.Value) {
		depth := v.Get("depth")
		out[tokenOf(v)] = QuoteLadder{
			Last: numOr(v.Get("last_price"), 0),
			Bids: levels(depth.Get("buy")),
			Asks: levels(depth.Get("sell")),
		}
	})
	return out, err
}

// ---------------------------------------------------------------------------
// Margins and charges

// BasketOrder is one line of a basket-margin request (JSON keys in Node's order).
type BasketOrder struct {
	Exchange        string  `json:"exchange"`
	Tradingsymbol   string  `json:"tradingsymbol"`
	TransactionType string  `json:"transaction_type"` // BUY | SELL
	Variety         string  `json:"variety"`
	Product         string  `json:"product"`
	OrderType       string  `json:"order_type"`
	Quantity        float64 `json:"quantity"`
	Price           float64 `json:"price"`
}

// BasketMarginResult is getBasketMargin's {initial, final, total: final || initial}.
type BasketMarginResult struct {
	Initial float64 `json:"initial"`
	Final   float64 `json:"final"`
	Total   float64 `json:"total"`
}

// GetBasketMargin is POST /margins/basket?consider_positions=true|false. Node's default
// is considerPositions=true; pass false for a standalone figure.
func (c *Client) GetBasketMargin(ctx context.Context, orders []BasketOrder, considerPositions bool) (BasketMarginResult, error) {
	hdr, err := c.authHeader()
	if err != nil {
		return BasketMarginResult{}, err
	}
	hdr.Set("Content-Type", "application/json")
	body := []byte{'['}
	for i, o := range orders {
		if i > 0 {
			body = append(body, ',')
		}
		body = appendObject(body,
			kv{"exchange", str(o.Exchange)}, kv{"tradingsymbol", str(o.Tradingsymbol)},
			kv{"transaction_type", str(o.TransactionType)}, kv{"variety", str(o.Variety)},
			kv{"product", str(o.Product)}, kv{"order_type", str(o.OrderType)},
			kv{"quantity", number(o.Quantity)}, kv{"price", number(o.Price)})
	}
	body = append(body, ']')
	q := "false"
	if considerPositions {
		q = "true"
	}
	req, err := c.newRequest(ctx, http.MethodPost, c.apiRoot+"/margins/basket?consider_positions="+q, body, hdr)
	if err != nil {
		return BasketMarginResult{}, err
	}
	data, err := c.callJSON(req, "Failed to fetch basket margin", true, (*jsjson.Value).Truthy)
	if err != nil {
		return BasketMarginResult{}, err
	}
	initial := numOr(data.Get("initial").Get("total"), 0)
	final := numOr(data.Get("final").Get("total"), 0)
	total := final
	if total == 0 || total != total { // final || initial (0 and NaN are falsy)
		total = initial
	}
	return BasketMarginResult{Initial: initial, Final: final, Total: total}, nil
}

// ChargeOrder is one order line for the virtual contract note (POST /charges/orders).
type ChargeOrder struct {
	OrderID         string  `json:"order_id"`
	Exchange        string  `json:"exchange"`
	Tradingsymbol   string  `json:"tradingsymbol"`
	TransactionType string  `json:"transaction_type"`
	Variety         string  `json:"variety"`
	Product         string  `json:"product"`
	OrderType       string  `json:"order_type"`
	Quantity        float64 `json:"quantity"`
	AveragePrice    float64 `json:"average_price"`
}

// GST is the GST split of a charge breakdown.
type GST struct {
	IGST  float64 `json:"igst"`
	CGST  float64 `json:"cgst"`
	SGST  float64 `json:"sgst"`
	Total float64 `json:"total"`
}

// OrderChargeBreakdown is the per-order charge heads (kite.ts OrderChargeBreakdown).
type OrderChargeBreakdown struct {
	TransactionTax         float64 `json:"transaction_tax"`
	TransactionTaxType     string  `json:"transaction_tax_type"`
	ExchangeTurnoverCharge float64 `json:"exchange_turnover_charge"`
	SebiTurnoverCharge     float64 `json:"sebi_turnover_charge"`
	Brokerage              float64 `json:"brokerage"`
	StampDuty              float64 `json:"stamp_duty"`
	GST                    GST     `json:"gst"`
	Total                  float64 `json:"total"`
}

// OrderCharges is one order's charges tied back to its request line. Raw is Kite's
// untouched `charges` object (JSON null when absent).
type OrderCharges struct {
	OrderID         string               `json:"order_id"`
	Tradingsymbol   string               `json:"tradingsymbol"`
	TransactionType string               `json:"transaction_type"`
	Quantity        float64              `json:"quantity"`
	Price           float64              `json:"price"`
	Charges         OrderChargeBreakdown `json:"charges"`
	Raw             json.RawMessage      `json:"raw"`
}

// parseCharges reads Kite's charge object defensively (kite.ts parseCharges): every head
// is a finite number or 0; totals are Kite's when non-zero, else recomputed.
func parseCharges(c *jsjson.Value) OrderChargeBreakdown {
	g := c.Get("gst")
	igst, cgst, sgst := num(g.Get("igst")), num(g.Get("cgst")), num(g.Get("sgst"))
	gstTotal := num(g.Get("total"))
	if gstTotal == 0 {
		gstTotal = igst + cgst + sgst
	}
	tt := num(c.Get("transaction_tax"))
	exch := num(c.Get("exchange_turnover_charge"))
	sebi := num(c.Get("sebi_turnover_charge"))
	brokerage := num(c.Get("brokerage"))
	stamp := num(c.Get("stamp_duty"))
	total := num(c.Get("total"))
	if total == 0 {
		total = tt + exch + sebi + brokerage + stamp + gstTotal
	}
	return OrderChargeBreakdown{
		TransactionTax:         tt,
		TransactionTaxType:     c.Get("transaction_tax_type").Str(),
		ExchangeTurnoverCharge: exch,
		SebiTurnoverCharge:     sebi,
		Brokerage:              brokerage,
		StampDuty:              stamp,
		GST:                    GST{IGST: igst, CGST: cgst, SGST: sgst, Total: gstTotal},
		Total:                  total,
	}
}

// GetOrderCharges is POST /charges/orders. Empty input returns an empty list without a
// call. Rows are mapped in response order, falling back to the request line at the same
// index for missing fields.
func (c *Client) GetOrderCharges(ctx context.Context, orders []ChargeOrder) ([]OrderCharges, error) {
	if len(orders) == 0 {
		return []OrderCharges{}, nil
	}
	hdr, err := c.authHeader()
	if err != nil {
		return nil, err
	}
	hdr.Set("Content-Type", "application/json")
	body := []byte{'['}
	for i, o := range orders {
		if i > 0 {
			body = append(body, ',')
		}
		body = appendObject(body,
			kv{"order_id", str(o.OrderID)}, kv{"exchange", str(o.Exchange)},
			kv{"tradingsymbol", str(o.Tradingsymbol)}, kv{"transaction_type", str(o.TransactionType)},
			kv{"variety", str(o.Variety)}, kv{"product", str(o.Product)}, kv{"order_type", str(o.OrderType)},
			kv{"quantity", number(o.Quantity)}, kv{"average_price", number(o.AveragePrice)})
	}
	body = append(body, ']')
	req, err := c.newRequest(ctx, http.MethodPost, c.apiRoot+"/charges/orders", body, hdr)
	if err != nil {
		return nil, err
	}
	data, err := c.callJSON(req, "Failed to fetch order charges", true, func(d *jsjson.Value) bool { return d.Kind() == jsjson.Array })
	if err != nil {
		return nil, err
	}
	rows := data.Elems()
	out := make([]OrderCharges, len(rows))
	for i, row := range rows {
		var req *ChargeOrder
		if i < len(orders) {
			req = &orders[i]
		}
		oc := OrderCharges{}
		if id := row.Get("order_id"); id.IsString() && id.Str() != "" {
			oc.OrderID = id.Str()
		} else if req != nil {
			oc.OrderID = req.OrderID
		} else {
			oc.OrderID = strconv.Itoa(i)
		}
		if ts := row.Get("tradingsymbol"); ts.IsString() {
			oc.Tradingsymbol = ts.Str()
		} else if req != nil {
			oc.Tradingsymbol = req.Tradingsymbol
		}
		if tt := row.Get("transaction_type").Str(); tt == "SELL" || tt == "BUY" {
			oc.TransactionType = tt
		} else if req != nil {
			oc.TransactionType = req.TransactionType
		} else {
			oc.TransactionType = "BUY"
		}
		oc.Quantity = num(row.Get("quantity"))
		if oc.Quantity == 0 && req != nil {
			oc.Quantity = req.Quantity
		}
		oc.Price = num(row.Get("price"))
		if oc.Price == 0 && req != nil {
			oc.Price = req.AveragePrice
		}
		raw := row.Get("charges")
		oc.Charges = parseCharges(raw)
		if raw.Nullish() {
			oc.Raw = json.RawMessage("null")
		} else {
			oc.Raw = jsjson.Marshal(raw)
		}
		out[i] = oc
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Historical candles

// HistoricalCandle is a full daily candle (getHistoricalFull).
type HistoricalCandle struct {
	Date   string  `json:"date"`
	Open   float64 `json:"open"`
	High   float64 `json:"high"`
	Low    float64 `json:"low"`
	Close  float64 `json:"close"`
	Volume float64 `json:"volume"`
	OI     float64 `json:"oi"`
}

// DayOI is one getHistoricalOi row: the day's close and closing OI.
type DayOI struct {
	Date  string  `json:"date"`
	Close float64 `json:"close"`
	OI    float64 `json:"oi"`
}

// ClosePoint is one getHistorical row with the full candle timestamp.
type ClosePoint struct {
	T     string  `json:"t"`
	Close float64 `json:"close"`
}

// OISeriesPoint is one getHistoricalOiSeries row with the full candle timestamp.
type OISeriesPoint struct {
	T     string  `json:"t"`
	Close float64 `json:"close"`
	OI    float64 `json:"oi"`
}

func (c *Client) historicalURL(token int64, interval, from, to string, oi bool) string {
	u := c.apiRoot + "/instruments/historical/" + strconv.FormatInt(token, 10) + "/" + interval +
		"?from=" + EncodeURIComponent(from) + "&to=" + EncodeURIComponent(to)
	if oi {
		u += "&oi=1"
	}
	return u
}

// historicalCandles runs one request through the gate and returns the candle rows. The
// auth header is read inside the slot, as in Node, so an unauthenticated call still
// queues and paces.
func (c *Client) historicalCandles(ctx context.Context, url string, prio HistoricalPriority) ([]*jsjson.Value, error) {
	var candles *jsjson.Value
	err := c.gate.Run(ctx, prio, func() error {
		hdr, err := c.authHeader()
		if err != nil {
			return err
		}
		req, err := c.newRequest(ctx, http.MethodGet, url, nil, hdr)
		if err != nil {
			return err
		}
		data, err := c.callJSON(req, "Failed to fetch historical data", true, func(d *jsjson.Value) bool {
			return d.Get("candles").Truthy()
		})
		if err != nil {
			return err
		}
		candles = data.Get("candles")
		return nil
	})
	if err != nil {
		return nil, err
	}
	if candles.Kind() != jsjson.Array {
		return nil, &ResponseError{Message: "candles.map is not a function", HTTPStatus: 200}
	}
	return candles.Elems(), nil
}

// candleField is c[i] for one candle row.
func candleField(c *jsjson.Value, i int) (*jsjson.Value, error) {
	switch c.Kind() {
	case jsjson.Null:
		return nil, &ResponseError{Message: fmt.Sprintf("Cannot read properties of null (reading '%d')", i), HTTPStatus: 200}
	case jsjson.String:
		vals := c.Values()
		if i < len(vals) {
			return vals[i], nil
		}
		return nil, nil
	}
	return c.Get(strconv.Itoa(i)), nil
}

type candleRow struct {
	ts     string
	fields [7]float64
}

func readCandles(rows []*jsjson.Value) ([]candleRow, error) {
	out := make([]candleRow, len(rows))
	for r, c := range rows {
		for i := 0; i < 7; i++ {
			v, err := candleField(c, i)
			if err != nil {
				return nil, err
			}
			if i == 0 {
				out[r].ts = looseString(v) // String(c[0] ?? "")
				continue
			}
			if v.Nullish() {
				out[r].fields[i] = 0 // Number(c[i] ?? 0)
			} else {
				out[r].fields[i] = jsjson.ToNumber(v)
			}
		}
	}
	return out, nil
}

// GetHistoricalOi is daily candles with OI: GET …/<token>/day?from&to&oi=1, mapped to
// {date: first 10 chars of the stamp, close, oi}.
func (c *Client) GetHistoricalOi(ctx context.Context, token int64, from, to string, prio HistoricalPriority) ([]DayOI, error) {
	rows, err := c.historicalCandles(ctx, c.historicalURL(token, "day", from, to, true), prio)
	if err != nil {
		return nil, err
	}
	cs, err := readCandles(rows)
	if err != nil {
		return nil, err
	}
	out := make([]DayOI, len(cs))
	for i, r := range cs {
		out[i] = DayOI{Date: jsjson.SliceUTF16(r.ts, 10), Close: r.fields[4], OI: r.fields[6]}
	}
	return out, nil
}

// GetHistoricalFull is OHLCV + OI candles at interval ("" means "day").
func (c *Client) GetHistoricalFull(ctx context.Context, token int64, from, to, interval string, prio HistoricalPriority) ([]HistoricalCandle, error) {
	if interval == "" {
		interval = "day"
	}
	rows, err := c.historicalCandles(ctx, c.historicalURL(token, interval, from, to, true), prio)
	if err != nil {
		return nil, err
	}
	cs, err := readCandles(rows)
	if err != nil {
		return nil, err
	}
	out := make([]HistoricalCandle, len(cs))
	for i, r := range cs {
		f := r.fields
		out[i] = HistoricalCandle{Date: jsjson.SliceUTF16(r.ts, 10), Open: f[1], High: f[2], Low: f[3], Close: f[4], Volume: f[5], OI: f[6]}
	}
	return out, nil
}

// GetHistorical is candles at any interval without OI: {t: full stamp, close}.
func (c *Client) GetHistorical(ctx context.Context, token int64, from, to, interval string, prio HistoricalPriority) ([]ClosePoint, error) {
	rows, err := c.historicalCandles(ctx, c.historicalURL(token, interval, from, to, false), prio)
	if err != nil {
		return nil, err
	}
	cs, err := readCandles(rows)
	if err != nil {
		return nil, err
	}
	out := make([]ClosePoint, len(cs))
	for i, r := range cs {
		out[i] = ClosePoint{T: r.ts, Close: r.fields[4]}
	}
	return out, nil
}

// GetHistoricalOiSeries is candles at any interval with OI and the full stamp.
func (c *Client) GetHistoricalOiSeries(ctx context.Context, token int64, from, to, interval string, prio HistoricalPriority) ([]OISeriesPoint, error) {
	rows, err := c.historicalCandles(ctx, c.historicalURL(token, interval, from, to, true), prio)
	if err != nil {
		return nil, err
	}
	cs, err := readCandles(rows)
	if err != nil {
		return nil, err
	}
	out := make([]OISeriesPoint, len(cs))
	for i, r := range cs {
		out[i] = OISeriesPoint{T: r.ts, Close: r.fields[4], OI: r.fields[6]}
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Instruments

// GetInstruments downloads the instruments CSV (all exchanges, or one). The first attempt
// sends no access token; if refused and a session exists it is retried authenticated.
// A final 401/403 clears the session.
func (c *Client) GetInstruments(ctx context.Context, exchange string) ([]market.Instrument, error) {
	url := c.apiRoot + "/instruments"
	if exchange != "" {
		url += "/" + EncodeURIComponent(exchange)
	}
	req, err := c.newRequest(ctx, http.MethodGet, url, nil, http.Header{"X-Kite-Version": {"3"}})
	if err != nil {
		return nil, err
	}
	resp, body, err := c.send(req)
	if err != nil {
		return nil, err
	}
	if !okStatus(resp.StatusCode) && c.AccessToken() != "" {
		hdr, err := c.authHeader()
		if err != nil {
			return nil, err
		}
		if req, err = c.newRequest(ctx, http.MethodGet, url, nil, hdr); err != nil {
			return nil, err
		}
		if resp, body, err = c.send(req); err != nil {
			return nil, err
		}
	}
	text := bodyText(body)
	if !okStatus(resp.StatusCode) {
		if resp.StatusCode == 401 || resp.StatusCode == 403 {
			c.ClearSession()
			return nil, newKiteError(instrumentsNoLogin, resp.StatusCode)
		}
		return nil, newKiteError(fmt.Sprintf("Failed to fetch instruments (HTTP %d): %s", resp.StatusCode, jsjson.SliceUTF16(text, 200)), resp.StatusCode)
	}
	return ParseInstrumentsCSV(text), nil
}

// ---------------------------------------------------------------------------
// JSON.stringify for request bodies

type kv struct {
	k string
	v func([]byte) []byte
}

func str(s string) func([]byte) []byte {
	return func(b []byte) []byte { return jsjson.AppendString(b, s) }
}

func number(f float64) func([]byte) []byte {
	return func(b []byte) []byte { return jsjson.AppendNumber(b, f) }
}

func appendObject(b []byte, fields ...kv) []byte {
	b = append(b, '{')
	for i, f := range fields {
		if i > 0 {
			b = append(b, ',')
		}
		b = jsjson.AppendString(b, f.k)
		b = append(b, ':')
		b = f.v(b)
	}
	return append(b, '}')
}
