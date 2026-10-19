import { cleanIssueText } from '../../text/clean.ts';
import { packText } from '../../text/chunk.ts';
import type { IssuesConfig } from '../../config/types.ts';
import type { AuthorRole, IndexChunk, IndexItem, PaginatingClient } from '../types.ts';
import type { RawStore } from '../../store/raw.ts';

const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const DAY_MS = 24 * 60 * 60 * 1000;
/** Upper bound of a chunk's text, under the embedding model window so nothing is silently truncated. */
const CHUNK_CHARS = 2000;

/** The fields of the REST issue and comment objects the reader uses. */
interface ApiUser { login?: string }
interface ApiLabel { name: string }
export interface ApiIssue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  state_reason?: string | null;
  html_url: string;
  user?: ApiUser;
  author_association?: string;
  labels?: ApiLabel[];
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  reactions?: Record<string, number>;
  body?: string | null;
  pull_request?: unknown;
}
export interface ApiComment {
  user?: ApiUser;
  author_association?: string;
  created_at: string;
  body?: string | null;
}

/**
 * The author role is taken from the API's association, never from the text, so a
 * body that claims to be from a maintainer carries no authority downstream.
 */
function authorRole(association: string | undefined, login: string | undefined, reporterLogin: string): AuthorRole {
  if (login === reporterLogin) return 'reporter';
  if (association && MAINTAINER_ASSOCIATIONS.has(association)) return 'maintainer';
  return 'user';
}

/** Chunks of one comment; logs ride on the first one. */
function commentChunks(comment: ApiComment, firstSeq: number, reporterLogin: string): IndexChunk[] {
  const { text, logs } = cleanIssueText(comment.body ?? '');
  if (!text && !logs) return [];
  const role = authorRole(comment.author_association, comment.user?.login, reporterLogin);
  const pieces = packText(text, { maxChars: CHUNK_CHARS });
  if (pieces.length === 0) pieces.push('');
  return pieces.map((piece, i) => ({
    seq: firstSeq + i, kind: 'comment', text: piece, logs: i === 0 ? logs : null, createdAt: comment.created_at, authorRole: role,
  }));
}

/** What the raw store holds for an issue; `complete` is false when comments were not wanted at fetch time. */
interface StoredIssue { issue: ApiIssue; comments: ApiComment[]; complete: boolean }

/**
 * Comments of one issue: from the raw store when the issue did not change and
 * the stored payload is complete, else fetched and recorded.
 */
async function issueComments(client: PaginatingClient, repo: string, issue: ApiIssue, wanted: boolean, raw?: RawStore): Promise<ApiComment[]> {
  const stored = raw?.get<StoredIssue>('github', repo, 'issue', String(issue.number));
  if (stored && stored.updatedAt === issue.updated_at && (stored.payload.complete || !wanted)) return stored.payload.comments;
  const comments: ApiComment[] = [];
  if (wanted && issue.comments > 0) {
    for await (const comment of client.paginate(`/repos/${repo}/issues/${issue.number}/comments`, { per_page: 100 })) comments.push(comment as ApiComment);
  }
  const payload: StoredIssue = { issue, comments, complete: wanted };
  raw?.put({ provider: 'github', origin: repo, kind: 'issue', id: String(issue.number), updatedAt: issue.updated_at, payload });
  return comments;
}

export interface ReadIssuesInput {
  client: PaginatingClient;
  repo: string;
  options: IssuesConfig;
  now?: Date;
  raw?: RawStore;
}

/**
 * Reads the issues of one repository as index items: body chunks per issue,
 * chunks per comment, and the outcome fields the renderer shows.
 */
export async function* readIssues({ client, repo, options, now = new Date(), raw }: ReadIssuesInput): AsyncGenerator<IndexItem> {
  const cutoff = options.closedWithinDays === undefined ? null : new Date(now.getTime() - options.closedWithinDays * DAY_MS);
  const wanted = new Set(options.states);
  const listing = { per_page: 100, sort: 'updated', direction: 'asc' };
  // Open issues have no window: a long-standing bug nobody touched is still a duplicate target.
  // `since` filters on updated_at, so it is only applied to the closed listing, and only when a window is set.
  const listings = [
    ...(wanted.has('open') ? [{ state: 'open', ...listing }] : []),
    ...(wanted.has('closed') ? [{ state: 'closed', ...(cutoff ? { since: cutoff.toISOString() } : {}), ...listing }] : []),
  ];

  for (const params of listings) for await (const element of client.paginate(`/repos/${repo}/issues`, params)) {
    const issue = element as ApiIssue;
    if (issue.pull_request) continue;
    if (!wanted.has(issue.state)) continue;
    if (cutoff && issue.state === 'closed' && issue.closed_at && new Date(issue.closed_at) < cutoff) continue;

    const { text, logs } = cleanIssueText(issue.body ?? '');
    const reporter = issue.user?.login ?? '';
    const chunks: IndexChunk[] = [];
    const bodyText = [issue.title, text].filter(Boolean).join('\n\n');
    for (const piece of packText(bodyText, { maxChars: CHUNK_CHARS })) {
      chunks.push({ seq: chunks.length, kind: 'body', text: piece, logs: chunks.length === 0 ? logs : null, createdAt: issue.created_at, authorRole: 'reporter' });
    }

    for (const comment of await issueComments(client, repo, issue, options.comments, raw)) {
      chunks.push(...commentChunks(comment, chunks.length, reporter));
    }

    yield {
      source: 'issue',
      provider: 'github',
      origin: repo,
      sourceId: String(issue.number),
      url: issue.html_url,
      title: issue.title,
      audience: 'user',
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      outcome: {
        state: issue.state,
        stateReason: issue.state_reason ?? null,
        labels: (issue.labels ?? []).map((l) => l.name),
        closedAt: issue.closed_at ?? null,
        reactions: { up: issue.reactions?.['+1'] ?? 0, down: issue.reactions?.['-1'] ?? 0 },
      },
      extra: { reporter },
      chunks,
    };
  }
}
