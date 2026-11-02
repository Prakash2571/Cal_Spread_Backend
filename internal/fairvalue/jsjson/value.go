package jsjson

import (
	"encoding/json"
	"math"
	"sort"
	"strconv"

	kitejson "github.com/Prakash2571/Cal_Spread_Backend/internal/kite/jsjson"
)

// Object is a JavaScript plain object decoded from JSON: own properties in
// JavaScript's enumeration order. Values are nil (null), bool, float64, string,
// []any or *Object.
type Object struct {
	keys []string
	vals map[string]any
	// unordered marks objects converted from a Go map, whose original key order is lost.
	unordered bool
}

// NewObjectValue returns an empty object.
func NewObjectValue() *Object { return &Object{vals: map[string]any{}} }

// Get returns the value of key and whether it is an own property.
func (o *Object) Get(key string) (any, bool) {
	if o == nil {
		return nil, false
	}
	v, ok := o.vals[key]
	return v, ok
}

// Has reports whether key is an own property (Object.hasOwn).
func (o *Object) Has(key string) bool { _, ok := o.Get(key); return ok }

// Set defines key. An existing key keeps its position, as in JavaScript.
func (o *Object) Set(key string, v any) {
	if o.vals == nil {
		o.vals = map[string]any{}
	}
	if _, ok := o.vals[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.vals[key] = v
}

// Delete removes key.
func (o *Object) Delete(key string) {
	if _, ok := o.vals[key]; !ok {
		return
	}
	delete(o.vals, key)
	for i, k := range o.keys {
		if k == key {
			o.keys = append(o.keys[:i:i], o.keys[i+1:]...)
			break
		}
	}
}

// Len is the number of own properties.
func (o *Object) Len() int {
	if o == nil {
		return 0
	}
	return len(o.keys)
}

// Keys returns the keys in JavaScript order (Object.keys).
func (o *Object) Keys() []string {
	if o == nil {
		return nil
	}
	return jsKeyOrder(o.keys)
}

// Unordered reports whether the object came from a Go map (key order unknown).
func (o *Object) Unordered() bool { return o != nil && o.unordered }

// Clone deep-copies the object (structuredClone of plain JSON data).
func (o *Object) Clone() *Object {
	if o == nil {
		return nil
	}
	c := &Object{keys: append([]string(nil), o.keys...), vals: make(map[string]any, len(o.vals)), unordered: o.unordered}
	for k, v := range o.vals {
		c.vals[k] = CloneValue(v)
	}
	return c
}

// CloneValue deep-copies a decoded JSON value.
func CloneValue(v any) any {
	switch x := v.(type) {
	case *Object:
		return x.Clone()
	case []any:
		c := make([]any, len(x))
		for i, e := range x {
			c[i] = CloneValue(e)
		}
		return c
	}
	return v
}

// AppendJS writes the object with JavaScript property order.
func (o *Object) AppendJS(dst []byte) []byte {
	if o == nil {
		return append(dst, "null"...)
	}
	dst = append(dst, '{')
	for i, k := range o.Keys() {
		if i > 0 {
			dst = append(dst, ',')
		}
		dst = AppendString(dst, k)
		dst = append(dst, ':')
		dst = Append(dst, o.vals[k])
	}
	return append(dst, '}')
}

// arrayIndex reports whether k is a canonical array index (0 .. 2**32-2).
func arrayIndex(k string) (uint64, bool) {
	if k == "" || len(k) > 10 || (len(k) > 1 && k[0] == '0') {
		return 0, false
	}
	n, err := strconv.ParseUint(k, 10, 64)
	if err != nil || n > 4294967294 {
		return 0, false
	}
	return n, true
}

// jsKeyOrder puts array-index keys first in ascending numeric order and keeps the
// remaining keys in their given order.
func jsKeyOrder(keys []string) []string {
	var idx []string
	var rest []string
	for _, k := range keys {
		if _, ok := arrayIndex(k); ok {
			idx = append(idx, k)
		} else {
			rest = append(rest, k)
		}
	}
	if len(idx) == 0 {
		return append([]string(nil), keys...)
	}
	sort.SliceStable(idx, func(i, j int) bool {
		a, _ := arrayIndex(idx[i])
		b, _ := arrayIndex(idx[j])
		return a < b
	})
	return append(idx, rest...)
}

// Parse is JSON.parse: it keeps object key order (with JavaScript's index-key rule),
// later duplicate keys overwrite earlier ones in place, numbers beyond the double range
// become infinities, and syntax errors carry V8's message text (the parser is the one
// internal/kite/jsjson verified against Node 22).
func Parse(data []byte) (any, error) {
	v, err := kitejson.Parse(string(data))
	if err != nil {
		return nil, err
	}
	return fromKite(v), nil
}

// fromKite converts a parsed value into this package's representation.
func fromKite(v *kitejson.Value) any {
	switch v.Kind() {
	case kitejson.Bool:
		return v.Truthy()
	case kitejson.Number:
		return v.Num()
	case kitejson.String:
		return v.Str()
	case kitejson.Array:
		elems := v.Elems()
		out := make([]any, len(elems))
		for i, e := range elems {
			out[i] = fromKite(e)
		}
		return out
	case kitejson.Object:
		keys := v.Keys()
		o := &Object{keys: make([]string, 0, len(keys)), vals: make(map[string]any, len(keys))}
		for _, k := range keys {
			o.keys = append(o.keys, k)
			o.vals[k] = fromKite(v.Get(k))
		}
		return o
	}
	return nil
}

// FromGo converts a value decoded by encoding/json into an ordered value. Object keys
// of Go maps have no order; they are sorted and the objects are marked unordered.
func FromGo(v any) any {
	switch x := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		o := &Object{vals: make(map[string]any, len(x)), unordered: true}
		for _, k := range keys {
			o.Set(k, FromGo(x[k]))
		}
		return o
	case []any:
		c := make([]any, len(x))
		for i, e := range x {
			c[i] = FromGo(e)
		}
		return c
	case json.Number:
		f, _ := strconv.ParseFloat(string(x), 64)
		return f
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case float32:
		return float64(x)
	}
	return v
}

// IsFinite reports whether v is a finite number.
func IsFinite(v any) bool {
	f, ok := v.(float64)
	return ok && !math.IsNaN(f) && !math.IsInf(f, 0)
}
