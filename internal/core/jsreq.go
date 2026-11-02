package core

import (
	"math"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
	kjson "github.com/Prakash2571/Cal_Spread_Backend/internal/kite/jsjson"
)

// This file reads requests the way the Express 5 handlers in index.ts saw them:
// req.query from node:querystring.parse, req.params decoded with decodeURIComponent,
// String()/Number() of JSON body fields, and req.headers with repeated headers joined.

// queryMaxKeys is node:querystring's default maxKeys: pairs after the 1000th are ignored.
const queryMaxKeys = 1000

// parseQuery is node:querystring.parse(raw) (Express 5's "simple" query parser). A key
// that occurs once maps to one value (a string in Node), a repeated key to several (an
// array). '+' is a space; %XX escapes are decoded and the bytes read as UTF-8 with
// U+FFFD for invalid sequences, while a malformed escape stays as written (Node's
// decodeURIComponent-then-unescapeBuffer fallback).
func parseQuery(raw string) map[string][]string {
	out := map[string][]string{}
	if raw == "" {
		return out
	}
	pairs := queryMaxKeys
	for _, pair := range strings.Split(raw, "&") {
		if pair == "" {
			// An empty substring between separators adds nothing but counts as a pair.
			if pairs--; pairs == 0 {
				return out
			}
			continue
		}
		key, value := pair, ""
		if i := strings.IndexByte(pair, '='); i >= 0 {
			key, value = pair[:i], pair[i+1:]
		}
		key, value = decodeQueryComponent(key), decodeQueryComponent(value)
		out[key] = append(out[key], value)
		if pairs--; pairs == 0 {
			return out
		}
	}
	return out
}

// decodeQueryComponent turns '+' into a space, decodes every well-formed %XX escape and
// reads the result as UTF-8 the way Buffer.toString() does.
func decodeQueryComponent(s string) string {
	if !strings.ContainsAny(s, "+%") {
		return s
	}
	b := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '+':
			b = append(b, ' ')
		case c == '%' && i+2 < len(s) && isHex(s[i+1]) && isHex(s[i+2]):
			b = append(b, unhex(s[i+1])<<4|unhex(s[i+2]))
			i += 2
		default:
			b = append(b, c)
		}
	}
	return decodeUTF8(b)
}

func isHex(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

func unhex(c byte) byte {
	switch {
	case c >= '0' && c <= '9':
		return c - '0'
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10
	}
	return c - 'A' + 10
}

// decodeUTF8 is the WHATWG UTF-8 decoder with replacement (what V8 and Buffer.toString
// use): each maximal invalid subpart becomes one U+FFFD. Go's own decoding would emit one
// U+FFFD per byte of a truncated sequence.
func decodeUTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	sb.Grow(len(b) + 8)
	needed, seen := 0, 0
	lower, upper := byte(0x80), byte(0xBF)
	cp := rune(0)
	for i := 0; i < len(b); i++ {
		c := b[i]
		if needed == 0 {
			switch {
			case c <= 0x7F:
				sb.WriteByte(c)
			case c >= 0xC2 && c <= 0xDF:
				needed, cp = 1, rune(c&0x1F)
			case c >= 0xE0 && c <= 0xEF:
				if c == 0xE0 {
					lower = 0xA0
				}
				if c == 0xED {
					upper = 0x9F
				}
				needed, cp = 2, rune(c&0x0F)
			case c >= 0xF0 && c <= 0xF4:
				if c == 0xF0 {
					lower = 0x90
				}
				if c == 0xF4 {
					upper = 0x8F
				}
				needed, cp = 3, rune(c&0x07)
			default:
				sb.WriteRune(utf8.RuneError)
			}
			continue
		}
		if c < lower || c > upper {
			needed, seen, cp = 0, 0, 0
			lower, upper = 0x80, 0xBF
			sb.WriteRune(utf8.RuneError)
			i-- // reprocess this byte as the start of a new sequence
			continue
		}
		lower, upper = 0x80, 0xBF
		cp = cp<<6 | rune(c&0x3F)
		if seen++; seen == needed {
			sb.WriteRune(cp)
			needed, seen, cp = 0, 0, 0
		}
	}
	if needed != 0 {
		sb.WriteRune(utf8.RuneError)
	}
	return sb.String()
}

// queryString is String(req.query[key] ?? ""): "" when absent, the value when given once,
// the values joined with "," when repeated (String of an array).
func queryString(q map[string][]string, key string) (value string, present bool) {
	vals, ok := q[key]
	if !ok {
		return "", false
	}
	return strings.Join(vals, ","), true
}

// joinedHeader is req.headers[name] for a header Node does not special-case: repeated
// headers are joined with ", ". present is false when the header is absent.
func joinedHeader(r *http.Request, name string) (value string, present bool) {
	vals := r.Header.Values(name)
	if len(vals) == 0 {
		return "", false
	}
	return strings.Join(vals, ", "), true
}

// readPasscode is tokenRouteAuth.ts readPasscode: the header when it is present (even
// empty; repeated headers arrive joined, as Node delivers them), else the query value
// when it occurs exactly once (a repeated parameter is an array, which is not a string).
func readPasscode(r *http.Request, header, query string) (value string, supplied bool) {
	if v, ok := joinedHeader(r, header); ok {
		return v, true
	}
	if vals := parseQuery(r.URL.RawQuery)[query]; len(vals) == 1 {
		return vals[0], true
	}
	return "", false
}

// pathParam is req.params[name] for a route whose parameter is its last segment (every
// parameter route here): the segment of the escaped path, decoded with
// decodeURIComponent semantics. ok is false when Express would have refused to decode it
// (a malformed escape or bytes that are not UTF-8), which Express answers with its 400
// error page. It reads r.URL rather than chi's route parameters, so it does not depend on
// whether chi matched the escaped or the decoded path (trailing-slash rewrites and
// sub-routers differ there).
func pathParam(r *http.Request, _ string) (value, raw string, ok bool) {
	p := strings.TrimSuffix(r.URL.EscapedPath(), "/") // Express matches one trailing slash
	raw = p[strings.LastIndexByte(p, '/')+1:]
	v, err := url.PathUnescape(raw)
	if err != nil {
		return raw, raw, false
	}
	return v, raw, utf8.ValidString(v)
}

// badParam answers like Express when a path parameter cannot be decoded.
func badParam(w http.ResponseWriter, raw string) {
	httpx.HTMLError(w, http.StatusBadRequest, "URIError: Failed to decode param '"+raw+"'")
}

// bodyField is req.body?.[key]: the field of a JSON object body. present is false when
// the body is missing, is an array, or lacks the key (JavaScript undefined).
func bodyField(r *http.Request, key string) (v any, present bool) {
	m, ok := httpx.Body(r).(map[string]any)
	if !ok {
		return nil, false
	}
	v, present = m[key]
	return v, present
}

// jsString is String(v) for a value decoded from JSON (null is "null").
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return kjson.FormatNumber(x)
	case string:
		return x
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e != nil { // null and undefined elements join as ""
				parts[i] = jsString(e)
			}
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}

// jsNumber is Number(v) for a value decoded from JSON; present=false is undefined (NaN).
func jsNumber(v any, present bool) float64 {
	if !present {
		return math.NaN()
	}
	switch x := v.(type) {
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case string:
		return kjson.StringToNumber(x)
	case []any:
		return kjson.StringToNumber(jsString(x))
	}
	return math.NaN()
}

// stringOrEmpty is String(v ?? "").
func stringOrEmpty(v any, present bool) string {
	if !present || v == nil {
		return ""
	}
	return jsString(v)
}
