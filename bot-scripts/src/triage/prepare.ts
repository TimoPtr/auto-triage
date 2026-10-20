import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config/types.ts';
import type { Embedder } from '../embed/embedder.ts';
import { retrieve } from '../retrieval/retrieve.ts';
import type { RankedList } from '../retrieval/rrf.ts';
import { readMeta } from '../store/db.ts';
import { cleanIssueText } from '../text/clean.ts';
import { HANDOFF_VERSION, HANDOFF_EXCERPTS, toExcerpt, type Handoff } from './handoff.ts';
import type { TriageIssue } from './issue.ts';
import { triageSettings } from './settings.ts';

/** The live forum search carries the question in a URL; the cleaned text is cut to this. */
export const LIVE_QUERY_MAX_CHARS = 300;

export type GateReason = 'ok' | 'pull-request' | 'bot-author' | 'empty-issue' | 'no-usable-index' | 'below-min-similarity' | 'no-excerpts';

export interface TriageDecision { shouldContinue: boolean; reason: GateReason; bestSimilarity: number }

export interface PrepareInput {
  config: Config;
  db: DatabaseSync | null;
  embedder: Embedder | null;
  issue: TriageIssue;
  repository: string;
  /** Extra ranked lists (a live forum search); a function is called only once the gate has passed, with the cleaned question. */
  liveLists?: RankedList[] | ((question: string) => Promise<RankedList[]>);
  now?: Date;
}

/** `#<number>` of every merged pull request of `origin` whose body links the issue, ascending. */
export function fixedBy(db: DatabaseSync, origin: string, issueNumber: number): string[] {
  const rows = db.prepare(
    `SELECT source_id FROM items WHERE source = 'pull' AND origin = ? AND json_extract(outcome, '$.state') = 'merged'
     AND EXISTS (SELECT 1 FROM json_each(json_extract(outcome, '$.linkedIssues')) WHERE value = ?)
     ORDER BY CAST(source_id AS INTEGER)`,
  ).all(origin, issueNumber) as unknown as { source_id: string }[];
  return rows.map((r) => `#${r.source_id}`);
}

/** The index row id of an issue, when the index already holds it (re-check of an indexed issue). */
export function indexedItemId(db: DatabaseSync, origin: string, issueNumber: number): number | null {
  const row = db.prepare(`SELECT id FROM items WHERE source = 'issue' AND origin = ? AND source_id = ?`).get(origin, String(issueNumber)) as { id: number } | undefined;
  return row ? Number(row.id) : null;
}

function gate(issue: TriageIssue, question: string, db: DatabaseSync | null, embedder: Embedder | null): GateReason {
  if (issue.isPullRequest) return 'pull-request';
  if (issue.authorType === 'Bot') return 'bot-author';
  if (question.trim() === '') return 'empty-issue';
  if (!db || !embedder) return 'no-usable-index';
  return 'ok';
}

/**
 * Decides whether the agent runs and, when it does, builds the handoff: the
 * cleaned issue and the closest excerpts, with the issue itself excluded.
 */
export async function prepareTriage({ config, db, embedder, issue, repository, liveLists = [], now = new Date() }: PrepareInput): Promise<{ decision: TriageDecision; handoff: Handoff | null }> {
  const settings = triageSettings(config);
  const cleaned = cleanIssueText(issue.body);
  const question = [issue.title, cleaned.text].filter(Boolean).join('\n\n');
  const stop = (reason: GateReason, bestSimilarity = 0) => ({ decision: { shouldContinue: false, reason, bestSimilarity }, handoff: null });

  const reason = gate(issue, question, db, embedder);
  if (reason !== 'ok' || !db || !embedder) return stop(reason);

  // retrieve cleans the raw text itself and lifts fenced logs into the lexical query
  const lists = typeof liveLists === 'function' ? await liveLists(question.slice(0, LIVE_QUERY_MAX_CHARS)) : liveLists;
  const results = await retrieve(db, embedder, `${issue.title}\n\n${issue.body}`, {
    k: HANDOFF_EXCERPTS, minSimilarity: settings.minSimilarity, excludeItemId: indexedItemId(db, repository, issue.number) ?? undefined, liveLists: lists, now,
  });
  if (results.bestSimilarity < settings.minSimilarity) return stop('below-min-similarity', results.bestSimilarity);
  if (results.length === 0) return stop('no-excerpts', results.bestSimilarity);

  const handoff: Handoff = {
    version: HANDOFF_VERSION,
    product: { name: config.product.name, slug: config.product.slug },
    repository,
    issue: { number: issue.number, title: issue.title, body: cleaned.text, logs: cleaned.logs, labels: issue.labels, createdAt: issue.createdAt },
    excerpts: results.map((r, id) => toExcerpt(r, id, r.source === 'issue' ? fixedBy(db, r.origin, Number(r.sourceId)) : [])),
    thresholds: { answer: settings.answer, links: settings.links },
    retrieval: { bestSimilarity: results.bestSimilarity, minSimilarity: settings.minSimilarity, indexBuiltAt: readMeta(db).built_at ?? null },
  };
  return { decision: { shouldContinue: true, reason: 'ok', bestSimilarity: results.bestSimilarity }, handoff };
}
