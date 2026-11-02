package captures

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Small JavaScript-compatible helpers for the string and date handling the capture
// modules do inline. Inputs are ASCII in practice (dates, slots, Kite timestamps), so
// String.prototype.slice is byte slicing here.

// jsSlice is s.slice(start, end) for non-negative bounds.
func jsSlice(s string, start, end int) string {
	if end > len(s) {
		end = len(s)
	}
	if start >= end {
		return ""
	}
	return s[start:end]
}

// isJSWhite reports the characters String.prototype.trim and parseInt skip.
func isJSWhite(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\u1680', '\u2028', '\u2029',
		'\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	}
	return r >= '\u2000' && r <= '\u200a'
}

// jsParseInt10 is parseInt(s, 10): leading whitespace, an optional sign, then the
// longest run of decimal digits. NaN when there are no digits.
func jsParseInt10(s string) float64 {
	s = strings.TrimLeftFunc(s, isJSWhite)
	neg := false
	if s != "" && (s[0] == '+' || s[0] == '-') {
		neg = s[0] == '-'
		s = s[1:]
	}
	n := 0
	for n < len(s) && s[n] >= '0' && s[n] <= '9' {
		n++
	}
	if n == 0 {
		return math.NaN()
	}
	v, _ := strconv.ParseFloat(s[:n], 64)
	if neg {
		v = -v
	}
	return v
}

// jsNumString is String(x) for a JavaScript number.
func jsNumString(x float64) string {
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
	if a := math.Abs(x); a >= 1e-6 && a < 1e21 {
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	s := strconv.FormatFloat(x, 'e', -1, 64) // 1e-07 -> 1e-7, 1e+21 stays
	mant, exp, _ := strings.Cut(s, "e")
	sign := exp[0]
	exp = strings.TrimLeft(exp[1:], "0")
	return mant + "e" + string(sign) + exp
}

// padStart2 is String(n).padStart(2, "0").
func padStart2(n float64) string {
	s := jsNumString(n)
	if len(s) < 2 {
		return strings.Repeat("0", 2-len(s)) + s
	}
	return s
}

// jsISODay matches the ISO forms V8 accepts before "T00:00:00Z": YYYY, YYYY-MM,
// YYYY-MM-DD (or a signed six-digit year).
var jsISODay = regexp.MustCompile(`^([+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$`)

// parseJSDay is new Date(s + "T00:00:00Z") (also "T00:00:00.000Z"). ok is false for an
// Invalid Date. Like V8, a day of 29-31 past the month's end rolls into the next month.
func parseJSDay(s string) (time.Time, bool) {
	m := jsISODay.FindStringSubmatch(s)
	if m == nil || m[1] == "-000000" {
		return time.Time{}, false
	}
	year, _ := strconv.Atoi(m[1])
	month, day := 1, 1
	if m[2] != "" {
		month, _ = strconv.Atoi(m[2])
	}
	if m[3] != "" {
		day, _ = strconv.Atoi(m[3])
	}
	if month < 1 || month > 12 || day < 1 || day > 31 {
		return time.Time{}, false
	}
	t := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	if ms := t.UnixMilli(); ms > maxJSTime || ms < -maxJSTime {
		return time.Time{}, false
	}
	return t, true
}

// maxJSTime is the largest absolute time value a JavaScript Date can hold (ms).
const maxJSTime = 8.64e15

// jsISOString is new Date(ms).toISOString(); ok is false where JavaScript throws
// RangeError("Invalid time value"). Fractional ms are truncated toward zero (TimeClip).
func jsISOString(ms float64) (string, bool) {
	if math.IsNaN(ms) || math.IsInf(ms, 0) || math.Abs(ms) > maxJSTime {
		return "", false
	}
	t := time.UnixMilli(int64(ms)).UTC() // int64 conversion truncates toward zero
	y := t.Year()
	var year string
	switch {
	case y >= 0 && y <= 9999:
		year = strconv.Itoa(y)
		year = strings.Repeat("0", 4-len(year)) + year
	case y < 0:
		year = strconv.Itoa(-y)
		year = "-" + strings.Repeat("0", 6-len(year)) + year
	default:
		year = strconv.Itoa(y)
		year = "+" + strings.Repeat("0", 6-len(year)) + year
	}
	return year + t.Format("-01-02T15:04:05.000Z"), true
}

// isoDay is toISOString().slice(0, 10) of a valid instant.
func isoDay(t time.Time) string {
	s, _ := jsISOString(float64(t.UnixMilli()))
	return jsSlice(s, 0, 10)
}

// isWeekday is the modules' isWeekday(dateStr): new Date(d+"T00:00:00Z").getUTCDay() is
// neither 0 nor 6. An Invalid Date gives NaN, which is "a weekday".
func isWeekday(dateStr string) bool {
	t, ok := parseJSDay(dateStr)
	if !ok {
		return true
	}
	wd := t.Weekday()
	return wd != time.Sunday && wd != time.Saturday
}

// encodeURIComponent percent-encodes every UTF-8 byte except A-Z a-z 0-9 - _ . ! ~ * ' ( ).
// ok is false for invalid UTF-8, where JavaScript (lone surrogate) throws URIError.
func encodeURIComponent(s string) (string, bool) {
	if !utf8.ValidString(s) {
		return "", false
	}
	const hexDigits = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' ||
			strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hexDigits[c>>4])
		b.WriteByte(hexDigits[c&15])
	}
	return b.String(), true
}
