// Package db owns the PostgreSQL connection pool and schema migrations. PostgreSQL is
// the only store: it replaces MongoDB (durable data) and Upstash Redis (caches).
package db

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Pool is a PostgreSQL connection pool. A nil *Pool means "no database configured":
// callers check Enabled() the way the Node code checked isDbEnabled().
type Pool struct {
	*pgxpool.Pool
}

// Enabled reports whether a database is configured and connected.
func (p *Pool) Enabled() bool { return p != nil && p.Pool != nil }

// Open connects to url and verifies the connection with a ping.
func Open(ctx context.Context, url string) (*Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	if cfg.MaxConns < 10 {
		cfg.MaxConns = 10
	}
	cfg.MaxConnLifetime = time.Hour
	cfg.HealthCheckPeriod = time.Minute
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect to PostgreSQL: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping PostgreSQL: %w", err)
	}
	return &Pool{pool}, nil
}

// Close releases the pool. Safe on a nil pool.
func (p *Pool) Close() {
	if p.Enabled() {
		p.Pool.Close()
	}
}

// UniqueViolation reports whether err is a PostgreSQL unique violation (SQLSTATE 23505,
// the equivalent of MongoDB's E11000) and returns the constraint or index name.
func UniqueViolation(err error) (constraint string, ok bool) {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return pgErr.ConstraintName, true
	}
	return "", false
}

// NoRows reports whether err means a query that expected a row found none.
func NoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }
