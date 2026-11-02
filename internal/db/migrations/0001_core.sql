-- Core tables: admin sessions, app settings, broker/Kite/Dhan session state, and the
-- cache that replaces Upstash Redis. Names and fields follow the MongoDB collections.

-- admin_sessions: bearer token -> role, 24 h. Memory is the read path; this table
-- restores sessions at boot. Expired rows are purged by the cache janitor.
create table admin_sessions (
	id     text primary key collate "C",
	role   text not null check (role in ('full', 'trade')),
	expiry bigint not null            -- epoch milliseconds
);
create index admin_sessions_expiry on admin_sessions (expiry);

-- app_settings: only id 'rf_rate' (risk-free rate, percent) is written today.
create table app_settings (
	id         text primary key collate "C",
	value      double precision not null,
	updated_at timestamptz not null default now()
);

-- kite_session: single row id 'current'.
create table kite_session (
	id           text primary key collate "C",
	access_token text not null,
	user_id      text not null default '',
	user_name    text not null default '',
	login_date   text not null,        -- IST day, YYYY-MM-DD
	updated_at   timestamptz not null default now()
);

-- dhan_session: single row id 'current'. expiry_time is epoch ms; NULL means unknown
-- (never "no expiry").
create table dhan_session (
	id                      text primary key collate "C",
	access_token            text not null,
	dhan_client_id          text not null default '',
	dhan_client_name        text not null default '',
	dhan_client_ucc         text not null default '',
	given_power_of_attorney boolean not null default false,
	expiry_time             bigint,
	login_at                timestamptz not null default now(),
	login_date              text not null,
	updated_at              timestamptz not null default now()
);

-- active_broker: single row id 'current'. generation is a durable monotonic counter
-- advanced atomically on every broker switch.
create table active_broker (
	id          text primary key collate "C",
	broker      text not null,
	selected_at timestamptz not null default now(),
	selected_by text not null default 'admin',
	generation  bigint
);

-- Cache (replaces Upstash Redis). A key is either a plain value (one field named '')
-- or a hash of fields; expires_at is per key, like Redis EXPIRE. Values are the JSON
-- text the callers wrote.
create table kv_keys (
	key        text primary key collate "C",
	expires_at timestamptz
);
create index kv_keys_expires_at on kv_keys (expires_at) where expires_at is not null;

create table kv_fields (
	key   text not null references kv_keys (key) on delete cascade,
	field text not null collate "C",
	value text not null,
	primary key (key, field)
);
