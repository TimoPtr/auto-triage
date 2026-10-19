import type { DatabaseSync } from 'node:sqlite';
import { quantizeInt8, toBlob, cosineFromL2 } from '../store/vectors.ts';
import { readMeta } from '../store/db.ts';
import { cleanIssueText } from '../text/clean.ts';
import { toFtsQuery } from './fts.ts';
import { fuse, type RankedList } from './rrf.ts';
import type { Embedder } from '../embed/embedder.ts';

/** Sources whose entries age; docs and code never decay. */
const DATED_SOURCES = new Set(['issue', 'pull', 'discussion', 'forum']);
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetrievalResult {
  itemId: number;
  chunkId: number;
  source: string;
  provider: string;
  origin: string;
  sourceId: string;
  url: string;
  title: string;
  heading: string | null;
  anchor: string | null;
  text: string;
  createdAt: string;
  audience: string;
  authorRole: string | null;
  outcome: Record<string, unknown> | null;
  scores: { similarity: number | null; lexical: number | null; fused: number };
  rank: number;
}

export type RetrievalResults = RetrievalResult[] & { bestSimilarity: number };

export interface RetrieveOptions {
  k?: number;
  candidates?: number;
  /** Dense candidates below this cosine similarity never reach the fusion. 0 disables the floor. */
  minSimilarity?: number;
  sourceWeights?: Record<string, number>;
  decayAfterDays?: number;
  decayFactor?: number;
  asOf?: string;
  excludeItemId?: number;
  liveLists?: RankedList[];
  now?: Date;
}

interface KnnRow { chunk_id: number; distance: number }
interface LexicalRow { id: number; score: number }
interface ChunkRow {
  chunk_id: number; item_id: number; heading: string | null; anchor: string | null; text: string; created_at: string; author_role: string | null;
  source: string; provider: string; origin: string; source_id: string; url: string; title: string; audience: string; outcome: string | null;
}

function filters({ asOf, excludeItemId }: RetrieveOptions): { where: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (asOf) { clauses.push('c.created_at < ?'); params.push(asOf); }
  if (excludeItemId !== undefined) { clauses.push('c.item_id != ?'); params.push(excludeItemId); }
  return { where: clauses.length ? `AND ${clauses.join(' AND ')}` : '', params };
}

function denseCandidates(db: DatabaseSync, vector: Float32Array, candidates: number, where: string, params: (string | number)[]): KnnRow[] {
  return db.prepare(
    `SELECT v.chunk_id, v.distance FROM vec_chunks v JOIN chunks c ON c.id = v.chunk_id
     WHERE v.embedding MATCH vec_int8(?) AND k = ? ${where} ORDER BY v.distance`,
  ).all(toBlob(quantizeInt8(vector)), BigInt(candidates * 4), ...params) as unknown as KnnRow[];
}

function lexicalCandidates(db: DatabaseSync, question: string, candidates: number, where: string, params: (string | number)[]): LexicalRow[] {
  const ftsQuery = toFtsQuery(question);
  if (ftsQuery === null) return [];
  return db.prepare(
    `SELECT c.id, bm25(chunks_fts) AS score FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
     WHERE chunks_fts MATCH ? ${where} ORDER BY score LIMIT ?`,
  ).all(ftsQuery, ...params, candidates) as unknown as LexicalRow[];
}

function loadChunks(db: DatabaseSync, ids: number[]): ChunkRow[] {
  return db.prepare(
    `SELECT c.id AS chunk_id, c.item_id, c.heading, c.anchor, c.text, c.created_at, c.author_role,
            i.source, i.provider, i.origin, i.source_id, i.url, i.title, i.audience, i.outcome
     FROM chunks c JOIN items i ON i.id = c.item_id WHERE c.id IN (${ids.map(() => '?').join(',')})`,
  ).all(...ids) as unknown as ChunkRow[];
}

/**
 * Cleans a question like an issue body: template noise goes, logs are lifted
 * into the lexical text so error strings reach FTS5. A question that cleans
 * to nothing is used as written.
 */
export function prepareQuestion(question: string): { embedText: string; lexicalText: string } {
  const { text, logs } = cleanIssueText(question);
  const embedText = text || question;
  const lexicalText = [text, logs].filter(Boolean).join('\n') || question;
  return { embedText, lexicalText };
}

/**
 * Hybrid retrieval: vector KNN and FTS5 fused with reciprocal rank fusion,
 * weighted per source, decayed by age, collapsed to the best chunk per item.
 */
export async function retrieve(db: DatabaseSync, embedder: Embedder, question: string, options: RetrieveOptions = {}): Promise<RetrievalResults> {
  const { k = 8, candidates = 50, minSimilarity = 0, sourceWeights = {}, decayAfterDays = 730, decayFactor = 0.7, liveLists = [], now = new Date() } = options;
  const meta = readMeta(db);
  if (meta.model_key !== embedder.modelKey) {
    throw new Error(`Index model ${meta.model_key} does not match configured ${embedder.modelKey}; rebuild the index`);
  }
  const { where, params } = filters(options);

  const { embedText, lexicalText } = prepareQuestion(question);
  const [vector] = await embedder.embed([embedText]);
  const knn = denseCandidates(db, vector, candidates, where, params);
  // the gate reads the real best hit; the floor only decides what reaches the fusion
  const bestSimilarity = knn.length ? cosineFromL2(knn[0].distance) : 0;
  const dense = knn.filter((r) => cosineFromL2(r.distance) >= minSimilarity).slice(0, candidates);
  const similarity = new Map(dense.map((r) => [Number(r.chunk_id), cosineFromL2(r.distance)]));

  const lexicalRows = lexicalCandidates(db, lexicalText, candidates, where, params);
  const lexical = new Map(lexicalRows.map((r) => [Number(r.id), -r.score]));

  const fused = fuse([
    { weight: 1, ids: dense.map((r) => r.chunk_id), scores: dense.map((r) => r.distance) },
    { weight: 1, ids: lexicalRows.map((r) => r.id), scores: lexicalRows.map((r) => r.score) },
    ...liveLists,
  ]);
  if (fused.size === 0) return Object.assign([], { bestSimilarity });

  const best = new Map<number, RetrievalResult>();
  for (const row of loadChunks(db, Array.from(fused.keys()))) {
    const ageDays = (now.getTime() - Date.parse(row.created_at)) / DAY_MS;
    const decay = DATED_SOURCES.has(row.source) && ageDays > decayAfterDays ? decayFactor : 1;
    const score = (fused.get(row.chunk_id) ?? 0) * (sourceWeights[row.source] ?? 1) * decay;
    const current = best.get(row.item_id);
    if (!current || score > current.scores.fused) {
      best.set(row.item_id, {
        itemId: row.item_id, chunkId: row.chunk_id, source: row.source, provider: row.provider, origin: row.origin,
        sourceId: row.source_id, url: row.url, title: row.title, heading: row.heading, anchor: row.anchor, text: row.text,
        createdAt: row.created_at, audience: row.audience, authorRole: row.author_role ?? null,
        outcome: row.outcome ? (JSON.parse(row.outcome) as Record<string, unknown>) : null,
        scores: { similarity: similarity.get(row.chunk_id) ?? null, lexical: lexical.get(row.chunk_id) ?? null, fused: score },
        rank: 0,
      });
    }
  }
  const results = Array.from(best.values()).sort((a, b) => b.scores.fused - a.scores.fused).slice(0, k)
    .map((r, i) => ({ ...r, rank: i + 1 }));
  return Object.assign(results, { bestSimilarity });
}
