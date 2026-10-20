#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { compareRuns, type CaseResult } from '../eval/metrics.ts';

/** Exit code when run B regressed against run A, so a workflow can gate on it. */
const REGRESSION_EXIT = 3;

const { values, positionals } = parseArgs({ allowPositionals: true, options: { json: { type: 'boolean', default: false }, seed: { type: 'string', default: '1' } } });
if (positionals.length !== 2) {
  console.error('usage: compare-eval <a/cases.jsonl> <b/cases.jsonl> [--json] [--seed 1]');
  process.exit(2);
}
const read = (path: string): CaseResult[] => readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as CaseResult);
const comparison = compareRuns(read(positionals[0]), read(positionals[1]), { seed: Number(values.seed) });
if (values.json) console.log(JSON.stringify(comparison, null, 2));
else {
  const sign = comparison.deltaRecallAt5 >= 0 ? '+' : '';
  console.log(`${comparison.n} paired cases, recall@5 ${sign}${comparison.deltaRecallAt5.toFixed(1)} points (95% CI ${comparison.ci95[0].toFixed(1)} to ${comparison.ci95[1].toFixed(1)})${comparison.regression ? ': REGRESSION' : ''}`);
}
process.exit(comparison.regression ? REGRESSION_EXIT : 0);
