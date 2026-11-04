package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

func dhanAnalyticsFixture(t *testing.T, now time.Time) http.HandlerFunc {
	t.Helper()
	ist := time.FixedZone("IST", 330*60)
	day := now.In(ist)
	expiry := day.AddDate(0, 0, 7).Format("2006-01-02")
	master := "EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,UNDERLYING_SYMBOL,UNDERLYING_SECURITY_ID,LOT_SIZE,TICK_SIZE,EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE\n" +
		"NSE,I,13,INDEX,NIFTY 50,,,1,0.05,,,\n"
	for i, strike := range []int{23750, 23850, 23950} {
		for side, optionType := range []string{"CE", "PE"} {
			id := 30000 + i*2 + side
			master += fmt.Sprintf("NSE,D,%d,OPTIDX,NIFTY%s%d%s,NIFTY,13,75,0.05,%s,%d,%s\n",
				id, day.AddDate(0, 0, 7).Format("060102"), strike, optionType, expiry, strike, optionType)
		}
	}
	for i := 0; i < 3; i++ {
		futureExpiry := day.AddDate(0, 0, 10+i*30)
		master += fmt.Sprintf("NSE,D,%d,FUTIDX,NIFTY%sFUT,NIFTY,13,75,0.05,%s,,\n", 40000+i,
			strings.ToUpper(futureExpiry.Format("06Jan")), futureExpiry.Format("2006-01-02"))
	}
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/scrip-master.csv":
			w.Header().Set("Content-Type", "text/csv")
			_, _ = w.Write([]byte(master))
		case "/v2/profile":
			_ = json.NewEncoder(w).Encode(map[string]any{"dhanClientId": "1100001", "tokenValidity": time.Now().Add(24 * time.Hour).UnixMilli()})
		case "/v2/marketfeed/quote":
			var request map[string][]int64
			if json.NewDecoder(r.Body).Decode(&request) != nil {
				t.Error("invalid Dhan quote request")
				w.WriteHeader(400)
				return
			}
			data := map[string]map[string]any{}
			for segment, ids := range request {
				book := map[string]any{}
				for _, id := range ids {
					price, oi := 100+float64(id%10), 10000+float64(id)
					if id == 13 {
						price, oi = 23850, 0
					}
					book[strconv.FormatInt(id, 10)] = map[string]any{"last_price": price, "oi": oi,
						"last_trade_time": day.Format("02/01/2006 15:04:05"), "ohlc": map[string]float64{"close": price - 1}}
				}
				data[segment] = book
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": data})
		case "/v2/charts/intraday", "/v2/charts/historical":
			var request struct {
				SecurityID string `json:"securityId"`
				Instrument string `json:"instrument"`
				From       string `json:"fromDate"`
				To         string `json:"toDate"`
				OI         bool   `json:"oi"`
			}
			if json.NewDecoder(r.Body).Decode(&request) != nil {
				t.Error("invalid Dhan chart request")
				w.WriteHeader(400)
				return
			}
			id, _ := strconv.Atoi(request.SecurityID)
			wantClass := "OPTIDX"
			if id == 13 {
				wantClass = "INDEX"
			} else if id >= 40000 {
				wantClass = "FUTIDX"
			}
			if request.Instrument != wantClass || (id != 13 && !request.OI) {
				t.Errorf("Dhan history identity/OI: security %d class %s (want %s), oi=%v", id, request.Instrument, wantClass, request.OI)
				w.WriteHeader(400)
				return
			}
			if r.URL.Path == "/v2/charts/intraday" && (len(request.From) != 19 || len(request.To) != 19) {
				t.Errorf("Dhan intraday lost its time bounds: %s -> %s", request.From, request.To)
				w.WriteHeader(400)
				return
			}
			var stamps []int64
			var close, oi []float64
			if r.URL.Path == "/v2/charts/historical" {
				stamps = []int64{day.AddDate(0, 0, -1).Unix()}
				close, oi = []float64{101}, []float64{5000 + float64(id)}
			} else {
				start := time.Date(day.Year(), day.Month(), day.Day(), 10, 0, 0, 0, ist)
				for i := 0; i < 240; i++ {
					stamps = append(stamps, start.Add(time.Duration(i)*time.Minute).Unix())
					price := 100 + float64(id%10) + float64(i%7)
					if id == 13 {
						price = 23850 + float64(i%7)
					}
					close = append(close, price)
					oi = append(oi, 5000+float64(id+i))
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"timestamp": stamps, "close": close, "open_interest": oi})
		default:
			t.Errorf("unexpected Dhan analytics request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}
}

func TestDhanOnlyAnalyticsPopulatesAllFramesAndBaselines(t *testing.T) {
	ist := time.FixedZone("IST", 330*60)
	today := time.Now().In(ist)
	now := time.Date(today.Year(), today.Month(), today.Day(), 14, 5, 57, 0, ist)
	h := newHarness(t, harnessOptions{db: true, env: map[string]string{
		"DEFAULT_BROKER": "dhan", "DHAN_CLIENT_ID": "1100001", "DHAN_MIN_INTERVAL_MS": "0", "DHAN_MAX_READ_ATTEMPTS": "1",
	}, dhan: dhanAnalyticsFixture(t, now), analyticsNow: func() time.Time { return now }})
	h.app.Start(context.Background())
	full := h.fullToken()
	if res := h.do("POST", "/api/dhan/token", full, `{"accessToken":"loopback-analytics-token"}`); res.status != 200 {
		t.Fatalf("Dhan session: %d %s", res.status, res.body)
	}
	if h.app.kite.HasSession() {
		t.Fatal("fixture unexpectedly has a Kite session")
	}
	if res := h.do("GET", "/api/option-chain/NIFTY", "", ""); res.status != 200 {
		t.Fatalf("Dhan live chain: %d %s", res.status, res.body)
	}
	var lastFrames, lastPrevious string
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("last futures response: %s; previous close: %s", lastFrames, lastPrevious)
		}
	})
	waitFor(t, "Dhan futures history and day baseline", func() bool {
		time.Sleep(200 * time.Millisecond) // keep real HTTP polling below the API limiter
		frames := h.do("GET", "/api/futures-oi-frame/NIFTY?frame=1h", "", "")
		var history struct{ Points []json.RawMessage }
		previous := h.do("GET", "/api/option-prev-close/NIFTY", "", "")
		lastFrames, lastPrevious = frames.body, previous.body
		var baseline struct{ Tokens map[string]any }
		return json.Unmarshal([]byte(frames.body), &history) == nil && len(history.Points) >= 2 &&
			json.Unmarshal([]byte(previous.body), &baseline) == nil && len(baseline.Tokens) == 6
	})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := h.app.analytics.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if err := h.app.analytics.FlushNow(ctx); err != nil {
		t.Fatal(err)
	}
	for _, family := range []string{"option-oi-frame", "futures-oi-frame"} {
		for _, frame := range []string{"1m", "5m", "15m", "1h"} {
			res := h.do("GET", "/api/"+family+"/NIFTY?frame="+frame, "", "")
			var reply struct{ Points []json.RawMessage }
			if res.status != 200 || json.Unmarshal([]byte(res.body), &reply) != nil || len(reply.Points) < 2 {
				t.Fatalf("Dhan %s %s did not form history: %d %s", family, frame, res.status, res.body)
			}
		}
	}
	res := h.do("GET", "/api/option-oi-baseline/NIFTY?minutes=5", "", "")
	var baseline struct{ Tokens map[string]any }
	if json.Unmarshal([]byte(res.body), &baseline) != nil || len(baseline.Tokens) != 6 {
		t.Fatalf("Dhan chain baseline missing: %s", res.body)
	}
	res = h.do("GET", "/api/option-prev-close/NIFTY", "", "")
	if json.Unmarshal([]byte(res.body), &baseline) != nil || len(baseline.Tokens) != 6 {
		t.Fatalf("Dhan daily baseline missing: %s", res.body)
	}
	if requests := h.kite.requests(); len(requests) != 0 {
		t.Fatalf("Dhan analytics used Kite data requests: %v", requests)
	}
}
