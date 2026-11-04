package registry

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/auth"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/dhan"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/dbtest"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// fakeDhanFeed is a scriptable DhanFeed: it records the registry's calls and lets the
// test fire the feed's callbacks.
type fakeDhanFeed struct {
	name string
	opts dhan.FeedOptions
	rec  *recorder

	mu        sync.Mutex
	connected bool
	wanted    map[int64]bool
}

func (f *fakeDhanFeed) IsConnected() bool    { f.mu.Lock(); defer f.mu.Unlock(); return f.connected }
func (f *fakeDhanFeed) SubscribedCount() int { return 0 }
func (f *fakeDhanFeed) WantedCount() int     { f.mu.Lock(); defer f.mu.Unlock(); return len(f.wanted) }
func (f *fakeDhanFeed) LastTickAtMs() *int64 { return nil }
func (f *fakeDhanFeed) FeedAgeMs() *int64    { return nil }
func (f *fakeDhanFeed) SubscribeTokens(t []int64) {
	f.mu.Lock()
	for _, x := range t {
		f.wanted[x] = true
	}
	f.mu.Unlock()
	f.rec.add("%s:subscribe %s", f.name, intsJSON(t))
}
func (f *fakeDhanFeed) UnsubscribeTokens(t []int64) {
	f.mu.Lock()
	for _, x := range t {
		delete(f.wanted, x)
	}
	f.mu.Unlock()
	f.rec.add("%s:unsubscribe %s", f.name, intsJSON(t))
}
func (f *fakeDhanFeed) EnsureSocket() { f.rec.add("%s:ensure token=%s", f.name, f.opts.AccessToken()) }
func (f *fakeDhanFeed) Stop() {
	f.mu.Lock()
	f.connected = false
	f.wanted = map[int64]bool{}
	f.mu.Unlock()
	f.rec.add("%s:stop", f.name)
	if f.opts.OnConnection != nil {
		f.opts.OnConnection(false)
	}
}

type feedFactory struct {
	rec   *recorder
	mu    sync.Mutex
	feeds []*fakeDhanFeed
}

func (ff *feedFactory) new(opts dhan.FeedOptions) DhanFeed {
	ff.mu.Lock()
	defer ff.mu.Unlock()
	f := &fakeDhanFeed{name: fmt.Sprintf("feed%d", len(ff.feeds)+1), opts: opts, rec: ff.rec, wanted: map[int64]bool{}}
	ff.feeds = append(ff.feeds, f)
	return f
}

func (ff *feedFactory) get(i int) *fakeDhanFeed {
	ff.mu.Lock()
	defer ff.mu.Unlock()
	return ff.feeds[i]
}

var testCreds = map[string]string{
	"DEFAULT_BROKER": "zerodha", // historical Node cases begin on Zerodha explicitly
	"DHAN_CLIENT_ID": "1100001", "DHAN_API_KEY": "k", "DHAN_API_SECRET": "s",
	"DHAN_MIN_INTERVAL_MS": "0", "DHAN_MAX_READ_ATTEMPTS": "1",
}

type unitRig struct {
	reg   *Registry
	rec   *recorder
	feeds *feedFactory
	clock *fakeClock
	env   *fakeEnv
	kite  *fakeKite
	hub   *fakeHub
	dhan  *fakeDhan
}

func newUnitRig(t *testing.T, store Store, specs map[string][]httpSpec) *unitRig {
	t.Helper()
	return newUnitRigWithEnv(t, store, specs, nil)
}

