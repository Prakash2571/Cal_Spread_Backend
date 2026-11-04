package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/dhan"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/spike"
)

func (f *fixture) initSpike() {
	f.spikeAt.Store(spikeFixtureTime(time.Now()).UnixMilli())
}

func spikeFixtureTime(at time.Time) time.Time {
	ist := time.FixedZone("IST", 330*60)
	now := at.In(ist)
	// Exercise actual market-hours rules even when CI runs on a weekend.
	for now.Weekday() == time.Saturday || now.Weekday() == time.Sunday {
		now = now.AddDate(0, 0, -1)
	}
	return time.Date(now.Year(), now.Month(), now.Day(), 14, 5, 10, 0, ist)
}

func (f *fixture) spikeMaster() string {
	day := time.UnixMilli(f.spikeAt.Load()).In(time.FixedZone("IST", 330*60))
	expiry := day.AddDate(0, 0, 7).Format("2006-01-02")
	result := "EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,UNDERLYING_SYMBOL,UNDERLYING_SECURITY_ID,LOT_SIZE,TICK_SIZE,EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE\n" +
		"NSE,I,13,INDEX,NIFTY,,,1,0.05,,,\nBSE,I,51,INDEX,SENSEX,,,1,0.05,,,\n"
	for index, name := range []string{"NIFTY", "SENSEX"} {
		center, spacing, lot, exchange, underlying := 23850, 50, 75, "NSE", 13
		if index == 1 {
			center, spacing, lot, exchange, underlying = 80000, 100, 20, "BSE", 51
		}
		for offset := -5; offset <= 5; offset++ {
			for side, kind := range []string{"CE", "PE"} {
				id := 50000 + index*1000 + (offset+5)*2 + side
				result += fmt.Sprintf("%s,D,%d,OPTIDX,%s%s%d%s,%s,%d,%d,0.05,%s,%d,%s\n",
					exchange, id, name, day.AddDate(0, 0, 7).Format("060102"), center+offset*spacing, kind,
					name, underlying, lot, expiry, center+offset*spacing, kind)
			}
		}
	}
	return result
}

func (f *fixture) spikeQuote(id int64) (float64, float64) {
	index, slot := (id-50000)/1000, int((id-50000)%1000)
	price, average := 100.0, 100.0
	stage := int(f.spikeStage.Load())
	if stage > 3 {
		stage = 3
	}
	if index == 0 {
		if slot == 10 {
			price, average = []float64{60, 64, 66, 63.5}[stage], 55
		} else if slot == 11 {
			price, average = 40, 50
		} else if slot == 18 {
			price = 20
			if stage == 3 {
				price = 18.5
			}
		}
	} else {
		if slot == 10 {
			price, average = 60, 55
		} else if slot == 11 {
			price, average = []float64{60, 52, 49, 49}[stage], 55
		} else if slot == 3 {
			price = 15
		}
	}
	return price, average
}

func (f *fixture) spikeFeed(w http.ResponseWriter, r *http.Request) {
	conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	var mu sync.Mutex
	wanted := map[string]map[int64]bool{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var request struct {
				RequestCode    int
				InstrumentList []struct{ ExchangeSegment, SecurityId string }
			}
			if json.Unmarshal(raw, &request) != nil {
				continue
			}
			mu.Lock()
			for _, instrument := range request.InstrumentList {
				if wanted[instrument.ExchangeSegment] == nil {
					wanted[instrument.ExchangeSegment] = map[int64]bool{}
				}
				id, _ := strconv.ParseInt(instrument.SecurityId, 10, 64)
				if request.RequestCode == 22 {
					delete(wanted[instrument.ExchangeSegment], id)
				} else {
					wanted[instrument.ExchangeSegment][id] = true
				}
			}
			mu.Unlock()
		}
	}()
	timer := time.NewTicker(250 * time.Millisecond)
	defer timer.Stop()
	for {
		select {
		case <-done:
			return
		case <-timer.C:
			var frame []byte
			mu.Lock()
			for segment, ids := range wanted {
				for id := range ids {
					price, average := f.spikeQuote(id)
					packet := make([]byte, 162)
					packet[0], packet[3] = 8, byte(dhan.CodeBySegment[dhan.Segment(segment)])
					binary.LittleEndian.PutUint16(packet[1:], 162)
					binary.LittleEndian.PutUint32(packet[4:], uint32(id))
					binary.LittleEndian.PutUint32(packet[8:], math.Float32bits(float32(price)))
					binary.LittleEndian.PutUint32(packet[14:], uint32(time.Now().Unix()))
					binary.LittleEndian.PutUint32(packet[18:], math.Float32bits(float32(average)))
					binary.LittleEndian.PutUint32(packet[22:], 10000)
					binary.LittleEndian.PutUint32(packet[34:], 10000)
					binary.LittleEndian.PutUint32(packet[62:], 1000)
					binary.LittleEndian.PutUint32(packet[66:], 1000)
					binary.LittleEndian.PutUint32(packet[74:], math.Float32bits(float32(price-.5)))
					binary.LittleEndian.PutUint32(packet[78:], math.Float32bits(float32(price+.5)))
					frame = append(frame, packet...)
				}
			}
			mu.Unlock()
			if len(frame) > 0 {
				_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
				if conn.WriteMessage(websocket.BinaryMessage, frame) != nil {
					return
				}
			}
		}
	}
}

func (f *fixture) seedSpike(pool *db.Pool) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	store := &spike.Store{Pool: pool}
	ist := time.FixedZone("IST", 330*60)
	now := time.UnixMilli(f.spikeAt.Load()).In(ist)
	start := time.Date(now.Year(), now.Month(), now.Day(), 9, 16, 0, 0, ist)
	var bars []spike.Bar
	for _, name := range []string{"NIFTY", "SENSEX"} {
		price, average, strike := 90.0, 105.0, 23850.0
		if name == "SENSEX" {
			price, average, strike = 120, 110, 80000
		}
		for at := start; at.Before(now.Add(-time.Minute)); at = at.Add(time.Minute) {
			bars = append(bars, spike.Bar{Sample: spike.Sample{T: at.UnixMilli(), Premium: price, VWAP: average,
				Strike: strike, Expiry: now.AddDate(0, 0, 7).Format("2006-01-02")}, Symbol: name,
				Day: now.Format("2006-01-02"), Low: price, High: price, LowAt: at.Add(-time.Second).UnixMilli(), HighAt: at.Add(-time.Second).UnixMilli()})
		}
	}
	return store.SaveBars(ctx, bars)
}

func (f *fixture) spikeMarketQuote(w http.ResponseWriter, r *http.Request) {
	var request map[string][]int64
	_ = json.NewDecoder(r.Body).Decode(&request)
	data := map[string]map[string]any{}
	for segment, ids := range request {
		book := map[string]any{}
		for _, id := range ids {
			price, average := f.spikeQuote(id)
			if segment == "IDX_I" {
				price, average = 23850, 23850
			}
			book[fmt.Sprint(id)] = map[string]any{"last_price": price, "average_price": average, "oi": 10000,
				"last_trade_time": time.Now().In(time.FixedZone("IST", 330*60)).Format("02/01/2006 15:04:05")}
		}
		data[segment] = book
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": data})
}

func spikeFeedURL(origin string) string {
	return "ws" + strings.TrimPrefix(origin, "http") + "/spike-feed"
}
