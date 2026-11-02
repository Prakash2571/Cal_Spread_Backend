package synthetic

import "context"

// StoredTrade is a row read back by Store.Get. Deleted is set for a soft-deleted row
// (its Status then reads "closed"), with DeletedFrom saying whether it was open or
// closed when deleted.
type StoredTrade struct {
	*Trade
	Deleted     bool
	DeletedFrom string
}

// DeleteAudit records who soft-deleted a trade, when and why.
type DeleteAudit struct {
	Reason *string
	Actor  string
	At     int64 // epoch ms
}

// Store is the persistence seam (SynthTradeStore): PostgreSQL in production
// (Repository), anything else in tests. Every write that matters is atomic.
type Store interface {
	// Enabled reports whether trades can be read and written.
	Enabled() bool
	// EnsureReady creates and verifies what the atomicity guarantees rest on (the
	// partial unique index). Paper entries stay off until it has succeeded.
	EnsureReady(ctx context.Context) error
	// NewID allocates a trade id (24 hex characters).
	NewID() string
	// Get returns the stored row, or nil when there is none (or the id is malformed).
	Get(ctx context.Context, id string) (*StoredTrade, error)
	// InsertOpen stores a new open trade; duplicate is true when the underlying already
	// has an open position (or this id already exists).
	InsertOpen(ctx context.Context, t *Trade) (duplicate bool, err error)
	// Close is the atomic open → closed write. False when the row was not open.
	Close(ctx context.Context, t *Trade) (bool, error)
	// SetMargin records a trade's margin figure; the only writer of the margin fields.
	SetMargin(ctx context.Context, id string, p MarginPatch) error
	// MarkDeleted soft-deletes a trade whose status is still from ("open"|"closed").
	MarkDeleted(ctx context.Context, id, from string, audit DeleteAudit) (bool, error)
	// LoadOpen lists the open trades, oldest first.
	LoadOpen(ctx context.Context) ([]*Trade, error)
	// LoadClosed lists closed trades, newest first, optionally since an IST day.
	LoadClosed(ctx context.Context, limit int, sinceDay *string) ([]*Trade, error)
	// LoadSettings returns the saved runtime settings (unvalidated); keys never saved are
	// absent.
	LoadSettings(ctx context.Context) (map[string]float64, error)
	// SaveSettings saves every runtime setting at once.
	SaveSettings(ctx context.Context, s Settings) error
}
