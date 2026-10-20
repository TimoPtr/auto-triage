import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestMarkdown, DIGEST_RECENT } from '../../src/feedback/digest.ts';
import type { Feedback, FeedbackComment } from '../../src/feedback/collect.ts';

const base = { runId: '1', commentId: 1, suggested: [], outcome: { recheck: false, closedAt: null, stateReason: null, duplicateOf: [], hit: false, miss: false, answered: false, dismissed: false } };
const c = (issue: number, tier: string, up: number, down: number, outcome: Partial<FeedbackComment['outcome']>, role: 'reporter' | 'maintainer' | 'user' | null, at: string): FeedbackComment =>
  ({ ...base, issue, tier, up, down, commentAt: at, reply: role ? { role, at, text: 'secret reply text' } : null, outcome: { ...base.outcome, ...outcome } });

const feedback: Feedback = {
  version: 1, repository: 'o/r', generatedAt: '2026-10-20T00:00:00Z',
  comments: [
    c(10, 'high', 2, 0, { hit: true, closedAt: '2026-10-12T00:00:00Z', stateReason: 'duplicate', duplicateOf: [7] }, 'maintainer', '2026-10-10T00:00:00Z'),
    c(11, 'medium', 0, 1, { answered: true, dismissed: true, closedAt: '2026-10-12T00:00:00Z', stateReason: 'completed' }, null, '2026-10-09T00:00:00Z'),
    c(14, 'high', 0, 0, { miss: true, dismissed: true, closedAt: '2026-10-13T00:00:00Z', stateReason: 'duplicate', duplicateOf: [99] }, 'reporter', '2026-10-08T00:00:00Z'),
    c(12, 'medium', 0, 0, { recheck: true }, 'user', '2026-10-07T00:00:00Z'),
  ],
  suppressed: [{ issue: 11, reason: 'downvoted', at: '2026-10-09T00:00:00Z' }, { issue: 14, reason: 'dismissed', at: '2026-10-08T00:00:00Z' }],
};

test('renders the digest with totals and the recent table', () => {
  const md = digestMarkdown(feedback);
  assert.match(md, /comments: 4 \(high 2, medium 2, low 0\)/);
  assert.match(md, /reactions: 2 up, 1 down/);
  assert.match(md, /outcomes: 1 hit, 1 miss, 1 answered, 2 dismissed, 1 recheck/);
  assert.match(md, /suppressed: 2/);
  assert.match(md, /\| #10 \| high \| 2 \/ 0 \| hit \| maintainer \|/);
  assert.match(md, /\| #11 \| medium \| 0 \/ 1 \| answered \| none \|/);
  assert.match(md, /\| #12 \| medium \| 0 \/ 0 \| recheck \| user \|/);
  assert.ok(!md.includes('secret reply text'));
  assert.ok(md.includes('2026-10-20'));
});

test('limits the table to the newest comments', () => {
  const many = { ...feedback, comments: Array.from({ length: DIGEST_RECENT + 5 }, (_, i) => c(100 + i, 'low', 0, 0, {}, null, `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00Z`)) };
  const rows = digestMarkdown(many).split('\n').filter((l) => /^\| #\d+ \|/.test(l));
  assert.equal(rows.length, DIGEST_RECENT);
});
