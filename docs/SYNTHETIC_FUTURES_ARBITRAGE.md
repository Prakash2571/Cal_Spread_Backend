# Futures vs synthetic futures arbitrage

The listed future is compared against the synthetic future built from the same-expiry
option pair, **K + CE(K) − PE(K)**. The strike K is restricted to **ATM, ATM±1, ATM±2
or ATM±3** (`strike_level` 1/2/3).

## Trades priced

| Direction | When | Legs (1 lot each) | Locked per unit (at the touch) |
|---|---|---|---|
| CONVERSION | future cheap | BUY FUT, SELL CE(K), BUY PE(K) | `K + CE.bid − PE.ask − FUT.ask` |
| REVERSAL | future rich | SELL FUT, BUY CE(K), SELL PE(K) | `FUT.bid − K − (CE.ask − PE.bid)` |

- **Carry** (`SYNTH_INCLUDE_CARRY`): the net option premium is financed to 15:30 IST on
  expiry at the admin rf, using simple interest. On a conversion the premium is received
  (`+`), on a reversal it is paid (`−`).
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
  market-shut **INDICATIVE** view, and only for legs that traded in the latest session.
- If the option lot differs from the future lot, the underlying is skipped.
- The ATM window is centred on the future's mid price, with the same hysteresis and
  minimum re-centre interval as Box.

## Architecture

`src/synthetic/`:
- `math.ts`: pure pricing and universe logic.
- `config.ts`: `SYNTH_*` settings, see `CONFIGURATION.md`.
- `engine.ts`: scanner lifecycle.
- `routes.ts`: HTTP routes.

- Tokens ride the **Box market-data lane** under the `scanner` owner
  (`ActiveBrokerManager.setSyntheticTokens`). They are refcounted apart from Box's
  `strategy` owner. Books go into the scanner's own `BoxQuoteStore`, so Box books are
  never touched.
- A broker switch or a lost session stops the scanner, and a lane reconnect invalidates
  its books.
- Nothing is persisted. Runtime threshold changes last until restart.

## API (admin token required, `x-admin-token`)

| Method | Path | Body / query |
|---|---|---|
| GET | `/api/synthetic/status` | |
| POST | `/api/synthetic/start` · `/stop` | |
| POST | `/api/synthetic/strike-level` | `{ level: 1\|2\|3 }` |
| POST | `/api/synthetic/settings` | `{ min_expected_net_profit?, safety_buffer? }` |
| GET | `/api/synthetic/opportunities` | `?limit=` |
| GET | `/api/synthetic/chain/:underlying` | |
| GET | `/api/synthetic/stream` | SSE `snapshot` `{status, opportunities}`, token in `?x-admin-token=` |

## Scope and next phases

This phase is **detection only**. Possible next phases:
1. Paper positions: record ELIGIBLE entries, then mark to market until expiry or convergence.
2. Live execution through Box's durable gateway: hedge-first leg order, reservations,
   basket margin for all three legs, and partial-fill unwind.

Known modelling gaps:
- Futures margin financing is not included.
- Physical-settlement STT on ITM stock options held to expiry is not included, because
  the exit estimate assumes an unwind instead.
- Dividends before expiry are not modelled. They move the stock-future fair value, but
  not parity between a same-expiry future and its options.
