package app

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/config"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
)

// wantBoot is the boot chain of index.ts's listen callback (see Start).
var wantBoot = []string{
	"market-data session sweeper",
	"EOD capture scheduler and startup backfill",
	"expired-row purge job",
	"restore the Zerodha session",
	"restore the active broker",
	"start the active broker runtime",
	"restore admin sessions",
	"restore the risk-free rate",
	"hourly capture scheduler, backfill and day review",
	"analytics warm load and capture schedulers",
	"Synthetic boot",
	"Fair Value boot",
}

// wantShutdown is index.ts's ShutdownCoordinator without its two Box steps, plus the
// final cache flush and the wait for background writes before the pool closes.
var wantShutdown = []string{
	stepSynthetic, stepFairValue, stepHTTP, stepSchedulers, stepFeeds, stepFlush, stepWrites, stepDatabase,
}

// nodeShutdownSteps reads the frozen shutdown contract from the pinned Node
// revision. Removing the old backend must not turn this cross-check into a skip.
func nodeShutdownSteps(t *testing.T) []string {
	src, err := os.ReadFile("../parity/testdata/shutdown.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		ReferenceCommit string   `json:"reference_commit"`
		Steps           []string `json:"steps"`
	}
	if err := json.Unmarshal(src, &contract); err != nil {
		t.Fatal(err)
	}
	if contract.ReferenceCommit != "1ea1d958ebf5c4a0fc673d786f5ee9638bdffa8d" || len(contract.Steps) != 8 {
		t.Fatalf("invalid original shutdown contract: %+v", contract)
	}
	return contract.Steps
}

func TestShutdownOrderFollowsIndexTs(t *testing.T) {
	node := nodeShutdownSteps(t)
	var kept []string
	for _, n := range node {
		switch {
		case strings.Contains(n, "Box"):
			continue // Box is removed
		case n == "close MongoDB connections":
			n = stepDatabase
		}
		kept = append(kept, n)
	}
	var core []string
	for _, n := range wantShutdown {
		if n != stepFlush && n != stepWrites { // the two Go additions
			core = append(core, n)
		}
	}
	if !reflect.DeepEqual(kept, core) {
		t.Fatalf("index.ts steps without Box = %q\nGo steps without its additions = %q", kept, core)
	}
	if len(node) != len(kept)+2 {
		t.Fatalf("index.ts has %d steps, %d of them Box (want exactly the two Box steps)", len(node), len(node)-len(kept))
	}
}

func seedBootRows(t *testing.T, pool *db.Pool) {
	t.Helper()
	ctx := context.Background()
	future := time.Now().Add(time.Hour).UnixMilli()
	past := time.Now().Add(-time.Hour)
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`insert into admin_sessions (id, role, expiry) values ('seeded-full-token', 'full', $1), ('expired-token', 'trade', 1)`, []any{future}},
		{`insert into app_settings (id, value) values ('rf_rate', 6.5)`, nil},
		{`insert into active_broker (id, broker, selected_by, generation) values ('current', 'zerodha', 'full', 5)`, nil},
		// A Kite session from an earlier IST day: restored as stale and deleted.
		{`insert into kite_session (id, access_token, login_date) values ('current', 'old-token', '2000-01-01')`, nil},
		{`insert into kv_keys (key, expires_at) values ('calspread:expired', $1), ('calspread:live', null)`, []any{past}},
		{`insert into kv_fields (key, field, value) values ('calspread:expired', '', '1'), ('calspread:live', '', '2')`, nil},
	} {
		if _, err := pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatalf("seed %q: %v", q.sql, err)
		}
	}
}

