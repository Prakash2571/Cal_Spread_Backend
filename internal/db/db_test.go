package db_test

import (
	"context"
	"path/filepath"
	"regexp"
	"sort"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/dbtest"
)

func TestNewIDShapeAndOrdering(t *testing.T) {
	hex24 := regexp.MustCompile(`^[0-9a-f]{24}$`)
	seen := map[string]bool{}
	var ids []string
	base := time.Date(2026, 10, 27, 9, 0, 0, 0, time.UTC)
	for i := 0; i < 2000; i++ {
		id := db.NewIDAt(base.Add(time.Duration(i) * time.Second))
		if !hex24.MatchString(id) {
			t.Fatalf("id %q is not 24 lowercase hex", id)
		}
		if seen[id] {
			t.Fatalf("duplicate id %q", id)
		}
		seen[id] = true
		ids = append(ids, id)
	}
	if !sort.StringsAreSorted(ids) {
		t.Fatal("ids made at increasing times must sort in time order")
	}
	// Same second: the counter keeps them unique and increasing.
	a, b := db.NewIDAt(base), db.NewIDAt(base)
	if a == b || a > b {
		t.Fatalf("same-second ids: %s then %s", a, b)
	}
}

func TestCheckID(t *testing.T) {
	cases := []struct {
		in   string
		kind db.IDKind
		want string
	}{
		{"507f1f77bcf86cd799439011", db.IDValid, "507f1f77bcf86cd799439011"},
		{"507F1F77BCF86CD799439011", db.IDValid, "507f1f77bcf86cd799439011"}, // ObjectId casts upper-case hex
		{"abcdefghijkl", db.IDInvalid, ""},                                   // 12 chars: bson 6 ObjectId.isValid says no (400)
		{"507f1f77bcf86cd79943901z", db.IDInvalid, ""},                       // 24 chars but not hex
		{"", db.IDInvalid, ""}, {"123", db.IDInvalid, ""}, {"507f1f77bcf86cd7994390112", db.IDInvalid, ""},
	}
	for _, c := range cases {
		kind, got := db.CheckID(c.in)
		if kind != c.kind || got != c.want {
			t.Errorf("CheckID(%q) = %v,%q want %v,%q", c.in, kind, got, c.kind, c.want)
		}
	}
}

func TestNilPoolIsDisabled(t *testing.T) {
	var p *db.Pool
	if p.Enabled() {
		t.Fatal("nil pool must not be enabled")
	}
	p.Close() // must not panic
	if err := p.Migrate(context.Background()); err != nil {
		t.Fatalf("migrating a nil pool is a no-op, got %v", err)
	}
}

func TestMigrateIsIdempotentAndCreatesCoreTables(t *testing.T) {
	p := dbtest.New(t)
	ctx := context.Background()
	if err := p.Migrate(ctx); err != nil { // second run must change nothing
		t.Fatalf("second migrate: %v", err)
	}
	files, _ := filepath.Glob(filepath.Join("migrations", "*.sql"))
	var n int
	if err := p.QueryRow(ctx, `select count(*) from schema_migrations`).Scan(&n); err != nil || n != len(files) {
		t.Fatalf("schema_migrations rows = %d, err %v (want %d)", n, err, len(files))
	}
	for _, table := range []string{"admin_sessions", "app_settings", "kite_session", "dhan_session", "active_broker", "kv_keys", "kv_fields"} {
		var ok bool
		if err := p.QueryRow(ctx, `select to_regclass($1) is not null`, table).Scan(&ok); err != nil || !ok {
			t.Errorf("table %s missing (err %v)", table, err)
		}
	}
}

func TestUniqueViolationNamesTheConstraint(t *testing.T) {
	p := dbtest.New(t)
	ctx := context.Background()
	if _, err := p.Exec(ctx, `insert into app_settings (id, value) values ('rf_rate', 7)`); err != nil {
		t.Fatal(err)
	}
	_, err := p.Exec(ctx, `insert into app_settings (id, value) values ('rf_rate', 8)`)
	name, ok := db.UniqueViolation(err)
	if !ok || name != "app_settings_pkey" {
		t.Fatalf("UniqueViolation = %q,%v (err %v)", name, ok, err)
	}
	if _, ok := db.UniqueViolation(nil); ok {
		t.Fatal("nil error is not a unique violation")
	}
}
