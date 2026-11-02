package dhan

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestReadRetryBudgetAndRetryAfter(t *testing.T) {
	for _, tc := range []struct {
		name       string
		statuses   []int
		attempts   int
		retryAfter string
		waits      []time.Duration
		wantCalls  int32
		wantError  bool
	}{
		{"transient reads", []int{503, 503, 200}, 3, "", []time.Duration{300 * time.Millisecond, 600 * time.Millisecond}, 3, false},
		{"retry-after capped", []int{429, 200}, 2, "60", []time.Duration{10 * time.Second}, 2, false},
		{"auth is not retried", []int{401, 200}, 3, "", nil, 1, true},
		{"bad input is not retried", []int{400, 200}, 3, "", nil, 1, true},
		{"finite failure budget", []int{503, 503, 503}, 3, "", []time.Duration{300 * time.Millisecond, 600 * time.Millisecond}, 3, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				n := int(calls.Add(1)) - 1
				if r.Method != "POST" || r.Header.Get("access-token") != "loopback-session" || r.Header.Get("client-id") != "fixture-client" {
					t.Error("Dhan read lost its method/auth/client-id contract")
				}
				body, _ := io.ReadAll(r.Body)
				if string(body) != `{"securityId":"42"}` {
					t.Errorf("Dhan read body: %s", body)
				}
				if n >= len(tc.statuses) {
					t.Error("Dhan exceeded its configured read attempts")
					w.WriteHeader(500)
					return
				}
				w.Header().Set("Retry-After", tc.retryAfter)
				w.WriteHeader(tc.statuses[n])
				if tc.statuses[n] == 200 {
					_, _ = io.WriteString(w, `{"ok":true}`)
				} else {
					_, _ = io.WriteString(w, `{"errorMessage":"fixture failure"}`)
				}
			}))
			defer server.Close()
			now := time.Unix(100, 0)
			var waits []time.Duration
			h := NewHTTP(HTTPConfig{APIRoot: server.URL, Client: server.Client(), TimeoutMs: 1000, MaxReadAttempts: tc.attempts,
				AccessToken: func() string { return "loopback-session" }, ClientID: func() string { return "fixture-client" },
				Now: func() time.Time { return now }, Sleep: func(_ context.Context, d time.Duration) error { waits = append(waits, d); now = now.Add(d); return nil }})
			body, err := h.Read(context.Background(), RequestOptions{Method: "POST", Path: "/marketfeed", WithClientID: true, Body: map[string]string{"securityId": "42"}})
			if (err != nil) != tc.wantError || calls.Load() != tc.wantCalls || !reflect.DeepEqual(waits, tc.waits) {
				t.Fatalf("Dhan retry result: error=%v calls=%d waits=%v", err, calls.Load(), waits)
			}
			if err == nil && string(body) != `{"ok":true}` {
				t.Fatalf("Dhan successful read: %s", body)
			}
		})
	}
}

func TestHTTPDeadlineReleasesPacerAndCanceledBackoffDoesNotRetry(t *testing.T) {
	var retryCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/stall" {
			<-r.Context().Done()
			return
		}
		if r.URL.Path == "/retry" {
			retryCalls.Add(1)
			w.WriteHeader(503)
			return
		}
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer server.Close()
	h := NewHTTP(HTTPConfig{APIRoot: server.URL, Client: server.Client(), TimeoutMs: 30, MaxReadAttempts: 1, AccessToken: func() string { return "loopback-session" }})
	if _, err := h.Read(context.Background(), RequestOptions{Path: "/stall"}); err == nil || !strings.Contains(err.Error(), "timed out after 30ms") {
		t.Fatalf("Dhan stalled read deadline: %v", err)
	}
	if body, err := h.Read(context.Background(), RequestOptions{Path: "/ok"}); err != nil || string(body) != `{"ok":true}` {
		t.Fatalf("Dhan pacer remained blocked after timeout: %s %v", body, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var sleeps int
	h = NewHTTP(HTTPConfig{APIRoot: server.URL, Client: server.Client(), TimeoutMs: 1000, MaxReadAttempts: 3,
		AccessToken: func() string { return "loopback-session" }, Sleep: func(ctx context.Context, _ time.Duration) error {
			sleeps++
			cancel()
			return ctx.Err()
		}})
	if _, err := h.Read(ctx, RequestOptions{Path: "/retry"}); err == nil || sleeps != 1 || retryCalls.Load() != 1 {
		t.Fatalf("Dhan canceled backoff: error=%v sleeps=%d calls=%d", err, sleeps, retryCalls.Load())
	}
}

func TestHTTPPacesRequestStarts(t *testing.T) {
	started := make(chan time.Time, 3)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		started <- time.Now()
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer server.Close()
	h := NewHTTP(HTTPConfig{APIRoot: server.URL, Client: server.Client(), TimeoutMs: 1000, MinIntervalMs: 20,
		MaxReadAttempts: 1, AccessToken: func() string { return "loopback-session" }})
	for n := 0; n < 3; n++ {
		if _, err := h.Read(context.Background(), RequestOptions{Path: "/quote"}); err != nil {
			t.Fatal(err)
		}
	}
	previous := <-started
	for n := 0; n < 2; n++ {
		at := <-started
		// Node's clock and the port's lastAt have millisecond resolution.
		if at.Sub(previous) < 18*time.Millisecond {
			t.Fatalf("Dhan request starts were not paced: %v", at.Sub(previous))
		}
		previous = at
	}
}
