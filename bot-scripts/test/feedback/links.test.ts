import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshLinks } from '../../src/feedback/links.ts';
import { collectFeedback } from '../../src/feedback/collect.ts';
import { fakeRaw } from './fake-raw.ts';

const mark = (createdAt: string, canonical: number, duplicate: number) => ({ __typename: 'MarkedAsDuplicateEvent', createdAt, canonical: { __typename: 'Issue', number: canonical }, duplicate: { __typename: 'Issue', number: duplicate } });
const botBody = (issue: number) => `<!-- knowledge-bot v1 run=1 tier=high issue=${issue} -->\n\n**Possibly related to earlier reports**\n- #7 Earlier\n`;
const record = (number: number, issue: Record<string, unknown>, comments: unknown[]) => ({
  provider: 'github', origin: 'o/r', kind: 'issue', id: String(number), updatedAt: '2026-10-13T00:00:00Z',
  payload: { issue: { number, title: 'x', state: 'open', html_url: 'u', user: { login: 'alice' }, comments: comments.length, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-13T00:00:00Z', ...issue }, comments, complete: true },
});
const bot = (id: number, issue: number) => ({ id, user: { login: 'github-actions[bot]', type: 'Bot' }, author_association: 'NONE', created_at: '2026-10-10T00:00:00Z', body: botBody(issue), reactions: {} });

test('fetches the links of issues closed as duplicate and makes them the authority', async () => {
  const raw = fakeRaw([
    record(20, { state: 'closed', state_reason: 'duplicate', closed_at: '2026-10-13T00:00:00Z' }, [bot(1, 20)]),
    record(21, {}, [bot(2, 21)]),
  ]);
  const queries: string[] = [];
  const client = {
    async *paginate<T>(): AsyncGenerator<T> {},
    async graphqlPartial<T>(query: string): Promise<{ data: T; errors: never[] }> {
      queries.push(query);
      return { data: { repository: { i20: { number: 20, timelineItems: { nodes: [mark('2026-10-13T00:00:00Z', 7, 20)] } } } } as T, errors: [] };
    },
  };
  const before = collectFeedback({ raw, repository: 'o/r' });
  assert.equal(before.comments.find((c) => c.issue === 20).outcome.hit, false);
  const stats = await refreshLinks(client, raw, before);
  assert.equal(stats.requests, 1);
  assert.match(queries[0], /i20: issue\(number: 20\)/);
  assert.ok(!queries[0].includes('i21:'), 'only duplicate closes are fetched');
  const after = collectFeedback({ raw, repository: 'o/r' });
  assert.deepEqual(after.comments.find((c) => c.issue === 20).outcome.duplicateOf, [7]);
  assert.equal(after.comments.find((c) => c.issue === 20).outcome.hit, true);
});
