package fairvalue

// Port of tests/fairValue/storage.test.mjs, plus the PostgreSQL store's own behaviour.
// The Node suite never ran against Mongo, so the database cases check what Mongo
// provided: insert-once appends, pruning to the limit, retention, exact stored JSON.

import (
	"context"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/dbtest"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/fvtest"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/model"
)

func noEnv(string) (string, bool) { return "", false }

func TestUnconfiguredStoreIsExplicitlyUnavailable(t *testing.T) {
	ctx := context.Background()
	cfg, err := model.DefaultConfig(noEnv, fvtest.Now)
	if err != nil {
		t.Fatal(err)
	}
	input := fvtest.InputSnapshot(fvtest.InputOptions{})
	surface := model.BuildSurface(input)
	var unset *PGStore
	for _, store := range []*PGStore{unset, {}} {
		if store.Enabled() {
			t.Fatal("a store without a pool must be memory-only")
		}
		if c, err := store.LoadConfig(ctx); c != nil || err != nil {
			t.Fatalf("loadConfig: %v %v", c, err)
		}
		if h, err := store.History(ctx, "TEST", 10); err != nil || h == nil || string(jsjson.Marshal(h)) != "[]" {
			t.Fatalf("history: %s %v", jsjson.Marshal(h), err)
		}
		if s, err := store.Snapshot(ctx, "TEST", "missing"); s != nil || err != nil {
			t.Fatalf("snapshot: %v %v", s, err)
		}
		if err := store.SaveConfig(ctx, cfg, "v1"); err == nil || !strings.Contains(err.Error(), "memory-only") {
			t.Fatalf("saveConfig must be rejected: %v", err)
		}
		if err := store.Append(ctx, &surface, input, 10, 7); err != nil {
			t.Fatalf("append without a database is a no-op: %v", err)
		}
	}
}

