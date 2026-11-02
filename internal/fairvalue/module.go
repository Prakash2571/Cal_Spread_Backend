package fairvalue

import (
	"log"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/model"
)

// ConfigFromEnv is registerFairValueModule's configuration choice (fairValue/index.ts):
// the environment defaults (FAIR_VALUE_ENABLED, FAIR_VALUE_CONFIG_JSON) and the reason
// the engine is forced off, "" for none. FAIR_VALUE_DISABLED=true forces it off; an
// invalid FAIR_VALUE_CONFIG_JSON falls back to the plain defaults and forces it off with
// the validation (or JSON.parse) message, overriding the deployment switch's reason.
func ConfigFromEnv(env model.LookupEnv, nowMs float64) (model.Config, string) {
	reason := ""
	if v, _ := env("FAIR_VALUE_DISABLED"); v == "true" {
		reason = "Fair Value disabled by FAIR_VALUE_DISABLED deployment switch."
	}
	cfg, err := model.DefaultConfig(env, nowMs)
	if err != nil {
		cfg, _ = model.DefaultConfig(nil, nowMs)
		reason = "Fair Value configuration invalid; analytics disabled: " + err.Error()
		log.Print(reason)
	}
	return cfg, reason
}
