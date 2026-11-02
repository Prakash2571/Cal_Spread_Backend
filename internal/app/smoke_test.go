package app

import (
	"bufio"
	"encoding/json"
	"net/http"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// Requests through the full handler of the assembled App (served on loopback). The
// expected bodies come from reading the TypeScript, and where a stage recorded the same
// state from the original code (registry and market-data goldens), from those
// recordings: the broker status body below is the Node golden's for "no Dhan env,
// Zerodha without a session".

const nodeBrokerStatusNoSession = `{"broker":"zerodha","session":{"broker":"zerodha","authenticated":false,"client_id":null,"client_name":null,"token_expires_at":null,"token_expired":false,"login_day":null,"login_at":null},"health":{"broker":"zerodha","authenticated":false,"token_expires_at":null,"token_expired":false,"data_ready":false,"trading_ready":false,"static_ip_configured":null,"feed_connected":false,"feed_age_ms":null,"problems":["Zerodha is not connected"]},"dhan_configured":false,"dhan_instruments":0,"dhan_instruments_loaded_at":null,"dhan_static_ip":{"ready":false,"declared":false,"configured_ip":null,"api_verified":null,"primary_ip":null,"secondary_ip":null,"checked_at":null,"error":null},"last_margin_source":null,"generation":1,"feed":{"connected":false,"subscribed":0,"universe":null,"feed_age_ms":null,"last_tick_at":null,"state":"DOWN","detail":"No broker session — connect the broker."},"subscriptions":{"browser":0,"scanner":0,"strategy":0,"analytics":0,"tokens":0,"leases":0,"lane":"futures"},"instruments":0,"instruments_loaded_at":null}`

// marketDataStatusIdle is marketDataRoutes.ts snapshot() with no session, no stream and
// both lanes idle (key order as in the mdroutes golden).
const marketDataStatusIdle = `{"broker":"zerodha","generation":1,"subscriptions":{"browser":0,"scanner":0,"strategy":0,"analytics":0,"tokens":0,"leases":0,"lane":"futures"},"sessions":{"sessions":0,"connections":0,"tokens":0},"feed":{"state":"DOWN","connected":false,"subscribed":0,"universe":null,"feed_age_ms":null,"last_tick_at":null,"detail":"No broker session — connect the broker."},"upstream":{"broker":"zerodha","wanted":0,"subscribed":0,"socket_connected":false,"last_tick_at":null},"lanes":{"futures":{"lane":"futures","connected":false,"subscribedTokens":0,"wantedTokens":0,"ticksPerSecond":0,"lastTickAgeMs":null,"reconnects":0,"generation":1},"box":{"lane":"box","connected":false,"subscribedTokens":0,"wantedTokens":0,"ticksPerSecond":0,"lastTickAgeMs":null,"reconnects":0,"generation":1,"subscriptions":{"browser":0,"scanner":0,"strategy":0,"analytics":0,"tokens":0,"leases":0,"lane":"box"}}}}`

// Shape S of api.md §2.11 and the Fair Value status of §2.12, in key order.
var (
	syntheticStatusKeys = strings.Fields(`running market_open authenticated broker detection_only execution_mode
		paper_trading paper_blocked_reason db_enabled strike_level paired_underlyings monitored_underlyings
		skipped_for_budget unbuilt_windows subscribed_tokens ready_books token_budget base_token_budget
		borrowed_from_box box_scanner_running box_lane_tokens feed_age_ms feed_healthy universe_at evaluated_at
		close_session_day eligible_count opportunity_count open_count max_open_positions margin_enabled
		unlinked_positions day_pnl rf_pct rf_source last_error config`)
	fairValueStatusKeys = strings.Fields(`enabled paused model_version config_version force_disabled_reason
		surface_max_age_ms config_persisted expiry_policy_configured curve_configured broker broker_generation
		feed_generation feed data_ready subscribed_tokens watched_underlyings workers last_error storage
		persistence_error history_memory surfaces`)
)

func TestSmokeThroughTheFullHandler(t *testing.T) {
	h := newHarness(t, harnessOptions{db: true})

	expect(t, "GET /", h.do("GET", "/", "", ""), 200,
		`{"status":"ok","authenticated":false,"hint":"Visit /api/login to authenticate with Zerodha."}`)
	status := h.do("GET", "/api/status", "", "")
	expect(t, "GET /api/status", status, 200,
		`{"status":"ok","authenticated":false,"broker":"zerodha","broker_authenticated":false,"market_data_ready":false,"feed_connected":false,"feed_state":"DOWN","trading_ready":false,"problems":["Zerodha is not connected"],"generation":1,"zerodha_session":false}`)
	if got := topKeys(t, status.body); !reflect.DeepEqual(got, strings.Fields(`status authenticated broker broker_authenticated
		market_data_ready feed_connected feed_state trading_ready problems generation zerodha_session`)) {
		t.Errorf("/api/status key order %v", got)
	}
	for k, want := range map[string]string{
		"Content-Type":                     "application/json; charset=utf-8",
		"Access-Control-Allow-Origin":      testFrontend,
		"Access-Control-Allow-Methods":     "GET,POST,PATCH,DELETE,OPTIONS",
		"Access-Control-Allow-Headers":     "Content-Type, x-admin-token",
		"Access-Control-Allow-Credentials": "true",
		"Cache-Control":                    "no-store",
	} {
		if got := status.header.Get(k); got != want {
			t.Errorf("/api/status header %s = %q, want %q", k, got, want)
		}
	}

	unknown := h.do("GET", "/api/nope", "", "")
	expect(t, "unknown route", unknown, 404, "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot GET /api/nope</pre>\n</body>\n</html>\n")
	if ct, csp := unknown.header.Get("Content-Type"), unknown.header.Get("Content-Security-Policy"); ct != "text/html; charset=utf-8" || csp != "default-src 'none'" {
		t.Errorf("404 headers: %q %q", ct, csp)
	}

	// The browser's preflight for the PATCH the Fair Value page sends (PATCH added to
	// the allowed methods, PLAN decision).
	pre := h.do("OPTIONS", "/api/fair-value/config", "", "",
		[2]string{"Origin", testFrontend}, [2]string{"Access-Control-Request-Method", "PATCH"},
		[2]string{"Access-Control-Request-Headers", "content-type,x-admin-token"})
	expect(t, "preflight", pre, 204, "")
	if got := pre.header.Get("Access-Control-Allow-Methods"); got != "GET,POST,PATCH,DELETE,OPTIONS" {
		t.Errorf("preflight Allow-Methods %q", got)
	}
	if got := pre.header.Get("Access-Control-Allow-Origin"); got != testFrontend {
		t.Errorf("preflight Allow-Origin %q", got)
	}

	trade := h.tradeToken()
	full := h.fullToken()
	expect(t, "admin status", h.do("GET", "/api/admin/status", full, ""), 200, `{"authenticated":true,"role":"full","broker":"zerodha"}`)

	// Calendar trades: the database is there, the Kite session is not.
	expect(t, "POST /api/trades without a Kite session", h.do("POST", "/api/trades", trade, `{"symbol":"RELIANCE"}`), 401,
		`{"error":"Taking a trade requires a Zerodha session. Connect Zerodha.","broker":"zerodha","problems":["Zerodha is not connected"]}`)
	expect(t, "POST /api/trades without admin", h.do("POST", "/api/trades", "", `{"symbol":"RELIANCE"}`), 403,
		`{"error":"Admin authentication required"}`)

	expect(t, "GET /api/broker/status", h.do("GET", "/api/broker/status", trade, ""), 200, nodeBrokerStatusNoSession)
	expect(t, "GET /api/market-data/status", h.do("GET", "/api/market-data/status", "", ""), 200, marketDataStatusIdle)
	expect(t, "GET /api/option-chain/NIFTY", h.do("GET", "/api/option-chain/NIFTY", "", ""), 401,
		`{"error":"Option chain requires a Zerodha session. Connect Zerodha.","broker":"zerodha","problems":["Zerodha is not connected"]}`)

	// Synthetic status: the shape, the idle second lane (Box gone: never running, holding
	// nothing, its 2200-token budget lent) and the database.
	synth := h.do("GET", "/api/synthetic/status", trade, "")
	if synth.status != 200 {
		t.Fatalf("synthetic status %d %s", synth.status, synth.body)
	}
	if got := topKeys(t, synth.body); !reflect.DeepEqual(got, syntheticStatusKeys) {
		t.Errorf("synthetic status keys\n got %v\nwant %v", got, syntheticStatusKeys)
	}
	for _, frag := range []string{`"running":false`, `"broker":"zerodha"`, `"db_enabled":true`, `"token_budget":2950`,
		`"base_token_budget":750`, `"borrowed_from_box":2200`, `"box_scanner_running":false`, `"box_lane_tokens":0`,
		`"execution_mode":"paper_touch"`} {
		if !strings.Contains(synth.body, frag) {
			t.Errorf("synthetic status lacks %s: %s", frag, synth.body)
		}
	}
	expect(t, "synthetic status without admin", h.do("GET", "/api/synthetic/status", "", ""), 403, `{"error":"Admin authentication required"}`)

	// Fair Value status as full admin; the trade role is refused.
	fv := h.do("GET", "/api/fair-value/status", full, "")
	if fv.status != 200 {
		t.Fatalf("fair value status %d %s", fv.status, fv.body)
	}
	if got := topKeys(t, fv.body); !reflect.DeepEqual(got, fairValueStatusKeys) {
		t.Errorf("fair value status keys\n got %v\nwant %v", got, fairValueStatusKeys)
	}
	for _, frag := range []string{`"enabled":false`, `"broker":"zerodha"`, `"broker_generation":1`, `"feed_generation":2`,
		`"storage":"postgres"`, `"data_ready":false`,
		`"feed":{"lane":"futures","connected":false,"subscribedTokens":0,"wantedTokens":0,"ticksPerSecond":0,"lastTickAgeMs":null,"reconnects":0,"generation":1}`} {
		if !strings.Contains(fv.body, frag) {
			t.Errorf("fair value status lacks %s: %s", frag, fv.body)
		}
	}
	if got := fv.header.Get("Cache-Control"); got != "private, no-store" {
		t.Errorf("fair value Cache-Control %q", got)
	}
	expect(t, "fair value status, trade role", h.do("GET", "/api/fair-value/status", trade, ""), 403, `{"error":"Full admin access required."}`)

	// Market-data stream: with a Kite session in memory the session is created, then its
	// SSE stream opens with the hub's cached tick as the first frame, and the browser
	// lease reaches the hub's Kite socket (the fake ticker).
	expect(t, "stream session without data", h.do("POST", "/api/stream/session", "", `{"tokens":[256265]}`), 401,
		`{"error":"Live prices require a Zerodha session. Connect Zerodha.","broker":"zerodha","problems":["Zerodha is not connected"]}`)
	h.app.kite.SetAccessToken("test-access-token")
	h.app.hub.Seed([]market.Tick{{Token: 256265, LastPrice: 24500.5, ClosePrice: 24410}})
	created := h.do("POST", "/api/stream/session", "", `{"tokens":[256265,256265]}`)
	if created.status != 200 || !regexp.MustCompile(`^\{"id":"[0-9a-f]{32}","tokens":1,"broker":"zerodha","generation":1\}$`).MatchString(created.body) {
		t.Fatalf("POST /api/stream/session = %d %s", created.status, created.body)
	}
	var sess struct{ ID string }
	_ = json.Unmarshal([]byte(created.body), &sess)

	req, _ := http.NewRequest("GET", h.base+"/api/stream/session/"+sess.ID, nil)
	resp, err := h.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	for k, want := range map[string]string{
		"Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive",
		"X-Accel-Buffering": "no", "Access-Control-Allow-Origin": testFrontend,
	} {
		if got := resp.Header.Get(k); got != want {
			t.Errorf("SSE header %s = %q, want %q", k, got, want)
		}
	}
	frame := sseFrame(t, bufio.NewReader(resp.Body))
	if want := "data: [{\"token\":256265,\"last_price\":24500.5,\"close_price\":24410,\"oi\":0,\"bid\":0,\"ask\":0}]\n\n"; frame != want {
		t.Errorf("first SSE frame %q, want %q", frame, want)
	}
	waitFor(t, "the browser lease on the hub socket", func() bool { return containsEvent(h.ticker.log(), "connect#0 [256265]") })
	if r := h.do("GET", "/api/market-data/status", "", ""); !strings.Contains(r.body, `"sessions":{"sessions":1,"connections":1,"tokens":1}`) ||
		!strings.Contains(r.body, `"browser":1`) {
		t.Errorf("market-data status during the stream: %s", r.body)
	}
	resp.Body.Close()
	waitFor(t, "the stream cleanup", func() bool {
		r := h.do("GET", "/api/market-data/status", "", "")
		return strings.Contains(r.body, `"sessions":{"sessions":1,"connections":0,"tokens":1}`)
	})

	start := time.Now()
	res := h.shutdown("SIGTERM")
	if len(res.Failed) > 0 || res.TimedOut {
		t.Errorf("shutdown: %+v", res)
	}
	if took := time.Since(start); took > HTTPDrainGrace {
		t.Errorf("shutdown with no open stream took %v (the drain grace is only for open streams)", took)
	}
	h.waitGoroutines(3)
}

// TestShutdownClosesOpenStreams keeps a market-data SSE stream open through shutdown:
// the HTTP step waits the 3 s drain grace, then closes it (the browser reconnects to the
// next process), and the handler's cleanup still runs.
func TestShutdownClosesOpenStreams(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.app.kite.SetAccessToken("test-access-token")
	created := h.do("POST", "/api/stream/session", "", `{"tokens":[256265]}`)
	var sess struct{ ID string }
	if err := json.Unmarshal([]byte(created.body), &sess); err != nil || sess.ID == "" {
		t.Fatalf("session: %d %s", created.status, created.body)
	}
	resp, err := h.client.Get(h.base + "/api/stream/session/" + sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	waitFor(t, "the stream to attach", func() bool {
		return strings.Contains(h.do("GET", "/api/market-data/status", "", "").body, `"connections":1`)
	})
	start := time.Now()
	res := h.shutdown("SIGTERM")
	took := time.Since(start)
	if !reflect.DeepEqual(res.Completed, wantShutdown) || len(res.Failed) > 0 || res.TimedOut {
		t.Fatalf("shutdown: %+v", res)
	}
	if took < HTTPDrainGrace || took > HTTPDrainGrace+3*time.Second {
		t.Errorf("shutdown with an open stream took %v, want the %v grace and a little", took, HTTPDrainGrace)
	}
	if _, err := bufio.NewReader(resp.Body).ReadString('\n'); err == nil {
		// The connection may deliver a ping first; the next read must end.
		if _, err := bufio.NewReader(resp.Body).ReadString('\n'); err == nil {
			t.Error("the stream is still open after shutdown")
		}
	}
	if st := h.app.mdStore.Stats(); st.Connections != 0 {
		t.Errorf("session connections after shutdown: %+v", st)
	}
	h.waitGoroutines(3)
}
