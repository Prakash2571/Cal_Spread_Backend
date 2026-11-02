package kite

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"sync"
	"testing"
	"time"

	fvjson "github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite/jsjson"
)

type clientRequest struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

type clientResponse struct {
	Status int     `json:"status"`
	Body   *string `json:"body"`
	Hex    *string `json:"hex"`
	Type   *string `json:"type"`
}

type clientCase struct {
	Name      string            `json:"name"`
	APIKey    string            `json:"apiKey"`
	APISecret string            `json:"apiSecret"`
	Session   *string           `json:"session"`
	Call      string            `json:"call"`
	Args      []json.RawMessage `json:"args"`
	Responses []clientResponse  `json:"responses"`
	Requests  []clientRequest   `json:"requests"`
	Result    json.RawMessage   `json:"result"`
	JSON      *string           `json:"json"`
	Raws      []string          `json:"raws"`
	Error     *struct {
		Name    string `json:"name"`
		Message string `json:"message"`
		Status  *int   `json:"status"`
	} `json:"error"`
	After json.RawMessage `json:"after"`
}

// fakeKiteAPI serves a case's scripted responses in order and records every request.
type fakeKiteAPI struct {
	mu        sync.Mutex
	responses []clientResponse
	requests  []clientRequest
}

func (f *fakeKiteAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	got := clientRequest{Method: r.Method, URL: r.RequestURI, Headers: map[string]string{}, Body: string(body)}
	for _, k := range []string{"X-Kite-Version", "Authorization", "Content-Type"} {
		if v := r.Header.Values(k); len(v) > 0 {
			got.Headers[http.CanonicalHeaderKey(k)] = v[0]
		}
	}
	f.mu.Lock()
	f.requests = append(f.requests, got)
	var resp *clientResponse
	if len(f.responses) > 0 {
		resp = &f.responses[0]
		f.responses = f.responses[1:]
	}
	f.mu.Unlock()
	if resp == nil {
		w.WriteHeader(599)
		_, _ = io.WriteString(w, "unscripted request")
		return
	}
	ct := "application/json; charset=utf-8"
	if resp.Type != nil {
		ct = *resp.Type
	}
	w.Header().Set("Content-Type", ct)
	w.WriteHeader(resp.Status)
	switch {
	case resp.Hex != nil:
		b, _ := hex.DecodeString(*resp.Hex)
		_, _ = w.Write(b)
	case resp.Body != nil:
		_, _ = io.WriteString(w, *resp.Body)
	}
}

func loadClientGolden(t *testing.T) []clientCase {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "client.golden.json"))
	if err != nil {
		t.Fatalf("golden: %v (regenerate with scratch/go-migration/check.sh node internal/kite/testdata/gen_client.mjs)", err)
	}
	var g struct {
		Cases []clientCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	return g.Cases
}

// generic decodes JSON for an order-insensitive comparison (numbers as float64, so
// "1e-07" and "1e-7" are the same value).
func generic(t *testing.T, b []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, b)
	}
	return v
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// jsJSON is the JSON a route sends for v (JSON.stringify semantics: NaN and ±Infinity
// become null).
func jsJSON(v any) []byte { return fvjson.Marshal(v) }

// nodeMap turns the loader's {"$map":[[k,v],…]} into {"k": v} (what Go's map JSON is).
func nodeMap(t *testing.T, raw json.RawMessage) any {
	t.Helper()
	var m struct {
		Map [][2]json.RawMessage `json:"$map"`
	}
	if err := json.Unmarshal(raw, &m); err != nil || m.Map == nil {
		t.Fatalf("result is not a Map: %s", raw)
	}
	out := map[string]any{}
	for _, e := range m.Map {
		var k float64
		if err := json.Unmarshal(e[0], &k); err != nil {
			t.Fatal(err)
		}
		out[strconv.FormatFloat(k, 'f', -1, 64)] = generic(t, e[1])
	}
	return out
}

func arg[T any](t *testing.T, c clientCase, i int, def T) T {
	t.Helper()
	if i >= len(c.Args) {
		return def
	}
	var v T
	if err := json.Unmarshal(c.Args[i], &v); err != nil {
		t.Fatalf("arg %d: %v", i, err)
	}
	return v
}

// ohlcFromNode is what Go's typed OhlcQuote holds for one raw Node entry: Node returned
// the raw Kite object, whose missing numbers its only caller (hourlyCapture, `q.last_price
// > 0`) treated like 0.
func ohlcFromNode(t *testing.T, raw json.RawMessage) []OhlcQuote {
	t.Helper()
	var entries []struct {
		Token *float64 `json:"instrument_token"`
		Last  *float64 `json:"last_price"`
		OHLC  *struct {
			Open, High, Low, Close *float64
		} `json:"ohlc"`
	}
	if err := json.Unmarshal(raw, &entries); err != nil {
		t.Fatal(err)
	}
	or0 := func(p *float64) float64 {
		if p == nil {
			return 0
		}
		return *p
	}
	out := []OhlcQuote{}
	for _, e := range entries {
		q := OhlcQuote{InstrumentToken: int64(or0(e.Token)), LastPrice: or0(e.Last)}
		if e.OHLC != nil {
			q.OHLC = OHLC{Open: or0(e.OHLC.Open), High: or0(e.OHLC.High), Low: or0(e.OHLC.Low), Close: or0(e.OHLC.Close)}
		}
		out = append(out, q)
	}
	return out
}

