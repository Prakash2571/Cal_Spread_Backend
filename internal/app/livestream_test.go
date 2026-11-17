package app

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

func TestLiveRelayWiringAndShutdownWithoutUpstreamWork(t *testing.T) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		t.Fatal("could not generate test credential")
	}
	secret := hex.EncodeToString(raw[:])
	h := newHarness(t, harnessOptions{env: map[string]string{"CALSPREAD_STREAM_SECRET": secret}})
	kiteBefore, dhanBefore, tickerBefore := h.kite.requests(), h.dhan.requests(), h.ticker.log()
	conn, _, err := websocket.DefaultDialer.Dial(
		"ws"+strings.TrimPrefix(h.base, "http")+"/api/stream/live?secret="+secret, nil)
	if err != nil {
		t.Fatal("live relay handshake failed")
	}
	defer conn.Close()
	volume := 500.0
	h.app.hub.IngestExternalTicks([]market.Tick{{Token: 123, LastPrice: 10, Volume: &volume}})
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, payload, err := conn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var rows []struct {
		Token  int64    `json:"token"`
		LTP    float64  `json:"last_price"`
		Volume *float64 `json:"volume"`
	}
	if json.Unmarshal(payload, &rows) != nil || len(rows) != 1 || rows[0].Token != 123 || rows[0].LTP != 10 {
		t.Fatalf("relay did not receive the hub batch: %s", payload)
	}
	if rows[0].Volume != nil {
		t.Fatal("test assumption changed: hub no longer strips volume")
	}
	// The Spike route still resolves independently and still requires admin auth.
	if response := h.do("GET", "/api/spike/stream", "", ""); response.status != 403 {
		t.Fatalf("Spike SSE route changed: status %d", response.status)
	}
	if !reflect.DeepEqual(kiteBefore, h.kite.requests()) || !reflect.DeepEqual(dhanBefore, h.dhan.requests()) ||
		!reflect.DeepEqual(tickerBefore, h.ticker.log()) {
		t.Fatal("relay connection or tick delivery caused upstream work")
	}
	if result := h.shutdown("relay-test"); result.ExitCode() != 0 {
		t.Fatal("app shutdown failed")
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err = conn.ReadMessage()
	if !websocket.IsCloseError(err, websocket.CloseGoingAway) {
		t.Fatalf("app did not close hijacked relay socket: %v", err)
	}
}
