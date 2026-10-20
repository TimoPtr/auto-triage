import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import type { SourceKind } from '../providers/types.ts';

export const SPLIT_TRAIN_PERCENT = 60;
export const SPLIT_VALIDATION_PERCENT = 20;

const SCHEMA_PATH = fileURLToPath(new URL('../../../schemas/eval-case.json', import.meta.url));
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export type Relation = 'duplicate' | 'fixed-by' | 'docs' | 'forum' | 'negative' | 'curated';
export type Split = 'train' | 'validation' | 'test';
export type Tier = 'high' | 'medium' | 'low';

export type CaseQuery =
  | { type: 'issue' | 'pull' | 'discussion' | 'forum'; number: number; origin?: string; asOf?: string }
  | { type: 'text'; text: string; asOf?: string };

export interface Expected { type: SourceKind; number?: number; url?: string; origin?: string }

/** One benchmark case; `labelSource` says which mining rule or person produced it. */
export interface EvalCase {
  id: string;
  relation: Relation;
  split: Split;
  query: CaseQuery;
  expected: Expected[];
  expectedTier: Tier;
  labelSource: string;
  verified: boolean;
}

export class EvalCaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalCaseError';
  }
}

let validator: ValidateFunction | undefined;
function validate(): ValidateFunction {
  if (!validator) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    ajv.addFormat('uri', /^https?:\/\/\S+$/);
    ajv.addFormat('date-time', DATE_TIME);
    validator = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>);
  }
  return validator;
}

function describe(error: ErrorObject): string {
  const where = error.instancePath ? error.instancePath.slice(1).replaceAll('/', '.') : '(case)';
  const extra = (error.params as { additionalProperty?: string }).additionalProperty;
  return `${where}: ${error.message}${extra ? ` (${extra})` : ''}`;
}

function parseLine(path: string, lineNumber: number, line: string): EvalCase {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new EvalCaseError(`${path}:${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const check = validate();
  if (!check(parsed)) throw new EvalCaseError(`${path}:${lineNumber}: ${(check.errors ?? []).map(describe).join('; ')}`);
  return parsed as EvalCase;
}

/** Reads and validates the cases of every file; blank lines are skipped, a repeated id is an error. */
export function readCases(paths: string[]): EvalCase[] {
  const cases: EvalCase[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
      if (!line.trim()) return;
      const evalCase = parseLine(path, index + 1, line);
      if (seen.has(evalCase.id)) throw new EvalCaseError(`${path}:${index + 1}: duplicate id ${evalCase.id}`);
      seen.add(evalCase.id);
      cases.push(evalCase);
    });
  }
  return cases;
}

/** A `.jsonl` file as is, a directory's `*.jsonl` files sorted by name, a missing path nothing. */
export function caseFiles(target: string): string[] {
  if (!existsSync(target)) return [];
  if (statSync(target).isFile()) return [target];
  return readdirSync(target).filter((name) => name.endsWith('.jsonl')).sort().map((name) => join(target, name));
}

/** Hex digest ordering keys and splits derive from; the salt re-draws them. */
export function hashOrder(key: string, salt = ''): string {
  return createHash('sha256').update(salt + key).digest('hex');
}

/** The split of a case from a salted hash of its id, so re-mining keeps the split and a new salt re-draws it. */
export function splitFor(id: string, salt = ''): Split {
  const bucket = parseInt(hashOrder(id, salt).slice(0, 8), 16) % 100;
  if (bucket < SPLIT_TRAIN_PERCENT) return 'train';
  if (bucket < SPLIT_TRAIN_PERCENT + SPLIT_VALIDATION_PERCENT) return 'validation';
  return 'test';
}
