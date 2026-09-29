# Futures vs synthetic futures arbitrage

The listed future is compared against the synthetic future built from the same-expiry
option pair, **K + CE(K) − PE(K)**. The strike K is restricted to **ATM, ATM±1, ATM±2
or ATM±3** (`strike_level` 1/2/3). While RUN is on, ELIGIBLE opportunities are opened
automatically as one-lot **paper** positions and closed by the exit rules below. Nothing
can send a real order.

## Trades priced

| Direction | When | Legs (1 lot each) | Locked per unit (at the touch) |
|---|---|---|---|
| CONVERSION | future cheap | BUY FUT, SELL CE(K), BUY PE(K) | `K + CE.bid − PE.ask − FUT.ask` |
| REVERSAL | future rich | SELL FUT, BUY CE(K), SELL PE(K) | `FUT.bid − K − (CE.ask − PE.bid)` |

- **Carry** (`SYNTH_INCLUDE_CARRY`): the net option premium is financed to 15:30 IST on
  expiry at the admin rf, using simple interest. On a conversion the premium is received
  (`+`), on a reversal it is paid (`−`). Carry is part of the entry gate only; realised
  P&L is the legs' price move.
- **Expected net** = gross − entry charges − estimated exit charges (unwind priced at entry)
  − slippage − safety buffer. **ELIGIBLE** means expected net ≥ `min_expected_net_profit`
  and all three legs show a full lot at the touch within the freshness window.
- **Mid basis** `F_mid − (K + CE_mid − PE_mid)` is shown for context only. It is never
  used for a decision.

## Rules

- The option expiry must equal the future expiry. The nearest future is paired first.
  Index weeklies have no future, so they are never used.
- Prices come from the executable touch only: a BUY pays the ask, a SELL receives the
  bid. An empty side or a short lot rejects the strike. LTP is used only in the
  market-shut **INDICATIVE** view (legs that traded in the latest session) and for the
  broker-screen mark of open positions.
- If the option lot differs from the future lot, the underlying is skipped.
- The ATM window is centred on the future's mid price, with the same hysteresis and
  minimum re-centre interval as Box.

## Paper trading

**Entry** (scanner running, market open, feed live, `synth_trades` storage connected):
- the opportunity is ELIGIBLE on `SYNTH_SIGNAL_CONFIRMATIONS` consecutive evaluations
  over NEW books (default 2). A confirmation needs a leg's book version to change, so
  a quiet tick or a settings change confirms nothing, and one flickering book cannot
  open a position;
- at most one open position per underlying (also enforced by a unique Mongo index), and
  `SYNTH_REENTRY_COOLDOWN_MS` after an underlying's last close;
- at most **max open trades** in total. It is set on the page (any whole number, `0` = no
  limit, the default) and saved. Lowering it never closes a position; it only stops new
  entries;
- room in the token budget for the new position's three legs. Open legs are never dropped,
  so this only binds when `SYNTH_MAX_TOKENS` is set very low (`token_budget`);
- no entries on expiry day inside the expiry-safety window;
- filled at exactly the touch it was priced at (BUY at ask, SELL at bid), one lot.

**Fills are LIMIT orders at the best bid / best ask.** Every leg is priced as a limit
order at the touch (best ask to buy, best bid to sell) and is only sent when at least
one lot rests at that price, so it fills in full at its limit. Never a market order, and
never a deeper level. A leg is refused if its side is empty, if less than a lot rests at
the touch, if its book is older than `SYNTH_QUOTE_MAX_AGE_MS`, or if the book is crossed
(best bid ≥ best ask: an inconsistent snapshot whose touch is not really available).
Exits are closing limit orders on the same rule, so a crossed book also holds an exit
(expiry safety included) until it uncrosses. Each leg stores the evidence for its entry
and exit fills: best bid and best ask with their quantities, the quantity at the limit
price, the book's age, and the top five levels a side (`entry_*` / `exit_*`). The page
checks every fill against that recorded book: the limit equals the best level on its
side, at least one lot rests there, and the book is not crossed. Trades stored before the
book was recorded show "not recorded".

An ELIGIBLE row that is not entered carries `entry_blocked` with the reason. The row of
a held position shows status `OPEN`.

**Exit**: Box's rules, on the same quantities. `entry edge` = lock × quantity (the gross
if held to expiry). `gross now` = closing all three legs at the touch. `remaining edge` =
entry edge − gross now. `net` = gross now − entry charges − exit charges at those prices.

