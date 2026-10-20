import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config/load.ts';
import { buildIndex } from '../../src/index/build.ts';
import type { BuildPlan } from '../../src/index/plan.ts';
import { createProviders } from '../../src/providers/registry.ts';
import { createReplayFetch } from '../../src/providers/replay.ts';
import { openDatabase } from '../../src/store/db.ts';
import { openRawStore } from '../../src/store/raw.ts';

const tmp = mkdtempSync(join(tmpdir(), 'kb-replay-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(fixtures, name), 'utf8'));
const issuesPage = fixture('github/issues-page.json');
const releases = [{ tag_name: '2026.8.4', name: '', draft: false, prerelease: false, published_at: '2026-08-31T09:42:13Z', html_url: 'https://github.com/home-assistant/android/releases/tag/2026.8.4', body: '## Highlights\n* Added a sensor' }];
const discussion = { number: 5, title: 'How do I', url: 'https://github.com/home-assistant/android/discussions/5', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', closed: false, isAnswered: true, category: { slug: 'general' }, bodyText: 'How do I set a widget?', author: { login: 'u' }, authorAssociation: 'NONE', comments: { totalCount: 1 }, answer: { bodyText: 'Long press.', createdAt: '2026-01-02T00:00:00Z', author: { login: 'm' }, authorAssociation: 'MEMBER' } };
const discourse = {
  '/site.json': fixture('discourse/site.json'),
  '/c/android-companion/42.json?page=0': fixture('discourse/category-page-0.json'),
  '/c/android-companion/42.json?page=1': fixture('discourse/category-page-1.json'),
  '/t/100.json': fixture('discourse/topic-100.json'),
  '/t/101.json': fixture('discourse/topic-101.json'),
  '/t/102.json': fixture('discourse/topic-102.json'),
};

const onlineFetch = async (url, init) => {
  const u = new URL(String(url));
  if (u.hostname === 'community.example') { const body = discourse[u.pathname + u.search]; return body ? Response.json(body) : new Response('nope', { status: 404 }); }
  const p = u.pathname;
  if (p === '/repos/home-assistant/android/issues') { const state = u.searchParams.get('state'); return Response.json(issuesPage.filter((i) => state === 'all' || i.state === state)); }
  if (p === '/repos/home-assistant/android/issues/12/comments') return Response.json(fixture('github/issue-12-comments.json'));
  if (p === '/repos/home-assistant/android/pulls') return Response.json(fixture('github/pulls-page.json'));
  if (p === '/repos/home-assistant/android/pulls/40/comments') return Response.json(fixture('github/pull-40-review-comments.json'));
  if (p === '/repos/home-assistant/android/pulls/40/files') return Response.json(fixture('github/pull-40-files.json'));
  if (p.endsWith('/comments') || p.endsWith('/files')) return Response.json([]);
  if (p === '/repos/home-assistant/android/releases') return Response.json(releases);
  if (p === '/graphql') {
    const query = JSON.parse(String(init?.body ?? '{}')).query ?? '';
    if (query.includes('discussionCategories')) return Response.json({ data: { repository: { discussionCategories: { nodes: [{ id: 'C1', slug: 'general' }] } } } });
    return Response.json({ data: { repository: { discussions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [discussion] } } } });
  }
  return new Response('nope', { status: 404 });
};

const plan: BuildPlan = { mode: 'full', since: null, reason: 'test', fullBuiltAt: '2026-10-15T00:00:00Z' };
const embedder = { modelKey: 'fake@1@q8@cls', dimensions: 4, async embed(texts) { return texts.map(() => Float32Array.from([1, 0, 0, 0])); } };
const now = new Date('2026-10-15T00:00:00Z');

function config() {
  const c = loadConfig(join(fixtures, 'config/android.yaml'));
  delete c.providers.github['home-assistant/companion.home-assistant'];
  delete c.providers.github['home-assistant/contributors.home-assistant.io'];
  const android = c.providers.github['home-assistant/android'];
  delete android.code;
  delete android.files;
  android.discussions.categories = ['general'];
  c.providers.discourse = { 'community.example': { categories: ['android-companion'], tags: [], solvedOnly: false, acceptedAnswers: true, requestsPerSecond: 50 } };
  return c;
}

function rows(path: string) {
  const db = openDatabase(path, { readOnly: true });
  const items = db.prepare('SELECT source, source_id, title FROM items ORDER BY source, source_id').all().map((r) => ({ ...r }));
  const hashes = db.prepare('SELECT hash FROM chunks ORDER BY hash').all().map((r) => r.hash);
  db.close();
  return { items, hashes };
}

test('rebuilds the same items from the raw store without the network', async () => {
  const raw = openRawStore(join(tmp, 'raw.sqlite'));
  const online = createProviders(config(), { githubToken: 't', fetchImpl: onlineFetch, sleepImpl: async () => {}, now, raw });
  await buildIndex({ config: config(), configHash: 'a', outPath: join(tmp, 'online.sqlite'), embedder, providers: online, plan });

  let calls = 0;
  const replay = createReplayFetch(raw, { hosts: { 'community.example': ['android-companion'] } });
  const spy = async (url, init) => { calls += 1; return replay(url, init); };
  const offline = createProviders(config(), { fetchImpl: spy, now, raw, offline: true });
  await buildIndex({ config: config(), configHash: 'a', outPath: join(tmp, 'offline.sqlite'), embedder, providers: offline, plan });
  raw.close();

  const a = rows(join(tmp, 'online.sqlite'));
  const b = rows(join(tmp, 'offline.sqlite'));
  assert.ok(calls > 0);
  assert.ok(a.items.some((i) => i.source === 'forum') && a.items.some((i) => i.source === 'pull') && a.items.some((i) => i.source === 'discussion') && a.items.some((i) => i.source === 'release'));
  assert.deepEqual(b.items, a.items);
  assert.deepEqual(b.hashes, a.hashes);
});

test('serves issue listings filtered by state and since', async () => {
  const raw = openRawStore(join(tmp, 'listing.raw.sqlite'));
  for (const issue of issuesPage) raw.put({ provider: 'github', origin: 'o/r', kind: 'issue', id: String(issue.number), updatedAt: issue.updated_at, payload: { issue, comments: [], complete: true } });
  const fetch = createReplayFetch(raw);
  const numbers = async (query: string) => ((await (await fetch(`https://api.github.com/repos/o/r/issues?${query}`)).json()) as { number: number }[]).map((i) => i.number);
  assert.deepEqual(await numbers('state=closed&since=2025-03-04T00:00:00Z'), [7, 12]);
  assert.deepEqual(await numbers('state=open'), [20]);
  assert.deepEqual(await numbers('state=all'), [20, 13, 7, 12]);
  assert.equal((await fetch('https://api.github.com/repos/o/r/unknown')).status, 404);
  raw.close();
});
