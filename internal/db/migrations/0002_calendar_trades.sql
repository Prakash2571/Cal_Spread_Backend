-- Calendar-spread trades (src/index.ts /api/trades*, src/db.ts): the MongoDB collection
-- `trades` (model Trade) and its append-only charges ledger `trade_log` (model TradeLog,
-- which had its own TRADE_LOG_URI connection). Field names follow the Mongo documents.
-- Ids are ObjectId-style 24-hex strings; Dates are timestamptz written with millisecond
-- precision; numbers are double precision (JavaScript doubles); text used for matching
-- is COLLATE "C" (bytewise, like Mongo). Nested charge documents are `json`, so the
-- stored text, and with it the key order, is exactly what was written.

-- trades: one row per trade. No unique index on open trades: like Node, the take-trade
-- route checks for an open trade and then inserts (the race is ported as-is).
create table trades (
	id               text primary key collate "C" check (id ~ '^[0-9a-f]{24}$'),
	symbol           text not null collate "C",
	name             text not null default '',
	is_index         boolean not null default false,
	lot_size         double precision not null,
	-- buy / sell: the TradeLeg subdocuments {token, expiry, entry}.
	buy_token        bigint not null,
	buy_expiry       text not null collate "C",          -- YYYY-MM-DD
	buy_entry        double precision not null,
	sell_token       bigint not null,
	sell_expiry      text not null collate "C",
	sell_entry       double precision not null,
	status           text not null default 'open' collate "C" check (status in ('open', 'closed')),
	opened_at        timestamptz not null,
	closed_at        timestamptz,
	close_pnl        double precision,                   -- GROSS realised P&L
	buy_close        double precision,
	sell_close       double precision,
	margin           double precision,                   -- basket margin at entry (rupees)
	-- ITradeCharges {legs, value, brokerage, stt, exchange_txn, sebi, stamp_duty, gst,
	-- total, source, at}; NULL when Kite could not price the orders.
	entry_charges    json,
	exit_charges     json,
	est_exit_charges json,
	entry_value      double precision,
	exit_value       double precision,
	total_charges    double precision,
	net_pnl          double precision
);
create index trades_symbol on trades (symbol);
create index trades_status on trades (status);
-- GET /api/trades: newest opened_at first (id breaks ties: ObjectIds are time-ordered).
create index trades_opened_at on trades (opened_at desc, id desc);

-- trade_log: one row per trade EVENT (entry, exit). Append-only: never read, updated or
-- deleted by the app, and deliberately not a foreign key, so the record of a trade
-- survives deleting the trade.
create table trade_log (
	id            text primary key collate "C" check (id ~ '^[0-9a-f]{24}$'),
	trade_id      text not null collate "C",
	symbol        text not null collate "C",
	name          text not null default '',
	is_index      boolean not null default false,
	lot_size      double precision not null default 0,
	event         text not null check (event in ('entry', 'exit')),
	at            timestamptz not null,
	-- ITradeLogLeg[] in the stored (schema) key order, each leg with Kite's untouched
	-- `raw` charge object.
	legs          json not null default '[]',
	value         double precision not null default 0,
	-- {brokerage, stt, exchange_txn, sebi, stamp_duty, gst, total}
	charges       json not null,
	source        text not null default 'kite' check (source in ('kite', 'kite_estimate', 'unpriced')),
	margin        double precision,
	gross_pnl     double precision,
	total_charges double precision,
	net_pnl       double precision
);
create index trade_log_trade_id on trade_log (trade_id);
create index trade_log_symbol on trade_log (symbol);
create index trade_log_at on trade_log (at);
