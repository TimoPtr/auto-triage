// @ts-check
import { setTimeout as sleep } from 'node:timers/promises';

const NEXT_LINK = /<([^>]+)>;\s*rel="next"/;
/** Longest wait on an exhausted rate limit; a longer reset fails the request instead of hanging the job. */
export const MAX_RATE_LIMIT_WAIT_SECONDS = 15 * 60;

/**
 * @param {string} path
 * @param {Record<string, string | number | boolean> | undefined} params
 * @param {string} baseUrl
 */
function buildUrl(path, params, baseUrl) {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, String(value));
  return url.toString();
}

/**
 * Seconds to wait before retrying a rate-limited response, or null when the
 * response is not a rate limit. A 403 with remaining quota is a permissions
 * error and never waits, since GitHub sends `x-ratelimit-reset` on every response.
 * @param {Response} response
 */
function retryDelaySeconds(response) {
  if (response.status !== 403 && response.status !== 429) return null;
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null) return Number(retryAfter);
  if (response.headers.get('x-ratelimit-remaining') !== '0') return null;
  const reset = response.headers.get('x-ratelimit-reset');
  if (reset === null) return null;
  return Math.max(0, Number(reset) - Math.floor(Date.now() / 1000));
}

/**
 * Minimal GitHub REST client: JSON requests with the token, Link pagination,
 * one retry on a rate limit.
 * @param {{ token: string, fetchImpl?: typeof fetch, baseUrl?: string, sleepImpl?: (ms: number) => Promise<unknown>, log?: (line: string) => void }} options
 */
export function createGitHubClient({ token, fetchImpl = fetch, baseUrl = 'https://api.github.com', sleepImpl = sleep, log = () => {} }) {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'home-assistant-auto-triage',
  };

  /** @param {string} url */
  async function request(url) {
    let response = await fetchImpl(url, { headers });
    const delay = retryDelaySeconds(response);
    if (delay !== null) {
      const wait = Math.min(delay, MAX_RATE_LIMIT_WAIT_SECONDS);
      log(`GitHub rate limit hit, waiting ${wait}s before retrying ${url}`);
      await sleepImpl(wait * 1000);
      response = await fetchImpl(url, { headers });
    }
    if (!response.ok) {
      const body = (await response.text()).slice(0, 200);
      throw new Error(`GitHub ${response.status} for ${url}: ${body}`);
    }
    return response;
  }

  return {
    /**
     * @param {string} path
     * @param {Record<string, string | number | boolean>} [params]
     */
    async getJson(path, params) {
      const response = await request(buildUrl(path, params, baseUrl));
      return response.json();
    },
    /**
     * @param {string} path
     * @param {Record<string, string | number | boolean>} [params]
     */
    async *paginate(path, params) {
      /** @type {string | null} */
      let url = buildUrl(path, params, baseUrl);
      while (url) {
        const response = await request(url);
        const page = /** @type {unknown[]} */ (await response.json());
        for (const element of page) yield element;
        const link = response.headers.get('link');
        url = link ? (NEXT_LINK.exec(link)?.[1] ?? null) : null;
      }
    },
  };
}
