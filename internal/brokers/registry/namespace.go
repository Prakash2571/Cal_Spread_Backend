package registry

import (
	"context"
	"errors"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
)

var errNamespaceChanged = errors.New("broker token namespace changed; retry with the current broker")

// Namespace reads broker and generation from the same atomic state.
func (r *Registry) Namespace() brokers.Namespace {
	state := r.state.Load()
	return brokers.Namespace{Broker: state.active, Generation: state.gen}
}

func (r *Registry) namespaceFor(ctx context.Context) (brokers.Namespace, error) {
	if err := ctx.Err(); err != nil {
		return brokers.Namespace{}, err
	}
	current := r.Namespace()
	if expected, ok := brokers.NamespaceFromContext(ctx); ok && (expected != current || r.Switching()) {
		return brokers.Namespace{}, errNamespaceChanged
	}
	return current, nil
}
