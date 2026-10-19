export interface MarkdownChunk {
  heading: string | null;
  breadcrumbs: string[];
  anchor: string | null;
  text: string;
}

interface Section {
  level: number;
  heading: string | null;
  lines: string[];
}

const FENCE = /^(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** GitHub-style anchor for a heading: lowercase, punctuation removed, spaces to dashes. */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Splits markdown into heading-scoped sections, fence-aware. */
function splitSections(markdown: string): Section[] {
  const sections: Section[] = [{ level: 0, heading: null, lines: [] }];
  let inFence = false;
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (FENCE.test(line.trim())) inFence = !inFence;
    const match = inFence ? null : HEADING.exec(line);
    if (match) {
      sections.push({ level: match[1].length, heading: match[2], lines: [] });
    } else {
      sections[sections.length - 1].lines.push(line);
    }
  }
  return sections;
}

/** Splits section text into paragraphs, keeping fenced blocks whole. */
function paragraphs(lines: string[]): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = current.join('\n').trim();
    if (text) out.push(text);
    current = [];
  };
  for (const line of lines) {
    if (FENCE.test(line.trim())) inFence = !inFence;
    if (!inFence && line.trim() === '') flush();
    else current.push(line);
  }
  flush();
  return out;
}

/** Splits one oversized line into slices of at most maxChars. */
function hardSlice(line: string, maxChars: number): string[] {
  const slices: string[] = [];
  for (let start = 0; start < line.length; start += maxChars) slices.push(line.slice(start, start + maxChars));
  return slices;
}

/**
 * Groups the lines of a paragraph into units of at most maxChars, keeping the
 * original line breaks. Tables and lists have no sentence boundaries, so this
 * is the fallback that keeps them whole per row.
 */
function lineGroups(paragraph: string, maxChars: number): string[] {
  const groups: string[] = [];
  let current = '';
  for (const line of paragraph.split('\n')) {
    for (const piece of hardSlice(line, maxChars)) {
      if (current && current.length + piece.length + 1 > maxChars) {
        groups.push(current);
        current = '';
      }
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  if (current) groups.push(current);
  return groups;
}

/** Splits a paragraph that exceeds maxChars: on sentences when every sentence fits, else on lines. */
function splitOversized(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) return [paragraph];
  const sentences = paragraph.split(/(?<=[.!?])\s+/);
  if (sentences.length > 1 && sentences.every((s) => s.length <= maxChars)) return sentences;
  return lineGroups(paragraph, maxChars);
}

/** Packs paragraphs into pieces of at most maxChars. */
function pack(paras: string[], maxChars: number): string[] {
  const pieces: string[] = [];
  let current = '';
  for (const unit of paras.flatMap((para) => splitOversized(para, maxChars))) {
    if (current && current.length + unit.length + 2 > maxChars) {
      pieces.push(current);
      current = '';
    }
    current = current ? `${current}\n\n${unit}` : unit;
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * Pieces of at most maxChars from free text with no headings, such as an issue
 * body or a comment. Fenced blocks stay whole unless they alone exceed the cap.
 */
export function packText(text: string, { maxChars = 2000 }: { maxChars?: number } = {}): string[] {
  if (!(maxChars >= 1)) throw new Error(`packText: maxChars must be at least 1, got ${maxChars}`);
  return pack(paragraphs(text.replace(/\r\n/g, '\n').split('\n')), maxChars);
}

/** Heading-scoped chunks of a markdown document. */
export function chunkMarkdown(markdown: string, { maxChars = 2000, minChars = 300 }: { maxChars?: number; minChars?: number } = {}): MarkdownChunk[] {
  const chunks: MarkdownChunk[] = [];
  const trail: { level: number; heading: string }[] = [];
  for (const section of splitSections(markdown)) {
    if (section.heading !== null) {
      while (trail.length && trail[trail.length - 1].level >= section.level) trail.pop();
      trail.push({ level: section.level, heading: section.heading });
    }
    const breadcrumbs = trail.map((t) => t.heading);
    // A level-1 heading is the page title: its section is addressed by the page URL itself.
    const anchor = section.heading === null || section.level === 1 ? null : slugifyHeading(section.heading);
    const sectionStart = chunks.length;
    for (const text of pack(paragraphs(section.lines), maxChars)) {
      const previous = chunks.at(-1);
      const sameSection = chunks.length > sectionStart;
      if (previous && sameSection && text.length < minChars && previous.text.length + text.length + 2 <= maxChars) {
        previous.text = `${previous.text}\n\n${text}`;
      } else {
        chunks.push({ heading: section.heading, breadcrumbs, anchor, text });
      }
    }
  }
  return chunks;
}
