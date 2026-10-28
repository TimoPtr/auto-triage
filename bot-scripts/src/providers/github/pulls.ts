import { cleanIssueText } from '../../text/clean.ts';
import { packText } from '../../text/chunk.ts';
import type { PullsConfig } from '../../config/types.ts';
import type { AuthorRole, IndexChunk, IndexItem, PaginatingClient, ProviderItem } from '../types.ts';
import type { RawStore } from '../../store/raw.ts';
import { CLOSING_BATCH, fetchClosingIssues } from './closing-issues.ts';

const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const DAY_MS = 24 * 60 * 60 * 1000;
const CHUNK_CHARS = 2000;
/** Files listed per pull request; enough to tell what a change touched without indexing bulk renames. */
const MAX_FILES = 50;
/** Longest `path:line` head of a review chunk; a longer path keeps its tail, where the file name is. */
const MAX_HEAD_CHARS = 200;
const LINKED_ISSUE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/gi;

export interface ApiPull {
  number: number; title: string; state: string; merged_at: string | null; closed_at: string | null; html_url: string;
  user?: { login?: string; type?: string }; author_association?: string; labels?: { name: string }[];
  created_at: string; updated_at: string; draft: boolean; base?: { ref?: string }; body?: string | null;
}
interface ApiReviewComment {
  id: number; in_reply_to_id: number | null; path: string; line: number | null; user?: { login?: string };
  author_association?: string; created_at: string; body?: string | null;
}
/** `closingIssues` is null when the closing references could not be read this pass. */
interface PullDetails { reviewComments: ApiReviewComment[]; files: string[]; closingIssues: number[] | null }
/**
 * What the raw store holds for a pull request; `complete` is false when reviews
 * were not wanted at fetch time, `closingIssues` is absent until the closing
 * references were read, so a later pass asks for them again.
 */
export interface StoredPull { pull: ApiPull; reviewComments: ApiReviewComment[]; files: string[]; complete: boolean; closingIssues?: number[] }

function isBot(pull: ApiPull): boolean {
  return pull.user?.type === 'Bot' || (pull.user?.login ?? '').endsWith('[bot]');
}

function roleOf(association: string | undefined, login: string | undefined, author: string): AuthorRole {
  if (login === author) return 'reporter';
  if (association && MAINTAINER_ASSOCIATIONS.has(association)) return 'maintainer';
  return 'user';
}

/**
 * Issue numbers a pull request closes: what GitHub records first, then the
 * ones the body claims with a closing keyword, each once.
 */
export function linkedIssues(body: string, closingIssues: number[] | null = null): number[] {
  return Array.from(new Set([...(closingIssues ?? []), ...Array.from(body.matchAll(LINKED_ISSUE), (m) => Number(m[1]))]));
}

/** Groups review comments into threads (root comment plus replies) keeping API order. */
function threads(comments: ApiReviewComment[]): ApiReviewComment[][] {
  const byRoot = new Map<number, ApiReviewComment[]>();
  for (const c of comments) {
    const root = c.in_reply_to_id ?? c.id;
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root)!.push(c);
  }
  return Array.from(byRoot.values());
}

function threadHead(comment: ApiReviewComment): string {
  const head = `${comment.path}:${comment.line ?? ''}`;
  return head.length <= MAX_HEAD_CHARS ? head : `…${head.slice(head.length - MAX_HEAD_CHARS + 1)}`;
}

/**
 * Chunks of the review threads that have a maintainer reply: one chunk per
 * comment, each carrying its own role from the API association, so a user's
 * question in a thread never borrows the maintainer's authority. Every chunk
 * starts with the thread's `path:line` head.
 */
