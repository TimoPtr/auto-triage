import { cleanIssueText } from '../../text/clean.ts';
import { packText } from '../../text/chunk.ts';
import type { PullsConfig } from '../../config/types.ts';
import type { AuthorRole, IndexChunk, IndexItem, PaginatingClient } from '../types.ts';
import type { RawStore } from '../../store/raw.ts';

const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const DAY_MS = 24 * 60 * 60 * 1000;
const CHUNK_CHARS = 2000;
/** Files listed per pull request; enough to tell what a change touched without indexing bulk renames. */
const MAX_FILES = 50;
const LINKED_ISSUE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/gi;

interface ApiPull {
  number: number; title: string; state: string; merged_at: string | null; closed_at: string | null; html_url: string;
  user?: { login?: string; type?: string }; author_association?: string; labels?: { name: string }[];
  created_at: string; updated_at: string; draft: boolean; base?: { ref?: string }; body?: string | null;
}
interface ApiReviewComment {
  id: number; in_reply_to_id: number | null; path: string; line: number | null; user?: { login?: string };
  author_association?: string; created_at: string; body?: string | null;
}
interface PullDetails { reviewComments: ApiReviewComment[]; files: string[] }

function isBot(pull: ApiPull): boolean {
  return pull.user?.type === 'Bot' || (pull.user?.login ?? '').endsWith('[bot]');
}

function roleOf(association: string | undefined, login: string | undefined, author: string): AuthorRole {
  if (login === author) return 'reporter';
  if (association && MAINTAINER_ASSOCIATIONS.has(association)) return 'maintainer';
  return 'user';
}

/** Issue numbers a pull request body claims to close, in order of first mention. */
export function linkedIssues(body: string): number[] {
  return Array.from(new Set(Array.from(body.matchAll(LINKED_ISSUE), (m) => Number(m[1]))));
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

/** One chunk per review thread that has a maintainer reply; the thread's first comment names the file and line. */
function reviewChunks(comments: ApiReviewComment[], firstSeq: number, author: string): IndexChunk[] {
  const chunks: IndexChunk[] = [];
  for (const thread of threads(comments)) {
    const maintainer = thread.find((c) => roleOf(c.author_association, c.user?.login, author) === 'maintainer');
    if (!maintainer) continue;
    const head = `${thread[0].path}:${thread[0].line ?? ''}`;
    const body = thread.map((c) => cleanIssueText(c.body ?? '').text).filter(Boolean).join('\n\n');
    for (const piece of packText(body, { maxChars: CHUNK_CHARS - head.length - 1 })) {
      chunks.push({ seq: firstSeq + chunks.length, kind: 'review', heading: head, text: `${head}\n${piece}`, logs: null, createdAt: maintainer.created_at, authorRole: 'maintainer' });
    }
  }
  return chunks;
}

/** Review comments and files of one pull request: from the raw store when unchanged, else fetched and recorded. */
async function pullDetails(client: PaginatingClient, repo: string, pull: ApiPull, wanted: boolean, raw?: RawStore): Promise<PullDetails> {
  const stored = raw?.get<{ reviewComments: ApiReviewComment[]; files: string[] }>('github', repo, 'pull', String(pull.number));
  if (stored && stored.updatedAt === pull.updated_at) return { reviewComments: stored.payload.reviewComments, files: stored.payload.files };
  const details: PullDetails = { reviewComments: [], files: [] };
  if (wanted) {
    for await (const c of client.paginate(`/repos/${repo}/pulls/${pull.number}/comments`, { per_page: 100 })) details.reviewComments.push(c as ApiReviewComment);
    for await (const f of client.paginate(`/repos/${repo}/pulls/${pull.number}/files`, { per_page: 100 })) {
      if (details.files.length >= MAX_FILES) break;
      details.files.push((f as { filename: string }).filename);
    }
  }
  raw?.put({ provider: 'github', origin: repo, kind: 'pull', id: String(pull.number), updatedAt: pull.updated_at, payload: { pull, ...details } });
  return details;
}

export interface ReadPullsInput { client: PaginatingClient; repo: string; options: PullsConfig; now?: Date; raw?: RawStore }

/** Reads closed pull requests, merged or not, with their maintainer review threads. */
export async function* readPulls({ client, repo, options, now = new Date(), raw }: ReadPullsInput): AsyncGenerator<IndexItem> {
  const cutoff = options.closedWithinDays === undefined ? null : new Date(now.getTime() - options.closedWithinDays * DAY_MS);
  const wanted = new Set(options.states);
  for await (const element of client.paginate(`/repos/${repo}/pulls`, { state: 'closed', per_page: 100, sort: 'updated', direction: 'asc' })) {
    const pull = element as ApiPull;
    const state = pull.merged_at ? 'merged' : 'closed';
    if (!wanted.has(state)) continue;
    if (options.excludeBots && isBot(pull)) continue;
    if (cutoff && pull.closed_at && new Date(pull.closed_at) < cutoff) continue;

    const author = pull.user?.login ?? '';
    const { text, logs } = cleanIssueText(pull.body ?? '');
    const chunks: IndexChunk[] = [];
    for (const piece of packText([pull.title, text].filter(Boolean).join('\n\n'), { maxChars: CHUNK_CHARS })) {
      chunks.push({ seq: chunks.length, kind: 'body', text: piece, logs: chunks.length === 0 ? logs : null, createdAt: pull.created_at, authorRole: 'reporter' });
    }
    const { reviewComments, files } = await pullDetails(client, repo, pull, options.reviews, raw);
    chunks.push(...reviewChunks(reviewComments, chunks.length, author));
    yield {
      source: 'pull', provider: 'github', origin: repo, sourceId: String(pull.number), url: pull.html_url, title: pull.title,
      audience: 'user', createdAt: pull.created_at, updatedAt: pull.updated_at,
      outcome: { state, mergedAt: pull.merged_at, closedAt: pull.closed_at, labels: (pull.labels ?? []).map((l) => l.name), linkedIssues: linkedIssues(pull.body ?? ''), files, base: pull.base?.ref ?? null },
      extra: { author }, chunks,
    };
  }
}
