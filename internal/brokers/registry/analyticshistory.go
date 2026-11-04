package registry

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/dhan"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
)

func parseDhanChartTime(value string) (time.Time, error) {
	if stamp, err := time.Parse(time.RFC3339, value); err == nil {
		return stamp, nil
	}
	for _, layout := range []string{"2006-01-02 15:04:05", "2006-01-02"} {
		if stamp, err := time.ParseInLocation(layout, value, tokenIST); err == nil {
			return stamp, nil
		}
	}
	return time.Time{}, fmt.Errorf("invalid Dhan chart time")
}

func (h *HistoryProvider) nativeDhanCandles(ctx context.Context, token int64, from, to, interval string) ([]kite.HistoricalCandle, error) {
	namespace, err := h.r.namespaceFor(ctx)
	if err != nil {
		return nil, err
	}
	ctx = brokers.WithNamespace(ctx, namespace)
	if _, err := h.r.dhanInstruments.Load(ctx, false); err != nil {
		return nil, err
	}
	inst, ok := h.r.dhanInstruments.Get(token)
	if !ok {
		return nil, fmt.Errorf("Dhan chart instrument is not in the active master")
	}
	class := inst.DhanInstrumentClass
	if class == "" {
		class = dhanInstrumentClass(inst)
	}
	if class == "ES" {
		class = "EQUITY"
	}
	derivative := strings.HasPrefix(class, "OPT") || strings.HasPrefix(class, "FUT")
	begin, err := parseDhanChartTime(from)
	if err != nil {
		return nil, err
	}
	end, err := parseDhanChartTime(to)
	if err != nil {
		return nil, err
	}
	minutes := dhanInterval(interval)
	var responses []dhan.Candles
	if minutes == "" {
		response, err := h.r.dhanClient.HistoricalCandles(ctx, dhan.HistoricalRequest{
			SecurityID: strconv.FormatInt(inst.DhanSecurityID, 10), ExchangeSegment: inst.DhanSegment,
			Instrument: class, OI: &derivative, FromDate: begin.In(tokenIST).Format("2006-01-02"), ToDate: end.In(tokenIST).Format("2006-01-02"),
		})
		if err != nil {
			return nil, err
		}
		responses = append(responses, response)
	} else {
		maxDays := dhanIntradayMaxDays[minutes]
		for _, chunk := range ChunkDateRange(float64(begin.UnixMilli()), float64(end.UnixMilli()), maxDays) {
			if _, err := h.r.namespaceFor(ctx); err != nil {
				return nil, err
			}
			response, err := h.r.dhanClient.IntradayCandles(ctx, dhan.IntradayRequest{
				SecurityID: strconv.FormatInt(inst.DhanSecurityID, 10), ExchangeSegment: inst.DhanSegment,
				Instrument: class, Interval: minutes, OI: &derivative,
				FromDate: time.UnixMilli(int64(chunk.From)).In(tokenIST).Format("2006-01-02 15:04:05"),
				ToDate:   time.UnixMilli(int64(chunk.To)).In(tokenIST).Format("2006-01-02 15:04:05"),
			})
			if err != nil {
				return nil, err
			}
			responses = append(responses, response)
		}
	}
	if _, err := h.r.namespaceFor(ctx); err != nil {
		return nil, err
	}
	out := []kite.HistoricalCandle{}
	seen := map[string]bool{}
	for _, response := range responses {
		if len(response.Close) != len(response.Timestamp) || (derivative && len(response.OpenInterest) != len(response.Timestamp)) {
			return nil, fmt.Errorf("Dhan history omitted required price/OI columns")
		}
		for i, stamp := range response.Timestamp {
			seconds, hasStamp := stamp.Num()
			close, hasClose := response.Close[i].Num()
			oi, hasOI := 0.0, !derivative
			if derivative {
				oi, hasOI = response.OpenInterest[i].Num()
			}
			if !hasStamp || !hasClose || !hasOI || !jsx.Finite(seconds) || seconds <= 0 || seconds > 253402300799 ||
				!jsx.Finite(close) || close < 0 || !jsx.Finite(oi) || oi < 0 {
				return nil, fmt.Errorf("Dhan history contains an unreadable price/OI candle")
			}
			date := time.UnixMilli(int64(seconds * 1000)).In(tokenIST).Format(time.RFC3339)
			if seen[date] {
				continue
			}
			seen[date] = true
			out = append(out, kite.HistoricalCandle{Date: date, Close: close, OI: oi,
				Open: numAt(response.Open, i), High: numAt(response.High, i), Low: numAt(response.Low, i), Volume: numAt(response.Volume, i)})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Date < out[j].Date })
	return out, nil
}
