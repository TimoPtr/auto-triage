import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readCode, splitDeclarations, globToRegExp } from '../../../src/providers/github/code.ts';

const checkout = fileURLToPath(new URL('../../fixtures/code/', import.meta.url));
const options = { include: ['**/*.kt'], exclude: ['**/build/**'], ref: 'main', audience: 'maintainer' as const };
async function collect() { const out = []; for await (const i of readCode({ repo: 'o/r', checkoutPath: checkout, options })) out.push(i); return out.sort((a, b) => a.sourceId.localeCompare(b.sourceId)); }

test('globToRegExp handles ** and *', () => {
  assert.ok(globToRegExp('**/*.kt').test('app/src/main/A.kt'));
  assert.ok(globToRegExp('**/*.kt').test('A.kt'));
  assert.ok(!globToRegExp('**/*.kt').test('A.kts'));
  assert.ok(globToRegExp('**/build/**').test('app/build/Generated.kt'));
  assert.ok(!globToRegExp('**/build/**').test('app/src/Build.kt'));
});

test('splitDeclarations keeps KDoc and annotations with their declaration', () => {
  const src = 'package p\n\nimport x\n\n/** Doc. */\n@Keep\nclass A {\n  fun inner() {}\n}\n\nfun top() = 1\n\nprivate const val T = "t"\n';
  const decls = splitDeclarations(src);
  assert.deepEqual(decls.map((d) => d.name), ['A', 'top', 'T']);
  assert.ok(decls[0].text.startsWith('/** Doc. */\n@Keep\nclass A'));
  assert.ok(decls[0].text.includes('fun inner()'), 'members stay inside the class chunk');
});

test('yields one item per included file with symbol chunks, path, package and string keys', async () => {
  const items = await collect();
  assert.deepEqual(items.map((i) => i.sourceId), ['app/src/main/kotlin/io/ha/widgets/EntityWidget.kt']);
  const [file] = items;
  assert.equal(file.source, 'code');
  assert.equal(file.url, 'https://github.com/o/r/blob/main/app/src/main/kotlin/io/ha/widgets/EntityWidget.kt');
  assert.equal(file.audience, 'maintainer');
  assert.deepEqual(file.chunks.map((c) => c.heading), ['EntityWidget', 'widgetLabel', 'TAG']);
  assert.ok(file.chunks[0].text.startsWith('app/src/main/kotlin/io/ha/widgets/EntityWidget.kt\npackage io.ha.widgets\n'));
  assert.ok(file.chunks[0].text.endsWith('strings: widget_entity_refresh'));
  assert.ok(file.chunks[1].text.endsWith('strings: widget_label'));
  assert.ok(file.chunks.every((c) => c.kind === 'symbol'));
});

test('yields nothing for a file without declarations', async () => {
  assert.ok((await collect()).every((i) => !i.sourceId.endsWith('OnlyImports.kt')));
});

test('a declaration that references many string keys still yields chunks within the cap', () => {
  const keys = Array.from({ length: 80 }, (_, i) => `R.string.some_rather_long_resource_name_${i}`).join(', ');
  const src = `package io.ha\n\nclass Many {\n    val all = listOf(${keys})\n}\n`;
  const decls = splitDeclarations(src);
  assert.equal(decls.length, 1);
});

test('readCode does not throw on a file whose string keys would exceed the chunk budget', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'kb-code-'));
  try {
    const keys = Array.from({ length: 80 }, (_, i) => `R.string.some_rather_long_resource_name_${i}`).join(',\n        ');
    writeFileSync(join(dir, 'Many.kt'), `package io.ha\n\nclass Many {\n    val all = listOf(\n        ${keys}\n    )\n}\n`);
    const out = [];
    for await (const i of readCode({ repo: 'o/r', checkoutPath: dir, options })) out.push(i);
    assert.equal(out.length, 1);
    assert.ok(out[0].chunks.every((c) => c.text.length <= 2000));
    assert.ok(out[0].chunks[0].text.includes('strings: some_rather_long_resource_name_0'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
