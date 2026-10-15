// @ts-check
import { cleanIssueText } from '../../text/clean.js';

/** @typedef {import('../types.js').IndexItem} IndexItem */
/** @typedef {import('../types.js').IndexChunk} IndexChunk */

const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const DAY_MS = 24 * 60 * 60 * 1000;
/** A body line that imitates the author prefix the reader adds; neutralized so it cannot claim a role. */
const SPOOFED_PREFIX = /^(\s*)Comment by (a maintainer|the reporter|a user):/gim;

/**
 * @param {string} association
 * @param {string} login
 * @param {string} reporterLogin
 */
function authorLabel(association, login, reporterLogin) {
  if (login === reporterLogin) return 'the reporter';
  if (MAINTAINER_ASSOCIATIONS.has(association)) return 'a maintainer';
  return 'a user';
}

/**
 * @param {any} comment
 * @param {number} seq
 * @param {string} reporterLogin
 * @returns {IndexChunk | null}
 */
function commentChunk(comment, seq, reporterLogin) {
  const { text, logs } = cleanIssueText(comment.body ?? '');
  if (!text && !logs) return null;
  const who = authorLabel(comment.author_association, comment.user?.login, reporterLogin);
  const body = text.replace(SPOOFED_PREFIX, '$1Comment by (claimed) $2:');
  return { seq, kind: 'comment', text: `Comment by ${who}:\n${body}`.trim(), logs, createdAt: comment.created_at };
}

/**
 * Reads the issues of one repository as index items: one body chunk per issue,
 * one chunk per comment, and the outcome fields the renderer shows.
 * @param {{ client: { paginate(path: string, params?: object): AsyncIterable<any> }, repo: string, options: import('../../config/types.js').IssuesConfig, now?: Date }} input
 * @returns {AsyncGenerator<IndexItem>}
 */
export async function* readIssues({ client, repo, options, now = new Date() }) {
  const cutoff = new Date(now.getTime() - options.closedWithinDays * DAY_MS);
  const wanted = new Set(options.states);
  const params = { state: 'all', since: cutoff.toISOString(), per_page: 100, sort: 'updated', direction: 'asc' };

  for await (const issue of client.paginate(`/repos/${repo}/issues`, params)) {
    if (issue.pull_request) continue;
    if (!wanted.has(issue.state)) continue;
    if (issue.state === 'closed' && issue.closed_at && new Date(issue.closed_at) < cutoff) continue;

    const { text, logs } = cleanIssueText(issue.body ?? '');
    const reporter = issue.user?.login ?? '';
    const chunks = /** @type {IndexChunk[]} */ ([]);
    const bodyText = [issue.title, text].filter(Boolean).join('\n\n');
    chunks.push({ seq: 0, kind: 'body', text: bodyText, logs, createdAt: issue.created_at });

    if (options.comments && issue.comments > 0) {
      for await (const comment of client.paginate(`/repos/${repo}/issues/${issue.number}/comments`, { per_page: 100 })) {
        const chunk = commentChunk(comment, chunks.length, reporter);
        if (chunk) chunks.push(chunk);
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
