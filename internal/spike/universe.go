package spike

import (
	"math"
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

// atmPair is the listed same-strike CE+PE nearest the underlying spot. Pairs are
// sorted by strike, so an exact midpoint tie takes the lower strike.
func atmPair(u universe, spot float64) (pair, bool) {
	if spot <= 0 || !finite(spot) || len(u.Pairs) == 0 {
		return pair{}, false
	}
	best := 0
	for i := range u.Pairs {
		if math.Abs(u.Pairs[i].CE.Strike-spot) < math.Abs(u.Pairs[best].CE.Strike-spot) {
			best = i
		}
	}
	return u.Pairs[best], true
}

// creditSpreadLegs counts listed strikes strictly above/below the selected ATM
// strike on the same option side; missing intermediate strikes are allowed.
func creditSpreadLegs(u universe, selected pair, direction string) (market.Instrument, market.Instrument, bool) {
	var short market.Instrument
	var options []market.Instrument
	switch direction {
	case CallCredit:
		short, options = selected.CE, u.Calls
		count := 0
		for _, option := range options {
			if option.Strike > short.Strike {
				count++
				if count == HedgeSteps {
					return short, option, true
				}
			}
		}
	case PutCredit:
		short, options = selected.PE, u.Puts
		count := 0
		for i := len(options) - 1; i >= 0; i-- {
			if options[i].Strike < short.Strike {
				count++
				if count == HedgeSteps {
					return short, options[i], true
				}
			}
		}
	}
	return short, market.Instrument{}, false
}
