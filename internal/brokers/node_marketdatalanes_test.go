package brokers

// Ports of the tests/box/marketDataLanes.test.mjs cases that TestLanesAreIsolated and
// TestSameTokenInBothLanesIsCountedIndependently asserted only in part. recordingTransport
// is the recorder of subscriptions_test.go (flat subscribed/unsubscribed lists, live()).

import "testing"

func twoLanes() (futures, box *Coordinator, ft, bt *recorder) {
	ft, bt = &recorder{}, &recorder{}
	return NewCoordinator(ft, "futures"), NewCoordinator(bt, "box"), ft, bt
}

func set(tokens ...int64) map[int64]bool {
	m := map[int64]bool{}
	for _, t := range tokens {
		m[t] = true
	}
	return m
}

// "T1: the futures and box subscription domains stay isolated"
func TestNodeT1LaneDomainsStayIsolated(t *testing.T) {
	futures, box, ft, bt := twoLanes()
	futures.SetOwnerTokens(OwnerStrategy, []int64{111, 222})
	box.SetOwnerTokens(OwnerStrategy, []int64{900, 901, 902})
	eq(t, ft.live(), set(111, 222), "futures transport")
	eq(t, bt.live(), set(900, 901, 902), "box transport")
	eq(t, futures.Size(), 2, "futures counts only its own tokens")
	eq(t, box.Size(), 3, "box counts only its own tokens")
	eq(t, string(futures.Lane), "futures", "futures lane id")
	eq(t, string(box.Lane), "box", "box lane id")
}

// "T2: a futures token never becomes box-owned"
func TestNodeT2FuturesTokenNeverBecomesBoxOwned(t *testing.T) {
	futures, box, _, bt := twoLanes()
	futures.SetOwnerTokens(OwnerStrategy, []int64{111, 222})
	if box.CountsFor(111) != nil {
		t.Error("the box lane has no knowledge of a futures token")
	}
	eq(t, len(bt.subscribed), 0, "and never subscribed it")
	futures.SetOwnerTokens(OwnerStrategy, []int64{222, 333})
	eq(t, len(bt.subscribed), 0, "box subscribes after the futures window moved")
	eq(t, len(bt.unsubscribed), 0, "box unsubscribes after the futures window moved")
}

// "T3: a box token never pollutes the futures coordinator"
func TestNodeT3BoxTokenNeverPollutesFutures(t *testing.T) {
	futures, box, ft, _ := twoLanes()
	futures.SetOwnerTokens(OwnerBrowser, []int64{111})
	beforeSub, beforeUnsub := len(ft.subscribed), len(ft.unsubscribed)
	box.SetOwnerTokens(OwnerStrategy, []int64{900, 901})
	box.SetOwnerTokens(OwnerStrategy, []int64{901, 902}) // the strike window moves
	if futures.CountsFor(900) != nil {
		t.Error("futures never learns a box token")
	}
	eq(t, len(ft.subscribed), beforeSub, "no futures subscribe was emitted")
	eq(t, len(ft.unsubscribed), beforeUnsub, "no futures unsubscribe was emitted")
	eq(t, ft.live(), set(111), "the board's token is untouched")
}

// "the SAME token in both lanes is refcounted independently"
func TestNodeSameTokenInBothLanesLiveSets(t *testing.T) {
	futures, box, ft, bt := twoLanes()
	futures.SetOwnerTokens(OwnerStrategy, []int64{555})
	box.SetOwnerTokens(OwnerStrategy, []int64{555})
	eq(t, ft.live(), set(555), "futures live")
	eq(t, bt.live(), set(555), "box live")
	box.SetOwnerTokens(OwnerStrategy, []int64{}) // box drops it
	eq(t, bt.live(), set(), "box unsubscribed on its own socket")
	eq(t, ft.live(), set(555), "the futures lane still has it")
}

// "within one lane, refcounting still prevents a duplicate upstream subscription"
func TestNodeWithinOneLaneRefcountingPreventsADuplicateSubscribe(t *testing.T) {
	_, box, _, bt := twoLanes()
	a := box.Acquire(OwnerStrategy, []int64{900})
	b := box.Acquire(OwnerBrowser, []int64{900})
	n := 0
	for _, tok := range bt.subscribed {
		if tok == 900 {
			n++
		}
	}
	eq(t, n, 1, "only the 0->1 transition reaches upstream")
	a.Release()
	eq(t, len(bt.unsubscribed), 0, "still wanted by the other consumer")
	b.Release()
	eq(t, bt.unsubscribed, []int64{900}, "unsubscribed only when the last holder went")
}

// "T6: each lane replays only its OWN tokens after a reconnect"
func TestNodeT6EachLaneReplaysOnlyItsOwnTokens(t *testing.T) {
	futures, box, _, _ := twoLanes()
	futures.SetOwnerTokens(OwnerStrategy, []int64{111, 222})
	box.SetOwnerTokens(OwnerStrategy, []int64{900, 901})
	eq(t, futures.ActiveTokens(), []int64{111, 222}, "futures replay")
	eq(t, box.ActiveTokens(), []int64{900, 901}, "box replay")
	for _, tok := range box.ActiveTokens() {
		for _, f := range futures.ActiveTokens() {
			if tok == f {
				t.Errorf("box token %d in the futures replay", tok)
			}
		}
	}
}

// "there are exactly two lanes, and they are named not boolean"
func TestNodeExactlyTwoNamedLanes(t *testing.T) {
	eq(t, Lanes, []Lane{"futures", "box"}, "MARKET_DATA_LANES")
	eq(t, len(Lanes), 2, "lane count")
}

// "lane stats appear per-lane in the coordinator's own summary"
func TestNodeLaneStatsPerLane(t *testing.T) {
	futures, box, _, _ := twoLanes()
	futures.SetOwnerTokens(OwnerStrategy, []int64{111})
	box.SetOwnerTokens(OwnerStrategy, []int64{900, 901})
	fs, bs := futures.Stats(), box.Stats()
	eq(t, string(fs.Lane), "futures", "futures stats lane")
	eq(t, string(bs.Lane), "box", "box stats lane")
	eq(t, fs.Tokens, 1, "futures stats tokens")
	eq(t, bs.Tokens, 2, "box stats tokens")
}
