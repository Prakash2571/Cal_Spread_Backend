package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
	_ "time/tzdata" // Asia/Kolkata without relying on the host zoneinfo

	"github.com/go-chi/chi/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/auth"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/captures"
	fjson "github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	kjson "github.com/Prakash2571/Cal_Spread_Backend/internal/kite/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/server"
)

// The goldens are recorded by testdata/gen_core.mjs, which runs the original route code
// of src/index.ts on Express 5.2.1 over loopback HTTP with scenario fakes. This file
// replays every scenario against the Go routes with fakes that behave the same way and
// compares status, headers, body, the collaborator calls, the Kite token and the rf.

type goldenStep struct {
	Op      string          `json:"op"`
	Ms      int64           `json:"ms"`
	TZ      string          `json:"tz"`
	Path    string          `json:"path"`
	Value   json.RawMessage `json:"value"`
	Method  string          `json:"method"`
	Headers [][2]string     `json:"headers"`
	Body    *string         `json:"body"`
	Res     *struct {
		Status  int               `json:"status"`
		Headers map[string]string `json:"headers"`
		Body    string            `json:"body"`
	} `json:"res"`
	Calls     map[string]json.RawMessage `json:"calls"`
	KiteToken json.RawMessage            `json:"kiteToken"`
	Rf        json.RawMessage            `json:"rf"`
	Logs      []string                   `json:"logs"`
	Board     string                     `json:"board"`
	Stocks    string                     `json:"stocks"`
}

type goldenScenario struct {
	Name  string          `json:"name"`
	World json.RawMessage `json:"world"`
	Steps []goldenStep    `json:"steps"`
}

func loadCoreGolden(t *testing.T) []goldenScenario {
	t.Helper()
	raw, err := os.ReadFile("testdata/core.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Scenarios []goldenScenario `json:"scenarios"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Scenarios) == 0 {
		t.Fatal("no scenarios")
	}
	return g.Scenarios
}

// --- the scenario world (ordered JSON, as the Node fakes saw it) ---

type world struct {
	mu   sync.Mutex
	root any
}

func parseOrdered(t testing.TB, raw []byte) any {
	t.Helper()
	v, err := fjson.Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	return v
}

func lookup(v any, keys ...string) (any, bool) {
	for _, k := range keys {
		o, ok := v.(*fjson.Object)
		if !ok {
			return nil, false
		}
		if v, ok = o.Get(k); !ok {
			return nil, false
		}
	}
	return v, true
}

func (w *world) get(keys ...string) (any, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	v, ok := lookup(w.root, keys...)
	return fjson.CloneValue(v), ok
}

func (w *world) set(path string, v any) {
	w.mu.Lock()
	defer w.mu.Unlock()
	keys := strings.Split(path, ".")
	parent, _ := lookup(w.root, keys[:len(keys)-1]...)
	parent.(*fjson.Object).Set(keys[len(keys)-1], v)
}

func (w *world) str(keys ...string) string {
	v, _ := w.get(keys...)
	s, _ := v.(string)
	return s
}

// decodeInto converts an ordered value into a Go type through its JSON text.
func decodeInto(v any, out any) error { return json.Unmarshal(fjson.Marshal(v), out) }

// failure is the scenario encoding of an error ({kiteError:{message,status}} or {error}).
func failure(v any) error {
	o, ok := v.(*fjson.Object)
	if !ok {
		return nil
	}
	if ke, ok := o.Get("kiteError"); ok {
		var e struct {
			Message string  `json:"message"`
			Status  float64 `json:"status"`
		}
		_ = decodeInto(ke, &e)
		return &kite.KiteError{Status: int(e.Status), Message: e.Message}
	}
	if msg, ok := o.Get("error"); ok {
		return errors.New(msg.(string))
	}
	return nil
}

// --- recording ---

type recorder struct {
	mu    sync.Mutex
	calls map[string][]any
	logs  []string
}