func TestPGStoreConfigRoundTripKeepsKeyOrder(t *testing.T) {
	ctx := context.Background()
	pool := dbtest.New(t)
	store := &PGStore{Pool: pool}
	if !store.Enabled() {
		t.Fatal("store with a pool is not enabled")
	}
	if c, err := store.LoadConfig(ctx); c != nil || err != nil {
		t.Fatalf("nothing saved yet: %v %v", c, err)
	}
	base, err := model.DefaultConfig(noEnv, fvtest.Now)
	if err != nil {
		t.Fatal(err)
	}
	first, err := base.With(func(raw *jsjson.Object) { raw.Set("history_limit", 7.0) })
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveConfig(ctx, first, first.Version()); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.LoadConfig(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// The default key order is not sorted; jsonb would have reordered it.
	if got, want := string(jsjson.Marshal(loaded)), string(jsjson.Marshal(first)); got != want {
		t.Fatalf("config changed in storage:\n got %s\nwant %s", got, want)
	}
	merged, err := model.MergeConfig(base, loaded)
	if err != nil || merged.Version() != first.Version() {
		t.Fatalf("restored version %q (%v), want %q", merged.Version(), err, first.Version())
	}
	second := first.WithEnabled(!first.Enabled)
	if err := store.SaveConfig(ctx, second, second.Version()); err != nil {
		t.Fatal(err)
	}
	if loaded, err = store.LoadConfig(ctx); err != nil || string(jsjson.Marshal(loaded)) != string(jsjson.Marshal(second)) {
		t.Fatalf("second save not loaded: %v", err)
	}
	var rows int
	var version string
	if err := pool.QueryRow(ctx, `select count(*), max(version) from fair_value_settings`).Scan(&rows, &version); err != nil {
		t.Fatal(err)
	}
	if rows != 1 || version != second.Version() {
		t.Fatalf("settings rows %d version %q, want 1 %q", rows, version, second.Version())
	}
}

func TestPGStoreAppendInsertOncePruneAndRetention(t *testing.T) {
	ctx := context.Background()
	pool := dbtest.New(t)
	clock := time.Now().Truncate(time.Millisecond)
	store := &PGStore{Pool: pool, Now: func() time.Time { return clock }}
	input := *fvtest.InputSnapshot(fvtest.InputOptions{})
	input.ListingCatalog, input.HasListingCatalog = []model.OptionMetadata{fvtest.MetadataFor(100, "CE")}, true
	base := model.BuildSurface(&input)
	nowMs := float64(clock.UnixMilli())
	snapshot := func(id, underlying string, publishedMs, sequence float64) *model.SurfaceSnapshot {
		s := base
		s.ID, s.Underlying, s.PublishedAt, s.Sequence = id, underlying, model.ISOString(publishedMs), sequence
		return &s
	}
	count := func(underlying string) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, `select count(*) from fair_value_snapshots where underlying = $1`, underlying).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	ids := func(list []model.HistorySummary) string {
		out := make([]string, len(list))
		for i, s := range list {
			out[i] = s.ID
		}
		return strings.Join(out, ",")
	}

	var published []*model.SurfaceSnapshot
	for i := 0; i < 5; i++ {
		s := snapshot(fmt.Sprintf("fv-%d", i), "TEST", nowMs-float64(5-i)*1000, float64(i))
		published = append(published, s)
		if err := store.Append(ctx, s, &input, 3, 7); err != nil {
			t.Fatal(err)
		}
	}
	history, err := store.History(ctx, "TEST", 10)
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(history); got != "fv-4,fv-3,fv-2" || count("TEST") != 3 {
		t.Fatalf("history %s with %d rows, want the newest 3", got, count("TEST"))
	}
	for i, h := range history {
		if got, want := string(jsjson.Marshal(h)), string(jsjson.Marshal(published[4-i].Summary())); got != want {
			t.Fatalf("summary %d:\n got %s\nwant %s", i, got, want)
		}
	}
	if h, _ := store.History(ctx, "TEST", 2.9); ids(h) != "fv-4,fv-3" {
		t.Fatalf("limit 2.9 read %s", ids(h))
	}

	// Insert-once: the same id again changes nothing.
	if err := store.Append(ctx, snapshot("fv-4", "TEST", nowMs, 99), &input, 3, 7); err != nil {
		t.Fatal(err)
	}
	stored, err := store.Snapshot(ctx, "TEST", "fv-4")
	if err != nil || stored == nil {
		t.Fatalf("stored snapshot: %v %v", stored, err)
	}
	if string(stored.JSON) != string(jsjson.Marshal(published[4])) || stored.PublishedAt != published[4].PublishedAt {
		t.Fatal("stored snapshot is not the first append's exact JSON")
	}
	for _, miss := range [][2]string{{"OTHER", "fv-4"}, {"TEST", "fv-0"}, {"TEST", "missing"}} {
		if s, err := store.Snapshot(ctx, miss[0], miss[1]); s != nil || err != nil {
			t.Fatalf("snapshot %v: %v %v", miss, s, err)
		}
	}
	var inputJSON string
	var atMs, expiresMs int64
	if err := pool.QueryRow(ctx, `select input::text, (extract(epoch from at) * 1000)::bigint,
		(extract(epoch from expires_at) * 1000)::bigint from fair_value_snapshots where id = 'fv-4'`).Scan(&inputJSON, &atMs, &expiresMs); err != nil {
		t.Fatal(err)
	}
	calibration := input.WithoutListingCatalog()
	if inputJSON != string(jsjson.Marshal(&calibration)) || strings.Contains(inputJSON, "listing_catalog") {
		t.Fatal("stored input must be the calibration input without the listing catalog")
	}
	if atMs != int64(nowMs)-1000 || expiresMs != atMs+7*86400000 {
		t.Fatalf("at %d expires_at %d", atMs, expiresMs)
	}

	// Past expires_at a row is invisible to reads at once, and deleted by the next
	// append of any underlying (Mongo's TTL monitor).
	clock = clock.Add(7*24*time.Hour - 2500*time.Millisecond) // fv-2 expired, fv-3 not
	if h, _ := store.History(ctx, "TEST", 10); ids(h) != "fv-4,fv-3" {
		t.Fatalf("history after expiry %s", ids(h))
	}
	if s, _ := store.Snapshot(ctx, "TEST", "fv-2"); s != nil || count("TEST") != 3 {
		t.Fatal("expired row must be unreadable but still stored until the next append")
	}
	if err := store.Append(ctx, snapshot("other-1", "OTHER", float64(clock.UnixMilli()), 1), &input, 3, 7); err != nil {
		t.Fatal(err)
	}
	if count("TEST") != 2 || count("OTHER") != 1 {
		t.Fatalf("after append: TEST %d OTHER %d rows", count("TEST"), count("OTHER"))
	}
}

