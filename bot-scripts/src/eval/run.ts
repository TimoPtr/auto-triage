import type { DatabaseSync } from 'node:sqlite';
import { readMeta } from '../store/db.ts';
import { retrieve, type RetrieveOptions } from '../retrieval/retrieve.ts';
import { normalizeUrl } from './mine.ts';
import { mulberry32 } from './random.ts';
import { byGroup, gateAt, gateSweep, retrievalMetrics, RETRIEVE_K, type CaseResult, type GateMetrics, type RankedEntry, type RetrievalMetrics } from './metrics.ts';
import type { EvalCase, Expected } from './cases.ts';
import type { Embedder } from '../embed/embedder.ts';

export type EvalMode = 'production' | 'oracle' | 'null';
/** Longest query text in oracle mode, where an expected docs page may be long. */
const ORACLE_CHARS = 2000;

export interface RunEvalInput {
  db: DatabaseSync;
  embedder: Embedder;
  cases: EvalCase[];
  mode?: EvalMode;
  threshold: number;
  retrieveOptions?: Pick<RetrieveOptions, 'minSimilarity' | 'sourceWeights' | 'decayAfterDays' | 'decayFactor'>;
  seed?: number;
  log?: (line: string) => void;
}

export interface EvalError { id: string; reason: string }

export interface EvalSummary {
  run: { mode: EvalMode; cases: number; scored: number; errors: number; modelKey: string; builtAt: string | null; startedAt: string; durationSeconds: number; threshold: number };
  retrieval: { all: RetrievalMetrics; byRelation: Record<string, RetrievalMetrics>; byExpectedSource: Record<string, RetrievalMetrics>; byLabelSource: Record<string, RetrievalMetrics> };
  gate: { at: GateMetrics; sweep: GateMetrics[] };
}

interface ItemRef { id: number; source: string; sourceId: string; url: string }
class CaseError extends Error {}

/** Index lookups the harness needs, with bound parameters only. */
class Index {
  private readonly byNumber;
  private readonly byNumberAnywhere;
  private readonly bySource;
  private readonly bodyChunks;
  private readonly allChunks;
  private readonly allItems;
  constructor(db: DatabaseSync) {
    const columns = 'id, source, source_id AS sourceId, url';
    this.byNumber = db.prepare(`SELECT ${columns} FROM items WHERE source = ? AND source_id = ? AND origin = ?`);
    this.byNumberAnywhere = db.prepare(`SELECT ${columns} FROM items WHERE source = ? AND source_id = ?`);
    this.bySource = db.prepare(`SELECT ${columns} FROM items WHERE source = ?`);
    this.bodyChunks = db.prepare("SELECT text, logs FROM chunks WHERE item_id = ? AND kind = 'body' ORDER BY seq");
    this.allChunks = db.prepare('SELECT text, logs FROM chunks WHERE item_id = ? ORDER BY seq');
    this.allItems = db.prepare(`SELECT ${columns} FROM items ORDER BY id`);
  }

  /** The item an expected or query entry names, or null; several matches without an origin is an error. */
  resolve(entry: { type: string; number?: number; url?: string; origin?: string }): ItemRef | null {
    if (entry.url !== undefined) {
      const wanted = normalizeUrl(entry.url);
      return (this.bySource.all(entry.type) as unknown as ItemRef[]).find((i) => normalizeUrl(i.url) === wanted) ?? null;
    }
    const rows = (entry.origin
      ? this.byNumber.all(entry.type, String(entry.number), entry.origin)
      : this.byNumberAnywhere.all(entry.type, String(entry.number))) as unknown as ItemRef[];
    if (rows.length > 1) throw new CaseError(`ambiguous ${entry.type} ${entry.number}: ${rows.length} origins`);
    return rows[0] ?? null;
  }

  /** The item's body chunks (every chunk for an item without a body, such as a docs page) with their logs. */
  text(ref: ItemRef): string {
    let rows = this.bodyChunks.all(ref.id) as unknown as { text: string; logs: string | null }[];
    if (rows.length === 0) rows = this.allChunks.all(ref.id) as unknown as { text: string; logs: string | null }[];
    return [...rows.map((r) => r.text), ...rows.map((r) => r.logs).filter(Boolean)].join('\n\n');
  }

  items(): ItemRef[] {
    return this.allItems.all() as unknown as ItemRef[];
  }
}

function matches(entry: RankedEntry, expected: { ref: ItemRef; url: string | undefined }[]): boolean {
  return expected.some(({ ref, url }) => (url !== undefined ? normalizeUrl(entry.url) === url : entry.source === ref.source && entry.sourceId === ref.sourceId));
}

function describe(entry: Expected): string {
  return `${entry.type} ${entry.url ?? entry.number}`;
}

/** Resolves a case's query item and expected items against the index; an absent one is an error. */
function prepare(index: Index, evalCase: EvalCase): { query: ItemRef | null; expected: { ref: ItemRef; url: string | undefined }[] } {
  const expected = evalCase.expected.map((entry) => {
    const ref = index.resolve(entry);
    if (!ref) throw new CaseError(`expected not in index: ${describe(entry)}`);
    return { ref, url: entry.url === undefined ? undefined : normalizeUrl(entry.url) };
  });
  if (evalCase.query.type === 'text') return { query: null, expected };
  const query = index.resolve(evalCase.query);
  if (!query) throw new CaseError(`query item not in index: ${evalCase.query.type} ${evalCase.query.number}`);
  return { query, expected };
}

