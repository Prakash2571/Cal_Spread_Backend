import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { defaultConfig, mergeConfig } from '../../dist/fairValue/config.js';
import { buildSurface } from '../../dist/fairValue/pipeline.js';
import { blackPrice, frozenBlackGreeks, yearFraction } from '../../dist/fairValue/black.js';
import { FairValueEngine } from '../../dist/fairValue/engine.js';
import { SubscriptionCoordinator } from '../../dist/brokers/subscriptions.js';
import { registerFairValueRoutes } from '../../dist/fairValue/routes.js';
import { SnapshotHistory } from '../../dist/fairValue/history.js';
import { TickerHub } from '../../dist/hub.js';
import { inputSnapshot, memoryStore, NOW } from './fixtures.mjs';

test('strict configuration rejects unknown/prototype/nonfinite settings and normalizes source timestamps', () => {
  const config = defaultConfig({});
  assert.equal(config.enabled, false); assert.equal(config.expiry_policy, null);
  for (const patch of [{ enabled: 'true' }, { workers: 100 }, { quote: { max_age_ms: Infinity } },
    { smile: { min_svi_strikes: 5 } }, JSON.parse('{"__proto__":{"enabled":true}}'), { constructor: {} },
    { curve: { as_of: '2026-10-01' } }]) assert.throws(() => mergeConfig(config, patch));
  const normalized = mergeConfig(config, { curve: { as_of: '2026-10-01T12:00:00+05:30' } });
  assert.equal(normalized.curve.as_of, '2026-10-01T06:30:00.000Z');
});

test('tiny ATM variance is stable and zero-vol ATM vega is its one-sided limit', () => {
  const price = blackPrice({ f: 100, k: 100, d: 1, w: 1e-30, side: 'CE' });
  assert.ok(Math.abs(price - 100 / Math.sqrt(2 * Math.PI) * 1e-15) < 1e-28);
  const greek = frozenBlackGreeks({ f: 100, k: 100, d: 1, w: 0, t: 1, side: 'CE', spot: null, proportionalCarry: false });
  assert.ok(greek.vega_1pct > 0); assert.equal(greek.forward_gamma, null);
  assert.throws(() => yearFraction('2026-11-01', '2026-10-01'));
});

test('incoherent pairs and duplicate instruments never enter smile calibration', () => {
  const input = inputSnapshot();
  const target = input.instruments.filter((i) => i.strike === 100).map((i) => i.instrument_token);
  const call = input.quotes.find((q) => q.token === target[0]);
  call.bid += 20; call.ask += 20;
  const slice = buildSurface(input).slices[0];
  assert.ok(slice.forward.excluded_pairs.some((p) => p.strike === 100 && p.reasons.includes('robust_forward_outlier')));
  assert.ok(slice.observations.every((o) => o.strike !== 100));
  input.instruments.push({ ...input.instruments[0], instrument_token: 99999 });
  const duplicate = buildSurface(input).slices[0];
  assert.ok(duplicate.rows.filter((r) => r.strike === 80 && r.side === 'CE').every((r) => r.reasons.includes('duplicate_instrument_metadata')));
});

test('analytics yields before a protective subscription and cannot evict shared execution tokens', () => {
  const operations = [];
  const upstream = new Set();
  const coordinator = new SubscriptionCoordinator({
    subscribeTokens: (tokens) => { operations.push(['add', tokens]); tokens.forEach((t) => upstream.add(t)); assert.ok(upstream.size <= 4); },
    unsubscribeTokens: (tokens) => { operations.push(['drop', tokens]); tokens.forEach((t) => upstream.delete(t)); },
  });
  coordinator.setOwnerTokens('strategy', [1, 2]);
  coordinator.setOwnerTokens('analytics', [1, 3, 4]);
  coordinator.setAnalyticsYield((priority) => {
    const current = coordinator.activeTokens().filter((t) => coordinator.owns('analytics', t));
    const keep = [...current.filter((t) => priority.has(t)), ...current.filter((t) => !priority.has(t)).slice(0, Math.max(0, 4 - priority.size))];
    coordinator.setOwnerTokens('analytics', keep);
  });
  coordinator.setOwnerTokens('strategy', [1, 2, 5, 6]);
  assert.deepEqual([...upstream].sort(), [1, 2, 5, 6]);
  assert.equal(coordinator.owns('analytics', 1), true);
  const dropIndex = operations.findIndex((o) => o[0] === 'drop' && o[1].includes(3));
  const addIndex = operations.findIndex((o) => o[0] === 'add' && o[1].includes(5));
  assert.ok(dropIndex < addIndex);
});

