package analytics

import (
	"context"
	"errors"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
)

var errNamespaceChanged = errors.New("analytics broker namespace changed")

type operationScope struct {
	namespace brokers.Namespace
	epoch     uint64
}

type operationKey struct{}

func (s *Service) currentNamespace() brokers.Namespace {
	if s.d.Namespace != nil {
		return s.d.Namespace()
	}
	return brokers.Namespace{Broker: brokers.Zerodha}
}

func (s *Service) resetNamespaceLocked(namespace brokers.Namespace) {
	if s.scopeCancel != nil {
		s.scopeCancel()
	}
	s.scope = operationScope{namespace: namespace, epoch: s.scope.epoch + 1}
	s.scopeCtx, s.scopeCancel = context.WithCancel(s.ctx)
	s.scopeWarm = s.d.Namespace == nil
	s.day, s.prevClose = nil, nil
	s.oiFrames = [frameCount][]*OiAggPoint{}
	s.futFrames = [frameCount][]*FutOiPoint{}
	s.futContracts = nil
	s.futKnown = newOmap[string, FutContract]()
	s.chainMin, s.chainHour = nil, nil
	s.partialRepairs, s.headRepairs = map[string]repairMark{}, map[string]repairMark{}
	s.prevCloseAttempts.day, s.prevCloseAttempts.n = "", 0
	s.closedDayLogged = ""
	s.oiBackfillRunning, s.futBackfillRunning, s.prevCloseBackfillRunning = false, false, false
	// Buffered writes already carry their broker key. Keep them so switching
	// cannot lose a closing bucket or relabel it as the incoming broker's data.
}

func (s *Service) syncNamespaceLocked() {
	namespace := s.currentNamespace()
	if s.scopeCtx == nil || s.scope.namespace != namespace {
		s.resetNamespaceLocked(namespace)
	}
}

func (s *Service) syncNamespace() {
	s.mu.Lock()
	s.syncNamespaceLocked()
	s.mu.Unlock()
}

// InvalidateNamespace cancels old readers before a broker switch publishes its
// new generation. Reads then adopt the new broker, without sharing token caches.
func (s *Service) InvalidateNamespace() {
	s.mu.Lock()
	s.resetNamespaceLocked(s.currentNamespace())
	s.mu.Unlock()
}

func (s *Service) scopeCurrentLocked(scope operationScope) bool {
	return scope == s.scope && s.scopeCtx.Err() == nil && s.currentNamespace() == scope.namespace
}

func (s *Service) beginOperation(parent context.Context) (context.Context, operationScope, func(), bool) {
	s.mu.Lock()
	s.syncNamespaceLocked()
	scope, lifetime := s.scope, s.scopeCtx
	valid := !s.stopped && parent.Err() == nil && lifetime.Err() == nil
	if expected, ok := brokers.NamespaceFromContext(parent); ok && expected != scope.namespace {
		valid = false
	}
	if expected, ok := parent.Value(operationKey{}).(operationScope); ok && expected != scope {
		valid = false
	}
	s.mu.Unlock()
	if !valid {
		return parent, scope, func() {}, false
	}
	ctx, cancel := context.WithCancel(parent)
	stop := context.AfterFunc(lifetime, cancel)
	ctx = brokers.WithNamespace(ctx, scope.namespace)
	ctx = context.WithValue(ctx, operationKey{}, scope)
	return ctx, scope, func() { stop(); cancel() }, true
}

func (s *Service) checkOperation(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if expected, ok := brokers.NamespaceFromContext(ctx); ok && expected != s.currentNamespace() {
		return errNamespaceChanged
	}
	if expected, ok := ctx.Value(operationKey{}).(operationScope); ok {
		s.mu.Lock()
		valid := s.scopeCurrentLocked(expected)
		s.mu.Unlock()
		if !valid {
			return errNamespaceChanged
		}
	}
	return nil
}

func analyticsCacheKey(namespace brokers.Namespace, key string) string {
	if namespace.Broker == brokers.Dhan {
		return "analytics:dhan:" + key
	}
	return key // retained Zerodha caches stay readable
}

func (s *Service) cacheKeyLocked(key string) string {
	return analyticsCacheKey(s.scope.namespace, key)
}

func (s *Service) cacheReadKey(ctx context.Context, key string) string {
	namespace, ok := brokers.NamespaceFromContext(ctx)
	if !ok {
		namespace = s.currentNamespace()
	}
	return analyticsCacheKey(namespace, key)
}

func (s *Service) historySource() string {
	if s.currentNamespace().Broker == brokers.Dhan {
		return "Dhan"
	}
	return "Kite"
}
