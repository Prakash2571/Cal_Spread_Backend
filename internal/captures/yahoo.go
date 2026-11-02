package captures

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
)

// Port of src/yahoo.ts: a minimal, unofficial Yahoo Finance client for trailing dividend
// yields. Every failure degrades to a 0 % yield.

const (
	// DefaultYahooChartRoot is yahoo.ts CHART_ROOT.
	DefaultYahooChartRoot = "https://query1.finance.yahoo.com/v8/finance/chart"
	// YahooUserAgent is the browser User-Agent yahoo.ts sends.
	YahooUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
		"(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
	// YahooTimeout is AbortSignal.timeout(6000); it covers the request and the body.
	YahooTimeout = 6 * time.Second
	// DefaultYahooConcurrency is getDividendYields' default concurrency.
	DefaultYahooConcurrency = 6
)

// Yahoo fetches dividend yields. The zero value is not usable; use NewYahoo.
type Yahoo struct {
	// ChartRoot replaces CHART_ROOT (tests point it at an httptest server).
	ChartRoot string
	Client    *http.Client
	Timeout   time.Duration
	Now       func() time.Time
}

// NewYahoo returns a client for chartRoot ("" = Yahoo). client and now may be nil.
func NewYahoo(chartRoot string, client *http.Client, now func() time.Time) *Yahoo {
	if chartRoot == "" {
		chartRoot = DefaultYahooChartRoot
	}
	if client == nil {
		// No keep-alive: Go silently replays an idempotent request when a reused
		// connection dies, Node's fetch does not, and Yahoo is only called occasionally.
		client = &http.Client{Transport: &http.Transport{DisableKeepAlives: true, Proxy: http.ProxyFromEnvironment}}
	}
	if now == nil {
		now = time.Now
	}
	return &Yahoo{ChartRoot: chartRoot, Client: client, Timeout: YahooTimeout, Now: now}
}

// FetchYieldPct is fetchYieldPct: the annual trailing dividend yield (%) of one NSE
// trading symbol, or 0 on any failure. The result is unrounded and, for pathological
// payloads (a non-numeric price), can be NaN or ±Inf exactly where Node produced them;
// JSON encoders must write those as null like JSON.stringify.
func (y *Yahoo) FetchYieldPct(ctx context.Context, nseSymbol string) float64 {
	enc, ok := encodeURIComponent(nseSymbol)
	if !ok {
		return 0 // encodeURIComponent throws; getDividendYields' catch maps it to 0
	}
	url := y.ChartRoot + "/" + enc + ".NS" + "?range=1y&interval=1mo&events=div"

	timeout := y.Timeout
	if timeout <= 0 {
		timeout = YahooTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0
	}
	req.Header.Set("User-Agent", YahooUserAgent)
	req.Header.Set("Accept", "application/json")
	res, err := y.Client.Do(req)
	if err != nil {
		return 0 // timeout / network error
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return 0
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return 0 // body aborted by the timeout: res.json() rejects
	}
	doc, err := parseJSON(body)
	if err != nil {
		return 0
	}
	if doc == nil {
		return 0 // json.chart on null throws; the caller's catch maps it to 0
	}

	result := jsOptGet(jsOptGet(jsGet(doc, "chart"), "result"), "0")
	if !jsTruthy(result) {
		return 0
	}
	meta := jsGet(result, "meta")
	price := jsOptGet(meta, "regularMarketPrice")
	if jsNullish(price) {
		price = jsOptGet(meta, "chartPreviousClose")
	}
	if !jsTruthy(price) || jsToNumber(price) <= 0 {
		return 0
	}

	dividends := jsOptGet(jsGet(result, "events"), "dividends")
	if jsNullish(dividends) {
		dividends = &jsObject{}
	}
	cutoff := float64(y.Now().UnixMilli())/1000 - 365*86400
	sum := 0.0
	for _, key := range jsObjectKeys(dividends) {
		d := jsGet(dividends, key)
		when := jsOptGet(d, "date")
		if jsNullish(when) {
			n, ok := jsx.ParseNumber(key)
			if !ok {
				n = math.NaN()
			}
			when = n
		}
		amount, isNum := jsGet(d, "amount").(float64)
		if jsTruthy(d) && isNum && jsToNumber(when) >= cutoff {
			sum += amount
		}
	}
	return (sum / jsToNumber(price)) * 100
}

// GetDividendYields is getDividendYields: yields (%) for many symbols with
// min(concurrency, len(symbols)) workers sharing one cursor. Empty symbols are skipped;
// failures map to 0. (Node returned an object in completion order; a map has none.)
func (y *Yahoo) GetDividendYields(ctx context.Context, symbols []string, concurrency int) map[string]float64 {
	out := map[string]float64{}
	workers := concurrency
	if len(symbols) < workers {
		workers = len(symbols)
	}
	var (
		mu     sync.Mutex
		cursor int
		wg     sync.WaitGroup
	)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				mu.Lock()
				if cursor >= len(symbols) {
					mu.Unlock()
					return
				}
				symbol := symbols[cursor]
				cursor++
				mu.Unlock()
				if symbol == "" {
					continue
				}
				v := y.FetchYieldPct(ctx, symbol)
				mu.Lock()
				out[symbol] = v
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	return out
}

