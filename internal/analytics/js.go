package analytics

import (
	"math"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
)

// JavaScript semantics the port depends on: Map insertion order, string ordering and
// slicing by UTF-16 code units, String.prototype.trim/toUpperCase, Number(), and the
// Express 5 request parsing (node:querystring for req.query, decoded req.params).

// omap is a JavaScript Map: iteration in insertion order, re-setting a key keeps its
// position, deleting and re-adding moves it to the end.
type omap[K comparable, V any] struct {
	keys  []K
	alive []bool
	pos   map[K]int
	vals  map[K]V
	dead  int
}

func newOmap[K comparable, V any]() *omap[K, V] {
	return &omap[K, V]{pos: map[K]int{}, vals: map[K]V{}}
}

func (m *omap[K, V]) Get(k K) (V, bool) { v, ok := m.vals[k]; return v, ok }

func (m *omap[K, V]) Has(k K) bool { _, ok := m.vals[k]; return ok }

func (m *omap[K, V]) Len() int { return len(m.vals) }

func (m *omap[K, V]) Set(k K, v V) {
	if _, ok := m.vals[k]; !ok {
		m.pos[k] = len(m.keys)
		m.keys = append(m.keys, k)
		m.alive = append(m.alive, true)
	}
	m.vals[k] = v
}

func (m *omap[K, V]) Delete(k K) {
	i, ok := m.pos[k]
	if !ok {
		return
	}
	delete(m.pos, k)
	delete(m.vals, k)
	m.alive[i] = false
	m.dead++
	if m.dead > 32 && m.dead*2 > len(m.keys) {
		m.compact()
	}
}

func (m *omap[K, V]) compact() {
	keys := make([]K, 0, len(m.vals))
	for i, k := range m.keys {
		if m.alive[i] {
			m.pos[k] = len(keys)
			keys = append(keys, k)
		}
	}
	m.keys = keys
	m.alive = make([]bool, len(keys))
	for i := range m.alive {
		m.alive[i] = true
	}
	m.dead = 0
}

// Keys returns the live keys in insertion order.
func (m *omap[K, V]) Keys() []K {
	out := make([]K, 0, len(m.vals))
	for i, k := range m.keys {
		if m.alive[i] {
			out = append(out, k)
		}
	}
	return out
}

// Values returns the values in key order.
func (m *omap[K, V]) Values() []V {
	out := make([]V, 0, len(m.vals))
	for i, k := range m.keys {
		if m.alive[i] {
			out = append(out, m.vals[k])
		}
	}
	return out
}

// cmpUTF16 compares strings by UTF-16 code units, as JavaScript's < and the default
// Array.prototype.sort do. It differs from Go's byte order only for characters above
// U+FFFF against U+E000-U+FFFF.
func cmpUTF16(a, b string) int {
	for a != "" && b != "" {
		ra, na := utf8.DecodeRuneInString(a)
		rb, nb := utf8.DecodeRuneInString(b)
		if ra != rb {
			ua, ub := firstUnit(ra), firstUnit(rb)
			if ua != ub {
				if ua < ub {
					return -1
				}
				return 1
			}
			// Same high surrogate: compare the low ones.
			if ra < rb {
				return -1
			}
			return 1
		}
		a, b = a[na:], b[nb:]
	}
	switch {
	case a == "" && b == "":
		return 0
	case a == "":
		return -1
	}
	return 1
}

func firstUnit(r rune) rune {
	if r >= 0x10000 {
		hi, _ := utf16.EncodeRune(r)
		return hi
	}
	return r
}

// jsSortStrings is the default Array.prototype.sort on strings.
func jsSortStrings(s []string) {
	sort.SliceStable(s, func(i, j int) bool { return cmpUTF16(s[i], s[j]) < 0 })
}

// sliceUTF16 is s.slice(0, n) for ASCII-dominated strings: the first n UTF-16 code units.
// A surrogate pair cut in half becomes U+FFFD (a UTF-8 string cannot hold the lone half).
func sliceUTF16(s string, n int) string {
	units := 0
	for i, r := range s {
		w := 1
		if r >= 0x10000 {
			w = 2
		}
		if units+w > n {
			if units < n { // half a pair fits
				return s[:i] + "\uFFFD"
			}
			return s[:i]
		}
		units += w
	}
	return s
}

