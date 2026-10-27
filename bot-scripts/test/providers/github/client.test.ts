import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubClient, MAX_RATE_LIMIT_WAIT_SECONDS, RATE_LIMIT_MARGIN_SECONDS } from '../../../src/providers/github/client.ts';

/** @param {Record<string, { status?: number, headers?: Record<string,string>, body: unknown }>} routes */
function fakeFetch(routes, log = []) {
  return async (url, init) => {
    log.push({ url: String(url), headers: init?.headers });
    const route = routes[String(url)];
    if (!route) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { 'content-type': 'application/json', ...route.headers } });
  };
}

test('getJson sends the token and parses JSON', async () => {
  const log = [];
  const client = createGitHubClient({ token: 't', fetchImpl: fakeFetch({ 'https://api.github.com/repos/o/r/issues/1': { body: { number: 1 } } }, log) });
  assert.deepEqual(await client.getJson('/repos/o/r/issues/1'), { number: 1 });
  assert.equal(log[0].headers.authorization, 'Bearer t');
  assert.equal(log[0].headers.accept, 'application/vnd.github+json');
});

test('paginate follows the Link header and yields elements', async () => {
  const routes = {
    'https://api.github.com/repos/o/r/issues?state=all&per_page=2': { body: [{ number: 1 }, { number: 2 }], headers: { link: '<https://api.github.com/repositories/1/issues?state=all&per_page=2&page=2>; rel="next", <https://api.github.com/x>; rel="last"' } },
    'https://api.github.com/repositories/1/issues?state=all&per_page=2&page=2': { body: [{ number: 3 }] },
  };
  const client = createGitHubClient({ token: 't', fetchImpl: fakeFetch(routes) });
  const numbers = [];
  for await (const issue of client.paginate<{ number: number }>('/repos/o/r/issues', { state: 'all', per_page: 2 })) numbers.push(issue.number);
  assert.deepEqual(numbers, [1, 2, 3]);
});

test('throws with status and body excerpt on errors', async () => {
  const client = createGitHubClient({ token: 't', fetchImpl: fakeFetch({ 'https://api.github.com/repos/o/r': { status: 500, body: { message: 'boom' } } }) });
  await assert.rejects(() => client.getJson('/repos/o/r'), /500.*boom/);
});

test('retries once after a rate limit with retry-after', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return calls === 1
      ? new Response('{"message":"rate"}', { status: 403, headers: { 'retry-after': '0' } })
      : new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = createGitHubClient({ token: 't', fetchImpl });
  assert.deepEqual(await client.getJson('/x'), { ok: true });
  assert.equal(calls, 2);
});

test('a 403 that is not a rate limit fails fast without sleeping', async () => {
  let calls = 0;
  const reset = String(Math.floor(Date.now() / 1000) + 3600);
  const fetchImpl = async () => {
    calls += 1;
    return new Response('{"message":"forbidden"}', { status: 403, headers: { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': reset } });
  };
  const sleeps = [];
  const client = createGitHubClient({ token: 't', fetchImpl, sleepImpl: async (ms) => { sleeps.push(ms); } });
  await assert.rejects(() => client.getJson('/x'), /403.*forbidden/);
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
});

test('an exhausted rate limit waits until reset plus a margin, capped at the maximum wait', async () => {
  let calls = 0;
  const reset = String(Math.floor(Date.now() / 1000) + 3600 * 2);
  const fetchImpl = async () => {
    calls += 1;
    return calls === 1
      ? new Response('{"message":"rate"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } })
      : new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const sleeps = [];
  const client = createGitHubClient({ token: 't', fetchImpl, sleepImpl: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(await client.getJson('/x'), { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [MAX_RATE_LIMIT_WAIT_SECONDS * 1000]);
  assert.equal(MAX_RATE_LIMIT_WAIT_SECONDS, 61 * 60);
});

test('a rate limit that is still exhausted right after the reset is waited out again', async () => {
  let calls = 0;
  const reset = String(Math.floor(Date.now() / 1000) + 60);
  const fetchImpl = async () => {
    calls += 1;
    return calls <= 2
      ? new Response('{"message":"rate"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } })
      : new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const sleeps = [];
  const client = createGitHubClient({ token: 't', fetchImpl, sleepImpl: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(await client.getJson('/x'), { ok: true });
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps.every((ms) => ms >= 60 * 1000 + RATE_LIMIT_MARGIN_SECONDS * 1000 - 1000), `margin added: ${sleeps}`);
});

test('gives up after the rate-limit wait budget', async () => {
  const reset = String(Math.floor(Date.now() / 1000) + 10);
  const fetchImpl = async () => new Response('{"message":"rate"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } });
  const client = createGitHubClient({ token: 't', fetchImpl, sleepImpl: async () => {} });
  await assert.rejects(() => client.getJson('/x'), /403/);
});

test('retries a transient network error with backoff', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 3) throw new TypeError('fetch failed');
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const sleeps = [];
  const client = createGitHubClient({ token: 't', fetchImpl, sleepImpl: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(await client.getJson('/x'), { ok: true });
  assert.deepEqual(sleeps, [1000, 2000]);
});

test('gives up after the retry budget on a 502', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response('bad gateway', { status: 502 }); };
  const client = createGitHubClient({ token: 't', fetchImpl, sleepImpl: async () => {} });
  await assert.rejects(() => client.getJson('/x'), /502/);
  assert.equal(calls, 4);
});

test('graphql posts the query and unwraps data', async () => {
  const log = [];
  const fetchImpl = async (url, init) => {
    log.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return Response.json({ data: { repository: { discussions: { totalCount: 3 } } } });
  };
  const client = createGitHubClient({ token: 't', fetchImpl });
  const data = await client.graphql('query($n: Int!) { repository { discussions(first: $n) { totalCount } } }', { n: 1 });
  assert.deepEqual(data, { repository: { discussions: { totalCount: 3 } } });
  assert.equal(log[0].url, 'https://api.github.com/graphql');
  assert.deepEqual(log[0].body.variables, { n: 1 });
});

test('graphql throws the first error message', async () => {
  const fetchImpl = async () => Response.json({ data: null, errors: [{ message: 'Could not resolve to a Repository' }] });
  const client = createGitHubClient({ token: 't', fetchImpl });
  await assert.rejects(() => client.graphql('{ x }'), /Could not resolve/);
});

test('logs the remaining rate limit at most once per minute', async () => {
  let clock = 0;
  const lines: string[] = [];
  const reset = String(Math.floor(Date.now() / 1000) + 25 * 60);
  const fetchImpl = async () => new Response('{}', { status: 200, headers: { 'x-ratelimit-remaining': '412', 'x-ratelimit-reset': reset } });
  const client = createGitHubClient({ token: 't', fetchImpl: fetchImpl as unknown as typeof fetch, log: (l) => lines.push(l), now: () => clock });
  await client.getJson('/repos/o/r');
  clock = 30_000; await client.getJson('/repos/o/r');
  assert.deepEqual(lines, []);
  clock = 61_000; await client.getJson('/repos/o/r');
  assert.deepEqual(lines, ['GitHub API: 412 requests left, limit resets in 25 min']);
  clock = 90_000; await client.getJson('/repos/o/r');
  assert.equal(lines.length, 1);
});
