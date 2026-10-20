import { hashOrder, splitFor, type EvalCase, type Expected, type Relation, type Tier } from './cases.ts';
import { linksOf } from './github-links.ts';
import { linkedIssues, type StoredPull } from '../providers/github/pulls.ts';
import type { ApiComment, StoredIssue } from '../providers/github/issues.ts';
import type { Config } from '../config/types.ts';
import type { RawStore } from '../store/raw.ts';

/** A docs link in the comment that closed the issue still counts this long after the close event. */
export const CLOSE_COMMENT_GRACE_MS = 60_000;
export const DEFAULT_SAMPLE = 30;
const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const DUPLICATE_OF = /\bdup(?:licate|e)s?\s*(?:of|:)?\s*(?:https:\/\/github\.com\/([^\s/]+\/[^\s/]+)\/(?:issues|pull)\/|#)(\d+)/gi;
const URL = /https?:\/\/[^\s)>\]'"]+/g;
/** Lines a comment quotes from someone else; what they say is not the maintainer's. */
const QUOTED_LINE = /^[ \t]*>.*$/gm;
const TIER: Record<Relation, Tier> = { duplicate: 'high', 'fixed-by': 'medium', docs: 'high', forum: 'medium', negative: 'low', curated: 'high' };
const PREFIX: Record<Relation, string> = { duplicate: 'dup', 'fixed-by': 'fix', docs: 'docs', forum: 'forum', negative: 'neg', curated: 'cur' };

export interface MiningReport {
  counts: { byRelation: Record<string, number>; byLabelSource: Record<string, number> };
  dropped: Record<string, number>;
  negativesPool: number;
}

interface Draft { relation: Relation; repo: string; query: number; asOf: string; expected: Expected[]; labelSource: string }
interface Repo { name: string; issues: Map<number, StoredIssue>; pulls: Map<number, StoredPull> }

/** Mining state for one repository: the drafts keyed by relation and query, and the drop counters. */
class Miner {
  readonly drafts = new Map<string, Draft>();
  readonly dropped: Record<string, number> = {};
  readonly incomplete = new Set<number>();
  readonly repo: Repo;
  readonly raw: RawStore;
  readonly docsBases: string[];
  readonly forumHosts: string[];
  constructor(repo: Repo, raw: RawStore, docsBases: string[], forumHosts: string[]) {
    this.repo = repo;
    this.raw = raw;
    this.docsBases = docsBases;
    this.forumHosts = forumHosts;
  }

  drop(reason: string) { this.dropped[reason] = (this.dropped[reason] ?? 0) + 1; }

  /** Adds an expected entry to the draft of `(relation, query)`, creating it; the latest `asOf` wins so every expected exists. */
  add(relation: Relation, query: number, asOf: string, expected: Expected, labelSource: string) {
    const key = `${relation}:${query}`;
    const draft = this.drafts.get(key);
    if (!draft) { this.drafts.set(key, { relation, repo: this.repo.name, query, asOf, expected: [expected], labelSource }); return; }
    if (!draft.expected.some((e) => e.number === expected.number && e.url === expected.url && e.type === expected.type)) draft.expected.push(expected);
    if (asOf > draft.asOf) draft.asOf = asOf;
  }

  /** Maintainer comments of a closed issue with their quoted lines removed; an issue stored without its comments is counted and skipped. */
  maintainerComments(stored: StoredIssue): ApiComment[] {
    if (!stored.complete) {
      if (!this.incomplete.has(stored.issue.number)) { this.incomplete.add(stored.issue.number); this.drop('incomplete-issue'); }
      return [];
    }
    return stored.comments
      .filter((c) => c.author_association !== undefined && MAINTAINER_ASSOCIATIONS.has(c.author_association))
      .map((c) => ({ ...c, body: (c.body ?? '').replace(QUOTED_LINE, '') }));
  }

  /** The type of a referenced number, or null when it is unknown or in another repository. */
  target(number: number, repo: string | undefined): Expected | null {
    if (repo && repo.toLowerCase() !== this.repo.name.toLowerCase()) { this.drop('unknown-target'); return null; }
    if (this.repo.issues.has(number)) return { type: 'issue', number, origin: this.repo.name };
    if (this.repo.pulls.has(number)) return { type: 'pull', number, origin: this.repo.name };
    this.drop('unknown-target');
    return null;
  }

