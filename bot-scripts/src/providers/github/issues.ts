import { cleanIssueText } from '../../text/clean.ts';
import { packText } from '../../text/chunk.ts';
import type { IssuesConfig } from '../../config/types.ts';
import type { AuthorRole, IndexChunk, IndexItem, PaginatingClient, ProviderItem } from '../types.ts';
import type { RawStore } from '../../store/raw.ts';

const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const DAY_MS = 24 * 60 * 60 * 1000;
/** Upper bound of a chunk's text, under the embedding model window so nothing is silently truncated. */
const CHUNK_CHARS = 2000;

/** The fields of the REST issue and comment objects the reader uses. */
export interface ApiUser { login?: string; type?: string }
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
  closed_by?: ApiUser | null;
}
export interface ApiComment {
  id?: number;
  user?: ApiUser;
  author_association?: string;
  created_at: string;
  body?: string | null;
  reactions?: Record<string, number>;
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
export interface StoredIssue { issue: ApiIssue; comments: ApiComment[]; complete: boolean }

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

/** The index item of one issue and its comments. */
export function issueItem(issue: ApiIssue, comments: ApiComment[], repo: string): IndexItem {
  const { text, logs } = cleanIssueText(issue.body ?? '');
  const reporter = issue.user?.login ?? '';
  const chunks: IndexChunk[] = [];
  const bodyText = [issue.title, text].filter(Boolean).join('\n\n');
  for (const piece of packText(bodyText, { maxChars: CHUNK_CHARS })) {
    chunks.push({ seq: chunks.length, kind: 'body', text: piece, logs: chunks.length === 0 ? logs : null, createdAt: issue.created_at, authorRole: 'reporter' });
  }
  for (const comment of comments) chunks.push(...commentChunks(comment, chunks.length, reporter));
  return {
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

export interface ReadIssuesInput {
  client: PaginatingClient;
  repo: string;
  options: IssuesConfig;
  now?: Date;
  raw?: RawStore;
  /** Only issues updated after this instant; absent, every issue. */
  since?: Date;
}

/**
 * Reads the issues of one repository as index items: body chunks per issue,
 * chunks per comment, and the outcome fields the renderer shows.
 */
export async function* readIssues({ client, repo, options, now = new Date(), raw, since }: ReadIssuesInput): AsyncGenerator<ProviderItem> {
  const cutoff = options.closedWithinDays === undefined ? null : new Date(now.getTime() - options.closedWithinDays * DAY_MS);
  const wanted = new Set(options.states);
  for (const params of listings(wanted, cutoff, since)) for await (const element of client.paginate(`/repos/${repo}/issues`, params)) {
    const issue = element as ApiIssue;
    if (issue.pull_request) continue;
    if (!wanted.has(issue.state) || (cutoff && issue.state === 'closed' && issue.closed_at && new Date(issue.closed_at) < cutoff)) {
      if (since) yield { remove: true, provider: 'github', origin: repo, source: 'issue', sourceId: String(issue.number) };
      continue;
    }
    yield issueItem(issue, await issueComments(client, repo, issue, options.comments, raw), repo);
  }
}

/**
 * The listing calls of a pass. A full pass lists open issues without a window
 * (a long-standing bug nobody touched is still a duplicate target) and closed
 * ones since the window start when one is set, because `since` filters on
 * `updated_at`. An incremental pass lists every state once since the date.
 */
function listings(wanted: Set<string>, cutoff: Date | null, since: Date | undefined): Record<string, string | number>[] {
  const listing = { per_page: 100, sort: 'updated', direction: 'asc' };
  if (since) return [{ state: 'all', since: since.toISOString(), ...listing }];
  return [
    ...(wanted.has('open') ? [{ state: 'open', ...listing }] : []),
    ...(wanted.has('closed') ? [{ state: 'closed', ...(cutoff ? { since: cutoff.toISOString() } : {}), ...listing }] : []),
  ];
}

export interface ReadIssueInput { client: PaginatingClient; repo: string; number: number; options: IssuesConfig; raw?: RawStore }

/** One issue by number, or null when it is a pull request or its state is not configured. */
export async function readIssue({ client, repo, number, options, raw }: ReadIssueInput): Promise<IndexItem | null> {
  if (!client.getJson) throw new Error('readIssue needs a client with getJson');
  const issue = await client.getJson<ApiIssue>(`/repos/${repo}/issues/${number}`);
  if (issue.pull_request || !options.states.includes(issue.state)) return null;
  return issueItem(issue, await issueComments(client, repo, issue, options.comments, raw), repo);
}
