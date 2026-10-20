import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshReactions, FEEDBACK_WINDOW_DAYS } from '../../src/feedback/refresh.ts';
import type { Feedback, FeedbackComment } from '../../src/feedback/collect.ts';

const outcome = { recheck: false, closedAt: null, stateReason: null, duplicateOf: [], hit: false, miss: false, answered: false, dismissed: false };
const comment = (issue: number, commentId: number | null, commentAt: string): FeedbackComment => ({ issue, runId: '1', tier: 'high', commentId, commentAt, suggested: [], up: 0, down: 0, reply: null, outcome: { ...outcome } });
const now = new Date('2026-10-20T00:00:00Z');
const feedback = (): Feedback => ({
  version: 1, repository: 'o/r', generatedAt: now.toISOString(), suppressed: [],
  comments: [comment(10, 501, '2026-10-10T00:00:00Z'), comment(11, 502, '2026-01-01T00:00:00Z'), comment(12, null, '2026-10-11T00:00:00Z')],
});

test('refreshes reactions of recent comments and recomputes the suppression', async () => {
  const paths: string[] = [];
  const client = { async getJson<T>(path: string): Promise<T> { paths.push(path); return { reactions: { '+1': 0, '-1': 3 } } as T; } };
  const f = feedback();
  const { refreshed } = await refreshReactions(client, f, { now });
  assert.deepEqual(paths, ['repos/o/r/issues/comments/501']);
  assert.equal(refreshed, 1);
  assert.equal(f.comments[0].down, 3); assert.equal(f.comments[0].outcome.dismissed, true);
  assert.equal(f.comments[1].down, 0, 'older than the window keeps its counts');
  assert.deepEqual(f.suppressed, [{ issue: 10, reason: 'downvoted', at: '2026-10-10T00:00:00Z' }]);
  assert.ok(FEEDBACK_WINDOW_DAYS >= 30);
});

test('skips a deleted comment and propagates other errors', async () => {
  const lines: string[] = [];
  const gone = { async getJson<T>(): Promise<T> { throw new Error('GitHub 404 for x: Not Found'); } };
  const { refreshed } = await refreshReactions(gone, feedback(), { now, log: (l) => lines.push(l) });
  assert.equal(refreshed, 0); assert.equal(lines.length, 1);
  const broken = { async getJson<T>(): Promise<T> { throw new Error('GitHub 500 for x: boom'); } };
  await assert.rejects(refreshReactions(broken, feedback(), { now }), /500/);
});
