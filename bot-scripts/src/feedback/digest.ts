import type { Feedback, FeedbackComment } from './collect.ts';

/** Rows of the recent-comments table in the digest. */
export const DIGEST_RECENT = 20;

function outcomeWord(c: FeedbackComment): string {
  if (c.outcome.hit) return 'hit';
  if (c.outcome.miss) return 'miss';
  if (c.outcome.answered) return 'answered';
  if (c.outcome.dismissed) return 'dismissed';
  if (c.outcome.recheck) return 'recheck';
  return c.outcome.closedAt ? `closed (${c.outcome.stateReason ?? 'no reason'})` : 'open';
}

const count = (comments: FeedbackComment[], pick: (c: FeedbackComment) => boolean): number => comments.filter(pick).length;

/** The digest issue body: totals and the newest comments, numbers only, no free text from users. */
export function digestMarkdown(feedback: Feedback): string {
  const c = feedback.comments;
  const tiers = ['high', 'medium', 'low'].map((t) => `${t} ${count(c, (x) => x.tier === t)}`).join(', ');
  const lines = [
    `Knowledge bot feedback for ${feedback.repository}, generated ${feedback.generatedAt.slice(0, 10)}.`,
    '',
    `- comments: ${c.length} (${tiers})`,
    `- reactions: ${c.reduce((n, x) => n + x.up, 0)} up, ${c.reduce((n, x) => n + x.down, 0)} down`,
    `- outcomes: ${count(c, (x) => x.outcome.hit)} hit, ${count(c, (x) => x.outcome.miss)} miss, ${count(c, (x) => x.outcome.answered)} answered, ${count(c, (x) => x.outcome.dismissed)} dismissed, ${count(c, (x) => x.outcome.recheck)} recheck`,
    `- suppressed: ${feedback.suppressed.length}`,
    '',
    '| issue | tier | 👍 / 👎 | outcome | reply |',
    '| --- | --- | --- | --- | --- |',
    ...[...c].sort((a, b) => b.commentAt.localeCompare(a.commentAt)).slice(0, DIGEST_RECENT)
      .map((x) => `| #${x.issue} | ${x.tier} | ${x.up} / ${x.down} | ${outcomeWord(x)} | ${x.reply?.role ?? 'none'} |`),
    '',
    'Updated nightly by the knowledge index build; the full data is the `feedback-<slug>` artifact of that run.',
  ];
  return `${lines.join('\n')}\n`;
}
