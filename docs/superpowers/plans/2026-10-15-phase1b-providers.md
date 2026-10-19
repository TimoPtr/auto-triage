# Knowledge bot phase 1b: remaining providers implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the index to pull requests, discussions, release notes, the Kotlin codebase, string resources and skills, and the community forum, and close the hardening findings of the phase 1a review.

**Architecture:** Each new source is a reader module yielding `IndexItem` streams, registered under the existing `github` provider or a new `discourse` provider, selected by config keys the schema validates strictly. The GitHub client gains GraphQL and transient-error retry. Retrieval gains query cleaning, per-item similarity and a live forum list. Everything else (store, embedder, writer, CLIs) is unchanged.

**Tech Stack:** TypeScript on Node 24 (type stripping, no build), `node:sqlite` + `sqlite-vec`, `@huggingface/transformers`, `yaml`, `ajv`, `node:test`. GitHub REST and GraphQL, Discourse JSON.

**Spec:** `/Users/timo/Documents/ha/android/docs/superpowers/specs/2026-10-15-knowledge-bot-design.md` (sections 4, 5.1, 5.4 forum crawl, 6 step 1 and 6). Plan 1a lives next to this file and defines the modules this plan extends. Plans 1c (CI) and 1d (eval) follow.

## Global Constraints

