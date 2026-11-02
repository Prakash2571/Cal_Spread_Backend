package model

import (
	"math"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
)

// This file evaluates the handful of JavaScript operations that config.ts and
// calculator.ts apply to untyped JSON (an admin PATCH body, a saved configuration, a
// calculator request), so malformed input fails with the same message Node gave,
// including V8's TypeError texts, and accepted input keeps its exact shape.
//
// JSON values are nil (null), bool, float64, string, []any and *jsjson.Object. A
// missing property is jsUndefined.

type undefinedValue struct{}

// jsUndefined is JavaScript undefined (a missing property).
var jsUndefined any = undefinedValue{}

func isUndefined(v any) bool { _, ok := v.(undefinedValue); return ok }

func isNullish(v any) bool { return v == nil || isUndefined(v) }

// typeError throws a TypeError with V8's message.
func typeError(message string) { panic(&Error{Message: message}) }

// getProp is base[key] (base.key).
func getProp(base any, key string) any {
	switch b := base.(type) {
	case nil:
		typeError("Cannot read properties of null (reading '" + key + "')")
	case undefinedValue:
		typeError("Cannot read properties of undefined (reading '" + key + "')")
	case *jsjson.Object:
		if v, ok := b.Get(key); ok {
			return v
		}
	case []any:
		if key == "length" {
			return float64(len(b))
		}
		if i, ok := indexKey(key); ok && i < len(b) {
			return b[i]
		}
	case string:
		units := utf16.Encode([]rune(b))
		if key == "length" {
			return float64(len(units))
		}
		if i, ok := indexKey(key); ok && i < len(units) {
			return string(utf16.Decode(units[i : i+1]))
		}
	}
	return jsUndefined
}

// indexKey parses a canonical array index.
func indexKey(key string) (int, bool) {
	if key == "" || len(key) > 10 || (len(key) > 1 && key[0] == '0') {
		return 0, false
	}
	n, err := strconv.ParseUint(key, 10, 32)
	if err != nil || n > 4294967294 {
		return 0, false
	}
	return int(n), true
}

// truthy is JavaScript truthiness.
func truthy(v any) bool {
	switch x := v.(type) {
	case nil, undefinedValue:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case string:
		return x != ""
	}
	return true
}

// typeOf is the typeof operator for JSON values.
func typeOf(v any) string {
	switch v.(type) {
	case undefinedValue:
		return "undefined"
	case bool:
		return "boolean"
	case float64:
		return "number"
	case string:
		return "string"
	}
	return "object" // null, arrays, objects
}

func isArray(v any) bool { _, ok := v.([]any); return ok }

// finiteNumber is Number.isFinite(v).
func finiteNumber(v any) (float64, bool) {
	f, ok := v.(float64)
	return f, ok && isFinite(f)
}

// trimCall is v?.trim() where the source text of v?.trim is expr: undefined for a
// nullish v, the trimmed string for a string, else V8's TypeError.
func trimCall(v any, expr string) any {
	switch x := v.(type) {
	case nil, undefinedValue:
		return jsUndefined
	case string:
		return jsTrim(x)
	}
	typeError(expr + " is not a function")
	return nil
}

// objectKeys is Object.keys(v).
func objectKeys(v any) []string {
	switch x := v.(type) {
	case nil, undefinedValue:
		typeError("Cannot convert undefined or null to object")
	case *jsjson.Object:
		return x.Keys()
	case []any:
		keys := make([]string, len(x))
		for i := range x {
			keys[i] = strconv.Itoa(i)
		}
		return keys
	case string:
		n := len(utf16.Encode([]rune(x)))
		keys := make([]string, n)
		for i := range keys {
			keys[i] = strconv.Itoa(i)
		}
		return keys
	}
	return nil
}

type jsEntry struct {
	key   string
	value any
}

// objectEntries is Object.entries(v).
func objectEntries(v any) []jsEntry {
	keys := objectKeys(v)
	out := make([]jsEntry, len(keys))
	for i, k := range keys {
		out[i] = jsEntry{k, getProp(v, k)}
	}
	return out
}

// iterate is for (const x of v) where the source text of v is expr: arrays yield their
// elements, strings their code points; anything else is V8's TypeError.
func iterate(v any, expr string) []any {
	switch x := v.(type) {
	case []any:
		return x
	case string:
		out := []any{}
		for _, r := range x {
			out = append(out, string(r))
		}
		return out
	}
	typeError(expr + " is not iterable")
	return nil
}

// jsToString is String(v).
func jsToString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case undefinedValue:
		return "undefined"
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return jsjson.FormatNumber(x)
	case string:
		return x
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if !isNullish(e) {
				parts[i] = jsToString(e)
			}
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}

// strictEqual is === for JSON values that are primitives (objects compare by identity
// in JavaScript and never equal a literal).
func strictEqual(v any, literal any) bool {
	switch x := v.(type) {
	case nil:
		return literal == nil
	case bool, float64, string:
		return x == literal
	}
	return false
}

// utcTimestampAny is utcTimestamp(value: unknown).
func utcTimestampAny(v any) (string, bool) {
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	return UTCTimestamp(s)
}

// lengthGreater is `v.length > n` for a value whose length may be undefined.
func lengthGreater(v any, n float64) bool {
	l, ok := getProp(v, "length").(float64)
	return ok && l > n
}
