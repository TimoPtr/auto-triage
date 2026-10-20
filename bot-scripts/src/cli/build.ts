#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../config/load.ts';
import { createEmbedder } from '../embed/embedder.ts';
import { createProviders } from '../providers/registry.ts';
import { buildIndex } from '../index/build.ts';
import { openRawStore } from '../store/raw.ts';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    out: { type: 'string' },
    previous: { type: 'string' },
    raw: { type: 'string' },
    checkout: { type: 'string', multiple: true, default: [] },
    self: { type: 'string' },
    'model-cache': { type: 'string', default: '.model-cache' },
  },
});

if (!values.config || !values.out) {
  console.error('usage: build --config <knowledge-bot.yaml> --out <knowledge.sqlite> [--previous <sqlite>] [--raw <sqlite>] [--self <dir>] [--checkout owner/repo=<dir>]...');
  process.exit(2);
}

const checkouts = Object.fromEntries(values.checkout.map((pair) => {
  const separator = pair.indexOf('=');
  if (separator <= 0 || separator === pair.length - 1) throw new Error(`--checkout expects owner/repo=<dir>, got ${pair}`);
  return [pair.slice(0, separator), pair.slice(separator + 1)];
}));

const config = loadConfig(values.config);
// --self is the consumer's own checkout: every repository that reads code or files from a checkout and has no explicit one uses it.
if (values.self) {
  for (const [repo, repoConfig] of Object.entries(config.providers.github ?? {})) {
    if ((repoConfig.code || repoConfig.files?.length) && !checkouts[repo]) checkouts[repo] = values.self;
  }
}
const configHash = createHash('sha256').update(readFileSync(values.config)).digest('hex').slice(0, 12);
const embedder = createEmbedder(config.embedding, { cacheDir: values['model-cache'] });
const log = (line: string) => console.log(line);
// A raw store from another schema version is moved aside: a build must not stay wedged on a restored file.
const raw = values.raw ? openRawStore(values.raw, { recreateOnMismatch: true, log }) : undefined;
const providers = createProviders(config, { githubToken: process.env.GITHUB_TOKEN, checkouts, raw });

try {
  const plan = { mode: 'full' as const, since: null, reason: 'full build', fullBuiltAt: new Date().toISOString() };
  const stats = await buildIndex({ config, configHash, outPath: values.out, previousPath: values.previous, embedder, providers, plan, log });
  if (raw) log(`raw store: ${raw.count()} records`);
  console.log(JSON.stringify(stats));
} finally {
  raw?.close();
}
