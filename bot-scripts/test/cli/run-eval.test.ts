import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = mkdtempSync(join(tmpdir(), 'kb-run-eval-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));
const cli = fileURLToPath(new URL('../../src/cli/run-eval.ts', import.meta.url));
const config = fileURLToPath(new URL('../fixtures/config/android.yaml', import.meta.url));

test('exits 0 with a message when no cases are configured', () => {
  const result = spawnSync(process.execPath, [cli, '--config', config, '--index', join(tmp, 'never-opened.sqlite')], { cwd: tmp, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no eval cases configured/);
  assert.equal(existsSync(join(tmp, 'eval-out')), false);
});