function reviewChunks(comments: ApiReviewComment[], firstSeq: number, author: string): IndexChunk[] {
  const chunks: IndexChunk[] = [];
  for (const thread of threads(comments)) {
    const roles = thread.map((c) => roleOf(c.author_association, c.user?.login, author));
    if (!roles.includes('maintainer')) continue;
    const head = threadHead(thread[0]);
    thread.forEach((comment, i) => {
      for (const piece of packText(cleanIssueText(comment.body ?? '').text, { maxChars: CHUNK_CHARS - head.length - 1 })) {
        chunks.push({ seq: firstSeq + chunks.length, kind: 'review', heading: head, text: `${head}\n${piece}`, logs: null, createdAt: comment.created_at, authorRole: roles[i] });
      }
    });
  }
  return chunks;
}

/** The stored record of a pull request when it has not changed since. */
function storedOf(raw: RawStore | undefined, repo: string, pull: ApiPull): StoredPull | null {
  const stored = raw?.get<StoredPull>('github', repo, 'pull', String(pull.number));
  return stored && stored.updatedAt === pull.updated_at ? stored.payload : null;
}

/** Whether the closing references of a pull request still have to be read. */
function needsClosingIssues(raw: RawStore | undefined, repo: string, pull: ApiPull): boolean {
  return storedOf(raw, repo, pull)?.closingIssues === undefined;
}

/**
 * Review comments, files and closing references of one pull request: from the
 * raw store when unchanged and complete, else fetched and recorded. `closing`
 * holds the references read for this batch; a pull request missing from it
 * keeps the stored ones, or none when they were never read.
 */
async function pullDetails(client: PaginatingClient, repo: string, pull: ApiPull, wanted: boolean, raw: RawStore | undefined, closing: Map<number, number[]>): Promise<PullDetails> {
  const stored = storedOf(raw, repo, pull);
  const fetched = closing.get(pull.number);
  const hasDetails = stored !== null && (stored.complete || !wanted);
  if (stored && hasDetails && stored.closingIssues !== undefined && fetched === undefined) {
    return { reviewComments: stored.reviewComments, files: stored.files, closingIssues: stored.closingIssues };
  }
  const details = { reviewComments: [] as ApiReviewComment[], files: [] as string[], complete: wanted };
  if (stored && hasDetails) {
    details.reviewComments = stored.reviewComments;
    details.files = stored.files;
    details.complete = stored.complete;
  } else if (wanted) {
    for await (const c of client.paginate(`/repos/${repo}/pulls/${pull.number}/comments`, { per_page: 100 })) details.reviewComments.push(c as ApiReviewComment);
    for await (const f of client.paginate(`/repos/${repo}/pulls/${pull.number}/files`, { per_page: 100 })) {
      if (details.files.length >= MAX_FILES) break;
      details.files.push((f as { filename: string }).filename);
    }
  }
  const closingIssues = fetched ?? stored?.closingIssues;
  const payload: StoredPull = { pull, ...details, ...(closingIssues === undefined ? {} : { closingIssues }) };
  raw?.put({ provider: 'github', origin: repo, kind: 'pull', id: String(pull.number), updatedAt: pull.updated_at, payload });
  return { ...details, closingIssues: closingIssues ?? null };
}

/** The items of a batch of pull requests, their closing references read in one request. */
async function* readBatch(client: PaginatingClient, repo: string, pulls: ApiPull[], options: PullsConfig, raw: RawStore | undefined, log: (line: string) => void): AsyncGenerator<ProviderItem> {
  const closing = await fetchClosingIssues(client, repo, pulls.filter((p) => needsClosingIssues(raw, repo, p)).map((p) => p.number), log);
  for (const pull of pulls) yield pullItem(pull, await pullDetails(client, repo, pull, options.reviews, raw, closing), repo);
}

