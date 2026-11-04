package spike

// Monotonic queues retain exact observed rolling extrema without scanning every
// WebSocket update. An equal, newer value supersedes an older equal reference.
type priceWindow struct {
	low  []Sample
	high []Sample
}

func (w *priceWindow) Add(sample Sample) {
	for len(w.low) > 0 && w.low[len(w.low)-1].Premium >= sample.Premium {
		w.low = w.low[:len(w.low)-1]
	}
	w.low = append(w.low, sample)
	for len(w.high) > 0 && w.high[len(w.high)-1].Premium <= sample.Premium {
		w.high = w.high[:len(w.high)-1]
	}
	w.high = append(w.high, sample)
	w.References(sample.T)
}

func (w *priceWindow) References(now int64) []Sample {
	for len(w.low) > 0 && now-w.low[0].T > WindowMs {
		w.low = w.low[1:]
	}
	for len(w.high) > 0 && now-w.high[0].T > WindowMs {
		w.high = w.high[1:]
	}
	result := make([]Sample, 0, 2)
	if len(w.low) > 0 {
		result = append(result, w.low[0])
	}
	if len(w.high) > 0 {
		result = append(result, w.high[0])
	}
	return result
}
