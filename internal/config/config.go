// Package config reads the process environment. Names and defaults match the Node
// backend (docs/CONFIGURATION.md); only the storage variables changed: a single
// DATABASE_URL replaces the MongoDB and Upstash Redis settings.
package config

import (
	"math"
	"os"
	"strings"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
)

// Getter looks up an environment variable. Tests pass a map-backed one.
type Getter func(key string) string

// OS reads the real environment.
func OS(key string) string { return os.Getenv(key) }

// MapGetter serves values from a map (tests).
func MapGetter(m map[string]string) Getter { return func(k string) string { return m[k] } }

// Config is the server-level configuration. Feature packages (Synthetic, Fair Value,
// the brokers) read their own variables through the same Getter.
type Config struct {
	Host        string
	Port        int
	FrontendURL string
	DatabaseURL string

	AdminSecret         string
	AccessSecret        string
	TokenRouteSecret    string
	InternalTokenSecret string

	KiteAPIKey    string
	KiteAPISecret string

	// ExtraSessionDays are IST dates that are trading sessions although they fall on a
	// weekend (muhurat and other special sessions), as ISO dates.
	ExtraSessionDays map[string]bool

	Env Getter
}

// Load builds a Config from get. Blank values fall back to the Node defaults.
func Load(get Getter) Config {
	c := Config{
		Host:                strings.TrimSpace(get("HOST")),
		Port:                int(Num(get, "PORT", 3001)),
		FrontendURL:         Str(get, "FRONTEND_URL", "http://localhost:5173"),
		DatabaseURL:         strings.TrimSpace(get("DATABASE_URL")),
		AdminSecret:         strings.TrimSpace(get("ADMIN_SECRET")),
		AccessSecret:        strings.TrimSpace(get("ACCESS_SECRET")),
		TokenRouteSecret:    strings.TrimSpace(get("TOKEN_ROUTE_SECRET")),
		InternalTokenSecret: strings.TrimSpace(get("INTERNAL_TOKEN_SECRET")),
		KiteAPIKey:          strings.TrimSpace(get("KITE_API_KEY")),
		KiteAPISecret:       strings.TrimSpace(get("KITE_API_SECRET")),
		ExtraSessionDays:    map[string]bool{},
		Env:                 get,
	}
	for _, d := range strings.Split(get("EXTRA_SESSION_DAYS"), ",") {
		if d = strings.TrimSpace(d); d != "" {
			c.ExtraSessionDays[d] = true
		}
	}
	return c
}

// Str returns the trimmed value of key, or def when it is unset or blank.
func Str(get Getter, key, def string) string {
	if v := strings.TrimSpace(get(key)); v != "" {
		return v
	}
	return def
}

// Num is the Node `num(name, fallback)` helper: a finite number >= 0, else def.
func Num(get Getter, key string, def float64) float64 {
	v, ok := NumAny(get, key)
	if !ok || v < 0 {
		return def
	}
	return v
}

// NumAny parses key like JavaScript's Number(): ok is false when the variable is unset,
// blank or not a finite number. Negative values are allowed.
func NumAny(get Getter, key string) (float64, bool) {
	raw := strings.TrimSpace(get(key))
	if raw == "" {
		return 0, false
	}
	v, ok := jsx.ParseNumber(raw)
	if !ok || math.IsInf(v, 0) || math.IsNaN(v) {
		return 0, false
	}
	return v, true
}

// Bool is the Node `bool(name, fallback)` helper: 1/true/yes and 0/false/no
// (case-insensitive, trimmed); anything else, or unset, gives def.
func Bool(get Getter, key string, def bool) bool {
	switch strings.ToLower(strings.TrimSpace(get(key))) {
	case "1", "true", "yes":
		return true
	case "0", "false", "no":
		return false
	}
	return def
}
