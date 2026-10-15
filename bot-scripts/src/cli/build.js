#!/usr/bin/env node
// @ts-check
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../config/load.js';
import { createEmbedder } from '../embed/embedder.js';
import { createProviders } from '../providers/registry.js';
import { buildIndex } from '../index/build.js';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    out: { type: 'string' },
    previous: { type: 'string' },
    checkout: { type: 'string', multiple: true, default: [] },
    'model-cache': { type: 'string', default: '.model-cache' },
  },
});

if (!values.config || !values.out) {
  console.error('usage: build --config <knowledge-bot.yaml> --out <knowledge.sqlite> [--previous <sqlite>] [--checkout owner/repo=<dir>]...');
  process.exit(2);
}

const checkouts = Object.fromEntries(values.checkout.map((pair) => {
  const [repo, dir] = pair.split('=');
  if (!repo || !dir) throw new Error(`--checkout expects owner/repo=<dir>, got ${pair}`);
  return [repo, dir];
}));

const config = loadConfig(values.config);
const configHash = createHash('sha256').update(readFileSync(values.config)).digest('hex').slice(0, 12);
const embedder = createEmbedder(config.embedding, { cacheDir: values['model-cache'] });
const providers = createProviders(config, { githubToken: process.env.GITHUB_TOKEN, checkouts });
const log = (/** @type {string} */ line) => console.log(line);

const stats = await buildIndex({ config, configHash, outPath: values.out, previousPath: values.previous, embedder, providers, log });
console.log(JSON.stringify(stats));
