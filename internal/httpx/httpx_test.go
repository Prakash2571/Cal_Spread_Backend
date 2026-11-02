package httpx_test

import (
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
)

func do(h http.Handler, method, path, ct, body string, hdr ...string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if ct != "" {
		r.Header.Set("Content-Type", ct)
	}
	for i := 0; i+1 < len(hdr); i += 2 {
		r.Header.Add(hdr[i], hdr[i+1])
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestJSONIsCompactUnescapedNoNewline(t *testing.T) {
	w := httptest.NewRecorder()
	httpx.JSON(w, 200, map[string]any{"a": "<b>&", "n": 1.5})
	if got := w.Body.String(); got != `{"a":"<b>&","n":1.5}` {
		t.Fatalf("body = %q", got)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Fatalf("content-type = %q", ct)
	}
	w = httptest.NewRecorder()
	httpx.JSON(w, 200, map[string]any{"bad": math.NaN(), "inf": math.Inf(-1), "negzero": math.Copysign(0, -1), "small": 1e-7, "big": 1e21})
	if w.Code != 200 || w.Body.String() != `{"bad":null,"big":1e+21,"inf":null,"negzero":0,"small":1e-7}` {
		t.Fatalf("JSON.stringify numbers: %d %q", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	httpx.JSON(w, 200, struct {
		List  []int  `json:"list"`
		Skip  int    `json:"skip,omitempty"`
		Keep  int    `json:"keep"`
		Maybe *int   `json:"maybe"`
		Gone  string `json:"gone,omitempty"`
	}{})
	if got := w.Body.String(); got != `{"list":[],"keep":0,"maybe":null}` {
		t.Fatalf("struct = %q", got)
	}
}

func TestCORSHeadersAndPreflight(t *testing.T) {
	h := httpx.CORS("http://localhost:5173")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	w := do(h, "OPTIONS", "/anything/at/all", "", "")
	if w.Code != 204 || w.Body.Len() != 0 {
		t.Fatalf("OPTIONS: %d %q", w.Code, w.Body.String())
	}
	for k, v := range map[string]string{
		"Access-Control-Allow-Origin":      "http://localhost:5173",
		"Access-Control-Allow-Methods":     "GET,POST,PATCH,DELETE,OPTIONS",
		"Access-Control-Allow-Headers":     "Content-Type, x-admin-token",
		"Access-Control-Allow-Credentials": "true",
		"Cache-Control":                    "no-store",
	} {
		if got := w.Header().Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	if got := do(h, "GET", "/x", "", "").Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("GET Cache-Control = %q", got)
	}
}

func TestParseBody(t *testing.T) {
	var seen any
	var present bool
	h := httpx.ParseBody(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = httpx.Body(r)
		present = seen != nil
		w.WriteHeader(200)
	}))
	cases := []struct {
		name, ct, body string
		code           int
		wantPresent    bool
	}{
		{"object", "application/json", `{"secret":"x"}`, 200, true},
		{"charset param", "application/json; charset=utf-8", `{"a":1}`, 200, true},
		{"array", "application/json", `[1,2]`, 200, true},
		{"zero-length json body reads as {}", "application/json", ``, 200, true},
		{"whitespace body reads as {}", "application/json", "  \n", 200, true},
		{"not json content type is ignored", "text/plain", `{"a":1}`, 200, false},
		{"no content type is ignored", "", `{"a":1}`, 200, false},
		{"malformed", "application/json", `{"a":`, 400, false},
		{"strict: bare string rejected", "application/json", `"hi"`, 400, false},
		{"strict: number rejected", "application/json", `5`, 400, false},
	}
	for _, c := range cases {
		seen, present = nil, false
		w := do(h, "POST", "/x", c.ct, c.body)
		if w.Code != c.code {
			t.Errorf("%s: status %d, want %d", c.name, w.Code, c.code)
		}
		if c.code == 200 && present != c.wantPresent {
			t.Errorf("%s: body present = %v, want %v", c.name, present, c.wantPresent)
		}
		if c.code != 200 && !strings.HasPrefix(w.Header().Get("Content-Type"), "text/html") {
			t.Errorf("%s: error page must be HTML, got %q", c.name, w.Header().Get("Content-Type"))
		}
	}
}

func TestParseBodyLimit(t *testing.T) {
	h := httpx.ParseBody(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	ok := `{"x":"` + strings.Repeat("a", httpx.MaxBodyBytes-10) + `"}`
	if w := do(h, "POST", "/x", "application/json", ok); w.Code != 200 {
		t.Fatalf("body just under 100 kB: %d", w.Code)
	}
	big := `{"x":"` + strings.Repeat("a", httpx.MaxBodyBytes) + `"}`
	if w := do(h, "POST", "/x", "application/json", big); w.Code != 413 {
		t.Fatalf("body over 100 kB: %d, want 413", w.Code)
	}
	// Unknown length (chunked) is limited too.
	r := httptest.NewRequest("POST", "/x", io.MultiReader(strings.NewReader(big)))
	r.ContentLength = -1
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 413 {
		t.Fatalf("chunked oversized body: %d, want 413", w.Code)
	}
}

func TestNotFoundAndRecoverer(t *testing.T) {
	w := httptest.NewRecorder()
	httpx.NotFound(w, httptest.NewRequest("GET", "/api/nope<x>", nil))
	if w.Code != 404 || !strings.Contains(w.Body.String(), "<pre>Cannot GET /api/nope&lt;x&gt;</pre>") {
		t.Fatalf("404 page: %d %q", w.Code, w.Body.String())
	}
	h := httpx.Recoverer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { panic("boom") }))
	if w := do(h, "GET", "/x", "", ""); w.Code != 500 || !strings.Contains(w.Body.String(), "Internal Server Error") {
		t.Fatalf("panic: %d %q", w.Code, w.Body.String())
	}
}

func TestClientIPAndAdminToken(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "10.1.2.3:5555"
	if got := httpx.ClientIP(r); got != "10.1.2.3" {
		t.Errorf("peer ip = %q", got)
	}
	r.Header.Set("X-Forwarded-For", " 203.0.113.9 , 70.41.3.18")
	if got := httpx.ClientIP(r); got != "203.0.113.9" {
		t.Errorf("first XFF entry = %q", got)
	}
	r.Header.Set("X-Forwarded-For", " , 70.41.3.18")
	if got := httpx.ClientIP(r); got != "10.1.2.3" {
		t.Errorf("empty first XFF entry falls back to peer, got %q", got)
	}
	r.Header.Add("X-Admin-Token", "a")
	r.Header.Add("X-Admin-Token", "b")
	if got := httpx.AdminToken(r); got != "a, b" {
		t.Errorf("repeated header = %q", got)
	}
}

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func TestLimiterFixedWindow(t *testing.T) {
	clk := &clock{t: time.UnixMilli(1_000_000)}
	l := httpx.NewLimiter(time.Minute, 3, "slow down", clk.now)
	h := l.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	req := func(ip string) *httptest.ResponseRecorder {
		return do(h, "GET", "/x", "", "", "X-Forwarded-For", ip)
	}
	for i := 1; i <= 3; i++ {
		if w := req("1.1.1.1"); w.Code != 200 {
			t.Fatalf("request %d: %d", i, w.Code)
		}
	}
	clk.add(20 * time.Second)
	w := req("1.1.1.1") // 4th request, 40 s left in the window
	if w.Code != 429 || w.Header().Get("Retry-After") != "40" || w.Body.String() != `{"error":"slow down"}` {
		t.Fatalf("4th: %d retry=%q body=%q", w.Code, w.Header().Get("Retry-After"), w.Body.String())
	}
	if w := req("2.2.2.2"); w.Code != 200 {
		t.Fatalf("other client unaffected: %d", w.Code)
	}
	// Window anchored at the first request: at exactly resetAt the old window still applies.
	clk.add(40 * time.Second)
	if w := req("1.1.1.1"); w.Code != 429 {
		t.Fatalf("on the boundary ms the old window still applies, got %d", w.Code)
	}
	clk.add(time.Millisecond)
	if w := req("1.1.1.1"); w.Code != 200 {
		t.Fatalf("after the window: %d", w.Code)
	}
}

func TestLimiterRetryAfterRoundsUpAndDefaultMessage(t *testing.T) {
	clk := &clock{t: time.UnixMilli(5_000)}
	l := httpx.NewLimiter(10*time.Second, 1, "", clk.now)
	l.Allow("a")
	clk.add(9500 * time.Millisecond)
	ok, retry := l.Allow("a")
	if ok || retry != 1 {
		t.Fatalf("ok=%v retry=%d (500 ms left rounds up to 1)", ok, retry)
	}
	h := l.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	w := do(h, "GET", "/", "", "", "X-Forwarded-For", "a")
	if w.Body.String() != `{"error":"Too many requests. Please slow down."}` {
		t.Fatalf("default message body = %q", w.Body.String())
	}
}

func TestLimiterSweepsExpiredBuckets(t *testing.T) {
	clk := &clock{t: time.UnixMilli(0)}
	l := httpx.NewLimiter(time.Second, 1, "", clk.now)
	for i := 0; i < 100; i++ {
		l.Allow(string(rune('a' + i%26)))
	}
	clk.add(3 * time.Second)
	l.Allow("fresh")
	if ok, _ := l.Allow("a"); !ok {
		t.Fatal("an expired bucket must start a new window")
	}
}

func TestCoercions(t *testing.T) {
	cases := []struct {
		in   any
		want float64
	}{
		{nil, 0}, {true, 1}, {false, 0}, {12.5, 12.5}, {"7.25", 7.25}, {" 3 ", 3}, {"", 0},
		{[]any{}, 0}, {[]any{"4"}, 4},
	}
	for _, c := range cases {
		if got := httpx.ToNumber(c.in); got != c.want {
			t.Errorf("ToNumber(%#v) = %v, want %v", c.in, got, c.want)
		}
	}
	for _, bad := range []any{"abc", map[string]any{}, []any{1.0, 2.0}} {
		if got := httpx.ToNumber(bad); !math.IsNaN(got) {
			t.Errorf("ToNumber(%#v) = %v, want NaN", bad, got)
		}
	}
	body := map[string]any{"rf": nil, "s": "x", "n": 3.0}
	if !math.IsNaN(httpx.NumberField(body, "missing")) || httpx.NumberField(body, "rf") != 0 {
		t.Error("missing key is NaN, explicit null is 0")
	}
	if httpx.StringField(body, "s") != "x" || httpx.StringField(body, "n") != "" {
		t.Error("StringField only accepts strings")
	}
}
