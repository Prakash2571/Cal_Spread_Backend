package fairvalue

import (
	"context"
	"log"
	"math"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/model"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
	kitejson "github.com/Prakash2571/Cal_Spread_Backend/internal/kite/jsjson"
)

// Service is what the routes need from the engine; the authorisation tests substitute
// a fake.
type Service interface {
	Status() StatusView
	GetConfig() ConfigView
	UpdateConfig(patch any) (UpdateResult, error)
	Underlyings() ([]Underlying, error)
	GetSnapshot(underlying string) SnapshotView
	Refresh(underlying string) (RefreshResult, error)
	Pause(paused bool)
	Calculate(value any) (*model.CalculatorResult, error)
	Independent(value any) (*model.IndependentEstimate, error)
	History(underlying string, limit float64) ([]model.HistorySummary, error)
	HistoricalSnapshot(underlying, id string) (any, error)
	Subscribe(listener func()) (func(), error)
}

// RouteDeps are routes.ts FairValueRouteDeps.
type RouteDeps struct {
	Engine Service
	// IsFullAdmin reports whether token is a live full-admin session (getAdminRole(token)
	// === "full"); "" is no token.
	IsFullAdmin func(token string) bool
	// StreamInterval is the SSE publish period (default 5 s).
	StreamInterval time.Duration
	// StreamWriteTimeout bounds one SSE write (default 10 s; see stream).
	StreamWriteTimeout time.Duration
	// Now is the work limiter's clock (nil: time.Now).
	Now func() time.Time
}

const fullAdminRequired = "Full admin access required."

type tokenKey struct{}

// writeJS writes body exactly as res.json(JSON.stringify) did.
func writeJS(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(jsjson.Marshal(body))
}

type errorBody struct {
	Error string `json:"error"`
}

// respond is the wrapped res.json: the caller's role is re-checked when the response is
// written, so a session that expired during an asynchronous computation gets 403.
func (d *RouteDeps) respond(w http.ResponseWriter, r *http.Request, status int, body any) {
	token, _ := r.Context().Value(tokenKey{}).(string)
	if !d.IsFullAdmin(token) {
		writeJS(w, http.StatusForbidden, errorBody{fullAdminRequired})
		return
	}
	writeJS(w, status, body)
}

func (d *RouteDeps) fail(w http.ResponseWriter, r *http.Request, status int, err error) {
	d.respond(w, r, status, errorBody{err.Error()})
}

// streamToken is req.header("x-admin-token") ?? (single string query parameter).
func streamToken(r *http.Request) string {
	if len(r.Header.Values("X-Admin-Token")) > 0 {
		return httpx.AdminToken(r)
	}
	if q := r.URL.Query()["x-admin-token"]; len(q) == 1 {
		return q[0]
	}
	return ""
}

// guard is the router-wide middleware: no-store on every response, full admin for
// everything (the stream may carry its token in the query), and the response-time
// role re-check for JSON responses.
func (d *RouteDeps) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, no-store")
		if r.Method == http.MethodGet && r.URL.Path == "/api/fair-value/stream" {
			if !d.IsFullAdmin(streamToken(r)) {
				writeJS(w, http.StatusForbidden, errorBody{fullAdminRequired})
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		token := httpx.AdminToken(r)
		if !d.IsFullAdmin(token) {
			writeJS(w, http.StatusForbidden, errorBody{fullAdminRequired})
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), tokenKey{}, token)))
	})
}

// bodyValue is req.body as JSON.parse produced it: nil when there was none (undefined),
// an empty object for an empty JSON body.
func bodyValue(r *http.Request) any {
	if raw := httpx.RawBody(r); raw != nil {
		if v, err := jsjson.Parse(raw); err == nil {
			return v
		}
	}
	if httpx.Body(r) != nil {
		return jsjson.NewObjectValue()
	}
	return nil
}

// bodyProp is req.body?.[key].
func bodyProp(body any, key string) any {
	if o, ok := body.(*jsjson.Object); ok {
		v, _ := o.Get(key)
		return v
	}
	return nil
}

