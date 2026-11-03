package registry

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/dhan"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/dbtest"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/hub"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/server"
)

// routes.golden.json is written by testdata/gen_registry.mjs, which drives the ORIGINAL
// ActiveBrokerManager and registerBrokerRoutes with fakes. Each scenario is replayed
// here against the Go registry behind the real server stack (CORS, body parser, global
// limiter) with the same fakes: Kite and hub doubles, loopback Dhan hosts, a PostgreSQL
// store when the scenario had a database, a WebSocket black hole for the Dhan feeds.
// Every step must give the same status and body bytes, the same hub/hook/Kite events in
// the same order, the same outbound Dhan requests (method, path, headers, body) and, per
// scenario, the same sockets.

type routesGolden struct {
	Masters   map[string]string   `json:"masters"`
	KiteRows  []market.Instrument `json:"kiteRows"`
	Scenarios []goldenScenario    `json:"scenarios"`
}

type goldenScenario struct {
	Name    string                `json:"name"`
	Env     map[string]string     `json:"env"`
	DB      bool                  `json:"db"`
	Seed    goldenSeed            `json:"seed"`
	Kite    *goldenKite           `json:"kite"`
	HTTP    map[string][]httpSpec `json:"http"`
	Steps   []goldenStep          `json:"steps"`
	Results []goldenResult        `json:"results"`
	Sockets []string              `json:"sockets"`
	StartMs int64                 `json:"startMs"`
}

type goldenSeed struct {
	ActiveBroker map[string]any `json:"active_broker"`
	DhanSession  map[string]any `json:"dhan_session"`
}

type goldenKite struct {
	Token         *string `json:"token"`
	HubConnected  bool    `json:"hubConnected"`
	HubSubscribed int64   `json:"hubSubscribed"`
}

type goldenStep struct {
	Op      string            `json:"op"`
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Query   string            `json:"query"`
	Token   json.RawMessage   `json:"token"`
	Headers map[string]string `json:"headers"`
	Body    json.RawMessage   `json:"body"`

	Ms    int64             `json:"ms"`
	Set   map[string]string `json:"set"`
	Unset []string          `json:"unset"`

	Tokens            []int64              `json:"tokens"`
	Lease             int                  `json:"lease"`
	IDs               []string             `json:"ids"`
	Orders            []market.MarginOrder `json:"orders"`
	ConsiderPositions *bool                `json:"considerPositions"`
	Fn                string               `json:"fn"`
	From              string               `json:"from"`
	To                string               `json:"to"`
	Interval          string               `json:"interval"`
	Prio              string               `json:"prio"`
	Force             bool                 `json:"force"`
	Lane              string               `json:"lane"`
	Broker            string               `json:"broker"`
}

type goldenResult struct {
	Status     *int     `json:"status"`
	Body       *string  `json:"body"`
	RetryAfter *string  `json:"retryAfter"`
	Value      *string  `json:"value"`
	Error      *string  `json:"error"`
	Events     []string `json:"events"`
	Out        []string `json:"out"`
}

func loadRoutesGolden(t *testing.T) routesGolden {
	t.Helper()
	raw, err := os.ReadFile("testdata/routes.golden.json")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	var g routesGolden
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatalf("decode golden: %v", err)
	}
	return g
}

// replay is one scenario's world.
type replay struct {
	t        *testing.T
	sc       goldenScenario
	clock    *fakeClock
	env      *fakeEnv
	rec      *recorder
	kite     *fakeKite
	hub      *fakeHub
	dhan     *fakeDhan
	hole     *blackHole
	kiteWS   *kiteSockets
	pool     *db.Pool
	reg      *Registry
	handler  http.Handler
	leases   []func()
	authRoot string
}

func TestRoutesGolden(t *testing.T) {
	g := loadRoutesGolden(t)
	if len(g.Scenarios) == 0 {
		t.Fatal("no scenarios")
	}
	// Node's last parse report is process-wide and the scenarios ran in one process; Go
	// tests run more parses, so the replay only sees a report once one of its own fake
	// masters has been served (the first scenario expects none).
	var served atomic.Bool
	prev := getParseReport
	getParseReport = func() *dhan.ParseReport {
		if !served.Load() {
			return nil
		}
		return dhan.GetParseReport()
	}
	t.Cleanup(func() { getParseReport = prev })
	dhan.SetLogger(func(string, ...any) {})
	t.Cleanup(func() { dhan.SetLogger(nil) })

	for _, sc := range g.Scenarios {
		ok := t.Run(sc.Name, func(t *testing.T) { runReplay(t, g, sc, &served) })
		if !ok {
			// Later scenarios inherit the process-wide parse report; stop at the first
			// divergence so its cause is not buried under follow-on failures.
			t.FailNow()
		}
	}
}

