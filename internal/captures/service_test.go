package captures

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/dbtest"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// Service wiring: StartHourly / StartEOD (the index.ts startup blocks), PostLogin (the
// capture half of triggerPostLoginBackfill, index.ts:3371), the scheduler loops and Stop.
// The Kite side is the real *kite.Client talking to a loopback fake of the Kite REST API,
// so the request lines and headers are the ones production sends. Expected log lines and
// values are taken from reading src/eodCapture.ts, src/hourlyCapture.ts and index.ts.

// ---------------------------------------------------------------------------------------
// Loopback fake Kite

type kiteHit struct{ uri, auth, version string }

// loopKite serves /quote/ohlc, /quote and /instruments/historical/{token}/{interval} from
// scripted data and records every request.
type loopKite struct {
	srv *httptest.Server

	mu      sync.Mutex
	hits    []kiteHit
	ohlc    map[string]any   // identifier -> /quote/ohlc entry
	full    map[string]any   // identifier -> /quote entry
	candles map[string][]any // "<token>/<interval>" -> candle rows
	// hold, when set, runs before a historical request is answered (it may block).
	hold func(r *http.Request)
}

func newLoopKite(t *testing.T) *loopKite {
	t.Helper()
	k := &loopKite{ohlc: map[string]any{}, full: map[string]any{}, candles: map[string][]any{}}
	k.srv = httptest.NewServer(http.HandlerFunc(k.serve))
	t.Cleanup(k.srv.Close)
	return k
}

