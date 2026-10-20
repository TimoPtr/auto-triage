#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import { loadConfig, validateConfig } from '../config/load.ts';
import { createEmbedder } from '../embed/embedder.ts';
import { buildIndex } from '../index/build.ts';
import { planBuild } from '../index/plan.ts';
import { createProviders } from '../providers/registry.ts';
import { createReplayFetch } from '../providers/replay.ts';
import { openDatabase } from '../store/db.ts';
import { openRawStore } from '../store/raw.ts';
import { caseFiles, readCases } from '../eval/cases.ts';
import { runEval } from '../eval/run.ts';
import { bakeOffMarkdown, type BakeOffRow } from '../eval/bake-off.ts';
import { parseCheckouts, withSelf } from './checkouts.ts';
import type { Config, EmbeddingConfig } from '../config/types.ts';

const DEFAULT_THRESHOLD = 0.35;
const SPLITS = ['test', 'validation', 'train', 'all'];

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    raw: { type: 'string' },
    models: { type: 'string' },
    out: { type: 'string' },
    cases: { type: 'string', multiple: true, default: [] },
    split: { type: 'string', default: 'validation' },
    self: { type: 'string' },
    checkout: { type: 'string', multiple: true, default: [] },
    'model-cache': { type: 'string', default: '.model-cache' },
    only: { type: 'string', multiple: true, default: [] },
  },
});
if (!values.config || !values.raw || !values.models || !values.out || !SPLITS.includes(values.split)) {
  console.error('usage: bake-off --config <knowledge-bot.yaml> --raw <sqlite> --models <models.yaml> --out <dir> [--cases <file-or-dir>]... [--split validation] [--self <dir>] [--checkout owner/repo=<dir>]... [--model-cache <dir>] [--only <name>]...');
  process.exit(2);
}

interface Candidate { name: string; embedding: EmbeddingConfig }
const log = (line: string) => console.error(line);
const config = loadConfig(values.config);
const candidates = (YAML.parse(readFileSync(values.models, 'utf8')) as { models: Candidate[] }).models
  .filter((m) => values.only.length === 0 || values.only.includes(m.name));
const targets = values.cases.length ? values.cases : config.evalCases ? [resolve(dirname(values.config), config.evalCases)] : [];
const all = readCases(targets.flatMap(caseFiles));
const cases = values.split === 'all' ? all : all.filter((c) => c.split === values.split);
if (cases.length === 0) throw new Error(`no cases in split ${values.split}`);
const checkouts = withSelf(config, parseCheckouts(values.checkout), values.self);
const hosts = Object.fromEntries(Object.entries(config.providers.discourse ?? {}).map(([host, site]) => [host, site.categories]));
const threshold = config.triage?.minSimilarity ?? DEFAULT_THRESHOLD;
mkdirSync(values.out, { recursive: true });
const raw = openRawStore(values.raw);

/** Builds the candidate's index offline and runs the split through it. */
async function bake(candidate: Candidate): Promise<BakeOffRow> {
  const candidateConfig = validateConfig({ ...structuredClone(config), embedding: candidate.embedding }) as Config;
  const configHash = createHash('sha256').update(JSON.stringify(candidateConfig)).digest('hex').slice(0, 12);
  const embedder = createEmbedder(candidateConfig.embedding, { cacheDir: values['model-cache'] });
  const outPath = join(values.out!, `${candidate.name.replace(/[^A-Za-z0-9._-]/g, '_')}.sqlite`);
  const providers = createProviders(candidateConfig, { fetchImpl: createReplayFetch(raw, { hosts }), checkouts, raw, offline: true });
  const plan = planBuild({ previousMeta: null, configHash, now: new Date(), full: true, offline: true });
  const started = performance.now();
  const stats = await buildIndex({ config: candidateConfig, configHash, outPath, embedder, providers, plan, log });
  const buildSeconds = (performance.now() - started) / 1000;
  const db = openDatabase(outPath, { readOnly: true });
  try {
    const { summary } = await runEval({ db, embedder, cases, threshold, retrieveOptions: { minSimilarity: candidateConfig.triage?.minSimilarity }, log });
    log(`${candidate.name}: ${summary.run.scored} scored, ${summary.run.errors} errors, recall@5 ${summary.retrieval.all.recallAt5.toFixed(1)}`);
    return {
      name: candidate.name, modelKey: embedder.modelKey, buildSeconds, indexBytes: statSync(outPath).size, chunksPerSecond: stats.chunks / buildSeconds,
      recallAt5: summary.retrieval.all.recallAt5, mrr: summary.retrieval.all.mrr, gatePrecision: summary.gate.at.precision, gateSpecificity: summary.gate.at.specificity,
    };
  } finally {
    db.close();
  }
}

const rows: BakeOffRow[] = [];
try {
  for (const candidate of candidates) {
    log(`bake-off: ${candidate.name}`);
    try {
      rows.push(await bake(candidate));
    } catch (error) {
      rows.push({ name: candidate.name, modelKey: `${candidate.embedding.model}@${candidate.embedding.revision}`, buildSeconds: 0, indexBytes: 0, chunksPerSecond: 0, recallAt5: 0, mrr: 0, gatePrecision: null, gateSpecificity: null, skipped: error instanceof Error ? error.message : String(error) });
    }
    // rewritten after every model so a run that dies keeps its rows
    writeFileSync(join(values.out, 'bake-off.json'), JSON.stringify({ split: values.split, cases: cases.length, threshold, rows }, null, 2) + '\n');
    writeFileSync(join(values.out, 'bake-off.md'), bakeOffMarkdown(rows));
  }
} finally {
  raw.close();
}
console.log(bakeOffMarkdown(rows));
