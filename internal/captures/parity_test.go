package captures

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/config"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/dbtest"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// Parity tests: the fixtures in testdata/ were produced by running the ORIGINAL
// TypeScript (src/eodCapture.ts, src/hourlyCapture.ts, src/yahoo.ts) under Node 22 with
// in-memory stand-ins for Mongo, Kite, timers and fetch (testdata/gen_parity.mjs). The
// tests below replay the same scenarios against the Go port and require the same Kite
// calls, delays, log lines and final table contents.

func readFixture(t testing.TB, name string, v any) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v (regenerate with scratch/go-migration/check.sh node internal/captures/testdata/gen_parity.mjs)", name, err)
	}
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatalf("decode fixture %s: %v", name, err)
	}
}

// normalize round-trips v through JSON so Go values and decoded fixtures compare equal.
func normalize(t testing.TB, v any) any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("normalize: %v", err)
	}
	return out
}

// requireJSONEqual fails with the first differing line of the two indented documents.
func requireJSONEqual(t testing.TB, what string, want, got any) {
	t.Helper()
	w, g := normalize(t, want), normalize(t, got)
	if reflect.DeepEqual(w, g) {
		return
	}
	wb, _ := json.MarshalIndent(w, "", " ")
	gb, _ := json.MarshalIndent(g, "", " ")
	wl, gl := strings.Split(string(wb), "\n"), strings.Split(string(gb), "\n")
	for i := 0; i < max(len(wl), len(gl)); i++ {
		var a, b string
		if i < len(wl) {
			a = wl[i]
		}
		if i < len(gl) {
			b = gl[i]
		}
		if a != b {
			lo := max(0, i-3)
			t.Fatalf("%s differs at line %d\n want: %s\n  got: %s\n--- want (context)\n%s\n--- got (context)\n%s",
				what, i+1, a, b, strings.Join(wl[lo:min(len(wl), i+4)], "\n"), strings.Join(gl[lo:min(len(gl), i+4)], "\n"))
		}
	}
	t.Fatalf("%s differs", what)
}

// ---------------------------------------------------------------------------------------
// Pure helpers (helpers.json)

type helpersFixture struct {
	SlotsPerDay int                 `json:"slots_per_day"`
	MarketHours map[string][]string `json:"market_hours"`
	CaptureSlot []struct {
		At   string  `json:"at"`
		Slot *string `json:"slot"`
	} `json:"capture_slot"`
	CandleSlot []struct {
		T   string  `json:"t"`
		Key *string `json:"key"`
	} `json:"candle_slot"`
	ExpectedSlots []struct {
		Start   string         `json:"start"`
		End     string         `json:"end"`
		EndTime string         `json:"end_time"`
		Slots   []DateTimeSlot `json:"slots"`
	} `json:"expected_slots"`
	WeekdaysBetween []struct {
		Start string   `json:"start"`
		End   string   `json:"end"`
		Days  []string `json:"days"`
	} `json:"weekdays_between"`
	IsWeekday map[string][]bool `json:"is_weekday"`
	HourKey   []struct {
		At  string `json:"at"`
		Key string `json:"key"`
	} `json:"hour_key"`
	MarketOpen []struct {
		At   string `json:"at"`
		Open bool   `json:"open"`
	} `json:"market_open"`
}

func mustTime(t testing.TB, iso string) time.Time {
	t.Helper()
	v, err := time.Parse(time.RFC3339Nano, iso)
	if err != nil {
		t.Fatalf("parse %q: %v", iso, err)
	}
	return v
}

