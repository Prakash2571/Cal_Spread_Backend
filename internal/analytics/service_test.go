package analytics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/dbtest"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kv"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// istT is epoch ms of an IST wall-clock time.
func istT(y, mo, d, h, mi, s int) int64 {
	return time.Date(y, time.Month(mo), d, h, mi, s, 0, time.UTC).UnixMilli() - istOffsetMs
}

type testClock struct{ ms atomic.Int64 }

func (c *testClock) now() time.Time { return time.UnixMilli(c.ms.Load()) }
func (c *testClock) set(ms int64)   { c.ms.Store(ms) }

// syntheticQuotes answers getQuoteFull for a universe with deterministic values: OI and
// prices move with the minute, the stamp is the IST time of the clock (a trading day).
func syntheticQuotes(universe []market.Instrument, clk *testClock, calls *atomic.Int64) func(context.Context, []string) ([]kite.FullQuote, error) {
	byID := map[string]market.Instrument{}
	for _, in := range universe {
		byID[in.Exchange+":"+in.Tradingsymbol] = in
	}
	return func(ctx context.Context, ids []string) ([]kite.FullQuote, error) {
		if calls != nil {
			calls.Add(1)
		}
		now := clk.ms.Load()
		m := (now + istOffsetMs) / minuteMs
		seen := map[int64]bool{}
		var out []kite.FullQuote
		for _, id := range ids {
			in, ok := byID[id]
			if !ok || seen[in.InstrumentToken] {
				continue
			}
			seen[in.InstrumentToken] = true
			tok := in.InstrumentToken
			q := kite.FullQuote{InstrumentToken: tok, LastTradeTime: istDateTime(now)}
			if in.Segment == "INDICES" {
				q.LastPrice = 24990 + float64(m%40)
			} else {
				q.LastPrice = float64(tok%97) + float64(m%13)/4 + 20
				q.OI = float64(tok%1000*75 + m%50)
			}
			q.Close = q.LastPrice - 1
			out = append(out, q)
		}
		return out, nil
	}
}

func goldenUniverse(t *testing.T, name string) []market.Instrument {
	return loadAnalyticsGolden(t).Universes[name]
}

func allow(string) bool { return true }

// frameJSON is the frames' JSON, keeping only points with t <= upTo.
func frameJSON(s *Service, upTo int64) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var parts []string
	for i, f := range frames {
		var opt []OiAggPoint
		for _, p := range s.oiFrames[i] {
			if p.T <= upTo {
				opt = append(opt, *p)
			}
		}
		var fut []FutOiPoint
		for _, p := range s.futFrames[i] {
			if p.T <= upTo {
				fut = append(fut, *p)
			}
		}
		parts = append(parts, f.Key+"="+js(opt)+"|"+js(fut))
	}
	return strings.Join(parts, "\n")
}

