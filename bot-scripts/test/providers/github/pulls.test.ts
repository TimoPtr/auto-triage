import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPull, readPulls } from '../../../src/providers/github/pulls.ts';
import { openRawStore } from '../../../src/store/raw.ts';
import type { PullsConfig } from '../../../src/config/types.ts';

const read = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/github/${name}`, import.meta.url), 'utf8'));
const page = read('pulls-page.json');
const reviewComments = read('pull-40-review-comments.json');
const files = read('pull-40-files.json');
const tmp = mkdtempSync(join(tmpdir(), 'kb-pulls-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

/** Closing references GitHub records per pull request in the fake; 40 also claims #9 in its body, 30 is a sidebar-only link. */
const closing = { p40: [12, 30], p41: [], p42: [] };
function fakeClient(log = [], { failing = [] } = {}) {
  return {
    async graphqlPartial(query, variables): Promise<any> {
      log.push({ path: '/graphql', query, variables });
      const repository = {};
      const errors = [];
      for (const [, alias] of query.matchAll(/\b(p\d+):\s*pullRequest\(/g)) {
        if (failing.includes(alias)) { repository[alias] = null; errors.push({ message: 'Could not resolve to a node', path: ['repository', alias] }); continue; }
        repository[alias] = { closingIssuesReferences: { nodes: (closing[alias] ?? []).map((number) => ({ number })) } };
      }
      return { data: { repository }, errors };
    },
    async *paginate(path, params) {
      log.push({ path, params });
      if (path === '/repos/o/r/pulls') yield* params.direction === 'desc' ? [...page].reverse() : page;
      else if (path === '/repos/o/r/pulls/40/comments') yield* reviewComments;
      else if (path === '/repos/o/r/pulls/40/files') yield* files;
      else yield* [];
    },
    async getJson(path) {
      log.push({ path });
      return page.find((p) => p.number === Number(path.split('/').pop()));
    },
  };
}
const options: PullsConfig = { states: ['merged', 'closed'], reviews: true, excludeBots: true };
const now = new Date('2026-10-15T00:00:00Z');
async function collect(opts = options, log = [], raw = undefined, since = undefined) { const out = []; for await (const i of readPulls({ client: fakeClient(log), repo: 'o/r', options: opts, now, raw, since })) out.push(i); return out; }

test('yields a merged pull request with body, linked issues, files and the maintainer review thread', async () => {
  const pr = (await collect()).find((i) => i.sourceId === '40');
  assert.equal(pr.source, 'pull');
  assert.equal(pr.outcome.state, 'merged');
  assert.deepEqual(pr.outcome.linkedIssues, [12, 30, 9], 'the closing references first, then what the body claims, each once');
  assert.deepEqual(pr.outcome.files, ['app/src/main/kotlin/Widget.kt', 'CHANGELOG.md']);
  assert.equal(pr.chunks[0].kind, 'body');
  assert.ok(pr.chunks[0].text.startsWith('Re-register widgets after boot'));
  const reviews = pr.chunks.filter((c) => c.kind === 'review');
  assert.equal(reviews.length, 2, 'only the thread with a maintainer reply, one chunk per comment');
  assert.ok(reviews.every((c) => c.text.startsWith('app/src/main/kotlin/Widget.kt:12\n')));
  assert.equal(reviews[0].authorRole, 'user', 'the question keeps its own role');
  assert.ok(reviews[0].text.includes('Why not use WorkManager'));
  assert.equal(reviews[1].authorRole, 'maintainer');
  assert.ok(reviews[1].text.includes('WorkManager is delayed'));
});

test('a review comment on an absurdly long path still yields bounded chunks', async () => {
  const longPath = 'a/'.repeat(1500) + 'File.kt';
  const comments = [
    { id: 1, in_reply_to_id: null, path: longPath, line: 1, user: { login: 'someone' }, author_association: 'NONE', created_at: '2025-03-02T11:00:00Z', body: 'q' },
    { id: 2, in_reply_to_id: 1, path: longPath, line: 1, user: { login: 'm' }, author_association: 'MEMBER', created_at: '2025-03-02T12:00:00Z', body: 'a' },
  ];
  const client = { ...fakeClient(), async *paginate(path) { if (path === '/repos/o/r/pulls') yield* page; else if (path.endsWith('/40/comments')) yield* comments; else yield* []; } };
  const out = [];
  for await (const i of readPulls({ client, repo: 'o/r', options, now })) out.push(i);
  const pr = out.find((i) => i.sourceId === '40');
  const reviews = pr.chunks.filter((c) => c.kind === 'review');
  assert.equal(reviews.length, 2);
  assert.ok(reviews.every((c) => c.text.length <= 2000));
});

test('reads the closing references of a listing in one request per batch', async () => {
  const log = [];
  await collect(options, log);
  const graphql = log.filter((c) => c.path === '/graphql');
  assert.equal(graphql.length, 1);
  assert.deepEqual(graphql[0].variables, { owner: 'o', name: 'r' });
  assert.ok(graphql[0].query.includes('p40: pullRequest(number: 40)') && graphql[0].query.includes('p42: pullRequest(number: 42)'));
  assert.ok(!graphql[0].query.includes('p41'), 'a pull request the filter drops is not asked for');
});

test('a pull request the API cannot resolve keeps the links of its body and is asked again next pass', async () => {
  const raw = openRawStore(join(tmp, 'raw-unresolved.sqlite'));
  const lines = [];
  const out = [];
  for await (const i of readPulls({ client: fakeClient([], { failing: ['p40'] }), repo: 'o/r', options, now, raw, log: (l) => lines.push(l) })) out.push(i);
  assert.deepEqual(out.find((i) => i.sourceId === '40').outcome.linkedIssues, [12, 9]);
  assert.ok(lines.some((l) => l.includes('Could not resolve')) && lines.some((l) => l.includes('no data for pull request 40')));
  assert.equal(raw.get<any>('github', 'o/r', 'pull', '40').payload.closingIssues, undefined);
  assert.deepEqual(raw.get<any>('github', 'o/r', 'pull', '42').payload.closingIssues, []);
  const log = [];
  const pr = (await collect(options, log, raw)).find((i) => i.sourceId === '40');
  assert.deepEqual(pr.outcome.linkedIssues, [12, 30, 9]);
  assert.ok(log.filter((c) => c.path === '/graphql').every((c) => c.query.includes('p40') && !c.query.includes('p42')), 'only the unresolved one is asked again');
  assert.ok(log.every((c) => !c.path.endsWith('/comments')), 'the stored reviews are reused');
  raw.close();
});

test('skips bot pull requests by default', async () => {
  assert.ok((await collect()).every((i) => i.sourceId !== '41'));
  assert.ok((await collect({ ...options, excludeBots: false })).some((i) => i.sourceId === '41'));
});

test('an unmerged pull request is state closed', async () => {
  const pr = (await collect()).find((i) => i.sourceId === '42');
  assert.equal(pr.outcome.state, 'closed');
  assert.equal(pr.outcome.mergedAt, null);
});

test('states filter drops unmerged pull requests when only merged is wanted', async () => {
  const items = await collect({ ...options, states: ['merged'] });
  assert.ok(items.every((i) => i.sourceId !== '42'));
});

test('does not fetch reviews or files when reviews are off', async () => {
  const log = [];
  await collect({ ...options, reviews: false }, log);
  assert.ok(log.every((c) => !c.path.endsWith('/comments') && !c.path.endsWith('/files')));
});

test('lists closed pull requests sorted by update', async () => {
  const log = [];
  await collect(options, log);
  assert.deepEqual(log[0], { path: '/repos/o/r/pulls', params: { state: 'closed', per_page: 100, sort: 'updated', direction: 'asc' } });
});

test('records the pull request in the raw store', async () => {
  const raw = openRawStore(join(tmp, 'raw-record.sqlite'));
  await collect(options, [], raw);
  const record = raw.get<any>('github', 'o/r', 'pull', '40');
  assert.equal(record.updatedAt, '2025-03-04T10:00:00Z');
  assert.equal(record.payload.pull.number, 40);
  assert.equal(record.payload.files.length, 2);
  assert.equal(record.payload.reviewComments.length, 3);
  assert.deepEqual(record.payload.closingIssues, [12, 30]);
  raw.close();
});

test('a record stored before closing references were read gets them without refetching reviews', async () => {
  const raw = openRawStore(join(tmp, 'raw-upgrade.sqlite'));
  await collect(options, [], raw);
  const record = raw.get<any>('github', 'o/r', 'pull', '40');
  delete record.payload.closingIssues;
  raw.put(record);
  const log = [];
  const pr = (await collect(options, log, raw)).find((i) => i.sourceId === '40');
  assert.deepEqual(pr.outcome.linkedIssues, [12, 30, 9]);
  assert.ok(log.every((c) => !c.path.endsWith('/comments') && !c.path.endsWith('/files')));
  assert.deepEqual(raw.get<any>('github', 'o/r', 'pull', '40').payload.closingIssues, [12, 30]);
  raw.close();
});

test('reuses stored review comments and files when the pull request has not changed', async () => {
  const raw = openRawStore(join(tmp, 'raw-reuse.sqlite'));
  await collect(options, [], raw);
  const log = [];
  const items = await collect(options, log, raw);
  assert.ok(log.every((c) => !c.path.endsWith('/comments') && !c.path.endsWith('/files') && c.path !== '/graphql'));
  const pr = items.find((i) => i.sourceId === '40');
  assert.equal(pr.chunks.filter((c) => c.kind === 'review').length, 2);
  assert.deepEqual(pr.outcome.files, ['app/src/main/kotlin/Widget.kt', 'CHANGELOG.md']);
  raw.close();
});

test('a pass without reviews does not hide them from a later pass with reviews on', async () => {
  const raw = openRawStore(join(tmp, 'raw-partial.sqlite'));
  await collect({ ...options, reviews: false }, [], raw);
  const pr = (await collect(options, [], raw)).find((i) => i.sourceId === '40');
  assert.equal(pr.chunks.filter((c) => c.kind === 'review').length, 2);
  assert.deepEqual(pr.outcome.files, ['app/src/main/kotlin/Widget.kt', 'CHANGELOG.md']);
  raw.close();
});

test('readPull fetches one merged pull request with its review threads and closing references', async () => {
  const pr = await readPull({ client: fakeClient(), repo: 'o/r', number: 40, options, now });
  assert.equal(pr.outcome.state, 'merged');
  assert.equal(pr.chunks.filter((c) => c.kind === 'review').length, 2);
  assert.deepEqual(pr.outcome.linkedIssues, [12, 30, 9]);
});

test('readPull returns null for a bot author, an unwanted state or an open pull request', async () => {
  assert.equal(await readPull({ client: fakeClient(), repo: 'o/r', number: 41, options, now }), null);
  assert.equal(await readPull({ client: fakeClient(), repo: 'o/r', number: 42, options: { ...options, states: ['merged'] }, now }), null);
  const open = { async getJson() { return { ...page[0], state: 'open', merged_at: null, closed_at: null }; }, async *paginate() { yield* []; }, async graphqlPartial() { throw new Error('not asked'); } };
  assert.equal(await readPull({ client: open, repo: 'o/r', number: 40, options, now }), null);
});

test('since lists newest first and stops at the first older pull request', async () => {
  const log = [];
  const items = await collect(options, log, undefined, new Date('2025-03-05T00:00:00Z'));
  assert.equal(log[0].params.direction, 'desc');
  assert.deepEqual(items.filter((i) => !i.remove).map((i) => i.sourceId), ['42']);
  assert.ok(log.every((c) => !c.path.endsWith('/40/comments') && !(c.path === '/graphql' && c.query.includes('p40'))), 'pull 40 is older than since and stops the listing before its details are fetched');
});

test('a bot pull request listed after since is a removal', async () => {
  const items = await collect(options, [], undefined, new Date('2025-03-05T00:00:00Z'));
  assert.deepEqual(items.find((i) => i.remove), { remove: true, provider: 'github', origin: 'o/r', source: 'pull', sourceId: '41' });
});
