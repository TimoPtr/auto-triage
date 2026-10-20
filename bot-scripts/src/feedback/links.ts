import type { PaginatingClient } from '../providers/types.ts';
import type { RawStore } from '../store/raw.ts';
import type { StoredIssue } from '../providers/github/issues.ts';
import { fetchLinks, type FetchLinksStats, type LinkRef } from '../eval/github-links.ts';
import type { Feedback } from './collect.ts';

/**
 * Fetches the duplicate marks of the issues closed as duplicate that carry a bot
 * comment, so the links record is the authority on the target. A few GraphQL
 * requests at most; the caller collects the feedback again afterwards.
 */
export async function refreshLinks(client: PaginatingClient, raw: RawStore, feedback: Feedback, log: (line: string) => void = () => {}): Promise<FetchLinksStats> {
  const numbers = new Set(feedback.comments.filter((c) => c.outcome.stateReason === 'duplicate').map((c) => c.issue));
  const refs: LinkRef[] = [];
  for (const number of numbers) {
    const stored = raw.get<StoredIssue>('github', feedback.repository, 'issue', String(number));
    if (stored) refs.push({ kind: 'issue', number, updatedAt: stored.payload.issue.updated_at });
  }
  if (refs.length === 0) return { fetched: 0, reused: 0, requests: 0 };
  return fetchLinks(client, feedback.repository, refs, raw, log);
}
