import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchIssue } from '../../src/triage/issue.ts';

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/github/issue-7654.json', import.meta.url)), 'utf8'));

test('reads an issue through the client', async () => {
  const client = { async getJson(path: string) { assert.equal(path, 'repos/o/r/issues/7654'); return fixture; } };
  const issue = await fetchIssue(client, 'o/r', 7654);
  assert.equal(issue.number, 7654);
  assert.equal(issue.title, fixture.title);
  assert.equal(issue.body, fixture.body);
  assert.equal(issue.isPullRequest, false);
  assert.equal(issue.authorType, 'User');
  assert.equal(issue.state, 'open');
  assert.equal(issue.createdAt, fixture.created_at);
  assert.deepEqual(issue.labels, fixture.labels.map((l: { name: string }) => l.name));
  assert.equal(issue.subIssues, 0);
});

test('counts the sub-issues of a parent issue', async () => {
  const client = { async getJson() { return { ...fixture, sub_issues_summary: { total: 3, completed: 1, percent_completed: 33 } }; } };
  assert.equal((await fetchIssue(client, 'o/r', 7654)).subIssues, 3);
});

test('marks pull requests and bots and tolerates a missing body', async () => {
  const client = { async getJson() { return { ...fixture, body: null, pull_request: { url: 'x' }, user: { login: 'renovate[bot]', type: 'Bot' } }; } };
  const issue = await fetchIssue(client, 'o/r', 7654);
  assert.equal(issue.isPullRequest, true);
  assert.equal(issue.authorType, 'Bot');
  assert.equal(issue.body, '');
});

test('refuses an invalid number or repository before any request', async () => {
  const client = { async getJson<T>(): Promise<T> { throw new Error('must not be called'); } };
  await assert.rejects(fetchIssue(client, 'o/r', 0), /issue number/);
  await assert.rejects(fetchIssue(client, 'o/r', 1.5), /issue number/);
  await assert.rejects(fetchIssue(client, 'o/r/x', 1), /repository/);
  await assert.rejects(fetchIssue(client, 'o/..', 1), /repository/);
  await assert.rejects(fetchIssue(client, '../r', 1), /repository/);
  await assert.rejects(fetchIssue(client, '-o/r', 1), /repository/);
});
