import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeIndex } from '../../src/store/writer.ts';
import { upsertItems, removeItem } from '../../src/store/upsert.ts';
import { openDatabase, readMeta } from '../../src/store/db.ts';
import type { IndexItem } from '../../src/providers/types.ts';

const tmp = mkdtempSync(join(tmpdir(), 'kb-upsert-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

function fakeEmbedder(calls = []) {
  return { modelKey: 'fake@1@q8@cls', dimensions: 4, async embed(texts) { calls.push(...texts); return texts.map((t) => Float32Array.from([t.length % 2, 1, 0, 0])); } };
}
const item = (sourceId: string, texts: string[]): IndexItem => ({
  source: 'issue', provider: 'github', origin: 'o/r', sourceId, url: `https://x/${sourceId}`, title: `Issue ${sourceId}`, audience: 'user',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: null, outcome: { state: 'open' }, extra: null,
  chunks: texts.map((text, seq) => ({ seq, kind: seq === 0 ? 'body' : 'comment', text, logs: null, createdAt: '2026-01-01T00:00:00Z' })),
});
async function* of(...items: IndexItem[]) { yield* items; }
function counts(path: string) {
  const db = openDatabase(path, { readOnly: true });
  const row = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
  const out = { items: row('SELECT count(*) n FROM items'), chunks: row('SELECT count(*) n FROM chunks'), vectors: row('SELECT count(*) n FROM vec_chunks'), fts: row("SELECT count(*) n FROM chunks_fts WHERE chunks_fts MATCH 'widget'"), meta: readMeta(db) };
  db.close();
  return out;
}
const ref = { provider: 'github', origin: 'o/r', source: 'issue', sourceId: '1' };

async function fresh(name: string) {
  const path = join(tmp, name);
  await writeIndex({ items: of(item('1', ['widget stops', 'first comment']), item('2', ['notification sound'])), embedder: fakeEmbedder(), outPath: path, meta: {} });
  return path;
}

test('replaces an existing item and all of its chunks', async () => {
  const path = await fresh('replace.sqlite');
  const stats = await upsertItems({ indexPath: path, items: of(item('1', ['widget stops', 'first comment', 'fixed in #40'])), embedder: fakeEmbedder() });
  assert.equal(stats.items, 1);
  assert.equal(stats.chunks, 3);
  const c = counts(path);
  assert.equal(c.items, 2);
  assert.equal(c.chunks, 4);
  assert.equal(c.vectors, 4);
  assert.equal(c.fts, 1, 'the rebuilt FTS table still finds the widget chunk once');
  assert.equal(c.meta.item_count, '2');
  assert.equal(c.meta.chunk_count, '4');
  assert.ok(c.meta.appended_at);
});

test('reuses the vectors of unchanged chunks and embeds only new text', async () => {
  const path = await fresh('reuse.sqlite');
  const calls = [];
  const stats = await upsertItems({ indexPath: path, items: of(item('1', ['widget stops', 'first comment', 'fixed in #40'])), embedder: fakeEmbedder(calls) });
  assert.deepEqual(calls, ['fixed in #40']);
  assert.equal(stats.reused, 2);
  assert.equal(stats.embedded, 1);
});

test('adds an item that was not in the index', async () => {
  const path = await fresh('add.sqlite');
  await upsertItems({ indexPath: path, items: of(item('3', ['brand new'])), embedder: fakeEmbedder() });
  assert.equal(counts(path).items, 3);
});

test('a failed embedding leaves the old rows in place', async () => {
  const path = await fresh('failed.sqlite');
  const broken = { ...fakeEmbedder(), async embed() { throw new Error('model unavailable'); } };
  await assert.rejects(() => upsertItems({ indexPath: path, items: of(item('1', ['widget stops', 'changed'])), embedder: broken }), /model unavailable/);
  const c = counts(path);
  assert.equal(c.items, 2);
  assert.equal(c.chunks, 3);
  assert.equal(c.fts, 1);
});

test('refuses an index built with another model', async () => {
  const path = await fresh('model.sqlite');
  await assert.rejects(() => upsertItems({ indexPath: path, items: of(item('3', ['x'])), embedder: { ...fakeEmbedder(), modelKey: 'other@1@q8@cls' } }), /model/);
});

test('removeItem deletes the item, its chunks, vectors and FTS rows', async () => {
  const path = await fresh('remove.sqlite');
  assert.equal(removeItem({ indexPath: path, ref }), true);
  assert.equal(removeItem({ indexPath: path, ref }), false);
  const c = counts(path);
  assert.equal(c.items, 1);
  assert.equal(c.chunks, 1);
  assert.equal(c.vectors, 1);
  assert.equal(c.fts, 0);
  assert.equal(c.meta.item_count, '1');
});
