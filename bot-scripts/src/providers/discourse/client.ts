import { setTimeout as sleep } from 'node:timers/promises';

const BACKOFF_MS = [1000, 2000, 4000];

export interface DiscourseClient { getJson<T>(path: string): Promise<T> }

export interface DiscourseClientOptions {
  host: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<unknown>;
  /** Clock the throttle reads; injectable so tests can move time with the sleep hook. */
  nowImpl?: () => number;
  requestsPerSecond: number;
  log?: (line: string) => void;
}

/** JSON client for one Discourse host: throttled, with a small retry on 429 and 5xx. */
export function createDiscourseClient({ host, fetchImpl = fetch, sleepImpl = sleep, nowImpl = Date.now, requestsPerSecond, log = () => {} }: DiscourseClientOptions): DiscourseClient {
  const interval = 1000 / requestsPerSecond;
  let nextSlot = 0;
  async function throttle() {
    const now = nowImpl();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + interval;
    if (wait > 0) await sleepImpl(wait);
  }
  return {
    async getJson<T>(path: string): Promise<T> {
      const url = `https://${host}${path}`;
      for (let attempt = 0; ; attempt += 1) {
        await throttle();
        const response = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'home-assistant-auto-triage' } });
        if (response.ok) return (await response.json()) as T;
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt >= BACKOFF_MS.length) throw new Error(`Discourse ${response.status} for ${url}`);
        log(`Discourse ${response.status} for ${url}, retry ${attempt + 1}`);
        await sleepImpl(BACKOFF_MS[attempt]);
      }
    },
  };
}
