import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openRawStore } from '../../src/store/raw.ts';

const tmp = mkdtempSync(join(tmpdir(), 'kb-raw-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

test('stores a payload by key and replaces it on a second put', () => {
  const store = openRawStore(join(tmp, 'raw.sqlite'));
  store.put({ provider: 'github', origin: 'o/r', kind: 'issue', id: '1', updatedAt: '2026-01-01T00:00:00Z', payload: { issue: { number: 1 }, comments: [] } });
  store.put({ provider: 'github', origin: 'o/r', kind: 'issue', id: '1', updatedAt: '2026-01-02T00:00:00Z', payload: { issue: { number: 1, title: 'x' }, comments: [{ body: 'c' }] } });
  const record = store.get('github', 'o/r', 'issue', '1');
  assert.equal(record.updatedAt, '2026-01-02T00:00:00Z');
  assert.deepEqual(record.payload, { issue: { number: 1, title: 'x' }, comments: [{ body: 'c' }] });
  assert.equal(store.get('github', 'o/r', 'issue', '2'), null);
  assert.equal(store.count(), 1);
  store.close();
});

test('iterates one kind of one origin and survives reopening', () => {
  const path = join(tmp, 'raw2.sqlite');
  let store = openRawStore(path);
  store.put({ provider: 'github', origin: 'o/r', kind: 'issue', id: '1', updatedAt: null, payload: 1 });
  store.put({ provider: 'github', origin: 'o/r', kind: 'pull', id: '2', updatedAt: null, payload: 2 });
  store.put({ provider: 'github', origin: 'o/other', kind: 'issue', id: '3', updatedAt: null, payload: 3 });
  store.close();
  store = openRawStore(path);
  assert.deepEqual(Array.from(store.each('github', 'o/r', 'issue')).map((r) => r.payload), [1]);
  assert.equal(store.count(), 3);
  store.close();
});

test('a large payload round-trips through compression', () => {
  const store = openRawStore(join(tmp, 'raw3.sqlite'));
  const text = 'log line\n'.repeat(50_000);
  store.put({ provider: 'github', origin: 'o/r', kind: 'issue', id: '9', updatedAt: null, payload: { text } });
  assert.equal(store.get<any>('github', 'o/r', 'issue', '9').payload.text, text);
  store.close();
});

test('refuses a store written with another schema version', () => {
  const path = join(tmp, 'raw4.sqlite');
  openRawStore(path).close();
  const db = new DatabaseSync(path);
  db.exec("UPDATE meta SET value = '99' WHERE key = 'raw_schema_version'");
  db.close();
  assert.throws(() => openRawStore(path), /raw store schema 99/);
});
