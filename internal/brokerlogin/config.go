// Package brokerlogin implements env_home's token API, as used by Live Index Algo.
// It fetches an existing Dhan token; the shared service performs the actual login.
package brokerlogin

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
	"time"
)

type Config struct {
	URL, CFClientID, CFClientSecret string
	ClientID, TokenAPISeed          string
	AutoLoginTime                   string
}

var clientIDPattern = regexp.MustCompile(`^[A-Za-z0-9]+$`)

// LoadConfig validates private server settings without including their values in errors.
// An empty URL disables automatic fetching; token pasting remains available.
func LoadConfig(get func(string) string) (Config, error) {
	c := Config{
		URL:            strings.TrimRight(strings.TrimSpace(get("BROKER_LOGIN_URL")), "/"),
		CFClientID:     strings.TrimSpace(get("BROKER_LOGIN_CF_CLIENT_ID")),
		CFClientSecret: strings.TrimSpace(get("BROKER_LOGIN_CF_CLIENT_SECRET")),
		ClientID:       strings.TrimSpace(get("DHAN_CLIENT_ID")),
		TokenAPISeed:   strings.TrimSpace(get("DHAN_TOKEN_API_SEED")),
		AutoLoginTime:  strings.TrimSpace(get("AUTO_LOGIN_TIME")),
	}
	if c.AutoLoginTime == "" {
		c.AutoLoginTime = "08:30"
	}
	if c.URL == "" {
		if c.CFClientID != "" || c.CFClientSecret != "" || c.TokenAPISeed != "" {
			return c, errors.New("Set BROKER_LOGIN_URL with the broker-login credentials, or paste an access token.")
		}
		return c, nil
	}
	u, err := url.Parse(c.URL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return c, errors.New("BROKER_LOGIN_URL must be https://<host> with no path, query or credentials.")
	}
	if c.CFClientID == "" || c.CFClientSecret == "" {
		return c, errors.New("BROKER_LOGIN_CF_CLIENT_ID and BROKER_LOGIN_CF_CLIENT_SECRET are required for automatic token fetching.")
	}
	if !clientIDPattern.MatchString(c.ClientID) {
		return c, errors.New("DHAN_CLIENT_ID must be an alphanumeric Dhan client ID.")
	}
	if _, err := decodeSeed(c.TokenAPISeed); err != nil {
		return c, err
	}
	if _, err := time.Parse("15:04", c.AutoLoginTime); err != nil || len(c.AutoLoginTime) != 5 {
		return c, errors.New("AUTO_LOGIN_TIME must be HH:MM in IST.")
	}
	return c, nil
}
