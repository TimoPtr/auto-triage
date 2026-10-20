# Knowledge bot phase 1d: benchmark implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A retrieval benchmark for a consumer: ground truth mined from the raw store (duplicates, fixes, docs and forum answers, negatives), a harness that runs every case through the production `retrieve` with the as-of filter and reports recall at 5, mean reciprocal rank and the gate's precision and specificity, oracle and null runs that bound the scores, a paired comparison of two runs, and an embedding bake-off that builds one index per candidate model offline from the raw store.

**Architecture:** `src/eval/` holds the case model (`cases.ts`, validated by `schemas/eval-case.json`), the GraphQL links enrichment cached in the raw store (`github-links.ts`), the mining rules (`mine.ts`), the metrics (`metrics.ts`) and the harness (`run.ts`). A replay `fetch` over the raw store (`src/providers/replay.ts`) lets `build --offline` rebuild an index without the network, which the bake-off uses once per model. The embedder learns an optional query and document prefix, which two of the candidate models need. `build-index.yml` gains an evaluate step that runs the test split nightly and writes the summary to the job summary and an artifact.

**Tech Stack:** TypeScript on Node 24, `node:sqlite` + `sqlite-vec`, ajv, GitHub GraphQL, GitHub Actions.

**Spec:** `/Users/timo/Documents/ha/android/docs/superpowers/specs/2026-10-15-knowledge-bot-design.md` section 9 (benchmark), section 5.2 (bake-off models), section 15 phase 1. Plans 1a to 1c-2 next to this file define the modules this plan extends.

## Global Constraints

- Node floor `>=24`, type stripping, imports keep `.ts`, `npm test` exits 0 (strict `tsc` on `src`, lenient on `test`, `node --test`). No new runtime dependency (ajv and yaml exist; the PRNG is inline). No network in unit tests.
- Constants, all in `src/eval/`: `RECALL_K = 5`, `RETRIEVE_K = 10`, `SPLIT_TRAIN_PERCENT = 60`, `SPLIT_VALIDATION_PERCENT = 20` (test is the rest), `REGRESSION_POINTS = 5`, `BOOTSTRAP_RESAMPLES = 1000`, `LINKS_BATCH = 50`, `GATE_SWEEP = { from: 0.3, to: 0.95, step: 0.05 }`, `DEFAULT_SAMPLE = 30`, `CLOSE_COMMENT_GRACE_MS = 60_000`.
- Case format (spec 9.4) plus two optional fields: `origin` on a query or expected entry (the index column; absent means any origin) and `url` on an expected `docs` entry. Query types `issue`, `pull`, `discussion`, `forum` (by `number`) and `text` (inline text). `asOf` rule: the instant the label was produced (duplicate event or comment, the merge of the fixing pull request, the docs or forum comment); negatives use the issue's creation. The query item is always excluded from the ranking.
- Labels come only from maintainer actions: a comment counts only when the API association is OWNER, MEMBER or COLLABORATOR; the timeline and `closingIssuesReferences` are authoritative over text rules. Text from issues, comments and case files is data: embedded, FTS-quoted, compared, never executed and never interpolated into SQL.
- Infra failures (query item or expected item absent from the index, an exception in `retrieve`) go to `errors.jsonl` with a reason and never into the score.
- Every run writes `summary.json`, `summary.md`, `cases.jsonl` (ranked lists with scores) and `errors.jsonl`. Outputs are never committed: `bot-scripts/eval-out/` and `bot-scripts/bake-off/` are gitignored.
- Files under about 300 lines, functions under 50. YAML files start with `---`; android files follow android's `.yamllint`. Actions pinned by SHA, inputs reach `run:` through `env:` only.
- Commits go on `main` in `auto-triage`; the android repository is only edited (config, cases, spec); Timo commits there.

## Review Focus

1. A case whose expected item is not in the index (a renamed docs page, a transferred issue) must become an `errors.jsonl` row, not a miss that lowers recall (Task 7 test `reports an expected item missing from the index as an error`).
2. The query issue must never retrieve itself or any chunk written after its `asOf`, including the maintainer's own "duplicate of" comment (Task 7 test `excludes the query item and chunks after asOf`).
3. A "duplicate of #N" written by a non-maintainer must produce no label (Task 5 test `ignores duplicate claims from non-maintainers`).
4. A malformed line in a cases file must fail with the file and line number rather than being skipped (Task 3 test `rejects a malformed line with its file and line`).
5. The nightly evaluate step must neither fail nor stall the build when a consumer has no cases: the CLI exits 0 with a message and writes nothing (Task 7 test `exits 0 with a message when no cases are configured`).

---

### Task 1: Query and document prefixes on the embedder

**Files:**
- Modify: `bot-scripts/src/config/types.ts` (`EmbeddingConfig`), `schemas/config.base.json` (embedding object)
- Modify: `bot-scripts/src/embed/embedder.ts`, `bot-scripts/src/retrieval/retrieve.ts`
- Test: `bot-scripts/test/embed/embedder.test.ts`, `bot-scripts/test/config/load.test.ts`

**Interfaces:**
- Consumes: `createEmbedder(config, options)`, `Embedder.embed(texts)`, `modelKeyOf(config)`.
- Produces: `EmbeddingConfig.queryPrefix?: string`, `EmbeddingConfig.documentPrefix?: string`; `Embedder.embed(texts: string[], { role = 'document' }: { role?: EmbedRole } = {})` with `export type EmbedRole = 'query' | 'document'`; `modelKeyOf` appends `@q=<queryPrefix>@d=<documentPrefix>` only when either prefix is set, so existing keys do not change.

- [ ] **Step 1: Write the failing tests**

In `test/embed/embedder.test.ts`:

