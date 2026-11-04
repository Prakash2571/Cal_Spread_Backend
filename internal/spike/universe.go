package spike

import (
	"sort"
	"strings"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

type pair struct{ CE, PE market.Instrument }
type universe struct {
	Symbol, Expiry string
	Pairs          []pair
	Calls, Puts    []market.Instrument
}

func buildUniverses(all []market.Instrument, day string) map[string]universe {
	result := map[string]universe{}
	for _, symbol := range Symbols {
		expiry := ""
		for _, row := range all {
			if strings.ToUpper(row.Name) == symbol && (row.Exchange == "NFO" || row.Exchange == "BFO") &&
				(row.InstrumentType == "CE" || row.InstrumentType == "PE") && row.Expiry >= day &&
				(expiry == "" || row.Expiry < expiry) {
				expiry = row.Expiry
			}
		}
		u := universe{Symbol: symbol, Expiry: expiry}
		calls, puts := map[float64]market.Instrument{}, map[float64]market.Instrument{}
		for _, row := range all {
			if strings.ToUpper(row.Name) != symbol || row.Expiry != expiry || row.Strike <= 0 ||
				(row.Exchange != "NFO" && row.Exchange != "BFO") {
				continue
			}
			if row.InstrumentType == "CE" {
				calls[row.Strike] = row
				u.Calls = append(u.Calls, row)
			}
			if row.InstrumentType == "PE" {
				puts[row.Strike] = row
				u.Puts = append(u.Puts, row)
			}
		}
		for strike, ce := range calls {
			if pe, ok := puts[strike]; ok {
				u.Pairs = append(u.Pairs, pair{ce, pe})
			}
		}
		sort.Slice(u.Pairs, func(i, j int) bool { return u.Pairs[i].CE.Strike < u.Pairs[j].CE.Strike })
		sort.Slice(u.Calls, func(i, j int) bool { return u.Calls[i].Strike < u.Calls[j].Strike })
		sort.Slice(u.Puts, func(i, j int) bool { return u.Puts[i].Strike < u.Puts[j].Strike })
		result[symbol] = u
	}
	return result
}

func hedgeFor(u universe, selected pair, direction string) (market.Instrument, market.Instrument, bool) {
	short, options, step := selected.CE, u.Calls, HedgeSteps
	if direction == "PUT_CREDIT" {
		short, options, step = selected.PE, u.Puts, -HedgeSteps
	}
	for i, option := range options {
		if option.InstrumentToken == short.InstrumentToken {
			at := i + step
			if at >= 0 && at < len(options) {
				return short, options[at], true
			}
			break
		}
	}
	return short, market.Instrument{}, false
}
