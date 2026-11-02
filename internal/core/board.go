package core

import (
	"sort"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/captures"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// BoardFuture and BoardItem are index.ts BoardFuture/BoardItem, the rows of the F&O
// board. They are the captures package's types (the hourly and EOD jobs read the same
// board), so captures.Deps.GetBoard can take Core.Board directly. JSON: {symbol, name,
// spot_token, futures: [{token, expiry, lot_size}], is_index: true only for indices}.
type (
	BoardFuture = captures.BoardFuture
	BoardItem   = captures.BoardItem
)

// IndexSpot is one entry of indexSpot.ts INDEX_SPOT_MAP.
type IndexSpot struct {
	Underlying string // the NFO futures name, e.g. NIFTY
	Spot       string // Zerodha's spot index trading symbol, e.g. "NIFTY 50"
}

// IndexSpotMap is INDEX_SPOT_MAP in its declaration order (Object.entries order): the
// allow-list of index underlyings the board shows, mapped to Zerodha's spot names.
var IndexSpotMap = []IndexSpot{
	{"NIFTY", "NIFTY 50"},
	{"BANKNIFTY", "NIFTY BANK"},
	{"FINNIFTY", "NIFTY FIN SERVICE"},
	{"MIDCPNIFTY", "NIFTY MID SELECT"},
	{"NIFTYNXT50", "NIFTY NEXT 50"},
}

// IndexSpotSymbol is INDEX_SPOT_MAP[underlying].
func IndexSpotSymbol(underlying string) (string, bool) {
	for _, e := range IndexSpotMap {
		if e.Underlying == underlying {
			return e.Spot, true
		}
	}
	return "", false
}

// IndexSpotCandidates is indexSpotCandidates: the spot trading symbols to try for an
// index underlying, best first (the curated Zerodha name, then the underlying itself,
// which is Dhan's name), deduplicated. Empty for anything not in IndexSpotMap.
func IndexSpotCandidates(underlying string) []string {
	mapped, ok := IndexSpotSymbol(underlying)
	if !ok || mapped == "" {
		return []string{}
	}
	if mapped == underlying {
		return []string{mapped}
	}
	return []string{mapped, underlying}
}

// ResolveIndexSpotSymbol is resolveIndexSpotSymbol: the first candidate the universe
// contains (hasSpot), or ok=false.
func ResolveIndexSpotSymbol(underlying string, hasSpot func(tradingsymbol string) bool) (string, bool) {
	for _, c := range IndexSpotCandidates(underlying) {
		if hasSpot(c) {
			return c, true
		}
	}
	return "", false
}

// isFut is the NFO futures test both derivations use (i.exchange === "NFO" &&
// i.instrument_type === "FUT" && i.name).
func isFut(i *market.Instrument) bool {
	return i.Exchange == "NFO" && i.InstrumentType == "FUT" && i.Name != ""
}

// DeriveFnoBoard is index.ts deriveFnoBoard: every NFO futures underlying with its spot
// (the NSE equity, or for an allow-listed index the INDICES row) and its three nearest
// futures by expiry; indices first, then stocks, each in localeCompare order of the
// symbol. Underlyings without a spot are skipped. Sorting is stable, as V8's is.
func DeriveFnoBoard(all []market.Instrument) []BoardItem {
	var order []string // futures underlyings in first-seen order (Map insertion order)
	futs := map[string][]int{}
	eqBySymbol := map[string]int{}    // last row wins, as Map.set does
	indexBySymbol := map[string]int{} // likewise
	for i := range all {
		in := &all[i]
		switch {
		case isFut(in):
			if _, seen := futs[in.Name]; !seen {
				order = append(order, in.Name)
			}
			futs[in.Name] = append(futs[in.Name], i)
		case in.Segment == "INDICES":
			// Checked before the equity branch: Zerodha's index rows are also NSE "EQ".
			indexBySymbol[in.Tradingsymbol] = i
		case in.Exchange == "NSE" && in.InstrumentType == "EQ":
			eqBySymbol[in.Tradingsymbol] = i
		}
	}

	var stocks, indices []BoardItem
	for _, symbol := range order {
		rows := futs[symbol]
		sort.SliceStable(rows, func(a, b int) bool {
			return jsx.LocaleCompare(all[rows[a]].Expiry, all[rows[b]].Expiry) < 0
		})
		if len(rows) > 3 {
			rows = rows[:3]
		}
		futures := make([]BoardFuture, len(rows))
		for k, idx := range rows {
			f := &all[idx]
			futures[k] = BoardFuture{Token: f.InstrumentToken, Expiry: f.Expiry, LotSize: f.LotSize}
		}
		if e, ok := eqBySymbol[symbol]; ok {
			stocks = append(stocks, BoardItem{
				Symbol: symbol, Name: all[e].Name, SpotToken: all[e].InstrumentToken, Futures: futures,
			})
			continue
		}
		spot, ok := ResolveIndexSpotSymbol(symbol, func(s string) bool { _, ok := indexBySymbol[s]; return ok })
		if !ok {
			continue // unknown underlying with no spot
		}
		idx := &all[indexBySymbol[spot]]
		indices = append(indices, BoardItem{
			Symbol: symbol, Name: idx.Tradingsymbol, SpotToken: idx.InstrumentToken, Futures: futures, IsIndex: true,
		})
	}
	bySymbol := func(list []BoardItem) {
		sort.SliceStable(list, func(a, b int) bool { return jsx.LocaleCompare(list[a].Symbol, list[b].Symbol) < 0 })
	}
	bySymbol(stocks)
	bySymbol(indices)
	return append(indices, stocks...)
}

// FnoStock is index.ts FnoStock: an NSE equity row with an F&O lot size. Its JSON is the
// instrument's fields followed by fno_lot_size ({...eq, fno_lot_size}).
type FnoStock struct {
	Instrument market.Instrument
	FnoLotSize float64
	// Row is the index of the equity row in the slice the stock was derived from.
	Row int
}

// AppendJS writes {...instrument, fno_lot_size}.
func (s FnoStock) AppendJS(dst []byte) []byte {
	return appendRow(dst, WireRow{Instrument: s.Instrument}, &s.FnoLotSize)
}

// DeriveFnoStocks is index.ts deriveFnoStocks: every NSE EQ row whose trading symbol is
// an NFO futures name, with the lot size of the first future seen for it, sorted by
// trading symbol (localeCompare, stable).
func DeriveFnoStocks(all []market.Instrument) []FnoStock {
	var order []string
	lot := map[string]float64{}
	eqBySymbol := map[string]int{}
	for i := range all {
		in := &all[i]
		switch {
		case isFut(in):
			if _, seen := lot[in.Name]; !seen { // keep the first seen
				lot[in.Name] = in.LotSize
				order = append(order, in.Name)
			}
		case in.Exchange == "NSE" && in.InstrumentType == "EQ":
			eqBySymbol[in.Tradingsymbol] = i
		}
	}
	out := []FnoStock{}
	for _, symbol := range order {
		if e, ok := eqBySymbol[symbol]; ok {
			out = append(out, FnoStock{Instrument: all[e], FnoLotSize: lot[symbol], Row: e})
		}
	}
	sort.SliceStable(out, func(a, b int) bool {
		return jsx.LocaleCompare(out[a].Instrument.Tradingsymbol, out[b].Instrument.Tradingsymbol) < 0
	})
	return out
}

// appendRow writes one instrument row as Node's objects were: the row's own JSON (the
// twelve Kite fields, plus broker-native fields for a Dhan row), then fno_lot_size when
// lot is not nil ({...eq, fno_lot_size}).
func appendRow(dst []byte, row WireRow, lot *float64) []byte {
	if row.JSON != nil {
		dst = row.JSON.AppendJS(dst)
	} else {
		dst = jsjson.Append(dst, &row.Instrument)
	}
	if lot != nil && len(dst) > 0 && dst[len(dst)-1] == '}' {
		if dst[len(dst)-2] != '{' {
			dst = append(dst[:len(dst)-1], ',')
		} else {
			dst = dst[:len(dst)-1]
		}
		dst = jsjson.AppendString(dst, "fno_lot_size")
		dst = append(dst, ':')
		dst = jsjson.AppendFloat(dst, *lot)
		dst = append(dst, '}')
	}
	return dst
}
