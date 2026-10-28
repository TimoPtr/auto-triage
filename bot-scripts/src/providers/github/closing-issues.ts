import type { PaginatingClient } from '../types.ts';

/** Pull requests per GraphQL request; each alias is one node of the query budget. */
export const CLOSING_BATCH = 50;
/** Closing references read per pull request; more than that is never a single human action. */
const PER_PULL = 20;

interface PullNode { closingIssuesReferences: { nodes: { number: number }[] } }

/** The batched query; aliases are built from integers only, never from text. */
function buildQuery(numbers: number[]): string {
  const fields = numbers.map((n) => {
    if (!Number.isInteger(n) || n <= 0) throw new Error(`bad pull request number ${n}`);
    return `p${n}: pullRequest(number: ${n}) { closingIssuesReferences(first: ${PER_PULL}) { nodes { number } } }`;
  });
  return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(' ')} } }`;
}

/**
 * The issues GitHub itself records as closed by each pull request (the
 * sidebar's closing references, which cover keywords in the body, the commits
 * and manual links), `CLOSING_BATCH` pull requests per request. A pull request
 * the API cannot resolve is logged and left out of the map.
 */
export async function fetchClosingIssues(client: PaginatingClient, repo: string, numbers: number[], log: (line: string) => void = () => {}): Promise<Map<number, number[]>> {
  if (!client.graphqlPartial) throw new Error('closing references need a GraphQL-capable client');
  const [owner, name] = repo.split('/');
  const out = new Map<number, number[]>();
  for (let start = 0; start < numbers.length; start += CLOSING_BATCH) {
    const batch = numbers.slice(start, start + CLOSING_BATCH);
    const { data, errors } = await client.graphqlPartial<{ repository: Record<string, PullNode | null> }>(buildQuery(batch), { owner, name });
    for (const error of errors) log(`closing references: ${error.message} at ${(error.path ?? []).join('.')}`);
    for (const n of batch) {
      const node = data?.repository?.[`p${n}`] ?? null;
      if (!node) { log(`closing references: no data for pull request ${n}`); continue; }
      out.set(n, node.closingIssuesReferences.nodes.map((i) => i.number));
    }
  }
  return out;
}
