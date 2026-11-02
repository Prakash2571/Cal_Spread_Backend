package fairvalue

// Strict re-port of tests/fairValue/service.test.mjs "admin HTTP workflow: publish,
// calculate, independent cache, history, pause, disable and failure isolation".
// TestServiceAdminHTTPWorkflow replays the same steps, but three of its checks pass when
// a key is absent (its `at` helper returns nil for a missing key). Node's checks are:
//   history: every summary has a truthy model_version, config_version and input_snapshot_id;
//   calculate: calculator.data.instrument_token === null (present and null);
//   after disabling: (await call('/snapshot/TEST')).data.snapshot === null (present and null).
// This test runs the same workflow and asserts those three exactly.

import (
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/fvtest"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// presentNull reports whether v is an object that HAS key with the JSON value null.
func presentNull(v any, key string) bool {
	o, ok := v.(*jsjson.Object)
	if !ok || !o.Has(key) {
		return false
	}
	x, _ := o.Get(key)
	return x == nil
}

// truthyString reports whether v[key] is a non-empty string (a JS-truthy identity).
func truthyString(v any, key string) bool {
	s, ok := at(v, key).(string)
	return ok && s != ""
}

func TestNodeServiceWorkflowStrictPresence(t *testing.T) {
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
	if refresh := call("/refresh", `{"underlying":"TEST"}`); refresh.status != 200 {
		t.Fatalf("refresh %d", refresh.status)
	}

	calculator := call("/calculate", `{"underlying":"TEST","strike":102,"expiry_timestamp":"2026-11-01T10:00:00Z","side":"CE","research_mode":false}`)
	if calculator.status != 200 || at(calculator.data, "available") != true {
		t.Fatalf("calculator %d %s", calculator.status, jsjson.Marshal(calculator.data))
	}
	if !presentNull(calculator.data, "instrument_token") {
		t.Errorf("calculator.data.instrument_token must be present and null: %s", jsjson.Marshal(calculator.data))
	}

	for i := 0; i < 3; i++ {
		f.advance(10000)
		ingest()
		call("/refresh", `{"underlying":"TEST"}`)
	}
	history := call("/history/TEST")
	snapshots, _ := at(history.data, "snapshots").([]any)
	if len(snapshots) != 2 {
		t.Fatalf("history %d entries: %s", len(snapshots), jsjson.Marshal(history.data))
	}
	for i, s := range snapshots {
		for _, key := range []string{"model_version", "config_version", "input_snapshot_id"} {
			if !truthyString(s, key) {
				t.Errorf("history summary %d: %s must be a non-empty string, got %#v", i, key, at(s, key))
			}
		}
	}

	f.advance(input.Config.SurfaceMaxAgeMs + 1)
	if at(call("/snapshot/TEST").data, "stale") != true {
		t.Fatal("stale surface not reported")
	}
	call("/pause", `{"paused":true}`)
	if s := call("/refresh", `{"underlying":"TEST"}`).status; s != 503 {
		t.Fatalf("paused refresh %d", s)
	}
	disable := jsjson.NewObjectValue()
	disable.Set("enabled", false)
	if _, err := engine.UpdateConfig(disable); err != nil {
		t.Fatal(err)
	}
	final := call("/snapshot/TEST")
	if !presentNull(final.data, "snapshot") {
		t.Errorf("after disabling, data.snapshot must be present and null: %d %s", final.status, jsjson.Marshal(final.data))
	}
}