func TestHelpersMatchNode(t *testing.T) {
	var f helpersFixture
	readFixture(t, "helpers.json", &f)

	t.Run("slots_per_day", func(t *testing.T) {
		if SlotsPerDay != f.SlotsPerDay {
			t.Fatalf("SlotsPerDay = %d, Node %d", SlotsPerDay, f.SlotsPerDay)
		}
	})
	t.Run("market_hours", func(t *testing.T) {
		if len(f.MarketHours) == 0 {
			t.Fatal("no fixtures")
		}
		for date, want := range f.MarketHours {
			if got := MarketHoursFor(date); !slices.Equal(got, want) {
				t.Errorf("MarketHoursFor(%q) = %v, Node %v", date, got, want)
			}
		}
	})
	t.Run("capture_slot", func(t *testing.T) {
		hits := 0
		for _, c := range f.CaptureSlot {
			got, ok := currentCaptureSlot(mustTime(t, c.At))
			switch {
			case c.Slot == nil && ok:
				t.Errorf("%s: slot %q, Node null", c.At, got)
			case c.Slot != nil && (!ok || got != *c.Slot):
				t.Errorf("%s: slot %q (ok=%v), Node %q", c.At, got, ok, *c.Slot)
			}
			if c.Slot != nil {
				hits++
			}
		}
		if hits < 20 {
			t.Fatalf("fixture has only %d matching minutes", hits)
		}
	})
	t.Run("candle_slot", func(t *testing.T) {
		if len(f.CandleSlot) < 400 {
			t.Fatalf("only %d candle fixtures", len(f.CandleSlot))
		}
		keys := 0
		for _, c := range f.CandleSlot {
			got, ok := candleToSlotKey(c.T)
			switch {
			case c.Key == nil && ok:
				t.Errorf("candleToSlotKey(%q) = %q, Node null", c.T, got)
			case c.Key != nil && (!ok || got != *c.Key):
				t.Errorf("candleToSlotKey(%q) = %q (ok=%v), Node %q", c.T, got, ok, *c.Key)
			}
			if c.Key != nil {
				keys++
			}
		}
		if keys < 100 {
			t.Fatalf("fixture has only %d mapped candles", keys)
		}
	})
	t.Run("expected_slots", func(t *testing.T) {
		for _, c := range f.ExpectedSlots {
			got := allExpectedSlots(c.Start, c.End, c.EndTime)
			if len(got) == 0 && len(c.Slots) == 0 {
				continue
			}
			if !slices.Equal(got, c.Slots) {
				t.Errorf("allExpectedSlots(%q, %q, %q) = %v, Node %v", c.Start, c.End, c.EndTime, got, c.Slots)
			}
		}
	})
	t.Run("weekdays_between", func(t *testing.T) {
		for _, c := range f.WeekdaysBetween {
			got := getWeekdaysBetween(c.Start, c.End)
			if got == nil || c.Days == nil {
				t.Fatalf("getWeekdaysBetween(%q, %q): nil result (Node always returns an array)", c.Start, c.End)
			}
			if !slices.Equal(got, c.Days) {
				t.Errorf("getWeekdaysBetween(%q, %q) = %v, Node %v", c.Start, c.End, got, c.Days)
			}
		}
	})
	t.Run("is_weekday", func(t *testing.T) {
		for d, want := range f.IsWeekday {
			if want[0] != want[1] {
				t.Fatalf("fixture inconsistent for %q", d)
			}
			if got := isWeekday(d); got != want[0] {
				t.Errorf("isWeekday(%q) = %v, Node %v", d, got, want[0])
			}
		}
	})
	t.Run("hour_key_and_market_open", func(t *testing.T) {
		for _, c := range f.HourKey {
			if got := istHourKey(mustTime(t, c.At)); got != c.Key {
				t.Errorf("istHourKey(%s) = %q, Node %q", c.At, got, c.Key)
			}
		}
		for _, c := range f.MarketOpen {
			if got := jsx.IsMarketOpen(mustTime(t, c.At)); got != c.Open {
				t.Errorf("IsMarketOpen(%s) = %v, Node %v", c.At, got, c.Open)
			}
		}
		if len(f.HourKey) == 0 || len(f.MarketOpen) == 0 {
			t.Fatal("no fixtures")
		}
	})
}

// ---------------------------------------------------------------------------------------
// Spread summary statistics (summary.json)

type summaryFixture struct {
	SpreadDaily []struct {
		Symbol      string  `json:"symbol"`
		TradingDate string  `json:"trading_date"`
		Spread      float64 `json:"spread"`
	} `json:"spread_daily"`
	Summary []map[string]any `json:"summary"`
}

func TestSummaryStatisticsMatchNode(t *testing.T) {
	var f summaryFixture
	readFixture(t, "summary.json", &f)

	// Group like recomputeSpreadSummary: symbols in first-seen order, rows in natural
	// (deliberately non-chronological) order.
	var symbols []string
	grouped := map[string][]SpreadPoint{}
	for _, r := range f.SpreadDaily {
		if _, ok := grouped[r.Symbol]; !ok {
			symbols = append(symbols, r.Symbol)
		}
		grouped[r.Symbol] = append(grouped[r.Symbol], SpreadPoint{Symbol: r.Symbol, Spread: r.Spread, TradingDate: mustTime(t, r.TradingDate)})
	}
	if len(symbols) < 50 || len(f.Summary) != len(symbols) {
		t.Fatalf("fixture has %d symbols and %d summaries", len(symbols), len(f.Summary))
	}
	// The fixture lists the summaries sorted by symbol; compare per symbol so a failure
	// names the statistic.
	for _, want := range f.Summary {
		sym := want["symbol"].(string)
		raw, err := json.Marshal(computeSummary(sym, grouped[sym]))
		if err != nil {
			t.Fatal(err)
		}
		var got map[string]any
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Fatal(err)
		}
		delete(got, "_id")
		delete(want, "_id")
		if len(got) != len(want) {
			t.Errorf("%s: fields %v, Node %v", sym, got, want)
		}
		for k, wv := range want {
			if !reflect.DeepEqual(wv, got[k]) {
				t.Errorf("%s: %s = %v (Go) vs %v (Node)", sym, k, got[k], wv)
			}
		}
	}
}

