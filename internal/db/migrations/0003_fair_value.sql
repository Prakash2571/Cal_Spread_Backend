-- Fair Value analytics persistence (was the MongoDB collections `fair_value_settings` and
-- `fair_value_snapshots`, src/fairValue/store.ts). The configuration and the snapshots
-- are pass-through blobs whose key order is part of the API (and of config_version), so
-- they are `json` (stored as written), not `jsonb`.

-- fair_value_settings: single row id 'current', the full saved configuration.
create table fair_value_settings (
	id         text primary key collate "C",
	version    text not null,
	config     json not null,
	updated_at timestamptz not null default now()
);

-- fair_value_snapshots: bounded surface history. id = snapshot.id; insert-once
-- ($setOnInsert in Mongo = ON CONFLICT DO NOTHING). `summary` is historySummary(snapshot),
-- written with the row so history lists never read the large snapshot blob (Mongo used a
-- projection for the same purpose). Reads ignore rows whose expires_at has passed (by the
-- application clock, like Node's `new Date()` filter); expired rows are deleted on each
-- append (Mongo's TTL monitor did that in the background).
create table fair_value_snapshots (
	id                text primary key collate "C",
	underlying        text not null collate "C",
	input_snapshot_id text not null,
	model_version     text not null,
	config_version    text not null,
	at                timestamptz not null,
	expires_at        timestamptz not null,
	snapshot          json not null,
	input             json not null,
	summary           json not null
);
create index fair_value_snapshots_underlying_at on fair_value_snapshots (underlying, at desc);
create index fair_value_snapshots_at on fair_value_snapshots (at);
create index fair_value_snapshots_expires_at on fair_value_snapshots (expires_at);