func (k *loopKite) serve(w http.ResponseWriter, r *http.Request) {
	k.mu.Lock()
	k.hits = append(k.hits, kiteHit{r.URL.RequestURI(), r.Header.Get("Authorization"), r.Header.Get("X-Kite-Version")})
	hold := k.hold
	k.mu.Unlock()
	var body any
	switch {
	case r.URL.Path == "/quote/ohlc" || r.URL.Path == "/quote":
		src := k.ohlc
		if r.URL.Path == "/quote" {
			src = k.full
		}
		data := map[string]any{}
		k.mu.Lock()
		for _, id := range r.URL.Query()["i"] {
			if e, ok := src[id]; ok {
				data[id] = e
			}
		}
		k.mu.Unlock()
		body = map[string]any{"status": "success", "data": data}
	case strings.HasPrefix(r.URL.Path, "/instruments/historical/"):
		if hold != nil {
			hold(r)
		}
		k.mu.Lock()
		rows := k.candles[strings.TrimPrefix(r.URL.Path, "/instruments/historical/")]
		k.mu.Unlock()
		if rows == nil {
			rows = []any{}
		}
		body = map[string]any{"status": "success", "data": map[string]any{"candles": rows}}
	default:
		w.WriteHeader(http.StatusNotFound)
		body = map[string]any{"status": "error", "message": "no such route"}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(body)
}

func (k *loopKite) setHold(f func(r *http.Request)) {
	k.mu.Lock()
	k.hold = f
	k.mu.Unlock()
}

func (k *loopKite) requests() []kiteHit {
	k.mu.Lock()
	defer k.mu.Unlock()
	return append([]kiteHit(nil), k.hits...)
}

// uris lists the request lines whose path starts with prefix, in arrival order.
func (k *loopKite) uris(prefix string) []string {
	out := []string{}
	for _, h := range k.requests() {
		if strings.HasPrefix(h.uri, prefix) {
			out = append(out, h.uri)
		}
	}
	return out
}

// client is a real Kite client for the fake, with its own historical gate (no start gap,
// so the tests do not wait 350 ms per request).
func (k *loopKite) client(t *testing.T, gate *kite.HistoricalGate) *kite.Client {
	t.Helper()
	if gate == nil {
		gate = kite.NewHistoricalGate(0, 20*time.Second)
	}
	c, err := kite.NewClient(kite.Config{APIKey: "api-key", APISecret: "secret", APIRoot: k.srv.URL, HistoricalGate: gate})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func requireKiteAuth(t *testing.T, hits []kiteHit) {
	t.Helper()
	for _, h := range hits {
		if h.auth != "token api-key:access-token" || h.version != "3" {
			t.Errorf("%s: Authorization %q, X-Kite-Version %q", h.uri, h.auth, h.version)
		}
	}
}

// candle is one Kite candle row: [timestamp, open, high, low, close, volume(, oi)].
func candle(ts string, closePx float64, oi ...float64) []any {
	row := []any{ts, closePx - 1, closePx + 1, closePx - 2, closePx, 1000.0}
	for _, v := range oi {
		row = append(row, v)
	}
	return row
}

// ---------------------------------------------------------------------------------------
// Helpers

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// serviceGoroutines lists the stacks of goroutines a Service started (scheduler loops
// and background runs).
func serviceGoroutines() []string {
	buf := make([]byte, 1<<22)
	buf = buf[:runtime.Stack(buf, true)]
	var out []string
	for _, g := range strings.Split(string(buf), "\n\n") {
		if strings.Contains(g, "captures.(*Service).loop.func") || strings.Contains(g, "captures.(*Service).goTask.func") {
			out = append(out, g)
		}
	}
	return out
}

func requireNoServiceGoroutines(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		left := serviceGoroutines()
		if len(left) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d service goroutine(s) still running after Stop:\n%s", len(left), strings.Join(left, "\n\n"))
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func stopWithin(t *testing.T, svc *Service, d time.Duration) []string {
	t.Helper()
	done := make(chan []string, 1)
	go func() { done <- svc.Stop() }()
	select {
	case names := <-done:
		return names
	case <-time.After(d):
		t.Fatalf("Stop did not return within %v", d)
		return nil
	}
}

func countRows(t *testing.T, pool *db.Pool, table string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), `select count(*) from `+table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func lookupEnv(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

func twoSymbolBoard() []BoardItem {
	return []BoardItem{
		{Symbol: "ALPHA", Name: "ALPHA", SpotToken: 1, Futures: []BoardFuture{{101, "2026-08-27", 100}, {102, "2026-09-24", 100}}},
		{Symbol: "NIFTY", Name: "NIFTY", SpotToken: 5, IsIndex: true, Futures: []BoardFuture{{501, "2026-08-27", 75}, {502, "2026-09-24", 75}}},
	}
}

func twoSymbolInstruments() []market.Instrument {
	return []market.Instrument{inst(101, "ALPHA26AUGFUT"), inst(102, "ALPHA26SEPFUT"), inst(501, "NIFTY26AUGFUT"), inst(502, "NIFTY26SEPFUT")}
}

func staticDeps(board []BoardItem, all []market.Instrument) (func(context.Context) ([]BoardItem, error), func(context.Context) ([]market.Instrument, error)) {
	return func(context.Context) ([]BoardItem, error) { return cloneBoard(board), nil },
		func(context.Context) ([]market.Instrument, error) { return append([]market.Instrument{}, all...), nil }
}

// ---------------------------------------------------------------------------------------
// StartHourly / StartEOD / Stop

func TestStartHourlyAndStartEODActOnlyOnce(t *testing.T) {
	logs := &logSink{}
	clk := newFakeClock(istTime("2026-08-04", "09:00"))
	fk := newFakeKite(kiteSpec{Session: new(bool)}) // no Kite session
	svc := New(Deps{Kite: fk, Clock: clk, Logf: logs.logf})
	t.Cleanup(func() { svc.Stop() })

	svc.StartHourly()
	svc.StartHourly()
	svc.StartEOD()
	svc.StartEOD()
	svc.waitTasks()

	if got := svc.Intervals(); !slices.Equal(got, []string{IntervalHourly, IntervalDayReview, IntervalEOD}) {
		t.Fatalf("Intervals() = %v", got)
	}
	tickers := clk.allTickers()
	if len(tickers) != 3 {
		t.Fatalf("%d tickers, want one per scheduler", len(tickers))
	}
	for _, tk := range tickers {
		if tk.period != 60*time.Second {
			t.Errorf("ticker period %v, want 60s (setInterval(…, 60_000))", tk.period)
		}
	}
	// index.ts: startHourlyScheduler, backfillMissedHours (no session), startDayReviewScheduler;
	// then the nse_fno block: startEodScheduler, backfillStockFutures (no session) and
	// checkAndRecomputeSummary (no database: returns without a line). Each exactly once.
	want := []string{
		"[HourlyCapture] Hourly scheduler started (checking every 60s).",
		"[HourlyCapture] No Kite session available. Skipping backfill.",
		"[DayReview] End-of-day review scheduler started (checking for 16:30 IST).",
		"[EODCapture] EOD scheduler started (checking every 60s for 15:45 & 16:00 IST).",
		"[EODCapture] No Kite session. Skipping backfill.",
	}
	got := logs.all()
	if len(got) != len(want) {
		t.Fatalf("logs = %q", got)
	}
	for _, line := range want {
		if logs.count(line) != 1 {
			t.Errorf("%q logged %d times, want once (logs %q)", line, logs.count(line), got)
		}
	}
	if calls := fk.recorded(); len(calls) != 0 {
		t.Errorf("Kite called without a session: %v", calls)
	}

	names := stopWithin(t, svc, 5*time.Second)
	if !slices.Equal(names, []string{IntervalHourly, IntervalDayReview, IntervalEOD}) {
		t.Errorf("Stop() = %v, want the schedulers in start order", names)
	}
	for _, tk := range tickers {
		if !tk.isStopped() {
			t.Error("a scheduler ticker was not stopped")
		}
	}
	if again := svc.Stop(); len(again) != 0 {
		t.Errorf("second Stop() = %v, want []", again)
	}
	requireNoServiceGoroutines(t)

	// After Stop nothing starts again and a login does nothing.
	before := len(logs.all())
	svc.StartHourly()
	svc.StartEOD()
	svc.PostLogin()
	svc.waitTasks()
	if len(clk.allTickers()) != 3 || len(logs.all()) != before || len(svc.Intervals()) != 0 {
		t.Errorf("work started after Stop: tickers %d, new logs %q, intervals %v",
			len(clk.allTickers()), logs.all()[before:], svc.Intervals())
	}
}

func TestSchedulerTicksNeverOverlap(t *testing.T) {
	logs := &logSink{}
	clk := newFakeClock(istTime("2026-08-04", "10:00"))
	fk := newFakeKite(kiteSpec{Session: new(bool)})
	entered, release := make(chan struct{}), make(chan struct{})
	var boards atomic.Int32
	board, all := staticDeps(twoSymbolBoard(), twoSymbolInstruments())
	svc := New(Deps{
		Kite: fk, Clock: clk, Logf: logs.logf, GetAllInstruments: all,
		GetBoard: func(ctx context.Context) ([]BoardItem, error) {
			if boards.Add(1) == 1 {
				close(entered)
				<-release
			}
			return board(ctx)
		},
	})
	t.Cleanup(func() { svc.Stop() })
	ticked := make(chan string, 16)
	svc.afterTick = func(name string) { ticked <- name }
	svc.StartHourly()
	svc.waitTasks() // the startup backfill (no session) is done
	hourly := clk.allTickers()[0]

	// First tick: inside the 10:00 window, its capture blocks in GetBoard.
	if !hourly.tick(clk.Now()) {
		t.Fatal("first tick refused")
	}
	<-entered
	// While it is busy one tick waits in the channel and the next is dropped, like
	// time.Ticker (Node's setInterval would have started two overlapping captures).
	if !hourly.tick(clk.Now()) {
		t.Fatal("second tick refused")
	}
	if hourly.tick(clk.Now()) {
		t.Fatal("a third tick was buffered while the first was still running")
	}
	close(release)
	for i := 0; i < 2; i++ {
		select {
		case <-ticked:
		case <-time.After(5 * time.Second):
			t.Fatal("tick did not finish")
		}
	}
	// The waiting tick ran after the first finished and found the slot marked.
	if n := boards.Load(); n != 1 {
		t.Fatalf("GetBoard called %d times, want 1", n)
	}

	// Ticks that do not overlap all run, as with setInterval: 11:00 captures, 11:01 is
	// inside the same window and skips on the marker.
	for _, at := range []string{"11:00", "11:01"} {
		clk.set(istTime("2026-08-04", at))
		if !hourly.tick(clk.Now()) {
			t.Fatalf("tick at %s refused", at)
		}
		select {
		case <-ticked:
		case <-time.After(5 * time.Second):
			t.Fatalf("tick at %s did not finish", at)
		}
	}
	if n := boards.Load(); n != 2 {
		t.Fatalf("GetBoard called %d times after 11:00 and 11:01, want 2", n)
	}
	if got := logs.count("[HourlyCapture] Captured 0 records at 2026-08-04 10:00"); got != 1 {
		t.Errorf("10:00 captured %d times (logs %q)", got, logs.all())
	}
	if got := logs.count("[HourlyCapture] Captured 0 records at 2026-08-04 11:00"); got != 1 {
		t.Errorf("11:00 captured %d times (logs %q)", got, logs.all())
	}
}

// ---------------------------------------------------------------------------------------
// PostLogin

func TestPostLoginRunsTheStartedHalvesThroughKite(t *testing.T) {
	pool := dbtest.New(t)
	ctx := context.Background()
	// Wednesday 12:20 IST: today's expected slots are 10:00-12:00, the one-day lookback
	// starts at Tuesday 2026-08-04, and yesterday is 2026-08-04.
	clk := newFakeClock(istTime("2026-08-05", "12:20"))
	logs := &logSink{}
	k := newLoopKite(t)
	client := k.client(t, nil) // no session yet: the startup backfills skip
	board, all := staticDeps(twoSymbolBoard(), twoSymbolInstruments())
	env := map[string]string{"HOURLY_BACKFILL_LOOKBACK_DAYS": "1"}
	svc := New(Deps{Pool: pool, Kite: client, GetBoard: board, GetAllInstruments: all,
		LookupEnv: lookupEnv(env), Clock: clk, Logf: logs.logf})
	t.Cleanup(func() { svc.Stop() })

	// Seed: ALPHA's Tuesday is complete, NIFTY has nothing; the latest stock_futures day
	// is Monday; spread_summary is as new as spread_daily.
	for _, slot := range MarketHoursFor("2026-08-04") {
		insertFixtureRow(t, pool, "hourlyprices", nil, map[string]any{"symbol": "ALPHA", "date": "2026-08-04", "time": slot,
			"month": "2026-08", "current_month_close": 1.0, "mid_month_close": 2.0, "spread": 1.0})
	}
	insertFixtureRow(t, pool, "stock_futures", map[string]any{"source": "current"}, map[string]any{
		"trading_date": "2026-08-03T00:00:00.000Z", "symbol": "ALPHA", "instrument": "FUTSTK", "expiry": "2026-08-27T00:00:00.000Z",
		"open": 999.0, "high": 999.0, "low": 999.0, "close": 999.0})
	insertFixtureRow(t, pool, "spread_daily", nil, map[string]any{"symbol": "ALPHA", "trading_date": "2026-08-03T00:00:00.000Z",
		"near_expiry": "2026-08-27T00:00:00.000Z", "mid_expiry": "2026-09-24T00:00:00.000Z", "near_close": 1000.0, "mid_close": 1010.0, "spread": 10.0})
	insertFixtureRow(t, pool, "spread_summary", nil, map[string]any{"_id": "65f000000000000000000001", "symbol": "ALPHA", "observations": 1.0,
		"first_date": "2026-08-03T00:00:00.000Z", "last_date": "2026-08-03T00:00:00.000Z", "mean_spread": 10.0, "max_spread": 10.0,
		"min_spread": 10.0, "mean_deviation": 0.0, "max_abs_spread": 10.0, "std_dev_spread": 0.0, "percentile_95": 10.0,
		"mean_reversion_probability": 0.0})

	// Kite data: 60-minute candles start at :15 (09:15 -> slot 10:00, 15:15 -> close).
	hourlyRows := func(day string, n int, base float64) []any {
		out := []any{}
		for i, hh := range []string{"09", "10", "11", "12", "13", "14", "15"}[:n] {
			out = append(out, candle(day+"T"+hh+":15:00+0530", base+float64(i)))
		}
		return out
	}
	k.candles["101/60minute"] = hourlyRows("2026-08-05", 3, 1000.5)
	k.candles["102/60minute"] = hourlyRows("2026-08-05", 3, 1010.25)
	k.candles["501/60minute"] = append(hourlyRows("2026-08-04", 7, 24500), hourlyRows("2026-08-05", 3, 24600)...)
	k.candles["502/60minute"] = append(hourlyRows("2026-08-04", 7, 24600.5), hourlyRows("2026-08-05", 3, 24700.5)...)
	k.candles["101/day"] = []any{candle("2026-08-04T00:00:00+0530", 1000, 101000)}
	k.candles["102/day"] = []any{candle("2026-08-04T00:00:00+0530", 1012, 102000)}

	// Before StartHourly / StartEOD a login does nothing (hourlyBackfillDeps and
	// eodBackfillDeps were still null in Node).
	svc.PostLogin()
	svc.waitTasks()
	if got := logs.all(); len(got) != 0 || len(k.requests()) != 0 {
		t.Fatalf("PostLogin before the start blocks: logs %q, requests %v", got, k.requests())
	}

	svc.StartHourly()
	svc.StartEOD()
	svc.waitTasks()
	upToDate := "[EODCapture] Spread summary is up to date. No startup recomputation needed."
	for _, line := range []string{
		"[HourlyCapture] No Kite session available. Skipping backfill.",
		"[EODCapture] No Kite session. Skipping backfill.",
		upToDate,
	} {
		if logs.count(line) != 1 {
			t.Fatalf("startup: %q logged %d times (logs %q)", line, logs.count(line), logs.all())
		}
	}
	if len(k.requests()) != 0 {
		t.Fatalf("startup without a session called Kite: %v", k.requests())
	}

	// Login. In Node checkAndRecomputeSummary's first read resolves long before the
	// stock-futures backfill reaches its first candles; hold that request until the
	// reconciliation has answered so the test sees the same order.
	client.SetAccessToken("access-token")
	release := make(chan struct{})
	k.setHold(func(r *http.Request) {
		if r.URL.Path == "/instruments/historical/101/day" {
			<-release
		}
	})
	var reconciledFirst atomic.Bool
	go func() {
		// Never touches t (it may outlive a failed test) and always releases, so a broken
		// run fails on the assertions below instead of hanging.
		defer close(release)
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			if logs.count(upToDate) == 2 {
				reconciledFirst.Store(true)
				return
			}
			time.Sleep(2 * time.Millisecond)
		}
	}()
	svc.PostLogin()
	if logs.count("[HourlyCapture] Login detected — backfilling any missed slots.") != 1 {
		t.Fatalf("PostLogin did not log the hourly half at once: %q", logs.all())
	}
	svc.waitTasks()
	if !reconciledFirst.Load() {
		t.Fatalf("the post-login reconciliation did not run (logs %q)", logs.all())
	}

	requireKiteAuth(t, k.requests())
	hourlyURIs := []string{
		"/instruments/historical/101/60minute?from=2026-08-05&to=2026-08-05",
		"/instruments/historical/102/60minute?from=2026-08-05&to=2026-08-05",
		"/instruments/historical/501/60minute?from=2026-08-04&to=2026-08-05",
		"/instruments/historical/502/60minute?from=2026-08-04&to=2026-08-05",
	}
	if got := k.uris("/instruments/historical/"); len(got) != 6 {
		t.Fatalf("historical requests %v", got)
	}
	var gotHourly, gotDaily []string
	for _, u := range k.uris("/instruments/historical/") {
		if strings.Contains(u, "/60minute?") {
			gotHourly = append(gotHourly, u)
		} else {
			gotDaily = append(gotDaily, u)
		}
	}
	if !slices.Equal(gotHourly, hourlyURIs) {
		t.Errorf("hourly backfill requests\n got: %v\nwant: %v", gotHourly, hourlyURIs)
	}
	wantDaily := []string{
		"/instruments/historical/101/day?from=2026-08-04&to=2026-08-04&oi=1",
		"/instruments/historical/102/day?from=2026-08-04&to=2026-08-04&oi=1",
	}
	if !slices.Equal(gotDaily, wantDaily) {
		t.Errorf("stock-futures backfill requests\n got: %v\nwant: %v", gotDaily, wantDaily)
	}
	for _, line := range []string{
		"[HourlyCapture] Backfill queued 13 records. Draining...",
		"[EODCapture] Backfilling 1 missing day(s): 2026-08-04 to 2026-08-04.",
		"[EODCapture] Backfill queued 2 stock_futures docs. Draining to DB...",
		"[EODCapture] Drained 2 stock_futures docs to DB.",
		"[EODCapture] Backfill drain complete.",
		"[EODCapture] Queued 1 spread_daily docs. Draining to DB...",
		"[EODCapture] Drained 1 spread_daily docs to DB.",
	} {
		if logs.count(line) != 1 {
			t.Errorf("post-login: %q logged %d times", line, logs.count(line))
		}
	}

	hp := dumpRows(t, pool, `select symbol, date, time, current_month_close, mid_month_close, far_month_close, spread
		from hourlyprices where date = '2026-08-05' or symbol = 'NIFTY' order by symbol, date, time`)
	wantHP := []map[string]any{}
	for i, slot := range []string{"10:00", "11:00", "12:00"} {
		cur, mid := 1000.5+float64(i), 1010.25+float64(i)
		wantHP = append(wantHP, map[string]any{"symbol": "ALPHA", "date": "2026-08-05", "time": slot,
			"current_month_close": cur, "mid_month_close": mid, "far_month_close": nil, "spread": mid - cur})
	}
	for _, d := range []struct {
		day        string
		slots      []string
		cur0, mid0 float64
	}{{"2026-08-04", MarketHoursFor("2026-08-04"), 24500, 24600.5}, {"2026-08-05", []string{"10:00", "11:00", "12:00"}, 24600, 24700.5}} {
		for i, slot := range d.slots {
			cur, mid := d.cur0+float64(i), d.mid0+float64(i)
			wantHP = append(wantHP, map[string]any{"symbol": "NIFTY", "date": d.day, "time": slot,
				"current_month_close": cur, "mid_month_close": mid, "far_month_close": nil, "spread": mid - cur})
		}
	}
	requireJSONEqual(t, "hourlyprices", wantHP, hp)

	sf := dumpRows(t, pool, `select trading_date, symbol, expiry, open, high, low, close, settle_price, open_interest
		from stock_futures where source = 'current' and trading_date = '2026-08-04T00:00:00Z' order by expiry`)
	requireJSONEqual(t, "stock_futures", []map[string]any{
		{"trading_date": "2026-08-04T00:00:00.000Z", "symbol": "ALPHA", "expiry": "2026-08-27T00:00:00.000Z",
			"open": 999.0, "high": 1001.0, "low": 998.0, "close": 1000.0, "settle_price": 1000.0, "open_interest": 101000.0},
		{"trading_date": "2026-08-04T00:00:00.000Z", "symbol": "ALPHA", "expiry": "2026-09-24T00:00:00.000Z",
			"open": 1011.0, "high": 1013.0, "low": 1010.0, "close": 1012.0, "settle_price": 1012.0, "open_interest": 102000.0},
	}, sf)
	sd := dumpRows(t, pool, `select symbol, trading_date, near_expiry, mid_expiry, near_close, mid_close, spread
		from spread_daily order by trading_date`)
	requireJSONEqual(t, "spread_daily", []map[string]any{
		{"symbol": "ALPHA", "trading_date": "2026-08-03T00:00:00.000Z", "near_expiry": "2026-08-27T00:00:00.000Z",
			"mid_expiry": "2026-09-24T00:00:00.000Z", "near_close": 1000.0, "mid_close": 1010.0, "spread": 10.0},
		{"symbol": "ALPHA", "trading_date": "2026-08-04T00:00:00.000Z", "near_expiry": "2026-08-27T00:00:00.000Z",
			"mid_expiry": "2026-09-24T00:00:00.000Z", "near_close": 1000.0, "mid_close": 1012.0, "spread": 12.0},
	}, sd)

	// Second login: nothing is missing any more, and spread_daily is now newer than the
	// summary, so the reconciliation recomputes it (keeping the row's id).
	before := len(k.requests())
	svc.PostLogin()
	svc.waitTasks()
	if after := k.requests(); len(after) != before {
		t.Errorf("second login called Kite again: %v", after[before:])
	}
	for _, line := range []string{
		"[HourlyCapture] Backfill: no missing slots found.",
		"[EODCapture] Backfill: no missing days found.",
		"[EODCapture] spread_daily has newer data (2026-08-04) than spread_summary (2026-08-03). Triggering startup recomputation...",
		"[EODCapture] Spread summary recomputed: 1 symbols.",
	} {
		if logs.count(line) != 1 {
			t.Errorf("second login: %q logged %d times (logs %q)", line, logs.count(line), logs.all())
		}
	}
	doc, err := svc.SpreadSummary(ctx, "ALPHA")
	if err != nil || doc == nil {
		t.Fatalf("SpreadSummary = %v, %v", doc, err)
	}
	// recomputeSpreadSummary over spreads [10, 12]: mean 11, mean deviation 1, population
	// std 1, p95 = sorted[ceil(1.9) - 1] = 12, one crossing out of two deviations = 50 %.
	rec := httptest.NewRecorder()
	httpx.JSON(rec, http.StatusOK, *doc) // what GET /api/spread-stats/:symbol writes
	want := `{"_id":"65f000000000000000000001","symbol":"ALPHA","observations":2,"first_date":"2026-08-03T00:00:00.000Z",` +
		`"last_date":"2026-08-04T00:00:00.000Z","mean_spread":11,"max_spread":12,"min_spread":10,"mean_deviation":1,` +
		`"max_abs_spread":12,"std_dev_spread":1,"percentile_95":12,"mean_reversion_probability":50}`
	if got := rec.Body.String(); got != want {
		t.Errorf("spread-stats body\n got: %s\nwant: %s", got, want)
	}
}

// ---------------------------------------------------------------------------------------
// Stop during a run

func TestStopDuringABackfillLeavesNothingRunning(t *testing.T) {
	pool := dbtest.New(t)
	clk := newFakeClock(istTime("2026-08-05", "12:20"))
	logs := &logSink{}
	k := newLoopKite(t)
	client := k.client(t, nil)
	client.SetAccessToken("access-token")
	entered, abort := make(chan struct{}), make(chan struct{})
	var once sync.Once
	k.setHold(func(r *http.Request) {
		once.Do(func() { close(entered) })
		select {
		case <-r.Context().Done(): // answers only when the client gives up
		case <-abort: // the test failed; do not hang the cleanup
		}
	})
	board, all := staticDeps(twoSymbolBoard(), twoSymbolInstruments())
	svc := New(Deps{Pool: pool, Kite: client, GetBoard: board, GetAllInstruments: all,
		LookupEnv: lookupEnv(map[string]string{"HOURLY_BACKFILL_LOOKBACK_DAYS": "1"}), Clock: clk, Logf: logs.logf})
	t.Cleanup(func() { svc.Stop() })
	t.Cleanup(func() { close(abort) }) // runs before the Stop above

	svc.StartHourly() // the startup backfill starts at once and blocks on its first candles
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("the backfill never reached Kite")
	}
	names := stopWithin(t, svc, 10*time.Second)
	if !slices.Equal(names, []string{IntervalHourly, IntervalDayReview}) {
		t.Errorf("Stop() = %v", names)
	}
	requireNoServiceGoroutines(t)
	time.Sleep(100 * time.Millisecond)
	if hits := k.uris("/instruments/historical/"); len(hits) != 1 {
		t.Errorf("Kite requests after Stop: %v", hits)
	}
	if n := countRows(t, pool, "hourlyprices"); n != 0 {
		t.Errorf("%d hourlyprices rows written", n)
	}
	for _, line := range logs.all() {
		if strings.Contains(line, "failed") || strings.Contains(line, "context canceled") {
			t.Errorf("Stop was logged as a failure: %q", line)
		}
	}
	// The guard was released on the way out, so a backfill is not reported as running.
	if svc.Hourly.backfilling {
		t.Error("backfilling still set after Stop")
	}
}

// Stop waits for the run in flight: here a pacing delay that (unlike the real clock)
// ignores the cancellation, so the run can only end when the test lets it.
func TestStopWaitsForTheRunInFlight(t *testing.T) {
	pool := dbtest.New(t)
	clk := newFakeClock(istTime("2026-08-05", "12:20"))
	sleeping, release := make(chan struct{}), make(chan struct{})
	releaseOnce := sync.OnceFunc(func() { close(release) })
	var once sync.Once
	clk.sleepHook = func(ctx context.Context, d time.Duration) error {
		once.Do(func() { close(sleeping) })
		<-release
		return ctx.Err()
	}
	board, all := staticDeps(twoSymbolBoard(), twoSymbolInstruments())
	svc := New(Deps{Pool: pool, Kite: newFakeKite(kiteSpec{}), GetBoard: board, GetAllInstruments: all,
		Clock: clk, Logf: (&logSink{}).logf})
	t.Cleanup(func() { svc.Stop() })
	t.Cleanup(releaseOnce)
	svc.StartHourly() // the startup backfill pauses after its first candles
	select {
	case <-sleeping:
	case <-time.After(10 * time.Second):
		t.Fatal("the backfill never paused")
	}
	stopped := make(chan struct{})
	go func() { svc.Stop(); close(stopped) }()
	select {
	case <-stopped:
		t.Fatal("Stop returned while a backfill was still running")
	case <-time.After(150 * time.Millisecond):
	}
	releaseOnce()
	select {
	case <-stopped:
	case <-time.After(10 * time.Second):
		t.Fatal("Stop did not return once the run ended")
	}
	requireNoServiceGoroutines(t)
}

func TestStopDuringADrainWritesNothingMore(t *testing.T) {
	pool := dbtest.New(t)
	clk := newFakeClock(istTime("2026-08-04", "10:00"))
	logs := &logSink{}
	sleeping := make(chan struct{})
	var once sync.Once
	clk.sleepHook = func(ctx context.Context, d time.Duration) error {
		if d == hourlyDrainSpacing {
			once.Do(func() { close(sleeping) })
			<-ctx.Done() // the 100 ms pause after the first write lasts until Stop
			return ctx.Err()
		}
		return ctx.Err()
	}
	board := []BoardItem{
		{Symbol: "A", Futures: []BoardFuture{{1, "2026-08-27", 1}, {2, "2026-09-24", 1}}},
		{Symbol: "B", Futures: []BoardFuture{{3, "2026-08-27", 1}, {4, "2026-09-24", 1}}},
		{Symbol: "C", Futures: []BoardFuture{{5, "2026-08-27", 1}, {6, "2026-09-24", 1}}},
	}
	getBoard, all := staticDeps(board, nil)
	svc := New(Deps{Pool: pool, Kite: newFakeKite(kiteSpec{Session: new(bool)}), GetBoard: getBoard, GetAllInstruments: all,
		GetLatestTick: func(token int64) (market.Tick, bool) {
			return market.Tick{Token: token, LastPrice: 100 + float64(token)}, true
		},
		Clock: clk, Logf: logs.logf})
	t.Cleanup(func() { svc.Stop() })
	svc.StartHourly()
	svc.waitTasks()

	if !clk.allTickers()[0].tick(clk.Now()) {
		t.Fatal("tick refused")
	}
	select {
	case <-sleeping:
	case <-time.After(10 * time.Second):
		t.Fatal("the drain never paused")
	}
	stopWithin(t, svc, 10*time.Second)
	requireNoServiceGoroutines(t)
	time.Sleep(100 * time.Millisecond)
	if n := countRows(t, pool, "hourlyprices"); n != 1 {
		t.Errorf("%d rows written, want only the one before Stop", n)
	}
	if n := svc.Hourly.Pending(); n != 2 {
		t.Errorf("%d rows still queued, want 2 (dropped, as when Node exited)", n)
	}
	for _, line := range logs.all() {
		if strings.Contains(line, "Failed") || strings.Contains(line, "error") {
			t.Errorf("Stop was logged as a failure: %q", line)
		}
	}
}

// ---------------------------------------------------------------------------------------
// Historical gate priority

func TestCaptureBackfillsYieldToInteractiveHistory(t *testing.T) {
	pool := dbtest.New(t)
	ctx := context.Background()
	clk := newFakeClock(istTime("2026-08-05", "12:20"))
	logs := &logSink{}
	k := newLoopKite(t)
	gate := kite.NewHistoricalGate(0, 20*time.Second)
	client := k.client(t, gate)
	client.SetAccessToken("access-token")
	held, release := make(chan struct{}), make(chan struct{})
	releaseOnce := sync.OnceFunc(func() { close(release) })
	var once sync.Once
	k.setHold(func(r *http.Request) {
		first := false
		once.Do(func() { first = true })
		if first {
			close(held)
			<-release
		}
	})
	insertFixtureRow(t, pool, "stock_futures", map[string]any{"source": "current"}, map[string]any{
		"trading_date": "2026-08-03T00:00:00.000Z", "symbol": "ALPHA", "instrument": "FUTSTK", "expiry": "2026-08-27T00:00:00.000Z",
		"open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0})
	board, all := staticDeps(twoSymbolBoard(), twoSymbolInstruments())
	svc := New(Deps{Pool: pool, Kite: client, GetBoard: board, GetAllInstruments: all,
		LookupEnv: lookupEnv(map[string]string{"HOURLY_BACKFILL_LOOKBACK_DAYS": "1"}), Clock: clk, Logf: logs.logf})
	t.Cleanup(func() { svc.Stop() })
	t.Cleanup(releaseOnce) // runs first: a failed wait must not leave the request held

	var wg sync.WaitGroup
	wg.Add(3)
	go func() { defer wg.Done(); _ = svc.Hourly.BackfillMissedHours(ctx) }()
	<-held // the hourly backfill's first request holds the gate's slot
	go func() { defer wg.Done(); _ = svc.EOD.BackfillStockFutures(ctx) }()
	waitFor(t, "the stock-futures backfill to queue", func() bool { return gate.Queued() == 1 })
	go func() {
		defer wg.Done()
		// A chart request a user is waiting on (core's history routes use Interactive).
		if _, err := client.GetHistorical(ctx, 999, "2026-08-01", "2026-08-05", "day", kite.Interactive); err != nil {
			t.Errorf("interactive request: %v", err)
		}
	}()
	waitFor(t, "the interactive request to queue", func() bool { return gate.Queued() == 2 })
	releaseOnce()
	wg.Wait()

	got := k.uris("/instruments/historical/")
	if len(got) < 3 {
		t.Fatalf("requests %v", got)
	}
	want := []string{
		"/instruments/historical/101/60minute?from=2026-08-04&to=2026-08-05",
		"/instruments/historical/999/day?from=2026-08-01&to=2026-08-05",
		"/instruments/historical/101/day?from=2026-08-04&to=2026-08-04&oi=1",
	}
	if !slices.Equal(got[:3], want) {
		t.Errorf("gate order\n got: %v\nwant: %v (the interactive request jumps the queued background capture)", got[:3], want)
	}
}

// ---------------------------------------------------------------------------------------
// The scheduler ticks through the real client, down to GET /api/spread-stats

var hex24 = regexp.MustCompile(`"_id":"[0-9a-f]{24}"`)

func TestSchedulerTicksThroughKiteAndPostgres(t *testing.T) {
	pool := dbtest.New(t)
	ctx := context.Background()
	clk := newFakeClock(istTime("2026-08-04", "10:00"))
	logs := &logSink{}
	k := newLoopKite(t)
	client := k.client(t, nil)
	client.SetAccessToken("access-token")
	items := []BoardItem{
		{Symbol: "ALPHA", Name: "ALPHA", SpotToken: 1, Futures: []BoardFuture{{101, "2026-08-27", 100}, {102, "2026-09-24", 100}}},
		{Symbol: "NIFTY", Name: "NIFTY", SpotToken: 5, IsIndex: true, Futures: []BoardFuture{{501, "2026-08-27", 75}, {502, "2026-09-24", 75}}},
		{Symbol: "M&M", Name: "MAHINDRA & MAHINDRA", SpotToken: 6, Futures: []BoardFuture{{601, "2026-08-27", 200}, {602, "2026-09-24", 200}}},
	}
	instruments := append(twoSymbolInstruments(), inst(601, "M&M26AUGFUT"), inst(602, "M&M26SEPFUT"))
	board, all := staticDeps(items, instruments)
	for id, q := range map[string][2]float64{
		"NFO:ALPHA26AUGFUT": {101, 1000.5}, "NFO:ALPHA26SEPFUT": {102, 1010.25}, "NFO:NIFTY26AUGFUT": {501, 24500},
		"NFO:NIFTY26SEPFUT": {502, 24600.35}, "NFO:M&M26AUGFUT": {601, 3000}, "NFO:M&M26SEPFUT": {602, 3010.55},
	} {
		k.ohlc[id] = map[string]any{"instrument_token": q[0], "last_price": q[1],
			"ohlc": map[string]any{"open": q[1] - 1, "high": q[1] + 1, "low": q[1] - 2, "close": q[1] - 0.5}}
	}
	for id, q := range map[string][2]float64{
		"NFO:ALPHA26AUGFUT": {101, 1000}, "NFO:ALPHA26SEPFUT": {102, 1012.5}, "NFO:M&M26AUGFUT": {601, 3000}, "NFO:M&M26SEPFUT": {602, 3011},
	} {
		k.full[id] = map[string]any{"instrument_token": q[0], "last_price": q[1] + 0.5, "oi": q[0] * 1000,
			"ohlc": map[string]any{"open": q[1] - 5, "high": q[1] + 5, "low": q[1] - 10, "close": q[1]}}
	}
	svc := New(Deps{Pool: pool, Kite: client, GetBoard: board, GetAllInstruments: all, Clock: clk, Logf: logs.logf})
	t.Cleanup(func() { svc.Stop() })

	// 10:00 IST: no live ticks, so every eligible symbol (the index included) goes to
	// one REST /quote/ohlc call in board order.
	svc.Hourly.schedulerTick(ctx)
	// 15:45 IST: the EOD capture (stocks only) via /quote, then today's spreads.
	clk.set(istTime("2026-08-04", "15:45"))
	svc.EOD.schedulerTick(ctx)
	// 16:00 IST: the summary.
	clk.set(istTime("2026-08-04", "16:00"))
	svc.EOD.schedulerTick(ctx)

	hits := k.requests()
	requireKiteAuth(t, hits)
	wantURIs := []string{
		"/quote/ohlc?i=NFO%3AALPHA26AUGFUT&i=NFO%3AALPHA26SEPFUT&i=NFO%3ANIFTY26AUGFUT&i=NFO%3ANIFTY26SEPFUT" +
			"&i=NFO%3AM%26M26AUGFUT&i=NFO%3AM%26M26SEPFUT",
		"/quote?i=NFO%3AALPHA26AUGFUT&i=NFO%3AALPHA26SEPFUT&i=NFO%3AM%26M26AUGFUT&i=NFO%3AM%26M26SEPFUT",
	}
	if got := k.uris("/"); !slices.Equal(got, wantURIs) {
		t.Errorf("Kite requests\n got: %v\nwant: %v", got, wantURIs)
	}
	wantLogs := []string{
		"[HourlyCapture] Captured 3 records at 2026-08-04 10:00",
		"[EODCapture] Triggering EOD capture at 15:45 IST...",
		"[EODCapture] Queued 4 stock_futures docs for 2026-08-04. Draining to DB...",
		"[EODCapture] Drained 4 stock_futures docs to DB.",
		"[EODCapture] Queued 2 spread_daily docs. Draining to DB...",
		"[EODCapture] Drained 2 spread_daily docs to DB.",
		"[EODCapture] Triggering spread summary recomputation at 16:00 IST...",
		"[EODCapture] Recomputing spread_summary...",
		"[EODCapture] Spread summary recomputed: 2 symbols.",
	}
	if got := logs.all(); !slices.Equal(got, wantLogs) {
		t.Errorf("logs\n got: %q\nwant: %q", got, wantLogs)
	}

	// Spreads are float64 subtractions as in JavaScript (3010.55 - 3000 is
	// 10.550000000000182); a Go constant expression would be computed exactly.
	sub := func(a, b float64) float64 { return a - b }
	requireJSONEqual(t, "hourlyprices", []map[string]any{
		{"symbol": "ALPHA", "time": "10:00", "current_month_close": 1000.5, "mid_month_close": 1010.25, "far_month_close": nil, "spread": sub(1010.25, 1000.5)},
		{"symbol": "M&M", "time": "10:00", "current_month_close": 3000.0, "mid_month_close": 3010.55, "far_month_close": nil, "spread": sub(3010.55, 3000)},
		{"symbol": "NIFTY", "time": "10:00", "current_month_close": 24500.0, "mid_month_close": 24600.35, "far_month_close": nil, "spread": sub(24600.35, 24500)},
	}, dumpRows(t, pool, `select symbol, time, current_month_close, mid_month_close, far_month_close, spread
		from hourlyprices where date = '2026-08-04' order by symbol`))
	requireJSONEqual(t, "stock_futures", []map[string]any{
		{"symbol": "ALPHA", "expiry": "2026-08-27T00:00:00.000Z", "open": 995.0, "high": 1005.0, "low": 990.0, "close": 1000.0, "settle_price": 1000.0, "open_interest": 101000.0},
		{"symbol": "ALPHA", "expiry": "2026-09-24T00:00:00.000Z", "open": 1007.5, "high": 1017.5, "low": 1002.5, "close": 1012.5, "settle_price": 1012.5, "open_interest": 102000.0},
		{"symbol": "M&M", "expiry": "2026-08-27T00:00:00.000Z", "open": 2995.0, "high": 3005.0, "low": 2990.0, "close": 3000.0, "settle_price": 3000.0, "open_interest": 601000.0},
		{"symbol": "M&M", "expiry": "2026-09-24T00:00:00.000Z", "open": 3006.0, "high": 3016.0, "low": 3001.0, "close": 3011.0, "settle_price": 3011.0, "open_interest": 602000.0},
	}, dumpRows(t, pool, `select symbol, expiry, open, high, low, close, settle_price, open_interest from stock_futures
		where source = 'current' and trading_date = '2026-08-04T00:00:00Z' order by symbol, expiry`))
	requireJSONEqual(t, "spread_daily", []map[string]any{
		{"symbol": "ALPHA", "spread": 12.5}, {"symbol": "M&M", "spread": 11.0},
	}, dumpRows(t, pool, `select symbol, spread from spread_daily where trading_date = '2026-08-04T00:00:00Z' order by symbol`))

	doc, err := svc.SpreadSummary(ctx, "M&M")
	if err != nil || doc == nil {
		t.Fatalf("SpreadSummary(M&M) = %v, %v", doc, err)
	}
	rec := httptest.NewRecorder()
	httpx.JSON(rec, http.StatusOK, *doc)
	body := hex24.ReplaceAllString(rec.Body.String(), `"_id":"<id>"`)
	want := `{"_id":"<id>","symbol":"M&M","observations":1,"first_date":"2026-08-04T00:00:00.000Z",` +
		`"last_date":"2026-08-04T00:00:00.000Z","mean_spread":11,"max_spread":11,"min_spread":11,"mean_deviation":0,` +
		`"max_abs_spread":11,"std_dev_spread":0,"percentile_95":11,"mean_reversion_probability":0}`
	if body != want {
		t.Errorf("spread-stats body\n got: %s\nwant: %s", rec.Body.String(), want)
	}
	if doc, err := svc.SpreadSummary(ctx, "NIFTY"); doc != nil || err != nil {
		t.Errorf("an index has no EOD summary: %v, %v", doc, err)
	}
}

// ---------------------------------------------------------------------------------------
// The drain flag

// memHourlyStore is an in-memory hourlyStore.
type memHourlyStore struct {
	mu     sync.Mutex
	writes int
}

func (m *memHourlyStore) UpsertHourlyPrice(context.Context, HourlyPrice) error {
	m.mu.Lock()
	m.writes++
	m.mu.Unlock()
	runtime.Gosched() // let other captures queue rows while this drain is running
	return nil
}

func (m *memHourlyStore) HourlySlotsSince(context.Context, string, string) ([]DateTimeSlot, error) {
	return nil, nil
}

func (m *memHourlyStore) CountHourlyPrices(context.Context, string, []string) (int, error) {
	return 0, nil
}

// Every row queued by a capture is written by some drain, however the captures and their
// drains interleave. In Node the empty check and the flag reset had no await between
// them, so a capture whose drain call came just as another drain ended always found the
// flag clear. afterDrain runs exactly at that moment.
func TestADrainThatJustEndedLeavesNoRowBehind(t *testing.T) {
	ctx := context.Background()
	clk := newFakeClock(istTime("2026-08-04", "10:00"))
	t.Run("hourly", func(t *testing.T) {
		h := NewHourly(nil, Deps{Clock: clk, Logf: (&logSink{}).logf})
		mem := &memHourlyStore{}
		h.store = mem
		fired := false // the hook re-enters through the nested drain; act only once
		h.afterDrain = func() {
			if fired {
				return
			}
			fired = true
			// The next slot's capture: queue a row and drain.
			h.push(HourlyPrice{Symbol: "LATE", Date: "2026-08-04", Time: "11:00"})
			h.DrainCacheToDB(ctx)
		}
		h.push(HourlyPrice{Symbol: "FIRST", Date: "2026-08-04", Time: "10:00"})
		h.DrainCacheToDB(ctx)
		if n := h.Pending(); n != 0 || mem.writes != 2 {
			t.Fatalf("%d rows left queued, %d written; want 0 and 2", n, mem.writes)
		}
	})
	t.Run("stock_futures", func(t *testing.T) {
		pool := dbtest.New(t)
		e := NewEOD(NewStore(pool), Deps{Clock: clk, Logf: (&logSink{}).logf})
		fired := false
		e.afterDrain = func() {
			if fired {
				return
			}
			fired = true
			e.pushStockFuture(sfRow("LATE", "2026-03-04", "2026-03-26", 20))
			e.drainStockFutures(ctx)
		}
		e.pushStockFuture(sfRow("FIRST", "2026-03-04", "2026-03-26", 10))
		e.drainStockFutures(ctx)
		if n := e.PendingStockFutures(); n != 0 {
			t.Fatalf("%d rows left queued", n)
		}
		if n := countRows(t, pool, "stock_futures"); n != 2 {
			t.Fatalf("%d rows written, want 2", n)
		}
	})
}

// The same property under real concurrency (a sanity check for the race detector).
func TestConcurrentCapturesNeverStrandAQueuedRow(t *testing.T) {
	clk := newFakeClock(istTime("2026-08-04", "10:00"))
	h := NewHourly(nil, Deps{Clock: clk, Logf: (&logSink{}).logf})
	mem := &memHourlyStore{}
	h.store = mem
	const workers, perWorker = 8, 400
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < perWorker; i++ {
				h.push(HourlyPrice{Symbol: "S", Date: "2026-08-04", Time: "10:00"})
				h.DrainCacheToDB(context.Background())
				if i%16 == 0 {
					runtime.Gosched()
				}
			}
		}()
	}
	wg.Wait()
	if n := h.Pending(); n != 0 {
		t.Fatalf("%d rows left queued after every capture's drain returned", n)
	}
	if mem.writes != workers*perWorker {
		t.Fatalf("%d writes, want %d", mem.writes, workers*perWorker)
	}
}
