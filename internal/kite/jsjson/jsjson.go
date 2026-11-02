// Package jsjson reproduces the parts of JavaScript's JSON and value conversion that the
// Kite port depends on, so responses are read and written exactly as the Node backend
// did:
//
//   - Parse is JSON.parse: object keys keep JavaScript's own-property order (array-index
//     keys ascending first, then the rest in insertion order), a duplicate key keeps its
//     first position and its last value, numbers beyond float64 range become ±Infinity,
//     and syntax errors carry V8's message text.
//   - Marshal / AppendString / AppendNumber are JSON.stringify: no HTML escaping, U+2028
//     and U+2029 written raw, lone surrogates escaped, NaN and the infinities as null and
//     negative zero as 0.
//   - ToNumber, ToString and FormatNumber are Number(v), String(v) and
//     Number.prototype.toString().
package jsjson

import (
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
)

// Kind is the JavaScript type of a parsed value.
type Kind uint8

// The kinds. A nil *Value is Undefined (a missing property).
const (
	Undefined Kind = iota
	Null
	Bool
	Number
	String
	Array
	Object
)

// Value is one parsed JSON value. Values are immutable after Parse.
type Value struct {
	kind  Kind
	b     bool
	n     float64
	s     string
	arr   []*Value
	keys  []string // own-property order
	props map[string]*Value
}

// Kind returns the value's kind; Undefined for a nil value.
func (v *Value) Kind() Kind {
	if v == nil {
		return Undefined
	}
	return v.kind
}

// Nullish reports v == null || v === undefined (the left side of ??).
func (v *Value) Nullish() bool { k := v.Kind(); return k == Undefined || k == Null }

// Truthy is JavaScript truthiness.
func (v *Value) Truthy() bool {
	switch v.Kind() {
	case Bool:
		return v.b
	case Number:
		return v.n != 0 && !math.IsNaN(v.n)
	case String:
		return v.s != ""
	case Array, Object:
		return true
	}
	return false
}

// IsNumber reports typeof v === "number".
func (v *Value) IsNumber() bool { return v.Kind() == Number }

// IsString reports typeof v === "string".
func (v *Value) IsString() bool { return v.Kind() == String }

// Num is the number of a Number value (0 for other kinds).
func (v *Value) Num() float64 {
	if v.Kind() != Number {
		return 0
	}
	return v.n
}

// Str is the text of a String value ("" for other kinds).
func (v *Value) Str() string {
	if v.Kind() != String {
		return ""
	}
	return v.s
}

// Get is property access v[key] for objects and array indexes (v?.[key]): undefined
// (nil) for anything else.
func (v *Value) Get(key string) *Value {
	switch v.Kind() {
	case Object:
		return v.props[key]
	case Array:
		if i, ok := arrayIndex(key); ok && int(i) < len(v.arr) {
			return v.arr[i]
		}
	}
	return nil
}

// Index is v[i] for arrays (undefined otherwise or when out of range).
func (v *Value) Index(i int) *Value {
	if v.Kind() != Array || i < 0 || i >= len(v.arr) {
		return nil
	}
	return v.arr[i]
}

// Elems returns the elements of an array (nil otherwise).
func (v *Value) Elems() []*Value {
	if v.Kind() != Array {
		return nil
	}
	return v.arr
}

// Keys returns an object's own keys in JavaScript order (nil otherwise).
func (v *Value) Keys() []string {
	if v.Kind() != Object {
		return nil
	}
	return v.keys
}

// Values is Object.values(v): object property values in key order, array elements, the
// characters of a string; nothing for other kinds.
func (v *Value) Values() []*Value {
	switch v.Kind() {
	case Object:
		out := make([]*Value, len(v.keys))
		for i, k := range v.keys {
			out[i] = v.props[k]
		}
		return out
	case Array:
		return v.arr
	case String:
		units := utf16.Encode([]rune(v.s))
		out := make([]*Value, len(units))
		for i, u := range units {
			out[i] = &Value{kind: String, s: string(utf16.Decode([]uint16{u}))}
		}
		return out
	}
	return nil
}

// NewNumber, NewString, NewNull build values (used by tests and callers that need to
// pass synthetic values through the same conversions).
func NewNumber(f float64) *Value { return &Value{kind: Number, n: f} }

