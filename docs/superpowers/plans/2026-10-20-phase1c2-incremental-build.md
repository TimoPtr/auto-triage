# Knowledge bot phase 1c-2: incremental nightly build implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a usable index is restored, the nightly build reads only what changed since that index was started, patches a copy of it in place, and falls back to a full rebuild at least every 7 days, so the nightly cost is bounded by the number of changed items rather than by the size of the repository.

**Architecture:** Readers take an optional `since` date and yield either an `IndexItem` or a `Removal` for a listed item that no longer qualifies; GitHub issues use the API's `since`, every other remote listing is read newest first and stops at the first page whose items are all older. Checkout sources (docs, code, files) are always re-read in full. `planBuild` reads the previous index's meta (`started_at`, `full_built_at`, `config_hash`) and decides `full` or `incremental`; `incrementalBuild` copies the previous file, upserts the stream through the existing upsert path, removes tombstoned and vanished items, and rewrites the meta. The CLI gains `--full`, the reusable workflow and the android caller a `full` input.

**Tech Stack:** TypeScript on Node 24, `node:sqlite` + `sqlite-vec`, GitHub REST and GraphQL, Discourse JSON, GitHub Actions.

**Spec:** `/Users/timo/Documents/ha/android/docs/superpowers/specs/2026-10-15-knowledge-bot-design.md` section 5.4, paragraph "Incremental build (decided 2026-10-20)". Plans 1a to 1c next to this file define the modules this plan extends.

## Global Constraints

- Node floor `>=24`, type stripping, imports keep `.ts`, `npm test` exits 0 (strict `tsc` on `src`, lenient on `test`, `node --test`). No new runtime dependency. No network in unit tests.
- Constants: `FULL_REBUILD_DAYS = 7`, `SINCE_OVERLAP_MS = 60 * 60 * 1000` (one hour), both in `src/index/plan.ts`. Meta keys: `started_at` (ISO, when the build began), `full_built_at` (ISO, when the last full build began; carried over by incremental builds), `config_hash` (already written).
- Full rebuild when: no usable previous index, `--full`, `config_hash` differs, `full_built_at` missing or older than `FULL_REBUILD_DAYS`. Otherwise incremental with `since = started_at - SINCE_OVERLAP_MS`; a previous index without `started_at` (built before this plan) is rebuilt in full.
- Removal rules: a listed item that fails the reader's own filter after `since` is a `Removal`; checkout sources remove every item of their `(provider, origin, source)` not present in this pass; removals the sources cannot report wait for the full rebuild.
- Files under about 300 lines, functions under 50. YAML files start with `---`; android files follow android's `.yamllint` (no `---`, `on: # yamllint disable-line rule:truthy`). Actions pinned by SHA, inputs reach `run:` through `env:` only.
- Commits go on `main` in `auto-triage`; the android repository is only edited.

## Review Focus

1. An incremental build must never lose an item it did not read: a copy of the previous index is the starting point, and an upsert of one item leaves every other row untouched (Task 6 test `keeps every item it did not read`).
2. A failed incremental build must leave the restored index file intact for the publish-on-failure path and the status step (Task 6 test `a failure leaves the previous index untouched`, the tmp copy is removed).
3. An issue reopened when only closed issues are indexed must disappear from the index on the next incremental build (Task 2 test `yields a removal for a listed issue that stopped qualifying`, Task 6 test `applies removals`).
4. A docs page deleted from the checkout must disappear on the next incremental build without a full rebuild (Task 6 test `removes checkout items that vanished`).
5. A previous index older than seven days of full builds, or built by another config, must trigger a full rebuild rather than an incremental one (Task 5 tests `full when the last full build is older than FULL_REBUILD_DAYS` and `full when the config hash changed`).

---

### Task 1: Removal type, `since` on the provider interface

**Files:**
- Modify: `bot-scripts/src/providers/types.ts`
- Modify: `bot-scripts/src/providers/registry.ts`, `bot-scripts/src/providers/github/index.ts`, `bot-scripts/src/providers/discourse/index.ts`
- Modify: `bot-scripts/src/store/writer.ts` (`writeIndex` skips removals)
- Test: `bot-scripts/test/store/writer.test.ts`

