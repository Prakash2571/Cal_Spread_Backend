package calendar

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/dbtest"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
)

func sampleCharges(source string, at time.Time) *TradeCharges {
	legs := []LegCharges{
		{Side: "BUY", Tradingsymbol: "ABC26OCTFUT", Quantity: 500, Price: 1010.45, Value: 505225, Brokerage: 20,
			SttType: "stt", ExchangeTxn: 8.74, Sebi: 0.51, StampDuty: 10.1, Gst: 5.26, Total: 44.61},
		{Side: "SELL", Tradingsymbol: "ABC26NOVFUT", Quantity: 500, Price: 1025.05, Value: 512525, Brokerage: 20,
			Stt: 102.51, SttType: "stt", ExchangeTxn: 8.87, Sebi: 0.51, Gst: 5.29, Total: 137.18},
	}
	return aggregateCharges(legs, source, at)
}

func sampleTrade(id string, openedAt time.Time) *Trade {
	return &Trade{
		ID: id, Symbol: "ABC", Name: "ABC LTD", LotSize: 500,
		Buy:      Leg{Token: 12001, Expiry: "2026-10-29", Entry: 1010.45},
		Sell:     Leg{Token: 12002, Expiry: "2026-11-26", Entry: 1025.05},
		Status:   "open",
		OpenedAt: openedAt, Margin: f64(98766),
		EntryCharges: sampleCharges("kite", openedAt), EstExitCharges: sampleCharges("kite_estimate", openedAt),
		EntryValue: f64(1017750),
	}
}

var t0 = time.Date(2026, 10, 28, 4, 30, 0, 123_000_000, time.UTC)

func TestStoreRoundTripKeepsEveryField(t *testing.T) {
	pool := dbtest.New(t)
	st := &store{pool: pool}
	ctx := context.Background()
	tr := sampleTrade(db.NewIDAt(t0), t0.Add(456*time.Microsecond)) // sub-ms precision is dropped, as BSON did
	tr.IsIndex = true
	tr.ClosePnl = f64(math.Inf(1)) // non-finite numbers survive the double precision columns
	if err := st.insert(ctx, tr); err != nil {
		t.Fatal(err)
	}
	got, err := st.get(ctx, tr.ID)
	if err != nil || got == nil {
		t.Fatalf("get: %v %v", got, err)
	}
	tr.OpenedAt = t0
	if a, b := marshal(serializeTrade(got)), marshal(serializeTrade(tr)); a != b {
		t.Fatalf("round trip:\n got %s\nwant %s", a, b)
	}
	if !math.IsInf(*got.ClosePnl, 1) {
		t.Fatalf("close_pnl %v", *got.ClosePnl)
	}
	if missing, err := st.get(ctx, db.NewIDAt(t0)); err != nil || missing != nil {
		t.Fatalf("unknown id: %v %v", missing, err)
	}
}

func TestStoreChargesAreStoredAsWrittenText(t *testing.T) {
	pool := dbtest.New(t)
	st := &store{pool: pool}
	ctx := context.Background()
	tr := sampleTrade(db.NewIDAt(t0), t0)
	if err := st.insert(ctx, tr); err != nil {
		t.Fatal(err)
	}
	var text string
	if err := pool.QueryRow(ctx, `select entry_charges::text from trades where id = $1`, tr.ID).Scan(&text); err != nil {
		t.Fatal(err)
	}
	// json (not jsonb): the exact bytes, so the key order the API sends is kept.
	if want := string(jsjson.Marshal(tr.EntryCharges)); text != want {
		t.Fatalf("stored charges text\n got %s\nwant %s", text, want)
	}
	if !strings.HasPrefix(text, `{"legs":[{"side":"BUY","tradingsymbol":`) {
		t.Fatalf("key order lost: %s", text)
	}
}

