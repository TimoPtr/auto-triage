import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config/load.ts';
import { buildIndex } from '../../src/index/build.ts';
import { createProviders } from '../../src/providers/registry.ts';
import { openDatabase, readMeta } from '../../src/store/db.ts';
import { openRawStore } from '../../src/store/raw.ts';

const tmp = mkdtempSync(join(tmpdir(), 'kb-build-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));
const issuesPage = JSON.parse(readFileSync(join(fixtures, 'github/issues-page.json'), 'utf8'));

const fakeFetch = async (url, init) => {
  const u = new URL(String(url));
  if (u.pathname === '/repos/home-assistant/android/issues') {
    const state = u.searchParams.get('state');
    return Response.json(issuesPage.filter((i) => state === 'all' || i.state === state));
  }
  if (u.pathname.endsWith('/comments') || u.pathname.endsWith('/files')) return Response.json([]);
  if (u.pathname.endsWith('/pulls') || u.pathname.endsWith('/releases')) return Response.json([]);
  if (u.pathname === '/graphql') {
    const query = JSON.parse(String(init?.body ?? '{}')).query ?? '';
    if (query.includes('discussionCategories')) return Response.json({ data: { repository: { discussionCategories: { nodes: [{ id: 'C1', slug: 'general' }, { id: 'C2', slug: 'q-a' }] } } } });
    return Response.json({ data: { repository: { discussions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
  }
  if (u.hostname === 'community.example' && u.pathname === '/site.json') return Response.json({ categories: [{ id: 1, slug: 'general' }] });
  if (u.hostname === 'community.example' && u.pathname === '/c/general/1.json') return Response.json({ topic_list: { topics: [] } });
  return new Response('nope', { status: 404 });
};

const embedder = { modelKey: 'fake@1@q8@cls', dimensions: 4, async embed(texts) { return texts.map(() => Float32Array.from([1, 0, 0, 0])); } };

test('builds an index from the android fixture config with issues and docs', async () => {
  const config = loadConfig(join(fixtures, 'config/android.yaml'));
  // this test covers the sources that need no consumer checkout and no forum
  delete config.providers.github['home-assistant/android'].code;
  delete config.providers.github['home-assistant/android'].files;
  delete config.providers.discourse;
  // point both docs repositories at the docs fixture directory
  const checkouts = { 'home-assistant/companion.home-assistant': fixtures, 'home-assistant/contributors.home-assistant.io': fixtures };
  config.providers.github['home-assistant/companion.home-assistant'].docs.path = 'docs';
  config.providers.github['home-assistant/contributors.home-assistant.io'].docs.path = 'docs/android';
  const providers = createProviders(config, { githubToken: 't', fetchImpl: fakeFetch, checkouts, now: new Date('2026-10-15T00:00:00Z') });
  const out = join(tmp, 'knowledge.sqlite');
  const stats = await buildIndex({ config, configHash: 'abc', outPath: out, embedder, providers });
  // two indexable issues (one closed in the window, one long-standing open), four docs fixtures under docs/ (evil.md included), two under docs/android
  assert.equal(stats.items, 2 + 4 + 2);
  const db = openDatabase(out, { readOnly: true });
  // node:sqlite rows have a null prototype, which strict deepEqual rejects; compare plain copies
  const sources = db.prepare('SELECT source, count(*) c FROM items GROUP BY source ORDER BY source').all().map((r) => ({ ...r }));
  assert.deepEqual(sources, [{ source: 'docs', c: 6 }, { source: 'issue', c: 2 }]);
  const meta = readMeta(db);
  assert.equal(meta.product, 'android');
  assert.equal(meta.config_hash, 'abc');
  db.close();
});

test('fails when a configured provider has no checkout for a docs repository', async () => {
  const config = loadConfig(join(fixtures, 'config/android.yaml'));
  const providers = createProviders(config, { githubToken: 't', fetchImpl: fakeFetch, checkouts: {}, now: new Date() });
  await assert.rejects(() => buildIndex({ config, configHash: 'x', outPath: join(tmp, 'never.sqlite'), embedder, providers }), /checkout/);
});

test('wires every configured source kind and the discourse provider', async () => {
  const config = loadConfig(join(fixtures, 'config/android.yaml'));
  const self = join(fixtures, 'code');
  config.providers.github['home-assistant/android'].files = [];
  config.providers.discourse = { 'community.example': { categories: ['general'], tags: [], solvedOnly: false, acceptedAnswers: true, requestsPerSecond: 50 } };
  const checkouts = { 'home-assistant/android': self, 'home-assistant/companion.home-assistant': fixtures, 'home-assistant/contributors.home-assistant.io': fixtures };
  config.providers.github['home-assistant/companion.home-assistant'].docs.path = 'docs';
  config.providers.github['home-assistant/contributors.home-assistant.io'].docs.path = 'docs/android';
  const raw = openRawStore(join(tmp, 'wired.raw.sqlite'));
  const providers = createProviders(config, { githubToken: 't', fetchImpl: fakeFetch, sleepImpl: async () => {}, checkouts, now: new Date('2026-10-15T00:00:00Z'), raw });
  assert.deepEqual(providers.map((p) => p.name), ['github', 'discourse']);
  const stats = await buildIndex({ config, configHash: 'w', outPath: join(tmp, 'wired.sqlite'), embedder, providers });
  const db = openDatabase(join(tmp, 'wired.sqlite'), { readOnly: true });
  const sources = db.prepare('SELECT source, count(*) c FROM items GROUP BY source ORDER BY source').all().map((r) => ({ ...r }));
  db.close();
  assert.deepEqual(sources, [{ source: 'code', c: 1 }, { source: 'docs', c: 6 }, { source: 'issue', c: 2 }]);
  assert.ok(stats.items >= 9);
  assert.ok(raw.count() >= 2, 'the issues were recorded in the raw store');
  raw.close();
});

test('logs the item count and elapsed time of every provider and of the whole build', async () => {
  const config = loadConfig(join(fixtures, 'config/android.yaml'));
  delete config.providers.github['home-assistant/android'].code;
  delete config.providers.github['home-assistant/android'].files;
  delete config.providers.discourse;
  config.providers.github['home-assistant/companion.home-assistant'].docs.path = 'docs';
  config.providers.github['home-assistant/contributors.home-assistant.io'].docs.path = 'docs/android';
  const checkouts = { 'home-assistant/companion.home-assistant': fixtures, 'home-assistant/contributors.home-assistant.io': fixtures };
  const providers = createProviders(config, { githubToken: 't', fetchImpl: fakeFetch, checkouts, now: new Date('2026-10-15T00:00:00Z') });
  const lines = [];
  await buildIndex({ config, configHash: 't', outPath: join(tmp, 'timed.sqlite'), embedder, providers, log: (l) => lines.push(l) });
  assert.ok(lines.some((l) => /^github: 8 items in \d+(\.\d+)?s$/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /^build finished in \d+(\.\d+)?s$/.test(l)), lines.join('\n'));
});
