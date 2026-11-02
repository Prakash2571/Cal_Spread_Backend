package brokers

// Ports of the five SubscriptionCoordinator cases of tests/box/marketDataTransport.test.mjs
// (browser leases), which the coordinator tests asserted only in part. The recorder keeps
// each call sorted (Node sorted where it compared a call) and the flat lists in call order.

import "testing"

// "two browser leases with OVERLAPPING tokens subscribe upstream ONCE"
func TestNodeOverlappingBrowserLeasesSubscribeOnce(t *testing.T) {
	c, r := newCoord()
	a := c.Acquire(OwnerBrowser, []int64{1, 2, 3})
	b := c.Acquire(OwnerBrowser, []int64{2, 3, 4})
	eq(t, r.sub, [][]int64{{1, 2, 3}, {4}}, "subscribe calls")
	eq(t, c.Size(), 4, "size")
	a.Release()
	b.Release()
}

// "releasing one lease keeps tokens another lease still wants"
func TestNodeReleasingOneLeaseKeepsSharedTokens(t *testing.T) {
	c, r := newCoord()
	a := c.Acquire(OwnerBrowser, []int64{1, 2, 3})
	b := c.Acquire(OwnerBrowser, []int64{2, 3, 4})
	a.Release()
	eq(t, r.unsub, [][]int64{{1}}, "only token 1 is unsubscribed")
	eq(t, c.Size(), 3, "size after the first release")
	b.Release()
	eq(t, r.unsub, [][]int64{{1}, {2, 3, 4}}, "the rest go in one call")
	eq(t, c.Size(), 0, "size after the last release")
}

// "a DOUBLE release cannot unsubscribe another client's tokens"
func TestNodeTripleReleaseCannotUnsubscribeAnotherClient(t *testing.T) {
	c, r := newCoord()
	a := c.Acquire(OwnerBrowser, []int64{1, 2})
	b := c.Acquire(OwnerBrowser, []int64{1, 2})
	a.Release()
	a.Release()
	a.Release()
	eq(t, len(r.unsub), 0, "b still wants both (no unsubscribe call)")
	eq(t, c.Size(), 2, "size")
	b.Release()
	eq(t, c.Size(), 0, "size after b")
}

// "a browser lease does not disturb the scanner's tokens"
func TestNodeBrowserLeaseLeavesScannerTokens(t *testing.T) {
	c, r := newCoord()
	c.SetOwnerTokens(OwnerScanner, []int64{10, 11})
	l := c.Acquire(OwnerBrowser, []int64{11, 12})
	l.Release()
	eq(t, r.unsubscribed, []int64{12}, "only the browser-only token goes")
	if got := c.CountsFor(11); got == nil || got.Scanner != 1 {
		t.Errorf("countsFor(11) = %+v, want scanner 1", got)
	}
}

// "a full board lease reports a browser subscription count > 0"
func TestNodeFullBoardLeaseStats(t *testing.T) {
	c, _ := newCoord()
	tokens := make([]int64, 816)
	for i := range tokens {
		tokens[i] = 2_000_000_000 + int64(i)
	}
	l := c.Acquire(OwnerBrowser, tokens)
	if s := c.Stats(); s.Browser != 816 || s.Tokens != 816 || s.Leases != 1 {
		t.Errorf("stats %+v, want browser 816 tokens 816 leases 1", s)
	}
	l.Release()
	if s := c.Stats(); s.Tokens != 0 {
		t.Errorf("tokens after release = %d", s.Tokens)
	}
}
