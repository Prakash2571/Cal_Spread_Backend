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
	MarkStale   bool     `json:"mark_stale"`
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

// Qualify requires a price-driven crossover NOW, not a delayed confirmation or
// a crossover caused only by VWAP moving. References are earlier prices <=30m old.
func Qualify(previous, current Sample, history []Sample) (Signal, bool) {
	if previous.T <= 0 || current.T < previous.T || current.T-previous.T > quoteAgeMs ||
		previous.VWAP <= 0 || current.VWAP <= 0 || !finite(current.Premium) || !finite(current.VWAP) {
		return Signal{}, false
	}
	direction := ""
	if previous.Premium <= previous.VWAP && current.Premium > current.VWAP && current.Premium > previous.Premium {
		direction = "CALL_CREDIT"
	} else if previous.Premium >= previous.VWAP && current.Premium < current.VWAP && current.Premium < previous.Premium {
		direction = "PUT_CREDIT"
	}
	if direction == "" {
		return Signal{}, false
	}
	var reference *Sample
	for i := range history {
		sample := &history[i]
		if sample.T >= current.T || current.T-sample.T > WindowMs || sample.Premium <= 0 || !finite(sample.Premium) {
			continue
		}
		if reference == nil || (direction == "CALL_CREDIT" && sample.Premium < reference.Premium) ||
			(direction == "PUT_CREDIT" && sample.Premium > reference.Premium) {
			reference = sample
		}
	}
	if reference == nil {
		return Signal{}, false
	}
	move := (current.Premium/reference.Premium - 1) * 100
	if (direction == "CALL_CREDIT" && move+1e-9 < MinimumMovePct) || (direction == "PUT_CREDIT" && move-1e-9 > -MinimumMovePct) {
		return Signal{}, false
	}
	return Signal{Direction: direction, T: current.T, Reference: reference.Premium, ReferenceAt: reference.T,
		MovePct: move, Premium: current.Premium, VWAP: current.VWAP}, true
}

func grossPNL(trade Trade, shortAsk, hedgeBid float64) float64 {
	return float64(trade.Quantity) * (trade.Short.Entry - shortAsk + hedgeBid - trade.Hedge.Entry)
}