func (r *recorder) rec(cat string, args ...any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls[cat] = append(r.calls[cat], args)
}

func (r *recorder) logf(format string, args ...any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.logs = append(r.logs, fmt.Sprintf(format, args...))
}

func (r *recorder) reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = map[string][]any{}
	r.logs = nil
}

// --- fakes mirroring gen_core.mjs ---

type goldenKite struct {
	w *world
	r *recorder
}

func (k *goldenKite) LoginURL() string { return k.w.str("kite", "loginUrl") }

func (k *goldenKite) GenerateSession(_ context.Context, rt string) (kite.SessionData, error) {
	k.r.rec("kite", "generateSession", rt)
	s, ok := k.w.get("kite", "sessions", rt)
	if !ok {
		return kite.SessionData{}, &kite.KiteError{Status: 403, Message: "Token is invalid or has expired."}
	}
	if err := failure(s); err != nil {
		return kite.SessionData{}, err
	}
	data, _ := lookup(s, "data")
	token, _ := lookup(data, "access_token")
	k.w.set("kite.token", token)
	loose := func(key string) string {
		v, ok := lookup(data, key)
		if !ok || v == nil {
			return ""
		}
		return jsString(v)
	}
	return kite.SessionData{
		AccessToken: loose("access_token"), UserID: loose("user_id"), UserName: loose("user_name"),
		Raw: fjson.Marshal(data),
	}, nil
}

func (k *goldenKite) SetAccessToken(t string) {
	k.r.rec("kite", "setAccessToken", t)
	k.w.set("kite.token", t)
}

func (k *goldenKite) HasSession() bool { v, _ := k.w.get("kite", "token"); return v != nil }
func (k *goldenKite) APIKey() string   { return k.w.str("kite", "apiKey") }
func (k *goldenKite) AccessToken() string {
	return k.w.str("kite", "token")
}

func (k *goldenKite) ClearSession() {
	k.r.rec("kite", "clearSession")
	k.w.set("kite.token", nil)
}

func (k *goldenKite) GetProfile(context.Context) (json.RawMessage, error) {
	k.r.rec("kite", "getProfile")
	if k.AccessToken() == "" {
		return nil, &kite.KiteError{Status: 401, Message: "Not authenticated. Complete the Zerodha login flow first (/login)."}
	}
	p, _ := k.w.get("kite", "profile")
	if err := failure(p); err != nil {
		// The real client drops the session itself on a Kite 401/403.
		if ke, ok := kite.AsKiteError(err); ok && (ke.Status == 401 || ke.Status == 403) {
			k.ClearSession()
		}
		return nil, err
	}
	data, _ := lookup(p, "data")
	return fjson.Marshal(data), nil
}

type goldenKiteStore struct {
	w *world
	r *recorder
}

func (s *goldenKiteStore) SaveKiteSession(_ context.Context, rec KiteSessionRecord) error {
	s.r.rec("db", "saveKiteSession", map[string]any{
		"access_token": rec.AccessToken, "user_id": rec.UserID, "user_name": rec.UserName, "login_date": rec.LoginDate,
	})
	o := fjson.NewObjectValue()
	o.Set("access_token", rec.AccessToken)
	o.Set("user_id", rec.UserID)
	o.Set("user_name", rec.UserName)
	o.Set("login_date", rec.LoginDate)
	s.w.set("db.kiteSession", o)
	return nil
}

func (s *goldenKiteStore) LoadKiteSession(context.Context) (*KiteSessionRecord, error) {
	s.r.rec("db", "loadKiteSession")
	if msg := s.w.str("db", "loadError"); msg != "" {
		return nil, errors.New(msg)
	}
	v, _ := s.w.get("db", "kiteSession")
	if v == nil {
		return nil, nil
	}
	var rec struct {
		AccessToken string `json:"access_token"`
		UserID      string `json:"user_id"`
		UserName    string `json:"user_name"`
		LoginDate   string `json:"login_date"`
	}
	if err := decodeInto(v, &rec); err != nil {
		return nil, err
	}
	return &KiteSessionRecord{AccessToken: rec.AccessToken, UserID: rec.UserID, UserName: rec.UserName, LoginDate: rec.LoginDate}, nil
}

