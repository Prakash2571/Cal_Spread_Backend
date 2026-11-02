package marketdata

import (
	"math"
	"strings"

	kitejson "github.com/Prakash2571/Cal_Spread_Backend/internal/kite/jsjson"
)

// maxQueryPairs is node:querystring's default maxKeys.
const maxQueryPairs = 1000

// queryTokens is the lenient token parse both GET routes share:
//
//	[...new Set(String(req.query.tokens ?? "").split(",").map((s) => Number(s.trim()))
//	  .filter((n) => Number.isFinite(n) && Number.isInteger(n) && n > 0))]
//
// Entries that are not positive integers are dropped silently, duplicates keep their
// first position. An integer of 2^63 or more cannot be an int64 token and is dropped too
// (Node kept it as an imprecise double; real tokens are below 2^34).
func queryTokens(rawQuery string) []int64 {
	raw := strings.Join(queryValues(rawQuery, "tokens"), ",")
	seen := map[int64]struct{}{}
	var out []int64
	for _, part := range strings.Split(raw, ",") {
		n := kitejson.StringToNumber(part) // Number(s.trim())
		if !(n > 0) || math.IsInf(n, 0) || n != math.Trunc(n) || n >= 1<<63 {
			continue
		}
		t := int64(n)
		if _, dup := seen[t]; dup {
			continue
		}
		seen[t] = struct{}{}
		out = append(out, t)
	}
	return out
}

// queryValues returns every value of key in the raw query string as Express 5's default
// ("simple") query parser, node:querystring.parse, reads it: pairs are separated by "&"
// and only the first 1000 are read (an empty segment between separators counts towards
// that limit but adds nothing; the last segment is always read), key and value split at
// the first "=", "+" is a space, and percent escapes are decoded leniently: a "%" that is
// not followed by two hex digits stays as it is. (Node first tries decodeURIComponent and
// falls back to exactly this byte-wise decoding; for the ASCII text a token list can
// contain both give the same bytes.) String(array) joins repeated values with ",".
func queryValues(rawQuery, key string) []string {
	if rawQuery == "" {
		return nil
	}
	segments := strings.Split(rawQuery, "&")
	pairs := maxQueryPairs
	var out []string
	for i, seg := range segments {
		if seg != "" {
			k, v, _ := strings.Cut(seg, "=")
			if unescapeQuery(k) == key {
				out = append(out, unescapeQuery(v))
			}
		}
		if i == len(segments)-1 {
			break
		}
		if pairs--; pairs == 0 {
			break
		}
	}
	return out
}

// unescapeQuery turns "+" into a space, then decodes every valid %XX escape and keeps
// any other "%" literally (querystring.unescapeBuffer).
func unescapeQuery(s string) string {
	s = strings.ReplaceAll(s, "+", " ")
	if !strings.Contains(s, "%") {
		return s
	}
	b := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			if hi, ok := unhex(s[i+1]); ok {
				if lo, ok := unhex(s[i+2]); ok {
					b = append(b, hi<<4|lo)
					i += 2
					continue
				}
			}
		}
		b = append(b, s[i])
	}
	return string(b)
}

func unhex(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}