function nullRanking(index: Index, exclude: ItemRef | null, random: () => number): RankedEntry[] {
  const pool = index.items().filter((i) => i.id !== exclude?.id);
  for (let i = pool.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, RETRIEVE_K).map((i) => ({ source: i.source, sourceId: i.sourceId, url: i.url, fused: 0, similarity: null }));
}

function toResult(evalCase: EvalCase, ranked: RankedEntry[], bestSimilarity: number, expected: { ref: ItemRef; url: string | undefined }[]): CaseResult {
  const index = ranked.findIndex((entry) => matches(entry, expected));
  return {
    id: evalCase.id, relation: evalCase.relation, split: evalCase.split, expectedSources: Array.from(new Set(expected.map((e) => e.ref.source))),
    ranked, firstRank: index === -1 ? null : index + 1, bestSimilarity, positive: evalCase.relation !== 'negative',
  };
}

/** Runs every case through the production retrieval (or the oracle or null ranking) and scores it. */
export async function runEval({ db, embedder, cases, mode = 'production', threshold, retrieveOptions = {}, seed = 1, log = () => {} }: RunEvalInput): Promise<{ results: CaseResult[]; errors: EvalError[]; summary: EvalSummary }> {
  const started = Date.now();
  const index = new Index(db);
  const random = mulberry32(seed);
  const results: CaseResult[] = [];
  const errors: EvalError[] = [];
  for (const evalCase of cases) {
    try {
      const { query, expected } = prepare(index, evalCase);
      if (mode === 'oracle' && expected.length === 0) continue;
      if (mode === 'null') { results.push(toResult(evalCase, nullRanking(index, query, random), 0, expected)); continue; }
      const text = mode === 'oracle' ? index.text(expected[0].ref).slice(0, ORACLE_CHARS) : query ? index.text(query) : (evalCase.query as { text: string }).text;
      const hits = await retrieve(db, embedder, text, { ...retrieveOptions, k: RETRIEVE_K, asOf: evalCase.query.asOf, excludeItemId: query?.id });
      const ranked = hits.map((h) => ({ source: h.source, sourceId: h.sourceId, url: h.url, fused: h.scores.fused, similarity: h.scores.itemSimilarity }));
      results.push(toResult(evalCase, ranked, hits.bestSimilarity, expected));
    } catch (error) {
      const reason = error instanceof CaseError ? error.message : `retrieve failed: ${error instanceof Error ? error.message : String(error)}`;
      errors.push({ id: evalCase.id, reason });
      log(`${evalCase.id}: ${reason}`);
    }
  }
  const meta = readMeta(db);
  const summary: EvalSummary = {
    run: { mode, cases: cases.length, scored: results.length, errors: errors.length, modelKey: meta.model_key ?? '', builtAt: meta.built_at ?? null, startedAt: new Date(started).toISOString(), durationSeconds: (Date.now() - started) / 1000, threshold },
    retrieval: {
      all: retrievalMetrics(results),
      byRelation: byGroup(results.filter((r) => r.positive), (r) => [r.relation]),
      byExpectedSource: byGroup(results.filter((r) => r.positive), (r) => r.expectedSources),
      byLabelSource: byGroup(results.filter((r) => r.positive), (r) => [cases.find((c) => c.id === r.id)?.labelSource ?? '?']),
    },
    gate: { at: gateAt(results, threshold), sweep: gateSweep(results) },
  };
  return { results, errors, summary };
}

const pct = (n: number | null) => (n === null ? 'n/a' : n.toFixed(1));
function metricsTable(title: string, groups: Record<string, RetrievalMetrics>): string[] {
  return [`### ${title}`, '', '| group | n | recall@5 | MRR |', '| --- | --- | --- | --- |', ...Object.entries(groups).sort().map(([name, m]) => `| ${name} | ${m.n} | ${pct(m.recallAt5)} | ${m.mrr.toFixed(3)} |`), ''];
}

/** The run summary as markdown for a job summary or a README. */
export function summaryMarkdown(summary: EvalSummary): string {
  const { run, retrieval, gate } = summary;
  const gateRow = (g: GateMetrics) => `| ${g.threshold.toFixed(2)} | ${pct(g.precision)} | ${pct(g.specificity)} | ${pct(g.sensitivity)} |`;
  return [
    `## Retrieval eval (${run.mode})`, '',
    `${run.scored} of ${run.cases} cases scored, errors: ${run.errors}; model \`${run.modelKey}\`; index built ${run.builtAt ?? 'unknown'}; ${run.durationSeconds.toFixed(1)} s.`, '',
    `All positives: n ${retrieval.all.n}, recall@5 ${pct(retrieval.all.recallAt5)}, MRR ${retrieval.all.mrr.toFixed(3)}.`, '',
    ...metricsTable('By relation', retrieval.byRelation),
    ...metricsTable('By expected source', retrieval.byExpectedSource),
    ...metricsTable('By label source', retrieval.byLabelSource),
    `### Gate at ${gate.at.threshold.toFixed(2)}`, '',
    `Precision ${pct(gate.at.precision)}, specificity ${pct(gate.at.specificity)}, sensitivity ${pct(gate.at.sensitivity)} over ${gate.at.positives} positives and ${gate.at.negatives} negatives.`, '',
    '| threshold | precision | specificity | sensitivity |', '| --- | --- | --- | --- |', ...gate.sweep.map(gateRow), '',
  ].join('\n');
}
