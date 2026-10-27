import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeIndex, chunkHash } from '../../src/store/writer.ts';
import { openDatabase, readMeta } from '../../src/store/db.ts';
import type { IndexChunk, IndexItem, Removal } from '../../src/providers/types.ts';

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

function item(sourceId: string, text: string, extraChunks: IndexChunk[] = []): IndexItem {
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
  const withDate = { kind: 'body' as const, heading: null, text: 'x', logs: null, createdAt: 'ignored' };
  assert.equal(a, chunkHash(withDate));
  assert.notEqual(a, chunkHash({ kind: 'comment', heading: null, text: 'x', logs: null }));
  assert.notEqual(a, chunkHash({ kind: 'body', heading: null, text: 'y', logs: null }));
});

test('ignores a previous index with another dimension and logs it', async () => {
  const previous = join(tmp, 'prev-dim.sqlite');
  await writeIndex({ items: of(item('1', 'widget stops')), embedder: { ...fakeEmbedder(), dimensions: 8, async embed(t) { return t.map(() => new Float32Array(8)); } }, outPath: previous, meta: {} });
  const lines = [];
  const stats = await writeIndex({ items: of(item('1', 'widget stops')), embedder: fakeEmbedder(), outPath: join(tmp, 'f.sqlite'), previousPath: previous, meta: {}, log: (l) => lines.push(l) });
  assert.equal(stats.reused, 0);
  assert.ok(lines.some((l) => /previous index/.test(l)));
});

test('ignores an unreadable previous index', async () => {
  const bogus = join(tmp, 'bogus.sqlite');
  (await import('node:fs')).writeFileSync(bogus, 'not a database');
  const stats = await writeIndex({ items: of(item('1', 'widget stops')), embedder: fakeEmbedder(), outPath: join(tmp, 'g.sqlite'), previousPath: bogus, meta: {} });
  assert.equal(stats.reused, 0);
});

test('a full build skips removals in the stream', async () => {
  const path = join(tmp, 'removals.sqlite');
  const removal: Removal = { remove: true, provider: 'github', origin: 'o/r', source: 'issue', sourceId: '1' };
  async function* items() { yield item('1', 'a'); yield removal; yield item('2', 'b'); }
  const stats = await writeIndex({ items: items(), embedder: fakeEmbedder(), outPath: path, meta: {} });
  assert.equal(stats.items, 2);
});

test('logs the embedding progress at most once per minute', async () => {
  let clock = 0;
  const lines: string[] = [];
  async function* many() { for (let i = 0; i < 70; i += 1) { clock += 1_000; yield item(String(i), `text ${i}`); } }
  await writeIndex({ items: many(), embedder: fakeEmbedder(), outPath: join(tmp, 'progress.sqlite'), meta: {}, log: (l) => lines.push(l), now: () => clock });
  const progress = lines.filter((l) => l.startsWith('embedding:'));
  assert.equal(progress.length, 1, lines.join('\n'));
  assert.match(progress[0], /^embedding: \d+ chunks embedded, 0 reused so far$/);
  assert.match(lines.at(-1), /^index written: 70 items/);
});
