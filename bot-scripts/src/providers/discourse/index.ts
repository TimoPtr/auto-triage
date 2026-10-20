import { createDiscourseClient } from './client.ts';
import { readTopics } from './topics.ts';
import type { DiscourseSiteConfig } from '../../config/types.ts';
import type { Provider, ReadWindow } from '../types.ts';
import type { RawStore } from '../../store/raw.ts';

export interface DiscourseProviderDeps {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<unknown>;
  now: Date;
  log?: (line: string) => void;
  raw?: RawStore;
}

/** One provider for every host under `providers.discourse`. */
export function createDiscourseProvider(sites: Record<string, DiscourseSiteConfig>, { fetchImpl, sleepImpl, now, log, raw }: DiscourseProviderDeps): Provider {
  return {
    name: 'discourse',
    async *items({ since }: ReadWindow = {}) {
      for (const [host, options] of Object.entries(sites)) {
        const client = createDiscourseClient({ host, fetchImpl, sleepImpl, requestsPerSecond: options.requestsPerSecond, log });
        yield* readTopics({ client, host, options, now, raw, since });
      }
    },
  };
}
