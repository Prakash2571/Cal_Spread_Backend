package dhan

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Kind is the JavaScript type of a decoded JSON Value.
type Kind uint8

// Value kinds. KindUndefined is the zero value: a field that was absent.
const (
	KindUndefined Kind = iota
	KindNull
	KindBool
	KindNumber
	KindString
	KindArray
	KindObject
)

// Value is a JSON value read the way JSON.parse reads it: numbers are float64, and
// object keys keep JavaScript's own-property order (integer-like keys ascending, then
// the rest in first-occurrence order), so Object.keys/Object.values walks match Node.
//
// Dhan response helpers (normalizeDhanMultiMargin, describeDhanMarginPayload,
// extractIpv4Addresses, the 200-with-"failed" check) inspect payloads whose shape is
// not fixed, and the Node code reads them with typeof and Number() rather than a
// schema. Value carries enough to reproduce those reads exactly. Typed response
// structs use Value fields for the same reason: decoding never fails on an odd shape.
type Value struct {
	kind Kind
	b    bool
	n    float64
	s    string
	arr  []Value
	obj  *object
}

type object struct {
	keys []string // JavaScript own-property order
	vals map[string]Value
}

// Null is the JSON null value.
func Null() Value { return Value{kind: KindNull} }

// NumberValue wraps a number.
func NumberValue(f float64) Value { return Value{kind: KindNumber, n: f} }

// StringValue wraps a string.
func StringValue(s string) Value { return Value{kind: KindString, s: s} }

// BoolValue wraps a boolean.
func BoolValue(b bool) Value { return Value{kind: KindBool, b: b} }

// ParseJSON parses one JSON document like JSON.parse. Trailing non-space data is an
// error, as it is in JavaScript.
func ParseJSON(data []byte) (Value, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := parseValue(dec)
	if err != nil {
		return Value{}, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return Value{}, errors.New("unexpected data after the JSON value")
	}
	return v, nil
}

func parseValue(dec *json.Decoder) (Value, error) {
	tok, err := dec.Token()
	if err != nil {
		return Value{}, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			o := &object{vals: map[string]Value{}}
			var insertion []string
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return Value{}, err
				}
				key, ok := kt.(string)
				if !ok {
					return Value{}, errors.New("object key is not a string")
				}
				val, err := parseValue(dec)
				if err != nil {
					return Value{}, err
				}
				if _, seen := o.vals[key]; !seen {
					insertion = append(insertion, key)
				}
				// JSON.parse keeps the LAST duplicate's value at the FIRST key's position.
				o.vals[key] = val
			}
			if _, err := dec.Token(); err != nil { // '}'
				return Value{}, err
			}
			o.keys = jsKeyOrder(insertion)
			return Value{kind: KindObject, obj: o}, nil
		case '[':
			arr := []Value{}
			for dec.More() {
				val, err := parseValue(dec)
				if err != nil {
					return Value{}, err
				}
				arr = append(arr, val)
			}
			if _, err := dec.Token(); err != nil { // ']'
				return Value{}, err
			}
			return Value{kind: KindArray, arr: arr}, nil
		}
		return Value{}, errors.New("unexpected delimiter")
	case json.Number:
		f, err := strconv.ParseFloat(string(t), 64)
		if err != nil {
			var ne *strconv.NumError
			if !errors.As(err, &ne) || ne.Err != strconv.ErrRange {
				return Value{}, err
			}
			// JSON.parse("1e400") is Infinity; ParseFloat returns ±Inf with ErrRange.
		}
		return Value{kind: KindNumber, n: f}, nil
	case string:
		return Value{kind: KindString, s: t}, nil
	case bool:
		return Value{kind: KindBool, b: t}, nil
	case nil:
		return Value{kind: KindNull}, nil
	}
	return Value{}, errors.New("unexpected JSON token")
}

// jsKeyOrder applies OrdinaryOwnPropertyKeys: array-index keys ascending, then the
// remaining keys in insertion order.
func jsKeyOrder(insertion []string) []string {
	var idx []string
	var rest []string
	for _, k := range insertion {
		if _, ok := arrayIndex(k); ok {
			idx = append(idx, k)
		} else {
			rest = append(rest, k)
		}
	}
	if len(idx) == 0 {
		return insertion
	}
	sort.SliceStable(idx, func(i, j int) bool {
		a, _ := arrayIndex(idx[i])
		b, _ := arrayIndex(idx[j])
		return a < b
	})
	return append(idx, rest...)
}