func (s *goldenKiteStore) ClearKiteSession(context.Context) error {
	s.r.rec("db", "clearKiteSession")
	if msg := s.w.str("db", "clearError"); msg != "" {
		return errors.New(msg)
	}
	s.w.set("db.kiteSession", nil)
	return nil
}

type goldenRfStore struct{ r *recorder }

func (s goldenRfStore) SaveRfRate(_ context.Context, v float64) error {
	s.r.rec("db", "saveRfRate", v)
	return nil
}

func (s goldenRfStore) LoadRfRate(context.Context) (float64, bool, error) { return 0, false, nil }

type memAdmin struct{ rows []auth.StoredSession }

func (m memAdmin) SaveAdminSession(context.Context, string, auth.Role, int64) error { return nil }
func (m memAdmin) DeleteAdminSession(context.Context, string) error                 { return nil }
func (m memAdmin) LoadAdminSessions(context.Context, int64) ([]auth.StoredSession, error) {
	return m.rows, nil
}

// goldenSeries reads world.history[token][key] the way the Node fake did ("NaN" closes
// stand for junk values Number() makes NaN).
func goldenSeries(w *world, token int64, key string) ([]*fjson.Object, error) {
	v, ok := w.get("history", strconv.FormatInt(token, 10), key)
	if !ok {
		return nil, nil
	}
	if err := failure(v); err != nil {
		return nil, err
	}
	var out []*fjson.Object
	for _, e := range v.([]any) {
		out = append(out, e.(*fjson.Object))
	}
	return out, nil
}

func num(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case string:
		return kjson.StringToNumber(x)
	}
	return math.NaN()
}

// --- the harness ---

type goldenHarness struct {
	t       *testing.T
	w       *world
	r       *recorder
	core    *Core
	handler http.Handler
	mu      sync.Mutex
	nowMs   int64
}

func (h *goldenHarness) now() time.Time {
	h.mu.Lock()
	defer h.mu.Unlock()
	return time.UnixMilli(h.nowMs)
}

