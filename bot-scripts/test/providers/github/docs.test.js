import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readDocs, DOCS_EPOCH } from '../../../src/providers/github/docs.js';

const checkout = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const options = { path: 'docs', baseUrl: 'https://example.test/docs/', audience: 'developer' };

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