test('broker-neutral fanout retention never consults Kite credentials or opens an inactive socket', () => {
  let calls = 0;
  const hub = new TickerHub(() => { calls++; throw new Error('Kite must not be opened'); }, () => {});
  const release = hub.retainFanout();
  assert.equal(calls, 0);
  release(); release();
  assert.equal(calls, 0);
});

test('HTTP role revoked during asynchronous analytics returns 403 without result data', async () => {
  let finish, role = 'full';
  const engine = { history: () => new Promise((r) => { finish = r; }), status: () => ({ storage: 'test' }) };
  const app = express();
  registerFairValueRoutes(app, { engine, getAdminRole: (t) => t === 'full' ? role : null,
    requireFullAdmin: (_req, _res, next) => next() });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const pending = fetch(`http://127.0.0.1:${server.address().port}/api/fair-value/history/TEST`, { headers: { 'x-admin-token': 'full' } });
    while (!finish) await new Promise((r) => setTimeout(r, 1));
    role = null; finish([]);
    const response = await pending;
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'Full admin access required.' });
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});

test('recent snapshot remains explicitly addressable across publication; changed namespace drops all private current state', async () => {
  const input = inputSnapshot(); let now = NOW, generation = 1, tokens = [];
  const engine = new FairValueEngine({ getAllInstruments: async () => input.instruments,
    getBoard: async () => [{ symbol: 'TEST', name: 'Test', spot_token: 1 }], metadataVersion: () => 'test', activeBroker: () => 'dhan',
    brokerGeneration: () => generation, dataReady: () => true, switching: () => false,
    setTokens: (t) => { tokens = t; }, tokenBudget: () => 600, retainFeed: () => () => {}, feedStatus: () => ({}), store: memoryStore(), config: input.config, now: () => now });
  const ingest = () => engine.ingestTicks(input.quotes.map((q) => ({ token: q.token, last_price: q.bid, close_price: 0, oi: 0,
    bid: q.bid, ask: q.ask, bids: [{ price: q.bid, qty: 1000, orders: 1 }], asks: [{ price: q.ask, qty: 1000, orders: 1 }], depth_updated: true })), now);
  try {
    await engine.watch('TEST'); ingest(); await engine.refresh('TEST');
    const first = engine.getSnapshot('TEST').snapshot;
    now += 100; ingest(); await engine.refresh('TEST');
    assert.notEqual(first.input_snapshot_id, engine.getSnapshot('TEST').snapshot.input_snapshot_id);
    const independent = await engine.independent({ underlying: 'TEST', expiry: first.slices[0].expiry, strike: 100, input_snapshot_id: first.input_snapshot_id });
    assert.equal(independent.input_snapshot_id, first.input_snapshot_id);
    assert.equal(independent.status, 'available');
    assert.ok(engine.getInput('TEST').quotes.every((q) => q.exchange_timestamp === null));
    generation++;
    assert.equal(engine.getSnapshot('TEST').snapshot, null);
    assert.equal(engine.status().watched_underlyings.length, 0);
    assert.equal(tokens.length, 0);
  } finally { await engine.dispose(); }
});

test('history obeys explicit byte/count/age ceilings', () => {
  const input = inputSnapshot(), base = buildSurface(input);
  const bytes = Buffer.byteLength(JSON.stringify(base));
  let now = NOW;
  const history = new SnapshotHistory({ maxBytes: bytes * 2 + 100, maxUnderlyings: 2, now: () => now });
  for (let i = 0; i < 20; i++) history.add({ ...base, id: `history-${i}`, published_at: new Date(NOW + i).toISOString() }, 100, 1);
  assert.ok(history.stats().snapshots <= 2);
  assert.ok(history.stats().bytes <= bytes * 2 + 100);
  now += 2 * 86400000;
  assert.equal(history.list('TEST', 1).length, 0);
});
