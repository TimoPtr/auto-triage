import type { Provider, ProviderItem, ReadWindow } from '../providers/types.ts';

export const elapsedSeconds = (since: number) => ((performance.now() - since) / 1000).toFixed(1);

/** Every provider's items in turn, with a log line per provider giving its item count and wall time. */
export async function* concat(providers: Provider[], log: (line: string) => void, window: ReadWindow = {}): AsyncGenerator<ProviderItem> {
  for (const provider of providers) {
    const started = performance.now();
    let count = 0;
    for await (const item of provider.items(window)) {
      count += 1;
      yield item;
    }
    log(`${provider.name}: ${count} items in ${elapsedSeconds(started)}s`);
  }
}
