import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeIndex } from '../../src/store/writer.js';
import { openDatabase } from '../../src/store/db.js';
import { retrieve } from '../../src/retrieval/retrieve.js';

const tmp = mkdtempSync(join(tmpdir(), 'kb-retrieve-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

/** Vectors by keyword so tests control similarity: widget (or a punctuation-only question) -> e1, notification -> e2, else e3. */
const vectorFor = (text) => {
  const t = text.toLowerCase();
  if (t.includes('widget') || t.startsWith('??')) return Float32Array.from([1, 0, 0, 0]);
  if (t.includes('notification')) return Float32Array.from([0, 1, 0, 0]);
  return Float32Array.from([0, 0, 1, 0]);
};
const embedder = { modelKey: 'fake@1@q8@cls', dimensions: 4, async embed(texts) { return texts.map(vectorFor); } };

const item = (sourceId, source, title, text, createdAt, extra = {}) => ({
  source, provider: 'github', origin: 'o/r', sourceId, url: `https://x/${source}/${sourceId}`, title, audience: 'user',
  createdAt, updatedAt: null, outcome: source === 'issue' ? { state: 'closed' } : null, extra: null,
  chunks: [{ seq: 0, kind: source === 'docs' ? 'section' : 'body', heading: extra.heading ?? null, anchor: null, text, logs: extra.logs ?? null, createdAt, authorRole: source === 'issue' ? 'reporter' : null }],
});

const indexPath = join(tmp, 'knowledge.sqlite');
test.before(async () => {
  async function* items() {
    yield item('1', 'issue', 'Widget stops after reboot', 'Widget stops after reboot', '2025-03-01T00:00:00Z', { logs: 'E/EntityWidget: refresh failed' });
    yield item('2', 'issue', 'Notification sound missing', 'Notification sound missing', '2025-04-01T00:00:00Z');
    yield item('3', 'issue', 'Old widget bug', 'Widget stops on old phones', '2021-01-01T00:00:00Z');
    yield item('widgets', 'docs', 'Android Widgets', 'Widgets refresh on tap', '1970-01-01T00:00:00Z', { heading: 'Refresh' });
    yield item('4', 'issue', 'Future widget issue', 'Widget stops updating', '2026-01-01T00:00:00Z');
  }
  await writeIndex({ items: items(), embedder, outPath: indexPath, meta: {} });
});

test('ranks dense and lexical matches and reports scores', async () => {
  const db = openDatabase(indexPath, { readOnly: true });
  const results = await retrieve(db, embedder, 'widget stops updating', { k: 5, minSimilarity: 0.3, now: new Date('2026-10-15T00:00:00Z') });
  db.close();
  assert.ok(results.length >= 3);
  assert.ok(results.every((r) => r.source !== 'issue' || r.sourceId !== '2'));
  assert.equal(results[0].rank, 1);
  assert.ok(results[0].scores.similarity > 0.9);
  assert.ok(results.bestSimilarity > 0.9);
  const widget = results.find((r) => r.sourceId === '1');
  assert.deepEqual(widget.outcome, { state: 'closed' });
  assert.equal(widget.authorRole, 'reporter');
  assert.equal(results.find((r) => r.source === 'docs').authorRole, null);
});

test('finds an error string through the logs column', async () => {
  const db = openDatabase(indexPath, { readOnly: true });
  const results = await retrieve(db, embedder, 'E/EntityWidget', { k: 3, minSimilarity: 0.3 });
  db.close();
  assert.equal(results[0].sourceId, '1');
  assert.ok(results[0].scores.lexical !== null);
});

test('as-of filter hides later items and the excluded item', async () => {
  const db = openDatabase(indexPath, { readOnly: true });
  const results = await retrieve(db, embedder, 'widget stops', { k: 10, asOf: '2025-06-01T00:00:00Z', excludeItemId: 1 });
  db.close();
  const ids = results.map((r) => r.sourceId);
  assert.ok(!ids.includes('4'), 'later item hidden');
  assert.ok(!ids.includes('1'), 'excluded item hidden');
  assert.ok(ids.includes('widgets'), 'docs always eligible');
});

test('date decay lowers an old issue below a recent equivalent, never docs', async () => {
  const db = openDatabase(indexPath, { readOnly: true });
  const results = await retrieve(db, embedder, 'widget stops', { k: 10, now: new Date('2026-10-15T00:00:00Z') });
  db.close();
  const pos = (id) => results.findIndex((r) => r.sourceId === id);
  assert.ok(pos('1') < pos('3'), 'recent before old');
});

test('question without indexable tokens still returns dense results', async () => {
  const db = openDatabase(indexPath, { readOnly: true });
  const results = await retrieve(db, embedder, '?? !!', { k: 3 });
  db.close();
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.scores.lexical === null));
});

test('source weights change the order', async () => {
  const db = openDatabase(indexPath, { readOnly: true });
  const plain = await retrieve(db, embedder, 'widget', { k: 10 });
  const docsFirst = await retrieve(db, embedder, 'widget', { k: 10, sourceWeights: { docs: 3, issue: 0.2 } });
  db.close();
  assert.notEqual(plain[0].sourceId, docsFirst[0].sourceId);
  assert.equal(docsFirst[0].source, 'docs');
});

test('bestSimilarity reports the real best hit even when the floor filters every dense candidate', async () => {
  const db = openDatabase(indexPath, { readOnly: true });
  const results = await retrieve(db, embedder, 'widget', { k: 10, minSimilarity: 1.1 });
  db.close();
  assert.ok(results.bestSimilarity > 0.9);
  assert.ok(results.every((r) => r.scores.similarity === null), 'dense side contributed nothing');
});

test('the floor is off by default', async () => {
  const db = openDatabase(indexPath, { readOnly: true });
  const results = await retrieve(db, embedder, 'widget stops updating', { k: 10 });
  db.close();
  assert.ok(results.some((r) => r.sourceId === '2'), 'an orthogonal item is still a candidate without a floor');
});
