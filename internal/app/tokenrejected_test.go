package app

import (
	"bufio"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
)

// TestKiteTokenRejectedClearsTheSession is the TickerHub callback of index.ts: when
// Zerodha rejects the token on the hub's socket, the session is cleared in memory and in
// kite_session, onFeedSessionLost stops Synthetic's discovery, and every stream gets the
// kite_error event (and stays open, as in Node).
func TestKiteTokenRejectedClearsTheSession(t *testing.T) {
	h := newHarness(t, harnessOptions{db: true, seed: func(t *testing.T, pool *db.Pool) {
		if _, err := pool.Exec(context.Background(),
			`insert into kite_session (id, access_token, user_id, user_name, login_date) values ('current', 'live-token', 'AB1234', 'Trader One', $1)`,
			jsx.IstDayKey(time.Now())); err != nil {
			t.Fatal(err)
		}
	}})
	ctx := context.Background()
	h.app.core.RestoreKiteSession(ctx) // the boot step: today's token is restored
	expect(t, "GET / with the restored session", h.do("GET", "/", "", ""), 200,
		`{"status":"ok","authenticated":true,"hint":"Visit /api/login to authenticate with Zerodha."}`)
	trade := h.tradeToken()
	if r := h.do("POST", "/api/synthetic/start", trade, ""); r.status != 200 || !strings.Contains(r.body, `"running":true`) {
		t.Fatalf("synthetic start: %d %s", r.status, r.body)
	}

	created := h.do("POST", "/api/stream/session", "", `{"tokens":[256265]}`)
	var sess struct{ ID string }
	if err := json.Unmarshal([]byte(created.body), &sess); err != nil || sess.ID == "" {
		t.Fatalf("session: %d %s", created.status, created.body)
	}
	stream, err := h.client.Get(h.base + "/api/stream/session/" + sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	waitFor(t, "the hub socket", func() bool { return containsEvent(h.ticker.log(), "connect#0 [256265]") })
	if s := h.ticker.socket(0); s.AccessToken != "live-token" || s.APIKey != "test-api-key" {
		t.Errorf("hub socket credentials %q %q", s.APIKey, s.AccessToken)
	}

	// Zerodha refuses the token.
	h.ticker.socket(0).OnError("Incorrect `api_key` or `access_token`.")

	frame := sseFrame(t, bufio.NewReader(stream.Body))
	if want := "event: kite_error\ndata: {\"message\":\"Incorrect `api_key` or `access_token`.\"}\n\n"; frame != want {
		t.Errorf("stream frame %q, want %q", frame, want)
	}
	if !h.trace.has("hook: kite token rejected") {
		t.Error("the hub's token-rejected callback did not run")
	}
	expect(t, "GET / after the rejection", h.do("GET", "/", "", ""), 200,
		`{"status":"ok","authenticated":false,"hint":"Visit /api/login to authenticate with Zerodha."}`)
	waitFor(t, "kite_session to be cleared", func() bool {
		var n int
		err := h.pool.QueryRow(ctx, `select count(*) from kite_session`).Scan(&n)
		return err == nil && n == 0
	})
	if r := h.do("GET", "/api/synthetic/status", trade, ""); !strings.HasPrefix(r.body, `{"running":false,`) {
		t.Errorf("synthetic after the rejection: %s", r.body)
	}
	if !containsEvent(h.ticker.log(), "close#0") {
		t.Errorf("the hub did not stop its socket: %v", h.ticker.log())
	}
}
