import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleHandoff } from '../triage/fixtures.ts';

const cli = fileURLToPath(new URL('../../src/cli/render-verdict.ts', import.meta.url));
const configPath = fileURLToPath(new URL('../fixtures/config/android.yaml', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'kb-render-cli-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const stagedConfig = join(tmp, 'staged.yaml');
writeFileSync(stagedConfig, `${readFileSync(configPath, 'utf8')}\ntriage:\n  staged: true\n`);
const handoffPath = join(tmp, 'handoff.json');
writeFileSync(handoffPath, JSON.stringify(sampleHandoff()));
const agentOutput = (items: unknown[]) => { const p = join(tmp, `agent-${Math.random().toString(36).slice(2)}.json`); writeFileSync(p, JSON.stringify({ items })); return p; };

function run(config: string, agent: string, name: string) {
  const outDir = join(tmp, name); const outputs = join(tmp, `${name}.outputs`); const summary = join(tmp, `${name}.summary.md`);
  const r = spawnSync(process.execPath, [cli, '--config', config, '--handoff', handoffPath, '--agent-output', agent, '--out-dir', outDir, '--run-id', '77'], { env: { ...process.env, GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: summary }, encoding: 'utf8' });
  return { ...r, outDir, outputs: existsSync(outputs) ? readFileSync(outputs, 'utf8') : '', summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '' };
}

test('renders the comment and asks to post it', () => {
  const r = run(configPath, agentOutput([{ type: 'post_triage_verdict', confidence: '80', duplicates: '0', answer: 'Reboot fixes it.' }]), 'live');
  assert.equal(r.status, 0, r.stderr);
  const comment = readFileSync(join(r.outDir, 'comment.md'), 'utf8');
  assert.match(comment, /^<!-- knowledge-bot v1 run=77 tier=high issue=7612 -->/);
  assert.match(r.outputs, /tier=high\npost=true\ncomment-path=.*comment\.md/);
  const verdict = JSON.parse(readFileSync(join(r.outDir, 'verdict.json'), 'utf8'));
  assert.equal(verdict.tier, 'high'); assert.equal(verdict.staged, false); assert.equal(verdict.posted, true);
  assert.match(r.summary, /tier: high/); assert.match(r.summary, /Reboot fixes it/);
});

test('writes the comment to the summary only in staged mode', () => {
  const r = run(stagedConfig, agentOutput([{ type: 'post_triage_verdict', confidence: '60', related: '0' }]), 'staged');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.outputs, /tier=medium\npost=false/);
  assert.match(r.summary, /staged: the comment below was not posted/);
  assert.match(r.summary, /<!-- knowledge-bot v1 run=77 tier=medium issue=7612 -->/);
  const verdict = JSON.parse(readFileSync(join(r.outDir, 'verdict.json'), 'utf8'));
  assert.equal(verdict.staged, true); assert.equal(verdict.posted, false);
});

test('posts nothing for a low tier and fails loudly on a verdict without confidence', () => {
  const low = run(configPath, agentOutput([{ type: 'post_triage_verdict', confidence: '10', component: 'widgets' }]), 'low');
  assert.equal(low.status, 0, low.stderr);
  assert.match(low.outputs, /tier=low\npost=false/);
  assert.ok(!existsSync(join(low.outDir, 'comment.md')));
  assert.match(low.summary, /no comment for this tier/); assert.match(low.summary, /component: widgets/);
  const none = run(configPath, agentOutput([]), 'none');
  assert.equal(none.status, 1);
  assert.match(none.stderr, /post_triage_verdict/);
});
