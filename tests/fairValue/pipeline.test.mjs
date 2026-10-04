import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSurface } from '../../dist/fairValue/pipeline.js';
import { varianceAt } from '../../dist/fairValue/smile.js';
import { FairValueEngine } from '../../dist/fairValue/engine.js';
import { AnalyticsWorkers } from '../../dist/fairValue/workers.js';
import { inputSnapshot, memoryStore, NOW } from './fixtures.mjs';

test('listed-expiry pipeline preserves snapshot identity and per-unit/lot/IV units', () => {
  const input = inputSnapshot({ configPatch: { smile: { ...inputSnapshot().config.smile, model: 'interpolation' } } });
  const result = buildSurface(input);
  assert.equal(result.input_snapshot_id, input.id);
  assert.equal(result.config_version, input.config_version);
  const slice = result.slices[0];
  assert.equal(slice.smile.method, 'validated_interpolation');
  assert.equal(slice.smile.valid, true, JSON.stringify(slice.smile.diagnostics));
  const row = slice.rows.find((r) => r.strike === 100 && r.side === 'CE');
  assert.ok(Math.abs(row.surface_iv - .3) < 1e-8);
  assert.equal(row.fair_value_per_lot, row.fair_value * 50);
  assert.ok(row.bid_iv.iv < row.ask_iv.iv);
  assert.ok(Math.abs(row.comparison.mid_deviation) < 1e-8);
  assert.ok(slice.observations.filter((o) => o.strike === 100).reduce((s, o) => s + o.dependence_factor, 0) <= 1);
  assert.equal(varianceAt(slice.smile, 2, input.config.smile), null);
});

test('unverified date-only expiry returns unavailable reasons, never a guessed weekday/time', () => {
  const input = inputSnapshot();
  input.config.expiry_policy = null;
  input.instruments.forEach((i) => { delete i.expiry_timestamp; });
  const slice = buildSurface(input).slices[0];
  assert.equal(slice.expiry_timestamp, null);
  assert.ok(slice.rows.every((r) => r.fair_value === null && r.reasons.includes('expiry_time_unverified')));
});

function engineFixture(workers) {
  const input = inputSnapshot();
  let generation = 1;
  let currentTokens = [];
  const engine = new FairValueEngine({
    getAllInstruments: async () => input.instruments,
    getBoard: async () => [{ symbol: 'TEST', name: 'Test underlying', spot_token: 1 }],
    metadataVersion: () => 'test-v1', activeBroker: () => 'zerodha', brokerGeneration: () => generation,
    dataReady: () => true, switching: () => false, setTokens: (tokens) => { currentTokens = tokens; },
    tokenBudget: () => 600, retainFeed: () => () => {}, feedStatus: () => ({ connected: true }),
    store: memoryStore(), config: input.config, now: () => NOW, ...(workers ? { workers } : {}),
  });
  const ingest = () => engine.ingestTicks(input.quotes.map((q) => ({ token: q.token,
    last_price: q.bid, close_price: 0, oi: 0, bid: q.bid, ask: q.ask,
    bids: [{ price: q.bid, qty: 1000, orders: 1 }], asks: [{ price: q.ask, qty: 1000, orders: 1 }],
    depth_updated: true, exchange_ts: NOW - 100 })), NOW);
  return { engine, input, ingest, bump: () => { generation++; }, tokens: () => currentTokens };
}

test('worker publication is immutable, atomic and cannot cross feed generations', async () => {
  const fixture = engineFixture();
  const { engine } = fixture;
  try {
    await engine.watch('TEST');
    fixture.ingest();
    await engine.refresh('TEST');
    const result = engine.getSnapshot('TEST').snapshot;
    assert.ok(result);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.slices[0].rows));
    assert.throws(() => { result.slices[0].rows[0].fair_value = 123; }, TypeError);
    assert.ok(engine.getInput('TEST').quotes.every((q) => q.receive_timestamp === new Date(NOW).toISOString()));
    assert.ok(fixture.tokens().length <= 600);
    const retained = JSON.stringify(result);
    fixture.ingest();
    assert.equal(JSON.stringify(result), retained);
    engine.invalidate();
    assert.equal(engine.getSnapshot('TEST').snapshot, null);
  } finally { await engine.dispose(); }
});

test('a stale worker result is discarded and exceptions leave analytics outside execution', async () => {
  let resolve;
  let captured;
  const workers = {
    surface: async (input) => { captured = input; return new Promise((r) => { resolve = r; }); },
    stats: () => ({ running: 0, queued: 0, failures: 0, workers: 0 }), dispose: async () => {},
  };
  const f = engineFixture(workers);
  try {
    await f.engine.watch('TEST'); f.ingest();
    const pending = f.engine.refresh('TEST');
    await new Promise((r) => setTimeout(r, 5));
    f.bump(); f.engine.invalidate(); resolve(buildSurface(captured));
    await pending;
    assert.equal(f.engine.getSnapshot('TEST').snapshot, null);
    workers.surface = async () => { throw new Error('scripted isolated calibration failure'); };
    await f.engine.refresh('TEST');
    assert.match(f.engine.status().last_error, /isolated/);
    // No order/protection dependency exists in the engine; caller event loop continues.
    let protectiveAction = false;
    await new Promise((r) => setImmediate(() => { protectiveAction = true; r(); }));
    assert.equal(protectiveAction, true);
  } finally { await f.engine.dispose(); }
});

test('actual worker timeout/crash only rejects bounded analytics jobs', async () => {
  const pool = new AnalyticsWorkers({ concurrency: 1, maxQueue: 1, timeoutMs: 20,
    workerUrl: new URL('data:text/javascript,import { parentPort } from "node:worker_threads"; parentPort.on("message",()=>{while(true){}})') });
  try {
    const p = pool.submit('poison', {});
    let protectiveRan = false;
    await new Promise((r) => setTimeout(() => { protectiveRan = true; r(); }, 2));
    assert.equal(protectiveRan, true);
    await assert.rejects(p, /time budget/);
    assert.ok(pool.stats().failures >= 1);
  } finally { await pool.dispose(); }
});
