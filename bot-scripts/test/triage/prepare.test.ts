import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeIndex } from '../../src/store/writer.ts';
import { openDatabase } from '../../src/store/db.ts';
import { loadConfig } from '../../src/config/load.ts';
import { prepareTriage, fixedBy, indexedItemId, LIVE_QUERY_MAX_CHARS } from '../../src/triage/prepare.ts';
import type { TriageIssue } from '../../src/triage/issue.ts';
import type { IndexItem, SourceKind } from '../../src/providers/types.ts';
import type { Audience } from '../../src/config/types.ts';
import type { DatabaseSync } from 'node:sqlite';

const tmp = mkdtempSync(join(tmpdir(), 'kb-prepare-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const vectorFor = (text: string) => {
  const t = text.toLowerCase();
  if (t.includes('widget')) return Float32Array.from([1, 0, 0, 0]);
  if (t.includes('notification')) return Float32Array.from([0, 1, 0, 0]);
  return Float32Array.from([0, 0, 1, 0]);
};
const embedder = { modelKey: 'fake@1@q8@cls', dimensions: 4, async embed(texts: string[]) { return texts.map(vectorFor); } };

const item = (sourceId: string, source: SourceKind, title: string, text: string, over: Partial<IndexItem> = {}): IndexItem => ({
  source, provider: source === 'forum' ? 'discourse' : 'github', origin: 'o/r', sourceId, url: `https://x/${source}/${sourceId}`, title, audience: 'user' as Audience,
  createdAt: '2025-03-01T00:00:00Z', updatedAt: null, outcome: null, extra: null,
  chunks: [{ seq: 0, kind: source === 'docs' ? 'section' : 'body', heading: null, anchor: null, text, logs: null, createdAt: '2025-03-01T00:00:00Z', authorRole: null }],
  ...over,
});

const config = loadConfig(fileURLToPath(new URL('../fixtures/config/android.yaml', import.meta.url)));
const indexPath = join(tmp, 'knowledge.sqlite');
let db: DatabaseSync;
test.before(async () => {
  async function* items() {
    yield item('1', 'issue', 'Widget stops after reboot', 'Widget stops after reboot', { outcome: { state: 'closed', stateReason: 'completed' } });
    yield item('50', 'pull', 'Fix widget refresh', 'Fix widget refresh after reboot', { outcome: { state: 'merged', linkedIssues: [1, 7] } });
    yield item('51', 'pull', 'Widget rework', 'Widget rework', { outcome: { state: 'closed', linkedIssues: [1] } });
    yield item('widgets', 'docs', 'Android Widgets', 'Widgets refresh on tap');
    yield item('EntityWidget.kt', 'code', 'EntityWidget.kt', 'class EntityWidget widget provider', { audience: 'maintainer' });
    const logged = item('7', 'issue', 'Refresh failure', 'Refresh failure on tablets');
    logged.chunks[0].logs = 'E/EntityWidget: refresh failed';
    yield logged;
  }
  await writeIndex({ items: items(), embedder, outPath: indexPath, meta: {} });
  db = openDatabase(indexPath, { readOnly: true });
});
test.after(() => db?.close());

const issueOf = (over: Partial<TriageIssue> = {}): TriageIssue => ({
  number: 900, title: 'Widget stops updating', body: '<!-- template -->\nWidget stops updating', labels: ['bug'], createdAt: '2026-10-20T00:00:00Z',
  authorType: 'User', isPullRequest: false, state: 'open', ...over,
});
const base = () => ({ config, db, embedder, issue: issueOf(), repository: 'o/r', now: new Date('2026-10-20T00:00:00Z') });

test('builds a handoff with fixedBy from merged pulls', async () => {
  const { decision, handoff } = await prepareTriage(base());
  assert.equal(decision.reason, 'ok');
  assert.equal(decision.shouldContinue, true);
  assert.ok(decision.bestSimilarity > 0.9);
  const first = handoff.excerpts.find((e) => e.source === 'issue' && e.url.endsWith('/1'));
  assert.deepEqual(first.outcome.fixedBy, ['#50']);
  assert.equal(handoff.issue.body, 'Widget stops updating');
  assert.equal(handoff.issue.number, 900);
  assert.equal(handoff.repository, 'o/r');
  assert.equal(handoff.thresholds.answer, 75);
  assert.equal(handoff.retrieval.minSimilarity, 0.35);
  assert.ok(handoff.retrieval.indexBuiltAt);
  assert.deepEqual(handoff.excerpts.map((e) => e.id), handoff.excerpts.map((_, i) => i));
  assert.ok(handoff.excerpts.some((e) => e.audience === 'maintainer'), 'maintainer excerpts reach the agent');
});

test('skips bot authors, pull requests and empty issues', async () => {
  assert.equal((await prepareTriage({ ...base(), issue: issueOf({ authorType: 'Bot' }) })).decision.reason, 'bot-author');
  assert.equal((await prepareTriage({ ...base(), issue: issueOf({ isPullRequest: true }) })).decision.reason, 'pull-request');
  const empty = await prepareTriage({ ...base(), issue: issueOf({ title: '', body: '<!-- only a comment -->' }) });
  assert.equal(empty.decision.reason, 'empty-issue');
  assert.equal(empty.handoff, null);
});

test('stops below the similarity floor and without an index', async () => {
  const low = await prepareTriage({ ...base(), issue: issueOf({ title: 'Notification sound missing', body: '' }) });
  assert.equal(low.decision.reason, 'below-min-similarity');
  assert.equal(low.decision.shouldContinue, false);
  assert.equal((await prepareTriage({ ...base(), db: null, embedder: null })).decision.reason, 'no-usable-index');
});

test('excludes the issue itself when it is already indexed', async () => {
  assert.equal(indexedItemId(db, 'o/r', 1), 1);
  assert.equal(indexedItemId(db, 'o/r', 999), null);
  const { handoff } = await prepareTriage({ ...base(), issue: issueOf({ number: 1, title: 'Widget stops after reboot', body: 'Widget stops after reboot' }) });
  assert.ok(handoff.excerpts.every((e) => !(e.source === 'issue' && e.url.endsWith('/1'))));
});

test('fixedBy lists only merged pulls of the origin that link the issue', () => {
  assert.deepEqual(fixedBy(db, 'o/r', 1), ['#50']);
  assert.deepEqual(fixedBy(db, 'o/r', 7), ['#50']);
  assert.deepEqual(fixedBy(db, 'o/r', 2), []);
  assert.deepEqual(fixedBy(db, 'other/repo', 1), []);
});

test('lifts fenced logs of the issue into the lexical search', async () => {
  const body = 'Widget crash\n\n```\nE/EntityWidget: refresh failed\n\tat io.ha.widget.EntityWidget.refresh(EntityWidget.kt:10)\n```';
  const { decision, handoff } = await prepareTriage({ ...base(), issue: issueOf({ title: 'Widget crash', body }) });
  assert.equal(decision.reason, 'ok');
  const logged = handoff.excerpts.find((e) => e.url.endsWith('/issue/7'));
  assert.ok(logged, 'the item matched only through its logs is retrieved');
  assert.ok(logged.scores.lexical !== null);
  assert.equal(handoff.issue.body, 'Widget crash');
  assert.match(handoff.issue.logs, /E\/EntityWidget/);
});

test('asks for live lists only after the gate, with the cleaned question', async () => {
  const calls: string[] = [];
  const liveLists = async (question: string) => { calls.push(question); return []; };
  await prepareTriage({ ...base(), issue: issueOf({ authorType: 'Bot' }), liveLists });
  assert.deepEqual(calls, []);
  await prepareTriage({ ...base(), issue: issueOf({ title: 'Widget stops updating', body: `<!-- template -->\nWidget stops updating\n\n${'x'.repeat(2000)}` }), liveLists });
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].includes('<!--'));
  assert.ok(calls[0].length <= LIVE_QUERY_MAX_CHARS);
  assert.ok(calls[0].startsWith('Widget stops updating'));
});

test('demotes one tier when a suppressed issue of the repository is retrieved above the floor', async () => {
  const hit = await prepareTriage({ ...base(), suppressed: new Set([1]) });
  assert.deepEqual(hit.handoff.retrieval.demote?.issue, 1);
  assert.ok(hit.handoff.retrieval.demote.similarity >= 0.9);
  const otherRepo = await prepareTriage({ ...base(), repository: 'other/repo', suppressed: new Set([1]) });
  assert.equal(otherRepo.handoff.retrieval.demote, null);
  const unknown = await prepareTriage({ ...base(), suppressed: new Set([999]) });
  assert.equal(unknown.handoff.retrieval.demote, null);
  // issue 7 reaches the excerpts through its text only, far below the floor
  const belowFloor = await prepareTriage({ ...base(), issue: issueOf({ title: 'Widget crash', body: 'Widget crash\n\n```\nE/EntityWidget: refresh failed\n```' }), suppressed: new Set([7]) });
  assert.ok(belowFloor.handoff.excerpts.some((e) => e.url.endsWith('/issue/7')));
  assert.equal(belowFloor.handoff.retrieval.demote, null);
});
