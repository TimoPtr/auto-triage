const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}\-._:/]*/gu;
const TRAILING_PUNCTUATION = /[-._:/]+$/;
/** Distinct tokens kept from a question: an issue body is untrusted and can be arbitrarily long. */
const MAX_TOKENS = 128;

/**
 * FTS5 query for a free-text question: each token quoted, joined with OR, so
 * user text can never be parsed as FTS5 syntax. Tokens are prefix matches
 * (`"reboot"*`) because the index tokenizer keeps sentence punctuation glued
 * to words (`reboot.`, `EntityWidget:`), which an exact token would miss. Only the
 * first distinct tokens are kept, so the query stays bounded whatever the body length.
 */
export function toFtsQuery(question: string): string | null {
  const tokens = Array.from(question.toLowerCase().matchAll(TOKEN), (m) => m[0].replace(/"/g, '').replace(TRAILING_PUNCTUATION, ''))
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return null;
  return Array.from(new Set(tokens)).slice(0, MAX_TOKENS).map((t) => `"${t}"*`).join(' OR ');
}
