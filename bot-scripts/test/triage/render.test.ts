import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderComment, sanitizeAnswer, marker, parseMarker, excerptLine, FOOTER } from '../../src/triage/render.ts';
import { toExcerpt, type Handoff } from '../../src/triage/handoff.ts';
import type { Verdict } from '../../src/triage/verdict.ts';
import { result, sampleHandoff } from './fixtures.ts';

const handoff: Handoff = {
  ...sampleHandoff(),
  excerpts: [
    toExcerpt(result(), 0, ['#5644']),
    toExcerpt(result({ source: 'forum', provider: 'discourse', origin: 'community.example', sourceId: '9', url: 'https://community.example/t/9', title: 'Force widget update', createdAt: '2026-03-05T00:00:00Z', outcome: { solved: true } }), 1, []),
    toExcerpt(result({ source: 'docs', origin: 'o/docs', sourceId: 'widgets', url: 'https://docs.example/widgets#refresh', title: 'Widgets', heading: 'Refresh behavior', createdAt: '1970-01-01T00:00:00Z', outcome: null }), 2, []),
    toExcerpt(result({ source: 'docs', origin: 'o/dev', sourceId: 'build', url: 'https://dev.example/build', title: 'Building the app', audience: 'developer', createdAt: '1970-01-01T00:00:00Z', outcome: null }), 3, []),
    toExcerpt(result({ source: 'code', sourceId: 'Widget.kt', url: 'https://github.com/o/r/blob/main/Widget.kt', title: 'Widget.kt', audience: 'maintainer', createdAt: '1970-01-01T00:00:00Z', outcome: null }), 4, []),
    toExcerpt(result({ source: 'issue', origin: 'other/repo', sourceId: '12', url: 'https://github.com/other/repo/issues/12', title: 'Core widget bug', createdAt: '2024-06-01T00:00:00Z', outcome: { state: 'open', stateReason: null } }), 5, []),
    toExcerpt(result({ source: 'pull', sourceId: '5644', url: 'https://github.com/o/r/pull/5644', title: 'Fix widget refresh', createdAt: '2025-02-01T00:00:00Z', outcome: { state: 'merged' } }), 6, []),
    toExcerpt(result({ source: 'pull', sourceId: '5700', url: 'https://github.com/o/r/pull/5700', title: 'Rework widget refresh', createdAt: '2025-04-01T00:00:00Z', outcome: { state: 'closed' } }), 7, []),
    toExcerpt(result({ sourceId: '7001', url: 'https://github.com/o/r/issues/7001', title: 'Widget frozen again', createdAt: '2026-05-01T00:00:00Z', outcome: { state: 'open', stateReason: null } }), 8, []),
  ],
};
const verdict = (over: Partial<Verdict> = {}): Verdict => ({ confidence: 80, duplicates: [0], related: [1, 2], answer: 'Reboot fixes it.', component: null, notes: [], ...over });

