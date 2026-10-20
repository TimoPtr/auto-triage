import type { PaginatingClient } from '../providers/types.ts';
import type { RawStore } from '../store/raw.ts';

/** Issues and pull requests per GraphQL request; each alias is one node of the query budget. */
export const LINKS_BATCH = 50;
/** Timeline events and closing references read per item; more than that is never a single human action. */
const PER_ITEM = 20;
const KIND = 'links';

/** What the timeline and the closing references say about one issue or pull request. */
export interface StoredLinks { kind: 'issue' | 'pull'; duplicateOf: number[]; closes: number[]; markedAt: string | null }
export interface LinkRef { kind: 'issue' | 'pull'; number: number; updatedAt: string }
export interface FetchLinksStats { fetched: number; reused: number; requests: number }

interface Canonical { __typename: string; number?: number }
interface TimelineNode { __typename: string; createdAt: string; canonical: Canonical | null }
interface IssueNode { number: number; timelineItems: { nodes: TimelineNode[] } }
interface PullNode { number: number; closingIssuesReferences: { nodes: { number: number }[] } }
type Repository = Record<string, IssueNode | PullNode | null>;

const alias = (ref: LinkRef) => `${ref.kind === 'issue' ? 'i' : 'p'}${ref.number}`;

/** The batched query; aliases are built from integers only, never from text. */
function buildQuery(refs: LinkRef[]): string {
  const fields = refs.map((ref) => {
    if (!Number.isInteger(ref.number) || ref.number <= 0) throw new Error(`bad ${ref.kind} number ${ref.number}`);
    return ref.kind === 'issue'
      ? `${alias(ref)}: issue(number: ${ref.number}) { number timelineItems(itemTypes: [MARKED_AS_DUPLICATE_EVENT, UNMARKED_AS_DUPLICATE_EVENT], first: ${PER_ITEM}) { nodes { __typename ... on MarkedAsDuplicateEvent { createdAt canonical { __typename ... on Issue { number } ... on PullRequest { number } } } ... on UnmarkedAsDuplicateEvent { createdAt canonical { __typename ... on Issue { number } ... on PullRequest { number } } } } } }`
      : `${alias(ref)}: pullRequest(number: ${ref.number}) { number closingIssuesReferences(first: ${PER_ITEM}) { nodes { number } } }`;
  });
  return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(' ')} } }`;
}

/** Net duplicate targets after unmarks, in event order, with the instant of the last mark. */
function duplicates(nodes: TimelineNode[]): { duplicateOf: number[]; markedAt: string | null } {
  const current = new Map<number, true>();
  let markedAt: string | null = null;
  for (const node of nodes) {
    const number = node.canonical?.number;
    if (number === undefined) continue;
    if (node.__typename === 'MarkedAsDuplicateEvent') { current.set(number, true); markedAt = node.createdAt; }
    else current.delete(number);
  }
  const duplicateOf = Array.from(current.keys());
  return { duplicateOf, markedAt: duplicateOf.length ? markedAt : null };
}

function toLinks(ref: LinkRef, node: IssueNode | PullNode): StoredLinks {
  if (ref.kind === 'issue') return { kind: 'issue', ...duplicates((node as IssueNode).timelineItems.nodes), closes: [] };
  return { kind: 'pull', duplicateOf: [], closes: (node as PullNode).closingIssuesReferences.nodes.map((n) => n.number), markedAt: null };
}

/** The stored links of one issue or pull request, or null when never fetched. */
export function linksOf(raw: RawStore, repo: string, number: number): StoredLinks | null {
  return raw.get<StoredLinks>('github', repo, KIND, String(number))?.payload ?? null;
}

/**
 * Fetches the duplicate marks and closing references of the refs whose stored
 * links are stale, `LINKS_BATCH` per request, and records them in the raw
 * store under the ref's `updatedAt`. An alias the API cannot resolve is logged and skipped.
 */
export async function fetchLinks(client: PaginatingClient, repo: string, refs: LinkRef[], raw: RawStore, log: (line: string) => void = () => {}): Promise<FetchLinksStats> {
  if (!client.graphqlPartial) throw new Error('fetchLinks needs a client with graphqlPartial');
  const [owner, name] = repo.split('/');
  const stats: FetchLinksStats = { fetched: 0, reused: 0, requests: 0 };
  const stale = refs.filter((ref) => {
    const stored = raw.get<StoredLinks>('github', repo, KIND, String(ref.number));
    const fresh = stored !== null && stored.updatedAt === ref.updatedAt;
    if (fresh) stats.reused += 1;
    return !fresh;
  });
  for (let start = 0; start < stale.length; start += LINKS_BATCH) {
    const batch = stale.slice(start, start + LINKS_BATCH);
    const { data, errors } = await client.graphqlPartial<{ repository: Repository }>(buildQuery(batch), { owner, name });
    stats.requests += 1;
    for (const error of errors) log(`links: ${error.message} at ${(error.path ?? []).join('.')}`);
    for (const ref of batch) {
      const node = data?.repository?.[alias(ref)] ?? null;
      if (!node) { log(`links: no data for ${ref.kind} ${ref.number}`); continue; }
      raw.put({ provider: 'github', origin: repo, kind: KIND, id: String(ref.number), updatedAt: ref.updatedAt, payload: toLinks(ref, node) });
      stats.fetched += 1;
    }
  }
  return stats;
}
