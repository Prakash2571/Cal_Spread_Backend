package captures

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/dbtest"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
)

// PostgreSQL behaviour of the capture tables (migration 0005_captures.sql): the Mongo
// upserts are idempotent per key, stock_futures keeps the archive/current split of the
// two old databases, spread_summary keeps its id across recomputes and reads back in
// the shape GET /api/spread-stats returned, and NaN is refused like Mongoose's Number
// cast.

func day(t testing.TB, d string) time.Time { t.Helper(); return mustTime(t, d+"T00:00:00Z") }

func TestStoreWithoutPool(t *testing.T) {
	s := NewStore(nil)
	if s.Ready() {
		t.Fatal("a store without a pool must not be ready")
	}
	ctx := context.Background()
	checks := map[string]error{
		"UpsertHourlyPrice": s.UpsertHourlyPrice(ctx, HourlyPrice{Symbol: "A"}),
		"UpsertStockFuture": s.UpsertStockFuture(ctx, StockFuture{Symbol: "A"}),
		"UpsertSpreadDaily": s.UpsertSpreadDaily(ctx, SpreadDaily{Symbol: "A"}),
		"ReplaceSummaries":  s.ReplaceSpreadSummaries(ctx, nil, nil),
	}
	_, err := s.HourlySlotsSince(ctx, "A", "2026-01-01")
	checks["HourlySlotsSince"] = err
	_, err = s.CountHourlyPrices(ctx, "2026-01-01", []string{"A"})
	checks["CountHourlyPrices"] = err
	_, _, err = s.LatestStockFutureDate(ctx)
	checks["LatestStockFutureDate"] = err
	_, err = s.StockFuturesOn(ctx, SourceCurrent, nil)
	checks["StockFuturesOn"] = err
	_, err = s.SpreadDailyAll(ctx)
	checks["SpreadDailyAll"] = err
	_, _, err = s.LatestSpreadDailyDate(ctx)
	checks["LatestSpreadDailyDate"] = err
	_, _, err = s.LatestSummaryLastDate(ctx)
	checks["LatestSummaryLastDate"] = err
	doc, err := s.SpreadSummary(ctx, "A")
	checks["SpreadSummary"] = err
	if doc != nil {
		t.Error("SpreadSummary without a pool returned a document")
	}
	for name, err := range checks {
		if !errors.Is(err, ErrNoDatabase) {
			t.Errorf("%s: %v, want ErrNoDatabase", name, err)
		}
	}
	var nilStore *Store
	if nilStore.Ready() {
		t.Error("a nil store must not be ready")
	}
}

func TestHourlyUpsertIsIdempotentPerSlot(t *testing.T) {
	s := NewStore(dbtest.New(t))
	ctx := context.Background()
	far := 1020.75
	row := HourlyPrice{Symbol: "M&M", Date: "2026-08-04", Time: "10:00", Month: "2026-08",
		CurrentMonthClose: 1000.5, MidMonthClose: 1010.25, FarMonthClose: &far, Spread: 9.75}
	for i := 0; i < 2; i++ {
		if err := s.UpsertHourlyPrice(ctx, row); err != nil {
			t.Fatal(err)
		}
	}
	// $set of a later capture of the same slot replaces every field, far included.
	row2 := row
	row2.CurrentMonthClose, row2.MidMonthClose, row2.FarMonthClose, row2.Spread = 1001, 1012, nil, 11
	if err := s.UpsertHourlyPrice(ctx, row2); err != nil {
		t.Fatal(err)
	}
	other := HourlyPrice{Symbol: "M&M", Date: "2026-08-04", Time: "15:40", Month: "2026-08",
		CurrentMonthClose: 1, MidMonthClose: 2, Spread: 1}
	if err := s.UpsertHourlyPrice(ctx, other); err != nil {
		t.Fatal(err)
	}
	got, err := s.HourlyPrices(ctx, "2026-08-04")
	if err != nil {
		t.Fatal(err)
	}
	requireJSONEqual(t, "rows", []HourlyPrice{row2, other}, got)

	n, err := s.CountHourlyPrices(ctx, "2026-08-04", []string{"M&M", "M&M", "OTHER"})
	if err != nil || n != 2 {
		t.Fatalf("CountHourlyPrices = %d, %v; want 2 ($in semantics, duplicates do not multiply)", n, err)
	}
	if n, _ := s.CountHourlyPrices(ctx, "2026-08-04", []string{}); n != 0 {
		t.Errorf("empty $in counted %d", n)
	}
}

