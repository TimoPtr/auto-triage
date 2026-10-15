import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown, slugifyHeading } from '../../src/text/chunk.js';

test('slugifyHeading matches GitHub anchors', () => {
  assert.equal(slugifyHeading('Available Widgets'), 'available-widgets');
  assert.equal(slugifyHeading('Entity State Widget (Android 12+)'), 'entity-state-widget-android-12');
});

test('splits on headings and records breadcrumbs and anchors', () => {
  const md = `# Widgets\n\nIntro paragraph.\n\n## Entity state\n\nShows a state.\n\n### Refresh\n\nTap to refresh.\n`;
  const chunks = chunkMarkdown(md);
  assert.deepEqual(chunks.map((c) => c.anchor), [null, 'entity-state', 'refresh']);
  assert.deepEqual(chunks[2].breadcrumbs, ['Widgets', 'Entity state', 'Refresh']);
  assert.equal(chunks[0].text, 'Intro paragraph.');
});

test('never splits inside a fenced code block', () => {
  const md = '## Config\n\n```yaml\n# not a heading\nkey: value\n```\n\nAfter.\n';
  const chunks = chunkMarkdown(md);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].text.includes('# not a heading'));
});

test('packs paragraphs up to maxChars and merges tiny trailing chunks', () => {
  const para = 'x'.repeat(900);
  const md = `## A\n\n${para}\n\n${para}\n\n${para}\n\n## B\n\nshort\n`;
  const chunks = chunkMarkdown(md, { maxChars: 2000, minChars: 300 });
  assert.equal(chunks.filter((c) => c.heading === 'A').length, 2);
  // "short" under B is below minChars and is merged into the previous chunk
  assert.equal(chunks.at(-1).text.endsWith('short'), true);
});

test('returns no chunk for an empty document', () => {
  assert.deepEqual(chunkMarkdown('\n\n'), []);
});
