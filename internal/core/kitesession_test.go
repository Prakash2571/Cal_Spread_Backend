package core

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/auth"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/dbtest"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/server"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/store"
)

// istTime is an IST wall-clock instant.
func istTime(y, mo, d, h, mi int) time.Time {
	return time.Date(y, time.Month(mo), d, h, mi, 0, 0, time.FixedZone("IST", 5*3600+1800))
}

type testClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *testClock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *testClock) set(t time.Time) {
	c.mu.Lock()
	c.t = t
	c.mu.Unlock()
}

func TestPGKiteSessionsRoundTrip(t *testing.T) {
	pool := dbtest.New(t)
	clk := &testClock{t: time.Date(2026, 10, 27, 4, 30, 0, 123_456_789, time.UTC)}
	s := &PGKiteSessions{Pool: pool, Now: clk.now}
	ctx := context.Background()

	if rec, err := s.LoadKiteSession(ctx); rec != nil || err != nil {
		t.Fatalf("empty table: %+v %v", rec, err)
	}
	if err := s.SaveKiteSession(ctx, KiteSessionRecord{AccessToken: "a1", UserID: "AB1234", UserName: "Trader One", LoginDate: "2026-10-27"}); err != nil {
		t.Fatal(err)
	}
	clk.set(clk.now().Add(time.Hour))
	// A second login the same day replaces every field of the single row.
	if err := s.SaveKiteSession(ctx, KiteSessionRecord{AccessToken: "a2", LoginDate: "2026-10-28"}); err != nil {
		t.Fatal(err)
	}
	rec, err := s.LoadKiteSession(ctx)
	if err != nil || rec == nil {
		t.Fatalf("load: %+v %v", rec, err)
	}
	want := KiteSessionRecord{AccessToken: "a2", UserID: "", UserName: "", LoginDate: "2026-10-28",
		UpdatedAt: time.Date(2026, 10, 27, 5, 30, 0, 123_000_000, time.UTC)}
	if *rec != want {
		t.Fatalf("load = %+v, want %+v", *rec, want)
	}
	var n int
	if err := pool.QueryRow(ctx, `select count(*) from kite_session`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("rows = %d, %v (want exactly one, id 'current')", n, err)
	}
	if err := s.ClearKiteSession(ctx); err != nil {
		t.Fatal(err)
	}
	if rec, err := s.LoadKiteSession(ctx); rec != nil || err != nil {
		t.Fatalf("after clear: %+v %v", rec, err)
	}
	if err := s.ClearKiteSession(ctx); err != nil { // clearing nothing is fine
		t.Fatal(err)
	}
}

func TestPGKiteSessionsWithoutDatabaseAreNoOps(t *testing.T) {
	for _, s := range []*PGKiteSessions{nil, {}, {Pool: (*db.Pool)(nil)}} {
		ctx := context.Background()
		if err := s.SaveKiteSession(ctx, KiteSessionRecord{AccessToken: "x"}); err != nil {
			t.Fatal(err)
		}
		if rec, err := s.LoadKiteSession(ctx); rec != nil || err != nil {
			t.Fatalf("load: %+v %v", rec, err)
		}
		if err := s.ClearKiteSession(ctx); err != nil {
			t.Fatal(err)
		}
	}
}

// fakeKiteAPI is a loopback Kite REST server: /session/token and /user/profile.
type fakeKiteAPI struct {
	srv      *httptest.Server
	mu       sync.Mutex
	exchange []string // request tokens seen
}

