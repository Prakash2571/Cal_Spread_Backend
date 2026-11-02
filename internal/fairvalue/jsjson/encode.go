package jsjson

import (
	"encoding/json"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Marshaler is implemented by types that write their own JSON (for key orders that
// depend on how the TypeScript object was built).
type Marshaler interface {
	AppendJS(dst []byte) []byte
}

// RawObject adapts a function that appends one JSON value to a Marshaler.
type RawObject func(dst []byte) []byte

// AppendJS calls the function.
func (f RawObject) AppendJS(dst []byte) []byte { return f(dst) }

// Marshal returns the JSON.stringify text of v. It never fails: values JSON.stringify
// cannot represent become null.
func Marshal(v any) []byte { return Append(nil, v) }

// Append appends the JSON text of v to dst.
func Append(dst []byte, v any) []byte {
	if v == nil {
		return append(dst, "null"...)
	}
	return appendValue(dst, reflect.ValueOf(v))
}

var (
	marshalerType     = reflect.TypeOf((*Marshaler)(nil)).Elem()
	jsonMarshalerType = reflect.TypeOf((*json.Marshaler)(nil)).Elem()
)

func appendValue(dst []byte, v reflect.Value) []byte {
	if !v.IsValid() {
		return append(dst, "null"...)
	}
	t := v.Type()
	if t.Kind() == reflect.Pointer && v.IsNil() {
		return append(dst, "null"...)
	}
	if t.Implements(marshalerType) {
		if t.Kind() == reflect.Interface && v.IsNil() {
			return append(dst, "null"...)
		}
		return v.Interface().(Marshaler).AppendJS(dst)
	}
	if t.Kind() != reflect.Pointer && reflect.PointerTo(t).Implements(marshalerType) {
		if v.CanAddr() {
			return v.Addr().Interface().(Marshaler).AppendJS(dst)
		}
		p := reflect.New(t)
		p.Elem().Set(v)
		return p.Interface().(Marshaler).AppendJS(dst)
	}
	if t.Kind() != reflect.Interface && t.Implements(jsonMarshalerType) {
		raw, err := v.Interface().(json.Marshaler).MarshalJSON()
		if err != nil {
			return append(dst, "null"...)
		}
		return appendForeign(dst, raw)
	}
	switch t.Kind() {
	case reflect.Interface:
		if v.IsNil() {
			return append(dst, "null"...)
		}
		return appendValue(dst, v.Elem())
	case reflect.Pointer:
		return appendValue(dst, v.Elem())
	case reflect.Bool:
		if v.Bool() {
			return append(dst, "true"...)
		}
		return append(dst, "false"...)
	case reflect.String:
		return AppendString(dst, v.String())
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return strconv.AppendInt(dst, v.Int(), 10)
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		return strconv.AppendUint(dst, v.Uint(), 10)
	case reflect.Float32, reflect.Float64:
		return AppendFloat(dst, v.Float())
	case reflect.Slice, reflect.Array:
		dst = append(dst, '[')
		for i := 0; i < v.Len(); i++ {
			if i > 0 {
				dst = append(dst, ',')
			}
			dst = appendValue(dst, v.Index(i))
		}
		return append(dst, ']')
	case reflect.Map:
		return appendMap(dst, v)
	case reflect.Struct:
		return appendStruct(dst, v)
	}
	// Functions, channels and complex numbers are undefined in JavaScript terms.
	return append(dst, "null"...)
}

// appendForeign re-encodes JSON produced by encoding/json (a foreign json.Marshaler) so
// its numbers and strings follow JavaScript's formatting.
func appendForeign(dst []byte, raw []byte) []byte {
	v, err := Parse(raw)
	if err != nil {
		return append(dst, "null"...)
	}
	return Append(dst, v)
}

func appendMap(dst []byte, v reflect.Value) []byte {
	if v.Type().Key().Kind() != reflect.String {
		return append(dst, "{}"...)
	}
	keys := make([]string, 0, v.Len())
	for _, k := range v.MapKeys() {
		keys = append(keys, k.String())
	}
	// Go maps have no order; JavaScript would use insertion order. Index-like keys first
	// (as JavaScript does), the rest sorted so output is deterministic.
	sort.Strings(keys)
	keys = jsKeyOrder(keys)
	dst = append(dst, '{')
	for i, k := range keys {
		if i > 0 {
			dst = append(dst, ',')
		}
		dst = AppendString(dst, k)
		dst = append(dst, ':')
		dst = appendValue(dst, v.MapIndex(reflect.ValueOf(k).Convert(v.Type().Key())))
	}
	return append(dst, '}')
}

type fieldInfo struct {
	index     []int
	name      string
	omitEmpty bool
}

var fieldCache sync.Map // reflect.Type -> []fieldInfo

func structFields(t reflect.Type) []fieldInfo {
	if f, ok := fieldCache.Load(t); ok {
		return f.([]fieldInfo)
	}
	var fields []fieldInfo
	var walk func(t reflect.Type, index []int)
	walk = func(t reflect.Type, index []int) {
		for i := 0; i < t.NumField(); i++ {
			sf := t.Field(i)
			tag := sf.Tag.Get("json")
			if tag == "-" {
				continue
			}
			idx := append(append([]int(nil), index...), i)
			name, opts, _ := strings.Cut(tag, ",")
			if sf.Anonymous && name == "" {
				ft := sf.Type
				if ft.Kind() == reflect.Pointer {
					ft = ft.Elem()
				}
				if ft.Kind() == reflect.Struct {
					walk(ft, idx)
					continue
				}
			}
			if !sf.IsExported() {
				continue
			}
			if name == "" {
				name = sf.Name
			}
			fields = append(fields, fieldInfo{index: idx, name: name, omitEmpty: strings.Contains(opts, "omitempty")})
		}
	}
	walk(t, nil)
	fieldCache.Store(t, fields)
	return fields
}

func appendStruct(dst []byte, v reflect.Value) []byte {
	dst = append(dst, '{')
	first := true
	for _, f := range structFields(v.Type()) {
		fv, ok := fieldByIndex(v, f.index)
		if !ok {
			continue
		}
		if f.omitEmpty && isEmpty(fv) {
			continue
		}
		if !first {
			dst = append(dst, ',')
		}
		first = false
		dst = AppendString(dst, f.name)
		dst = append(dst, ':')
		dst = appendValue(dst, fv)
	}
	return append(dst, '}')
}

func fieldByIndex(v reflect.Value, index []int) (reflect.Value, bool) {
	for i, x := range index {
		if i > 0 && v.Kind() == reflect.Pointer {
			if v.IsNil() {
				return reflect.Value{}, false
			}
			v = v.Elem()
		}
		v = v.Field(x)
	}
	return v, true
}

// isEmpty is encoding/json's omitempty rule, so a struct written for encoding/json keeps
// the same fields when httpx.JSON encodes it through this package.
func isEmpty(v reflect.Value) bool {
	switch v.Kind() {
	case reflect.Pointer, reflect.Interface:
		return v.IsNil()
	case reflect.Slice, reflect.Map, reflect.Array, reflect.String:
		return v.Len() == 0
	case reflect.Bool:
		return !v.Bool()
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return v.Int() == 0
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		return v.Uint() == 0
	case reflect.Float32, reflect.Float64:
		return v.Float() == 0
	}
	return false
}

// ObjectWriter builds a JSON object by hand, for Marshaler implementations.
type ObjectWriter struct {
	buf   []byte
	first bool
}

// NewObject starts an object appended to dst.
func NewObject(dst []byte) *ObjectWriter { return &ObjectWriter{buf: append(dst, '{'), first: true} }

// Field appends "key":value.
func (o *ObjectWriter) Field(key string, value any) *ObjectWriter {
	if !o.first {
		o.buf = append(o.buf, ',')
	}
	o.first = false
	o.buf = AppendString(o.buf, key)
	o.buf = append(o.buf, ':')
	o.buf = Append(o.buf, value)
	return o
}

// End closes the object and returns the buffer.
func (o *ObjectWriter) End() []byte { return append(o.buf, '}') }
