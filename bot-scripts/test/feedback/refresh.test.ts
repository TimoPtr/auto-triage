import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshReactions, FEEDBACK_WINDOW_DAYS } from '../../src/feedback/refresh.ts';
import type { Feedback, FeedbackComment } from '../../src/feedback/collect.ts';

const outcome = { recheck: false, closedAt: null, stateReason: null, duplicateOf: [], hit: false, miss: false, answered: false, dismissed: false };
const comment = (issue: number, commentId: number | null, commentAt: string): FeedbackComment => ({ issue, runId: '1', tier: 'high', commentId, commentAt, suggested: [], up: 0, down: 0, reply: null, outcome: { ...outcome } });
const now = new Date('2026-10-20T00:00:00Z');
const feedback = (): Feedback => ({
  version: 1, repository: 'o/r', generatedAt: now.toISOString(), suppressed: [],
  comments: [comment(10, 501, '2026-10-10T00:00:00Z'), comment(11, 502, '2026-01-01T00:00:00Z'), comment(12, null, '2026-10-11T00:00:00Z'), comment(13, 503, '2026-10-12T00:00:00Z')],
});

test('refreshes reactions from one listing of recent comments and recomputes the suppression', async () => {
  const calls: { path: string; params: Record<string, unknown> }[] = [];
  const client = {
    async *paginate<T>(path: string, params: Record<string, unknown>): AsyncGenerator<T> {
      calls.push({ path, params });
      yield { id: 501, reactions: { '+1': 0, '-1': 3 } } as T;
      yield { id: 999, reactions: { '+1': 5, '-1': 0 } } as T;
    },
  };
  const f = feedback();
  const { refreshed } = await refreshReactions(client, f, { now });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, 'repos/o/r/issues/comments');
  assert.equal(calls[0].params.since, new Date(now.getTime() - FEEDBACK_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString());
  assert.equal(calls[0].params.per_page, 100);
  assert.equal(refreshed, 1);
  assert.equal(f.comments[0].down, 3); assert.equal(f.comments[0].outcome.dismissed, true);
  assert.equal(f.comments[1].down, 0, 'older than the window keeps its counts');
  assert.equal(f.comments[3].down, 0, 'a comment absent from the listing keeps its counts');
  assert.deepEqual(f.suppressed, [{ issue: 10, reason: 'downvoted', at: '2026-10-10T00:00:00Z' }]);
});

test('propagates listing errors', async () => {
  const broken = { async *paginate<T>(): AsyncGenerator<T> { throw new Error('GitHub 500 for x: boom'); } };
  await assert.rejects(refreshReactions(broken, feedback(), { now }), /500/);
});