// TestCacheRoundTripOnPostgres: what one process writes behind is exactly what the next
// warm-loads (closed buckets, chain snapshots, the previous close, futures contracts), and
// every key carries its Node TTL.
func TestCacheRoundTripOnPostgres(t *testing.T) {
	pool := dbtest.New(t)
	clk := &testClock{}
	cache := kv.New(pool, clk.now)
	uni := goldenUniverse(t, "small")
	ctx := context.Background()
	deps := func() Deps {
		return Deps{
			Instruments:    func(context.Context) ([]market.Instrument, error) { return uni, nil },
			QuoteFull:      syntheticQuotes(uni, clk, nil),
			CaptureAllowed: allow,
			Cache:          cache,
			Now:            clk.now,
			AfterFunc:      (&fakeTimers{}).afterFunc,
			Sleep:          func(context.Context, time.Duration) error { return nil },
			Logf:           t.Logf,
		}
	}
	a := New(deps())
	// Today's baseline (persisted at once, like persistPrevClose).
	clk.set(istT(2026, 10, 27, 9, 58, 0))
	a.mu.Lock()
	a.prevClose = &PrevClose{ForDay: "2026-10-27", ClosedOn: "2026-10-26", Expiry: "2026-10-27", Complete: true,
		Order: []int64{10000000, 10000001}, Tokens: map[int64]OiLtp{10000000: {OI: 1, LTP: 2.5}, 10000001: {OI: 3, LTP: 4.25}}}
	a.persistPrevCloseLocked()
	a.mu.Unlock()
	a.wg.Wait()

	var last int64
	for _, hm := range [][2]int{{9, 58}, {9, 59}, {10, 0}, {10, 1}, {10, 2}, {10, 3}} {
		last = istT(2026, 10, 27, hm[0], hm[1], 57)
		clk.set(last)
		a.captureOptionOi(ctx)
		a.captureFuturesOi(ctx)
	}
	a.wg.Wait()
	clk.set(istT(2026, 10, 27, 10, 4, 10))
	flushAt := clk.ms.Load()
	a.flush()
	a.mu.Lock()
	pending := a.hasPendingLocked()
	a.mu.Unlock()
	if pending {
		t.Fatal("writes still pending after a successful flush")
	}

	// The forming bucket of each frame (end after the last capture) was never written.
	b := New(deps())
	b.WarmLoad(ctx)
	if got, want := frameJSON(b, last), frameJSON(a, last); got != want {
		t.Fatalf("warm-loaded frames differ\n got %s\nwant %s", got, want)
	}
	a.mu.Lock()
	wantMin, wantHour := js(a.chainMin), js(a.chainHour)
	wantPrev := string(a.prevClose.AppendJS(nil))
	wantKnown := js(a.futKnown.Values())
	a.mu.Unlock()
	b.mu.Lock()
	gotMin, gotHour := js(b.chainMin), js(b.chainHour)
	gotPrev := ""
	if b.prevClose != nil {
		gotPrev = string(b.prevClose.AppendJS(nil))
	}
	gotKnown := js(b.futKnown.Values())
	b.mu.Unlock()
	if gotMin != wantMin || gotHour != wantHour {
		t.Fatalf("chain snapshots differ\n got %s / %s\nwant %s / %s", clip(gotMin, 300), clip(gotHour, 300), clip(wantMin, 300), clip(wantHour, 300))
	}
	if gotPrev != wantPrev {
		t.Fatalf("prev close: got %s want %s", gotPrev, wantPrev)
	}
	if gotKnown != wantKnown {
		t.Fatalf("contracts: got %s want %s", gotKnown, wantKnown)
	}

	// TTLs: retention + 1 day per frame key, 2 d / 5 d for the snapshots, 2 d for the
	// baseline, 8 d for the contracts (the EXPIRE went out with the first write).
	wantTTL := map[string]int64{
		"oiframe:v2:1m": 172800, "oiframe:v2:5m": 345600, "oiframe:v2:15m": 691200, "oiframe:v2:1h": 691200,
		"futoiframe:1m": 172800, "futoiframe:5m": 345600, "futoiframe:15m": 691200, "futoiframe:1h": 691200,
		"chainsnap:min:2026-10-27": 172800, "chainsnap:hour:2026-10-27": 432000,
		"prevclose": 172800, "futcontracts": 691200,
	}
	setAt := map[string]int64{"prevclose": istT(2026, 10, 27, 9, 58, 0)}
	rows, err := pool.Query(ctx, `select key, expires_at from kv_keys order by key`)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]time.Time{}
	for rows.Next() {
		var k string
		var at *time.Time
		if err := rows.Scan(&k, &at); err != nil {
			t.Fatal(err)
		}
		if at == nil {
			t.Errorf("key %s has no expiry", k)
			continue
		}
		got[strings.TrimPrefix(k, kv.Prefix)] = *at
	}
	rows.Close()
	for key, ttl := range wantTTL {
		base, ok := setAt[key]
		if !ok {
			base = flushAt
		}
		at, ok := got[key]
		if !ok {
			t.Errorf("key %s missing in kv_keys (have %v)", key, keysOf(got))
			continue
		}
		if want := time.UnixMilli(base + ttl*1000); !at.Equal(want) {
			t.Errorf("key %s expires %v, want %v", key, at.UTC(), want.UTC())
		}
	}
	if len(got) != len(wantTTL) {
		t.Errorf("kv keys %v, want exactly %v", keysOf(got), len(wantTTL))
	}

	// Within 15 minutes the TTL is not re-sent; after 15 minutes it is.
	clk.set(istT(2026, 10, 27, 10, 4, 57))
	a.captureOptionOi(ctx)
	clk.set(istT(2026, 10, 27, 10, 5, 0))
	a.flush()
	if at := expiry(t, pool, "oiframe:v2:1m"); !at.Equal(time.UnixMilli(flushAt + 172800*1000)) {
		t.Errorf("TTL moved within 15 minutes: %v", at.UTC())
	}
	clk.set(istT(2026, 10, 27, 10, 19, 57))
	a.captureOptionOi(ctx)
	clk.set(istT(2026, 10, 27, 10, 20, 0))
	a.flush()
	if at, want := expiry(t, pool, "oiframe:v2:1m"), time.UnixMilli(istT(2026, 10, 27, 10, 20, 0)+172800*1000); !at.Equal(want) {
		t.Errorf("TTL after 15 minutes = %v, want %v", at.UTC(), want.UTC())
	}
}

func keysOf(m map[string]time.Time) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func expiry(t *testing.T, pool *db.Pool, key string) time.Time {
	t.Helper()
	var at time.Time
	if err := pool.QueryRow(context.Background(), `select expires_at from kv_keys where key = $1`, kv.Prefix+key).Scan(&at); err != nil {
		t.Fatalf("expiry of %s: %v", key, err)
	}
	return at
}

// failingCache fails the next n calls, then behaves like the wrapped cache.
type failingCache struct {
	Cache
	mu sync.Mutex
	n  int
}

func (f *failingCache) fail() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.n > 0 {
		f.n--
		return errors.New("simulated database outage")
	}
	return nil
}

func (f *failingCache) HSet(ctx context.Context, k string, m map[string]string) error {
	if err := f.fail(); err != nil {
		return err
	}
	return f.Cache.HSet(ctx, k, m)
}

