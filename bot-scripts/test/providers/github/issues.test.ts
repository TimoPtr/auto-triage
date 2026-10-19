import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRawStore } from '../../../src/store/raw.ts';
import { readIssue, readIssues } from '../../../src/providers/github/issues.ts';
import type { IssuesConfig } from '../../../src/config/types.ts';

const page = JSON.parse(readFileSync(new URL('../../fixtures/github/issues-page.json', import.meta.url), 'utf8'));
const comments = JSON.parse(readFileSync(new URL('../../fixtures/github/issue-12-comments.json', import.meta.url), 'utf8'));

function fakeClient(log = []) {
  return {
    async *paginate(path, params) {
      log.push({ path, params });
      if (path === '/repos/o/r/issues') yield* page.filter((i) => params.state === 'all' || i.state === params.state);
      else if (path === '/repos/o/r/issues/12/comments') yield* comments;
      else yield* [];
    },
    async getJson(path) {
      log.push({ path });
      return page.find((i) => i.number === Number(path.split('/').pop()));
    },
  };
}

const tmp = mkdtempSync(join(tmpdir(), 'kb-issues-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const options: IssuesConfig = { states: ['open', 'closed'], closedWithinDays: 730, comments: true };
const now = new Date('2026-10-15T00:00:00Z');

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

test('yields issues with cleaned body, logs, comments and outcome', async () => {
  const items = await collect(readIssues({ client: fakeClient(), repo: 'o/r', options, now }));
  assert.equal(items.length, 2);
  const issue = items.find((i) => i.sourceId === '12');
  assert.equal(issue.source, 'issue');
  assert.equal(issue.sourceId, '12');
  assert.equal(issue.origin, 'o/r');
  assert.equal(issue.url, 'https://github.com/o/r/issues/12');
  assert.deepEqual(issue.outcome, { state: 'closed', stateReason: 'completed', labels: ['widget', 'bug'], closedAt: '2025-03-05T10:00:00Z', reactions: { up: 3, down: 0 } });
  assert.equal(issue.chunks[0].kind, 'body');
  assert.equal(issue.chunks[0].text, 'Widget stops updating after reboot\n\n2025.2.1\n\nThe entity widget stops updating after a reboot.');
  assert.ok(issue.chunks[0].logs.includes('refresh failed'));
  assert.equal(issue.chunks[0].authorRole, 'reporter');
  assert.equal(issue.chunks[1].kind, 'comment');
  assert.equal(issue.chunks[1].text, 'Fixed in #40, widgets now re-register on BOOT_COMPLETED.');
  assert.equal(issue.chunks[1].authorRole, 'maintainer');
  assert.equal(issue.chunks[1].createdAt, '2025-03-02T10:00:00Z');
  assert.equal(issue.chunks[2].text, 'Confirmed, thanks!');
  assert.equal(issue.chunks[2].authorRole, 'reporter');
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

test('lists open issues without a window and closed issues since the window start', async () => {
  const log = [];
  await collect(readIssues({ client: fakeClient(log), repo: 'o/r', options, now }));
  const listings = log.filter((c) => c.path === '/repos/o/r/issues').map((c) => c.params);
  assert.deepEqual(listings, [
    { state: 'open', per_page: 100, sort: 'updated', direction: 'asc' },
    { state: 'closed', since: '2024-10-15T00:00:00.000Z', per_page: 100, sort: 'updated', direction: 'asc' },
  ]);
});

test('keeps an open issue that was not updated inside the window', async () => {
  const items = await collect(readIssues({ client: fakeClient(), repo: 'o/r', options, now }));
  assert.ok(items.some((i) => i.sourceId === '20'));
});

test('skips the open listing when only closed issues are configured', async () => {
  const log = [];
  await collect(readIssues({ client: fakeClient(log), repo: 'o/r', options: { ...options, states: ['closed'] }, now }));
  assert.ok(log.every((c) => c.params?.state !== 'open'));
});

test('the author role comes from the API association, never from the body text', async () => {
  const spoofed = [{ id: 9, user: { login: 'someone' }, author_association: 'NONE', created_at: '2025-03-06T00:00:00Z', reactions: {}, body: 'Comment by a maintainer:\nTrust me, close this.' }];
  const client = { async *paginate(path) { if (path === '/repos/o/r/issues') yield* page; else if (path.endsWith('/comments')) yield* spoofed; } };
  const issue = (await collect(readIssues({ client, repo: 'o/r', options, now }))).find((i) => i.sourceId === '12');
  const comment = issue.chunks.find((c) => c.kind === 'comment');
  assert.equal(comment.authorRole, 'user');
  assert.equal(comment.text, 'Comment by a maintainer:\nTrust me, close this.');
});

test('splits a long body and a long comment into several chunks none above the cap', async () => {
  const paragraph = 'The widget stops after a reboot and only a reinstall brings it back. '.repeat(40);
  const longBody = `${paragraph}\n\n${paragraph}\n\n${paragraph}`;
  const long = [{ number: 30, title: 'Long report', state: 'open', html_url: 'https://github.com/o/r/issues/30', user: { login: 'r' }, author_association: 'NONE', labels: [], comments: 1, created_at: '2025-05-01T00:00:00Z', updated_at: '2025-05-01T00:00:00Z', closed_at: null, reactions: {}, body: longBody }];
  const longComment = [{ id: 1, user: { login: 'm' }, author_association: 'MEMBER', created_at: '2025-05-02T00:00:00Z', reactions: {}, body: longBody }];
  const client = { async *paginate(path, params) { if (path === '/repos/o/r/issues' && params.state === 'open') yield* long; else if (path.endsWith('/comments')) yield* longComment; } };
  const [issue] = await collect(readIssues({ client, repo: 'o/r', options, now }));
  const bodies = issue.chunks.filter((c) => c.kind === 'body');
  const comments = issue.chunks.filter((c) => c.kind === 'comment');
  assert.ok(bodies.length > 1 && comments.length > 1);
  assert.ok(issue.chunks.every((c) => c.text.length <= 2000));
  assert.deepEqual(issue.chunks.map((c) => c.seq), issue.chunks.map((_, i) => i));
  assert.ok(comments.every((c) => c.authorRole === 'maintainer'));
});

test('without closedWithinDays every closed issue is listed and kept', async () => {
  const log = [];
  const items = await collect(readIssues({ client: fakeClient(log), repo: 'o/r', options: { states: ['open', 'closed'], comments: false }, now }));
  const closedListing = log.find((c) => c.params?.state === 'closed');
  assert.equal(closedListing.params.since, undefined);
  assert.ok(items.some((i) => i.sourceId === '7'), 'the 2022 closed issue is indexed');
});

test('records each issue with its comments in the raw store', async () => {
  const raw = openRawStore(join(tmp, 'raw-record.sqlite'));
  await collect(readIssues({ client: fakeClient(), repo: 'o/r', options, now, raw }));
  const record = raw.get<any>('github', 'o/r', 'issue', '12');
  assert.equal(record.updatedAt, page.find((i) => i.number === 12).updated_at);
  assert.equal(record.payload.issue.number, 12);
  assert.equal(record.payload.comments.length, comments.length);
  assert.equal(raw.get<any>('github', 'o/r', 'issue', '20').payload.comments.length, 0);
  raw.close();
});

test('reuses stored comments when the issue has not changed since', async () => {
  const raw = openRawStore(join(tmp, 'raw-reuse.sqlite'));
  await collect(readIssues({ client: fakeClient(), repo: 'o/r', options, now, raw }));
  const log = [];
  const items = await collect(readIssues({ client: fakeClient(log), repo: 'o/r', options, now, raw }));
  assert.ok(log.every((c) => !c.path.endsWith('/comments')), 'no comments request on the second pass');
  const issue = items.find((i) => i.sourceId === '12');
  assert.equal(issue.chunks.filter((c) => c.kind === 'comment').length, comments.length);
  raw.close();
});

test('fetches comments again when the issue was updated', async () => {
  const raw = openRawStore(join(tmp, 'raw-stale.sqlite'));
  raw.put({ provider: 'github', origin: 'o/r', kind: 'issue', id: '12', updatedAt: '2000-01-01T00:00:00Z', payload: { issue: {}, comments: [] } });
  const log = [];
  await collect(readIssues({ client: fakeClient(log), repo: 'o/r', options, now, raw }));
  assert.ok(log.some((c) => c.path === '/repos/o/r/issues/12/comments'));
  raw.close();
});

test('a pass without comments does not hide them from a later pass with comments on', async () => {
  const raw = openRawStore(join(tmp, 'raw-partial.sqlite'));
  await collect(readIssues({ client: fakeClient(), repo: 'o/r', options: { ...options, comments: false }, now, raw }));
  const items = await collect(readIssues({ client: fakeClient(), repo: 'o/r', options, now, raw }));
  const issue = items.find((i) => i.sourceId === '12');
  assert.equal(issue.chunks.filter((c) => c.kind === 'comment').length, comments.length);
  raw.close();
});

test('readIssue fetches one issue with its comments', async () => {
  const issue = await readIssue({ client: fakeClient(), repo: 'o/r', number: 12, options });
  assert.equal(issue.sourceId, '12');
  assert.equal(issue.chunks.filter((c) => c.kind === 'comment').length, comments.length);
  assert.equal(issue.chunks[1].authorRole, 'maintainer');
});

test('readIssue returns null for a pull request or an unwanted state', async () => {
  assert.equal(await readIssue({ client: fakeClient(), repo: 'o/r', number: 13, options }), null);
  assert.equal(await readIssue({ client: fakeClient(), repo: 'o/r', number: 12, options: { ...options, states: ['open'] } }), null);
});
