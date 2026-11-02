package registry

// Port of tests/box/singleBroker.test.mjs "Dhan is not trading_ready without a session,
// even with a static IP": no golden step has a ready static IP without a session.

import (
	"regexp"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
)

func TestNodeDhanNotTradingReadyWithoutASessionEvenWithAStaticIP(t *testing.T) {
	notConnected := regexp.MustCompile(`(?i)not connected`)
	for _, withCreds := range []bool{true, false} {
		u := newUnitRig(t, nil, nil) // Zerodha active, no Dhan session
		if !withCreds {
			for _, k := range []string{"DHAN_CLIENT_ID", "DHAN_API_KEY", "DHAN_API_SECRET"} {
				u.env.unset(k)
			}
		}
		u.env.set("DHAN_STATIC_IP_EXPECTED", "true")
		h := u.reg.HealthFor(brokers.Dhan)
		if h.StaticIPConfigured == nil || !*h.StaticIPConfigured {
			t.Fatalf("creds=%v: premise: the static IP must be ready, got %v", withCreds, h.StaticIPConfigured)
		}
		if h.Authenticated || h.DataReady || h.TradingReady {
			t.Errorf("creds=%v: authenticated %v data_ready %v trading_ready %v, want all false", withCreds, h.Authenticated, h.DataReady, h.TradingReady)
		}
		found := false
		for _, p := range h.Problems {
			found = found || notConnected.MatchString(p)
		}
		if !found {
			t.Errorf("creds=%v: problems %q lack /not connected/i", withCreds, h.Problems)
		}
	}
}
