package registry

// End-to-end ports of the tests/box/dhanBoardJoin.test.mjs parse-to-board cases: the
// Node master text goes through dhan.ParseScripMaster and the parsed rows through
// DiagnoseBoard / CheckKnownSymbols, as the suite does. The goldens pinned the parse and
// the board on different universes; these run the suite's own masters. Node builds its
// expiries as Date.now() + N days; here they are built from the clock passed to the
// parser (the 400-day horizon is measured from it).

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/dhan"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

var nodeBoardNow = time.UnixMilli(1_793_167_200_000) // 2026-10-28T06:00:00Z

// isoDaysFromNow is the suite's isoDaysFromNow against the parser's clock.
func isoDaysFromNow(days int) string {
	return nodeBoardNow.Add(time.Duration(days) * 24 * time.Hour).UTC().Format("2006-01-02")
}

var nodeFNO = []struct {
	sym           string
	eqID, futBase int
}{{"BHEL", 438, 50000}, {"RELIANCE", 2885, 51000}, {"HDFCBANK", 1333, 52000}, {"SBIN", 3045, 53000}, {"TCS", 11536, 54000}}

func masterWithDisplayNames() string {
	rows := []string{"EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,DISPLAY_NAME,UNDERLYING_SYMBOL,UNDERLYING_SECURITY_ID,LOT_SIZE,SM_EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE,TICK_SIZE"}
	for _, f := range nodeFNO {
		rows = append(rows, fmt.Sprintf("NSE,E,%d,EQUITY,%s,%s LTD,%s,%d,1,,0,,0.05", f.eqID, f.sym, f.sym, f.sym, f.eqID))
	}
	expiries := []string{isoDaysFromNow(20), isoDaysFromNow(48), isoDaysFromNow(76)}
	for _, f := range nodeFNO {
		for i, expiry := range expiries {
			label := expiry[:7]
			rows = append(rows, fmt.Sprintf("NSE,D,%d,FUTSTK,%s %s FUT,%s %s FUT,,%d,250,%s,0,,0.05", f.futBase+i, f.sym, label, f.sym, label, f.eqID, expiry))
		}
	}
	return strings.Join(rows, "\n")
}

const shortHeader = "EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,UNDERLYING_SYMBOL,UNDERLYING_SECURITY_ID,LOT_SIZE,SM_EXPIRY_DATE,TICK_SIZE"

// parseNodeMaster parses like parseDhanScripMaster and returns the rows, the parse
// report and the rows as the board sees them.
func parseNodeMaster(t *testing.T, lines ...string) ([]dhan.Instrument, *dhan.ParseReport, []market.Instrument) {
	t.Helper()
	dhan.SetLogger(func(string, ...any) {})
	t.Cleanup(func() { dhan.SetLogger(nil) })
	rows, report, err := dhan.ParseScripMaster(strings.Join(lines, "\n"), nodeBoardNow)
	if err != nil {
		t.Fatal(err)
	}
	all := make([]market.Instrument, len(rows))
	for i := range rows {
		all[i] = rows[i].Instrument
	}
	return rows, report, all
}

func rowByID(rows []dhan.Instrument, id int64) *dhan.Instrument {
	for i := range rows {
		if rows[i].DhanSecurityID == id {
			return &rows[i]
		}
	}
	return nil
}

// "FIVE real underlyings produce FIVE board cards, not one"
func TestNodeFiveUnderlyingsProduceFiveBoardCards(t *testing.T) {
	_, _, all := parseNodeMaster(t, masterWithDisplayNames())
	board := DiagnoseBoard(all, map[string]string{})
	if board.UniqueFutureUnderlyings != 5 || board.MatchedEquities != 5 || board.BoardSize < 5 || board.UnmatchedUnderlyings != 0 {
		t.Fatalf("board %+v", board)
	}
}

// "every known symbol passes every stage"
func TestNodeEveryKnownSymbolPassesEveryStage(t *testing.T) {
	_, _, all := parseNodeMaster(t, masterWithDisplayNames())
	var symbols []string
	for _, f := range nodeFNO {
		symbols = append(symbols, f.sym)
	}
	checks := CheckKnownSymbols(all, symbols)
	if len(checks) != 5 {
		t.Fatalf("%d checks", len(checks))
	}
	for _, c := range checks {
		if c.FailsAt != nil || !c.EquityFound || c.FuturesFound != 3 || c.ValidExpiries != 3 || c.ValidLotSizes != 3 || !c.OnBoard {
			t.Errorf("%s: %+v (failsAt %v)", c.Symbol, c, c.FailsAt)
		}
	}
}

// "an unmatched underlying is REPORTED, not silently dropped"
func TestNodeUnmatchedUnderlyingIsReported(t *testing.T) {
	_, _, all := parseNodeMaster(t, shortHeader, "NSE,D,60000,FUTSTK,ORPHAN FUT,ORPHAN,99999,250,"+isoDaysFromNow(20)+",0.05")
	board := DiagnoseBoard(all, map[string]string{})
	if board.BoardSize != 0 || board.UnmatchedUnderlyings != 1 || len(board.UnmatchedSamples) == 0 {
		t.Fatalf("board %+v", board)
	}
	if s := board.UnmatchedSamples[0]; s.Reason != "no_spot_equity" || s.Underlying != "ORPHAN" {
		t.Fatalf("sample %+v", s)
	}
}

