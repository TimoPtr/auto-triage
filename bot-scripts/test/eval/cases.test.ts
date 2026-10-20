import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseFiles, readCases, splitFor, EvalCaseError, SPLIT_TRAIN_PERCENT, SPLIT_VALIDATION_PERCENT } from '../../src/eval/cases.ts';

const tmp = mkdtempSync(join(tmpdir(), 'kb-cases-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const line = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  id, relation: 'duplicate', split: 'train', query: { type: 'issue', number: 20, origin: 'o/r', asOf: '2025-03-02T10:14:00Z' },
  expected: [{ type: 'issue', number: 10, origin: 'o/r' }], expectedTier: 'high', labelSource: 'comment:duplicate-of', verified: false, ...extra,
});

const dir = join(tmp, 'eval');
mkdirSync(dir);
writeFileSync(join(dir, 'cases-a.jsonl'), [line('dup-20'), '', line('text-1', { relation: 'curated', query: { type: 'text', text: 'widget stops' }, expected: [{ type: 'docs', url: 'https://docs.example/docs/widgets' }] })].join('\n') + '\n');
writeFileSync(join(dir, 'cases-b.jsonl'), line('fix-3', { relation: 'fixed-by', expected: [{ type: 'pull', number: 9 }] }) + '\n');

test('reads cases from a directory in file order', () => {
  const files = caseFiles(dir);
  assert.deepEqual(files, [join(dir, 'cases-a.jsonl'), join(dir, 'cases-b.jsonl')]);
  assert.deepEqual(readCases(files).map((c) => c.id), ['dup-20', 'text-1', 'fix-3']);
  assert.deepEqual(caseFiles(join(dir, 'cases-b.jsonl')), [join(dir, 'cases-b.jsonl')]);
  assert.deepEqual(caseFiles(join(tmp, 'missing')), []);
});

test('rejects a malformed line with its file and line', () => {
  const bad = join(tmp, 'bad.jsonl');
  writeFileSync(bad, line('ok-1') + '\n' + JSON.stringify({ id: 'x', relation: 'docs', split: 'test', query: { type: 'issue', number: 1 }, expectedTier: 'high', labelSource: 's', verified: false }) + '\n');
  assert.throws(() => readCases([bad]), (e: Error) => e instanceof EvalCaseError && /bad\.jsonl:2: /.test(e.message) && /expected/.test(e.message));
  const broken = join(tmp, 'broken.jsonl');
  writeFileSync(broken, '{not json\n');
  assert.throws(() => readCases([broken]), (e: Error) => e instanceof EvalCaseError && /broken\.jsonl:1: /.test(e.message));
  const unknown = join(tmp, 'unknown.jsonl');
  writeFileSync(unknown, line('u-1', { extra: true }) + '\n');
  assert.throws(() => readCases([unknown]), EvalCaseError);
});

test('rejects a duplicate id across files', () => {
  const again = join(tmp, 'again.jsonl');
  writeFileSync(again, line('dup-20') + '\n');
  assert.throws(() => readCases([join(dir, 'cases-a.jsonl'), again]), (e: Error) => e instanceof EvalCaseError && /again\.jsonl:1: duplicate id dup-20/.test(e.message));
});

test('assigns splits by hash within the expected proportions', () => {
  const ids = Array.from({ length: 1000 }, (_, i) => `c-${i + 1}`);
  const counts = { train: 0, validation: 0, test: 0 };
  for (const id of ids) counts[splitFor(id)] += 1;
  assert.ok(counts.train >= 540 && counts.train <= 660, `train ${counts.train}`);
  assert.ok(counts.validation >= 150 && counts.validation <= 250, `validation ${counts.validation}`);
  assert.equal(SPLIT_TRAIN_PERCENT + SPLIT_VALIDATION_PERCENT, 80);
  assert.equal(splitFor('c-1'), splitFor('c-1'));
  assert.ok(ids.slice(0, 50).some((id) => splitFor(id) !== splitFor(id, 'other')));
});
