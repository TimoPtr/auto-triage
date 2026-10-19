import { chunkMarkdown } from '../../text/chunk.ts';
import type { ReleasesConfig } from '../../config/types.ts';
import type { IndexChunk, IndexItem, PaginatingClient } from '../types.ts';
import type { RawStore } from '../../store/raw.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

interface ApiRelease { tag_name: string; name: string | null; draft: boolean; prerelease: boolean; published_at: string | null; html_url: string; body: string | null }

export interface ReadReleasesInput { client: PaginatingClient; repo: string; options: ReleasesConfig; now?: Date; raw?: RawStore }

/** Reads release notes: which version shipped what. */
export async function* readReleases({ client, repo, options, now = new Date(), raw }: ReadReleasesInput): AsyncGenerator<IndexItem> {
  const cutoff = options.withinDays === undefined ? null : new Date(now.getTime() - options.withinDays * DAY_MS);
  for await (const element of client.paginate(`/repos/${repo}/releases`, { per_page: 100 })) {
    const release = element as ApiRelease;
    if (release.draft || !release.published_at) continue;
    if (release.prerelease && !options.includePrereleases) continue;
    if (cutoff && new Date(release.published_at) < cutoff) continue;
    const title = release.name?.trim() ? `${release.tag_name} ${release.name.trim()}` : release.tag_name;
    const chunks: IndexChunk[] = chunkMarkdown(release.body ?? '').map((c, seq) => ({
      seq, kind: 'section', heading: c.heading, anchor: c.anchor,
      text: [seq === 0 ? release.tag_name : null, ...c.breadcrumbs, c.text].filter(Boolean).join('\n'),
      logs: null, createdAt: release.published_at!,
    }));
    if (chunks.length === 0) continue;
    raw?.put({ provider: 'github', origin: repo, kind: 'release', id: release.tag_name, updatedAt: release.published_at, payload: release });
    yield {
      source: 'release', provider: 'github', origin: repo, sourceId: release.tag_name, url: release.html_url, title,
      audience: 'user', createdAt: release.published_at, updatedAt: null, outcome: { prerelease: release.prerelease }, extra: null, chunks,
    };
  }
}
