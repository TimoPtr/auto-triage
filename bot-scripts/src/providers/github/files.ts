import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { chunkMarkdown } from '../../text/chunk.ts';
import { DOCS_EPOCH, splitFrontMatter } from './docs.ts';
import type { FileConfig } from '../../config/types.ts';
import type { IndexChunk, IndexItem } from '../types.ts';

/** String resources per chunk: enough context for a lookup, well under the chunk size. */
const STRINGS_PER_CHUNK = 40;
const STRING_ENTRY = /<string\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/string>/g;
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" };

function decode(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\\n/g, '\n')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .trim();
}

/** Every `<string name="k">text</string>` of an Android resource file, entities and escapes decoded. */
export function parseStrings(xml: string): { key: string; text: string }[] {
  return Array.from(xml.matchAll(STRING_ENTRY), (m) => ({ key: m[1], text: decode(m[2]) }));
}

function blobUrl(repo: string, ref: string, rel: string): string {
  return `https://github.com/${repo}/blob/${ref}/${rel}`;
}

function stringsItem(repo: string, rel: string, xml: string, ref: string, audience: FileConfig['audience']): IndexItem {
  const entries = parseStrings(xml);
  const chunks: IndexChunk[] = [];
  for (let i = 0; i < entries.length; i += STRINGS_PER_CHUNK) {
    const group = entries.slice(i, i + STRINGS_PER_CHUNK);
    chunks.push({ seq: chunks.length, kind: 'section', heading: group[0].key, text: group.map((e) => `${e.key}: ${e.text}`).join('\n'), logs: null, createdAt: DOCS_EPOCH });
  }
  return {
    source: 'file', provider: 'github', origin: repo, sourceId: rel, url: blobUrl(repo, ref, rel), title: basename(rel), audience,
    createdAt: DOCS_EPOCH, updatedAt: null, outcome: null, extra: { kind: 'strings', count: entries.length }, chunks,
  };
}

async function* markdownFiles(root: string, rel: string): AsyncGenerator<string> {
  const info = await stat(root);
  if (info.isFile()) {
    yield rel;
    return;
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const childRel = `${rel}/${entry.name}`;
    if (entry.isDirectory()) yield* markdownFiles(join(root, entry.name), childRel);
    else if (/\.mdx?$/.test(entry.name)) yield childRel;
  }
}

function markdownItem(repo: string, rel: string, content: string, ref: string, audience: FileConfig['audience']): IndexItem | null {
  const { frontMatter, body } = splitFrontMatter(content);
  const title = String(frontMatter.title ?? /^#\s+(.+)$/m.exec(body)?.[1] ?? basename(rel));
  const chunks: IndexChunk[] = chunkMarkdown(body).map((c, seq) => ({
    seq, kind: 'section', heading: c.heading, anchor: c.anchor,
    text: [seq === 0 ? title : null, ...c.breadcrumbs, c.text].filter(Boolean).join('\n'), logs: null, createdAt: DOCS_EPOCH,
  }));
  if (chunks.length === 0) return null;
  return {
    source: 'file', provider: 'github', origin: repo, sourceId: rel, url: blobUrl(repo, ref, rel), title, audience,
    createdAt: DOCS_EPOCH, updatedAt: null, outcome: null, extra: { kind: 'markdown' }, chunks,
  };
}

export interface ReadFilesInput { repo: string; checkoutPath: string; entries: FileConfig[]; ref: string }

/** Reads configured files of the consumer checkout: string resources and markdown trees. */
export async function* readFiles({ repo, checkoutPath, entries, ref }: ReadFilesInput): AsyncGenerator<IndexItem> {
  for (const entry of entries) {
    const full = join(checkoutPath, entry.path);
    if (!(await stat(full).catch(() => null))) throw new Error(`Configured file ${entry.path} not found in the checkout of ${repo}`);
    if (entry.kind === 'strings') {
      yield stringsItem(repo, entry.path, await readFile(full, 'utf8'), ref, entry.audience);
    } else {
      for await (const rel of markdownFiles(full, entry.path)) {
        const item = markdownItem(repo, rel, await readFile(join(checkoutPath, rel), 'utf8'), ref, entry.audience);
        if (item) yield item;
      }
    }
  }
}
