import { writeIndex, type WriteStats } from '../store/writer.ts';
import { FORMAT_VERSION } from '../store/db.ts';
import { incrementalBuild } from './incremental.ts';
import { concat, elapsedSeconds } from './stream.ts';
import type { BuildPlan } from './plan.ts';
import type { Config } from '../config/types.ts';
import type { Embedder } from '../embed/embedder.ts';
import type { Provider } from '../providers/types.ts';

export interface BuildIndexInput {
  config: Config;
  configHash: string;
  outPath: string;
  previousPath?: string;
  embedder: Embedder;
  providers: Provider[];
  plan: BuildPlan;
  log?: (line: string) => void;
}

/** Builds the index file for a config from its providers, in full or incrementally as the plan says. */
export async function buildIndex({ config, configHash, outPath, previousPath, embedder, providers, plan, log = () => {} }: BuildIndexInput): Promise<WriteStats> {
  const started = performance.now();
  log(`build mode: ${plan.mode} (${plan.reason})`);
  const meta = {
    product: config.product.slug, config_hash: configHash, format_version: String(FORMAT_VERSION),
    started_at: new Date().toISOString(), full_built_at: plan.fullBuiltAt ?? '',
  };
  const stats = plan.mode === 'incremental' && plan.since && previousPath
    ? await incrementalBuild({ previousPath, outPath, providers, since: plan.since, embedder, meta, log })
    : await writeIndex({ items: concat(providers, log), embedder, outPath, previousPath, meta, log });
  log(`build finished in ${elapsedSeconds(started)}s`);
  return stats;
}
