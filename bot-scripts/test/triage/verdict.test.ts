import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseVerdict, tierOf, demote, readAgentOutput, VerdictError, ANSWER_MAX_CHARS } from '../../src/triage/verdict.ts';
import { sampleHandoff } from './fixtures.ts';
import type { Handoff } from '../../src/triage/handoff.ts';

const handoff: Handoff = (() => {
  const h = sampleHandoff();
  h.excerpts = [0, 1, 2].map((id) => ({ ...h.excerpts[0], id }));
  return h;
})();
const item = (over: Record<string, unknown>) => ({ type: 'post_triage_verdict', ...over });

test('takes the last verdict and parses its fields', () => {
  const verdict = parseVerdict({ items: [item({ confidence: '10' }), { type: 'noop' }, item({ confidence: '82.5', duplicates: '2, 0', related: '1', answer: ' Reboot fixes it. ', component: 'widgets' })] }, handoff);
  assert.deepEqual(verdict, { confidence: 82.5, duplicates: [2, 0], related: [1], answer: 'Reboot fixes it.', component: 'widgets', notes: ['used the last of 2 verdicts'] });
});

test('drops unknown and repeated ids with a note', () => {
  const verdict = parseVerdict({ items: [item({ confidence: 50, duplicates: '0,0,9', related: '0 1 x' })] }, handoff);
  assert.deepEqual(verdict.duplicates, [0]);
  assert.deepEqual(verdict.related, [1]);
  assert.equal(verdict.notes.length, 4, verdict.notes.join('; '));
  assert.equal(verdict.answer, null);
  assert.equal(verdict.component, null);
});

test('rejects a missing or unparsable verdict', () => {
  assert.throws(() => parseVerdict({ items: [] }, handoff), VerdictError);
  assert.throws(() => parseVerdict({ items: [{ type: 'noop' }] }, handoff), VerdictError);
  assert.throws(() => parseVerdict(null, handoff), VerdictError);
  assert.throws(() => parseVerdict({ items: [item({ confidence: 'high' })] }, handoff), VerdictError);
  assert.throws(() => parseVerdict({ items: [item({ confidence: '101' })] }, handoff), VerdictError);
  assert.throws(() => parseVerdict({ items: [item({ confidence: '-1' })] }, handoff), VerdictError);
});

test('trims the answer at its maximum length', () => {
  const verdict = parseVerdict({ items: [item({ confidence: '90', answer: 'a'.repeat(ANSWER_MAX_CHARS + 100) })] }, handoff);
  assert.equal(verdict.answer.length, ANSWER_MAX_CHARS);
});

test('tiers at the thresholds', () => {
  const t = { answer: 75, links: 45 };
  assert.equal(tierOf(75, t), 'high'); assert.equal(tierOf(74.9, t), 'medium'); assert.equal(tierOf(45, t), 'medium'); assert.equal(tierOf(44, t), 'low');
});

test('reads a missing agent output as no items', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'kb-verdict-'));
  try {
    assert.deepEqual(readAgentOutput(join(tmp, 'missing.json')), { items: [] });
    writeFileSync(join(tmp, 'out.json'), '{"items":[{"type":"post_triage_verdict","confidence":"1"}]}');
    assert.equal((readAgentOutput(join(tmp, 'out.json')) as { items: unknown[] }).items.length, 1);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('demotes one tier and never below low', () => {
  assert.equal(demote('high'), 'medium'); assert.equal(demote('medium'), 'low'); assert.equal(demote('low'), 'low');
});
