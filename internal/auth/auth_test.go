package auth_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/auth"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
)

type memStore struct {
	mu      sync.Mutex
	rows    map[string]auth.StoredSession
	deleted []string
	failing bool
}

func newMemStore() *memStore { return &memStore{rows: map[string]auth.StoredSession{}} }
func (m *memStore) SaveAdminSession(_ context.Context, t string, r auth.Role, e int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.failing {
		return context.DeadlineExceeded
	}
	m.rows[t] = auth.StoredSession{Token: t, Role: r, ExpiryMs: e}
	return nil
}
func (m *memStore) DeleteAdminSession(_ context.Context, t string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.rows, t)
	m.deleted = append(m.deleted, t)
	return nil
}
func (m *memStore) LoadAdminSessions(_ context.Context, now int64) ([]auth.StoredSession, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []auth.StoredSession
	for _, r := range m.rows {
		if r.ExpiryMs > now {
			out = append(out, r)
		}
	}
	return out, nil
}

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func newSessions() (*auth.Sessions, *memStore, *clock) {
	st, clk := newMemStore(), &clock{t: time.Date(2026, 10, 27, 9, 0, 0, 0, time.UTC)}
	s := auth.NewSessions(st, clk.now)
	s.SetBackground(func(f func()) { f() })
	return s, st, clk
}

func TestGenerateTokenShape(t *testing.T) {
	re := regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	seen := map[string]bool{}
	for i := 0; i < 500; i++ {
		tok := auth.GenerateToken()
		if !re.MatchString(tok) || seen[tok] {
			t.Fatalf("bad or repeated token %q", tok)
		}
		seen[tok] = true
	}
}

func TestSessionLifecycle(t *testing.T) {
	s, st, clk := newSessions()
	tok := s.Mint(auth.RoleTrade)
	if s.Role(tok) != auth.RoleTrade || s.Role("") != auth.RoleNone || s.Role("nope") != auth.RoleNone {
		t.Fatal("role lookup")
	}
	if row := st.rows[tok]; row.Role != auth.RoleTrade || row.ExpiryMs != clk.t.UnixMilli()+86_400_000 {
		t.Fatalf("persisted row = %+v", row)
	}
	clk.t = clk.t.Add(24 * time.Hour) // exactly at expiry: still valid (strict >)
	if s.Role(tok) != auth.RoleTrade {
		t.Fatal("token is valid at the expiry instant")
	}
	clk.t = clk.t.Add(time.Millisecond)
	if s.Role(tok) != auth.RoleNone {
		t.Fatal("token expired 1 ms later")
	}
	if len(st.deleted) != 1 || st.deleted[0] != tok {
		t.Fatalf("expired token must be deleted from the store, got %v", st.deleted)
	}
	s.Role("never-seen")
	if len(st.deleted) != 1 {
		t.Fatal("unknown tokens must not hit the database")
	}
}

func TestPersistenceFailureNeverBlocksLogin(t *testing.T) {
	s, st, _ := newSessions()
	st.failing = true
	tok := s.Mint(auth.RoleFull)
	if s.Role(tok) != auth.RoleFull {
		t.Fatal("memory session must work even when persistence fails")
	}
}

func TestRestoreAfterRestart(t *testing.T) {
	s1, st, clk := newSessions()
	full, trade := s1.Mint(auth.RoleFull), s1.Mint(auth.RoleTrade)
	st.rows["expired"] = auth.StoredSession{Token: "expired", Role: auth.RoleFull, ExpiryMs: clk.t.UnixMilli() - 1}
	s2 := auth.NewSessions(st, clk.now)
	n, err := s2.Restore(context.Background())
	if err != nil || n != 2 {
		t.Fatalf("restored %d, err %v", n, err)
	}
	if s2.Role(full) != auth.RoleFull || s2.Role(trade) != auth.RoleTrade || s2.Role("expired") != auth.RoleNone {
		t.Fatal("restored roles")
	}
	if n, err := auth.NewSessions(nil, nil).Restore(context.Background()); n != 0 || err != nil {
		t.Fatal("no store means nothing to restore")
	}
}

func TestMiddlewareStatusCodes(t *testing.T) {
	s, _, _ := newSessions()
	full, trade := s.Mint(auth.RoleFull), s.Mint(auth.RoleTrade)
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	call := func(h http.Handler, token string) (int, string) {
		r := httptest.NewRequest("GET", "/", nil)
		if token != "" {
			r.Header.Set("x-admin-token", token)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code, w.Body.String()
	}
	admin, fullOnly := s.RequireAdmin(ok), s.RequireFull(ok)
	if c, b := call(admin, ""); c != 403 || b != `{"error":"Admin authentication required"}` {
		t.Errorf("admin, no token: %d %s", c, b)
	}
	if c, _ := call(admin, trade); c != 200 {
		t.Errorf("admin accepts trade role: %d", c)
	}
	if c, b := call(fullOnly, trade); c != 403 || b != `{"error":"Full admin access required."}` {
		t.Errorf("full-only rejects trade role: %d %s", c, b)
	}
	if c, _ := call(fullOnly, full); c != 200 {
		t.Errorf("full-only accepts full: %d", c)
	}
	// A repeated header is joined and therefore never matches.
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Add("x-admin-token", full)
	r.Header.Add("x-admin-token", full)
	w := httptest.NewRecorder()
	admin.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Errorf("repeated header should not authenticate, got %d", w.Code)
	}
}