// TestClientGolden replays src/kite.ts KiteClient (gen_client.mjs) against a local fake
// Kite: every request (method, path and query exactly as sent, X-Kite-Version,
// Authorization, Content-Type, body bytes), the result, the error (class, message,
// status) and whether the session survived.
func TestClientGolden(t *testing.T) {
	cases := loadClientGolden(t)
	if len(cases) < 90 {
		t.Fatalf("golden has only %d cases", len(cases))
	}
	ctx := context.Background()
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			api := &fakeKiteAPI{responses: append([]clientResponse(nil), c.Responses...)}
			srv := httptest.NewServer(api)
			defer srv.Close()
			client, err := NewClient(Config{APIKey: c.APIKey, APISecret: c.APISecret, APIRoot: srv.URL,
				HistoricalGate: NewHistoricalGate(0, 5*time.Second)})
			if err == nil && c.Session != nil {
				client.SetAccessToken(*c.Session)
			}
			var got any // Go result to compare as generic JSON with Node's `json`
			compare := true
			if err == nil {
				switch c.Call {
				case "getLoginUrl":
					got = client.LoginURL()
				case "generateSession":
					var s SessionData
					if s, err = client.GenerateSession(ctx, arg(t, c, 0, "")); err == nil {
						compare = false
						if string(s.Raw) != *c.JSON {
							t.Fatalf("session data\n got %s\nwant %s", s.Raw, *c.JSON)
						}
						if s.AccessToken != client.AccessToken() {
							t.Fatalf("returned token %q, held %q", s.AccessToken, client.AccessToken())
						}
					}
				case "getProfile":
					var p json.RawMessage
					if p, err = client.GetProfile(ctx); err == nil {
						compare = false
						if string(p) != *c.JSON {
							t.Fatalf("profile\n got %s\nwant %s", p, *c.JSON)
						}
					}
				case "getQuoteOhlc":
					var q []OhlcQuote
					if q, err = client.GetQuoteOhlc(ctx, arg(t, c, 0, []string{})); err == nil {
						compare = false
						if want := ohlcFromNode(t, c.Result); !reflect.DeepEqual(q, want) {
							t.Fatalf("ohlc\n got %+v\nwant %+v", q, want)
						}
					}
				case "getQuoteFull":
					got, err = client.GetQuoteFull(ctx, arg(t, c, 0, []string{}))
				case "getQuoteFullOhlc":
					got, err = client.GetQuoteFullOhlc(ctx, arg(t, c, 0, []string{}))
				case "getQuoteDepth":
					var m map[int64]QuoteDepth
					if m, err = client.GetQuoteDepth(ctx, arg(t, c, 0, []string{})); err == nil {
						compare = false
						if g, w := generic(t, mustJSON(t, m)), nodeMap(t, c.Result); !reflect.DeepEqual(g, w) {
							t.Fatalf("depth\n got %v\nwant %v", g, w)
						}
					}
				case "getQuoteLadder":
					var m map[int64]QuoteLadder
					if m, err = client.GetQuoteLadder(ctx, arg(t, c, 0, []string{})); err == nil {
						compare = false
						// Go levels carry Orders (always 0 for REST); Node's had price and qty.
						// The ladder only feeds bestPrice and is never sent to a client.
						for _, l := range m {
							for _, lv := range append(append([]any{}, toAny(l.Bids)...), toAny(l.Asks)...) {
								if lv.(map[string]any)["orders"] != 0.0 {
									t.Fatal("REST ladder level with an order count")
								}
							}
						}
						g := generic(t, mustJSON(t, m))
						for _, l := range g.(map[string]any) {
							for _, side := range []string{"bids", "asks"} {
								for _, lv := range l.(map[string]any)[side].([]any) {
									delete(lv.(map[string]any), "orders")
								}
							}
						}
						if w := nodeMap(t, c.Result); !reflect.DeepEqual(g, w) {
							t.Fatalf("ladder\n got %v\nwant %v", g, w)
						}
					}
				case "getBasketMargin":
					opts := arg(t, c, 1, struct {
						ConsiderPositions *bool `json:"considerPositions"`
					}{})
					considerPositions := opts.ConsiderPositions == nil || *opts.ConsiderPositions // !== false
					got, err = client.GetBasketMargin(ctx, arg(t, c, 0, []BasketOrder{}), considerPositions)
				case "getOrderCharges":
					var rows []OrderCharges
					if rows, err = client.GetOrderCharges(ctx, arg(t, c, 0, []ChargeOrder{})); err == nil {
						got = rows
						if len(rows) != len(c.Raws) {
							t.Fatalf("%d rows, want %d", len(rows), len(c.Raws))
						}
						for i, r := range rows {
							if string(r.Raw) != c.Raws[i] {
								t.Fatalf("row %d raw charges\n got %s\nwant %s", i, r.Raw, c.Raws[i])
							}
						}
					}
				case "getHistoricalOi":
					got, err = client.GetHistoricalOi(ctx, arg(t, c, 0, int64(0)), arg(t, c, 1, ""), arg(t, c, 2, ""),
						HistoricalPriority(arg(t, c, 3, "interactive")))
				case "getHistoricalFull":
					got, err = client.GetHistoricalFull(ctx, arg(t, c, 0, int64(0)), arg(t, c, 1, ""), arg(t, c, 2, ""),
						arg(t, c, 3, "day"), HistoricalPriority(arg(t, c, 4, "interactive")))
				case "getHistorical":
					got, err = client.GetHistorical(ctx, arg(t, c, 0, int64(0)), arg(t, c, 1, ""), arg(t, c, 2, ""),
						arg(t, c, 3, ""), HistoricalPriority(arg(t, c, 4, "interactive")))
				case "getHistoricalOiSeries":
					got, err = client.GetHistoricalOiSeries(ctx, arg(t, c, 0, int64(0)), arg(t, c, 1, ""), arg(t, c, 2, ""),
						arg(t, c, 3, ""), HistoricalPriority(arg(t, c, 4, "interactive")))
				case "getInstruments":
					got, err = client.GetInstruments(ctx, arg(t, c, 0, ""))
				default:
					t.Fatalf("unknown call %q", c.Call)
				}
			}

			api.mu.Lock()
			requests := api.requests
			api.mu.Unlock()
			if len(requests) != len(c.Requests) {
				t.Fatalf("%d requests, want %d: %+v", len(requests), len(c.Requests), requests)
			}
			for i, w := range c.Requests {
				g := requests[i]
				want := map[string]string{}
				for k, v := range w.Headers {
					want[http.CanonicalHeaderKey(k)] = v
				}
				if g.Method != w.Method || g.URL != w.URL || g.Body != w.Body || !reflect.DeepEqual(g.Headers, want) {
					t.Fatalf("request %d\n got %s %s %v %q\nwant %s %s %v %q", i, g.Method, g.URL, g.Headers, g.Body, w.Method, w.URL, want, w.Body)
				}
			}

			if c.Error != nil {
				if err == nil {
					t.Fatalf("no error, want %s %q", c.Error.Name, c.Error.Message)
				}
				if err.Error() != c.Error.Message {
					t.Fatalf("error %q, want %q", err.Error(), c.Error.Message)
				}
				var ke *KiteError
				var re *ResponseError
				switch c.Error.Name {
				case "KiteError":
					if !errors.As(err, &ke) || c.Error.Status == nil || ke.Status != *c.Error.Status {
						t.Fatalf("error %T %+v, want KiteError status %v", err, err, c.Error.Status)
					}
				case "SyntaxError", "TypeError":
					if !errors.As(err, &re) {
						t.Fatalf("error %T, want ResponseError (Node %s)", err, c.Error.Name)
					}
				default:
					t.Fatalf("unexpected Node error class %s", c.Error.Name)
				}
			} else {
				if err != nil {
					t.Fatalf("error %v, want success", err)
				}
				if compare {
					if c.JSON == nil {
						t.Fatal("golden has no result")
					}
					if g, w := generic(t, jsJSON(got)), generic(t, []byte(*c.JSON)); !reflect.DeepEqual(g, w) {
						t.Fatalf("result\n got %s\nwant %s", jsJSON(got), *c.JSON)
					}
				}
			}

			if client != nil {
				var after any
				if err := json.Unmarshal(c.After, &after); err != nil {
					t.Fatal(err)
				}
				switch a := after.(type) {
				case nil:
					if client.HasSession() {
						t.Fatalf("session %q kept, Node cleared it", client.AccessToken())
					}
				case string:
					if !client.HasSession() || client.AccessToken() != a {
						t.Fatalf("session %v %q, want %q", client.HasSession(), client.AccessToken(), a)
					}
				case float64:
					if client.AccessToken() != jsjson.FormatNumber(a) {
						t.Fatalf("session %q, want String(%v)", client.AccessToken(), a)
					}
				default:
					t.Fatalf("unexpected session %v", a)
				}
			}
		})
	}
}

func toAny[T any](s []T) []any {
	out := make([]any, len(s))
	for i, v := range s {
		b, _ := json.Marshal(v)
		var m any
		_ = json.Unmarshal(b, &m)
		out[i] = m
	}
	return out
}

// TestClientDefaults checks the production defaults (the golden test always passes an
// APIRoot, so it never reaches the real hosts).
func TestClientDefaults(t *testing.T) {
	c, err := NewClient(Config{APIKey: "k", APISecret: "s"})
	if err != nil {
		t.Fatal(err)
	}
	if c.apiRoot != DefaultAPIRoot || c.loginRoot != DefaultLoginRoot || c.gate != defaultGate {
		t.Fatalf("defaults %q %q", c.apiRoot, c.loginRoot)
	}
	if c.HasSession() || c.AccessToken() != "" {
		t.Fatalf("fresh client has session %v %q", c.HasSession(), c.AccessToken())
	}
}
