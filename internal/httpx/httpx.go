// Package httpx is the HTTP plumbing shared by every route: JSON responses, the body
// parser, CORS, the rate limiter and Express-compatible error pages. It reproduces what
// the Node server did so clients see the same statuses, headers and bodies.
package httpx

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"strings"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
)

// JSON writes v as a compact JSON response, the way Express's res.json does: the
// JSON.stringify encoding (internal/fairvalue/jsjson), so NaN and the infinities become
// null, -0 becomes 0, numbers use JavaScript's formatting, nil slices are [] and nothing
// is HTML-escaped. There is no trailing newline. omitempty follows encoding/json.
func JSON(w http.ResponseWriter, status int, v any) {
	b := jsjson.Marshal(v)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

// RawJSON writes body, already JSON text, with the JSON content type.
func RawJSON(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// Error writes {"error": msg} with the given status.
func Error(w http.ResponseWriter, status int, msg string) {
	JSON(w, status, map[string]string{"error": msg})
}

// HTMLError writes the plain HTML error page Express's default handler produces. The
// Node server had no JSON error handler, so malformed bodies, oversized bodies and unknown
// routes answer with this.
func HTMLError(w http.ResponseWriter, status int, msg string) {
	body := "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>" +
		html.EscapeString(msg) + "</pre>\n</body>\n</html>\n"
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Content-Security-Policy", "default-src 'none'")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

// NotFound is the handler for unknown routes: 404 "Cannot GET /path".
func NotFound(w http.ResponseWriter, r *http.Request) {
	HTMLError(w, http.StatusNotFound, "Cannot "+r.Method+" "+r.URL.Path)
}

// Recoverer turns a panic into a 500 error page instead of dropping the connection.
func Recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				if rec == http.ErrAbortHandler {
					panic(rec)
				}
				log.Printf("[http] panic serving %s %s: %v", r.Method, r.URL.Path, rec)
				HTMLError(w, http.StatusInternalServerError, "Internal Server Error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// CORS answers every response with the single configured frontend origin and
// Cache-Control: no-store, and answers OPTIONS on any path with 204 straight away.
// PATCH is allowed (the Node list omitted it, which broke PATCH /api/fair-value/config
// cross-origin).
func CORS(origin string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Content-Type, x-admin-token")
			h.Set("Access-Control-Allow-Credentials", "true")
			h.Set("Cache-Control", "no-store")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// ClientIP is the rate-limit key: the first entry of X-Forwarded-For if present (trusted
// unconditionally, as in Node), else the peer address, else "unknown".
func ClientIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		if first := strings.TrimSpace(strings.SplitN(fwd, ",", 2)[0]); first != "" {
			return first
		}
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil && host != "" {
		return host
	}
	if r.RemoteAddr != "" {
		return r.RemoteAddr
	}
	return "unknown"
}

// AdminToken reads the x-admin-token header. Repeated headers are joined with ", " like
// Node does, so a repeated header never matches a stored token.
func AdminToken(r *http.Request) string {
	return strings.Join(r.Header.Values("X-Admin-Token"), ", ")
}

// MaxBodyBytes is express.json()'s default limit (100 kB).
const MaxBodyBytes = 100 * 1024

type bodyKey struct{}

// ParseBody is express.json(): for application/json requests with a body it reads up to
// 100 kB, accepts only a top-level object or array, and stores the result for Body.
// Bad JSON answers 400 and an oversized body 413, both as HTML error pages.
func ParseBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isJSONContent(r.Header.Get("Content-Type")) || r.Body == nil || r.Body == http.NoBody {
			next.ServeHTTP(w, r)
			return
		}
		if r.ContentLength > MaxBodyBytes {
			HTMLError(w, http.StatusRequestEntityTooLarge, "PayloadTooLargeError: request entity too large")
			return
		}
		raw, err := io.ReadAll(io.LimitReader(r.Body, MaxBodyBytes+1))
		if err != nil {
			HTMLError(w, http.StatusBadRequest, "BadRequestError: request aborted")
			return
		}
		if len(raw) > MaxBodyBytes {
			HTMLError(w, http.StatusRequestEntityTooLarge, "PayloadTooLargeError: request entity too large")
			return
		}
		trimmed := bytes.TrimLeft(raw, " \t\r\n")
		if len(trimmed) == 0 {
			// body-parser treats an empty JSON body as {}.
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), bodyKey{}, map[string]any{})))
			return
		}
		if trimmed[0] != '{' && trimmed[0] != '[' {
			HTMLError(w, http.StatusBadRequest, fmt.Sprintf("SyntaxError: Unexpected token '%c', body is not valid JSON", trimmed[0]))
			return
		}
		var v any
		if err := json.Unmarshal(raw, &v); err != nil {
			HTMLError(w, http.StatusBadRequest, "SyntaxError: "+err.Error())
			return
		}
		ctx := context.WithValue(r.Context(), bodyKey{}, v)
		ctx = context.WithValue(ctx, rawBodyKey{}, raw)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func isJSONContent(ct string) bool {
	if ct == "" {
		return false
	}
	mt, _, err := mime.ParseMediaType(ct)
	return err == nil && mt == "application/json"
}

// Body returns the parsed JSON body, or nil when the request had none (req.body is
// undefined in Express 5).
func Body(r *http.Request) any { return r.Context().Value(bodyKey{}) }

type rawBodyKey struct{}

// RawBody returns the exact bytes of a parsed, non-empty JSON body (nil when there was
// none, including the empty body that Body reports as {}). Handlers that need
// JSON.parse semantics Go maps cannot give, such as key order, parse these bytes.
func RawBody(r *http.Request) []byte {
	b, _ := r.Context().Value(rawBodyKey{}).([]byte)
	return b
}

// BodyObject returns the body when it is a JSON object, else an empty map, which is what
// handlers written as `req.body ?? {}` / `req.body?.x` effectively see.
func BodyObject(r *http.Request) map[string]any {
	if m, ok := Body(r).(map[string]any); ok {
		return m
	}
	return map[string]any{}
}