// The engine on PostgreSQL: the saved configuration survives a restart, and history
// written in the background is served from the database by a fresh engine.
func TestEngineHistoryAndConfigSurviveRestartOnPostgres(t *testing.T) {
	ctx := context.Background()
	pool := dbtest.New(t)
	input := fvtest.InputSnapshot(fvtest.InputOptions{Patch: fvtest.Set("history_interval_ms", 10000.0)})
	var f, g *engineFixture
	storeA := &PGStore{Pool: pool, Now: func() time.Time { return time.UnixMilli(int64(f.getNow())) }}
	storeB := &PGStore{Pool: pool, Now: func() time.Time { return time.UnixMilli(int64(g.getNow())) }}

	f = newEngineFixture(t, input, fixtureOptions{store: storeA})
	f.engine.Boot()
	if st := f.engine.Status(); st.Storage != "postgres" || st.ConfigPersisted {
		t.Fatalf("storage %q persisted %v", st.Storage, st.ConfigPersisted)
	}
	patch := jsjson.NewObjectValue()
	patch.Set("history_limit", 3.0)
	res, err := f.engine.UpdateConfig(patch)
	if err != nil || !res.Persisted {
		t.Fatalf("update: %+v %v", res, err)
	}
	if err := f.engine.Watch("TEST"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if i > 0 {
			f.advance(10000)
		}
		f.engine.IngestTicksAt(bookTicks(input.Quotes, false, nil), f.getNow())
		if _, err := f.engine.Refresh("TEST"); err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		if h, err := storeA.History(ctx, "TEST", 10); err == nil && len(h) == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("history was not persisted")
		}
		time.Sleep(20 * time.Millisecond)
	}
	before, err := f.engine.History("TEST", 10)
	if err != nil || len(before) != 2 {
		t.Fatalf("history before restart: %d %v", len(before), err)
	}
	memory, _ := f.engine.HistoricalSnapshot("TEST", before[0].ID)
	if memory == nil {
		t.Fatal("newest snapshot not in memory history")
	}
	var inputJSON string
	if err := pool.QueryRow(ctx, `select input::text from fair_value_snapshots where id = $1`, before[0].ID).Scan(&inputJSON); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(inputJSON, "listing_catalog") {
		t.Fatal("the listing catalog was persisted")
	}

	g = newEngineFixture(t, input, fixtureOptions{store: storeB})
	g.advance(10000)
	g.engine.Boot()
	if cfg := g.engine.GetConfig(); !cfg.Persisted || cfg.Version != f.engine.GetConfig().Version || cfg.Config.HistoryLimit != 3 {
		t.Fatalf("restored config persisted %v version %q", cfg.Persisted, cfg.Version)
	}
	after, err := g.engine.History("test", 10)
	if err != nil || string(jsjson.Marshal(after)) != string(jsjson.Marshal(before)) {
		t.Fatalf("history after restart (%v):\n got %s\nwant %s", err, jsjson.Marshal(after), jsjson.Marshal(before))
	}
	stored, err := g.engine.HistoricalSnapshot("test", before[0].ID)
	if err != nil || stored == nil || string(jsjson.Marshal(stored)) != string(jsjson.Marshal(memory)) {
		t.Fatalf("snapshot after restart differs (%v)", err)
	}
	origin := newTestServer(t, g.engine, func(token string) bool { return token == "full" }, RouteDeps{})
	resp := request(t, "GET", origin+"/history/TEST/"+before[0].ID, "full", "")
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil || resp.StatusCode != 200 || string(body) != `{"historical":true,"snapshot":`+string(jsjson.Marshal(memory))+`}` {
		t.Fatalf("historical route %d: %.200s", resp.StatusCode, body)
	}

	g.advance(7*86400000 + 1)
	if h, err := g.engine.History("TEST", 10); err != nil || h == nil || len(h) != 0 {
		t.Fatalf("history beyond retention: %d %v", len(h), err)
	}
	if s, err := g.engine.HistoricalSnapshot("TEST", before[0].ID); s != nil || err != nil {
		t.Fatalf("snapshot beyond retention: %v", err)
	}
}
