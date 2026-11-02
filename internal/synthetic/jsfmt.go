package synthetic

import (
	"bytes"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
)

// JavaScript-compatible helpers the Synthetic port needs beyond internal/jsx: Number()
// on decoded JSON values, String(number), String.prototype.trim, UTF-16 slicing,
// toLocaleString("en-IN") for whole rupees, and String.prototype.localeCompare as ICU
// (CLDR root) orders the characters that occur in instrument symbols and keys.

// encodeJS marshals v exactly like JSON.stringify (internal/fairvalue/jsjson): no HTML
// escaping, NaN and the infinities as null, -0 as 0, JavaScript number formatting and
// no trailing newline. It never fails; the error is kept for the callers' signatures.
func encodeJS(v any) ([]byte, error) {
	return jsjson.Marshal(v), nil
}

// objWriter writes a JSON object with keys in a chosen order (JavaScript insertion
// order), which Go maps cannot express.
type objWriter struct {
	buf   bytes.Buffer
	count int
	err   error
}

func (w *objWriter) field(key string, v any) {
	if w.err != nil {
		return
	}
	b, err := encodeJS(v)
	if err != nil {
		w.err = err
		return
	}
	w.raw(key, b)
}

func (w *objWriter) raw(key string, b []byte) {
	if w.count == 0 {
		w.buf.WriteByte('{')
	} else {
		w.buf.WriteByte(',')
	}
	w.count++
	k, _ := encodeJS(key)
	w.buf.Write(k)
	w.buf.WriteByte(':')
	w.buf.Write(b)
}

func (w *objWriter) bytes() ([]byte, error) {
	if w.err != nil {
		return nil, w.err
	}
	if w.count == 0 {
		return []byte("{}"), nil
	}
	w.buf.WriteByte('}')
	return w.buf.Bytes(), nil
}

// isJSWhite reports the characters String.prototype.trim removes (WhiteSpace and
// LineTerminator in ECMA-262).
func isJSWhite(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// jsTrim is String.prototype.trim.
func jsTrim(s string) string { return strings.TrimFunc(s, isJSWhite) }

// jsToUpper is String.prototype.toUpperCase for instrument symbols: Unicode upper-casing,
// plus the one special casing ECMAScript applies to Latin text (ß becomes SS).
func jsToUpper(s string) string {
	return strings.ReplaceAll(strings.ToUpper(s), "ß", "SS")
}

// utf16Prefix is s.slice(0, n): the first n UTF-16 code units. A surrogate pair cut in
// half leaves a lone surrogate, which a UTF-8 string cannot hold; it becomes U+FFFD,
// as the database driver would have stored it.
func utf16Prefix(s string, n int) string {
	units := utf16.Encode([]rune(s))
	if len(units) <= n {
		return s
	}
	return string(utf16.Decode(units[:n]))
}

// jsNumberFromString is Number(string).
func jsNumberFromString(s string) float64 {
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

// jsNumber is Number(v) for a decoded JSON value (or a Go number).
func jsNumber(v any) float64 {
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
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case string:
		return jsNumberFromString(x)
	case []any:
		// Number(array) is Number(String(array)): the elements joined with ",".
		return jsNumberFromString(jsString(x))
	}
	return math.NaN() // objects: String({}) is "[object Object]"
}

// jsString is String(v) for a decoded JSON value.
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
		return jsNumberString(x)
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

// shortestDigits returns the shortest round-trip decimal digits of |x| (x finite and
// non-zero) and n, the position of the decimal point: |x| = 0.d1d2... × 10^n.
func shortestDigits(x float64) (string, int) {
	s := strconv.FormatFloat(math.Abs(x), 'e', -1, 64) // d.ddde±XX
	mant, exp, _ := strings.Cut(s, "e")
	e, _ := strconv.Atoi(exp)
	return strings.Replace(mant, ".", "", 1), e + 1
}

// jsNumberString is Number.prototype.toString() (and template-literal formatting).
func jsNumberString(x float64) string {
	switch {
	case math.IsNaN(x):
		return "NaN"
	case math.IsInf(x, 1):
		return "Infinity"
	case math.IsInf(x, -1):
		return "-Infinity"
	case x == 0:
		return "0"
	}
	sign := ""
	if x < 0 {
		sign = "-"
	}
	digits, n := shortestDigits(x)
	k := len(digits)
	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}
	e := n - 1
	es := "+" + strconv.Itoa(e)
	if e < 0 {
		es = strconv.Itoa(e)
	}
	if k == 1 {
		return sign + digits + "e" + es
	}
	return sign + digits[:1] + "." + digits[1:] + "e" + es
}

// formatRoundedENIN is Math.round(x).toLocaleString("en-IN"): whole rupees with Indian
// digit grouping (12,34,567). Math.round of a value in [-0.5, 0) is -0, printed "-0";
// NaN prints "NaN" and the infinities "∞" / "-∞", as ICU does.
func formatRoundedENIN(x float64) string {
	switch {
	case math.IsNaN(x):
		return "NaN"
	case math.IsInf(x, 1):
		return "∞"
	case math.IsInf(x, -1):
		return "-∞"
	}
	r := jsx.Round(x)
	neg := r < 0 || (r == 0 && (x < 0 || math.Signbit(x)))
	if r == 0 {
		if neg {
			return "-0"
		}
		return "0"
	}
	digits, n := shortestDigits(r)
	if len(digits) < n {
		digits += strings.Repeat("0", n-len(digits))
	}
	var out string
	if len(digits) <= 3 {
		out = digits
	} else {
		head, tail := digits[:len(digits)-3], digits[len(digits)-3:]
		var groups []string
		for len(head) > 2 {
			groups = append([]string{head[len(head)-2:]}, groups...)
			head = head[:len(head)-2]
		}
		if head != "" {
			groups = append([]string{head}, groups...)
		}
		out = strings.Join(groups, ",") + "," + tail
	}
	if neg {
		return "-" + out
	}
	return out
}

/* ------------------------------ localeCompare ------------------------------ */

// localeCompare is a.localeCompare(b) with Node's default (ICU root) collation:
// primary weights first, then case; -1, 0 or 1 (jsx.LocaleCompare, checked against
// Node on 40,000+ pairs).
func localeCompare(a, b string) int { return jsx.LocaleCompare(a, b) }

// jsDateParseDayAt10Z is Date.parse(`${day}T10:00:00Z`) for the YYYY-MM-DD form V8 accepts
// (month 1-12, day 1-31, overflow rolled into the next month). ok is false for NaN.
func jsDateParseDayAt10Z(day string) (ms int64, ok bool) {
	if len(day) != 10 || day[4] != '-' || day[7] != '-' {
		return 0, false
	}
	num := func(s string) (int, bool) {
		n := 0
		for i := 0; i < len(s); i++ {
			if s[i] < '0' || s[i] > '9' {
				return 0, false
			}
			n = n*10 + int(s[i]-'0')
		}
		return n, true
	}
	y, ok1 := num(day[0:4])
	m, ok2 := num(day[5:7])
	d, ok3 := num(day[8:10])
	if !ok1 || !ok2 || !ok3 || m < 1 || m > 12 || d < 1 || d > 31 {
		return 0, false
	}
	// time.Date carries day overflow into the next month, as ECMAScript MakeDay does.
	return time.Date(y, time.Month(m), d, 10, 0, 0, 0, time.UTC).UnixMilli(), true
}
