package fairvalue

// orderedMap is a JavaScript Map: iteration in insertion order, and setting an existing
// key keeps its position.
type orderedMap[K comparable, V any] struct {
	keys []K
	vals map[K]V
}

func newOrderedMap[K comparable, V any]() *orderedMap[K, V] {
	return &orderedMap[K, V]{vals: map[K]V{}}
}

func (m *orderedMap[K, V]) Get(k K) (V, bool) { v, ok := m.vals[k]; return v, ok }

func (m *orderedMap[K, V]) Has(k K) bool { _, ok := m.vals[k]; return ok }

func (m *orderedMap[K, V]) Set(k K, v V) {
	if _, ok := m.vals[k]; !ok {
		m.keys = append(m.keys, k)
	}
	m.vals[k] = v
}

func (m *orderedMap[K, V]) Delete(k K) {
	if _, ok := m.vals[k]; !ok {
		return
	}
	delete(m.vals, k)
	for i, x := range m.keys {
		if x == k {
			m.keys = append(m.keys[:i:i], m.keys[i+1:]...)
			return
		}
	}
}

func (m *orderedMap[K, V]) Len() int { return len(m.keys) }

func (m *orderedMap[K, V]) Keys() []K { return append([]K(nil), m.keys...) }

func (m *orderedMap[K, V]) Values() []V {
	out := make([]V, len(m.keys))
	for i, k := range m.keys {
		out[i] = m.vals[k]
	}
	return out
}

func (m *orderedMap[K, V]) Clear() {
	m.keys = nil
	m.vals = map[K]V{}
}

// tokenSet is a JavaScript Set of tokens (insertion order).
type tokenSet = orderedMap[float64, struct{}]

func newTokenSet(tokens ...float64) *tokenSet {
	s := newOrderedMap[float64, struct{}]()
	for _, t := range tokens {
		s.Set(t, struct{}{})
	}
	return s
}
