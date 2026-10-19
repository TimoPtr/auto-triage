import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readFiles, parseStrings } from '../../../src/providers/github/files.ts';

const checkout = fileURLToPath(new URL('../../fixtures/files/', import.meta.url));
async function collect(entries) { const out = []; for await (const i of readFiles({ repo: 'o/r', checkoutPath: checkout, entries, ref: 'main' })) out.push(i); return out; }

test('parseStrings decodes entities and escapes and keeps every key', () => {
  const parsed = parseStrings(readFileSync(new URL('../../fixtures/files/strings.xml', import.meta.url), 'utf8'));
  assert.deepEqual(parsed, [
    { key: 'widget_label', text: 'Widgets' },
    { key: 'widget_entity_refresh', text: 'Tap to refresh & reload' },
    { key: 'aa_launch', text: "Don't show again\nSecond line" },
    { key: 'skipped', text: 'internal' },
  ]);
});

test('a strings file becomes one item with grouped key lines', async () => {
  const [item] = await collect([{ path: 'strings.xml', kind: 'strings', audience: 'maintainer' }]);
  assert.equal(item.source, 'file');
  assert.equal(item.sourceId, 'strings.xml');
  assert.equal(item.url, 'https://github.com/o/r/blob/main/strings.xml');
  assert.equal(item.chunks.length, 1);
  assert.equal(item.chunks[0].heading, 'widget_label');
  assert.ok(item.chunks[0].text.includes('widget_entity_refresh: Tap to refresh & reload'));
});

test('a markdown directory yields one item per file chunked by heading', async () => {
  const items = await collect([{ path: 'skills', kind: 'markdown', audience: 'maintainer' }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].sourceId, 'skills/one/SKILL.md');
  assert.equal(items[0].title, 'One');
  assert.equal(items[0].chunks.at(-1).anchor, 'rule');
});

test('a missing path fails with the path in the message', async () => {
  await assert.rejects(() => collect([{ path: 'nope.xml', kind: 'strings', audience: 'maintainer' }]), /nope\.xml/);
});
