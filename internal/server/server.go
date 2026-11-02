// Package server assembles the HTTP handler: the shared middleware in the order the Node
// app used, then whatever route groups the caller mounts.
package server

import (
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
)

// Options configures the shared middleware.
type Options struct {
	// FrontendOrigin is the single allowed CORS origin (FRONTEND_URL).
	FrontendOrigin string
	// Now is the limiter clock; nil means time.Now.
	Now func() time.Time
}

// New builds the handler. Order matches index.ts: CORS and no-store on every response
// (OPTIONS answered here), the JSON body parser, the 150-per-minute limiter on /api and
// /api/*, the routes, then Express's HTML 404 for anything unmatched.
func New(opts Options, mounts ...func(chi.Router)) http.Handler {
	r := chi.NewRouter()
	r.Use(httpx.CORS(opts.FrontendOrigin))
	r.Use(httpx.Recoverer)
	r.Use(httpx.ParseBody)
	r.Use(apiLimiter(httpx.NewLimiter(time.Minute, 150, "", opts.Now)))
	r.Use(chimw.StripSlashes) // Express matches /path and /path/ alike
	r.NotFound(httpx.NotFound)
	r.MethodNotAllowed(httpx.NotFound) // Express answers an unmatched method with the same 404
	for _, mount := range mounts {
		mount(r)
	}
	return r
}

// apiLimiter applies l to /api and everything under it, like app.use("/api", ...).
func apiLimiter(l *httpx.Limiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		limited := l.Middleware(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if p := r.URL.Path; p == "/api" || strings.HasPrefix(p, "/api/") {
				limited.ServeHTTP(w, r)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