// isJSWhite reports the characters String.prototype.trim removes.
func isJSWhite(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

func jsTrim(s string) string { return strings.TrimFunc(s, isJSWhite) }

// jsToUpper is String.prototype.toUpperCase: Unicode upper-casing plus the special
// casings ECMAScript applies to Latin text (ß and the ligatures expand).
func jsToUpper(s string) string {
	u := strings.ToUpper(s)
	if !strings.ContainsAny(u, "ßﬀﬁﬂﬃﬄﬅﬆ") {
		return u
	}
	return strings.NewReplacer("ß", "SS", "ﬀ", "FF", "ﬁ", "FI", "ﬂ", "FL", "ﬃ", "FFI", "ﬄ", "FFL", "ﬅ", "ST", "ﬆ", "ST").Replace(u)
}

// jsNumberString is Number(string): JavaScript whitespace trimmed, "" is 0, otherwise the
// numeric literal forms Number accepts, else NaN.
func jsNumberString(s string) float64 {
	t := jsTrim(s)
	if t == "" {
		return 0
	}
	n, ok := jsx.ParseNumber(t)
	if !ok {
		return math.NaN()
	}
	return n
}

// fmtNum is String(x) for a number (template literals in log lines).
func fmtNum(x float64) string { return jsjson.FormatNumber(x) }

// errText is `e instanceof Error ? e.message : e` for a log line.
func errText(err error) string {
	if err == nil {
		return "undefined"
	}
	return err.Error()
}

// nodeQuery parses a raw query string the way node:querystring does (Express 5's
// "simple" query parser): pairs split on "&", the first "=" separates key and value, "+"
// is a space, percent escapes are decoded leniently (an invalid escape stays as typed),
// repeated keys collect their values in order. At most 1000 pairs are read.
func nodeQuery(raw string) map[string][]string {
	out := map[string][]string{}
	if raw == "" {
		return out
	}
	pairs := strings.Split(raw, "&")
	if len(pairs) > 1000 {
		pairs = pairs[:1000]
	}
	for _, p := range pairs {
		if p == "" {
			continue
		}
		k, v, _ := strings.Cut(p, "=")
		key := qsUnescape(k)
		out[key] = append(out[key], qsUnescape(v))
	}
	return out
}

// qsUnescape is querystring.unescape with "+" decoded as a space.
func qsUnescape(s string) string {
	s = strings.ReplaceAll(s, "+", " ")
	if !strings.Contains(s, "%") {
		return s
	}
	if d, err := url.PathUnescape(s); err == nil && utf8.ValidString(d) {
		return d
	}
	// unescapeBuffer: decode the valid %XX escapes, keep the rest, then read as UTF-8.
	b := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) && isHex(s[i+1]) && isHex(s[i+2]) {
			b = append(b, unhex(s[i+1])<<4|unhex(s[i+2]))
			i += 2
			continue
		}
		b = append(b, s[i])
	}
	return strings.ToValidUTF8(string(b), "\uFFFD")
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

// queryValue is req.query[key]: absent (ok false), one string, or several (an array).
func queryValue(r *http.Request, key string) ([]string, bool) {
	v, ok := nodeQuery(r.URL.RawQuery)[key]
	return v, ok
}

// queryString is String(req.query[key] ?? def): an array joins with ",".
func queryString(r *http.Request, key, def string) string {
	v, ok := queryValue(r, key)
	if !ok {
		return def
	}
	return strings.Join(v, ",")
}

// queryNumber is Number(req.query[key] ?? def).
func queryNumber(r *http.Request, key string, def float64) float64 {
	v, ok := queryValue(r, key)
	if !ok {
		return def
	}
	return jsNumberString(strings.Join(v, ","))
}

// pathParam is Express's decoded req.params value. chi routes on the escaped path when the
// request has one, so its parameters are then still percent-encoded. decodeURIComponent
// fails (Express answers 400 "Failed to decode param") when the escapes do not form UTF-8;
// an escape that is not %XX at all never reaches a handler (net/http rejects the request).
func pathParam(w http.ResponseWriter, r *http.Request, name string) (string, bool) {
	raw := chi.URLParam(r, name)
	v := raw
	if r.URL.RawPath != "" {
		var err error
		if v, err = url.PathUnescape(raw); err != nil {
			httpx.HTMLError(w, http.StatusBadRequest, "URIError: Failed to decode param '"+raw+"'")
			return "", false
		}
	}
	if !utf8.ValidString(v) {
		if r.URL.RawPath == "" {
			raw = url.PathEscape(v)
		}
		httpx.HTMLError(w, http.StatusBadRequest, "URIError: Failed to decode param '"+raw+"'")
		return "", false
	}
	return v, true
}

// jsIndexKey reports whether a non-negative integer token is an array-index property
// key (0 .. 2^32-2), which JavaScript enumerates first in ascending order.
func jsIndexKey(tok int64) bool { return tok >= 0 && tok <= 4294967294 }

// jsTokenOrder orders integer object keys the way JavaScript enumerates them: array-index
// keys ascending, then the others in insertion order (the order given).
func jsTokenOrder(tokens []int64) []int64 {
	out := make([]int64, 0, len(tokens))
	var rest []int64
	for _, t := range tokens {
		if jsIndexKey(t) {
			out = append(out, t)
		} else {
			rest = append(rest, t)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i] < out[j] })
	return append(out, rest...)
}
