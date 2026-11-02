package auth_test

// Ports of the tests/box/adminToken.test.mjs cases that TestGenerateTokenShape did not
// assert with Node's inputs: "1000 tokens are all distinct", "a token embeds NO
// timestamp" and "output is not obviously biased".

import (
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/auth"
)

// "1000 tokens are all distinct"
func TestNodeAdminTokenThousandTokensAreDistinct(t *testing.T) {
	seen := make(map[string]bool, 1000)
	for i := 0; i < 1000; i++ {
		seen[auth.GenerateToken()] = true
	}
	if len(seen) != 1000 {
		t.Fatalf("%d distinct tokens out of 1000", len(seen))
	}
}

// "a token embeds NO timestamp": two successive tokens share a trailing run shorter
// than 5 characters.
func TestNodeAdminTokenEmbedsNoTimestamp(t *testing.T) {
	a, b := auth.GenerateToken(), auth.GenerateToken()
	shared := 0
	for shared < min(len(a), len(b)) && a[len(a)-1-shared] == b[len(b)-1-shared] {
		shared++
	}
	if shared >= 5 {
		t.Fatalf("tokens share a %d-char suffix, suggesting a timestamp: %q %q", shared, a, b)
	}
}

// "output is not obviously biased": more than 40 distinct characters over 500 tokens.
func TestNodeAdminTokenOutputIsNotObviouslyBiased(t *testing.T) {
	alphabet := map[rune]bool{}
	for i := 0; i < 500; i++ {
		for _, ch := range auth.GenerateToken() {
			alphabet[ch] = true
		}
	}
	if len(alphabet) <= 40 {
		t.Fatalf("only %d distinct characters observed", len(alphabet))
	}
}
