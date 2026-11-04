package app

import (
	"bufio"
	"context"
	"encoding/json"
	"testing"
)

func TestSpikeHTTPRolesControlsFramesAndSnapshotStream(t *testing.T) {
	h := newHarness(t, harnessOptions{db: true})
	h.app.Start(context.Background())
	for _, path := range []string{"/api/spike/status", "/api/spike/series?symbol=NIFTY&frame=1m", "/api/spike/stream"} {
		if response := h.do("GET", path, "", ""); response.status != 403 {
			t.Fatalf("public Spike access: %d %s", response.status, response.body)
		}
	}
	trade, full := h.tradeToken(), h.fullToken()
	for _, token := range []string{trade, full} {
		response := h.do("GET", "/api/spike/status", token, "")
		var snapshot struct{ Mode string }
		if response.status != 200 || json.Unmarshal([]byte(response.body), &snapshot) != nil || snapshot.Mode != "PAPER_ONLY" {
			t.Fatalf("authorized Spike status: %d %s", response.status, response.body)
		}
		for _, symbol := range []string{"NIFTY", "SENSEX"} {
			for _, frame := range []string{"1m", "5m", "30m", "1h"} {
				if result := h.do("GET", "/api/spike/series?symbol="+symbol+"&frame="+frame, token, ""); result.status != 200 {
					t.Fatalf("Spike frame %s/%s: %d %s", symbol, frame, result.status, result.body)
				}
			}
		}
	}
	if result := h.do("GET", "/api/spike/series?symbol=OTHER&frame=1m", trade, ""); result.status != 400 {
		t.Fatal("unsupported Spike index accepted")
	}
	if result := h.do("POST", "/api/spike/paper", trade, `{"enabled":false}`); result.status != 200 {
		t.Fatalf("paper pause: %d %s", result.status, result.body)
	}
	var enabled bool
	if err := h.pool.QueryRow(context.Background(), `select paper_enabled from spike_control where id='current'`).Scan(&enabled); err != nil || enabled {
		t.Fatal("simple paper control did not persist")
	}
	stream, err := h.client.Get(h.base + "/api/spike/stream?x-admin-token=" + trade)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	if stream.StatusCode != 200 || stream.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatal("Spike snapshot stream did not open")
	}
	frame := sseFrame(t, bufio.NewReader(stream.Body))
	if len(frame) == 0 {
		t.Fatal("Spike initial snapshot is missing")
	}
	stream.Body.Close()
}
