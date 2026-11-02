package synthetic

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"net/url"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/auth"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
)

// HTTP + SSE surface of the scanner, mounted under /api/synthetic (src/synthetic/routes.ts).
//
// Every route needs an admin token (full OR trade access) in x-admin-token. The stream
// also takes it as a query parameter because EventSource cannot set headers. DELETE
// additionally needs the full role. Nothing here can send a real order: positions are
// paper fills at the observed touch.

// RouteDeps are the collaborators Register takes from the outer shell.
type RouteDeps struct {
	// Role maps an x-admin-token value to its role; auth.RoleNone for an unknown,
	// expired or empty token (index.ts getAdminRole). Production: sessions.Role.
	Role func(token string) auth.Role
	// Now is the delete limiter's clock; nil means time.Now.
	Now func() time.Time
	// PingInterval is the stream keep-alive period; 0 means 20 s.
	PingInterval time.Duration
}

const (
	deleteWindow  = 60 * time.Second
	deleteMax     = 20
	deleteMessage = "Too many delete requests. Slow down."
	sseKeepAlive  = 20 * time.Second
	historyMax    = 2000
	historyBase   = 500
)

type routes struct {
	eng         *Engine
	deps        RouteDeps
	deleteLimit *httpx.Limiter
	ping        time.Duration
}

// Register mounts the 12 routes on r. The delete limiter (60 s, 20 per IP) is private to
// this call, as the Node instance was private to the module.
func Register(r chi.Router, eng *Engine, deps RouteDeps) {
	h := &routes{
		eng:         eng,
		deps:        deps,
		deleteLimit: httpx.NewLimiter(deleteWindow, deleteMax, deleteMessage, deps.Now),
		ping:        deps.PingInterval,
	}
	if h.ping <= 0 {
		h.ping = sseKeepAlive
	}
	r.Get("/api/synthetic/status", h.admin(h.status))
	r.Post("/api/synthetic/start", h.admin(guard(h.start)))
	r.Post("/api/synthetic/stop", h.admin(h.stop))
	r.Post("/api/synthetic/strike-level", h.admin(h.strikeLevel))
	r.Post("/api/synthetic/settings", h.admin(guard(h.settings)))
	r.Get("/api/synthetic/opportunities", h.admin(h.opportunities))
	r.Get("/api/synthetic/trades/open", h.admin(h.tradesOpen))
	r.Get("/api/synthetic/trades/history", h.admin(guard(h.tradesHistory)))
	// Express decodes the path parameters while matching, before any handler of the
	// route runs: a parameter that cannot be decoded is a 400 before the limiter and auth.
	r.Post("/api/synthetic/trades/{id}/close", withParam("id", h.admin(guard(h.closeTrade))))
	// The delete limiter comes first, so unauthenticated calls consume its bucket too.
	r.Delete("/api/synthetic/trades/{id}", withParam("id", h.deleteLimit.Wrap(h.admin(h.deleteTrade))))
	r.Get("/api/synthetic/chain/{underlying}", withParam("underlying", h.admin(h.chain)))
	r.Get("/api/synthetic/stream", h.stream)
}

func (h *routes) roleOf(token string) auth.Role {
	if h.deps.Role == nil || token == "" {
		return auth.RoleNone
	}
	return h.deps.Role(token)
}

// admin is requireAdmin: any valid session, else 403.
func (h *routes) admin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if h.roleOf(httpx.AdminToken(r)) == auth.RoleNone {
			httpx.Error(w, http.StatusForbidden, "Admin authentication required")
			return
		}
		next(w, r)
	}
}

// guard is the `try { ... } catch (err) { fail(res, err) }` of the async handlers: a
// panic answers 500 with its message. (The synchronous Node handlers had no catch; their
// panics reach the server's recoverer, as Express's default handler.)
func guard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				if rec == http.ErrAbortHandler {
					panic(rec)
				}
				err, ok := rec.(error)
				if !ok {
					err = nonError{fmt.Sprint(rec)}
				}
				fail(w, err)
			}
		}()
		next(w, r)
	}
}

// nonError is something thrown that is not an Error: fail answers its generic text.
type nonError struct{ v string }

func (n nonError) Error() string { return n.v }

// fail is routes.ts fail: 500 with the error's message ("Unexpected server error." for
// something that is not an Error).
func fail(w http.ResponseWriter, err error) {
	msg := "Unexpected server error."
	var ne nonError
	if err != nil && !errors.As(err, &ne) {
		msg = err.Error()
	}
	log.Printf("[Synthetic] request failed: %v", err)
	httpx.Error(w, http.StatusInternalServerError, msg)
}

// paramKey is the context key of a decoded path parameter.
type paramKey string

