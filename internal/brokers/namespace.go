package brokers

import "context"

// Namespace identifies one active broker/token generation. Background readers
// carry it so a switch cannot send an old broker's tokens to the new provider.
type Namespace struct {
	Broker     ID
	Generation int64
}

type namespaceKey struct{}

func WithNamespace(ctx context.Context, namespace Namespace) context.Context {
	return context.WithValue(ctx, namespaceKey{}, namespace)
}

func NamespaceFromContext(ctx context.Context) (Namespace, bool) {
	namespace, ok := ctx.Value(namespaceKey{}).(Namespace)
	return namespace, ok
}