func newGoldenHarness(t *testing.T, sc goldenScenario) *goldenHarness {
	h := &goldenHarness{t: t, w: &world{root: parseOrdered(t, sc.World)}, r: &recorder{calls: map[string][]any{}}}
	h.nowMs = time.Date(2026, 10, 27, 6, 0, 0, 0, time.UTC).UnixMilli()
	loc := time.UTC
	for _, s := range sc.Steps {
		if s.Op == "tz" {
			l, err := time.LoadLocation(s.TZ)
			if err != nil {
				t.Fatal(err)
			}
			loc = l
			break
		}
	}
	var admins []auth.StoredSession
	if a, ok := h.w.get("admin"); ok {
		o := a.(*fjson.Object)
		for _, tok := range o.Keys() {
			v, _ := o.Get(tok)
			var s struct {
				Role   string  `json:"role"`
				Expiry float64 `json:"expiry"`
			}
			_ = decodeInto(v, &s)
			admins = append(admins, auth.StoredSession{Token: tok, Role: auth.Role(s.Role), ExpiryMs: int64(s.Expiry)})
		}
	}
	sessions := auth.NewSessions(memAdmin{admins}, h.now)
	sessions.SetBackground(func(f func()) { f() })
	if _, err := sessions.Restore(context.Background()); err != nil {
		t.Fatal(err)
	}
	broker := func(keys ...string) any { v, _ := h.w.get(append([]string{"broker"}, keys...)...); return v }
	c, err := New(Deps{
		Kite:     &goldenKite{h.w, h.r},
		Sessions: sessions,
		ActiveBroker: func() brokers.ID {
			return brokers.ID(broker("active").(string))
		},
		ActiveHealth: func() Health {
			var hs struct {
				Authenticated bool     `json:"authenticated"`
				DataReady     bool     `json:"data_ready"`
				TradingReady  bool     `json:"trading_ready"`
				Problems      []string `json:"problems"`
			}
			_ = decodeInto(broker("health"), &hs)
			return Health{hs.Authenticated, hs.DataReady, hs.TradingReady, hs.Problems}
		},
		FeedHealth: func() brokers.FeedHealth {
			var f struct {
				Connected bool   `json:"connected"`
				State     string `json:"state"`
			}
			_ = decodeInto(broker("feed"), &f)
			return brokers.FeedHealth{Connected: f.Connected, State: brokers.FeedState(f.State)}
		},
		Generation: func() int64 { return int64(broker("generation").(float64)) },
		Instruments: func(context.Context) ([]market.Instrument, error) {
			h.r.rec("instruments", "load")
			v, _ := h.w.get("instruments")
			if err := failure(v); err != nil {
				return nil, err
			}
			var out []market.Instrument
			err := decodeInto(v, &out)
			return out, err
		},
		HistoricalOi: func(_ context.Context, token int64, from, to string) ([]kite.DayOI, error) {
			h.r.rec("history", "oi", token, from, to)
			rows, err := goldenSeries(h.w, token, "oi")
			out := make([]kite.DayOI, len(rows))
			for i, r := range rows {
				d, _ := r.Get("date")
				c, _ := r.Get("close")
				o, _ := r.Get("oi")
				out[i] = kite.DayOI{Date: d.(string), Close: num(c), OI: num(o)}
			}
			return out, err
		},
		Historical: func(_ context.Context, token int64, from, to, interval string) ([]kite.ClosePoint, error) {
			h.r.rec("history", "hist", token, from, to, interval)
			rows, err := goldenSeries(h.w, token, interval)
			out := make([]kite.ClosePoint, len(rows))
			for i, r := range rows {
				ts, _ := r.Get("t")
				c, _ := r.Get("close")
				out[i] = kite.ClosePoint{T: ts.(string), Close: num(c)}
			}
			return out, err
		},
		DividendYields: func(_ context.Context, symbols []string) map[string]float64 {
			h.r.rec("yahoo", "getDividendYields", symbols)
			out := map[string]float64{}
			for _, s := range symbols {
				if s == "" {
					continue
				}
				v, _ := h.w.get("yields", s)
				f, _ := v.(float64)
				out[s] = f
			}
			return out
		},
		SpreadSummary: func(_ context.Context, symbol string) (*captures.SpreadSummary, error) {
			h.r.rec("spread", "findOne", symbol)
			v, ok := h.w.get("spread", symbol)
			if !ok {
				return nil, nil
			}
			if err := failure(v); err != nil {
				return nil, err
			}
			var d struct {
				ID           string    `json:"_id"`
				Symbol       string    `json:"symbol"`
				Observations float64   `json:"observations"`
				FirstDate    time.Time `json:"first_date"`
				LastDate     time.Time `json:"last_date"`
				Mean         float64   `json:"mean_spread"`
				Max          float64   `json:"max_spread"`
				Min          float64   `json:"min_spread"`
				MeanDev      float64   `json:"mean_deviation"`
				MaxAbs       float64   `json:"max_abs_spread"`
				Std          float64   `json:"std_dev_spread"`
				P95          float64   `json:"percentile_95"`
				MRP          float64   `json:"mean_reversion_probability"`
			}
			if err := decodeInto(v, &d); err != nil {
				return nil, err
			}
			return &captures.SpreadSummary{
				ID: d.ID, Symbol: d.Symbol, Observations: d.Observations, FirstDate: d.FirstDate, LastDate: d.LastDate,
				MeanSpread: d.Mean, MaxSpread: d.Max, MinSpread: d.Min, MeanDeviation: d.MeanDev, MaxAbsSpread: d.MaxAbs,
				StdDevSpread: d.Std, Percentile95: d.P95, MeanReversionProbability: d.MRP,
			}, nil
		},
		KiteSessions:        &goldenKiteStore{h.w, h.r},
		RfStore:             goldenRfStore{h.r},
		OnKiteLogin:         func() { h.r.rec("hooks", "triggerPostLoginBackfill") },
		FrontendURL:         h.w.str("config", "frontendUrl"),
		InternalTokenSecret: h.w.str("config", "internalSecret"),
		TokenRouteSecret:    h.w.str("config", "tokenSecret"),
		Now:                 h.now,
		Location:            loc,
		Sleep: func(_ context.Context, d time.Duration) error {
			h.r.rec("delays", d.Milliseconds())
			return nil
		},
		Logf: h.r.logf,
	})
	if err != nil {
		t.Fatal(err)
	}
	h.core = c
	h.handler = server.New(server.Options{FrontendOrigin: h.w.str("config", "frontendUrl"), Now: h.now}, c.Mount)
	t.Cleanup(c.Dispose)
	return h
}

