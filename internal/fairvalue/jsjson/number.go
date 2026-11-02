// Package jsjson writes and reads JSON exactly the way the Node backend's JSON.stringify
// and JSON.parse did, which the Fair Value port needs for byte-identical bodies, hashes
// (config_version, input snapshot ids) and byte-size ceilings:
//
//   - numbers use JavaScript's Number::toString (shortest round-trip digits, exponent
//     form outside 1e-6 <= |x| < 1e21, "1e-7" not "1e-07"); -0 prints as 0 and NaN or an
//     infinity prints as null;
//   - strings are escaped like JSON.stringify: only ", \ and control characters, never
//     <, >, & or U+2028/U+2029 (encoding/json escapes the last two even with
//     SetEscapeHTML(false));
//   - struct fields follow declaration order, nil slices print as [] (TypeScript arrays
//     are never null), nil pointers as null, and `omitempty` pointers are left out the
//     way an undefined property is;
//   - ordered objects (Object) keep insertion order with JavaScript's rule that
//     array-index keys come first in ascending numeric order.
package jsjson

import (
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

// FormatNumber is JavaScript's String(x) for a number.
func FormatNumber(x float64) string {
	switch {
	case math.IsNaN(x):
		return "NaN"
	case x == 0:
		return "0"
	case math.IsInf(x, 1):
		return "Infinity"
	case math.IsInf(x, -1):
		return "-Infinity"
	}
	return string(appendNumber(nil, x))
}

// appendNumber appends a finite, non-zero x formatted as Number::toString.
func appendNumber(dst []byte, x float64) []byte {
	if x < 0 {
		dst = append(dst, '-')
		x = -x
	}
	var tmp [32]byte
	e := strconv.AppendFloat(tmp[:0], x, 'e', -1, 64) // d.ddddde±XX
	mant, expPart, _ := strings.Cut(string(e), "e")
	digits := strings.Replace(mant, ".", "", 1)
	exp, _ := strconv.Atoi(expPart)
	k := len(digits)
	n := exp + 1
	switch {
	case k <= n && n <= 21:
		dst = append(dst, digits...)
		for i := 0; i < n-k; i++ {
			dst = append(dst, '0')
		}
	case 0 < n && n <= 21:
		dst = append(dst, digits[:n]...)
		dst = append(dst, '.')
		dst = append(dst, digits[n:]...)
	case -6 < n && n <= 0:
		dst = append(dst, '0', '.')
		for i := 0; i < -n; i++ {
			dst = append(dst, '0')
		}
		dst = append(dst, digits...)
	default:
		dst = append(dst, digits[0])
		if k > 1 {
			dst = append(dst, '.')
			dst = append(dst, digits[1:]...)
		}
		dst = append(dst, 'e')
		if n-1 >= 0 {
			dst = append(dst, '+')
		} else {
			dst = append(dst, '-')
		}
		dst = strconv.AppendInt(dst, int64(abs(n-1)), 10)
	}
	return dst
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// AppendFloat appends x as JSON.stringify would: null for NaN and the infinities, 0 for
// both zeros.
func AppendFloat(dst []byte, x float64) []byte {
	switch {
	case math.IsNaN(x) || math.IsInf(x, 0):
		return append(dst, "null"...)
	case x == 0:
		return append(dst, '0')
	}
	return appendNumber(dst, x)
}

const hexDigits = "0123456789abcdef"

// AppendString appends s as a JSON string literal the way JSON.stringify escapes it.
func AppendString(dst []byte, s string) []byte {
	dst = append(dst, '"')
	start := 0
	for i := 0; i < len(s); {
		c := s[i]
		if c >= 0x20 && c != '"' && c != '\\' && c < 0x80 {
			i++
			continue
		}
		if c >= 0x80 {
			r, size := utf8.DecodeRuneInString(s[i:])
			if r == utf8.RuneError && size == 1 {
				dst = append(dst, s[start:i]...)
				dst = append(dst, "\ufffd"...)
				i++
				start = i
				continue
			}
			i += size
			continue
		}
		dst = append(dst, s[start:i]...)
		switch c {
		case '"':
			dst = append(dst, '\\', '"')
		case '\\':
			dst = append(dst, '\\', '\\')
		case '\b':
			dst = append(dst, '\\', 'b')
		case '\f':
			dst = append(dst, '\\', 'f')
		case '\n':
			dst = append(dst, '\\', 'n')
		case '\r':
			dst = append(dst, '\\', 'r')
		case '\t':
			dst = append(dst, '\\', 't')
		default:
			dst = append(dst, '\\', 'u', '0', '0', hexDigits[c>>4], hexDigits[c&0xf])
		}
		i++
		start = i
	}
	dst = append(dst, s[start:]...)
	return append(dst, '"')
}
