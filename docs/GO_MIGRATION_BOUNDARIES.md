# Go Migration Boundaries

Architectural map for the planned Go rewrite. **Documentation only — no Go code yet, and
no TypeScript is reorganised to match it.** It is derived from the seams that already
exist in the working Node backend, so the rewrite follows real boundaries rather than
imagined ones.

## Guiding principle

> Preserve **contracts, state machines, fixtures, behaviour and persistence
> compatibility**. Re-implement internals freely.

This is **not** a line-by-line translation. The Node backend is a *reference
implementation*: run its behaviour through the golden fixtures and the documented
contracts, and let the Go internals be idiomatic Go. A file-by-file port would carry over
Node-shaped decisions (single-process event loop, Mongoose models, Express middleware)
that Go should not inherit.

## Proposed package layout

```
cmd/calspread/
    main.go                 # wiring + lifecycle only (today: src/index.ts top level)

internal/
    config/                 # env → typed config; the CONFIGURATION.md manifest
                            #   ← src/box/config.ts, scattered process.env reads

    domain/                 # pure value types shared across packages
                            #   ← src/box/types.ts (BoxCandidate, BoxQuote, roles, sides)

    brokers/
        broker.go           # BrokerAdapter, MarginProvider, LiveAdapterFactory
        zerodha/            # ← src/kite.ts, src/box/kiteBrokerAdapter.ts, hub.ts
        dhan/               # ← src/brokers/dhan/*, src/box/dhanBrokerAdapter.ts
                            #   registry ← src/brokers/registry.ts (ActiveBrokerManager)

    marketdata/             # QuoteProvider + Feed + instrument universe
                            #   ← src/brokers/{quoteProvider,instrumentProvider,
                            #        feedHealth}.ts, src/box/brokerContext.ts providers

    subscriptions/          # refcounted coordinator, one active token set
                            #   ← src/brokers/subscriptions.ts (SubscriptionCoordinator)

    strategies/
        box/
            scanner.go      # ← src/box/scanner.ts
            engine.go       # ← src/box/engine.ts (orchestration only)
            math.go         # ← src/box/math.ts        ★ fixtures pin this
            positions.go    # ← src/box/positions.ts   ★ fixtures pin this
            monitor.go      # ← src/box/positionMonitor.ts
            execution.go    # ← src/box/{legExecutor,executionGateway,
                            #        executionPolicy,executionSimulator,orderManager}.ts
            charges.go      # ← src/box/{localCharges,charges}.ts  ★ fixtures pin this
            pricing.go      # ← src/box/orderPricing.ts ★ fixtures pin this

    persistence/
        mongo/              # collections + models (SAME names/shapes)
                            #   ← src/db.ts, src/box/model.ts, src/box/repository.ts
        redis/              # analytics cache ← Upstash REST usage in src/index.ts

    api/
        http/               # route handlers ← src/index.ts, src/box/routes.ts,
                            #   src/brokers/routes.ts, src/marketDataRoutes.ts
        sse/                # tick + box streams, session store
                            #   ← src/marketDataSession.ts, hub.ts fan-out

    runtime/
        lifecycle/          # graceful shutdown coordinator ← src/shutdown.ts
        schedulers/         # capture jobs ← src/hourlyCapture.ts, src/eodCapture.ts
```

## Module → package mapping (detail)

| Today (TypeScript) | Future (Go) | Migration note |
|---|---|---|
| `src/box/math.ts` | `strategies/box/math.go` | **Pure.** Port against `tests/migration-fixtures/box/*.json`; direction, evaluation, edges, exit economics are all frozen there. |
| `src/box/orderPricing.ts` | `strategies/box/pricing.go` | **Pure.** Tick rounding + bounded limits frozen in `order-pricing.json`. |
| `src/box/{localCharges,charges}.ts` | `strategies/box/charges.go` | **Pure.** Indian F&O heads frozen in `charges.json`; keep sell-only STT nearest-rupee, buy-only stamp, IPFT/crore, GST base. |
| `src/box/positions.ts` | `strategies/box/positions.go` | **Pure.** Position-state machine frozen in `position-state.json`. |
| `src/box/engine.ts` | `strategies/box/engine.go` | Orchestration. Do **not** copy its timer plumbing; use Go contexts/tickers. Preserve the entry/exit *decisions*, which are the pure functions above. |
| `src/box/{legExecutor,executionGateway,executionPolicy}.ts` | `strategies/box/execution.go` | The live state machine — **not** fixture-covered (needs a broker + DB). Preserve leg order, partial-fill handling, emergency unwind, abort-after-fill, durable intents. |
| `src/box/orderManager.ts` | `strategies/box/execution.go` + `persistence/mongo` | Durable order intents are the recovery backbone; keep `box_order_intents` shape and state machine exactly. |
| `src/brokers/registry.ts` | `brokers/registry` | Single-active-broker rule, generation counter, guarded switch — all contract. |
| `src/brokers/subscriptions.ts` | `subscriptions/` | Refcount semantics: 0→1 subscribes upstream, 1→0 unsubscribes; overlaps subscribe once. |
| `src/marketDataSession.ts` | `api/sse/` | Session lifecycle: look-up-not-consume, TTL, generation binding (see MIGRATION_CONTRACT §2). |
| `src/shutdown.ts` | `runtime/lifecycle/` | Ordering + idempotency + timeout; **never flatten positions on a signal**. |
| `src/db.ts`, `src/box/model.ts` | `persistence/mongo/` | Same collection names, same field names, same indexes. |

## What must NOT change across the rewrite

- Every item in the behavioural regression checklist (see the hardening-pass report):
  Box formulas, direction, candidate count, thresholds, order limit prices, tick rounding,
  charges, margin, paper + live state machines, partial-fill and unwind handling,
  persistence and restart recovery, both broker adapters, broker switching, subscription
  refcounting.
- HTTP paths, methods, JSON field names, status codes (MIGRATION_CONTRACT §1).
- SSE session semantics and event shapes (§2).
- Mongo collection names + persisted schemas + Redis key formats (§4).
- Environment-variable names and their effects (CONFIGURATION.md).

## Recommended migration order

1. **Pure core first** (`math`, `pricing`, `charges`, `positions`) — validated entirely by
   the golden fixtures with no infrastructure. This is where the fixtures pay off: a Go
   package that passes all 42 cases is behaviourally equal to the TS core.
2. **Persistence** — same collections/schemas, so Go and Node could even run against the
   same database during a phased cutover.
3. **Broker adapters + registry** — behind the interfaces in MIGRATION_CONTRACT §3.
4. **Market data + subscriptions + SSE** — the transport, preserving §2.
5. **Execution state machine** — last and most carefully; not fixture-covered, so lean on
   the existing TypeScript execution suites as the oracle and add Go-side equivalents.
6. **HTTP surface + schedulers + lifecycle** — the outer shell.

Extend `tests/migration-fixtures/` as needed, but regenerate from the TypeScript reference
only deliberately — a changed fixture means changed behaviour.
