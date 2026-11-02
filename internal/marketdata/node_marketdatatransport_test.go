package marketdata

// Ports of the tests/box/marketDataTransport.test.mjs cases that TestParseTokenList and
// TestSessionRoundTripAndIDs asserted only in part (helpers storeAt, board and toAny of
// session_test.go). The coordinator cases of that suite are in
// internal/brokers/node_marketdatatransport_test.go.

import (
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
)

// "only positive integers are accepted": [0], [-1], [1.5], [NaN], [Infinity], ["123"],
// [null], [{}] are each rejected (NaN and Infinity were not in the Go test).
func TestNodeOnlyPositiveIntegerTokensAreAccepted(t *testing.T) {
	for _, bad := range []any{
		toAny(0.0), toAny(-1.0), toAny(1.5), toAny(math.NaN()), toAny(math.Inf(1)), toAny("123"), toAny(nil), toAny(map[string]any{}),
	} {
		if _, e := ParseTokenList(bad, 0); e == "" {
			t.Errorf("%#v must be rejected", bad)
		}
	}
}

// "token lists are deduplicated": [7, 7, 8, 9, 9, 9] -> [7, 8, 9] (the whole list).
func TestNodeTokenListsAreDeduplicated(t *testing.T) {
	got, e := ParseTokenList(toAny(7.0, 7.0, 8.0, 9.0, 9.0, 9.0), 0)
	if e != "" || !reflect.DeepEqual(got, []int64{7, 8, 9}) {
		t.Fatalf("parseTokenList = %v %q, want [7 8 9]", got, e)
	}
}

// "the SSE path for a session is tiny regardless of token count"
func TestNodeSSEPathIsTinyForAFullBoard(t *testing.T) {
	s, _ := storeAt(SessionStoreOptions{})
	sess := s.Create(board(816), brokers.Dhan, 1)
	path := "/api/stream/session/" + sess.ID
	if len(path) >= 100 {
		t.Errorf("path was %d bytes", len(path))
	}
	if strings.Contains(path, ",") {
		t.Errorf("path %q carries a token list", path)
	}
	if len(sess.Tokens) != 816 {
		t.Errorf("session holds %d tokens", len(sess.Tokens))
	}
}
