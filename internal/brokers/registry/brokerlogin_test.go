package registry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokerlogin"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/dbtest"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/server"
)

const tokenTestSeed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

type tokenTestReply struct {
	status, retry int
	code, token   string
	expiresIn     int64
}

type tokenTestService struct {
	server *httptest.Server
	reply  atomic.Pointer[tokenTestReply]
	calls  atomic.Int64
	mu     sync.Mutex
	codes  []string
}

func newTokenRig(t *testing.T, store Store, specs map[string][]httpSpec) (*unitRig, *tokenTestService) {
	t.Helper()
	return newTokenRigWithEnv(t, store, specs, nil)
}

func newTokenRigWithEnv(t *testing.T, store Store, specs map[string][]httpSpec, extra map[string]string) (*unitRig, *tokenTestService) {
	t.Helper()
	u := newUnitRigWithEnv(t, store, specs, extra)
	u.env.unset("DHAN_API_KEY")
	u.env.unset("DHAN_API_SECRET")
	service := &tokenTestService{}
	service.reply.Store(&tokenTestReply{status: 200, token: "synthetic-served-token", expiresIn: 86400})
	service.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		service.calls.Add(1)
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if r.Method != "POST" || r.URL.Path != "/api/v1/token" || body["client_id"] != "1100001" || len(body) != 2 {
			t.Errorf("invalid token API request shape")
		}
		code, _ := brokerlogin.CodeAt(tokenTestSeed, u.clock.Now())
		if body["totp"] != code {
			t.Errorf("token API code did not use the current step")
		}
		service.mu.Lock()
		service.codes = append(service.codes, body["totp"])
		service.mu.Unlock()
		reply := service.reply.Load()
		if reply.retry > 0 {
			w.Header().Set("Retry-After", fmt.Sprint(reply.retry))
		}
		w.WriteHeader(reply.status)
		if reply.status == 200 {
			_ = json.NewEncoder(w).Encode(map[string]any{"client_id": "1100001", "access_token": reply.token, "expires_in": reply.expiresIn})
		} else {
			_ = json.NewEncoder(w).Encode(map[string]string{"error": reply.code})
		}
	}))
	t.Cleanup(service.server.Close)
	u.env.set("BROKER_LOGIN_URL", service.server.URL)
	u.env.set("BROKER_LOGIN_CF_CLIENT_ID", "synthetic-cf-id")
	u.env.set("BROKER_LOGIN_CF_CLIENT_SECRET", "synthetic-cf-secret")
	u.env.set("DHAN_TOKEN_API_SEED", tokenTestSeed)
	u.reg.brokerLogin = newBrokerLoginController(u.reg.get, service.server.Client())
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := u.reg.StopDhanTokenService(ctx); err != nil {
			t.Error(err)
		}
	})
	return u, service
}