// arrayIndex reports whether k is a canonical array index ("0", or no leading zero,
// value at most 2^32-2).
func arrayIndex(k string) (uint64, bool) {
	if k == "" || len(k) > 10 || (len(k) > 1 && k[0] == '0') {
		return 0, false
	}
	var n uint64
	for i := 0; i < len(k); i++ {
		c := k[i]
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + uint64(c-'0')
	}
	if n > 4294967294 {
		return 0, false
	}
	return n, true
}

// Kind returns the JavaScript type of v.
func (v Value) Kind() Kind { return v.kind }

// IsUndefined reports an absent value.
func (v Value) IsUndefined() bool { return v.kind == KindUndefined }

// IsNull reports JSON null.
func (v Value) IsNull() bool { return v.kind == KindNull }

// IsNullish reports null or undefined (the `??` test).
func (v Value) IsNullish() bool { return v.kind == KindUndefined || v.kind == KindNull }

// IsObjectLike reports typeof v === "object" && v !== null (objects and arrays).
func (v Value) IsObjectLike() bool { return v.kind == KindObject || v.kind == KindArray }

// IsArray reports Array.isArray(v).
func (v Value) IsArray() bool { return v.kind == KindArray }

// Num returns the number when typeof v === "number".
func (v Value) Num() (float64, bool) { return v.n, v.kind == KindNumber }

// Str returns the string when typeof v === "string".
func (v Value) Str() (string, bool) { return v.s, v.kind == KindString }

// Bool returns the boolean when typeof v === "boolean".
func (v Value) Bool() (bool, bool) { return v.b, v.kind == KindBool }

// Get is property access v[key] for objects and arrays (canonical index keys);
// everything else yields undefined.
func (v Value) Get(key string) Value {
	switch v.kind {
	case KindObject:
		return v.obj.vals[key]
	case KindArray:
		if i, ok := arrayIndex(key); ok && i < uint64(len(v.arr)) {
			return v.arr[i]
		}
	}
	return Value{}
}

// Len is the array length (0 for non-arrays).
func (v Value) Len() int {
	if v.kind == KindArray {
		return len(v.arr)
	}
	return 0
}

// Index is v[i] for arrays; undefined otherwise or out of range.
func (v Value) Index(i int) Value {
	if v.kind == KindArray && i >= 0 && i < len(v.arr) {
		return v.arr[i]
	}
	return Value{}
}

// Array returns the elements of an array (nil otherwise).
func (v Value) Array() []Value {
	if v.kind == KindArray {
		return v.arr
	}
	return nil
}

// Keys is Object.keys(v): own keys of an object in JavaScript order, index strings for
// arrays and strings, and nothing for other values.
func (v Value) Keys() []string {
	switch v.kind {
	case KindObject:
		return append([]string(nil), v.obj.keys...)
	case KindArray:
		out := make([]string, len(v.arr))
		for i := range v.arr {
			out[i] = strconv.Itoa(i)
		}
		return out
	case KindString:
		n := utf16Len(v.s)
		out := make([]string, n)
		for i := 0; i < n; i++ {
			out[i] = strconv.Itoa(i)
		}
		return out
	}
	return []string{}
}

// Values is Object.values(v) for objects and arrays.
func (v Value) Values() []Value {
	switch v.kind {
	case KindObject:
		out := make([]Value, len(v.obj.keys))
		for i, k := range v.obj.keys {
			out[i] = v.obj.vals[k]
		}
		return out
	case KindArray:
		return append([]Value(nil), v.arr...)
	}
	return nil
}

// ToNumber is JavaScript's Number(v).
func (v Value) ToNumber() float64 {
	switch v.kind {
	case KindNull:
		return 0
	case KindBool:
		if v.b {
			return 1
		}
		return 0
	case KindNumber:
		return v.n
	case KindString:
		return jsStringToNumber(v.s)
	case KindArray:
		// Number([]) = Number("") = 0; Number([x]) = Number(String(x)); two or more
		// elements stringify with a comma and are NaN.
		switch len(v.arr) {
		case 0:
			return 0
		case 1:
			e := v.arr[0]
			switch e.kind {
			case KindUndefined, KindNull:
				return 0
			case KindBool, KindObject:
				return math.NaN()
			}
			return e.ToNumber()
		}
		return math.NaN()
	}
	return math.NaN() // undefined, plain objects
}