// NewString builds a String value.
func NewString(s string) *Value { return &Value{kind: String, s: s} }

// NewNull builds a null value.
func NewNull() *Value { return &Value{kind: Null} }

// arrayIndex reports whether key is a canonical array index ("0" .. "4294967294").
func arrayIndex(key string) (uint32, bool) {
	if key == "" || len(key) > 10 || (len(key) > 1 && key[0] == '0') {
		return 0, false
	}
	for i := 0; i < len(key); i++ {
		if key[i] < '0' || key[i] > '9' {
			return 0, false
		}
	}
	n, err := strconv.ParseUint(key, 10, 64)
	if err != nil || n >= math.MaxUint32 {
		return 0, false
	}
	return uint32(n), true
}

// orderKeys applies OrdinaryOwnPropertyKeys: integer indexes ascending, then strings in
// insertion order.
func orderKeys(keys []string) []string {
	var ints []string
	var strs []string
	for _, k := range keys {
		if _, ok := arrayIndex(k); ok {
			ints = append(ints, k)
		} else {
			strs = append(strs, k)
		}
	}
	if len(ints) == 0 {
		return keys
	}
	sort.SliceStable(ints, func(i, j int) bool {
		a, _ := arrayIndex(ints[i])
		b, _ := arrayIndex(ints[j])
		return a < b
	})
	return append(ints, strs...)
}

// ---------------------------------------------------------------------------
// Conversions

// ToNumber is JavaScript Number(v).
func ToNumber(v *Value) float64 {
	switch v.Kind() {
	case Undefined:
		return math.NaN()
	case Null:
		return 0
	case Bool:
		if v.b {
			return 1
		}
		return 0
	case Number:
		return v.n
	case String:
		return StringToNumber(v.s)
	case Array:
		return StringToNumber(ToString(v))
	}
	return math.NaN()
}

// StringToNumber is Number(s) for a string: JavaScript whitespace is trimmed, "" is 0,
// 0x/0o/0b integers and Infinity are accepted, anything else that is not a decimal
// literal is NaN.
func StringToNumber(s string) float64 {
	t := TrimJS(s)
	if t == "" {
		return 0
	}
	// TrimJS removed exactly JavaScript's whitespace; anything Go would still trim (U+0085)
	// is not whitespace to JavaScript and makes the literal invalid.
	if r, _ := utf8.DecodeRuneInString(t); unicode.IsSpace(r) {
		return math.NaN()
	}
	if r, _ := utf8.DecodeLastRuneInString(t); unicode.IsSpace(r) {
		return math.NaN()
	}
	n, ok := jsx.ParseNumber(t)
	if !ok {
		return math.NaN()
	}
	return n
}

