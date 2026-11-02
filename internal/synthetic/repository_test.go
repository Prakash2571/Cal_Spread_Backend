package synthetic

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/dbtest"
)

// The Node store (src/synthetic/repository.ts) ran on MongoDB and had no test; these
// cases pin what it guaranteed, on PostgreSQL: one open row per underlying, closes that
// never touch the margin fields, soft deletes kept as audit rows, settings upserts, and
// trades that read back exactly as written (legs with Mongoose's stored defaults).

var _ Store = (*Repository)(nil)

// goldenTrades are real opened and closed trades from math_golden.json, with ids made
// valid ObjectIds.
func goldenTrades(t *testing.T) (opened, closed []*Trade) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "math_golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Trades []struct {
			Opened *string `json:"opened"`
			Exits  []struct {
				Closed *string `json:"closed"`
			} `json:"exits"`
		} `json:"trades"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	for _, tr := range g.Trades {
		if tr.Opened == nil {
			continue
		}
		var o Trade
		if err := json.Unmarshal([]byte(*tr.Opened), &o); err != nil {
			t.Fatal(err)
		}
		for _, ex := range tr.Exits {
			if ex.Closed != nil {
				var c Trade
				if err := json.Unmarshal([]byte(*ex.Closed), &c); err != nil {
					t.Fatal(err)
				}
				closed = append(closed, &c)
				break
			}
		}
		opened = append(opened, &o)
	}
	if len(opened) < 20 || len(closed) < 20 {
		t.Fatalf("golden has %d opened, %d closed trades", len(opened), len(closed))
	}
	return opened, closed
}

// stored is t as a stored row reads back: legs carry every optional field (null when
// never recorded), as Mongoose's schema defaults wrote them.
func stored(t *Trade) string {
	c := t.Clone()
	for i := range c.Legs {
		c.Legs[i] = c.Legs[i].withStoredDefaults()
	}
	b, _ := encodeJS(c)
	return string(b)
}

func js(t *testing.T, v any) string {
	t.Helper()
	b, err := encodeJS(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestRepositoryOnPostgres(t *testing.T) {
	ctx := context.Background()
	pool := dbtest.New(t)
	repo := NewRepository(pool)
	if !repo.Enabled() {
		t.Fatal("repository with a pool is disabled")
	}
	if err := repo.EnsureReady(ctx); err != nil {
		t.Fatal(err)
	}
	if err := repo.EnsureReady(ctx); err != nil {
		t.Fatalf("second EnsureReady: %v", err)
	}
	opened, closed := goldenTrades(t)

	// Pick open trades on distinct underlyings plus one more on the first underlying.
	byUnderlying := map[string]*Trade{}
	var extra *Trade
	for _, o := range opened {
		if _, seen := byUnderlying[o.Underlying]; !seen {
			byUnderlying[o.Underlying] = o
		} else if extra == nil {
			extra = o
		}
	}
	if len(byUnderlying) < 3 || extra == nil {
		t.Fatalf("golden trades cover %d underlyings", len(byUnderlying))
	}
	ids := map[string]string{}
	var first *Trade
	var names []string
	for u := range byUnderlying {
		names = append(names, u)
	}
	sort.Strings(names)
	names = names[:3]
	for i, u := range names {
		o := byUnderlying[u].Clone()
		o.ID = db.NewID()
		o.OpenedAt += int64(i) * 1001 // distinct, millisecond-precise open times
		if i == 1 {
			o.Broker = "" // a legacy row without a broker reads as zerodha
		}
		dup, err := repo.InsertOpen(ctx, o)
		if err != nil || dup {
			t.Fatalf("insert %s: dup %v err %v", u, dup, err)
		}
		ids[u] = o.ID
		got, err := repo.Get(ctx, o.ID)
		if err != nil || got == nil || got.Deleted {
			t.Fatalf("get %s: %+v %v", u, got, err)
		}
		want := o.Clone()
		if want.Broker == "" {
			want.Broker = "zerodha"
		}
		if js(t, got.Trade) != stored(want) {
			t.Fatalf("%s read back differs:\n got %s\nwant %s", u, js(t, got.Trade), stored(want))
		}
		if first == nil {
			first = o
		}
	}

	// One open row per underlying; the same id twice is a duplicate too.
	second := extra.Clone()
	second.ID, second.Underlying = db.NewID(), first.Underlying
	if dup, err := repo.InsertOpen(ctx, second); err != nil || !dup {
		t.Fatalf("second open trade on %s: dup %v err %v", first.Underlying, dup, err)
	}
	if dup, err := repo.InsertOpen(ctx, first); err != nil || !dup {
		t.Fatalf("same id again: dup %v err %v", dup, err)
	}

	// Margin belongs to SetMargin: a close never writes it.
	margin, src, hedge, at := 152345.5, "kite_basket", 1234.25, int64(1793167260123)
	if err := repo.SetMargin(ctx, first.ID, MarginPatch{Margin: &margin, MarginSource: &src, MarginHedgeBenefit: &hedge, MarginAt: &at}); err != nil {
		t.Fatal(err)
	}
	if err := repo.SetMargin(ctx, "not-an-id", MarginPatch{}); err != nil {
		t.Fatalf("malformed id must be a no-op: %v", err)
	}
	var closing *Trade
	for _, c := range closed {
		if c.Key == first.Key {
			closing = c.Clone()
		}
	}
	if closing == nil {
		closing = closed[0].Clone()
		closing.Key, closing.Underlying, closing.Expiry = first.Key, first.Underlying, first.Expiry
	}
	closing.ID, closing.OpenedAt = first.ID, first.OpenedAt
	closing.Margin, closing.MarginSource = nil, nil // must not clobber the stored margin
	if ok, err := repo.Close(ctx, closing); err != nil || !ok {
		t.Fatalf("close: %v %v", ok, err)
	}
	if ok, _ := repo.Close(ctx, closing); ok {
		t.Fatal("closing a closed row matched")
	}
	got, _ := repo.Get(ctx, first.ID)
	if got.Status != "closed" || got.Margin == nil || *got.Margin != margin || got.MarginAt == nil || *got.MarginAt != at ||
		*got.MarginSource != src || *got.MarginHedgeBenefit != hedge {
		t.Fatalf("closed row: status %s margin %v at %v", got.Status, got.Margin, got.MarginAt)
	}
	wantClosed := closing.Clone()
	wantClosed.Margin, wantClosed.MarginSource, wantClosed.MarginHedgeBenefit, wantClosed.MarginAt =
		&margin, &src, &hedge, &at
	if js(t, got.Trade) != stored(wantClosed) {
		t.Fatalf("closed row differs:\n got %s\nwant %s", js(t, got.Trade), stored(wantClosed))
	}
	// After the close the underlying may be opened again.
	if dup, err := repo.InsertOpen(ctx, second); err != nil || dup {
		t.Fatalf("reopen after close: dup %v err %v", dup, err)
	}

	// Listings.
	open, err := repo.LoadOpen(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i < len(open); i++ {
		if open[i-1].OpenedAt > open[i].OpenedAt {
			t.Fatal("open trades not oldest first")
		}
	}
	if len(open) != 3 {
		t.Fatalf("%d open trades, want 3", len(open))
	}
	for i, c := range closed[:5] {
		c := c.Clone()
		c.ID, c.Underlying = db.NewID(), "CLOSED"+string(rune('A'+i))
		c.Status = "closed"
		day := []string{"2026-10-27", "2026-10-28", "2026-10-28", "2026-10-29", "2026-10-30"}[i]
		ca := int64(1793167200000 + i*60000)
		c.ClosedDay, c.ClosedAt = &day, &ca
		if dup, err := repo.InsertOpen(ctx, c); err != nil || dup {
			t.Fatalf("insert closed row: %v %v", dup, err)
		}
	}
	all, _ := repo.LoadClosed(ctx, 0, nil)
	if len(all) != 6 {
		t.Fatalf("%d closed trades, want 6", len(all))
	}
	for i := 1; i < len(all); i++ {
		if *all[i-1].ClosedAt < *all[i].ClosedAt {
			t.Fatal("closed trades not newest first")
		}
	}
	since := "2026-10-28"
	recent, _ := repo.LoadClosed(ctx, 2, &since)
	if len(recent) != 2 || *recent[0].ClosedDay < since || *recent[1].ClosedDay < since || *recent[0].ClosedAt < *recent[1].ClosedAt {
		t.Fatalf("limit 2 since %s: %d rows", since, len(recent))
	}

	// Soft delete: an audit row, out of every list, untouched by SetMargin.
	reason := "duplicate entry"
	if ok, err := repo.MarkDeleted(ctx, ids[names[2]], "open", DeleteAudit{Reason: &reason, Actor: "full", At: 1793167300000}); err != nil || !ok {
		t.Fatalf("delete: %v %v", ok, err)
	}
	if ok, _ := repo.MarkDeleted(ctx, ids[names[2]], "open", DeleteAudit{Actor: "full", At: 1}); ok {
		t.Fatal("deleting twice matched")
	}
	if ok, _ := repo.MarkDeleted(ctx, "zz", "open", DeleteAudit{}); ok {
		t.Fatal("malformed id matched")
	}
	m2 := 1.0
	_ = repo.SetMargin(ctx, ids[names[2]], MarginPatch{Margin: &m2})
	del, _ := repo.Get(ctx, ids[names[2]])
	if del == nil || !del.Deleted || del.DeletedFrom != "open" || del.Status != "closed" || del.Margin != nil {
		t.Fatalf("deleted row: %+v", del)
	}
	var auditBy, auditReason string
	if err := pool.QueryRow(ctx, `select deleted_by, delete_reason from synth_trades where id = $1`, ids[names[2]]).Scan(&auditBy, &auditReason); err != nil ||
		auditBy != "full" || auditReason != reason {
		t.Fatalf("audit fields %q %q %v", auditBy, auditReason, err)
	}
	if open, _ = repo.LoadOpen(ctx); len(open) != 2 {
		t.Fatalf("%d open trades after the delete, want 2", len(open))
	}

	// Ids: anything but 24 hex characters (a 12-character string included, as with bson
	// 6.10.4) is simply not found; upper-case hex finds the row.
	for _, id := range []string{"abcdefghijkl", "nope", "", strings.ToUpper(ids[names[0]])} {
		got, err := repo.Get(ctx, id)
		if err != nil {
			t.Fatalf("get %q: %v", id, err)
		}
		if (got != nil) != (id == strings.ToUpper(ids[names[0]])) {
			t.Fatalf("get %q found %v", id, got != nil)
		}
	}
}

func TestRepositorySettingsOnPostgres(t *testing.T) {
	ctx := context.Background()
	pool := dbtest.New(t)
	repo := NewRepository(pool)
	got, err := repo.LoadSettings(ctx)
	if err != nil || len(got) != 0 {
		t.Fatalf("fresh settings %v %v", got, err)
	}
	if err := repo.SaveSettings(ctx, Settings{MinExpectedNetProfit: 750, SafetyBuffer: 125.5, MaxOpenPositions: 3}); err != nil {
		t.Fatal(err)
	}
	if err := repo.SaveSettings(ctx, Settings{MinExpectedNetProfit: 800, SafetyBuffer: 0, MaxOpenPositions: 0}); err != nil {
		t.Fatal(err)
	}
	// Rows the engine must ignore: an unknown key and non-finite values.
	if _, err := pool.Exec(ctx, `insert into synth_settings (id, value, updated_at) values ('unknown_key', 5, now())`); err != nil {
		t.Fatal(err)
	}
	got, err = repo.LoadSettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[SettingMinExpectedNetProfit] != 800 || got[SettingSafetyBuffer] != 0 || got[SettingMaxOpenPositions] != 0 {
		t.Fatalf("settings %v", got)
	}
	if _, err := pool.Exec(ctx, `update synth_settings set value = 'NaN' where id = $1`, SettingSafetyBuffer); err != nil {
		t.Skipf("column rejects NaN: %v", err)
	}
	if got, _ = repo.LoadSettings(ctx); len(got) != 2 {
		t.Fatalf("a NaN setting must be ignored: %v", got)
	}
}

func TestRepositoryWithoutDatabase(t *testing.T) {
	ctx := context.Background()
	var repo *Repository
	if repo.Enabled() || NewRepository(nil).Enabled() {
		t.Fatal("a repository without a pool must be disabled")
	}
	r := NewRepository(nil)
	if err := r.EnsureReady(ctx); err == nil {
		t.Fatal("EnsureReady without storage succeeded")
	}
	if _, err := r.LoadOpen(ctx); err == nil {
		t.Fatal("LoadOpen without storage succeeded")
	}
}
