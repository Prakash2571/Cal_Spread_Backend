package synthetic

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/ratecard"
)

// The config section of math_golden.json (gen_math.mjs): src/synthetic/config.ts
// loadSynthConfig and loadFuturesChargeRates under four environments, and every
// clampSynthStrikeLevel / parseSynthSetting input.
func TestConfigGolden(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "math_golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Config struct {
			Loads []struct {
				Env     map[string]string `json:"env"`
				Config  json.RawMessage   `json:"config"`
				Futures json.RawMessage   `json:"futures"`
			} `json:"loads"`
			Clamp []struct {
				Input any  `json:"input"`
				Value *int `json:"value"`
			} `json:"clamp"`
			Parse []struct {
				Key   string `json:"key"`
				Input any    `json:"input"`
				Value struct {
					OK    bool    `json:"ok"`
					Value float64 `json:"value"`
					Error string  `json:"error"`
				} `json:"value"`
			} `json:"parse"`
		} `json:"config"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Config.Loads) < 4 || len(g.Config.Clamp) < 20 || len(g.Config.Parse) < 70 {
		t.Fatalf("config golden too small: %d loads, %d clamp, %d parse", len(g.Config.Loads), len(g.Config.Clamp), len(g.Config.Parse))
	}
	for i, l := range g.Config.Loads {
		get := func(k string) string { return l.Env[k] }
		b, err := encodeJS(LoadConfig(get))
		if err != nil {
			t.Fatal(err)
		}
		if string(b) != string(l.Config) {
			t.Errorf("env set %d config:\n got %s\nwant %s", i, b, l.Config)
		}
		fb, _ := encodeJS(LoadFuturesChargeRates(get, ratecard.Load(get)))
		if string(fb) != string(l.Futures) {
			t.Errorf("env set %d futures rates:\n got %s\nwant %s", i, fb, l.Futures)
		}
	}
	for _, c := range g.Config.Clamp {
		level, ok := ClampStrikeLevel(c.Input)
		var got *int
		if ok {
			got = &level
		}
		if !reflect.DeepEqual(got, c.Value) {
			t.Errorf("ClampStrikeLevel(%#v) = %v, want %v", c.Input, got, c.Value)
		}
	}
	for _, c := range g.Config.Parse {
		v, errText := ParseSetting(c.Key, c.Input)
		if (errText == "") != c.Value.OK || errText != c.Value.Error || (c.Value.OK && v != c.Value.Value) {
			t.Errorf("ParseSetting(%s, %#v) = %v %q, want %+v", c.Key, c.Input, v, errText, c.Value)
		}
	}
}