func TestFetchedTokenRestoresAcrossFreshRegistryAndPool(t *testing.T) {
	for _, tc := range []struct {
		name, fallback, savedBroker string
		initial, restored           brokers.ID
		expired                     bool
	}{
		{name: "fresh Dhan", initial: brokers.Dhan, restored: brokers.Dhan},
		{name: "saved Dhan", savedBroker: "dhan", initial: brokers.Dhan, restored: brokers.Dhan},
		{name: "saved Zerodha", savedBroker: "zerodha", initial: brokers.Dhan, restored: brokers.Zerodha},
		{name: "saved Dhan overrides Zerodha fallback", fallback: "zerodha", savedBroker: "dhan", initial: brokers.Zerodha, restored: brokers.Dhan},
		{name: "expired token", initial: brokers.Dhan, restored: brokers.Dhan, expired: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			pool := dbtest.New(t)
			store := &PGStore{Pool: pool}
			u, service := newTokenRigWithEnv(t, store, nil, map[string]string{"DEFAULT_BROKER": tc.fallback})
			u.clock.ms.Store(time.Date(2026, 11, 3, 8, 30, 0, 0, tokenIST).UnixMilli())
			store.Now = u.clock.Now
			if u.reg.ActiveBroker() != tc.initial || u.reg.Generation() != 1 {
				t.Fatal("fresh registry did not use the expected initial broker/generation")
			}
			if tc.savedBroker != "" {
				if _, err := pool.Exec(ctx, `insert into active_broker (id, broker, generation) values ('current', $1, 7)`, tc.savedBroker); err != nil {
					t.Fatal(err)
				}
			}
			u.reg.Restore(ctx)
			u.reg.brokerPass(ctx)
			u.settle()
			saved, err := store.LoadDhanSession(ctx)
			if err != nil || saved == nil || saved.Source != "BROKER_LOGIN" || service.calls.Load() != 1 || u.reg.ActiveBroker() != tc.restored {
				t.Fatal("automatic fetch did not save the token independently of broker selection")
			}

			// Stop the old runtime and close its database connections. A new registry
			// and new pool must restore entirely from PostgreSQL, not shared memory.
			u.reg.StopFeeds()
			u.settle()
			if err := u.reg.StopDhanTokenService(ctx); err != nil {
				t.Fatal(err)
			}
			connectionConfig := pool.Config().Copy()
			pool.Close()
			connections, err := pgxpool.NewWithConfig(ctx, connectionConfig)
			if err != nil {
				t.Fatal(err)
			}
			reopened := &db.Pool{Pool: connections}
			t.Cleanup(reopened.Close)
			freshStore := &PGStore{Pool: reopened}
			fresh, freshService := newTokenRigWithEnv(t, freshStore, nil, map[string]string{"DEFAULT_BROKER": tc.fallback})
			restartAt := u.clock.Now().Add(time.Minute)
			if tc.expired {
				restartAt = u.clock.Now().Add(25 * time.Hour)
			}
			fresh.clock.ms.Store(restartAt.UnixMilli())
			freshStore.Now = fresh.clock.Now
			fresh.reg.Restore(ctx)
			if fresh.reg.ActiveBroker() != tc.restored || (tc.savedBroker != "" && fresh.reg.Generation() != 7) {
				t.Fatal("saved selection/generation did not restore ahead of the fallback")
			}
			if tc.expired {
				if fresh.reg.SessionFor(brokers.Dhan).Authenticated {
					t.Fatal("expired token restored as usable")
				}
				if record, err := freshStore.LoadDhanSession(ctx); err != nil || record != nil {
					t.Fatal("expired token was not removed from PostgreSQL")
				}
				fresh.reg.brokerPass(ctx)
				fresh.settle()
				if freshService.calls.Load() != 1 || !fresh.reg.SessionFor(brokers.Dhan).Authenticated {
					t.Fatal("restart with an expired token did not recover within the automatic window")
				}
				return
			}
			token, expiry, meta := fresh.reg.dhanSession()
			fetchedAt := fresh.reg.BrokerLoginStatus().LastFetchedAt
			if token == nil || *token != saved.AccessToken || expiry == nil || saved.ExpiryTime == nil || *expiry != *saved.ExpiryTime ||
				meta == nil || meta.source != saved.Source || meta.clientID != saved.DhanClientID || meta.loginDay != saved.LoginDate ||
				fetchedAt == nil || *fetchedAt != saved.LoginAt.UnixMilli() || !fresh.reg.SessionFor(brokers.Dhan).Authenticated {
				t.Fatal("token/account/source/expiry/login metadata did not survive a fresh runtime")
			}
			fresh.reg.StartActiveRuntime(ctx)
			fresh.reg.brokerPass(ctx)
			fresh.settle()
			if freshService.calls.Load() != 0 {
				t.Fatal("restart unnecessarily fetched another fresh token")
			}
		})
	}
}

