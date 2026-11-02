package dhan

// Port of tests/box/dhanBoardJoin.test.mjs "real NSE symbols are never corrupted by
// suffix stripping" with its full list (the helpers golden lacks the bare "BHEL"). The
// parse-to-board cases of the suite are ported in internal/brokers/registry
// (node_dhanboardjoin_test.go), where the board diagnostics live.

import "testing"

func TestNodeRealNSESymbolsSurviveSuffixStripping(t *testing.T) {
	for _, symbol := range []string{"RELIANCE", "BAJAJ-AUTO", "M&M", "L&TFH", "TATASTEEL", "IDEA", "BHEL", "SBIN", "HDFCBANK"} {
		if got := StripContractSuffix(symbol); got != symbol {
			t.Errorf("%s must survive unchanged, got %q", symbol, got)
		}
	}
}
