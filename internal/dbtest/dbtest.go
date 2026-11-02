// Package dbtest gives tests an isolated, migrated PostgreSQL schema.
//
// Set TEST_DATABASE_URL to a local PostgreSQL. Without it the database tests are
// skipped, unless REQUIRE_DB_TESTS=1, which turns the missing database into a failure
// so CI can never pass by skipping.
package dbtest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
)

// New returns a pool bound to a fresh schema with all migrations applied. The schema is
// dropped when the test ends.
func New(t testing.TB) *db.Pool {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("REQUIRE_DB_TESTS") == "1" {
			t.Fatal("TEST_DATABASE_URL is not set but REQUIRE_DB_TESTS=1")
		}
		t.Skip("TEST_DATABASE_URL is not set; skipping PostgreSQL test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect to test database: %v", err)
	}
	var rnd [6]byte
	_, _ = rand.Read(rnd[:])
	schema := "t_" + hex.EncodeToString(rnd[:])
	if _, err := admin.Exec(ctx, `create schema `+schema); err != nil {
		admin.Close()
		t.Fatalf("create schema: %v", err)
	}

	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		admin.Close()
		t.Fatalf("parse test database url: %v", err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		admin.Close()
		t.Fatalf("open schema pool: %v", err)
	}
	p := &db.Pool{Pool: pool}
	t.Cleanup(func() {
		p.Close()
		dropCtx, c := context.WithTimeout(context.Background(), 20*time.Second)
		defer c()
		_, _ = admin.Exec(dropCtx, `drop schema `+schema+` cascade`)
		admin.Close()
	})
	if err := p.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return p
}
