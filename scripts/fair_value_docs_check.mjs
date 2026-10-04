/** Verify every configurable field and private route has a documentation reference. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { defaultConfig } from '../dist/fairValue/config.js';

const guide = await readFile(new URL('../docs/FAIR_VALUE.md', import.meta.url), 'utf8');
const config = defaultConfig({});
let fields = 0;
for (const [key, value] of Object.entries(config)) {
  assert.ok(guide.includes(`\`${key}\``) || guide.includes(`\`${key}.`), `Missing setting ${key}`);
  fields++;
  if (['quote', 'iv', 'forward', 'smile', 'curve'].includes(key)) {
    for (const field of Object.keys(value)) {
      assert.ok(guide.includes(`\`${field}\``) || guide.includes(`\`${key}.${field}\``), `Missing setting ${key}.${field}`);
      fields++;
    }
  }
}
const routes = await readFile(new URL('../src/fairValue/routes.ts', import.meta.url), 'utf8');
const endpoints = [...routes.matchAll(/router\.(get|post|patch)\("([^"]+)"/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
for (const endpoint of endpoints) assert.ok(guide.includes(endpoint), `Missing endpoint ${endpoint}`);
for (const label of ['supported', 'limited', 'research', 'invalid', 'unavailable']) assert.ok(guide.includes(`\`${label}\``));
console.log(JSON.stringify({ documented_configuration_fields: fields, documented_private_routes: endpoints.length, quality_labels: 5 }));
