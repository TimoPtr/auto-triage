import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeIndex } from '../../src/store/writer.ts';
import { FORMAT_VERSION, SCHEMA_VERSION } from '../../src/store/db.ts';
import { RAW_SCHEMA_VERSION } from '../../src/store/raw.ts';
import { indexStatus, rawVersions } from '../../src/index/status.ts';
import type { Config } from '../../src/config/types.ts';
import type { IndexItem } from '../../src/providers/types.ts';

const tmp = mkdtempSync(join(tmpdir(), 'kb-status-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));
const embedder = { modelKey: 'Xenova/bge-small-en-v1.5@abc@q8@cls', dimensions: 4, async embed(t) { return t.map(() => Float32Array.from([1, 0, 0, 0])); } };
const config = { embedding: { model: 'Xenova/bge-small-en-v1.5', revision: 'abc', dtype: 'q8', dimensions: 4, pooling: 'cls' } } as Config;
const item: IndexItem = { source: 'issue', provider: 'github', origin: 'o/r', sourceId: '1', url: 'https://x/1', title: 'One', audience: 'user', createdAt: '2026-01-01T00:00:00Z', updatedAt: null, outcome: null, extra: null, chunks: [{ seq: 0, kind: 'body', text: 'one', logs: null, createdAt: '2026-01-01T00:00:00Z' }] };
const indexPath = join(tmp, 'k.sqlite');
test.before(async () => { async function* items() { yield item; } await writeIndex({ items: items(), embedder, outPath: indexPath, meta: {} }); });

test('reports a usable fresh index with its counts and age', () => {
  const s = indexStatus({ indexPath, config, now: new Date(Date.now() + 3600_000) });
  assert.equal(s.found, true);
  assert.equal(s.usable, true);
  assert.equal(s.status, 'fresh');
  assert.equal(s.items, 1);
  assert.equal(s.chunks, 1);
  assert.ok(s.ageDays !== null && s.ageDays < 1);
  assert.equal(s.formatVersion, FORMAT_VERSION);
  assert.equal(s.schemaVersion, SCHEMA_VERSION);
});

test('an index older than the freshness window is stale but usable', () => {
  const s = indexStatus({ indexPath, config, now: new Date(Date.now() + 5 * 24 * 3600_000) });
  assert.equal(s.status, 'stale');
  assert.equal(s.usable, true);
});

test('reports an index built with another model as unusable', () => {
  const other = { embedding: { ...config.embedding, revision: 'def' } } as Config;
  const s = indexStatus({ indexPath, config: other });
  assert.equal(s.found, true);
  assert.equal(s.usable, false);
  assert.equal(s.status, 'unusable');
  assert.match(s.reason, /model/);
});

test('a missing file is missing and an unreadable file is unusable', () => {
  assert.equal(indexStatus({ indexPath: join(tmp, 'nope.sqlite'), config }).status, 'missing');
  const bogus = join(tmp, 'bogus.sqlite');
  writeFileSync(bogus, 'not a database');
  const s = indexStatus({ indexPath: bogus, config });
  assert.equal(s.found, true);
  assert.equal(s.status, 'unusable');
  assert.match(s.reason, /cannot open/);
});

test('rawVersions exposes the three version numbers', () => {
  assert.deepEqual(rawVersions(), { formatVersion: FORMAT_VERSION, schemaVersion: SCHEMA_VERSION, rawSchemaVersion: RAW_SCHEMA_VERSION });
});

test('writeOutputs appends key=value lines to the output file', async () => {
  const { writeOutputs } = await import('../../src/cli/index-status.ts');
  const out = join(tmp, 'outputs.txt');
  writeOutputs({ status: 'fresh', 'age-days': 0.5, reason: null }, out);
  assert.equal(readFileSync(out, 'utf8'), 'status=fresh\nage-days=0.5\nreason=\n');
});