func newUnitRigWithEnv(t *testing.T, store Store, specs map[string][]httpSpec, extra map[string]string) *unitRig {
	t.Helper()
	dhan.SetLogger(func(string, ...any) {})
	t.Cleanup(func() { dhan.SetLogger(nil) })
	rec := &recorder{}
	tok := "kite-token"
	u := &unitRig{rec: rec, feeds: &feedFactory{rec: rec}, clock: newClock(1_793_167_200_000), env: newEnv(testCreds)}
	for key, value := range extra {
		u.env.set(key, value)
	}
	u.kite = &fakeKite{rec: rec, token: &tok}
	u.hub = &fakeHub{rec: rec}
	u.dhan = newFakeDhan(t, specs, nil)
	u.reg = New(Deps{
		Kite: u.kite, Hub: u.hub, Store: store, Lookup: u.env.lookup, Now: u.clock.Now,
		Dhan: DhanConfig{
			APIRoot: u.dhan.apiRoot(), AuthRoot: u.dhan.authRoot(), ScripMasterURLs: u.dhan.masterURLs(),
			HTTPClient: u.dhan.srv.Client(), Sleep: func(context.Context, time.Duration) error { return nil },
		},
		NewDhanFeed: u.feeds.new,
	})
	u.reg.Attach(recordingHooks(rec))
	t.Cleanup(func() { u.reg.bg.Wait() })
	return u
}

// activateDhan puts the registry in "Dhan active with a live session" without a switch.
func (u *unitRig) activateDhan(token string) {
	u.reg.state.Store(&brokerState{active: brokers.Dhan, gen: 3})
	u.reg.setDhanSession(&token, nil, &dhanMeta{clientID: "1100001", clientName: "T", loginDay: "2026-10-28", loginAt: 1})
}

func (u *unitRig) settle() {
	u.reg.bg.Wait()
	u.reg.flushFeeds()
	u.reg.bg.Wait()
}

func TestSessionLostWhileDhanActiveFailsClosed(t *testing.T) {
	pool := dbtest.New(t)
	store := &PGStore{Pool: pool}
	u := newUnitRig(t, store, nil)
	if err := store.SaveDhanSession(context.Background(), DhanSessionRecord{AccessToken: "tok", LoginDate: "2026-10-28"}); err != nil {
		t.Fatal(err)
	}
	u.activateDhan("tok")
	u.reg.StartActiveFeed()
	u.reg.AcquireBrowserTokens([]int64{2000050000})
	u.settle()
	u.rec.take()

	// The feed reports an auth close: the registry handles it off the feed's goroutine.
	u.feeds.get(0).opts.OnSessionLost("Dhan feed rejected the session (close code 4401) — the access token is invalid or expired.")
	u.settle()
	got := u.rec.take()
	want := []string{
		"feed1:stop", "hub:external false", "publish",
		"invalidateBooks",
		"sessionLost dhan Dhan feed rejected the session (close code 4401) — the access token is invalid or expired.",
		"publish",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("events\n got  %q\n want %q", got, want)
	}
	if s := u.reg.SessionFor(brokers.Dhan); s.Authenticated || s.ClientID == nil {
		t.Fatalf("session after loss: %+v (token gone, identity kept)", s)
	}
	if rec, _ := store.LoadDhanSession(context.Background()); rec != nil {
		t.Fatal("the persisted session survived the loss")
	}
	if p := u.reg.DhanProblems(); len(p) == 0 || p[0] != problemNotConnected {
		t.Fatalf("problems %q", p)
	}
}

func TestSessionLostWhileZerodhaActiveTouchesNoHook(t *testing.T) {
	u := newUnitRig(t, nil, nil)
	tok := "tok"
	u.reg.setDhanSession(&tok, nil, &dhanMeta{clientID: "1100001"})
	u.reg.SetSyntheticTokens([]int64{1}) // Zerodha active: the box lane is Kite's
	u.reg.ensureDhanFeed()
	u.rec.take()
	u.feeds.get(0).opts.OnSessionLost("gone")
	u.settle()
	if got := u.rec.take(); strings.Join(got, ",") != "feed1:stop,hub:external false,publish" {
		t.Fatalf("events %q", got)
	}
	if u.reg.usableDhanToken() != "" {
		t.Fatal("token kept")
	}
}

