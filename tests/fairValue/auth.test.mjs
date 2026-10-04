import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { registerFairValueRoutes } from '../../dist/fairValue/routes.js';

test('router-wide full-admin authorization covers valuation/settings/history/export and SSE', async () => {
  const app = express(); app.use(express.json());
  let role = 'full';
  const getRole = (token) => token === 'full-test' ? role : token === 'trade-test' ? 'trade' : null;
  let privateCalls = 0;
  const status = { enabled: true };
  const engine = {
    status: () => { privateCalls++; return status; }, getConfig: () => ({}), updateConfig: async () => ({}),
    underlyings: async () => [], getSnapshot: () => ({ snapshot: { id: 'private-snapshot' } }),
    refresh: async () => ({}), pause: () => {}, history: async () => [], historicalSnapshot: async () => ({ id: 'secret' }),
    subscribe: () => () => {},
  };
  registerFairValueRoutes(app, { engine, getAdminRole: getRole,
    requireFullAdmin: (req, res, next) => getRole(req.header('x-admin-token')) === 'full' ? next() : res.status(403).json({ error: 'Full admin required' }),
    streamIntervalMs: 10,
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}/api/fair-value`;
  try {
    for (const [method, path] of [['GET', '/status'], ['GET', '/config'], ['PATCH', '/config'], ['GET', '/underlyings'],
      ['GET', '/snapshot/TEST'], ['POST', '/refresh'], ['POST', '/pause'], ['POST', '/calculate'], ['POST', '/independent'],
      ['GET', '/history/TEST'], ['GET', '/history/TEST/id'], ['GET', '/export/TEST'], ['GET', '/stream']]) {
      for (const token of ['', 'trade-test', 'expired']) {
        const response = await fetch(origin + path, { method, headers: { 'x-admin-token': token } });
        assert.equal(response.status, 403, `${method} ${path} ${token}`);
        assert.match(response.headers.get('cache-control'), /no-store/);
      }
    }
    assert.equal(privateCalls, 0);
    assert.equal((await fetch(origin + '/status', { headers: { 'x-admin-token': 'full-test' } })).status, 200);
    const stream = await fetch(origin + '/stream?x-admin-token=full-test');
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const first = await reader.read(); assert.ok(first.value.length > 0);
    role = null;
    while (!(await reader.read()).done) { /* role revoked -> stream closes */ }
    assert.equal((await fetch(origin + '/export/TEST', { headers: { 'x-admin-token': 'full-test' } })).status, 403);
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});
