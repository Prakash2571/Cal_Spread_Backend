// Package jsx holds the small JavaScript-compatible helpers the port needs so numbers,
// timestamps and day keys come out exactly as the Node backend produced them.
package jsx

import (
	"math"
	"strconv"
	"strings"
	"time"
)

// Round is JavaScript's Math.round: halves round toward +Infinity (so -2.5 -> -2, where
// Go's math.Round gives -3). The result is never negative zero, because JSON.stringify
// prints -0 as 0 while Go's encoder prints "-0".
func Round(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) || math.Abs(x) >= 1<<52 {
		return x + 0
	}
	r := math.Floor(x)
	if x-r >= 0.5 {
		r++
	}
	return r + 0
}

// Round2 rounds to paise the way the Node code does: Math.round(v * 100) / 100.
func Round2(x float64) float64 { return Round(x*100) / 100 }

// Finite reports whether x is neither NaN nor an infinity.
func Finite(x float64) bool { return !math.IsNaN(x) && !math.IsInf(x, 0) }

// NullIfNotFinite returns nil for NaN and the infinities, which JSON.stringify prints
// as null, and a pointer to x otherwise.
func NullIfNotFinite(x float64) *float64 {
	if !Finite(x) {
		return nil
	}
	return &x
}

// ISO formats t like Date.prototype.toISOString: UTC with exactly three fraction digits.
func ISO(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// TruncMs drops sub-millisecond precision, as a BSON Date does.
func TruncMs(t time.Time) time.Time { return t.Truncate(time.Millisecond) }

// FromMs converts epoch milliseconds to a time.
func FromMs(ms int64) time.Time { return time.UnixMilli(ms).UTC() }

const istOffsetMs = (5*60 + 30) * 60 * 1000

// IstDayKey is the IST calendar day of the instant as YYYY-MM-DD: the UTC date of
// t + 5h30m (index.ts istDayKey).
func IstDayKey(t time.Time) string {
	return time.UnixMilli(t.UnixMilli() + istOffsetMs).UTC().Format("2006-01-02")
}

// IstDateTime is index.ts istDateTime: "YYYY-MM-DD HH:MM:SS" in IST (Kite wants exchange time).
func IstDateTime(t time.Time) string {
	return time.UnixMilli(t.UnixMilli() + istOffsetMs).UTC().Format("2006-01-02 15:04:05")
}

// IstClock returns the IST wall-clock fields of the instant. weekday is 0 (Sunday)
// to 6 (Saturday), like Date.getUTCDay on the shifted instant.
func IstClock(t time.Time) (year, month, day, hour, minute, second, weekday int) {
	s := time.UnixMilli(t.UnixMilli() + istOffsetMs).UTC()
	return s.Year(), int(s.Month()), s.Day(), s.Hour(), s.Minute(), s.Second(), int(s.Weekday())
}

// IsMarketOpen is index.ts isMarketOpen: Monday to Friday, 09:15 to 15:40 IST inclusive,
// with no holiday calendar.
func IsMarketOpen(t time.Time) bool {
	_, _, _, h, m, _, wd := IstClock(t)
	if wd == 0 || wd == 6 {
		return false
	}
	mins := h*60 + m
	return mins >= 9*60+15 && mins <= 15*60+40
}

// ParseNumber converts a trimmed string the way JavaScript's Number() does for the forms
// that occur in configuration: decimal and exponent notation plus 0x/0o/0b integers.
// Go-only spellings (inf, nan, underscores, hex floats) are rejected.
func ParseNumber(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, true // Number("") === 0; callers that care check for blank first
	}
	if len(s) > 2 && s[0] == '0' {
		base := 0
		switch s[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			n, err := strconv.ParseUint(s[2:], base, 64)
			if err != nil {
				return math.NaN(), false
			}
			return float64(n), true
		}
	}
	for _, r := range s {
		switch {
		case r >= '0' && r <= '9', r == '.', r == 'e', r == 'E', r == '+', r == '-':
		default:
			if s == "Infinity" || s == "+Infinity" {
				return math.Inf(1), true
			}
			if s == "-Infinity" {
				return math.Inf(-1), true
			}
			return math.NaN(), false
		}
	}
	n, err := strconv.ParseFloat(s, 64)
	if err != nil {
		if ne, ok := err.(*strconv.NumError); ok && ne.Err == strconv.ErrRange {
			return n, true // +/-Inf like JS
		}
		return math.NaN(), false
	}
	return n, true
}
