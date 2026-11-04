# Spike — implementation, Jev review and verification

Date: 2026-11-04 · Task: `2026-11-04-spike-paper-straddles`

## Delivered locally

- `/spike` navigation/page for NIFTY and SENSEX with separate premium/VWAP plots,
  1m/5m/30m/1h history, live values, paper controls, positions and manual P&L.
- Continuous backend-owned Dhan FULL WebSocket monitoring on a dedicated chain
  lane; browser visits are not needed for collection or qualifying paper entries.
- Minimum same-strike CE+PE selection across each index's nearest live expiry.
  VWAP is the selected CE/PE Dhan day-average-price sum.
- Exact price-driven crossover qualification: the directional 5% move must already
  qualify against an earlier premium within the rolling, inclusive 30-minute window.
- One actual lot per leg; only the primary fourth-higher CE/fourth-lower PE hedge,
  one open spread per index. Entry strikes remain fixed until manual two-leg exit.
- Executable short-bid/hedge-ask entries and short-ask/hedge-bid exits, fresh
  readable depth/size requirements, live/stale gross marks and durable paper records.
- Existing PostgreSQL/Dhan configuration reused. Migration `0007_spike.sql` adds
  three tables; no additional application environment variables or dependencies.

Rules, formulas, data boundaries, controls and endpoints are in
[docs/SPIKE.md](../docs/SPIKE.md).

## Jev was used during the build

Two actual TypeSafe requests, each with seven atomic Noul questions, returned
`jev-1.14.0`. State contained generated fixture screenshots and focused rule text.
The first review identified chart-axis clipping and an unstated downward lookback.

| Proposition | Baseline probability | Revised probability |
|---|---:|---:|
| Desktop chart time labels are clipped | 0.80 | 0.08 |
| Mobile NIFTY chart time labels are clipped | 0.51 (unsettled) | 0.11 |
| Downward rule explicitly states its 30-minute window | 0.13 | 0.99 |
| Upward rule requires the move at the crossover | 0.94 | 0.95 |
| Delayed-confirmation negative case requires the move at the crossover | 0.09 | 0.08 |

Browser geometry independently reproduced all four clipped desktop endpoint labels.
The fix anchors fitted endpoint text inside the canvas. Revised browser checks
measured every desktop/mobile axis label inside its SVG. The downward rule now
states the price-driven timing and rolling reference window explicitly. The same
question wording/criteria/0.3–0.7 thresholds were used on the revised page.

Total usage: **16,295 input / 306 free output tokens**, estimated
**US$0.000684390** at US$0.042/Mtok input; **US$0.009315610** remains from the
US$0.01 allowance. Zero retries or unknown usage. The unavailable SDK was handled
with the live-documented HTTP API from a scratch TypeScript script.

[Actual Jev response/usage receipt](../../Cal_Spread/outputs/2026-11-04-spike-jev-review.json)
includes request hashes and local exact-payload/assets paths. Arithmetic, date
comparisons, minimum selection, fills and P&L are implemented/tested in code.

## Meaningful correctness cases

- Exact ±5% boundary; any prior price, 29-minute and inclusive 30-minute references;
  expired reference, insufficient move, VWAP-only cross, stale gap and delayed entry.
- Monotonic rolling extrema compared with a brute-force full-window oracle.
- Both indexes' minimum selection, actual fixture lot sizes, fourth-listed hedges,
  no duplicate open primary spread, manual gross P&L and restart restoration.
- Invalid new average cannot reuse an old VWAP; unreadable one-lot entry size is
  skipped and cannot fill later without a fresh crossover.
- Crossed/missing/nonfinite closing books and insufficient sizes keep the spread
  open and its last finite mark stale; a restored valid book permits manual exit.
- Exact-minute ticks cannot overwrite the completed previous minute's history.
- Dedicated lane isolation/token replacement and internal Dhan update provenance.
- Full/trade authorization, public rejection, saved control, frames and snapshot SSE.
- Weekend-safe verification fixture clock, tested for Saturday/Sunday/Monday.

## Commands and results

Backend commands use the existing repository-local tools wrapper:

```bash
bash scratch/dhan-default-check/check.sh env GOPROXY=off TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' make check
bash scratch/dhan-default-check/check.sh env GOPROXY=off make build
bash scratch/dhan-default-check/check.sh env GOPROXY=off go mod tidy -diff
git diff --exit-code -- go.mod go.sum .env.example internal/parity/testdata
```

All exited **0**. Final full suite: **34 tested packages**, mandatory PostgreSQL
tests/race detector, build/vet/format/module checks and standalone binary.
Locked dependencies, environment example and frozen reference fixtures unchanged.

Frontend commands:

```bash
npm run build
npm test
bash ../Cal_Spread_Backend/scratch/dhan-default-check/check.sh npm run test:go
bash ../Cal_Spread_Backend/scratch/dhan-default-check/check.sh env FIREFOX_BIN=/snap/firefox/current/usr/lib/firefox/firefox GECKODRIVER_BIN=/snap/firefox/current/usr/lib/firefox/geckodriver npm run test:spike:browser
bash ../Cal_Spread_Backend/scratch/dhan-default-check/check.sh env FIREFOX_BIN=/snap/firefox/current/usr/lib/firefox/firefox GECKODRIVER_BIN=/snap/firefox/current/usr/lib/firefox/geckodriver npm run test:browser
git diff --exit-code -- .env.example package-lock.json
```

All exited **0**: TypeScript/Vite build, **37 tests**, **8 real-Go HTTP groups**,
**6 Spike browser checks** and **14 existing browser checks**, Firefox 157.0.
Spike checks include all four timeframes, both real binary-feed paper entries,
saved control, manual exit/P&L, private-request gating and no remote upstream calls.
All **20 desktop / 12 mobile axis labels** fit their SVG; mobile width 390 and
scroll width 378. Browser fixtures must run sequentially to avoid Firefox BiDi
port sharing. The narrowly recognized navigation cancellation follows verification
that the actual snapshot stream opened and delivered frames.

Evidence retained under frontend `scratch/go-integration/`:

- `spike-browser-L4L9a0/`: final Spike workflow/report/screenshots used by Jev recheck.
- `browser-r0uIlH/`: final existing-workflow regression/report/screenshots.
- `scratch/jev-spike-review/{baseline,revised}/`: exact TypeSafe requests/results,
  prepared PNGs and image/hash manifests, relative to frontend root.

The final PostgreSQL inspection found **zero non-system test schemas**.
Tool caches, PostgreSQL data, compiled output and browser evidence are retained.

## Publication

Both remote mains were fetched before publication and still matched the clean
baselines: backend `1586c24`, frontend `4749fd0`. Source publication and matching
GitHub CI are the remaining step; this section will record their actual results.

## Operator rollout

After both verified mains are published, run the existing configured VM script as
`calspread`, with both VM checkouts clean/on main:

```bash
/home/calspread/Cal_Spread_Backend/scripts/deploy.sh
```

The script pulls/builds both mains and restarts/rechecks the configured service.
Then open `https://calspread.online/spike` with full/trade access. The service uses
the existing Dhan session/database and applies the embedded migration at startup.
