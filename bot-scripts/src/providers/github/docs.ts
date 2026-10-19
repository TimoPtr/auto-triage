import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep, basename, dirname, extname } from 'node:path';
import YAML from 'yaml';
import { chunkMarkdown } from '../../text/chunk.ts';
import type { DocsConfig } from '../../config/types.ts';
import type { IndexChunk, IndexItem } from '../types.ts';

/** Docs carry no creation date; this sentinel keeps them eligible for every as-of query. */
export const DOCS_EPOCH = '1970-01-01T00:00:00Z';
const EXTENSIONS = new Set(['.md', '.mdx']);
const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n?/;

export type FrontMatter = Record<string, unknown>;

export function splitFrontMatter(content: string): { frontMatter: FrontMatter; body: string } {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = FRONT_MATTER.exec(normalized);
  if (!match) return { frontMatter: {}, body: normalized };
  let frontMatter: FrontMatter = {};
  try {
    frontMatter = (YAML.parse(match[1]) as FrontMatter | null) ?? {};
  } catch {
    frontMatter = {};
  }
  return { frontMatter, body: normalized.slice(match[0].length) };
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (EXTENSIONS.has(extname(entry.name))) yield path;
  }
}

/** The URL only when it stays on the base origin and (for relative names) under the base path. */
function onSite(candidate: string, base: URL, underBase: boolean): string | null {
  let url: URL;
  try {
    url = new URL(candidate, underBase ? base : base.origin);
  } catch {
    return null;
  }
  if (url.origin !== base.origin) return null;
  if (underBase && !url.pathname.startsWith(base.pathname)) return null;
  return url.toString().replace(/\/$/, '');
}

/**
 * Link of a page. Front matter is untrusted: a `slug` must be a site-absolute
 * path and an `id` a name under the docs base; anything else falls back to the
 * file path. The check is on the parsed URL, not the raw string, so parser
 * quirks such as `/\host` cannot point off site.
 * @param relativePath path relative to the docs root, POSIX separators
 */
export function docUrl(relativePath: string, frontMatter: FrontMatter, baseUrl: string): string {
  const base = new URL(baseUrl);
  const { slug, id } = frontMatter;
  if (typeof slug === 'string' && slug.startsWith('/')) {
    const url = onSite(slug, base, false);
    if (url) return url;
  }
  const dir = dirname(relativePath) === '.' ? '' : `${dirname(relativePath)}/`;
  const file = basename(relativePath, extname(relativePath));
  const pageOf = (name: string) => (name === 'index' ? dir.replace(/\/$/, '') : `${dir}${name}`);
  for (const name of [id, typeof slug === 'string' && !slug.startsWith('/') ? slug : null]) {
    if (typeof name !== 'string' || !name) continue;
    const url = onSite(pageOf(name), base, true);
    if (url) return url;
  }
  // A file name that cannot form an on-site link (such as `host:x.md`) links the docs root, never off site.
  return onSite(pageOf(file), base, true) ?? base.toString().replace(/\/$/, '');
}

function firstHeading(body: string): string | null {
  return /^#\s+(.+)$/m.exec(body)?.[1] ?? null;
}

export interface ReadDocsInput {
  repo: string;
  checkoutPath: string;
  options: DocsConfig;
}

/** Reads markdown documentation from a local checkout as index items. */
export async function* readDocs({ repo, checkoutPath, options }: ReadDocsInput): AsyncGenerator<IndexItem> {
  const root = join(checkoutPath, options.path);
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new Error(`Docs checkout for ${repo} not found at ${root}; pass --checkout ${repo}=<path>`);
  }
  for await (const file of walk(root)) {
    const { frontMatter, body } = splitFrontMatter(await readFile(file, 'utf8'));
    if (frontMatter.draft === true || frontMatter.pagefind === false) continue;
    const rel = relative(root, file).split(sep).join('/');
    const title = String(frontMatter.title ?? firstHeading(body) ?? basename(file, extname(file)));
    const description = typeof frontMatter.description === 'string' ? frontMatter.description : null;
    const pageHeader = [title, description].filter(Boolean).join('\n');
    const chunks: IndexChunk[] = chunkMarkdown(body).map((c, seq) => ({
      seq,
      kind: 'section',
      heading: c.heading,
      anchor: c.anchor,
      text: [seq === 0 ? pageHeader : null, ...c.breadcrumbs, c.text].filter(Boolean).join('\n'),
      logs: null,
      createdAt: DOCS_EPOCH,
    }));
    if (chunks.length === 0) continue;
    yield {
      source: 'docs',
      provider: 'github',
      origin: repo,
      sourceId: `${options.path}/${rel}`,
      url: docUrl(rel, frontMatter, options.baseUrl),
      title,
      audience: options.audience,
      createdAt: DOCS_EPOCH,
      updatedAt: null,
      outcome: null,
      extra: { description: frontMatter.description ?? null },
      chunks,
    };
  }
}
