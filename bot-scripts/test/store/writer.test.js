import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeIndex, chunkHash } from '../../src/store/writer.js';
import { openDatabase, readMeta } from '../../src/store/db.js';

const tmp = mkdtempSync(join(tmpdir(), 'kb-writer-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

function fakeEmbedder(modelKey = 'fake@1@q8@cls', calls = []) {
  return {
    modelKey,
    dimensions: 4,
    async embed(texts) {
      calls.push(texts);
      return texts.map((t) => Float32Array.from([t.length % 2, (t.length + 1) % 2, 0, 0]));
    },
  };
}

function item(sourceId, text, extraChunks = []) {
  return {
    source: 'issue', provider: 'github', origin: 'o/r', sourceId, url: `https://x/${sourceId}`, title: `Issue ${sourceId}`,
    audience: 'user', createdAt: '2025-01-01T00:00:00Z', updatedAt: null, outcome: { state: 'open' }, extra: null,
    chunks: [{ seq: 0, kind: 'body', text, logs: null, createdAt: '2025-01-01T00:00:00Z' }, ...extraChunks],
  };
}

async function* of(...items) { yield* items; }

test('writes items, chunks, vectors, fts and meta atomically', async () => {
  const out = join(tmp, 'a.sqlite');
  const calls = [];
  const stats = await writeIndex({ items: of(item('1', 'widget stops'), item('2', 'notification fails')), embedder: fakeEmbedder(undefined, calls), outPath: out, meta: { product: 'android', config_hash: 'c1' } });
  assert.deepEqual(stats, { items: 2, chunks: 2, embedded: 2, reused: 0 });
  assert.ok(!existsSync(`${out}.tmp`));
  const db = openDatabase(out, { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) c FROM vec_chunks').get().c, 2);
  assert.deepEqual(db.prepare(`SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH '"notification"'`).all().map((r) => r.rowid), [2]);
  const meta = readMeta(db);
  assert.equal(meta.model_key, 'fake@1@q8@cls');
  assert.equal(meta.product, 'android');
  assert.equal(meta.chunk_count, '2');
  assert.ok(meta.built_at);
  db.close();
});

test('stores the author role of a chunk', async () => {
  const out = join(tmp, 'role.sqlite');
  const withRole = item('9', 'body text', [{ seq: 1, kind: 'comment', text: 'reply', logs: null, createdAt: '2025-01-02T00:00:00Z', authorRole: 'maintainer' }]);
  withRole.chunks[0].authorRole = 'reporter';
  await writeIndex({ items: of(withRole), embedder: fakeEmbedder(), outPath: out, meta: {} });
  const db = openDatabase(out, { readOnly: true });
  const roles = db.prepare('SELECT author_role FROM chunks ORDER BY seq').all().map((r) => r.author_role);
  db.close();
  assert.deepEqual(roles, ['reporter', 'maintainer']);
});

test('reuses vectors for unchanged chunks from the previous index', async () => {
  const previous = join(tmp, 'prev.sqlite');
  await writeIndex({ items: of(item('1', 'widget stops')), embedder: fakeEmbedder(), outPath: previous, meta: {} });
  const calls = [];
  const out = join(tmp, 'b.sqlite');
  const stats = await writeIndex({ items: of(item('1', 'widget stops'), item('3', 'new text')), embedder: fakeEmbedder(undefined, calls), outPath: out, previousPath: previous, meta: {} });
  assert.deepEqual(stats, { items: 2, chunks: 2, embedded: 1, reused: 1 });
  assert.deepEqual(calls.flat(), ['new text']);
});

test('does not reuse vectors from another model', async () => {
  const previous = join(tmp, 'prev-other.sqlite');
  await writeIndex({ items: of(item('1', 'widget stops')), embedder: fakeEmbedder('other@1@q8@cls'), outPath: previous, meta: {} });
  const calls = [];
  const stats = await writeIndex({ items: of(item('1', 'widget stops')), embedder: fakeEmbedder('fake@1@q8@cls', calls), outPath: join(tmp, 'c.sqlite'), previousPath: previous, meta: {} });
  assert.equal(stats.reused, 0);
  assert.equal(calls.flat().length, 1);
});

test('skips chunks with empty text', async () => {
  const calls = [];
  const stats = await writeIndex({ items: of(item('1', '', [{ seq: 1, kind: 'comment', text: 'real', logs: null, createdAt: '2025-01-02T00:00:00Z' }])), embedder: fakeEmbedder(undefined, calls), outPath: join(tmp, 'd.sqlite'), meta: {} });
  assert.equal(stats.chunks, 1);
  assert.deepEqual(calls.flat(), ['real']);
});

test('leaves no output when a provider throws', async () => {
  const out = join(tmp, 'e.sqlite');
  async function* failing() { yield item('1', 'x'); throw new Error('provider down'); }
  await assert.rejects(() => writeIndex({ items: failing(), embedder: fakeEmbedder(), outPath: out, meta: {} }), /provider down/);
  assert.ok(!existsSync(out));
  assert.ok(!existsSync(`${out}.tmp`));
});

test('chunkHash changes with text and kind only', () => {
  const a = chunkHash({ kind: 'body', heading: null, text: 'x', logs: null });
  assert.equal(a, chunkHash({ kind: 'body', heading: null, text: 'x', logs: null, createdAt: 'ignored' }));
  assert.notEqual(a, chunkHash({ kind: 'comment', heading: null, text: 'x', logs: null }));
  assert.notEqual(a, chunkHash({ kind: 'body', heading: null, text: 'y', logs: null }));
});
