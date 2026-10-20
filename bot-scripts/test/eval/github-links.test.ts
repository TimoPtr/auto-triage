import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchLinks, linksOf, LINKS_BATCH } from '../../src/eval/github-links.ts';
import { openRawStore } from '../../src/store/raw.ts';
import type { PaginatingClient } from '../../src/providers/types.ts';

const tmp = mkdtempSync(join(tmpdir(), 'kb-links-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const mark = (createdAt: string, number: number) => ({ __typename: 'MarkedAsDuplicateEvent', createdAt, canonical: { __typename: 'Issue', number } });
const unmark = (createdAt: string, number: number) => ({ __typename: 'UnmarkedAsDuplicateEvent', createdAt, canonical: { __typename: 'Issue', number } });

/** Answers every alias in the query from `answers`, keyed by alias; an alias in `failing` becomes a GraphQL error. */
function fakeClient(answers: Record<string, unknown>, failing: string[] = [], log: { query: string; variables: Record<string, unknown> }[] = []): PaginatingClient {
  return {
    async paginate() { throw new Error('not used'); },
    async graphqlPartial(query: string, variables: Record<string, unknown>) {
      log.push({ query, variables });
      const aliases = Array.from(query.matchAll(/\b([ip]\d+):\s*(?:issue|pullRequest)\(/g), (m) => m[1]);
      const repository: Record<string, unknown> = {};
      const errors: { message: string; path?: (string | number)[] }[] = [];
      for (const alias of aliases) {
        if (failing.includes(alias)) { repository[alias] = null; errors.push({ message: `Could not resolve to a node`, path: ['repository', alias] }); continue; }
        repository[alias] = answers[alias] ?? null;
      }
      return { data: { repository }, errors };
    },
  } as unknown as PaginatingClient;
}

const answers = {
  i10: { number: 10, timelineItems: { nodes: [mark('2025-01-01T00:00:00Z', 3), unmark('2025-01-02T00:00:00Z', 3)] } },
  i20: { number: 20, timelineItems: { nodes: [mark('2025-02-01T00:00:00Z', 10)] } },
  p40: { number: 40, closingIssuesReferences: { nodes: [{ number: 10 }, { number: 11 }] } },
};
const refs = [
  { kind: 'issue' as const, number: 10, updatedAt: '2025-03-01T00:00:00Z' },
  { kind: 'issue' as const, number: 20, updatedAt: '2025-03-01T00:00:00Z' },
  { kind: 'pull' as const, number: 40, updatedAt: '2025-03-01T00:00:00Z' },
];

test('fetches issue duplicates and pull closes in one batch', async () => {
  const raw = openRawStore(join(tmp, 'a.sqlite'));
  const log = [];
  const stats = await fetchLinks(fakeClient(answers, [], log), 'o/r', refs, raw);
  assert.deepEqual(stats, { fetched: 3, reused: 0, requests: 1 });
  assert.equal(log.length, 1);
  assert.deepEqual(log[0].variables, { owner: 'o', name: 'r' });
  assert.match(log[0].query, /MARKED_AS_DUPLICATE_EVENT, UNMARKED_AS_DUPLICATE_EVENT/);
  assert.deepEqual(linksOf(raw, 'o/r', 10), { kind: 'issue', duplicateOf: [], closes: [], markedAt: null });
  assert.deepEqual(linksOf(raw, 'o/r', 20), { kind: 'issue', duplicateOf: [10], closes: [], markedAt: '2025-02-01T00:00:00Z' });
  assert.deepEqual(linksOf(raw, 'o/r', 40), { kind: 'pull', duplicateOf: [], closes: [10, 11], markedAt: null });
  assert.equal(linksOf(raw, 'o/r', 99), null);
  raw.close();
});

test('reuses stored links when updatedAt matches', async () => {
  const raw = openRawStore(join(tmp, 'b.sqlite'));
  await fetchLinks(fakeClient(answers), 'o/r', refs, raw);
  const again = await fetchLinks(fakeClient(answers), 'o/r', refs, raw);
  assert.deepEqual(again, { fetched: 0, reused: 3, requests: 0 });
  const changed = await fetchLinks(fakeClient(answers), 'o/r', [{ ...refs[1], updatedAt: '2025-04-01T00:00:00Z' }], raw);
  assert.deepEqual(changed, { fetched: 1, reused: 0, requests: 1 });
  raw.close();
});

test('batches LINKS_BATCH refs per request', async () => {
  const raw = openRawStore(join(tmp, 'c.sqlite'));
  const many = Array.from({ length: 120 }, (_, i) => ({ kind: 'issue' as const, number: i + 1, updatedAt: 'u' }));
  const log = [];
  const stats = await fetchLinks(fakeClient({}, [], log), 'o/r', many, raw);
  assert.equal(LINKS_BATCH, 50);
  assert.equal(stats.requests, 3);
  assert.equal(log.length, 3);
  raw.close();
});

test('skips an alias with an error', async () => {
  const raw = openRawStore(join(tmp, 'd.sqlite'));
  const lines = [];
  const stats = await fetchLinks(fakeClient(answers, ['i10']), 'o/r', refs, raw, (l) => lines.push(l));
  assert.deepEqual(stats, { fetched: 2, reused: 0, requests: 1 });
  assert.equal(linksOf(raw, 'o/r', 10), null);
  assert.ok(linksOf(raw, 'o/r', 20));
  assert.ok(lines.some((l) => /i10|issue 10/.test(l)));
  raw.close();
});
