/** Boot actual app with local fixture credentials, no broker session and analytics
 * disabled. Verify real full/trade auth and invalid-analytics-config isolation.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const port = 3197;
const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: new URL('../', import.meta.url),
  env: {
    ...process.env, PORT: String(port), FRONTEND_URL: 'http://127.0.0.1:5175',
    KITE_API_KEY: 'local-fixture', KITE_API_SECRET: 'local-fixture',
    ADMIN_SECRET: 'local-fixture-admin', ACCESS_SECRET: 'local-fixture-trade',
    MONGODB_URI: '', BOX_MONGODB_URI: '', TRADE_LOG_URI: '',
    NSE_FNO_ARCHIVE_URI: '', NSE_FNO_CURRENT_URI: '', NSE_FNO_SPREAD_URI: '',
    UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
    DHAN_CLIENT_ID: '', DHAN_ACCESS_TOKEN: '',
    BOX_EXECUTION_MODE: 'paper_latency', BOX_LIVE_TRADING_ENABLED: 'false',
    FAIR_VALUE_ENABLED: 'false', FAIR_VALUE_CONFIG_JSON: '{invalid-json',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (data) => { output = (output + data).slice(-20000); });
child.stderr.on('data', (data) => { output = (output + data).slice(-20000); });
const origin = `http://127.0.0.1:${port}`;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Fixture app exited (${child.exitCode}): ${output}`);
    try { ready = (await fetch(origin + '/api/status')).ok; } catch { /* startup */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(ready, true, output);
  const verify = async (path, secret) => {
    const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret }) });
    assert.equal(response.status, 200);
    return (await response.json()).token;
  };
  const full = await verify('/api/admin/verify', 'local-fixture-admin');
  const trade = await verify('/api/access/verify', 'local-fixture-trade');
  for (const token of [null, trade]) {
    for (const [method, path] of [['GET', '/status'], ['GET', '/config'], ['GET', '/snapshot/NIFTY'],
      ['GET', '/history/NIFTY'], ['GET', '/export/NIFTY'], ['POST', '/calculate'], ['POST', '/independent'],
      ['POST', '/refresh'], ['PATCH', '/config'], ['POST', '/pause']]) {
      const response = await fetch(origin + '/api/fair-value' + path, { method,
        headers: token ? { 'x-admin-token': token } : {} });
      assert.equal(response.status, 403, `${method} ${path}`);
    }
  }
  const response = await fetch(origin + '/api/fair-value/status', { headers: { 'x-admin-token': full } });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.enabled, false);
  assert.match(status.force_disabled_reason, /configuration invalid/);
  const enable = await fetch(origin + '/api/fair-value/config', { method: 'PATCH',
    headers: { 'x-admin-token': full, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  assert.equal(enable.status, 400);
  assert.equal((await fetch(origin + '/api/status')).status, 200);
  console.log(JSON.stringify({ actual_app_boot: true, full_admin_authorization: true,
    trade_public_denied: true, analytics_configuration_failure_isolated: true, live_trading: false }));
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 15000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}
