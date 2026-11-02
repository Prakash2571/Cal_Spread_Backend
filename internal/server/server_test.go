package server_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/server"
)

func newHandler(now func() time.Time) http.Handler {
	return server.New(server.Options{FrontendOrigin: "http://front.example", Now: now}, func(r chi.Router) {
		r.Get("/", func(w http.ResponseWriter, r *http.Request) { httpx.JSON(w, 200, map[string]string{"status": "ok"}) })
		r.Get("/api/ping", func(w http.ResponseWriter, r *http.Request) { httpx.JSON(w, 200, map[string]string{"pong": "yes"}) })
		r.Post("/api/echo", func(w http.ResponseWriter, r *http.Request) { httpx.JSON(w, 200, httpx.BodyObject(r)) })
		r.Get("/api/boom", func(w http.ResponseWriter, r *http.Request) { panic("boom") })
	})
}

func call(h http.Handler, method, target, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestCORSOnEveryResponseKind(t *testing.T) {
	h := newHandler(nil)
	for name, w := range map[string]*httptest.ResponseRecorder{
		"ok":        call(h, "GET", "/api/ping", ""),
		"404":       call(h, "GET", "/nope", ""),
		"bad json":  call(h, "POST", "/api/echo", `{"a":`),
		"panic":     call(h, "GET", "/api/boom", ""),
		"preflight": call(h, "OPTIONS", "/api/ping", ""),
	} {
		if w.Header().Get("Access-Control-Allow-Origin") != "http://front.example" || w.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("%s: missing CORS/no-store headers: %v", name, w.Header())
		}
	}
}

func TestStatusesForUnmatchedAndBrokenRequests(t *testing.T) {
	h := newHandler(nil)
	cases := []struct {
		method, target, body string
		code                 int
	}{
		{"GET", "/api/ping", "", 200},
		{"GET", "/api/ping/", "", 200}, // trailing slash is the same route, as in Express
		{"GET", "/nope", "", 404},
		{"POST", "/api/ping", "", 404}, // wrong method: Express has no route, so 404, not 405
		{"OPTIONS", "/anything", "", 204},
		{"POST", "/api/echo", `{"a":1}`, 200},
		{"POST", "/api/echo", `{"a":`, 400},
		{"POST", "/api/echo", `"just a string"`, 400},            // not an object or array: strict JSON
		{"POST", "/api/echo", strings.Repeat("x", 120_000), 413}, // the size limit is checked before parsing
		{"POST", "/api/echo", `{"x":"` + strings.Repeat("a", 120_000) + `"}`, 413},
		{"GET", "/api/boom", "", 500},
	}
	for _, c := range cases {
		if w := call(h, c.method, c.target, c.body); w.Code != c.code {
			t.Errorf("%s %s: %d, want %d", c.method, c.target, w.Code, c.code)
		}
	}
	if w := call(h, "GET", "/nope", ""); !strings.Contains(w.Body.String(), "Cannot GET /nope") || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/html") {
		t.Errorf("404 body: %q (%s)", w.Body.String(), w.Header().Get("Content-Type"))
	}
	if w := call(h, "POST", "/api/echo", `{"a":1,"b":[true]}`); w.Body.String() != `{"a":1,"b":[true]}` {
		t.Errorf("echo = %s", w.Body)
	}
}

func TestGlobalAPILimiter(t *testing.T) {
	clk := time.UnixMilli(1_000_000)
	h := newHandler(func() time.Time { return clk })
	for i := 1; i <= 150; i++ {
		if w := call(h, "GET", "/api/ping", ""); w.Code != 200 {
			t.Fatalf("request %d: %d", i, w.Code)
		}
	}
	w := call(h, "GET", "/api/ping", "")
	if w.Code != 429 || w.Header().Get("Retry-After") != "60" || w.Body.String() != `{"error":"Too many requests. Please slow down."}` {
		t.Fatalf("151st: %d retry=%q %s", w.Code, w.Header().Get("Retry-After"), w.Body)
	}
	// Unknown /api paths and /api itself are limited too; paths outside /api and OPTIONS are not.
	if w := call(h, "GET", "/api/unknown", ""); w.Code != 429 {
		t.Errorf("unknown /api path: %d", w.Code)
	}
	if w := call(h, "GET", "/", ""); w.Code != 200 {
		t.Errorf("root is not limited: %d", w.Code)
	}
	if w := call(h, "OPTIONS", "/api/ping", ""); w.Code != 204 {
		t.Errorf("preflight is not limited: %d", w.Code)
	}
	clk = clk.Add(61 * time.Second)
	if w := call(h, "GET", "/api/ping", ""); w.Code != 200 {
		t.Errorf("after the window: %d", w.Code)
	}
}
