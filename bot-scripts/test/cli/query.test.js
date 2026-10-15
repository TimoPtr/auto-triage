import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatResults } from '../../src/cli/query.js';

const results = Object.assign([
  { rank: 1, source: 'issue', title: 'Widget stops', url: 'https://x/1', createdAt: '2025-03-01T00:00:00Z', heading: null, text: 'Widget stops after reboot', scores: { similarity: 0.91, lexical: 3.2, fused: 0.031 }, outcome: { state: 'closed', stateReason: 'completed' } },
  { rank: 2, source: 'docs', title: 'Android Widgets', url: 'https://x/docs', createdAt: '1970-01-01T00:00:00Z', heading: 'Refresh', text: 'Widgets refresh on tap', scores: { similarity: 0.8, lexical: null, fused: 0.02 }, outcome: null },
], { bestSimilarity: 0.91 });

test('formats a readable block per result', () => {
  const out = formatResults(results, { json: false });
  assert.match(out, /^best similarity 0\.91/m);
  assert.match(out, /1\. \[issue\] Widget stops \(closed, completed, 2025-03-01\)\n\s+https:\/\/x\/1\n\s+similarity 0\.91 · lexical 3\.20 · fused 0\.0310/);
  assert.match(out, /2\. \[docs\] Android Widgets › Refresh\n\s+https:\/\/x\/docs/);
  assert.ok(!out.includes('1970-01-01'));
});

test('json output includes bestSimilarity and the results', () => {
  const parsed = JSON.parse(formatResults(results, { json: true }));
  assert.equal(parsed.bestSimilarity, 0.91);
  assert.equal(parsed.results.length, 2);
});
