import type { Audience } from '../config/types.ts';

export type SourceKind = 'docs' | 'issue' | 'pull' | 'discussion' | 'release' | 'forum' | 'code' | 'file';
export type ChunkKind = 'body' | 'comment' | 'review' | 'answer' | 'section' | 'symbol';
export type AuthorRole = 'reporter' | 'maintainer' | 'user';

export interface IndexChunk {
  seq: number;
  kind: ChunkKind;
  heading?: string | null;
  anchor?: string | null;
  text: string;
  logs?: string | null;
  createdAt: string;
  /** From the API's author association, never from the text: the only source of author authority. */
  authorRole?: AuthorRole | null;
}

export interface IndexItem {
  source: SourceKind;
  provider: string;
  origin: string;
  sourceId: string;
  url: string;
  title: string;
  audience: Audience;
  createdAt: string;
  updatedAt?: string | null;
  outcome?: Record<string, unknown> | null;
  extra?: Record<string, unknown> | null;
  chunks: IndexChunk[];
}

export interface Provider {
  name: string;
  items(): AsyncGenerator<IndexItem>;
}

/** The part of the GitHub client the readers depend on. */
export interface PaginatingClient {
  paginate(path: string, params?: Record<string, string | number | boolean>): AsyncIterable<unknown>;
  graphql?<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
}
