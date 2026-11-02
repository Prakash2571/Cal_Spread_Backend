package core

import (
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	kjson "github.com/Prakash2571/Cal_Spread_Backend/internal/kite/jsjson"
)

// redirect is Express 5.2.1 res.redirect(url): 302 with the encodeurl'd Location, a
// body chosen by content negotiation between text/plain and text/html (res.format, which
// also sets Vary: Accept), and an empty body without a Content-Type when the client
// accepts neither. HEAD gets the headers only.
func redirect(w http.ResponseWriter, r *http.Request, target string) {
	address := encodeURL(target)
	h := w.Header()
	h.Set("Location", address)
	h.Set("Vary", "Accept")
	var body string
	accept, _ := joinedHeader(r, "Accept")
	switch negotiateTextHTML(accept) {
	case "text":
		h.Set("Content-Type", "text/plain; charset=utf-8")
		body = "Found. Redirecting to " + address
	case "html":
		h.Set("Content-Type", "text/html; charset=utf-8")
		body = "<p>Found. Redirecting to " + escapeHTML(address) + "</p>"
	}
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusFound)
	if r.Method != http.MethodHead {
		_, _ = io.WriteString(w, body)
	}
}

// encodeURL is the encodeurl 2.0.0 package (res.location): every character outside the
// URL-safe set is percent-encoded with encodeURI, and a "%" that does not start a valid
// escape is encoded together with the character(s) the library's pattern consumes after
// it. Already-encoded sequences are left alone.
func encodeURL(s string) string {
	s = strings.ToValidUTF8(s, "\uFFFD") // unpaired surrogates become U+FFFD first
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == '%' {
			j := i + 1
			if j >= len(s) { // "%" at the end
				b.WriteString("%25")
				i = j
				continue
			}
			r1, s1 := utf8.DecodeRuneInString(s[j:])
			if !isHexRune(r1) { // "%" + a non-hex character
				b.WriteString("%25")
				b.WriteString(encodeURIRune(r1))
				i = j + s1
				continue
			}
			k := j + s1
			if k < len(s) {
				if r2, s2 := utf8.DecodeRuneInString(s[k:]); !isHexRune(r2) { // "%" + hex + non-hex
					b.WriteString("%25")
					b.WriteRune(r1)
					b.WriteString(encodeURIRune(r2))
					i = k + s2
					continue
				}
			}
			// A valid escape, or "%X" at the very end: the pattern does not match "%".
			b.WriteByte('%')
			i = j
			continue
		}
		if urlSafe(r) {
			b.WriteRune(r)
		} else {
			b.WriteString(encodeURIRune(r))
		}
		i += size
	}
	return b.String()
}

func isHexRune(r rune) bool { return r < utf8.RuneSelf && isHex(byte(r)) }

// urlSafe is encodeurl's allowed set: [\x21\x23-\x3B\x3D\x3F-\x5F\x61-\x7A\x7C\x7E].
func urlSafe(r rune) bool {
	return r == 0x21 || (r >= 0x23 && r <= 0x3B) || r == 0x3D || (r >= 0x3F && r <= 0x5F) ||
		(r >= 0x61 && r <= 0x7A) || r == 0x7C || r == 0x7E
}

// encodeURIRune is encodeURI for one code point.
func encodeURIRune(r rune) string {
	if r < utf8.RuneSelf {
		c := byte(r)
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
			strings.IndexByte(";,/?:@&=+$-_.!~*'()#", c) >= 0 {
			return string(c)
		}
	}
	var buf [utf8.UTFMax]byte
	n := utf8.EncodeRune(buf[:], r)
	var sb strings.Builder
	for _, c := range buf[:n] {
		fmt.Fprintf(&sb, "%%%02X", c)
	}
	return sb.String()
}

// escapeHTML is the escape-html package.
func escapeHTML(s string) string {
	return strings.NewReplacer(`"`, "&quot;", "&", "&amp;", "'", "&#39;", "<", "&lt;", ">", "&gt;").Replace(s)
}

// negotiateTextHTML is req.accepts(["text", "html"]) (accepts 2.0.0 over negotiator
// 1.1.0): "text" when the Accept header is absent or empty; otherwise the acceptable
// type with the highest quality, then the most specific match, then the earlier Accept
// entry, then the order given; "" when neither text/plain nor text/html is acceptable.
func negotiateTextHTML(accept string) string {
	if accept == "" {
		return "text"
	}
	specs := parseAccept(accept)
	provided := []struct{ name, typ, sub string }{{"text", "text", "plain"}, {"html", "text", "html"}}
	type prio struct {
		i, o, s int
		q       float64
	}
	var ok []prio
	for idx, p := range provided {
		best := prio{i: idx, o: -1}
		for _, sp := range specs {
			s := 0
			switch {
			case strings.EqualFold(sp.typ, p.typ):
				s |= 4
			case sp.typ != "*":
				continue
			}
			switch {
			case strings.EqualFold(sp.sub, p.sub):
				s |= 2
			case sp.sub != "*":
				continue
			}
			if len(sp.params) > 0 {
				match := true
				for _, v := range sp.params {
					// The provided types carry no parameters, so only "*" and "" match.
					if v != "*" && v != "" {
						match = false
						break
					}
				}
				if !match {
					continue
				}
				s |= 1
			}
			if replaces(best.s, best.o, best.q, s, sp.i, sp.q) {
				best = prio{i: idx, o: sp.i, s: s, q: sp.q}
			}
		}
		if best.q > 0 {
			ok = append(ok, best)
		}
	}
	if len(ok) == 0 {
		return ""
	}
	sort.SliceStable(ok, func(a, b int) bool {
		x, y := ok[a], ok[b]
		if x.q != y.q {
			return x.q > y.q
		}
		if x.s != y.s {
			return x.s > y.s
		}
		if x.o != y.o {
			return x.o < y.o
		}
		return x.i < y.i
	})
	return provided[ok[0].i].name
}

