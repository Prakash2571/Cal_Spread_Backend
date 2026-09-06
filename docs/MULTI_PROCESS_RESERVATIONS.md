# Multi-process Box instrument reservations

How two Node workers are prevented from reserving the same option contract, and what
happens in every failure mode. Companion to `src/box/reservations/` — the code carries the
detailed argument; this is the operator- and reviewer-facing summary.

## 1. The failure mode this closes

`InProcessInstrumentReservations` is genuinely atomic inside ONE process: `tryAcquireAll`
inspects every key and then writes every key with no `await` between the two passes, and
Node runs one turn of the event loop to completion. That argument is airtight, and it is
entirely local.

With two processes it says nothing:

```
PROCESS A                          PROCESS B
Box 1300/1320                      Box 1320/1340
sees RELIANCE 1320CE free          sees RELIANCE 1320CE free
reserves it in its own Map         reserves it in its own Map
submits                            submits
```

Both assume the full displayed size resting at 1320. The same lot is spent twice. This is
reachable under PM2 cluster mode, several backend workers, multiple EC2 instances,
Kubernetes replicas, a separate Box execution service, or a future Go/Rust executor —
anything with more than one process against one broker account.

## 2. Architecture after the change

```
BoxExecutionCoordinator (CoordinatedBoxExecutionGateway)
        |
        v
ChainedInstrumentReservations          acquire: local -> durable
        |                              release: durable -> local
        +-- InProcessInstrumentReservations      (fast filter, not authoritative)
        |
        +-- DurableInstrumentReservations        (the authority)
                  |
                  +-- MongoReservationPort -> box_instrument_reservations
```

The local tier is kept because it is free and rejects the most common conflict — two
overlapping strike pairs on the same tick — without a network call. It is a filter in
front of the authority, never a substitute for it. An acquire succeeds only when BOTH
tiers agree; if the durable tier refuses, the local reservation is rolled back immediately
so a rejected attempt never leaves this process holding contracts it does not own.

## 3. The durable acquire algorithm

```
keys = dedupe(sorted canonical broker-namespaced contract keys)
fence = spare token, else atomic $inc on a per-deployment counter
insertOne({ _id: owner, deployment, broker, generation, keys, fence, expires_at })

  inserted        -> lease granted
  owner_exists    -> our own re-entrant row; delete it (owner-verified) and retry once
  key_conflict    -> deleteMany({ deployment, keys: {$in: keys},
                                  expires_at: {$lte: serverNow - grace} })
                     if anything was reclaimed, retry the insert once
                     else read the live holders and report a CONFLICT
  thrown error    -> report UNAVAILABLE (never "free")
```

A duplicate-key error is the mechanism, not a fault. If the retry's conflict turns out to
be against a document this owner already holds, the insert really did commit (a retryable
write whose acknowledgement was lost) and it is recognised as success rather than waited
out against itself.

## 4. Mongo and index design

Collection `box_instrument_reservations`, one document per reservation:

| field | purpose |
|---|---|
| `_id` | the globally unique owner id — owner lookup is a primary-key hit, and owner uniqueness is enforced by the database |
| `deployment` | lock namespace (production / staging / development) |
| `broker`, `generation` | which broker world the lease was taken in |
| `keys` | the COMPLETE instrument set, as an array |
| `fence` | monotonic fencing token |
| `expires_at` | authority-clock expiry |
| `sides`, `mode`, `instance`, `created_at`, `renewed_at` | diagnostics |

Indexes, created and then **read back and verified** in `ensureReady()`:

| index | why |
|---|---|
| `{ deployment: 1, keys: 1 }` **unique** | the entire safety property |
| `{ expires_at: 1 }` `expireAfterSeconds: 0` | garbage collection ONLY |
| `{ deployment: 1, broker: 1, generation: 1 }` | operator queries, generation housekeeping |

`autoIndex` is explicitly **disabled** on the schema. Relying on it would mean the unique
constraint that provides the whole guarantee might silently not exist — most likely in
production, where `autoIndex` is exactly what gets turned off. If the unique index is
absent, or exists but is not unique, the adapter refuses to become ready and live Box
entry fails closed. `ready` is not latched: an observed disconnect clears it, so an index
dropped during maintenance is re-detected rather than trusted forever.

## 5. Why acquisition is atomic

`keys` is an array, so the unique index is MULTIKEY: Mongo writes one index entry per
element. A unique index applies its constraint across documents — per the multikey manual,
"a document may have array elements that result in repeating index key values as long as
the index key values for that document do not duplicate those of another document". So no
`(deployment, key)` pair can exist in two documents, which is exactly "no contract is held
by two live reservations".

