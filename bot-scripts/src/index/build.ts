import { writeIndex, type WriteStats } from '../store/writer.ts';
import { FORMAT_VERSION } from '../store/db.ts';
import type { Config } from '../config/types.ts';
import type { Embedder } from '../embed/embedder.ts';
import type { IndexItem, Provider } from '../providers/types.ts';

async function* concat(providers: Provider[], log: (line: string) => void): AsyncGenerator<IndexItem> {
  for (const provider of providers) {
    let count = 0;
    for await (const item of provider.items()) {
      count += 1;
      yield item;
    }
    log(`${provider.name}: ${count} items`);
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
export function buildIndex({ config, configHash, outPath, previousPath, embedder, providers, log = () => {} }: BuildIndexInput): Promise<WriteStats> {
  return writeIndex({
    items: concat(providers, log),
    embedder,
    outPath,
    previousPath,
    meta: { product: config.product.slug, config_hash: configHash, format_version: String(FORMAT_VERSION) },
    log,
  });
}
