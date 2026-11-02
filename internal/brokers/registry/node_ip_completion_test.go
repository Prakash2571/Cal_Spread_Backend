package registry

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
)

// Literal remaining static-IP cases from tests/box/dhanMarginAndIp.test.mjs.
// The inherited goldens use other addresses and exercise several of these
// assertions indirectly; each original payload now reaches the real verifier.
func TestNodeStaticIPReadinessAndVerification(t *testing.T) {
	for _, tc := range []struct {
		title      string
		env        map[string]string
		body       string
		status     int
		verify     bool
		verified   bool
		ready      bool
		primary    string
		errorParts []string
	}{
		{"with NO configured IP, readiness falls back to the manual declaration", map[string]string{"DHAN_STATIC_IP_EXPECTED": "true"}, "", 0, false, false, true, "", nil},
		{"with nothing configured at all, it FAILS CLOSED", nil, "", 0, false, false, false, "", nil},
		{"a configured IP that MATCHES Dhan's primary verifies and becomes ready", map[string]string{"DHAN_STATIC_PUBLIC_IP": "203.0.113.7"}, `{"primaryIP":"203.0.113.7","secondaryIP":""}`, 200, true, true, true, "", nil},
		{"a configured IP matching the SECONDARY also verifies", map[string]string{"DHAN_STATIC_PUBLIC_IP": "203.0.113.9"}, `{"primaryIP":"198.51.100.1","secondaryIP":"203.0.113.9"}`, 200, true, true, true, "", nil},
		{"a MISMATCHED IP blocks trading and names both sides", map[string]string{"DHAN_STATIC_PUBLIC_IP": "203.0.113.7"}, `{"primaryIP":"198.51.100.1","secondaryIP":"198.51.100.2"}`, 200, true, false, false, "", []string{"203.0.113.7", "198.51.100.1"}},
		{"an UNREACHABLE verification call fails closed", map[string]string{"DHAN_STATIC_PUBLIC_IP": "203.0.113.7"}, `{"errorMessage":"network down"}`, 500, true, false, false, "", []string{"verification failed"}},
		{"the manual flag remains an override that can still BLOCK a verified IP", map[string]string{"DHAN_STATIC_PUBLIC_IP": "203.0.113.7", "DHAN_STATIC_IP_EXPECTED": "false"}, `{"primaryIP":"203.0.113.7"}`, 200, true, true, false, "", nil},
		{"verification MATCHES against Dhan's dashboard-style key names", map[string]string{"DHAN_STATIC_PUBLIC_IP": "100.31.218.89"}, `{"dhanClientId":"1000000001","ipAddress1":"100.31.218.89","ipAddress2":"NA"}`, 200, true, true, true, "100.31.218.89", nil},
		{"an EMPTY whitelist is reported differently from a mismatch", map[string]string{"DHAN_STATIC_PUBLIC_IP": "100.31.218.89"}, `{"dhanClientId":"1","ipAddress1":"NA","ipAddress2":"NA"}`, 200, true, false, false, "", []string{"returned no IP address", "Response fields"}},
		{"a genuine mismatch lists what Dhan actually has", map[string]string{"DHAN_STATIC_PUBLIC_IP": "100.31.218.89"}, `{"ipAddress1":"198.51.100.1","ipAddress2":"198.51.100.2"}`, 200, true, false, false, "", []string{"does not match", "198.51.100.1, 198.51.100.2"}},
	} {
		t.Run(tc.title, func(t *testing.T) {
			var responses map[string][]httpSpec
			if tc.verify {
				responses = map[string][]httpSpec{"api GET /ip/getIP": {{Status: tc.status, Body: json.RawMessage(tc.body)}}}
			}
			u := newUnitRig(t, nil, responses)
			u.activateDhan("tok")
			for key, value := range tc.env {
				u.env.set(key, value)
			}
			if tc.verify {
				res := u.reg.VerifyDhanStaticIP(context.Background())
				if res.Verified != tc.verified {
					t.Fatalf("verified = %v, want %v; error %v", res.Verified, tc.verified, res.Error)
				}
				if tc.primary != "" && (res.PrimaryIP == nil || *res.PrimaryIP != tc.primary) {
					t.Errorf("primary_ip = %v, want %q", res.PrimaryIP, tc.primary)
				}
				for _, part := range tc.errorParts {
					if res.Error == nil || !strings.Contains(strings.ToLower(*res.Error), strings.ToLower(part)) {
						t.Errorf("verification error %v must include %q", res.Error, part)
					}
				}
				if tc.verified && tc.ready {
					state := u.reg.DhanStaticIPState()
					if state.APIVerified == nil || !*state.APIVerified {
						t.Errorf("API verification evidence is missing: %+v", state)
					}
				}
			} else if tc.ready {
				state := u.reg.DhanStaticIPState()
				if state.ConfiguredIP != nil || !state.Declared {
					t.Errorf("manual-only evidence must be explicit: %+v", state)
				}
			}
			if got := u.reg.DhanStaticIPReady(); got != tc.ready {
				t.Errorf("static IP readiness = %v, want %v", got, tc.ready)
			}
			if !tc.ready && u.reg.HealthFor(brokers.Dhan).TradingReady {
				t.Error("unready static IP must not report trading readiness")
			}
		})
	}
	// "readiness on the manual flag alone is reported as weaker evidence"
	t.Run("readiness on the manual flag alone is reported as weaker evidence", func(t *testing.T) {
		u := newUnitRig(t, nil, nil)
		u.activateDhan("tok")
		u.env.set("DHAN_STATIC_IP_EXPECTED", "true")
		u.env.set("DHAN_LIVE_TRADING_ENABLED", "true")
		for _, problem := range u.reg.HealthFor(brokers.Dhan).Problems {
			if strings.Contains(problem, "DHAN_STATIC_PUBLIC_IP") {
				return
			}
		}
		t.Fatal("manual-only readiness must recommend API-verified DHAN_STATIC_PUBLIC_IP")
	})
}
