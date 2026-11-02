package model

import (
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
)

// DecodeInputSnapshot reads an InputSnapshot from its JSON value (as JSON.parse
// produced it). The configuration is validated like the engine constructor does, not
// normalised. Tests use it to run the Go model on the exact inputs Node used.
func DecodeInputSnapshot(v any) (in InputSnapshot, err error) {
	err = Catch(func() {
		str := func(o any, k string) string { s, _ := getProp(o, k).(string); return s }
		num := func(o any, k string) float64 { f, _ := getProp(o, k).(float64); return f }
		in.ID = str(v, "id")
		in.Underlying = str(v, "underlying")
		in.Name = str(v, "name")
		in.Broker = str(v, "broker")
		in.BrokerGeneration = num(v, "broker_generation")
		in.FeedGeneration = num(v, "feed_generation")
		in.ValuationTime = str(v, "valuation_time")
		in.MetadataVersion = str(v, "metadata_version")
		in.Instruments = []Instrument{}
		for _, e := range arrayOf(getProp(v, "instruments")) {
			in.Instruments = append(in.Instruments, DecodeInstrument(e))
		}
		in.Quotes = []MarketQuote{}
		for _, e := range arrayOf(getProp(v, "quotes")) {
			in.Quotes = append(in.Quotes, DecodeMarketQuote(e))
		}
		in.Spot = decodeSpot(getProp(v, "spot"))
		in.Futures = []Future{}
		for _, e := range arrayOf(getProp(v, "futures")) {
			in.Futures = append(in.Futures, Future{ExpiryTimestamp: str(e, "expiry_timestamp"),
				Quote: DecodeMarketQuote(getProp(e, "quote")), TickSize: num(e, "tick_size")})
		}
		raw, ok := getProp(v, "config").(*jsjson.Object)
		if !ok {
			throw("Input snapshot has no configuration object.")
		}
		cfg, cerr := DecodeConfig(raw)
		if cerr != nil {
			panic(cerr)
		}
		in.Config = cfg
		in.ConfigVersion = str(v, "config_version")
		u := getProp(v, "universe")
		in.Universe = Universe{ListedContracts: num(u, "listed_contracts"), CapturedContracts: num(u, "captured_contracts"),
			OmittedExpiries: []string{}, Bounded: getProp(u, "bounded") == true}
		for _, e := range arrayOf(getProp(u, "omitted_expiries")) {
			s, _ := e.(string)
			in.Universe.OmittedExpiries = append(in.Universe.OmittedExpiries, s)
		}
		if p := getProp(v, "spot_provenance"); !isUndefined(p) {
			in.HasSpotProvenance = true
			if p != nil {
				var exch *string
				if s, ok := getProp(p, "exchange_timestamp").(string); ok {
					exch = &s
				}
				in.SpotProvenance = &SpotProvenance{ExchangeTimestamp: exch, ReceiveTimestamp: str(p, "receive_timestamp"),
					FreshnessBasis: str(p, "freshness_basis")}
			}
		}
		if c := getProp(v, "listing_catalog"); !isUndefined(c) {
			in.HasListingCatalog = true
			in.ListingCatalog = []OptionMetadata{}
			for _, e := range arrayOf(c) {
				in.ListingCatalog = append(in.ListingCatalog, DecodeOptionMetadata(e))
			}
		}
	})
	return in, err
}

func arrayOf(v any) []any {
	a, _ := v.([]any)
	return a
}

// DecodeInstrument reads one instrument row.
func DecodeInstrument(v any) Instrument {
	str := func(k string) string { s, _ := getProp(v, k).(string); return s }
	num := func(k string) float64 { f, _ := getProp(v, k).(float64); return f }
	inst := Instrument{InstrumentToken: num("instrument_token"), ExchangeToken: num("exchange_token"),
		Tradingsymbol: str("tradingsymbol"), Name: str("name"), LastPrice: num("last_price"), Expiry: str("expiry"),
		Strike: num("strike"), TickSize: num("tick_size"), LotSize: num("lot_size"), InstrumentType: str("instrument_type"),
		Segment: str("segment"), Exchange: str("exchange")}
	if s, ok := getProp(v, "expiry_timestamp").(string); ok {
		inst.ExpiryTimestamp = &s
	}
	if s, ok := getProp(v, "exercise_style").(string); ok {
		inst.ExerciseStyle = &s
	}
	inst.Raw, _ = v.(*jsjson.Object)
	return inst
}