| Reason | When |
|---|---|
| `EDGE_CONVERGED` | remaining ≤ max(`SYNTH_CONVERGENCE_FLOOR`, `SYNTH_CONVERGENCE_PCT` × entry net edge) and net ≥ `SYNTH_MIN_EXIT_NET_PNL` |
| `PROFIT_CAPTURE` | net ≥ `SYNTH_MIN_EXIT_NET_PNL` and (net ≥ `SYNTH_PROFIT_CAPTURE_PCT` × entry net edge, or gross ≥ `SYNTH_MIN_CAPTURED_PCT` × entry edge) |
| `EXPIRY_SAFETY` | expiry day, from `SYNTH_EXPIRY_SAFETY_MINUTES` before 15:30 IST, at the touch whatever the P&L |
| `EXPIRED` | still open after expiry (e.g. no liquidity or the server was down): settled at the lock, with the entry-time unwind estimate as exit charges |
| `MANUAL` | "Close now" (`POST /trades/:id/close`), at the touch |

- A position that has converged into a loss is held: the lock still pays at expiry.
- Rule exits also need `SYNTH_SIGNAL_CONFIRMATIONS` evaluations over new books; expiry
  safety acts at once.
- No exit is ever filled at an invented price. If a leg has no book or less than one lot
  at the touch, the position stays open and says why.
- Open positions are monitored with the scanner stopped and are adopted again after a
  restart. Legs are always re-resolved by (underlying, expiry, strike, type) in the
  active broker's instruments, never trusted by token: an adopted position is unlinked
  (shown, not subscribed) until that succeeds, retried every 10 s.
- Broker switch, Dhan logout or lost session: the scanner releases its whole lease and
  forgets every token. No refresh starts while a switch is in progress, and a refresh
  that sees the broker generation change mid-flight is discarded, so an old-broker token
  is never subscribed on the new socket. The switch's own reload re-links the positions.

**Margin**: right after entry, and off the fill path, the three legs are sent together
to the ACTIVE broker's basket-margin calculator, the same one Box uses:
- Zerodha: `/margins/basket`;
- Dhan: `/margincalculator/multi`, or a flagged per-leg sum if that fails.

The orders are the exact limit orders filled, with product `NRML`, so the future/option
hedge is recognised. The basket is asked on its own (`considerPositions: false`, i.e.
Kite `consider_positions=false`), so real positions in the account cannot shrink a paper
trade's figure. It is stored on the trade as `margin`, `margin_source`,
`margin_hedge_benefit` and `margin_at`:
- a failed fetch is retried (3 attempts, then up to 3 sweeps 60 s apart). A sweep counts
  only when the broker is actually asked, so a session outage uses up none;
- the failure reason is stored in `margin_error`. It is shown as unavailable, never as ₹0;
- trades opened on another broker are not re-margined, because their tradingsymbols use
  that broker's naming. They say so in `margin_error`;
- margin is never written onto a deleted row.

`day_pnl` carries `open_margin`, the margin the open positions block now, and
`closed_margin`, a day sum over today's closes.

**Delete** (`DELETE /api/synthetic/trades/:id`, full admin, 20/min, body
`{ reason?, expected_status? }`) removes a paper trade, open or closed, from every list,
count, P&L and margin figure:
- it is a SOFT delete: the row stays as `status: "deleted"` with the admin role, the
  time and the reason;
- an open position stops being monitored and its tokens are released;
- its underlying waits out `SYNTH_REENTRY_COOLDOWN_MS`, so the scanner does not
  reopen the same trade at once;
- `expected_status` is the status the confirmation showed. A position that closed while
  the dialog was open is refused (409), not deleted with the P&L it just booked. It is
  also refused while an exit is in flight;
- it is safe to retry. A write whose answer was lost is reconciled from the stored row,
  and deleting an already-deleted trade returns ok with `already_deleted: true`;
- a load or close that was in flight cannot bring a deleted trade back.

**P&L** follows `.kiro/steering/trade-realism.md` in the frontend: open positions are marked
to LTP (price move only). Charges are shown beside P&L, and "net" figures are labelled as
after charges. The day strip shows the open mark at LTP, the open net if closed now at the
touch, today's realised net, and the day net.

## Token budget: sharing Box's lane

Tokens ride the **Box market-data lane** under the `scanner` owner
(`ActiveBrokerManager.setSyntheticTokens`), refcounted apart from Box's `strategy` owner.

