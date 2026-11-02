package calendar

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/auth"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/dbtest"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	kitejson "github.com/Prakash2571/Cal_Spread_Backend/internal/kite/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/server"
)

// Replays testdata/routes.golden.json: every request the original index.ts handlers
// answered, against the Go routes on PostgreSQL, a real kite.Client talking to a
// loopback server that serves the responses Node's fake Kite served, the same hub books,
// instrument universe, board and clock. Per step it checks the response bytes, every
// Kite request (method, URL, headers, body), the Kite session afterwards, the sendError
// session clears, the instrument loads, the hub lookups, the trade_log rows and the
// warnings.
//
// One answer differs from Node on purpose (PLAN.md Decisions): the 503 text names
// DATABASE_URL instead of MONGODB_URI. A 12-character id gets Node's own answer (400,
// bson 6.10.4 ObjectId.isValid accepts only 24 hex characters).

type persistedSessions []auth.StoredSession

func (p persistedSessions) SaveAdminSession(context.Context, string, auth.Role, int64) error {
	return nil
}
func (p persistedSessions) DeleteAdminSession(context.Context, string) error { return nil }
func (p persistedSessions) LoadAdminSessions(context.Context, int64) ([]auth.StoredSession, error) {
	return p, nil
}

// kiteReplay is the loopback Kite of one scenario.
type kiteReplay struct {
	t    *testing.T
	pool *db.Pool
	mu   sync.Mutex
	step string
	exs  []*kitejson.Value
	errs []string
}

func (k *kiteReplay) load(step string, exs []*kitejson.Value) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.step, k.exs, k.errs = step, exs, nil
}

func (k *kiteReplay) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	k.mu.Lock()
	if len(k.exs) == 0 {
		k.errs = append(k.errs, fmt.Sprintf("unexpected Kite request %s %s %s", r.Method, r.URL.RequestURI(), body))
		k.mu.Unlock()
		w.WriteHeader(599)
		return
	}
	ex := k.exs[0]
	k.exs = k.exs[1:]
	req := ex.Get("request")
	if r.Method != req.Get("method").Str() || r.URL.RequestURI() != req.Get("url").Str() || string(body) != req.Get("body").Str() {
		k.errs = append(k.errs, fmt.Sprintf("Kite request\n got %s %s %s\nwant %s %s %s", r.Method, r.URL.RequestURI(), body,
			req.Get("method").Str(), req.Get("url").Str(), req.Get("body").Str()))
	}
	hdr := req.Get("headers")
	for _, name := range []string{"x-kite-version", "authorization", "content-type"} {
		want := hdr.Get(name)
		got := r.Header.Values(name)
		switch {
		case want.Nullish() && len(got) > 0:
			k.errs = append(k.errs, fmt.Sprintf("Kite request header %s = %q, Node sent none", name, got))
		case !want.Nullish() && (len(got) != 1 || got[0] != want.Str()):
			k.errs = append(k.errs, fmt.Sprintf("Kite request header %s = %q, Node %q", name, got, want.Str()))
		}
	}
	if id := ex.Get("sideEffect").Get("deleteTrade"); !id.Nullish() {
		if _, err := k.pool.Exec(context.Background(), `delete from trades where id = $1`, id.Str()); err != nil {
			k.errs = append(k.errs, "side effect: "+err.Error())
		}
	}
	k.mu.Unlock()
	res := ex.Get("response")
	ct := "application/json; charset=utf-8"
	if typ := res.Get("type"); !typ.Nullish() {
		ct = typ.Str()
	}
	w.Header().Set("Content-Type", ct)
	w.WriteHeader(int(res.Get("status").Num()))
	_, _ = io.WriteString(w, res.Get("body").Str())
}

func (k *kiteReplay) finish() []string {
	k.mu.Lock()
	defer k.mu.Unlock()
	errs := k.errs
	if len(k.exs) > 0 {
		errs = append(errs, fmt.Sprintf("%d Kite exchanges Node made were not requested", len(k.exs)))
	}
	return errs
}

