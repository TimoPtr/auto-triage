import { cleanIssueText } from '../../text/clean.ts';
import { packText } from '../../text/chunk.ts';
import type { DiscussionsConfig } from '../../config/types.ts';
import type { AuthorRole, IndexChunk, IndexItem, PaginatingClient } from '../types.ts';
import type { RawStore } from '../../store/raw.ts';

const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const CHUNK_CHARS = 2000;
const PAGE = 50;

const CATEGORIES_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { discussionCategories(first: 50) { nodes { id slug } } } }`;

const DISCUSSIONS_QUERY = `query($owner: String!, $name: String!, $categoryId: ID!, $after: String, $first: Int!) {
  repository(owner: $owner, name: $name) {
    discussions(first: $first, after: $after, categoryId: $categoryId, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { number title url createdAt updatedAt closed isAnswered category { slug } bodyText
              author { login } authorAssociation comments { totalCount }
              answer { bodyText createdAt author { login } authorAssociation } } } } }`;

interface Category { id: string; slug: string }
interface Node {
  number: number; title: string; url: string; createdAt: string; updatedAt: string; closed: boolean; isAnswered: boolean | null;
  category: { slug: string }; bodyText: string; author: { login: string } | null; authorAssociation: string;
  comments: { totalCount: number }; answer: { bodyText: string; createdAt: string; author: { login: string } | null; authorAssociation: string } | null;
}
interface Page { repository: { discussions: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Node[] } } }

function roleOf(association: string, login: string | undefined, author: string | undefined): AuthorRole {
  if (login && login === author) return 'reporter';
  return MAINTAINER_ASSOCIATIONS.has(association) ? 'maintainer' : 'user';
}

async function categoryIds(client: PaginatingClient, owner: string, name: string, slugs: string[]): Promise<Category[]> {
  const data = await client.graphql!<{ repository: { discussionCategories: { nodes: Category[] } } }>(CATEGORIES_QUERY, { owner, name });
  const known = new Map(data.repository.discussionCategories.nodes.map((c) => [c.slug, c]));
  const missing = slugs.filter((s) => !known.has(s));
  if (missing.length) throw new Error(`Unknown discussion categories for ${owner}/${name}: ${missing.join(', ')}`);
  return slugs.map((s) => known.get(s)!);
}

function toItem(node: Node, repo: string, answers: boolean): IndexItem {
  const { text, logs } = cleanIssueText(node.bodyText);
  const chunks: IndexChunk[] = [];
  for (const piece of packText([node.title, text].filter(Boolean).join('\n\n'), { maxChars: CHUNK_CHARS })) {
    chunks.push({ seq: chunks.length, kind: 'body', text: piece, logs: chunks.length === 0 ? logs : null, createdAt: node.createdAt, authorRole: 'reporter' });
  }
  if (answers && node.answer) {
    const role = roleOf(node.answer.authorAssociation, node.answer.author?.login, node.author?.login);
    for (const piece of packText(cleanIssueText(node.answer.bodyText).text, { maxChars: CHUNK_CHARS })) {
      chunks.push({ seq: chunks.length, kind: 'answer', text: piece, logs: null, createdAt: node.answer.createdAt, authorRole: role });
    }
  }
  return {
    source: 'discussion', provider: 'github', origin: repo, sourceId: String(node.number), url: node.url, title: node.title,
    audience: 'user', createdAt: node.createdAt, updatedAt: node.updatedAt,
    outcome: { closed: node.closed, isAnswered: node.isAnswered ?? false, category: node.category.slug, comments: node.comments.totalCount },
    extra: { author: node.author?.login ?? null }, chunks,
  };
}

export interface ReadDiscussionsInput { client: PaginatingClient; repo: string; options: DiscussionsConfig; raw?: RawStore; since?: Date }

/**
 * Reads the discussions of the configured categories through GraphQL, newest
 * update first. With `since`, a category stops at the first node updated before it.
 */
export async function* readDiscussions({ client, repo, options, raw, since }: ReadDiscussionsInput): AsyncGenerator<IndexItem> {
  if (!client.graphql) throw new Error('discussions need a GraphQL-capable client');
  const [owner, name] = repo.split('/');
  for (const category of await categoryIds(client, owner, name, options.categories)) {
    let after: string | null = null;
    do {
      const page: Page = await client.graphql<Page>(DISCUSSIONS_QUERY, { owner, name, categoryId: category.id, after, first: PAGE });
      let stop = false;
      for (const node of page.repository.discussions.nodes) {
        if (since && new Date(node.updatedAt) < since) { stop = true; break; }
        raw?.put({ provider: 'github', origin: repo, kind: 'discussion', id: String(node.number), updatedAt: node.updatedAt, payload: node });
        yield toItem(node, repo, options.answers);
      }
      after = !stop && page.repository.discussions.pageInfo.hasNextPage ? page.repository.discussions.pageInfo.endCursor : null;
    } while (after);
  }
}