var keptHeaders = []string{"content-type", "location", "retry-after", "vary", "cache-control", "access-control-allow-origin"}

// canonJSON re-encodes JSON text with encoding/json so two encoders' number and key
// choices do not matter (negative zero is written as 0, as JSON.stringify does).
func canonJSON(t *testing.T, raw []byte) string {
	t.Helper()
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("canon %s: %v", raw, err)
	}
	var fix func(v any) any
	fix = func(v any) any {
		switch x := v.(type) {
		case float64:
			return x + 0
		case []any:
			for i := range x {
				x[i] = fix(x[i])
			}
		case map[string]any:
			for k := range x {
				x[k] = fix(x[k])
			}
		}
		return v
	}
	out, _ := json.Marshal(fix(v))
	return string(out)
}

// normalizeNodeCalls maps the Node call log onto what the Go fakes record: the stored
// Kite session as strings (Mongo would have cast user_id to a string; a missing
// user_name is "").
func normalizeNodeCalls(t *testing.T, cat string, raw json.RawMessage) string {
	t.Helper()
	var calls [][]any
	if err := json.Unmarshal(raw, &calls); err != nil {
		t.Fatal(err)
	}
	if cat == "db" {
		for _, c := range calls {
			if c[0] == "saveKiteSession" {
				m := c[1].(map[string]any)
				for _, k := range []string{"access_token", "user_id", "user_name", "login_date"} {
					if v, ok := m[k]; ok && v != nil {
						m[k] = jsString(v)
					} else {
						m[k] = ""
					}
				}
			}
		}
	}
	out, _ := json.Marshal(calls)
	return canonJSON(t, out)
}

func (h *goldenHarness) checkCalls(label string, want map[string]json.RawMessage) {
	t := h.t
	h.r.mu.Lock()
	got := h.r.calls
	h.r.mu.Unlock()
	for cat, raw := range want {
		g := got[cat]
		if g == nil {
			g = []any{}
		}
		gb, _ := json.Marshal(g)
		if gs, ws := canonJSON(t, gb), normalizeNodeCalls(t, cat, raw); gs != ws {
			t.Errorf("%s: %s calls\n got %s\nwant %s", label, cat, gs, ws)
		}
	}
	for cat := range got {
		if _, ok := want[cat]; !ok {
			t.Errorf("%s: unexpected %s calls %v", label, cat, got[cat])
		}
	}
}