func TestReLoginWhileDhanActiveRecyclesTheFeedAndReplaysBothLanes(t *testing.T) {
	csv := "EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,LOT_SIZE,TICK_SIZE\nNSE,D,50000,FUTSTK,BHEL-FUT,1,0.05\nNSE,E,438,EQUITY,BHEL,1,0.05"
	specs := map[string][]httpSpec{
		"auth GET /app/consumeApp-consent": {{Status: 200, Body: json.RawMessage(`{"accessToken":"new-tok","dhanClientId":"1100001"}`)}},
		"master GET detailed":              {{Status: 200, Body: json.RawMessage(mustJSON(csv))}},
	}
	u := newUnitRig(t, nil, specs)
	u.activateDhan("old-tok")
	u.reg.StartActiveFeed()
	u.reg.AcquireBrowserTokens([]int64{2000050000, 1000000438})
	u.reg.SetSyntheticTokens([]int64{2000050000})
	u.settle()
	u.rec.take()

	sess, err := u.reg.CompleteDhanLogin(context.Background(), "tid")
	if err != nil {
		t.Fatal(err)
	}
	u.settle()
	if !sess.Authenticated || u.reg.usableDhanToken() != "new-tok" {
		t.Fatalf("session %+v token %q", sess, u.reg.usableDhanToken())
	}
	got := u.rec.take()
	want := []string{
		"feed1:stop", "hub:external false", "publish", // the futures feed on the old token goes
		"feed3:ensure token=new-tok", // a fresh one starts on the new token
		"feed3:subscribe [1000000438,2000050000]",
		"feed2:subscribe [2000050000]", // the second lane keeps its feed (not recycled, as in Node)
		"publish",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("events\n got  %q\n want %q", got, want)
	}
}

func TestConcurrentSwitchesSerialise(t *testing.T) {
	pool := dbtest.New(t)
	u := newUnitRig(t, &PGStore{Pool: pool}, map[string][]httpSpec{"master GET detailed": {{Status: 404, Body: json.RawMessage(`"x"`)}}})
	var wg sync.WaitGroup
	stop := make(chan struct{})
	// Status readers run throughout: nothing may deadlock or race.
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
					_ = u.reg.Snapshot()
					_ = u.reg.ActiveHealth()
					_ = u.reg.LaneStats(brokers.LaneBox)
					_ = u.reg.UpstreamFeedStats()
				}
			}
		}()
	}
	results := make(chan SwitchResult, 8)
	var sw sync.WaitGroup
	for i := 0; i < 8; i++ {
		sw.Add(1)
		go func() {
			defer sw.Done()
			results <- u.reg.SwitchTo(context.Background(), brokers.Dhan, "full")
		}()
	}
	sw.Wait()
	close(stop)
	wg.Wait()
	close(results)
	for r := range results {
		if !r.OK || r.Broker != brokers.Dhan {
			t.Fatalf("result %+v", r)
		}
	}
	events := u.rec.take()
	n := 0
	for _, e := range events {
		if e == "stopScanner" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("%d teardowns, want exactly one: %q", n, events)
	}
	if g := u.reg.Generation(); g != 2 {
		t.Fatalf("generation %d, want 2", g)
	}
	rec, err := (&PGStore{Pool: pool}).LoadActiveBroker(context.Background())
	if err != nil || rec == nil || rec.Broker != "dhan" || rec.Generation != 1 {
		t.Fatalf("persisted %+v %v", rec, err)
	}
}

func TestSwitchAdoptsTheHigherDurableGeneration(t *testing.T) {
	pool := dbtest.New(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `insert into active_broker (id, broker, generation) values ('current', 'zerodha', 41)`); err != nil {
		t.Fatal(err)
	}
	u := newUnitRig(t, &PGStore{Pool: pool}, nil)
	// The process restarted without restoring (e.g. the load failed): gen is 1 in memory,
	// 41 in the database. The switch adopts max(gen+1, persisted) = 42.
	res := u.reg.SwitchTo(ctx, brokers.Dhan, "")
	if !res.OK || u.reg.Generation() != 42 {
		t.Fatalf("result %+v generation %d", res, u.reg.Generation())
	}
	// Without a database the counter still moves.
	u2 := newUnitRig(t, nil, nil)
	u2.reg.SwitchTo(ctx, brokers.Dhan, "x")
	u2.reg.SwitchTo(ctx, brokers.Zerodha, "x")
	if u2.reg.Generation() != 3 {
		t.Fatalf("memory-only generation %d", u2.reg.Generation())
	}
	// A restore never lowers the generation.
	u.reg.Restore(ctx)
	if u.reg.Generation() != 42 || u.reg.ActiveBroker() != brokers.Dhan {
		t.Fatalf("after restore: %s %d", u.reg.ActiveBroker(), u.reg.Generation())
	}
}

