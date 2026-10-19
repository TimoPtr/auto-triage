import { setTimeout as sleep } from 'node:timers/promises';

const NEXT_LINK = /<([^>]+)>;\s*rel="next"/;
/** Longest wait on an exhausted rate limit; a longer reset fails the request instead of hanging the job. */
export const MAX_RATE_LIMIT_WAIT_SECONDS = 15 * 60;
/** Retries on a thrown fetch error or a 5xx response; a long build must survive a dropped socket. */
export const MAX_TRANSIENT_RETRIES = 3;
const BACKOFF_MS = [1000, 2000, 4000];

type Params = Record<string, string | number | boolean>;

export interface GitHubClient {
  getJson<T = unknown>(path: string, params?: Params): Promise<T>;
  paginate<T = unknown>(path: string, params?: Params): AsyncGenerator<T>;
  graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

export interface GitHubClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  sleepImpl?: (ms: number) => Promise<unknown>;
  log?: (line: string) => void;
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
  return Math.max(0, Number(reset) - Math.floor(Date.now() / 1000));
}

function isTransient(response: Response | null, error: unknown): boolean {
  if (error) return true;
  return response !== null && response.status >= 500;
}

/**
 * Minimal GitHub client: JSON requests with the token, Link pagination, a
 * GraphQL call, retries with backoff on transient errors and one wait on a rate limit.
 */
export function createGitHubClient({ token, fetchImpl = fetch, baseUrl = 'https://api.github.com', sleepImpl = sleep, log = () => {} }: GitHubClientOptions): GitHubClient {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'home-assistant-auto-triage',
  };

  /** One request with the transient-error budget; after the budget a 5xx response is returned as is. */
  async function fetchOnce(url: string, init: RequestInit): Promise<Response> {
    let attempt = 0;
    for (;;) {
      let response: Response | null = null;
      let error: unknown = null;
      try {
        response = await fetchImpl(url, init);
      } catch (e) {
        error = e;
      }
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
    let response = await fetchOnce(url, init);
    const delay = retryDelaySeconds(response);
    if (delay !== null) {
      const wait = Math.min(delay, MAX_RATE_LIMIT_WAIT_SECONDS);
      log(`GitHub rate limit hit, waiting ${wait}s before retrying ${url}`);
      await sleepImpl(wait * 1000);
      response = await fetchOnce(url, init);
    }
    if (!response.ok) {
      const body = (await response.text()).slice(0, 200);
      throw new Error(`GitHub ${response.status} for ${url}: ${body}`);
    }
    return response;
  }

  return {
    async getJson<T>(path: string, params?: Params): Promise<T> {
      const response = await request(buildUrl(path, params, baseUrl));
      return (await response.json()) as T;
    },
    async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
      const response = await request(`${baseUrl}/graphql`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      const payload = (await response.json()) as { data?: T; errors?: { message: string }[] };
      if (payload.errors?.length) throw new Error(`GitHub GraphQL: ${payload.errors[0].message}`);
      return payload.data as T;
    },
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
