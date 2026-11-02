package jsx

import (
	"encoding/json"
	"os"
	"testing"
)

// testdata/collate.json is written by testdata/gen_collate.mjs from Node 22.
func TestLocaleCompareMatchesNode(t *testing.T) {
	raw, err := os.ReadFile("testdata/collate.json")
	if err != nil {
		t.Fatal(err)
	}
	var ref struct {
		ICU   string               `json:"icu"`
		Pairs [][3]json.RawMessage `json:"pairs"`
	}
	if err := json.Unmarshal(raw, &ref); err != nil {
		t.Fatal(err)
	}
	bad := 0
	for _, p := range ref.Pairs {
		var a, b string
		var want int
		if json.Unmarshal(p[0], &a) != nil || json.Unmarshal(p[1], &b) != nil || json.Unmarshal(p[2], &want) != nil {
			t.Fatalf("bad pair %s", p)
		}
		if got := LocaleCompare(a, b); got != want {
			bad++
			if bad <= 10 {
				t.Errorf("LocaleCompare(%q, %q) = %d, Node %d", a, b, got, want)
			}
		}
	}
	if bad > 0 {
		t.Fatalf("%d of %d pairs differ from Node (ICU %s)", bad, len(ref.Pairs), ref.ICU)
	}
}