func TestBrokerControlActor(t *testing.T) {
	pool := dbtest.New(t)
	store := &PGStore{Pool: pool}
	u := newUnitRig(t, store, nil)
	ctx := context.Background()
	var bc auth.BrokerControl = u.reg
	if r := bc.SwitchBroker(ctx, brokers.Dhan, auth.RoleFull); !r.OK || r.Broker != brokers.Dhan || bc.ActiveBroker() != brokers.Dhan {
		t.Fatalf("switch %+v", r)
	}
	var by string
	if err := pool.QueryRow(ctx, `select selected_by from active_broker`).Scan(&by); err != nil || by != "full" {
		t.Fatalf("selected_by %q %v", by, err)
	}
	if r := bc.SwitchBroker(ctx, brokers.Zerodha, auth.RoleNone); !r.OK {
		t.Fatalf("switch back %+v", r)
	}
	if err := pool.QueryRow(ctx, `select selected_by from active_broker`).Scan(&by); err != nil || by != "admin" {
		t.Fatalf("selected_by %q %v", by, err)
	}
	u.env.unset("DHAN_CLIENT_ID")
	r := bc.SwitchBroker(ctx, brokers.Dhan, auth.RoleFull)
	if r.OK || len(r.Blockers) != 1 || r.Blockers[0].Reason != "broker_not_configured" ||
		r.Blockers[0].Detail != "Dhan is not configured: DHAN_CLIENT_ID missing." {
		t.Fatalf("blocked switch %+v", r)
	}
}

func TestPGStoreGenerationCounter(t *testing.T) {
	pool := dbtest.New(t)
	ctx := context.Background()
	s := &PGStore{Pool: pool, Now: func() time.Time { return time.UnixMilli(1_700_000_000_123).Add(456 * time.Microsecond) }}
	if rec, err := s.LoadActiveBroker(ctx); rec != nil || err != nil {
		t.Fatalf("empty table: %+v %v", rec, err)
	}
	for want := int64(1); want <= 3; want++ {
		g, ok, err := s.SaveActiveBroker(ctx, "dhan", "full")
		if err != nil || !ok || g != want {
			t.Fatalf("save %d: %d %v %v", want, g, ok, err)
		}
	}
	if _, err := pool.Exec(ctx, `update active_broker set generation = null`); err != nil {
		t.Fatal(err)
	}
	if rec, _ := s.LoadActiveBroker(ctx); rec == nil || rec.Generation != 1 {
		t.Fatalf("null generation reads as 1: %+v", rec)
	}
	if g, _, _ := s.SaveActiveBroker(ctx, "zerodha", "x"); g != 1 {
		t.Fatalf("$inc on a missing field gives 1, got %d", g)
	}
	exp := int64(1_800_000_000_000)
	if err := s.SaveDhanSession(ctx, DhanSessionRecord{AccessToken: "a", DhanClientID: "c", ExpiryTime: &exp, LoginDate: "2026-10-28"}); err != nil {
		t.Fatal(err)
	}
	rec, err := s.LoadDhanSession(ctx)
	if err != nil || rec == nil || *rec.ExpiryTime != exp || rec.LoginAt.UnixMilli() != 1_700_000_000_123 || rec.UpdatedAt != rec.LoginAt {
		t.Fatalf("round trip %+v %v", rec, err)
	}
	if err := s.SaveDhanSession(ctx, DhanSessionRecord{AccessToken: "b", LoginDate: "2026-10-29"}); err != nil {
		t.Fatal(err)
	}
	if rec, _ = s.LoadDhanSession(ctx); rec.AccessToken != "b" || rec.ExpiryTime != nil || rec.DhanClientID != "" {
		t.Fatalf("upsert replaces every field: %+v", rec)
	}
	if err := s.ClearDhanSession(ctx); err != nil {
		t.Fatal(err)
	}
	if rec, _ = s.LoadDhanSession(ctx); rec != nil {
		t.Fatal("cleared session still there")
	}
	// A nil or disabled pool is a memory-only store.
	var none *PGStore
	if g, ok, err := none.SaveActiveBroker(ctx, "dhan", "x"); ok || g != 0 || err != nil {
		t.Fatal("nil store saved")
	}
}

