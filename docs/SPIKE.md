# Spike — NIFTY and SENSEX minimum-straddle paper monitor

Spike is available from the **Spike** button on the CalSpread board and at
`/spike`. Full-admin and trade-access users can view it, pause/resume paper
entries and manually close paper spreads. The backend monitors continuously,
including when this page is closed.

## Configuration and simple controls

**No new environment variables are required.** Spike reuses the existing Dhan
session and PostgreSQL configuration. The strategy rules below are fixed: a
rolling 30-minute reference window, a minimum 5% move, one lot, and a fourth-OTM
hedge. The page's paper-enabled setting is stored in PostgreSQL.

- **Pause paper entries** keeps data collection and existing position P&L active.
- **Resume paper entries** allows new qualifying crossovers to open paper spreads.
- **Close paper spread** closes both legs using current executable quotes.
- The first version keeps **one primary open paper spread per index**, so NIFTY
  and SENSEX can each have their own spread. A later entry needs a fresh qualifying
  crossover after that index's existing position is closed.

Paper entries default to enabled once the backend is running with a usable Dhan
session and PostgreSQL. Charts can collect in memory without a database, but
durable paper entries and the saved control require PostgreSQL.

## What “ATM straddle” means here

For this feature, ATM follows the requested **minimum-premium definition**:

1. Resolve the nearest live expiry independently for NIFTY and SENSEX.
2. For each strike having both a CE and PE in that same expiry, add their LTPs.
3. Select the strike with the smallest valid `CE LTP + PE LTP`.

This is not necessarily the strike nearest spot, and it is only used for the
chart and the qualification/pin signal; entries sell the ATM strike nearest index spot
(see the entry rule below). A tie chooses the lower listed
strike deterministically. Candidate legs need positive, finite prices received
within the last minute. No arbitrary strike band is substituted for the chain.
The selected strike may change as prices change; an entered spread retains its
original contracts and expiry.

## VWAP and separate charts

Dhan's QUOTE/FULL packets contain each contract's **average traded price**, its
day-volume-weighted average. For the currently selected minimum pair:

```text
minimum straddle premium = CE LTP + PE LTP
straddle VWAP baseline   = CE day average traded price + PE day average traded price
```

The live header's **signal VWAP** is this Dhan average-price sum and is display
only. Missing or invalid leg averages leave that displayed value unavailable;
they do not block qualification, pinning or entry. Ticker-only/OI-only packets do
not refresh an old average as if it were new.

The **chart VWAP** is a separate cumulative volume-weighted figure. The existing
chart calculation stamps each completed one-minute bar with its VWAP, weighting
the rounded selected-pair premium by the smaller CE/PE minute-volume delta. All
pin and entry decisions use the latest completed bar's stamped `bar.VWAP` at
that sample's time, including restored bars. The line steps only on completion;
it never reads the in-memory accumulator or a forming bar. An invalid latest
stamp fails closed rather than falling back to an older valid stamp. Without a
completed chart bar with valid VWAP, the note is “Waiting for first completed
chart bar with valid VWAP”; +5% qualification can still latch while pin/entry wait.
`IndexView.chart_vwap` exposes the completed chart line when available, while
`Current.vwap` remains the Dhan sum. `Signal.vwap` records chart VWAP at entry.

The backend uses one fixed, dedicated Dhan FULL-feed socket for the two chains,
separate from the browser/Fair Value and Synthetic lanes. It also keeps the legs
of open Spike paper positions subscribed until manual close. Token replacement,
logout and broker-generation changes recycle/fence this lane.

## Exact entry rule: qualify, pin direction, enter on a downward chart cross

The chart's straddle is the **minimum-premium** pair above. The traded short
strike is always the **ATM strike nearest index spot at entry**.

1. **Qualify and latch.** The premium reaches at least 5% above its lowest
   observed value in the preceding rolling 30 minutes (`WindowMs`). Qualification
   requires no VWAP condition and does not expire when the low ages out or the
   premium falls below +5%. Until a direction is pinned, the reference low keeps
   sliding with the window.
2. **Pin the first direction.** While qualified, the first cross of chart VWAP
   in either direction between consecutive evaluated samples, or a touch within
   ₹1 on either side (`TouchBand`), pins direction. Cross samples must be at most
   60 seconds apart. Compare index spot at the reference low **as of this pin**
   with spot now:
   - Spot rose → pin **SHORT**, a bearish **CALL_CREDIT** spread.
   - Spot fell → pin **LONG**, a bullish **PUT_CREDIT** spread.
   - Flat, missing or stale spot skips and consumes qualification/the pin. The
     baseline must be at/before the low and no more than 5 minutes older; current
     spot must be at/before the pin and no more than 60 seconds older.

   First pin wins. Its direction, reference and baseline stay fixed until entry
   or day end. Later touches, spot reversals and rolling-low changes cannot
   change it. Qualification and pin may coincide on the same evaluated sample.
3. **Enter on the first downward chart-VWAP cross after pinning.** There is no
   +5% re-check or reference-age expiry. The existing price-driven touch-and-fall
   shape applies, using the chart line available at each sample's own time:

   ```text
   previous premium >= previous completed chart VWAP − ₹1
   current premium  <  current completed chart VWAP
   current premium  <  previous premium
   current time − previous time is between 0 and 60 seconds inclusive
   ```

   If this is also the pinning cross, pin and entry coincide immediately. Every
   entry trigger consumes the latch, including a skipped paper entry. A later
   trade needs a fresh qualification. A pin consumed by flat/stale spot cannot
   supply direction to a later cross.
