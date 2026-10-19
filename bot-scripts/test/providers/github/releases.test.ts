import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readReleases } from '../../../src/providers/github/releases.ts';
import { openRawStore } from '../../../src/store/raw.ts';

const tmp = mkdtempSync(join(tmpdir(), 'kb-releases-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const page = [
  { tag_name: '2026.8.4', name: '', draft: false, prerelease: false, published_at: '2026-08-31T09:42:13Z', html_url: 'https://github.com/o/r/releases/tag/2026.8.4', body: '## Highlights of this release\n* Added an **assistant volume** sensor\n\n## What\'s Changed\n* Bump foo by @renovate in https://github.com/o/r/pull/1' },
  { tag_name: '2026.10.1', name: null, draft: false, prerelease: true, published_at: '2026-10-06T13:38:43Z', html_url: 'https://github.com/o/r/releases/tag/2026.10.1', body: 'beta' },
  { tag_name: 'draft', name: null, draft: true, prerelease: false, published_at: null, html_url: 'https://github.com/o/r/releases/tag/draft', body: 'x' },
  { tag_name: '2022.1.0', name: 'Old', draft: false, prerelease: false, published_at: '2022-01-10T00:00:00Z', html_url: 'https://github.com/o/r/releases/tag/2022.1.0', body: 'Old notes' },
];
const client = { async *paginate(path) { if (path === '/repos/o/r/releases') yield* page; } };
async function collect(options, raw = undefined) { const out = []; for await (const i of readReleases({ client, repo: 'o/r', options, now: new Date('2026-10-15T00:00:00Z'), raw })) out.push(i); return out; }

test('indexes stable releases with sections and skips drafts and prereleases by default', async () => {
  const items = await collect({ includePrereleases: false });
  assert.deepEqual(items.map((i) => i.sourceId), ['2026.8.4', '2022.1.0']);
  const r = items[0];
  assert.equal(r.source, 'release');
  assert.equal(r.createdAt, '2026-08-31T09:42:13Z');
  assert.ok(r.chunks[0].text.startsWith('2026.8.4\n'));
  assert.equal(r.chunks[0].heading, 'Highlights of this release');
  assert.equal(r.chunks[1].anchor, 'whats-changed');
});

test('includes prereleases when asked and applies the window', async () => {
  const items = await collect({ includePrereleases: true, withinDays: 90 });
  assert.deepEqual(items.map((i) => i.sourceId), ['2026.8.4', '2026.10.1']);
});

test('records releases in the raw store', async () => {
  const raw = openRawStore(join(tmp, 'raw.sqlite'));
  await collect({ includePrereleases: false }, raw);
  const record = raw.get<any>('github', 'o/r', 'release', '2026.8.4');
  assert.equal(record.updatedAt, '2026-08-31T09:42:13Z');
  assert.ok(record.payload.body.includes('assistant volume'));
  raw.close();
});