// OrZero is `Number(v) || 0`.
func (v Value) OrZero() float64 {
	n := v.ToNumber()
	if math.IsNaN(n) {
		return 0
	}
	return n + 0
}

// Decode copies v into a typed struct, skipping fields whose JSON type does not fit
// (the struct then reads like a JavaScript object with those properties missing).
func (v Value) Decode(out any) {
	raw, err := v.MarshalJSON()
	if err != nil {
		return
	}
	decodeLoose(raw, out)
}

// MarshalJSON writes v like JSON.stringify (non-finite numbers become null, -0 is 0,
// undefined object members are omitted).
func (v Value) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	v.writeJSON(&buf)
	return buf.Bytes(), nil
}

func (v Value) writeJSON(buf *bytes.Buffer) {
	switch v.kind {
	case KindUndefined, KindNull:
		buf.WriteString("null")
	case KindBool:
		if v.b {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case KindNumber:
		buf.Write(jsonNumber(v.n))
	case KindString:
		buf.Write(marshalNoEscape(v.s))
	case KindArray:
		buf.WriteByte('[')
		for i, e := range v.arr {
			if i > 0 {
				buf.WriteByte(',')
			}
			e.writeJSON(buf)
		}
		buf.WriteByte(']')
	case KindObject:
		buf.WriteByte('{')
		first := true
		for _, k := range v.obj.keys {
			e := v.obj.vals[k]
			if e.kind == KindUndefined {
				continue
			}
			if !first {
				buf.WriteByte(',')
			}
			first = false
			buf.Write(marshalNoEscape(k))
			buf.WriteByte(':')
			e.writeJSON(buf)
		}
		buf.WriteByte('}')
	}
}

// UnmarshalJSON decodes any JSON value. Used when Value is a struct field type.
func (v *Value) UnmarshalJSON(data []byte) error {
	p, err := ParseJSON(data)
	if err != nil {
		return err
	}
	*v = p
	return nil
}

// jsonNumber formats a finite number the way JSON.stringify does (encoding/json
// already follows ECMAScript Number::toString); -0 prints as 0 and NaN/±Inf as null.
func jsonNumber(f float64) []byte {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return []byte("null")
	}
	if f == 0 {
		return []byte("0")
	}
	b, _ := json.Marshal(f)
	return b
}

// jsNumberString is String(f) (template literals): like jsonNumber, but NaN and the
// infinities print as NaN, Infinity and -Infinity.
func jsNumberString(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	}
	return string(jsonNumber(f))
}

// encodeJSON is json.Marshal without HTML escaping and without the trailing newline,
// so request bodies match JSON.stringify byte for byte for ordinary text.
func encodeJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// marshalNoEscape is encodeJSON for values that always encode (strings, string maps).
func marshalNoEscape(v any) []byte {
	b, err := encodeJSON(v)
	if err != nil {
		return []byte("null")
	}
	return b
}

// decodeLoose unmarshals raw into out, ignoring JSON-type mismatches (Unmarshal still
// fills every field that fits).
func decodeLoose(raw []byte, out any) {
	if err := json.Unmarshal(raw, out); err != nil {
		var te *json.UnmarshalTypeError
		_ = errors.As(err, &te) // mismatches are tolerated; raw is already valid JSON
	}
}

/* ------------------------- JavaScript string helpers ----------------------- */

// jsIsSpace is the WhiteSpace + LineTerminator set used by String.prototype.trim,
// /\s/ and Number() (TAB VT FF SP NBSP ZWNBSP, every Zs, LF CR LS PS).
func jsIsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// jsTrim is String.prototype.trim.
func jsTrim(s string) string { return strings.TrimFunc(s, jsIsSpace) }

// jsUpper is String.prototype.toUpperCase for the text this package sees: ASCII
// exactly, other scripts via Unicode simple mappings plus the common full mappings
// (ß, ŉ and the Latin ligatures) that expand to several letters.
func jsUpper(s string) string {
	ascii := true
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			ascii = false
			break
		}
	}
	if ascii {
		return strings.ToUpper(s)
	}
	var b strings.Builder
	for _, r := range s {
		switch r {
		case 'ß':
			b.WriteString("SS")
		case 'ŉ':
			b.WriteString("ʼN")
		case 'ﬀ':
			b.WriteString("FF")
		case 'ﬁ':
			b.WriteString("FI")
		case 'ﬂ':
			b.WriteString("FL")
		case 'ﬃ':
			b.WriteString("FFI")
		case 'ﬄ':
			b.WriteString("FFL")
		case 'ﬅ', 'ﬆ':
			b.WriteString("ST")
		default:
			b.WriteRune(unicode.ToUpper(r))
		}
	}
	return b.String()
}