func (h *goldenHarness) checkState(label string, s goldenStep) {
	t := h.t
	var wantTok *string
	_ = json.Unmarshal(s.KiteToken, &wantTok)
	gotTokV, _ := h.w.get("kite", "token")
	var gotTok *string
	if str, ok := gotTokV.(string); ok {
		gotTok = &str
	}
	if (wantTok == nil) != (gotTok == nil) || (wantTok != nil && *wantTok != *gotTok) {
		t.Errorf("%s: kite token %v, want %v", label, deref(gotTok), deref(wantTok))
	}
	var wantRf *float64
	_ = json.Unmarshal(s.Rf, &wantRf)
	gotRf := h.core.RfPct()
	if (wantRf == nil) != (gotRf == nil) || (wantRf != nil && *wantRf != *gotRf) {
		t.Errorf("%s: rf %v, want %v", label, deref(gotRf), deref(wantRf))
	}
}

func deref[T any](p *T) any {
	if p == nil {
		return nil
	}
	return *p
}

func (h *goldenHarness) request(label string, s goldenStep) {
	t := h.t
	var body *strings.Reader
	if s.Body != nil {
		body = strings.NewReader(*s.Body)
	} else {
		body = strings.NewReader("")
	}
	req := httptest.NewRequest(s.Method, s.Path, body)
	if s.Body == nil {
		req.Body = http.NoBody
		req.ContentLength = 0
	}
	req.RemoteAddr = "127.0.0.1:40000"
	for _, kv := range s.Headers {
		// On the wire both servers drop the optional whitespace around a header value.
		req.Header.Add(kv[0], strings.Trim(kv[1], " \t"))
	}
	rec := httptest.NewRecorder()
	h.handler.ServeHTTP(rec, req)
	h.core.queue.wait()

	res := s.Res
	if rec.Code != res.Status {
		t.Errorf("%s: status %d, want %d (body %s)", label, rec.Code, res.Status, rec.Body.String())
	}
	got := map[string]string{}
	for _, k := range keptHeaders {
		if v := rec.Header().Values(k); len(v) > 0 {
			got[k] = strings.Join(v, ", ")
		}
	}
	if fmt.Sprint(sortedMap(got)) != fmt.Sprint(sortedMap(res.Headers)) {
		t.Errorf("%s: headers\n got %v\nwant %v", label, got, res.Headers)
	}
	if strings.Contains(res.Body, "<pre>SyntaxError: ") {
		// body-parser's JSON.parse message (V8's wording) versus encoding/json's: the
		// shared body parser answers 400 with its own text. Status and type are compared.
		return
	}
	if rec.Body.String() != res.Body {
		t.Errorf("%s: body\n got %s\nwant %s", label, rec.Body.String(), res.Body)
	}
}

func sortedMap(m map[string]string) []string {
	var out []string
	for k, v := range m {
		out = append(out, k+"="+v)
	}
	sort.Strings(out)
	return out
}

func TestRoutesGolden(t *testing.T) {
	for _, sc := range loadCoreGolden(t) {
		t.Run(sc.Name, func(t *testing.T) {
			h := newGoldenHarness(t, sc)
			for i, s := range sc.Steps {
				label := fmt.Sprintf("step %d %s %s", i, s.Method, s.Path)
				h.r.reset()
				switch s.Op {
				case "now":
					h.mu.Lock()
					h.nowMs = s.Ms
					h.mu.Unlock()
				case "tz":
					// The zone is fixed per scenario (first tz step); a later switch back to
					// UTC only resets the generator.
				case "set":
					h.w.set(s.Path, parseOrdered(t, s.Value))
				case "req":
					h.request(label, s)
					h.checkCalls(label, s.Calls)
					h.checkState(label, s)
				case "restore":
					label = fmt.Sprintf("step %d restore", i)
					h.core.RestoreKiteSession(context.Background())
					h.core.queue.wait()
					h.checkCalls(label, s.Calls)
					h.checkState(label, s)
					var want []string
					for _, l := range s.Logs {
						// Node printed the Error object ("Error: msg"); Go prints the message.
						want = append(want, strings.Replace(l, "failed: Error: ", "failed: ", 1))
					}
					h.r.mu.Lock()
					got := append([]string(nil), h.r.logs...)
					h.r.mu.Unlock()
					if strings.Join(got, "\n") != strings.Join(want, "\n") {
						t.Errorf("%s: logs\n got %q\nwant %q", label, got, want)
					}
				case "board":
					v, _ := h.w.get("instruments")
					var all []market.Instrument
					if err := decodeInto(v, &all); err != nil {
						t.Fatal(err)
					}
					if got := string(fjson.Marshal(DeriveFnoBoard(all))); got != s.Board {
						t.Errorf("step %d: deriveFnoBoard\n got %s\nwant %s", i, got, s.Board)
					}
					if got := string(fjson.Marshal(DeriveFnoStocks(all))); got != s.Stocks {
						t.Errorf("step %d: deriveFnoStocks\n got %s\nwant %s", i, got, s.Stocks)
					}
				default:
					t.Fatalf("unknown op %q", s.Op)
				}
			}
		})
	}
}

