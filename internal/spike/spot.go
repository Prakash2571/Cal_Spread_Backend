package spike

import (
	"strings"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

const (
	spotHistoryMs     = int64(45 * time.Minute / time.Millisecond)
	spotBaselineAgeMs = int64(5 * time.Minute / time.Millisecond)
)

type spotSample struct {
	T     int64
	Price float64
}

type spotHistory []spotSample

func (h *spotHistory) prune(now int64) {
	cut := 0
	for cut < len(*h) && now-(*h)[cut].T > spotHistoryMs {
		cut++
	}
	if cut > 0 {
		*h = (*h)[cut:]
		if len(*h) == 0 {
			*h = nil
		}
	}
}

func (h *spotHistory) add(sample spotSample) {
	h.prune(sample.T)
	if n := len(*h); n > 0 && (*h)[n-1].T == sample.T {
		(*h)[n-1] = sample
	} else {
		*h = append(*h, sample)
	}
}

func (h spotHistory) atOrBefore(at int64) spotSample {
	for i := len(h) - 1; i >= 0; i-- {
		if h[i].T <= at {
			return h[i]
		}
	}
	return spotSample{}
}

// attributeUnderlyingDirection is the single policy for mapping the underlying
// move to legs. Timestamps are local receipt times, like option quoteAgeMs.
func attributeUnderlyingDirection(baseline, current spotSample, armedAt, triggerAt int64) (string, string) {
	if baseline.T <= 0 || baseline.T > armedAt || armedAt-baseline.T > spotBaselineAgeMs ||
		current.T <= 0 || current.T > triggerAt || triggerAt-current.T > quoteAgeMs ||
		baseline.Price <= 0 || current.Price <= 0 || !finite(baseline.Price) || !finite(current.Price) {
		return "", "Signal skipped: underlying spot was unavailable or stale"
	}
	if current.Price > baseline.Price {
		return ShortPELongCE, ""
	}
	if current.Price < baseline.Price {
		return ShortCELongPE, ""
	}
	return "", "Signal skipped: underlying was flat since arming"
}

// resolveSpotTokens uses normalized Instruments() master rows, never security-ID
// constants. Dhan maps raw NSE/BSE segment I, INDEX rows to INDICES/INDICES.
// Match exact index aliases; a conflicting match fails closed for that symbol.
func resolveSpotTokens(all []market.Instrument) map[int64]string {
	bySymbol := map[string]int64{}
	ambiguous := map[string]bool{}
	for _, row := range all {
		if row.InstrumentType != "INDEX" || row.Exchange != "INDICES" || row.Segment != "INDICES" || row.InstrumentToken <= 0 {
			continue
		}
		for _, symbol := range Symbols {
			matches := func(value string) bool {
				value = strings.Join(strings.Fields(strings.ToUpper(value)), " ")
				return value == symbol || (symbol == "NIFTY" && value == "NIFTY 50")
			}
			if !matches(row.Name) && !matches(row.Tradingsymbol) {
				continue
			}
			if token := bySymbol[symbol]; token != 0 && token != row.InstrumentToken {
				ambiguous[symbol] = true
			}
			bySymbol[symbol] = row.InstrumentToken
		}
	}
	result := map[int64]string{}
	for symbol, token := range bySymbol {
		if !ambiguous[symbol] {
			result[token] = symbol
		}
	}
	return result
}
