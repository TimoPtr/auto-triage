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

/** An item a source listed that no longer qualifies; an incremental build deletes it. */
export interface Removal { remove: true; provider: string; origin: string; source: SourceKind; sourceId: string }
export type ProviderItem = IndexItem | Removal;

export function isRemoval(item: ProviderItem): item is Removal {
  return 'remove' in item && item.remove === true;
}

/** `since` limits a read to what changed after that instant; absent, the source is read in full. */
export interface ReadWindow { since?: Date }

export interface Provider {
  name: string;
  items(window?: ReadWindow): AsyncGenerator<ProviderItem>;
}

/** The part of the GitHub client the readers depend on. */
export interface PaginatingClient {
  paginate(path: string, params?: Record<string, string | number | boolean>): AsyncIterable<unknown>;
  getJson?<T = unknown>(path: string, params?: Record<string, string | number | boolean>): Promise<T>;
  graphql?<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
  graphqlPartial?<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<{ data: T | null; errors: { message: string; path?: (string | number)[] }[] }>;
}
