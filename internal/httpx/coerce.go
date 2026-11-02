package httpx

import (
	"math"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
)

// ToNumber is JavaScript's Number(v) for a decoded JSON value: null is 0, booleans are
// 0/1, numeric strings convert (blank is 0), an empty array is 0 and a one-element array
// converts its element. Anything else, and a missing value, is NaN.
func ToNumber(v any) float64 {
	switch x := v.(type) {
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case string:
		n, ok := jsx.ParseNumber(x)
		if !ok {
			return math.NaN()
		}
		return n
	case []any:
		switch len(x) {
		case 0:
			return 0
		case 1:
			return ToNumber(x[0])
		}
	}
	return math.NaN()
}

// Field returns body[key] and whether the key was present. A missing key is JavaScript's
// undefined, which Number() turns into NaN but String(v ?? "") into "".
func Field(body map[string]any, key string) (any, bool) {
	v, ok := body[key]
	return v, ok
}

// NumberField is Number(body[key]): a missing key is NaN, an explicit null is 0.
func NumberField(body map[string]any, key string) float64 {
	v, ok := body[key]
	if !ok {
		return math.NaN()
	}
	return ToNumber(v)
}

// StringField is body[key] when it is a string, else "" (the `typeof x === "string"` guard).
func StringField(body map[string]any, key string) string {
	s, _ := body[key].(string)
	return s
}