A single-document insert is atomic, so four keys either write all four index entries or,
on the first collision, write none and leave no document. Four contracts are claimed
together or not at all. There is no `insert key1; insert key2; ...` sequence anywhere,
because that would reintroduce the partial-reservation and deadlock problems all-or-none
exists to eliminate.

Verified against a real cluster by `tests/box/mongoReservationIntegration.test.mjs`
(env-gated on `BOX_TEST_MONGODB_URI`); modelled faithfully, index and all, by
`InMemoryReservationPort` for the offline suite.

## 6. Expiration semantics

Expiry is decided **logically**, from the stored timestamp. Mongo's TTL monitor runs
roughly once a minute, so a document routinely outlives its `expires_at`; nothing in the
algorithm depends on it.

Whose clock decides is critical. If each worker used its own `Date.now()`, a worker ten
seconds fast would consider a live lease expired, delete it, and take the contracts — two
owners, one contract. So the **authority's clock is the only clock**: the offset is
measured at startup and refreshed periodically (round-trip midpoint), every stored
timestamp is in authority time, and conversion happens at the tier boundary. An offset
that has gone unmeasured for longer than `clockSyncMaxStaleMs` forces a blocking
re-measurement, and failing that, `unavailable`.

On top of that the test is deliberately **asymmetric**:

```
holder     claims ownership only while   now <  expiresAt - grace
challenger may reclaim only once        now >= expiresAt + grace
```

leaving a dead band of 2×grace in which nobody acts. Handing a contract to nobody for
500 ms is a missed opportunity; handing it to two workers is a naked position.

## 7. Renewal semantics

A bounded timer (`BOX_RESERVATION_RENEW_INTERVAL_MS`, default TTL/3), never per market
tick. Renewals run concurrently, so a slow tier cannot push a tick past its interval or
couple unrelated boxes.

```
findOneAndUpdate(
  { _id: owner, fence, broker, generation, expires_at: { $gt: serverNow } },
  { $set: { expires_at: serverNow + ttl } })
```

Owner, fence, broker and generation are all in the **filter**, not checked afterwards — a
superseded lease must never have its expiry extended and only then be rejected, because
that locks the contract for another full TTL on behalf of a worker that may not trade it.

Zero matched rows is a **safety event**: `reservationOwnershipLost` is incremented,
`invariantViolation` is raised, and the synchronous ownership guard flips so remaining legs
abort. It is never a retry. A `local_only` lease is renewed against the local tier that
issued it, not against the authority that never did.

## 8. Stale-owner protection

- Owner ids are globally unique: `deployment:instance:pNNN:boot:kind-seq:uuid`. A bare
  per-process counter would have let worker-1's `entry-7` renew or release worker-2's.
- Release is `deleteOne({ _id: owner, fence })` — never `deleteMany({ keys: { $in } })`,
  which would delete whoever holds those contracts *now*.
- A fencing token pins each operation to a specific lease. The chain keeps **per-tier**
  bookkeeping, because the in-process fence and the durable fence are unrelated number
  spaces and handing one tier the other's token breaks every renewal.
- Ownership is re-checked before submission, and the guard's margin is
  `BOX_RESERVATION_OWNERSHIP_MARGIN_MS` (worst-case broker round trip), not the clock
  grace — a leg permitted 300 ms before expiry could still be in flight when someone else
  legitimately owns the contract.

**Documented limitation of fencing:** neither Zerodha nor Dhan accepts a token on an
order, so the broker cannot reject a stale worker's submission. The token is used
internally only — stale-owner detection, renewal pinning, reconciliation, logs, invariant
checks. It narrows the window; it does not close it at the broker.

## 9. Broker-generation protection

`generation` is stamped on every lease and re-checked before execution and on every
renewal. It is now **persisted and monotonic**: `active_broker.generation` is `$inc`ed on
every switch and adopted at boot. Previously the counter reset to 1 on every restart, so
"generation 1" could mean two different states of the world — which would make the stamp
meaningless. Broker and generation are adopted together, after the persist, so no lease
can record a pair that never existed.

A broker switch also clears this process's reservations (a new `SwitchHooks` member —
previously `engine.clearInstrumentReservations()` existed but had **no callers**, so
reservations survived a switch until TTL), and `executionInFlight` now also reports
coordinator-held reservations, so a switch cannot land under a queued execution.

**Limitation:** a worker that has not itself observed the switch keeps its own in-memory
generation. Cross-worker propagation is bounded by the switch blockers (which refuse while
any execution or reservation is outstanding) and by the reservation TTL. Full multi-worker
switch coordination is out of scope here.

## 10. During a Mongo outage