func TestHourlySlotsSinceComparesDatesBytewiseInNaturalOrder(t *testing.T) {
	s := NewStore(dbtest.New(t))
	ctx := context.Background()
	for _, r := range []DateTimeSlot{
		{"2026-08-05", "11:00"}, {"2026-07-28", "10:00"}, {"2026-08-04", "15:40"}, {"2026-08-04", "10:00"}, {"2026-07-29", "15:30"},
	} {
		if err := s.UpsertHourlyPrice(ctx, HourlyPrice{Symbol: "A", Date: r.Date, Time: r.Time, Month: r.Date[:7], CurrentMonthClose: 1, MidMonthClose: 2, Spread: 1}); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.UpsertHourlyPrice(ctx, HourlyPrice{Symbol: "B", Date: "2026-08-05", Time: "10:00", Month: "2026-08", CurrentMonthClose: 1, MidMonthClose: 2, Spread: 1}); err != nil {
		t.Fatal(err)
	}
	got, err := s.HourlySlotsSince(ctx, "A", "2026-07-29")
	if err != nil {
		t.Fatal(err)
	}
	// Insertion order (Mongo natural order), only date >= "2026-07-29", only symbol A.
	want := []DateTimeSlot{{"2026-08-05", "11:00"}, {"2026-08-04", "15:40"}, {"2026-08-04", "10:00"}, {"2026-07-29", "15:30"}}
	requireJSONEqual(t, "slots", want, got)
}

// utcDay is the instant of new Date(d + "T00:00:00.000Z") for a valid d.
func utcDay(d string) time.Time {
	t, ok := parseJSDay(d)
	if !ok {
		panic("bad day " + d)
	}
	return t
}

func sfRow(symbol, tradingDay, expiry string, closePx float64) StockFuture {
	return StockFuture{TradingDate: utcDay(tradingDay), Symbol: symbol, Instrument: "FUTSTK",
		Expiry: utcDay(expiry), Open: closePx - 1, High: closePx + 1, Low: closePx - 2,
		Close: closePx, SettlePrice: closePx, OpenInterest: 5000}
}

func TestStockFuturesUpsertWritesCurrentOnlyAndIsIdempotent(t *testing.T) {
	pool := dbtest.New(t)
	s := NewStore(pool)
	ctx := context.Background()
	// An archive row with the very same key: the unique key includes the source, as the
	// two databases each had their own unique index.
	insertFixtureRow(t, pool, "stock_futures", map[string]any{"source": "archive"}, map[string]any{
		"trading_date": "2026-03-04T00:00:00.000Z", "symbol": "ALPHA", "instrument": "FUTSTK", "expiry": "2026-03-26T00:00:00.000Z",
		"open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0, "settle_price": 1.0, "contracts": 7.0, "value_lakh": 8.0,
		"open_interest": 9.0, "change_in_oi": 10.0,
	})
	a := sfRow("ALPHA", "2026-03-04", "2026-03-26", 1000)
	for i := 0; i < 2; i++ {
		if err := s.UpsertStockFuture(ctx, a); err != nil {
			t.Fatal(err)
		}
	}
	a.Close, a.SettlePrice, a.OpenInterest = 1001.5, 1001.5, 6000
	if err := s.UpsertStockFuture(ctx, a); err != nil {
		t.Fatal(err)
	}
	rows := dumpRows(t, pool, `select source, symbol, trading_date, expiry, close, settle_price, open_interest, contracts
		from stock_futures order by source, id`)
	want := []map[string]any{
		{"source": "archive", "symbol": "ALPHA", "trading_date": "2026-03-04T00:00:00.000Z", "expiry": "2026-03-26T00:00:00.000Z",
			"close": 1.0, "settle_price": 1.0, "open_interest": 9.0, "contracts": 7.0},
		{"source": "current", "symbol": "ALPHA", "trading_date": "2026-03-04T00:00:00.000Z", "expiry": "2026-03-26T00:00:00.000Z",
			"close": 1001.5, "settle_price": 1001.5, "open_interest": 6000.0, "contracts": 0.0},
	}
	requireJSONEqual(t, "stock_futures", want, rows)
}

func TestStockFuturesReadsRouteBySource(t *testing.T) {
	pool := dbtest.New(t)
	s := NewStore(pool)
	ctx := context.Background()
	if _, ok, err := s.LatestStockFutureDate(ctx); ok || err != nil {
		t.Fatalf("empty table: ok=%v err=%v", ok, err)
	}
	// The archive holds the LATEST trading date, but the backfill start is read from the
	// current database only (StockFuture.findOne().sort({trading_date: -1})).
	for _, r := range []struct {
		src string
		row StockFuture
	}{
		{"archive", sfRow("ALPHA", "2026-06-01", "2026-06-25", 5)},
		{"current", sfRow("ALPHA", "2026-03-05", "2026-03-26", 10)},
		{"current", sfRow("BETA", "2026-03-04", "2026-03-26", 20)},
		{"current", sfRow("ALPHA", "2026-03-04", "2026-04-28", 30)},
		{"archive", sfRow("ALPHA", "2026-03-04", "2026-03-26", 40)},
	} {
		if r.src == "current" {
			if err := s.UpsertStockFuture(ctx, r.row); err != nil {
				t.Fatal(err)
			}
			continue
		}
		insertFixtureRow(t, pool, "stock_futures", map[string]any{"source": "archive"}, map[string]any{
			"trading_date": jsxISO(r.row.TradingDate), "symbol": r.row.Symbol, "instrument": "FUTSTK", "expiry": jsxISO(r.row.Expiry),
			"open": r.row.Open, "high": r.row.High, "low": r.row.Low, "close": r.row.Close,
		})
	}
	latest, ok, err := s.LatestStockFutureDate(ctx)
	if err != nil || !ok || isoDay(latest) != "2026-03-05" {
		t.Fatalf("LatestStockFutureDate = %v %v %v, want 2026-03-05 from the current rows", latest, ok, err)
	}
	closes := func(src Source, days ...string) []float64 {
		t.Helper()
		var ts []time.Time
		for _, d := range days {
			ts = append(ts, day(t, d))
		}
		rows, err := s.StockFuturesOn(ctx, src, ts)
		if err != nil {
			t.Fatal(err)
		}
		out := []float64{}
		for _, r := range rows {
			out = append(out, r.Close)
		}
		return out
	}
	// Natural (insertion) order within a source, $in on exact instants.
	requireJSONEqual(t, "current 03-04", []float64{20, 30}, closes(SourceCurrent, "2026-03-04"))
	requireJSONEqual(t, "current 03-04,03-05", []float64{10, 20, 30}, closes(SourceCurrent, "2026-03-05", "2026-03-04"))
	requireJSONEqual(t, "archive 03-04", []float64{40}, closes(SourceArchive, "2026-03-04"))
	requireJSONEqual(t, "archive none", []float64{}, closes(SourceArchive, "2026-03-05"))
}

func TestComputeSpreadsRoutesDatesByTheCutoff(t *testing.T) {
	pool := dbtest.New(t)
	logs := &logSink{}
	svc := New(Deps{Pool: pool, Clock: newFakeClock(time.Unix(0, 0)), Logf: logs.logf})
	t.Cleanup(func() { svc.Stop() })
	ctx := context.Background()
	seed := func(src, symbol, d, expiry string, closePx float64) {
		insertFixtureRow(t, pool, "stock_futures", map[string]any{"source": src}, map[string]any{
			"trading_date": d + "T00:00:00.000Z", "symbol": symbol, "instrument": "FUTSTK", "expiry": expiry + "T00:00:00.000Z",
			"open": closePx, "high": closePx, "low": closePx, "close": closePx,
		})
	}
	// 2025-12-31 is before the cutoff: only the archive rows count (spread 10, not 1).
	seed("archive", "ALPHA", "2025-12-31", "2026-02-24", 110)
	seed("archive", "ALPHA", "2025-12-31", "2026-01-27", 100)
	seed("current", "ALPHA", "2025-12-31", "2026-01-27", 1)
	seed("current", "ALPHA", "2025-12-31", "2026-02-24", 2)
	// 2026-01-01 is the cutoff itself: current rows (spread 5, not 8).
	seed("current", "ALPHA", "2026-01-01", "2026-01-27", 200)
	seed("current", "ALPHA", "2026-01-01", "2026-02-24", 205)
	seed("archive", "ALPHA", "2026-01-01", "2026-01-27", 1)
	seed("archive", "ALPHA", "2026-01-01", "2026-02-24", 9)
	if err := svc.EOD.ComputeSpreads(ctx, []string{"2025-12-31", "2026-01-01"}); err != nil {
		t.Fatal(err)
	}
	rows, err := svc.Store.SpreadDailyRows(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("%d spread_daily rows, want 2: %+v", len(rows), rows)
	}
	if isoDay(rows[0].TradingDate) != "2025-12-31" || rows[0].Spread != 10 || isoDay(rows[0].NearExpiry) != "2026-01-27" {
		t.Errorf("pre-cutoff row %+v, want the archive spread 10 (near 2026-01-27)", rows[0])
	}
	if isoDay(rows[1].TradingDate) != "2026-01-01" || rows[1].Spread != 5 {
		t.Errorf("cutoff-day row %+v, want the current spread 5", rows[1])
	}
	if err := svc.EOD.ComputeSpreads(ctx, []string{"not-a-date"}); err == nil {
		t.Error("an invalid date must fail the computation (Mongoose CastError)")
	}
}

func TestSpreadDailyUpsertIsIdempotentAndTruncatesToMilliseconds(t *testing.T) {
	pool := dbtest.New(t)
	s := NewStore(pool)
	ctx := context.Background()
	d := SpreadDaily{Symbol: "ALPHA", TradingDate: day(t, "2026-03-04").Add(123456 * time.Nanosecond),
		NearExpiry: day(t, "2026-03-26"), MidExpiry: day(t, "2026-04-28"), NearClose: 1000.15, MidClose: 1012.4, Spread: 1012.4 - 1000.15}
	if err := s.UpsertSpreadDaily(ctx, d); err != nil {
		t.Fatal(err)
	}
	d2 := d
	d2.TradingDate = day(t, "2026-03-04").Add(456 * time.Microsecond) // same millisecond
	d2.MidClose, d2.Spread = 1013, 1013-1000.15
	if err := s.UpsertSpreadDaily(ctx, d2); err != nil {
		t.Fatal(err)
	}
	rows, err := s.SpreadDailyRows(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].MidClose != 1013 || !rows[0].TradingDate.Equal(day(t, "2026-03-04")) {
		t.Fatalf("rows = %+v, want one row (ms-truncated key) with the second values", rows)
	}
	latest, ok, err := s.LatestSpreadDailyDate(ctx)
	if err != nil || !ok || !latest.Equal(day(t, "2026-03-04")) {
		t.Fatalf("LatestSpreadDailyDate = %v %v %v", latest, ok, err)
	}
}

func TestSpreadDailyAllKeepsNaturalOrder(t *testing.T) {
	s := NewStore(dbtest.New(t))
	ctx := context.Background()
	order := []struct {
		sym string
		d   string
	}{{"ZETA", "2026-03-05"}, {"ALPHA", "2026-03-09"}, {"ZETA", "2026-03-02"}, {"ALPHA", "2026-03-03"}}
	for i, o := range order {
		if err := s.UpsertSpreadDaily(ctx, SpreadDaily{Symbol: o.sym, TradingDate: day(t, o.d), NearExpiry: day(t, "2026-03-26"),
			MidExpiry: day(t, "2026-04-28"), NearClose: 1, MidClose: 2, Spread: float64(i)}); err != nil {
			t.Fatal(err)
		}
	}
	all, err := s.SpreadDailyAll(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for i, p := range all {
		if p.Symbol != order[i].sym || isoDay(p.TradingDate) != order[i].d || p.Spread != float64(i) {
			t.Fatalf("row %d = %+v, want insertion order %v", i, p, order)
		}
	}
}

var hexID = regexp.MustCompile(`^[0-9a-f]{24}$`)

func TestSpreadSummaryReplaceKeepsIDsAndReadsBackLikeNode(t *testing.T) {
	pool := dbtest.New(t)
	s := NewStore(pool)
	ctx := context.Background()
	if d, err := s.SpreadSummary(ctx, "M&M"); d != nil || err != nil {
		t.Fatalf("empty table: %v %v", d, err)
	}
	if _, ok, err := s.LatestSummaryLastDate(ctx); ok || err != nil {
		t.Fatalf("empty table: ok=%v err=%v", ok, err)
	}
	a, b := 0.1, 0.2 // a run-time sum (a constant 0.1 + 0.2 would be exactly 0.3)
	mm := SpreadSummary{Symbol: "M&M", Observations: 3, FirstDate: day(t, "2026-03-02"), LastDate: day(t, "2026-03-04"),
		MeanSpread: a + b, MaxSpread: 1e21, MinSpread: math.Copysign(0, -1), MeanDeviation: 1e-7,
		MaxAbsSpread: 12.5, StdDevSpread: 0.8165, Percentile95: -3.25, MeanReversionProbability: 66.67}
	alpha := SpreadSummary{Symbol: "ALPHA", Observations: 1, FirstDate: day(t, "2025-12-31"), LastDate: day(t, "2025-12-31"),
		MeanSpread: 2, MaxSpread: 2, MinSpread: 2, MaxAbsSpread: 2, Percentile95: 2}
	if err := s.ReplaceSpreadSummaries(ctx, []SpreadSummary{mm, alpha}, []string{"M&M", "ALPHA"}); err != nil {
		t.Fatal(err)
	}
	first, err := s.SpreadSummary(ctx, "M&M")
	if err != nil || first == nil {
		t.Fatalf("SpreadSummary(M&M) = %v, %v", first, err)
	}
	if !hexID.MatchString(first.ID) {
		t.Fatalf("id %q is not a 24-hex ObjectId", first.ID)
	}

	// GET /api/spread-stats/:symbol answered res.json(doc) with the lean document: _id
	// (ObjectId.toJSON = hex), the replacement fields in schema order, Dates as
	// toISOString, numbers as JSON.stringify writes them (-0 as 0, 1e21 as 1e+21).
	want := `{"_id":"` + first.ID + `","symbol":"M&M","observations":3,"first_date":"2026-03-02T00:00:00.000Z",` +
		`"last_date":"2026-03-04T00:00:00.000Z","mean_spread":0.30000000000000004,"max_spread":1e+21,"min_spread":0,` +
		`"mean_deviation":1e-7,"max_abs_spread":12.5,"std_dev_spread":0.8165,"percentile_95":-3.25,` +
		`"mean_reversion_probability":66.67}`
	rec := httptest.NewRecorder()
	httpx.JSON(rec, http.StatusOK, *first) // what the core route does
	if got := rec.Body.String(); got != want {
		t.Errorf("route body\n got: %s\nwant: %s", got, want)
	}
	if got := string(jsjson.Marshal(first)); got != want {
		t.Errorf("jsjson pointer encoding differs: %s", got)
	}
	// encoding/json keeps the bytes except its own HTML escaping of the output.
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(*first); err != nil || buf.String() != want+"\n" {
		t.Errorf("encoding/json = %s, %v", buf.String(), err)
	}
	noID := *first
	noID.ID = ""
	if got := string(noID.AppendJS(nil)); !strings.HasPrefix(got, `{"symbol":"M&M",`) {
		t.Errorf("a document without id must omit _id: %s", got)
	}

	// A recompute replaces the fields and keeps the id; a symbol no longer active is
	// deleted; a new one gets a fresh id.
	mm.Observations, mm.MeanSpread, mm.LastDate = 4, 1.5, day(t, "2026-03-05")
	beta := alpha
	beta.Symbol = "BETA"
	if err := s.ReplaceSpreadSummaries(ctx, []SpreadSummary{mm, beta}, []string{"M&M", "BETA"}); err != nil {
		t.Fatal(err)
	}
	all, err := s.SpreadSummaries(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 || all[0].Symbol != "BETA" || all[1].Symbol != "M&M" {
		t.Fatalf("summaries after the recompute: %+v", all)
	}
	if all[1].ID != first.ID || all[1].Observations != 4 || all[1].MeanSpread != 1.5 || isoDay(all[1].LastDate) != "2026-03-05" {
		t.Errorf("M&M after replace = %+v, want the same id %s with the new fields", all[1], first.ID)
	}
	if !hexID.MatchString(all[0].ID) || all[0].ID == first.ID {
		t.Errorf("BETA id %q", all[0].ID)
	}
	if d, _ := s.SpreadSummary(ctx, "ALPHA"); d != nil {
		t.Error("ALPHA should have been deleted ($nin active)")
	}
	if d, _ := s.SpreadSummary(ctx, "m&m"); d != nil {
		t.Error("the lookup is exact; the route upper-cases the symbol first")
	}
	latest, ok, err := s.LatestSummaryLastDate(ctx)
	if err != nil || !ok || isoDay(latest) != "2026-03-05" {
		t.Errorf("LatestSummaryLastDate = %v %v %v", latest, ok, err)
	}
	// An empty active list deletes everything ($nin: []).
	if err := s.ReplaceSpreadSummaries(ctx, nil, nil); err != nil {
		t.Fatal(err)
	}
	if all, _ := s.SpreadSummaries(ctx); len(all) != 0 {
		t.Errorf("%d rows left after deleteMany({$nin: []})", len(all))
	}
}

func TestNaNIsRefusedLikeMongooseNumberCast(t *testing.T) {
	pool := dbtest.New(t)
	s := NewStore(pool)
	ctx := context.Background()
	nan := math.NaN()

	bad := sfRow("ALPHA", "2026-03-04", "2026-03-26", 1000)
	bad.High, bad.OpenInterest = nan, nan
	err := s.UpsertStockFuture(ctx, bad)
	if err == nil || err.Error() != `Cast to Number failed for value "NaN" (type number) at path "high"` {
		t.Fatalf("NaN stock future: %v", err)
	}
	err = s.UpsertHourlyPrice(ctx, HourlyPrice{Symbol: "A", Date: "2026-08-04", Time: "10:00", Month: "2026-08",
		CurrentMonthClose: 1, MidMonthClose: 2, FarMonthClose: &nan, Spread: nan})
	if err == nil || !strings.Contains(err.Error(), `at path "far_month_close"`) {
		t.Fatalf("NaN hourly price: %v", err)
	}
	err = s.UpsertSpreadDaily(ctx, SpreadDaily{Symbol: "A", TradingDate: day(t, "2026-03-04"), NearExpiry: day(t, "2026-03-26"),
		MidExpiry: day(t, "2026-04-28"), NearClose: 1, MidClose: nan, Spread: nan})
	if err == nil || !strings.Contains(err.Error(), `at path "mid_close"`) {
		t.Fatalf("NaN spread_daily: %v", err)
	}
	// Infinity passes the cast (and PostgreSQL stores it), as in Mongoose.
	inf := sfRow("BETA", "2026-03-04", "2026-03-26", math.Inf(1))
	if err := s.UpsertStockFuture(ctx, inf); err != nil {
		t.Fatalf("Infinity: %v", err)
	}
	rows := dumpRows(t, pool, `select symbol, close from stock_futures order by id`)
	if len(rows) != 1 || rows[0]["symbol"] != "BETA" || !math.IsInf(rows[0]["close"].(float64), 1) {
		t.Fatalf("rows = %v, want only the Infinity row", rows)
	}

	// The ordered bulkWrite cast every replacement first: a NaN statistic writes nothing
	// and deletes nothing.
	keep := SpreadSummary{Symbol: "KEEP", Observations: 1, FirstDate: day(t, "2026-03-02"), LastDate: day(t, "2026-03-02")}
	if err := s.ReplaceSpreadSummaries(ctx, []SpreadSummary{keep}, []string{"KEEP"}); err != nil {
		t.Fatal(err)
	}
	other := keep
	other.Symbol, other.StdDevSpread = "NEW", nan
	if err := s.ReplaceSpreadSummaries(ctx, []SpreadSummary{other}, []string{"NEW"}); err == nil {
		t.Fatal("NaN summary accepted")
	}
	if all, _ := s.SpreadSummaries(ctx); len(all) != 1 || all[0].Symbol != "KEEP" {
		t.Fatalf("summaries = %+v, want KEEP untouched", all)
	}
}

func TestDrainStopsAtARowMongooseWouldRefuse(t *testing.T) {
	pool := dbtest.New(t)
	logs := &logSink{}
	svc := New(Deps{Pool: pool, Clock: newFakeClock(time.Unix(0, 0)), Logf: logs.logf})
	t.Cleanup(func() { svc.Stop() })
	ctx := context.Background()
	bad := sfRow("ALPHA", "2026-03-04", "2026-03-26", math.NaN())
	svc.EOD.pushStockFuture(bad)
	svc.EOD.pushStockFuture(sfRow("BETA", "2026-03-04", "2026-03-26", 10))
	svc.EOD.drainStockFutures(ctx)
	if n := svc.EOD.PendingStockFutures(); n != 2 {
		t.Fatalf("%d rows queued, want both (the refused head blocks the queue, as in Node)", n)
	}
	if logs.count("[EODCapture] Failed to upsert stock_futures ALPHA: <error>") != 1 {
		t.Errorf("logs = %q", logs.all())
	}
	if rows := dumpRows(t, pool, `select symbol from stock_futures`); len(rows) != 0 {
		t.Errorf("rows written: %v", rows)
	}
}

func jsxISO(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