test('renders the high tier with both sections, the answer and the footer', () => {
  const body = renderComment({ handoff, verdict: verdict(), tier: 'high', runId: '42' });
  assert.equal(body.split('\n')[0], '<!-- knowledge-bot v1 run=42 tier=high issue=7612 -->');
  assert.match(body, /\*\*Possibly related to earlier reports\*\*\n- #5610 Widget stops updating after reboot \(closed, fixed by #5644, Jan 2025\)\n/);
  assert.match(body, /\*\*Discussions and docs\*\*\n- Forum: \[Force widget update\]\(https:\/\/community\.example\/t\/9\) \(solved, Mar 2026\)\n- Docs: \[Widgets › Refresh behavior\]\(https:\/\/docs\.example\/widgets#refresh\)\n/);
  assert.match(body, /Reboot fixes it\.\n\n---\nWas this helpful\?/);
  assert.ok(body.endsWith(`${FOOTER}\n`));
});

test('renders the medium tier without the answer and nothing for low', () => {
  const medium = renderComment({ handoff, verdict: verdict(), tier: 'medium', runId: '42' });
  assert.ok(!medium.includes('Reboot fixes it.'));
  assert.match(medium, /tier=medium/);
  assert.equal(renderComment({ handoff, verdict: verdict(), tier: 'low', runId: '42' }), null);
});

test('shows developer excerpts only when the issue talks about building and never maintainer ones', () => {
  const plain = renderComment({ handoff, verdict: verdict({ duplicates: [], related: [3, 4, 2] }), tier: 'medium', runId: '1' });
  assert.ok(!plain.includes('Building the app')); assert.ok(!plain.includes('Widget.kt')); assert.ok(plain.includes('Refresh behavior'));
  const dev = renderComment({ handoff: { ...handoff, issue: { ...handoff.issue, body: 'The Gradle build fails on minimal' } }, verdict: verdict({ duplicates: [], related: [3, 4] }), tier: 'medium', runId: '1' });
  assert.ok(dev.includes('- Docs: [Building the app](https://dev.example/build)')); assert.ok(!dev.includes('Widget.kt'));
});

test('says that a closed pull was not merged', () => {
  assert.equal(excerptLine(handoff.excerpts[7], 'o/r'), '- #5700 Rework widget refresh (closed, not merged, Apr 2025)');
  const dated = toExcerpt(result({ source: 'pull', sourceId: '5700', url: 'https://github.com/o/r/pull/5700', title: 'Rework widget refresh', createdAt: '2025-04-01T00:00:00Z', outcome: { state: 'closed', closedAt: '2025-06-10T00:00:00Z' } }), 7, []);
  assert.equal(excerptLine(dated, 'o/r', true), '- #5700 Rework widget refresh (closed Jun 2025, not merged)');
});

test('shows the close month and the stable release that ships the fix', () => {
  const fixed = toExcerpt(result({ outcome: { state: 'closed', stateReason: 'completed', closedAt: '2025-03-04T00:00:00Z' } }), 0, ['#5644'], '2025.4.1');
  assert.equal(excerptLine(fixed, 'o/r', true), '- #5610 Widget stops updating after reboot (closed Mar 2025, fixed by #5644, in 2025.4.1)');
  const pending = toExcerpt(result({ outcome: { state: 'closed', stateReason: 'completed', closedAt: '2025-03-04T00:00:00Z' } }), 0, ['#5644']);
  assert.equal(excerptLine(pending, 'o/r', true), '- #5610 Widget stops updating after reboot (closed Mar 2025, fixed by #5644, not yet in a stable release)');
  assert.equal(excerptLine(pending, 'o/r', false), '- #5610 Widget stops updating after reboot (closed Mar 2025, fixed by #5644)');
  const notPlanned = toExcerpt(result({ outcome: { state: 'closed', stateReason: 'not_planned', closedAt: '2025-03-04T00:00:00Z' } }), 0, []);
  assert.equal(excerptLine(notPlanned, 'o/r', true), '- #5610 Widget stops updating after reboot (closed Mar 2025, not_planned)');
  const merged = toExcerpt(result({ source: 'pull', sourceId: '5644', url: 'https://github.com/o/r/pull/5644', title: 'Fix widget refresh', createdAt: '2025-02-01T00:00:00Z', outcome: { state: 'merged', mergedAt: '2025-02-20T00:00:00Z' } }), 6, [], '2025.4.1');
  assert.equal(excerptLine(merged, 'o/r', true), '- #5644 Fix widget refresh (merged Feb 2025, in 2025.4.1)');
  assert.equal(excerptLine(toExcerpt(result({ source: 'pull', sourceId: '5644', url: 'https://github.com/o/r/pull/5644', title: 'Fix widget refresh', createdAt: '2025-02-01T00:00:00Z', outcome: { state: 'merged', mergedAt: '2025-02-20T00:00:00Z' } }), 6, []), 'o/r', true), '- #5644 Fix widget refresh (merged Feb 2025, not yet in a stable release)');
  const open = toExcerpt(result({ outcome: { state: 'open', stateReason: null } }), 0, []);
  assert.equal(excerptLine(open, 'o/r', true), '- #5610 Widget stops updating after reboot (open, Jan 2025)');
});

test('lists duplicates oldest first and keeps the related order', () => {
  const body = renderComment({ handoff, verdict: verdict({ duplicates: [8, 0], related: [2, 1], answer: null }), tier: 'medium', runId: '1' });
  assert.match(body, /earlier reports\*\*\n- #5610 Widget stops updating after reboot \(closed, fixed by #5644, Jan 2025\)\n- #7001 Widget frozen again \(open, May 2026\)\n/);
  assert.match(body, /docs\*\*\n- Docs: \[Widgets › Refresh behavior\][^\n]*\n- Forum: \[Force widget update\]/);
});

test('formats other origins, pulls and discussions with links', () => {
  assert.equal(excerptLine(handoff.excerpts[5], 'o/r'), '- [Core widget bug](https://github.com/other/repo/issues/12) (open, Jun 2024)');
  assert.equal(excerptLine(handoff.excerpts[6], 'o/r'), '- #5644 Fix widget refresh (merged, Feb 2025)');
  assert.equal(excerptLine(toExcerpt(result({ source: 'discussion', sourceId: '3', url: 'https://github.com/o/r/discussions/3', title: 'Widget ideas', createdAt: '2025-05-01T00:00:00Z', outcome: null }), 9, []), 'o/r'), '- Discussion: [Widget ideas](https://github.com/o/r/discussions/3) (May 2025)');
  assert.equal(excerptLine(handoff.excerpts[2], 'o/r'), '- Docs: [Widgets › Refresh behavior](https://docs.example/widgets#refresh)');
});

test('strips links, mentions and html from the answer', () => {
  assert.equal(sanitizeAnswer('See [docs](https://x) or https://y.example and ask @maintainer <b>now</b>'), 'See docs or and ask maintainer now');
  assert.equal(sanitizeAnswer('Line one\n\n\n\nLine two  '), 'Line one\n\nLine two');
  const body = renderComment({ handoff, verdict: verdict({ answer: 'Ping @someone, see https://evil.example/x' }), tier: 'high', runId: '1' });
  assert.ok(!body.includes('@someone')); assert.ok(!body.includes('evil.example'));
});

test('returns null when nothing is visible and parses its own marker', () => {
  assert.equal(renderComment({ handoff, verdict: verdict({ duplicates: [], related: [], answer: null }), tier: 'high', runId: '1' }), null);
  assert.equal(renderComment({ handoff, verdict: verdict({ duplicates: [4], related: [], answer: null }), tier: 'high', runId: '1' }), null);
  assert.ok(renderComment({ handoff, verdict: verdict({ duplicates: [], related: [], answer: 'Only an answer.' }), tier: 'high', runId: '1' }).includes('Only an answer.'));
  assert.deepEqual(parseMarker(`${marker({ runId: '42', tier: 'medium', issue: 3 })}\nrest`), { runId: '42', tier: 'medium', issue: 3 });
  assert.equal(parseMarker('plain comment'), null);
});

test('escapes markdown, html and mentions in titles and headings', () => {
  const hostile = toExcerpt(result({ source: 'docs', origin: 'o/docs', sourceId: 'h', url: 'https://docs.example/h', title: 'Crash [see](http://evil) @admin <b>x</b>', heading: '*bold* `code`', createdAt: '1970-01-01T00:00:00Z', outcome: null }), 7, []);
  const line = excerptLine(hostile, 'o/r');
  assert.equal(line, '- Docs: [Crash \\[see\\]\\(http://evil\\) admin x › \\*bold\\* \\`code\\`](https://docs.example/h)');
  const issueLine = excerptLine(toExcerpt(result({ title: 'Ping @someone\nnext line' }), 8, []), 'o/r');
  assert.equal(issueLine, '- #5610 Ping someone next line (closed, completed, Jan 2025)');
});

test('encodes unsafe characters in urls and drops non-http ones', () => {
  const spaced = toExcerpt(result({ source: 'docs', url: 'https://docs.example/a b(c)<d>', title: 'Spaced', createdAt: '1970-01-01T00:00:00Z', outcome: null }), 9, []);
  assert.equal(excerptLine(spaced, 'o/r'), '- Docs: [Spaced](https://docs.example/a%20b%28c%29%3Cd%3E)');
  const bad = toExcerpt(result({ source: 'forum', url: 'javascript:alert(1)', title: 'Bad', outcome: null }), 10, []);
  assert.equal(excerptLine(bad, 'o/r'), '- Forum: Bad (Jan 2025)');
});

test('escapes markdown in the answer and neutralises issue references and bare links', () => {
  assert.equal(sanitizeAnswer('Fix in #5610 and www.evil.example //cdn.evil/x *bold* _u_ `code` [x](y) a|b'), 'Fix in `#5610` and \\*bold\\* \\_u\\_ \\`code\\` x a\\|b');
});
