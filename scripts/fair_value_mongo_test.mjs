/** Actual ephemeral Mongo persistence check. Requires approved scratch mongodb-memory-server tooling. */
import assert from 'node:assert/strict';
import { MongoMemoryServer } from '../scratch/node_modules/mongodb-memory-server/index.js';
import { inputSnapshot } from '../tests/fairValue/fixtures.mjs';
import { buildSurface } from '../dist/fairValue/pipeline.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const mongo = await MongoMemoryServer.create({ binary: { version: '8.0.16', downloadDir: new URL('../scratch/mongodb-binaries/', import.meta.url).pathname,
  os: { os: 'linux', dist: 'ubuntu', release: '24.04' } },
  instance: { dbPath: new URL('../scratch/mongodb-data/', import.meta.url).pathname } });
process.env.MONGODB_URI = mongo.getUri('fair_value_verification');
try {
  const { initDb, closeDbConnections } = await import('../dist/db.js');
  const { MongoFairValueStore } = await import('../dist/fairValue/store.js');
  await initDb();
  const store = new MongoFairValueStore();
  assert.equal(store.enabled(), true);
  const input = inputSnapshot();
  await store.saveConfig(input.config, input.config_version);
  assert.deepEqual(await store.loadConfig(), input.config);
  for (let i = 0; i < 4; i++) {
    const surface = buildSurface(input);
    surface.id = `mongo-fixture-${i}`;
    surface.published_at = new Date(Date.now() + i).toISOString();
    await store.append(surface, input, 2, 7);
  }
  const history = await store.history('TEST', 100);
  assert.equal(history.length, 2);
  assert.ok(history.every((s) => s.slices.every((slice) => !('rows' in slice) && typeof slice.observations === 'number')));
  assert.ok(history.every((s) => s.config_version === input.config_version && s.input_snapshot_id === input.id));
  assert.equal(await store.snapshot('TEST', 'mongo-fixture-0'), null);
  assert.equal((await store.snapshot('TEST', 'mongo-fixture-3')).id, 'mongo-fixture-3');
  assert.equal(await store.snapshot('OTHER', 'mongo-fixture-3'), null);
  const reduced = buildSurface(input);
  reduced.id = 'mongo-fixture-reduced-limit';
  reduced.published_at = new Date(Date.now() + 100).toISOString();
  await store.append(reduced, input, 1, 7);
  assert.equal((await store.history('TEST', 100)).length, 1);
  // Reopening the application connection proves the data is not a memory cache.
  await closeDbConnections();
  await initDb();
  assert.equal((await new MongoFairValueStore().history('TEST', 100)).length, 1);
  console.log(JSON.stringify({ check: 'ephemeral MongoDB persistence', config_roundtrip: true, immutable_input_history: true,
    retention_count: 1, reduced_retention_verified: true, restart_read: true }));
  await closeDbConnections();
  if (process.argv.includes('--box-integration')) {
    // Optional pre-existing suite on its own throwaway database, using mocked
    // broker adapters. This is regression verification, never live execution.
    const child = spawn(process.execPath, ['--test', 'tests/integration/mongoOrderIntentCas.test.mjs'], {
      cwd: new URL('../', import.meta.url), stdio: 'inherit', env: {
        ...process.env, BOX_TEST_MONGODB_URI: mongo.getUri('calspread_box_regression'), BOX_REQUIRE_MONGODB: '1',
      },
    });
    const [exitCode] = await once(child, 'exit');
    assert.equal(exitCode, 0, 'Pre-existing real MongoDB integration failed');
  }
} finally { await mongo.stop(); }
