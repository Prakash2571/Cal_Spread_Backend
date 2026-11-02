package model

import (
	"regexp"
	"strconv"
	"strings"
)

// indexSpotMap is the index allow-list of src/indexSpot.ts INDEX_SPOT_MAP (Zerodha spot
// trading symbols); only the keys matter here: they decide the settlement convention.
var indexSpotMap = map[string]string{
	"NIFTY":      "NIFTY 50",
	"BANKNIFTY":  "NIFTY BANK",
	"FINNIFTY":   "NIFTY FIN SERVICE",
	"MIDCPNIFTY": "NIFTY MID SELECT",
	"NIFTYNXT50": "NIFTY NEXT 50",
}

var (
	reDate      = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)
	reTimestamp = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?(?:Z|[+-][0-9]{2}:[0-9]{2})$`)
	reLocalTime = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$`)
)

// ValidDate is metadata.ts validDate: it rejects the date rollovers Date.parse accepts
// (for example February 30).
func ValidDate(date string) bool {
	if !reDate.MatchString(date) {
		return false
	}
	ms := DateParse(date)
	if !isFinite(ms) {
		return false
	}
	return ISOString(ms)[:10] == date
}

// UTCTimestamp is metadata.ts utcTimestamp: it returns the canonical ISO string of an
// exact UTC/offset timestamp, or false.
func UTCTimestamp(value string) (string, bool) {
	if !reTimestamp.MatchString(value) || !ValidDate(value[:10]) {
		return "", false
	}
	ms := DateParse(value)
	if !isFinite(ms) {
		return "", false
	}
	hh, _ := strconv.Atoi(value[11:13])
	mm, _ := strconv.Atoi(value[14:16])
	ss, _ := strconv.Atoi(value[17:19])
	if hh > 23 || mm > 59 || ss > 59 {
		return "", false
	}
	if n := len(value); n >= 6 && (value[n-6] == '+' || value[n-6] == '-') {
		oh, _ := strconv.Atoi(value[n-5 : n-3])
		om, _ := strconv.Atoi(value[n-2:])
		if oh > 23 || om > 59 {
			return "", false
		}
	}
	return ISOString(ms), true
}

// OptionMetadataResult is the outcome of ResolveOptionMetadata.
type OptionMetadataResult struct {
	OK       bool
	Metadata OptionMetadata
	Reasons  []string
}

// ResolveOptionMetadata is metadata.ts resolveOptionMetadata.
func ResolveOptionMetadata(inst Instrument, policy *ExpiryPolicy, metadataVersion string) OptionMetadataResult {
	reasons := []string{}
	if inst.Exchange != "NFO" || (inst.InstrumentType != CE && inst.InstrumentType != PE) {
		reasons = append(reasons, "unsupported_contract_style")
	}
	if jsTrim(inst.Name) == "" || jsTrim(inst.Tradingsymbol) == "" || !isSafeInteger(inst.InstrumentToken) || inst.InstrumentToken <= 0 ||
		!isFinite(inst.Strike) || inst.Strike <= 0 || !isFinite(inst.TickSize) || inst.TickSize <= 0 ||
		!isSafeInteger(inst.LotSize) || inst.LotSize <= 0 {
		reasons = append(reasons, "invalid_instrument_metadata")
	}
	if inst.ExerciseStyle != nil && *inst.ExerciseStyle != "european" {
		reasons = append(reasons, "unsupported_contract_style")
	}
	var timestamp string
	var haveTimestamp bool
	var source string
	if inst.ExpiryTimestamp != nil {
		timestamp, haveTimestamp = UTCTimestamp(*inst.ExpiryTimestamp)
		source = "instrument_metadata_exact_timestamp"
	} else if o := overrideFor(policy, inst.Tradingsymbol); o != "" {
		timestamp, haveTimestamp = UTCTimestamp(o)
		source = policy.Source + " / " + policy.Version + " / exact instrument override"
	} else if ValidDate(inst.Expiry) && policy != nil {
		timestamp, haveTimestamp = UTCTimestamp(inst.Expiry + "T" + policy.LocalTime + "+05:30")
		source = policy.Source + " / " + policy.Version + " / date from instrument metadata"
	} else if ts, ok := UTCTimestamp(inst.Expiry); ok {
		timestamp, haveTimestamp = ts, true
		source = "instrument_metadata_exact_timestamp"
	}
	if !ValidDate(jsPrefix(inst.Expiry, 10)) {
		reasons = append(reasons, "invalid_expiry_metadata")
	}
	if !haveTimestamp {
		if ValidDate(inst.Expiry) {
			reasons = append(reasons, "expiry_time_unverified")
		} else {
			reasons = append(reasons, "invalid_expiry_metadata")
		}
	}
	if len(reasons) > 0 || !haveTimestamp {
		return OptionMetadataResult{Reasons: reasons}
	}
	name := strings.ToUpper(inst.Name)
	settlement := "official_stock_settlement"
	if _, ok := indexSpotMap[name]; ok {
		settlement = "official_index_close"
	}
	return OptionMetadataResult{OK: true, Metadata: OptionMetadata{
		Token: inst.InstrumentToken, Tradingsymbol: inst.Tradingsymbol, Underlying: name,
		Exchange: inst.Exchange, Side: inst.InstrumentType, Strike: inst.Strike,
		Expiry: jsPrefix(inst.Expiry, 10), ExpiryTimestamp: timestamp, ExpirySource: source,
		Timezone: "Asia/Kolkata", Style: "european", SettlementUnderlying: settlement,
		LotSize: inst.LotSize, TickSize: inst.TickSize, MetadataVersion: metadataVersion,
	}}
}

func overrideFor(policy *ExpiryPolicy, symbol string) string {
	if policy == nil {
		return ""
	}
	return policy.Overrides[symbol]
}

// jsPrefix is s.slice(0, n) for the ASCII strings that matter here.
func jsPrefix(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// validLocalTime reports whether s is an HH:mm:ss local time.
func validLocalTime(s string) bool { return reLocalTime.MatchString(s) }
