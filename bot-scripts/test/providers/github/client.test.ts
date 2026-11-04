import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubClient, paceInterval, MAX_IN_FLIGHT, MAX_RATE_LIMIT_WAIT_SECONDS, QUOTA_RESERVE, RATE_LIMIT_MARGIN_SECONDS, SECONDARY_LIMIT_PER_MINUTE } from '../../../src/providers/github/client.ts';

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
  const client = createGitHubClient({ token: 't', fetchImpl: fetchImpl as unknown as typeof fetch, log: (l) => lines.push(l), now: () => clock, sleepImpl: async () => {} });
  await client.getJson('/repos/o/r');
  clock = 30_000; await client.getJson('/repos/o/r');
  assert.deepEqual(lines, []);
  clock = 61_000; await client.getJson('/repos/o/r');
  assert.deepEqual(lines, ['GitHub API: 412 requests left, limit resets in 25 min']);
  clock = 90_000; await client.getJson('/repos/o/r');
  assert.equal(lines.length, 1);
});

test('paceInterval spreads the announced quota over the window and never beats the secondary limit', () => {
  const minInterval = 60_000 / SECONDARY_LIMIT_PER_MINUTE;
  assert.equal(paceInterval(null, 0), 0);
  // 100 s left, 75 usable requests after the reserve: one every 1333 ms.
  assert.equal(Math.round(paceInterval({ remaining: 75 + QUOTA_RESERVE, resetMs: 100_000 }, 0)), 1333);
  // 14 000 an hour is one every 257 ms; more than the secondary limit allows is floored to it.
  assert.equal(Math.round(paceInterval({ remaining: 14_000, resetMs: 3_600_000 }, 0)), 258);
  assert.equal(paceInterval({ remaining: 60_000 + QUOTA_RESERVE, resetMs: 3_600_000 }, 0), minInterval);
  // Nothing usable: wait for the window to end, plus the margin.
  assert.equal(paceInterval({ remaining: QUOTA_RESERVE, resetMs: 100_000 }, 40_000), 60_000 + RATE_LIMIT_MARGIN_SECONDS * 1000);
  // A window already over says nothing about the next one.
  assert.equal(paceInterval({ remaining: 0, resetMs: 100_000 }, 100_000), minInterval);
});

test('paces request starts by the headers of the previous response', async () => {
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const resetMs = clock + 100_000;
  // Each response announces 75 usable requests for the 100 s left: the next start is 1333 ms later.
  const fetchImpl = async () => new Response('{}', { status: 200, headers: { 'x-ratelimit-remaining': String(75 + QUOTA_RESERVE), 'x-ratelimit-reset': String(resetMs / 1000) } });
  const client = createGitHubClient({ token: 't', fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock, sleepImpl: async (ms) => { sleeps.push(ms); clock += ms; } });
  await client.getJson('/a');
  assert.deepEqual(sleeps, [], 'the first request knows no quota and starts at once');
  await client.getJson('/b');
  assert.equal(Math.round(sleeps[0]), 1333);
  clock += 5_000; // time passes on its own: no sleep is needed for the next start
  await client.getJson('/c');
  assert.equal(sleeps.length, 1);
});

test('within one window the lowest remaining count seen wins', async () => {
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const resetMs = clock + 100_000;
  const remaining = [String(1000), String(50 + QUOTA_RESERVE), String(900)];
  const fetchImpl = async () => new Response('{}', { status: 200, headers: { 'x-ratelimit-remaining': remaining.shift() ?? '900', 'x-ratelimit-reset': String(resetMs / 1000) } });
  const client = createGitHubClient({ token: 't', fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock, sleepImpl: async (ms) => { sleeps.push(ms); clock += ms; } });
  await client.getJson('/a');
  await client.getJson('/b'); // paced by 975 usable over 100 s: 103 ms
  await client.getJson('/c'); // paced by 50 usable over the window: 2 s
  await client.getJson('/d'); // the stale 900 does not raise the pace again
  assert.equal(Math.round(sleeps[0]), 103);
  assert.ok(Math.abs(sleeps[1] - (100_000 - sleeps[0]) / 50) < 1, String(sleeps[1]));
  // The fake keeps announcing 50 usable requests, so the pace follows the shrinking window.
  assert.ok(Math.abs(sleeps[2] - (100_000 - sleeps[0] - sleeps[1]) / 50) < 1, String(sleeps[2]));
});

test('keeps at most MAX_IN_FLIGHT requests in flight', async () => {
  let inFlight = 0;
  let peak = 0;
  const pending: (() => void)[] = [];
  const fetchImpl = () => {
    inFlight += 1; peak = Math.max(peak, inFlight);
    return new Promise<Response>((resolve) => pending.push(() => { inFlight -= 1; resolve(new Response('{}', { status: 200 })); }));
  };
  const client = createGitHubClient({ token: 't', fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: async () => {} });
  const all = Promise.all(Array.from({ length: 10 }, (_, i) => client.getJson(`/${i}`)));
  await new Promise((r) => setImmediate(r));
  assert.equal(peak, MAX_IN_FLIGHT);
  while (pending.length) { pending.shift()!(); await new Promise((r) => setImmediate(r)); }
  await all;
  assert.equal(peak, MAX_IN_FLIGHT);
});