func TestCheckPasscode(t *testing.T) {
	cases := []struct {
		configured, provided string
		supplied             bool
		want                 auth.PasscodeResult
	}{
		{"", "x", true, auth.PasscodeNotConfigured}, {"   ", "x", true, auth.PasscodeNotConfigured},
		{"s3cret", "", true, auth.PasscodeForbidden}, {"s3cret", "", false, auth.PasscodeForbidden},
		{"s3cret", "s3cret", true, auth.PasscodeOK}, {"  s3cret  ", "s3cret", true, auth.PasscodeOK}, // configured is trimmed
		{"s3cret", " s3cret", true, auth.PasscodeForbidden}, // supplied is not
		{"s3cret", "S3CRET", true, auth.PasscodeForbidden},
	}
	for _, c := range cases {
		if got := auth.CheckPasscode(c.configured, c.provided, c.supplied); got != c.want {
			t.Errorf("CheckPasscode(%q,%q,%v) = %v want %v", c.configured, c.provided, c.supplied, got, c.want)
		}
	}
}

func TestReadPasscode(t *testing.T) {
	read := func(target string, hdr ...string) (string, bool) {
		r := httptest.NewRequest("GET", target, nil)
		for i := 0; i+1 < len(hdr); i += 2 {
			r.Header.Add(hdr[i], hdr[i+1])
		}
		return auth.ReadPasscode(r, "x-token-passcode", "passcode")
	}
	if v, ok := read("/?passcode=q", "x-token-passcode", "h"); !ok || v != "h" {
		t.Errorf("header wins: %q %v", v, ok)
	}
	if v, ok := read("/?passcode=q", "x-token-passcode", ""); !ok || v != "" {
		t.Errorf("an empty header must not fall back to the query: %q %v", v, ok)
	}
	if v, ok := read("/?passcode=q", "x-token-passcode", "h", "x-token-passcode", "h"); !ok || v != "h, h" {
		t.Errorf("a repeated header arrives joined, as Node delivers it: %q %v", v, ok)
	}
	if v, ok := read("/?passcode=q"); !ok || v != "q" {
		t.Errorf("query: %q %v", v, ok)
	}
	if _, ok := read("/?passcode=a&passcode=b"); ok {
		t.Error("repeated query parameter counts as not supplied")
	}
	if _, ok := read("/"); ok {
		t.Error("nothing supplied")
	}
}

// --- routes ---

type fakeBrokers struct {
	active   brokers.ID
	result   auth.SwitchResult
	switched []brokers.ID
}

func (f *fakeBrokers) ActiveBroker() brokers.ID { return f.active }
func (f *fakeBrokers) SwitchBroker(_ context.Context, to brokers.ID, _ auth.Role) auth.SwitchResult {
	f.switched = append(f.switched, to)
	return f.result
}

func routes(t *testing.T) (http.Handler, *auth.Sessions, *fakeBrokers) {
	t.Helper()
	s, _, _ := newSessions()
	fb := &fakeBrokers{active: brokers.Zerodha}
	r := chi.NewRouter()
	r.Use(httpx.ParseBody)
	(&auth.Routes{Sessions: s, AdminSecret: "admin-s", AccessSecret: "access-s", Brokers: fb}).Mount(r)
	return r, s, fb
}

func post(h http.Handler, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestAdminVerify(t *testing.T) {
	h, s, fb := routes(t)

	w := post(h, "/api/admin/verify", `{"secret":"admin-s"}`)
	if w.Code != 200 {
		t.Fatalf("status %d %s", w.Code, w.Body)
	}
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if out["success"] != true || out["role"] != "full" || out["broker"] != "zerodha" || out["expiresIn"] != float64(86_400_000) {
		t.Fatalf("response = %v", out)
	}
	if _, has := out["broker_switch_refused"]; has {
		t.Error("refusal keys must be absent when no switch was requested")
	}
	if s.Role(out["token"].(string)) != auth.RoleFull {
		t.Error("minted token is not a valid full session")
	}
	// Key order is part of the contract the UI was built against.
	if !strings.HasPrefix(w.Body.String(), `{"success":true,"token":"`) || !strings.HasSuffix(w.Body.String(), `"expiresIn":86400000}`) {
		t.Errorf("key order: %s", w.Body)
	}

	for _, c := range []struct {
		body string
		code int
		msg  string
	}{
		{`{"secret":"wrong"}`, 401, "Invalid admin secret"},
		{`{"secret":123}`, 401, "Invalid admin secret"},
		{`{}`, 401, "Invalid admin secret"},
		{`{"secret":"admin-s","broker":"upstox"}`, 400, `broker must be "zerodha" or "dhan".`},
		{`{"secret":"admin-s","broker":5}`, 400, `broker must be "zerodha" or "dhan".`},
	} {
		w := post(h, "/api/admin/verify", c.body)
		var errBody struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &errBody)
		if w.Code != c.code || errBody.Error != c.msg {
			t.Errorf("%s: %d %s", c.body, w.Code, w.Body)
		}
	}
	if len(fb.switched) != 0 {
		t.Error("a rejected request must never switch the broker")
	}
	// Blank/null broker means "not requested".
	post(h, "/api/admin/verify", `{"secret":"admin-s","broker":""}`)
	post(h, "/api/admin/verify", `{"secret":"admin-s","broker":null}`)
	if len(fb.switched) != 0 {
		t.Error("blank broker must not switch")
	}
}

