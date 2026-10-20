import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDiscussions } from '../../../src/providers/github/discussions.ts';
import { openRawStore } from '../../../src/store/raw.ts';

const tmp = mkdtempSync(join(tmpdir(), 'kb-discussions-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const categories = { repository: { discussionCategories: { nodes: [{ id: 'C1', slug: 'general' }, { id: 'C2', slug: 'q-a' }] } } };
const pageFor = (categoryId, after) => ({ repository: { discussions: {
  pageInfo: { hasNextPage: categoryId === 'C1' && !after, endCursor: 'cur1' },
  nodes: categoryId === 'C1' && !after ? [{ number: 7, title: 'Wear OS battery', url: 'https://github.com/o/r/discussions/7', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-02T00:00:00Z', closed: false, isAnswered: true, category: { slug: 'general' }, bodyText: 'Battery drains on my watch.', author: { login: 'asker' }, authorAssociation: 'NONE', comments: { totalCount: 2 }, answer: { bodyText: 'Disable the always-on sensor.', author: { login: 'maint' }, authorAssociation: 'MEMBER', createdAt: '2025-01-02T00:00:00Z' } }]
    : categoryId === 'C1' ? [{ number: 8, title: 'Second page', url: 'https://github.com/o/r/discussions/8', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z', closed: true, isAnswered: false, category: { slug: 'general' }, bodyText: 'Old.', author: { login: 'x' }, authorAssociation: 'NONE', comments: { totalCount: 0 }, answer: null }]
    : [],
} } });

function fakeClient(log = []) {
  return {
    async *paginate() { yield* []; },
    async graphql(query, variables) {
      log.push({ query, variables });
      if (query.includes('discussionCategories')) return categories;
      return pageFor(variables.categoryId, variables.after);
    },
  };
}
async function collect(options = { categories: ['general', 'q-a'], answers: true }, log = [], raw = undefined, since = undefined) { const out = []; for await (const i of readDiscussions({ client: fakeClient(log) as any, repo: 'o/r', options, raw, since })) out.push(i); return out; }

test('resolves category slugs, pages each category and yields body and answer chunks', async () => {
  const items = await collect();
  assert.deepEqual(items.map((i) => i.sourceId), ['7', '8']);
  const d = items[0];
  assert.equal(d.source, 'discussion');
  assert.deepEqual(d.outcome, { closed: false, isAnswered: true, category: 'general', comments: 2 });
  assert.equal(d.chunks[0].kind, 'body');
  assert.equal(d.chunks[0].authorRole, 'reporter');
  assert.equal(d.chunks[1].kind, 'answer');
  assert.equal(d.chunks[1].authorRole, 'maintainer');
  assert.equal(d.chunks[1].text, 'Disable the always-on sensor.');
});

test('passes the cursor on the second page', async () => {
  const log = [];
  await collect(undefined, log);
  const pages = log.filter((c) => c.variables?.categoryId === 'C1').map((c) => c.variables.after);
  assert.deepEqual(pages, [null, 'cur1']);
});

test('fails naming an unknown category slug', async () => {
  await assert.rejects(() => collect({ categories: ['general', 'nope'], answers: true }), /nope/);
});

test('omits the answer chunk when answers are off', async () => {
  const [d] = await collect({ categories: ['general'], answers: false });
  assert.ok(d.chunks.every((c) => c.kind !== 'answer'));
});

test('records discussions in the raw store', async () => {
  const raw = openRawStore(join(tmp, 'raw.sqlite'));
  await collect(undefined, [], raw);
  const record = raw.get<any>('github', 'o/r', 'discussion', '7');
  assert.equal(record.updatedAt, '2025-01-02T00:00:00Z');
  assert.equal(record.payload.answer.bodyText, 'Disable the always-on sensor.');
  assert.equal(raw.count(), 2);
  raw.close();
});

test('since stops the discussion listing at the first older node', async () => {
  const log = [];
  const items = await collect({ categories: ['general'], answers: true }, log, undefined, new Date('2025-01-03T00:00:00Z'));
  assert.deepEqual(items, []);
  const pages = log.filter((c) => !c.query.includes('discussionCategories'));
  assert.equal(pages.length, 1, 'discussion 7 is already older than since, so the second page is never requested');
});

test('since stops before paging when the last node of a page is older', async () => {
  const log = [];
  const items = await collect({ categories: ['general'], answers: true }, log, undefined, new Date('2024-06-01T00:00:00Z'));
  assert.deepEqual(items.map((i) => i.sourceId), ['7']);
  assert.equal(log.filter((c) => !c.query.includes('discussionCategories')).length, 2, 'page two is requested, its only node is older and ends the listing');
});
