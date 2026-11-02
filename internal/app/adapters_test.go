package app

import (
	"context"
	"regexp"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/dhan"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/registry"
	fvjson "github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// Fair Value received the instrument provider's own row objects in Node, so its input
// snapshot (and the snapshot id hashed from it) carried each row exactly as the
// provider held it: the twelve Kite fields, plus dhan_* for a Dhan row.
func TestFairValueInstrumentRowsSerialiseLikeTheProviderRows(t *testing.T) {
	kiteRow := market.Instrument{InstrumentToken: 13238786, ExchangeToken: 51714, Tradingsymbol: "NIFTY26NOVFUT", Name: "NIFTY",
		Expiry: "2026-11-24", TickSize: 0.1, LotSize: 75, InstrumentType: "FUT", Segment: "NFO-FUT", Exchange: "NFO"}
	under := int64(13)
	dhanRow := market.Instrument{InstrumentToken: 2000035012, ExchangeToken: 35012, Tradingsymbol: "NIFTY26NOV24500CE", Name: "NIFTY",
		Expiry: "2026-11-24", Strike: 24500, TickSize: 0.05, LotSize: 75, InstrumentType: "CE", Segment: "NFO-OPT", Exchange: "NFO"}
	for _, w := range []registry.WireInstrument{
		{Instrument: kiteRow},
		{Instrument: dhanRow, Dhan: &dhan.Instrument{Instrument: dhanRow, DhanSecurityID: 35012, DhanSegment: dhan.SegmentNSEFNO, DhanUnderlyingSecurityID: &under}},
	} {
		got, want := string(fvjson.Marshal(fairValueInstrument(w))), string(fvjson.Marshal(w))
		if got != want {
			t.Errorf("Fair Value row\n got %s\nwant %s", got, want)
		}
	}
	if s := string(fvjson.Marshal(fairValueInstrument(registry.WireInstrument{Instrument: kiteRow}))); s !=
		`{"instrument_token":13238786,"exchange_token":51714,"tradingsymbol":"NIFTY26NOVFUT","name":"NIFTY","last_price":0,"expiry":"2026-11-24","strike":0,"tick_size":0.1,"lot_size":75,"instrument_type":"FUT","segment":"NFO-FUT","exchange":"NFO"}` {
		t.Errorf("Kite row %s", s)
	}
}

func TestFairValueAdaptersOverTheRegistry(t *testing.T) {
	h := newHarness(t, harnessOptions{})
	ctx := context.Background()
	if v := h.app.metadataVersion(); v != "zerodha:unloaded" {
		t.Errorf("metadata version before a load %q", v)
	}
	first, err := h.app.fvRows.load(ctx)
	if err != nil || len(first) != 4 {
		t.Fatalf("load: %d rows, %v", len(first), err)
	}
	again, err := h.app.fvRows.load(ctx)
	if err != nil || &again[0] != &first[0] {
		t.Errorf("an unchanged universe was converted again (%v)", err)
	}
	if !regexp.MustCompile(`^zerodha:\d{13}$`).MatchString(h.app.metadataVersion()) {
		t.Errorf("metadata version after a load %q", h.app.metadataVersion())
	}
	board, err := h.app.fairValueBoard(ctx)
	if err != nil {
		t.Fatal(err)
	}
	synth, err := h.app.synthBoard(ctx)
	if err != nil || len(synth) != len(board) {
		t.Fatalf("boards: %d / %d (%v)", len(synth), len(board), err)
	}
	for i, b := range board {
		if b.Symbol != synth[i].Symbol || b.Name != synth[i].Name || b.IsIndex != synth[i].IsIndex {
			t.Errorf("row %d: %+v vs %+v", i, b, synth[i])
		}
	}
	if len(board) == 0 || board[0].Symbol != "NIFTY" || !board[0].IsIndex || board[0].SpotToken != 256265 {
		t.Errorf("Fair Value board %+v", board)
	}
}