func (f *failingCache) Set(ctx context.Context, k, v string, ttl time.Duration) error {
	if err := f.fail(); err != nil {
		return err
	}
	return f.Cache.Set(ctx, k, v, ttl)
}

func (f *failingCache) HDel(ctx context.Context, k string, fields ...string) error {
	if err := f.fail(); err != nil {
		return err
	}
	return f.Cache.HDel(ctx, k, fields...)
}

func (f *failingCache) Expire(ctx context.Context, k string, ttl time.Duration) (bool, error) {
	if err := f.fail(); err != nil {
		return false, err
	}
	return f.Cache.Expire(ctx, k, ttl)
}

// TestOutageRequeueAndShutdownFlushOnPostgres: a failed flush keeps its writes, three
// failures mute the cache for 60 s, retention drops reach the database, and FlushNow (the
// final flush at shutdown) writes what is still buffered despite the cooldown.
func TestOutageRequeueAndShutdownFlushOnPostgres(t *testing.T) {
	pool := dbtest.New(t)
	clk := &testClock{}
	inner := kv.New(pool, clk.now)
	fc := &failingCache{Cache: inner}
	timers := &fakeTimers{}
	s := New(Deps{Cache: fc, Now: clk.now, AfterFunc: timers.afterFunc, Logf: t.Logf})
	ctx := context.Background()
	agg := OiAggPoint{TotalCe: 1, TotalPe: 2, Straddle: 3, Spot: 25000}

	clk.set(istT(2026, 10, 27, 9, 30, 57))
	s.mu.Lock()
	s.appendOiFrameLiveLocked(clk.ms.Load(), agg)
	clk.set(istT(2026, 10, 27, 9, 31, 57))
	s.appendOiFrameLiveLocked(clk.ms.Load(), agg) // closes 09:31
	s.mu.Unlock()

	fc.n = 3
	for i := 0; i < 3; i++ {
		s.flush()
	}
	m, _ := inner.HGetAll(ctx, "oiframe:v2:1m")
	if len(m) != 0 {
		t.Fatalf("failed flushes wrote %v", m)
	}
	s.mu.Lock()
	muted := s.mutedUntil
	pending := s.hasPendingLocked()
	s.mu.Unlock()
	if muted != clk.ms.Load()+60000 || !pending {
		t.Fatalf("after 3 failures: mutedUntil=%d pending=%v", muted, pending)
	}
	s.flush() // muted: nothing is sent
	if m, _ := inner.HGetAll(ctx, "oiframe:v2:1m"); len(m) != 0 {
		t.Fatal("flush ran during the cooldown")
	}
	// After the cooldown the requeued bucket reaches the database.
	clk.ms.Add(61_000)
	s.flush()
	closed := strconv.FormatInt(istT(2026, 10, 27, 9, 31, 0), 10)
	if m, _ := inner.HGetAll(ctx, "oiframe:v2:1m"); len(m) != 1 || m[closed] == "" {
		t.Fatalf("after the outage the 1m hash is %v, want the requeued %s bucket", m, closed)
	}

	// A day later every point leaves the 1m frame; the drop is queued as HDEL.
	clk.set(istT(2026, 10, 28, 9, 32, 57))
	s.mu.Lock()
	s.appendOiFrameLiveLocked(clk.ms.Load(), agg)
	s.mu.Unlock()

	// Shutdown: Stop, then the final flush, which does not wait out a cooldown.
	s.mu.Lock()
	s.mutedUntil = clk.ms.Load() + 60000
	s.mu.Unlock()
	if err := s.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.FlushNow(ctx); err != nil {
		t.Fatal(err)
	}
	m, err := inner.HGetAll(ctx, "oiframe:v2:1m")
	if err != nil {
		t.Fatal(err)
	}
	if len(m) != 0 {
		// The pruned buckets of the 27th were deleted; 09:33 on the 28th is still forming.
		t.Fatalf("1m hash after FlushNow = %v, want empty", m)
	}
	m5, _ := inner.HGetAll(ctx, "oiframe:v2:5m")
	if want := strconv.FormatInt(istT(2026, 10, 27, 9, 35, 0), 10); len(m5) != 1 || m5[want] == "" {
		t.Fatalf("5m hash = %v, want the 09:35 bucket of the 27th only", m5)
	}
	s.mu.Lock()
	pending = s.hasPendingLocked()
	s.mu.Unlock()
	if pending {
		t.Fatal("FlushNow left writes pending")
	}
}

