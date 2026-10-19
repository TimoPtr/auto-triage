#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadConfig, ConfigError } from '../config/load.ts';
import { modelKeyOf } from '../embed/embedder.ts';
import { writeOutputs } from './index-status.ts';
import type { Config } from '../config/types.ts';

const GITHUB_KINDS = ['issues', 'pulls', 'discussions', 'releases', 'docs', 'code', 'files'] as const;

export interface ConfigSummary { slug: string; modelKey: string; sources: string[] }

/** The facts a CI job prints about a config: product slug, model key and every source as `provider:origin[:kind]`. */
export function summarizeConfig(config: Config): ConfigSummary {
  const sources: string[] = [];
  for (const [repo, repoConfig] of Object.entries(config.providers.github ?? {})) {
    for (const kind of GITHUB_KINDS) if (repoConfig[kind]) sources.push(`github:${repo}:${kind}`);
  }
  for (const host of Object.keys(config.providers.discourse ?? {})) sources.push(`discourse:${host}`);
  return { slug: config.product.slug, modelKey: modelKeyOf(config.embedding), sources };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({ options: { config: { type: 'string' } } });
  if (!values.config) {
    console.error('usage: validate-config --config <knowledge-bot.yaml>');
    process.exit(2);
  }
  try {
    const summary = summarizeConfig(loadConfig(values.config));
    console.log(JSON.stringify(summary));
    writeOutputs({ slug: summary.slug, 'model-key': summary.modelKey });
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : String(error));
    process.exit(1);
  }
}
