package auth

import (
	"context"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
)

// Blocker explains why a broker switch was refused. Each one is something the operator
// can fix.
type Blocker struct {
	Reason string `json:"reason"`
	Detail string `json:"detail"`
}

// SwitchResult is the outcome of a broker switch attempt.
type SwitchResult struct {
	OK       bool
	Broker   brokers.ID // the broker now active when OK
	Blockers []Blocker  // why it was refused when not OK
}

// BrokerControl is what the login routes need from the broker registry.
type BrokerControl interface {
	ActiveBroker() brokers.ID
	// SwitchBroker moves the whole system to another broker. role is the caller's role.
	SwitchBroker(ctx context.Context, to brokers.ID, role Role) SwitchResult
}

// Routes serves the three admin-session endpoints.
type Routes struct {
	Sessions     *Sessions
	AdminSecret  string
	AccessSecret string
	Brokers      BrokerControl
}

// Mount registers the routes. Each verify route has its own 10-per-5-minutes limiter.
func (h *Routes) Mount(r chi.Router) {
	const msg = "Too many attempts. Try again in a few minutes."
	adminLimit := httpx.NewLimiter(5*time.Minute, 10, msg, nil)
	accessLimit := httpx.NewLimiter(5*time.Minute, 10, msg, nil)
	r.Post("/api/admin/verify", adminLimit.Wrap(h.adminVerify))
	r.Post("/api/access/verify", accessLimit.Wrap(h.accessVerify))
	r.Get("/api/admin/status", h.status)
}

type adminVerifyResponse struct {
	Success         bool      `json:"success"`
	Token           string    `json:"token"`
	Role            Role      `json:"role"`
	Broker          string    `json:"broker"`
	SwitchRefused   bool      `json:"broker_switch_refused,omitempty"`
	SwitchBlockers  []Blocker `json:"broker_switch_blockers,omitempty"`
	ExpiresInMillis int64     `json:"expiresIn"`
}

func (h *Routes) adminVerify(w http.ResponseWriter, r *http.Request) {
	body := httpx.BodyObject(r)
	secret, isStr := body["secret"].(string)
	switch CheckPasscode(h.AdminSecret, secret, isStr) {
	case PasscodeNotConfigured:
		httpx.Error(w, http.StatusInternalServerError, "Admin secret not configured on server")
		return
	case PasscodeForbidden:
		httpx.Error(w, http.StatusUnauthorized, "Invalid admin secret")
		return
	}

	// The broker is optional so a client that only sends the secret keeps working. When it
	// is present it must be valid: silently ignoring a typo would log the operator in
	// against a different broker than the one they picked.
	broker := h.Brokers.ActiveBroker()
	var blockers []Blocker
	if raw, present := body["broker"]; present && raw != nil && raw != "" {
		parsed, ok := brokers.Parse(raw)
		if !ok {
			httpx.Error(w, http.StatusBadRequest, `broker must be "zerodha" or "dhan".`)
			return
		}
		// Log in first, then attempt the switch: a refused switch must not deny the login,
		// or the operator could never reach the UI to clear what blocks it.
		if res := h.Brokers.SwitchBroker(r.Context(), parsed, RoleFull); res.OK {
			broker = res.Broker
		} else {
			blockers = res.Blockers
		}
	}

	resp := adminVerifyResponse{
		Success: true, Token: h.Sessions.Mint(RoleFull), Role: RoleFull,
		Broker: string(broker), ExpiresInMillis: SessionTTL.Milliseconds(),
	}
	if len(blockers) > 0 {
		resp.SwitchRefused, resp.SwitchBlockers = true, blockers
	}
	httpx.JSON(w, http.StatusOK, resp)
}

func (h *Routes) accessVerify(w http.ResponseWriter, r *http.Request) {
	// Node threw on a request without a JSON body here (an accidental 500). A missing body
	// is treated as an empty one, which falls through to the usual wrong-code answer.
	secret, isStr := httpx.BodyObject(r)["secret"].(string)
	switch CheckPasscode(h.AccessSecret, secret, isStr) {
	case PasscodeNotConfigured:
		httpx.Error(w, http.StatusInternalServerError, "Access secret not configured on server")
		return
	case PasscodeForbidden:
		httpx.Error(w, http.StatusUnauthorized, "Invalid access code")
		return
	}
	httpx.JSON(w, http.StatusOK, struct {
		Success         bool   `json:"success"`
		Token           string `json:"token"`
		Role            Role   `json:"role"`
		Broker          string `json:"broker"` // inherited, never selected
		ExpiresInMillis int64  `json:"expiresIn"`
	}{true, h.Sessions.Mint(RoleTrade), RoleTrade, string(h.Brokers.ActiveBroker()), SessionTTL.Milliseconds()})
}

func (h *Routes) status(w http.ResponseWriter, r *http.Request) {
	role := h.Sessions.RoleOf(r)
	var roleOut *Role
	if role != RoleNone {
		roleOut = &role
	}
	httpx.JSON(w, http.StatusOK, struct {
		Authenticated bool   `json:"authenticated"`
		Role          *Role  `json:"role"`
		Broker        string `json:"broker"`
	}{role != RoleNone, roleOut, string(h.Brokers.ActiveBroker())})
}
