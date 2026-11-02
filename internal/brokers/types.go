// Package brokers holds broker identity and, as the port proceeds, the active-broker
// registry, subscriptions and feed plumbing shared by the market-data features.
package brokers

import "strings"

// ID is the one canonical broker discriminator. Exactly one broker owns the market-data
// feed at any instant; historical records of both brokers coexist in the database.
type ID string

const (
	Zerodha ID = "zerodha"
	Dhan    ID = "dhan"
)

// IDs lists the only two brokers the application knows, in canonical order.
var IDs = []ID{Zerodha, Dhan}

// Legacy is the broker every record written before broker identity existed belongs to:
// Zerodha was the only integration that had ever run.
const Legacy = Zerodha

// IsID reports whether s is exactly "zerodha" or "dhan" (case-sensitive).
func IsID(s string) bool { return s == string(Zerodha) || s == string(Dhan) }

// Of resolves the broker of a record that may predate broker identity: a missing or
// unrecognised value reads as Zerodha.
func Of(stored *string) ID {
	if stored != nil && IsID(*stored) {
		return ID(*stored)
	}
	return Legacy
}

// Label is the human-facing badge text.
func (b ID) Label() string {
	if b == Dhan {
		return "DHAN"
	}
	return "ZERODHA"
}

// Parse reads a broker supplied by an API client: only strings are accepted, trimmed and
// lower-cased. ok is false for anything else so the caller can answer 400 instead of
// silently picking a broker the operator did not ask for.
func Parse(v any) (ID, bool) {
	s, isStr := v.(string)
	if !isStr {
		return "", false
	}
	s = strings.ToLower(strings.TrimSpace(s))
	if !IsID(s) {
		return "", false
	}
	return ID(s), true
}