func newFakeKiteAPI(t *testing.T) *fakeKiteAPI {
	f := &fakeKiteAPI{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/session/token":
			_ = r.ParseForm()
			rt := r.PostForm.Get("request_token")
			f.mu.Lock()
			f.exchange = append(f.exchange, rt)
			f.mu.Unlock()
			if rt == "good" {
				_, _ = io.WriteString(w, `{"status":"success","data":{"user_type":"individual","user_name":"Trader One","user_id":"AB1234","access_token":"live-token","login_time":"2026-10-27 10:00:00"}}`)
				return
			}
			w.WriteHeader(http.StatusForbidden)
			_, _ = io.WriteString(w, `{"status":"error","message":"Token is invalid or has expired.","error_type":"TokenException"}`)
		case "/user/profile":
			if r.Header.Get("Authorization") != "token key:live-token" {
				w.WriteHeader(http.StatusForbidden)
				_, _ = io.WriteString(w, `{"status":"error","message":"Incorrect `+"`api_key`"+` or `+"`access_token`"+`.","error_type":"TokenException"}`)
				return
			}
			_, _ = io.WriteString(w, `{"status":"success","data":{"user_id":"AB1234","user_name":"Trader One","exchanges":["NSE","NFO"],"meta":{"demat_consent":"consent"}}}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeKiteAPI) client(t *testing.T) *kite.Client {
	c, err := kite.NewClient(kite.Config{APIKey: "key", APISecret: "secret", APIRoot: f.srv.URL,
		LoginRoot: "https://kite.example/connect/login", HTTPClient: f.srv.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// pgCore is one "process": a Core over the shared pool with a fresh Kite client.
type pgCore struct {
	core    *Core
	kite    *kite.Client
	handler http.Handler
	full    string
	logins  int
}

func newPGCore(t *testing.T, pool *db.Pool, api *fakeKiteAPI, clk *testClock) *pgCore {
	st := store.New(pool, clk.now)
	sessions := auth.NewSessions(st, clk.now)
	sessions.SetBackground(func(f func()) { f() })
	p := &pgCore{kite: api.client(t), full: sessions.Mint(auth.RoleFull)}
	c, err := New(Deps{
		Kite: p.kite, Sessions: sessions, Pool: pool, RfStore: st, Now: clk.now,
		OnKiteLogin: func() { p.logins++ }, Logf: t.Logf,
	})
	if err != nil {
		t.Fatal(err)
	}
	p.core = c
	p.handler = server.New(server.Options{FrontendOrigin: "http://front.example", Now: clk.now}, c.Mount)
	t.Cleanup(c.Dispose)
	return p
}

func (p *pgCore) do(t *testing.T, method, target, body string, auth bool) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if auth {
		r.Header.Set("x-admin-token", p.full)
	}
	w := httptest.NewRecorder()
	p.handler.ServeHTTP(w, r)
	p.core.queue.wait()
	return w
}

func loadRow(t *testing.T, pool *db.Pool) *KiteSessionRecord {
	t.Helper()
	rec, err := (&PGKiteSessions{Pool: pool}).LoadKiteSession(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return rec
}

func TestKiteLoginPersistsAndRestoresOnTheSameISTDay(t *testing.T) {
	pool := dbtest.New(t)
	api := newFakeKiteAPI(t)
	clk := &testClock{t: istTime(2026, 10, 27, 10, 0)}

	first := newPGCore(t, pool, api, clk)
	w := first.do(t, "POST", "/api/session", `{"request_token":"good"}`, true)
	if w.Code != 200 || w.Body.String() != `{"authenticated":true,"user_id":"AB1234","user_name":"Trader One"}` {
		t.Fatalf("session: %d %s", w.Code, w.Body)
	}
	if first.logins != 1 || first.kite.AccessToken() != "live-token" {
		t.Fatalf("logins=%d token=%q", first.logins, first.kite.AccessToken())
	}
	rec := loadRow(t, pool)
	if rec == nil || rec.AccessToken != "live-token" || rec.UserID != "AB1234" || rec.UserName != "Trader One" || rec.LoginDate != "2026-10-27" {
		t.Fatalf("persisted %+v", rec)
	}
	if w := first.do(t, "GET", "/api/profile", "", false); w.Code != 200 ||
		w.Body.String() != `{"user_id":"AB1234","user_name":"Trader One","exchanges":["NSE","NFO"],"meta":{"demat_consent":"consent"}}` {
		t.Fatalf("profile: %d %s", w.Code, w.Body)
	}

	// A duplicate (already consumed) request token answers Kite's 403 but must not drop
	// the session that is still valid, in memory or in the table.
	if w := first.do(t, "POST", "/api/session", `{"request_token":"dup"}`, true); w.Code != 403 ||
		w.Body.String() != `{"error":"Token is invalid or has expired."}` {
		t.Fatalf("duplicate: %d %s", w.Code, w.Body)
	}
	if !first.kite.HasSession() || loadRow(t, pool) == nil {
		t.Fatal("a failed exchange cleared the session")
	}

	// Restart later the same IST day: the token is restored without a login.
	clk.set(istTime(2026, 10, 27, 23, 59))
	second := newPGCore(t, pool, api, clk)
	second.core.RestoreKiteSession(context.Background())
	if second.kite.AccessToken() != "live-token" {
		t.Fatalf("not restored: %q", second.kite.AccessToken())
	}
	if w := second.do(t, "GET", "/api/kite/access-token", "", true); w.Code != 200 ||
		w.Body.String() != `{"api_key":"key","access_token":"live-token","login_date":"2026-10-27"}` {
		t.Fatalf("access-token: %d %s", w.Code, w.Body)
	}
	if w := second.do(t, "GET", "/", "", false); w.Body.String() != `{"status":"ok","authenticated":true,"hint":"Visit /api/login to authenticate with Zerodha."}` {
		t.Fatalf("health: %s", w.Body)
	}

	// Restart at 00:00 IST the next day: the token is stale, discarded and deleted.
	clk.set(istTime(2026, 10, 28, 0, 0))
	third := newPGCore(t, pool, api, clk)
	third.core.RestoreKiteSession(context.Background())
	if third.kite.HasSession() {
		t.Fatal("a token from the previous IST day was restored")
	}
	if rec := loadRow(t, pool); rec != nil {
		t.Fatalf("stale row kept: %+v", rec)
	}
	third.core.RestoreKiteSession(context.Background()) // nothing persisted: still no session
	if third.kite.HasSession() {
		t.Fatal("restored from nothing")
	}
}

func TestLogoutAndKiteAuthFailureClearThePersistedSession(t *testing.T) {
	pool := dbtest.New(t)
	api := newFakeKiteAPI(t)
	clk := &testClock{t: istTime(2026, 10, 27, 11, 0)}
	p := newPGCore(t, pool, api, clk)

	if w := p.do(t, "POST", "/api/session", `{"request_token":"good"}`, true); w.Code != 200 {
		t.Fatalf("login: %d %s", w.Code, w.Body)
	}
	if w := p.do(t, "POST", "/api/logout", "", true); w.Code != 200 || w.Body.String() != `{"authenticated":false}` {
		t.Fatalf("logout: %d %s", w.Code, w.Body)
	}
	if p.kite.HasSession() || loadRow(t, pool) != nil {
		t.Fatal("logout left a session behind")
	}

	// A Kite 403 seen by sendError (here: the profile route with a revoked token) drops
	// the session in memory and the persisted copy.
	if w := p.do(t, "POST", "/api/session", `{"request_token":"good"}`, true); w.Code != 200 {
		t.Fatalf("login: %d %s", w.Code, w.Body)
	}
	p.kite.SetAccessToken("revoked")
	w := p.do(t, "GET", "/api/profile", "", false)
	if w.Code != 403 || w.Body.String() != "{\"error\":\"Incorrect `api_key` or `access_token`.\"}" {
		t.Fatalf("profile: %d %s", w.Code, w.Body)
	}
	if p.kite.HasSession() || loadRow(t, pool) != nil {
		t.Fatal("a Kite 403 must clear the session")
	}
	// Without a session the client refuses locally with 401, which clears again (no-op).
	if w := p.do(t, "GET", "/api/profile", "", false); w.Code != 401 ||
		w.Body.String() != `{"error":"Not authenticated. Complete the Zerodha login flow first (/login)."}` {
		t.Fatalf("profile without session: %d %s", w.Code, w.Body)
	}
}

func TestRiskFreeRatePersistsAcrossARestart(t *testing.T) {
	pool := dbtest.New(t)
	api := newFakeKiteAPI(t)
	clk := &testClock{t: istTime(2026, 10, 27, 11, 0)}
	p := newPGCore(t, pool, api, clk)
	for _, body := range []string{`{"rf":6.5}`, `{"rf":"7.25"}`, `{"rf":6.75}`} {
		if w := p.do(t, "POST", "/api/rf", body, true); w.Code != 200 {
			t.Fatalf("POST %s: %d %s", body, w.Code, w.Body)
		}
	}
	if v, ok, err := store.New(pool, nil).LoadRfRate(context.Background()); err != nil || !ok || v != 6.75 {
		t.Fatalf("stored rf = %v %v %v (the last write must win)", v, ok, err)
	}
	next := newPGCore(t, pool, api, clk)
	if w := next.do(t, "GET", "/api/rf/current", "", false); w.Body.String() != `{"rf":null}` {
		t.Fatalf("before restore: %s", w.Body)
	}
	next.core.RestoreRfRate(context.Background())
	if w := next.do(t, "GET", "/api/rf/current", "", false); w.Body.String() != `{"rf":6.75}` {
		t.Fatalf("after restore: %s", w.Body)
	}
	if rf := next.core.RfPct(); rf == nil || *rf != 6.75 {
		t.Fatalf("RfPct = %v", rf)
	}
}

// TestHeadersOnTheWire runs a real HTTP server: whitespace around a header value is not
// part of it, and a repeated passcode header arrives joined (Node's req.headers) and so
// fails.
func TestHeadersOnTheWire(t *testing.T) {
	sessions := auth.NewSessions(nil, nil)
	k := &stubKite{token: ptr("tok")}
	c, err := New(Deps{Kite: k, Sessions: sessions, TokenRouteSecret: "route-pass"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Dispose)
	srv := httptest.NewServer(server.New(server.Options{FrontendOrigin: "http://f"}, c.Mount))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	raw := func(headers string) (int, string) {
		conn, err := net.Dial("tcp", u.Host)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		fmt.Fprintf(conn, "GET /api/kite/token HTTP/1.1\r\nHost: x\r\nConnection: close\r\n%s\r\n", headers)
		res, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	if code, body := raw("x-token-passcode:   route-pass  \r\n"); code != 200 || !strings.Contains(body, `"access_token":"tok"`) {
		t.Errorf("padded header: %d %s", code, body)
	}
	if code, body := raw("x-token-passcode: route-pass\r\nx-token-passcode: route-pass\r\n"); code != 403 {
		t.Errorf("repeated header: %d %s", code, body)
	}
	var v map[string]any
	_, body := raw("x-token-passcode: route-pass\r\n")
	if err := json.Unmarshal([]byte(body), &v); err != nil || v["login_date"] == nil {
		t.Errorf("body %s", body)
	}
}
