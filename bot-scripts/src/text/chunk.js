// @ts-check

/** @typedef {{ heading: string | null, breadcrumbs: string[], anchor: string | null, text: string }} MarkdownChunk */

const FENCE = /^(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * GitHub-style anchor for a heading: lowercase, punctuation removed, spaces to dashes.
 * @param {string} text
 */
export function slugifyHeading(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/**
 * Splits markdown into heading-scoped sections, fence-aware.
 * @param {string} markdown
 * @returns {{ level: number, heading: string | null, lines: string[] }[]}
 */
function splitSections(markdown) {
  const sections = [{ level: 0, heading: /** @type {string | null} */ (null), lines: /** @type {string[]} */ ([]) }];
  let inFence = false;
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (FENCE.test(line.trim())) inFence = !inFence;
    const match = inFence ? null : HEADING.exec(line);
    if (match) {
      sections.push({ level: match[1].length, heading: match[2], lines: [] });
    } else {
      sections.at(-1)?.lines.push(line);
    }
  }
  return sections;
}

/**
 * Splits section text into paragraphs, keeping fenced blocks whole.
 * @param {string[]} lines
 */
function paragraphs(lines) {
  const out = /** @type {string[]} */ ([]);
  let current = /** @type {string[]} */ ([]);
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

/**
 * Packs paragraphs into pieces of at most maxChars, splitting an oversized paragraph on sentences.
 * @param {string[]} paras
 * @param {number} maxChars
 */
function pack(paras, maxChars) {
  const pieces = /** @type {string[]} */ ([]);
  let current = '';
  for (const para of paras) {
    const units = para.length > maxChars ? para.split(/(?<=[.!?])\s+/) : [para];
    for (const unit of units) {
      if (current && current.length + unit.length + 2 > maxChars) {
        pieces.push(current);
        current = '';
      }
      current = current ? `${current}\n\n${unit}` : unit;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * Heading-scoped chunks of a markdown document.
 * @param {string} markdown
 * @param {{ maxChars?: number, minChars?: number }} [options]
 * @returns {MarkdownChunk[]}
 */
export function chunkMarkdown(markdown, { maxChars = 2000, minChars = 300 } = {}) {
  const chunks = /** @type {MarkdownChunk[]} */ ([]);
  const trail = /** @type {{ level: number, heading: string }[]} */ ([]);
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
