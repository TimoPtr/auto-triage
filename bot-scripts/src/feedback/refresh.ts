import type { GitHubClient } from '../providers/github/client.ts';
import { dismissedOf, suppressedOf, type Feedback } from './collect.ts';

/** Reactions are re-read for comments younger than this, since a reaction does not bump the issue's `updated_at`. */
export const FEEDBACK_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const PER_PAGE = 100;

interface ApiCommentListing { id: number; reactions?: Record<string, number> }

export interface RefreshOptions { now?: Date; windowDays?: number; log?: (line: string) => void }

/**
 * Replaces the reaction counts of recent comments in place from one listing of
 * the repository's comments since the window start (about one request per 100
 * comments, whatever the number of bot comments), then recomputes what depends on them.
 */
export async function refreshReactions(client: Pick<GitHubClient, 'paginate'>, feedback: Feedback, { now = new Date(), windowDays = FEEDBACK_WINDOW_DAYS, log = () => {} }: RefreshOptions = {}): Promise<{ refreshed: number }> {
  const since = new Date(now.getTime() - windowDays * DAY_MS).toISOString();
  const recent = new Map(feedback.comments.filter((c) => c.commentId !== null && c.commentAt >= since).map((c) => [c.commentId as number, c]));
  let refreshed = 0;
  if (recent.size > 0) {
    for await (const listed of client.paginate<ApiCommentListing>(`repos/${feedback.repository}/issues/comments`, { since, per_page: PER_PAGE })) {
      const comment = recent.get(listed.id);
      if (!comment) continue;
      comment.up = listed.reactions?.['+1'] ?? 0;
      comment.down = listed.reactions?.['-1'] ?? 0;
      comment.outcome.dismissed = dismissedOf(comment.down, comment.outcome.miss, comment.suggested);
      refreshed += 1;
    }
    if (refreshed < recent.size) log(`${recent.size - refreshed} recent bot comment(s) not in the listing, keeping their stored reactions`);
  }
  feedback.suppressed = suppressedOf(feedback.comments);
  return { refreshed };
}
