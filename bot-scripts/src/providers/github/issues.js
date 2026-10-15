// @ts-check
import { cleanIssueText } from '../../text/clean.js';
import { packText } from '../../text/chunk.js';

/** @typedef {import('../types.js').IndexItem} IndexItem */
/** @typedef {import('../types.js').IndexChunk} IndexChunk */
/** @typedef {import('../types.js').AuthorRole} AuthorRole */

const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const DAY_MS = 24 * 60 * 60 * 1000;
/** Upper bound of a chunk's text, under the embedding model window so nothing is silently truncated. */
const CHUNK_CHARS = 2000;

/**
 * The author role is taken from the API's association, never from the text, so a
 * body that claims to be from a maintainer carries no authority downstream.
 * @param {string} association
 * @param {string} login
 * @param {string} reporterLogin
 * @returns {AuthorRole}
 */
function authorRole(association, login, reporterLogin) {
  if (login === reporterLogin) return 'reporter';
  if (MAINTAINER_ASSOCIATIONS.has(association)) return 'maintainer';
  return 'user';
}

/**
 * Chunks of one comment; logs ride on the first one.
 * @param {any} comment
 * @param {number} firstSeq
 * @param {string} reporterLogin
 * @returns {IndexChunk[]}
 */
function commentChunks(comment, firstSeq, reporterLogin) {
  const { text, logs } = cleanIssueText(comment.body ?? '');
  if (!text && !logs) return [];
  const role = authorRole(comment.author_association, comment.user?.login, reporterLogin);
  const pieces = packText(text, { maxChars: CHUNK_CHARS });
  if (pieces.length === 0) pieces.push('');
  return pieces.map((piece, i) => ({
    seq: firstSeq + i, kind: /** @type {const} */ ('comment'), text: piece, logs: i === 0 ? logs : null, createdAt: comment.created_at, authorRole: role,
  }));
}

/**
 * Reads the issues of one repository as index items: body chunks per issue,
 * chunks per comment, and the outcome fields the renderer shows.
 * @param {{ client: { paginate(path: string, params?: object): AsyncIterable<any> }, repo: string, options: import('../../config/types.js').IssuesConfig, now?: Date }} input
 * @returns {AsyncGenerator<IndexItem>}
 */
export async function* readIssues({ client, repo, options, now = new Date() }) {
  const cutoff = new Date(now.getTime() - options.closedWithinDays * DAY_MS);
  const wanted = new Set(options.states);
  const listing = { per_page: 100, sort: 'updated', direction: 'asc' };
  // Open issues have no window: a long-standing bug nobody touched is still a duplicate target.
  // `since` filters on updated_at, so it is only applied to the closed listing.
  const listings = [
    ...(wanted.has('open') ? [{ state: 'open', ...listing }] : []),
    ...(wanted.has('closed') ? [{ state: 'closed', since: cutoff.toISOString(), ...listing }] : []),
  ];

  for (const params of listings) for await (const issue of client.paginate(`/repos/${repo}/issues`, params)) {
    if (issue.pull_request) continue;
    if (!wanted.has(issue.state)) continue;
    if (issue.state === 'closed' && issue.closed_at && new Date(issue.closed_at) < cutoff) continue;

    const { text, logs } = cleanIssueText(issue.body ?? '');
    const reporter = issue.user?.login ?? '';
    const chunks = /** @type {IndexChunk[]} */ ([]);
    const bodyText = [issue.title, text].filter(Boolean).join('\n\n');
    for (const piece of packText(bodyText, { maxChars: CHUNK_CHARS })) {
      chunks.push({ seq: chunks.length, kind: 'body', text: piece, logs: chunks.length === 0 ? logs : null, createdAt: issue.created_at, authorRole: 'reporter' });
    }

    if (options.comments && issue.comments > 0) {
      for await (const comment of client.paginate(`/repos/${repo}/issues/${issue.number}/comments`, { per_page: 100 })) {
        chunks.push(...commentChunks(comment, chunks.length, reporter));
      }
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
        labels: (issue.labels ?? []).map((/** @type {any} */ l) => l.name),
        closedAt: issue.closed_at ?? null,
        reactions: { up: issue.reactions?.['+1'] ?? 0, down: issue.reactions?.['-1'] ?? 0 },
      },
      extra: { reporter },
      chunks,
    };
  }
}