// TestFlushNowWaitsForFlushInFlight: the final flush waits for a flush in progress and
// then sends what was queued meanwhile.
func TestFlushNowWaitsForFlushInFlight(t *testing.T) {
	clk := &testClock{}
	clk.set(istT(2026, 10, 27, 9, 30, 57))
	gate := make(chan struct{})
	started := make(chan struct{}, 1)
	bc := &blockingCache{fakeCache: newFakeCache(func() int64 { return clk.ms.Load() }, nil), gate: gate, started: started}
	s := New(Deps{Cache: bc, Now: clk.now, AfterFunc: (&fakeTimers{}).afterFunc, Logf: t.Logf})
	s.mu.Lock()
	s.queuePlainWriteLocked("futcontracts", []FutContract{{Token: 1, Expiry: "2026-10-27"}}, 60)
	s.voidFlushLocked()
	s.mu.Unlock()
	<-started
	s.mu.Lock()
	s.queuePlainWriteLocked("prevclose", &PrevClose{ForDay: "2026-10-27", Tokens: map[int64]OiLtp{}}, 60)
	s.mu.Unlock()
	done := make(chan error, 1)
	go func() { done <- s.FlushNow(context.Background()) }()
	select {
	case <-done:
		t.Fatal("FlushNow returned while a flush was in flight")
	case <-time.After(50 * time.Millisecond):
	}
	close(gate)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"futcontracts", "prevclose"} {
		if _, ok, _ := bc.fakeCache.Get(context.Background(), k); !ok {
			t.Errorf("%s not written", k)
		}
	}
	_ = s.Stop(context.Background())
}

type blockingCache struct {
	*fakeCache
	gate    chan struct{}
	started chan struct{}
	once    sync.Once
}