// replaces is getMediaTypePriority's test for a better match:
// (priority.s - spec.s || priority.q - spec.q || priority.o - spec.o) < 0, where a zero
// or NaN difference falls through to the next one as `||` does in JavaScript.
func replaces(curS, curO int, curQ float64, s, o int, q float64) bool {
	if d := curS - s; d != 0 {
		return d < 0
	}
	if d := curQ - q; d != 0 && !math.IsNaN(d) {
		return d < 0
	}
	return curO-o < 0
}

type acceptSpec struct {
	typ, sub string            // original casing
	params   map[string]string // lower-cased keys, first occurrence wins, q removed
	q        float64
	i        int // position among the comma-separated entries
}

func isOWS(c byte) bool { return c == ' ' || c == '\t' }

func skipOWS(h string, i int) int {
	for i < len(h) && isOWS(h[i]) {
		i++
	}
	return i
}

func trailingOWS(h string, start, end int) int {
	for end > start && isOWS(h[end-1]) {
		end--
	}
	return end
}

// skipValue advances to the next ';' or ',' (or the end).
func skipValue(h string, i int) int {
	for i < len(h) && h[i] != ';' && h[i] != ',' {
		i++
	}
	return i
}

// parseAccept is negotiator 1.1.0 parseAccept over content-type 2.1.0's comma-aware
// parse: each entry is "type/subtype" with optional ";key=value" parameters (quoted
// values with backslash escapes), entries without a "/" are dropped but keep their
// position, and q defaults to 1 (an empty q is 1, parseFloat otherwise).
func parseAccept(h string) []acceptSpec {
	var out []acceptSpec
	entry := 0
	for i := 0; i < len(h); entry++ {
		start := skipOWS(h, i)
		end := skipValue(h, start)
		typ := h[start:trailingOWS(h, start, end)]
		params, next := parseParams(h, end)
		if slash := strings.IndexByte(typ, '/'); slash >= 0 {
			q := 1.0
			if v := params["q"]; v != "" {
				q = jsParseFloat(v)
			}
			delete(params, "q")
			out = append(out, acceptSpec{typ: typ[:slash], sub: typ[slash+1:], params: params, q: q, i: entry})
		}
		i = next + 1
	}
	return out
}

// parseParams is content-type 2.1.0 parseParameters with ',' as the stop character. i
// points at the ';' after the type (or at ',' / the end). It returns the parameters and
// the index of the stopping ',' (or len(h)).
func parseParams(h string, i int) (map[string]string, int) {
	params := map[string]string{}
param:
	for i < len(h) {
		if h[i] == ',' {
			break
		}
		i = skipOWS(h, i+1) // over the ';'
		keyStart := i
		for i < len(h) {
			switch h[i] {
			case ',':
				break param
			case ';':
				continue param // a key without "=" is ignored
			case '=':
				key := strings.ToLower(h[keyStart:trailingOWS(h, keyStart, i)])
				i = skipOWS(h, i+1)
				if i < len(h) && h[i] == '"' {
					i++
					var val []byte
					for i < len(h) {
						c := h[i]
						i++
						if c == '"' {
							i = skipValue(h, i)
							if _, seen := params[key]; !seen {
								params[key] = string(val)
							}
							break
						}
						if c == '\\' && i < len(h) {
							val = append(val, h[i])
							i++
							continue
						}
						val = append(val, c)
					}
					continue param
				}
				valueStart := i
				i = skipValue(h, i)
				if _, seen := params[key]; !seen {
					params[key] = h[valueStart:trailingOWS(h, valueStart, i)]
				}
				continue param
			}
			i++
		}
	}
	return params, i
}

// jsParseFloat is parseFloat: the longest decimal prefix after leading whitespace, NaN
// when there is none.
func jsParseFloat(s string) float64 {
	s = strings.TrimLeftFunc(s, kjson.IsJSSpace)
	end := 0
	if end < len(s) && (s[end] == '+' || s[end] == '-') {
		end++
	}
	if strings.HasPrefix(s[end:], "Infinity") {
		return kjson.StringToNumber(s[:end+len("Infinity")])
	}
	digits := 0
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
		digits++
	}
	if end < len(s) && s[end] == '.' {
		end++
		for end < len(s) && s[end] >= '0' && s[end] <= '9' {
			end++
			digits++
		}
	}
	if digits == 0 {
		return math.NaN()
	}
	if end < len(s) && (s[end] == 'e' || s[end] == 'E') {
		k := end + 1
		if k < len(s) && (s[k] == '+' || s[k] == '-') {
			k++
		}
		if k < len(s) && s[k] >= '0' && s[k] <= '9' {
			for k < len(s) && s[k] >= '0' && s[k] <= '9' {
				k++
			}
			end = k
		}
	}
	return kjson.StringToNumber(s[:end])
}
