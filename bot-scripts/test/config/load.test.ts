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

test('applies defaults to the new github source kinds', () => {
  const android = loadConfig(fixture).providers.github['home-assistant/android'];
  assert.deepEqual(android.pulls, { states: ['merged', 'closed'], reviews: true, excludeBots: true });
  assert.deepEqual(android.discussions, { categories: ['general', 'q-a'], answers: true });
  assert.deepEqual(android.releases, { includePrereleases: false });
  assert.equal(android.code.ref, 'main');
  assert.equal(android.code.audience, 'maintainer');
  assert.equal(android.files[0].audience, 'maintainer');
});

test('applies defaults to a discourse site and rejects an unknown key', () => {
  const config = loadConfig(fixture);
  const site = config.providers.discourse['community.home-assistant.io'];
  assert.deepEqual(site, { categories: ['android-companion'], tags: ['android'], solvedOnly: false, acceptedAnswers: true, requestsPerSecond: 4 });
  (site as unknown as Record<string, unknown>).scrapeEverything = true;
  assert.throws(() => validateConfig(config), (e) => e instanceof ConfigError && /discourse.*scrapeEverything/.test(e.message));
});

test('a file entry needs a known kind', () => {
  const config = loadConfig(fixture);
  config.providers.github['home-assistant/android'].files.push({ path: 'x', kind: 'pdf' } as never);
  assert.throws(() => validateConfig(config), ConfigError);
});
