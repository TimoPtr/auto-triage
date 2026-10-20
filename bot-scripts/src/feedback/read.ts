import { existsSync, readFileSync } from 'node:fs';
import { FEEDBACK_VERSION } from './collect.ts';

/**
 * The suppressed issue numbers of a `feedback.json`. A missing, unparsable or
 * older file yields none: the cache is a hint, never a reason to stop a triage.
 */
export function readFeedback(path: string, log: (line: string) => void = () => {}): Set<number> {
  if (!existsSync(path)) { log(`no feedback file at ${path}`); return new Set(); }
  let parsed: { version?: unknown; suppressed?: unknown };
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as typeof parsed;
  } catch (error) {
    log(`ignoring unreadable feedback file ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return new Set();
  }
  if (parsed?.version !== FEEDBACK_VERSION || !Array.isArray(parsed.suppressed)) {
    log(`ignoring feedback file ${path}: not version ${FEEDBACK_VERSION}`);
    return new Set();
  }
  const numbers = (parsed.suppressed as { issue?: unknown }[]).map((s) => s?.issue).filter((n): n is number => Number.isInteger(n) && (n as number) > 0);
  return new Set(numbers);
}
