package auth_test

// Ports of the tests/box/tokenRouteAuth.test.mjs cases that TestCheckPasscode and
// TestReadPasscode did not assert with Node's inputs. Mapping: Node's `undefined`
// configured secret is an unset environment variable, "" in Go; Node's `undefined`
// passcode is supplied=false. readPasscode(header, query) is ReadPasscode over a real
// request carrying that header and/or query parameter.

import (
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/auth"
)

const nodeSecret = "s3cr3t-passcode-value"

// "an UNSET secret disables the route, it never grants access"
func TestNodeTokenRouteUnsetSecretDisablesTheRoute(t *testing.T) {
	// undefined, "", "   ", "\t\n"
	for _, configured := range []string{"", "", "   ", "\t\n"} {
		if got := auth.CheckPasscode(configured, "anything", true); got != auth.PasscodeNotConfigured {
			t.Errorf("configured=%q must disable the route, got %v", configured, got)
		}
	}
}

// "an unset secret is not_configured even when the caller sends nothing"
func TestNodeTokenRouteUnsetSecretWithNothingSent(t *testing.T) {
	if got := auth.CheckPasscode("", "", true); got != auth.PasscodeNotConfigured { // ("", "")
		t.Errorf(`checkTokenPasscode("", "") = %v, want not_configured`, got)
	}
	if got := auth.CheckPasscode("", "", false); got != auth.PasscodeNotConfigured { // (undefined, undefined)
		t.Errorf("checkTokenPasscode(undefined, undefined) = %v, want not_configured", got)
	}
}

// "near-miss passcodes are refused"
func TestNodeTokenRouteNearMissesAreRefused(t *testing.T) {
	for _, wrong := range []string{
		strings.ToUpper(nodeSecret),              // SECRET.toUpperCase()
		nodeSecret[:len(nodeSecret)-1],           // SECRET.slice(0, -1)
		nodeSecret + "x",                         // `${SECRET}x`
		strings.Replace(nodeSecret, "3", "e", 1), // SECRET.replace("3", "e"): first match only
		"",
	} {
		if got := auth.CheckPasscode(nodeSecret, wrong, true); got != auth.PasscodeForbidden {
			t.Errorf("%q: got %v, want forbidden", wrong, got)
		}
	}
}

// "comparison tolerates length differences without throwing"
func TestNodeTokenRouteLengthDifferencesDoNotPanic(t *testing.T) {
	long := strings.Repeat("a", 5000)
	if got := auth.CheckPasscode("short", long, true); got != auth.PasscodeForbidden {
		t.Errorf("short vs 5000 chars: %v", got)
	}
	if got := auth.CheckPasscode(long, "short", true); got != auth.PasscodeForbidden {
		t.Errorf("5000 chars vs short: %v", got)
	}
}

// "end to end: only the real passcode from either source is accepted"
func TestNodeTokenRouteEndToEnd(t *testing.T) {
	check := func(target string, hdr ...string) auth.PasscodeResult {
		r := httptest.NewRequest("GET", target, nil)
		for i := 0; i+1 < len(hdr); i += 2 {
			r.Header.Add(hdr[i], hdr[i+1])
		}
		v, ok := auth.ReadPasscode(r, "x-token-passcode", "passcode")
		return auth.CheckPasscode(nodeSecret, v, ok)
	}
	q := "/?passcode=" + url.QueryEscape(nodeSecret)
	if got := check("/", "x-token-passcode", nodeSecret); got != auth.PasscodeOK { // readPasscode(SECRET, undefined)
		t.Errorf("header only: %v, want ok", got)
	}
	if got := check(q); got != auth.PasscodeOK { // readPasscode(undefined, SECRET)
		t.Errorf("query only: %v, want ok", got)
	}
	if got := check("/"); got != auth.PasscodeForbidden { // readPasscode(undefined, undefined)
		t.Errorf("neither: %v, want forbidden", got)
	}
	if got := check(q, "x-token-passcode", "nope"); got != auth.PasscodeForbidden { // readPasscode("nope", SECRET)
		t.Errorf("wrong header beats a right query: %v, want forbidden", got)
	}
}
