import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('the triage template restores the feedback file under the path the nightly build saves', () => {
  const build = read('../../../.github/workflows/build-index.yml');
  const template = read('../../../.github/workflows/triage.md');
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

test('the reusable workflows check this repository out through the job context', () => {
  for (const rel of ['../../../.github/workflows/build-index.yml', '../../../.github/workflows/append-on-close.yml', '../../../.github/workflows/selfcheck.yml', '../../../.github/workflows/triage.md']) {
    const text = read(rel);
    assert.ok(!text.includes('github.job_workflow'), `${rel} uses a github.job_workflow_* field, which does not exist`);
    assert.match(text, /repository: \$\{\{ job\.workflow_repository \}\}\n\s+ref: \$\{\{ job\.workflow_sha \}\}/, rel);
  }
});