func runReplay(t *testing.T, g routesGolden, sc goldenScenario, served *atomic.Bool) {
	if len(sc.Steps) != len(sc.Results) {
		t.Fatalf("%d steps but %d results", len(sc.Steps), len(sc.Results))
	}
	rp := &replay{t: t, sc: sc, clock: newClock(sc.StartMs), env: newEnv(sc.Env), rec: &recorder{}}
	rp.kite = &fakeKite{rec: rp.rec, rows: g.KiteRows}
	rp.hub = &fakeHub{rec: rp.rec}
	if sc.Kite != nil {
		rp.kite.token = sc.Kite.Token
		rp.hub.connected.Store(sc.Kite.HubConnected)
		rp.hub.subscribed.Store(sc.Kite.HubSubscribed)
	}
	rp.dhan = newFakeDhan(t, sc.HTTP, served)
	rp.authRoot = rp.dhan.authRoot()
	rp.hole = newBlackHole(t)
	rp.kiteWS = &kiteSockets{}

	var store Store
	if sc.DB {
		rp.pool = dbtest.New(t)
		rp.seed(sc.Seed)
		store = &PGStore{Pool: rp.pool, Now: rp.clock.Now}
	}
	rp.reg = New(Deps{
		Kite:   rp.kite,
		Hub:    rp.hub,
		Store:  store,
		Lookup: rp.env.lookup,
		Now:    rp.clock.Now,
		Dhan: DhanConfig{
			APIRoot: rp.dhan.apiRoot(), AuthRoot: rp.authRoot, FeedURL: rp.hole.url(),
			ScripMasterURLs: rp.dhan.masterURLs(), HTTPClient: rp.dhan.srv.Client(),
			Sleep:  func(context.Context, time.Duration) error { return nil },
			Dialer: &websocket.Dialer{HandshakeTimeout: time.Minute},
		},
		KiteConnect: rp.kiteWS.connect,
	})
	rp.reg.Attach(recordingHooks(rp.rec))
	sessions := newSessions(t, rp.clock)
	rp.handler = server.New(server.Options{FrontendOrigin: "http://localhost:5173", Now: rp.clock.Now}, func(r chi.Router) {
		Mount(r, RouteDeps{Registry: rp.reg, Sessions: sessions, IndexSpotMap: IndexSpotMap, Now: rp.clock.Now})
	})
	t.Cleanup(func() {
		rp.reg.StopFeeds()
		rp.reg.bg.Wait()
	})

	for i, step := range sc.Steps {
		rp.rec.take()
		rp.dhan.takeOut()
		got := rp.run(step)
		rp.reg.bg.Wait()
		rp.reg.flushFeeds()
		rp.reg.bg.Wait()
		got.Events = rp.rec.take()
		got.Out = rp.dhan.takeOut()
		rp.compare(i, step, got, sc.Results[i])
		if t.Failed() {
			t.FailNow()
		}
	}

	var wantDhan, wantKite []string
	for _, s := range sc.Sockets {
		if strings.HasPrefix(s, "wss://ws.kite.trade") {
			wantKite = append(wantKite, s)
		} else {
			wantDhan = append(wantDhan, s)
		}
	}
	if gotDhan := rp.hole.waitFor(len(wantDhan), 5*time.Second); !reflect.DeepEqual(nonNil(gotDhan), nonNil(wantDhan)) {
		t.Errorf("Dhan sockets:\n got  %q\n want %q", gotDhan, wantDhan)
	}
	if gotKite := rp.kiteWS.list(); !reflect.DeepEqual(nonNil(gotKite), nonNil(wantKite)) {
		t.Errorf("Kite sockets:\n got  %q\n want %q", gotKite, wantKite)
	}
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func (rp *replay) ctx() context.Context { return context.Background() }

func (rp *replay) seed(s goldenSeed) {
	ctx := rp.ctx()
	ms := func(v any) *time.Time {
		f, ok := v.(float64)
		if !ok {
			return nil
		}
		t := time.UnixMilli(int64(f)).UTC()
		return &t
	}
	num := func(v any) *int64 {
		f, ok := v.(float64)
		if !ok {
			return nil
		}
		n := int64(f)
		return &n
	}
	if a := s.ActiveBroker; a != nil {
		_, err := rp.pool.Exec(ctx, `insert into active_broker (id, broker, selected_at, selected_by, generation) values ('current', $1, $2, $3, $4)`,
			a["broker"], ms(a["selected_at"]), a["selected_by"], num(a["generation"]))
		if err != nil {
			rp.t.Fatal(err)
		}
	}
	if d := s.DhanSession; d != nil {
		_, err := rp.pool.Exec(ctx, `insert into dhan_session (id, access_token, dhan_client_id, dhan_client_name, dhan_client_ucc,
			given_power_of_attorney, expiry_time, login_at, login_date, updated_at) values ('current', $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			d["access_token"], d["dhan_client_id"], d["dhan_client_name"], d["dhan_client_ucc"], d["given_power_of_attorney"],
			num(d["expiry_time"]), ms(d["login_at"]), d["login_date"], ms(d["updated_at"]))
		if err != nil {
			rp.t.Fatal(err)
		}
	}
}

// dbDump projects both tables onto the fields the Node stub dumps.
func (rp *replay) dbDump() map[string]any {
	out := map[string]any{"dhan_session": nil, "active_broker": nil}
	if rp.pool == nil {
		return out
	}
	ctx := rp.ctx()
	var broker, by string
	var gen *int64
	var at time.Time
	err := rp.pool.QueryRow(ctx, `select broker, selected_by, selected_at, generation from active_broker where id = 'current'`).Scan(&broker, &by, &at, &gen)
	if err == nil {
		var g any
		if gen != nil {
			g = float64(*gen)
		}
		out["active_broker"] = map[string]any{"broker": broker, "selected_by": by, "selected_at": float64(at.UnixMilli()), "generation": g}
	} else if !db.NoRows(err) {
		rp.t.Fatal(err)
	}
	if rec, err := (&PGStore{Pool: rp.pool}).LoadDhanSession(ctx); err != nil {
		rp.t.Fatal(err)
	} else if rec != nil {
		var exp any
		if rec.ExpiryTime != nil {
			exp = float64(*rec.ExpiryTime)
		}
		out["dhan_session"] = map[string]any{
			"access_token": rec.AccessToken, "dhan_client_id": rec.DhanClientID, "dhan_client_name": rec.DhanClientName,
			"dhan_client_ucc": rec.DhanClientUcc, "given_power_of_attorney": rec.GivenPowerOfAttorney, "expiry_time": exp,
			"login_at": float64(rec.LoginAt.UnixMilli()), "login_date": rec.LoginDate, "updated_at": float64(rec.UpdatedAt.UnixMilli()),
		}
	}
	return out
}

// projectNodeDump keeps the same fields of the stub's dump (absent → null).
func projectNodeDump(v map[string]any) map[string]any {
	pick := func(src any, keys ...string) any {
		m, ok := src.(map[string]any)
		if !ok {
			return nil
		}
		out := map[string]any{}
		for _, k := range keys {
			out[k] = m[k]
		}
		return out
	}
	return map[string]any{
		"active_broker": pick(v["active_broker"], "broker", "selected_by", "selected_at", "generation"),
		"dhan_session": pick(v["dhan_session"], "access_token", "dhan_client_id", "dhan_client_name", "dhan_client_ucc",
			"given_power_of_attorney", "expiry_time", "login_at", "login_date", "updated_at"),
	}
}

func strp(s string) *string { return &s }

func (rp *replay) value(v any, err error) goldenResult {
	if err != nil {
		return goldenResult{Error: strp(err.Error())}
	}
	switch x := v.(type) {
	case string:
		return goldenResult{Value: strp(x)}
	}
	return goldenResult{Value: strp(string(jsjson.Marshal(v)))}
}

// marginJSON writes a BasketMargin the way the TypeScript object literal for its source
// looks (the Go struct leaves out what Node sent as null).
func marginJSON(m market.BasketMargin) string {
	o := jsjson.NewObject(nil).Field("initial", m.Initial).Field("final", m.Final).Field("total", m.Total).Field("source", string(m.Source))
	opt := func(p *float64) any {
		if p == nil {
			return nil
		}
		return *p
	}
	switch m.Source {
	case market.MarginDhanMulti:
		o.Field("hedge_benefit", opt(m.HedgeBenefit)).Field("span", opt(m.Span)).Field("exposure", opt(m.Exposure))
	case market.MarginDhanPerLegFallback:
		o.Field("hedge_benefit", nil).Field("span", opt(m.Span)).Field("exposure", nil)
	}
	return string(o.End())
}

func (rp *replay) run(step goldenStep) goldenResult {
	reg := rp.reg
	ctx := rp.ctx()
	switch step.Op {
	case "req":
		return rp.request(step)
	case "restore":
		reg.Restore(ctx)
	case "startRuntime":
		reg.StartActiveRuntime(ctx)
	case "stopFeeds":
		reg.StopFeeds()
	case "advance":
		rp.clock.advance(step.Ms)
	case "env":
		for k, v := range step.Set {
			rp.env.set(k, v)
		}
		for _, k := range step.Unset {
			rp.env.unset(k)
		}
	case "kiteToken":
		var tok *string
		_ = json.Unmarshal(step.Token, &tok)
		rp.kite.setToken(tok)
	case "noteTick":
		reg.NoteTick()
	case "acquire":
		rp.leases = append(rp.leases, reg.AcquireBrowserTokens(step.Tokens))
	case "release":
		rp.leases[step.Lease]()
	case "setSynthetic":
		reg.SetSyntheticTokens(step.Tokens)
	case "setAnalytics":
		reg.SetAnalyticsTokens(step.Tokens)
	case "quotes":
		ticks, err := reg.QuoteProvider().QuotesByToken(ctx, step.Tokens)
		if err != nil {
			return rp.value(nil, err)
		}
		return goldenResult{Value: strp(string(hub.TicksJSON(ticks)))}
	case "marketData":
		return rp.value(reg.MarketData().GetQuoteFull(ctx, step.IDs))
	case "marketAuth":
		return rp.value(reg.MarketData().IsAuthenticated(), nil)
	case "margin":
		consider := true // Node: `opts ?? {}` leaves Kite's default considerPositions=true
		if step.ConsiderPositions != nil {
			consider = *step.ConsiderPositions
		}
		m, err := reg.Margins().BasketMargin(ctx, step.Orders, consider)
		if err != nil {
			return rp.value(nil, err)
		}
		return goldenResult{Value: strp(marginJSON(m))}
	case "history":
		var tok int64
		_ = json.Unmarshal(step.Token, &tok)
		h := reg.HistoryProvider()
		prio := kite.HistoricalPriority(step.Prio)
		switch step.Fn {
		case "full":
			return rp.value(h.GetHistoricalFull(ctx, tok, step.From, step.To, step.Interval, prio))
		case "close":
			return rp.value(h.GetHistorical(ctx, tok, step.From, step.To, step.Interval, prio))
		case "oi":
			return rp.value(h.GetHistoricalOi(ctx, tok, step.From, step.To, prio))
		case "oiSeries":
			return rp.value(h.GetHistoricalOiSeries(ctx, tok, step.From, step.To, step.Interval, prio))
		}
		rp.t.Fatalf("unknown history fn %q", step.Fn)
	case "loadInstruments":
		rows, err := reg.InstrumentProvider().Load(ctx, step.Force)
		if err != nil {
			return rp.value(nil, err)
		}
		return rp.value(len(rows), nil)
	case "owns":
		var tok int64
		_ = json.Unmarshal(step.Token, &tok)
		return rp.value(reg.AssertActiveBrokerToken(tok, "golden"), nil)
	case "snapshot":
		return rp.value(reg.Snapshot(), nil)
	case "feedHealth":
		return rp.value(reg.FeedHealth(), nil)
	case "laneStats":
		return rp.value(reg.LaneStats(brokers.Lane(step.Lane)), nil)
	case "upstream":
		return rp.value(reg.UpstreamFeedStats(), nil)
	case "health":
		return rp.value(reg.HealthFor(brokers.ID(step.Broker)), nil)
	case "db":
		return goldenResult{Value: strp("db")}
	default:
		rp.t.Fatalf("unknown op %q", step.Op)
	}
	return goldenResult{}
}

var tokens = map[string]string{"full": "full-token", "trade": "trade-token", "bogus": "bogus-token"}

func (rp *replay) request(step goldenStep) goldenResult {
	target := step.Path
	if step.Query != "" {
		target += "?" + step.Query
	}
	var body *bytes.Reader
	if len(step.Body) > 0 {
		body = bytes.NewReader(step.Body)
	}
	var req *http.Request
	if body != nil {
		req = httptest.NewRequest(step.Method, target, body)
		req.Header.Set("Content-Type", "application/json")
	} else {
		req = httptest.NewRequest(step.Method, target, nil)
	}
	req.RemoteAddr = "127.0.0.1:5555"
	var role string
	_ = json.Unmarshal(step.Token, &role)
	if role != "" {
		req.Header.Set("x-admin-token", tokens[role])
	}
	for k, v := range step.Headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	rp.handler.ServeHTTP(w, req)
	status := w.Code
	text := strings.ReplaceAll(w.Body.String(), rp.authRoot, "https://auth.dhan.co")
	res := goldenResult{Status: &status, Body: &text}
	if ra := w.Header().Get("Retry-After"); ra != "" {
		res.RetryAfter = &ra
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		rp.t.Errorf("%s %s: Content-Type %q", step.Method, target, ct)
	}
	return res
}

func describe(step goldenStep) string {
	if step.Op == "req" {
		q := ""
		if step.Query != "" {
			q = "?" + step.Query
		}
		return fmt.Sprintf("%s %s%s token=%s body=%s", step.Method, step.Path, q, step.Token, step.Body)
	}
	return fmt.Sprintf("%s %s", step.Op, step.Fn)
}

func firstDiff(a, b string) string {
	i := 0
	for i < len(a) && i < len(b) && a[i] == b[i] {
		i++
	}
	lo := max(0, i-120)
	ha, hb := min(len(a), i+120), min(len(b), i+120)
	return fmt.Sprintf("at byte %d:\n got  …%s…\n want …%s…", i, a[lo:ha], b[lo:hb])
}

func (rp *replay) compare(i int, step goldenStep, got, want goldenResult) {
	t := rp.t
	t.Helper()
	where := fmt.Sprintf("step %d (%s)", i, describe(step))
	// Broker readiness now needs only DHAN_CLIENT_ID. The original consent endpoints
	// still enforce their own app credentials; pin only the intended readiness-text change.
	if step.Op == "req" && step.Path != "/api/dhan/login" && step.Path != "/api/dhan/session" && want.Body != nil {
		body := strings.ReplaceAll(*want.Body,
			"Dhan is not configured: DHAN_CLIENT_ID, DHAN_API_KEY, DHAN_API_SECRET missing.",
			"Dhan is not configured: DHAN_CLIENT_ID missing.")
		want.Body = &body
	}
	if (step.Op == "health" || step.Op == "snapshot") && want.Value != nil {
		value := strings.ReplaceAll(*want.Value,
			"Dhan is not configured: DHAN_CLIENT_ID, DHAN_API_KEY, DHAN_API_SECRET missing.",
			"Dhan is not configured: DHAN_CLIENT_ID missing.")
		want.Value = &value
	}
	if step.Op == "db" {
		var node map[string]any
		if want.Value == nil || json.Unmarshal([]byte(*want.Value), &node) != nil {
			t.Fatalf("%s: bad golden db value", where)
		}
		if g, w := rp.dbDump(), projectNodeDump(node); !reflect.DeepEqual(g, w) {
			t.Errorf("%s: database\n got  %v\n want %v", where, g, w)
		}
		got.Value, want.Value = nil, nil
	}
	if step.Op == "marketData" && want.Value != nil {
		// Node's Zerodha path returned Kite's own quote objects, which also carry close and
		// oi; the provider contract (BoxRestQuote, market.RestQuote) and every consumer use
		// only these three fields.
		var rows []map[string]json.RawMessage
		if json.Unmarshal([]byte(*want.Value), &rows) == nil {
			parts := make([]string, len(rows))
			for i, r := range rows {
				parts[i] = fmt.Sprintf(`{"instrument_token":%s,"last_price":%s,"last_trade_time":%s}`,
					r["instrument_token"], r["last_price"], r["last_trade_time"])
			}
			want.Value = strp("[" + strings.Join(parts, ",") + "]")
		}
	}
	if (got.Status == nil) != (want.Status == nil) || (got.Status != nil && *got.Status != *want.Status) {
		t.Errorf("%s: status %v, want %v", where, deref(got.Status), deref(want.Status))
	}
	cmpStr := func(name string, g, w *string) {
		switch {
		case g == nil && w == nil:
		case g == nil || w == nil:
			t.Errorf("%s: %s %v, want %v", where, name, derefS(g), derefS(w))
		case *g != *w:
			t.Errorf("%s: %s differs %s", where, name, firstDiff(*g, *w))
		}
	}
	cmpStr("body", got.Body, want.Body)
	cmpStr("Retry-After", got.RetryAfter, want.RetryAfter)
	cmpStr("value", got.Value, want.Value)
	cmpStr("error", got.Error, want.Error)
	if !reflect.DeepEqual(nonNil(got.Events), nonNil(want.Events)) {
		t.Errorf("%s: events\n got  %q\n want %q", where, got.Events, want.Events)
	}
	if !reflect.DeepEqual(nonNil(got.Out), nonNil(want.Out)) {
		t.Errorf("%s: outbound requests\n got  %q\n want %q", where, got.Out, want.Out)
	}
}

func deref(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}

func derefS(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}
