// @ts-check
import { writeIndex } from '../store/writer.js';
import { FORMAT_VERSION } from '../store/db.js';

/**
 * @param {import('../providers/types.js').Provider[]} providers
 * @param {(line: string) => void} log
 */
async function* concat(providers, log) {
  for (const provider of providers) {
    let count = 0;
    for await (const item of provider.items()) {
      count += 1;
      yield item;
    }
    log(`${provider.name}: ${count} items`);
  }
}

/**
 * Builds the index file for a config from its providers.
 * @param {{ config: import('../config/types.js').Config, configHash: string, outPath: string, previousPath?: string, embedder: import('../embed/embedder.js').Embedder, providers: import('../providers/types.js').Provider[], log?: (line: string) => void }} input
 */
export function buildIndex({ config, configHash, outPath, previousPath, embedder, providers, log = () => {} }) {
  return writeIndex({
    items: concat(providers, log),
    embedder,
    outPath,
    previousPath,
    meta: { product: config.product.slug, config_hash: configHash, format_version: String(FORMAT_VERSION) },
    log,
  });
}
