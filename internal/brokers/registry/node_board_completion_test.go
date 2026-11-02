package registry

import (
	"strings"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// tests/box/dhanBoardJoin.test.mjs: "checkKnownSymbols names the FIRST failing stage".
func TestNodeKnownSymbolNamesTheFirstFailingStage(t *testing.T) {
	_, _, rows := parseNodeMaster(t, shortHeader,
		"NSE,D,50000,FUTSTK,BHEL FUT,BHEL,438,250,"+isoDaysFromNow(20)+",0.05")
	checks := CheckKnownSymbols(rows, []string{"BHEL"})
	if len(checks) != 1 || checks[0].EquityFound || checks[0].FailsAt == nil || !strings.Contains(*checks[0].FailsAt, "no NSE equity row") {
		t.Fatalf("first failing stage = %+v", checks)
	}
}

// The three board-assembly cases of tests/box/indexSpot.test.mjs use a
// two-instrument universe, rather than the larger helper-golden universes.
func TestNodeIndexBoardNamingAndMissingSpot(t *testing.T) {
	for _, tc := range []struct {
		title string
		spot  string
		found bool
	}{
		{"the index reaches the board under DHAN's naming", "NIFTY", true},
		{"the index reaches the board under ZERODHA's naming", "NIFTY 50", true},
		{"a missing index spot is reported as a MAPPING problem, not a missing equity", "TOTALLY OTHER INDEX", false},
	} {
		t.Run(tc.title, func(t *testing.T) {
			rows := []market.Instrument{
				{InstrumentToken: 11, ExchangeToken: 11, Tradingsymbol: tc.spot, Name: tc.spot,
					TickSize: .05, InstrumentType: "INDEX", Segment: "INDICES", Exchange: "INDICES"},
				{InstrumentToken: 12, ExchangeToken: 12, Tradingsymbol: "NIFTY-FUT", Name: "NIFTY", Expiry: "2026-09-29",
					TickSize: .05, LotSize: 50, InstrumentType: "FUT", Segment: "NFO-FUT", Exchange: "NFO"},
			}
			board := DiagnoseBoard(rows, IndexSpotMap)
			if tc.found {
				if board.MatchedIndices != 1 || board.BoardSize != 1 || board.UnmatchedUnderlyings != 0 {
					t.Fatalf("index must reach the board: %+v", board)
				}
			} else if board.MatchedIndices != 0 || board.UnmatchedUnderlyings != 1 || len(board.UnmatchedSamples) != 1 ||
				board.UnmatchedSamples[0].Underlying != "NIFTY" || board.UnmatchedSamples[0].Reason != "no_index_mapping" {
				t.Fatalf("missing index must report the mapping failure: %+v", board)
			}
		})
	}
}
