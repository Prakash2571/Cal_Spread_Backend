package marketdata

import (
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
)

// Remaining literal assertions from tests/box/marketDataTransport.test.mjs.

// "a numeric STRING is rejected rather than coerced"
func TestNodeNumericTokenStringIsNotCoerced(t *testing.T) {
	if _, err := ParseTokenList(toAny("2000000001"), 0); err == "" {
		t.Fatal("a numeric token string must be rejected")
	}
}

// "the token limit comfortably exceeds today's board"
func TestNodeTokenLimitAcceptsTwoThousandTokens(t *testing.T) {
	if MaxSessionTokens < 2000 {
		t.Fatalf("limit %d must allow 2000+", MaxSessionTokens)
	}
	input := make([]any, 2000)
	for i := range input {
		input[i] = float64(i + 1)
	}
	if got, err := ParseTokenList(input, 0); err != "" || len(got) != 2000 {
		t.Fatalf("2000-token board: %d tokens, %q", len(got), err)
	}
}

// "a session with a LIVE connection is never reaped"
func TestNodeLiveSessionResolvesAfterAnHour(t *testing.T) {
	s, clock := storeAt(SessionStoreOptions{})
	session := s.Create([]int64{1, 2, 3}, brokers.Dhan, 1)
	s.Open(session.ID)
	clock.advance(time.Hour)
	if got := s.Sweep(); got != 0 {
		t.Fatalf("a live connection holds the session: reaped %d", got)
	}
	if _, rejection := s.Resolve(session.ID, brokers.Dhan, 1); rejection != RejectNone {
		t.Fatalf("the live session must still resolve: %q", rejection)
	}
}

// "a broker switch drops every session"
func TestNodeBrokerSwitchDropsThreeSessions(t *testing.T) {
	s, _ := storeAt(SessionStoreOptions{})
	for _, token := range []int64{1, 2, 3} {
		s.Create([]int64{token}, brokers.Dhan, 1)
	}
	if dropped := s.DropAll(); dropped != 3 || s.Size() != 0 {
		t.Fatalf("dropAll = %d, remaining = %d; want 3 and 0", dropped, s.Size())
	}
}