func TestRoutesGolden(t *testing.T) {
	g := loadGolden(t, "testdata/routes.golden.json")
	universes := map[string][]market.Instrument{}
	for _, name := range g.Get("universes").Keys() {
		universes[name] = gInstruments(t, g.Get("universes").Get(name))
	}
	boards := map[string][]BoardItem{}
	for _, name := range g.Get("boards").Keys() {
		boards[name] = gBoard(t, g.Get("boards").Get(name))
	}
	steps := 0
	for _, sc := range g.Get("scenarios").Elems() {
		sc := sc
		t.Run(sc.Get("name").Str(), func(t *testing.T) {
			steps += replayScenario(t, g, sc, universes, boards)
		})
	}
	t.Logf("%d steps replayed", steps)
}

func replayScenario(t *testing.T, g, sc *kitejson.Value, universes map[string][]market.Instrument, boards map[string][]BoardItem) int {
	pool := dbtest.New(t)
	st := &store{pool: pool}
	var clock atomic.Int64
	now := func() time.Time { return time.UnixMilli(clock.Load()).UTC() }
	clock.Store(int64(sc.Get("steps").Index(0).Get("at").Num()))

	var rows persistedSessions
	for _, s := range g.Get("sessions").Elems() {
		rows = append(rows, auth.StoredSession{Token: s.Get("token").Str(), Role: auth.Role(s.Get("role").Str()), ExpiryMs: int64(s.Get("expiry").Num())})
	}
	sessions := auth.NewSessions(rows, now)
	sessions.SetBackground(func(f func()) { f() })
	if _, err := sessions.Restore(context.Background()); err != nil {
		t.Fatal(err)
	}

	replay := &kiteReplay{t: t, pool: pool}
	srv := httptest.NewServer(replay)
	defer srv.Close()
	kc, err := kite.NewClient(kite.Config{APIKey: "kite-key", APISecret: "kite-secret", APIRoot: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	kc.SetAccessToken(g.Get("kiteSession").Str())

	seq := 0
	newID := func() string { seq++; return fmt.Sprintf("65a1%020x", seq) }
	var ledgerWant []string
	steps := sc.Get("steps").Elems()
	for _, step := range steps {
		name := step.Get("name").Str()
		clock.Store(int64(step.Get("at").Num()))
		if sa := step.Get("session"); !sa.Nullish() {
			if sa.Get("clear").Truthy() {
				kc.ClearSession()
			} else {
				kc.SetAccessToken(sa.Get("set").Str())
			}
		}
		for _, d := range step.Get("seed").Elems() {
			if err := st.insert(context.Background(), gTrade(t, d)); err != nil {
				t.Fatalf("%s: seed: %v", name, err)
			}
		}
		replay.load(name, step.Get("exchanges").Elems())

		md := step.Get("md")
		outcomes := step.Get("instruments").Elems()
		instCalls := 0
		lastUniverse := ""
		var mu sync.Mutex
		cleared := 0
		h := &fakeHub{books: gBooks(step.Get("hub"))}
		logs := &logSink{}
		deps := Deps{
			Sessions: sessions,
			RequireMarketData: func(what string) (bool, MarketDataRefusal) {
				if md.Get("ready").Truthy() {
					return true, MarketDataRefusal{}
				}
				var problems []string
				for _, p := range md.Get("problems").Elems() {
					problems = append(problems, p.Str())
				}
				return false, NewMarketDataRefusal(what, md.Get("broker").Str(), problems)
			},
			Instruments: func(context.Context) ([]market.Instrument, error) {
				mu.Lock()
				defer mu.Unlock()
				o := outcomes[min(instCalls, len(outcomes)-1)]
				instCalls++
				if e := o.Get("error"); !e.Nullish() {
					return nil, gError(e)
				}
				lastUniverse = o.Get("list").Str()
				return universes[lastUniverse], nil
			},
			Board: func([]market.Instrument) []BoardItem {
				mu.Lock()
				defer mu.Unlock()
				return boards[lastUniverse]
			},
			Hub:  h,
			Kite: kc,
			ClearKiteSession: func() {
				kc.ClearSession()
				mu.Lock()
				cleared++
				mu.Unlock()
			},
			Now:   now,
			NewID: newID,
			Logf:  logs.logf,
		}
		if step.Get("db").Truthy() {
			deps.Pool = pool
		}
		svc := New(deps)
		handler := server.New(server.Options{FrontendOrigin: "http://localhost:5173", Now: now}, svc.Mount)

		var path, method string
		id := step.Get("id").Str()
		switch step.Get("route").Str() {
		case "take":
			method, path = http.MethodPost, "/api/trades"
		case "list":
			method, path = http.MethodGet, "/api/trades"
		case "close":
			method, path = http.MethodPost, "/api/trades/"+url.PathEscape(id)+"/close"
		case "delete":
			method, path = http.MethodDelete, "/api/trades/"+url.PathEscape(id)
		}
		var body io.Reader
		if b := step.Get("body"); !b.Nullish() {
			body = strings.NewReader(b.Str())
		}
		req := httptest.NewRequest(method, path, body)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if tok := step.Get("token"); !tok.Nullish() {
			req.Header.Set("X-Admin-Token", tok.Str())
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		svc.Stop()

		wantStatus := int(step.Get("response").Get("status").Num())
		wantBody := strings.ReplaceAll(step.Get("response").Get("body").Str(), "(set MONGODB_URI)", "(set DATABASE_URL)")
		if rec.Code != wantStatus || rec.Body.String() != wantBody {
			t.Errorf("%s: response\n got %d %s\nwant %d %s", name, rec.Code, rec.Body.String(), wantStatus, wantBody)
		}
		if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
			t.Errorf("%s: content type %q", name, ct)
		}
		for _, e := range replay.finish() {
			t.Errorf("%s: %s", name, e)
		}
		after := step.Get("kiteSessionAfter")
		if after.Nullish() == kc.HasSession() || (!after.Nullish() && kc.AccessToken() != after.Str()) {
			t.Errorf("%s: Kite session after = %v %q, Node %s", name, kc.HasSession(), kc.AccessToken(), kitejson.Marshal(after))
		}
		if float64(cleared) != step.Get("cleared").Num() {
			t.Errorf("%s: sendError cleared the Kite session %d times, Node %v", name, cleared, step.Get("cleared").Num())
		}
		if float64(instCalls) != step.Get("instrumentCalls").Num() {
			t.Errorf("%s: %d instrument loads, Node %v", name, instCalls, step.Get("instrumentCalls").Num())
		}
		if got, want := marshal(h.calls), string(kitejson.Marshal(step.Get("hubCalls"))); got != want {
			t.Errorf("%s: hub lookups %s, Node %s", name, got, want)
		}
		if len(h.badAge) > 0 {
			t.Errorf("%s: getFreshLadder max ages %v", name, h.badAge)
		}
		checkWarns(t, name, step.Get("warns").Elems(), logs.take())
		for _, e := range step.Get("ledger").Elems() {
			ledgerWant = append(ledgerWant, e.Str())
		}
		got := readLedger(t, pool)
		if len(got) != len(ledgerWant) {
			t.Errorf("%s: %d trade_log rows, Node %d", name, len(got), len(ledgerWant))
		} else {
			for i := range got {
				if got[i] != ledgerWant[i] {
					t.Errorf("%s: trade_log row %d\n got %s\nwant %s", name, i, got[i], ledgerWant[i])
				}
			}
		}
	}
	return len(steps)
}

// readLedger reads trade_log in append order as the canonical document the generator
// records: the TradeLog schema's key order, legs and charges as stored.
func readLedger(t *testing.T, pool *db.Pool) []string {
	t.Helper()
	rows, err := pool.Query(context.Background(), `select trade_id, symbol, name, is_index, lot_size, event, at,
		legs, value, charges, source, margin, gross_pnl, total_charges, net_pnl from trade_log order by at, id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var tradeID, symbol, name, event, source string
		var isIndex bool
		var lot, value float64
		var at time.Time
		var legs, charges []byte
		var margin, gross, total, net *float64
		if err := rows.Scan(&tradeID, &symbol, &name, &isIndex, &lot, &event, &at, &legs, &value, &charges, &source,
			&margin, &gross, &total, &net); err != nil {
			t.Fatal(err)
		}
		raw := func(b []byte) jsjson.RawObject { return func(dst []byte) []byte { return append(dst, b...) } }
		doc := jsjson.NewObject(nil).Field("trade_id", tradeID).Field("symbol", symbol).Field("name", name).
			Field("is_index", isIndex).Field("lot_size", lot).Field("event", event).Field("at", jsx.ISO(at)).
			Field("legs", raw(legs)).Field("value", value).Field("charges", raw(charges)).Field("source", source).
			Field("margin", margin).Field("gross_pnl", gross).Field("total_charges", total).Field("net_pnl", net).End()
		out = append(out, string(doc))
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}
