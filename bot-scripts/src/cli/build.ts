#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../config/load.ts';
import { createEmbedder } from '../embed/embedder.ts';
import { createProviders } from '../providers/registry.ts';
import { buildIndex } from '../index/build.ts';
import { openRawStore } from '../store/raw.ts';
import { createReplayFetch } from '../providers/replay.ts';
import { openDatabase, readMeta } from '../store/db.ts';
import { indexStatus } from '../index/status.ts';
import { planBuild } from '../index/plan.ts';
import { parseCheckouts, withSelf } from './checkouts.ts';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    out: { type: 'string' },
    previous: { type: 'string' },
    raw: { type: 'string' },
    checkout: { type: 'string', multiple: true, default: [] },
    self: { type: 'string' },
    'model-cache': { type: 'string', default: '.model-cache' },
    full: { type: 'boolean', default: false },
    offline: { type: 'boolean', default: false },
  },
});

if (!values.config || !values.out || (values.offline && !values.raw)) {
  console.error('usage: build --config <knowledge-bot.yaml> --out <knowledge.sqlite> [--previous <sqlite>] [--full] [--raw <sqlite>] [--offline] [--self <dir>] [--checkout owner/repo=<dir>]...');
  console.error('--offline replays the raw store instead of the network and needs --raw');
  process.exit(2);
}

const config = loadConfig(values.config);
const checkouts = withSelf(config, parseCheckouts(values.checkout), values.self);
const configHash = createHash('sha256').update(readFileSync(values.config)).digest('hex').slice(0, 12);
const embedder = createEmbedder(config.embedding, { cacheDir: values['model-cache'] });
const log = (line: string) => console.log(line);

/** Meta of the previous index when this config can serve it, else null (a full build follows). */
function previousMeta(previousPath: string | undefined, cfg: typeof config): Record<string, string> | null {
  if (!previousPath || !indexStatus({ indexPath: previousPath, config: cfg }).usable) return null;
  const db = openDatabase(previousPath, { readOnly: true });
  try {
    return readMeta(db);
  } finally {
    db.close();
  }
}
// A raw store from another schema version is moved aside: a build must not stay wedged on a restored file.
const raw = values.raw ? openRawStore(values.raw, { recreateOnMismatch: true, log }) : undefined;
const hosts = Object.fromEntries(Object.entries(config.providers.discourse ?? {}).map(([host, site]) => [host, site.categories]));
const providers = values.offline && raw
  ? createProviders(config, { fetchImpl: createReplayFetch(raw, { hosts }), checkouts, raw, offline: true })
  : createProviders(config, { githubToken: process.env.GITHUB_TOKEN, checkouts, raw, log });

try {
  const plan = planBuild({ previousMeta: previousMeta(values.previous, config), configHash, now: new Date(), full: values.full, offline: values.offline });
  const stats = await buildIndex({ config, configHash, outPath: values.out, previousPath: values.previous, embedder, providers, plan, log });
  if (raw) log(`raw store: ${raw.count()} records`);
  console.log(JSON.stringify(stats));
} finally {
  raw?.close();
}