// param is req.params[name]: the path segment, percent-decoded.
func param(r *http.Request, name string) string {
	raw := chi.URLParam(r, name)
	if s, err := url.PathUnescape(raw); err == nil {
		return s
	}
	return raw
}

// Mount registers /api/fair-value/*.
func Mount(r chi.Router, d RouteDeps) {
	if d.StreamInterval <= 0 {
		d.StreamInterval = 5 * time.Second
	}
	if d.StreamWriteTimeout <= 0 {
		d.StreamWriteTimeout = 10 * time.Second
	}
	work := httpx.NewLimiter(time.Minute, 30, "Fair Value analytics request budget exceeded.", d.Now)
	r.Route("/api/fair-value", func(fr chi.Router) {
		fr.Use(d.guard)
		fr.NotFound(httpx.NotFound)
		fr.MethodNotAllowed(httpx.NotFound)
		fr.Get("/status", func(w http.ResponseWriter, r *http.Request) { d.respond(w, r, 200, d.Engine.Status()) })
		fr.Get("/config", func(w http.ResponseWriter, r *http.Request) { d.respond(w, r, 200, d.Engine.GetConfig()) })
		fr.With(work.Middleware).Patch("/config", func(w http.ResponseWriter, r *http.Request) {
			res, err := d.Engine.UpdateConfig(bodyValue(r))
			if err != nil {
				d.fail(w, r, 400, err)
				return
			}
			d.respond(w, r, 200, struct {
				Version   string     `json:"version"`
				Persisted bool       `json:"persisted"`
				Status    StatusView `json:"status"`
			}{res.Version, res.Persisted, d.Engine.Status()})
		})
		fr.Get("/underlyings", func(w http.ResponseWriter, r *http.Request) {
			list, err := d.Engine.Underlyings()
			if err != nil {
				d.fail(w, r, 503, err)
				return
			}
			d.respond(w, r, 200, struct {
				Underlyings []Underlying `json:"underlyings"`
				Status      StatusView   `json:"status"`
			}{list, d.Engine.Status()})
		})
		fr.Get("/snapshot/{underlying}", func(w http.ResponseWriter, r *http.Request) {
			d.respond(w, r, 200, d.Engine.GetSnapshot(param(r, "underlying")))
		})
		fr.With(work.Middleware).Post("/refresh", func(w http.ResponseWriter, r *http.Request) {
			underlying, ok := bodyProp(bodyValue(r), "underlying").(string)
			if !ok {
				d.respond(w, r, 400, errorBody{"underlying is required."})
				return
			}
			res, err := d.Engine.Refresh(underlying)
			if err != nil {
				d.fail(w, r, 503, err)
				return
			}
			d.respond(w, r, 200, struct {
				Snapshot *model.SurfaceSnapshot `json:"snapshot"`
				Pending  bool                   `json:"pending"`
				Status   StatusView             `json:"status"`
			}{res.Snapshot, res.Pending, d.Engine.Status()})
		})
		fr.Post("/pause", func(w http.ResponseWriter, r *http.Request) {
			paused, ok := bodyProp(bodyValue(r), "paused").(bool)
			if !ok {
				d.respond(w, r, 400, errorBody{"paused must be boolean."})
				return
			}
			d.Engine.Pause(paused)
			d.respond(w, r, 200, struct {
				Status StatusView `json:"status"`
			}{d.Engine.Status()})
		})
		fr.With(work.Middleware).Post("/calculate", func(w http.ResponseWriter, r *http.Request) {
			res, err := d.Engine.Calculate(bodyValue(r))
			if err != nil {
				d.fail(w, r, 400, err)
				return
			}
			d.respond(w, r, 200, res)
		})
		fr.With(work.Middleware).Post("/independent", func(w http.ResponseWriter, r *http.Request) {
			res, err := d.Engine.Independent(bodyValue(r))
			if err != nil {
				d.fail(w, r, 400, err)
				return
			}
			d.respond(w, r, 200, res)
		})
		fr.Get("/history/{underlying}", func(w http.ResponseWriter, r *http.Request) {
			limit := 100.0
			if q := r.URL.Query()["limit"]; len(q) == 1 {
				if n := kitejson.StringToNumber(q[0]); n != 0 && !math.IsNaN(n) {
					limit = n
				}
			}
			limit = math.Min(500, math.Max(1, limit))
			snapshots, err := d.Engine.History(param(r, "underlying"), limit)
			if err != nil {
				d.fail(w, r, 503, err)
				return
			}
			d.respond(w, r, 200, struct {
				Historical bool                   `json:"historical"`
				Snapshots  []model.HistorySummary `json:"snapshots"`
				Storage    string                 `json:"storage"`
			}{true, snapshots, d.Engine.Status().Storage})
		})
		fr.Get("/history/{underlying}/{id}", func(w http.ResponseWriter, r *http.Request) {
			snapshot, err := d.Engine.HistoricalSnapshot(param(r, "underlying"), param(r, "id"))
			if err != nil {
				d.fail(w, r, 503, err)
				return
			}
			if snapshot == nil {
				d.respond(w, r, 404, errorBody{"Historical snapshot unavailable or outside retention."})
				return
			}
			d.respond(w, r, 200, struct {
				Historical bool `json:"historical"`
				Snapshot   any  `json:"snapshot"`
			}{true, snapshot})
		})
		fr.Get("/export/{underlying}", func(w http.ResponseWriter, r *http.Request) {
			result := d.Engine.GetSnapshot(param(r, "underlying"))
			if result.Snapshot == nil {
				d.respond(w, r, 404, errorBody{"No current Fair Value snapshot."})
				return
			}
			w.Header().Set("Content-Disposition", `attachment; filename="fair-value-snapshot.json"`)
			d.respond(w, r, 200, result)
		})
		fr.Get("/stream", d.stream)
	})
}

