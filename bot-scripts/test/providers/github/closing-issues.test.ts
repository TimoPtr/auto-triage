import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOSING_BATCH, fetchClosingIssues } from '../../../src/providers/github/closing-issues.ts';
import type { PaginatingClient } from '../../../src/providers/types.ts';

function fake(answers: Record<string, number[]>, log: { query: string }[] = []): PaginatingClient {
  return {
    async *paginate() { yield* []; },
    async graphqlPartial(query: string) {
      log.push({ query });
      const repository: Record<string, unknown> = {};
      for (const [, alias] of query.matchAll(/\b(p\d+):\s*pullRequest\(/g)) repository[alias] = alias in answers ? { closingIssuesReferences: { nodes: answers[alias].map((number) => ({ number })) } } : null;
      return { data: { repository }, errors: [] };
    },
  } as unknown as PaginatingClient;
}

test('maps each pull request to the issues GitHub says it closes, batched', async () => {
  const log = [];
  const numbers = Array.from({ length: CLOSING_BATCH + 1 }, (_, i) => i + 1);
  const out = await fetchClosingIssues(fake({ p1: [7, 8], p51: [] }, log), 'o/r', numbers);
  assert.equal(log.length, 2);
  assert.deepEqual(out.get(1), [7, 8]);
  assert.deepEqual(out.get(51), []);
  assert.equal(out.has(2), false, 'an unresolved alias is absent, not empty');
});

test('asks nothing for an empty list and refuses a client without GraphQL or a bad number', async () => {
  const log = [];
  assert.equal((await fetchClosingIssues(fake({}, log), 'o/r', [])).size, 0);
  assert.equal(log.length, 0);
  await assert.rejects(fetchClosingIssues({ async *paginate() { yield* []; } }, 'o/r', [1]), /GraphQL/);
  await assert.rejects(fetchClosingIssues(fake({}), 'o/r', [1.5]), /bad pull request number/);
});
