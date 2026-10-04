import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoFairValueStore } from '../../dist/fairValue/store.js';
import { defaultConfig } from '../../dist/fairValue/config.js';

test('unconfigured Mongo is explicitly unavailable; no fabricated persistence success', async () => {
  const store = new MongoFairValueStore();
  assert.equal(store.enabled(), false);
  assert.equal(await store.loadConfig(), null);
  assert.deepEqual(await store.history('TEST', 10), []);
  assert.equal(await store.snapshot('TEST', 'missing'), null);
  await assert.rejects(store.saveConfig(defaultConfig({}), 'v1'), /memory-only/);
});