/** The index item of one pull request with its review threads and files. */
export function pullItem(pull: ApiPull, { reviewComments, files, closingIssues }: PullDetails, repo: string): IndexItem {
  const author = pull.user?.login ?? '';
  const { text, logs } = cleanIssueText(pull.body ?? '');
  const chunks: IndexChunk[] = [];
  for (const piece of packText([pull.title, text].filter(Boolean).join('\n\n'), { maxChars: CHUNK_CHARS })) {
    chunks.push({ seq: chunks.length, kind: 'body', text: piece, logs: chunks.length === 0 ? logs : null, createdAt: pull.created_at, authorRole: 'reporter' });
  }
  chunks.push(...reviewChunks(reviewComments, chunks.length, author));
  return {
    source: 'pull', provider: 'github', origin: repo, sourceId: String(pull.number), url: pull.html_url, title: pull.title,
    audience: 'user', createdAt: pull.created_at, updatedAt: pull.updated_at,
    outcome: { state: stateOf(pull), mergedAt: pull.merged_at, closedAt: pull.closed_at, labels: (pull.labels ?? []).map((l) => l.name), linkedIssues: linkedIssues(pull.body ?? '', closingIssues), files, base: pull.base?.ref ?? null },
    extra: { author }, chunks,
  };
}

function stateOf(pull: ApiPull): 'merged' | 'closed' {
  return pull.merged_at ? 'merged' : 'closed';
}

function cutoffOf(options: PullsConfig, now: Date): Date | null {
  return options.closedWithinDays === undefined ? null : new Date(now.getTime() - options.closedWithinDays * DAY_MS);
}

/** Whether a closed pull request is one the config wants: state, author and window. */
function qualifies(pull: ApiPull, options: PullsConfig, cutoff: Date | null): boolean {
  if (!options.states.includes(stateOf(pull))) return false;
  if (options.excludeBots && isBot(pull)) return false;
  if (cutoff && pull.closed_at && new Date(pull.closed_at) < cutoff) return false;
  return true;
}

export interface ReadPullsInput { client: PaginatingClient; repo: string; options: PullsConfig; now?: Date; raw?: RawStore; since?: Date; log?: (line: string) => void }

/**
 * Reads closed pull requests, merged or not, with their maintainer review
 * threads and closing references. With `since`, the listing runs newest first
 * and stops at the first pull request updated before it; a listed one that
 * fails the filter is a removal.
 */
export async function* readPulls({ client, repo, options, now = new Date(), raw, since, log = () => {} }: ReadPullsInput): AsyncGenerator<ProviderItem> {
  const cutoff = cutoffOf(options, now);
  const params = { state: 'closed', per_page: 100, sort: 'updated', direction: since ? 'desc' : 'asc' };
  let batch: ApiPull[] = [];
  for await (const element of client.paginate(`/repos/${repo}/pulls`, params)) {
    const pull = element as ApiPull;
    if (since && new Date(pull.updated_at) < since) break;
    if (!qualifies(pull, options, cutoff)) {
      if (since) yield { remove: true, provider: 'github', origin: repo, source: 'pull', sourceId: String(pull.number) };
      continue;
    }
    batch.push(pull);
    if (batch.length < CLOSING_BATCH) continue;
    yield* readBatch(client, repo, batch, options, raw, log);
    batch = [];
  }
  yield* readBatch(client, repo, batch, options, raw, log);
}

export interface ReadPullInput { client: PaginatingClient; repo: string; number: number; options: PullsConfig; now?: Date; raw?: RawStore; log?: (line: string) => void }

/** One pull request by number, or null when it is open or the config does not want it. */
export async function readPull({ client, repo, number, options, now = new Date(), raw, log = () => {} }: ReadPullInput): Promise<IndexItem | null> {
  if (!client.getJson) throw new Error('readPull needs a client with getJson');
  const pull = await client.getJson<ApiPull>(`/repos/${repo}/pulls/${number}`);
  if (pull.state !== 'closed' || !qualifies(pull, options, cutoffOf(options, now))) return null;
  const closing = await fetchClosingIssues(client, repo, needsClosingIssues(raw, repo, pull) ? [pull.number] : [], log);
  return pullItem(pull, await pullDetails(client, repo, pull, options.reviews, raw, closing), repo);
}