**Interfaces:**
- Produces in `types.ts`: `export interface Removal { remove: true; provider: string; origin: string; source: SourceKind; sourceId: string }`, `export type ProviderItem = IndexItem | Removal`, `export function isRemoval(item: ProviderItem): item is Removal`, `export interface ReadWindow { since?: Date }`, and `Provider.items(window?: ReadWindow): AsyncGenerator<ProviderItem>`.
- `createGithubProvider` and `createDiscourseProvider` pass `window.since` to every reader that accepts it (Tasks 2 to 4 add the parameter; until then the readers ignore it).
- `writeIndex({ items: AsyncIterable<ProviderItem>, ... })` skips removals (a full build has nothing to remove from).

- [ ] **Step 1: Write the failing test** in `writer.test.ts`:

```ts
test('a full build skips removals in the stream', async () => {
  const path = join(tmp, 'removals.sqlite');
  async function* items() { yield item('1', ['a']); yield { remove: true, provider: 'github', origin: 'o/r', source: 'issue', sourceId: '1' }; yield item('2', ['b']); }
  const stats = await writeIndex({ items: items(), embedder: fakeEmbedder(), outPath: path, meta: {} });
  assert.equal(stats.items, 2);
});
```

(`item` is the test file's existing item helper or a local one with the same shape as `upsert.test.ts`.)

- [ ] **Step 2: Run it**: `cd bot-scripts && node --test test/store/writer.test.ts`. Expected: FAIL, the writer inserts the removal object (TypeError on `item.chunks`) or `tsc` rejects the stream type.
- [ ] **Step 3: Implement** the types, `isRemoval`, the `window` parameter on `Provider.items` and both provider factories, and the `if (isRemoval(item)) continue;` in `writeIndex`.
- [ ] **Step 4: Run** `npm test`. Expected: exit 0.
- [ ] **Step 5: Commit** `Add removals and a read window to the provider interface`.

---

### Task 2: Issues since

**Files:**
- Modify: `bot-scripts/src/providers/github/issues.ts`
- Test: `bot-scripts/test/providers/github/issues.test.ts`

**Interfaces:**
- `ReadIssuesInput` gains `since?: Date`. With `since`, both listings (open and closed) carry `since: since.toISOString()` and the closed listing no longer uses the window cutoff as `since` (the later of the two dates wins). A listed issue that fails the state filter yields `Removal { source: 'issue' }`; a pull request listed as an issue is still skipped silently (it was never an issue item).

- [ ] **Step 1: Write the failing tests**:

```ts
test('since is passed to both listings and wins over the window start', async () => {
  const log = [];
  await collect(readIssues({ client: fakeClient(log), repo: 'o/r', options, now, since: new Date('2026-10-01T00:00:00Z') }));
  const listings = log.filter((c) => c.path === '/repos/o/r/issues').map((c) => c.params.since);
  assert.deepEqual(listings, ['2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z']);
});

test('yields a removal for a listed issue that stopped qualifying', async () => {
  const items = await collect(readIssues({ client: fakeClient(), repo: 'o/r', options: { ...options, states: ['closed'] }, now, since: new Date('2020-01-01T00:00:00Z') }));
  const removal = items.find((i) => i.remove);
  assert.deepEqual(removal, { remove: true, provider: 'github', origin: 'o/r', source: 'issue', sourceId: '20' });
  assert.ok(items.every((i) => i.sourceId !== '13'), 'a pull request listed as an issue is neither an item nor a removal');
});
```

(The fake client's open listing yields issue 20, open; with `states: ['closed']` and no `since` the reader skips the open listing entirely, so the test passes `since`, which lists `state: all` in one call. Decide: with `since`, list once with `state: 'all'` and `since`, and filter by state in code; without `since`, keep the two listings. Write the first test's expectation accordingly: one listing with `state: 'all'`.)

- [ ] **Step 2: Run**: `node --test test/providers/github/issues.test.ts`. Expected: FAIL (`since` ignored, no removal).
- [ ] **Step 3: Implement**: `since` on `ReadIssuesInput`; a `listings(options, cutoff, since)` helper returning the params list; the state filter yields `removal(repo, 'issue', issue.number)`.
- [ ] **Step 4: Run** `npm test`. Expected: exit 0.
- [ ] **Step 5: Commit** `List issues changed since a date and report the ones that stopped qualifying`.

---

### Task 3: Pull requests, discussions and releases since

**Files:**
- Modify: `bot-scripts/src/providers/github/pulls.ts`, `discussions.ts`, `releases.ts`
- Test: the three matching test files

**Interfaces:**
- `ReadPullsInput`, `ReadDiscussionsInput`, `ReadReleasesInput` gain `since?: Date`.
- With `since`, pulls are listed `sort: 'updated', direction: 'desc'` and the generator returns at the first element with `updated_at < since`; discussions already come `UPDATED_AT DESC` and return at the first node with `updatedAt < since`; releases return at the first release with `published_at < since` (drafts, which have no `published_at`, are skipped, not a stop). A pull request or discussion that fails the reader's filter after `since` yields a `Removal` (`source: 'pull'` / `'discussion'`); a release never stops qualifying.

- [ ] **Step 1: Write the failing tests** (one per file, same shape):

```ts
test('since lists newest first and stops at the first older pull request', async () => {
  const log = [];
  const items = await collect(options, log, undefined, new Date('2025-03-05T00:00:00Z'));
  assert.equal(log[0].params.direction, 'desc');
  assert.deepEqual(items.filter((i) => !i.remove).map((i) => i.sourceId), ['42']);
});
test('a bot pull request listed after since is a removal', async () => {
  const items = await collect(options, [], undefined, new Date('2025-03-05T00:00:00Z'));
  assert.deepEqual(items.find((i) => i.remove), { remove: true, provider: 'github', origin: 'o/r', source: 'pull', sourceId: '41' });
});
```

(`collect` gains a fourth `since` parameter. The fixture page is in ascending order; the fake client reverses it when `params.direction === 'desc'`. Pull 42 updated 2025-03-06 and 41 updated 2025-03-05T10:00 are after `since`, 40 is before and stops the loop.)

```ts
test('since stops the discussion listing at the first older node', async () => { /* since 2025-01-01: discussion 7 (updated 2025-01-02) kept, discussion 8 (2024-01-01) stops the loop and the fake client's second page is never requested */ });
test('since stops the release listing at the first older release', async () => { /* since 2026-01-01: 2026.8.4 kept, draft skipped, 2022.1.0 stops; the listing is requested once */ });
```

- [ ] **Step 2: Run** the three files. Expected: FAIL.
- [ ] **Step 3: Implement** in each reader; keep `qualifies` from plan 1c in `pulls.ts` as the removal gate.
- [ ] **Step 4: Run** `npm test`. Expected: exit 0.
- [ ] **Step 5: Commit** `List pull requests, discussions and releases changed since a date`.

---

### Task 4: Forum topics since

**Files:**
- Modify: `bot-scripts/src/providers/discourse/topics.ts`
- Test: `bot-scripts/test/providers/discourse/topics.test.ts`

**Interfaces:**
- `ReadTopicsInput` gains `since?: Date`. `listTopics` takes `since` and stops after the first page in which every topic has `last_posted_at < since` (a pinned old topic at the top of a page does not stop it). A listed topic that fails `keep` after `since` yields a `Removal { provider: 'discourse', source: 'forum' }`.

- [ ] **Step 1: Write the failing tests**:

```ts
test('since stops paging after the first page whose topics are all older', async () => {
  const log = [];
  const items = await collect({ since: new Date('2026-03-01T00:00:00Z'), log });
  assert.deepEqual(items.filter((i) => !i.remove).map((i) => i.sourceId), ['100']);
  assert.ok(log.every((path) => !path.includes('page=1')), 'page 1 holds only topic 102 from 2020 and page 0 already had an older topic, so page 1 is never requested');
});
```

(Page 0 holds 100 from 2026-03-05 and 101 from 2026-02-01: not all older, so paging continues; stop happens when page 1 is all older. Adjust the assertion to the real fixture: page 1 is requested once and the loop stops there. Write `assert.equal(log.filter((p) => p.includes('page=')).length, 2)`.)

```ts
test('a listed topic that stopped qualifying is a removal', async () => { /* solvedOnly: true with since: topic 101 has no accepted answer in the fixture -> Removal sourceId '101' */ });
```

- [ ] **Step 2: Run**: `node --test test/providers/discourse/topics.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `npm test`. Expected: exit 0.
- [ ] **Step 5: Commit** `List forum topics changed since a date`.

---

### Task 5: Build plan from the previous index

**Files:**
- Create: `bot-scripts/src/index/plan.ts`
- Test: `bot-scripts/test/index/plan.test.ts`

**Interfaces:**
- `export const FULL_REBUILD_DAYS = 7; export const SINCE_OVERLAP_MS = 60 * 60 * 1000;`
- `export interface BuildPlan { mode: 'full' | 'incremental'; since: Date | null; reason: string; fullBuiltAt: string | null }`
- `export function planBuild({ previousMeta, configHash, now, full }: { previousMeta: Record<string, string> | null; configHash: string; now: Date; full: boolean }): BuildPlan`. `previousMeta` is null when there is no usable previous index (the caller uses `indexStatus` from plan 1c and `readMeta`). Reasons: `forced`, `no previous index`, `previous index has no started_at`, `config hash changed`, `last full build N days ago`, `incremental since <iso>`. `fullBuiltAt` is `now` for a full plan and the previous value for an incremental one.

- [ ] **Step 1: Write the failing tests**:

```ts
const now = new Date('2026-10-20T03:00:00Z');
const meta = { started_at: '2026-10-19T03:00:00Z', built_at: '2026-10-19T03:05:00Z', full_built_at: '2026-10-15T03:00:00Z', config_hash: 'abc' };
test('incremental since the previous start minus the overlap', () => {
  const plan = planBuild({ previousMeta: meta, configHash: 'abc', now, full: false });
  assert.equal(plan.mode, 'incremental');
  assert.equal(plan.since.toISOString(), '2026-10-19T02:00:00.000Z');
  assert.equal(plan.fullBuiltAt, '2026-10-15T03:00:00Z');
});
test('full when forced, when there is no previous index, or when started_at is missing', () => { /* three asserts on mode and reason */ });
test('full when the config hash changed', () => { /* configHash 'def' -> mode full, reason /config hash/ */ });
test('full when the last full build is older than FULL_REBUILD_DAYS', () => { /* full_built_at '2026-10-12T03:00:00Z' -> full; '2026-10-13T04:00:00Z' -> incremental; fullBuiltAt of a full plan equals now.toISOString() */ });
```

- [ ] **Step 2: Run**: `node --test test/index/plan.test.ts`. Expected: FAIL `Cannot find module`.
- [ ] **Step 3: Implement** `planBuild` (pure, under 30 lines).
- [ ] **Step 4: Run** `npm test`. Expected: exit 0.
- [ ] **Step 5: Commit** `Decide between a full and an incremental build from the previous index`.

---

### Task 6: Incremental build

**Files:**
- Modify: `bot-scripts/src/store/upsert.ts` (expose `upsertInto(db, stmt, item, embedder, stats)`, `removeFrom(db, ref): boolean`, `finish(db)`; the existing `upsertItems`/`removeItem` become thin wrappers that open and close the file)
- Create: `bot-scripts/src/index/incremental.ts`
- Modify: `bot-scripts/src/index/build.ts` (`buildIndex` takes `plan: BuildPlan`, writes `started_at` and `full_built_at` in meta, dispatches to `writeIndex` or `incrementalBuild`)
- Test: `bot-scripts/test/index/incremental.test.ts`

**Interfaces:**
- `export async function incrementalBuild({ previousPath, outPath, providers, since, embedder, meta, log }: IncrementalBuildInput): Promise<WriteStats>`: copies `previousPath` to `<outPath>.tmp`, opens it, for each provider iterates `items({ since })`: an `IndexItem` is upserted (counted in stats), a `Removal` removed; for every checkout source seen (`docs`, `code`, `file`), items of that `(provider, origin, source)` whose `sourceId` was not yielded in this pass are deleted; then `finish` (FTS rebuild, counts, `appended_at`), the meta entries written (`built_at`, `started_at`, `full_built_at` carried, `config_hash`, `product`), `VACUUM`, close, rename `<outPath>.tmp` to `outPath`. On any error the tmp file is removed and the error rethrown; `previousPath` is never written.
- `export function removeAbsent(db, scope: { provider: string; origin: string; source: SourceKind }, present: Set<string>): number` in `upsert.ts`.
- `buildIndex({ config, configHash, outPath, previousPath, embedder, providers, plan, log })`: `plan.mode === 'full'` → `writeIndex` with `meta.started_at = now`, `meta.full_built_at = plan.fullBuiltAt`; else `incrementalBuild` with `since: plan.since`. Logs `build mode: <mode> (<reason>)`.

- [ ] **Step 1: Write the failing tests** (fake providers over an in-memory list; `fakeEmbedder` as in `upsert.test.ts`; `fresh()` writes a previous index with issues 1 and 2 and docs pages `a` and `b`):

```ts
test('keeps every item it did not read', async () => { /* provider yields only issue 1 changed; after the build items 2, a, b are still there with their chunks and vectors; stats.items === 1 */ });
test('applies removals', async () => { /* provider yields Removal issue 2 -> items count 3, no row for 2 */ });
test('removes checkout items that vanished', async () => { /* provider yields docs page a only (page b absent) -> b removed, a kept; issues untouched since no issue was listed */ });
test('a failure leaves the previous index untouched', async () => { /* embedder throws; assert.rejects; previous file still opens with 4 items; <outPath>.tmp does not exist */ });
test('carries full_built_at and records started_at', async () => { /* meta.full_built_at equals the value passed, meta.started_at equals the passed start, built_at is newer */ });
```

- [ ] **Step 2: Run**: `node --test test/index/incremental.test.ts`. Expected: FAIL `Cannot find module`.
- [ ] **Step 3: Implement** `upsert.ts` split, `removeAbsent`, `incrementalBuild` (under 300 lines total with helpers `copyPrevious`, `applyStream`, `pruneCheckoutSources`), and the `buildIndex` dispatch. `build.test.ts` existing tests pass a `plan` of `{ mode: 'full', since: null, reason: 'test', fullBuiltAt: now }`.
- [ ] **Step 4: Run** `npm test`. Expected: exit 0.
- [ ] **Step 5: Commit** `Build incrementally from a copy of the previous index`.

---

### Task 7: CLI, status and workflow wiring

**Files:**
- Modify: `bot-scripts/src/cli/build.ts` (`--full`; computes the plan from `indexStatus` + `readMeta` of `--previous`; prints the mode)
- Modify: `bot-scripts/src/index/status.ts` and `src/cli/index-status.ts` (`fullBuiltAt`, `fullAgeDays` in `IndexStatus`, outputs `full-built-at`, `full-age-days`)
- Modify: `.github/workflows/build-index.yml` (input `full`, boolean, default false, passed as `--full` when true), `README.md`
- Modify (android, uncommitted): `/Users/timo/Documents/ha/android/.github/workflows/knowledge-index.yml` (`workflow_dispatch` input `full`, boolean, default false, forwarded)
- Test: `bot-scripts/test/index/status.test.ts`

**Interfaces:**
- `IndexStatus` gains `fullBuiltAt: string | null; fullAgeDays: number | null`.
- `build-index.yml` input `full` (type boolean) → `env: FULL: ${{ inputs.full }}` → `full=(); [ "$FULL" = "true" ] && full=(--full)` → appended to the build command.

- [ ] **Step 1: Write the failing test** in `status.test.ts`: `test('reports when the last full build happened', ...)` asserting `fullBuiltAt` equals the meta value written by `writeIndex` (`meta: { full_built_at: '2026-10-15T03:00:00Z' }`) and `fullAgeDays` about 5 for `now` 2026-10-20T03:00:00Z.
- [ ] **Step 2: Run**: `node --test test/index/status.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the status fields, the CLI (`--full`, plan computation, `build mode` log line), the workflow input, the android dispatch input, and a README paragraph under "Run it in GitHub Actions" (what incremental means, the 7 day full rebuild, the `full` input, what removals wait for the full rebuild).
- [ ] **Step 4: Run** `npm test && yamllint .github/workflows/build-index.yml` and, in android, `yamllint .github/workflows/knowledge-index.yml`. Then the real measurement: `node src/cli/build.ts --config ../../android/.github/knowledge-bot.yaml --out <scratch>/incremental.sqlite --previous ./knowledge-android.sqlite --raw <copy of the raw store> --self ../../android --checkout ... --model-cache ./.model-cache` twice: the first run is full (the previous index has no `started_at`), the second incremental; record both durations and the request counts in the README's "Build time" section. Expected: the incremental run reads a handful of items and finishes well under a minute plus the checkout re-read.
- [ ] **Step 5: Commit** `Run the nightly build incrementally with a weekly full rebuild`.

---

## Self-review

**Spec coverage.** 5.4 incremental paragraph: `since` per source (Tasks 2 to 4), checkout sources re-read in full with removal of vanished items (Task 6), removals of listed items that stopped qualifying (Tasks 2 to 4, applied in Task 6), full rebuild rules and the 7 day cadence (Task 5), `--full` and the `full` workflow input (Task 7), measured numbers in the README (Task 7). Appends from plan 1c are unchanged.

**Type consistency.** `Removal`/`ProviderItem`/`ReadWindow` from Task 1 are consumed by Tasks 2 to 4 (yield) and Task 6 (dispatch). `BuildPlan` from Task 5 is consumed by `buildIndex` in Task 6 and the CLI in Task 7. `WriteStats` is reused by `incrementalBuild`.

**Review Focus coverage.** 1 and 2 Task 6; 3 Task 2 plus Task 6; 4 Task 6; 5 Task 5.

**Open point for the reviewer of this plan.** Issues with `since` list `state: all` once instead of two listings, which changes the first-fill request pattern only when `since` is set (never on a full build); the raw store still de-duplicates the comment requests.
