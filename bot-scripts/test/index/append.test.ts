import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config/load.ts';
import { writeIndex } from '../../src/store/writer.ts';
import { openDatabase } from '../../src/store/db.ts';
import { appendItem, parseItemRef } from '../../src/index/append.ts';
import type { IndexItem } from '../../src/providers/types.ts';
import type { Config } from '../../src/config/types.ts';

const tmp = mkdtempSync(join(tmpdir(), 'kb-append-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));
const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));
const issues = JSON.parse(readFileSync(join(fixtures, 'github/issues-page.json'), 'utf8'));
const pulls = JSON.parse(readFileSync(join(fixtures, 'github/pulls-page.json'), 'utf8'));
const config = loadConfig(join(fixtures, 'config/android.yaml'));
const repo = 'home-assistant/android';
const embedder = { modelKey: 'fake@1@q8@cls', dimensions: 4, async embed(t) { return t.map(() => Float32Array.from([1, 0, 0, 0])); } };
const client = {
  async getJson(path) { const n = Number(path.split('/').pop()); return path.includes('/pulls/') ? pulls.find((p) => p.number === n) : issues.find((i) => i.number === n); },
  async *paginate() { yield* []; },
};
const seed: IndexItem = { source: 'issue', provider: 'github', origin: repo, sourceId: '12', url: 'https://x/12', title: 'Old title', audience: 'user', createdAt: '2025-03-01T00:00:00Z', updatedAt: null, outcome: null, extra: null, chunks: [{ seq: 0, kind: 'body', text: 'old text', logs: null, createdAt: '2025-03-01T00:00:00Z' }] };
async function freshIndex(name: string) { const path = join(tmp, name); async function* items() { yield seed; } await writeIndex({ items: items(), embedder, outPath: path, meta: {} }); return path; }
function titleOf(path: string, sourceId: string) { const db = openDatabase(path, { readOnly: true }); const row = db.prepare('SELECT title FROM items WHERE source_id = ?').get(sourceId); db.close(); return row?.title ?? null; }

test('parseItemRef accepts issue and pull references', () => {
  assert.deepEqual(parseItemRef('issue:12'), { kind: 'issue', number: 12 });
  assert.deepEqual(parseItemRef('pull:40'), { kind: 'pull', number: 40 });
  assert.throws(() => parseItemRef('discussion:1'), /issue:<n> or pull:<n>/);
  assert.throws(() => parseItemRef('issue:x'), /issue:<n> or pull:<n>/);
});

test('upserts a closed issue, replacing the stale copy', async () => {
  const indexPath = await freshIndex('upsert.sqlite');
  const result = await appendItem({ config, repo, ref: { kind: 'issue', number: 12 }, indexPath, embedder, client });
  assert.equal(result.action, 'upserted');
  assert.equal(titleOf(indexPath, '12'), issues.find((i) => i.number === 12).title);
});

test('upserts a merged pull request', async () => {
  const indexPath = await freshIndex('pull.sqlite');
  const result = await appendItem({ config, repo, ref: { kind: 'pull', number: 40 }, indexPath, embedder, client });
  assert.equal(result.action, 'upserted');
  assert.equal(titleOf(indexPath, '40'), 'Re-register widgets after boot');
});

test('removes an item the config no longer wants', async () => {
  const indexPath = await freshIndex('remove.sqlite');
  const onlyOpen = { ...config, providers: { ...config.providers, github: { ...config.providers.github, [repo]: { ...config.providers.github[repo], issues: { states: ['open'], comments: true } } } } } as Config;
  const result = await appendItem({ config: onlyOpen, repo, ref: { kind: 'issue', number: 12 }, indexPath, embedder, client });
  assert.equal(result.action, 'removed');
  assert.equal(titleOf(indexPath, '12'), null);
});

test('skips a repository or kind the config does not index', async () => {
  const indexPath = await freshIndex('skip.sqlite');
  const result = await appendItem({ config, repo: 'o/other', ref: { kind: 'issue', number: 12 }, indexPath, embedder, client });
  assert.equal(result.action, 'skipped');
  assert.match(result.reason, /o\/other/);
});
