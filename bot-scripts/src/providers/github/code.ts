import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { packText } from '../../text/chunk.ts';
import type { CodeConfig } from '../../config/types.ts';
import type { IndexChunk, IndexItem } from '../types.ts';
import { DOCS_EPOCH } from './docs.ts';

const CHUNK_CHARS = 2000;
/** String keys listed per declaration; a sensor manager can reference dozens, which must not eat the chunk budget. */
const MAX_TAIL_KEYS = 20;
/** Longest `path\npackage` header; a longer one keeps its tail, where the file name is. */
const MAX_HEADER_CHARS = 200;
const DECLARATION = /^(?:(?:public|internal|private|protected|open|abstract|sealed|data|enum|annotation|value|inline|suspend|override|operator|infix|expect|actual|const|external|lateinit)\s+)*(?:class|interface|object|fun|val|var|typealias)\b\s*(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)/;
const KDOC_OR_ANNOTATION = /^(\s*\/\*\*|\s*\*|\s*\*\/|\s*@\w)/;
const STRING_KEY = /\b(?:R|commonR)\.string\.(\w+)/g;

const GLOB_TOKEN = /\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/g;

/** Regular expression for a glob relative to the checkout root; supports `**`, `*` and `?`. One pass, so emitted regex text is never re-read. */
export function globToRegExp(glob: string): RegExp {
  const pattern = glob.replace(GLOB_TOKEN, (token) => {
    if (token === '**/') return '(?:.*/)?';
    if (token === '**') return '.*';
    if (token === '*') return '[^/]*';
    if (token === '?') return '[^/]';
    return `\\${token}`;
  });
  return new RegExp(`^${pattern}$`);
}

/** Splits a Kotlin file into top-level declarations, each with the KDoc and annotations above it. */
export function splitDeclarations(source: string): { name: string; text: string }[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const starts: { index: number; name: string }[] = [];
  lines.forEach((line, index) => {
    if (/^\s/.test(line)) return;
    const match = DECLARATION.exec(line);
    if (match) starts.push({ index, name: match[1] });
  });
  return starts.map((start, i) => {
    let from = start.index;
    while (from > 0 && KDOC_OR_ANNOTATION.test(lines[from - 1])) from -= 1;
    const to = i + 1 < starts.length ? starts[i + 1].index : lines.length;
    let end = to;
    while (end > from && (lines[end - 1].trim() === '' || KDOC_OR_ANNOTATION.test(lines[end - 1]))) end -= 1;
    return { name: start.name, text: lines.slice(from, end).join('\n').trim() };
  }).filter((d) => d.text);
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

function symbolChunks(source: string, header: string): IndexChunk[] {
  const chunks: IndexChunk[] = [];
  for (const decl of splitDeclarations(source)) {
    const keys = Array.from(new Set(Array.from(decl.text.matchAll(STRING_KEY), (m) => m[1]))).slice(0, MAX_TAIL_KEYS);
    const tail = keys.length ? `\nstrings: ${keys.join(', ')}` : '';
    for (const piece of packText(decl.text, { maxChars: CHUNK_CHARS - header.length - tail.length - 2 })) {
      chunks.push({ seq: chunks.length, kind: 'symbol', heading: decl.name, text: `${header}\n${piece}${tail}`, logs: null, createdAt: DOCS_EPOCH });
    }
  }
  return chunks;
}

export interface ReadCodeInput { repo: string; checkoutPath: string; options: CodeConfig }

/** Reads source files as one item per file and one chunk per top-level declaration. */
export async function* readCode({ repo, checkoutPath, options }: ReadCodeInput): AsyncGenerator<IndexItem> {
  const include = options.include.map(globToRegExp);
  const exclude = options.exclude.map(globToRegExp);
  for await (const file of walk(checkoutPath)) {
    const rel = relative(checkoutPath, file).split(sep).join('/');
    if (!include.some((r) => r.test(rel)) || exclude.some((r) => r.test(rel))) continue;
    const source = await readFile(file, 'utf8');
    const pkg = /^package\s+([\w.]+)/m.exec(source)?.[1] ?? null;
    const fullHeader = [rel, pkg ? `package ${pkg}` : null].filter(Boolean).join('\n');
    const header = fullHeader.length <= MAX_HEADER_CHARS ? fullHeader : `…${fullHeader.slice(fullHeader.length - MAX_HEADER_CHARS + 1)}`;
    const chunks = symbolChunks(source, header);
    if (chunks.length === 0) continue;
    yield {
      source: 'code', provider: 'github', origin: repo, sourceId: rel, url: `https://github.com/${repo}/blob/${options.ref}/${rel}`,
      title: rel.split('/').pop() ?? rel, audience: options.audience, createdAt: DOCS_EPOCH, updatedAt: null, outcome: null, extra: { package: pkg }, chunks,
    };
  }
}