// TestFlushAskedDuringFlightRunsAfterIt: a flush requested while one is in flight is not
// dropped (flushAgain); it runs as soon as the first settles, without the caller waiting.
func TestFlushAskedDuringFlightRunsAfterIt(t *testing.T) {
	clk := &testClock{}
	clk.set(istT(2026, 10, 27, 9, 30, 57))
	gate := make(chan struct{})
	started := make(chan struct{}, 1)
	bc := &blockingCache{fakeCache: newFakeCache(func() int64 { return clk.ms.Load() }, nil), gate: gate, started: started}
	s := New(Deps{Cache: bc, Now: clk.now, AfterFunc: (&fakeTimers{}).afterFunc, Logf: t.Logf})
	s.mu.Lock()
	s.queuePlainWriteLocked("futcontracts", []FutContract{{Token: 1, Expiry: "2026-10-27"}}, 60)
	s.voidFlushLocked()
	s.mu.Unlock()
	<-started
	s.mu.Lock()
	s.queuePlainWriteLocked("prevclose", &PrevClose{ForDay: "2026-10-27", Tokens: map[int64]OiLtp{}}, 60)
	s.mu.Unlock()
	returned := make(chan struct{})
	go func() {
		s.flush() // in flight: records the request and returns at once
		close(returned)
	}()
	select {
	case <-returned:
	case <-time.After(5 * time.Second):
		t.Fatal("flush blocked behind the flush in flight")
	}
	s.mu.Lock()
	again := s.flushAgain
	s.mu.Unlock()
	if !again {
		t.Fatal("the request was not recorded")
	}
	close(gate)
	s.wg.Wait()
	if _, ok, _ := bc.fakeCache.Get(context.Background(), "prevclose"); !ok {
		t.Fatal("the re-run flush did not send the write queued during the first")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.flushInFlight || s.flushAgain || s.hasPendingLocked() {
		t.Fatalf("after the re-run: inFlight=%v again=%v pending=%v", s.flushInFlight, s.flushAgain, s.hasPendingLocked())
	}
}

func (b *blockingCache) Set(ctx context.Context, k, v string, ttl time.Duration) error {
	b.once.Do(func() {
		b.started <- struct{}{}
		<-b.gate
	})
	return b.fakeCache.Set(ctx, k, v, ttl)
}

// ---------------------------------------------------------------------------
// The real Kite REST client against a loopback fake.

type fakeKite struct {
	mu       sync.Mutex
	uni      []market.Instrument
	clk      *testClock
	requests []string
	failAuth bool
}

func (f *fakeKite) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, r.Method+" "+r.URL.Path+"?"+r.URL.RawQuery+" auth="+r.Header.Get("Authorization")+" v="+r.Header.Get("X-Kite-Version"))
	w.Header().Set("Content-Type", "application/json")
	if f.failAuth {
		w.WriteHeader(403)
		_, _ = w.Write([]byte(`{"status":"error","message":"Incorrect api_key or access_token.","error_type":"TokenException"}`))
		return
	}
	now := f.clk.ms.Load()
	m := (now + istOffsetMs) / minuteMs
	switch {
	case r.URL.Path == "/quote":
		q, _ := url.ParseQuery(r.URL.RawQuery)
		data := jsjson.NewObject(nil)
		for _, id := range q["i"] {
			for _, in := range f.uni {
				if in.Exchange+":"+in.Tradingsymbol != id {
					continue
				}
				o := orderedJSON{"instrument_token", in.InstrumentToken}
				if in.Segment == "INDICES" {
					o = append(o, "last_price", 24990+float64(m%40), "ohlc", orderedJSON{"close", 24900.5}, "exchange_timestamp", istDateTime(now))
				} else {
					o = append(o, "last_price", float64(in.InstrumentToken%97)+20, "ohlc", orderedJSON{"close", 19.5}, "oi", float64(in.InstrumentToken%1000*75), "last_trade_time", istDateTime(now))
				}
				data.Field(id, o)
				break
			}
		}
		_, _ = w.Write(jsjson.NewObject(nil).Field("status", "success").Field("data", jsjson.RawObject(func(dst []byte) []byte { return append(dst, data.End()...) })).End())
	case strings.HasPrefix(r.URL.Path, "/instruments/historical/"):
		parts := strings.Split(r.URL.Path, "/")
		tok, _ := strconv.ParseInt(parts[3], 10, 64)
		interval := parts[4]
		q, _ := url.ParseQuery(r.URL.RawQuery)
		from, _ := time.ParseInLocation("2006-01-02 15:04:05", q.Get("from"), time.FixedZone("IST", 19800))
		to, _ := time.ParseInLocation("2006-01-02 15:04:05", q.Get("to"), time.FixedZone("IST", 19800))
		var candles []any
		if interval == "day" {
			for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
				if wd := d.Weekday(); wd == time.Saturday || wd == time.Sunday {
					continue
				}
				day := d.Format("2006-01-02")
				candles = append(candles, []any{day + "T00:00:00+0530", 1, 2, 0.5, float64(tok%89) + 10, 1000, float64(tok%1000*75 + 7)})
			}
		} else {
			for c := from.Truncate(time.Minute); !c.After(to); c = c.Add(time.Minute) {
				ist := c.In(time.FixedZone("IST", 19800))
				mins := ist.Hour()*60 + ist.Minute()
				if mins < 9*60+15 || mins > 15*60+39 {
					continue
				}
				close := float64(tok%89) + float64(ist.Minute())/10
				if tok == 256265 {
					close = 25000 + float64(ist.Minute())
				}
				row := []any{ist.Format("2006-01-02T15:04:05-0700"), close, close, close, close, 10}
				if q.Get("oi") == "1" {
					row = append(row, float64(tok%1000*75+int64(ist.Minute())))
				}
				candles = append(candles, row)
			}
		}
		if candles == nil {
			candles = []any{}
		}
		_, _ = w.Write(jsjson.NewObject(nil).Field("status", "success").Field("data", orderedJSON{"candles", candles}).End())
	default:
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"status":"error","message":"not found"}`))
	}
}

func (f *fakeKite) reqs() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.requests...)
}

// TestCaptureAndBackfillThroughLoopbackKite runs the captures and backfills through the
// real kite.Client (request shapes, auth header, historical gate) against a local fake;
// a 403 then clears the session and the Zerodha gate stops further captures.
func TestCaptureAndBackfillThroughLoopbackKite(t *testing.T) {
	uni := goldenUniverse(t, "small")
	clk := &testClock{}
	clk.set(istT(2026, 10, 27, 10, 5, 57))
	fk := &fakeKite{uni: uni, clk: clk}
	srv := httptest.NewServer(fk)
	defer srv.Close()
	client, err := kite.NewClient(kite.Config{APIKey: "api-key", APISecret: "secret", APIRoot: srv.URL, HistoricalGate: kite.NewHistoricalGate(0, 20*time.Second)})
	if err != nil {
		t.Fatal(err)
	}
	client.SetAccessToken("access-token")
	var logs []string
	var logMu sync.Mutex
	s := New(Deps{
		Instruments:        func(context.Context) ([]market.Instrument, error) { return uni, nil },
		QuoteFull:          client.GetQuoteFull,
		Historical:         client.GetHistorical,
		HistoricalOiSeries: client.GetHistoricalOiSeries,
		CaptureAllowed:     ZerodhaCaptureGate(func() brokers.ID { return brokers.Zerodha }, client.HasSession, nil),
		Now:                clk.now,
		AfterFunc:          (&fakeTimers{}).afterFunc,
		Sleep:              func(context.Context, time.Duration) error { return nil },
		Logf: func(f string, a ...any) {
			logMu.Lock()
			logs = append(logs, fmt.Sprintf(f, a...))
			logMu.Unlock()
		},
	})
	ctx := context.Background()
	s.mu.Lock()
	s.prevClose = &PrevClose{ForDay: "2026-10-26", Tokens: map[int64]OiLtp{}} // stale: today's is missing
	s.mu.Unlock()
	s.captureOptionOi(ctx)
	s.captureFuturesOi(ctx)
	s.wg.Wait() // the capture asked for today's baseline (void backfillPrevClose)
	from := istT(2026, 10, 27, 9, 50, 0)
	s.backfillOiFrames(ctx, &from)
	s.backfillFutOiFrames(ctx, &from)

	reqs := fk.reqs()
	auth := " auth=token api-key:access-token v=3"
	if len(reqs) == 0 || !strings.HasPrefix(reqs[0], "GET /quote?i=NSE%3ANIFTY%2050&i=NFO%3ANIFTY261027") || !strings.HasSuffix(reqs[0], auth) {
		t.Fatalf("first request %q", reqs[0])
	}
	var day, minute, spot int
	for _, r := range reqs {
		switch {
		case strings.Contains(r, "/instruments/historical/256265/minute?from=2026-10-27%2009%3A50%3A00&to=2026-10-27%2010%3A05%3A57 "):
			spot++ // the spot series is asked for without oi=1
		case strings.Contains(r, "/day?") && strings.Contains(r, "&oi=1"):
			day++
		case strings.Contains(r, "/minute?") && strings.Contains(r, "&oi=1"):
			minute++
		}
		if !strings.HasSuffix(r, auth) {
			t.Errorf("request without the Kite auth headers: %s", r)
		}
	}
	// Previous close: 22 band tokens (11 strikes × CE/PE, all inside ±60) of daily candles;
	// frames: the spot, 22 option tokens and 3 futures of minute candles.
	if spot != 1 || day != 22 || minute != 25 {
		t.Fatalf("historical requests: spot=%d day=%d minute(oi)=%d\n%s", spot, day, minute, strings.Join(reqs, "\n"))
	}
	s.mu.Lock()
	pc := s.prevClose
	n1m := len(s.oiFrames[0])
	var backfilled, live int
	for _, p := range s.oiFrames[0] {
		if p.HasWLo {
			backfilled++
		} else {
			live++
		}
	}
	nFut := len(s.futFrames[0])
	s.mu.Unlock()
	if pc == nil || pc.ForDay != "2026-10-27" || pc.ClosedOn != "2026-10-26" || !pc.Complete || len(pc.Order) != 22 {
		t.Fatalf("prev close = %+v", pc)
	}
	// 09:50..10:05 candles fill the buckets 09:51..10:06; the live 10:06 bucket wins.
	if n1m != 16 || live != 1 || backfilled != 15 || nFut != 16 {
		t.Fatalf("1m frame: %d points (%d live, %d backfilled), futures %d", n1m, live, backfilled, nFut)
	}

	// Kite answers 403: the capture logs the failure, the client drops the session and the
	// gate closes for every recorder.
	fk.mu.Lock()
	fk.failAuth = true
	fk.mu.Unlock()
	clk.set(istT(2026, 10, 27, 10, 6, 57))
	s.captureOptionOi(ctx)
	if client.HasSession() {
		t.Fatal("a 403 from /quote must clear the Kite session")
	}
	before := len(fk.reqs())
	s.captureOptionOi(ctx)
	s.captureFuturesOi(ctx)
	if len(fk.reqs()) != before {
		t.Fatal("captures ran without a session")
	}
	logMu.Lock()
	defer logMu.Unlock()
	if !containsLine(logs, "[OptionOI] capture failed: Incorrect api_key or access_token.") {
		t.Fatalf("logs: %q", logs)
	}
}

func containsLine(lines []string, want string) bool {
	for _, l := range lines {
		if l == want {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Routes: behaviour the golden cannot drive (Express's request parsing and sendError).

func newRouteService(t *testing.T, d Deps) (*Service, chi.Router) {
	t.Helper()
	if d.Now == nil {
		clk := &testClock{}
		clk.set(istT(2026, 10, 27, 11, 0, 0))
		d.Now = clk.now
	}
	if d.Instruments == nil {
		uni := goldenUniverse(t, "chain")
		d.Instruments = func(context.Context) ([]market.Instrument, error) { return uni, nil }
	}
	s := New(d)
	r := chi.NewRouter()
	s.Mount(r)
	return s, r
}

func get(r http.Handler, target string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest("GET", target, nil))
	return rec
}

func TestRouteParamDecodingAndErrors(t *testing.T) {
	var cleared atomic.Int64
	_, r := newRouteService(t, Deps{KiteAuthFailed: func() { cleared.Add(1) }})
	// Escapes that do not decode to UTF-8 are Express's 400 page on every analytics route
	// (decodeURIComponent throws URIError; a lone surrogate counts too).
	for _, p := range []string{"/api/option-chain/%C3%28", "/api/option-oi-frame/%E0%A4", "/api/option-oi-baseline/%FF", "/api/futures-oi-frame/%C0%AF", "/api/option-prev-close/%ED%A0%80", "/api/option-oi-series/%F4%90%80%80"} {
		rec := get(r, p)
		want := "URIError: Failed to decode param &#39;" + strings.TrimPrefix(p[strings.LastIndex(p, "/"):], "/") + "&#39;"
		if rec.Code != 400 || !strings.Contains(rec.Body.String(), want) || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/html") {
			t.Errorf("%s: %d %q", p, rec.Code, rec.Body.String())
		}
	}
	// A decoded underlying: %4E is N.
	if rec := get(r, "/api/option-chain/%4EIFTY?band=5"); rec.Code != 200 || !strings.HasPrefix(rec.Body.String(), `{"underlying":"NIFTY","name":"NIFTY 50"`) {
		t.Errorf("decoded param: %d %s", rec.Code, clip(rec.Body.String(), 200))
	}

	// sendError: a KiteError keeps its status (and 401/403 clears the session), anything
	// else is 500 with the message.
	for _, c := range []struct {
		err    error
		status int
		body   string
		clears int64
	}{
		{&kite.KiteError{Status: 403, Message: "Incorrect api_key or access_token."}, 403, `{"error":"Incorrect api_key or access_token."}`, 1},
		{&kite.KiteError{Status: 429, Message: "Too many requests"}, 429, `{"error":"Too many requests"}`, 0},
		{&kite.KiteError{Status: 200, Message: "odd"}, 200, `{"error":"odd"}`, 0},
		{errors.New("instrument dump unavailable"), 500, `{"error":"instrument dump unavailable"}`, 0},
	} {
		cleared.Store(0)
		_, r := newRouteService(t, Deps{
			KiteAuthFailed: func() { cleared.Add(1) },
			Instruments:    func(context.Context) ([]market.Instrument, error) { return nil, c.err },
		})
		rec := get(r, "/api/option-chain/NIFTY")
		if rec.Code != c.status || rec.Body.String() != c.body || cleared.Load() != c.clears {
			t.Errorf("%v: %d %s (cleared %d)", c.err, rec.Code, rec.Body.String(), cleared.Load())
		}
	}

	// requireMarketData with no problems list still sends "problems": [].
	_, r = newRouteService(t, Deps{MarketData: func() Readiness { return Readiness{Broker: brokers.Zerodha} }})
	rec := get(r, "/api/option-chain/NIFTY")
	if want := `{"error":"Option chain requires a Zerodha session. Connect Zerodha.","broker":"zerodha","problems":[]}`; rec.Code != 401 || rec.Body.String() != want {
		t.Errorf("401: %d %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("content type %q", ct)
	}

	// Query parsing follows node:querystring: an invalid escape stays literal (band NaN →
	// no strikes), "+" is a space.
	_, r = newRouteService(t, Deps{})
	rec = get(r, "/api/option-chain/NIFTY?band=%zz")
	var body struct {
		Strikes []any `json:"strikes"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if rec.Code != 200 || len(body.Strikes) != 0 {
		t.Errorf("band=%%zz: %d %s", rec.Code, clip(rec.Body.String(), 200))
	}
	rec = get(r, "/api/option-chain/NIFTY?expiry=+2026-11-03+&band=5")
	if !strings.Contains(rec.Body.String(), `"expiry":"2026-11-03"`) {
		t.Errorf("expiry with + spaces: %s", clip(rec.Body.String(), 300))
	}
}

