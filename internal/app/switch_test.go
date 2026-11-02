package app

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
)

// TestBrokerSwitchRunsTheHooks drives POST /api/broker/select through the full handler
// against loopback fakes (Kite REST and ticker, a Dhan host that answers 503) and checks
// the effects index.ts's attach() hooks have: the generation advanced and persisted,
// Synthetic stopped, every market-data session dropped, Fair Value's namespace
// invalidated, in the registry's teardown order.
func TestBrokerSwitchRunsTheHooks(t *testing.T) {
	h := newHarness(t, harnessOptions{
		db: true,
		env: map[string]string{
			"DHAN_CLIENT_ID": "1100001", "DHAN_API_KEY": "app-key", "DHAN_API_SECRET": "app-secret",
			"DHAN_MIN_INTERVAL_MS": "0", "DHAN_MAX_READ_ATTEMPTS": "1",
		},
		seed: func(t *testing.T, pool *db.Pool) {
			if _, err := pool.Exec(context.Background(),
				`insert into active_broker (id, broker, selected_by, generation) values ('current', 'zerodha', 'full', 5)`); err != nil {
				t.Fatal(err)
			}
		},
	})
	h.app.reg.Restore(context.Background()) // the boot step: adopt the durable generation
	h.app.kite.SetAccessToken("test-access-token")
	full, trade := h.fullToken(), h.tradeToken()

	created := h.do("POST", "/api/stream/session", "", `{"tokens":[256265]}`)
	var sess struct {
		ID         string `json:"id"`
		Generation int    `json:"generation"`
	}
	if err := json.Unmarshal([]byte(created.body), &sess); err != nil || sess.ID == "" || sess.Generation != 5 {
		t.Fatalf("stream session: %d %s", created.status, created.body)
	}
	// An open stream: its browser lease opens the hub's Kite socket (the fake ticker).
	stream, err := h.client.Get(h.base + "/api/stream/session/" + sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	waitFor(t, "the hub socket", func() bool { return containsEvent(h.ticker.log(), "connect#0 [256265]") })
	if r := h.do("POST", "/api/synthetic/start", trade, ""); r.status != 200 || !strings.Contains(r.body, `"running":true`) {
		t.Fatalf("synthetic start: %d %s", r.status, r.body)
	}
	fvBefore := h.do("GET", "/api/fair-value/status", full, "")
	if !strings.Contains(fvBefore.body, `"broker_generation":5,`) {
		t.Fatalf("fair value before the switch: %s", fvBefore.body)
	}

	h.trace.reset()
	sw := h.do("POST", "/api/broker/select", full, `{"broker":"dhan"}`)
	if sw.status != 200 || !strings.HasPrefix(sw.body, `{"ok":true,"broker":"dhan",`) || !strings.Contains(sw.body, `"generation":6,`) {
		t.Fatalf("switch: %d %s", sw.status, sw.body)
	}

	// The registry's teardown order, through the hooks this package attached.
	if got := h.trace.with("hook: "); !reflect.DeepEqual(got, []string{"stop scanner", "drop market-data sessions", "invalidate books", "reload universe"}) {
		t.Errorf("hooks during the switch: %q", got)
	}
	// Generation advanced from the durable 5 and persisted with the new broker.
	var broker, by string
	var gen int64
	if err := h.pool.QueryRow(context.Background(), `select broker, generation, selected_by from active_broker where id = 'current'`).
		Scan(&broker, &gen, &by); err != nil || broker != "dhan" || gen != 6 || by != "full" {
		t.Errorf("active_broker = %q %d %q (%v), want dhan 6 full", broker, gen, by, err)
	}
	// Synthetic discovery is off.
	if r := h.do("GET", "/api/synthetic/status", trade, ""); !strings.HasPrefix(r.body, `{"running":false,`) || !strings.Contains(r.body, `"broker":"dhan"`) {
		t.Errorf("synthetic after the switch: %s", r.body)
	}
	// Every browser stream session is gone.
	expect(t, "old stream session", h.do("GET", "/api/stream/session/"+sess.ID, "", ""), 404,
		`{"error":"Unknown or expired market-data session. Create a new one.","broker":"dhan","generation":6}`)
	if st := h.app.mdStore.Stats(); st.Sessions != 0 {
		t.Errorf("sessions after the switch: %+v", st)
	}
	// Fair Value: the hook invalidated the namespace (feed generation +1, still under the
	// old broker generation), and the next status read saw the new broker generation and
	// invalidated once more (+1). Without the hook the difference would be 1.
	fvAfter := h.do("GET", "/api/fair-value/status", full, "")
	if !strings.Contains(fvAfter.body, `"broker":"dhan","broker_generation":6,`) {
		t.Errorf("fair value after the switch: %s", fvAfter.body)
	}
	if b, a := feedGeneration(t, fvBefore.body), feedGeneration(t, fvAfter.body); a != b+2 {
		t.Errorf("fair value feed generation %v → %v, want +2", b, a)
	}
	// The outgoing Zerodha feed was stopped: the hub closed its Kite socket.
	if !containsEvent(h.ticker.log(), "close#0") {
		t.Errorf("the hub's Kite socket was not closed by the switch: %v", h.ticker.log())
	}
	stream.Body.Close()
	// Dhan was asked for its instrument master on the loopback fake only.
	if got := h.dhan.requests(); len(got) == 0 || got[0] != "GET /scrip-master.csv" {
		t.Errorf("Dhan requests: %v", got)
	}
}

func feedGeneration(t *testing.T, statusBody string) float64 {
	t.Helper()
	var v struct {
		FeedGeneration float64 `json:"feed_generation"`
	}
	if err := json.Unmarshal([]byte(statusBody), &v); err != nil {
		t.Fatalf("fair value status: %v: %s", err, statusBody)
	}
	return v.FeedGeneration
}
