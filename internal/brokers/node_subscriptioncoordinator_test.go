package brokers

// Port of tests/box/subscriptionCoordinator.test.mjs "resetForBrokerSwitch drops
// everything and issues NO upstream unsubscribe" with all its assertions (the earlier
// test did not check activeTokens()).

import "testing"

func TestNodeResetForBrokerSwitchDropsEverything(t *testing.T) {
	c, r := newCoord()
	c.Acquire(OwnerBrowser, []int64{1, 2})
	c.SetOwnerTokens(OwnerScanner, []int64{3, 4})
	r.sub, r.unsub = nil, nil
	dropped, _ := c.ResetForBrokerSwitch()
	eq(t, dropped, 4, "droppedTokens")
	eq(t, len(r.unsub), 0, "no upstream unsubscribe")
	eq(t, c.ActiveTokens(), []int64{}, "activeTokens")
	eq(t, c.Size(), 0, "size")
}
