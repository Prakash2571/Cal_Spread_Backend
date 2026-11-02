package fairvalue

// Port of tests/fairValue/service.test.mjs: the admin HTTP workflow with the real engine,
// the routes behind the real middleware stack and an in-memory store.

import (
	"fmt"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/fvtest"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/model"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/server"
)

func newTestServer(t *testing.T, svc Service, isFull func(string) bool, d RouteDeps) string {
	t.Helper()
	d.Engine, d.IsFullAdmin = svc, isFull
	srv := httptest.NewServer(server.New(server.Options{FrontendOrigin: "http://frontend.test"}, func(r chi.Router) { Mount(r, d) }))
	t.Cleanup(srv.Close)
	return srv.URL + "/api/fair-value"
}

func TestServiceAdminHTTPWorkflow(t *testing.T) {
	input := fvtest.InputSnapshot(fvtest.InputOptions{Expiries: []string{"2026-10-20T10:00:00Z", "2026-11-17T10:00:00Z"},
		Patch: fvtest.Set("history_interval_ms", 10000.0, "history_limit", 2.0, "forward_interpolation", "log_carry_assumption",
			"proportional_calendar_assumption", true)})
	f := newEngineFixture(t, input, fixtureOptions{boardName: "Test"})
	engine := f.engine
	engine.Boot()
	origin := newTestServer(t, engine, func(token string) bool { return token == "full" }, RouteDeps{})
	call := func(path string, body ...string) parsed {
		method, payload := "GET", ""
		if len(body) > 0 {
			method, payload = "POST", body[0]
		}
		return decode(t, request(t, method, origin+path, "full", payload))
	}
	ingest := func() {
		now := f.getNow()
		engine.IngestTicksAt([]market.Tick{{Token: 1, LastPrice: 100, ClosePrice: 100, DepthUpdated: boolPtr(false)}}, now)
		engine.IngestTicksAt(bookTicks(input.Quotes, true, i64(int64(now-100))), now)
	}
	if err := engine.Watch("TEST"); err != nil {
		t.Fatal(err)
	}
	ingest()
	refresh := call("/refresh", `{"underlying":"TEST"}`)
	if refresh.status != 200 {
		t.Fatalf("refresh %d %v", refresh.status, string(jsjson.Marshal(refresh.data)))
	}
	snapshot := at(refresh.data, "snapshot")
	priced := false
	for _, row := range at(snapshot, "slices", 0, "rows").([]any) {
		if v, ok := at(row, "fair_value").(float64); ok && v > 0 {
			priced = true
		}
	}
	if !priced {
		t.Fatal("no row priced")
	}
	calculator := call("/calculate", `{"underlying":"TEST","strike":102,"expiry_timestamp":"2026-11-01T10:00:00Z","side":"CE","research_mode":false}`)
	if calculator.status != 200 || at(calculator.data, "available") != true || at(calculator.data, "contract") != "hypothetical" ||
		at(calculator.data, "instrument_token") != nil || len(at(calculator.data, "sensitivity", "scenarios").([]any)) < 3 {
		t.Fatalf("calculator %d %s", calculator.status, jsjson.Marshal(calculator.data))
	}
	req := jsjson.NewObjectValue()
	req.Set("underlying", "TEST")
	req.Set("expiry", at(snapshot, "slices", 0, "expiry"))
	req.Set("strike", 100.0)
	req.Set("input_snapshot_id", at(snapshot, "input_snapshot_id"))
	var wg sync.WaitGroup
	results := make([]*model.IndependentEstimate, 2)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r, err := engine.Independent(req)
			if err != nil {
				t.Error(err)
			}
			results[i] = r
		}(i)
	}
	wg.Wait()
	if results[0] == nil || results[0] != results[1] {
		t.Fatal("concurrent independent requests did not share one result")
	}
	again, _ := engine.Independent(req)
	if again != results[0] {
		t.Fatal("cached independent result not reused")
	}
	for _, p := range results[0].Forward.Pairs {
		if p.Strike == 100 {
			t.Fatal("target strike in the independent forward")
		}
	}
	old := fmt.Sprintf(`{"underlying":"TEST","expiry":%q,"strike":100,"input_snapshot_id":"old-snapshot"}`, at(snapshot, "slices", 0, "expiry"))
	if s := call("/independent", old).status; s != 400 {
		t.Fatalf("old snapshot id: %d", s)
	}
	for i := 0; i < 3; i++ {
		f.advance(10000)
		ingest()
		refresh = call("/refresh", `{"underlying":"TEST"}`)
	}
	history := call("/history/TEST")
	snapshots, _ := at(history.data, "snapshots").([]any)
	if len(snapshots) != 2 {
		t.Fatalf("history %d entries: %s", len(snapshots), jsjson.Marshal(history.data))
	}
	for _, s := range snapshots {
		for _, slice := range at(s, "slices").([]any) {
			if slice.(*jsjson.Object).Has("rows") {
				t.Fatal("history summary carries rows")
			}
		}
		if at(s, "model_version") == "" || at(s, "config_version") == "" || at(s, "input_snapshot_id") == "" {
			t.Fatal("history summary identity missing")
		}
	}
	historical := call(fmt.Sprintf("/history/TEST/%s", at(snapshots[0], "id")))
	if at(historical.data, "historical") != true {
		t.Fatalf("historical %d", historical.status)
	}
	if exp := call("/export/TEST"); exp.status != 200 || exp.header.Get("Content-Disposition") == "" {
		t.Fatalf("export %d", exp.status)
	}
	f.advance(input.Config.SurfaceMaxAgeMs + 1)
	if at(call("/snapshot/TEST").data, "stale") != true {
		t.Fatal("stale surface not reported")
	}
	if s := call("/calculate", `{"underlying":"TEST","strike":100,"expiry_timestamp":"2026-11-17T10:00:00Z","side":"CE","research_mode":false}`).status; s != 400 {
		t.Fatalf("stale calculate %d", s)
	}
	call("/pause", `{"paused":true}`)
	if n := len(f.currentTokens()); n != 0 {
		t.Fatalf("paused engine holds %d tokens", n)
	}
	if s := call("/refresh", `{"underlying":"TEST"}`).status; s != 503 {
		t.Fatalf("paused refresh %d", s)
	}
	disable := jsjson.NewObjectValue()
	disable.Set("enabled", false)
	if _, err := engine.UpdateConfig(disable); err != nil {
		t.Fatal(err)
	}
	if engine.Status().Enabled || len(f.currentTokens()) != 0 {
		t.Fatal("disable did not release everything")
	}
	if at(call("/snapshot/TEST").data, "snapshot") != nil {
		t.Fatal("snapshot survived disabling")
	}
}