| Box scanner | Synthetic budget |
|---|---|
| running | `SYNTH_MAX_TOKENS` (750) |
| stopped | `SYNTH_MAX_TOKENS` + (`BOX_MAX_SUBSCRIBED_TOKENS` − tokens Box still holds for its open positions), up to 2950 by default |

Both are capped at `SYNTH_LANE_TOKEN_LIMIT` minus Box's reservation (its whole budget
while it runs). Box always has priority. `index.ts` calls `yieldToBox()` synchronously
before Box's token set goes upstream, so when Box starts the synthetic scanner drops its
lowest-priority windows first (indices are kept longest) and the socket never exceeds the
limit. When Box stops, the freed budget is picked up within a few seconds. Open positions'
legs (3 tokens each) are reserved first and never dropped.

Box only receives lane ticks for tokens it holds (`SubscriptionCoordinator.owns`), so the
scanner's books never enter Box's quote store or liveness clock. Books go into the
scanner's own `BoxQuoteStore`.

## Architecture

`src/synthetic/`:
- `math.ts`: pure pricing, universe, exit rules, settlement and day P&L.
- `config.ts`: `SYNTH_*` settings, see `CONFIGURATION.md`.
- `engine.ts`: one loop driving discovery (running) and monitoring (open positions).
- `model.ts`, `repository.ts`: `synth_trades` on the Box connection.
- `routes.ts`: HTTP routes.

Persistence (`synth_trades`, Box connection): one document per trade, `status`
`open|closed|deleted`. The unique partial index `synth_open_one_per_underlying` allows one open
position per underlying. `autoIndex` is off: the index is created and read back at boot
(`ensureReady`), the way the Box reservation store does it. Until that succeeds, entries
are paused with `paper_blocked_reason: "unsafe_index"`, while open positions are still
monitored and closed. Closing is a single `$set` guarded on `status: "open"`, so two
racing closes can never both land. A close that loses that race, or an insert rejected as
a duplicate, is reconciled with the stored row. Without MongoDB the scanner still detects,
but it does not paper-trade (`paper_blocked_reason: "no_db"`), like Box.

Settings (`synth_settings`, Box connection, one row per key like `box_settings`): the
entry gate, safety buffer and max open trades. They are changed on the page and saved in
one write. If the save fails, the change is rolled back and reported (503). A saved value
overrides the env default at boot, and paper entries wait until saved settings are loaded.
With storage down, a change applies to the running process only (`persisted: false`) and
is saved once storage connects; it is not overwritten by older saved values.

## API (admin token required, `x-admin-token`)

| Method | Path | Body / query |
|---|---|---|
| GET | `/api/synthetic/status` | |
| POST | `/api/synthetic/start` · `/stop` | |
| POST | `/api/synthetic/strike-level` | `{ level: 1\|2\|3 }` |
| POST | `/api/synthetic/settings` | `{ min_expected_net_profit?, safety_buffer?, max_open_positions? }` (0 = no limit) → `{ persisted, status }`; saved |
| GET | `/api/synthetic/opportunities` | `?limit=` |
| GET | `/api/synthetic/trades/open` | → `{ db_enabled, open }` with live marks |
| GET | `/api/synthetic/trades/history` | `?scope=today\|all&limit=` → `{ db_enabled, scope, trades }` |
| POST | `/api/synthetic/trades/:id/close` | 409 with the reason when a leg cannot be closed at the touch |
| DELETE | `/api/synthetic/trades/:id` | full admin; `{ reason?, expected_status? }` → `{ deleted_id, deleted_from, already_deleted, status, open, closed_today }`; 409 when it changed state or is closing |
| GET | `/api/synthetic/chain/:underlying` | |
| GET | `/api/synthetic/stream` | SSE `snapshot` `{status, opportunities, open_trades}`, plus `entry` / `exit` `{trade}` and `trade_deleted` `{id, from}`. Token in `?x-admin-token=` |

The snapshot carries at most `SYNTH_MAX_PUBLISHED_OPPORTUNITIES` rows: every ELIGIBLE and
OPEN row, then the best row per underlying. The status counts always cover every row.

## Known modelling gaps

- Paper fills assume all three legs fill at the observed touch at once. Real execution
  has inter-leg latency and legging risk. Live execution would need Box's durable
  gateway (hedge-first order, reservations, three-leg basket margin, partial-fill unwind).
- Futures margin financing is not included.
- Exercise STT and physical-delivery charges at expiry are not modelled. `EXPIRED` trades
  use the entry-time unwind estimate instead.
- Dividends before expiry are not modelled. They move the stock-future fair value, but
  not parity between a same-expiry future and its options.
