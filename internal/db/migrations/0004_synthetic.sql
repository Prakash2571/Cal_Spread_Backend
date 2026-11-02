-- Synthetic-futures PAPER trades (was the MongoDB collection `synth_trades`) and the
-- admin-tunable Synthetic settings (`synth_settings`). Field names follow the Mongo
-- documents; nested leg documents are jsonb (decoded into typed Go values).

-- synth_trades: one row per trade. status 'deleted' is a soft delete: the row leaves
-- every list and P&L figure but stays as an audit record (deleted_*).
create table synth_trades (
	id                      text primary key collate "C" check (id ~ '^[0-9a-f]{24}$'),
	status                  text not null default 'open' collate "C"
	                        check (status in ('open', 'closed', 'deleted')),
	key                     text not null collate "C",
	broker                  text collate "C" check (broker in ('zerodha', 'dhan')), -- NULL reads as zerodha
	execution_mode          text not null default 'paper_touch' check (execution_mode = 'paper_touch'),
	order_type              text not null default 'LIMIT' check (order_type = 'LIMIT'),
	underlying              text not null collate "C",
	name                    text not null default '',
	is_index                boolean not null default false,
	expiry                  text not null collate "C",          -- YYYY-MM-DD
	strike                  double precision not null,
	atm_strike              double precision not null default 0,
	atm_offset              double precision not null default 0,
	direction               text not null check (direction in ('CONVERSION', 'REVERSAL')),
	lot_size                double precision not null,
	quantity                double precision not null,
	opened_at               timestamptz not null,               -- millisecond precision
	opened_day              text not null collate "C",          -- IST YYYY-MM-DD
	legs                    jsonb not null default '[]',
	entry_future_price      double precision not null,
	entry_synthetic_price   double precision not null,
	entry_lock_per_unit     double precision not null,
	entry_carry_per_unit    double precision not null default 0,
	entry_edge              double precision not null,
	entry_gross_edge        double precision not null,
	entry_charges           double precision not null,
	estimated_exit_charges  double precision not null,
	entry_net_edge          double precision not null,
	expected_net_profit     double precision not null,
	min_expected_net_profit double precision not null default 0,
	safety_buffer           double precision not null default 0,
	expected_slippage       double precision not null default 0,
	rf_pct                  double precision not null default 0,
	option_rate_version     text not null default '',
	futures_rate_version    text not null default '',
	closed_at               timestamptz,
	closed_day              text collate "C",
	exit_reason             text check (exit_reason in
	                        ('EDGE_CONVERGED', 'PROFIT_CAPTURE', 'EXPIRY_SAFETY', 'EXPIRED', 'MANUAL')),
	gross_pnl               double precision,
	exit_charges            double precision,
	total_charges           double precision,
	net_pnl                 double precision,
	exit_note               text,
	-- Written only by the margin capture (setMargin), never by a close.
	margin                  double precision,
	margin_source           text,
	margin_hedge_benefit    double precision,
	margin_at               timestamptz,
	margin_error            text,
	deleted_at              timestamptz,
	deleted_from            text check (deleted_from in ('open', 'closed')),
	delete_reason           text,
	deleted_by              text
);

-- The one-open-position-per-underlying guarantee. The engine reads this index back at
-- boot and refuses paper entries until it is verified.
create unique index synth_open_one_per_underlying on synth_trades (underlying) where status = 'open';
-- The Closed-trades read path, newest first (Mongo sorts a missing closed_at last).
create index synth_status_closed_at on synth_trades (status, closed_at desc nulls last);
-- Today's closed trades, for the day P&L after a restart.
create index synth_closed_day on synth_trades (closed_day);

-- synth_settings: one row per runtime setting (min_expected_net_profit, safety_buffer,
-- max_open_positions). A saved value overrides the env default at boot.
create table synth_settings (
	id         text primary key collate "C",
	value      double precision not null,
	updated_at timestamptz not null default now()
);
