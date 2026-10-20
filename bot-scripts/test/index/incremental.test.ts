import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeIndex } from '../../src/store/writer.ts';
import { openDatabase, readMeta } from '../../src/store/db.ts';
import { incrementalBuild } from '../../src/index/incremental.ts';
import type { IndexItem, Provider, ProviderItem, SourceKind } from '../../src/providers/types.ts';

const tmp = mkdtempSync(join(tmpdir(), 'kb-incremental-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

function fakeEmbedder(calls = []) {
  return { modelKey: 'fake@1@q8@cls', dimensions: 4, async embed(texts) { calls.push(...texts); return texts.map((t) => Float32Array.from([t.length % 2, 1, 0, 0])); } };
}
const item = (source: SourceKind, sourceId: string, text: string): IndexItem => ({
  source, provider: 'github', origin: 'o/r', sourceId, url: `https://x/${source}/${sourceId}`, title: `${source} ${sourceId}`, audience: 'user',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: null, outcome: null, extra: null,
  chunks: [{ seq: 0, kind: 'body', text, logs: null, createdAt: '2026-01-01T00:00:00Z' }],
});
const provider = (name: string, ...items: ProviderItem[]): Provider => ({ name, async *items() { yield* items; } });
const since = new Date('2026-10-19T02:00:00Z');
const meta = { product: 'test', config_hash: 'abc', started_at: '2026-10-20T03:00:00Z', full_built_at: '2026-10-15T03:00:00Z' };

function rows(path: string) {
  const db = openDatabase(path, { readOnly: true });
  const items = (db.prepare('SELECT source, source_id, title FROM items ORDER BY source, source_id').all() as { source: string; source_id: string; title: string }[]).map((r) => `${r.source}:${r.source_id}:${r.title}`);
  const n = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
  const out = { items, chunks: n('SELECT count(*) n FROM chunks'), vectors: n('SELECT count(*) n FROM vec_chunks'), fts: n("SELECT count(*) n FROM chunks_fts WHERE chunks_fts MATCH 'widget'"), meta: readMeta(db) };
  db.close();
  return out;
}
async function previous(name: string) {
  const path = join(tmp, name);
  async function* items() { yield item('issue', '1', 'widget one'); yield item('issue', '2', 'two'); yield item('docs', 'a', 'page a'); yield item('docs', 'b', 'page b'); }
  await writeIndex({ items: items(), embedder: fakeEmbedder(), outPath: path, meta: { ...meta, started_at: '2026-10-19T03:00:00Z' } });
  return path;
}

test('keeps every item it did not read', async () => {
  const previousPath = await previous('keep.sqlite');
  const outPath = join(tmp, 'keep.out.sqlite');
  const stats = await incrementalBuild({ previousPath, outPath, providers: [provider('github', { ...item('issue', '1', 'widget one'), title: 'issue 1 renamed' })], since, embedder: fakeEmbedder(), meta });
  assert.equal(stats.items, 1);
  const r = rows(outPath);
  assert.deepEqual(r.items, ['docs:a:docs a', 'docs:b:docs b', 'issue:1:issue 1 renamed', 'issue:2:issue 2']);
  assert.equal(r.chunks, 4);
  assert.equal(r.vectors, 4);
  assert.equal(r.fts, 1);
  assert.equal(r.meta.item_count, '4');
  assert.ok(!existsSync(`${outPath}.tmp`));
});

test('applies removals', async () => {
  const previousPath = await previous('remove.sqlite');
  const outPath = join(tmp, 'remove.out.sqlite');
  await incrementalBuild({ previousPath, outPath, providers: [provider('github', { remove: true, provider: 'github', origin: 'o/r', source: 'issue', sourceId: '2' })], since, embedder: fakeEmbedder(), meta });
  const r = rows(outPath);
  assert.deepEqual(r.items, ['docs:a:docs a', 'docs:b:docs b', 'issue:1:issue 1']);
  assert.equal(r.chunks, 3);
  assert.equal(r.vectors, 3);
});

test('removes checkout items that vanished', async () => {
  const previousPath = await previous('vanish.sqlite');
  const outPath = join(tmp, 'vanish.out.sqlite');
  const calls = [];
  await incrementalBuild({ previousPath, outPath, providers: [provider('github', item('docs', 'a', 'page a'))], since, embedder: fakeEmbedder(calls), meta });
  const r = rows(outPath);
  assert.deepEqual(r.items, ['docs:a:docs a', 'issue:1:issue 1', 'issue:2:issue 2'], 'page b vanished, the issues were not listed and stay');
  assert.deepEqual(calls, [], 'the unchanged page reuses its vector');
});

test('a failure leaves the previous index untouched', async () => {
  const previousPath = await previous('fail.sqlite');
  const outPath = join(tmp, 'fail.out.sqlite');
  const broken = { ...fakeEmbedder(), async embed() { throw new Error('model unavailable'); } };
  await assert.rejects(() => incrementalBuild({ previousPath, outPath, providers: [provider('github', item('issue', '3', 'new'))], since, embedder: broken, meta }), /model unavailable/);
  assert.equal(rows(previousPath).items.length, 4);
  assert.ok(!existsSync(outPath) && !existsSync(`${outPath}.tmp`));
});

test('carries full_built_at and records started_at', async () => {
  const previousPath = await previous('meta.sqlite');
  const outPath = join(tmp, 'meta.out.sqlite');
  await incrementalBuild({ previousPath, outPath, providers: [], since, embedder: fakeEmbedder(), meta });
  const r = rows(outPath);
  assert.equal(r.meta.full_built_at, '2026-10-15T03:00:00Z');
  assert.equal(r.meta.started_at, '2026-10-20T03:00:00Z');
  assert.ok(r.meta.built_at > r.meta.started_at);
  assert.equal(r.meta.config_hash, 'abc');
});