func TestAdminVerifySwitching(t *testing.T) {
	h, _, fb := routes(t)
	fb.result = auth.SwitchResult{OK: true, Broker: brokers.Dhan}
	var out map[string]any
	w := post(h, "/api/admin/verify", `{"secret":"admin-s","broker":" DHAN "}`)
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if out["broker"] != "dhan" || len(fb.switched) != 1 || fb.switched[0] != brokers.Dhan {
		t.Fatalf("switch: %v %v", out, fb.switched)
	}

	// A refused switch still logs in, on the previous broker, and says why.
	fb.result = auth.SwitchResult{OK: false, Blockers: []auth.Blocker{{Reason: "working_orders", Detail: "2 working"}}}
	w = post(h, "/api/admin/verify", `{"secret":"admin-s","broker":"dhan"}`)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"broker":"zerodha","broker_switch_refused":true,"broker_switch_blockers":[{"reason":"working_orders","detail":"2 working"}],"expiresIn":`) {
		t.Fatalf("refused switch: %d %s", w.Code, w.Body)
	}
}

func TestAdminVerifyNotConfigured(t *testing.T) {
	s, _, _ := newSessions()
	r := chi.NewRouter()
	r.Use(httpx.ParseBody)
	(&auth.Routes{Sessions: s, AdminSecret: "  ", AccessSecret: "", Brokers: &fakeBrokers{active: brokers.Dhan}}).Mount(r)
	if w := post(r, "/api/admin/verify", `{"secret":"x"}`); w.Code != 500 || !strings.Contains(w.Body.String(), "Admin secret not configured on server") {
		t.Errorf("admin: %d %s", w.Code, w.Body)
	}
	if w := post(r, "/api/access/verify", `{"secret":"x"}`); w.Code != 500 || !strings.Contains(w.Body.String(), "Access secret not configured on server") {
		t.Errorf("access: %d %s", w.Code, w.Body)
	}
}

func TestAccessVerify(t *testing.T) {
	h, s, fb := routes(t)
	fb.active = brokers.Dhan
	w := post(h, "/api/access/verify", `{"secret":"access-s"}`)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if w.Code != 200 || out["role"] != "trade" || out["broker"] != "dhan" || s.Role(out["token"].(string)) != auth.RoleTrade {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if w := post(h, "/api/access/verify", `{"secret":"nope"}`); w.Code != 401 || !strings.Contains(w.Body.String(), "Invalid access code") {
		t.Errorf("wrong code: %d %s", w.Code, w.Body)
	}
	// No JSON body at all: Node crashed with a 500 page; Go answers like a wrong code.
	r := httptest.NewRequest("POST", "/api/access/verify", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	if rec.Code != 401 {
		t.Errorf("missing body: %d", rec.Code)
	}
	if len(fb.switched) != 0 {
		t.Error("access verify must never switch the broker")
	}
}

func TestVerifyIsRateLimited(t *testing.T) {
	h, _, _ := routes(t)
	for i := 0; i < 10; i++ {
		if w := post(h, "/api/admin/verify", `{"secret":"bad"}`); w.Code != 401 {
			t.Fatalf("attempt %d: %d", i+1, w.Code)
		}
	}
	w := post(h, "/api/admin/verify", `{"secret":"admin-s"}`) // even the right secret is refused now
	if w.Code != 429 || w.Header().Get("Retry-After") == "" || !strings.Contains(w.Body.String(), "Too many attempts. Try again in a few minutes.") {
		t.Fatalf("11th attempt: %d %s", w.Code, w.Body)
	}
	// The access route has its own counter.
	if w := post(h, "/api/access/verify", `{"secret":"access-s"}`); w.Code != 200 {
		t.Errorf("access limiter is separate: %d", w.Code)
	}
}

func TestStatus(t *testing.T) {
	h, s, fb := routes(t)
	fb.active = brokers.Dhan
	get := func(token string) string {
		r := httptest.NewRequest("GET", "/api/admin/status", nil)
		if token != "" {
			r.Header.Set("x-admin-token", token)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Body.String()
	}
	if got := get(""); got != `{"authenticated":false,"role":null,"broker":"dhan"}` {
		t.Errorf("anonymous: %s", got)
	}
	if got := get(s.Mint(auth.RoleTrade)); got != `{"authenticated":true,"role":"trade","broker":"dhan"}` {
		t.Errorf("trade: %s", got)
	}
}
