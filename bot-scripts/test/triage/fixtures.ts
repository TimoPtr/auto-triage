import { toExcerpt, type Handoff } from '../../src/triage/handoff.ts';
import type { RetrievalResult } from '../../src/retrieval/retrieve.ts';

export const result = (over: Partial<RetrievalResult> = {}): RetrievalResult => ({
  itemId: 1, chunkId: 1, source: 'issue', provider: 'github', origin: 'o/r', sourceId: '5610', url: 'https://github.com/o/r/issues/5610',
  title: 'Widget stops updating after reboot', heading: null, anchor: null, text: 'Widget stops updating after reboot', createdAt: '2025-01-12T10:00:00Z',
  audience: 'user', authorRole: 'reporter', outcome: { state: 'closed', stateReason: 'completed' },
  scores: { similarity: 0.71, itemSimilarity: 0.8, lexical: 12.4, fused: 0.031 }, rank: 1, ...over,
});

export const sampleHandoff = (): Handoff => ({
  version: 1, product: { name: 'Android', slug: 'android' }, repository: 'o/r',
  issue: { number: 7612, title: 'Widget frozen', body: 'Widget frozen after reboot', logs: null, labels: [], createdAt: '2026-10-20T00:00:00Z' },
  excerpts: [toExcerpt(result(), 0, ['#5644'])],
  thresholds: { answer: 75, links: 45 },
  retrieval: { bestSimilarity: 0.8, minSimilarity: 0.35, indexBuiltAt: '2026-10-19T03:00:00Z', demote: null },
});