| operation | behaviour |
|---|---|
| LIVE Box **entry** | **FAILS CLOSED.** Refused with `durable_reservation_unavailable`; `liveEntryBlocked: true` in health |
| PAPER entry | proceeds on the local tier, labelled `reservationDurability: local_only` and counted |
| Exits | proceed on the local tier — a database outage must never strand an open position |
| Residual flattening | **completely ungated**, as before |
| Reconciliation, monitoring | unaffected |
| Renew / verify | report `unavailable` (ownership UNKNOWN), and the reservation is **not** deleted |
| Uncertain holds | retained through a transient blip; only a confirmed loss ends them |

An outage is never reported as a conflict, and never as "free".

## 11. After a worker crash

The lease sits in Mongo until `expires_at + grace`, then any worker's acquire reclaims it
via the expired-document delete. Before that it is authoritative and respected — a newly
started process does **not** wipe the table; `reapExpired()` at startup removes only
documents that have already lost their lease.

## 12. With two PM2 workers

Same underlying, overlapping contracts → exactly one worker submits; the other waits
(bounded by `BOX_CONFLICT_WAIT_MAX_MS`), then re-prices and re-qualifies before it is
allowed to trade. Unrelated boxes (RELIANCE vs TCS) run fully concurrently: there is no
global mutex and no per-underlying lock. Same underlying, different strikes stay
concurrent. The same exact contract conflicts regardless of BUY/SELL.

Waiting is hybrid: `onRelease` is an in-memory emitter and cannot see a sibling's release,
so each round races the release event against a short **deterministically jittered** timer
(seeded from the process boot token — `Math.random` is banned in `src/box`, and different
workers must not retry in lockstep).

## 13. One authority, and only one

The durable tier is the single correctness authority. The chain requires **unanimity** to
grant a lease and never picks whichever tier gives the convenient answer; ownership
questions resolve against the durable tier so two tiers can never be quoted as
disagreeing. Redis is **not** used: `src/redis.ts` is Upstash over REST and by explicit
design never throws, returning `null` when unreachable — a fail-OPEN primitive, which is
worse than no lock because it looks like one.

## 14. Configuration

See `docs/CONFIGURATION.md`. New: `BOX_DURABLE_RESERVATIONS_ENABLED`,
`BOX_RESERVATION_RENEW_INTERVAL_MS`, `BOX_RESERVATION_CLOCK_SKEW_GRACE_MS`,
`BOX_RESERVATION_UNCERTAIN_HOLD_MAX_MS`, `BOX_RESERVATION_OWNERSHIP_MARGIN_MS`,
`CALSPREAD_DEPLOYMENT_ID`, `CALSPREAD_INSTANCE_ID`.

**Multi-worker deployments must set `BOX_RESERVATION_REQUIRE_DURABLE=true` and an explicit
`CALSPREAD_DEPLOYMENT_ID`.**

## 15. Observability

`GET /api/box/execution-diagnostics` gains `executionCoordination` (per-tier health,
`durableReady`, `liveEntryBlocked` + reason, deployment, generation, acquire percentiles,
scrubbed last error) and extends `coordinator` with `durableAcquireAttempts/Success`,
`durableConflicts`, `durableErrors`, acquire p50/p95/p99, `reservationRenewSuccess/Failure`,
`reservationOwnershipLost`, `expiredReservationsObserved`, `durableUnavailableRefusals`,
`localOnlyFallbacks`, `staleGenerationAborts`, `uncertainHoldsActive/Abandoned`,
`clockOffsetMs`.

All buffers are bounded (256-sample rings). No execution id, instrument token, symbol or
order id appears in `metrics()` — asserted by test. Error strings are scrubbed of
connection strings and contract keys at the source.

## 16. Remaining limitations

1. **Fencing is advisory at the broker.** No broker accepts a token, so a sufficiently
   stalled worker can still submit a stale order. The ownership margin and renewal shrink
   the window; they cannot eliminate it.
2. **Cross-worker broker-switch propagation** relies on the switch blockers plus the TTL,
   not on a live consensus.
3. **The fence counter is a shared document.** It is a write, not a lock — unrelated boxes
   are never excluded by it — but it is one round trip per acquisition that needs a new
   token. Unused tokens are recycled, so the conflict-retry loop does not burn one per
   round.
4. **Mongo's TTL monitor is not a lock primitive** and is used only for garbage
   collection; correctness comes from logical expiry.
5. **Paper `local_only` mode is genuinely weaker.** It is labelled and counted, never
   silent, and never available to live entry.
6. **The offline suite models Mongo** rather than running it. The real index semantics are
   covered by the env-gated integration suite, which must be run against a cluster before
   trusting a change to the acquire path.
