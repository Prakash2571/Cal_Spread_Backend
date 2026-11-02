-- Captures (src/eodCapture.ts, src/hourlyCapture.ts): hourly current/mid/far futures
-- prices, NSE F&O stock-futures EOD rows, daily calendar spreads and the per-symbol
-- spread summary. Field names follow the MongoDB collections. Mongo Dates (UTC midnight
-- instants) are timestamptz, truncated to milliseconds on write; numbers are double
-- precision; text used in comparisons or ordering is COLLATE "C" (bytewise, like Mongo).
-- Internal tables use an identity id, so "order by id" is the Mongo natural order; only
-- spread_summary exposes its id (GET /api/spread-stats/:symbol returns it as _id).

-- hourlyprices (Mongoose model HourlyPrice, pluralised collection name).
create table hourlyprices (
	id                  bigint generated always as identity primary key,
	symbol              text collate "C" not null,
	date                text collate "C" not null,   -- YYYY-MM-DD, IST
	time                text collate "C" not null,   -- HH:MM slot, e.g. 10:00, 15:40
	month               text collate "C" not null,   -- YYYY-MM
	current_month_close double precision not null,
	mid_month_close     double precision not null,
	far_month_close     double precision,            -- null when there is no far leg
	spread              double precision not null,   -- mid - current
	constraint hourlyprices_symbol_date_time unique (symbol, date, time)
);
-- Day review counts one IST date across the board's symbols.
create index hourlyprices_date on hourlyprices (date);

-- stock_futures: the old archive database (NSE_FNO_ARCHIVE_URI, read-only, data before
-- 2026) and the current one (NSE_FNO_CURRENT_URI) in one table. The app writes only
-- source = 'current'; reads route dates < 2026-01-01 to 'archive' and the rest to
-- 'current', exactly as the two connections did.
create table stock_futures (
	id            bigint generated always as identity primary key,
	source        text collate "C" not null check (source in ('archive', 'current')),
	trading_date  timestamptz not null,
	symbol        text collate "C" not null,
	instrument    text collate "C" not null default 'FUTSTK',
	expiry        timestamptz not null,
	open          double precision not null,
	high          double precision not null,
	low           double precision not null,
	close         double precision not null,
	settle_price  double precision not null default 0,
	contracts     double precision not null default 0,
	value_lakh    double precision not null default 0,
	open_interest double precision not null default 0,
	change_in_oi  double precision not null default 0,
	constraint stock_futures_source_symbol_date_expiry unique (source, symbol, trading_date, expiry)
);
create index stock_futures_source_trading_date on stock_futures (source, trading_date desc);

-- spread_daily: near/mid calendar spread per symbol and trading day.
create table spread_daily (
	id           bigint generated always as identity primary key,
	symbol       text collate "C" not null,
	trading_date timestamptz not null,
	near_expiry  timestamptz not null,
	mid_expiry   timestamptz not null,
	near_close   double precision not null,
	mid_close    double precision not null,
	spread       double precision not null,
	constraint spread_daily_symbol_trading_date unique (symbol, trading_date)
);
create index spread_daily_trading_date on spread_daily (trading_date desc);

-- spread_summary: recomputed in full from spread_daily. id is ObjectId-style and stays
-- stable across recomputes (Mongo replaceOne keeps _id); __v is not stored.
create table spread_summary (
	id                         text collate "C" primary key check (id ~ '^[0-9a-f]{24}$'),
	symbol                     text collate "C" not null,
	observations               double precision not null,
	first_date                 timestamptz not null,
	last_date                  timestamptz not null,
	mean_spread                double precision not null,
	max_spread                 double precision not null,
	min_spread                 double precision not null,
	mean_deviation             double precision not null,
	max_abs_spread             double precision not null,
	std_dev_spread             double precision not null,
	percentile_95              double precision not null,
	mean_reversion_probability double precision not null,
	constraint spread_summary_symbol unique (symbol)
);
create index spread_summary_last_date on spread_summary (last_date desc);