func TestStoreListNewestFirstLimit200(t *testing.T) {
	pool := dbtest.New(t)
	st := &store{pool: pool}
	ctx := context.Background()
	var ids []string
	for i := 0; i < 205; i++ {
		at := t0.Add(time.Duration(i) * time.Second)
		if i >= 200 {
			at = t0.Add(199 * time.Second) // ties on opened_at: the later id (the newer trade) comes first
		}
		id := fmt.Sprintf("65a1%020x", i+1)
		ids = append(ids, id)
		if err := st.insert(ctx, sampleTrade(id, at)); err != nil {
			t.Fatal(err)
		}
	}
	list, err := st.list(ctx, 200)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 200 {
		t.Fatalf("%d rows", len(list))
	}
	want := []string{ids[204], ids[203], ids[202], ids[201], ids[200], ids[199], ids[198]}
	for i, w := range want {
		if list[i].ID != w {
			t.Fatalf("row %d = %s, want %s", i, list[i].ID, w)
		}
	}
	if last := list[199].ID; last != ids[5] {
		t.Fatalf("last row %s, want %s", last, ids[5])
	}
}

func TestStoreHasOpenAndClose(t *testing.T) {
	pool := dbtest.New(t)
	st := &store{pool: pool}
	ctx := context.Background()
	tr := sampleTrade(db.NewIDAt(t0), t0)
	if err := st.insert(ctx, tr); err != nil {
		t.Fatal(err)
	}
	for sym, want := range map[string]bool{"ABC": true, "abc": false, "XYZ": false} {
		if got, err := st.hasOpen(ctx, sym); err != nil || got != want {
			t.Fatalf("hasOpen(%s) = %v %v", sym, got, err)
		}
	}

	closed := t0.Add(time.Hour)
	tr.Status, tr.ClosedAt = "closed", &closed
	tr.ClosePnl, tr.BuyClose, tr.SellClose = f64(325), f64(1012.25), f64(1026.2)
	tr.ExitCharges = sampleCharges("kite", closed)
	tr.ExitValue, tr.TotalCharges, tr.NetPnl = f64(1019225), f64(362.5), f64(-37.5)
	// Not flagged: entry_charges / entry_value must not be written.
	tr.EntryCharges, tr.EntryValue = nil, nil
	if err := st.saveClose(ctx, tr, false, false); err != nil {
		t.Fatal(err)
	}
	got, err := st.get(ctx, tr.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "closed" || *got.ClosePnl != 325 || *got.NetPnl != -37.5 || got.ClosedAt == nil || !got.ClosedAt.Equal(closed) {
		t.Fatalf("closed row %+v", got)
	}
	if got.EntryCharges == nil || got.EntryValue == nil || *got.EntryValue != 1017750 {
		t.Fatalf("unflagged entry fields were overwritten: %v %v", got.EntryCharges, got.EntryValue)
	}
	if open, _ := st.hasOpen(ctx, "ABC"); open {
		t.Fatal("still open")
	}

	// Flagged: both are written (the legacy backfill).
	tr.EntryCharges, tr.EntryValue = sampleCharges("kite_estimate", closed), f64(1)
	if err := st.saveClose(ctx, tr, true, true); err != nil {
		t.Fatal(err)
	}
	got, _ = st.get(ctx, tr.ID)
	if got.EntryCharges.Source != "kite_estimate" || *got.EntryValue != 1 {
		t.Fatalf("flagged entry fields not written: %v %v", got.EntryCharges.Source, *got.EntryValue)
	}

	// A trade deleted between the read and the write fails like Mongoose's save().
	if err := st.remove(ctx, tr.ID); err != nil {
		t.Fatal(err)
	}
	err = st.saveClose(ctx, tr, false, false)
	want := `No document found for query "{ _id: new ObjectId('` + tr.ID + `') }" on model "Trade"`
	if err == nil || err.Error() != want {
		t.Fatalf("saveClose after delete: %v", err)
	}
}

func TestStoreLedgerAppendOnlySurvivesDelete(t *testing.T) {
	pool := dbtest.New(t)
	st := &store{pool: pool}
	ctx := context.Background()
	tr := sampleTrade(db.NewIDAt(t0), t0)
	if err := st.insert(ctx, tr); err != nil {
		t.Fatal(err)
	}
	raw := json.RawMessage(`{"z":1,"a":{"y":2,"b":0.30000000000000004},"m":[1e21,null]}`)
	e := LedgerEntry{
		TradeID: tr.ID, Symbol: "ABC", Name: "ABC LTD", LotSize: 500, Event: "entry", At: JSTime(t0),
		Legs:  []LogLeg{logLegOf(tr.EntryCharges.Legs[0], ChargeLeg{Token: 12001, Exchange: "NFO", Expiry: "2026-10-29"}, raw)},
		Value: 1017750, Charges: chargeTotals(tr.EntryCharges), Source: "kite", Margin: f64(98766),
	}
	if err := st.appendLog(ctx, db.NewIDAt(t0), &e); err != nil {
		t.Fatal(err)
	}
	if err := st.remove(ctx, tr.ID); err != nil {
		t.Fatal(err)
	}
	rows := readLedger(t, pool)
	if len(rows) != 1 {
		t.Fatalf("%d ledger rows after deleting the trade", len(rows))
	}
	want := `{"trade_id":"` + tr.ID + `","symbol":"ABC","name":"ABC LTD","is_index":false,"lot_size":500,"event":"entry",` +
		`"at":"2026-10-28T04:30:00.123Z","legs":[{"side":"BUY","token":12001,"tradingsymbol":"ABC26OCTFUT","exchange":"NFO",` +
		`"expiry":"2026-10-29","quantity":500,"price":1010.45,"value":505225,"brokerage":20,"stt":0,"stt_type":"stt",` +
		`"exchange_txn":8.74,"sebi":0.51,"stamp_duty":10.1,"gst":5.26,"total":44.61,` +
		`"raw":{"z":1,"a":{"y":2,"b":0.30000000000000004},"m":[1e+21,null]}}],"value":1017750,` +
		`"charges":{"brokerage":40,"stt":102.51,"exchange_txn":17.61,"sebi":1.02,"stamp_duty":10.1,"gst":10.55,"total":181.79},` +
		`"source":"kite","margin":98766,"gross_pnl":null,"total_charges":null,"net_pnl":null}`
	if rows[0] != want {
		t.Fatalf("ledger row\n got %s\nwant %s", rows[0], want)
	}
	if got, _ := st.get(ctx, tr.ID); got != nil {
		t.Fatal("trade not deleted")
	}
}

func TestDecodeChargesDefaultsAndNulls(t *testing.T) {
	c, err := decodeCharges([]byte(`{"legs":[{"side":"SELL","total":1.5}],"total":null,"at":"2026-10-28T04:30:00.000Z"}`))
	if err != nil {
		t.Fatal(err)
	}
	got := marshal(c)
	want := `{"legs":[{"side":"SELL","tradingsymbol":"","quantity":0,"price":0,"value":0,"brokerage":0,"stt":0,"stt_type":"",` +
		`"exchange_txn":0,"sebi":0,"stamp_duty":0,"gst":0,"total":1.5}],"value":0,"brokerage":0,"stt":0,"exchange_txn":0,` +
		`"sebi":0,"stamp_duty":0,"gst":0,"total":null,"source":"kite","at":"2026-10-28T04:30:00.000Z"}`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
	if !math.IsNaN(c.Total) {
		t.Fatalf("null total = %v, want NaN", c.Total)
	}
	for _, in := range []string{"", "null"} {
		var raw []byte
		if in != "" {
			raw = []byte(in)
		}
		if c, err := decodeCharges(raw); c != nil || err != nil {
			t.Fatalf("decodeCharges(%q) = %v %v", in, c, err)
		}
	}
	if _, err := decodeCharges([]byte(`{`)); err == nil {
		t.Fatal("broken JSON accepted")
	}
}

func TestStoreWithoutDatabase(t *testing.T) {
	st := &store{}
	ctx := context.Background()
	if st.enabled() {
		t.Fatal("enabled without a pool")
	}
	if _, err := st.hasOpen(ctx, "ABC"); err != errNoStorage {
		t.Fatal(err)
	}
	if err := st.insert(ctx, sampleTrade(db.NewID(), t0)); err != errNoStorage {
		t.Fatal(err)
	}
	if _, err := st.list(ctx, 200); err != errNoStorage {
		t.Fatal(err)
	}
	if err := st.appendLog(ctx, db.NewID(), &LedgerEntry{}); err != errNoStorage {
		t.Fatal(err)
	}
}
