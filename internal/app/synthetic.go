package app

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/auth"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/synthetic"
)

// mountSynthetic keeps the complete route surface mounted on the idle engine.
// Start can create its loop even without Boot, so block that entry in the app.
func (a *App) mountSynthetic(r chi.Router) {
	r.Group(func(r chi.Router) {
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPost && strings.TrimRight(r.URL.Path, "/") == "/api/synthetic/start" {
					if a.sessions.Role(httpx.AdminToken(r)) == auth.RoleNone {
						httpx.Error(w, http.StatusForbidden, "Admin authentication required")
					} else {
						httpx.Error(w, http.StatusServiceUnavailable, "Synthetic is intentionally disabled.")
					}
					return
				}
				next.ServeHTTP(w, r)
			})
		})
		synthetic.Register(r, a.synth, synthetic.RouteDeps{Role: a.sessions.Role})
	})
}
