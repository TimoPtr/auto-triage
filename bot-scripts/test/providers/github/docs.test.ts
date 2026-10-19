import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readDocs, DOCS_EPOCH } from '../../../src/providers/github/docs.ts';
import type { DocsConfig } from '../../../src/config/types.ts';

const checkout = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const options: DocsConfig = { path: 'docs', baseUrl: 'https://example.test/docs/', audience: 'developer' };

async function collect() {
  const out = [];
  for await (const item of readDocs({ repo: 'o/docs', checkoutPath: checkout, options })) out.push(item);
  return out.sort((a, b) => a.url.localeCompare(b.url));
}

test('derives URLs from id, directory index and absolute slug', async () => {
  const urls = (await collect()).map((i) => i.url);
  assert.deepEqual(urls, [
    'https://example.test/docs/android',
    'https://example.test/docs/android-widgets',
    'https://example.test/docs/evil',
    'https://example.test/tools/debugging',
  ]);
});

test('absolute slug overrides path', async () => {
  const debug = (await collect()).find((i) => i.title === 'Android debug tools');
  assert.equal(debug.url, 'https://example.test/tools/debugging');
  assert.equal(debug.sourceId, 'docs/android/debugging.md');
});

test('chunks sections with anchors, title, audience and the docs epoch', async () => {
  const widgets = (await collect()).find((i) => i.sourceId === 'docs/widgets.md');
  assert.equal(widgets.source, 'docs');
  assert.equal(widgets.audience, 'developer');
  assert.equal(widgets.createdAt, DOCS_EPOCH);
  assert.equal(widgets.chunks.length, 2);
  assert.equal(widgets.chunks[1].anchor, 'available-widgets');
  assert.equal(widgets.chunks[1].heading, 'Available widgets');
  assert.equal(widgets.chunks[1].kind, 'section');
  assert.equal(widgets.extra.description, null);
});

test('skips drafts', async () => {
  assert.ok((await collect()).every((i) => i.title !== 'Legal'));
});

test('fails clearly when the checkout path is missing', async () => {
  await assert.rejects(async () => {
    for await (const _ of readDocs({ repo: 'o/docs', checkoutPath: '/nonexistent', options })) { /* drain */ }
  }, /checkout.*o\/docs/);
});

test('prefixes the title and description into the first chunk only', async () => {
  const debug = (await collect()).find((i) => i.title === 'Android debug tools');
  assert.ok(debug.chunks[0].text.startsWith('Android debug tools\nThe developer playground and LeakCanary in debug builds.\n'));
  const widgets = (await collect()).find((i) => i.sourceId === 'docs/widgets.md');
  assert.ok(widgets.chunks[0].text.startsWith('Android Widgets\n'));
  assert.ok(!widgets.chunks[1].text.startsWith('Android Widgets\n'));
});

test('rejects a protocol-relative slug', async () => {
  const evil = (await collect()).find((i) => i.title === 'Evil');
  assert.equal(evil.url, 'https://example.test/docs/evil');
});

test('skips symbolic links', async () => {
  const { symlinkSync, rmSync, existsSync } = await import('node:fs');
  const link = join(checkout, 'docs', 'linked.md');
  if (existsSync(link)) rmSync(link);
  symlinkSync(join(checkout, 'docs', 'widgets.md'), link);
  try {
    const items = await collect();
    assert.ok(items.every((i) => i.sourceId !== 'docs/linked.md'));
  } finally {
    rmSync(link);
  }
});
