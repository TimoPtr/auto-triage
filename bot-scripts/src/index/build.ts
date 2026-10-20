import { writeIndex, type WriteStats } from '../store/writer.ts';
import { FORMAT_VERSION } from '../store/db.ts';
import type { Config } from '../config/types.ts';
import type { Embedder } from '../embed/embedder.ts';
import type { Provider, ProviderItem } from '../providers/types.ts';

const elapsedSeconds = (since: number) => ((performance.now() - since) / 1000).toFixed(1);

/** Every provider's items in turn, with a log line per provider giving its item count and wall time. */
async function* concat(providers: Provider[], log: (line: string) => void): AsyncGenerator<ProviderItem> {
  for (const provider of providers) {
    const started = performance.now();
    let count = 0;
    for await (const item of provider.items()) {
      count += 1;
      yield item;
    }
    log(`${provider.name}: ${count} items in ${elapsedSeconds(started)}s`);
  }
}

export interface BuildIndexInput {
  config: Config;
  configHash: string;
  outPath: string;
  previousPath?: string;
  embedder: Embedder;
  providers: Provider[];
  log?: (line: string) => void;
}

/** Builds the index file for a config from its providers. */
export async function buildIndex({ config, configHash, outPath, previousPath, embedder, providers, log = () => {} }: BuildIndexInput): Promise<WriteStats> {
  const started = performance.now();
  const stats = await writeIndex({
    items: concat(providers, log),
    embedder,
    outPath,
    previousPath,
    meta: { product: config.product.slug, config_hash: configHash, format_version: String(FORMAT_VERSION) },
    log,
  });
  log(`build finished in ${elapsedSeconds(started)}s`);
  return stats;
}