// ---------------------------------------------------------------------------------------
// Scenario replay (scenarios.json)

type scenarioStep struct {
	Op            string   `json:"op"`
	At            string   `json:"at"`
	Slot          string   `json:"slot"`
	Name          string   `json:"name"`
	Dates         []string `json:"dates"`
	Value         bool     `json:"value"`
	Model         string   `json:"model"`
	After         *int     `json:"after"`
	NoKite        bool     `json:"no_kite"`
	NoInstruments bool     `json:"no_instruments"`
}

type scenario struct {
	Name        string                      `json:"name"`
	Board       []BoardItem                 `json:"board"`
	Instruments []market.Instrument         `json:"instruments"`
	Ticks       map[string]float64          `json:"ticks"`
	Kite        kiteSpec                    `json:"kite"`
	Env         map[string]string           `json:"env"`
	DB          map[string][]map[string]any `json:"db"`
	Steps       []scenarioStep              `json:"steps"`
	Expected    struct {
		KiteCalls []map[string]any            `json:"kite_calls"`
		Sleeps    []int64                     `json:"sleeps"`
		Logs      []string                    `json:"logs"`
		DB        map[string][]map[string]any `json:"db"`
	} `json:"expected"`
}

type scenariosFixture struct {
	Scenarios []scenario `json:"scenarios"`
}

func cloneBoard(b []BoardItem) []BoardItem {
	out := make([]BoardItem, len(b))
	for i, item := range b {
		out[i] = item
		out[i].Futures = append([]BoardFuture(nil), item.Futures...)
	}
	return out
}

var dateColumns = map[string]bool{
	"trading_date": true, "expiry": true, "near_expiry": true, "mid_expiry": true, "first_date": true, "last_date": true,
}

// insertFixtureRow inserts one fixture document with plain SQL (not the code under
// test). Extra holds constant columns such as the stock_futures source.
func insertFixtureRow(t *testing.T, pool *db.Pool, table string, extra map[string]any, row map[string]any) {
	t.Helper()
	cols := map[string]any{}
	for k, v := range extra {
		cols[k] = v
	}
	for k, v := range row {
		if k == "_id" {
			k = "id"
		}
		if s, ok := v.(string); ok && dateColumns[k] {
			v = mustTime(t, s)
		}
		cols[k] = v
	}
	names := make([]string, 0, len(cols))
	for k := range cols {
		names = append(names, k)
	}
	sort.Strings(names)
	args := make([]any, len(names))
	ph := make([]string, len(names))
	quoted := make([]string, len(names))
	for i, k := range names {
		args[i] = cols[k]
		ph[i] = fmt.Sprintf("$%d", i+1)
		quoted[i] = `"` + k + `"`
	}
	q := fmt.Sprintf(`insert into %s (%s) values (%s)`, table, strings.Join(quoted, ","), strings.Join(ph, ","))
	if _, err := pool.Exec(context.Background(), q, args...); err != nil {
		t.Fatalf("seed %s: %v (%v)", table, err, row)
	}
}

func seedScenario(t *testing.T, pool *db.Pool, data map[string][]map[string]any) {
	t.Helper()
	for _, r := range data["hourlyprices"] {
		insertFixtureRow(t, pool, "hourlyprices", nil, r)
	}
	for _, r := range data["stock_futures_current"] {
		insertFixtureRow(t, pool, "stock_futures", map[string]any{"source": "current"}, r)
	}
	for _, r := range data["stock_futures_archive"] {
		insertFixtureRow(t, pool, "stock_futures", map[string]any{"source": "archive"}, r)
	}
	for _, r := range data["spread_daily"] {
		insertFixtureRow(t, pool, "spread_daily", nil, r)
	}
	for _, r := range data["spread_summary"] {
		insertFixtureRow(t, pool, "spread_summary", nil, r)
	}
}

