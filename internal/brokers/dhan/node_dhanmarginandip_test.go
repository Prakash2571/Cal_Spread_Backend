package dhan

// Port of tests/box/dhanMarginAndIp.test.mjs "the scan is bounded and safe on odd
// payloads": the margin golden has no bare top-level IP string.

import (
	"strings"
	"testing"
)

func TestNodeIPv4ScanIsSafeOnOddPayloads(t *testing.T) {
	parse := func(s string) Value {
		v, err := ParseJSON([]byte(s))
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	for _, c := range []struct {
		name string
		in   Value
		want []string
	}{
		{"null", parse("null"), nil},
		{"undefined", Value{}, nil},
		{`"203.0.113.7"`, parse(`"203.0.113.7"`), []string{"203.0.113.7"}},
		{"42", NumberValue(42), nil},
	} {
		got := ExtractIPv4Addresses(c.in)
		if len(got) != len(c.want) || strings.Join(got, ",") != strings.Join(c.want, ",") {
			t.Errorf("extractIpv4Addresses(%s) = %q, want %q", c.name, got, c.want)
		}
	}
}
