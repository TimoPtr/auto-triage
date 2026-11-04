import { createHash } from 'node:crypto';
import { existsSync, renameSync, rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { throttle } from '../log/progress.ts';
import { openDatabase, createSchema, readMeta, SCHEMA_VERSION } from './db.ts';
import { quantizeInt8, toBlob } from './vectors.ts';
import type { Embedder } from '../embed/embedder.ts';
import { isRemoval, type IndexChunk, type IndexItem, type ProviderItem } from '../providers/types.ts';
import type { VectorCheckpoint } from './raw.ts';

const EMBED_BATCH = 256;

export interface WriteStats {
  items: number;
  chunks: number;
  embedded: number;
  reused: number;
}

export interface WriteIndexInput {
  items: AsyncIterable<ProviderItem>;
  embedder: Embedder;
  outPath: string;
  previousPath?: string;
  /**
   * Where newly embedded vectors are kept as the build runs and read back when
   * neither the previous index nor this build has them: a build killed on its
   * time budget then resumes with its embedding work intact.
   */
  checkpoint?: VectorCheckpoint;
  meta?: Record<string, string>;
  log?: (line: string) => void;
  /** Clock for the once-a-minute embedding progress line. */
  now?: () => number;
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

/** Why a previous index cannot lend its vectors, or null when it can. */
function reuseBlocker(meta: Record<string, string>, embedder: Embedder): string | null {
  const reasons = [
    meta.schema_version !== String(SCHEMA_VERSION) ? `schema ${meta.schema_version}` : null,
    meta.dimensions !== String(embedder.dimensions) ? `dimensions ${meta.dimensions}` : null,
    meta.model_key !== embedder.modelKey ? `model ${meta.model_key}` : null,
  ].filter(Boolean);
  return reasons.length ? reasons.join(', ') : null;
}

/**
 * Loads hash -> vector blob from a previous index. A previous index that cannot
 * be opened or was built with another schema, dimension or model lends nothing
 * and is logged: the build then embeds everything instead of failing.
 */
function loadPreviousVectors(previousPath: string | undefined, embedder: Embedder, log: (line: string) => void): Map<string, Uint8Array> {
  const vectors = new Map<string, Uint8Array>();
  if (!previousPath || !existsSync(previousPath)) return vectors;
  let db: DatabaseSync;
  try {
    db = openDatabase(previousPath, { readOnly: true });
  } catch (error) {
    log(`previous index unusable (${error instanceof Error ? error.message : String(error)}); embedding everything`);
    return vectors;
  }
  try {
    const blocker = reuseBlocker(readMeta(db), embedder);
    if (blocker) {
      log(`previous index not reused (${blocker}); embedding everything`);
      return vectors;
    }
    const rows = db.prepare('SELECT c.hash, v.embedding FROM chunks c JOIN vec_chunks v ON v.chunk_id = c.id').all() as { hash: string; embedding: Uint8Array }[];
    for (const row of rows) vectors.set(row.hash, row.embedding);
  } catch (error) {
    log(`previous index unusable (${error instanceof Error ? error.message : String(error)}); embedding everything`);
    vectors.clear();
  } finally {
    db.close();
  }
  return vectors;
}

export function statements(db: DatabaseSync) {
  return {
    item: db.prepare(`INSERT INTO items (source, provider, origin, source_id, url, title, audience, created_at, updated_at, outcome, extra)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    chunk: db.prepare(`INSERT INTO chunks (item_id, seq, kind, heading, anchor, text, logs, author_role, created_at, hash)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    vector: db.prepare('INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, vec_int8(?))'),
    meta: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
  };
}

export type Statements = ReturnType<typeof statements>;

export function insertItem(stmt: Statements, item: IndexItem): number | bigint {
  return stmt.item.run(item.source, item.provider, item.origin, item.sourceId, item.url, item.title, item.audience,
    item.createdAt, item.updatedAt ?? null, item.outcome ? JSON.stringify(item.outcome) : null,
    item.extra ? JSON.stringify(item.extra) : null).lastInsertRowid;
}

export function insertChunk(stmt: Statements, itemId: number | bigint, chunk: IndexChunk, hash: string): bigint {
  return BigInt(stmt.chunk.run(itemId, chunk.seq, chunk.kind, chunk.heading ?? null, chunk.anchor ?? null,
    chunk.text, chunk.logs ?? null, chunk.authorRole ?? null, chunk.createdAt, hash).lastInsertRowid);
}

/**
 * Builds a new index file from a stream of items. Writes to `<outPath>.tmp` and
 * renames on success, so a failure never destroys the previous index.
 */
export async function writeIndex({ items, embedder, outPath, previousPath, checkpoint, meta = {}, log = () => {}, now = () => performance.now() }: WriteIndexInput): Promise<WriteStats> {
  const tick = throttle(undefined, now);
  const tmpPath = `${outPath}.tmp`;
  rmSync(tmpPath, { force: true });
  const previous = loadPreviousVectors(previousPath, embedder, log);
  const db = openDatabase(tmpPath);
  const stats: WriteStats = { items: 0, chunks: 0, embedded: 0, reused: 0 };
  let checkpointed = 0;
  const hashes = new Set<string>();
  let pending: { chunkId: bigint; hash: string; text: string }[] = [];
  let stmt: Statements;

  const embedPending = async () => {
    const vectors = await embedder.embed(pending.map((p) => p.text));
    const blobs = vectors.map((v) => toBlob(quantizeInt8(v)));
    checkpoint?.putVectors(embedder.modelKey, pending.map((p, i) => ({ hash: p.hash, embedding: blobs[i] })));
    return blobs;
  };
  const flush = async () => {
    if (pending.length === 0) return;
    const blobs = await embedPending();
    db.exec('BEGIN');
    pending.forEach((p, i) => stmt.vector.run(p.chunkId, blobs[i]));
    db.exec('COMMIT');
    stats.embedded += pending.length;
    pending = [];
  };

  try {
    createSchema(db, { dimensions: embedder.dimensions });
    stmt = statements(db);
    for await (const item of items) {
      if (isRemoval(item)) continue;
      db.exec('BEGIN');
      const itemId = insertItem(stmt, item);
      stats.items += 1;
      for (const chunk of item.chunks) {
        if (!chunk.text.trim()) continue;
        const hash = chunkHash(chunk);
        const chunkId = insertChunk(stmt, itemId, chunk, hash);
        stats.chunks += 1;
        if (checkpoint) hashes.add(hash);
        const known = previous.get(hash);
        const saved = known ?? checkpoint?.vector(embedder.modelKey, hash) ?? null;
        if (saved) {
          stmt.vector.run(chunkId, saved);
          stats.reused += 1;
          if (!known) checkpointed += 1;
        } else {
          pending.push({ chunkId, hash, text: chunk.text });
        }
      }
      db.exec('COMMIT');
      if (pending.length >= EMBED_BATCH) await flush();
      tick(() => log(`embedding: ${stats.embedded} chunks embedded, ${stats.reused} reused so far`));
    }
    await flush();
    db.exec(`INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')`);
    const finalMeta = { ...meta, model_key: embedder.modelKey, built_at: new Date().toISOString(), item_count: String(stats.items), chunk_count: String(stats.chunks) };
    for (const [key, value] of Object.entries(finalMeta)) stmt.meta.run(key, value);
    db.exec('VACUUM');
    db.close();
    renameSync(tmpPath, outPath);
    log(`index written: ${stats.items} items, ${stats.chunks} chunks, ${stats.embedded} embedded, ${stats.reused} reused${checkpointed ? ` (${checkpointed} from the checkpoint)` : ''}`);
    // The index now holds every vector; the checkpoint keeps only what a later full build could still reuse.
    if (checkpoint) {
      const pruned = checkpoint.pruneVectors(embedder.modelKey, hashes);
      if (pruned) log(`checkpoint: ${pruned} stale vectors dropped`);
    }
    return stats;
  } catch (error) {
    try { db.close(); } catch { /* already closed */ }
    rmSync(tmpPath, { force: true });
    // A provider that gave up (the rate limit, a dead socket) ends the build here; the chunks waiting for
    // a batch are embedded into the checkpoint first, so the next run starts where this one stopped.
    if (checkpoint && pending.length) {
      try { await embedPending(); } catch { /* the original error is the one to report */ }
    }
    throw error;
  }
}
