import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config/load.ts';
import { summarizeConfig } from '../../src/cli/validate-config.ts';

test('summarizeConfig lists every configured source', () => {
  const config = loadConfig(fileURLToPath(new URL('../fixtures/config/android.yaml', import.meta.url)));
  const summary = summarizeConfig(config);
  assert.equal(summary.slug, 'android');
  assert.match(summary.modelKey, /^Xenova\/bge-small-en-v1.5@/);
  assert.ok(summary.sources.includes('github:home-assistant/android:pulls'));
  assert.ok(summary.sources.includes('github:home-assistant/companion.home-assistant:docs'));
  assert.ok(summary.sources.includes('discourse:community.home-assistant.io'));
});
