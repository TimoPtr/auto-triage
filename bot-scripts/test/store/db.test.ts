import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, createSchema, SCHEMA_VERSION } from '../../src/store/db.ts';
import { toBlob } from '../../src/store/vectors.ts';

const tmp = mkdtempSync(join(tmpdir(), 'kb-db-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

test('creates the schema, stores chunks, vectors and FTS rows, then reads them back read-only', () => {
  const path = join(tmp, 'knowledge.sqlite');
  const db = openDatabase(path);
  createSchema(db, { dimensions: 4 });

  db.prepare(`INSERT INTO items (id, source, provider, origin, source_id, url, title, audience, created_at)
              VALUES (1, 'issue', 'github', 'o/r', '1', 'https://x/1', 'Widget stops', 'user', '2025-01-01T00:00:00Z')`).run();
  db.prepare(`INSERT INTO chunks (id, item_id, seq, kind, text, created_at, hash)
              VALUES (1, 1, 0, 'body', 'binary_sensor.motion_detected stops updating after reboot', '2025-01-01T00:00:00Z', 'h1')`).run();
  db.prepare(`INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, vec_int8(?))`)
    .run(1n, toBlob(Int8Array.from([127, 0, 0, 0])));
  db.exec(`INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')`);
  db.close();

  const ro = openDatabase(path, { readOnly: true });
  const fts = ro.prepare(`SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?`).all('"binary_sensor.motion_detected"');
  assert.deepEqual(fts.map((r) => r.rowid), [1]);

  const knn = ro.prepare(`SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH vec_int8(?) AND k = ?`)
    .all(toBlob(Int8Array.from([120, 10, 0, 0])), 1n);
  assert.equal(knn[0].chunk_id, 1);

  assert.equal(ro.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get().value, String(SCHEMA_VERSION));
  assert.throws(() => ro.exec(`INSERT INTO meta VALUES ('x', 'y')`), /readonly/);
  ro.close();
});
