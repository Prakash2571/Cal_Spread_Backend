package captures

import (
	"math"
	"testing"
)

// The JavaScript primitives behind jsutil.go, checked against what Node computed for the
// same inputs (testdata/jsutil.json, written by gen_parity.mjs).

type jsutilFixture struct {
	ParseInt []struct {
		In  string `json:"in"`
		Out any    `json:"out"`
	} `json:"parse_int"`
	NumString []struct {
		In  any    `json:"in"`
		Out string `json:"out"`
	} `json:"num_string"`
	Pad2 []struct {
		In  any    `json:"in"`
		Out string `json:"out"`
	} `json:"pad2"`
	ParseDay []struct {
		In       string   `json:"in"`
		Ms       *float64 `json:"ms"`
		MsMillis *float64 `json:"ms_millis_form"`
	} `json:"parse_day"`
	ISOString []struct {
		In  any     `json:"in"`
		Out *string `json:"out"`
	} `json:"iso_string"`
	Encode []struct {
		In  string `json:"in"`
		Out string `json:"out"`
	} `json:"encode"`
}

// fixtureNumber decodes the number encoding of the fixture: JSON numbers, plus the
// strings NaN, Infinity, -Infinity and -0 for values JSON cannot carry.
func fixtureNumber(t *testing.T, v any) float64 {
	t.Helper()
	switch x := v.(type) {
	case float64:
		return x
	case string:
		switch x {
		case "NaN":
			return math.NaN()
		case "Infinity":
			return math.Inf(1)
		case "-Infinity":
			return math.Inf(-1)
		case "-0":
			return math.Copysign(0, -1)
		}
	}
	t.Fatalf("bad fixture number %#v", v)
	return 0
}

func sameFloat(a, b float64) bool {
	if math.IsNaN(a) || math.IsNaN(b) {
		return math.IsNaN(a) && math.IsNaN(b)
	}
	return a == b
}

func TestJSUtilMatchesNode(t *testing.T) {
	var f jsutilFixture
	readFixture(t, "jsutil.json", &f)
	if len(f.ParseInt) < 20 || len(f.NumString) < 20 || len(f.ParseDay) < 40 || len(f.ISOString) < 20 || len(f.Encode) < 10 {
		t.Fatalf("fixture is too small: %d/%d/%d/%d/%d", len(f.ParseInt), len(f.NumString), len(f.ParseDay), len(f.ISOString), len(f.Encode))
	}

	t.Run("parseInt", func(t *testing.T) {
		for _, c := range f.ParseInt {
			if got, want := jsParseInt10(c.In), fixtureNumber(t, c.Out); !sameFloat(got, want) {
				t.Errorf("parseInt(%q, 10) = %v, Node %v", c.In, got, want)
			}
		}
	})
	t.Run("String(number)", func(t *testing.T) {
		for _, c := range f.NumString {
			if got := jsNumString(fixtureNumber(t, c.In)); got != c.Out {
				t.Errorf("String(%v) = %q, Node %q", c.In, got, c.Out)
			}
		}
	})
	t.Run("padStart", func(t *testing.T) {
		for _, c := range f.Pad2 {
			if got := padStart2(fixtureNumber(t, c.In)); got != c.Out {
				t.Errorf("String(%v).padStart(2, \"0\") = %q, Node %q", c.In, got, c.Out)
			}
		}
	})
	t.Run("Date parsing", func(t *testing.T) {
		valid := 0
		for _, c := range f.ParseDay {
			if (c.Ms == nil) != (c.MsMillis == nil) || (c.Ms != nil && *c.Ms != *c.MsMillis) {
				t.Fatalf("Node parses %q differently with and without milliseconds", c.In)
			}
			got, ok := parseJSDay(c.In)
			switch {
			case c.Ms == nil && ok:
				t.Errorf("parseJSDay(%q) = %v, Node Invalid Date", c.In, got)
			case c.Ms != nil && (!ok || float64(got.UnixMilli()) != *c.Ms):
				t.Errorf("parseJSDay(%q) = %v (ok=%v), Node %v", c.In, got.UnixMilli(), ok, *c.Ms)
			}
			if c.Ms != nil {
				valid++
			}
		}
		if valid < 15 {
			t.Fatalf("only %d valid dates in the fixture", valid)
		}
	})
	t.Run("toISOString", func(t *testing.T) {
		for _, c := range f.ISOString {
			got, ok := jsISOString(fixtureNumber(t, c.In))
			switch {
			case c.Out == nil && ok:
				t.Errorf("jsISOString(%v) = %q, Node throws RangeError", c.In, got)
			case c.Out != nil && (!ok || got != *c.Out):
				t.Errorf("jsISOString(%v) = %q (ok=%v), Node %q", c.In, got, ok, *c.Out)
			}
		}
	})
	t.Run("encodeURIComponent", func(t *testing.T) {
		for _, c := range f.Encode {
			got, ok := encodeURIComponent(c.In)
			if !ok || got != c.Out {
				t.Errorf("encodeURIComponent(%q) = %q (ok=%v), Node %q", c.In, got, ok, c.Out)
			}
		}
		// A lone surrogate is a URIError in JavaScript; the Go analogue is invalid UTF-8.
		if _, ok := encodeURIComponent("a\xffb"); ok {
			t.Error("invalid UTF-8 must not encode")
		}
	})
}

func TestIsoDayAndWeekdayAgree(t *testing.T) {
	// isoDay is toISOString().slice(0, 10) for a valid instant.
	for _, c := range []struct{ in, want string }{
		{"2026-03-07", "2026-03-07"},
		{"2026-02-30", "2026-03-02"},    // V8 rolls the day forward
		{"+275760-09-13", "+275760-09"}, // slice(0, 10) of the six-digit-year form
	} {
		tm, ok := parseJSDay(c.in)
		if !ok {
			t.Fatalf("parseJSDay(%q) failed", c.in)
		}
		if got := isoDay(tm); got != c.want {
			t.Errorf("isoDay(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
