import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { FairValueEngine } from '../../dist/fairValue/engine.js';
import { registerFairValueRoutes } from '../../dist/fairValue/routes.js';
import { inputSnapshot, memoryStore, NOW } from './fixtures.mjs';

test('admin HTTP workflow: publish, calculate, independent cache, history, pause, disable and failure isolation', async () => {
  const input = inputSnapshot({ expiries: ['2026-10-20T10:00:00Z', '2026-11-17T10:00:00Z'],
    configPatch: { history_interval_ms: 10000, history_limit: 2, forward_interpolation: 'log_carry_assumption', proportional_calendar_assumption: true } });
  let now = NOW, tokens = [];
  const store = memoryStore();
  const engine = new FairValueEngine({ getAllInstruments: async () => input.instruments,
    getBoard: async () => [{ symbol: 'TEST', name: 'Test', spot_token: 1 }],
    metadataVersion: () => 'test-v1', activeBroker: () => 'zerodha', brokerGeneration: () => 1,
    dataReady: () => true, switching: () => false, setTokens: (t) => { tokens = t; }, tokenBudget: () => 600,
    retainFeed: () => () => {}, feedStatus: () => ({ connected: true }), store, config: input.config, now: () => now });
  await engine.boot();
  const app = express(); app.use(express.json());
  const role = (token) => token === 'full' ? 'full' : null;
  registerFairValueRoutes(app, { engine, getAdminRole: role, requireFullAdmin: (req, res, next) => role(req.header('x-admin-token')) ? next() : res.sendStatus(403) });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}/api/fair-value`;
  const call = async (path, body) => {
    const res = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { 'x-admin-token': 'full', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json() };
  };
  const ingest = () => {
    engine.ingestTicks([{ token: 1, last_price: 100, close_price: 100, oi: 0, bid: 0, ask: 0, depth_updated: false }], now);
    engine.ingestTicks(input.quotes.map((q) => ({ token: q.token, last_price: (q.bid + q.ask) / 2, close_price: 0, oi: 0,
      bid: q.bid, ask: q.ask, bids: [{ price: q.bid, qty: 1000, orders: 1 }], asks: [{ price: q.ask, qty: 1000, orders: 1 }], depth_updated: true, exchange_ts: now - 100 })), now);
  };
  try {
    await engine.watch('TEST'); ingest();
    let refresh = await call('/refresh', { underlying: 'TEST' });
    assert.equal(refresh.status, 200);
    const snapshot = refresh.data.snapshot;
    assert.ok(snapshot.slices[0].rows.some((r) => r.fair_value > 0));
    const calculator = await call('/calculate', { underlying: 'TEST', strike: 102,
      expiry_timestamp: '2026-11-01T10:00:00Z', side: 'CE', research_mode: false });
    assert.equal(calculator.status, 200);
    assert.equal(calculator.data.available, true, JSON.stringify(calculator.data));
    assert.equal(calculator.data.contract, 'hypothetical');
    assert.equal(calculator.data.instrument_token, null);
    assert.ok(calculator.data.sensitivity.scenarios.length >= 3);
    const request = { underlying: 'TEST', expiry: snapshot.slices[0].expiry, strike: 100, input_snapshot_id: snapshot.input_snapshot_id };
    const [independentA, independentB] = await Promise.all([engine.independent(request), engine.independent(request)]);
    assert.equal(independentA, independentB);
    assert.equal(await engine.independent(request), independentA);
    assert.ok(independentA.forward.pairs.every((p) => p.strike !== 100));
    assert.equal((await call('/independent', { ...request, input_snapshot_id: 'old-snapshot' })).status, 400);
    for (let i = 0; i < 3; i++) { now += 10000; ingest(); refresh = await call('/refresh', { underlying: 'TEST' }); }
    const history = await call('/history/TEST');
    assert.equal(history.data.snapshots.length, 2);
    assert.ok(history.data.snapshots.every((s) => s.slices.every((slice) => !('rows' in slice))));
    assert.ok(history.data.snapshots.every((s) => s.model_version && s.config_version && s.input_snapshot_id));
    const historical = await call(`/history/TEST/${history.data.snapshots[0].id}`);
    assert.equal(historical.data.historical, true);
    const exportResult = await call('/export/TEST'); assert.equal(exportResult.status, 200);
    now += input.config.surface_max_age_ms + 1;
    assert.equal((await call('/snapshot/TEST')).data.stale, true);
    assert.equal((await call('/calculate', { underlying: 'TEST', strike: 100, expiry_timestamp: '2026-11-17T10:00:00Z', side: 'CE', research_mode: false })).status, 400);
    await call('/pause', { paused: true }); assert.equal(tokens.length, 0);
    assert.equal((await call('/refresh', { underlying: 'TEST' })).status, 503);
    await engine.updateConfig({ enabled: false });
    assert.equal(engine.status().enabled, false); assert.equal(tokens.length, 0);
    assert.equal((await call('/snapshot/TEST')).data.snapshot, null);
  } finally { await engine.dispose(); server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});