// --- library behaviour (express.golden.json: node:querystring, encodeurl, escape-html,
// accepts/negotiator, decodeURIComponent of route params) ---

func TestExpressHelpersGolden(t *testing.T) {
	raw, err := os.ReadFile("testdata/express.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Queries []struct {
			Q      string                     `json:"q"`
			Parsed map[string]json.RawMessage `json:"parsed"`
		} `json:"queries"`
		EncodeURL  []struct{ In, Out string } `json:"encodeUrl"`
		EscapeHTML []struct{ In, Out string } `json:"escapeHtml"`
		Accepts    []struct {
			Accept *string `json:"accept"`
			Result string  `json:"result"`
		} `json:"accepts"`
		DecodeParam []struct {
			Raw   string `json:"raw"`
			OK    bool   `json:"ok"`
			Value string `json:"value"`
		} `json:"decodeParam"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	for _, c := range g.Queries {
		want := map[string][]string{}
		for k, v := range c.Parsed {
			var s string
			if json.Unmarshal(v, &s) == nil {
				want[k] = []string{s}
				continue
			}
			var arr []string
			if err := json.Unmarshal(v, &arr); err != nil {
				t.Fatal(err)
			}
			want[k] = arr
		}
		got := parseQuery(c.Q)
		gb, _ := json.Marshal(got)
		wb, _ := json.Marshal(want)
		if string(gb) != string(wb) {
			q := c.Q
			if len(q) > 80 {
				q = q[:80] + "…"
			}
			t.Errorf("parseQuery(%q)\n got %.300s\nwant %.300s", q, gb, wb)
		}
	}
	for _, c := range g.EncodeURL {
		if got := encodeURL(c.In); got != c.Out {
			t.Errorf("encodeURL(%q) = %q, want %q", c.In, got, c.Out)
		}
	}
	for _, c := range g.EscapeHTML {
		if got := escapeHTML(c.In); got != c.Out {
			t.Errorf("escapeHTML(%q) = %q, want %q", c.In, got, c.Out)
		}
	}
	for _, c := range g.Accepts {
		accept := ""
		if c.Accept != nil {
			accept = *c.Accept
		}
		if got := negotiateTextHTML(accept); got != c.Result {
			t.Errorf("accepts(%q) = %q, want %q", accept, got, c.Result)
		}
	}
	r := chi.NewRouter()
	var gotValue string
	var gotOK bool
	r.Get("/x/{p}", func(w http.ResponseWriter, r *http.Request) { gotValue, _, gotOK = pathParam(r, "p") })
	for _, c := range g.DecodeParam {
		gotValue, gotOK = "", false
		r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/x/"+c.Raw, nil))
		if gotOK != c.OK || (c.OK && gotValue != c.Value) {
			t.Errorf("param %q = %q ok=%v, want %q ok=%v", c.Raw, gotValue, gotOK, c.Value, c.OK)
		}
	}
}