// ---------------------------------------------------------------------------------------
// JSON.parse with JavaScript value semantics, just enough for the chart payload.

// jsUndefined is the JavaScript undefined value (distinct from JSON null = nil).
type jsUndefinedT struct{}

var jsUndefined any = jsUndefinedT{}

// jsObject keeps property insertion order (JSON.parse: a duplicate key keeps its first
// position and takes the last value).
type jsObject struct {
	keys []string
	vals map[string]any
}

var errTrailingJSON = errors.New("unexpected data after JSON value")

// parseJSON is Response.json(): a UTF-8 BOM is stripped, then exactly one JSON value.
// Numbers are float64 (out-of-range literals become ±Inf or 0 as in JavaScript).
func parseJSON(body []byte) (any, error) {
	body = bytes.TrimPrefix(body, []byte("\xEF\xBB\xBF"))
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	v, err := parseJSONValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errTrailingJSON
	}
	return v, nil
}

func parseJSONValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			obj := &jsObject{vals: map[string]any{}}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, _ := kt.(string)
				v, err := parseJSONValue(dec)
				if err != nil {
					return nil, err
				}
				if _, seen := obj.vals[key]; !seen {
					obj.keys = append(obj.keys, key)
				}
				obj.vals[key] = v
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return obj, nil
		case '[':
			arr := []any{}
			for dec.More() {
				v, err := parseJSONValue(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return arr, nil
		}
		return nil, errors.New("unexpected delimiter")
	case json.Number:
		f, err := strconv.ParseFloat(string(t), 64)
		if err != nil {
			var ne *strconv.NumError
			if !errors.As(err, &ne) || ne.Err != strconv.ErrRange {
				return nil, err
			}
		}
		return f, nil
	default: // string, bool, nil
		return t, nil
	}
}

func jsNullish(v any) bool { return v == nil || v == jsUndefined }

// jsArrayIndex reports whether key is a canonical array index (0 .. 2^32-2).
func jsArrayIndex(key string) (uint64, bool) {
	if key == "" || len(key) > 10 || (len(key) > 1 && key[0] == '0') {
		return 0, false
	}
	n, err := strconv.ParseUint(key, 10, 64)
	if err != nil || n > 4294967294 {
		return 0, false
	}
	return n, true
}

// jsGet is v[key] for a non-nullish v (property reads on null are handled by callers).
func jsGet(v any, key string) any {
	switch t := v.(type) {
	case *jsObject:
		if x, ok := t.vals[key]; ok {
			return x
		}
	case []any:
		if key == "length" {
			return float64(len(t))
		}
		if i, ok := jsArrayIndex(key); ok && i < uint64(len(t)) {
			return t[i]
		}
	case string:
		if key == "length" {
			return float64(len(t))
		}
		if i, ok := jsArrayIndex(key); ok && i < uint64(len(t)) {
			return t[i : i+1]
		}
	}
	return jsUndefined
}

// jsOptGet is v?.[key].
func jsOptGet(v any, key string) any {
	if jsNullish(v) {
		return jsUndefined
	}
	return jsGet(v, key)
}

// jsObjectKeys is Object.keys(v): array-index keys ascending, then the other keys in
// insertion order. Primitives other than strings have no own keys.
func jsObjectKeys(v any) []string {
	switch t := v.(type) {
	case *jsObject:
		var idx []string
		var named []string
		for _, k := range t.keys {
			if _, ok := jsArrayIndex(k); ok {
				idx = append(idx, k)
			} else {
				named = append(named, k)
			}
		}
		sort.SliceStable(idx, func(i, j int) bool {
			a, _ := jsArrayIndex(idx[i])
			b, _ := jsArrayIndex(idx[j])
			return a < b
		})
		return append(idx, named...)
	case []any:
		keys := make([]string, len(t))
		for i := range t {
			keys[i] = strconv.Itoa(i)
		}
		return keys
	case string:
		keys := make([]string, len(t))
		for i := range keys {
			keys[i] = strconv.Itoa(i)
		}
		return keys
	}
	return nil
}

// jsTruthy is Boolean(v).
func jsTruthy(v any) bool {
	switch t := v.(type) {
	case nil, jsUndefinedT:
		return false
	case bool:
		return t
	case float64:
		return t != 0 && !math.IsNaN(t)
	case string:
		return t != ""
	}
	return true // objects and arrays
}

// jsToNumber is ToNumber(ToPrimitive(v)) as used by arithmetic and relational operators.
func jsToNumber(v any) float64 {
	switch t := v.(type) {
	case nil:
		return 0
	case jsUndefinedT:
		return math.NaN()
	case bool:
		if t {
			return 1
		}
		return 0
	case float64:
		return t
	case string:
		n, ok := jsx.ParseNumber(t)
		if !ok {
			return math.NaN()
		}
		return n
	case []any:
		// String(array) joins with ","; two or more items always leave a comma.
		switch len(t) {
		case 0:
			return 0
		case 1:
			if jsNullish(t[0]) {
				return 0
			}
			if _, ok := t[0].(bool); ok {
				return math.NaN() // "true" / "false"
			}
			return jsToNumber(t[0])
		}
		return math.NaN()
	}
	return math.NaN() // "[object Object]"
}