  /** The later-created issue of the pair becomes the query, the earlier the expected. */
  duplicate(stored: StoredIssue, targetNumber: number, targetRepo: string | undefined, asOf: string, labelSource: string) {
    const target = this.target(targetNumber, targetRepo);
    if (!target) return;
    const other = this.repo.issues.get(targetNumber);
    const swap = target.type === 'issue' && other !== undefined && other.issue.created_at > stored.issue.created_at;
    const query = swap ? targetNumber : stored.issue.number;
    const expected = swap ? { type: 'issue' as const, number: stored.issue.number, origin: this.repo.name } : target;
    this.add('duplicate', query, asOf, expected, labelSource);
  }

  /** Timeline marks first, read from both sides of the pair; a comment rule applies only to an issue with no mark. */
  duplicates() {
    const marked = new Set<number>();
    for (const stored of this.repo.issues.values()) {
      const links = linksOf(this.raw, this.repo.name, stored.issue.number);
      if (!links) continue;
      const asOf = links.markedAt ?? stored.issue.closed_at ?? stored.issue.updated_at;
      for (const number of links.duplicateOf) { marked.add(stored.issue.number); this.duplicate(stored, number, undefined, asOf, 'timeline:marked-duplicate'); }
      for (const number of links.duplicatedBy) {
        const other = this.repo.issues.get(number);
        if (!other) { this.drop('unknown-target'); continue; }
        marked.add(number);
        this.duplicate(other, stored.issue.number, undefined, asOf, 'timeline:marked-duplicate');
      }
    }
    for (const stored of this.repo.issues.values()) {
      if (stored.issue.state !== 'closed' || marked.has(stored.issue.number)) continue;
      for (const comment of this.maintainerComments(stored)) {
        for (const match of (comment.body ?? '').matchAll(DUPLICATE_OF)) this.duplicate(stored, Number(match[2]), match[1], comment.created_at, 'comment:duplicate-of');
      }
    }
  }

  fixes() {
    for (const stored of this.repo.pulls.values()) {
      const { pull } = stored;
      if (!pull.merged_at) continue;
      const links = linksOf(this.raw, this.repo.name, pull.number);
      const [numbers, labelSource] = links?.closes.length ? [links.closes, 'pull:closing-reference'] : [linkedIssues(pull.body ?? ''), 'pull:body-keyword'];
      for (const number of numbers) {
        const issue = this.repo.issues.get(number);
        if (!issue) { this.drop('unknown-target'); continue; }
        if (issue.issue.state !== 'closed' || !issue.issue.closed_at) continue;
        // a pull request fixes an issue that was still open when it was opened; a reference to a long-closed issue is noise
        if (issue.issue.closed_at < pull.created_at) { this.drop('closed-before-pull'); continue; }
        this.add('fixed-by', number, pull.merged_at, { type: 'pull', number: pull.number, origin: this.repo.name }, labelSource);
      }
    }
  }

  answers() {
    const forum = this.forumHosts.map((host) => ({ host, pattern: new RegExp(`^https://${host.replaceAll('.', '\\.')}/t/(?:[^/]+/)?(\\d+)`) }));
    for (const stored of this.repo.issues.values()) {
      if (stored.issue.state !== 'closed') continue;
      const closedAt = stored.issue.closed_at ? Date.parse(stored.issue.closed_at) + CLOSE_COMMENT_GRACE_MS : null;
      for (const comment of this.maintainerComments(stored)) for (const url of (comment.body ?? '').match(URL) ?? []) {
        if (this.docsBases.some((base) => url.startsWith(base))) {
          if (closedAt !== null && Date.parse(comment.created_at) <= closedAt) this.add('docs', stored.issue.number, comment.created_at, { type: 'docs', url: normalizeUrl(url) }, 'comment:docs-link');
          continue;
        }
        for (const { host, pattern } of forum) {
          const match = pattern.exec(url);
          if (!match) continue;
          if (this.raw.get('discourse', host, 'topic', match[1])) this.add('forum', stored.issue.number, comment.created_at, { type: 'forum', number: Number(match[1]), origin: host }, 'comment:forum-link');
          else this.drop('unknown-target');
        }
      }
    }
  }

