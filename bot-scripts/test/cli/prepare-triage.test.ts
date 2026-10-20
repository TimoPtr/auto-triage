import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../src/cli/prepare-triage.ts', import.meta.url));
const configPath = fileURLToPath(new URL('../fixtures/config/android.yaml', import.meta.url));
const fixture = readFileSync(fileURLToPath(new URL('../fixtures/github/issue-7654.json', import.meta.url)), 'utf8');
const tmp = mkdtempSync(join(tmpdir(), 'kb-prepare-cli-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const server = createServer((req, res) => {
  if (req.url === '/repos/o/r/issues/7') { res.setHeader('content-type', 'application/json'); res.end(fixture); return; }
  res.statusCode = 404; res.end('{}');
});
let baseUrl = '';
test.before(async () => { await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`; });
test.after(() => server.close());

/** Runs the CLI asynchronously so the server in this process can answer it. */
function run(args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('stops without a usable index and records the outputs', async () => {
  const outputs = join(tmp, 'outputs.txt'); const summary = join(tmp, 'summary.md');
  const { stdout, stderr, status } = await run(['--config', configPath, '--index', join(tmp, 'none.sqlite'), '--index-status', 'missing', '--repo', 'o/r', '--issue', '7', '--out', join(tmp, 'handoff.json'), '--no-live-forum'],
    { GH_TOKEN: 't', GITHUB_API_URL: baseUrl, GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: summary });
  assert.equal(status, 0, stderr);
  assert.equal(JSON.parse(stdout).reason, 'no-usable-index');
  assert.match(readFileSync(outputs, 'utf8'), /should-continue=false\nreason=no-usable-index\nbest-similarity=0/);
  assert.match(readFileSync(summary, 'utf8'), /no-usable-index/);
  assert.ok(!existsSync(join(tmp, 'handoff.json')));
});

test('exits 2 without a token or an issue number', async () => {
  const noToken = await run(['--config', configPath, '--index', 'x', '--index-status', 'missing', '--repo', 'o/r', '--issue', '7', '--out', join(tmp, 'h.json')], { GH_TOKEN: '', GITHUB_TOKEN: '' });
  assert.equal(noToken.status, 2);
  const noIssue = await run(['--config', configPath, '--index', 'x', '--index-status', 'missing', '--repo', 'o/r', '--issue', 'abc', '--out', join(tmp, 'h.json')], { GH_TOKEN: 't' });
  assert.equal(noIssue.status, 2);
});
