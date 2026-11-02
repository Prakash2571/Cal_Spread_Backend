package analytics

// indexSpotMap is src/indexSpot.ts INDEX_SPOT_MAP: index F&O underlying → the index's spot
// trading symbol in Zerodha's naming. It is also the allow-list of index underlyings.
var indexSpotMap = map[string]string{
	"NIFTY":      "NIFTY 50",
	"BANKNIFTY":  "NIFTY BANK",
	"FINNIFTY":   "NIFTY FIN SERVICE",
	"MIDCPNIFTY": "NIFTY MID SELECT",
	"NIFTYNXT50": "NIFTY NEXT 50",
}

// indexSpotCandidates is indexSpotCandidates: the curated name first, then the underlying
// itself (Dhan's convention); empty for a non-index underlying.
func indexSpotCandidates(underlying string) []string {
	mapped, ok := indexSpotMap[underlying]
	if !ok || mapped == "" {
		return nil
	}
	if mapped == underlying {
		return []string{mapped}
	}
	return []string{mapped, underlying}
}

// resolveIndexSpotSymbol is resolveIndexSpotSymbol: the first candidate the universe has.
func resolveIndexSpotSymbol(underlying string, hasSpot func(string) bool) (string, bool) {
	for _, c := range indexSpotCandidates(underlying) {
		if hasSpot(c) {
			return c, true
		}
	}
	return "", false
}