func TestNodeQuery(t *testing.T) {
	cases := []struct {
		raw  string
		want map[string][]string
	}{
		{"", map[string][]string{}},
		{"a=1&a=2&b", map[string][]string{"a": {"1", "2"}, "b": {""}}},
		{"x=%zz&y=%41%42&z=a+b&w=%E2%82%AC", map[string][]string{"x": {"%zz"}, "y": {"AB"}, "z": {"a b"}, "w": {"€"}}},
		{"&&=v&k=a=b", map[string][]string{"": {"v"}, "k": {"a=b"}}},
		{"q=%41%zz", map[string][]string{"q": {"A%zz"}}},
		{"s=a;b", map[string][]string{"s": {"a;b"}}},
	}
	for _, c := range cases {
		got := nodeQuery(c.raw)
		if js(got) != js(c.want) {
			t.Errorf("nodeQuery(%q) = %v, want %v", c.raw, got, c.want)
		}
	}
}

func TestNextTickDelay(t *testing.T) {
	// scheduleNextTick: the next hh:mm:57, re-armed a minute later when under a second away.
	base := istT(2026, 10, 27, 10, 0, 0)
	for _, c := range []struct{ at, want int64 }{
		{base, 57_000},
		{base + 20_000, 37_000},
		{base + 56_000, 1_000},
		{base + 56_001, 60_999},
		{base + 56_500, 60_500},
		{base + 57_000, 60_000},
		{base + 57_001, 59_999},
		{base + 59_999, 57_001},
	} {
		if got := nextTickDelay(c.at); got != c.want {
			t.Errorf("nextTickDelay(+%d ms) = %d, want %d", c.at-base, got, c.want)
		}
	}
}

