package app

import (
	"bufio"
	"context"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// Running=false alone cannot prove Boot was skipped: Boot starts a monitoring loop
// even with discovery off. Inspect its lifecycle fields without changing the engine.
func assertSyntheticNeverStarted(t *testing.T, h *harness) {
	t.Helper()
	if h.app.synth == nil {
		t.Fatal("Synthetic must remain constructed for routes and hooks")
	}
	engine := reflect.ValueOf(h.app.synth).Elem()
	if engine.FieldByName("booted").Bool() || !engine.FieldByName("loopStop").IsNil() {
		t.Fatal("Synthetic booted or started its background scanner loop")
	}
	status := h.app.synth.GetStatus()
	if status.Running || status.SubscribedTokens != 0 || status.OpenCount != 0 || status.UniverseAt != nil || status.EvaluatedAt != nil {
		t.Fatalf("Synthetic must stay idle: %+v", status)
	}
	if h.app.reg.BoxSubscriptions().Size() != 0 {
		t.Fatal("disabled Synthetic must never declare live box-lane tokens")
	}
}

func TestSyntheticNeverBootsAndCannotStartThroughMountedRoutes(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	assertSyntheticNeverStarted(t, h)
	h.app.Start(context.Background())
	if h.trace.has("boot: Synthetic boot") {
		t.Fatal("Synthetic boot step is still in the lifecycle")
	}
	h.app.kite.SetAccessToken("live-test-session")
	// Check both authorized roles with a broker session, including the slash alias.
	for _, token := range []string{h.fullToken(), h.tradeToken()} {
		for _, path := range []string{"/api/synthetic/start", "/api/synthetic/start/", "/api/synthetic/start?run=true"} {
			expect(t, "Synthetic start stays disabled", h.do("POST", path, token, ""),
				http.StatusServiceUnavailable, `{"error":"Synthetic is intentionally disabled."}`)
		}
	}
	expect(t, "Synthetic start retains authentication", h.do("POST", "/api/synthetic/start", "", ""),
		http.StatusForbidden, `{"error":"Admin authentication required"}`)
	trade := h.tradeToken()
	for _, route := range []struct {
		method, path, body, contains string
		status                      int
	}{
		{"GET", "/api/synthetic/status", "", `"running":false`, 200},
		{"GET", "/api/synthetic/opportunities", "", `"opportunities":[]`, 200},
		{"GET", "/api/synthetic/trades/open", "", `"open":[]`, 200},
		{"GET", "/api/synthetic/trades/history", "", `"trades":[]`, 200},
		{"GET", "/api/synthetic/chain/NIFTY", "", "NIFTY is not being monitored.", 404},
		{"POST", "/api/synthetic/stop", "", `"running":false`, 200},
		{"POST", "/api/synthetic/strike-level", `{"level":2}`, `"strike_level":2`, 200},
		{"POST", "/api/synthetic/settings", `{"min_expected_net_profit":100}`, `"running":false`, 200},
	} {
		r := h.do(route.method, route.path, trade, route.body)
		if r.status != route.status || !strings.Contains(r.body, route.contains) {
			t.Fatalf("idle %s %s: %d %s", route.method, route.path, r.status, r.body)
		}
	}
	assertSyntheticNeverStarted(t, h)
}

func TestSyntheticHooksAndDisposalAreSafeBeforeBoot(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	assertSyntheticNeverStarted(t, h)
	h.app.synth.Stop()
	h.app.synth.InvalidateBooks()
	h.app.synth.InvalidateNamespace()
	if err := h.app.synth.ReloadUniverse(context.Background()); err != nil {
		t.Fatal(err)
	}
	h.app.synth.OnTicks([]market.Tick{{Token: 1, LastPrice: 100}})
	h.app.synth.Dispose()
	h.app.synth.Dispose()
	if !h.app.synth.WaitIdle(time.Second) {
		t.Fatal("never-booted engine started background work through a lifecycle hook")
	}
	assertSyntheticNeverStarted(t, h)
	trade := h.tradeToken()
	r := h.do("GET", "/api/synthetic/status", trade, "")
	if r.status != 200 || !strings.Contains(r.body, `"running":false`) {
		t.Fatalf("routes after disposal before boot: %d %s", r.status, r.body)
	}
}

func TestSyntheticStreamServesIdleSnapshotWithoutStartingScanner(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	req, err := http.NewRequest("GET", h.base+"/api/synthetic/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Admin-Token", h.tradeToken())
	res, err := h.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("Synthetic stream status %d", res.StatusCode)
	}
	frame := sseFrame(t, bufio.NewReader(res.Body))
	if !strings.Contains(frame, "event: snapshot") || !strings.Contains(frame, `"running":false`) {
		t.Fatalf("idle Synthetic stream: %s", frame)
	}
	assertSyntheticNeverStarted(t, h)
}
