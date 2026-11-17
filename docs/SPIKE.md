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
chart and the arm/VWAP signal; entries sell the ATM strike nearest index spot
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

Premium and VWAP are plotted on **separate charts**. An absent/zero leg average
does not become an invented VWAP; qualification waits for both leg averages.
Ticker-only/OI-only packets do not refresh an old average as if it were new.

The backend uses one fixed, dedicated Dhan FULL-feed socket for the two chains,
separate from the browser/Fair Value and Synthetic lanes. It also keeps the legs
of open Spike paper positions subscribed until manual close. Token replacement,
logout and broker-generation changes recycle/fence this lane.

## Exact entry rule: arm, VWAP touch or cross, then attribute

The chart's straddle is the **minimum-premium** pair above. It is only the
signal; the traded short strike is the **ATM strike nearest index spot**.

1. **Arm.** The minimum straddle premium is at least 5% above its lowest value
   in the preceding rolling 30 minutes. That low is the arm's reference.
2. **Trigger.** On the next fresh update after arming, the premium turns down at
   VWAP: it crossed above VWAP and comes back below it, or it touched VWAP from
   below (within ₹1) and bounces back down. Any lower tick counts as the bounce.

   ```text
   previous premium >= previous VWAP − ₹1
   current premium  <  current VWAP
   current premium  <  previous premium
   ```

3. **Attribute the cause.** Compare index spot at the reference low with index
   spot at the trigger, i.e. the move that pushed the straddle up into VWAP.
   - Spot rose → **call credit**: sell one lot of the ATM CE, buy the CE four
     listed strikes higher.
   - Spot fell → **put credit**: sell one lot of the ATM PE, buy the PE four
     listed strikes lower.
   - Flat or stale spot (baseline older than 5 minutes before the low, current
     older than 1 minute) skips the entry and consumes the arm.

ATM is the listed same-strike CE + PE nearest spot at the trigger; an exact
midpoint tie takes the lower strike. Example: NIFTY low at spot 23,850, arms at
23,900, touches VWAP and turns down at 23,880 → spot rose, so with spot 23,880
and 50-point strikes the spread is short 23,900 CE / long 24,100 CE.

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
- A restart/reconnect does not replay a historical crossover into a new entry.
  Qualification needs a fresh live previous/current pair; a price gap longer than
  one minute cannot be treated as an observed crossover.
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
