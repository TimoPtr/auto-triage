import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, readMeta } from './db.ts';
import { chunkHash, statements, insertItem, insertChunk, type Statements, type WriteStats } from './writer.ts';
import { quantizeInt8, toBlob } from './vectors.ts';
import type { Embedder } from '../embed/embedder.ts';
import type { IndexChunk, IndexItem } from '../providers/types.ts';

export interface ItemRef { provider: string; origin: string; source: string; sourceId: string }

const FIND_ITEM = 'SELECT id FROM items WHERE provider = ? AND origin = ? AND source = ? AND source_id = ?';

type ItemId = number | bigint;

function findItem(db: DatabaseSync, ref: ItemRef): ItemId | undefined {
  const row = db.prepare(FIND_ITEM).get(ref.provider, ref.origin, ref.source, ref.sourceId) as { id: ItemId } | undefined;
  return row?.id;
}

/** Vectors of an item's current chunks by hash, read before anything is deleted. */
function vectorsOf(db: DatabaseSync, itemId: ItemId): Map<string, Uint8Array> {
  const rows = db.prepare('SELECT c.hash, v.embedding FROM chunks c JOIN vec_chunks v ON v.chunk_id = c.id WHERE c.item_id = ?').all(itemId) as { hash: string; embedding: Uint8Array }[];
  return new Map(rows.map((row) => [row.hash, row.embedding]));
}

/** Removes an item's rows: vectors first, then chunks, then the item. Runs inside the caller's transaction. */
function deleteRows(db: DatabaseSync, itemId: ItemId): void {
  db.prepare('DELETE FROM vec_chunks WHERE chunk_id IN (SELECT id FROM chunks WHERE item_id = ?)').run(itemId);
  db.prepare('DELETE FROM chunks WHERE item_id = ?').run(itemId);
  db.prepare('DELETE FROM items WHERE id = ?').run(itemId);
}

/** Rebuilds the FTS index and the counts after rows changed. */
export function finish(db: DatabaseSync): void {
  db.exec(`INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')`);
  const count = (sql: string) => String((db.prepare(sql).get() as { n: number }).n);
  const meta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  meta.run('item_count', count('SELECT count(*) n FROM items'));
  meta.run('chunk_count', count('SELECT count(*) n FROM chunks'));
  meta.run('appended_at', new Date().toISOString());
}

function transaction(db: DatabaseSync, body: () => void): void {
  db.exec('BEGIN');
  try {
    body();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** The non-empty chunks of an item with the vectors they need: reused by hash or freshly embedded. */
async function prepareChunks(item: IndexItem, known: Map<string, Uint8Array>, embedder: Embedder): Promise<{ chunk: IndexChunk; hash: string; vector: Uint8Array; reused: boolean }[]> {
  const chunks = item.chunks.filter((c) => c.text.trim()).map((chunk) => ({ chunk, hash: chunkHash(chunk) }));
  const missing = chunks.filter((c) => !known.has(c.hash));
  const vectors = missing.length ? await embedder.embed(missing.map((c) => c.chunk.text)) : [];
  const embedded = new Map(missing.map((c, i) => [c.hash, toBlob(quantizeInt8(vectors[i]))]));
  return chunks.map(({ chunk, hash }) => {
    const reused = known.get(hash);
    return { chunk, hash, vector: reused ?? embedded.get(hash)!, reused: reused !== undefined };
  });
}

/** The non-empty chunks of an item with the vectors they need, then the rows replaced in one transaction. */
export async function upsertInto(db: DatabaseSync, stmt: Statements, item: IndexItem, embedder: Embedder, stats: WriteStats, log: (line: string) => void = () => {}): Promise<void> {
  const existing = findItem(db, item);
  const prepared = await prepareChunks(item, existing === undefined ? new Map() : vectorsOf(db, existing), embedder);
  transaction(db, () => {
    if (existing !== undefined) deleteRows(db, existing);
    const itemId = insertItem(stmt, item);
    for (const { chunk, hash, vector, reused } of prepared) {
      stmt.vector.run(insertChunk(stmt, itemId, chunk, hash), vector);
      if (reused) stats.reused += 1; else stats.embedded += 1;
    }
  });
  stats.items += 1;
  stats.chunks += prepared.length;
  log(`${existing === undefined ? 'added' : 'replaced'} ${item.source} ${item.origin}#${item.sourceId}: ${prepared.length} chunks`);
}

/** Deletes one item with its chunks and vectors from an open index; true when it existed. */
export function removeFrom(db: DatabaseSync, ref: ItemRef): boolean {
  const existing = findItem(db, ref);
  if (existing === undefined) return false;
  transaction(db, () => deleteRows(db, existing));
  return true;
}

export interface SourceScope { provider: string; origin: string; source: string }

/** Deletes every item of a scope whose source id is not in `present`; returns how many went. */
export function removeAbsent(db: DatabaseSync, scope: SourceScope, present: Set<string>): number {
  const rows = db.prepare('SELECT id, source_id FROM items WHERE provider = ? AND origin = ? AND source = ?').all(scope.provider, scope.origin, scope.source) as { id: ItemId; source_id: string }[];
  const gone = rows.filter((row) => !present.has(row.source_id));
  transaction(db, () => { for (const row of gone) deleteRows(db, row.id); });
  return gone.length;
}

/** Throws when the open index was built with another model than the embedder's. */
export function assertSameModel(db: DatabaseSync, embedder: Embedder): void {
  const meta = readMeta(db);
  if (meta.model_key !== embedder.modelKey) throw new Error(`Index model ${meta.model_key} does not match ${embedder.modelKey}`);
}

export interface UpsertInput { indexPath: string; items: AsyncIterable<IndexItem>; embedder: Embedder; log?: (line: string) => void }

/**
 * Replaces or adds items in an existing index file in place, one transaction
 * per item. Embedding happens before the transaction, so a failed embed
 * leaves the old rows untouched.
 */
export async function upsertItems({ indexPath, items, embedder, log = () => {} }: UpsertInput): Promise<WriteStats> {
  const db = openDatabase(indexPath);
  const stats: WriteStats = { items: 0, chunks: 0, embedded: 0, reused: 0 };
  try {
    assertSameModel(db, embedder);
    const stmt = statements(db);
    for await (const item of items) await upsertInto(db, stmt, item, embedder, stats, log);
    finish(db);
  } finally {
    db.close();
  }
  return stats;
}

/** Deletes one item with its chunks and vectors from an index file; true when it existed. */
export function removeItem({ indexPath, ref }: { indexPath: string; ref: ItemRef }): boolean {
  const db = openDatabase(indexPath);
  try {
    const removed = removeFrom(db, ref);
    if (removed) finish(db);
    return removed;
  } finally {
    db.close();
  }
}
