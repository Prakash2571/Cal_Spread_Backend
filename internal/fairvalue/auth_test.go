package fairvalue

// Port of tests/fairValue/auth.test.mjs: router-wide full-admin authorisation covers
// valuation, settings, history, export and SSE.

import (
	"io"
	"net/http"
	"regexp"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/model"
)

// noHeaderGet is a GET without the x-admin-token header.
func noHeaderGet(url string) (*http.Response, error) { return http.Get(url) }

// fakeService is the auth test's engine stub.
type fakeService struct{ privateCalls atomic.Int64 }

func (s *fakeService) Status() StatusView {
	s.privateCalls.Add(1)
	return StatusView{Enabled: true}
}
func (s *fakeService) GetConfig() ConfigView                  { return ConfigView{} }
func (s *fakeService) UpdateConfig(any) (UpdateResult, error) { return UpdateResult{}, nil }
func (s *fakeService) Underlyings() ([]Underlying, error)     { return []Underlying{}, nil }
func (s *fakeService) GetSnapshot(string) SnapshotView {
	return SnapshotView{Snapshot: &model.SurfaceSnapshot{ID: "private-snapshot"}}
}
func (s *fakeService) Refresh(string) (RefreshResult, error) { return RefreshResult{}, nil }
func (s *fakeService) Pause(bool)                            {}
func (s *fakeService) Calculate(any) (*model.CalculatorResult, error) {
	return &model.CalculatorResult{}, nil
}
func (s *fakeService) Independent(any) (*model.IndependentEstimate, error) {
	return &model.IndependentEstimate{}, nil
}
func (s *fakeService) History(string, float64) ([]model.HistorySummary, error) { return nil, nil }
func (s *fakeService) HistoricalSnapshot(string, string) (any, error) {
	return map[string]string{"id": "secret"}, nil
}
func (s *fakeService) Subscribe(func()) (func(), error) { return func() {}, nil }

func TestRouterWideFullAdminAuthorization(t *testing.T) {
	var role atomic.Value
	role.Store("full")
	isFull := func(token string) bool { return token == "full-test" && role.Load() == "full" }
	svc := &fakeService{}
	origin := newTestServer(t, svc, isFull, RouteDeps{StreamInterval: 10 * time.Millisecond})
	noStore := regexp.MustCompile(`no-store`)
	for _, route := range [][2]string{{"GET", "/status"}, {"GET", "/config"}, {"PATCH", "/config"}, {"GET", "/underlyings"},
		{"GET", "/snapshot/TEST"}, {"POST", "/refresh"}, {"POST", "/pause"}, {"POST", "/calculate"}, {"POST", "/independent"},
		{"GET", "/history/TEST"}, {"GET", "/history/TEST/id"}, {"GET", "/export/TEST"}, {"GET", "/stream"}} {
		for _, token := range []string{"", "trade-test", "expired"} {
			res := request(t, route[0], origin+route[1], token, "")
			res.Body.Close()
			if res.StatusCode != 403 {
				t.Errorf("%s %s %q: %d", route[0], route[1], token, res.StatusCode)
			}
			if !noStore.MatchString(res.Header.Get("Cache-Control")) {
				t.Errorf("%s %s: Cache-Control %q", route[0], route[1], res.Header.Get("Cache-Control"))
			}
		}
	}
	if n := svc.privateCalls.Load(); n != 0 {
		t.Fatalf("engine reached %d times without authorisation", n)
	}
	if res := request(t, "GET", origin+"/status", "full-test", ""); res.StatusCode != 200 {
		t.Fatalf("authorised status %d", res.StatusCode)
	}
	// request() always sends the header (empty here), and Node reads the header before
	// the query, so the query-token stream needs a request without the header.
	res, err := noHeaderGet(origin + "/stream?x-admin-token=full-test")
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		t.Fatalf("stream %d", res.StatusCode)
	}
	buf := make([]byte, 4096)
	n, err := res.Body.Read(buf)
	if n == 0 || err != nil {
		t.Fatalf("first frame: %d %v", n, err)
	}
	role.Store("")
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, res.Body) // returns when the server ends the stream
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("stream stayed open after the role was revoked")
	}
	if r := request(t, "GET", origin+"/export/TEST", "full-test", ""); r.StatusCode != 403 {
		t.Fatalf("export after revocation %d", r.StatusCode)
	}
}
