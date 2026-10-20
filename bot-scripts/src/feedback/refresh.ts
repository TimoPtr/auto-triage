import type { GitHubClient } from '../providers/github/client.ts';
import { suppressedOf, type Feedback } from './collect.ts';

/** Reactions are re-read through the API for comments younger than this, since a reaction does not bump the issue's `updated_at`. */
export const FEEDBACK_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOT_FOUND = /\b404\b/;

interface ApiCommentReactions { reactions?: Record<string, number> }

export interface RefreshOptions { now?: Date; windowDays?: number; log?: (line: string) => void }

/** Replaces the reaction counts of recent comments in place and recomputes what depends on them. */
export async function refreshReactions(client: Pick<GitHubClient, 'getJson'>, feedback: Feedback, { now = new Date(), windowDays = FEEDBACK_WINDOW_DAYS, log = () => {} }: RefreshOptions = {}): Promise<{ refreshed: number }> {
  let refreshed = 0;
  for (const comment of feedback.comments) {
    if (comment.commentId === null || now.getTime() - Date.parse(comment.commentAt) > windowDays * DAY_MS) continue;
    let payload: ApiCommentReactions;
    try {
      payload = await client.getJson<ApiCommentReactions>(`repos/${feedback.repository}/issues/comments/${comment.commentId}`);
    } catch (error) {
      if (error instanceof Error && NOT_FOUND.test(error.message)) { log(`comment ${comment.commentId} of #${comment.issue} is gone, keeping its stored reactions`); continue; }
      throw error;
    }
    comment.up = payload.reactions?.['+1'] ?? 0;
    comment.down = payload.reactions?.['-1'] ?? 0;
    comment.outcome.dismissed = comment.down > 0 || (comment.outcome.miss && comment.suggested.length > 0);
    refreshed += 1;
  }
  feedback.suppressed = suppressedOf(feedback.comments);
  return { refreshed };
}
