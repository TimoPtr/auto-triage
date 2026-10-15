// @ts-check
import { quantizeInt8, toBlob, cosineFromL2 } from '../store/vectors.js';
import { readMeta } from '../store/db.js';
import { toFtsQuery } from './fts.js';
import { fuse } from './rrf.js';

/** Sources whose entries age; docs and code never decay. */
const DATED_SOURCES = new Set(['issue', 'pull', 'discussion', 'forum']);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {{ itemId: number, chunkId: number, source: string, provider: string, origin: string, sourceId: string, url: string, title: string, heading: string|null, anchor: string|null, text: string, createdAt: string, audience: string, outcome: object|null, scores: { similarity: number|null, lexical: number|null, fused: number }, rank: number }} RetrievalResult
 */

/**
 * @param {{ asOf?: string, excludeItemId?: number }} options
 */
function filters({ asOf, excludeItemId }) {
  const clauses = [];
  const params = [];
  if (asOf) { clauses.push('c.created_at < ?'); params.push(asOf); }
  if (excludeItemId !== undefined) { clauses.push('c.item_id != ?'); params.push(excludeItemId); }
  return { where: clauses.length ? `AND ${clauses.join(' AND ')}` : '', params };
}

/**
 * Hybrid retrieval: vector KNN and FTS5 fused with reciprocal rank fusion,
 * weighted per source, decayed by age, collapsed to the best chunk per item.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {import('../embed/embedder.js').Embedder} embedder
 * @param {string} question
 * @param {{ k?: number, candidates?: number, minSimilarity?: number, sourceWeights?: Record<string, number>, decayAfterDays?: number, decayFactor?: number, asOf?: string, excludeItemId?: number, liveLists?: { weight: number, ids: number[] }[], now?: Date }} [options]
 * @returns {Promise<RetrievalResult[] & { bestSimilarity: number }>}
 */
export async function retrieve(db, embedder, question, options = {}) {
  const { k = 8, candidates = 50, minSimilarity = 0.3, sourceWeights = {}, decayAfterDays = 730, decayFactor = 0.7, liveLists = [], now = new Date() } = options;
  const meta = readMeta(db);
  if (meta.model_key !== embedder.modelKey) {
    throw new Error(`Index model ${meta.model_key} does not match configured ${embedder.modelKey}; rebuild the index`);
  }
  const { where, params } = filters(options);

  const [vector] = await embedder.embed([question]);
  const dense = /** @type {{ chunk_id: number, distance: number }[]} */ (db.prepare(
    `SELECT v.chunk_id, v.distance FROM vec_chunks v JOIN chunks c ON c.id = v.chunk_id
     WHERE v.embedding MATCH vec_int8(?) AND k = ? ${where} ORDER BY v.distance`,
  ).all(toBlob(quantizeInt8(vector)), BigInt(candidates * 4), ...params))
    // a candidate below the floor matches nothing meaningful; it must not reach the fusion
    .filter((r) => cosineFromL2(r.distance) >= minSimilarity)
    .slice(0, candidates);
  const similarity = new Map(dense.map((r) => [Number(r.chunk_id), cosineFromL2(r.distance)]));

  const ftsQuery = toFtsQuery(question);
  const lexicalRows = ftsQuery === null ? [] : /** @type {{ id: number, score: number }[]} */ (db.prepare(
    `SELECT c.id, bm25(chunks_fts) AS score FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
     WHERE chunks_fts MATCH ? ${where} ORDER BY score LIMIT ?`,
  ).all(ftsQuery, ...params, candidates));
  const lexical = new Map(lexicalRows.map((r) => [Number(r.id), -r.score]));

  const fused = fuse([
    { weight: 1, ids: dense.map((r) => r.chunk_id) },
    { weight: 1, ids: lexicalRows.map((r) => r.id) },
    ...liveLists,
  ]);
  if (fused.size === 0) return Object.assign([], { bestSimilarity: 0 });

  const ids = Array.from(fused.keys());
  const rows = /** @type {any[]} */ (db.prepare(
    `SELECT c.id AS chunk_id, c.item_id, c.heading, c.anchor, c.text, c.created_at,
            i.source, i.provider, i.origin, i.source_id, i.url, i.title, i.audience, i.outcome
     FROM chunks c JOIN items i ON i.id = c.item_id WHERE c.id IN (${ids.map(() => '?').join(',')})`,
  ).all(...ids));

  const best = new Map();
  for (const row of rows) {
    const ageDays = (now.getTime() - Date.parse(row.created_at)) / DAY_MS;
    const decay = DATED_SOURCES.has(row.source) && ageDays > decayAfterDays ? decayFactor : 1;
    const score = (fused.get(row.chunk_id) ?? 0) * (sourceWeights[row.source] ?? 1) * decay;
    const current = best.get(row.item_id);
    if (!current || score > current.scores.fused) {
      best.set(row.item_id, {
        itemId: row.item_id, chunkId: row.chunk_id, source: row.source, provider: row.provider, origin: row.origin,
        sourceId: row.source_id, url: row.url, title: row.title, heading: row.heading, anchor: row.anchor, text: row.text,
        createdAt: row.created_at, audience: row.audience, outcome: row.outcome ? JSON.parse(row.outcome) : null,
        scores: { similarity: similarity.get(row.chunk_id) ?? null, lexical: lexical.get(row.chunk_id) ?? null, fused: score },
        rank: 0,
      });
    }
  }
  const results = Array.from(best.values()).sort((a, b) => b.scores.fused - a.scores.fused).slice(0, k)
    .map((r, i) => ({ ...r, rank: i + 1 }));
  const bestSimilarity = dense.length ? cosineFromL2(dense[0].distance) : 0;
  return Object.assign(results, { bestSimilarity });
}
