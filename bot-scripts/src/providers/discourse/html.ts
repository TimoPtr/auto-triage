const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const MAX_CODE_POINT = 0x10ffff;
const REPLACEMENT = '\uFFFD';

/** The character of a numeric entity; a code point outside Unicode or in the surrogate range is replaced, never thrown on. */
function numericEntity(code: string): string {
  const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
  if (!Number.isFinite(value) || value > MAX_CODE_POINT || (value >= 0xd800 && value <= 0xdfff)) return REPLACEMENT;
  return String.fromCodePoint(value);
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') return numericEntity(code);
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** Plain text from Discourse "cooked" HTML: paragraphs separated by blank lines, code fenced. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, code: string) => `\n\`\`\`\n${code.replace(/\n$/, '')}\n\`\`\`\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
