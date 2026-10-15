import { createHash } from 'node:crypto';
import { existsSync, renameSync, rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, createSchema, readMeta } from './db.ts';
import { quantizeInt8, toBlob } from './vectors.ts';
import type { Embedder } from '../embed/embedder.ts';
import type { IndexChunk, IndexItem } from '../providers/types.ts';

const EMBED_BATCH = 256;

export interface WriteStats {
  items: number;
  chunks: number;
  embedded: number;
  reused: number;
}

export interface WriteIndexInput {
  items: AsyncIterable<IndexItem>;
  embedder: Embedder;
  outPath: string;
  previousPath?: string;
  meta?: Record<string, string>;
  log?: (line: string) => void;
}

/** Content hash of a chunk; vectors are reused across builds when it is unchanged. */
export function chunkHash(chunk: Pick<IndexChunk, 'kind' | 'heading' | 'text' | 'logs'>): string {
  return createHash('sha256')
    .update(chunk.kind).update('\0')
    .update(chunk.heading ?? '').update('\0')
    .update(chunk.text).update('\0')
    .update(chunk.logs ?? '')
    .digest('hex');
}

/** Loads hash -> vector blob from a previous index built with the same model. */
function loadPreviousVectors(previousPath: string | undefined, modelKey: string): Map<string, Uint8Array> {
  const vectors = new Map<string, Uint8Array>();
  if (!previousPath || !existsSync(previousPath)) return vectors;
  const db = openDatabase(previousPath, { readOnly: true });
  try {
    if (readMeta(db).model_key !== modelKey) return vectors;
    const rows = db.prepare('SELECT c.hash, v.embedding FROM chunks c JOIN vec_chunks v ON v.chunk_id = c.id').all() as { hash: string; embedding: Uint8Array }[];
    for (const row of rows) vectors.set(row.hash, row.embedding);
  } finally {
    db.close();
  }
  return vectors;
}

function statements(db: DatabaseSync) {
  return {
    item: db.prepare(`INSERT INTO items (source, provider, origin, source_id, url, title, audience, created_at, updated_at, outcome, extra)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    chunk: db.prepare(`INSERT INTO chunks (item_id, seq, kind, heading, anchor, text, logs, author_role, created_at, hash)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    vector: db.prepare('INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, vec_int8(?))'),
    meta: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
  };
}

type Statements = ReturnType<typeof statements>;

function insertItem(stmt: Statements, item: IndexItem): number | bigint {
  return stmt.item.run(item.source, item.provider, item.origin, item.sourceId, item.url, item.title, item.audience,
    item.createdAt, item.updatedAt ?? null, item.outcome ? JSON.stringify(item.outcome) : null,
    item.extra ? JSON.stringify(item.extra) : null).lastInsertRowid;
}

function insertChunk(stmt: Statements, itemId: number | bigint, chunk: IndexChunk, hash: string): bigint {
  return BigInt(stmt.chunk.run(itemId, chunk.seq, chunk.kind, chunk.heading ?? null, chunk.anchor ?? null,
    chunk.text, chunk.logs ?? null, chunk.authorRole ?? null, chunk.createdAt, hash).lastInsertRowid);
}

/**
 * Builds a new index file from a stream of items. Writes to `<outPath>.tmp` and
 * renames on success, so a failure never destroys the previous index.
 */
export async function writeIndex({ items, embedder, outPath, previousPath, meta = {}, log = () => {} }: WriteIndexInput): Promise<WriteStats> {
  const tmpPath = `${outPath}.tmp`;
  rmSync(tmpPath, { force: true });
  const previous = loadPreviousVectors(previousPath, embedder.modelKey);
  const db = openDatabase(tmpPath);
  const stats: WriteStats = { items: 0, chunks: 0, embedded: 0, reused: 0 };
  let pending: { chunkId: bigint; text: string }[] = [];
  let stmt: Statements;

  const flush = async () => {
    if (pending.length === 0) return;
    const vectors = await embedder.embed(pending.map((p) => p.text));
    db.exec('BEGIN');
    pending.forEach((p, i) => stmt.vector.run(p.chunkId, toBlob(quantizeInt8(vectors[i]))));
    db.exec('COMMIT');
    stats.embedded += pending.length;
    pending = [];
  };

  try {
    createSchema(db, { dimensions: embedder.dimensions });
    stmt = statements(db);
    for await (const item of items) {
      db.exec('BEGIN');
      const itemId = insertItem(stmt, item);
      stats.items += 1;
      for (const chunk of item.chunks) {
        if (!chunk.text.trim()) continue;
        const hash = chunkHash(chunk);
        const chunkId = insertChunk(stmt, itemId, chunk, hash);
        stats.chunks += 1;
        const known = previous.get(hash);
        if (known) {
          stmt.vector.run(chunkId, known);
          stats.reused += 1;
        } else {
          pending.push({ chunkId, text: chunk.text });
        }
      }
      db.exec('COMMIT');
      if (pending.length >= EMBED_BATCH) await flush();
    }
    await flush();
    db.exec(`INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')`);
    const finalMeta = { ...meta, model_key: embedder.modelKey, built_at: new Date().toISOString(), item_count: String(stats.items), chunk_count: String(stats.chunks) };
    for (const [key, value] of Object.entries(finalMeta)) stmt.meta.run(key, value);
    db.exec('VACUUM');
    db.close();
    renameSync(tmpPath, outPath);
    log(`index written: ${stats.items} items, ${stats.chunks} chunks, ${stats.embedded} embedded, ${stats.reused} reused`);
    return stats;
  } catch (error) {
    try { db.close(); } catch { /* already closed */ }
    rmSync(tmpPath, { force: true });
    throw error;
  }
}
