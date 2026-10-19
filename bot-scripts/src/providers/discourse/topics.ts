import { htmlToText } from './html.ts';
import { packText } from '../../text/chunk.ts';
import type { DiscourseSiteConfig } from '../../config/types.ts';
import type { IndexChunk, IndexItem } from '../types.ts';
import type { DiscourseClient } from './client.ts';
import type { RawStore } from '../../store/raw.ts';

const CHUNK_CHARS = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface SiteCategory { id: number; slug: string }
interface ListTopic { id: number; title: string; slug: string; posts_count: number; views: number; like_count: number; created_at: string; last_posted_at: string; closed: boolean; has_accepted_answer: boolean; tags: string[] }
interface TopicList { topic_list: { more_topics_url?: string; topics: ListTopic[] } }
interface Post { post_number: number; cooked: string; created_at: string; username: string }
interface Topic { accepted_answer?: { post_number: number } | null; post_stream: { posts: Post[] } }

async function resolveCategories(client: DiscourseClient, wanted: string[]): Promise<SiteCategory[]> {
  const site = await client.getJson<{ categories: SiteCategory[] }>('/site.json');
  const bySlug = new Map(site.categories.map((c) => [c.slug, c]));
  const byId = new Map(site.categories.map((c) => [String(c.id), c]));
  const missing = wanted.filter((w) => !bySlug.has(w) && !byId.has(w));
  if (missing.length) throw new Error(`Unknown Discourse categories: ${missing.join(', ')}`);
  return wanted.map((w) => bySlug.get(w) ?? byId.get(w)!);
}

/** Pages a category list until the site stops offering a next page or repeats one. */
async function* listTopics(client: DiscourseClient, category: SiteCategory): AsyncGenerator<ListTopic> {
  let page = 0;
  let previousNext: string | undefined;
  for (;;) {
    const list = await client.getJson<TopicList>(`/c/${category.slug}/${category.id}.json?page=${page}`);
    yield* list.topic_list.topics;
    const next = list.topic_list.more_topics_url;
    if (!next || next === previousNext) return;
    previousNext = next;
    page += 1;
  }
}

/** The topic with its posts: from the raw store when the last post did not move, else fetched and recorded. */
async function loadTopic(client: DiscourseClient, host: string, listed: ListTopic, raw?: RawStore): Promise<Topic> {
  const stored = raw?.get<{ topic: Topic }>('discourse', host, 'topic', String(listed.id));
  if (stored && stored.updatedAt === listed.last_posted_at) return stored.payload.topic;
  const topic = await client.getJson<Topic>(`/t/${listed.id}.json`);
  raw?.put({ provider: 'discourse', origin: host, kind: 'topic', id: String(listed.id), updatedAt: listed.last_posted_at, payload: { listed, topic } });
  return topic;
}

async function answerText(client: DiscourseClient, topic: Topic, id: number): Promise<{ text: string; createdAt: string } | null> {
  const number = topic.accepted_answer?.post_number;
  if (!number) return null;
  const post = topic.post_stream.posts.find((p) => p.post_number === number);
  if (post) return { text: htmlToText(post.cooked), createdAt: post.created_at };
  const raw = await client.getJson<string>(`/raw/${id}/${number}`).catch(() => null);
  return raw ? { text: String(raw), createdAt: topic.post_stream.posts[0]?.created_at ?? '' } : null;
}

function keep(listed: ListTopic, options: DiscourseSiteConfig, cutoff: Date | null): boolean {
  if (options.tags.length && !listed.tags.some((t) => options.tags.includes(t))) return false;
  if (cutoff && new Date(listed.last_posted_at) < cutoff) return false;
  if (options.solvedOnly && !listed.has_accepted_answer) return false;
  return true;
}

function toItem(host: string, category: SiteCategory, listed: ListTopic, chunks: IndexChunk[]): IndexItem {
  return {
    source: 'forum', provider: 'discourse', origin: host, sourceId: String(listed.id), url: `https://${host}/t/${listed.slug}/${listed.id}`, title: listed.title,
    audience: 'user', createdAt: listed.created_at, updatedAt: listed.last_posted_at,
    outcome: { solved: listed.has_accepted_answer, closed: listed.closed, tags: listed.tags, views: listed.views, likeCount: listed.like_count, postsCount: listed.posts_count },
    extra: { category: category.slug }, chunks,
  };
}

export interface ReadTopicsInput { client: DiscourseClient; host: string; options: DiscourseSiteConfig; now?: Date; raw?: RawStore }

/** Reads the topics of the configured categories as forum items with their accepted answer. */
export async function* readTopics({ client, host, options, now = new Date(), raw }: ReadTopicsInput): AsyncGenerator<IndexItem> {
  const cutoff = options.closedWithinDays === undefined ? null : new Date(now.getTime() - options.closedWithinDays * DAY_MS);
  const seen = new Set<number>();
  for (const category of await resolveCategories(client, options.categories)) {
    for await (const listed of listTopics(client, category)) {
      if (seen.has(listed.id)) continue;
      seen.add(listed.id);
      if (!keep(listed, options, cutoff)) continue;
      const topic = await loadTopic(client, host, listed, raw);
      const first = topic.post_stream.posts[0];
      const chunks: IndexChunk[] = [];
      for (const piece of packText([listed.title, htmlToText(first?.cooked ?? '')].filter(Boolean).join('\n\n'), { maxChars: CHUNK_CHARS })) {
        chunks.push({ seq: chunks.length, kind: 'body', text: piece, logs: null, createdAt: listed.created_at, authorRole: 'reporter' });
      }
      const answer = options.acceptedAnswers ? await answerText(client, topic, listed.id) : null;
      if (answer) for (const piece of packText(answer.text, { maxChars: CHUNK_CHARS })) {
        chunks.push({ seq: chunks.length, kind: 'answer', text: piece, logs: null, createdAt: answer.createdAt, authorRole: 'user' });
      }
      if (chunks.length === 0) continue;
      yield toItem(host, category, listed, chunks);
    }
  }
}
