package quotes

// Port of tests/box/math.test.mjs "2. never more than seven strikes, however long the
// chain" with Node's own chain: helpers.mjs chain({count}) defaults to first 19700 and
// step 100 (TestStrikeWindow used a 20000/50 grid).

import "testing"

func TestNodeNeverMoreThanSevenStrikes(t *testing.T) {
	for _, count := range []int{7, 11, 41, 200} {
		c := chain(19700, 100, count)
		spot := c[count/2] // c.strikes[Math.floor(count / 2)]
		_, w, ok := SelectStrikeWindow(c, spot, 3)
		if !ok || len(w) > 7 {
			t.Errorf("count=%d gave %d strikes", count, len(w))
		}
		if len(w) != 7 {
			t.Errorf("count=%d: window length %d, want 7", count, len(w))
		}
	}
	// At the very edge of a chain the window truncates rather than reaching further the
	// other way.
	c := chain(19700, 100, 5)
	_, edge, ok := SelectStrikeWindow(c, c[0], 3)
	if !ok || len(edge) > 7 || len(edge) == 0 || edge[0] != c[0] {
		t.Fatalf("edge window = %v", edge)
	}
}
