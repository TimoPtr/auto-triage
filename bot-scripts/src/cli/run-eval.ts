#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from '../config/load.ts';
import { createEmbedder } from '../embed/embedder.ts';
import { openDatabase } from '../store/db.ts';
import { caseFiles, readCases } from '../eval/cases.ts';
import { runEval, summaryMarkdown, type EvalMode } from '../eval/run.ts';

const DEFAULT_THRESHOLD = 0.35;
const MODES: EvalMode[] = ['production', 'oracle', 'null'];
const SPLITS = ['test', 'validation', 'train', 'all'];

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    index: { type: 'string' },
    cases: { type: 'string', multiple: true, default: [] },
    split: { type: 'string', default: 'test' },
    mode: { type: 'string', default: 'production' },
    threshold: { type: 'string' },
    out: { type: 'string' },
    'model-cache': { type: 'string', default: '.model-cache' },
    seed: { type: 'string', default: '1' },
  },
});
const seed = Number(values.seed);
const mode = values.mode as EvalMode;
if (!values.config || !values.index || !MODES.includes(mode) || !SPLITS.includes(values.split) || !Number.isInteger(seed)) {
  console.error('usage: run-eval --config <knowledge-bot.yaml> --index <knowledge.sqlite> [--cases <file-or-dir>]... [--split test|validation|train|all] [--mode production|oracle|null] [--threshold <n>] [--out <dir>] [--model-cache <dir>] [--seed 1]');
  process.exit(2);
}

try {
  const config = loadConfig(values.config);
  const targets = values.cases.length ? values.cases : config.evalCases ? [resolve(dirname(values.config), config.evalCases)] : [];
  const files = targets.flatMap(caseFiles);
  if (files.length === 0) {
    console.log('no eval cases configured');
    process.exit(0);
  }
  const all = readCases(files);
  const cases = values.split === 'all' ? all : all.filter((c) => c.split === values.split);
  const threshold = values.threshold !== undefined ? Number(values.threshold) : config.triage?.minSimilarity ?? DEFAULT_THRESHOLD;
  const embedder = createEmbedder(config.embedding, { cacheDir: values['model-cache'] });
  const db = openDatabase(values.index, { readOnly: true });
  try {
    const { results, errors, summary } = await runEval({ db, embedder, cases, mode, threshold, seed, retrieveOptions: { minSimilarity: config.triage?.minSimilarity }, log: (line) => console.error(line) });
    const out = values.out ?? join('eval-out', `${mode}-${values.split}`);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    const markdown = summaryMarkdown(summary);
    writeFileSync(join(out, 'summary.md'), markdown);
    writeFileSync(join(out, 'cases.jsonl'), results.map((r) => JSON.stringify(r)).join('\n') + (results.length ? '\n' : ''));
    writeFileSync(join(out, 'errors.jsonl'), errors.map((e) => JSON.stringify(e)).join('\n') + (errors.length ? '\n' : ''));
    console.log(markdown);
    console.error(`written to ${out}`);
  } finally {
    db.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
