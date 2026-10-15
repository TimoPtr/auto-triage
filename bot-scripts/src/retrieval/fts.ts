const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}\-._:/]*/gu;
const TRAILING_PUNCTUATION = /[-._:/]+$/;

/**
 * FTS5 query for a free-text question: each token quoted, joined with OR, so
 * user text can never be parsed as FTS5 syntax. Tokens are prefix matches
 * (`"reboot"*`) because the index tokenizer keeps sentence punctuation glued
 * to words (`reboot.`, `EntityWidget:`), which an exact token would miss.
 */
export function toFtsQuery(question: string): string | null {
  const tokens = Array.from(question.toLowerCase().matchAll(TOKEN), (m) => m[0].replace(/"/g, '').replace(TRAILING_PUNCTUATION, ''))
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return null;
  return Array.from(new Set(tokens), (t) => `"${t}"*`).join(' OR ');
}
