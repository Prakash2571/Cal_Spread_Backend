package model

import (
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsmath"
)

// AlternativePrice is an optional alternative calibration for ModelSensitivity.
type AlternativePrice struct {
	Iv, Forward float64
	Label       string
}

// SensitivityArgs are the inputs of ModelSensitivity. Nil pointers are null.
type SensitivityArgs struct {
	F, Strike, T, D, Iv float64
	Side                string
	ForwardDispersion   *float64
	RateBump            float64
	QuoteIvBid          *float64
	QuoteIvAsk          *float64
	Alternative         *AlternativePrice
}

// ModelSensitivity is sensitivity.ts modelSensitivity: transparent scenario repricing,
// not a sampling distribution or statistical interval.
func ModelSensitivity(a SensitivityArgs) SensitivityRange {
	scenarios := []Scenario{}
	reasons := []string{}
	add := func(name string, forward, discount, volatility float64, assumption string) {
		if !isFinite(forward) || !isFinite(discount) || !isFinite(volatility) || forward <= 0 || discount <= 0 || volatility < 0 {
			reasons = append(reasons, name+"_invalid_scenario_omitted")
			return
		}
		scenarios = append(scenarios, Scenario{Name: name, Forward: forward, Discount: discount, Iv: volatility,
			Price:      BlackPrice(BlackInput{F: forward, K: a.Strike, D: discount, W: float64(volatility*volatility) * a.T, Side: a.Side}),
			Assumption: assumption})
	}
	add("baseline", a.F, a.D, a.Iv, "Frozen requested local surface IV, forward and curve.")
	if a.ForwardDispersion != nil && *a.ForwardDispersion > 0 {
		add("forward_minus_dispersion", a.F-*a.ForwardDispersion, a.D, a.Iv,
			"Forward minus weighted median absolute parity-forward dispersion; diagnostic scenario, not a probability quantile.")
		add("forward_plus_dispersion", a.F+*a.ForwardDispersion, a.D, a.Iv,
			"Forward plus weighted median absolute parity-forward dispersion; local IV held fixed.")
	} else {
		reasons = append(reasons, "forward_uncertainty_not_identified_by_dispersion")
	}
	if a.QuoteIvBid != nil {
		add("quote_bid_iv", a.F, a.D, *a.QuoteIvBid, "Valid target quote bid-IV at fixed forward/discount; quote-implied range only.")
	}
	if a.QuoteIvAsk != nil {
		add("quote_ask_iv", a.F, a.D, *a.QuoteIvAsk, "Valid target quote ask-IV at fixed forward/discount; quote-implied range only.")
	}
	if a.RateBump > 0 {
		bump := jsjson.FormatNumber(a.RateBump * 100)
		add("rate_minus_bump", a.F, a.D*jsmath.Exp(a.RateBump*a.T), a.Iv,
			"Configured continuous-zero rate scenario −"+bump+" percentage points; forward/IV held fixed.")
		add("rate_plus_bump", a.F, a.D*jsmath.Exp(-a.RateBump*a.T), a.Iv,
			"Configured continuous-zero rate scenario +"+bump+" percentage points; forward/IV held fixed.")
	}
	if a.Alternative != nil {
		add("alternative_calibration", a.Alternative.Forward, a.D, a.Alternative.Iv,
			a.Alternative.Label+"; alternative calibrated forward/local IV, same curve.")
	}
	prices := make([]float64, len(scenarios))
	for i, s := range scenarios {
		prices[i] = s.Price
	}
	return SensitivityRange{Label: "Model sensitivity range", Low: jsMin(prices...), High: jsMax(prices...),
		Scenarios: scenarios, Reasons: reasons}
}
