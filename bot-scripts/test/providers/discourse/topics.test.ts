import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiscourseClient } from '../../../src/providers/discourse/client.ts';
import { readTopics } from '../../../src/providers/discourse/topics.ts';
import { openRawStore } from '../../../src/store/raw.ts';
import type { DiscourseSiteConfig } from '../../../src/config/types.ts';

const tmp = mkdtempSync(join(tmpdir(), 'kb-discourse-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/discourse/${name}`, import.meta.url), 'utf8'));
const routes = {
  '/site.json': fixture('site.json'),
  '/c/android-companion/42.json?page=0': fixture('category-page-0.json'),
  '/c/android-companion/42.json?page=1': fixture('category-page-1.json'),
  '/t/100.json': fixture('topic-100.json'),
  '/t/101.json': fixture('topic-101.json'),
  '/t/102.json': fixture('topic-102.json'),
};
function fakeFetch(log = []) {
  return async (url) => {
    const u = new URL(String(url));
    const key = u.pathname + u.search;
    log.push(key);
    const body = routes[key];
    return body ? Response.json(body) : new Response('nope', { status: 404 });
  };
}
const sleeps = [];
function client(log = []) {
  let clock = 0;
  return createDiscourseClient({ host: 'community.example', fetchImpl: fakeFetch(log), sleepImpl: async (ms) => { sleeps.push(ms); clock += ms; }, nowImpl: () => clock, requestsPerSecond: 4 });
}
const base: DiscourseSiteConfig = { categories: ['android-companion'], tags: [], solvedOnly: false, acceptedAnswers: true, requestsPerSecond: 4 };
async function collect(options = base, log = [], raw = undefined) { const out = []; for await (const i of readTopics({ client: client(log), host: 'community.example', options, now: new Date('2026-10-15T00:00:00Z'), raw })) out.push(i); return out; }

test('resolves the category, pages the list and yields body and accepted answer', async () => {
  const items = await collect();
  assert.deepEqual(items.map((i) => i.sourceId), ['100', '101', '102']);
  const t = items[0];
  assert.equal(t.source, 'forum');
  assert.equal(t.provider, 'discourse');
  assert.equal(t.url, 'https://community.example/t/widget-not-updating/100');
  assert.equal(t.chunks[0].kind, 'body');
  assert.equal(t.chunks[0].text, 'Widget not updating\n\nMy widget stops & never refreshes.\n\nAndroid 15.');
  assert.equal(t.chunks[1].kind, 'answer');
  assert.equal(t.chunks[1].text, 'Disable battery optimisation for the app.');
  assert.deepEqual(t.outcome, { solved: true, closed: false, tags: ['android'], views: 120, likeCount: 2, postsCount: 3 });
});

test('stops paging when the next page repeats', async () => {
  const log = [];
  await collect(base, log);
  assert.equal(log.filter((k) => k.includes('page=1')).length, 1);
});

test('filters by tag and by window', async () => {
  assert.deepEqual((await collect({ ...base, tags: ['android'] })).map((i) => i.sourceId), ['100', '102']);
  assert.deepEqual((await collect({ ...base, closedWithinDays: 365 })).map((i) => i.sourceId), ['100', '101']);
});

test('solvedOnly keeps topics with an accepted answer', async () => {
  assert.deepEqual((await collect({ ...base, solvedOnly: true })).map((i) => i.sourceId), ['100']);
});

test('throttles requests through the sleep hook', async () => {
  sleeps.length = 0;
  await collect();
  assert.ok(sleeps.length > 0 && sleeps.every((ms) => ms <= 250));
});

test('a numeric category id is used as is and an unknown slug fails', async () => {
  assert.deepEqual((await collect({ ...base, categories: ['42'] })).map((i) => i.sourceId), ['100', '101', '102']);
  await assert.rejects(() => collect({ ...base, categories: ['nope'] }), /nope/);
});

test('records topics in the raw store', async () => {
  const raw = openRawStore(join(tmp, 'raw.sqlite'));
  await collect(base, [], raw);
  const record = raw.get<any>('discourse', 'community.example', 'topic', '100');
  assert.equal(record.updatedAt, '2026-03-05T00:00:00Z');
  assert.equal(record.payload.listed.slug, 'widget-not-updating');
  assert.equal(record.payload.topic.post_stream.posts.length, 2);
  raw.close();
});

test('reuses a stored topic when its last post did not move', async () => {
  const raw = openRawStore(join(tmp, 'raw-reuse.sqlite'));
  await collect(base, [], raw);
  const log = [];
  const items = await collect(base, log, raw);
  assert.ok(log.every((k) => !k.startsWith('/t/')), 'no topic request on the second pass');
  assert.equal(items[0].chunks[1].text, 'Disable battery optimisation for the app.');
  raw.close();
});
