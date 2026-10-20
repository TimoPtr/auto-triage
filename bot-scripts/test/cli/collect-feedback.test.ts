import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRawStore } from '../../src/store/raw.ts';

const cli = fileURLToPath(new URL('../../src/cli/collect-feedback.ts', import.meta.url));
const configPath = fileURLToPath(new URL('../fixtures/config/android.yaml', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'kb-feedback-cli-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const issue = (number: number, comments: unknown[]) => ({
  provider: 'github', origin: 'o/r', kind: 'issue', id: String(number), updatedAt: '2026-10-15T00:00:00Z',
  payload: { issue: { number, title: `Issue ${number}`, state: 'open', html_url: `https://github.com/o/r/issues/${number}`, user: { login: 'alice' }, comments: comments.length, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-15T00:00:00Z' }, comments, complete: true },
});
const botComment = { id: 501, user: { login: 'github-actions[bot]', type: 'Bot' }, author_association: 'NONE', created_at: '2026-10-10T00:00:00Z', body: '<!-- knowledge-bot v1 run=1 tier=high issue=10 -->\n\n**Possibly related to earlier reports**\n- #5 Earlier\n', reactions: { '+1': 1, '-1': 0 } };

const withBot = join(tmp, 'with-bot.sqlite');
const plain = join(tmp, 'plain.sqlite');
test.before(() => {
  let store = openRawStore(withBot); store.put(issue(10, [botComment])); store.put(issue(11, [])); store.close();
  store = openRawStore(plain); store.put(issue(12, [{ id: 1, user: { login: 'bob' }, created_at: '2026-10-10T00:00:00Z', body: 'hi' }])); store.close();
});

function run(rawPath: string, name: string) {
  const out = join(tmp, name); const outputs = join(tmp, `${name}.outputs`); const summary = join(tmp, `${name}.summary`);
  const r = spawnSync(process.execPath, [cli, '--config', configPath, '--raw', rawPath, '--repo', 'o/r', '--out', out], { env: { ...process.env, GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: summary }, encoding: 'utf8' });
  return { ...r, out, outputs: existsSync(outputs) ? readFileSync(outputs, 'utf8') : '', summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '' };
}

test('writes the feedback and the digest for a raw store with a bot comment', () => {
  const r = run(withBot, 'with-bot');
  assert.equal(r.status, 0, r.stderr);
  const feedback = JSON.parse(readFileSync(join(r.out, 'feedback.json'), 'utf8'));
  assert.equal(feedback.version, 1); assert.equal(feedback.comments.length, 1); assert.equal(feedback.comments[0].up, 1);
  assert.match(readFileSync(join(r.out, 'digest.md'), 'utf8'), /comments: 1/);
  assert.match(r.outputs, /comments=1\nsuppressed=0\ndigest=true/);
  assert.deepEqual(JSON.parse(r.stdout), { comments: 1, suppressed: 0, refreshed: 0 });
  assert.match(r.summary, /feedback: 1 bot comment/);
});

test('writes an empty feedback without a digest when no bot comment exists', () => {
  const r = run(plain, 'plain');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(r.out, 'feedback.json'), 'utf8')).comments, []);
  assert.ok(!existsSync(join(r.out, 'digest.md')));
  assert.match(r.outputs, /comments=0\nsuppressed=0\ndigest=false/);
});

test('exits 0 with a message when the raw store is missing', () => {
  const r = run(join(tmp, 'missing.sqlite'), 'missing');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /no raw store/);
  assert.ok(!existsSync(join(r.out, 'feedback.json')));
});