- Node floor `>=24`; sources are `.ts` run by type stripping, imports keep the `.ts` extension, `erasableSyntaxOnly` stays on, `npm test` must exit 0 (strict `tsc` on `src`, lenient on `test`, then `node --test`).
- No new runtime dependencies. Dev dependencies stay `typescript` and `@types/node`.
- No network in tests: every HTTP call goes through an injectable `fetchImpl`, every sleep through `sleepImpl`.
- Config stays YAML keyed by provider, strictly validated; every new key has a schema entry with a `description`.
- Chunk text never exceeds `CHUNK_CHARS = 2000`; author authority lives in `author_role`, never in text.
- Untrusted content (PR bodies, review comments, discussions, forum posts, code comments) is data: never executed, never interpolated into SQL, never given a role by its own words.
- Commits go on `main` in `auto-triage` (Timo's standing permission for the proof of concept); the android repository is only edited, never committed.
- Files under about 300 lines, functions under 50.

## Review Focus

1. A GitHub API call that fails with a socket error after minutes of work must be retried, not abort the whole build (Task 2 test `retries a transient network error with backoff`).
2. A pull request authored by a bot such as renovate must not be indexed by default, since it would dominate the posts index with dependency bumps (Task 6 test `skips bot pull requests by default`).
3. A Discourse topic list that keeps returning the same `more_topics_url` must not loop forever (Task 11 test `stops paging when the next page repeats`).
4. A Kotlin file with no top-level declaration, such as a file of only imports or a script, must yield no chunk rather than an empty one (Task 9 test `yields nothing for a file without declarations`).
5. A docs front matter `slug` of the form `//evil.example/x` must not produce an external link (Task 1 test `rejects a protocol-relative slug`).

---

### Task 1: Docs reader hardening

**Files:**
- Modify: `bot-scripts/src/providers/github/docs.ts`
- Modify: `bot-scripts/test/providers/github/docs.test.ts`
- Test fixture: `bot-scripts/test/fixtures/docs/evil.md`

**Interfaces:**
- Consumes: `readDocs`, `docUrl`, `splitFrontMatter` from plan 1a.
- Produces: unchanged signatures. Behavior: the first chunk of a page starts with the page title and, when present, the front matter description; a `slug` that does not match `^/[^/]` is ignored; symbolic links are skipped.

- [ ] **Step 1: Write the failing tests and the fixture**

`bot-scripts/test/fixtures/docs/evil.md`:

```markdown
---
title: Evil
slug: //evil.example/phish
---

Body.
```

Append to `bot-scripts/test/providers/github/docs.test.ts`:

```ts
test('prefixes the title and description into the first chunk only', async () => {
  const debug = (await collect()).find((i) => i.title === 'Android debug tools');
  assert.ok(debug.chunks[0].text.startsWith('Android debug tools\nThe developer playground and LeakCanary in debug builds.\n'));
  const widgets = (await collect()).find((i) => i.sourceId === 'docs/widgets.md');
  assert.ok(widgets.chunks[0].text.startsWith('Android Widgets\n'));
  assert.ok(!widgets.chunks[1].text.startsWith('Android Widgets\n'));
});

test('rejects a protocol-relative slug', async () => {
  const evil = (await collect()).find((i) => i.title === 'Evil');
  assert.equal(evil.url, 'https://example.test/docs/evil');
});

test('skips symbolic links', async () => {
  const { symlinkSync, rmSync, existsSync } = await import('node:fs');
  const link = join(checkout, 'docs', 'linked.md');
  if (existsSync(link)) rmSync(link);
  symlinkSync(join(checkout, 'docs', 'widgets.md'), link);
  try {
    const items = await collect();
    assert.ok(items.every((i) => i.sourceId !== 'docs/linked.md'));
  } finally {
    rmSync(link);
  }
});
```

Add `import { join } from 'node:path';` at the top of the test file, and update the existing URL test's expected list to include `'https://example.test/docs/evil'` after `android-widgets`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot-scripts && node --test test/providers/github/docs.test.ts`
Expected: FAIL on the three new tests (prefix missing, URL `https://evil.example/phish`, symlink indexed) and on the URL list.

- [ ] **Step 3: Implement**

In `docs.ts`, change `docUrl`:

```ts
const ABSOLUTE_SLUG = /^\/[^/]/;
...
  const slug = frontMatter.slug;
  if (typeof slug === 'string' && ABSOLUTE_SLUG.test(slug)) {
    return new URL(slug, base.origin).toString();
  }
  ...
  const name = String(frontMatter.id ?? (typeof slug === 'string' && !slug.startsWith('/') ? slug : null) ?? file);
```

In `walk`, skip links: `if (entry.isSymbolicLink()) continue;` before the directory check.

In `readDocs`, build the first chunk prefix:

```ts
    const description = typeof frontMatter.description === 'string' ? frontMatter.description : null;
    const pageHeader = [title, description].filter(Boolean).join('\n');
    const chunks: IndexChunk[] = chunkMarkdown(body).map((c, seq) => ({
      seq,
      kind: 'section',
      heading: c.heading,
      anchor: c.anchor,
      text: [seq === 0 ? pageHeader : null, ...c.breadcrumbs, c.text].filter(Boolean).join('\n'),
      logs: null,
      createdAt: DOCS_EPOCH,
    }));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && npm test`
Expected: exit 0, every test green.

- [ ] **Step 5: Commit**

`git add bot-scripts/src/providers/github/docs.ts bot-scripts/test/providers/github/docs.test.ts bot-scripts/test/fixtures/docs/evil.md` and commit `Harden the docs reader: title in chunks, slug and symlink checks`.

---

### Task 2: GitHub client retry on transient errors and GraphQL

**Files:**
- Modify: `bot-scripts/src/providers/github/client.ts`
- Modify: `bot-scripts/test/providers/github/client.test.ts`

**Interfaces:**
- Produces: `GitHubClient.graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>` posting to `${baseUrl}/graphql`; throws with the first error message when the response has `errors`. `request` retries up to `MAX_TRANSIENT_RETRIES = 3` times on a thrown fetch error or a 5xx status, sleeping `1s, 2s, 4s`.

- [ ] **Step 1: Write the failing tests**

Append to `client.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot-scripts && node --test test/providers/github/client.test.ts`
Expected: FAIL: the first rejects with `fetch failed`, the second rejects after one call, the GraphQL tests fail with `client.graphql is not a function`.

- [ ] **Step 3: Implement**

In `client.ts` add:

```ts
export const MAX_TRANSIENT_RETRIES = 3;
const BACKOFF_MS = [1000, 2000, 4000];

function isTransient(response: Response | null, error: unknown): boolean {
  if (error) return true;
  return response !== null && response.status >= 500;
}
```

Rewrite `request` as a loop:

```ts
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
      if (!isTransient(response, error) || attempt >= MAX_TRANSIENT_RETRIES) {
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
```

Note: after the retry budget on a 5xx, `fetchOnce` returns the last response, and `request` turns it into the `GitHub 502` error the test expects.

Add the method:

```ts
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
```

and `graphql` to the `GitHubClient` interface and to `PaginatingClient` in `providers/types.ts` as an optional member: `graphql?<T>(query: string, variables?: Record<string, unknown>): Promise<T>`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && npm test`
Expected: exit 0.

- [ ] **Step 5: Commit**

Commit `Retry transient GitHub errors and add a GraphQL call`.

---

### Task 2b: Raw source store

**Files:**
- Create: `bot-scripts/src/store/raw.ts`
- Modify: `bot-scripts/src/providers/github/issues.ts`
- Modify: `bot-scripts/src/providers/github/index.ts`
- Modify: `bot-scripts/src/providers/registry.ts`
- Modify: `bot-scripts/src/cli/build.ts`
- Test: `bot-scripts/test/store/raw.test.ts`
- Modify: `bot-scripts/test/providers/github/issues.test.ts`

**Why:** the index keeps cleaned, packed chunks. The benchmark (plan 1d) mines its ground truth from the original material: "duplicate of #N" comments, close reasons, `fixes #N` in pull request bodies, docs links in maintainer replies. Keeping every fetched payload next to the index means the mining never re-fetches, and a rebuild skips the comment and review requests of items whose `updated_at` has not moved. Timo asked for this on 2026-10-19.

**Interfaces:**
- Produces in `raw.ts`: `RawRecord { provider: string; origin: string; kind: string; id: string; updatedAt: string | null; payload: unknown }`, `RawStore { get(provider, origin, kind, id): RawRecord | null; put(record: RawRecord): void; each(provider, origin, kind): Iterable<RawRecord>; count(): number; close(): void }`, `openRawStore(path: string): RawStore`, `RAW_SCHEMA_VERSION = 1`. Payloads are gzip JSON blobs in table `raw_items (provider, origin, kind, id, updated_at, fetched_at, payload)`; a `meta` table holds `raw_schema_version` and opening a store with another version throws.
- Readers take an optional `raw?: RawStore`. Issues: after the comments are known, `raw.put({ provider: 'github', origin: repo, kind: 'issue', id: String(number), updatedAt: issue.updated_at, payload: { issue, comments } })`; when `raw.get(...)` returns a record whose `updatedAt` equals the listing's `updated_at`, its `comments` are used and the comments request is skipped. Later tasks follow the pattern: pulls store `{ pull, reviewComments, files }` under kind `pull` (Task 6), discussions store the GraphQL node under `discussion` (Task 7), releases store the release under `release` keyed by tag with `updatedAt: published_at` (Task 8), Discourse topics store `{ listed, topic }` under `topic` with `updatedAt: last_posted_at` and reuse `topic` when unchanged (Task 11).
- `GithubProviderDeps.raw?: RawStore`, `ProviderDeps.raw?: RawStore`. CLI flag `--raw <sqlite>` opens (creating) the store, closes it after the build, and logs `raw store: <count> records`.

- [ ] **Step 1: Write the failing tests**

`bot-scripts/test/store/raw.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRawStore } from '../../src/store/raw.ts';

const tmp = mkdtempSync(join(tmpdir(), 'kb-raw-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

test('stores a payload by key and replaces it on a second put', () => {
  const store = openRawStore(join(tmp, 'raw.sqlite'));
  store.put({ provider: 'github', origin: 'o/r', kind: 'issue', id: '1', updatedAt: '2026-01-01T00:00:00Z', payload: { issue: { number: 1 }, comments: [] } });
  store.put({ provider: 'github', origin: 'o/r', kind: 'issue', id: '1', updatedAt: '2026-01-02T00:00:00Z', payload: { issue: { number: 1, title: 'x' }, comments: [{ body: 'c' }] } });
  const record = store.get('github', 'o/r', 'issue', '1');
  assert.equal(record.updatedAt, '2026-01-02T00:00:00Z');
  assert.deepEqual(record.payload, { issue: { number: 1, title: 'x' }, comments: [{ body: 'c' }] });
  assert.equal(store.get('github', 'o/r', 'issue', '2'), null);
  assert.equal(store.count(), 1);
  store.close();
});

test('iterates one kind of one origin and survives reopening', () => {
  const path = join(tmp, 'raw2.sqlite');
  let store = openRawStore(path);
  store.put({ provider: 'github', origin: 'o/r', kind: 'issue', id: '1', updatedAt: null, payload: 1 });
  store.put({ provider: 'github', origin: 'o/r', kind: 'pull', id: '2', updatedAt: null, payload: 2 });
  store.put({ provider: 'github', origin: 'o/other', kind: 'issue', id: '3', updatedAt: null, payload: 3 });
  store.close();
  store = openRawStore(path);
  assert.deepEqual(Array.from(store.each('github', 'o/r', 'issue')).map((r) => r.payload), [1]);
  assert.equal(store.count(), 3);
  store.close();
});

test('a large payload round-trips through compression', () => {
  const store = openRawStore(join(tmp, 'raw3.sqlite'));
  const text = 'log line\n'.repeat(50_000);
  store.put({ provider: 'github', origin: 'o/r', kind: 'issue', id: '9', updatedAt: null, payload: { text } });
  assert.equal(store.get('github', 'o/r', 'issue', '9').payload.text, text);
  store.close();
});

test('refuses a store written with another schema version', () => {
  const path = join(tmp, 'raw4.sqlite');
  const store = openRawStore(path);
  store.close();
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path);
  db.exec("UPDATE meta SET value = '99' WHERE key = 'raw_schema_version'");
  db.close();
  assert.throws(() => openRawStore(path), /raw store schema 99/);
});
```

(the test file is lenient TypeScript; use `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);` at the top for the `require` call, or import `DatabaseSync` directly from `node:sqlite`.)

Append to `issues.test.ts` (add `import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { openRawStore } from '../../../src/store/raw.ts';` and a `tmp` directory with `test.after` cleanup):

```ts
test('records each issue with its comments in the raw store', async () => {
  const raw = openRawStore(join(tmp, 'raw-record.sqlite'));
  await collect(readIssues({ client: fakeClient(), repo: 'o/r', options, now, raw }));
  const record = raw.get('github', 'o/r', 'issue', '12');
  assert.equal(record.updatedAt, page.find((i) => i.number === 12).updated_at);
  assert.equal(record.payload.issue.number, 12);
  assert.equal(record.payload.comments.length, comments.length);
  assert.equal(raw.get('github', 'o/r', 'issue', '20').payload.comments.length, 0);
  raw.close();
});

test('reuses stored comments when the issue has not changed since', async () => {
  const raw = openRawStore(join(tmp, 'raw-reuse.sqlite'));
  await collect(readIssues({ client: fakeClient(), repo: 'o/r', options, now, raw }));
  const log = [];
  const items = await collect(readIssues({ client: fakeClient(log), repo: 'o/r', options, now, raw }));
  assert.ok(log.every((c) => !c.path.endsWith('/comments')), 'no comments request on the second pass');
  const issue = items.find((i) => i.sourceId === '12');
  assert.equal(issue.chunks.filter((c) => c.kind === 'comment').length, comments.length);
  raw.close();
});

test('fetches comments again when the issue was updated', async () => {
  const raw = openRawStore(join(tmp, 'raw-stale.sqlite'));
  raw.put({ provider: 'github', origin: 'o/r', kind: 'issue', id: '12', updatedAt: '2000-01-01T00:00:00Z', payload: { issue: {}, comments: [] } });
  const log = [];
  await collect(readIssues({ client: fakeClient(log), repo: 'o/r', options, now, raw }));
  assert.ok(log.some((c) => c.path === '/repos/o/r/issues/12/comments'));
  raw.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot-scripts && node --test test/store/raw.test.ts test/providers/github/issues.test.ts`
Expected: `raw.test.ts` fails with `Cannot find module '.../store/raw.ts'`; the three issue tests fail on the same import.

- [ ] **Step 3: Implement**

`bot-scripts/src/store/raw.ts`:

```ts
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync, gzipSync } from 'node:zlib';

export const RAW_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS raw_items (
  provider   TEXT NOT NULL,
  origin     TEXT NOT NULL,
  kind       TEXT NOT NULL,   -- issue | pull | discussion | release | topic
  id         TEXT NOT NULL,
  updated_at TEXT,            -- the source's own change marker; equal means the payload is current
  fetched_at TEXT NOT NULL,
  payload    BLOB NOT NULL,   -- gzip JSON exactly as fetched
  PRIMARY KEY (provider, origin, kind, id)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta (key, value) VALUES ('raw_schema_version', '${RAW_SCHEMA_VERSION}');
`;

export interface RawRecord {
  provider: string;
  origin: string;
  kind: string;
  id: string;
  updatedAt: string | null;
  payload: unknown;
}

/** Fetched source payloads, kept next to the index for the benchmark mining and for rebuild reuse. */
export interface RawStore {
  get(provider: string, origin: string, kind: string, id: string): RawRecord | null;
  put(record: RawRecord): void;
  each(provider: string, origin: string, kind: string): Iterable<RawRecord>;
  count(): number;
  close(): void;
}

interface Row { provider: string; origin: string; kind: string; id: string; updated_at: string | null; payload: Uint8Array }

function toRecord(row: Row): RawRecord {
  return { provider: row.provider, origin: row.origin, kind: row.kind, id: row.id, updatedAt: row.updated_at, payload: JSON.parse(gunzipSync(row.payload).toString('utf8')) };
}

/** Opens (creating when absent) a raw store file. */
export function openRawStore(path: string): RawStore {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const version = (db.prepare("SELECT value FROM meta WHERE key = 'raw_schema_version'").get() as { value: string }).value;
  if (version !== String(RAW_SCHEMA_VERSION)) {
    db.close();
    throw new Error(`raw store schema ${version} at ${path} is not the supported ${RAW_SCHEMA_VERSION}`);
  }
  const select = db.prepare('SELECT provider, origin, kind, id, updated_at, payload FROM raw_items WHERE provider = ? AND origin = ? AND kind = ? AND id = ?');
  const upsert = db.prepare(`INSERT INTO raw_items (provider, origin, kind, id, updated_at, fetched_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (provider, origin, kind, id) DO UPDATE SET updated_at = excluded.updated_at, fetched_at = excluded.fetched_at, payload = excluded.payload`);
  const list = db.prepare('SELECT provider, origin, kind, id, updated_at, payload FROM raw_items WHERE provider = ? AND origin = ? AND kind = ? ORDER BY id');
  const total = db.prepare('SELECT count(*) AS n FROM raw_items');
  return {
    get(provider, origin, kind, id) {
      const row = select.get(provider, origin, kind, id) as Row | undefined;
      return row ? toRecord(row) : null;
    },
    put({ provider, origin, kind, id, updatedAt, payload }) {
      upsert.run(provider, origin, kind, id, updatedAt, new Date().toISOString(), gzipSync(Buffer.from(JSON.stringify(payload))));
    },
    *each(provider, origin, kind) {
      for (const row of list.iterate(provider, origin, kind)) yield toRecord(row as Row);
    },
    count() {
      return Number((total.get() as { n: number }).n);
    },
    close() {
      db.close();
    },
  };
}
```

In `issues.ts`: add `raw?: RawStore` to `ReadIssuesInput` (import type from `../../store/raw.ts`), and replace the comments block by a helper:

```ts
/** Comments of one issue: from the raw store when the issue did not change, else fetched and recorded. */
async function issueComments(client: PaginatingClient, repo: string, issue: ApiIssue, wanted: boolean, raw?: RawStore): Promise<ApiComment[]> {
  const stored = raw?.get('github', repo, 'issue', String(issue.number));
  if (stored && stored.updatedAt === issue.updated_at) return (stored.payload as { comments: ApiComment[] }).comments;
  const comments: ApiComment[] = [];
  if (wanted && issue.comments > 0) {
    for await (const comment of client.paginate(`/repos/${repo}/issues/${issue.number}/comments`, { per_page: 100 })) comments.push(comment as ApiComment);
  }
  raw?.put({ provider: 'github', origin: repo, kind: 'issue', id: String(issue.number), updatedAt: issue.updated_at, payload: { issue, comments } });
  return comments;
}
```

and in the loop: `for (const comment of await issueComments(client, repo, issue, options.comments, raw)) chunks.push(...commentChunks(comment, chunks.length, reporter));`. Note the reuse applies even when `comments` is off: the stored payload then has an empty `comments` list, which is what the index would get anyway.

In `github/index.ts`: `raw?: RawStore` in `GithubProviderDeps`, passed to `readIssues`. In `registry.ts`: `raw?: RawStore` in `ProviderDeps`, passed into `createGithubProvider`. In `cli/build.ts`: option `raw: { type: 'string' }`; `const raw = values.raw ? openRawStore(values.raw) : undefined;` before `createProviders`, pass `raw`, wrap the build in `try { ... } finally { raw?.close(); }`, and log `raw store: ${raw.count()} records` after the build when a store is open.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && npm test`
Expected: exit 0.

- [ ] **Step 5: Commit**

Commit `Keep fetched source payloads in a raw store for mining and rebuild reuse`.

---

### Task 3: Cleaner and query hygiene

**Files:**
- Modify: `bot-scripts/src/text/clean.ts`
- Modify: `bot-scripts/src/retrieval/retrieve.ts`
- Modify: `bot-scripts/test/text/clean.test.ts`
- Modify: `bot-scripts/test/retrieval/retrieve.test.ts`

**Interfaces:**
- Produces: `prepareQuestion(question: string): { embedText: string; lexicalText: string }` exported from `retrieve.ts`: cleans the question like an issue body; `embedText` is the cleaned text (or the raw question when cleaning leaves nothing), `lexicalText` is the cleaned text plus the extracted logs so error strings reach FTS5. `retrieve` uses it.

- [ ] **Step 1: Write the failing tests**

Append to `clean.test.ts`:

```ts
test('a long run of blank lines inside a fence does not stall the detector', () => {
  const body = '```\nx' + '\n'.repeat(60_000) + 'y\n```';
  const started = performance.now();
  cleanIssueText(body);
  assert.ok(performance.now() - started < 300, 'took too long');
});
```

Append to `retrieve.test.ts`:

```ts
test('prepareQuestion strips template noise and lifts logs into the lexical text', async () => {
  const { prepareQuestion } = await import('../../src/retrieval/retrieve.ts');
  const body = '**Description of problem:**\nWidget stops.\n\n```\n03-01 09:59:01 E/EntityWidget: refresh failed\n```';
  const q = prepareQuestion(body);
  assert.equal(q.embedText, 'Widget stops.');
  assert.ok(q.lexicalText.includes('E/EntityWidget'));
});

test('a question that cleans to nothing is embedded as written', async () => {
  const { prepareQuestion } = await import('../../src/retrieval/retrieve.ts');
  assert.equal(prepareQuestion('<!-- only a comment -->').embedText, '<!-- only a comment -->');
});

test('retrieve finds a log tag given a whole issue body', async () => {
  const db = openDatabase(indexPath, { readOnly: true });
  const body = '**Companion App Logs:**\n\n```\nE/EntityWidget: refresh failed\n```';
  const results = await retrieve(db, embedder, body, { k: 3 });
  db.close();
  assert.equal(results[0].sourceId, '1');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot-scripts && node --test test/text/clean.test.ts test/retrieval/retrieve.test.ts`
Expected: the blank-line test exceeds 300 ms or passes slowly on a fast machine (watch the duration printed); the `prepareQuestion` tests fail with `not a function`; the whole-body test fails because the log fence is stripped from nothing and the fake embedder sees no `widget`.

- [ ] **Step 3: Implement**

In `clean.ts` change `LOG_LINE` to start with `^[ \t]*` instead of `^\s*`, and in `looksLikeLog` replace `body.split('\n').filter(...)` by a counting loop that stops at `maxLogLines + 1` non-empty lines.

In `retrieve.ts`:

```ts
import { cleanIssueText } from '../text/clean.ts';

export function prepareQuestion(question: string): { embedText: string; lexicalText: string } {
  const { text, logs } = cleanIssueText(question);
  const embedText = text || question;
  const lexicalText = [text, logs].filter(Boolean).join('\n') || question;
  return { embedText, lexicalText };
}
```

and in `retrieve`: `const { embedText, lexicalText } = prepareQuestion(question);`, embed `embedText`, pass `lexicalText` to `lexicalCandidates`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && npm test`
Expected: exit 0.

- [ ] **Step 5: Commit**

Commit `Clean the question like a chunk and bound the log detector`.

---

### Task 4: Writer tolerance and per-item similarity

**Files:**
- Modify: `bot-scripts/src/store/writer.ts`
- Modify: `bot-scripts/src/retrieval/retrieve.ts`
- Modify: `bot-scripts/src/cli/query.ts`
- Modify: `bot-scripts/test/store/writer.test.ts`
- Modify: `bot-scripts/test/retrieval/retrieve.test.ts`

**Interfaces:**
- Produces: `loadPreviousVectors` returns an empty map, with a log line, when the previous index has another `schema_version`, `dimensions` or `model_key`, or cannot be opened. `RetrievalResult.scores.itemSimilarity: number | null` is the best cosine among the item's dense candidates. The query CLI prints `similarity` from `itemSimilarity`.

- [ ] **Step 1: Write the failing tests**

Append to `writer.test.ts`:

```ts
test('ignores a previous index with another dimension and logs it', async () => {
  const previous = join(tmp, 'prev-dim.sqlite');
  await writeIndex({ items: of(item('1', 'widget stops')), embedder: { ...fakeEmbedder(), dimensions: 8, async embed(t) { return t.map(() => new Float32Array(8)); } }, outPath: previous, meta: {} });
  const lines = [];
  const stats = await writeIndex({ items: of(item('1', 'widget stops')), embedder: fakeEmbedder(), outPath: join(tmp, 'f.sqlite'), previousPath: previous, meta: {}, log: (l) => lines.push(l) });
  assert.equal(stats.reused, 0);
  assert.ok(lines.some((l) => /previous index/.test(l)));
});

test('ignores an unreadable previous index', async () => {
  const bogus = join(tmp, 'bogus.sqlite');
  (await import('node:fs')).writeFileSync(bogus, 'not a database');
  const stats = await writeIndex({ items: of(item('1', 'widget stops')), embedder: fakeEmbedder(), outPath: join(tmp, 'g.sqlite'), previousPath: bogus, meta: {} });
  assert.equal(stats.reused, 0);
});
```

Append to `retrieve.test.ts`:

```ts
test('reports the best similarity of the item, not only of the chunk that won the fusion', async () => {
  const db = openDatabase(indexPath, { readOnly: true });
  const results = await retrieve(db, embedder, 'widget stops', { k: 10 });
  db.close();
  for (const r of results) {
    if (r.scores.similarity !== null) assert.ok(r.scores.itemSimilarity >= r.scores.similarity);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot-scripts && node --test test/store/writer.test.ts test/retrieval/retrieve.test.ts`
Expected: the dimension test throws from sqlite-vec (`vec_chunks` dimension mismatch) or reuses nothing without a log line; the bogus test throws `file is not a database`; the similarity test fails on `undefined >= number`.

- [ ] **Step 3: Implement**

In `writer.ts`, `loadPreviousVectors(previousPath, embedder, log)`:

```ts
function loadPreviousVectors(previousPath: string | undefined, embedder: Embedder, log: (line: string) => void): Map<string, Uint8Array> {
  const vectors = new Map<string, Uint8Array>();
  if (!previousPath || !existsSync(previousPath)) return vectors;
  let db: DatabaseSync;
  try {
    db = openDatabase(previousPath, { readOnly: true });
  } catch (error) {
    log(`previous index unusable (${error instanceof Error ? error.message : String(error)}); embedding everything`);
    return vectors;
  }
  try {
    const meta = readMeta(db);
    const reasons = [
      meta.schema_version !== String(SCHEMA_VERSION) ? `schema ${meta.schema_version}` : null,
      meta.dimensions !== String(embedder.dimensions) ? `dimensions ${meta.dimensions}` : null,
      meta.model_key !== embedder.modelKey ? `model ${meta.model_key}` : null,
    ].filter(Boolean);
    if (reasons.length) {
      log(`previous index not reused (${reasons.join(', ')}); embedding everything`);
      return vectors;
    }
    const rows = db.prepare('SELECT c.hash, v.embedding FROM chunks c JOIN vec_chunks v ON v.chunk_id = c.id').all() as { hash: string; embedding: Uint8Array }[];
    for (const row of rows) vectors.set(row.hash, row.embedding);
  } catch (error) {
    log(`previous index unusable (${error instanceof Error ? error.message : String(error)}); embedding everything`);
    vectors.clear();
  } finally {
    db.close();
  }
  return vectors;
}
```

Import `SCHEMA_VERSION` from `./db.ts`. Move `const db = openDatabase(tmpPath)` inside the `try` in `writeIndex` (declare `let db: DatabaseSync | undefined` before, close it in the catch when defined).

In `retrieve.ts`, add `itemSimilarity: number | null` to `scores`, compute per item while collapsing: keep a `Map<number, number>` of the best similarity seen per `item_id` over all loaded rows, then set it on the result after the loop. In `query.ts`, print `r.scores.itemSimilarity` in place of `r.scores.similarity` and add the field to the test fixture object in `query.test.ts` (`itemSimilarity: 0.91` and `0.8`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && npm test`
Expected: exit 0.

- [ ] **Step 5: Commit**

Commit `Tolerate an unusable previous index and report per-item similarity`.

---

### Task 5: Config schema for the new sources

**Files:**
- Modify: `schemas/providers/github.json`
- Create: `schemas/providers/discourse.json`
- Modify: `bot-scripts/src/config/types.ts`
- Modify: `bot-scripts/src/config/load.ts`
- Modify: `bot-scripts/test/fixtures/config/android.yaml`
- Modify: `bot-scripts/test/config/load.test.ts`

**Interfaces:**
- Produces, under a github repository: `pulls: { states: ('merged'|'closed')[] = ['merged','closed'], closedWithinDays?, reviews: boolean = true, excludeBots: boolean = true }`, `discussions: { categories: string[] (slugs), answers: boolean = true }`, `releases: { includePrereleases: boolean = false, withinDays? }`, `code: { include: string[], exclude: string[] = [], ref: string = 'main', audience = 'maintainer' }`, `files: { path, kind: 'strings'|'markdown', audience = 'maintainer' }[]`.
- Produces `providers.discourse`: map keyed by host, value `{ categories: string[] (slug or numeric id as string), tags: string[] = [], solvedOnly: boolean = false, acceptedAnswers: boolean = true, closedWithinDays?, requestsPerSecond: number = 4 }`.
- Types: `PullsConfig`, `DiscussionsConfig`, `ReleasesConfig`, `CodeConfig`, `FileConfig`, `DiscourseSiteConfig`; `Config.providers.discourse?: Record<string, DiscourseSiteConfig>`.

- [ ] **Step 1: Write the failing tests**

Replace the github section of the fixture `android.yaml` with:

```yaml
providers:
  github:
    home-assistant/android:
      issues:
        states: [open, closed]
        comments: true
      pulls:
        states: [merged, closed]
      discussions:
        categories: [general, q-a]
      releases: {}
      code:
        include: ["**/*.kt"]
        exclude: ["**/build/**"]
      files:
        - path: common/src/main/res/values/strings.xml
          kind: strings
        - path: .agents/skills
          kind: markdown
    home-assistant/companion.home-assistant:
      docs:
        path: docs
        baseUrl: https://companion.home-assistant.io/docs/
    home-assistant/contributors.home-assistant.io:
      docs:
        path: src/content/docs/companion
        baseUrl: https://contributors.home-assistant.io/companion/
        audience: developer
  discourse:
    community.home-assistant.io:
      categories: [android-companion]
      tags: [android]
```

Append to `load.test.ts`:

```ts
test('applies defaults to the new github source kinds', () => {
  const android = loadConfig(fixture).providers.github['home-assistant/android'];
  assert.deepEqual(android.pulls, { states: ['merged', 'closed'], reviews: true, excludeBots: true });
  assert.deepEqual(android.discussions, { categories: ['general', 'q-a'], answers: true });
  assert.deepEqual(android.releases, { includePrereleases: false });
  assert.equal(android.code.ref, 'main');
  assert.equal(android.code.audience, 'maintainer');
  assert.equal(android.files[0].audience, 'maintainer');
});

test('applies defaults to a discourse site and rejects an unknown key', () => {
  const config = loadConfig(fixture);
  const site = config.providers.discourse['community.home-assistant.io'];
  assert.deepEqual(site, { categories: ['android-companion'], tags: ['android'], solvedOnly: false, acceptedAnswers: true, requestsPerSecond: 4 });
  (site as Record<string, unknown>).scrapeEverything = true;
  assert.throws(() => validateConfig(config), (e) => e instanceof ConfigError && /discourse.*scrapeEverything/.test(e.message));
});

test('a file entry needs a known kind', () => {
  const config = loadConfig(fixture);
  config.providers.github['home-assistant/android'].files.push({ path: 'x', kind: 'pdf' } as never);
  assert.throws(() => validateConfig(config), ConfigError);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot-scripts && node --test test/config/load.test.ts`
Expected: the fixture itself now fails validation (`pulls`, `discussions`, `releases`, `code`, `files`, `discourse` unknown), so every test in the file fails.

- [ ] **Step 3: Implement**

Add to the repository `properties` in `schemas/providers/github.json`:

```json
      "pulls": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "states": { "type": "array", "items": { "enum": ["merged", "closed"] }, "default": ["merged", "closed"], "minItems": 1, "description": "closed means closed without merge." },
          "closedWithinDays": { "type": "integer", "minimum": 1, "description": "Only index pull requests closed within this many days. Omit for all." },
          "reviews": { "type": "boolean", "default": true, "description": "Index review threads that have a maintainer reply." },
          "excludeBots": { "type": "boolean", "default": true, "description": "Skip pull requests opened by bot accounts such as renovate." }
        }
      },
      "discussions": {
        "type": "object",
        "additionalProperties": false,
        "required": ["categories"],
        "properties": {
          "categories": { "type": "array", "items": { "type": "string" }, "minItems": 1, "description": "Category slugs to index." },
          "answers": { "type": "boolean", "default": true, "description": "Index the accepted answer as its own chunk." }
        }
      },
      "releases": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "includePrereleases": { "type": "boolean", "default": false },
          "withinDays": { "type": "integer", "minimum": 1, "description": "Only index releases published within this many days. Omit for all." }
        }
      },
      "code": {
        "type": "object",
        "additionalProperties": false,
        "required": ["include"],
        "properties": {
          "include": { "type": "array", "items": { "type": "string" }, "minItems": 1, "description": "Glob patterns relative to the checkout." },
          "exclude": { "type": "array", "items": { "type": "string" }, "default": [] },
          "ref": { "type": "string", "default": "main", "description": "Branch used in the source links." },
          "audience": { "enum": ["user", "developer", "maintainer"], "default": "maintainer" }
        }
      },
      "files": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["path", "kind"],
          "properties": {
            "path": { "type": "string", "minLength": 1 },
            "kind": { "enum": ["strings", "markdown"] },
            "audience": { "enum": ["user", "developer", "maintainer"], "default": "maintainer" }
          }
        }
      }
```

`schemas/providers/discourse.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://home-assistant.io/auto-triage/providers/discourse.json",
  "type": "object",
  "minProperties": 1,
  "propertyNames": { "pattern": "^[a-z0-9.-]+$" },
  "additionalProperties": {
    "type": "object",
    "additionalProperties": false,
    "required": ["categories"],
    "properties": {
      "categories": { "type": "array", "items": { "type": "string" }, "minItems": 1, "description": "Category slugs or numeric ids. A topic must be in one of them." },
      "tags": { "type": "array", "items": { "type": "string" }, "default": [], "description": "When given, a topic must also carry one of these tags." },
      "solvedOnly": { "type": "boolean", "default": false },
      "acceptedAnswers": { "type": "boolean", "default": true, "description": "Index the accepted answer as its own chunk." },
      "closedWithinDays": { "type": "integer", "minimum": 1, "description": "Only index topics with activity within this many days. Omit for all." },
      "requestsPerSecond": { "type": "number", "exclusiveMinimum": 0, "maximum": 20, "default": 4 }
    }
  }
}
```

In `load.ts`, `defaultProviderSchemas` returns `{ github: ..., discourse: readSchema('providers/discourse.json') }`.

In `types.ts` add the interfaces listed under Interfaces, extend `GithubRepoConfig` with `pulls?`, `discussions?`, `releases?`, `code?`, `files?`, and `Config.providers` with `discourse?: Record<string, DiscourseSiteConfig>`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && npm test`
Expected: exit 0. The build test still passes because the registry ignores the new keys until later tasks wire them.

- [ ] **Step 5: Commit**

Commit `Add config schema for pulls, discussions, releases, code, files and discourse`.

---

### Task 6: Pull requests reader

**Files:**
- Create: `bot-scripts/src/providers/github/pulls.ts`
- Test: `bot-scripts/test/providers/github/pulls.test.ts`
- Fixtures: `bot-scripts/test/fixtures/github/pulls-page.json`, `bot-scripts/test/fixtures/github/pull-40-review-comments.json`, `bot-scripts/test/fixtures/github/pull-40-files.json`

**Interfaces:**
- Consumes: `cleanIssueText`, `packText`, `PaginatingClient`, `PullsConfig`.
- Produces: `readPulls({ client, repo, options, now }): AsyncGenerator<IndexItem>` with `source: 'pull'`. Chunks: `body` pieces (`authorRole: 'reporter'` meaning the PR author), one `review` chunk per review thread that has at least one maintainer comment, text `path:line\n<comments joined by blank lines>`, `authorRole` of the thread's first maintainer. `outcome: { state: 'merged'|'closed', mergedAt, closedAt, labels, linkedIssues: number[], files: string[] (first 50), base }`. Bot authors skipped when `excludeBots`. Linked issues parsed from the body with `/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/gi`.

- [ ] **Step 1: Write fixtures and failing tests**

`pulls-page.json`:

```json
[
  { "number": 40, "title": "Re-register widgets after boot", "state": "closed", "merged_at": "2025-03-04T10:00:00Z", "closed_at": "2025-03-04T10:00:00Z", "html_url": "https://github.com/o/r/pull/40", "user": { "login": "dev", "type": "User" }, "author_association": "MEMBER", "labels": [{ "name": "widget" }], "created_at": "2025-03-02T10:00:00Z", "updated_at": "2025-03-04T10:00:00Z", "draft": false, "base": { "ref": "main" }, "body": "## Summary\nWidgets re-register on BOOT_COMPLETED.\n\nFixes #12 and closes o/r#9." },
  { "number": 41, "title": "Update dependency foo to v2", "state": "closed", "merged_at": "2025-03-05T10:00:00Z", "closed_at": "2025-03-05T10:00:00Z", "html_url": "https://github.com/o/r/pull/41", "user": { "login": "renovate[bot]", "type": "Bot" }, "author_association": "CONTRIBUTOR", "labels": [], "created_at": "2025-03-05T09:00:00Z", "updated_at": "2025-03-05T10:00:00Z", "draft": false, "base": { "ref": "main" }, "body": "This PR contains the following updates" },
  { "number": 42, "title": "Try a different widget provider", "state": "closed", "merged_at": null, "closed_at": "2025-03-06T10:00:00Z", "html_url": "https://github.com/o/r/pull/42", "user": { "login": "someone", "type": "User" }, "author_association": "NONE", "labels": [], "created_at": "2025-03-01T10:00:00Z", "updated_at": "2025-03-06T10:00:00Z", "draft": false, "base": { "ref": "main" }, "body": "Replaces the provider." }
]
```

`pull-40-review-comments.json`:

```json
[
  { "id": 1, "in_reply_to_id": null, "path": "app/src/main/kotlin/Widget.kt", "line": 12, "user": { "login": "someone" }, "author_association": "NONE", "created_at": "2025-03-02T11:00:00Z", "body": "Why not use WorkManager here?" },
  { "id": 2, "in_reply_to_id": 1, "path": "app/src/main/kotlin/Widget.kt", "line": 12, "user": { "login": "maintainer" }, "author_association": "MEMBER", "created_at": "2025-03-02T12:00:00Z", "body": "WorkManager is delayed after boot; a receiver is what we need." },
  { "id": 3, "in_reply_to_id": null, "path": "README.md", "line": 1, "user": { "login": "someone" }, "author_association": "NONE", "created_at": "2025-03-02T13:00:00Z", "body": "typo" }
]
```

`pull-40-files.json`:

```json
[{ "filename": "app/src/main/kotlin/Widget.kt", "status": "modified" }, { "filename": "CHANGELOG.md", "status": "modified" }]
```

`pulls.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readPulls } from '../../../src/providers/github/pulls.ts';
import type { PullsConfig } from '../../../src/config/types.ts';

const read = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/github/${name}`, import.meta.url), 'utf8'));
const page = read('pulls-page.json');
const reviewComments = read('pull-40-review-comments.json');
const files = read('pull-40-files.json');

function fakeClient(log = []) {
  return {
    async *paginate(path, params) {
      log.push({ path, params });
      if (path === '/repos/o/r/pulls') yield* page;
      else if (path === '/repos/o/r/pulls/40/comments') yield* reviewComments;
      else if (path === '/repos/o/r/pulls/40/files') yield* files;
      else yield* [];
    },
  };
}
const options: PullsConfig = { states: ['merged', 'closed'], reviews: true, excludeBots: true };
const now = new Date('2026-10-15T00:00:00Z');
async function collect(opts = options, log = []) { const out = []; for await (const i of readPulls({ client: fakeClient(log), repo: 'o/r', options: opts, now })) out.push(i); return out; }

test('yields a merged pull request with body, linked issues, files and the maintainer review thread', async () => {
  const pr = (await collect()).find((i) => i.sourceId === '40');
  assert.equal(pr.source, 'pull');
  assert.equal(pr.outcome.state, 'merged');
  assert.deepEqual(pr.outcome.linkedIssues, [12, 9]);
  assert.deepEqual(pr.outcome.files, ['app/src/main/kotlin/Widget.kt', 'CHANGELOG.md']);
  assert.equal(pr.chunks[0].kind, 'body');
  assert.ok(pr.chunks[0].text.startsWith('Re-register widgets after boot'));
  const reviews = pr.chunks.filter((c) => c.kind === 'review');
  assert.equal(reviews.length, 1, 'only the thread with a maintainer reply');
  assert.ok(reviews[0].text.startsWith('app/src/main/kotlin/Widget.kt:12\n'));
  assert.ok(reviews[0].text.includes('WorkManager is delayed'));
  assert.equal(reviews[0].authorRole, 'maintainer');
});

test('skips bot pull requests by default', async () => {
  assert.ok((await collect()).every((i) => i.sourceId !== '41'));
  assert.ok((await collect({ ...options, excludeBots: false })).some((i) => i.sourceId === '41'));
});

test('an unmerged pull request is state closed', async () => {
  const pr = (await collect()).find((i) => i.sourceId === '42');
  assert.equal(pr.outcome.state, 'closed');
  assert.equal(pr.outcome.mergedAt, null);
});

test('states filter drops unmerged pull requests when only merged is wanted', async () => {
  const items = await collect({ ...options, states: ['merged'] });
  assert.ok(items.every((i) => i.sourceId !== '42'));
});

test('does not fetch reviews or files when reviews are off', async () => {
  const log = [];
  await collect({ ...options, reviews: false }, log);
  assert.ok(log.every((c) => !c.path.endsWith('/comments')));
});

test('lists closed pull requests sorted by update', async () => {
  const log = [];
  await collect(options, log);
  assert.deepEqual(log[0], { path: '/repos/o/r/pulls', params: { state: 'closed', per_page: 100, sort: 'updated', direction: 'asc' } });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot-scripts && node --test test/providers/github/pulls.test.ts`
Expected: FAIL with `Cannot find module '.../pulls.ts'`.

- [ ] **Step 3: Implement `pulls.ts`**

```ts
import { cleanIssueText } from '../../text/clean.ts';
import { packText } from '../../text/chunk.ts';
import type { PullsConfig } from '../../config/types.ts';
import type { AuthorRole, IndexChunk, IndexItem, PaginatingClient } from '../types.ts';

const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const DAY_MS = 24 * 60 * 60 * 1000;
const CHUNK_CHARS = 2000;
const MAX_FILES = 50;
const LINKED_ISSUE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/gi;

interface ApiPull {
  number: number; title: string; state: string; merged_at: string | null; closed_at: string | null; html_url: string;
  user?: { login?: string; type?: string }; author_association?: string; labels?: { name: string }[];
  created_at: string; updated_at: string; draft: boolean; base?: { ref?: string }; body?: string | null;
}
interface ApiReviewComment {
  id: number; in_reply_to_id: number | null; path: string; line: number | null; user?: { login?: string };
  author_association?: string; created_at: string; body?: string | null;
}

function isBot(pull: ApiPull): boolean {
  return pull.user?.type === 'Bot' || (pull.user?.login ?? '').endsWith('[bot]');
}

function roleOf(association: string | undefined, login: string | undefined, author: string): AuthorRole {
  if (login === author) return 'reporter';
  if (association && MAINTAINER_ASSOCIATIONS.has(association)) return 'maintainer';
  return 'user';
}

export function linkedIssues(body: string): number[] {
  return Array.from(new Set(Array.from(body.matchAll(LINKED_ISSUE), (m) => Number(m[1]))));
}

/** Groups review comments into threads (root comment plus replies) keeping API order. */
function threads(comments: ApiReviewComment[]): ApiReviewComment[][] {
  const byRoot = new Map<number, ApiReviewComment[]>();
  for (const c of comments) {
    const root = c.in_reply_to_id ?? c.id;
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root)!.push(c);
  }
  return Array.from(byRoot.values());
}

function reviewChunks(comments: ApiReviewComment[], firstSeq: number, author: string): IndexChunk[] {
  const chunks: IndexChunk[] = [];
  for (const thread of threads(comments)) {
    const maintainer = thread.find((c) => roleOf(c.author_association, c.user?.login, author) === 'maintainer');
    if (!maintainer) continue;
    const head = `${thread[0].path}:${thread[0].line ?? ''}`;
    const body = thread.map((c) => cleanIssueText(c.body ?? '').text).filter(Boolean).join('\n\n');
    for (const piece of packText(body, { maxChars: CHUNK_CHARS - head.length - 1 })) {
      chunks.push({ seq: firstSeq + chunks.length, kind: 'review', heading: head, text: `${head}\n${piece}`, logs: null, createdAt: maintainer.created_at, authorRole: 'maintainer' });
    }
  }
  return chunks;
}

export interface ReadPullsInput { client: PaginatingClient; repo: string; options: PullsConfig; now?: Date }

/** Reads closed pull requests, merged or not, with their maintainer review threads. */
export async function* readPulls({ client, repo, options, now = new Date() }: ReadPullsInput): AsyncGenerator<IndexItem> {
  const cutoff = options.closedWithinDays === undefined ? null : new Date(now.getTime() - options.closedWithinDays * DAY_MS);
  const wanted = new Set(options.states);
  for await (const raw of client.paginate(`/repos/${repo}/pulls`, { state: 'closed', per_page: 100, sort: 'updated', direction: 'asc' })) {
    const pull = raw as ApiPull;
    const state = pull.merged_at ? 'merged' : 'closed';
    if (!wanted.has(state)) continue;
    if (options.excludeBots && isBot(pull)) continue;
    if (cutoff && pull.closed_at && new Date(pull.closed_at) < cutoff) continue;

    const author = pull.user?.login ?? '';
    const { text, logs } = cleanIssueText(pull.body ?? '');
    const chunks: IndexChunk[] = [];
    for (const piece of packText([pull.title, text].filter(Boolean).join('\n\n'), { maxChars: CHUNK_CHARS })) {
      chunks.push({ seq: chunks.length, kind: 'body', text: piece, logs: chunks.length === 0 ? logs : null, createdAt: pull.created_at, authorRole: 'reporter' });
    }
    let files: string[] = [];
    if (options.reviews) {
      const comments: ApiReviewComment[] = [];
      for await (const c of client.paginate(`/repos/${repo}/pulls/${pull.number}/comments`, { per_page: 100 })) comments.push(c as ApiReviewComment);
      chunks.push(...reviewChunks(comments, chunks.length, author));
      for await (const f of client.paginate(`/repos/${repo}/pulls/${pull.number}/files`, { per_page: 100 })) {
        if (files.length >= MAX_FILES) break;
        files.push((f as { filename: string }).filename);
      }
    }
    yield {
      source: 'pull', provider: 'github', origin: repo, sourceId: String(pull.number), url: pull.html_url, title: pull.title,
      audience: 'user', createdAt: pull.created_at, updatedAt: pull.updated_at,
      outcome: { state, mergedAt: pull.merged_at, closedAt: pull.closed_at, labels: (pull.labels ?? []).map((l) => l.name), linkedIssues: linkedIssues(pull.body ?? ''), files, base: pull.base?.ref ?? null },
      extra: { author }, chunks,
    };
  }
}
```

**Raw store (Task 2b):** `ReadPullsInput` takes `raw?: RawStore`. Before fetching review comments and files, `raw?.get('github', repo, 'pull', String(pull.number))` with an equal `updatedAt` supplies `{ reviewComments, files }`; otherwise fetch and `raw?.put({ ..., kind: 'pull', updatedAt: pull.updated_at, payload: { pull, reviewComments, files } })`. Add the test `reuses stored review comments and files when the pull request has not changed` (two passes with the same store, the second pass makes no `/comments` or `/files` request) and `records the pull request in the raw store` (payload `pull.number === 40`, `files.length === 2`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && npm test`
Expected: exit 0.

- [ ] **Step 5: Commit**

Commit `Add pull requests reader with maintainer review threads`.

---

### Task 7: Discussions reader (GraphQL)

**Files:**
- Create: `bot-scripts/src/providers/github/discussions.ts`
- Test: `bot-scripts/test/providers/github/discussions.test.ts`

**Interfaces:**
- Consumes: `PaginatingClient.graphql` (Task 2), `DiscussionsConfig`.
- Produces: `readDiscussions({ client, repo, options }): AsyncGenerator<IndexItem>` with `source: 'discussion'`. Resolves category slugs to ids with one query, then pages each category with `discussions(first: 50, after, categoryId, orderBy: {field: UPDATED_AT, direction: DESC})`. Chunks: `body` pieces (`authorRole: 'reporter'`), and when `answers` and the discussion has an answer, one `answer` chunk whose role comes from `authorAssociation`. `outcome: { closed, isAnswered, category, comments }`. Unknown slugs are reported in one error naming them.

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDiscussions } from '../../../src/providers/github/discussions.ts';

const categories = { repository: { discussionCategories: { nodes: [{ id: 'C1', slug: 'general' }, { id: 'C2', slug: 'q-a' }] } } };
const pageFor = (categoryId, after) => ({ repository: { discussions: {
  pageInfo: { hasNextPage: categoryId === 'C1' && !after, endCursor: 'cur1' },
  nodes: categoryId === 'C1' && !after ? [{ number: 7, title: 'Wear OS battery', url: 'https://github.com/o/r/discussions/7', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-02T00:00:00Z', closed: false, isAnswered: true, category: { slug: 'general' }, bodyText: 'Battery drains on my watch.', author: { login: 'asker' }, authorAssociation: 'NONE', comments: { totalCount: 2 }, answer: { bodyText: 'Disable the always-on sensor.', author: { login: 'maint' }, authorAssociation: 'MEMBER', createdAt: '2025-01-02T00:00:00Z' } }]
    : categoryId === 'C1' ? [{ number: 8, title: 'Second page', url: 'https://github.com/o/r/discussions/8', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z', closed: true, isAnswered: false, category: { slug: 'general' }, bodyText: 'Old.', author: { login: 'x' }, authorAssociation: 'NONE', comments: { totalCount: 0 }, answer: null }]
    : [],
} } });

function fakeClient(log = []) {
  return {
    async *paginate() { yield* []; },
    async graphql(query, variables) {
      log.push({ query, variables });
      if (query.includes('discussionCategories')) return categories;
      return pageFor(variables.categoryId, variables.after);
    },
  };
}
async function collect(options = { categories: ['general', 'q-a'], answers: true }, log = []) { const out = []; for await (const i of readDiscussions({ client: fakeClient(log), repo: 'o/r', options })) out.push(i); return out; }

test('resolves category slugs, pages each category and yields body and answer chunks', async () => {
  const items = await collect();
  assert.deepEqual(items.map((i) => i.sourceId), ['7', '8']);
  const d = items[0];
  assert.equal(d.source, 'discussion');
  assert.deepEqual(d.outcome, { closed: false, isAnswered: true, category: 'general', comments: 2 });
  assert.equal(d.chunks[0].kind, 'body');
  assert.equal(d.chunks[0].authorRole, 'reporter');
  assert.equal(d.chunks[1].kind, 'answer');
  assert.equal(d.chunks[1].authorRole, 'maintainer');
  assert.equal(d.chunks[1].text, 'Disable the always-on sensor.');
});

test('passes the cursor on the second page', async () => {
  const log = [];
  await collect(undefined, log);
  const pages = log.filter((c) => c.variables?.categoryId === 'C1').map((c) => c.variables.after);
  assert.deepEqual(pages, [null, 'cur1']);
});

test('fails naming an unknown category slug', async () => {
  await assert.rejects(() => collect({ categories: ['general', 'nope'], answers: true }), /nope/);
});

test('omits the answer chunk when answers are off', async () => {
  const [d] = await collect({ categories: ['general'], answers: false });
  assert.ok(d.chunks.every((c) => c.kind !== 'answer'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot-scripts && node --test test/providers/github/discussions.test.ts`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `discussions.ts`**

```ts
import { cleanIssueText } from '../../text/clean.ts';
import { packText } from '../../text/chunk.ts';
import type { DiscussionsConfig } from '../../config/types.ts';
import type { AuthorRole, IndexChunk, IndexItem, PaginatingClient } from '../types.ts';

const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const CHUNK_CHARS = 2000;
const PAGE = 50;

const CATEGORIES_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { discussionCategories(first: 50) { nodes { id slug } } } }`;

const DISCUSSIONS_QUERY = `query($owner: String!, $name: String!, $categoryId: ID!, $after: String, $first: Int!) {
  repository(owner: $owner, name: $name) {
    discussions(first: $first, after: $after, categoryId: $categoryId, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { number title url createdAt updatedAt closed isAnswered category { slug } bodyText
              author { login } authorAssociation comments { totalCount }
              answer { bodyText createdAt author { login } authorAssociation } } } } }`;

interface Category { id: string; slug: string }
interface Node {
  number: number; title: string; url: string; createdAt: string; updatedAt: string; closed: boolean; isAnswered: boolean | null;
  category: { slug: string }; bodyText: string; author: { login: string } | null; authorAssociation: string;
  comments: { totalCount: number }; answer: { bodyText: string; createdAt: string; author: { login: string } | null; authorAssociation: string } | null;
}
interface Page { repository: { discussions: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Node[] } } }

function roleOf(association: string, login: string | undefined, author: string | undefined): AuthorRole {
  if (login && login === author) return 'reporter';
  return MAINTAINER_ASSOCIATIONS.has(association) ? 'maintainer' : 'user';
}

async function categoryIds(client: PaginatingClient, owner: string, name: string, slugs: string[]): Promise<Category[]> {
  const data = await client.graphql!<{ repository: { discussionCategories: { nodes: Category[] } } }>(CATEGORIES_QUERY, { owner, name });
  const known = new Map(data.repository.discussionCategories.nodes.map((c) => [c.slug, c]));
  const missing = slugs.filter((s) => !known.has(s));
  if (missing.length) throw new Error(`Unknown discussion categories for ${owner}/${name}: ${missing.join(', ')}`);
  return slugs.map((s) => known.get(s)!);
}

function toItem(node: Node, repo: string, answers: boolean): IndexItem {
  const { text, logs } = cleanIssueText(node.bodyText);
  const chunks: IndexChunk[] = [];
  for (const piece of packText([node.title, text].filter(Boolean).join('\n\n'), { maxChars: CHUNK_CHARS })) {
    chunks.push({ seq: chunks.length, kind: 'body', text: piece, logs: chunks.length === 0 ? logs : null, createdAt: node.createdAt, authorRole: 'reporter' });
  }
  if (answers && node.answer) {
    const role = roleOf(node.answer.authorAssociation, node.answer.author?.login, node.author?.login);
    for (const piece of packText(cleanIssueText(node.answer.bodyText).text, { maxChars: CHUNK_CHARS })) {
      chunks.push({ seq: chunks.length, kind: 'answer', text: piece, logs: null, createdAt: node.answer.createdAt, authorRole: role });
    }
  }
  return {
    source: 'discussion', provider: 'github', origin: repo, sourceId: String(node.number), url: node.url, title: node.title,
    audience: 'user', createdAt: node.createdAt, updatedAt: node.updatedAt,
    outcome: { closed: node.closed, isAnswered: node.isAnswered ?? false, category: node.category.slug, comments: node.comments.totalCount },
    extra: { author: node.author?.login ?? null }, chunks,
  };
}

export interface ReadDiscussionsInput { client: PaginatingClient; repo: string; options: DiscussionsConfig }

/** Reads the discussions of the configured categories through GraphQL. */
export async function* readDiscussions({ client, repo, options }: ReadDiscussionsInput): AsyncGenerator<IndexItem> {
  if (!client.graphql) throw new Error('discussions need a GraphQL-capable client');
  const [owner, name] = repo.split('/');
  for (const category of await categoryIds(client, owner, name, options.categories)) {
    let after: string | null = null;
    do {
      const page: Page = await client.graphql<Page>(DISCUSSIONS_QUERY, { owner, name, categoryId: category.id, after, first: PAGE });
      for (const node of page.repository.discussions.nodes) yield toItem(node, repo, options.answers);
      after = page.repository.discussions.pageInfo.hasNextPage ? page.repository.discussions.pageInfo.endCursor : null;
    } while (after);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && npm test`
Expected: exit 0.

**Raw store (Task 2b):** `ReadDiscussionsInput` takes `raw?: RawStore`; every node is stored with `raw?.put({ provider: 'github', origin: repo, kind: 'discussion', id: String(node.number), updatedAt: node.updatedAt, payload: node })` (nothing to reuse: the page carries the whole node). Test `records discussions in the raw store` (record `7` has `payload.answer.bodyText`).

- [ ] **Step 5: Commit**

Commit `Add discussions reader over GraphQL`.

---

### Task 8: Releases reader

**Files:**
- Create: `bot-scripts/src/providers/github/releases.ts`
- Modify: `bot-scripts/src/providers/types.ts` (add `'release'` to `SourceKind`)
- Modify: `bot-scripts/src/store/schema.sql` (comment only)
- Test: `bot-scripts/test/providers/github/releases.test.ts`

**Interfaces:**
- Produces: `readReleases({ client, repo, options, now }): AsyncGenerator<IndexItem>` with `source: 'release'`, `sourceId` = tag, `title` = tag (or name when set), `createdAt` = `published_at`, chunks from `chunkMarkdown(body)` with `kind: 'section'` and the tag prefixed to the first chunk, `outcome: { prerelease }`. Drafts and, by default, prereleases are skipped; `withinDays` filters on `published_at`.

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readReleases } from '../../../src/providers/github/releases.ts';

const page = [
  { tag_name: '2026.8.4', name: '', draft: false, prerelease: false, published_at: '2026-08-31T09:42:13Z', html_url: 'https://github.com/o/r/releases/tag/2026.8.4', body: '## Highlights of this release\n* Added an **assistant volume** sensor\n\n## What\'s Changed\n* Bump foo by @renovate in https://github.com/o/r/pull/1' },
  { tag_name: '2026.10.1', name: null, draft: false, prerelease: true, published_at: '2026-10-06T13:38:43Z', html_url: 'https://github.com/o/r/releases/tag/2026.10.1', body: 'beta' },
  { tag_name: 'draft', name: null, draft: true, prerelease: false, published_at: null, html_url: 'https://github.com/o/r/releases/tag/draft', body: 'x' },
  { tag_name: '2022.1.0', name: 'Old', draft: false, prerelease: false, published_at: '2022-01-10T00:00:00Z', html_url: 'https://github.com/o/r/releases/tag/2022.1.0', body: 'Old notes' },
];
const client = { async *paginate(path) { if (path === '/repos/o/r/releases') yield* page; } };
async function collect(options) { const out = []; for await (const i of readReleases({ client, repo: 'o/r', options, now: new Date('2026-10-15T00:00:00Z') })) out.push(i); return out; }

test('indexes stable releases with sections and skips drafts and prereleases by default', async () => {
  const items = await collect({ includePrereleases: false });
  assert.deepEqual(items.map((i) => i.sourceId), ['2026.8.4', '2022.1.0']);
  const r = items[0];
  assert.equal(r.source, 'release');
  assert.equal(r.createdAt, '2026-08-31T09:42:13Z');
  assert.ok(r.chunks[0].text.startsWith('2026.8.4\n'));
  assert.equal(r.chunks[0].heading, 'Highlights of this release');
  assert.equal(r.chunks[1].anchor, 'whats-changed');
});

test('includes prereleases when asked and applies the window', async () => {
  const items = await collect({ includePrereleases: true, withinDays: 90 });
  assert.deepEqual(items.map((i) => i.sourceId), ['2026.8.4', '2026.10.1']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot-scripts && node --test test/providers/github/releases.test.ts`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement**

Add `'release'` to `SourceKind` in `types.ts` and to the `source` comment in `schema.sql`.

`releases.ts`:

```ts
import { chunkMarkdown } from '../../text/chunk.ts';
import type { ReleasesConfig } from '../../config/types.ts';
import type { IndexChunk, IndexItem, PaginatingClient } from '../types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

interface ApiRelease { tag_name: string; name: string | null; draft: boolean; prerelease: boolean; published_at: string | null; html_url: string; body: string | null }

export interface ReadReleasesInput { client: PaginatingClient; repo: string; options: ReleasesConfig; now?: Date }

/** Reads release notes: which version shipped what. */
export async function* readReleases({ client, repo, options, now = new Date() }: ReadReleasesInput): AsyncGenerator<IndexItem> {
  const cutoff = options.withinDays === undefined ? null : new Date(now.getTime() - options.withinDays * DAY_MS);
  for await (const raw of client.paginate(`/repos/${repo}/releases`, { per_page: 100 })) {
    const release = raw as ApiRelease;
    if (release.draft || !release.published_at) continue;
    if (release.prerelease && !options.includePrereleases) continue;
    if (cutoff && new Date(release.published_at) < cutoff) continue;
    const title = release.name?.trim() ? `${release.tag_name} ${release.name.trim()}` : release.tag_name;
    const chunks: IndexChunk[] = chunkMarkdown(release.body ?? '').map((c, seq) => ({
      seq, kind: 'section', heading: c.heading, anchor: c.anchor,
      text: [seq === 0 ? release.tag_name : null, ...c.breadcrumbs, c.text].filter(Boolean).join('\n'),
      logs: null, createdAt: release.published_at!,
    }));
    if (chunks.length === 0) continue;
    yield {
      source: 'release', provider: 'github', origin: repo, sourceId: release.tag_name, url: release.html_url, title,
      audience: 'user', createdAt: release.published_at, updatedAt: null, outcome: { prerelease: release.prerelease }, extra: null, chunks,
    };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && npm test`
Expected: exit 0.

**Raw store (Task 2b):** `ReadReleasesInput` takes `raw?: RawStore`; each indexed release is stored under kind `release`, id `tag_name`, `updatedAt: published_at`, payload the release object. Test `records releases in the raw store` (record `2026.8.4` payload has `body`).

- [ ] **Step 5: Commit**

Commit `Add releases reader`.

---

### Task 9: Kotlin code reader

**Files:**
- Create: `bot-scripts/src/providers/github/code.ts`
- Test: `bot-scripts/test/providers/github/code.test.ts`
- Fixtures: `bot-scripts/test/fixtures/code/app/src/main/kotlin/io/ha/widgets/EntityWidget.kt`, `bot-scripts/test/fixtures/code/app/build/Generated.kt`, `bot-scripts/test/fixtures/code/app/src/main/kotlin/io/ha/OnlyImports.kt`

**Interfaces:**
- Consumes: `packText`, `CodeConfig`.
- Produces: `readCode({ repo, checkoutPath, options }): AsyncGenerator<IndexItem>` with `source: 'code'`, one item per matching file (`sourceId` = path relative to the checkout, `url` = `https://github.com/{repo}/blob/{ref}/{path}`, `createdAt` = `DOCS_EPOCH`), one `symbol` chunk per top-level declaration (its KDoc and annotations included), `heading` = declaration name, text prefixed with `path` and `package`, string resource keys referenced in the declaration appended as a final line `strings: key1, key2`. Also exports `splitDeclarations(source: string): { name: string; text: string }[]` and `globToRegExp(glob: string): RegExp` (supports `**`, `*`, `?`).

- [ ] **Step 1: Write fixtures and failing tests**

`EntityWidget.kt`:

```kotlin
package io.ha.widgets

import android.content.Context

/**
 * Renders the state of one entity on the home screen.
 */
class EntityWidget(private val context: Context) {
    fun refresh() {
        val label = context.getString(R.string.widget_entity_refresh)
    }
}

/** Shared helper. */
internal fun widgetLabel(context: Context): String = context.getString(commonR.string.widget_label)

private const val TAG = "EntityWidget"
```

`Generated.kt` (under `build/`, must be excluded): `package gen\n\nclass Generated\n`

`OnlyImports.kt`: `package io.ha\n\nimport android.content.Context\n`

`code.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readCode, splitDeclarations, globToRegExp } from '../../../src/providers/github/code.ts';

const checkout = fileURLToPath(new URL('../../fixtures/code/', import.meta.url));
const options = { include: ['**/*.kt'], exclude: ['**/build/**'], ref: 'main', audience: 'maintainer' as const };
async function collect() { const out = []; for await (const i of readCode({ repo: 'o/r', checkoutPath: checkout, options })) out.push(i); return out.sort((a, b) => a.sourceId.localeCompare(b.sourceId)); }

test('globToRegExp handles ** and *', () => {
  assert.ok(globToRegExp('**/*.kt').test('app/src/main/A.kt'));
  assert.ok(globToRegExp('**/*.kt').test('A.kt'));
  assert.ok(!globToRegExp('**/*.kt').test('A.kts'));
  assert.ok(globToRegExp('**/build/**').test('app/build/Generated.kt'));
  assert.ok(!globToRegExp('**/build/**').test('app/src/Build.kt'));
});

test('splitDeclarations keeps KDoc and annotations with their declaration', () => {
  const src = 'package p\n\nimport x\n\n/** Doc. */\n@Keep\nclass A {\n  fun inner() {}\n}\n\nfun top() = 1\n\nprivate const val T = "t"\n';
  const decls = splitDeclarations(src);
  assert.deepEqual(decls.map((d) => d.name), ['A', 'top', 'T']);
  assert.ok(decls[0].text.startsWith('/** Doc. */\n@Keep\nclass A'));
  assert.ok(decls[0].text.includes('fun inner()'), 'members stay inside the class chunk');
});

test('yields one item per included file with symbol chunks, path, package and string keys', async () => {
  const items = await collect();
  assert.deepEqual(items.map((i) => i.sourceId), ['app/src/main/kotlin/io/ha/widgets/EntityWidget.kt']);
  const [file] = items;
  assert.equal(file.source, 'code');
  assert.equal(file.url, 'https://github.com/o/r/blob/main/app/src/main/kotlin/io/ha/widgets/EntityWidget.kt');
  assert.equal(file.audience, 'maintainer');
  assert.deepEqual(file.chunks.map((c) => c.heading), ['EntityWidget', 'widgetLabel', 'TAG']);
  assert.ok(file.chunks[0].text.startsWith('app/src/main/kotlin/io/ha/widgets/EntityWidget.kt\npackage io.ha.widgets\n'));
  assert.ok(file.chunks[0].text.endsWith('strings: widget_entity_refresh'));
  assert.ok(file.chunks[1].text.endsWith('strings: widget_label'));
  assert.ok(file.chunks.every((c) => c.kind === 'symbol'));
});

test('yields nothing for a file without declarations', async () => {
  assert.ok((await collect()).every((i) => !i.sourceId.endsWith('OnlyImports.kt')));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot-scripts && node --test test/providers/github/code.test.ts`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `code.ts`**

```ts
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { packText } from '../../text/chunk.ts';
import type { CodeConfig } from '../../config/types.ts';
import type { IndexChunk, IndexItem } from '../types.ts';
import { DOCS_EPOCH } from './docs.ts';

const CHUNK_CHARS = 2000;
const DECLARATION = /^(?:(?:public|internal|private|protected|open|abstract|sealed|data|enum|annotation|value|inline|suspend|override|operator|infix|expect|actual|const|external|lateinit)\s+)*(?:class|interface|object|fun|val|var|typealias)\b\s*(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)/;
const KDOC_OR_ANNOTATION = /^(\s*\/\*\*|\s*\*|\s*\*\/|\s*@\w)/;
const STRING_KEY = /\b(?:R|commonR)\.string\.(\w+)/g;

export function globToRegExp(glob: string): RegExp {
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${pattern}$`);
}

/** Splits a Kotlin file into top-level declarations, each with the KDoc and annotations above it. */
export function splitDeclarations(source: string): { name: string; text: string }[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const starts: { index: number; name: string }[] = [];
  lines.forEach((line, index) => {
    if (/^\s/.test(line)) return;
    const match = DECLARATION.exec(line);
    if (match) starts.push({ index, name: match[1] });
  });
  return starts.map((start, i) => {
    let from = start.index;
    while (from > 0 && KDOC_OR_ANNOTATION.test(lines[from - 1])) from -= 1;
    const to = i + 1 < starts.length ? starts[i + 1].index : lines.length;
    let end = to;
    while (end > from && (lines[end - 1].trim() === '' || KDOC_OR_ANNOTATION.test(lines[end - 1]))) end -= 1;
    return { name: start.name, text: lines.slice(from, end).join('\n').trim() };
  }).filter((d) => d.text);
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

export interface ReadCodeInput { repo: string; checkoutPath: string; options: CodeConfig }

/** Reads source files as one item per file and one chunk per top-level declaration. */
export async function* readCode({ repo, checkoutPath, options }: ReadCodeInput): AsyncGenerator<IndexItem> {
  const include = options.include.map(globToRegExp);
  const exclude = options.exclude.map(globToRegExp);
  for await (const file of walk(checkoutPath)) {
    const rel = relative(checkoutPath, file).split(sep).join('/');
    if (!include.some((r) => r.test(rel)) || exclude.some((r) => r.test(rel))) continue;
    const source = await readFile(file, 'utf8');
    const pkg = /^package\s+([\w.]+)/m.exec(source)?.[1] ?? null;
    const header = [rel, pkg ? `package ${pkg}` : null].filter(Boolean).join('\n');
    const chunks: IndexChunk[] = [];
    for (const decl of splitDeclarations(source)) {
      const keys = Array.from(new Set(Array.from(decl.text.matchAll(STRING_KEY), (m) => m[1])));
      const tail = keys.length ? `\nstrings: ${keys.join(', ')}` : '';
      for (const piece of packText(decl.text, { maxChars: CHUNK_CHARS - header.length - tail.length - 2 })) {
        chunks.push({ seq: chunks.length, kind: 'symbol', heading: decl.name, text: `${header}\n${piece}${tail}`, logs: null, createdAt: DOCS_EPOCH });
      }
    }
    if (chunks.length === 0) continue;
    yield {
      source: 'code', provider: 'github', origin: repo, sourceId: rel, url: `https://github.com/${repo}/blob/${options.ref}/${rel}`,
      title: rel.split('/').pop() ?? rel, audience: options.audience, createdAt: DOCS_EPOCH, updatedAt: null, outcome: null, extra: { package: pkg }, chunks,
    };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && npm test`
Expected: exit 0. If `splitDeclarations` misses `private const val TAG`, check that `const` is in the modifier list and that the line starts at column 0.

- [ ] **Step 5: Commit**

Commit `Add Kotlin code reader with per-declaration chunks`.

---

### Task 10: Files reader (string resources and markdown)

**Files:**
- Create: `bot-scripts/src/providers/github/files.ts`
- Test: `bot-scripts/test/providers/github/files.test.ts`
- Fixtures: `bot-scripts/test/fixtures/files/strings.xml`, `bot-scripts/test/fixtures/files/skills/one/SKILL.md`

**Interfaces:**
- Produces: `readFiles({ repo, checkoutPath, entries, ref }): AsyncGenerator<IndexItem>`. `kind: 'strings'` parses `<string name="k">text</string>` (entities decoded, `\n` and `\'` unescaped) into one item (`source: 'file'`, `sourceId` = path) with chunks of 40 entries each (`kind: 'section'`, `heading` = first key of the chunk, text lines `key: text`). `kind: 'markdown'` walks the path (file or directory) and yields one item per markdown file, chunked like docs, `url` = GitHub blob URL. Also exports `parseStrings(xml: string): { key: string; text: string }[]`.

- [ ] **Step 1: Write fixtures and failing tests**

`strings.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="widget_label">Widgets</string>
    <string name="widget_entity_refresh">Tap to refresh &amp; reload</string>
    <string name="aa_launch">Don\'t show again\nSecond line</string>
    <string name="skipped" translatable="false">internal</string>
</resources>
```

`skills/one/SKILL.md`:

```markdown
---
name: one
---

# One

## Rule

Always do X.
```

`files.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readFiles, parseStrings } from '../../../src/providers/github/files.ts';

const checkout = fileURLToPath(new URL('../../fixtures/files/', import.meta.url));
async function collect(entries) { const out = []; for await (const i of readFiles({ repo: 'o/r', checkoutPath: checkout, entries, ref: 'main' })) out.push(i); return out; }

test('parseStrings decodes entities and escapes and keeps every key', () => {
  const parsed = parseStrings(readFileSync(new URL('../../fixtures/files/strings.xml', import.meta.url), 'utf8'));
  assert.deepEqual(parsed, [
    { key: 'widget_label', text: 'Widgets' },
    { key: 'widget_entity_refresh', text: 'Tap to refresh & reload' },
    { key: 'aa_launch', text: "Don't show again\nSecond line" },
    { key: 'skipped', text: 'internal' },
  ]);
});

test('a strings file becomes one item with grouped key lines', async () => {
  const [item] = await collect([{ path: 'strings.xml', kind: 'strings', audience: 'maintainer' }]);
  assert.equal(item.source, 'file');
  assert.equal(item.sourceId, 'strings.xml');
  assert.equal(item.url, 'https://github.com/o/r/blob/main/strings.xml');
  assert.equal(item.chunks.length, 1);
  assert.equal(item.chunks[0].heading, 'widget_label');
  assert.ok(item.chunks[0].text.includes('widget_entity_refresh: Tap to refresh & reload'));
});

test('a markdown directory yields one item per file chunked by heading', async () => {
  const items = await collect([{ path: 'skills', kind: 'markdown', audience: 'maintainer' }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].sourceId, 'skills/one/SKILL.md');
  assert.equal(items[0].title, 'One');
  assert.equal(items[0].chunks.at(-1).anchor, 'rule');
});

test('a missing path fails with the path in the message', async () => {
  await assert.rejects(() => collect([{ path: 'nope.xml', kind: 'strings', audience: 'maintainer' }]), /nope\.xml/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot-scripts && node --test test/providers/github/files.test.ts`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement `files.ts`**

```ts
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { chunkMarkdown } from '../../text/chunk.ts';
import { DOCS_EPOCH, splitFrontMatter } from './docs.ts';
import type { FileConfig } from '../../config/types.ts';
import type { IndexChunk, IndexItem } from '../types.ts';

const STRINGS_PER_CHUNK = 40;
const STRING_ENTRY = /<string\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/string>/g;
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" };

function decode(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\\n/g, '\n')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .trim();
}

export function parseStrings(xml: string): { key: string; text: string }[] {
  return Array.from(xml.matchAll(STRING_ENTRY), (m) => ({ key: m[1], text: decode(m[2]) }));
}

function stringsItem(repo: string, rel: string, xml: string, ref: string, audience: FileConfig['audience']): IndexItem {
  const entries = parseStrings(xml);
  const chunks: IndexChunk[] = [];
  for (let i = 0; i < entries.length; i += STRINGS_PER_CHUNK) {
    const group = entries.slice(i, i + STRINGS_PER_CHUNK);
    chunks.push({ seq: chunks.length, kind: 'section', heading: group[0].key, text: group.map((e) => `${e.key}: ${e.text}`).join('\n'), logs: null, createdAt: DOCS_EPOCH });
  }
  return { source: 'file', provider: 'github', origin: repo, sourceId: rel, url: `https://github.com/${repo}/blob/${ref}/${rel}`, title: basename(rel), audience, createdAt: DOCS_EPOCH, updatedAt: null, outcome: null, extra: { kind: 'strings', count: entries.length }, chunks };
}

async function* markdownFiles(root: string, rel: string): AsyncGenerator<string> {
  const info = await stat(root);
  if (info.isFile()) { yield rel; return; }
  const { readdir } = await import('node:fs/promises');
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const childRel = `${rel}/${entry.name}`;
    if (entry.isDirectory()) yield* markdownFiles(join(root, entry.name), childRel);
    else if (/\.mdx?$/.test(entry.name)) yield childRel;
  }
}

function markdownItem(repo: string, rel: string, content: string, ref: string, audience: FileConfig['audience']): IndexItem | null {
  const { frontMatter, body } = splitFrontMatter(content);
  const title = String(frontMatter.title ?? /^#\s+(.+)$/m.exec(body)?.[1] ?? basename(rel));
  const chunks: IndexChunk[] = chunkMarkdown(body).map((c, seq) => ({ seq, kind: 'section', heading: c.heading, anchor: c.anchor, text: [seq === 0 ? title : null, ...c.breadcrumbs, c.text].filter(Boolean).join('\n'), logs: null, createdAt: DOCS_EPOCH }));
  if (chunks.length === 0) return null;
  return { source: 'file', provider: 'github', origin: repo, sourceId: rel, url: `https://github.com/${repo}/blob/${ref}/${rel}`, title, audience, createdAt: DOCS_EPOCH, updatedAt: null, outcome: null, extra: { kind: 'markdown' }, chunks };
}

export interface ReadFilesInput { repo: string; checkoutPath: string; entries: FileConfig[]; ref: string }

/** Reads configured files of the consumer checkout: string resources and markdown trees. */
export async function* readFiles({ repo, checkoutPath, entries, ref }: ReadFilesInput): AsyncGenerator<IndexItem> {
  for (const entry of entries) {
    const full = join(checkoutPath, entry.path);
    if (!(await stat(full).catch(() => null))) throw new Error(`Configured file ${entry.path} not found in the checkout of ${repo}`);
    if (entry.kind === 'strings') {
      yield stringsItem(repo, entry.path, await readFile(full, 'utf8'), ref, entry.audience);
    } else {
      for await (const rel of markdownFiles(full, entry.path)) {
        const item = markdownItem(repo, rel, await readFile(join(checkoutPath, rel), 'utf8'), ref, entry.audience);
        if (item) yield item;
      }
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && npm test`
Expected: exit 0.

- [ ] **Step 5: Commit**

Commit `Add files reader for string resources and markdown trees`.

---

### Task 11: Discourse provider

**Files:**
- Create: `bot-scripts/src/providers/discourse/client.ts`
- Create: `bot-scripts/src/providers/discourse/html.ts`
- Create: `bot-scripts/src/providers/discourse/topics.ts`
- Create: `bot-scripts/src/providers/discourse/index.ts`
- Tests: `bot-scripts/test/providers/discourse/html.test.ts`, `bot-scripts/test/providers/discourse/topics.test.ts`
- Fixtures: `bot-scripts/test/fixtures/discourse/site.json`, `category-page-0.json`, `category-page-1.json`, `topic-100.json`, `topic-101.json`

**Interfaces:**
- `createDiscourseClient({ host, fetchImpl = fetch, sleepImpl = sleep, requestsPerSecond }): { getJson<T>(path): Promise<T> }` throttles to `requestsPerSecond` using `sleepImpl`, retries 429 and 5xx up to 3 times with `1s, 2s, 4s`, and fails on other errors with status and path.
- `htmlToText(html: string): string` strips tags, keeps paragraph and line breaks, decodes entities, collapses whitespace.
- `readTopics({ client, host, options, now }): AsyncGenerator<IndexItem>` with `source: 'forum'`, `provider: 'discourse'`, `origin: host`. Category slugs resolve through `/site.json` (`categories[]` with `id`, `slug`); numeric strings are ids. Pages come from `/c/{slug}/{id}.json?page=N` until `more_topics_url` is absent or repeats. A topic is kept when it passes the tag filter and the window on `last_posted_at`. `/t/{id}.json` gives `post_stream.posts[0].cooked` (the first post) and `accepted_answer.post_number`; the answer text comes from the post with that number in `post_stream.posts` when present, else from `/raw/{id}/{post_number}`. Chunks: `body` (`authorRole: 'reporter'`), `answer` (`authorRole: 'user'`). `outcome: { solved, closed, tags, views, likeCount, postsCount }`.
- `createDiscourseProvider(sites: Record<string, DiscourseSiteConfig>, deps: { fetchImpl?, sleepImpl?, now }): Provider` named `discourse`.

- [ ] **Step 1: Write fixtures and failing tests**

`site.json`: `{ "categories": [{ "id": 42, "slug": "android-companion", "name": "Home Assistant Companion for Android" }, { "id": 41, "slug": "ios" }] }`

`category-page-0.json`:

```json
{ "topic_list": { "more_topics_url": "/c/mobile-apps/android-companion/42?page=1", "topics": [
  { "id": 100, "title": "Widget not updating", "slug": "widget-not-updating", "posts_count": 3, "views": 120, "like_count": 2, "created_at": "2026-03-01T00:00:00Z", "last_posted_at": "2026-03-05T00:00:00Z", "closed": false, "has_accepted_answer": true, "tags": ["android"] },
  { "id": 101, "title": "iPhone question in the wrong place", "slug": "iphone", "posts_count": 1, "views": 5, "like_count": 0, "created_at": "2026-02-01T00:00:00Z", "last_posted_at": "2026-02-01T00:00:00Z", "closed": false, "has_accepted_answer": false, "tags": ["ios"] }
] } }
```

`category-page-1.json`: `{ "topic_list": { "more_topics_url": "/c/mobile-apps/android-companion/42?page=1", "topics": [ { "id": 102, "title": "Old topic", "slug": "old", "posts_count": 1, "views": 1, "like_count": 0, "created_at": "2020-01-01T00:00:00Z", "last_posted_at": "2020-01-02T00:00:00Z", "closed": true, "has_accepted_answer": false, "tags": ["android"] } ] } }`

(the repeated `more_topics_url` is the loop guard case)

`topic-100.json`:

```json
{ "id": 100, "title": "Widget not updating", "posts_count": 3, "views": 120, "like_count": 2, "created_at": "2026-03-01T00:00:00Z", "closed": false, "tags": ["android"],
  "accepted_answer": { "post_number": 2 },
  "post_stream": { "posts": [
    { "post_number": 1, "cooked": "<p>My <strong>widget</strong> stops &amp; never refreshes.</p><p>Android 15.</p>", "created_at": "2026-03-01T00:00:00Z", "username": "asker" },
    { "post_number": 2, "cooked": "<p>Disable battery optimisation for the app.</p>", "created_at": "2026-03-02T00:00:00Z", "username": "helper", "accepted_answer": true }
  ] } }
```

`topic-102.json`: a minimal topic with one post `<p>Old.</p>` and no `accepted_answer`.

`html.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from '../../../src/providers/discourse/html.ts';

test('strips tags, keeps paragraph breaks and decodes entities', () => {
  assert.equal(htmlToText('<p>My <strong>widget</strong> stops &amp; never refreshes.</p><p>Android 15.</p>'), 'My widget stops & never refreshes.\n\nAndroid 15.');
  assert.equal(htmlToText('line<br>break &lt;x&gt; &#8220;q&#8221;'), 'line\nbreak <x> “q”');
});

test('keeps code blocks as fenced text', () => {
  assert.equal(htmlToText('<pre><code>key: value\n</code></pre>'), '```\nkey: value\n```');
});
```

`topics.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDiscourseClient } from '../../../src/providers/discourse/client.ts';
import { readTopics } from '../../../src/providers/discourse/topics.ts';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/discourse/${name}`, import.meta.url), 'utf8'));
const routes = {
  '/site.json': fixture('site.json'),
  '/c/android-companion/42.json?page=0': fixture('category-page-0.json'),
  '/c/android-companion/42.json?page=1': fixture('category-page-1.json'),
  '/t/100.json': fixture('topic-100.json'),
  '/t/102.json': fixture('topic-102.json'),
};
function fakeFetch(log = []) {
  return async (url) => {
    const u = new URL(String(url));
    const key = u.pathname + u.search;
    log.push(key);
    const body = routes[key];
    return body ? Response.json(body) : new Response('nope', { status: 404 });
  };
}
const sleeps = [];
const client = (log) => createDiscourseClient({ host: 'community.example', fetchImpl: fakeFetch(log), sleepImpl: async (ms) => { sleeps.push(ms); }, requestsPerSecond: 4 });
const base = { categories: ['android-companion'], tags: [], solvedOnly: false, acceptedAnswers: true, requestsPerSecond: 4 };
async function collect(options = base, log = []) { const out = []; for await (const i of readTopics({ client: client(log), host: 'community.example', options, now: new Date('2026-10-15T00:00:00Z') })) out.push(i); return out; }

test('resolves the category, pages the list and yields body and accepted answer', async () => {
  const items = await collect();
  assert.deepEqual(items.map((i) => i.sourceId), ['100', '101', '102']);
  const t = items[0];
  assert.equal(t.source, 'forum');
  assert.equal(t.provider, 'discourse');
  assert.equal(t.url, 'https://community.example/t/widget-not-updating/100');
  assert.equal(t.chunks[0].kind, 'body');
  assert.equal(t.chunks[0].text, 'Widget not updating\n\nMy widget stops & never refreshes.\n\nAndroid 15.');
  assert.equal(t.chunks[1].kind, 'answer');
  assert.equal(t.chunks[1].text, 'Disable battery optimisation for the app.');
  assert.deepEqual(t.outcome, { solved: true, closed: false, tags: ['android'], views: 120, likeCount: 2, postsCount: 3 });
});

test('stops paging when the next page repeats', async () => {
  const log = [];
  await collect(base, log);
  assert.equal(log.filter((k) => k.includes('page=1')).length, 1);
});

test('filters by tag and by window', async () => {
  assert.deepEqual((await collect({ ...base, tags: ['android'] })).map((i) => i.sourceId), ['100', '102']);
  assert.deepEqual((await collect({ ...base, closedWithinDays: 365 })).map((i) => i.sourceId), ['100', '101']);
});

test('solvedOnly keeps topics with an accepted answer', async () => {
  assert.deepEqual((await collect({ ...base, solvedOnly: true })).map((i) => i.sourceId), ['100']);
});

test('throttles requests through the sleep hook', async () => {
  sleeps.length = 0;
  await collect();
  assert.ok(sleeps.length > 0 && sleeps.every((ms) => ms <= 250));
});

test('a numeric category id is used as is and an unknown slug fails', async () => {
  await assert.rejects(() => collect({ ...base, categories: ['nope'] }), /nope/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot-scripts && node --test test/providers/discourse/`
Expected: FAIL with `Cannot find module` for both files.

- [ ] **Step 3: Implement the four modules**

`client.ts`:

```ts
import { setTimeout as sleep } from 'node:timers/promises';

const BACKOFF_MS = [1000, 2000, 4000];

export interface DiscourseClient { getJson<T>(path: string): Promise<T> }

export interface DiscourseClientOptions {
  host: string; fetchImpl?: typeof fetch; sleepImpl?: (ms: number) => Promise<unknown>; requestsPerSecond: number; log?: (line: string) => void;
}

/** JSON client for one Discourse host: throttled, with a small retry on 429 and 5xx. */
export function createDiscourseClient({ host, fetchImpl = fetch, sleepImpl = sleep, requestsPerSecond, log = () => {} }: DiscourseClientOptions): DiscourseClient {
  const interval = 1000 / requestsPerSecond;
  let nextSlot = 0;
  async function throttle() {
    const now = Date.now();
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
```

Note for the throttle test: with a fake sleep that records but does not wait, consecutive calls see `wait` of about `interval` (250 ms at 4 per second); the test asserts every recorded sleep is at most 250.

`html.ts`:

```ts
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') return String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10));
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** Plain text from Discourse "cooked" HTML: paragraphs separated by blank lines, code fenced. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, code: string) => `\n\`\`\`\n${code.replace(/\n$/, '')}\n\`\`\`\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
```

`topics.ts`:

```ts
import { htmlToText } from './html.ts';
import { packText } from '../../text/chunk.ts';
import type { DiscourseSiteConfig } from '../../config/types.ts';
import type { IndexChunk, IndexItem } from '../types.ts';
import type { DiscourseClient } from './client.ts';

const CHUNK_CHARS = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface SiteCategory { id: number; slug: string }
interface ListTopic { id: number; title: string; slug: string; posts_count: number; views: number; like_count: number; created_at: string; last_posted_at: string; closed: boolean; has_accepted_answer: boolean; tags: string[] }
interface TopicList { topic_list: { more_topics_url?: string; topics: ListTopic[] } }
interface Post { post_number: number; cooked: string; created_at: string; username: string }
interface Topic { accepted_answer?: { post_number: number } | null; post_stream: { posts: Post[] } }

async function resolveCategories(client: DiscourseClient, wanted: string[]): Promise<SiteCategory[]> {
  const site = await client.getJson<{ categories: SiteCategory[] }>('/site.json');
  const bySlug = new Map(site.categories.map((c) => [c.slug, c]));
  const byId = new Map(site.categories.map((c) => [String(c.id), c]));
  const missing = wanted.filter((w) => !bySlug.has(w) && !byId.has(w));
  if (missing.length) throw new Error(`Unknown Discourse categories: ${missing.join(', ')}`);
  return wanted.map((w) => bySlug.get(w) ?? byId.get(w)!);
}

async function* listTopics(client: DiscourseClient, category: SiteCategory): AsyncGenerator<ListTopic> {
  let page = 0;
  let previousNext: string | undefined;
  for (;;) {
    const list = await client.getJson<TopicList>(`/c/${category.slug}/${category.id}.json?page=${page}`);
    yield* list.topic_list.topics;
    const next = list.topic_list.more_topics_url;
    if (!next || next === previousNext) return;
    previousNext = next;
    page += 1;
  }
}

async function answerText(client: DiscourseClient, topic: Topic, id: number): Promise<{ text: string; createdAt: string } | null> {
  const number = topic.accepted_answer?.post_number;
  if (!number) return null;
  const post = topic.post_stream.posts.find((p) => p.post_number === number);
  if (post) return { text: htmlToText(post.cooked), createdAt: post.created_at };
  const raw = await client.getJson<string>(`/raw/${id}/${number}`).catch(() => null);
  return raw ? { text: String(raw), createdAt: topic.post_stream.posts[0]?.created_at ?? '' } : null;
}

export interface ReadTopicsInput { client: DiscourseClient; host: string; options: DiscourseSiteConfig; now?: Date }

/** Reads the topics of the configured categories as forum items with their accepted answer. */
export async function* readTopics({ client, host, options, now = new Date() }: ReadTopicsInput): AsyncGenerator<IndexItem> {
  const cutoff = options.closedWithinDays === undefined ? null : new Date(now.getTime() - options.closedWithinDays * DAY_MS);
  const wantedTags = new Set(options.tags);
  const seen = new Set<number>();
  for (const category of await resolveCategories(client, options.categories)) {
    for await (const listed of listTopics(client, category)) {
      if (seen.has(listed.id)) continue;
      seen.add(listed.id);
      if (wantedTags.size && !listed.tags.some((t) => wantedTags.has(t))) continue;
      if (cutoff && new Date(listed.last_posted_at) < cutoff) continue;
      if (options.solvedOnly && !listed.has_accepted_answer) continue;
      const topic = await client.getJson<Topic>(`/t/${listed.id}.json`);
      const first = topic.post_stream.posts[0];
      const chunks: IndexChunk[] = [];
      for (const piece of packText([listed.title, htmlToText(first?.cooked ?? '')].filter(Boolean).join('\n\n'), { maxChars: CHUNK_CHARS })) {
        chunks.push({ seq: chunks.length, kind: 'body', text: piece, logs: null, createdAt: listed.created_at, authorRole: 'reporter' });
      }
      const answer = options.acceptedAnswers ? await answerText(client, topic, listed.id) : null;
      if (answer) for (const piece of packText(answer.text, { maxChars: CHUNK_CHARS })) {
        chunks.push({ seq: chunks.length, kind: 'answer', text: piece, logs: null, createdAt: answer.createdAt, authorRole: 'user' });
      }
      if (chunks.length === 0) continue;
      yield {
        source: 'forum', provider: 'discourse', origin: host, sourceId: String(listed.id), url: `https://${host}/t/${listed.slug}/${listed.id}`, title: listed.title,
        audience: 'user', createdAt: listed.created_at, updatedAt: listed.last_posted_at,
        outcome: { solved: listed.has_accepted_answer, closed: listed.closed, tags: listed.tags, views: listed.views, likeCount: listed.like_count, postsCount: listed.posts_count },
        extra: { category: category.slug }, chunks,
      };
    }
  }
}
```

`index.ts`:

```ts
import { createDiscourseClient } from './client.ts';
import { readTopics } from './topics.ts';
import type { DiscourseSiteConfig } from '../../config/types.ts';
import type { Provider } from '../types.ts';

export interface DiscourseProviderDeps { fetchImpl?: typeof fetch; sleepImpl?: (ms: number) => Promise<unknown>; now: Date; log?: (line: string) => void }

export function createDiscourseProvider(sites: Record<string, DiscourseSiteConfig>, { fetchImpl, sleepImpl, now, log }: DiscourseProviderDeps): Provider {
  return {
    name: 'discourse',
    async *items() {
      for (const [host, options] of Object.entries(sites)) {
        const client = createDiscourseClient({ host, fetchImpl, sleepImpl, requestsPerSecond: options.requestsPerSecond, log });
        yield* readTopics({ client, host, options, now });
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && npm test`
Expected: exit 0. The `/raw/...` path returns a 404 from the fake and is swallowed by `.catch`, which is the intended degradation when the answer post is outside the first page of posts.

**Raw store (Task 2b):** `ReadTopicsInput` takes `raw?: RawStore`. Before `/t/{id}.json`, `raw?.get('discourse', host, 'topic', String(listed.id))` with `updatedAt === listed.last_posted_at` supplies `topic` from `payload.topic`; otherwise fetch and `raw?.put({ provider: 'discourse', origin: host, kind: 'topic', id, updatedAt: listed.last_posted_at, payload: { listed, topic } })`. `createDiscourseProvider` deps gain `raw?`. Tests `records topics in the raw store` and `reuses a stored topic when its last post did not move` (second pass makes no `/t/` request).

- [ ] **Step 5: Commit**

Commit `Add Discourse provider with throttled client and accepted answers`.

---

### Task 12: Live forum search list

**Files:**
- Create: `bot-scripts/src/retrieval/live-forum.ts`
- Modify: `bot-scripts/src/cli/query.ts`
- Test: `bot-scripts/test/retrieval/live-forum.test.ts`

**Interfaces:**
- Produces: `liveForumList(db, { host, categorySlug, question, fetchImpl, weight = 0.5, limit = 10 }): Promise<RankedList>`: calls `https://{host}/search.json?q=<question> #<categorySlug>`, maps returned topic ids (`topics[].id`) to the chunk ids of items with `provider = 'discourse'`, `origin = host` and `source_id` in that order (the item's first chunk), ignores unknown topics, returns `{ weight, ids }`. Network failure returns an empty list and logs. The query CLI gets `--live-forum <host>/<category-slug>` and passes the list through `liveLists`.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeIndex } from '../../src/store/writer.ts';
import { openDatabase } from '../../src/store/db.ts';
import { liveForumList } from '../../src/retrieval/live-forum.ts';

const tmp = mkdtempSync(join(tmpdir(), 'kb-live-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));
const embedder = { modelKey: 'fake@1@q8@cls', dimensions: 4, async embed(t) { return t.map(() => Float32Array.from([1, 0, 0, 0])); } };
const forum = (id) => ({ source: 'forum', provider: 'discourse', origin: 'community.example', sourceId: String(id), url: `https://community.example/t/x/${id}`, title: `Topic ${id}`, audience: 'user', createdAt: '2026-01-01T00:00:00Z', updatedAt: null, outcome: null, extra: null, chunks: [{ seq: 0, kind: 'body', text: `topic ${id}`, logs: null, createdAt: '2026-01-01T00:00:00Z' }] });
const indexPath = join(tmp, 'k.sqlite');
test.before(async () => { async function* items() { yield forum(100); yield forum(101); } await writeIndex({ items: items(), embedder, outPath: indexPath, meta: {} }); });

test('maps search hits to indexed chunk ids in search order and skips unknown topics', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(String(url)); return Response.json({ topics: [{ id: 101 }, { id: 999 }, { id: 100 }] }); };
  const db = openDatabase(indexPath, { readOnly: true });
  const list = await liveForumList(db, { host: 'community.example', categorySlug: 'android-companion', question: 'widget stops', fetchImpl });
  db.close();
  assert.equal(list.weight, 0.5);
  assert.equal(list.ids.length, 2);
  assert.ok(decodeURIComponent(calls[0]).includes('widget stops #android-companion'));
});

test('a failing search yields an empty list', async () => {
  const db = openDatabase(indexPath, { readOnly: true });
  const list = await liveForumList(db, { host: 'community.example', categorySlug: 'c', question: 'x', fetchImpl: async () => { throw new Error('down'); } });
  db.close();
  assert.deepEqual(list.ids, []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd bot-scripts && node --test test/retrieval/live-forum.test.ts`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement**

`live-forum.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';
import type { RankedList } from './rrf.ts';

export interface LiveForumOptions { host: string; categorySlug: string; question: string; fetchImpl?: typeof fetch; weight?: number; limit?: number; log?: (line: string) => void }

/** Ranked list of indexed forum chunks from a live Discourse search, for topics newer than the index. */
export async function liveForumList(db: DatabaseSync, { host, categorySlug, question, fetchImpl = fetch, weight = 0.5, limit = 10, log = () => {} }: LiveForumOptions): Promise<RankedList> {
  const url = `https://${host}/search.json?q=${encodeURIComponent(`${question} #${categorySlug}`)}`;
  let topics: { id: number }[] = [];
  try {
    const response = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'home-assistant-auto-triage' } });
    if (!response.ok) throw new Error(`status ${response.status}`);
    topics = ((await response.json()) as { topics?: { id: number }[] }).topics ?? [];
  } catch (error) {
    log(`live forum search failed: ${error instanceof Error ? error.message : String(error)}`);
    return { weight, ids: [] };
  }
  const lookup = db.prepare(`SELECT c.id FROM items i JOIN chunks c ON c.item_id = i.id
    WHERE i.provider = 'discourse' AND i.origin = ? AND i.source_id = ? ORDER BY c.seq LIMIT 1`);
  const ids: number[] = [];
  for (const topic of topics.slice(0, limit)) {
    const row = lookup.get(host, String(topic.id)) as { id: number } | undefined;
    if (row) ids.push(Number(row.id));
  }
  return { weight, ids };
}
```

In `query.ts` add the option `'live-forum': { type: 'string' }`; when set, split on the first `/` into host and slug, call `liveForumList`, and pass `liveLists: [list]` to `retrieve`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && npm test`
Expected: exit 0.

- [ ] **Step 5: Commit**

Commit `Add live forum search as a fused ranked list`.

---

### Task 13: Registry wiring, android config, README and a real build

**Files:**
- Modify: `bot-scripts/src/providers/github/index.ts`
- Modify: `bot-scripts/src/providers/registry.ts`
- Modify: `bot-scripts/src/cli/build.ts`
- Modify: `bot-scripts/test/index/build.test.ts`
- Modify: `/Users/timo/Documents/ha/android/.github/knowledge-bot.yaml`
- Modify: `README.md`
- Modify (spec): `/Users/timo/Documents/ha/android/docs/superpowers/specs/2026-10-15-knowledge-bot-design.md` section 4 example (`changelog` file kind replaced by `releases`)

**Interfaces:**
- `createGithubProvider` yields, per repository and in this order: issues, pulls, discussions, releases, docs, code, files. `code` and `files` read from `checkouts[repo]`; for the consumer's own repository the CLI defaults the checkout to `--self <dir>` (new flag) so `--checkout` is not repeated for it.
- `createProviders` adds the discourse provider when `providers.discourse` is set, with `fetchImpl` and `sleepImpl` from deps.

- [ ] **Step 1: Write the failing tests**

In `build.test.ts` extend the fake fetch to answer `/pulls`, `/pulls/*/comments`, `/pulls/*/files`, `/releases` with `[]`, `/graphql` with the categories and an empty discussions page, and the Discourse routes `/site.json` (one category `general` id 1), `/c/general/1.json?page=0` with an empty topic list. Add:

```ts
test('wires every configured source kind and the discourse provider', async () => {
  const config = loadConfig(join(fixtures, 'config/android.yaml'));
  const self = join(fixtures, 'code');
  config.providers.github['home-assistant/android'].files = [];
  config.providers.discourse = { 'community.example': { categories: ['general'], tags: [], solvedOnly: false, acceptedAnswers: true, requestsPerSecond: 50 } };
  const checkouts = { 'home-assistant/android': self, 'home-assistant/companion.home-assistant': fixtures, 'home-assistant/contributors.home-assistant.io': fixtures };
  config.providers.github['home-assistant/companion.home-assistant'].docs.path = 'docs';
  config.providers.github['home-assistant/contributors.home-assistant.io'].docs.path = 'docs/android';
  const providers = createProviders(config, { githubToken: 't', fetchImpl: fakeFetch, sleepImpl: async () => {}, checkouts, now: new Date('2026-10-15T00:00:00Z') });
  assert.deepEqual(providers.map((p) => p.name), ['github', 'discourse']);
  const stats = await buildIndex({ config, configHash: 'w', outPath: join(tmp, 'wired.sqlite'), embedder, providers });
  const db = openDatabase(join(tmp, 'wired.sqlite'), { readOnly: true });
  const sources = db.prepare('SELECT source, count(*) c FROM items GROUP BY source ORDER BY source').all().map((r) => ({ ...r }));
  db.close();
  assert.deepEqual(sources, [{ source: 'code', c: 1 }, { source: 'docs', c: 5 }, { source: 'issue', c: 2 }]);
  assert.ok(stats.items >= 8);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd bot-scripts && node --test test/index/build.test.ts`
Expected: FAIL: `providers.map` gives `['github']` only, and no `code` source.

- [ ] **Step 3: Implement**

`providers/github/index.ts`:

```ts
export function createGithubProvider(repos, { client, checkouts, now }): Provider {
  const checkoutOf = (repo: string, what: string) => {
    const path = checkouts[repo];
    if (!path) throw new Error(`No checkout for ${repo} (needed for ${what}); pass --checkout ${repo}=<path>`);
    return path;
  };
  return {
    name: 'github',
    async *items() {
      for (const [repo, c] of Object.entries(repos)) {
        if (c.issues) yield* readIssues({ client, repo, options: c.issues, now });
        if (c.pulls) yield* readPulls({ client, repo, options: c.pulls, now });
        if (c.discussions) yield* readDiscussions({ client, repo, options: c.discussions });
        if (c.releases) yield* readReleases({ client, repo, options: c.releases, now });
        if (c.docs) yield* readDocs({ repo, checkoutPath: checkoutOf(repo, 'docs'), options: c.docs });
        if (c.code) yield* readCode({ repo, checkoutPath: checkoutOf(repo, 'code'), options: c.code });
        if (c.files?.length) yield* readFiles({ repo, checkoutPath: checkoutOf(repo, 'files'), entries: c.files, ref: c.code?.ref ?? 'main' });
      }
    },
  };
}
```

`registry.ts`: add `sleepImpl?` to `ProviderDeps`, and after the github block (passing `raw` from Task 2b):

```ts
  if (config.providers.discourse) {
    providers.push(createDiscourseProvider(config.providers.discourse, { fetchImpl, sleepImpl, now, raw }));
  }
```

`cli/build.ts`: add `self: { type: 'string' }`; when given, every github repository key that has `code` or `files` and no explicit checkout gets `checkouts[repo] = values.self`.

Android config `.github/knowledge-bot.yaml`, github section for `home-assistant/android`:

```yaml
      issues:
        states: [open, closed]
        comments: true
      pulls:
        states: [merged, closed]
      discussions:
        categories: [general, q-a, ideas]
      releases: {}
      code:
        include: ["**/*.kt"]
        exclude: ["**/build/**", "**/src/test/**", "**/src/androidTest/**"]
      files:
        - path: common/src/main/res/values/strings.xml
          kind: strings
        - path: common/src/main/res/values/strings_changelog.xml
          kind: strings
        - path: .agents/skills
          kind: markdown
```

and a new provider:

```yaml
  discourse:
    community.home-assistant.io:
      categories: [android-companion]
```

(no `tags` filter: the Android category carries few tags, and the category already scopes the crawl).

README: add `--self ../../android` and `--raw ./knowledge-android.raw.sqlite` to the build command, a sentence per new source, and a paragraph on the raw store (what it holds, that it is gitignored like the index, and that a rebuild with the same store skips unchanged items). Add `*.raw.sqlite` to `.gitignore` if the existing pattern does not cover it. In the wiring test, open a raw store in `tmp`, pass it in `createProviders` deps, and assert `raw.count() >= 2` after the build. Spec section 4: replace the `changelog` file entry with `releases: {}` and add a line to 5.1 saying release notes come from GitHub releases because the changelog Kotlin file only holds string references.

- [ ] **Step 4: Run the tests, then a real build**

Run: `cd bot-scripts && npm test`
Expected: exit 0.

Then, with the android checkout as `--self`:

```
GITHUB_TOKEN=$(gh auth token) node src/cli/build.ts --config ../../android/.github/knowledge-bot.yaml \
  --out ./knowledge-android.sqlite --previous ./knowledge-android.sqlite --raw ./knowledge-android.raw.sqlite --self ../../android \
  --checkout home-assistant/companion.home-assistant=../../companion.home-assistant \
  --checkout home-assistant/contributors.home-assistant.io=../../contributors.home-assistant.io
```

Expected: a build of 20 to 40 minutes on the first run (about 3800 merged PRs with review threads, 1800 forum topics at 4 requests per second, 1400 Kotlin files), reusing the existing issue and docs vectors. Record items per source and the file size in the hand-over. Then run the three acceptance questions from plan 1a plus `how do I add a sensor` (expect a code symbol and a contributor docs page) and `which release added the assistant volume sensor` (expect release 2026.8.4).

- [ ] **Step 5: Commit**

Commit `Wire pulls, discussions, releases, code, files and discourse into the build`. The android config and spec edits stay uncommitted for Timo.

---

## Self-review

**Spec coverage.** Section 4 config semantics: Task 5 (github keys, discourse map, audience and windows per source). Section 5.1 sources: pulls (Task 6, with review threads and unmerged PRs), discussions (Task 7), forum (Task 11, accepted answers, tags, window), code (Task 9), files (Task 10); release notes replace the `changelog` kind by a ruling recorded in Task 13 since the Kotlin changelog only references strings. Section 5.4 forum crawl throttling: Task 11 client. Section 6 step 1 query cleaning: Task 3; step 6 live forum list: Task 12; the `itemSimilarity` display issue found during manual testing: Task 4. Review minors M1 to M8 from plan 1a: M1 Task 1, M2 Task 3, M3 done in the TypeScript conversion, M4 Task 4, M5 done, M6 Task 3, M7 Task 1, M8 partly done (helpers extracted), the rest falls out of the new modules being small. Not in this plan: the on-close append job and CI (1c), eval and mining (1d), peers.

**Placeholders.** None: every step has its code or exact command. The org-level discussions repository is unknown; the android config lists the android repository's own categories, and the org source repository can be added as another github entry once Timo reads it from the org settings.

**Type consistency.** `PaginatingClient.graphql` is optional (Task 2) and guarded in Task 7. `SourceKind` gains `'release'` in Task 8 before Task 13 wires it. `RankedList` from `rrf.ts` is the type Task 12 returns and `retrieve` consumes. `DOCS_EPOCH` and `splitFrontMatter` are imported from `docs.ts` by Tasks 9 and 10. `FileConfig['audience']` reuses the config type.

**Review Focus coverage.** 1 Task 2 `retries a transient network error with backoff`; 2 Task 6 `skips bot pull requests by default`; 3 Task 11 `stops paging when the next page repeats`; 4 Task 9 `yields nothing for a file without declarations`; 5 Task 1 `rejects a protocol-relative slug`.
