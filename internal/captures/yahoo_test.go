package captures

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Yahoo dividend yields. The cases in testdata/yahoo.json come from running the original
// src/yahoo.ts fetchYieldPct / getDividendYields under Node with a scripted fetch; the
// Go client is pointed at an httptest server that serves the same bodies and statuses
// and records the exact request line and headers it receives.

type yahooFixture struct {
	Now       string `json:"now"`
	ChartRoot string `json:"chart_root"`
	Cases     []struct {
		Symbol       string `json:"symbol"`
		Body         string `json:"body"`
		Status       int    `json:"status"`
		NetworkError bool   `json:"network_error"`
		Request      *struct {
			Path    string            `json:"path"`
			Headers map[string]string `json:"headers"`
		} `json:"request"`
		Yield any `json:"yield"`
	} `json:"cases"`
	Yields []struct {
		Concurrency int            `json:"concurrency"`
		Symbols     []string       `json:"symbols"`
		Result      map[string]any `json:"result"`
		Requests    []string       `json:"requests"`
	} `json:"yields"`
}

type seenRequest struct {
	uri       string
	userAgent string
	accept    string
}

// yahooServer serves the fixture cases by request URI and records what it receives.
type yahooServer struct {
	*httptest.Server
	mu   sync.Mutex
	seen []seenRequest
}

func newYahooServer(t *testing.T, f *yahooFixture) *yahooServer {
	t.Helper()
	byPath := map[string]int{}
	for i, c := range f.Cases {
		if c.Request != nil {
			byPath[c.Request.Path] = i
		}
	}
	ys := &yahooServer{}
	ys.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ys.mu.Lock()
		ys.seen = append(ys.seen, seenRequest{r.RequestURI, r.Header.Get("User-Agent"), r.Header.Get("Accept")})
		ys.mu.Unlock()
		i, ok := byPath[r.RequestURI]
		if !ok || f.Cases[i].NetworkError {
			if hj, ok := w.(http.Hijacker); ok {
				if conn, _, err := hj.Hijack(); err == nil {
					_ = conn.Close() // connection reset: fetch rejects with "fetch failed"
					return
				}
			}
			http.Error(w, "unexpected", http.StatusTeapot)
			return
		}
		c := f.Cases[i]
		status := c.Status
		if status == 0 {
			status = http.StatusOK
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(c.Body))
	}))
	t.Cleanup(ys.Close)
	return ys
}

func (ys *yahooServer) requests() []seenRequest {
	ys.mu.Lock()
	defer ys.mu.Unlock()
	return append([]seenRequest(nil), ys.seen...)
}

func (ys *yahooServer) reset() {
	ys.mu.Lock()
	ys.seen = nil
	ys.mu.Unlock()
}

func TestYahooFetchYieldMatchesNode(t *testing.T) {
	var f yahooFixture
	readFixture(t, "yahoo.json", &f)
	if len(f.Cases) < 50 {
		t.Fatalf("only %d cases in the fixture", len(f.Cases))
	}
	now := mustTime(t, f.Now)
	ys := newYahooServer(t, &f)
	y := NewYahoo(ys.URL, noKeepAlive(), func() time.Time { return now })

	nonZero := 0
	for _, c := range f.Cases {
		t.Run(c.Symbol, func(t *testing.T) {
			ys.reset()
			got := y.FetchYieldPct(context.Background(), c.Symbol)
			want := fixtureNumber(t, c.Yield)
			if !sameFloat(got, want) {
				t.Errorf("yield = %v, Node %v", got, want)
			}
			reqs := ys.requests()
			if len(reqs) != 1 {
				t.Fatalf("%d requests, want 1", len(reqs))
			}
			if c.Request == nil {
				t.Fatal("fixture has no request")
			}
			if reqs[0].uri != c.Request.Path {
				t.Errorf("request line = %q, Node %q", reqs[0].uri, c.Request.Path)
			}
			if reqs[0].userAgent != c.Request.Headers["User-Agent"] || reqs[0].accept != c.Request.Headers["Accept"] {
				t.Errorf("headers = %q / %q, Node %v", reqs[0].userAgent, reqs[0].accept, c.Request.Headers)
			}
		})
		if v := fixtureNumber(t, c.Yield); v != 0 {
			nonZero++
		}
	}
	if nonZero < 15 {
		t.Fatalf("only %d cases have a non-zero yield; the fixture is not exercising the maths", nonZero)
	}
}

func TestYahooGetDividendYieldsMatchesNode(t *testing.T) {
	var f yahooFixture
	readFixture(t, "yahoo.json", &f)
	now := mustTime(t, f.Now)
	ys := newYahooServer(t, &f)
	y := NewYahoo(ys.URL, noKeepAlive(), func() time.Time { return now })
	if len(f.Yields) != 6 {
		t.Fatalf("fixture has %d concurrency runs", len(f.Yields))
	}
	for _, run := range f.Yields {
		t.Run(fmt.Sprintf("concurrency_%d", run.Concurrency), func(t *testing.T) {
			ys.reset()
			got := y.GetDividendYields(context.Background(), run.Symbols, run.Concurrency)
			if len(got) != len(run.Result) {
				t.Errorf("%d symbols in the result, Node %d", len(got), len(run.Result))
			}
			for sym, wantRaw := range run.Result {
				v, ok := got[sym]
				if !ok {
					t.Errorf("%q missing from the result", sym)
					continue
				}
				if want := fixtureNumber(t, wantRaw); !sameFloat(v, want) {
					t.Errorf("%q = %v, Node %v", sym, v, want)
				}
			}
			var uris []string
			for _, r := range ys.requests() {
				uris = append(uris, r.uri)
			}
			sort.Strings(uris)
			if !slices.Equal(uris, run.Requests) {
				t.Errorf("requests differ: %d vs Node %d\n got:  %v\n Node: %v", len(uris), len(run.Requests), uris, run.Requests)
			}
		})
	}
}