```ts
test('prepends the role prefix and keeps the key stable without prefixes', async () => {
  const calls: string[][] = [];
  const config = { model: 'm', revision: 'r', dtype: 'q8', dimensions: 4, pooling: 'mean', queryPrefix: 'search_query: ', documentPrefix: 'search_document: ' };
  const embedder = createEmbedder(config, { pipelineFactory: fakeFactory(calls) });
  await embedder.embed(['a'], { role: 'query' });
  await embedder.embed(['b']);
  assert.deepEqual(calls.flat(), ['search_query: a', 'search_document: b']);
  assert.equal(embedder.modelKey, 'm@r@q8@mean@q=search_query: @d=search_document: ');
  assert.equal(modelKeyOf({ ...config, queryPrefix: undefined, documentPrefix: undefined }), 'm@r@q8@mean');
});
```

In `test/config/load.test.ts`: `accepts embedding prefixes` loads a config with both prefixes and asserts they are present; `rejects a non-string prefix` expects `ConfigError`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd bot-scripts && node --test test/embed/embedder.test.ts test/config/load.test.ts`
Expected: FAIL, the prefix is not applied (`calls` contains `a`) and the config is rejected as an additional property.

- [ ] **Step 3: Implement**

`types.ts`: add the two optional strings. `config.base.json`: add `queryPrefix` and `documentPrefix` as optional strings to the embedding object. `embedder.ts`: `embed(texts, { role = 'document' } = {})` maps each text through the role's prefix (empty when unset) before batching; `modelKeyOf` appends the suffix when either prefix is set. `retrieve.ts`: `embedder.embed([embedText], { role: 'query' })`. Tests that define a fake embedder with `embed(texts)` keep working because the options argument is optional.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && npm test`
Expected: PASS, all green.

- [ ] **Step 5: Commit**

```bash
git add bot-scripts/src/config/types.ts schemas/config.base.json bot-scripts/src/embed/embedder.ts bot-scripts/src/retrieval/retrieve.ts bot-scripts/test
git commit -m "Support query and document prefixes on the embedding model"
```

---

### Task 2: Replay fetch over the raw store and `build --offline`

**Files:**
- Create: `bot-scripts/src/providers/replay.ts`
- Modify: `bot-scripts/src/providers/discourse/topics.ts` (store the category with a topic), `bot-scripts/src/providers/registry.ts` (`githubToken` not required when `fetchImpl` is a replay), `bot-scripts/src/cli/build.ts` (`--offline`)
- Modify: `README.md` (Raw store section)
- Test: `bot-scripts/test/providers/replay.test.ts`, `bot-scripts/test/index/plan.test.ts` (`full with reason offline`)