func TestBootAndShutdownWithDatabase(t *testing.T) {
	h := newHarness(t, harnessOptions{db: true, seed: seedBootRows})
	start := time.Now()
	h.app.Start(context.Background())
	if got := h.trace.with("boot: "); !reflect.DeepEqual(got, wantBoot) {
		t.Fatalf("boot order\n got %q\nwant %q", got, wantBoot)
	}

	// Each restore step really ran against PostgreSQL.
	expect(t, "admin status with a restored session", h.do("GET", "/api/admin/status", "seeded-full-token", ""),
		200, `{"authenticated":true,"role":"full","broker":"zerodha"}`)
	expect(t, "risk-free rate", h.do("GET", "/api/rf/current", "", ""), 200, `{"rf":6.5}`)
	if r := h.do("GET", "/api/status", "", ""); !strings.Contains(r.body, `"generation":5,`) {
		t.Errorf("the persisted generation was not adopted: %s", r.body)
	}
	ctx := context.Background()
	var kiteRows int
	if err := h.pool.QueryRow(ctx, `select count(*) from kite_session`).Scan(&kiteRows); err != nil || kiteRows != 0 {
		t.Errorf("stale kite_session rows = %d (%v), want 0", kiteRows, err)
	}
	if got := h.app.captures.Intervals(); !reflect.DeepEqual(got, []string{"eod-capture", "hourly-capture", "day-review"}) {
		t.Errorf("capture schedulers = %v", got)
	}
	// The purge job ran once at boot: the expired key and session rows are gone.
	waitFor(t, "first purge", func() bool { return h.trace.has("purge") })
	var keys []string
	rows, err := h.pool.Query(ctx, `select key from kv_keys order by key`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var k string
		_ = rows.Scan(&k)
		keys = append(keys, k)
	}
	rows.Close()
	if !reflect.DeepEqual(keys, []string{"calspread:live"}) {
		t.Errorf("kv keys after the purge = %v", keys)
	}
	var sessions int
	if err := h.pool.QueryRow(ctx, `select count(*) from admin_sessions where id = 'expired-token'`).Scan(&sessions); err != nil || sessions != 0 {
		t.Errorf("expired admin session rows = %d (%v)", sessions, err)
	}

	res := h.shutdown("SIGTERM")
	took := time.Since(start)
	if !reflect.DeepEqual(res.Completed, wantShutdown) || len(res.Failed) > 0 || res.TimedOut {
		t.Fatalf("shutdown: completed %q failed %v timed out %v", res.Completed, res.Failed, res.TimedOut)
	}
	if got := h.trace.with("shutdown: "); !reflect.DeepEqual(got, wantShutdown) {
		t.Errorf("shutdown trace %q", got)
	}
	if took > 5*time.Second {
		t.Errorf("boot + shutdown took %v", took)
	}
	if err := h.pool.Ping(ctx); err == nil {
		t.Error("the pool is still open after shutdown")
	}
	// A second signal waits for and reports the same run.
	if again := h.app.Shutdown(context.Background(), "SIGINT"); !reflect.DeepEqual(again.Completed, res.Completed) {
		t.Errorf("second shutdown = %+v", again)
	}
	h.waitGoroutines(3)
}

func TestBootAndShutdownWithoutDatabase(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	start := time.Now()
	h.app.Start(context.Background())
	if got := h.trace.with("boot: "); !reflect.DeepEqual(got, wantBoot) {
		t.Fatalf("boot order\n got %q\nwant %q", got, wantBoot)
	}
	// Memory only, as Node without MongoDB: nothing restored, trades refused.
	expect(t, "admin status", h.do("GET", "/api/admin/status", "seeded-full-token", ""),
		200, `{"authenticated":false,"role":null,"broker":"zerodha"}`)
	expect(t, "risk-free rate", h.do("GET", "/api/rf/current", "", ""), 200, `{"rf":null}`)
	token := h.tradeToken()
	expect(t, "take a trade without a database", h.do("POST", "/api/trades", token, `{"symbol":"RELIANCE"}`),
		503, `{"error":"Trade persistence is not configured (set DATABASE_URL)."}`)
	expect(t, "trade list without a database", h.do("GET", "/api/trades", token, ""), 200, `{"dbEnabled":false,"trades":[]}`)
	if h.trace.has("purge") {
		t.Error("the purge job ran without a database")
	}

	res := h.shutdown("SIGINT")
	if !reflect.DeepEqual(res.Completed, wantShutdown) || len(res.Failed) > 0 || res.TimedOut {
		t.Fatalf("shutdown: completed %q failed %v timed out %v", res.Completed, res.Failed, res.TimedOut)
	}
	if took := time.Since(start); took > 5*time.Second {
		t.Errorf("boot + shutdown took %v", took)
	}
	h.waitGoroutines(3)
}

