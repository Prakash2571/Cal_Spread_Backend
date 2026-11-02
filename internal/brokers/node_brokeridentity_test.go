package brokers

// Port of tests/box/brokerIdentity.test.mjs "brokerOf preserves an explicitly recorded
// broker" (TestOfDefaultsToLegacy checked only the dhan half).

import "testing"

func TestNodeBrokerOfPreservesAnExplicitlyRecordedBroker(t *testing.T) {
	dhan, zerodha := "dhan", "zerodha"
	if got := Of(&dhan); got != Dhan || string(got) != "dhan" {
		t.Errorf(`brokerOf({broker:"dhan"}) = %q`, got)
	}
	if got := Of(&zerodha); got != Zerodha || string(got) != "zerodha" {
		t.Errorf(`brokerOf({broker:"zerodha"}) = %q`, got)
	}
}