func TestFetchedTokenWithoutPostgresIsReportedMemoryOnlyAndDoesNotRestore(t *testing.T) {
	ctx := context.Background()
	u, _ := newTokenRigWithEnv(t, nil, nil, map[string]string{"DEFAULT_BROKER": ""})
	if _, err := u.reg.FetchBrokerToken(ctx); err != nil {
		t.Fatal(err)
	}
	u.settle()
	handler := server.New(server.Options{}, func(router chi.Router) {
		Mount(router, RouteDeps{Registry: u.reg, Sessions: newSessions(t, u.clock)})
	})
	req := httptest.NewRequest("GET", "/api/dhan/status", nil)
	req.Header.Set("x-admin-token", "full-token")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	var status struct {
		Authenticated bool  `json:"authenticated"`
		Persisted     *bool `json:"persisted"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &status) != nil || !status.Authenticated || status.Persisted == nil || *status.Persisted {
		t.Fatal("memory-only token was not explicitly reported as unpersisted")
	}
	fresh, _ := newTokenRigWithEnv(t, nil, nil, map[string]string{"DEFAULT_BROKER": ""})
	fresh.reg.Restore(ctx)
	if fresh.reg.ActiveBroker() != brokers.Dhan || fresh.reg.SessionFor(brokers.Dhan).Authenticated {
		t.Fatal("a fresh memory-only runtime invented a saved Dhan token")
	}
}

func TestAutomaticTokenWindowSaveAndRestore(t *testing.T) {
	pool := dbtest.New(t)
	store := &PGStore{Pool: pool}
	u, service := newTokenRig(t, store, nil)
	before := time.Date(2026, 11, 3, 8, 29, 0, 0, tokenIST)
	u.clock.ms.Store(before.UnixMilli())
	u.reg.brokerPass(context.Background())
	if service.calls.Load() != 0 {
		t.Fatal("automatic startup bypassed AUTO_LOGIN_TIME")
	}
	u.clock.advance(time.Minute.Milliseconds())
	u.reg.brokerPass(context.Background())
	u.settle()
	if service.calls.Load() != 1 || !u.reg.SessionFor(brokers.Dhan).Authenticated || len(u.reg.SwitchBlockers(brokers.Dhan)) != 0 {
		t.Fatal("token-only account did not connect automatically")
	}
	record, err := store.LoadDhanSession(context.Background())
	if err != nil || record == nil || record.AccessToken != "synthetic-served-token" || record.Source != "BROKER_LOGIN" || *record.ExpiryTime != u.clock.Now().Add(24*time.Hour).UnixMilli() {
		t.Fatal("served token/account/source/expiry did not survive PostgreSQL persistence")
	}
	u.reg.setDhanSession(nil, nil, nil)
	u.reg.Restore(context.Background())
	if !u.reg.SessionFor(brokers.Dhan).Authenticated || u.reg.BrokerLoginStatus().LastFetchedAt == nil {
		t.Fatal("saved service session or fetched time did not restore")
	}
	u.clock.advance(time.Minute.Milliseconds())
	if u.reg.brokerDue(u.clock.Now()) {
		t.Fatal("fresh token should be reused")
	}
	u.reg.LogoutDhan(context.Background())
	u.clock.advance(10 * time.Minute.Milliseconds())
	if u.reg.brokerDue(u.clock.Now()) || !u.reg.BrokerLoginStatus().Paused {
		t.Fatal("clear-token did not pause automatic fetching for the day")
	}
	if _, err := u.reg.FetchBrokerToken(context.Background()); err != nil || u.reg.BrokerLoginStatus().Paused {
		t.Fatalf("explicit fetch did not lift the pause: %v", err)
	}
}

func TestPermanentRefusalAndRetryAfter(t *testing.T) {
	u, service := newTokenRig(t, nil, nil)
	u.clock.ms.Store(time.Date(2026, 11, 3, 10, 0, 0, 0, tokenIST).UnixMilli())
	service.reply.Store(&tokenTestReply{status: 401, code: "unauthorized"})
	u.reg.brokerPass(context.Background())
	u.clock.advance(time.Hour.Milliseconds())
	u.reg.brokerPass(context.Background())
	if service.calls.Load() != 1 || !u.reg.BrokerLoginStatus().Stopped {
		t.Fatal("permanent refusal was retried automatically")
	}
	service.reply.Store(&tokenTestReply{status: 503, code: "no_token_yet", retry: 300})
	if _, err := u.reg.FetchBrokerToken(context.Background()); err == nil {
		t.Fatal("no-token response was treated as success")
	}
	u.clock.advance(4 * time.Minute.Milliseconds())
	if u.reg.brokerDue(u.clock.Now()) {
		t.Fatal("Retry-After was ignored")
	}
	u.clock.advance(time.Minute.Milliseconds())
	if !u.reg.brokerDue(u.clock.Now()) {
		t.Fatal("transient failure did not become retryable")
	}
	u.clock.advance(30 * time.Minute.Milliseconds())
	u.reg.brokerPass(context.Background())
	if !strings.Contains(u.reg.BrokerLoginStatus().LastError, "30 minutes") {
		t.Fatal("prolonged no-token failure did not surface operator recovery")
	}
	service.reply.Store(&tokenTestReply{status: 429, code: "locked", retry: 600})
	u.clock.advance(5 * time.Minute.Milliseconds())
	u.reg.brokerPass(context.Background())
	calls := service.calls.Load()
	if _, err := u.reg.FetchBrokerToken(context.Background()); err == nil || service.calls.Load() != calls {
		t.Fatal("operator fetch bypassed an active lockout")
	}
}

func TestUsedCodeRetriesOnceOnFreshStep(t *testing.T) {
	u, service := newTokenRig(t, nil, nil)
	u.clock.ms.Store(time.Date(2026, 11, 3, 8, 31, 2, 0, tokenIST).UnixMilli())
	service.reply.Store(&tokenTestReply{status: 409, code: "code_already_used", retry: 1})
	u.reg.deps.BrokerLoginSleep = func(ctx context.Context, wait time.Duration) error {
		if wait < 28*time.Second || wait > 31*time.Second {
			t.Errorf("retry did not wait for the next code step: %s", wait)
		}
		u.clock.advance(wait.Milliseconds())
		service.reply.Store(&tokenTestReply{status: 200, token: "synthetic-fresh-step-token", expiresIn: 86400})
		return ctx.Err()
	}
	if _, err := u.reg.FetchBrokerToken(context.Background()); err != nil {
		t.Fatal(err)
	}
	service.mu.Lock()
	defer service.mu.Unlock()
	if len(service.codes) != 2 || service.codes[0] == service.codes[1] {
		t.Fatal("retry reused the single-use code or made unbounded requests")
	}
}

func TestPastedFallbackValidationPersistenceAndExpiry(t *testing.T) {
	pool := dbtest.New(t)
	store := &PGStore{Pool: pool}
	profile := json.RawMessage(`{"dhanClientId":"1100001","tokenValidity":1800000000000}`)
	u, service := newTokenRig(t, store, map[string][]httpSpec{"api GET /profile": {
		{Status: 200, Body: profile}, {Status: 200, Body: json.RawMessage(`{"dhanClientId":"another-account"}`)},
		{Status: 401, Body: json.RawMessage(`{"errorMessage":"synthetic-rejected-token"}`)},
	}})
	u.clock.ms.Store(time.Date(2026, 11, 3, 10, 0, 0, 0, tokenIST).UnixMilli())
	if _, err := u.reg.SetManualDhanToken(context.Background(), "synthetic-pasted-token"); err != nil {
		t.Fatal(err)
	}
	u.settle()
	if u.reg.brokerDue(u.clock.Now().Add(time.Hour)) || service.calls.Load() != 0 {
		t.Fatal("automatic fetch would overwrite a valid pasted fallback")
	}
	for _, token := range []string{"synthetic-wrong-account-token", "synthetic-invalid-token"} {
		if _, err := u.reg.SetManualDhanToken(context.Background(), token); err == nil {
			t.Fatal("unvalidated token was accepted")
		}
		if saved, _ := store.LoadDhanSession(context.Background()); saved == nil || saved.AccessToken != "synthetic-pasted-token" {
			t.Fatal("failed paste overwrote the saved working token")
		}
	}
	u.reg.setDhanSession(nil, nil, nil)
	u.reg.Restore(context.Background())
	_, expiry, meta := u.reg.dhanSession()
	if meta == nil || meta.source != "MANUAL" || u.reg.brokerDue(u.clock.Now().Add(time.Hour)) {
		t.Fatal("manual source was not retained across restore")
	}
	u.clock.ms.Store(*expiry - 4*time.Minute.Milliseconds())
	if !u.reg.brokerDue(u.clock.Now()) {
		t.Fatal("fallback nearing expiry did not permit service recovery")
	}
	u.reg.setDhanSession(nil, nil, nil)
	u.env.set("DHAN_CLIENT_ID", "another-account")
	u.reg.Restore(context.Background())
	if u.reg.SessionFor(brokers.Dhan).Authenticated {
		t.Fatal("saved token was restored into the wrong configured account")
	}
}

func TestTokenReplacementRecyclesBothLanesAndIgnoresOldCallbacks(t *testing.T) {
	u, service := newTokenRig(t, nil, nil)
	u.activateDhan("synthetic-old-token")
	u.reg.StartActiveFeed()
	u.reg.AcquireBrowserTokens([]int64{2000050000})
	u.reg.SetSyntheticTokens([]int64{2000060000})
	u.settle()
	u.rec.take()
	if _, err := u.reg.FetchBrokerToken(context.Background()); err != nil {
		t.Fatal(err)
	}
	u.settle()
	got := strings.Join(u.rec.take(), "\n")
	if !strings.Contains(got, "feed1:stop") || !strings.Contains(got, "feed2:stop") || !strings.Contains(got, "feed3:subscribe [2000050000]") || !strings.Contains(got, "feed4:subscribe [2000060000]") {
		t.Fatalf("new token did not recycle and replay both lanes: %s", got)
	}
	u.feeds.get(0).opts.OnSessionLost("superseded socket")
	u.settle()
	if !u.reg.SessionFor(brokers.Dhan).Authenticated {
		t.Fatal("late old-socket callback cleared the newly installed token")
	}
	if _, err := u.reg.FetchBrokerToken(context.Background()); err != nil {
		t.Fatal(err)
	}
	u.settle()
	if strings.Contains(strings.Join(u.rec.take(), "\n"), ":stop") || service.calls.Load() != 2 {
		t.Fatal("fetching the same token unnecessarily recycled the feeds")
	}
}

type tokenFailingStore struct{ Store }

func (tokenFailingStore) SaveDhanSession(context.Context, DhanSessionRecord) error {
	return errors.New("synthetic-private-database-error")
}

func TestTokenSaveFailureDoesNotInstallAndRejectedServiceTokenDoesNotReconnect(t *testing.T) {
	u, service := newTokenRig(t, tokenFailingStore{Store: memoryStore{}}, nil)
	u.activateDhan("synthetic-working-token")
	if _, err := u.reg.FetchBrokerToken(context.Background()); err == nil || strings.Contains(err.Error(), "synthetic-private-database-error") {
		t.Fatal("save failure was hidden or exposed private database details")
	}
	if u.reg.usableDhanToken() != "synthetic-working-token" {
		t.Fatal("token activated before successful persistence")
	}
	u.reg.store = memoryStore{}
	u.reg.brokerLogin.rejectedToken = "synthetic-served-token"
	if _, err := u.reg.FetchBrokerToken(context.Background()); err == nil || !strings.Contains(err.Error(), "Dhan rejected") {
		t.Fatal("known rejected service token was installed again")
	}
	if u.reg.usableDhanToken() != "synthetic-working-token" || service.calls.Load() != 2 {
		t.Fatal("refused token changed the working session")
	}
}

func TestTokenEndpointsAuthorizationAndPasteWithoutService(t *testing.T) {
	u := newUnitRig(t, nil, map[string][]httpSpec{"api GET /profile": {{Status: 200, Body: json.RawMessage(`{"dhanClientId":"1100001","tokenValidity":1800000000000}`)}}})
	u.env.unset("DHAN_API_KEY")
	u.env.unset("DHAN_API_SECRET")
	sessions := newSessions(t, u.clock)
	handler := server.New(server.Options{}, func(router chi.Router) { Mount(router, RouteDeps{Registry: u.reg, Sessions: sessions}) })
	request := func(endpoint, token, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", endpoint, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("x-admin-token", token)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	for _, role := range []string{"", "bogus-token", "trade-token"} {
		for _, endpoint := range []string{"/api/dhan/login/broker", "/api/dhan/token"} {
			if w := request(endpoint, role, `{"accessToken":"synthetic-paste"}`); w.Code != 403 {
				t.Fatalf("token endpoint allowed a non-full role: %d", w.Code)
			}
		}
	}
	if w := request("/api/dhan/login/broker", "full-token", `{}`); w.Code != 409 {
		t.Fatal("missing service config did not report the paste fallback")
	}
	w := request("/api/dhan/token", "full-token", `{"accessToken":"synthetic-paste"}`)
	if w.Code != 200 || strings.Contains(w.Body.String(), "synthetic-paste") || w.Header().Get("Cache-Control") != "no-store" || !u.reg.SessionFor(brokers.Dhan).Authenticated {
		t.Fatal("paste-only full-admin endpoint failed or exposed the token")
	}
}

func TestTokenWorkerShutdownCancelsPendingFetch(t *testing.T) {
	u, service := newTokenRig(t, nil, nil)
	u.clock.ms.Store(time.Date(2026, 11, 3, 10, 0, 0, 0, tokenIST).UnixMilli())
	started := make(chan struct{})
	release := make(chan struct{})
	defer close(release)
	service.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Drain the POST body so HTTP/1 can observe the client's cancelled connection.
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		select {
		case <-r.Context().Done():
		case <-release:
		}
	})
	u.reg.StartDhanTokenService()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("token worker did not start")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := u.reg.StopDhanTokenService(ctx); err != nil || u.reg.SessionFor(brokers.Dhan).Authenticated {
		t.Fatal("shutdown did not cancel the fetch before token installation")
	}
	if _, err := u.reg.FetchBrokerToken(context.Background()); err == nil {
		t.Fatal("token fetch restarted after shutdown")
	}
}

func TestPastedJWTExpiryIsEnforcedBeforeInstallation(t *testing.T) {
	u := newUnitRig(t, nil, map[string][]httpSpec{"api GET /profile": {{Status: 200, Body: json.RawMessage(`{"dhanClientId":"1100001"}`)}}})
	u.activateDhan("synthetic-working-token")
	// exp=1: the profile accepted the account, but the token's expiry is in the past.
	if _, err := u.reg.SetManualDhanToken(context.Background(), "e30.eyJleHAiOjF9.synthetic-signature"); err == nil {
		t.Fatal("expired JWT was installed")
	}
	if u.reg.usableDhanToken() != "synthetic-working-token" {
		t.Fatal("expired paste changed the working token")
	}
}
