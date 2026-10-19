import type { DatabaseSync } from 'node:sqlite';
import type { RankedList } from './rrf.ts';

export interface LiveForumOptions {
  host: string;
  categorySlug: string;
  question: string;
  fetchImpl?: typeof fetch;
  weight?: number;
  limit?: number;
  log?: (line: string) => void;
}

/** Ranked list of indexed forum chunks from a live Discourse search, for topics newer than the index. */
export async function liveForumList(db: DatabaseSync, { host, categorySlug, question, fetchImpl = fetch, weight = 0.5, limit = 10, log = () => {} }: LiveForumOptions): Promise<RankedList> {
  const url = `https://${host}/search.json?q=${encodeURIComponent(`${question} #${categorySlug}`)}`;
  let topics: { id: number }[] = [];
  try {
    const response = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'home-assistant-auto-triage' } });
    if (!response.ok) throw new Error(`status ${response.status}`);
    topics = ((await response.json()) as { topics?: { id: number }[] }).topics ?? [];
  } catch (error) {
    log(`live forum search failed: ${error instanceof Error ? error.message : String(error)}`);
    return { weight, ids: [] };
  }
  const lookup = db.prepare(`SELECT c.id FROM items i JOIN chunks c ON c.item_id = i.id
    WHERE i.provider = 'discourse' AND i.origin = ? AND i.source_id = ? ORDER BY c.seq LIMIT 1`);
  const ids: number[] = [];
  for (const topic of topics.slice(0, limit)) {
    const row = lookup.get(host, String(topic.id)) as { id: number } | undefined;
    if (row) ids.push(Number(row.id));
  }
  return { weight, ids };
}
