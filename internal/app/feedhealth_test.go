package app

import (
	"strings"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// Box used to own the hub liveness listener. A Box-free service must report
// futures data as LIVE without relying on Synthetic or Fair Value to run.
func TestZerodhaFuturesTicksReportLiveWithoutAnAnalyticsScanner(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	h.app.kite.SetAccessToken("fixture-access-token")
	release := h.app.reg.AcquireBrowserTokens([]int64{256265})
	defer release()
	socket := h.ticker.socket(0)
	socket.OnOpen()
	before := h.do("GET", "/api/market-data/status", "", "")
	if before.status != 200 || !strings.Contains(before.body, `"state":"CONNECTING"`) {
		t.Fatalf("connected but unticked feed: %d %s", before.status, before.body)
	}
	socket.OnTick([]market.Tick{{Token: 256265, LastPrice: 24500.5}})
	after := h.do("GET", "/api/market-data/status", "", "")
	if after.status != 200 || !strings.Contains(after.body, `"state":"LIVE"`) {
		t.Fatalf("valid futures ticks were not reported as live: %d %s", after.status, after.body)
	}
}