// "index futures group even without an NSE equity row"
func TestNodeIndexFuturesGroupWithoutAnEquityRow(t *testing.T) {
	_, _, all := parseNodeMaster(t, shortHeader,
		"NSE,I,13,INDEX,NIFTY 50,NIFTY,13,0,,0.05",
		"NSE,D,70000,FUTIDX,NIFTY FUT,NIFTY,13,50,"+isoDaysFromNow(20)+",0.05")
	board := DiagnoseBoard(all, map[string]string{"NIFTY": "NIFTY 50"})
	if board.MatchedIndices != 1 {
		t.Errorf("matchedIndices = %d: the index underlying joined via the spot map", board.MatchedIndices)
	}
	if board.BoardSize != 1 {
		t.Errorf("boardSize = %d", board.BoardSize)
	}
}

// "an index future keeps the UNDERLYING symbol, not the index's trading symbol"
func TestNodeIndexFutureKeepsTheUnderlyingSymbol(t *testing.T) {
	near := isoDaysFromNow(20)
	rows, _, all := parseNodeMaster(t, shortHeader,
		"NSE,I,13,INDEX,NIFTY 50,NIFTY,13,0,,0.05",
		"NSE,I,25,INDEX,NIFTY BANK,BANKNIFTY,25,0,,0.05",
		"NSE,E,438,EQUITY,BHEL,BHEL,438,1,,0.05",
		"NSE,D,70000,FUTIDX,NIFTY FUT,NIFTY,13,50,"+near+",0.05",
		"NSE,D,70001,FUTIDX,BANKNIFTY FUT,BANKNIFTY,25,15,"+near+",0.05",
		"NSE,D,50000,FUTSTK,BHEL FUT,BHEL,438,250,"+near+",0.05")
	for id, want := range map[int64]string{70000: "NIFTY", 70001: "BANKNIFTY", 50000: "BHEL"} {
		r := rowByID(rows, id)
		if r == nil || r.Name != want {
			t.Errorf("row %d name = %v, must be %q", id, r, want)
		}
	}
	board := DiagnoseBoard(all, map[string]string{"NIFTY": "NIFTY 50", "BANKNIFTY": "NIFTY BANK"})
	if board.MatchedIndices != 2 || board.MatchedEquities != 1 || board.BoardSize != 3 || board.UnmatchedUnderlyings != 0 {
		t.Fatalf("board %+v", board)
	}
}

// "long-dated contracts are excluded and cannot reach the board"
func TestNodeLongDatedContractsCannotReachTheBoard(t *testing.T) {
	rows, report, all := parseNodeMaster(t, shortHeader,
		"NSE,E,438,EQUITY,BHEL,BHEL,438,1,,0.05",
		"NSE,D,50000,FUTSTK,BHEL FUT,BHEL,438,250,"+isoDaysFromNow(20)+",0.05",
		"NSE,E,777,EQUITY,LONGDATED,LONGDATED,777,1,,0.05",
		"NSE,D,50002,FUTSTK,LONGDATED FUT,LONGDATED,777,250,"+isoDaysFromNow(3700)+",0.05")
	if report == nil || report.SkippedImplausibleExpiry < 1 {
		t.Errorf("report %+v", report)
	}
	if rowByID(rows, 50002) != nil {
		t.Error("the long-dated future must be gone")
	}
	if board := DiagnoseBoard(all, map[string]string{}); board.BoardSize != 1 {
		t.Errorf("boardSize = %d: only BHEL; LONGDATED has an equity but no future", board.BoardSize)
	}
}

// "TEST scrips never reach the board even when otherwise well-formed"
func TestNodeTestScripsNeverReachTheBoard(t *testing.T) {
	near := isoDaysFromNow(20)
	rows, _, all := parseNodeMaster(t, shortHeader,
		"NSE,E,900,EQUITY,01INSETEST,01INSETEST,900,1,,0.05",
		"NSE,D,901,FUTSTK,01INSETEST FUT,01INSETEST,900,1,"+near+",0.05",
		"NSE,E,438,EQUITY,BHEL,BHEL,438,1,,0.05",
		"NSE,D,50000,FUTSTK,BHEL FUT,BHEL,438,250,"+near+",0.05")
	if board := DiagnoseBoard(all, map[string]string{}); board.BoardSize != 1 {
		t.Errorf("boardSize = %d, want 1 (only BHEL)", board.BoardSize)
	}
	for _, r := range rows {
		if strings.Contains(r.Tradingsymbol, "INSETEST") {
			t.Errorf("a TEST scrip survived: %s", r.Tradingsymbol)
		}
	}
}