func dumpRows(t *testing.T, pool *db.Pool, query string, args ...any) []map[string]any {
	t.Helper()
	rows, err := pool.Query(context.Background(), query, args...)
	if err != nil {
		t.Fatalf("dump: %v", err)
	}
	defer rows.Close()
	fds := rows.FieldDescriptions()
	out := []map[string]any{}
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			t.Fatalf("dump: %v", err)
		}
		m := map[string]any{}
		for i, v := range vals {
			if ts, ok := v.(time.Time); ok {
				v = jsx.ISO(ts)
			}
			m[fds[i].Name] = v
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("dump: %v", err)
	}
	return out
}

const stockFutureCols = `trading_date, symbol, instrument, expiry, open, high, low, close, settle_price,
	contracts, value_lakh, open_interest, change_in_oi`

func dumpScenarioDB(t *testing.T, pool *db.Pool, seededIDs map[string]bool) map[string][]map[string]any {
	t.Helper()
	out := map[string][]map[string]any{
		"hourlyprices": dumpRows(t, pool, `select symbol, date, time, month, current_month_close, mid_month_close,
			far_month_close, spread from hourlyprices order by symbol, date, time`),
		"stock_futures_current": dumpRows(t, pool, `select `+stockFutureCols+` from stock_futures
			where source = 'current' order by symbol, trading_date, expiry`),
		"stock_futures_archive": dumpRows(t, pool, `select `+stockFutureCols+` from stock_futures
			where source = 'archive' order by symbol, trading_date, expiry`),
		"spread_daily": dumpRows(t, pool, `select symbol, trading_date, near_expiry, mid_expiry, near_close, mid_close,
			spread from spread_daily order by symbol, trading_date`),
		"spread_summary": dumpRows(t, pool, `select id as _id, symbol, observations, first_date, last_date, mean_spread,
			max_spread, min_spread, mean_deviation, max_abs_spread, std_dev_spread, percentile_95,
			mean_reversion_probability from spread_summary order by symbol`),
	}
	for _, r := range out["spread_summary"] {
		if id, _ := r["_id"].(string); !seededIDs[id] {
			r["_id"] = "<new>"
		}
	}
	return out
}

// scenarioRun holds the state of one replayed scenario.
type scenarioRun struct {
	t     *testing.T
	sc    *scenario
	svc   *Service
	store *testStore
	kite  *fakeKite
	clock *fakeClock
	logs  *logSink

	mu         sync.Mutex
	boardError bool
	boardGate  func() // one-shot: runs inside the next GetBoard call

	reviewH, reviewM float64
}

func (r *scenarioRun) step(ctx context.Context, st scenarioStep) error {
	svc := r.svc
	switch st.Op {
	case "capture":
		var k Kite
		if !st.NoKite {
			k = r.kite
		}
		var instruments []market.Instrument
		if !st.NoInstruments {
			instruments = append([]market.Instrument{}, r.sc.Instruments...)
		}
		svc.Hourly.CaptureHourlyPrices(ctx, cloneBoard(r.sc.Board), k, instruments, st.Slot)
	case "drain":
		svc.Hourly.DrainCacheToDB(ctx)
	case "backfill":
		return svc.Hourly.BackfillMissedHours(ctx)
	case "backfill_concurrent":
		entered, release := make(chan struct{}), make(chan struct{})
		r.mu.Lock()
		r.boardGate = func() { close(entered); <-release }
		r.mu.Unlock()
		first := make(chan error, 1)
		go func() { first <- svc.Hourly.BackfillMissedHours(ctx) }()
		<-entered
		err2 := svc.Hourly.BackfillMissedHours(ctx) // returns at once: a run is in progress
		close(release)
		if err1 := <-first; err1 != nil {
			return err1
		}
		return err2
	case "review":
		_, err := svc.Hourly.ReviewDayCompleteness(ctx)
		return err
	case "start_hourly":
		svc.startHourlyScheduler()
	case "start_review":
		r.reviewH, r.reviewM = svc.Hourly.reviewTime()
		svc.startDayReviewScheduler()
	case "start_eod":
		svc.startEODScheduler()
	case "tick":
		switch st.Name {
		case IntervalHourly:
			svc.Hourly.schedulerTick(ctx)
		case IntervalEOD:
			svc.EOD.schedulerTick(ctx)
		case IntervalDayReview:
			svc.Hourly.dayReviewTick(ctx, r.reviewH, r.reviewM)
		default:
			r.t.Fatalf("unknown interval %q", st.Name)
		}
	case "capture_eod":
		return svc.EOD.captureEodData(ctx)
	case "backfill_eod":
		return svc.EOD.BackfillStockFutures(ctx)
	case "compute":
		return svc.EOD.ComputeSpreads(ctx, st.Dates)
	case "recompute":
		return svc.EOD.RecomputeSpreadSummary(ctx)
	case "check":
		return svc.EOD.CheckAndRecomputeSummary(ctx)
	case "session":
		r.kite.setSession(st.Value)
	case "board_error":
		r.mu.Lock()
		r.boardError = st.Value
		r.mu.Unlock()
	case "nse_fno":
		r.store.setReady(st.Value)
	case "fail_writes":
		n := -1
		if st.After != nil {
			n = *st.After
		}
		r.store.failWritesAfter(st.Model, n)
	default:
		r.t.Fatalf("unknown op %q", st.Op)
	}
	return nil
}

