import type { Excerpt, Handoff } from './handoff.ts';
import type { Tier, Verdict } from './verdict.ts';

export const MARKER_PREFIX = '<!-- knowledge-bot v1';
export const FOOTER = 'Was this helpful? React with 👍 or 👎 on this comment, or reply to say what was wrong.';
/** Issues about building or contributing may see developer-audience excerpts. */
export const DEVELOPER_TOPIC = /\b(build|building|builds|gradle|flavou?rs?|submit|submitting|pull request|contribut\w*)\b/i;
const DUPLICATES_HEADING = '**Possibly related to earlier reports**';
const RELATED_HEADING = '**Discussions and docs**';
const MARKER = /^<!-- knowledge-bot v1 run=(\S+) tier=(\S+) issue=(\d+) -->/;
const DOCS_EPOCH = '1970-01-01';

export function marker({ runId, tier, issue }: { runId: string; tier: Tier; issue: number }): string {
  return `${MARKER_PREFIX} run=${runId} tier=${tier} issue=${issue} -->`;
}

/** The fields of a bot comment's marker, or null for any other comment. */
export function parseMarker(body: string): { runId: string; tier: string; issue: number } | null {
  const m = MARKER.exec(body);
  return m ? { runId: m[1], tier: m[2], issue: Number(m[3]) } : null;
}

const MARKDOWN_SPECIALS = /[\\`*_[\]()<>!|~]/g;

/** Index text shown inline: no html, no markdown syntax, no mentions, one line. */
export function escapeInline(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/@(?=\w)/g, '')
    .replace(MARKDOWN_SPECIALS, (c) => `\\${c}`)
    .replace(/\s+/g, ' ')
    .trim();
}

/** An index url safe to place in a markdown link, or null when it is not http(s). */
export function safeUrl(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  return parsed.href.replace(/[\s()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/**
 * Model text as plain prose: html removed, links reduced to their label, url-like
 * tokens dropped, mentions broken, markdown escaped, issue references kept out of
 * GitHub's autolinking by a code span.
 */
export function sanitizeAnswer(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(https?:\/\/|\/\/|www\.)\S+/g, '')
    .replace(/@(?=\w)/g, '')
    .replace(MARKDOWN_SPECIALS, (c) => `\\${c}`)
    .replace(/#(\d+)/g, '`#$1`')
    .split('\n').map((line) => line.replace(/[ \t]{2,}/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function monthYear(date: string): string | null {
  if (date === DOCS_EPOCH) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const NOT_RELEASED = 'not yet in a stable release';

/** `in <tag>`, or the not-released note when the index knows the releases, or nothing. */
function shipped(release: string | null, releasesIndexed: boolean): string | null {
  if (release) return `in ${release}`;
  return releasesIndexed ? NOT_RELEASED : null;
}

/**
 * The parenthesis after a title: a closed issue or merged pull shows its close month and the
 * release that ships it; anything else shows its state and creation month.
 */
function parts(excerpt: Excerpt, releasesIndexed: boolean): string {
  const o = excerpt.outcome;
  const closed = o?.closedAt ? monthYear(o.closedAt) : null;
  const settled = (o?.state === 'closed' || o?.state === 'merged') && closed !== null;
  const list: (string | null)[] = [settled ? `${o?.state} ${closed}` : o?.state ?? null];
  if (o?.fixedBy.length) list.push(`fixed by ${o.fixedBy.join(', ')}`, shipped(o.release, releasesIndexed));
  else if (o?.state === 'merged') list.push(shipped(o.release, releasesIndexed));
  else if (o?.reason) list.push(o.reason);
  if (o?.solved) list.push('solved');
  if (!settled) list.push(monthYear(excerpt.date));
  const shown = list.filter((p): p is string => p !== null);
  return shown.length ? ` (${shown.join(', ')})` : '';
}

/** One bullet per excerpt; same-repository issues and pulls use the `#n` form GitHub links itself. */
export function excerptLine(excerpt: Excerpt, repository: string, releasesIndexed = false): string {
  const title = escapeInline(excerpt.title);
  const url = safeUrl(excerpt.url);
  const link = (label: string) => (url ? `[${label}](${url})` : label);
  switch (excerpt.source) {
    case 'issue':
    case 'pull': {
      const number = /\/(\d+)$/.exec(excerpt.url)?.[1];
      const ref = excerpt.origin === repository && number ? `#${number} ${title}` : link(title);
      return `- ${ref}${parts(excerpt, releasesIndexed)}`;
    }
    case 'forum': return `- Forum: ${link(title)}${parts(excerpt, releasesIndexed)}`;
    case 'discussion': return `- Discussion: ${link(title)}${parts(excerpt, releasesIndexed)}`;
    case 'docs': return `- Docs: ${link(excerpt.heading ? `${title} › ${escapeInline(excerpt.heading)}` : title)}`;
    default: return `- ${link(title)}${parts(excerpt, releasesIndexed)}`;
  }
}

function visible(excerpt: Excerpt, developerTopic: boolean): boolean {
  if (excerpt.audience === 'maintainer') return false;
  if (excerpt.audience === 'developer') return developerTopic;
  return true;
}

function section(heading: string, ids: number[], handoff: Handoff, developerTopic: boolean, order: (a: Excerpt, b: Excerpt) => number = () => 0): string | null {
  const byId = new Map(handoff.excerpts.map((e) => [e.id, e]));
  const excerpts = ids.map((id) => byId.get(id)).filter((e): e is Excerpt => e !== undefined && visible(e, developerTopic));
  const lines = excerpts.sort(order).map((e) => excerptLine(e, handoff.repository, handoff.retrieval.releasesIndexed));
  return lines.length ? [heading, ...lines].join('\n') : null;
}

/** Duplicates are listed oldest first so the original report comes before later copies. */
const OLDEST_FIRST = (a: Excerpt, b: Excerpt): number => a.date.localeCompare(b.date);

/** The comment for a tier, or null when the tier is low or nothing visible remains. */
export function renderComment({ handoff, verdict, tier, runId }: { handoff: Handoff; verdict: Verdict; tier: Tier; runId: string }): string | null {
  if (tier === 'low') return null;
  const developerTopic = DEVELOPER_TOPIC.test(`${handoff.issue.title}\n${handoff.issue.body}`);
  const blocks = [
    section(DUPLICATES_HEADING, verdict.duplicates, handoff, developerTopic, OLDEST_FIRST),
    section(RELATED_HEADING, verdict.related, handoff, developerTopic),
    tier === 'high' && verdict.answer ? sanitizeAnswer(verdict.answer) || null : null,
  ].filter((b): b is string => b !== null);
  if (blocks.length === 0) return null;
  return [marker({ runId, tier, issue: handoff.issue.number }), '', ...blocks.flatMap((b) => [b, '']), '---', FOOTER, ''].join('\n');
}
