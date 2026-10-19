import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeIndex } from '../../src/store/writer.ts';
import { openDatabase } from '../../src/store/db.ts';
import { liveForumList } from '../../src/retrieval/live-forum.ts';
import type { IndexItem } from '../../src/providers/types.ts';

const tmp = mkdtempSync(join(tmpdir(), 'kb-live-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));
const embedder = { modelKey: 'fake@1@q8@cls', dimensions: 4, async embed(t) { return t.map(() => Float32Array.from([1, 0, 0, 0])); } };
const forum = (id): IndexItem => ({ source: 'forum', provider: 'discourse', origin: 'community.example', sourceId: String(id), url: `https://community.example/t/x/${id}`, title: `Topic ${id}`, audience: 'user', createdAt: '2026-01-01T00:00:00Z', updatedAt: null, outcome: null, extra: null, chunks: [{ seq: 0, kind: 'body', text: `topic ${id}`, logs: null, createdAt: '2026-01-01T00:00:00Z' }] });
const indexPath = join(tmp, 'k.sqlite');
test.before(async () => { async function* items() { yield forum(100); yield forum(101); } await writeIndex({ items: items(), embedder, outPath: indexPath, meta: {} }); });

test('maps search hits to indexed chunk ids in search order and skips unknown topics', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(String(url)); return Response.json({ topics: [{ id: 101 }, { id: 999 }, { id: 100 }] }); };
  const db = openDatabase(indexPath, { readOnly: true });
  const list = await liveForumList(db, { host: 'community.example', categorySlug: 'android-companion', question: 'widget stops', fetchImpl });
  db.close();
  assert.equal(list.weight, 0.5);
  assert.equal(list.ids.length, 2);
  assert.ok(decodeURIComponent(calls[0]).includes('widget stops #android-companion'));
});

test('a failing search yields an empty list', async () => {
  const db = openDatabase(indexPath, { readOnly: true });
  const list = await liveForumList(db, { host: 'community.example', categorySlug: 'c', question: 'x', fetchImpl: async () => { throw new Error('down'); } });
  db.close();
  assert.deepEqual(list.ids, []);
});