// asciiUpper upper-cases ASCII letters only. JavaScript's non-unicode /i regexes never
// fold a non-ASCII character onto an ASCII one, so ASCII-only folding reproduces them.
func asciiUpper(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'a' && c <= 'z' {
			b[i] = c - 32
		}
	}
	return string(b)
}

// asciiEqualFold compares under ASCII-only case folding.
func asciiEqualFold(a, b string) bool { return len(a) == len(b) && asciiUpper(a) == asciiUpper(b) }

// collapseJSSpace replaces each run of /\s+/ with one space.
func collapseJSSpace(s string) string {
	var b strings.Builder
	inSpace := false
	for _, r := range s {
		if jsIsSpace(r) {
			if !inSpace {
				b.WriteByte(' ')
			}
			inSpace = true
			continue
		}
		inSpace = false
		b.WriteRune(r)
	}
	return b.String()
}

// utf16Len is the JavaScript string length.
func utf16Len(s string) int {
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

// utf16Prefix is s.slice(0, n) in UTF-16 code units. A surrogate pair that the cut
// would split is dropped (Go strings cannot hold a lone surrogate).
func utf16Prefix(s string, n int) string {
	units := 0
	for i, r := range s {
		w := 1
		if r >= 0x10000 {
			w = 2
		}
		if units+w > n {
			return s[:i]
		}
		units += w
	}
	return s
}

// encodeURIComponent percent-encodes everything except A-Z a-z 0-9 - _ . ! ~ * ' ( ).
func encodeURIComponent(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&15])
	}
	return b.String()
}

/* --------------------------- JavaScript Number() --------------------------- */

// jsStringToNumber is Number(string): trimmed, "" is 0, 0x/0o/0b integers, signed
// Infinity and decimal literals; anything else is NaN.
func jsStringToNumber(s string) float64 {
	t := jsTrim(s)
	if t == "" {
		return 0
	}
	if len(t) > 2 && t[0] == '0' {
		base := 0
		switch t[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			digits := t[2:]
			for _, c := range digits {
				d := digitVal(c)
				if d < 0 || d >= base {
					return math.NaN()
				}
			}
			if n, err := strconv.ParseUint(digits, base, 64); err == nil {
				return float64(n)
			}
			bi, ok := new(big.Int).SetString(digits, base)
			if !ok {
				return math.NaN()
			}
			f, _ := new(big.Float).SetInt(bi).Float64()
			return f
		}
	}
	switch t {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if !isDecimalLiteral(t) {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		var ne *strconv.NumError
		if errors.As(err, &ne) && ne.Err == strconv.ErrRange {
			return f
		}
		return math.NaN()
	}
	return f
}

func digitVal(c rune) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	}
	return -1
}

// isDecimalLiteral matches StrDecimalLiteral without Infinity:
// [+-]? (digits [. digits?] | . digits) ([eE] [+-]? digits)?
func isDecimalLiteral(s string) bool {
	i := 0
	if i < len(s) && (s[i] == '+' || s[i] == '-') {
		i++
	}
	intDigits := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
		intDigits++
	}
	fracDigits := 0
	if i < len(s) && s[i] == '.' {
		i++
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
			fracDigits++
		}
	}
	if intDigits == 0 && fracDigits == 0 {
		return false
	}
	if i < len(s) && (s[i] == 'e' || s[i] == 'E') {
		i++
		if i < len(s) && (s[i] == '+' || s[i] == '-') {
			i++
		}
		expDigits := 0
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
			expDigits++
		}
		if expDigits == 0 {
			return false
		}
	}
	return i == len(s)
}

// jsRound is Math.round (halves toward +Infinity).
func jsRound(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) || math.Abs(x) >= 1<<52 {
		return x
	}
	r := math.Floor(x)
	if x-r >= 0.5 {
		r++
	}
	return r
}

// clampToInt64 saturates a float to the int64 range (JavaScript numbers can exceed it).
func clampToInt64(f float64) int64 {
	switch {
	case f >= 9.223372036854775e18:
		return math.MaxInt64
	case f <= -9.223372036854775e18:
		return math.MinInt64
	}
	return int64(f)
}