// withParam decodes a path parameter as Express does (decodeURIComponent) and hands it
// to next. chi routes on the escaped path when the request has one (URL.RawPath), so its
// parameters are then still percent-encoded. A parameter that does not decode to UTF-8
// fails the way decodeURIComponent does: Express's 400 page. (A malformed escape such as
// "%A/" never gets here: net/http rejects the request line with its own 400.)
func withParam(name string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw := chi.URLParam(r, name)
		v := raw
		if r.URL.RawPath != "" {
			var err error
			if v, err = url.PathUnescape(raw); err != nil {
				httpx.HTMLError(w, http.StatusBadRequest, "URIError: Failed to decode param '"+raw+"'")
				return
			}
		} else {
			raw = url.PathEscape(raw)
		}
		if !utf8.ValidString(v) {
			httpx.HTMLError(w, http.StatusBadRequest, "URIError: Failed to decode param '"+raw+"'")
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), paramKey(name), v)))
	}
}

// param is a path parameter decoded by withParam (`String(req.params.x ?? "")`).
func param(r *http.Request, name string) string {
	v, _ := r.Context().Value(paramKey(name)).(string)
	return v
}

// queryNumber is Number(req.query[key]): NaN when absent; repeated keys form an array,
// whose Number() is that of the comma-joined values.
func queryNumber(r *http.Request, key string) float64 {
	vals := r.URL.Query()[key]
	switch len(vals) {
	case 0:
		return math.NaN()
	case 1:
		return jsNumberFromString(vals[0])
	}
	items := make([]any, len(vals))
	for i, v := range vals {
		items[i] = v
	}
	return jsNumberFromString(jsString(items))
}

type okStatus struct {
	OK     bool       `json:"ok"`
	Status StatusView `json:"status"`
}

func (h *routes) status(w http.ResponseWriter, _ *http.Request) {
	httpx.JSON(w, http.StatusOK, h.eng.GetStatus())
}

func (h *routes) start(w http.ResponseWriter, _ *http.Request) {
	ok, msg := h.eng.Start()
	if !ok {
		httpx.JSON(w, http.StatusBadRequest, struct {
			Error  string     `json:"error"`
			Status StatusView `json:"status"`
		}{msg, h.eng.GetStatus()})
		return
	}
	httpx.JSON(w, http.StatusOK, okStatus{true, h.eng.GetStatus()})
}

func (h *routes) stop(w http.ResponseWriter, _ *http.Request) {
	h.eng.Stop()
	httpx.JSON(w, http.StatusOK, okStatus{true, h.eng.GetStatus()})
}

// strikeLevel takes { level: 1 | 2 | 3 }: the synthetic uses ATM ± level strikes only.
func (h *routes) strikeLevel(w http.ResponseWriter, r *http.Request) {
	if msg := h.eng.SetStrikeLevel(httpx.BodyObject(r)["level"]); msg != "" {
		httpx.Error(w, http.StatusBadRequest, msg)
		return
	}
	st := h.eng.GetStatus()
	httpx.JSON(w, http.StatusOK, struct {
		OK          bool       `json:"ok"`
		StrikeLevel int        `json:"strike_level"`
		Status      StatusView `json:"status"`
	}{true, st.StrikeLevel, st})
}

// settings takes { min_expected_net_profit?, safety_buffer?, max_open_positions? }
// (max_open_positions 0 = no limit). persisted false means storage was unavailable and
// the change is not saved yet.
func (h *routes) settings(w http.ResponseWriter, r *http.Request) {
	persisted, status, msg := h.eng.UpdateSettings(httpx.BodyObject(r))
	if msg != "" {
		httpx.Error(w, status, msg)
		return
	}
	httpx.JSON(w, http.StatusOK, struct {
		OK        bool       `json:"ok"`
		Persisted bool       `json:"persisted"`
		Status    StatusView `json:"status"`
	}{true, persisted, h.eng.GetStatus()})
}

func (h *routes) opportunities(w http.ResponseWriter, r *http.Request) {
	var limit *float64
	if n := queryNumber(r, "limit"); jsFinite(n) {
		limit = &n
	}
	opps := h.eng.GetOpportunities(limit)
	httpx.JSON(w, http.StatusOK, struct {
		Opportunities []*Opportunity `json:"opportunities"`
		Status        StatusView     `json:"status"`
	}{opps, h.eng.GetStatus()})
}

func jsFinite(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) }

func (h *routes) tradesOpen(w http.ResponseWriter, _ *http.Request) {
	dbOn := h.eng.GetStatus().DBEnabled
	httpx.JSON(w, http.StatusOK, struct {
		DBEnabled bool       `json:"db_enabled"`
		Open      []OpenView `json:"open"`
	}{dbOn, h.eng.GetOpenPositions()})
}

// tradesHistory lists closed paper trades, newest first. scope=today is served from memory.
func (h *routes) tradesHistory(w http.ResponseWriter, r *http.Request) {
	scope := "all"
	if v := r.URL.Query()["scope"]; len(v) == 1 && v[0] == "today" {
		scope = "today"
	}
	limit := historyBase
	if raw := queryNumber(r, "limit"); jsFinite(raw) && raw > 0 {
		limit = int(math.Min(math.Floor(raw), historyMax))
	}
	view, err := h.eng.GetHistory(scope, limit)
	if err != nil {
		fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, view)
}