// ToString is JavaScript String(v).
func ToString(v *Value) string {
	switch v.Kind() {
	case Undefined:
		return "undefined"
	case Null:
		return "null"
	case Bool:
		if v.b {
			return "true"
		}
		return "false"
	case Number:
		return FormatNumber(v.n)
	case String:
		return v.s
	case Array:
		parts := make([]string, len(v.arr))
		for i, e := range v.arr {
			if !e.Nullish() {
				parts[i] = ToString(e)
			}
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}

// FormatNumber is Number.prototype.toString() in base 10.
func FormatNumber(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	return string(appendFinite(nil, f))
}

// appendFinite formats a finite non-zero number the way JavaScript does; it is the
// same algorithm encoding/json uses, which matches ECMAScript's Number::toString.
func appendFinite(b []byte, f float64) []byte {
	abs := math.Abs(f)
	format := byte('f')
	if abs < 1e-6 || abs >= 1e21 {
		format = 'e'
	}
	b = strconv.AppendFloat(b, f, format, -1, 64)
	if format == 'e' {
		// "1e-07" -> "1e-7"
		n := len(b)
		if n >= 4 && b[n-4] == 'e' && b[n-3] == '-' && b[n-2] == '0' {
			b[n-2] = b[n-1]
			b = b[:n-1]
		}
	}
	return b
}

// TrimJS is String.prototype.trim(): JavaScript WhiteSpace and LineTerminator.
func TrimJS(s string) string {
	return strings.TrimFunc(s, IsJSSpace)
}

// IsJSSpace reports whether r is JavaScript whitespace or a line terminator.
func IsJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// UTF16Len is s.length.
func UTF16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// SliceUTF16 is s.slice(0, n) on UTF-16 code units. A surrogate pair cut in half leaves a
// lone surrogate in JavaScript, which a Go string cannot hold; it becomes U+FFFD, which is
// what a client shows for the lone surrogate Node sent (and what any UTF-8 decoder makes
// of it).
func SliceUTF16(s string, n int) string {
	if n <= 0 {
		return ""
	}
	units := 0
	for i, r := range s {
		w := 1
		if r >= 0x10000 {
			w = 2
		}
		if units+w > n {
			if w == 2 && units+1 == n {
				return s[:i] + "\uFFFD"
			}
			return s[:i]
		}
		units += w
	}
	return s
}

// ---------------------------------------------------------------------------
// JSON.stringify

// Marshal is JSON.stringify(v) for a parsed value (undefined marshals as nil).
func Marshal(v *Value) []byte {
	if v == nil {
		return nil
	}
	return appendValue(nil, v)
}

func appendValue(b []byte, v *Value) []byte {
	switch v.Kind() {
	case Undefined, Null:
		return append(b, "null"...)
	case Bool:
		if v.b {
			return append(b, "true"...)
		}
		return append(b, "false"...)
	case Number:
		return AppendNumber(b, v.n)
	case String:
		return AppendString(b, v.s)
	case Array:
		b = append(b, '[')
		for i, e := range v.arr {
			if i > 0 {
				b = append(b, ',')
			}
			b = appendValue(b, e)
		}
		return append(b, ']')
	}
	b = append(b, '{')
	for i, k := range v.keys {
		if i > 0 {
			b = append(b, ',')
		}
		b = AppendString(b, k)
		b = append(b, ':')
		b = appendValue(b, v.props[k])
	}
	return append(b, '}')
}

// AppendNumber appends JSON.stringify(f): null for NaN and the infinities, 0 for -0.
func AppendNumber(b []byte, f float64) []byte {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return append(b, "null"...)
	}
	if f == 0 {
		return append(b, '0')
	}
	return appendFinite(b, f)
}

const hexDigits = "0123456789abcdef"

// AppendString appends JSON.stringify(s). Surrogate code points stored WTF-8 style (as
// Parse does for lone \uD800-\uDFFF escapes) are written back as \udXXX escapes; any
// other invalid byte is written as U+FFFD.
func AppendString(b []byte, s string) []byte {
	b = append(b, '"')
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			switch {
			case c == '"':
				b = append(b, '\\', '"')
			case c == '\\':
				b = append(b, '\\', '\\')
			case c == '\b':
				b = append(b, '\\', 'b')
			case c == '\f':
				b = append(b, '\\', 'f')
			case c == '\n':
				b = append(b, '\\', 'n')
			case c == '\r':
				b = append(b, '\\', 'r')
			case c == '\t':
				b = append(b, '\\', 't')
			case c < 0x20:
				b = append(b, '\\', 'u', '0', '0', hexDigits[c>>4], hexDigits[c&0xF])
			default:
				b = append(b, c)
			}
			i++
			continue
		}
		if sur, ok := wtf8Surrogate(s[i:]); ok {
			b = append(b, '\\', 'u', hexDigits[sur>>12&0xF], hexDigits[sur>>8&0xF], hexDigits[sur>>4&0xF], hexDigits[sur&0xF])
			i += 3
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			b = append(b, "\uFFFD"...)
		} else {
			b = append(b, s[i:i+size]...)
		}
		i += size
	}
	return append(b, '"')
}

// wtf8Surrogate decodes a 3-byte generalized-UTF-8 encoding of U+D800..U+DFFF.
func wtf8Surrogate(s string) (uint16, bool) {
	if len(s) < 3 || s[0] != 0xED || s[1] < 0xA0 || s[1] > 0xBF || s[2] < 0x80 || s[2] > 0xBF {
		return 0, false
	}
	return uint16(0xD000 | uint16(s[1]&0x3F)<<6 | uint16(s[2]&0x3F)), true
}

func appendWTF8Surrogate(b []byte, u uint16) []byte {
	return append(b, 0xED, byte(0x80|(u>>6)&0x3F), byte(0x80|u&0x3F))
}
