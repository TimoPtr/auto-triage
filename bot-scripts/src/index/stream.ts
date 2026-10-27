import type { Provider, ProviderItem, ReadWindow } from '../providers/types.ts';
import { throttle } from '../log/progress.ts';

export const elapsedSeconds = (since: number, at: number = performance.now()) => ((at - since) / 1000).toFixed(1);

export interface ConcatOptions { now?: () => number }

/** Every provider's items in turn, with a progress line per minute and a final line per provider giving its item count and wall time. */
export async function* concat(providers: Provider[], log: (line: string) => void, window: ReadWindow = {}, { now = () => performance.now() }: ConcatOptions = {}): AsyncGenerator<ProviderItem> {
  for (const provider of providers) {
    const started = now();
    const tick = throttle(undefined, now);
    let count = 0;
    for await (const item of provider.items(window)) {
      count += 1;
      yield item;
      tick(() => log(`${provider.name}: ${count} items so far, ${elapsedSeconds(started, now())}s elapsed`));
    }
    log(`${provider.name}: ${count} items in ${elapsedSeconds(started, now())}s`);
  }
}
