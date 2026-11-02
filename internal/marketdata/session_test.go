package marketdata

import (
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
)

// Ported from tests/box/marketDataTransport.test.mjs.

type clk struct{ t time.Time }

func (c *clk) now() time.Time          { return c.t }
func (c *clk) advance(d time.Duration) { c.t = c.t.Add(d) }

func storeAt(o SessionStoreOptions) (*SessionStore, *clk) {
	c := &clk{t: time.UnixMilli(1_000_000)}
	o.Now = c.now
	return NewSessionStore(o), c
}

func board(n int) []int64 {
	out := make([]int64, n)
	for i := range out {
		out[i] = 2_000_000_000 + int64(i)
	}
	return out
}

func toAny(v ...any) any { return v }

func TestParseTokenList(t *testing.T) {
	asAny := func(ts []int64) any {
		out := make([]any, len(ts))
		for i, v := range ts {
			out[i] = float64(v)
		}
		return out
	}
	if got, e := ParseTokenList(asAny(board(816)), 0); e != "" || len(got) != 816 {
		t.Errorf("full board: %d %q", len(got), e)
	}
	if got, _ := ParseTokenList(toAny(7.0, 7.0, 8.0, 9.0, 9.0, 9.0), 0); len(got) != 3 || got[0] != 7 || got[2] != 9 {
		t.Errorf("dedupe: %v", got)
	}
	for _, bad := range []any{
		toAny(0.0), toAny(-1.0), toAny(1.5), toAny(nil), toAny("123"), toAny(map[string]any{}), toAny(true),
		nil, map[string]any{}, toAny(),
	} {
		if _, e := ParseTokenList(bad, 0); e == "" {
			t.Errorf("%#v must be rejected", bad)
		}
	}
	if _, e := ParseTokenList(asAny(make([]int64, MaxSessionTokens+1)), 0); !strings.Contains(e, "Too many tokens") {
		t.Errorf("oversized: %q", e)
	}
	if MaxSessionTokens < 2000 {
		t.Error("limit must allow today's board")
	}
	if _, e := ParseTokenList(toAny(1.0), 0); e != "" {
		t.Error(e)
	}
}

func TestSessionRoundTripAndIDs(t *testing.T) {
	s, _ := storeAt(SessionStoreOptions{})
	sess := s.Create(board(816), brokers.Dhan, 3)
	got, rej := s.Resolve(sess.ID, brokers.Dhan, 3)
	if rej != RejectNone || len(got.Tokens) != 816 {
		t.Fatal("round trip")
	}
	ids := map[string]bool{}
	re := regexp.MustCompile(`^[0-9a-f]{32}$`)
	for i := 0; i < 50; i++ {
		id := s.Create([]int64{1}, brokers.Dhan, 1).ID
		if !re.MatchString(id) || ids[id] {
			t.Fatalf("bad id %q", id)
		}
		ids[id] = true
	}
	if _, rej := s.Resolve("deadbeef", brokers.Dhan, 1); rej != RejectNotFound {
		t.Error("unknown id")
	}
	for i := 0; i < 5; i++ { // EventSource reconnects resolve repeatedly
		if _, rej := s.Resolve(sess.ID, brokers.Dhan, 3); rej != RejectNone {
			t.Fatal("must survive repeated resolves")
		}
	}
}

func TestLiveConnectionsAreNeverReapedAndIdleOnesAre(t *testing.T) {
	s, c := storeAt(SessionStoreOptions{TTL: 60 * time.Second})
	live := s.Create([]int64{1, 2, 3}, brokers.Dhan, 1)
	s.Open(live.ID)
	idle := s.Create([]int64{1}, brokers.Dhan, 1)
	s.Open(idle.ID)
	s.Close(idle.ID)
	c.advance(30 * time.Second)
	if s.Sweep() != 0 {
		t.Error("still inside the TTL")
	}
	c.advance(31 * time.Second)
	if s.Sweep() != 1 {
		t.Error("the idle session is reaped after its TTL")
	}
	if _, rej := s.Resolve(idle.ID, brokers.Dhan, 1); rej != RejectNotFound {
		t.Error("reaped")
	}
	c.advance(time.Hour)
	if s.Sweep() != 0 {
		t.Error("a live connection holds the session")
	}
	// Closing one of two connections keeps it alive.
	two := s.Create([]int64{1}, brokers.Dhan, 1)
	s.Open(two.ID)
	s.Open(two.ID)
	s.Close(two.ID)
	c.advance(2 * time.Minute)
	if s.Sweep() != 0 {
		t.Error("one connection remains")
	}
}

func TestStaleBrokerOrGenerationIsRefusedAndDropped(t *testing.T) {
	s, _ := storeAt(SessionStoreOptions{})
	a := s.Create(board(10), brokers.Dhan, 3)
	if _, rej := s.Resolve(a.ID, brokers.Dhan, 4); rej != RejectStale {
		t.Error("generation")
	}
	if s.Size() != 0 {
		t.Error("a refused session is dropped")
	}
	if _, rej := s.Resolve(a.ID, brokers.Dhan, 4); rej != RejectNotFound {
		t.Error("and then not found")
	}
	b := s.Create([]int64{1, 2}, brokers.Zerodha, 1)
	if _, rej := s.Resolve(b.ID, brokers.Dhan, 1); rej != RejectStale {
		t.Error("broker")
	}
	s.Create([]int64{1}, brokers.Dhan, 1)
	s.Create([]int64{2}, brokers.Dhan, 1)
	if s.DropAll() != 2 || s.Size() != 0 {
		t.Error("a broker switch drops every session")
	}
}

func TestStoreIsBoundedAndSparesLiveSessions(t *testing.T) {
	s, _ := storeAt(SessionStoreOptions{MaxSessions: 10, TTL: 1000 * time.Hour})
	for i := 0; i < 40; i++ {
		s.Create([]int64{int64(i + 1)}, brokers.Dhan, 1)
	}
	if s.Size() > 10 {
		t.Errorf("size %d exceeds the cap", s.Size())
	}
	s2, _ := storeAt(SessionStoreOptions{MaxSessions: 3, TTL: 1000 * time.Hour})
	keep := s2.Create([]int64{1}, brokers.Dhan, 1)
	s2.Open(keep.ID)
	for i := 0; i < 20; i++ {
		s2.Create([]int64{int64(i + 100)}, brokers.Dhan, 1)
	}
	if _, rej := s2.Resolve(keep.ID, brokers.Dhan, 1); rej != RejectNone {
		t.Error("eviction must never kill a session with a live connection")
	}
}

func TestStats(t *testing.T) {
	s, _ := storeAt(SessionStoreOptions{})
	a := s.Create([]int64{1, 2, 3}, brokers.Dhan, 1)
	s.Create([]int64{4, 5}, brokers.Dhan, 1)
	s.Open(a.ID)
	if st := s.Stats(); st.Sessions != 2 || st.Connections != 1 || st.Tokens != 5 {
		t.Errorf("%+v", st)
	}
}
