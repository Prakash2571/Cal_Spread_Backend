package livestream

import (
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// wireTick retains market.Tick's public JSON names and adds explicit nullable
// availability fields. The hub currently strips Volume and has no symbol metadata.
type wireTick struct {
	Token         int64               `json:"token"`
	LastPrice     float64             `json:"last_price"`
	ClosePrice    float64             `json:"close_price"`
	OI            float64             `json:"oi"`
	Bid           float64             `json:"bid"`
	Ask           float64             `json:"ask"`
	Bids          []market.DepthLevel `json:"bids"`
	Asks          []market.DepthLevel `json:"asks"`
	DepthUpdated  *bool               `json:"depth_updated"`
	ExchangeTS    *int64              `json:"exchange_ts"`
	ReceivedAt    int64               `json:"received_at"`
	Volume        *float64            `json:"volume"`
	Tradingsymbol *string             `json:"tradingsymbol"`
	Name          *string             `json:"name"`
}

// copyBatch owns every value a writer reads after the hub callback returns.
// No hub tick, ladder, pointer value or cache is modified by the relay.
func copyBatch(ticks []market.Tick, receivedAt int64) batch {
	b := batch{ticks: make([]market.Tick, len(ticks)), receivedAt: receivedAt}
	for i, t := range ticks {
		b.ticks[i] = market.Tick{
			Token: t.Token, LastPrice: t.LastPrice, ClosePrice: t.ClosePrice,
			OI: t.OI, Bid: t.Bid, Ask: t.Ask,
			Bids: append([]market.DepthLevel{}, t.Bids...),
			Asks: append([]market.DepthLevel{}, t.Asks...),
		}
		if t.DepthUpdated != nil {
			v := *t.DepthUpdated
			b.ticks[i].DepthUpdated = &v
		}
		if t.ExchangeTS != nil {
			v := *t.ExchangeTS
			b.ticks[i].ExchangeTS = &v
		}
		if t.Volume != nil {
			v := *t.Volume
			b.ticks[i].Volume = &v
		}
	}
	return b
}

func encodeBatch(b batch) []byte {
	rows := make([]wireTick, len(b.ticks))
	for i, t := range b.ticks {
		rows[i] = wireTick{
			Token: t.Token, LastPrice: t.LastPrice, ClosePrice: t.ClosePrice,
			OI: t.OI, Bid: t.Bid, Ask: t.Ask, Bids: t.Bids, Asks: t.Asks,
			DepthUpdated: t.DepthUpdated, ExchangeTS: t.ExchangeTS,
			ReceivedAt: b.receivedAt, Volume: t.Volume,
		}
	}
	// Match the surrounding service's JSON conventions, including non-finite → null.
	return jsjson.Marshal(rows)
}