// stream is GET /stream: "event: snapshot" frames when the engine changed, ": heartbeat"
// otherwise, every StreamInterval. The role is re-checked on every emission.
//
// Node closed a stream whose unsent buffer exceeded 256,000 bytes. Go writes block
// instead of buffering, so a write that cannot finish within StreamWriteTimeout closes
// the stream for the same reason (a client that stopped reading).
func (d *RouteDeps) stream(w http.ResponseWriter, r *http.Request) {
	token := streamToken(r)
	symbol := ""
	if q := r.URL.Query()["underlying"]; len(q) == 1 {
		symbol = strings.ToUpper(q[0])
	}
	var dirty atomic.Bool
	dirty.Store(true)
	detach, err := d.Engine.Subscribe(func() { dirty.Store(true) })
	if err != nil {
		writeJS(w, http.StatusTooManyRequests, errorBody{err.Error()})
		return
	}
	defer detach()
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	rc := http.NewResponseController(w)
	_ = rc.Flush()
	publish := func() bool {
		if !d.IsFullAdmin(token) {
			return false
		}
		var frame []byte
		if dirty.Swap(false) {
			var body any
			if symbol != "" {
				body = d.Engine.GetSnapshot(symbol)
			} else {
				body = d.Engine.Status()
			}
			frame = append(append([]byte("event: snapshot\ndata: "), jsjson.Marshal(body)...), '\n', '\n')
		} else {
			frame = []byte(": heartbeat\n\n")
		}
		_ = rc.SetWriteDeadline(time.Now().Add(d.StreamWriteTimeout))
		if _, err := w.Write(frame); err != nil {
			return false
		}
		if err := rc.Flush(); err != nil {
			log.Printf("[FairValue] stream flush failed: %v", err)
			return false
		}
		return true
	}
	if !publish() {
		return
	}
	ticker := time.NewTicker(d.StreamInterval)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if !publish() {
				return
			}
		}
	}
}

var _ Service = (*Engine)(nil)
