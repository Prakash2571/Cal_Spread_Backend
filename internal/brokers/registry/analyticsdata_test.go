package registry

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
)

const analyticsMaster = "EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,UNDERLYING_SYMBOL,UNDERLYING_SECURITY_ID,LOT_SIZE,TICK_SIZE,EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE\n" +
	"NSE,I,13,INDEX,NIFTY 50,,,1,0.05,,,\n" +
	"NSE,D,30000,OPTIDX,NIFTY26NOV23850CE,NIFTY,13,75,0.05,2026-11-11,23850,CE\n" +
	"NSE,D,30001,OPTIDX,NIFTY26NOV23850PE,NIFTY,13,75,0.05,2026-11-11,23850,PE\n"

func TestDhanAnalyticsQuotesKeepOIAndBatchSegments(t *testing.T) {
	u := newUnitRig(t, nil, map[string][]httpSpec{
		"master GET detailed":        {{Status: 200, Body: json.RawMessage(mustJSON(analyticsMaster))}},
		"api POST /marketfeed/quote": {{Status: 200, Body: json.RawMessage(`{"data":{"IDX_I":{"13":{"last_price":23850,"last_trade_time":"01/01/1980 00:00:00"}},"NSE_FNO":{"30000":{"last_price":123,"oi":456,"ohlc":{"close":100},"last_trade_time":"04/11/2026 10:01:02"},"30001":{"last_price":124}}}}`)}},
	})
	u.activateDhan("synthetic-analytics-token")
	quotes, err := u.reg.QuoteProvider().GetQuoteFull(context.Background(), []string{"INDICES:NIFTY 50", "NFO:NIFTY26NOV23850CE", "NFO:NIFTY26NOV23850CE", "NFO:NIFTY26NOV23850PE"})
	if err != nil || len(quotes) != 2 || quotes[1].OI != 456 || quotes[1].Close != 100 || quotes[1].LastTradeTime != "2026-11-04 10:01:02" || quotes[0].LastTradeTime != "" {
		t.Fatalf("Dhan analytics quote fields/absence/date normalization: %+v, %v", quotes, err)
	}
	requests := u.dhan.takeOut()
	count := 0
	for _, request := range requests {
		if strings.Contains(request, "POST /marketfeed/quote") {
			count++
			if !strings.Contains(request, `"IDX_I":[13]`) || !strings.Contains(request, `"NSE_FNO":[30000,30001]`) {
				t.Fatalf("mixed segment batch or deduplication failed: %s", request)
			}
		}
	}
	if count != 1 {
		t.Fatal("analytics did not batch its index and F&O quotes into one request")
	}
	stale := brokers.WithNamespace(context.Background(), brokers.Namespace{Broker: brokers.Zerodha, Generation: 2})
	if _, err := u.reg.QuoteProvider().GetQuoteFull(stale, []string{"NFO:NIFTY26NOV23850CE"}); err == nil || len(u.dhan.takeOut()) != 0 {
		t.Fatal("stale broker quote context reached a provider")
	}
}

func TestDhanAnalyticsHistoryUsesNativeClassTimeBoundsAndErrors(t *testing.T) {
	for _, tc := range []struct {
		name      string
		body      json.RawMessage
		wantError bool
	}{
		{name: "valid OI", body: json.RawMessage(`{"timestamp":[1793763900],"close":[104],"open_interest":[50]}`)},
		{name: "missing OI", body: json.RawMessage(`{"timestamp":[1793763900],"close":[104]}`), wantError: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			u := newUnitRig(t, nil, map[string][]httpSpec{
				"master GET detailed":       {{Status: 200, Body: json.RawMessage(mustJSON(analyticsMaster))}},
				"api POST /charts/intraday": {{Status: 200, Body: tc.body}},
			})
			u.activateDhan("synthetic-analytics-token")
			history := u.reg.HistoryProvider().ForAnalytics()
			points, err := history.GetHistoricalOiSeries(context.Background(), 2_000_030_000, "2026-11-04 09:15:00", "2026-11-04 10:05:00", "minute", kite.Background)
			if (err != nil) != tc.wantError {
				t.Fatalf("required OI/error handling: %+v, %v", points, err)
			}
			if !tc.wantError && (len(points) != 1 || points[0].OI != 50 || !strings.HasSuffix(points[0].T, "+05:30")) {
				t.Fatalf("OI or timezone lost: %+v", points)
			}
			for _, request := range u.dhan.takeOut() {
				if strings.Contains(request, "POST /charts/intraday") && (!strings.Contains(request, `"instrument":"OPTIDX"`) ||
					!strings.Contains(request, `"fromDate":"2026-11-04 09:15:00"`) || !strings.Contains(request, `"toDate":"2026-11-04 10:05:00"`) || !strings.Contains(request, `"oi":true`)) {
					t.Fatalf("native class/time/OI request failed: %s", request)
				}
			}
			stale := brokers.WithNamespace(context.Background(), brokers.Namespace{Broker: brokers.Zerodha, Generation: 2})
			if _, err := history.GetHistoricalOiSeries(stale, 2_000_030_000, "2026-11-04 09:15:00", "2026-11-04 10:05:00", "minute", kite.Background); err == nil || len(u.dhan.takeOut()) != 0 {
				t.Fatal("stale history context reached a broker provider")
			}
		})
	}
}

func TestDhanAnalyticsQuoteQueueIsCancellable(t *testing.T) {
	u := newUnitRig(t, nil, map[string][]httpSpec{
		"master GET detailed": {{Status: 200, Body: json.RawMessage(mustJSON(analyticsMaster))}},
	})
	u.activateDhan("synthetic-analytics-token")
	u.reg.analyticsQuoteGate <- struct{}{}
	defer func() { <-u.reg.analyticsQuoteGate }()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := u.reg.QuoteProvider().GetQuoteFull(ctx, []string{"NFO:NIFTY26NOV23850CE"}); err == nil {
		t.Fatal("blocked analytics quote did not honor cancellation")
	}
	for _, request := range u.dhan.takeOut() {
		if strings.Contains(request, "POST /marketfeed/quote") {
			t.Fatal("cancelled queued quote was sent upstream")
		}
	}
}

func TestFetchedDhanTokenAndSelectionNotifyAnalyticsReady(t *testing.T) {
	u, _ := newTokenRig(t, nil, nil)
	u.activateDhan("synthetic-old-token")
	var ready atomic.Int64
	u.reg.Attach(Hooks{OnRuntimeReady: func() { ready.Add(1) }})
	if _, err := u.reg.FetchBrokerToken(context.Background()); err != nil {
		t.Fatal(err)
	}
	u.settle()
	if ready.Load() != 1 {
		t.Fatal("fetched active Dhan token did not notify analytics recovery")
	}
	u.reg.SwitchTo(context.Background(), brokers.Zerodha, "fixture")
	u.reg.SwitchTo(context.Background(), brokers.Dhan, "fixture")
	u.settle()
	if ready.Load() != 3 {
		t.Fatal("broker selections did not notify common recovery")
	}
}