4. **Sell ATM, buy the fourth hedge.** Use fresh spot at entry to select the
   nearest listed same-strike CE + PE pair (an exact midpoint tie takes the lower
   strike). SHORT sells one lot of its ATM CE and buys the fourth higher listed
   CE. LONG sells one lot of its ATM PE and buys the fourth lower listed PE.
   Both directions sell the ATM leg. Direction comes from the pin, while the
   exact ATM contracts come from spot at entry.

### 19 November 2026 worked check

The deterministic Go fixture `TestNineteenNovemberSensexDirectionPin` uses the
supplied observations plus explicit intermediate ticks to establish sequence:

- SENSEX low **393.15 at 09:37:51 IST**; **422.05 at 09:38:33** is +7.3509%,
  latching qualification. An unqualified upward cross just before that tick
  cannot pin direction.
- With completed chart VWAP about **410.4**, **410.45 at 09:53:35** touches and
  pins SHORT: reference spot **81,955** rose to about **82,165**. The **412.50 at
  09:53:39** then **408.90 at 09:53:40** samples produce entry at **09:53:40 IST**.
  Entry is already below +5% and still fires.
- The shape is **short spot-ATM CE + buy fourth higher CE**, one lot. The fixture
  exercises spot on both sides of 82,150 without requiring a single ATM strike.
- Separate no-cross continuations preserve both unpinned qualification and the
  first pin through **10:07:52**, the old reference-expiry time. The actual
  worked sequence has already consumed its pin at 09:53:40.
- The NIFTY fixture crosses/touches its chart line but stays below +5%; it emits
  no signal. This is a focused supplied-data check, not a complete historical
  feed replay or independent verification of every NIFTY tick on that date.

The fourth strike is counted from the actual listed ladder; spacing is not
hardcoded. Both contracts must have the same positive integer lot size. Lot
sizes come from the instrument master rather than assuming a permanent NIFTY or
SENSEX quantity.

## Paper fills, P&L and manual exit

All trades are paper records. Entry uses the observed **short bid / hedge ask**;
exit uses **short ask / hedge bid**. Both sides need fresh depth (15 seconds),
enough displayed size for one lot, readable/non-crossed books and a credit-spread
entry. If a qualifying update lacks this evidence, the entry is skipped rather
than filled optimistically later.

```text
entry credit = quantity × (short entry bid − hedge entry ask)
gross P&L    = quantity × [(short entry bid − current short ask)
                          + (current hedge bid − hedge entry ask)]
```

The same formula becomes realized P&L at manual close. **P&L is gross paper P&L**;
fees, brokerage and taxes are excluded. Missing closing liquidity leaves the
position open. Last valid marks are labelled stale when current depth is absent.
There is no time-based, profit-target or stop-loss exit: the operator closes it.
The 30-minute rule limits signal qualification, not how long a position is held.

## History, restart and data boundaries

- One-minute observations are saved to PostgreSQL; 5m, 30m and 1h views group the
  last completed minute observations into IST-aligned buckets.
- Live values above the plots update from the feed; chart points are completed
  buckets. A larger timeframe needs its first completed bucket before it appears.
- Collection starts when valid quotes arrive after the service begins monitoring;
  it does not fabricate earlier prices. The page reports “Recording since”.
- Minute lows/highs and their actual observation timestamps preserve the rolling
  reference extrema across restart, rather than replacing them with just closes.
- Open trades, entry contracts/prices, paper-enabled control, closed-today records
  and today's minute history restore after restart.
- Qualification and direction pins are in-memory day state. An unchanged
  five-minute instrument refresh preserves them, the spot history, previous
  sample and evaluated note. Feed/runtime resets discard quote/spot continuity
  but preserve the day latch and any pinned direction. A new day clears them;
  a process restart cannot restore an unentered pin from persisted bars.
  A restart/reconnect does not replay a historical crossover into a new entry;
  a price gap longer than one minute cannot be treated as an observed crossover.
- Monitoring and entries require active Dhan data. Old broker-generation packets
  and queued candidates are rejected. Open paper contracts stay fixed while the
  minimum changes or the nearest monitored expiry rolls forward.

## API and verification

All Spike endpoints require an existing full/trade admin session:

| Endpoint | Purpose |
|---|---|
| `GET /api/spike/status` | Current values, rules, paper control, positions and closed-today P&L |
| `GET /api/spike/series?symbol=NIFTY&frame=1m` | Completed history (`NIFTY`/`SENSEX`; `1m`/`5m`/`30m`/`1h`) |
| `POST /api/spike/paper` with `{enabled}` | Persist pause/resume of paper entries |
| `POST /api/spike/trades/{id}/close` | Manual two-leg paper exit |
| `POST /api/spike/trades/{id}/delete` | Delete an open or closed paper trade record |
| `GET /api/spike/stream` | Bounded snapshot SSE; upstream market data remains Dhan WebSocket |

Database migration `0007_spike.sql` adds `spike_bars`, `spike_trades` and
`spike_control`, including a one-open-spread-per-index unique index and one-lot
quantity constraints. Tests use generated loopback data and isolated PostgreSQL
schemas. Standard commands are backend `make check`/`make build`, frontend
`npm run build`/`npm test`, and the documented Go HTTP/browser workflows.

The build also used Jev's typed visual/language judgments over generated fixture
screenshots and focused rule wording. Confirmed findings corrected endpoint-label
clipping and clarified the downward lookback; browser bounds independently verify
the chart fix. See [the implementation/verification report](../outputs/2026-11-04-spike-paper-straddles.md)
and its linked actual model/usage receipt.
