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

const tmp = mkdtempSync(join(tmpdir(), 'kb-build-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));
const issuesPage = JSON.parse(readFileSync(join(fixtures, 'github/issues-page.json'), 'utf8'));

const fakeFetch = async (url) => {
  const u = new URL(String(url));
  if (u.pathname === '/repos/home-assistant/android/issues') {
    const state = u.searchParams.get('state');
    return Response.json(issuesPage.filter((i) => state === 'all' || i.state === state));
  }
  if (u.pathname.endsWith('/comments')) return Response.json([]);
  return new Response('nope', { status: 404 });
};

const embedder = { modelKey: 'fake@1@q8@cls', dimensions: 4, async embed(texts) { return texts.map(() => Float32Array.from([1, 0, 0, 0])); } };

test('builds an index from the android fixture config with issues and docs', async () => {
  const config = loadConfig(join(fixtures, 'config/android.yaml'));
  // point both docs repositories at the docs fixture directory
  const checkouts = { 'home-assistant/companion.home-assistant': fixtures, 'home-assistant/contributors.home-assistant.io': fixtures };
  config.providers.github['home-assistant/companion.home-assistant'].docs.path = 'docs';
  config.providers.github['home-assistant/contributors.home-assistant.io'].docs.path = 'docs/android';
  const providers = createProviders(config, { githubToken: 't', fetchImpl: fakeFetch, checkouts, now: new Date('2026-10-15T00:00:00Z') });
  const out = join(tmp, 'knowledge.sqlite');
  const stats = await buildIndex({ config, configHash: 'abc', outPath: out, embedder, providers });
  // two indexable issues (one closed in the window, one long-standing open), three docs fixtures under docs/, two under docs/android
  assert.equal(stats.items, 2 + 3 + 2);
  const db = openDatabase(out, { readOnly: true });
  // node:sqlite rows have a null prototype, which strict deepEqual rejects; compare plain copies
  const sources = db.prepare('SELECT source, count(*) c FROM items GROUP BY source ORDER BY source').all().map((r) => ({ ...r }));
  assert.deepEqual(sources, [{ source: 'docs', c: 5 }, { source: 'issue', c: 2 }]);
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