// closeTrade closes one open paper position now, at the executable touch.
func (h *routes) closeTrade(w http.ResponseWriter, r *http.Request) {
	res := h.eng.CloseManually(param(r, "id"))
	if res.Status != 0 {
		httpx.Error(w, res.Status, res.Error)
		return
	}
	trade := toTradeView(res.Trade)
	open := h.eng.GetOpenPositions()
	httpx.JSON(w, http.StatusOK, struct {
		OK     bool       `json:"ok"`
		Trade  TradeView  `json:"trade"`
		Open   []OpenView `json:"open"`
		Status StatusView `json:"status"`
	}{true, trade, open, h.eng.GetStatus()})
}

// deleteTrade soft-deletes a PAPER trade (open or closed). Full admin only. Body:
// { reason?, expected_status?: "open" | "closed" }. Retrying one is safe. The response
// carries the corrected state so the page updates without a reload.
func (h *routes) deleteTrade(w http.ResponseWriter, r *http.Request) {
	token := httpx.AdminToken(r)
	if h.roleOf(token) != auth.RoleFull {
		httpx.Error(w, http.StatusForbidden, "Full administrator access required.")
		return
	}
	guard(func(w http.ResponseWriter, r *http.Request) {
		id := param(r, "id")
		body := httpx.BodyObject(r)
		var reason *string
		if s, isStr := body["reason"].(string); isStr && jsTrim(s) != "" {
			v := utf16Prefix(jsTrim(s), 500)
			reason = &v
		}
		// The status the operator saw when confirming. A trade that changed state in the
		// meantime is refused, not deleted.
		expected := ""
		if s, isStr := body["expected_status"].(string); isStr && (s == "open" || s == "closed") {
			expected = s
		}
		actor := string(h.roleOf(token))
		if actor == "" {
			actor = "admin"
		}
		res, err := h.eng.DeleteTrade(id, reason, actor, expected)
		if err != nil {
			fail(w, err)
			return
		}
		if !res.OK {
			httpx.Error(w, res.Status, res.Error)
			return
		}
		today, err := h.eng.GetHistory("today", historyMax)
		if err != nil {
			fail(w, err)
			return
		}
		status := h.eng.GetStatus()
		open := h.eng.GetOpenPositions()
		httpx.JSON(w, http.StatusOK, struct {
			OK             bool        `json:"ok"`
			DeletedID      string      `json:"deleted_id"`
			DeletedFrom    string      `json:"deleted_from"`
			AlreadyDeleted bool        `json:"already_deleted"`
			Status         StatusView  `json:"status"`
			Open           []OpenView  `json:"open"`
			ClosedToday    []TradeView `json:"closed_today"`
		}{true, id, res.From, res.Already, status, open, today.Trades})
	})(w, r)
}

func (h *routes) chain(w http.ResponseWriter, r *http.Request) {
	u := jsToUpper(param(r, "underlying"))
	view := h.eng.GetChain(u)
	if view == nil {
		httpx.Error(w, http.StatusNotFound, u+" is not being monitored.")
		return
	}
	httpx.JSON(w, http.StatusOK, view)
}

// streamToken is `headers["x-admin-token"] ?? query["x-admin-token"]`: the header wins
// whenever it is present (even empty); the query value counts only as a single string.
func streamToken(r *http.Request) string {
	if vals := r.Header.Values("X-Admin-Token"); len(vals) > 0 {
		return httpx.AdminToken(r)
	}
	if q := r.URL.Query()["x-admin-token"]; len(q) == 1 {
		return q[0]
	}
	return ""
}

// stream is the SSE endpoint. The role is checked at connect only: an expired token
// keeps streaming until the client goes away. Engine.Dispose ends every stream (after
// its last snapshot); Stop does not.
func (h *routes) stream(w http.ResponseWriter, r *http.Request) {
	if h.roleOf(streamToken(r)) == auth.RoleNone {
		httpx.Error(w, http.StatusForbidden, "Admin authentication required")
		return
	}
	flusher, canFlush := w.(http.Flusher)
	// A stream outlives any per-request write deadline the server sets.
	_ = http.NewResponseController(w).SetWriteDeadline(time.Time{})
	hdr := w.Header()
	hdr.Set("Content-Type", "text/event-stream")
	hdr.Set("Cache-Control", "no-cache")
	hdr.Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flush := func() {
		if canFlush {
			flusher.Flush()
		}
	}
	flush()

	client, remove := h.eng.addSSEClient()
	defer remove()
	ping := time.NewTicker(h.ping)
	defer ping.Stop()
	write := func() bool {
		frames := client.take()
		for _, frame := range frames {
			if _, err := w.Write(frame); err != nil {
				return false
			}
		}
		if len(frames) > 0 {
			flush()
		}
		return true
	}
	for {
		select {
		case <-r.Context().Done():
			return
		case <-client.ended:
			write() // the frames queued before the end (Dispose publishes a last snapshot)
			return
		case <-client.notify:
			if !write() {
				return
			}
		case <-ping.C:
			if _, err := w.Write([]byte(": ping\n\n")); err != nil {
				return
			}
			flush()
		}
	}
}
