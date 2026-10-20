import type { RawStore } from '../store/raw.ts';

/** The GitHub API host; every other host is replayed as a Discourse site. */
const GITHUB_HOST = 'api.github.com';
/** Topics per replayed Discourse category page, as the site serves them. */
const TOPICS_PER_PAGE = 30;
const LISTING = /^\/repos\/([^/]+\/[^/]+)\/(issues|pulls|releases)$/;
const DETAILS = /^\/repos\/([^/]+\/[^/]+)\/(issues|pulls)\/(\d+)\/(comments|files)$/;
const CATEGORY_PAGE = /^\/c\/([^/]+)\/(\d+)\.json$/;
const TOPIC = /^\/t\/(\d+)\.json$/;

export interface ReplayOptions {
  /** Configured category slugs per Discourse host, so `/site.json` lists a category no stored topic carries yet. */
  hosts?: Record<string, string[]>;
}

interface StoredIssue { issue: { state: string; updated_at: string }; comments: unknown[] }
interface StoredPull { pull: unknown; reviewComments: unknown[]; files: string[] }
interface DiscussionNode { category: { slug: string } }
interface StoredTopic { listed: { last_posted_at: string }; topic: unknown; category?: { id: number; slug: string } }
interface SiteCategory { id: number; slug: string }

const json = (body: unknown) => Response.json(body);
const notFound = () => new Response('not replayed', { status: 404 });

function githubListing(raw: RawStore, repo: string, kind: string, params: URLSearchParams): Response {
  if (kind === 'releases') return json(Array.from(raw.each('github', repo, 'release'), (r) => r.payload));
  if (kind === 'pulls') return json(Array.from(raw.each<StoredPull>('github', repo, 'pull'), (r) => r.payload.pull));
  const state = params.get('state') ?? 'open';
  const since = params.get('since');
  const issues = Array.from(raw.each<StoredIssue>('github', repo, 'issue'), (r) => r.payload.issue)
    .filter((i) => (state === 'all' || i.state === state) && (!since || i.updated_at >= since))
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  return json(issues);
}

function githubDetails(raw: RawStore, repo: string, kind: string, number: string, what: string): Response {
  if (kind === 'issues') return json(raw.get<StoredIssue>('github', repo, 'issue', number)?.payload.comments ?? []);
  const pull = raw.get<StoredPull>('github', repo, 'pull', number)?.payload;
  if (!pull) return json([]);
  return json(what === 'files' ? pull.files.map((filename) => ({ filename })) : pull.reviewComments);
}

/** The two discussion queries: categories as the stored slugs (ids equal the slugs) and pages of nodes. */
function graphql(raw: RawStore, body: string): Response {
  const { query, variables } = JSON.parse(body) as { query: string; variables: Record<string, unknown> };
  const repo = `${variables.owner}/${variables.name}`;
  const nodes = Array.from(raw.each<DiscussionNode>('github', repo, 'discussion'), (r) => r.payload);
  if (query.includes('discussionCategories')) {
    const slugs = Array.from(new Set(nodes.map((n) => n.category.slug)));
    return json({ data: { repository: { discussionCategories: { nodes: slugs.map((slug) => ({ id: slug, slug })) } } } });
  }
  if (!query.includes('discussions(')) return new Response('not replayed', { status: 400 });
  const wanted = nodes.filter((n) => n.category.slug === variables.categoryId);
  const offset = Number(variables.after ?? 0);
  const page = wanted.slice(offset, offset + Number(variables.first));
  const end = offset + page.length;
  return json({ data: { repository: { discussions: { pageInfo: { hasNextPage: end < wanted.length, endCursor: String(end) }, nodes: page } } } });
}

function siteCategories(raw: RawStore, host: string, configured: string[]): SiteCategory[] {
  const bySlug = new Map<string, SiteCategory>();
  for (const record of raw.each<StoredTopic>('discourse', host, 'topic')) {
    const category = record.payload.category;
    if (category && !bySlug.has(category.slug)) bySlug.set(category.slug, category);
  }
  configured.forEach((slug, i) => { if (!bySlug.has(slug)) bySlug.set(slug, { id: 1_000_000 + i, slug }); });
  return Array.from(bySlug.values());
}

/** Stored topics of a category, newest post first; topics stored without a category fall under the host's first configured one. */
function categoryTopics(raw: RawStore, host: string, slug: string, configured: string[]): StoredTopic['listed'][] {
  const orphansHere = configured[0] === slug;
  return Array.from(raw.each<StoredTopic>('discourse', host, 'topic'), (r) => r.payload)
    .filter((t) => (t.category ? t.category.slug === slug : orphansHere))
    .map((t) => t.listed)
    .sort((a, b) => b.last_posted_at.localeCompare(a.last_posted_at));
}

function discourse(raw: RawStore, host: string, path: string, params: URLSearchParams, configured: string[]): Response {
  if (path === '/site.json') return json({ categories: siteCategories(raw, host, configured) });
  const page = CATEGORY_PAGE.exec(path);
  if (page) {
    const topics = categoryTopics(raw, host, page[1], configured);
    const n = Number(params.get('page') ?? 0);
    const slice = topics.slice(n * TOPICS_PER_PAGE, (n + 1) * TOPICS_PER_PAGE);
    const more = (n + 1) * TOPICS_PER_PAGE < topics.length;
    return json({ topic_list: { topics: slice, ...(more ? { more_topics_url: `/c/${page[1]}/${page[2]}?page=${n + 1}` } : {}) } });
  }
  const topic = TOPIC.exec(path);
  if (topic) {
    const stored = raw.get<StoredTopic>('discourse', host, 'topic', topic[1]);
    return stored ? json(stored.payload.topic) : notFound();
  }
  return notFound();
}

/**
 * A `fetch` answering the readers' requests from the raw store: GitHub
 * listings, comments, files, the discussion queries and a Discourse site.
 * Anything not stored is a 404, so a build with it never touches the network.
 */
export function createReplayFetch(raw: RawStore, { hosts = {} }: ReplayOptions = {}): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== GITHUB_HOST) return discourse(raw, url.hostname, url.pathname, url.searchParams, hosts[url.hostname] ?? []);
    if (url.pathname === '/graphql') return graphql(raw, String(init?.body ?? '{}'));
    const listing = LISTING.exec(url.pathname);
    if (listing) return githubListing(raw, listing[1], listing[2], url.searchParams);
    const details = DETAILS.exec(url.pathname);
    if (details) return githubDetails(raw, details[1], details[2], details[3], details[4]);
    return notFound();
  };
}
