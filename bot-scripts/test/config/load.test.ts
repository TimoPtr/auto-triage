import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateConfig, ConfigError } from '../../src/config/load.ts';

const fixture = fileURLToPath(new URL('../fixtures/config/android.yaml', import.meta.url));

test('loads the android fixture and applies defaults', () => {
  const config = loadConfig(fixture);
  assert.equal(config.product.slug, 'android');
  const android = config.providers.github['home-assistant/android'];
  assert.deepEqual(android.issues, { states: ['open', 'closed'], closedWithinDays: 730, comments: true });
  const companion = config.providers.github['home-assistant/companion.home-assistant'];
  assert.equal(companion.docs.audience, 'user');
  assert.equal(config.embedding.dimensions, 384);
});

test('rejects an unknown key with its path', () => {
  const config = loadConfig(fixture);
  (config.providers.github['home-assistant/android'].issues as unknown as Record<string, unknown>).includeBots = true;
  assert.throws(() => validateConfig(config), (e) => e instanceof ConfigError && /issues: .*includeBots/.test(e.message));
});

test('rejects an unknown provider', () => {
  const config = loadConfig(fixture);
  (config.providers as Record<string, unknown>).gitlab = {};
  assert.throws(() => validateConfig(config), (e) => e instanceof ConfigError && /providers: .*gitlab/.test(e.message));
});

test('rejects a missing embedding section', () => {
  const config = loadConfig(fixture);
  delete config.embedding;
  assert.throws(() => validateConfig(config), (e) => e instanceof ConfigError && /embedding/.test(e.message));
});

test('rejects a repository key that is not owner/name', () => {
  const config = loadConfig(fixture);
  config.providers.github['not a repo'] = { issues: {} as never };
  assert.throws(() => validateConfig(config), ConfigError);
});

test('closedWithinDays is optional and has no default', () => {
  const config = loadConfig(fixture);
  delete config.providers.github['home-assistant/android'].issues.closedWithinDays;
  const validated = validateConfig(config);
  assert.equal(validated.providers.github['home-assistant/android'].issues.closedWithinDays, undefined);
});
