// @ts-check
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep, basename, dirname, extname } from 'node:path';
import YAML from 'yaml';
import { chunkMarkdown } from '../../text/chunk.js';

/** @typedef {import('../types.js').IndexItem} IndexItem */

/** Docs carry no creation date; this sentinel keeps them eligible for every as-of query. */
export const DOCS_EPOCH = '1970-01-01T00:00:00Z';
const EXTENSIONS = new Set(['.md', '.mdx']);
const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n?/;

/**
 * @param {string} content
 * @returns {{ frontMatter: Record<string, any>, body: string }}
 */
export function splitFrontMatter(content) {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = FRONT_MATTER.exec(normalized);
  if (!match) return { frontMatter: {}, body: normalized };
  let frontMatter = {};
  try {
    frontMatter = YAML.parse(match[1]) ?? {};
  } catch {
    frontMatter = {};
  }
  return { frontMatter, body: normalized.slice(match[0].length) };
}

/**
 * @param {string} dir
 * @returns {AsyncGenerator<string>}
 */
async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (EXTENSIONS.has(extname(entry.name))) yield path;
  }
}

/**
 * @param {string} relativePath path relative to the docs root, POSIX separators
 * @param {Record<string, any>} frontMatter
 * @param {string} baseUrl
 */
export function docUrl(relativePath, frontMatter, baseUrl) {
  const base = new URL(baseUrl);
  if (typeof frontMatter.slug === 'string' && frontMatter.slug.startsWith('/')) {
    return new URL(frontMatter.slug, base.origin).toString();
  }
  const dir = dirname(relativePath) === '.' ? '' : `${dirname(relativePath)}/`;
  const file = basename(relativePath, extname(relativePath));
  const name = frontMatter.id ?? frontMatter.slug ?? file;
  const page = name === 'index' ? dir.replace(/\/$/, '') : `${dir}${name}`;
  return new URL(page, base).toString().replace(/\/$/, '');
}

/**
 * @param {string} body
 */
function firstHeading(body) {
  return /^#\s+(.+)$/m.exec(body)?.[1] ?? null;
}

/**
 * Reads markdown documentation from a local checkout as index items.
 * @param {{ repo: string, checkoutPath: string, options: import('../../config/types.js').DocsConfig }} input
 * @returns {AsyncGenerator<IndexItem>}
 */
export async function* readDocs({ repo, checkoutPath, options }) {
  const root = join(checkoutPath, options.path);
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new Error(`Docs checkout for ${repo} not found at ${root}; pass --checkout ${repo}=<path>`);
  }
  for await (const file of walk(root)) {
    const { frontMatter, body } = splitFrontMatter(await readFile(file, 'utf8'));
    if (frontMatter.draft === true || frontMatter.pagefind === false) continue;
    const rel = relative(root, file).split(sep).join('/');
    const title = frontMatter.title ?? firstHeading(body) ?? basename(file, extname(file));
    const chunks = chunkMarkdown(body).map((c, seq) => ({
      seq,
      kind: /** @type {const} */ ('section'),
      heading: c.heading,
      anchor: c.anchor,
      text: [...c.breadcrumbs, c.text].join('\n'),
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
      title: String(title),
      audience: options.audience,
      createdAt: DOCS_EPOCH,
      updatedAt: null,
      outcome: null,
      extra: { description: frontMatter.description ?? null },
      chunks,
    };
  }
}
