// Package kv is the PostgreSQL-backed cache that replaces Upstash Redis. It offers the
// same small command set the Node code used (GET/SET EX, HGETALL/HSET/HDEL, EXPIRE,
// DEL) with Redis semantics: a key expires as a whole, an expired key behaves as if it
// did not exist, and a hash disappears when its last field is removed.
//
// Values are the JSON text callers wrote; the cache never interprets them.
package kv

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
)

// Prefix is prepended to every key, as the Redis layer did (redis.ts:37).
const Prefix = "calspread:"

// plainField is the field a plain (non-hash) value is stored under.
const plainField = ""

// Cache is the key-value cache. A Cache over a nil or closed pool is disabled: reads
// report "not found" and writes fail with ErrDisabled, mirroring an unconfigured Redis.
type Cache struct {
	pool *db.Pool
	now  func() time.Time
}

// ErrDisabled is returned by writes when no database is configured.
var ErrDisabled = errors.New("cache is disabled: no database configured")

// New returns a cache over pool. now is injectable for tests; nil means time.Now.
func New(pool *db.Pool, now func() time.Time) *Cache {
	if now == nil {
		now = time.Now
	}
	return &Cache{pool: pool, now: now}
}

// Enabled reports whether the cache can be used.
func (c *Cache) Enabled() bool { return c != nil && c.pool.Enabled() }

func key(k string) string { return Prefix + k }

// Ping checks the connection (Redis PING).
func (c *Cache) Ping(ctx context.Context) error {
	if !c.Enabled() {
		return ErrDisabled
	}
	return c.pool.Ping(ctx)
}

// Get returns the plain value stored at k (Redis GET). ok is false when it is absent or expired.
func (c *Cache) Get(ctx context.Context, k string) (value string, ok bool, err error) {
	if !c.Enabled() {
		return "", false, nil
	}
	err = c.pool.QueryRow(ctx, `
		select f.value from kv_fields f join kv_keys k on k.key = f.key
		where f.key = $1 and f.field = $2 and (k.expires_at is null or k.expires_at > $3)`,
		key(k), plainField, c.now()).Scan(&value)
	if db.NoRows(err) {
		return "", false, nil
	}
	return value, err == nil, err
}

// Set stores a plain value (Redis SET k v EX ttl). ttl <= 0 stores it without expiry.
func (c *Cache) Set(ctx context.Context, k, value string, ttl time.Duration) error {
	if !c.Enabled() {
		return ErrDisabled
	}
	return c.inTx(ctx, func(tx pgx.Tx) error {
		// SET replaces whatever was there, including a hash, and resets the TTL.
		if _, err := tx.Exec(ctx, `delete from kv_keys where key = $1`, key(k)); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `insert into kv_keys (key, expires_at) values ($1, $2)`, key(k), c.expiry(ttl)); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `insert into kv_fields (key, field, value) values ($1, $2, $3)`, key(k), plainField, value)
		return err
	})
}

// HGetAll returns every field of the hash at k (Redis HGETALL). An absent or expired key gives an empty map.
func (c *Cache) HGetAll(ctx context.Context, k string) (map[string]string, error) {
	out := map[string]string{}
	if !c.Enabled() {
		return out, nil
	}
	rows, err := c.pool.Query(ctx, `
		select f.field, f.value from kv_fields f join kv_keys k on k.key = f.key
		where f.key = $1 and (k.expires_at is null or k.expires_at > $2)`, key(k), c.now())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var field, value string
		if err := rows.Scan(&field, &value); err != nil {
			return nil, err
		}
		out[field] = value
	}
	return out, rows.Err()
}

// HSet writes fields into the hash at k (Redis HSET). A new hash has no expiry until Expire is called.
func (c *Cache) HSet(ctx context.Context, k string, fields map[string]string) error {
	if !c.Enabled() {
		return ErrDisabled
	}
	if len(fields) == 0 {
		return nil
	}
	return c.inTx(ctx, func(tx pgx.Tx) error {
		if err := c.ensureLive(ctx, tx, k); err != nil {
			return err
		}
		batch := &pgx.Batch{}
		for f, v := range fields {
			batch.Queue(`insert into kv_fields (key, field, value) values ($1, $2, $3)
				on conflict (key, field) do update set value = excluded.value`, key(k), f, v)
		}
		res := tx.SendBatch(ctx, batch)
		for range fields {
			if _, err := res.Exec(); err != nil {
				_ = res.Close()
				return err
			}
		}
		return res.Close()
	})
}

// HDel removes fields from the hash at k (Redis HDEL). The key is dropped when no field is left.
func (c *Cache) HDel(ctx context.Context, k string, fields ...string) error {
	if !c.Enabled() {
		return ErrDisabled
	}
	if len(fields) == 0 {
		return nil
	}
	return c.inTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `delete from kv_fields where key = $1 and field = any($2)`, key(k), fields); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `delete from kv_keys where key = $1
			and not exists (select 1 from kv_fields where key = $1)`, key(k))
		return err
	})
}

// Expire sets the TTL of an existing key (Redis EXPIRE). It reports whether the key existed.
func (c *Cache) Expire(ctx context.Context, k string, ttl time.Duration) (bool, error) {
	if !c.Enabled() {
		return false, ErrDisabled
	}
	tag, err := c.pool.Exec(ctx, `update kv_keys set expires_at = $2
		where key = $1 and (expires_at is null or expires_at > $3)`, key(k), c.expiry(ttl), c.now())
	return tag.RowsAffected() == 1, err
}

// Del removes keys (Redis DEL).
func (c *Cache) Del(ctx context.Context, keys ...string) error {
	if !c.Enabled() {
		return ErrDisabled
	}
	full := make([]string, len(keys))
	for i, k := range keys {
		full[i] = key(k)
	}
	_, err := c.pool.Exec(ctx, `delete from kv_keys where key = any($1)`, full)
	return err
}

// Purge deletes expired keys and returns how many it removed. Reads already ignore
// expired keys; this only reclaims space (Redis does the same lazily).
func (c *Cache) Purge(ctx context.Context) (int64, error) {
	if !c.Enabled() {
		return 0, nil
	}
	tag, err := c.pool.Exec(ctx, `delete from kv_keys where expires_at is not null and expires_at <= $1`, c.now())
	return tag.RowsAffected(), err
}

func (c *Cache) expiry(ttl time.Duration) any {
	if ttl <= 0 {
		return nil
	}
	return c.now().Add(ttl)
}

// ensureLive makes sure a live key row exists for k: an expired one is replaced, as Redis
// would treat it as absent.
func (c *Cache) ensureLive(ctx context.Context, tx pgx.Tx, k string) error {
	if _, err := tx.Exec(ctx, `delete from kv_keys where key = $1 and expires_at is not null and expires_at <= $2`, key(k), c.now()); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `insert into kv_keys (key) values ($1) on conflict (key) do nothing`, key(k))
	return err
}

func (c *Cache) inTx(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, err := c.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("cache: begin: %w", err)
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback(ctx)
		return fmt.Errorf("cache: %w", err)
	}
	return tx.Commit(ctx)
}
