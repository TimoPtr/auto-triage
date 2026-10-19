import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPulls } from '../../../src/providers/github/pulls.ts';
import { openRawStore } from '../../../src/store/raw.ts';
import type { PullsConfig } from '../../../src/config/types.ts';

const read = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/github/${name}`, import.meta.url), 'utf8'));
const page = read('pulls-page.json');
const reviewComments = read('pull-40-review-comments.json');
const files = read('pull-40-files.json');
const tmp = mkdtempSync(join(tmpdir(), 'kb-pulls-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

function fakeClient(log = []) {
  return {
    async *paginate(path, params) {
      log.push({ path, params });
      if (path === '/repos/o/r/pulls') yield* page;
      else if (path === '/repos/o/r/pulls/40/comments') yield* reviewComments;
      else if (path === '/repos/o/r/pulls/40/files') yield* files;
      else yield* [];
    },
  };
}
const options: PullsConfig = { states: ['merged', 'closed'], reviews: true, excludeBots: true };
const now = new Date('2026-10-15T00:00:00Z');
async function collect(opts = options, log = [], raw = undefined) { const out = []; for await (const i of readPulls({ client: fakeClient(log), repo: 'o/r', options: opts, now, raw })) out.push(i); return out; }

test('yields a merged pull request with body, linked issues, files and the maintainer review thread', async () => {
  const pr = (await collect()).find((i) => i.sourceId === '40');
  assert.equal(pr.source, 'pull');
  assert.equal(pr.outcome.state, 'merged');
  assert.deepEqual(pr.outcome.linkedIssues, [12, 9]);
  assert.deepEqual(pr.outcome.files, ['app/src/main/kotlin/Widget.kt', 'CHANGELOG.md']);
  assert.equal(pr.chunks[0].kind, 'body');
  assert.ok(pr.chunks[0].text.startsWith('Re-register widgets after boot'));
  const reviews = pr.chunks.filter((c) => c.kind === 'review');
  assert.equal(reviews.length, 1, 'only the thread with a maintainer reply');
  assert.ok(reviews[0].text.startsWith('app/src/main/kotlin/Widget.kt:12\n'));
  assert.ok(reviews[0].text.includes('WorkManager is delayed'));
  assert.equal(reviews[0].authorRole, 'maintainer');
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
  raw.close();
});

test('reuses stored review comments and files when the pull request has not changed', async () => {
  const raw = openRawStore(join(tmp, 'raw-reuse.sqlite'));
  await collect(options, [], raw);
  const log = [];
  const items = await collect(options, log, raw);
  assert.ok(log.every((c) => !c.path.endsWith('/comments') && !c.path.endsWith('/files')));
  const pr = items.find((i) => i.sourceId === '40');
  assert.equal(pr.chunks.filter((c) => c.kind === 'review').length, 1);
  assert.deepEqual(pr.outcome.files, ['app/src/main/kotlin/Widget.kt', 'CHANGELOG.md']);
  raw.close();
});
