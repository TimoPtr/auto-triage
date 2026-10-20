import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('the triage template restores the feedback file under the path the nightly build saves', () => {
  const build = read('../../../.github/workflows/build-index.yml');
  const template = read('../../../workflows/triage.md');
  const saved = /actions\/cache\/save[\s\S]*?path: (\S*feedback\S*)/.exec(build)?.[1];
  const restored = /actions\/cache\/restore[\s\S]*?path: (\S*feedback\S*)/.exec(template)?.[1];
  const passed = /--feedback (\S+)/.exec(template)?.[1];
  assert.ok(saved, 'build saves a feedback path');
  assert.equal(restored, saved);
  assert.equal(passed, saved);
  const savedKey = /key: \$\{\{ inputs\.slug \}\}-feedback-v(\d+)-/.exec(build)?.[1];
  const restoredKey = /\$\{\{ steps\.config\.outputs\.slug \}\}-feedback-v(\d+)-\n/.exec(template)?.[1];
  assert.equal(restoredKey, savedKey);
});
