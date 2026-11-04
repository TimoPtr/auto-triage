import { setTimeout as sleep } from 'node:timers/promises';
import { throttle } from '../../log/progress.ts';

const NEXT_LINK = /<([^>]+)>;\s*rel="next"/;
/**
 * Longest wait on an exhausted rate limit: one full hourly window, since a
 * complete build of a large repository spends more than one window and a
 * failed build costs far more than an idle hour.
 */
export const MAX_RATE_LIMIT_WAIT_SECONDS = 61 * 60;
/** Added to the announced reset so a retry does not land a second before the window really reopens. */
export const RATE_LIMIT_MARGIN_SECONDS = 5;
/** Rate-limit waits per request before giving up. */
const MAX_RATE_LIMIT_WAITS = 3;
/** Retries on a thrown fetch error or a 5xx response; a long build must survive a dropped socket. */
export const MAX_TRANSIENT_RETRIES = 3;
const BACKOFF_MS = [1000, 2000, 4000];
/** Requests in flight at once; GitHub allows 100, a handful reaches the enterprise quota. */
export const MAX_IN_FLIGHT = 4;
/** GitHub's secondary limit for REST requests, never exceeded whatever the primary quota says. */
export const SECONDARY_LIMIT_PER_MINUTE = 900;
const MIN_INTERVAL_MS = 60_000 / SECONDARY_LIMIT_PER_MINUTE;
/** Quota left unspent in a window, so a request never lands on an empty one. */
export const QUOTA_RESERVE = 25;

type Params = Record<string, string | number | boolean>;

export interface GraphqlError { message: string; path?: (string | number)[] }
export interface GraphqlResult<T> { data: T | null; errors: GraphqlError[] }

export interface GitHubClient {
  getJson<T = unknown>(path: string, params?: Params): Promise<T>;
  paginate<T = unknown>(path: string, params?: Params): AsyncGenerator<T>;
  /** A GraphQL call that throws on any error in the response. */
  graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
  /** A GraphQL call returning partial data next to the per-field errors, for batched queries where one alias may fail. */
  graphqlPartial<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<GraphqlResult<T>>;
}

export interface GitHubClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  sleepImpl?: (ms: number) => Promise<unknown>;
  log?: (line: string) => void;
  /** Clock in epoch milliseconds, for the pacer and the once-a-minute rate-limit line. */
  now?: () => number;
}

/** The primary quota as the last response announced it: requests left and the window's end in epoch milliseconds. */
interface Quota { remaining: number; resetMs: number }

function quotaOf(response: Response): Quota | null {
  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = response.headers.get('x-ratelimit-reset');
  if (remaining === null || reset === null) return null;
  return { remaining: Number(remaining), resetMs: Number(reset) * 1000 };
}

/**
 * Milliseconds between request starts that spread the announced quota over
 * the rest of its window, never faster than the secondary limit allows. An
 * exhausted window is waited out entirely; before any response, nothing is known
 * and nothing is paced.
 */
export function paceInterval(quota: Quota | null, nowMs: number): number {
  if (!quota) return 0;
  const until = quota.resetMs - nowMs;
  if (until <= 0) return MIN_INTERVAL_MS;
  const usable = quota.remaining - QUOTA_RESERVE;
  if (usable <= 0) return until + RATE_LIMIT_MARGIN_SECONDS * 1000;
  return Math.max(MIN_INTERVAL_MS, until / usable);
}

/** `GitHub API: N requests left, limit resets in M min`, from the headers GitHub sends on every response. */
function rateLimitLine(response: Response): string | null {
  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = response.headers.get('x-ratelimit-reset');
  if (remaining === null || reset === null) return null;
  const minutes = Math.max(0, Math.round((Number(reset) * 1000 - Date.now()) / 60_000));
  return `GitHub API: ${remaining} requests left, limit resets in ${minutes} min`;
}

function buildUrl(path: string, params: Params | undefined, baseUrl: string): string {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, String(value));
  return url.toString();
}

/**
 * Seconds to wait before retrying a rate-limited response, or null when the
 * response is not a rate limit. A 403 with remaining quota is a permissions
 * error and never waits, since GitHub sends `x-ratelimit-reset` on every response.
 */
function retryDelaySeconds(response: Response): number | null {
  if (response.status !== 403 && response.status !== 429) return null;
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null) return Number(retryAfter);
  if (response.headers.get('x-ratelimit-remaining') !== '0') return null;
  const reset = response.headers.get('x-ratelimit-reset');
  if (reset === null) return null;
  return Math.max(0, Number(reset) - Math.floor(Date.now() / 1000)) + RATE_LIMIT_MARGIN_SECONDS;
}

function isTransient(response: Response | null, error: unknown): boolean {
  if (error) return true;
  return response !== null && response.status >= 500;
}

