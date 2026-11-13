package spike

import (
	"math"
	"time"
)

const (
	WindowMs       = int64(30 * time.Minute / time.Millisecond)
	MinimumMovePct = 5.0
	HedgeSteps     = 4
	quoteAgeMs     = int64(time.Minute / time.Millisecond)
	bookAgeMs      = int64(15 * time.Second / time.Millisecond)
	maxTokens      = 5000
)

var Symbols = []string{"NIFTY", "SENSEX"}
var ist = time.FixedZone("IST", 330*60)

type Sample struct {
	T       int64   `json:"t"`
	Premium float64 `json:"premium"`
	VWAP    float64 `json:"vwap"`
	Strike  float64 `json:"strike"`
	Expiry  string  `json:"expiry"`
	CEToken int64   `json:"ce_token"`
	PEToken int64   `json:"pe_token"`
}

type Bar struct {
	Sample
	Symbol string  `json:"symbol"`
	Day    string  `json:"day"`
	Low    float64 `json:"low"`
	LowAt  int64   `json:"low_at"`
	High   float64 `json:"high"`
	HighAt int64   `json:"high_at"`
}

// Chart-only day state. Bars persist the stamped VWAP, but not the volume weights
// or token marks needed to rebuild this accumulator after a mid-day restart.
type chartVWAPAccumulator struct {
	weighted, total float64
	marks           map[int64]float64
}

type Signal struct {
	Direction   string  `json:"direction"`
	T           int64   `json:"t"`
	Reference   float64 `json:"reference"`
	ReferenceAt int64   `json:"reference_at"`
	MovePct     float64 `json:"move_pct"`
	Premium     float64 `json:"premium"`
	VWAP        float64 `json:"vwap"`
}

type Leg struct {
	Token  int64    `json:"token"`
	Symbol string   `json:"symbol"`
	Strike float64  `json:"strike"`
	Entry  float64  `json:"entry"`
	Exit   *float64 `json:"exit,omitempty"`
}

type Trade struct {
	ID          string   `json:"id"`
	Symbol      string   `json:"symbol"`
	Status      string   `json:"status"`
	Direction   string   `json:"direction"`
	Expiry      string   `json:"expiry"`
	LotSize     int      `json:"lot_size"`
	Quantity    int      `json:"quantity"`
	OpenedAt    int64    `json:"opened_at"`
	ClosedAt    *int64   `json:"closed_at,omitempty"`
	Short       Leg      `json:"short"`
	Hedge       Leg      `json:"hedge"`
	Signal      Signal   `json:"signal"`
	EntryCredit float64  `json:"entry_credit"`
	MarkShort   *float64 `json:"mark_short,omitempty"`
	MarkHedge   *float64 `json:"mark_hedge,omitempty"`
	MarkAt      *int64   `json:"mark_at,omitempty"`
	PNL         *float64 `json:"pnl,omitempty"`
	PeakPNL     *float64 `json:"peak_pnl,omitempty"`
	PeakAt      *int64   `json:"peak_at,omitempty"`
	MarkStale   bool     `json:"mark_stale"`
}

func (t *Trade) updatePeak(pnl float64, at int64) {
	if t.PeakPNL == nil || pnl > *t.PeakPNL {
		t.PeakPNL, t.PeakAt = &pnl, &at
	}
}

type IndexView struct {
	Symbol         string  `json:"symbol"`
	Expiry         string  `json:"expiry"`
	Pairs          int     `json:"pairs"`
	LotSize        int     `json:"lot_size"`
	Current        *Sample `json:"current"`
	Signal         *Signal `json:"signal"`
	Note           string  `json:"note"`
	RecordingSince *int64  `json:"recording_since"`
}

type Snapshot struct {
	Mode          string      `json:"mode"`
	Day           string      `json:"day"`
	Active        bool        `json:"active"`
	Connected     bool        `json:"connected"`
	Database      bool        `json:"database"`
	PaperEnabled  bool        `json:"paper_enabled"`
	WantedTokens  int         `json:"wanted_tokens"`
	WindowMinutes int         `json:"window_minutes"`
	MovePct       float64     `json:"move_pct"`
	HedgeSteps    int         `json:"hedge_steps"`
	VWAPMethod    string      `json:"vwap_method"`
	Indexes       []IndexView `json:"indexes"`
	Open          []Trade     `json:"open"`
	Closed        []Trade     `json:"closed"`
	Error         string      `json:"error"`
}

func finite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }
func dayKey(at int64) string    { return time.UnixMilli(at).In(ist).Format("2006-01-02") }
func bucketEnd(at int64, minutes int64) int64 {
	step := minutes * 60_000
	offset := int64(330 * 60_000)
	return ((at+offset+step-1)/step)*step - offset
}
func marketOpen(at int64) bool {
	local := time.UnixMilli(at).In(ist)
	minutes := local.Hour()*60 + local.Minute()
	return local.Weekday() != time.Saturday && local.Weekday() != time.Sunday && minutes >= 9*60+15 && minutes < 15*60+31
}

// Directions describe same-side credit spreads.
const (
	CallCredit = "CALL_CREDIT" // underlying rose since arming
	PutCredit  = "PUT_CREDIT"  // underlying fell since arming
)

type armedState struct {
	ArmedAt   int64
	Reference Sample
	Baseline  spotSample // pinned at arming, even if the arm outlives history retention
}

// armReference finds an earlier +5% reference. The engine supplies priceWindow's
// rolling extrema before adding current, so its low is sufficient.
func armReference(current Sample, references []Sample) (Sample, bool) {
	if current.T <= 0 || current.Premium <= 0 || !finite(current.Premium) {
		return Sample{}, false
	}
	var low Sample
	for _, sample := range references {
		if sample.T <= 0 || sample.T >= current.T || current.T-sample.T > WindowMs || sample.Premium <= 0 || !finite(sample.Premium) {
			continue
		}
		if low.T == 0 || sample.Premium < low.Premium {
			low = sample
		}
	}
	return low, low.T > 0 && (current.Premium/low.Premium-1)*100+1e-9 >= MinimumMovePct
}

func downwardVWAPCross(previous, current Sample) bool {
	return previous.T > 0 && current.T >= previous.T && current.T-previous.T <= quoteAgeMs &&
		finite(previous.Premium) && finite(previous.VWAP) && finite(current.Premium) && finite(current.VWAP) &&
		previous.Premium > 0 && current.Premium > 0 && previous.VWAP > 0 && current.VWAP > 0 &&
		previous.Premium >= previous.VWAP && current.Premium < current.VWAP && current.Premium < previous.Premium
}

// advanceArmed arms independently of a cross. Once armed, a pullback may fall
// below +5% until the reference ages out. A surviving +5% reference refreshes
// Reference, never ArmedAt. Every trigger consumes the arm, including skips.
// Newly armed samples start waiting for the next sample's downward cross.
func advanceArmed(state *armedState, previous, current Sample, references []Sample) (*armedState, *armedState) {
	reference, qualifies := armReference(current, references)
	if state == nil {
		if qualifies {
			return &armedState{ArmedAt: current.T, Reference: reference}, nil
		}
		return nil, nil
	}
	if current.T-state.Reference.T > WindowMs {
		if !qualifies {
			return nil, nil
		}
		refreshed := *state
		refreshed.Reference = reference
		state = &refreshed
	}
	if downwardVWAPCross(previous, current) {
		return nil, state
	}
	return state, nil
}

func grossPNL(trade Trade, shortAsk, hedgeBid float64) float64 {
	return float64(trade.Quantity) * (trade.Short.Entry - shortAsk + hedgeBid - trade.Hedge.Entry)
}
