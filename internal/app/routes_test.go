package app

import (
	"encoding/json"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// inventoryRoutes independently pins the 83 non-Box method+path pairs. The
// frozen source inventory below must agree; neither missing file is a skip.
var inventoryRoutes = []string{
	"GET /", "GET /api/status",
	"POST /api/admin/verify", "POST /api/access/verify", "GET /api/admin/status",
	"GET /login", "GET /api/login", "POST /api/session", "GET /callback", "POST /api/logout",
	"GET /api/kite/access-token", "GET /api/kite/token", "GET /api/internal/kite-token", "GET /api/profile",
	"POST /api/rf", "GET /api/rf/current", "GET /api/rf",
	"POST /api/quotes", "GET /api/quotes", "POST /api/stream/session", "GET /api/stream/session/:id",
	"GET /api/stream", "GET /api/market-data/status", "GET /api/market-data/diagnostics",
	"GET /api/instruments", "GET /api/fno-stocks", "GET /api/fno-stocks/:symbol", "GET /api/fno-board",
	"GET /api/dividends", "GET /api/debug/indices",
	"GET /api/history/:symbol", "GET /api/spread-history/:symbol", "GET /api/intraday/:symbol",
	"GET /api/minute/:symbol", "GET /api/fivemin/:symbol",
	"GET /api/option-chain/:underlying", "GET /api/option-oi-baseline/:underlying",
	"GET /api/option-prev-close/:underlying", "GET /api/option-oi-series/:underlying",
	"GET /api/option-oi-frame/:underlying", "GET /api/futures-oi-frame/:underlying", "GET /api/spread-stats/:symbol",
	"POST /api/trades", "GET /api/trades", "POST /api/trades/:id/close", "DELETE /api/trades/:id",
	"GET /api/broker/status", "GET /api/broker/switch-blockers", "POST /api/broker/select",
	"POST /api/dhan/login", "POST /api/dhan/session", "GET /api/dhan/status", "POST /api/dhan/verify-ip",
	"GET /api/dhan/instruments/diagnostics", "POST /api/dhan/logout", "POST /api/dhan/postback",
	"GET /api/dhan/access-token", "GET /api/dhan/token",
	"GET /api/synthetic/status", "POST /api/synthetic/start", "POST /api/synthetic/stop",
	"POST /api/synthetic/strike-level", "POST /api/synthetic/settings", "GET /api/synthetic/opportunities",
	"GET /api/synthetic/trades/open", "GET /api/synthetic/trades/history", "POST /api/synthetic/trades/:id/close",
	"DELETE /api/synthetic/trades/:id", "GET /api/synthetic/chain/:underlying", "GET /api/synthetic/stream",
	"GET /api/fair-value/status", "GET /api/fair-value/config", "PATCH /api/fair-value/config",
	"GET /api/fair-value/underlyings", "GET /api/fair-value/snapshot/:underlying", "POST /api/fair-value/refresh",
	"POST /api/fair-value/pause", "POST /api/fair-value/calculate", "POST /api/fair-value/independent",
	"GET /api/fair-value/history/:underlying", "GET /api/fair-value/history/:underlying/:id",
	"GET /api/fair-value/export/:underlying", "GET /api/fair-value/stream",
}

// readInventory uses the frozen registrations captured from the original Node
// source before its retirement, rather than parsing optional planning documents.
func readInventory(t *testing.T) (routes []string, fromDoc bool) {
	data, err := os.ReadFile("../parity/testdata/routes.json")
	if err != nil {
		t.Fatal(err)
	}
	var reference struct {
		ReferenceCommit string                                  `json:"reference_commit"`
		Routes          []struct{ Method, Path, Source string } `json:"routes"`
	}
	if err := json.Unmarshal(data, &reference); err != nil {
		t.Fatal(err)
	}
	if reference.ReferenceCommit != "1ea1d958ebf5c4a0fc673d786f5ee9638bdffa8d" || len(reference.Routes) != 83 {
		t.Fatal("the original route specification changed")
	}
	for _, route := range reference.Routes {
		routes = append(routes, route.Method+" "+route.Path)
	}
	want := append([]string(nil), inventoryRoutes...)
	got := append([]string(nil), routes...)
	sort.Strings(want)
	sort.Strings(got)
	if strings.Join(want, "\n") != strings.Join(got, "\n") {
		t.Fatal("the frozen source registrations disagree with the independent inventory")
	}
	return routes, true
}

var paramName = regexp.MustCompile(`:[A-Za-z_]+|\{[^}]*\}`)

// normalise maps Express ":name" and chi "{name}" parameters to "{}".
func normalise(route string) string { return paramName.ReplaceAllString(route, "{}") }

// concrete fills parameters with sample values for a real lookup.
func concrete(path string) string { return paramName.ReplaceAllString(path, "X1") }

func TestRouteInventoryMatchesNodeWithoutBox(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	mux, ok := h.app.Handler().(*chi.Mux)
	if !ok {
		t.Fatalf("Handler is %T, want *chi.Mux", h.app.Handler())
	}
	mounted := map[string]bool{}
	if err := chi.Walk(mux, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		route = strings.TrimSuffix(strings.ReplaceAll(route, "/*/", "/"), "/*")
		if route != "/" {
			route = strings.TrimSuffix(route, "/")
		}
		mounted[method+" "+normalise(route)] = true
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	want, fromDoc := readInventory(t)
	box, matched := 0, 0
	var unmatched []string
	for _, r := range want {
		method, path, _ := strings.Cut(r, " ")
		if path == "/api/box" || strings.HasPrefix(path, "/api/box/") {
			box++
			continue
		}
		key := method + " " + normalise(path)
		if !mounted[key] {
			unmatched = append(unmatched, r+" (not mounted)")
			continue
		}
		// The pattern must also win for a real path through the mounted routers.
		found := mux.Find(chi.NewRouteContext(), method, concrete(path))
		if len(found) > 1 {
			found = strings.TrimSuffix(found, "/")
		}
		if normalise(found) != normalise(path) {
			unmatched = append(unmatched, r+" (resolves to "+found+")")
			continue
		}
		matched++
	}
	if len(unmatched) > 0 {
		t.Errorf("api.md routes not served by Go:\n  %s", strings.Join(unmatched, "\n  "))
	}
	if !fromDoc || matched != 83 || box != 0 {
		t.Errorf("frozen reference gave %d non-Box and %d Box routes, want 83 and 0", matched, box)
	}
	var boxRoutes, extra []string
	for k := range mounted {
		_, path, _ := strings.Cut(k, " ")
		if path == "/api/box" || strings.HasPrefix(path, "/api/box/") {
			boxRoutes = append(boxRoutes, k)
		}
	}
	listed := map[string]bool{}
	for _, r := range want {
		method, path, _ := strings.Cut(r, " ")
		listed[method+" "+normalise(path)] = true
	}
	for k := range mounted {
		if !listed[k] {
			extra = append(extra, k)
		}
	}
	sort.Strings(extra)
	if len(boxRoutes) > 0 {
		t.Errorf("Box routes are mounted: %v", boxRoutes)
	}
	if len(extra) > 0 {
		t.Errorf("routes mounted that api.md does not list: %v", extra)
	}
	t.Logf("frozen Node reference: %d non-Box routes served; no Box routes mounted", matched)

	// /api/box/* answers like any unknown route: Express's HTML 404, after the global
	// limiter and with the CORS headers.
	for _, c := range []struct{ method, path string }{
		{"GET", "/api/box/status"}, {"POST", "/api/box/start"}, {"GET", "/api/box/stream"}, {"DELETE", "/api/box/trades/abc"},
	} {
		r := h.do(c.method, c.path, "", "")
		page := "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot " +
			c.method + " " + c.path + "</pre>\n</body>\n</html>\n"
		expect(t, c.method+" "+c.path, r, 404, page)
		if got := r.header.Get("Access-Control-Allow-Origin"); got != testFrontend {
			t.Errorf("%s %s: Access-Control-Allow-Origin %q", c.method, c.path, got)
		}
	}
}
