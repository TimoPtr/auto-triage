import { setTimeout as sleep } from 'node:timers/promises';

const BACKOFF_MS = [1000, 2000, 4000];
/** A 429 is the per-address limit (200 a minute on a default Discourse): the window is waited out, not failed. */
const RATE_LIMIT_WAIT_MS = [5_000, 15_000, 30_000, 60_000];
const MAX_RETRY_AFTER_MS = 120_000;

function retryAfterMs(response: Response): number | null {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : null;
}

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

/**
 * JSON client for one Discourse host: throttled, with a small retry on 5xx and a failed request
 * (a dropped socket) and a patient one on 429, which honours `Retry-After` when the site sends it.
 */
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
      let failures = 0;
      let limited = 0;
      for (;;) {
        await throttle();
        let response: Response | null = null;
        let failure: unknown = null;
        try {
          response = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'home-assistant-auto-triage' } });
        } catch (error) {
          failure = error;
        }
        if (response?.ok) return (await response.json()) as T;
        const reason = response ? String(response.status) : `request failed (${failure instanceof Error ? failure.message : String(failure)})`;
        let wait: number | undefined;
        if (response?.status === 429) wait = retryAfterMs(response) ?? RATE_LIMIT_WAIT_MS[limited++];
        else if (response === null || response.status >= 500) wait = BACKOFF_MS[failures++];
        if (wait === undefined) throw new Error(`Discourse ${reason} for ${url}`);
        log(`Discourse ${reason} for ${url}, retry ${failures + limited} after ${wait / 1000}s`);
        await sleepImpl(wait);
      }
    },
  };
}