  /** Issues fixed by a pull request and answered by nothing else, drawn in salted hash order. */
  negatives(salt: string): number {
    const answered = new Set(Array.from(this.drafts.values()).filter((d) => d.relation !== 'fixed-by').map((d) => d.query));
    const pool = Array.from(this.drafts.values()).filter((d) => d.relation === 'fixed-by' && !answered.has(d.query)).map((d) => d.query);
    const wanted = Array.from(this.drafts.values()).filter((d) => d.relation === 'duplicate' || d.relation === 'docs' || d.relation === 'forum').length;
    pool.sort((a, b) => hashOrder(String(a), `negative${salt}`).localeCompare(hashOrder(String(b), `negative${salt}`)));
    for (const number of pool.slice(0, wanted)) {
      const issue = this.repo.issues.get(number)!;
      this.drafts.set(`negative:${number}`, { relation: 'negative', repo: this.repo.name, query: number, asOf: issue.issue.created_at, expected: [], labelSource: 'negative:fixed-only' });
    }
    return pool.length;
  }
}

/** A docs link without fragment, query string or trailing slash, as the index stores page URLs. */
export function normalizeUrl(url: string): string {
  return url.replace(/[#?].*$/, '').replace(/\/+$/, '');
}

function loadRepo(raw: RawStore, name: string): Repo {
  const issues = new Map<number, StoredIssue>();
  for (const r of raw.each<StoredIssue>('github', name, 'issue')) issues.set(r.payload.issue.number, r.payload);
  const pulls = new Map<number, StoredPull>();
  for (const r of raw.each<StoredPull>('github', name, 'pull')) pulls.set(r.payload.pull.number, r.payload);
  return { name, issues, pulls };
}

function toCase(draft: Draft, salt: string): EvalCase {
  const id = `${PREFIX[draft.relation]}-${draft.query}`;
  return {
    id, relation: draft.relation, split: splitFor(id, salt),
    query: { type: 'issue', number: draft.query, origin: draft.repo, asOf: draft.asOf },
    expected: draft.expected, expectedTier: TIER[draft.relation], labelSource: draft.labelSource, verified: false,
  };
}

/** Mines the benchmark cases of every GitHub repository with issues in the config from the raw store. */
export function mineCases({ config, raw, salt = '' }: { config: Config; raw: RawStore; salt?: string }): { cases: EvalCase[]; report: MiningReport } {
  const github = config.providers.github ?? {};
  const docsBases = Object.values(github).flatMap((c) => (c.docs ? [c.docs.baseUrl] : []));
  const forumHosts = Object.keys(config.providers.discourse ?? {});
  const cases: EvalCase[] = [];
  const report: MiningReport = { counts: { byRelation: {}, byLabelSource: {} }, dropped: {}, negativesPool: 0 };
  for (const name of Object.keys(github).filter((n) => github[n].issues)) {
    const miner = new Miner(loadRepo(raw, name), raw, docsBases, forumHosts);
    miner.duplicates();
    miner.fixes();
    miner.answers();
    report.negativesPool += miner.negatives(salt);
    for (const draft of miner.drafts.values()) cases.push(toCase(draft, salt));
    for (const [reason, n] of Object.entries(miner.dropped)) report.dropped[reason] = (report.dropped[reason] ?? 0) + n;
  }
  cases.sort((a, b) => a.relation.localeCompare(b.relation) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  for (const c of cases) {
    report.counts.byRelation[c.relation] = (report.counts.byRelation[c.relation] ?? 0) + 1;
    report.counts.byLabelSource[c.labelSource] = (report.counts.byLabelSource[c.labelSource] ?? 0) + 1;
  }
  return { cases, report };
}

/** A table of `n` cases in salted hash order for a person to re-derive by hand, with an empty verdict column. */
export function sampleMarkdown(cases: EvalCase[], n: number, salt: string, urls: (c: EvalCase) => { query: string; expected: string[] }): string {
  const picked = [...cases].sort((a, b) => hashOrder(a.id, `sample${salt}`).localeCompare(hashOrder(b.id, `sample${salt}`))).slice(0, n);
  const lines = ['# Benchmark label sample', '', `${picked.length} of ${cases.length} cases, drawn by hash. Fill the verdict column (ok / wrong: reason); fix the rule, never the case.`, '', '| id | relation | labelSource | query | expected | verdict |', '| --- | --- | --- | --- | --- | --- |'];
  for (const c of picked) {
    const u = urls(c);
    lines.push(`| ${c.id} | ${c.relation} | ${c.labelSource} | ${u.query} | ${u.expected.join(' ') || '(nothing)'} |  |`);
  }
  return lines.join('\n') + '\n';
}