// ---------------------------------------------------------------------------
// Lifecycle.

func TestStopCancelsWorkAndTimers(t *testing.T) {
	uni := goldenUniverse(t, "small")
	clk := &testClock{}
	clk.set(istT(2026, 10, 27, 10, 0, 20))
	timers := &fakeTimers{}
	entered := make(chan struct{}, 1)
	var calls atomic.Int64
	s := New(Deps{
		Instruments:    func(context.Context) ([]market.Instrument, error) { return uni, nil },
		QuoteFull:      syntheticQuotes(uni, clk, &calls),
		CaptureAllowed: allow,
		Historical: func(ctx context.Context, token int64, from, to, interval string, prio kite.HistoricalPriority) ([]kite.ClosePoint, error) {
			select {
			case entered <- struct{}{}:
			default:
			}
			<-ctx.Done() // a call that only ends when the service stops
			return nil, ctx.Err()
		},
		Cache:     newFakeCache(func() int64 { return clk.ms.Load() }, nil),
		Now:       clk.now,
		AfterFunc: timers.afterFunc,
		Sleep:     func(ctx context.Context, d time.Duration) error { return ctx.Err() },
		Logf:      t.Logf,
	})
	s.Start()
	s.Start() // second call: no second set of timers
	if got := timers.pending(); js(got) != "[37000,60000,1800000]" {
		t.Fatalf("timers after Start = %v", got)
	}
	select {
	case <-entered: // the cold-start backfill is blocked in Kite
	case <-time.After(5 * time.Second):
		t.Fatal("cold-start backfill did not start")
	}
	stopped := make(chan error, 1)
	go func() { stopped <- s.Stop(context.Background()) }()
	select {
	case err := <-stopped:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Stop did not return")
	}
	if got := timers.pending(); len(got) != 0 {
		t.Fatalf("timers after Stop = %v", got)
	}
	// Nothing runs after Stop.
	n := calls.Load()
	s.OnKiteLogin()
	s.Start()
	s.tick()
	s.wg.Wait()
	if calls.Load() != n || len(timers.pending()) != 0 {
		t.Fatal("work or timers after Stop")
	}
	if err := s.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestMemoryOnlyWithoutCache(t *testing.T) {
	uni := goldenUniverse(t, "small")
	clk := &testClock{}
	clk.set(istT(2026, 10, 27, 10, 0, 57))
	var logs []string
	timers := &fakeTimers{}
	s := New(Deps{
		Instruments:    func(context.Context) ([]market.Instrument, error) { return uni, nil },
		QuoteFull:      syntheticQuotes(uni, clk, nil),
		CaptureAllowed: allow,
		Now:            clk.now,
		AfterFunc:      timers.afterFunc,
		Logf:           func(f string, a ...any) { logs = append(logs, fmt.Sprintf(f, a...)) },
	})
	s.prevClose = &PrevClose{ForDay: "2026-10-27", Expiry: "2026-10-27", Complete: true, Tokens: map[int64]OiLtp{}}
	s.WarmLoad(context.Background())
	s.WarmLoad(context.Background())
	s.captureOptionOi(context.Background())
	s.captureFuturesOi(context.Background())
	s.mu.Lock()
	pending := s.hasPendingLocked()
	n := len(s.oiFrames[0])
	s.mu.Unlock()
	if pending || n != 1 {
		t.Fatalf("memory-only: pending=%v points=%d", pending, n)
	}
	if err := s.FlushNow(context.Background()); err != nil {
		t.Fatal(err)
	}
	disabled := 0
	for _, l := range logs {
		if strings.HasPrefix(l, "[Cache] DATABASE_URL not set") {
			disabled++
		}
	}
	if disabled != 1 {
		t.Fatalf("disabled notice logged %d times: %q", disabled, logs)
	}
	s.Start()
	if got := timers.pending(); js(got) != "[60000,1800000]" { // no flush-retry timer; 10:00:57 re-arms a minute on
		t.Fatalf("timers without a cache = %v", got)
	}
	_ = s.Stop(context.Background())
}

// TestConcurrentCapturesAndReads exercises the locks under -race: captures, backfill
// merges, coarsening, flushes and every route at once.
func TestConcurrentCapturesAndReads(t *testing.T) {
	uni := goldenUniverse(t, "small")
	clk := &testClock{}
	clk.set(istT(2026, 10, 27, 10, 0, 57))
	s, r := newRouteService(t, Deps{
		Instruments:    func(context.Context) ([]market.Instrument, error) { return uni, nil },
		QuoteFull:      syntheticQuotes(uni, clk, nil),
		QuotesByToken:  func(context.Context, []int64) ([]market.Tick, error) { return []market.Tick{{LastPrice: 25000}}, nil },
		CaptureAllowed: allow,
		Cache:          newFakeCache(func() int64 { return clk.ms.Load() }, nil),
		Now:            clk.now,
		AfterFunc:      (&fakeTimers{}).afterFunc,
		Sleep:          func(context.Context, time.Duration) error { return nil },
		Logf:           func(string, ...any) {},
	})
	s.prevClose = &PrevClose{ForDay: "2026-10-27", Expiry: "2026-10-27", Complete: true, Tokens: map[int64]OiLtp{}}
	ctx := context.Background()
	var wg sync.WaitGroup
	stop := make(chan struct{})
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 40; i++ {
			clk.ms.Add(60_000)
			s.captureOptionOi(ctx)
			s.captureFuturesOi(ctx)
			s.mu.Lock()
			s.mergeOiFrameLocked(i%4, []OiAggPoint{{T: clk.ms.Load() - 120_000, TotalCe: 1, Partial: i%2 == 0}})
			s.mu.Unlock()
			s.coarsenFrames()
			s.voidFlush()
		}
		close(stop)
	}()
	paths := []string{"/api/option-oi-frame/NIFTY?frame=1m", "/api/futures-oi-frame/NIFTY?frame=5m", "/api/option-oi-series/NIFTY", "/api/option-oi-baseline/NIFTY?minutes=2", "/api/option-prev-close/NIFTY", "/api/option-chain/NIFTY"}
	for _, p := range paths {
		wg.Add(1)
		go func(p string) {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				rec := get(r, p)
				if rec.Code != 200 || !json.Valid(rec.Body.Bytes()) {
					t.Errorf("%s: %d %s", p, rec.Code, clip(rec.Body.String(), 200))
					return
				}
			}
		}(p)
	}
	wg.Wait()
	s.wg.Wait()
	_ = s.Stop(ctx)
}
