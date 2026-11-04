# Plan: Spike — NIFTY/SENSEX minimum-straddle paper spreads

Task: `2026-11-04-spike-paper-straddles` · Projects: Cal_Spread_Backend + Cal_Spread · Created: 2026-11-04 · Status: [STATUS.md](STATUS.md)

## Goal

Add a Spike navigation section/page that monitors NIFTY and SENSEX continuously
from Dhan WebSocket data. Select the same-strike CE/PE pair with minimum combined
premium across the nearest live expiry, plot its premium and VWAP separately at
1m/5m/30m/1h cadence, and automatically track primary fourth-OTM one-lot paper
spreads for qualified rolling-30-minute 5%/VWAP-cross scenarios. Positions close
when the operator explicitly closes them.

## Confirmed requirements

- NIFTY and SENSEX only; minimum CE+PE is the user's ATM-straddle definition.
- Continuous server-owned Dhan WebSocket monitoring, independent of page visits.
- Separate straddle and VWAP charts, trading-day timestamps, 1m/5m/30m/1h views.
- Rolling 30-minute comparison against any earlier observed straddle price;
  require at least a 5% directional move plus the matching VWAP crossover.
- Up signal: one-lot short CE at the selected minimum strike plus one-lot long CE
  four listed strikes higher, same expiry. Down signal: short PE plus long PE four
  listed strikes lower. Only these primary fourth-OTM spreads in the first version.
- Keep controls simple for both indexes. **No new environment variables.** Reuse
  existing broker/database configuration; fixed rules and persisted page controls.
- Paper entry/exit prices and P&L come from observed executable bid/ask data and
  actual contract lot sizes. Manual close preserves the entry strikes/expiry.
- Proper documentation of selection, VWAP, trigger timing, fills, P&L, controls,
  persistence, data gaps and testing.

## Exact timing and VWAP

- User selected **At crossover only**: the directional VWAP crossover is the
  triggering update, and the 5% move must already qualify against an earlier
  straddle value in the preceding rolling 30 minutes. No delayed post-cross entry.
- VWAP baseline will use Dhan's volume-weighted average traded prices for the two
  selected legs, summed together; the page plots this separately from premium.
- One primary open paper spread per index keeps controls simple; new entries
  require a distinct qualifying crossover after the current position is closed.

## Steps

1. Finalize timing rules and inspect feed metadata, subscription coordination,
   paper persistence, authentication and React chart/page patterns.
2. Implement server-owned minimum-straddle monitoring and minute/day history,
   preserving broker/generation and restart boundaries.
3. Implement one-lot primary paper credit spreads, exact signal deduplication,
   live mark-to-exit P&L and manual close with durable records.
4. Add Spike navigation, separate NIFTY/SENSEX premium/VWAP charts, timeframe
   controls and concise paper position/history controls.
5. Write docs/SPIKE.md and setup/handoff links; verify meaningful signal/feed/fill/
   restart/authorization cases and full backend/frontend/HTTP/browser workflows.
6. Publish verified changes to GitHub main under the user's standing instruction,
   verify matching CI and record the exact operator rollout action.

## Jev-assisted final review

The user requested Jev while building Spike. Use focused typed language/image
judgments to review generated fixture screenshots and exact entry-rule wording.
Minimum selection, prices, timestamps, the 5% rule, fills and P&L stay deterministic
in code. Jev findings guide implementation review, not trade actions.

- State: generated desktop/mobile screenshots and the relevant rule descriptions;
  no production sessions, tokens, personal data or real positions.
- Keep atomic Noul questions, criteria and 0.3/0.7 thresholds together. Strong
  findings are inspected before editing; unsettled findings receive manual review.
- Include a delayed-confirmation negative case, preserve exact payload/assets and
  results, record returned model/token usage/spend, and recheck meaningful fixes.
- Use the standing US$0.01 session allowance and existing TYPESAFE_API_KEY. The
  official SDK is unavailable locally, so use the live-documented HTTP API from
  TypeScript with one bounded attempt and no retries; no dependency installation.

## Checks

- Existing local Go/PostgreSQL wrapper: scratch/dhan-default-check/check.sh.
- Backend: mandatory PostgreSQL/race make check, make build, locked module sync.
- Frontend: npm run build, npm test, npm run test:go, applicable browser checks.
- Meaningful synthetic loopback tests; no real broker orders or production tokens.
- Preserve inputs and unrelated edits; temporary artifacts in scratch, reports in
  outputs. Dependency installation and deployment need permission if required.
