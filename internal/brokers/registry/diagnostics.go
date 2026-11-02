package registry

import (
	"regexp"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// IndexSpotMap is indexSpot.ts INDEX_SPOT_MAP: index F&O underlying → the index's spot
// trading symbol in Zerodha's naming. It is also the allow-list of index underlyings.
var IndexSpotMap = map[string]string{
	"NIFTY":      "NIFTY 50",
	"BANKNIFTY":  "NIFTY BANK",
	"FINNIFTY":   "NIFTY FIN SERVICE",
	"MIDCPNIFTY": "NIFTY MID SELECT",
	"NIFTYNXT50": "NIFTY NEXT 50",
}

// IndexSpotCandidates is indexSpotCandidates: the curated name first, then the
// underlying itself (Dhan's convention), de-duplicated; empty for a non-index.
func IndexSpotCandidates(underlying string, spotMap map[string]string) []string {
	mapped := spotMap[underlying]
	if mapped == "" {
		return []string{}
	}
	if mapped == underlying {
		return []string{mapped}
	}
	return []string{mapped, underlying}
}

// ResolveIndexSpotSymbol is resolveIndexSpotSymbol: the first candidate the universe
// has, ok false when none.
func ResolveIndexSpotSymbol(underlying string, hasSpot func(tradingsymbol string) bool, spotMap map[string]string) (string, bool) {
	for _, c := range IndexSpotCandidates(underlying, spotMap) {
		if hasSpot(c) {
			return c, true
		}
	}
	return "", false
}

// UnmatchedUnderlying is a futures underlying the board drops, with the reason.
type UnmatchedUnderlying struct {
	Underlying   string `json:"underlying"`
	FutureSymbol string `json:"futureSymbol"`
	FutureName   string `json:"futureName"`
	Expiry       string `json:"expiry"`
	Reason       string `json:"reason"` // no_spot_equity | no_index_mapping | empty_underlying
}

// BoardDiagnostics is the stage-by-stage report of the board join.
type BoardDiagnostics struct {
	ParsedInstruments       int                   `json:"parsedInstruments"`
	Futures                 int                   `json:"futures"`
	UniqueFutureUnderlyings int                   `json:"uniqueFutureUnderlyings"`
	MatchedEquities         int                   `json:"matchedEquities"`
	MatchedIndices          int                   `json:"matchedIndices"`
	BoardSize               int                   `json:"boardSize"`
	UnmatchedUnderlyings    int                   `json:"unmatchedUnderlyings"`
	UnmatchedSamples        []UnmatchedUnderlying `json:"unmatchedSamples"`
	AvailableEquities       int                   `json:"availableEquities"`
	AvailableIndices        int                   `json:"availableIndices"`
}

// KnownSymbolCheck is the per-symbol board readiness check.
type KnownSymbolCheck struct {
	Symbol                     string  `json:"symbol"`
	EquityFound                bool    `json:"equityFound"`
	FuturesFound               int     `json:"futuresFound"`
	ValidExpiries              int     `json:"validExpiries"`
	ValidLotSizes              int     `json:"validLotSizes"`
	CanonicalUnderlyingMatches bool    `json:"canonicalUnderlyingMatches"`
	OnBoard                    bool    `json:"onBoard"`
	FailsAt                    *string `json:"failsAt"`
}

// DefaultKnownSymbols are the underlyings checkKnownSymbols looks at by default.
var DefaultKnownSymbols = []string{"BHEL", "RELIANCE", "HDFCBANK", "SBIN", "TCS", "INFY", "ICICIBANK", "AXISBANK", "BHARTIARTL"}

// orderedGroups is a Map<string, Instrument[]> in first-insertion order.
type orderedGroups struct {
	keys []string
	m    map[string][]*market.Instrument
}

func (g *orderedGroups) add(k string, inst *market.Instrument) {
	if g.m == nil {
		g.m = map[string][]*market.Instrument{}
	}
	if _, ok := g.m[k]; !ok {
		g.keys = append(g.keys, k)
	}
	g.m[k] = append(g.m[k], inst)
}

// DiagnoseBoard is diagnoseBoard: deriveFnoBoard's join, reported stage by stage.
func DiagnoseBoard(all []market.Instrument, spotMap map[string]string) BoardDiagnostics {
	var futures orderedGroups
	eqBySymbol := map[string]bool{}
	indexBySymbol := map[string]bool{}
	for i := range all {
		inst := &all[i]
		switch {
		case inst.Exchange == "NFO" && inst.InstrumentType == "FUT" && inst.Name != "":
			futures.add(inst.Name, inst)
		case inst.Segment == "INDICES":
			indexBySymbol[inst.Tradingsymbol] = true
		case inst.Exchange == "NSE" && inst.InstrumentType == "EQ":
			eqBySymbol[inst.Tradingsymbol] = true
		}
	}

	matchedEquities, matchedIndices := 0, 0
	unmatched := []UnmatchedUnderlying{}
	for _, underlying := range futures.keys {
		if eqBySymbol[underlying] {
			matchedEquities++
			continue
		}
		if _, ok := ResolveIndexSpotSymbol(underlying, func(s string) bool { return indexBySymbol[s] }, spotMap); ok {
			matchedIndices++
			continue
		}
		sample := futures.m[underlying][0]
		reason := "no_spot_equity"
		if spotMap[underlying] != "" {
			reason = "no_index_mapping"
		}
		unmatched = append(unmatched, UnmatchedUnderlying{
			Underlying: underlying, FutureSymbol: sample.Tradingsymbol, FutureName: sample.Name,
			Expiry: sample.Expiry, Reason: reason,
		})
	}

	nFutures, empty := 0, 0
	for i := range all {
		inst := &all[i]
		if inst.Exchange != "NFO" || inst.InstrumentType != "FUT" {
			continue
		}
		nFutures++
		if inst.Name == "" && empty < 10 {
			empty++
			unmatched = append(unmatched, UnmatchedUnderlying{
				FutureSymbol: inst.Tradingsymbol, FutureName: inst.Name, Expiry: inst.Expiry, Reason: "empty_underlying",
			})
		}
	}

	samples := unmatched
	if len(samples) > 30 {
		samples = samples[:30]
	}
	return BoardDiagnostics{
		ParsedInstruments:       len(all),
		Futures:                 nFutures,
		UniqueFutureUnderlyings: len(futures.keys),
		MatchedEquities:         matchedEquities,
		MatchedIndices:          matchedIndices,
		BoardSize:               matchedEquities + matchedIndices,
		UnmatchedUnderlyings:    len(unmatched),
		UnmatchedSamples:        samples,
		AvailableEquities:       len(eqBySymbol),
		AvailableIndices:        len(indexBySymbol),
	}
}

var isoDateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// CheckKnownSymbols is checkKnownSymbols: for each symbol, the first board stage that
// fails (nil when healthy). nil symbols means DefaultKnownSymbols.
func CheckKnownSymbols(all []market.Instrument, symbols []string) []KnownSymbolCheck {
	if symbols == nil {
		symbols = DefaultKnownSymbols
	}
	eqBySymbol := map[string]bool{}
	var futures orderedGroups
	for i := range all {
		inst := &all[i]
		if inst.Exchange == "NSE" && inst.InstrumentType == "EQ" {
			eqBySymbol[inst.Tradingsymbol] = true
		}
		if inst.Exchange == "NFO" && inst.InstrumentType == "FUT" && inst.Name != "" {
			futures.add(inst.Name, inst)
		}
	}
	out := make([]KnownSymbolCheck, 0, len(symbols))
	for _, symbol := range symbols {
		equity := eqBySymbol[symbol]
		futs := futures.m[symbol]
		validExpiries, validLots := 0, 0
		for _, f := range futs {
			if isoDateRe.MatchString(f.Expiry) {
				validExpiries++
			}
			if f.LotSize > 0 {
				validLots++
			}
		}
		canonical := len(futs) > 0 && equity
		var failsAt *string
		switch {
		case !equity:
			failsAt = strPtr("no NSE equity row with this trading symbol")
		case len(futs) == 0:
			failsAt = strPtr("no NFO future whose canonical underlying is this symbol")
		case validExpiries == 0:
			failsAt = strPtr("futures exist but none has a valid YYYY-MM-DD expiry")
		case validLots == 0:
			failsAt = strPtr("futures exist but none has a positive lot size")
		}
		out = append(out, KnownSymbolCheck{
			Symbol: symbol, EquityFound: equity, FuturesFound: len(futs), ValidExpiries: validExpiries,
			ValidLotSizes: validLots, CanonicalUnderlyingMatches: canonical,
			OnBoard: canonical && validExpiries > 0 && validLots > 0, FailsAt: failsAt,
		})
	}
	return out
}
