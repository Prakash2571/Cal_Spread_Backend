package brokerlogin

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const vectorSeed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

func TestRFC6238SixDigitVectors(t *testing.T) {
	for _, test := range []struct {
		seconds int64
		code    string
	}{{59, "287082"}, {1111111109, "081804"}, {1111111111, "050471"},
		{1234567890, "005924"}, {2000000000, "279037"}, {20000000000, "353130"}} {
		code, err := CodeAt(vectorSeed, time.Unix(test.seconds, 0))
		if err != nil || code != test.code {
			t.Fatalf("RFC vector at %d: %s, %v; want %s", test.seconds, code, err, test.code)
		}
	}
}

func TestTokenAPIContractAndRefusals(t *testing.T) {
	for _, test := range []struct {
		name, body, code string
		status           int
		permanent        bool
	}{
		{"served", `{"client_id":"1100001","access_token":"synthetic-token","expires_in":86400}`, "", 200, false},
		{"used code", `{"error":"code_already_used"}`, "code_already_used", 409, false},
		{"not ready", `{"error":"no_token_yet"}`, "no_token_yet", 503, false},
		{"service configuration", `{"error":"not_configured"}`, "not_configured", 503, true},
		{"wrong credentials", `{"error":"unauthorized"}`, "unauthorized", 401, true},
		{"locked", `{"error":"locked"}`, "locked", 429, false},
		{"rate limited", `{"error":"rate_limited"}`, "rate_limited", 429, false},
		{"malformed request", `{"error":"bad_request"}`, "bad_request", 400, true},
		{"Cloudflare refusal", "<html>blocked</html>", "cloudflare_blocked", 403, true},
		{"Cloudflare integrity", "error code: 1010", "cloudflare_1010", 403, true},
		{"Access redirect", "", "access_redirect", 302, true},
		{"wrong account", `{"client_id":"another-account","access_token":"synthetic-token","expires_in":86400}`, "wrong_account", 200, true},
		{"expired reply", `{"client_id":"1100001","access_token":"synthetic-token","expires_in":0}`, "bad_response", 200, false},
		{"broken JSON", "{", "bad_response", 200, false},
		{"oversized", strings.Repeat("x", maxBody+1), "bad_response", 200, false},
		{"untrusted error text", `{"error":"synthetic-secret https://private.example.test"}`, "http_500", 500, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			var redirected atomic.Bool
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/v1/token" {
					redirected.Store(true)
					return
				}
				if r.Method != "POST" || r.URL.RawQuery != "" {
					t.Errorf("unexpected token request method/query")
				}
				var body map[string]string
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body) != 2 || body["client_id"] != "1100001" || body["totp"] != "287082" {
					t.Errorf("request did not contain exactly the account ID and RFC code")
				}
				if r.Header.Get("CF-Access-Client-Id") != "synthetic-cf-id" || r.Header.Get("CF-Access-Client-Secret") != "synthetic-cf-secret" || r.Header.Get("User-Agent") != "calspread-backend/1" {
					t.Errorf("missing service-token headers or named user agent")
				}
				w.Header().Set("Retry-After", "120")
				w.Header().Set("Location", "/must-not-follow")
				w.WriteHeader(test.status)
				_, _ = io.WriteString(w, test.body)
			}))
			defer server.Close()
			client := New(Config{URL: server.URL, ClientID: "1100001", TokenAPISeed: vectorSeed,
				CFClientID: "synthetic-cf-id", CFClientSecret: "synthetic-cf-secret"})
			client.HTTP = server.Client()
			now := time.Unix(59, 0)
			token, err := client.Fetch(context.Background(), now)
			if redirected.Load() {
				t.Fatal("Access redirect was followed")
			}
			if test.code == "" {
				if err != nil || token == nil || token.ClientID != "1100001" || token.AccessToken != "synthetic-token" || !token.ExpiresAt.Equal(now.Add(24*time.Hour)) {
					t.Fatal("served token was not decoded with its account and expiry")
				}
				return
			}
			refusal, ok := err.(*Error)
			if token != nil || !ok || refusal.Code != test.code || refusal.Permanent() != test.permanent {
				t.Fatalf("refusal: %v; want %s permanent=%v", err, test.code, test.permanent)
			}
			if strings.Contains(err.Error(), "synthetic-secret") || strings.Contains(err.Error(), "private.example.test") || strings.Contains(err.Error(), server.URL) {
				t.Fatal("remote response or private URL leaked into the error")
			}
			if test.status != 200 && test.status != 302 && refusal.RetryAfter != 120*time.Second {
				t.Fatalf("Retry-After lost: %v", refusal.RetryAfter)
			}
		})
	}
}

func TestConfigValidationAndPasteOnly(t *testing.T) {
	valid := map[string]string{"BROKER_LOGIN_URL": "https://service.example.test/", "BROKER_LOGIN_CF_CLIENT_ID": "synthetic-id",
		"BROKER_LOGIN_CF_CLIENT_SECRET": "synthetic-secret", "DHAN_CLIENT_ID": "1100001", "DHAN_TOKEN_API_SEED": vectorSeed}
	get := func(key string) string { return valid[key] }
	config, err := LoadConfig(get)
	if err != nil || config.URL != "https://service.example.test" || config.AutoLoginTime != "08:30" {
		t.Fatalf("valid config: %v", err)
	}
	if config, err := LoadConfig(func(string) string { return "" }); err != nil || config.URL != "" {
		t.Fatal("paste-only operation should not need service credentials")
	}
	for _, test := range []struct{ key, value string }{
		{"BROKER_LOGIN_URL", "http://service.example.test"}, {"BROKER_LOGIN_URL", "https://service.example.test/api"},
		{"BROKER_LOGIN_URL", "https://service.example.test?q=secret"}, {"BROKER_LOGIN_URL", "https://user:password@service.example.test"},
		{"BROKER_LOGIN_URL", ""}, {"BROKER_LOGIN_CF_CLIENT_SECRET", ""}, {"DHAN_CLIENT_ID", "invalid/id"},
		{"DHAN_TOKEN_API_SEED", "invalid-seed!"}, {"DHAN_TOKEN_API_SEED", "GEZDGNBV"}, {"AUTO_LOGIN_TIME", "25:00"},
	} {
		copy := map[string]string{}
		for key, value := range valid {
			copy[key] = value
		}
		copy[test.key] = test.value
		_, err := LoadConfig(func(key string) string { return copy[key] })
		if err == nil || strings.Contains(err.Error(), "service.example.test") || strings.Contains(err.Error(), "synthetic-secret") {
			t.Errorf("%s validation failed or exposed a private value", test.key)
		}
	}
}

func TestRetryAfterHTTPDateAndOverflow(t *testing.T) {
	now := time.Date(2026, 11, 3, 8, 0, 0, 0, time.UTC)
	if got := retryAfter(now.Add(2*time.Minute).Format(http.TimeFormat), now); got != 2*time.Minute {
		t.Errorf("HTTP Retry-After date: %v", got)
	}
	if got := retryAfter("9223372036854775807", now); got != 24*time.Hour {
		t.Errorf("Retry-After overflow: %v", got)
	}
}
