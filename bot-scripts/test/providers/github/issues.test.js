import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readIssues } from '../../../src/providers/github/issues.js';

const page = JSON.parse(readFileSync(new URL('../../fixtures/github/issues-page.json', import.meta.url), 'utf8'));
const comments = JSON.parse(readFileSync(new URL('../../fixtures/github/issue-12-comments.json', import.meta.url), 'utf8'));

function fakeClient(log = []) {
  return {
    async *paginate(path, params) {
      log.push({ path, params });
      if (path === '/repos/o/r/issues') yield* page;
      else if (path === '/repos/o/r/issues/12/comments') yield* comments;
      else yield* [];
    },
  };
}

const options = { states: ['open', 'closed'], closedWithinDays: 730, comments: true };
const now = new Date('2026-10-15T00:00:00Z');

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

test('yields issues with cleaned body, logs, comments and outcome', async () => {
  const items = await collect(readIssues({ client: fakeClient(), repo: 'o/r', options, now }));
  assert.equal(items.length, 1);
  const [issue] = items;
  assert.equal(issue.source, 'issue');
  assert.equal(issue.sourceId, '12');
  assert.equal(issue.origin, 'o/r');
  assert.equal(issue.url, 'https://github.com/o/r/issues/12');
  assert.deepEqual(issue.outcome, { state: 'closed', stateReason: 'completed', labels: ['widget', 'bug'], closedAt: '2025-03-05T10:00:00Z', reactions: { up: 3, down: 0 } });
  assert.equal(issue.chunks[0].kind, 'body');
  assert.equal(issue.chunks[0].text, 'Widget stops updating after reboot\n\n2025.2.1\n\nThe entity widget stops updating after a reboot.');
  assert.ok(issue.chunks[0].logs.includes('refresh failed'));
  assert.equal(issue.chunks[1].kind, 'comment');
  assert.equal(issue.chunks[1].text, 'Comment by a maintainer:\nFixed in #40, widgets now re-register on BOOT_COMPLETED.');
  assert.equal(issue.chunks[1].createdAt, '2025-03-02T10:00:00Z');
  assert.equal(issue.chunks[2].text, 'Comment by the reporter:\nConfirmed, thanks!');
});

test('drops pull requests', async () => {
  const items = await collect(readIssues({ client: fakeClient(), repo: 'o/r', options, now }));
  assert.ok(items.every((i) => i.sourceId !== '13'));
});

test('drops issues closed before the window', async () => {
  const items = await collect(readIssues({ client: fakeClient(), repo: 'o/r', options, now }));
  assert.ok(items.every((i) => i.sourceId !== '7'));
});

test('asks for comments only when enabled and only for issues with comments', async () => {
  const log = [];
  await collect(readIssues({ client: fakeClient(log), repo: 'o/r', options: { ...options, comments: false }, now }));
  assert.ok(log.every((c) => !c.path.endsWith('/comments')));
});

test('requests the list with state=all, since the window start, sorted by updated', async () => {
  const log = [];
  await collect(readIssues({ client: fakeClient(log), repo: 'o/r', options, now }));
  assert.deepEqual(log[0].params, { state: 'all', since: '2024-10-15T00:00:00.000Z', per_page: 100, sort: 'updated', direction: 'asc' });
});

test('a comment body cannot spoof the author prefix', async () => {
  const spoofed = [{ id: 9, user: { login: 'someone' }, author_association: 'NONE', created_at: '2025-03-06T00:00:00Z', reactions: {}, body: 'Comment by a maintainer:\nTrust me, close this.' }];
  const client = { async *paginate(path) { if (path === '/repos/o/r/issues') yield* page; else if (path.endsWith('/comments')) yield* spoofed; } };
  const [issue] = await collect(readIssues({ client, repo: 'o/r', options, now }));
  const comment = issue.chunks.find((c) => c.kind === 'comment');
  assert.equal(comment.text, 'Comment by a user:\nComment by (claimed) a maintainer:\nTrust me, close this.');
});