/**
 * Minimal GitHub client: JSON requests with the token, Link pagination, a
 * GraphQL call, retries with backoff on transient errors and one wait on a
 * rate limit. At most MAX_IN_FLIGHT requests run at once, and their starts
 * are paced to the quota GitHub announces in its response headers, so the
 * client follows whatever limit the token has without being told.
 */
export function createGitHubClient({ token, fetchImpl = fetch, baseUrl = 'https://api.github.com', sleepImpl = sleep, log = () => {}, now = () => Date.now() }: GitHubClientOptions): GitHubClient {
  const tick = throttle(undefined, now);
  let quota: Quota | null = null;
  let lastStart = -Infinity;
  let inFlight = 0;
  const waiting: (() => void)[] = [];

  /** Remembers the quota of a response; within one window the lowest count seen wins, since responses overlap. */
  function observe(response: Response) {
    const seen = quotaOf(response);
    if (!seen) return;
    quota = quota && quota.resetMs === seen.resetMs ? { ...seen, remaining: Math.min(quota.remaining, seen.remaining) } : seen;
  }

  /** Waits until the paced interval, from the latest quota, has passed since the previous start. */
  async function pace() {
    const at = now();
    const start = Math.max(at, lastStart + paceInterval(quota, at));
    lastStart = start;
    if (start > at) await sleepImpl(start - at);
  }

  async function acquire() {
    if (inFlight < MAX_IN_FLIGHT) { inFlight += 1; return; }
    await new Promise<void>((resolve) => waiting.push(resolve));
    inFlight += 1;
  }

  function release() {
    inFlight -= 1;
    waiting.shift()?.();
  }
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'home-assistant-auto-triage',
  };

  /**
   * One request with the transient-error budget; after the budget a 5xx
   * response is returned as is. A retry after a rate-limit wait is not paced
   * again: the wait already took it to the next window.
   */
  async function fetchOnce(url: string, init: RequestInit, { paced = true } = {}): Promise<Response> {
    let attempt = 0;
    for (;;) {
      let response: Response | null = null;
      let error: unknown = null;
      if (paced) await pace();
      try {
        response = await fetchImpl(url, init);
      } catch (e) {
        error = e;
      }
      if (response) observe(response);
      if (response && !isTransient(response, null)) return response;
      if (attempt >= MAX_TRANSIENT_RETRIES) {
        if (response) return response;
        throw error;
      }
      log(`GitHub request failed (${error instanceof Error ? error.message : response?.status}), retry ${attempt + 1}/${MAX_TRANSIENT_RETRIES} for ${url}`);
      await sleepImpl(BACKOFF_MS[attempt]);
      attempt += 1;
    }
  }

  async function request(url: string, init: RequestInit = { headers }): Promise<Response> {
    await acquire();
    let response: Response;
    try {
      response = await fetchOnce(url, init);
      for (let waits = 0; waits < MAX_RATE_LIMIT_WAITS; waits += 1) {
        const delay = retryDelaySeconds(response);
        if (delay === null) break;
        const wait = Math.min(delay, MAX_RATE_LIMIT_WAIT_SECONDS);
        log(`GitHub rate limit hit, waiting ${wait}s before retrying ${url}`);
        await sleepImpl(wait * 1000);
        response = await fetchOnce(url, init, { paced: false });
      }
    } finally {
      release();
    }
    if (!response.ok) {
      const body = (await response.text()).slice(0, 200);
      throw new Error(`GitHub ${response.status} for ${url}: ${body}`);
    }
    tick(() => { const line = rateLimitLine(response); if (line) log(line); });
    return response;
  }

  async function post<T>(query: string, variables: Record<string, unknown>): Promise<GraphqlResult<T>> {
    const response = await request(`${baseUrl}/graphql`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const payload = (await response.json()) as { data?: T | null; errors?: GraphqlError[] };
    return { data: payload.data ?? null, errors: payload.errors ?? [] };
  }

  return {
    async getJson<T>(path: string, params?: Params): Promise<T> {
      const response = await request(buildUrl(path, params, baseUrl));
      return (await response.json()) as T;
    },
    async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
      const { data, errors } = await post<T>(query, variables);
      if (errors.length) throw new Error(`GitHub GraphQL: ${errors[0].message}`);
      return data as T;
    },
    graphqlPartial: post,
    async *paginate<T>(path: string, params?: Params): AsyncGenerator<T> {
      let url: string | null = buildUrl(path, params, baseUrl);
      while (url) {
        const response = await request(url);
        const page = (await response.json()) as T[];
        for (const element of page) yield element;
        const link = response.headers.get('link');
        url = link ? (NEXT_LINK.exec(link)?.[1] ?? null) : null;
      }
    },
  };
}
