package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/auth"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/dbtest"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/store"
)

var _ auth.Persistence = (*store.Store)(nil)

func TestAdminSessionRoundTrip(t *testing.T) {
	now := time.UnixMilli(1_000_000)
	s := store.New(dbtest.New(t), func() time.Time { return now })
	ctx := context.Background()

	if err := s.SaveAdminSession(ctx, "tok-a", auth.RoleFull, 2_000_000); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveAdminSession(ctx, "tok-b", auth.RoleTrade, 500_000); err != nil { // already expired
		t.Fatal(err)
	}
	if err := s.SaveAdminSession(ctx, "tok-a", auth.RoleTrade, 3_000_000); err != nil { // upsert changes role and expiry
		t.Fatal(err)
	}
	rows, err := s.LoadAdminSessions(ctx, now.UnixMilli())
	if err != nil || len(rows) != 1 || rows[0].Token != "tok-a" || rows[0].Role != auth.RoleTrade || rows[0].ExpiryMs != 3_000_000 {
		t.Fatalf("LoadAdminSessions = %+v, err %v", rows, err)
	}
	if n, err := s.PurgeExpiredAdminSessions(ctx); err != nil || n != 1 {
		t.Fatalf("purge removed %d, err %v (want 1)", n, err)
	}
	if err := s.DeleteAdminSession(ctx, "tok-a"); err != nil {
		t.Fatal(err)
	}
	if rows, _ := s.LoadAdminSessions(ctx, 0); len(rows) != 0 {
		t.Fatalf("after delete: %+v", rows)
	}
}

func TestSessionsSurviveARestartThroughPostgres(t *testing.T) {
	pool := dbtest.New(t)
	st := store.New(pool, nil)
	first := auth.NewSessions(st, nil)
	first.SetBackground(func(f func()) { f() })
	token := first.Mint(auth.RoleFull)

	second := auth.NewSessions(st, nil) // a fresh process
	if n, err := second.Restore(context.Background()); err != nil || n != 1 {
		t.Fatalf("restored %d, err %v", n, err)
	}
	if second.Role(token) != auth.RoleFull {
		t.Fatal("token must still be valid after restart")
	}
}

func TestRfRate(t *testing.T) {
	s := store.New(dbtest.New(t), nil)
	ctx := context.Background()
	if _, ok, err := s.LoadRfRate(ctx); ok || err != nil {
		t.Fatalf("nothing stored yet: ok=%v err=%v", ok, err)
	}
	if err := s.SaveRfRate(ctx, 6.75); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveRfRate(ctx, 0); err != nil { // zero is a real value
		t.Fatal(err)
	}
	if v, ok, err := s.LoadRfRate(ctx); !ok || err != nil || v != 0 {
		t.Fatalf("LoadRfRate = %v,%v,%v", v, ok, err)
	}
}

func TestNoDatabaseIsAQuietNoOp(t *testing.T) {
	s := store.New(nil, nil)
	ctx := context.Background()
	if s.Enabled() {
		t.Fatal("must be disabled")
	}
	if err := s.SaveAdminSession(ctx, "t", auth.RoleFull, 1); err != nil {
		t.Fatal(err)
	}
	if rows, err := s.LoadAdminSessions(ctx, 0); rows != nil || err != nil {
		t.Fatal("nothing to load")
	}
	if _, ok, err := s.LoadRfRate(ctx); ok || err != nil {
		t.Fatal("no stored rate")
	}
	if err := s.SaveRfRate(ctx, 1); err != nil {
		t.Fatal(err)
	}
}
