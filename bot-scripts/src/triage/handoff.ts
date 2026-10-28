import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv, type ValidateFunction } from 'ajv';
import type { RetrievalResult } from '../retrieval/retrieve.ts';

export const HANDOFF_VERSION = 1;
/** Excerpts handed to the agent; the renderer filters by audience afterwards. */
export const HANDOFF_EXCERPTS = 10;
export const EXCERPT_MAX_CHARS = 1200;
const SCHEMA_PATH = fileURLToPath(new URL('../../../schemas/handoff.json', import.meta.url));

export interface ExcerptOutcome { state: string | null; reason: string | null; fixedBy: string[]; solved: boolean | null }

/** The reason shown for a pull request that was closed without being merged. */
export const NOT_MERGED = 'not merged';

export interface Excerpt {
  id: number;
  source: string;
  origin: string;
  url: string;
  title: string;
  heading: string | null;
  date: string;
  audience: string;
  text: string;
  outcome: ExcerptOutcome | null;
  scores: { similarity: number | null; lexical: number | null; fused: number };
}

export interface HandoffIssue { number: number; title: string; body: string; logs: string | null; labels: string[]; createdAt: string }

export interface Handoff {
  version: 1;
  product: { name: string; slug: string };
  repository: string;
  issue: HandoffIssue;
  excerpts: Excerpt[];
  thresholds: { answer: number; links: number };
  /** `demote` names a suppressed issue retrieved above the floor; the renderer lowers the tier for it. */
  retrieval: { bestSimilarity: number; minSimilarity: number; indexBuiltAt: string | null; demote: { issue: number; similarity: number } | null };
}

export class HandoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandoffError';
  }
}

function outcomeOf(result: RetrievalResult, fixedBy: string[]): ExcerptOutcome | null {
  const outcome = result.outcome ?? {};
  const text = (key: string): string | null => (typeof outcome[key] === 'string' ? (outcome[key] as string) : null);
  switch (result.source) {
    case 'issue': return { state: text('state'), reason: text('stateReason'), fixedBy, solved: null };
    case 'pull': return { state: text('state'), reason: text('state') === 'closed' ? NOT_MERGED : null, fixedBy: [], solved: null };
    case 'forum': return { state: null, reason: null, fixedBy: [], solved: typeof outcome.solved === 'boolean' ? outcome.solved : null };
    default: return null;
  }
}

/** One retrieval result as the agent sees it: numbered, trimmed, with the outcome fields the renderer shows. */
export function toExcerpt(result: RetrievalResult, id: number, fixedBy: string[]): Excerpt {
  return {
    id, source: result.source, origin: result.origin, url: result.url, title: result.title, heading: result.heading,
    date: result.createdAt.slice(0, 10), audience: result.audience, text: result.text.slice(0, EXCERPT_MAX_CHARS),
    outcome: outcomeOf(result, fixedBy),
    scores: { similarity: result.scores.itemSimilarity ?? result.scores.similarity, lexical: result.scores.lexical, fused: result.scores.fused },
  };
}

let validator: ValidateFunction | null = null;

/** Checks a value against `schemas/handoff.json`; throws `HandoffError` naming the first offending path. */
export function validateHandoff(value: unknown): Handoff {
  if (!validator) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    ajv.addFormat('uri', /^https?:\/\/\S+$/);
    validator = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>);
  }
  if (!validator(value)) {
    const first = validator.errors?.[0];
    throw new HandoffError(`handoff ${first?.instancePath || '/'} ${first?.message ?? 'is invalid'}`);
  }
  return value as Handoff;
}

export function readHandoff(path: string): Handoff {
  return validateHandoff(JSON.parse(readFileSync(path, 'utf8')));
}
