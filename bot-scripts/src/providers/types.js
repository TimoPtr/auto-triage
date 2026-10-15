// @ts-check
/**
 * @typedef {'docs'|'issue'|'pull'|'discussion'|'forum'|'code'|'file'} SourceKind
 * @typedef {'user'|'developer'|'maintainer'} Audience
 * @typedef {{ seq: number, kind: 'body'|'comment'|'review'|'answer'|'section'|'symbol', heading?: string|null, anchor?: string|null, text: string, logs?: string|null, createdAt: string }} IndexChunk
 * @typedef {{ source: SourceKind, provider: string, origin: string, sourceId: string, url: string, title: string, audience: Audience, createdAt: string, updatedAt?: string|null, outcome?: object|null, extra?: object|null, chunks: IndexChunk[] }} IndexItem
 * @typedef {{ name: string, items(): AsyncGenerator<IndexItem> }} Provider
 */
export {};
