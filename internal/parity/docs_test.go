package parity

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/model"
)

// Ports the original documentation coverage gate without importing Node config.
func TestFairValueConfigurationAndPrivateRoutesAreDocumented(t *testing.T) {
	data, err := os.ReadFile("../../docs/FAIR_VALUE.md")
	if err != nil {
		t.Fatal(err)
	}
	guide := string(data)
	cfg, err := model.DefaultConfig(nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range cfg.Raw.Keys() {
		if !strings.Contains(guide, "`"+key+"`") && !strings.Contains(guide, "`"+key+".") {
			t.Errorf("missing configuration documentation: %s", key)
		}
		if key != "quote" && key != "iv" && key != "forward" && key != "smile" && key != "curve" {
			continue
		}
		value, _ := cfg.Raw.Get(key)
		for _, field := range value.(*jsjson.Object).Keys() {
			if !strings.Contains(guide, "`"+field+"`") && !strings.Contains(guide, "`"+key+"."+field+"`") {
				t.Errorf("missing configuration documentation: %s.%s", key, field)
			}
		}
	}
	data, err = os.ReadFile("testdata/routes.json")
	if err != nil {
		t.Fatal(err)
	}
	var spec struct {
		Routes []struct{ Method, Path string }
	}
	if err := json.Unmarshal(data, &spec); err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, route := range spec.Routes {
		if !strings.HasPrefix(route.Path, "/api/fair-value/") {
			continue
		}
		count++
		endpoint := route.Method + " " + strings.TrimPrefix(route.Path, "/api/fair-value")
		if !strings.Contains(guide, endpoint) {
			t.Errorf("missing endpoint documentation: %s", endpoint)
		}
	}
	if count != 13 {
		t.Fatalf("documented private routes = %d, want 13", count)
	}
	for _, label := range []string{"supported", "limited", "research", "invalid", "unavailable"} {
		if !strings.Contains(guide, "`"+label+"`") {
			t.Errorf("missing quality label: %s", label)
		}
	}
}