func runScenario(t *testing.T, sc scenario) {
	pool := dbtest.New(t)
	seedScenario(t, pool, sc.DB)
	seeded := map[string]bool{}
	for _, r := range sc.DB["spread_summary"] {
		if id, ok := r["_id"].(string); ok {
			seeded[id] = true
		}
	}

	r := &scenarioRun{t: t, sc: &sc, clock: newFakeClock(time.UnixMilli(0).UTC()), logs: &logSink{}, kite: newFakeKite(sc.Kite)}
	deps := Deps{
		Pool: pool,
		Kite: r.kite,
		GetBoard: func(context.Context) ([]BoardItem, error) {
			r.mu.Lock()
			failing, gate := r.boardError, r.boardGate
			r.boardGate = nil
			r.mu.Unlock()
			if gate != nil {
				gate()
			}
			if failing {
				return nil, fmt.Errorf("board unavailable")
			}
			return cloneBoard(sc.Board), nil
		},
		GetAllInstruments: func(context.Context) ([]market.Instrument, error) {
			return append([]market.Instrument{}, sc.Instruments...), nil
		},
		GetLatestTick: func(token int64) (market.Tick, bool) {
			p, ok := sc.Ticks[fmt.Sprint(token)]
			return market.Tick{Token: token, LastPrice: p}, ok
		},
		Env: config.MapGetter(sc.Env),
		// process.env semantics: a key present with "" is set (DAY_REVIEW_TIME "").
		LookupEnv: func(k string) (string, bool) { v, ok := sc.Env[k]; return v, ok },
		Clock:     r.clock,
		Logf:      r.logs.logf,
	}
	r.svc = New(deps)
	t.Cleanup(func() { r.svc.Stop() })
	r.store = newTestStore(r.svc.Store)
	r.svc.EOD.store = r.store
	r.svc.Hourly.store = r.store

	ctx := context.Background()
	for _, st := range sc.Steps {
		if st.At != "" {
			r.clock.set(mustTime(t, st.At))
		}
		if err := r.step(ctx, st); err != nil {
			r.logs.logf("[step error] %s", st.Op) // the call rejected (index.ts logged it)
		}
	}

	requireJSONEqual(t, "kite calls", sc.Expected.KiteCalls, r.kite.recorded())
	if got := r.clock.recordedSleeps(); !slices.Equal(got, sc.Expected.Sleeps) && (len(got) != 0 || len(sc.Expected.Sleeps) != 0) {
		t.Errorf("delays differ\n Node: %v\n  Go: %v", sc.Expected.Sleeps, got)
	}
	gotLogs, wantLogs := r.logs.all(), sc.Expected.Logs
	for i := 0; i < max(len(gotLogs), len(wantLogs)); i++ {
		var g, w string
		if i < len(gotLogs) {
			g = gotLogs[i]
		}
		if i < len(wantLogs) {
			w = wantLogs[i]
		}
		if g != w {
			t.Errorf("log line %d differs\n Node: %q\n  Go: %q", i, w, g)
		}
	}
	got := dumpScenarioDB(t, pool, seeded)
	for table, want := range sc.Expected.DB {
		requireJSONEqual(t, "table "+table, want, got[table])
	}
}

func TestScenariosMatchNode(t *testing.T) {
	var f scenariosFixture
	readFixture(t, "scenarios.json", &f)
	if len(f.Scenarios) < 40 {
		t.Fatalf("only %d scenarios in the fixture", len(f.Scenarios))
	}
	for _, sc := range f.Scenarios {
		t.Run(sc.Name, func(t *testing.T) { runScenario(t, sc) })
	}
}
