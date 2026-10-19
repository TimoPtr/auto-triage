#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/load.ts';
import { createEmbedder } from '../embed/embedder.ts';
import { createGitHubClient } from '../providers/github/client.ts';
import { openRawStore } from '../store/raw.ts';
import { appendItem, parseItemRef } from '../index/append.ts';
import { writeOutputs } from './index-status.ts';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    index: { type: 'string' },
    repo: { type: 'string' },
    item: { type: 'string' },
    raw: { type: 'string' },
    'model-cache': { type: 'string', default: '.model-cache' },
  },
});

if (!values.config || !values.index || !values.repo || !values.item) {
  console.error('usage: append --config <knowledge-bot.yaml> --index <knowledge.sqlite> --repo owner/repo --item issue:<n>|pull:<n> [--raw <sqlite>] [--model-cache <dir>]');
  process.exit(2);
}
const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('GITHUB_TOKEN is required');
  process.exit(2);
}

const config = loadConfig(values.config);
const ref = parseItemRef(values.item);
const embedder = createEmbedder(config.embedding, { cacheDir: values['model-cache'] });
const client = createGitHubClient({ token, log: (line) => console.log(line) });
const raw = values.raw ? openRawStore(values.raw) : undefined;

try {
  const result = await appendItem({ config, repo: values.repo, ref, indexPath: values.index, embedder, client, raw, log: (line) => console.log(line) });
  console.log(JSON.stringify(result));
  writeOutputs({ action: result.action, changed: result.changed });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
} finally {
  raw?.close();
}
