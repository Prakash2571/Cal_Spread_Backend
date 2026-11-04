package registry

import (
	"context"
	"log"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/auth"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/dhan"
)

// SwitchBlockers is everything that would make a switch unsafe, all at once. With Box
// gone its exposure checks are always idle (no scanner, positions, working or unknown
// orders, in-flight work, residual legs or unresolved intents), so the one blocker left
// is switching to an unconfigured Dhan.
func (r *Registry) SwitchBlockers(target brokers.ID) []auth.Blocker {
	blockers := []auth.Blocker{}
	if target == brokers.Dhan {
		if _, ok, reason := r.DhanCredentials(); !ok {
			blockers = append(blockers, auth.Blocker{Reason: "broker_not_configured", Detail: reason})
		}
	}
	return blockers
}

// SwitchResult is the outcome of SwitchTo.
type SwitchResult struct {
	OK       bool
	Broker   brokers.ID
	Blockers []auth.Blocker
}

// SwitchTo switches the active broker, or refuses with the blockers. THE ORDER IS THE
// SAFETY PROPERTY: the old broker is torn down (scanner, both lanes, subscriptions,
// stream sessions, books) before the selection and generation move, and only then is the
// new broker's universe loaded and its feed started. actor is recorded as selected_by.
func (r *Registry) SwitchTo(ctx context.Context, target brokers.ID, actor string) SwitchResult {
	r.opMu.Lock()
	defer r.opMu.Unlock()
	ctx = context.WithoutCancel(ctx)

	st := r.state.Load()
	if target == st.active {
		// Idempotent: re-selecting the current broker is a no-op success.
		return SwitchResult{OK: true, Broker: st.active}
	}
	if blockers := r.SwitchBlockers(target); len(blockers) > 0 {
		return SwitchResult{Blockers: blockers}
	}

	previous := st.active
	hooks := r.getHooks()
	r.transitioning.Store(true)
	log.Printf("[Broker] switch %s -> %s requested by %s", previous, target, actor)
	func() {
		defer r.transitioning.Store(false)

		// 1. stop discovery on the outgoing broker
		if hooks.StopScanner != nil {
			hooks.StopScanner()
		}
		log.Printf("[Broker] scanner stopped")

		// 2 + 3. stop BOTH lanes of the outgoing broker
		r.stopAllLanes()
		log.Printf("[Broker] %s feeds stopped (futures + box lanes)", previous)

		// 4. drop every token registration in both lanes (no upstream unsubscribes: the
		//    tokens belong to the outgoing namespace), and every browser stream session
		ft, fl := r.subscriptions.ResetForBrokerSwitch()
		bt, bl := r.boxSubscriptions.ResetForBrokerSwitch()
		log.Printf("[Broker] %d futures + %d box subscription(s) cleared (%d lease(s))", ft, bt, fl+bl)
		if hooks.DropMarketDataSessions != nil {
			if n := hooks.DropMarketDataSessions(); n > 0 {
				log.Printf("[Broker] %d browser stream session(s) invalidated", n)
			}
		}

		// 5. invalidate every book and both instrument universes
		if previous == brokers.Dhan {
			r.dhanInstruments.Clear()
		}
		r.instruments.Invalidate("")
		r.lastTickAt.Store(noTick)
		if hooks.InvalidateBooks != nil {
			hooks.InvalidateBooks()
		}
		log.Printf("[Broker] quote generation %d invalidated", st.gen)

		// 6. THE SWITCH: advance the durable generation first, then adopt broker and
		//    generation together.
		sctx, cancel := storeCtx()
		persisted, ok, err := r.store.SaveActiveBroker(sctx, string(target), actor)
		cancel()
		if err != nil {
			log.Printf("[Broker] failed to persist the active broker: %v", err)
			ok = false
		}
		next := st.gen + 1
		if ok {
			next = max(st.gen+1, persisted)
		}
		r.state.Store(&brokerState{active: target, gen: next})
		log.Printf("[Broker] active=%s generation=%d", target, next)

		// 7. load the NEW broker's universe before anything can ask for a token in it
		if err := r.loadNewUniverse(ctx, target); err != nil {
			log.Printf("[Broker] switched to %s but the universe load failed: %v", target, err)
		}

		// 8. rebuild the consumers' instrument sets in the new namespace
		if hooks.ReloadUniverse != nil {
			if err := hooks.ReloadUniverse(ctx); err != nil {
				log.Printf("[Broker] universe rebuild after switch to %s failed: %v", target, err)
			}
		}

		// 9. start ONLY the new broker's feed
		r.StartActiveFeed()
		log.Printf("[Broker] %s feed started", target)
	}()

	// 10. publish fresh runtime state
	if hooks.OnRuntimeReady != nil {
		hooks.OnRuntimeReady()
	}
	if hooks.Publish != nil {
		hooks.Publish()
	}
	log.Printf("[Broker] active broker switched %s → %s by %s.", previous, target, actor)
	return SwitchResult{OK: true, Broker: target}
}

