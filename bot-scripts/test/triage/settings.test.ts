import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadConfig, ConfigError } from '../../src/config/load.ts';
import { triageSettings } from '../../src/triage/settings.ts';

const fixture = fileURLToPath(new URL('../fixtures/config/android.yaml', import.meta.url));
const baseConfig = () => ({ ...loadConfig(fixture), triage: undefined });

test('applies the defaults when the triage block is absent', () => {
  assert.deepEqual(triageSettings(baseConfig()), { minSimilarity: 0.35, answer: 75, links: 45, recheckLabel: 'ai-recheck', staged: false, suppressSimilarity: 0.8 });
});

test('reads the configured values and rejects links above answer', () => {
  const config = { ...baseConfig(), triage: { minSimilarity: 0.5, confidence: { answer: 80, links: 50 }, staged: true, suppressSimilarity: 0.9 } };
  assert.equal(triageSettings(config).staged, true);
  assert.equal(triageSettings(config).suppressSimilarity, 0.9);
  assert.equal(triageSettings(config).answer, 80);
  assert.equal(triageSettings(config).minSimilarity, 0.5);
  assert.throws(() => triageSettings({ ...config, triage: { confidence: { answer: 40, links: 50 } } }), ConfigError);
});
