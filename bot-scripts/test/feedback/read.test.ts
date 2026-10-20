import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFeedback } from '../../src/feedback/read.ts';

const tmp = mkdtempSync(join(tmpdir(), 'kb-feedback-read-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

test('reads the suppressed issue numbers', () => {
  const p = join(tmp, 'ok.json');
  writeFileSync(p, JSON.stringify({ version: 1, repository: 'o/r', generatedAt: 'x', comments: [], suppressed: [{ issue: 11, reason: 'downvoted', at: 'x' }, { issue: 14, reason: 'dismissed', at: 'x' }] }));
  assert.deepEqual(readFeedback(p), new Set([11, 14]));
});

test('ignores an unreadable or older feedback file', () => {
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  assert.deepEqual(readFeedback(join(tmp, 'missing.json'), log), new Set());
  const garbage = join(tmp, 'garbage.json'); writeFileSync(garbage, '{not json');
  assert.deepEqual(readFeedback(garbage, log), new Set());
  const old = join(tmp, 'old.json'); writeFileSync(old, JSON.stringify({ version: 2, suppressed: [{ issue: 1 }] }));
  assert.deepEqual(readFeedback(old, log), new Set());
  const odd = join(tmp, 'odd.json'); writeFileSync(odd, JSON.stringify({ version: 1, suppressed: [{ issue: 'x' }, { issue: 3 }] }));
  assert.deepEqual(readFeedback(odd, log), new Set([3]));
  assert.equal(lines.length, 3);
});
