import { existsSync, readFileSync } from 'node:fs';
import type { Handoff } from './handoff.ts';

/** The safe-output type gh-aw writes for the `post-triage-verdict` job. */
export const VERDICT_TYPE = 'post_triage_verdict';
export const ANSWER_MAX_CHARS = 1200;

export type Tier = 'high' | 'medium' | 'low';

export interface Verdict {
  confidence: number;
  duplicates: number[];
  related: number[];
  answer: string | null;
  component: string | null;
  /** What was dropped or chosen while parsing; shown in the run summary. */
  notes: string[];
}

export class VerdictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerdictError';
  }
}

interface AgentItem { type?: unknown; [key: string]: unknown }

/** The agent output file gh-aw hands to a custom job; a missing file reads as no items. */
export function readAgentOutput(path: string): unknown {
  if (!existsSync(path)) return { items: [] };
  return JSON.parse(readFileSync(path, 'utf8'));
}

function text(value: unknown, max = Number.POSITIVE_INFINITY): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const trimmed = String(value).trim().slice(0, max);
  return trimmed === '' ? null : trimmed;
}

/** Parses a comma or whitespace separated id list, keeping only ids of the handoff, each once, not already taken. */
function parseIds(value: unknown, field: string, handoff: Handoff, taken: Set<number>, notes: string[]): number[] {
  const known = new Set(handoff.excerpts.map((e) => e.id));
  const ids: number[] = [];
  for (const token of (text(value) ?? '').split(/[\s,]+/).filter(Boolean)) {
    const id = /^\d+$/.test(token) ? Number(token) : null;
    if (id === null || !known.has(id)) notes.push(`dropped ${field} id ${token}: not in the handoff`);
    else if (taken.has(id)) notes.push(`dropped ${field} id ${id}: already listed`);
    else { taken.add(id); ids.push(id); }
  }
  return ids;
}

/** The last `post_triage_verdict` item of the agent output, validated against the handoff. */
export function parseVerdict(agentOutput: unknown, handoff: Handoff): Verdict {
  const items = (agentOutput as { items?: unknown } | null)?.items;
  const verdicts = Array.isArray(items) ? (items as AgentItem[]).filter((i) => i && i.type === VERDICT_TYPE) : [];
  const last = verdicts.at(-1);
  if (!last) throw new VerdictError('the agent did not call post_triage_verdict');
  const confidence = Number(text(last.confidence) ?? Number.NaN);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) throw new VerdictError(`confidence must be a number from 0 to 100, got ${String(last.confidence)}`);
  const notes: string[] = verdicts.length > 1 ? [`used the last of ${verdicts.length} verdicts`] : [];
  const taken = new Set<number>();
  const duplicates = parseIds(last.duplicates, 'duplicates', handoff, taken, notes);
  const related = parseIds(last.related, 'related', handoff, taken, notes);
  return { confidence, duplicates, related, answer: text(last.answer, ANSWER_MAX_CHARS), component: text(last.component), notes };
}

/** One tier down, for a verdict that resembles a suppressed issue; low stays low. */
export function demote(tier: Tier): Tier {
  return tier === 'high' ? 'medium' : 'low';
}

export function tierOf(confidence: number, thresholds: { answer: number; links: number }): Tier {
  if (confidence >= thresholds.answer) return 'high';
  if (confidence >= thresholds.links) return 'medium';
  return 'low';
}