// loadNewUniverse is step 7: a failed Dhan master load skips the IP check and the
// provider load, as the single try block in Node did.
func (r *Registry) loadNewUniverse(ctx context.Context, target brokers.ID) error {
	if target == brokers.Dhan {
		if _, err := r.dhanInstruments.Load(ctx, true); err != nil {
			return err
		}
		r.VerifyDhanStaticIP(ctx)
	}
	_, err := r.instruments.Load(ctx, true)
	return err
}

// SwitchBroker implements auth.BrokerControl (POST /api/admin/verify with a broker).
// The role is the actor; an empty role is recorded as "admin".
func (r *Registry) SwitchBroker(ctx context.Context, to brokers.ID, role auth.Role) auth.SwitchResult {
	actor := string(role)
	if actor == "" {
		actor = "admin"
	}
	res := r.SwitchTo(ctx, to, actor)
	return auth.SwitchResult{OK: res.OK, Broker: res.Broker, Blockers: res.Blockers}
}

var _ auth.BrokerControl = (*Registry)(nil)

// Restore adopts the persisted broker selection and generation and rehydrates a
// still-valid Dhan session (boot; restore()). It never fails: an unreadable store
// leaves the defaults.
func (r *Registry) Restore(ctx context.Context) {
	sctx, cancel := storeCtx()
	saved, err := r.store.LoadActiveBroker(sctx)
	cancel()
	if err != nil {
		saved = nil
	}
	if saved != nil {
		st := *r.state.Load()
		if brokers.IsID(saved.Broker) {
			st.active = brokers.ID(saved.Broker)
		}
		// Adopt the persisted generation, never restart the count.
		if saved.Generation > st.gen {
			st.gen = saved.Generation
		}
		r.state.Store(&st)
	}

	sctx, cancel = storeCtx()
	session, err := r.store.LoadDhanSession(sctx)
	cancel()
	if err != nil {
		session = nil
	}
	if session == nil {
		return
	}
	// Token-service/paste records must never be restored into another configured account.
	if session.Source != "" && session.DhanClientID != jsTrim(r.get("DHAN_CLIENT_ID")) {
		return
	}
	if dhan.IsTokenExpired(session.ExpiryTime, r.nowMs()) {
		sctx, cancel = storeCtx()
		_ = r.store.ClearDhanSession(sctx)
		cancel()
		return
	}
	token := session.AccessToken
	loginAt := r.nowMs()
	if !session.LoginAt.IsZero() {
		loginAt = session.LoginAt.UnixMilli()
	}
	r.setDhanSession(&token, copyInt(session.ExpiryTime), &dhanMeta{
		clientID:        session.DhanClientID,
		clientName:      session.DhanClientName,
		clientUcc:       session.DhanClientUcc,
		powerOfAttorney: session.GivenPowerOfAttorney,
		loginDay:        session.LoginDate,
		loginAt:         loginAt,
		source:          session.Source,
	})
	if session.Source == "BROKER_LOGIN" {
		r.brokerLogin.mu.Lock()
		r.brokerLogin.fetchedAt = time.UnixMilli(loginAt)
		r.brokerLogin.mu.Unlock()
	}
}

// StartActiveRuntime brings the active broker's runtime up at boot, in dependency order:
// static IP (Dhan), universe, then the feed. Without a session it stays idle.
func (r *Registry) StartActiveRuntime(ctx context.Context) {
	st := r.state.Load()
	if !r.SessionFor(st.active).Authenticated {
		log.Printf("[Broker] active=%s generation=%d — no session, runtime idle", st.active, st.gen)
		return
	}
	log.Printf("[Broker] active=%s generation=%d", st.active, st.gen)
	if st.active == brokers.Dhan {
		r.VerifyDhanStaticIP(ctx)
	}
	if _, err := r.instruments.Load(ctx, true); err != nil {
		log.Printf("[Broker] %s universe load failed at boot: %v", st.active, err)
	}
	r.StartActiveFeed()
}
