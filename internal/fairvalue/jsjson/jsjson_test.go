package jsjson

import (
	"math"
	"testing"
)

// Expected strings were printed by Node 22 (String(x), JSON.stringify, Object.keys).
func TestFormatNumber(t *testing.T) {
	cases := map[float64]string{
		1e-7: "1e-7", 1.5e-7: "1.5e-7", 1e21: "1e+21", 123e-20: "1.23e-18", 0.0025 * 100: "0.25",
		-0.5: "-0.5", 1e8: "100000000", 1e-8: "1e-8", 9007199254740992: "9007199254740992",
		0.1: "0.1", 1e-6: "0.000001", 123456789012345680000: "123456789012345680000", 1.7976931348623157e308: "1.7976931348623157e+308",
		5e-324: "5e-324", 2.5: "2.5", 100: "100", -1e-7: "-1e-7", 0.30000000000000004: "0.30000000000000004",
	}
	for x, want := range cases {
		if got := FormatNumber(x); got != want {
			t.Errorf("FormatNumber(%v) = %q, want %q", x, got, want)
		}
	}
	if FormatNumber(math.Copysign(0, -1)) != "0" || FormatNumber(math.NaN()) != "NaN" || FormatNumber(math.Inf(-1)) != "-Infinity" {
		t.Fatal("specials")
	}
}

func TestMarshalLikeJSONStringify(t *testing.T) {
	type inner struct {
		A float64  `json:"a"`
		B *float64 `json:"b"`
		C *string  `json:"c,omitempty"`
		D []int    `json:"d"`
	}
	nan := math.NaN()
	got := string(Marshal(map[string]any{"x": inner{A: math.Copysign(0, -1), B: &nan}, "s": "\u2028\u0007\"\\<>&"}))
	want := `{"s":"` + "\u2028" + `\u0007\"\\<>&","x":{"a":0,"b":null,"d":[]}}`
	if got != want {
		t.Fatalf("got %s\nwant %s", got, want)
	}
}

func TestParseKeepsJavaScriptOrder(t *testing.T) {
	v, err := Parse([]byte(`{"b":1,"2":2,"a":3,"1":4,"4294967295":5,"4294967294":6,"01":7,"b":8}`))
	if err != nil {
		t.Fatal(err)
	}
	o := v.(*Object)
	if got := string(Marshal(o)); got != `{"1":4,"2":2,"4294967294":6,"b":8,"a":3,"4294967295":5,"01":7}` {
		t.Fatalf("order %s", got)
	}
	big, _ := Parse([]byte(`[1e400,-1e400]`))
	if !math.IsInf(big.([]any)[0].(float64), 1) {
		t.Fatal("1e400 should parse as Infinity")
	}
	if _, err := Parse([]byte(`{} x`)); err == nil {
		t.Fatal("trailing data accepted")
	}
}