func TestLaneTickRouting(t *testing.T) {
	u := newUnitRig(t, nil, nil)
	var box atomic.Int64
	h := recordingHooks(u.rec)
	h.OnBoxLaneTicks = func(t []market.Tick) { box.Add(int64(len(t))) }
	u.reg.Attach(h)
	u.activateDhan("tok")
	u.reg.StartActiveFeed()
	u.reg.SetSyntheticTokens([]int64{2000060000})
	u.settle()
	u.rec.take()
	// Futures-lane Dhan ticks go to the hub (and count as liveness); second-lane ticks
	// never reach the hub.
	u.clock.advance(5)
	u.feeds.get(0).opts.OnTicks([]market.Tick{{Token: 1}, {Token: 2}})
	if got := u.rec.take(); strings.Join(got, ",") != "hub:ingest 2" {
		t.Fatalf("futures ticks: %q", got)
	}
	if last := u.reg.lastTick(); last == nil || *last != u.clock.ms.Load() {
		t.Fatalf("lastTick %v", last)
	}
	u.clock.advance(7)
	u.feeds.get(1).opts.OnTicks([]market.Tick{{Token: 3}})
	if got := u.rec.take(); len(got) != 0 || box.Load() != 1 {
		t.Fatalf("box ticks reached %q, consumer got %d", got, box.Load())
	}
	if last := u.reg.lastTick(); *last != u.clock.ms.Load() {
		t.Fatal("second-lane ticks are liveness too")
	}
}

func TestAnalyticsTokenBudgetAndWireRows(t *testing.T) {
	csv := "EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,UNDERLYING_SECURITY_ID,LOT_SIZE,TICK_SIZE\nNSE,D,50000,FUTSTK,BHEL-FUT,438,1,0.05"
	u := newUnitRig(t, nil, map[string][]httpSpec{"master GET detailed": {{Status: 200, Body: json.RawMessage(mustJSON(csv))}}})
	u.reg.SetAnalyticsTokens([]int64{1, 2, 3})
	u.reg.AcquireBrowserTokens([]int64{2, 4})
	// priority = tokens held by a non-analytics owner: 2 and 4.
	if b := u.reg.AnalyticsTokenBudget(); b != 2798 {
		t.Fatalf("budget %v", b)
	}
	u.activateDhan("tok")
	rows, err := u.reg.InstrumentProvider().LoadWire(context.Background(), false)
	if err != nil || len(rows) != 1 {
		t.Fatalf("rows %v %v", rows, err)
	}
	got := string(jsjson.Marshal(rows))
	want := `[{"instrument_token":2000050000,"exchange_token":50000,"tradingsymbol":"BHEL-FUT","name":"BHEL-FUT","last_price":0,` +
		`"expiry":"","strike":0,"tick_size":0.05,"lot_size":1,"instrument_type":"FUT","segment":"NFO-FUT","exchange":"NFO",` +
		`"dhan_security_id":50000,"dhan_segment":"NSE_FNO","dhan_underlying_security_id":438}]`
	if got != want {
		t.Fatalf("wire rows\n got  %s\n want %s", got, want)
	}
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

/* --------------------- the feed-gate deadlock regression ------------------- */

// tickServer is a minimal Dhan market feed: it learns the instruments from the
// subscribe requests and streams 16-byte TICKER packets for them every millisecond.
type tickServer struct {
	srv  *httptest.Server
	sent atomic.Int64
}

func newTickServer(t *testing.T) *tickServer {
	t.Helper()
	ts := &tickServer{}
	up := websocket.Upgrader{}
	ts.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		var mu sync.Mutex
		subs := map[int64]bool{}
		go func() {
			for {
				_, msg, err := c.ReadMessage()
				if err != nil {
					return
				}
				var req struct {
					RequestCode    int
					InstrumentList []struct{ ExchangeSegment, SecurityId string }
				}
				if json.Unmarshal(msg, &req) != nil {
					continue
				}
				mu.Lock()
				for _, i := range req.InstrumentList {
					var id int64
					fmt.Sscan(i.SecurityId, &id)
					subs[id] = req.RequestCode == 21
				}
				mu.Unlock()
			}
		}()
		for {
			mu.Lock()
			var frame []byte
			for id, on := range subs {
				if !on {
					continue
				}
				p := make([]byte, 16)
				p[0] = 2 // TICKER
				binary.LittleEndian.PutUint16(p[1:], 16)
				p[3] = 2 // NSE_FNO
				binary.LittleEndian.PutUint32(p[4:], uint32(id))
				binary.LittleEndian.PutUint32(p[8:], math.Float32bits(101.5))
				frame = append(frame, p...)
			}
			mu.Unlock()
			if len(frame) > 0 {
				if c.WriteMessage(websocket.BinaryMessage, frame) != nil {
					return
				}
				ts.sent.Add(1)
			}
			time.Sleep(time.Millisecond)
		}
	}))
	t.Cleanup(ts.srv.Close)
	return ts
}

