-- Dhan NIFTY/SENSEX Spike history and one-lot PAPER credit spreads.
create table spike_bars (
    symbol text not null check (symbol in ('NIFTY', 'SENSEX')),
    day text not null,
    t bigint not null,
    payload jsonb not null,
    primary key (symbol, day, t)
);
create table spike_trades (
    id text primary key check (id ~ '^[0-9a-f]{24}$'),
    symbol text not null check (symbol in ('NIFTY', 'SENSEX')),
    status text not null check (status in ('open', 'closed')),
    opened_at bigint not null,
    closed_at bigint,
    closed_day text,
    payload jsonb not null,
    check ((payload->>'quantity')::integer = (payload->>'lot_size')::integer),
    check ((payload->>'quantity')::integer > 0)
);
create unique index spike_one_open_per_symbol on spike_trades (symbol) where status = 'open';
create index spike_closed_day on spike_trades (closed_day, closed_at desc);
create table spike_control (
    id text primary key check (id = 'current'),
    paper_enabled boolean not null,
    updated_at timestamptz not null default now()
);