// DecodeMarketQuote reads one quote.
func DecodeMarketQuote(v any) MarketQuote {
	q := MarketQuote{}
	q.Token, _ = getProp(v, "token").(float64)
	if f, ok := getProp(v, "bid").(float64); ok {
		q.Bid = &f
	}
	if f, ok := getProp(v, "ask").(float64); ok {
		q.Ask = &f
	}
	q.BidDepth, _ = getProp(v, "bid_depth").(float64)
	q.AskDepth, _ = getProp(v, "ask_depth").(float64)
	if s, ok := getProp(v, "exchange_timestamp").(string); ok {
		q.ExchangeTimestamp = &s
	}
	q.ReceiveTimestamp, _ = getProp(v, "receive_timestamp").(string)
	q.Source, _ = getProp(v, "source").(string)
	q.Version, _ = getProp(v, "version").(float64)
	return q
}

// DecodeOptionMetadata reads one metadata record.
func DecodeOptionMetadata(v any) OptionMetadata {
	str := func(k string) string { s, _ := getProp(v, k).(string); return s }
	num := func(k string) float64 { f, _ := getProp(v, k).(float64); return f }
	return OptionMetadata{Token: num("token"), Tradingsymbol: str("tradingsymbol"), Underlying: str("underlying"),
		Exchange: str("exchange"), Side: str("side"), Strike: num("strike"), Expiry: str("expiry"),
		ExpiryTimestamp: str("expiry_timestamp"), ExpirySource: str("expiry_source"), Timezone: str("timezone"),
		Style: str("style"), SettlementUnderlying: str("settlement_underlying"), LotSize: num("lot_size"),
		TickSize: num("tick_size"), MetadataVersion: str("metadata_version")}
}

func decodeSpot(v any) *Spot {
	if isNullish(v) {
		return nil
	}
	s := &Spot{}
	s.Value, _ = getProp(v, "value").(float64)
	s.Timestamp, _ = getProp(v, "timestamp").(string)
	if o, ok := v.(*jsjson.Object); ok && o.Has("receive_timestamp") {
		p := &SpotProvenance{}
		if e, ok := getProp(v, "exchange_timestamp").(string); ok {
			p.ExchangeTimestamp = &e
		}
		p.ReceiveTimestamp, _ = getProp(v, "receive_timestamp").(string)
		p.FreshnessBasis, _ = getProp(v, "freshness_basis").(string)
		s.Provenance = p
	}
	return s
}

// DecodeCleanQuote reads a cleaned quote (test fixtures build them directly).
func DecodeCleanQuote(v any) CleanQuote {
	q := CleanQuote{MarketQuote: DecodeMarketQuote(v)}
	num := func(k string) float64 { f, _ := getProp(v, k).(float64); return f }
	q.Mid, q.Spread, q.RelativeSpread, q.AgeMs = num("mid"), num("spread"), num("relative_spread"), num("age_ms")
	q.FreshnessBasis, _ = getProp(v, "freshness_basis").(string)
	q.QuoteTimestamp, _ = getProp(v, "quote_timestamp").(string)
	q.AvailableDepth, q.Weight, q.H = num("available_depth"), num("weight"), num("h")
	q.CalibrationEligible = getProp(v, "calibration_eligible") == true
	q.Reasons = []string{}
	for _, r := range arrayOf(getProp(v, "reasons")) {
		s, _ := r.(string)
		q.Reasons = append(q.Reasons, s)
	}
	return q
}

// DecodeCurve reads a discount-curve object (tests and fixtures).
func DecodeCurve(v any) DiscountCurveSpec { return decodeCurve(v) }

// DecodeCarry reads a carry specification object.
func DecodeCarry(v any) *CarrySpec { return decodeCarry(v) }

// DecodeExpiryPolicy reads an expiry-policy object.
func DecodeExpiryPolicy(o *jsjson.Object) *ExpiryPolicy { return decodeExpiryPolicy(o) }
