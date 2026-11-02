package registry

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
)

// jsIsSpace is the WhiteSpace + LineTerminator set String.prototype.trim removes.
func jsIsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// jsTrim is String.prototype.trim.
func jsTrim(s string) string { return strings.TrimFunc(s, jsIsSpace) }

// jsString is JavaScript's String(v) for a value decoded from a JSON body
// (encoding/json types: nil, bool, float64, string, []any, map[string]any).
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return jsjson.FormatNumber(x)
	case []any:
		// Array.prototype.join: null and undefined elements are empty strings.
		parts := make([]string, len(x))
		for i, e := range x {
			if e != nil {
				parts[i] = jsString(e)
			}
		}
		return strings.Join(parts, ",")
	case map[string]any:
		return "[object Object]"
	}
	return fmt.Sprint(v)
}

// localeInt is Number.prototype.toLocaleString() in en-US for an integer: "18,492".
func localeInt(n int) string {
	s := strconv.Itoa(n)
	neg := strings.HasPrefix(s, "-")
	if neg {
		s = s[1:]
	}
	var b strings.Builder
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	if neg {
		return "-" + b.String()
	}
	return b.String()
}

// maxTimeMs is the ECMAScript time value range (±8.64e15 ms).
const maxTimeMs = 8.64e15

// errInvalidTime is the RangeError `new Date(NaN).toISOString()` throws.
var errInvalidTime = errors.New("Invalid time value")

// timeClip is TimeClip: NaN outside ±8.64e15, else truncated toward zero.
func timeClip(ms float64) float64 {
	if math.IsNaN(ms) || math.IsInf(ms, 0) || math.Abs(ms) > maxTimeMs {
		return math.NaN()
	}
	return math.Trunc(ms) + 0
}

// isoString is new Date(ms).toISOString(); an invalid time is the RangeError.
func isoString(ms float64) (string, error) {
	ms = timeClip(ms)
	if math.IsNaN(ms) {
		return "", errInvalidTime
	}
	t := time.UnixMilli(int64(ms)).UTC()
	y := t.Year()
	var year string
	switch {
	case y >= 0 && y <= 9999:
		year = fmt.Sprintf("%04d", y)
	case y < 0:
		year = fmt.Sprintf("-%06d", -y)
	default:
		year = fmt.Sprintf("+%06d", y)
	}
	return fmt.Sprintf("%s-%02d-%02dT%02d:%02d:%02d.%03dZ", year, int(t.Month()), t.Day(),
		t.Hour(), t.Minute(), t.Second(), t.Nanosecond()/1e6), nil
}

// isoDay is `d.toISOString().slice(0, 10)` (history.ts ISO_DAY).
func isoDay(ms float64) (string, error) {
	s, err := isoString(ms)
	if err != nil {
		return "", err
	}
	return s[:10], nil
}

const istOffsetMs = 5.5 * 60 * 60 * 1000

// istStamp is history.ts istStamp: the epoch as IST "YYYY-MM-DD HH:MM:SS", read with
// UTC getters on epoch + 5h30m. The year is not padded (String(year)), and an
// out-of-range time prints NaN in every field, as the Date getters do.
func istStamp(epochMs float64) string {
	ms := timeClip(epochMs + istOffsetMs)
	if math.IsNaN(ms) {
		return "NaN-NaN-NaN NaN:NaN:NaN"
	}
	t := time.UnixMilli(int64(ms)).UTC()
	p := func(n int) string {
		if n < 10 {
			return "0" + strconv.Itoa(n)
		}
		return strconv.Itoa(n)
	}
	return strconv.Itoa(t.Year()) + "-" + p(int(t.Month())) + "-" + p(t.Day()) + " " +
		p(t.Hour()) + ":" + p(t.Minute()) + ":" + p(t.Second())
}

// orderedKeys returns m's keys sorted, for deterministic iteration where the TypeScript
// iterated an object literal built in a fixed order.
func orderedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
