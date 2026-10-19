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
    'model-cache': { type: 'string', default: '.model-cache' },
  },
});

if (!values.config || !values.out) {
  console.error('usage: build --config <knowledge-bot.yaml> --out <knowledge.sqlite> [--previous <sqlite>] [--raw <sqlite>] [--checkout owner/repo=<dir>]...');
  process.exit(2);
}

const checkouts = Object.fromEntries(values.checkout.map((pair) => {
  const separator = pair.indexOf('=');
  if (separator <= 0 || separator === pair.length - 1) throw new Error(`--checkout expects owner/repo=<dir>, got ${pair}`);
  return [pair.slice(0, separator), pair.slice(separator + 1)];
}));

const config = loadConfig(values.config);
const configHash = createHash('sha256').update(readFileSync(values.config)).digest('hex').slice(0, 12);
const embedder = createEmbedder(config.embedding, { cacheDir: values['model-cache'] });
const raw = values.raw ? openRawStore(values.raw) : undefined;
const providers = createProviders(config, { githubToken: process.env.GITHUB_TOKEN, checkouts, raw });
const log = (line: string) => console.log(line);

try {
  const stats = await buildIndex({ config, configHash, outPath: values.out, previousPath: values.previous, embedder, providers, log });
  if (raw) log(`raw store: ${raw.count()} records`);
  console.log(JSON.stringify(stats));
} finally {
  raw?.close();
}
