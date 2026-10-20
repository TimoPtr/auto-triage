import type { RawStore } from '../store/raw.ts';
import type { ApiComment, ApiIssue, StoredIssue } from '../providers/github/issues.ts';
import { linksOf } from '../eval/github-links.ts';
import { DUPLICATE_OF } from '../eval/mine.ts';
import { MARKER_PREFIX, parseMarker } from '../triage/render.ts';

export const FEEDBACK_VERSION = 1;
/** A reporter closing this soon after the comment counts as answered. */
export const ANSWERED_WINDOW_DAYS = 7;
export const REPLY_MAX_CHARS = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const DUPLICATES_HEADING = '**Possibly related to earlier reports**';
const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const BOT_LOGIN = /\[bot\]$/;

export type ReplyRole = 'reporter' | 'maintainer' | 'user';
export interface FeedbackOutcome { recheck: boolean; closedAt: string | null; stateReason: string | null; duplicateOf: number[]; hit: boolean; miss: boolean; answered: boolean; dismissed: boolean }
export interface FeedbackReply { role: ReplyRole; at: string; text: string }
export interface FeedbackComment { issue: number; runId: string; tier: string; commentId: number | null; commentAt: string; suggested: number[]; up: number; down: number; reply: FeedbackReply | null; outcome: FeedbackOutcome }
export interface Suppressed { issue: number; reason: 'downvoted' | 'dismissed'; at: string }
export interface Feedback { version: 1; repository: string; generatedAt: string; comments: FeedbackComment[]; suppressed: Suppressed[] }

/** The `#n` bullets under the duplicates heading of a bot comment. */
export function parseSuggested(body: string): number[] {
  const start = body.indexOf(DUPLICATES_HEADING);
  if (start < 0) return [];
  const section = body.slice(start + DUPLICATES_HEADING.length).split(/\n\s*\n/)[0];
  return Array.from(section.matchAll(/^- #(\d+)\b/gm), (m) => Number(m[1]));
}

const TIERS = new Set(['high', 'medium', 'low']);
const RUN_ID = /^\d+$/;

/** A bot comment: posted by a Bot account, starting with a marker whose tier and run id are well formed; nothing a user can type qualifies. */
function isBot(comment: ApiComment): boolean {
  if (comment.user?.type !== 'Bot' || !(comment.body ?? '').startsWith(MARKER_PREFIX)) return false;
  const marker = parseMarker(comment.body ?? '');
  return marker !== null && TIERS.has(marker.tier) && RUN_ID.test(marker.runId);
}

function replyOf(comments: ApiComment[], after: string, issue: ApiIssue): FeedbackReply | null {
  const reply = comments.find((c) => c.created_at > after && !BOT_LOGIN.test(c.user?.login ?? '') && !isBot(c));
  if (!reply) return null;
  const login = reply.user?.login;
  const role: ReplyRole = login !== undefined && login === issue.user?.login ? 'reporter' : MAINTAINER_ASSOCIATIONS.has(reply.author_association ?? '') ? 'maintainer' : 'user';
  return { role, at: reply.created_at, text: (reply.body ?? '').slice(0, REPLY_MAX_CHARS) };
}

/** Duplicate targets: the benchmark's links record when present, else maintainer comments after the bot comment. */
function duplicateTargets(raw: RawStore, repository: string, issue: ApiIssue, comments: ApiComment[], after: string): number[] {
  const links = linksOf(raw, repository, issue.number);
  if (links) return links.duplicateOf;
  const numbers = new Set<number>();
  for (const c of comments) {
    if (c.created_at <= after || !MAINTAINER_ASSOCIATIONS.has(c.author_association ?? '')) continue;
    for (const m of (c.body ?? '').matchAll(DUPLICATE_OF)) if (!m[1] || m[1] === repository) numbers.add(Number(m[2]));
  }
  return Array.from(numbers).sort((a, b) => a - b);
}

function outcomeOf(raw: RawStore, repository: string, stored: StoredIssue, comment: ApiComment, suggested: number[], down: number): FeedbackOutcome {
  const { issue, comments } = stored;
  const recheck = comments.some((c) => c !== comment && isBot(c) && c.created_at > comment.created_at);
  const closedAt = issue.closed_at ?? null;
  const stateReason = issue.state === 'closed' ? issue.state_reason ?? null : null;
  const isDuplicate = issue.state === 'closed' && (stateReason === 'duplicate' || (issue.labels ?? []).some((l) => l.name === 'duplicate'));
  const duplicateOf = isDuplicate ? duplicateTargets(raw, repository, issue, comments, comment.created_at) : [];
  const hit = duplicateOf.some((n) => suggested.includes(n));
  const miss = isDuplicate && !hit;
  const answered = !isDuplicate && closedAt !== null && issue.closed_by?.login !== undefined && issue.closed_by.login === issue.user?.login
    && Date.parse(closedAt) - Date.parse(comment.created_at) <= ANSWERED_WINDOW_DAYS * DAY_MS && Date.parse(closedAt) >= Date.parse(comment.created_at);
  const dismissed = down > 0 || (miss && suggested.length > 0);
  return { recheck, closedAt, stateReason, duplicateOf, hit, miss, answered, dismissed };
}

/** One entry per issue that got a thumbs down or a dismissed suggestion, from its latest comment. */
export function suppressedOf(comments: FeedbackComment[]): Suppressed[] {
  const byIssue = new Map<number, Suppressed>();
  for (const c of [...comments].sort((a, b) => b.commentAt.localeCompare(a.commentAt))) {
    if (byIssue.has(c.issue)) continue;
    if (c.down > 0) byIssue.set(c.issue, { issue: c.issue, reason: 'downvoted', at: c.commentAt });
    else if (c.outcome.dismissed) byIssue.set(c.issue, { issue: c.issue, reason: 'dismissed', at: c.commentAt });
  }
  return Array.from(byIssue.values()).sort((a, b) => a.issue - b.issue);
}

/** Every bot comment of the repository in the raw store, with its reactions, reply and outcome. */
export function collectFeedback({ raw, repository, now = new Date() }: { raw: RawStore; repository: string; now?: Date }): Feedback {
  const comments: FeedbackComment[] = [];
  for (const record of raw.each<StoredIssue>('github', repository, 'issue')) {
    const stored = record.payload;
    const sorted = [...stored.comments].sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const comment of sorted) {
      const marker = isBot(comment) ? parseMarker(comment.body ?? '') : null;
      if (!marker) continue;
      const suggested = parseSuggested(comment.body ?? '');
      const up = comment.reactions?.['+1'] ?? 0;
      const down = comment.reactions?.['-1'] ?? 0;
      comments.push({
        issue: stored.issue.number, runId: marker.runId, tier: marker.tier, commentId: comment.id ?? null, commentAt: comment.created_at, suggested, up, down,
        reply: replyOf(sorted, comment.created_at, stored.issue),
        outcome: outcomeOf(raw, repository, { ...stored, comments: sorted }, comment, suggested, down),
      });
    }
  }
  comments.sort((a, b) => b.commentAt.localeCompare(a.commentAt) || b.issue - a.issue);
  return { version: FEEDBACK_VERSION, repository, generatedAt: now.toISOString(), comments, suppressed: suppressedOf(comments) };
}