// A second-lane consumer that holds its own lock while it declares its token set (as
// Synthetic does) must not deadlock against tick delivery on the same Dhan socket:
// dhan.Feed blocks UnsubscribeTokens until an in-flight delivery returns, and that
// delivery is waiting for the consumer's lock. The registry's per-feed queue is what
// breaks the cycle.
func TestBoxLaneConsumerLockDoesNotDeadlockTheDhanFeed(t *testing.T) {
	ts := newTickServer(t)
	dhan.SetLogger(func(string, ...any) {})
	t.Cleanup(func() { dhan.SetLogger(nil) })
	rec := &recorder{}
	env := newEnv(testCreds)
	reg := New(Deps{
		Kite: &fakeKite{rec: rec}, Hub: &fakeHub{rec: rec}, Lookup: env.lookup,
		Dhan: DhanConfig{FeedURL: "ws" + strings.TrimPrefix(ts.srv.URL, "http"), ScripMasterURLs: []string{ts.srv.URL + "/none"},
			ReconnectDelay: func(int) time.Duration { return 10 * time.Millisecond }},
	})
	tok := "tok"
	reg.state.Store(&brokerState{active: brokers.Dhan, gen: 2})
	reg.setDhanSession(&tok, nil, &dhanMeta{clientID: "1100001"})

	var consumerMu sync.Mutex
	var received atomic.Int64
	reg.Attach(Hooks{OnBoxLaneTicks: func(ticks []market.Tick) {
		consumerMu.Lock() // Synthetic.OnTicks takes the engine lock
		received.Add(int64(len(ticks)))
		consumerMu.Unlock()
	}})
	setA := []int64{2000060000, 2000060001, 2000060002}
	setB := []int64{2000060003, 2000060004}
	reg.SetSyntheticTokens(setA)

	deadline := time.Now().Add(5 * time.Second)
	for received.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if received.Load() == 0 {
		t.Fatal("no ticks arrived")
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		end := time.Now().Add(300 * time.Millisecond)
		for i := 0; time.Now().Before(end); i++ {
			consumerMu.Lock() // applySubscriptionsLocked: declare the set under the engine lock
			if i%2 == 0 {
				reg.SetSyntheticTokens(setB)
			} else {
				reg.SetSyntheticTokens(setA)
			}
			consumerMu.Unlock()
			time.Sleep(time.Millisecond)
		}
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("deadlock: the consumer could not declare its tokens while ticks were being delivered")
	}
	reg.SetSyntheticTokens(setA)
	reg.flushFeeds()
	if s := reg.LaneStats(brokers.LaneBox); s.WantedTokens != len(setA) || !s.Connected {
		t.Fatalf("lane after the churn: %+v", s)
	}
	reg.StopFeeds()
}
