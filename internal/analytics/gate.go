package analytics

import (
	"net/http"
	"sync/atomic"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
)

// ZerodhaCaptureGate is index.ts zerodhaCaptureAllowed, for Deps.CaptureAllowed. The NIFTY
// recorders are keyed by Kite instrument tokens, so they run only while Zerodha is the
// active broker (the first refusal is logged once for the process lifetime) and a Kite
// access token is held (kite.getAccessToken() !== null, i.e. Client.HasSession).
func ZerodhaCaptureGate(activeBroker func() brokers.ID, hasKiteSession func() bool, logf func(format string, args ...any)) func(what string) bool {
	var warned atomic.Bool
	return func(what string) bool {
		b := activeBroker()
		if b != brokers.Zerodha {
			if warned.CompareAndSwap(false, true) && logf != nil {
				logf("[Capture] %s and the other Zerodha-only analytics recorders are paused: active broker is %s. Their series are keyed by Kite instrument tokens, so they must not append while another broker is active.", what, b)
			}
			return false
		}
		return hasKiteSession()
	}
}

// DefaultSendError is index.ts sendError: a KiteError answers with its own status (a 401
// or 403 also calls authFailed, where Node cleared the Kite session in memory and in the
// database); any other error is 500 with its message.
func DefaultSendError(authFailed func()) func(w http.ResponseWriter, err error) {
	return func(w http.ResponseWriter, err error) {
		if ke, ok := kite.AsKiteError(err); ok {
			if (ke.Status == http.StatusUnauthorized || ke.Status == http.StatusForbidden) && authFailed != nil {
				authFailed()
			}
			httpx.Error(w, ke.Status, ke.Message)
			return
		}
		httpx.Error(w, http.StatusInternalServerError, err.Error())
	}
}