func TestYahooDefaults(t *testing.T) {
	y := NewYahoo("", nil, nil)
	if y.ChartRoot != "https://query1.finance.yahoo.com/v8/finance/chart" {
		t.Errorf("ChartRoot = %q", y.ChartRoot)
	}
	if y.Timeout != 6*time.Second {
		t.Errorf("Timeout = %v, want 6s (AbortSignal.timeout(6000))", y.Timeout)
	}
	if DefaultYahooConcurrency != 6 {
		t.Errorf("DefaultYahooConcurrency = %d", DefaultYahooConcurrency)
	}
	if y.Client == nil || y.Now == nil {
		t.Error("client and clock default to http.DefaultClient / time.Now")
	}
}

const simpleChart = `{"chart":{"result":[{"meta":{"regularMarketPrice":200},"events":{"dividends":{"1":{"amount":3,"date":%d}}}}]}}`

func TestYahooTimeoutCoversHeadersAndBody(t *testing.T) {
	release := make(chan struct{})
	var mode atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch mode.Load() {
		case 0: // never answers
			select {
			case <-release:
			case <-r.Context().Done():
			}
		case 1: // headers and a partial body, then stalls
			w.Header().Set("Content-Length", "1000")
			w.WriteHeader(200)
			_, _ = w.Write([]byte(`{"chart":`))
			w.(http.Flusher).Flush()
			select {
			case <-release:
			case <-r.Context().Done():
			}
		}
	}))
	defer srv.Close()
	defer close(release)

	y := NewYahoo(srv.URL, noKeepAlive(), nil)
	y.Timeout = 80 * time.Millisecond
	for m := int32(0); m < 2; m++ {
		mode.Store(m)
		start := time.Now()
		if got := y.FetchYieldPct(context.Background(), "SLOW"); got != 0 {
			t.Errorf("mode %d: yield = %v, want 0", m, got)
		}
		if d := time.Since(start); d > 3*time.Second {
			t.Errorf("mode %d: took %v; the timeout must bound the whole request", m, d)
		}
	}
}

func TestYahooContextCancel(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(release)
	y := NewYahoo(srv.URL, noKeepAlive(), nil)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(30 * time.Millisecond); cancel() }()
	start := time.Now()
	if got := y.FetchYieldPct(ctx, "X"); got != 0 {
		t.Errorf("yield = %v, want 0", got)
	}
	if time.Since(start) > 3*time.Second {
		t.Error("cancel did not stop the request")
	}
}

func TestYahooConcurrencyIsBounded(t *testing.T) {
	var inflight, peak atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := inflight.Add(1)
		for {
			p := peak.Load()
			if n <= p || peak.CompareAndSwap(p, n) {
				break
			}
		}
		time.Sleep(25 * time.Millisecond)
		inflight.Add(-1)
		_, _ = fmt.Fprintf(w, simpleChart, time.Now().Unix())
	}))
	defer srv.Close()
	y := NewYahoo(srv.URL, noKeepAlive(), nil)

	symbols := make([]string, 30)
	for i := range symbols {
		symbols[i] = fmt.Sprintf("SYM%02d", i)
	}
	got := y.GetDividendYields(context.Background(), symbols, 6)
	if len(got) != 30 {
		t.Fatalf("%d results, want 30", len(got))
	}
	for sym, v := range got {
		if v != 1.5 { // 3 / 200 * 100
			t.Errorf("%s = %v, want 1.5", sym, v)
		}
	}
	if p := peak.Load(); p > 6 || p < 2 {
		t.Errorf("peak concurrency = %d, want 2..6", p)
	}

	// Fewer symbols than workers: only that many run at once.
	peak.Store(0)
	y.GetDividendYields(context.Background(), symbols[:3], 6)
	if p := peak.Load(); p > 3 {
		t.Errorf("peak concurrency = %d with 3 symbols", p)
	}
	if got := y.GetDividendYields(context.Background(), nil, 6); len(got) != 0 {
		t.Errorf("no symbols gave %v", got)
	}
}

func TestServiceDividendYieldsUsesInjectedRoot(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.RequestURI != "/INFY.NS?range=1y&interval=1mo&events=div" {
			t.Errorf("unexpected request %q", r.RequestURI)
		}
		_, _ = fmt.Fprintf(w, simpleChart, time.Now().Unix())
	}))
	defer srv.Close()
	svc := New(Deps{YahooChartRoot: srv.URL, HTTPClient: noKeepAlive(), Logf: (&logSink{}).logf})
	t.Cleanup(func() { svc.Stop() })
	got := svc.DividendYields(context.Background(), []string{"INFY"})
	if len(got) != 1 || got["INFY"] != 1.5 || hits.Load() != 1 {
		t.Errorf("DividendYields = %v after %d request(s)", got, hits.Load())
	}
}

// noKeepAlive returns a client that never reuses connections, so a deliberately reset
// connection is not silently replayed by Go's transport (Node's fetch does not replay).
func noKeepAlive() *http.Client {
	return &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
}
