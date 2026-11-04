// Package market holds the broker-neutral data types and provider contracts shared by
// the market-data features (Kite, Dhan, the ticker hub, Synthetic, Fair Value,
// analytics). It has no behaviour of its own.
package market

import (
	"context"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
)

// Instrument is one row of the instrument master (kite.ts Instrument). Dhan rows are
// normalised into the same shape with internal tokens.
type Instrument struct {
	InstrumentToken int64   `json:"instrument_token"`
	ExchangeToken   int64   `json:"exchange_token"`
	Tradingsymbol   string  `json:"tradingsymbol"`
	Name            string  `json:"name"`
	LastPrice       float64 `json:"last_price"`
	Expiry          string  `json:"expiry"` // YYYY-MM-DD, "" when none
	Strike          float64 `json:"strike"`
	TickSize        float64 `json:"tick_size"`
	LotSize         float64 `json:"lot_size"`
	InstrumentType  string  `json:"instrument_type"`
	Segment         string  `json:"segment"`
	Exchange        string  `json:"exchange"`
}

// DepthLevel is one order-book level.
type DepthLevel struct {
	Price  float64 `json:"price"`
	Qty    float64 `json:"qty"`
	Orders float64 `json:"orders"`
}

// Tick is one normalised market-data update (ticker.ts Tick).
type Tick struct {
	Token      int64        `json:"token"`
	LastPrice  float64      `json:"last_price"`
	ClosePrice float64      `json:"close_price"`
	OI         float64      `json:"oi"`  // open interest (F&O only; 0 for spot/index)
	Bid        float64      `json:"bid"` // best bid (0 if unavailable)
	Ask        float64      `json:"ask"` // best ask (0 if unavailable)
	Bids       []DepthLevel `json:"bids,omitempty"`
	Asks       []DepthLevel `json:"asks,omitempty"`
	// DepthUpdated is true only when this wire packet carried an authoritative depth
	// snapshot; nil when the producer did not say.
	DepthUpdated *bool `json:"depth_updated,omitempty"`
	// ExchangeTS is the exchange timestamp in epoch ms (one-second resolution on Kite);
	// nil when the packet carried none.
	ExchangeTS *int64 `json:"exchange_ts,omitempty"`
	// Broker-native metadata for headless strategies; legacy browser tick JSON
	// stays unchanged. Dhan average traded price is that contract's day VWAP.
	AveragePrice   *float64           `json:"-"`
	PriceUpdated   *bool              `json:"-"`
	AverageUpdated *bool              `json:"-"`
	Namespace      *brokers.Namespace `json:"-"`
}

// RestQuote is the minimal REST quote the strategies use.
type RestQuote struct {
	InstrumentToken int64   `json:"instrument_token"`
	LastPrice       float64 `json:"last_price"`
	LastTradeTime   string  `json:"last_trade_time"`
}

// MarketDataProvider is the ACTIVE broker's REST market data.
type MarketDataProvider interface {
	IsAuthenticated() bool
	// GetQuoteFull takes "EXCHANGE:TRADINGSYMBOL" identifiers.
	GetQuoteFull(ctx context.Context, identifiers []string) ([]RestQuote, error)
}

// MarginOrder is one order line for a basket-margin request.
type MarginOrder struct {
	Exchange        string   `json:"exchange"`
	Tradingsymbol   string   `json:"tradingsymbol"`
	TransactionType string   `json:"transaction_type"` // BUY | SELL
	Variety         string   `json:"variety"`
	Product         string   `json:"product"`
	OrderType       string   `json:"order_type"`
	Quantity        float64  `json:"quantity"`
	Price           float64  `json:"price"`
	ReferencePrice  *float64 `json:"reference_price,omitempty"`
}

// MarginSource says which calculation produced a margin figure.
type MarginSource string

const (
	MarginKiteBasket         MarginSource = "kite_basket"
	MarginDhanMulti          MarginSource = "dhan_multi"
	MarginDhanPerLegFallback MarginSource = "dhan_per_leg_fallback"
	MarginUnavailable        MarginSource = "unavailable"
)

// BasketMargin is a margin result.
type BasketMargin struct {
	Initial      float64      `json:"initial"`
	Final        float64      `json:"final"`
	Total        float64      `json:"total"`
	Source       MarginSource `json:"source"`
	HedgeBenefit *float64     `json:"hedge_benefit,omitempty"`
	Span         *float64     `json:"span,omitempty"`
	Exposure     *float64     `json:"exposure,omitempty"`
}

// MarginProvider is the ACTIVE broker's basket-margin calculator.
type MarginProvider interface {
	Broker() brokers.ID
	BasketMargin(ctx context.Context, orders []MarginOrder, considerPositions bool) (BasketMargin, error)
}