**Interfaces:**
- Consumes: `RawStore.each(provider, origin, kind)`, the stored payload shapes: issue `{ issue, comments, complete }`, pull `{ pull, reviewComments, files, complete }`, discussion node, release object, topic `{ listed, topic, category? }`.
- Produces: `createReplayFetch(raw: RawStore): typeof fetch`, a `fetch` serving the GitHub REST listings (`/repos/{repo}/issues` honouring `state` and `since`, `/repos/{repo}/issues/{n}/comments`, `/repos/{repo}/pulls`, `/repos/{repo}/pulls/{n}/comments`, `/repos/{repo}/pulls/{n}/files`, `/repos/{repo}/releases`), the two discussion GraphQL queries (categories from the stored nodes' `category.slug`, ids equal to the slugs; pages of `first` with the cursor as an offset) and Discourse (`/site.json` from the stored categories, `/c/{slug}/{id}.json?page=N` in pages of 30 with `more_topics_url` while more remain, `/t/{id}.json` from the store, anything else 404). The GitHub listings are single pages without a `Link` header. A topic stored without a category replays under the first category of the `/site.json` list of its host.
- `ReplayOptions.hosts?: Record<string, string[]>` lists the configured category slugs per Discourse host so `/site.json` can name a category no stored topic carries yet; `createReplayFetch(raw, { hosts })`.
- `createProviders(config, { fetchImpl, raw, offline: true })` builds the GitHub client with the token `offline` and the Discourse clients with a no-op `sleepImpl`.
- `build --offline` requires `--raw`, forbids `--previous`-based incremental builds (plan is forced full with reason `offline`), and needs no `GITHUB_TOKEN`.

- [ ] **Step 1: Write the failing test**

`test/providers/replay.test.ts`, `rebuilds the same items from the raw store without the network`: build an index with the fake fetch of `test/index/build.test.ts` (copy its fixture routing; add one discourse topic page and one topic so the forum path is covered) and a raw store; then build a second index with `createReplayFetch(raw, { hosts: { 'community.example': ['general'] } })`, `offline: true` and a fetch spy asserting the replay was the only fetch used. Assert the two indexes have the same rows in `SELECT source, source_id, title FROM items ORDER BY 1, 2` and the same `SELECT hash FROM chunks ORDER BY hash`. A second test, `serves issue listings filtered by state and since`, calls the replay fetch directly for `/repos/o/r/issues?state=closed&since=<iso>` and checks the returned numbers.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd bot-scripts && node --test test/providers/replay.test.ts`
Expected: FAIL with `createReplayFetch` not found.

- [ ] **Step 3: Implement `createReplayFetch` in `src/providers/replay.ts`**

Route by `URL.hostname` (`api.github.com` versus a Discourse host) and pathname with small regexes; GraphQL by inspecting `body.query` for `discussionCategories` or `discussions(`; unknown routes return `new Response('not replayed', { status: 404 })`. `topics.ts`: `loadTopic` stores `{ listed, topic, category: { id, slug } }`. `registry.ts`: `offline?: boolean` as described. `build.ts`: `--offline` flag; `planBuild` receives `full: values.full || values.offline` and the reason is `offline` when offline (add the `offline` input to `PlanBuildInput` and `fullReason`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && npm test`
Expected: PASS.

- [ ] **Step 5: Verify on the real android store**

Run from `bot-scripts`: `node src/cli/build.ts --config ../../android/.github/knowledge-bot.yaml --out /private/tmp/claude-501/-Users-timo-Documents-ha-android/da1b5d89-f3c8-4cfb-829b-ecbc3207f12c/scratchpad/offline.sqlite --raw ./knowledge-android.raw.sqlite --previous ./knowledge-android.sqlite --offline --self ../../android --checkout home-assistant/companion.home-assistant=../../companion.home-assistant --checkout home-assistant/contributors.home-assistant.io=../../contributors.home-assistant.io --model-cache ./.model-cache`
Expected: `build mode: full (offline)`, item counts per source equal to the online index (issue 3142, pull 2854, forum 1847, discussion 34, release 97, docs 91, code 1137, file 12), wall time well under the online 3 minutes. Record the time for the README.

- [ ] **Step 6: Document and commit**

README "Raw store": add the `--offline` paragraph (what replays, what does not: a late accepted forum answer outside the stored first page, GraphQL links).

```bash
git add bot-scripts/src/providers/replay.ts bot-scripts/src/providers/discourse/topics.ts bot-scripts/src/providers/registry.ts bot-scripts/src/cli/build.ts bot-scripts/src/index/plan.ts bot-scripts/test README.md
git commit -m "Rebuild an index offline from the raw store"
```

---

### Task 3: Eval case model and reader

**Files:**
- Create: `bot-scripts/src/eval/cases.ts`, `schemas/eval-case.json`
- Test: `bot-scripts/test/eval/cases.test.ts`

**Interfaces:**
- Produces:
  - `export type Relation = 'duplicate' | 'fixed-by' | 'docs' | 'forum' | 'negative' | 'curated'`, `export type Split = 'train' | 'validation' | 'test'`, `export type Tier = 'high' | 'medium' | 'low'`.
  - `export type CaseQuery = { type: 'issue' | 'pull' | 'discussion' | 'forum'; number: number; origin?: string; asOf?: string } | { type: 'text'; text: string; asOf?: string }`.
  - `export interface Expected { type: SourceKind; number?: number; url?: string; origin?: string }`.
  - `export interface EvalCase { id: string; relation: Relation; split: Split; query: CaseQuery; expected: Expected[]; expectedTier: Tier; labelSource: string; verified: boolean }`.
  - `export function readCases(paths: string[]): EvalCase[]` validates every line against `schemas/eval-case.json` with ajv and throws `EvalCaseError` as `<path>:<line>: <ajv message>`; blank lines are skipped; duplicate ids across files throw.
  - `export function caseFiles(target: string): string[]`: a `.jsonl` file as is, a directory's `*.jsonl` sorted by name, a missing path an empty list.
  - `export function splitFor(id: string, salt = ''): Split` from the first 4 bytes of `sha256(salt + id)` modulo 100 against the percent constants.
  - `export function hashOrder(key: string, salt = ''): string` the hex digest used for deterministic sampling.

- [ ] **Step 1: Write the failing tests**

`test/eval/cases.test.ts`: `reads cases from a directory in file order` (two files, three cases, ids in order); `rejects a malformed line with its file and line` (second file, line 2 missing `expected`, error message matches `/cases-b\.jsonl:2: /`); `rejects a duplicate id across files`; `assigns splits by hash within the expected proportions` (ids `c-1`..`c-1000`: train between 540 and 660, validation between 150 and 250, and `splitFor('c-1', 'other')` can differ from `splitFor('c-1')` for at least one id in 1 to 50).

- [ ] **Step 2: Run them to verify they fail**

Run: `cd bot-scripts && node --test test/eval/cases.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `cases.ts` and the schema**

Schema: `additionalProperties: false` at every level, `relation`, `split`, `expectedTier` as enums, `query` a `oneOf` of the two shapes, `expected` an array of objects requiring `type` and one of `number` or `url`, `asOf` with the `date-time` format checked by a regex added through `ajv.addFormat` as `load.ts` does for `uri`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bot-scripts/src/eval/cases.ts schemas/eval-case.json bot-scripts/test/eval/cases.test.ts
git commit -m "Add the eval case model with schema validation and hash splits"
```

---

### Task 4: GraphQL links enrichment cached in the raw store

**Files:**
- Modify: `bot-scripts/src/providers/github/client.ts`, `bot-scripts/src/providers/types.ts`
- Create: `bot-scripts/src/eval/github-links.ts`
- Test: `bot-scripts/test/eval/github-links.test.ts`

**Interfaces:**
- Consumes: `GitHubClient.graphql`, `RawStore.get/put/each`.
- Produces:
  - `GitHubClient.graphqlPartial<T>(query, variables): Promise<{ data: T | null; errors: { message: string; path?: (string | number)[] }[] }>` returning partial data instead of throwing on per-field errors; `PaginatingClient.graphqlPartial?` optional alias.
  - `export interface StoredLinks { kind: 'issue' | 'pull'; duplicateOf: number[]; closes: number[]; markedAt: string | null }` stored in the raw store as `kind: 'links'`, `id: String(number)`, `updatedAt` equal to the issue or pull `updated_at` it was fetched for.
  - `export interface LinkRef { kind: 'issue' | 'pull'; number: number; updatedAt: string }`.
  - `export async function fetchLinks(client: PaginatingClient, repo: string, refs: LinkRef[], raw: RawStore, log?): Promise<{ fetched: number; reused: number; requests: number }>`: skips refs whose stored links carry the same `updatedAt`, batches the rest `LINKS_BATCH` per query with aliases `i<n>: issue(number: n)` and `p<n>: pullRequest(number: n)`, issues select `timelineItems(itemTypes: [MARKED_AS_DUPLICATE_EVENT, UNMARKED_AS_DUPLICATE_EVENT], first: 20)` with `createdAt` and `canonical { __typename ... on Issue { number } ... on PullRequest { number } }`, pulls select `closingIssuesReferences(first: 20) { nodes { number } }`. `duplicateOf` is the set of canonicals whose last event is a mark (an unmark removes it); `markedAt` is the `createdAt` of the last mark. An alias with an error stores nothing and is counted in the log.
  - `export function linksOf(raw: RawStore, repo: string, number: number): StoredLinks | null`.

- [ ] **Step 1: Write the failing tests**

`test/eval/github-links.test.ts` with a fake client whose `graphqlPartial` records the query and returns canned data: `fetches issue duplicates and pull closes in one batch` (2 issues and 1 pull in one request; one issue marked then unmarked yields `duplicateOf: []`; the other `duplicateOf: [10]`, `markedAt` set; the pull `closes: [10, 11]`); `reuses stored links when updatedAt matches` (second call with the same refs makes zero requests, a changed `updatedAt` makes one); `batches LINKS_BATCH refs per request` (120 refs, 3 requests); `skips an alias with an error` (errors path `['repository', 'i5']`, data null for it, no stored record for 5, the others stored).

- [ ] **Step 2: Run them to verify they fail**

Run: `cd bot-scripts && node --test test/eval/github-links.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`client.ts`: factor the POST out of `graphql` into a private `post` and add `graphqlPartial`; `graphql` keeps its throwing behaviour. `github-links.ts` as specified; the GraphQL query is built from the refs with aliases only from numbers (`Number.isInteger` checked), never from text.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bot-scripts/src/providers/github/client.ts bot-scripts/src/providers/types.ts bot-scripts/src/eval/github-links.ts bot-scripts/test/eval/github-links.test.ts
git commit -m "Fetch duplicate and closing links in GraphQL batches into the raw store"
```

---

### Task 5: Case mining from the raw store

**Files:**
- Create: `bot-scripts/src/eval/mine.ts`, `bot-scripts/src/cli/mine-cases.ts`
- Modify: `bot-scripts/.gitignore` (`eval-out/`, `bake-off/`)
- Test: `bot-scripts/test/eval/mine.test.ts`

**Interfaces:**
- Consumes: `StoredIssue`, `StoredPull` payload shapes (export the two interfaces from `issues.ts` and `pulls.ts`), `linkedIssues(body)` from `pulls.ts`, `linksOf` from Task 4, `splitFor`/`hashOrder` from Task 3, `Config` (docs `baseUrl`s, discourse hosts, github repos with `issues`).
- Produces:
  - `export interface MiningReport { counts: { byRelation: Record<string, number>; byLabelSource: Record<string, number> }; dropped: Record<string, number>; negativesPool: number }`.
  - `export function mineCases({ config, raw, salt = '' }: { config: Config; raw: RawStore; salt?: string }): { cases: EvalCase[]; report: MiningReport }`.
  - `export function sampleMarkdown(cases: EvalCase[], n: number, salt: string, urls: (c: EvalCase) => { query: string; expected: string[] }): string`: a table of `n` cases in `hashOrder('sample' + salt, id)` order with id, relation, labelSource, query link, expected links, and an empty "verdict" column.
  - CLI `mine-cases --config <yaml> --raw <sqlite> --out <dir> [--github] [--salt <s>] [--sample 30]`: with `--github`, runs `fetchLinks` for every stored closed issue and merged pull first (`GITHUB_TOKEN` required, `gh auth token` locally); writes `<out>/cases.jsonl`, `<out>/sample.md`, `<out>/mining-report.json`; prints the report counts.

Mining rules, each producing one case per query with every expected of that relation merged; the case id is `<prefix>-<queryNumber>` with prefixes `dup`, `fix`, `docs`, `forum`, `neg`:

| Relation | Source | Query | Expected | asOf | labelSource | tier |
| --- | --- | --- | --- | --- | --- | --- |
| duplicate | stored links `duplicateOf` of a closed issue | the later-created of the pair | the earlier-created | `markedAt` | `timeline:marked-duplicate` | high |
| duplicate | maintainer comment on a closed issue matching `DUPLICATE_OF = /\bdup(?:licate|e)s?\s*(?:of|:)?\s*(?:https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/(?:issues|pull)\/|#)(\d+)/i`, only when no timeline label exists for that issue | the later-created | the earlier-created | comment `created_at` | `comment:duplicate-of` | high |
| fixed-by | stored links `closes` of a merged pull, else `linkedIssues(pull.body)` | the issue (closed, in the store) | the pull | `merged_at` | `pull:closing-reference` / `pull:body-keyword` | medium |
| docs | maintainer comment on a closed issue, `created_at <= closed_at + CLOSE_COMMENT_GRACE_MS`, containing a URL starting with a configured docs `baseUrl` | the issue | `{ type: 'docs', url }` with fragment, query string and trailing slash removed | comment `created_at` | `comment:docs-link` | high |
| forum | maintainer comment on a closed issue containing `https://<configured host>/t/<slug>/<id>` whose topic is in the store | the issue | `{ type: 'forum', number: id }` | comment `created_at` | `comment:forum-link` | medium |
| negative | closed issues with a fixed-by label and no duplicate, docs or forum label | the issue | `[]` | issue `created_at` | `negative:fixed-only` | low |

An expected issue or pull number must exist in the store (`issue` or `pull` kind decides the type); a cross-repository link or an unknown number is dropped and counted under `dropped.unknown-target`. Negatives are the first `N` of the pool in `hashOrder('negative' + salt, id)` order where `N` is the number of duplicate, docs and forum cases. Comments of an issue stored with `complete: false` are not read (`dropped.incomplete-issue`). The query and every expected carry `origin: repo`. `split` is `splitFor(id, salt)`, `verified` is false.

- [ ] **Step 1: Write the failing tests**

`test/eval/mine.test.ts` builds a raw store in a temp dir with `openRawStore` and `put`, with a helper `issue(number, { state, createdAt, closedAt, comments: [{ association, body, createdAt }] })`, `pull(number, { body, mergedAt })`, `topic(id)`, `links(number, { duplicateOf, closes, markedAt })`, and a config with one github repo (`issues`, `pulls`), one docs baseUrl `https://docs.example/docs/` and one discourse host `forum.example`. Tests:
  - `labels a timeline duplicate with the later issue as query` (issue 20 marked duplicate of 10 → case `dup-20`, expected `[{type:'issue', number:10, origin}]`, asOf = markedAt, labelSource timeline).
  - `orders a comment duplicate by creation` (issue 5 closed as "duplicate of #30" where 30 is newer → case `dup-30` expecting 5).
  - `ignores duplicate claims from non-maintainers` (association NONE → no case).
  - `prefers the timeline over the comment` (both present → one case, labelSource timeline).
  - `labels fixed-by from closing references and from the body` (two pulls; labelSources differ).
  - `labels docs and forum answers from maintainer comments before the close` (URL with `#anchor` normalised; a comment two days after the close is ignored; a forum id not in the store is dropped and counted).
  - `draws as many negatives as known-answer positives, deterministically` (pool of 4 fixed issues, 2 positives → 2 negatives, same ids on a second run, a different salt may change them).
  - `drops unknown targets and counts them`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd bot-scripts && node --test test/eval/mine.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `mine.ts` and the CLI**

Keep each rule in its own function returning partial cases keyed by query number; a `merge` step combines expected arrays per `(relation, query)`. The CLI's `urls` callback builds `https://github.com/<repo>/issues/<n>` and the docs or forum URL.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bot-scripts/src/eval/mine.ts bot-scripts/src/cli/mine-cases.ts bot-scripts/.gitignore bot-scripts/test/eval/mine.test.ts bot-scripts/src/providers/github/issues.ts bot-scripts/src/providers/github/pulls.ts
git commit -m "Mine benchmark cases from the raw store"
```

---

### Task 6: Metrics, gate sweep and paired comparison

**Files:**
- Create: `bot-scripts/src/eval/metrics.ts`, `bot-scripts/src/eval/random.ts`
- Test: `bot-scripts/test/eval/metrics.test.ts`

**Interfaces:**
- Produces:
  - `random.ts`: `export function mulberry32(seed: number): () => number` (deterministic PRNG in [0, 1)).
  - `export interface CaseResult { id: string; relation: Relation; split: Split; expectedSources: string[]; ranked: { source: string; sourceId: string; url: string; fused: number; similarity: number | null }[]; firstRank: number | null; bestSimilarity: number; positive: boolean }` where `positive` is `relation !== 'negative'`.
  - `export interface RetrievalMetrics { n: number; recallAt5: number; mrr: number }` in points (0 to 100 for recall, 0 to 1 for MRR).
  - `export interface GateMetrics { threshold: number; precision: number | null; specificity: number | null; sensitivity: number | null; positives: number; negatives: number }`.
  - `export function retrievalMetrics(results: CaseResult[]): RetrievalMetrics` over positive cases only: recall counts a `firstRank <= RECALL_K`, MRR uses `1 / firstRank` within `RETRIEVE_K`, else 0.
  - `export function byGroup(results: CaseResult[], key: (r: CaseResult) => string[]): Record<string, RetrievalMetrics>` (a result may belong to several groups, such as every expected source).
  - `export function gateAt(results: CaseResult[], threshold: number): GateMetrics` where a case is "commented" when `bestSimilarity >= threshold`; precision over commented cases, specificity over negatives, sensitivity over positives; `null` when the denominator is 0.
  - `export function gateSweep(results: CaseResult[]): GateMetrics[]` over `GATE_SWEEP`.
  - `export interface Comparison { n: number; deltaRecallAt5: number; ci95: [number, number]; regression: boolean }`; `export function compareRuns(a: CaseResult[], b: CaseResult[], { resamples = BOOTSTRAP_RESAMPLES, seed = 1 } = {}): Comparison` paired on case id over positives present in both, delta in points of B minus A, percentile bootstrap on the paired differences, `regression` when `deltaRecallAt5 < -REGRESSION_POINTS` and `ci95[1] < 0`.

- [ ] **Step 1: Write the failing tests**

`test/eval/metrics.test.ts`: `recall and mrr over positives only` (3 positives with firstRank 1, 7, null and one negative → recall 33.3, MRR (1 + 1/7) / 3); `groups a result under every expected source`; `gate precision and specificity at a threshold` (2 positives at 0.8 and 0.4, 2 negatives at 0.6 and 0.2, threshold 0.5 → precision 50, specificity 50, sensitivity 50); `gate returns null without negatives`; `sweep covers 0.30 to 0.95` (14 rows, first 0.3, last 0.95); `compare reports a regression with a confidence interval excluding zero` (40 paired cases, A all hits, B 20 hits → delta −50, upper bound below 0, regression true) and `compare is deterministic for a seed`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd bot-scripts && node --test test/eval/metrics.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `metrics.ts` and `random.ts`**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bot-scripts/src/eval/metrics.ts bot-scripts/src/eval/random.ts bot-scripts/test/eval/metrics.test.ts
git commit -m "Add retrieval, gate and comparison metrics for the benchmark"
```

---

### Task 7: Eval harness and CLIs

**Files:**
- Create: `bot-scripts/src/eval/run.ts`, `bot-scripts/src/cli/run-eval.ts`, `bot-scripts/src/cli/compare-eval.ts`
- Modify: `bot-scripts/package.json` (scripts `mine-cases`, `run-eval`, `compare-eval`)
- Test: `bot-scripts/test/eval/run.test.ts`, `bot-scripts/test/cli/run-eval.test.ts`

**Interfaces:**
- Consumes: `retrieve(db, embedder, question, options)`, `readMeta`, `readCases`/`caseFiles`, metrics of Task 6.
- Produces:
  - `export type EvalMode = 'production' | 'oracle' | 'null'`.
  - `export interface RunEvalInput { db: DatabaseSync; embedder: Embedder; cases: EvalCase[]; mode?: EvalMode; threshold: number; retrieveOptions?: Pick<RetrieveOptions, 'minSimilarity' | 'sourceWeights' | 'decayAfterDays' | 'decayFactor'>; seed?: number; log?: (line: string) => void }`.
  - `export interface EvalError { id: string; reason: string }`.
  - `export interface EvalSummary { run: { mode: EvalMode; cases: number; scored: number; errors: number; modelKey: string; builtAt: string | null; startedAt: string; durationSeconds: number; threshold: number }; retrieval: { all: RetrievalMetrics; byRelation: Record<string, RetrievalMetrics>; byExpectedSource: Record<string, RetrievalMetrics>; byLabelSource: Record<string, RetrievalMetrics> }; gate: { at: GateMetrics; sweep: GateMetrics[] } }`.
  - `export async function runEval(input: RunEvalInput): Promise<{ results: CaseResult[]; errors: EvalError[]; summary: EvalSummary }>`.
  - `export function summaryMarkdown(summary: EvalSummary): string` (one table per relation and per expected source, one gate line at the threshold, one sweep table).
  - Query text of an item case: the item is looked up by `(source = type, source_id = String(number))` restricted to `origin` when given; several matches without an origin is an error `ambiguous query item`; the text is the item's `kind = 'body'` chunks in `seq` order joined by a blank line followed by their `logs`; the item id becomes `excludeItemId`. `oracle` mode uses the first expected item's text the same way (negatives are skipped in oracle mode). `null` mode draws `RETRIEVE_K` random item ids from `items` with `mulberry32(seed)` instead of calling `retrieve` and sets `bestSimilarity` to 0.
  - Every expected entry is resolved before retrieval: `number` by `(source, source_id, origin?)`, `url` by `items.url` after the same normalisation as mining; an unresolved expected is the error `expected not in index`, a query item absent is `query item not in index`; a thrown `retrieve` is `retrieve failed: <message>`. Cases with an error produce no `CaseResult`.
  - `retrieve` is called with `k: RETRIEVE_K`, `asOf`, `excludeItemId`, and the `retrieveOptions`; a hit is a ranked entry whose `(source, sourceId)` or normalised `url` matches an expected.
  - CLI `run-eval --config <yaml> --index <sqlite> [--cases <file-or-dir>]... [--split test|validation|train|all] [--mode production|oracle|null] [--threshold <n>] [--out <dir>] [--model-cache <dir>] [--seed 1]`: cases default to the config's `evalCases` resolved against the config file's directory; split defaults to `test`; threshold defaults to `config.triage?.minSimilarity ?? 0.35`; out defaults to `eval-out/<mode>-<split>`; with no case file found it prints `no eval cases configured` and exits 0 without writing. Writes `summary.json`, `summary.md`, `cases.jsonl` (one `CaseResult` per line), `errors.jsonl`; prints the markdown. Exit code 1 only on an exception.
  - CLI `compare-eval <a/cases.jsonl> <b/cases.jsonl> [--json]` prints the `Comparison`; exit code 3 when `regression` is true so a workflow can gate on it.

- [ ] **Step 1: Write the failing tests**

`test/eval/run.test.ts` builds an index with the fake keyword embedder of `test/retrieval/retrieve.test.ts` (widget, notification, other) and `writeIndex` with items: issue 1 widget (2025-03-01), issue 2 widget duplicate of 1 (2025-05-01) with a maintainer comment chunk "duplicate of #1" dated 2025-05-02, issue 3 notification (2025-04-01), docs page widgets with url `https://docs.example/docs/widgets`, pull 9 "fix widget" (2025-06-01). Cases: `dup-2` (query issue 2, asOf 2025-05-02T12:00:00Z, expected issue 1), `docs-2` (expected url with `#refresh`), `fix-3` (query issue 3, expected pull 9, asOf 2025-06-02), `neg-3`, `missing-1` (expected issue 404), `text-1` (type text "widget stops", expected docs). Tests:
  - `scores hits, errors and the gate` (results for dup-2, docs-2, fix-3, neg-3, text-1; `missing-1` in errors with `expected not in index`; dup-2 firstRank 1; docs-2 hit by url).
  - `excludes the query item and chunks after asOf` (a case querying issue 1 with asOf 2025-04-01 and expected issue 2 → firstRank null, and issue 1 never appears in its own ranked list).
  - `reports an expected item missing from the index as an error`.
  - `oracle mode finds every expected at rank 1 and skips negatives`.
  - `null mode scores at chance and is deterministic` (recall 0 on this tiny index with seed 1 twice giving equal ranked lists).
  - `summary markdown lists relations and the gate line`.

`test/cli/run-eval.test.ts`: `exits 0 with a message when no cases are configured` runs the CLI as a child process (`node src/cli/run-eval.ts --config <fixture config without evalCases> --index <tmp index>`) and asserts exit 0, stdout contains `no eval cases configured`, and no `eval-out` directory was created under a temp cwd.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd bot-scripts && node --test test/eval/run.test.ts test/cli/run-eval.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `run.ts` and the two CLIs**

Lookups through prepared statements with bound parameters only. The `cases.jsonl` writer truncates each ranked entry's fields to the `CaseResult` shape (no chunk text).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bot-scripts/src/eval/run.ts bot-scripts/src/cli/run-eval.ts bot-scripts/src/cli/compare-eval.ts bot-scripts/package.json bot-scripts/test
git commit -m "Run the benchmark cases through retrieval and compare two runs"
```

---

### Task 8: Embedding bake-off

**Files:**
- Create: `bot-scripts/src/cli/bake-off.ts`, `bot-scripts/eval/bake-off-models.yaml`
- Modify: `README.md` (new "Benchmark" section covering Tasks 5, 7 and 8)
- Test: `bot-scripts/test/cli/bake-off.test.ts`

**Interfaces:**
- Consumes: `buildIndex` with a replay provider set (Task 2), `runEval` (Task 7), `loadConfig`.
- Produces:
  - `bake-off-models.yaml`: a list of `{ name, embedding: EmbeddingConfig }` entries for `Xenova/all-MiniLM-L6-v2` (mean, 384), `Xenova/bge-small-en-v1.5` (cls, 384), `Snowflake/snowflake-arctic-embed-s` (cls, 384, queryPrefix `Represent this sentence for searching relevant passages: `), `nomic-ai/nomic-embed-text-v1.5` (mean, 768, prefixes `search_query: ` / `search_document: `), `onnx-community/embeddinggemma-300m-ONNX` (mean, 768, prefixes `task: search result | query: ` / `title: none | text: `). Each revision is the current commit `sha` from `https://huggingface.co/api/models/<id>` and the dtype `q8` when the repository lists a `*_quantized.onnx` or `q8` file, else `fp32`; record what was chosen in a comment per entry.
  - `export function bakeOffMarkdown(rows: BakeOffRow[]): string` with `export interface BakeOffRow { name: string; modelKey: string; buildSeconds: number; indexBytes: number; chunksPerSecond: number; recallAt5: number; mrr: number; gatePrecision: number | null; gateSpecificity: number | null; skipped?: string }`.
  - CLI `bake-off --config <yaml> --raw <sqlite> --models <yaml> --out <dir> [--cases <file-or-dir>] [--split validation] [--self <dir>] [--checkout owner/repo=<dir>]... [--model-cache <dir>] [--only <name>]...`: for each model, builds `<out>/<name>.sqlite` offline with the config's `embedding` replaced, runs the eval on the split, appends a `BakeOffRow`, and rewrites `<out>/bake-off.json` and `<out>/bake-off.md` after every model so a long run that dies keeps its rows. A model whose download or build throws becomes a row with `skipped: <message>` and the run continues.

- [ ] **Step 1: Write the failing test**

`test/cli/bake-off.test.ts`: `bakeOffMarkdown renders one row per model and marks skipped ones` (two rows, one skipped; the table has the model key, seconds, MB, recall, MRR, and the skipped reason in the row).

- [ ] **Step 2: Run it to verify it fails**

Run: `cd bot-scripts && node --test test/cli/bake-off.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the CLI and the models file**

The per-model loop reuses `createProviders(config, { fetchImpl: createReplayFetch(raw, { hosts }), raw, checkouts, offline: true })` and a fresh `createEmbedder` per model; `configHash` is the sha256 of the modified config JSON. Sanitise `name` to `[A-Za-z0-9._-]` for the file name.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && npm test`
Expected: PASS.

- [ ] **Step 5: Write the README "Benchmark" section**

Subsections: "Mine the cases" (command, what each relation means, the sample to verify, the split rule and salt), "Run the eval" (command, modes, output files, how to read the gate table), "Compare two runs" (exit code 3), "Bake-off" (command, the models file, what to look at), and a placeholder table "Results (android)" filled by Task 10.

- [ ] **Step 6: Commit**

```bash
git add bot-scripts/src/cli/bake-off.ts bot-scripts/eval/bake-off-models.yaml bot-scripts/test/cli/bake-off.test.ts README.md
git commit -m "Add the embedding bake-off over the raw store"
```

---

### Task 9: Nightly evaluate step and self-check case

**Files:**
- Modify: `.github/workflows/build-index.yml`, `.github/workflows/ci-pipeline.yml` (if it asserts step outputs), `examples/selfcheck/knowledge-bot.yaml`
- Create: `examples/selfcheck/eval/cases.jsonl`
- Modify: `README.md` ("Run it in GitHub Actions": the evaluate step and artifact)

**Interfaces:**
- Consumes: `run-eval` CLI (Task 7), `upload-artifact` pinned SHA `cf430e030ddbb5b0abf93d22962f4752f3646cd9`.
- Produces: in `build-index.yml`, after the success publish, step `eval` with `if: success()` running `node "$BOT_SCRIPTS_DIR/src/cli/run-eval.ts" --config "$CONFIG" --index "$INDEX" --split test --out .knowledge-bot/eval --model-cache "$KB_MODEL_CACHE"` then appending `.knowledge-bot/eval/summary.md` to `$GITHUB_STEP_SUMMARY` when it exists; a following `upload-artifact` step `if: success() && hashFiles('.knowledge-bot/eval/summary.json') != ''` with name `eval-${{ inputs.slug }}`, path `.knowledge-bot/eval`, retention 30 days. The self-check config gets `evalCases: eval` and one `text` case expecting the docs item the query "raw source store for the benchmark" already ranks first (take its `url` from `query --json`), split `test`, relation `curated`, labelSource `manual`, verified true.

- [ ] **Step 1: Write the self-check case and the config line, run the eval locally**

Run from `bot-scripts`: build the self-check index as `ci-pipeline.yml` does (the README's self-test command), then `node src/cli/run-eval.ts --config ../examples/selfcheck/knowledge-bot.yaml --index <that index> --split test --out /private/tmp/claude-501/-Users-timo-Documents-ha-android/da1b5d89-f3c8-4cfb-829b-ecbc3207f12c/scratchpad/selfcheck-eval`
Expected: `summary.md` printed with `recallAt5 100` for the single case, no errors.

- [ ] **Step 2: Add the workflow steps and lint**

Run: `cd /Users/timo/Documents/ha/auto-triage && yamllint .github/workflows/build-index.yml`
Expected: no output.

- [ ] **Step 3: Run the suite**

Run: `cd bot-scripts && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/build-index.yml examples/selfcheck README.md
git commit -m "Evaluate the test split after every successful index build"
```

---

### Task 10: Android cases, bounding runs and bake-off on real data

**Files:**
- Create (android, uncommitted): `.github/knowledge-bot/eval/cases.jsonl`, `.github/knowledge-bot/eval/sample.md`, `.github/knowledge-bot/eval/mining-report.json`
- Modify (android): `.github/knowledge-bot.yaml` (`evalCases: knowledge-bot/eval`, resolved against the config directory `.github/`)
- Modify: `README.md` "Results (android)" table

**Interfaces:**
- Consumes: the CLIs of Tasks 5, 7 and 8 on `bot-scripts/knowledge-android.raw.sqlite` and `bot-scripts/knowledge-android.sqlite`.

- [ ] **Step 1: Mine with the links enrichment**

Run from `bot-scripts`: `GITHUB_TOKEN=$(gh auth token) node src/cli/mine-cases.ts --config ../../android/.github/knowledge-bot.yaml --raw ./knowledge-android.raw.sqlite --out ../../android/.github/knowledge-bot/eval --github`
Expected: about 120 GraphQL requests, counts per relation printed in the order of magnitude of the spec's candidates (duplicate a few hundred, fixed-by several hundred, docs a few hundred, forum tens, negatives equal to duplicate + docs + forum), `sample.md` with 30 rows.

- [ ] **Step 2: Hand-check the sample**

Read `sample.md` and open each query and expected link in the raw store (not the browser: `node -e` against the store, printing the comment that produced the label). Count the wrong labels per rule. If a rule is wrong in more than one of its sampled cases, fix the rule in `mine.ts` with a test (RED → GREEN), re-mine, re-sample. Record the sample verdicts in `sample.md`'s verdict column.

- [ ] **Step 3: Bounding runs then the production run**

Run from `bot-scripts`, with `--split all` and the android config and index: `--mode oracle`, `--mode null`, then the default production mode with `--split test` and `--split validation`.
Expected: oracle recall at 5 above 95 (anything lower is a harness or as-of bug: investigate before continuing), null recall below 1, production somewhere between; `errors.jsonl` small and explained (renamed docs pages, transferred issues). Record recall at 5, MRR, gate precision and specificity at the config threshold, case counts and eval wall time.

- [ ] **Step 4: Bake-off**

Run from `bot-scripts`: `node src/cli/bake-off.ts --config ../../android/.github/knowledge-bot.yaml --raw ./knowledge-android.raw.sqlite --models ./eval/bake-off-models.yaml --out ./bake-off --cases ../../android/.github/knowledge-bot/eval --split validation --self ../../android --checkout home-assistant/companion.home-assistant=../../companion.home-assistant --checkout home-assistant/contributors.home-assistant.io=../../contributors.home-assistant.io --model-cache ./.model-cache`
Expected: five rows (or a skipped reason per row), `bake-off.md` with build seconds, index size, recall at 5 and MRR per model. Then run the test split through the best validation model's index with `run-eval --index ./bake-off/<name>.sqlite` and the matching embedding config (a temporary config file with that `embedding` block) to report the test number.

- [ ] **Step 5: Record and decide**

Fill the README "Results (android)" table (case counts per relation, oracle, null, production on test, the bake-off rows, run times). The default model stays `bge-small-en-v1.5` unless another model wins recall at 5 on validation by more than `REGRESSION_POINTS` with the comparison's interval excluding zero and builds within twice the time; state the outcome and the numbers in the final message for Timo to decide the config change.

- [ ] **Step 6: Commit the README**

```bash
git add README.md
git commit -m "Record the android benchmark and bake-off results"
```

---

### Task 11: Spec update

**Files:**
- Modify (android, uncommitted): `docs/superpowers/specs/2026-10-15-knowledge-bot-design.md` sections 9.2, 9.3, 9.4, 9.5, 5.4 and 16.

- [ ] **Step 1: Edit the spec**

9.2: mining is `mine-cases` from the raw store with the GraphQL links (`MarkedAsDuplicateEvent`, `closingIssuesReferences`) cached as `links` records; replace the candidate counts with the mined counts of Task 10. 9.3: the `asOf` rule (label instant; negatives at creation), the hash split with salt, negatives equal to the known-answer positives. 9.4: the `origin` and `url` fields, `evalCases` as a directory of `*.jsonl` files resolved against the config directory. 9.5: `run-eval --config --index [--cases] [--split] [--mode]`, `compare-eval` (exit 3 on regression), `bake-off`, the nightly evaluate step and artifact. 5.4: `build --offline` replays the raw store (what it cannot replay). 16: a "Decided on 2026-10-20" entry for the benchmark design points above and the bake-off outcome.

- [ ] **Step 2: Check the spec still reads as one document**

Run: `grep -n "cjs\|mine-cases.cjs\|run-eval.cjs" /Users/timo/Documents/ha/android/docs/superpowers/specs/2026-10-15-knowledge-bot-design.md`
Expected: no output.

No commit: the android repository is Timo's to commit.