// TestShutdownBeforeStart stops the service before the boot chain ran: Start is then a
// no-op and the goroutines still come back.
func TestShutdownBeforeStart(t *testing.T) {
	h := newHarness(t, harnessOptions{db: true})
	res := h.shutdown("SIGTERM")
	if !reflect.DeepEqual(res.Completed, wantShutdown) || len(res.Failed) > 0 || res.TimedOut {
		t.Fatalf("shutdown: %+v", res)
	}
	h.app.Start(context.Background()) // too late: a no-op
	if got := h.trace.with("boot: "); len(got) != 0 {
		t.Errorf("boot steps ran after shutdown: %q", got)
	}
	h.waitGoroutines(3)
}

// TestNewFailsWithoutKiteCredentials: Node's KiteClient constructor threw at module load,
// before the server listened, when KITE_API_KEY or KITE_API_SECRET was missing.
func TestNewFailsWithoutKiteCredentials(t *testing.T) {
	for _, env := range []map[string]string{{}, {"KITE_API_KEY": "k"}, {"KITE_API_SECRET": "s"}} {
		_, err := New(config.Load(config.MapGetter(env)), Options{LookupEnv: func(k string) (string, bool) { v, ok := env[k]; return v, ok }})
		if err == nil || err.Error() != "KITE_API_KEY and KITE_API_SECRET must be set in the environment (.env)." {
			t.Errorf("env %v: err = %v", env, err)
		}
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestShutdownDuringBoot: SIGTERM arrives while the boot chain waits for the Kite
// instrument download of the restored session. The chain is cancelled, nothing after
// the runtime start runs, and shutdown still finishes all its steps quickly.
func TestShutdownDuringBoot(t *testing.T) {
	release := make(chan struct{})
	var releaseOnce sync.Once
	entered := make(chan struct{}, 1)
	h := newHarness(t, harnessOptions{
		db: true,
		seed: func(t *testing.T, pool *db.Pool) {
			if _, err := pool.Exec(context.Background(),
				`insert into kite_session (id, access_token, login_date) values ('current', 'live-token', $1)`,
				jsx.IstDayKey(time.Now())); err != nil {
				t.Fatal(err)
			}
		},
		kite: func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/instruments" {
				select {
				case entered <- struct{}{}:
				default:
				}
				<-release
			}
			fakeKiteHandler(w, r)
		},
	})
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(unblock) // before the fakes close

	booted := make(chan struct{})
	go func() {
		h.app.Start(context.Background())
		close(booted)
	}()
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("the boot chain never asked Kite for the instruments")
	}
	start := time.Now()
	res := h.shutdown("SIGTERM")
	took := time.Since(start)
	select {
	case <-booted:
	case <-time.After(time.Second):
		t.Fatal("Start did not return after Shutdown")
	}
	if !reflect.DeepEqual(res.Completed, wantShutdown) || len(res.Failed) > 0 || res.TimedOut {
		t.Fatalf("shutdown: %+v", res)
	}
	if took > 5*time.Second {
		t.Errorf("shutdown during boot took %v", took)
	}
	if got := h.trace.with("boot: "); !reflect.DeepEqual(got, wantBoot[:6]) {
		t.Errorf("boot steps that ran\n got %q\nwant %q", got, wantBoot[:6])
	}
	unblock() // the provider's own download goroutine finishes now
	h.waitGoroutines(3)
}
