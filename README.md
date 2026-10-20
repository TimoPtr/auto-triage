# auto-triage

Shared code for the Home Assistant knowledge bot: index builders, retrieval, actions and
agentic workflow templates. Consumer repositories hold a `.github/knowledge-bot.yaml` and thin
callers. Design: the knowledge bot spec in `home-assistant/android`,
`docs/superpowers/specs/2026-10-15-knowledge-bot-design.md`.

## Layout

- `bot-scripts/` TypeScript run natively by Node 24 (type stripping, no build step): providers, index
  writer, retrieval, CLIs. `npm ci --ignore-scripts --omit=dev` installs the runtime; `tsc --noEmit` is a
  dev-only check. Imports keep the `.ts` extension, and no syntax that needs transformation (enums,
  parameter properties, decorators) is used.
- `schemas/` JSON Schema for the config and the index metadata.
- `docs/superpowers/plans/` implementation plans, one per phase.

## Development

    cd bot-scripts
    npm ci --ignore-scripts
    npm test          # tsc --noEmit on src (strict) and tests, then node --test

## Build and query an index locally

The consumer config (here the android one) names the sources. Docs, code and files are read from
local checkouts: `--self` is the consumer's own checkout, other repositories are passed with
`--checkout`. Issues, pull requests, discussions and releases are read through the GitHub API with
`GITHUB_TOKEN`; forum topics come from the Discourse JSON API anonymously.

    cd bot-scripts
    GITHUB_TOKEN=$(gh auth token) npm run build-index -- \
      --config ../../android/.github/knowledge-bot.yaml \
      --out ./knowledge-android.sqlite \
      --raw ./knowledge-android.raw.sqlite \
      --self ../../android \
      --checkout home-assistant/companion.home-assistant=../../companion.home-assistant \
      --checkout home-assistant/contributors.home-assistant.io=../../contributors.home-assistant.io

    npm run query -- --config ../../android/.github/knowledge-bot.yaml \
      --index ./knowledge-android.sqlite "widget stops updating after reboot"

Add `--live-forum community.home-assistant.io/android-companion` to a query to fuse a live forum
search into the ranking, for topics newer than the index.

The first run downloads the embedding model (about 35 MB) into `.model-cache/`.
Pass `--previous <older index>` to reuse the vectors of unchanged chunks. The index is a single
SQLite file (FTS5 plus sqlite-vec) that `sqlite3` can open directly.

### Sources

Under `providers.github.<owner/repo>`:

- `issues`: open and closed issues with their comments; the author role of every chunk comes from the API association, never from the text.
- `pulls`: closed pull requests, merged or not, with the review threads that have a maintainer reply (one chunk per comment with its own role), the linked issues and the files touched; bot authors are skipped by default.
- `discussions`: the discussions of the named categories with their accepted answer, read through GraphQL.
- `releases`: published release notes chunked by section; prereleases are opt-in.
- `docs`: a markdown tree with front matter, linked by slug or id when they stay on the docs site.
- `code`: Kotlin sources as one chunk per top-level declaration, with the string resource keys it uses; maintainer audience.
- `files`: Android string resources (`strings`) or markdown trees such as agent skills (`markdown`).

Under `providers.discourse.<host>`: the topics of the named categories (slug or id), optionally filtered by tag, with the accepted answer; throttled to `requestsPerSecond`.

### Build time

Measured on 2026-10-19 for the android config above (every issue since 2019, every closed pull
request, three discussion categories, stable releases, two docs sites, the Kotlin sources, two
string files, the agent skills and the whole Android forum category), on an Apple M4 Pro with
Node 26, a 1 Gbit/s connection and the vectors of a previous issues-and-docs index to reuse:

| Stage | Items | Wall time |
|---|---|---|
| GitHub sources (issues, pull requests, discussions, releases, docs, code, files) | 7367 | 24.6 min |
| Forum (Discourse, 4 requests per second) | 1847 | 9.7 min |
| Whole build, embedding included | 9214 items, 41440 chunks (18685 embedded, 22755 reused) | 34.3 min |

The resulting index is 91 MB and the raw store 43 MB (7974 records). This 34 minute pass started
from a raw store that already held every issue and 2084 of the pull requests, fetched by an earlier
pass that ran for 65 minutes before GitHub's primary rate limit stopped it. A first fill from
nothing therefore costs about 11 000 REST requests (one listing page per 100 items, one comments
request per issue, one review-comments and one files request per pull request), which is more
than the 5000 requests per hour of a user token: the client now waits out the window boundary,
so expect about two hours for the very first android build. Every later build reuses the raw
store (no comment, review or topic request for an unchanged item) and the previous vectors, and
takes the time of the listings plus the changed items.

Measured on 2026-10-20 with the same setup, a full raw store and the previous index to reuse:

| Build | What it read | Wall time |
|---|---|---|
| Full rebuild (`--full`, or every 7 days) | every listing, every checkout; 24 chunks embedded, 41 433 reused | 3 min 16 s |
| Incremental (the nightly default) | issues, pull requests, discussions, releases and forum topics changed since the previous build (none that morning), the checkouts in full; 0 chunks embedded, 6376 reused | 17 s |

The Actions `GITHUB_TOKEN` only has 1000 requests per hour, so the first fill of a large consumer
converges over a few nightly runs (see "Run it in GitHub Actions"); after that the nightly job is
incremental and its cost follows the number of changed items, not the size of the repository.

### Raw store

With `--raw`, every fetched payload is kept verbatim (gzip JSON per item) in a second SQLite file
next to the index. It is gitignored like the index. It serves two purposes: the benchmark mines its
ground truth (duplicate links, close reasons, `fixes #N`, docs links in maintainer replies) from the
original material rather than from cleaned chunks, and a rebuild with the same store skips the
comment, review and topic requests of items whose change marker (`updated_at`, `last_posted_at`)
did not move.

With `--offline`, the build replays the raw store instead of the network: issues, pull requests,
discussions, releases and forum topics come from the stored payloads, docs, code and files from the
checkouts as usual, and no token is needed. It is always a full build; `--previous` still reuses
the vectors of unchanged chunks. The benchmark's bake-off builds one index per candidate model this
way. Two things do not replay: an accepted forum answer that was not on the stored first page of
posts, and the GraphQL links the case mining fetches (those are stored by `mine-cases --github`,
see Benchmark). On the android store, an offline rebuild with every vector reused takes 22 s.

## Benchmark

The benchmark measures the retrieval on cases mined from the consumer's own history, so a change to
chunking, fusion, weights or the embedding model has a number before it ships. Outputs go under
`bot-scripts/eval-out/` and `bot-scripts/bake-off/`, both gitignored.

### Mine the cases

    cd bot-scripts
    GITHUB_TOKEN=$(gh auth token) npm run mine-cases -- \
      --config ../../android/.github/knowledge-bot.yaml \
      --raw ./knowledge-android.raw.sqlite \
      --out ../../android/.github/knowledge-bot/eval --github

`--github` first fetches, 50 items per GraphQL request, the duplicate marks of every closed issue
and the closing references of every merged pull request, and stores them in the raw store as
`links` records keyed by the item's `updated_at`; later runs reuse them and work offline. The rules,
one case per query issue (`cases.jsonl`):

| relation | label | query | expected | as of |
| --- | --- | --- | --- | --- |
| duplicate | timeline mark, else a maintainer comment saying "duplicate of #N" | the later-created issue | the earlier one | the mark or comment |
| fixed-by | closing references, else "fixes #N" in a merged pull request body | the issue | the pull request | the merge |
| docs | maintainer comment with a docs link, up to a minute after the close | the issue | the docs page (no fragment) | the comment |
| forum | maintainer comment with a forum topic link that is in the store | the issue | the topic | the comment |
| negative | fixed by a pull request and answered by nothing else | the issue | nothing | the issue's creation |

Labels come only from maintainer actions (API association OWNER, MEMBER or COLLABORATOR). The query
item is always excluded from the ranking and only chunks created before `asOf` are eligible, so a
case sees what the bot would have seen. Negatives are drawn, by salted hash, to equal the number of
duplicate, docs and forum cases. Each case gets a split from a salted hash of its id: 60 train,
20 validation, 20 test; re-mining keeps the split, `--salt` re-draws it. `sample.md` lists 30 cases
to re-derive by hand: when a rule is wrong, fix the rule and re-mine, never the case.
`mining-report.json` counts the cases per relation and label source and what was dropped and why.

Curated cases (recurring questions in the reporter's words, `query.type: text`) go in another
`.jsonl` file of the same directory; the schema is `schemas/eval-case.json`. The consumer config
names the directory with `evalCases`, relative to the config file.

### Run the eval

    npm run run-eval -- --config ../../android/.github/knowledge-bot.yaml \
      --index ./knowledge-android.sqlite [--split test] [--mode production|oracle|null]

Every case goes through the production `retrieve` with the as-of filter and the config's
similarity floor. The run writes `summary.json`, `summary.md`, `cases.jsonl` (the ranked list of
every case with scores) and `errors.jsonl` (cases that could not be scored: an expected item not in
the index, a query item missing; they never enter the score). The summary reports recall at 5 and
mean reciprocal rank over the positives, per relation, per expected source and per label source,
and the gate (precision, specificity, sensitivity of "best similarity at or above the threshold")
at the config's `triage.minSimilarity` plus a sweep from 0.30 to 0.95.

`--mode oracle` queries with the expected item's own text and should score near 100; anything
lower is a harness bug. `--mode null` ranks random items and shows the chance level. Run both before
trusting a production number.

### Compare two runs

    npm run compare-eval -- eval-out/a/cases.jsonl eval-out/b/cases.jsonl

Pairs the positive cases both runs scored and reports the recall at 5 difference of B minus A with
a bootstrap 95 percent interval. A drop of more than 5 points whose interval excludes zero is a
regression: exit code 3, for a workflow to gate on. Smaller moves are noise at this case count.

### Bake-off

    npm run bake-off -- --config ../../android/.github/knowledge-bot.yaml \
      --raw ./knowledge-android.raw.sqlite --models ./eval/bake-off-models.yaml \
      --out ./bake-off --split validation --self ../../android \
      --checkout home-assistant/companion.home-assistant=../../companion.home-assistant \
      --checkout home-assistant/contributors.home-assistant.io=../../contributors.home-assistant.io

Builds one index per model of `eval/bake-off-models.yaml` offline from the raw store, runs the
validation split through it and rewrites `bake-off.md` after every model, so a run that dies keeps
its rows. Models are chosen on validation; the winner's test number is reported separately. A
model whose download or build fails is a row marked skipped.

### Results (android)

First run on 2026-10-20, on the index of the same day (bge-small-en-v1.5 q8, 9214 items, 41 440
chunks), after the hand check of 30 labels and the three rule fixes it led to. Mined cases: 324
docs, 259 duplicate (76 from the timeline, 183 from comments), 743 fixed-by, 8 forum, 591
negatives; 1925 in all, 392 in the test split. Mining took 107 GraphQL requests for the links.

| run | split | positives | recall@5 | MRR | wall time |
| --- | --- | --- | --- | --- | --- |
| oracle (expected item's own text) | all | 1326 | 98.6 | 0.852 | 298 s |
| null (random ranking) | all | 1326 | 0.2 | 0.001 | 11 s |
| production | test | 282 | 30.9 | 0.195 | 90 s |
| production | validation | 255 | 29.8 | 0.204 | 82 s |

Production on the test split by relation: duplicate 47.3, docs 30.4, fixed-by 24.8 (recall at 5;
the one forum case hit). Errors: one docs page renamed since the maintainer linked it. The gate
sweep on the test split shows that every negative scores above 0.70 with this model, so the
config's `minSimilarity` of 0.35 filters nothing; the trade-off starts near 0.85 (precision 75,
specificity 76, sensitivity 28) and the threshold is a tuning item, not a benchmark one.

These are the baseline numbers the weekly tuning and the bake-off compare against; a change
that moves the test recall by less than 5 points is noise at this case count.

Bake-off of the same day on the validation split (255 positives, 130 negatives), each index built
offline from the raw store on a MacBook (CPU, q8), every chunk embedded:

| model | dims | build | chunks/s | recall@5 | MRR |
| --- | --- | --- | --- | --- | --- |
| all-MiniLM-L6-v2 | 384 | 5 min 6 s | 135 | 29.0 | 0.190 |
| bge-small-en-v1.5 (default) | 384 | 8 min 34 s | 81 | 30.6 | 0.203 |
| snowflake-arctic-embed-s | 384 | 8 min 57 s | 77 | 34.9 | 0.215 |
| nomic-embed-text-v1.5 | 768 | 31 min 23 s | 22 | 29.8 | 0.186 |
| embeddinggemma-300m | 768 | 30 min 34 s | 23 | 28.6 | 0.192 |

The two 768-dimension models cost four times the build for no gain. Arctic-embed-s is the only
candidate ahead of the default: paired against bge-small it gains 4.3 points on validation
(95 percent interval minus 0.8 to 9.0) and 5.7 on test (1.8 to 9.6; 36.9 against 31.2, with docs
42.0 against 30.4 and duplicate 54.5 against 47.3). The validation interval includes zero, so by
the rule above the default stays bge-small; arctic-embed-s is the candidate to re-run once the
case set has grown, and the switch is one `embedding` block in the consumer config.

## Run it in GitHub Actions

A consumer holds its config at `.github/knowledge-bot.yaml` and two thin caller workflows. The
reusable workflows check out this repository at the commit the caller references
(`github.job_workflow_sha`), so the actions and scripts always match the workflow version.

Nightly rebuild, manual run, and a run on every push that touches the config:

    name: Knowledge index

    on: # yamllint disable-line rule:truthy
      schedule:
        - cron: "17 3 * * *"
      workflow_dispatch:
      push:
        branches: [main]
        paths:
          - .github/knowledge-bot.yaml
          - .github/workflows/knowledge-index.yml

    permissions: {}

    jobs:
      build:
        uses: TimoPtr/auto-triage/.github/workflows/build-index.yml@main
        permissions:
          contents: read
          actions: read
          issues: write
        with:
          slug: android
          checkouts: |
            home-assistant/companion.home-assistant
            home-assistant/contributors.home-assistant.io

Append on close, so a resolution is searchable shortly after the issue or pull request closes:

    name: Knowledge index append

    on: # yamllint disable-line rule:truthy
      issues:
        types: [closed]
      pull_request_target:
        types: [closed]

    permissions: {}

    jobs:
      append:
        uses: TimoPtr/auto-triage/.github/workflows/append-on-close.yml@main
        permissions:
          contents: read
          actions: read
        with:
          slug: android
          item: ${{ github.event_name == 'issues' && format('issue:{0}', github.event.issue.number) || format('pull:{0}', github.event.pull_request.number) }}

Builds and appends of one slug share a concurrency group, so an append waits for a running build.
GitHub keeps one pending run per group: closes that pile up during a long build show as cancelled
and are covered by the next nightly rebuild. An append that changes nothing (a bot pull request
that was never indexed) publishes nothing.

`pull_request_target` is deliberate: a `pull_request` run from a fork writes the cache into the
fork's scope, invisible to the nightly build. The called workflow never checks out pull request
code; it reads the API with the workflow token only. `actions: read` is for the artifact fallback,
`issues: write` for the tracking issue the build keeps open while the index is stale, unusable or
missing (`tracking: false` turns it off).

What the pieces do:

- `actions/setup-bot` installs `bot-scripts` with Node 24 and caches the embedding model.
- `actions/restore-index` restores the index and the raw store from the Actions cache by key prefix
  (`<slug>-index-v<format>-`, `<slug>-raw-v<schema>-`), validates the index against the config,
  and falls back to the newest `<slug>-index` artifact produced by a default-branch run. Outputs:
  `found`, `usable`, `status` (`fresh` under two days, `stale`, `unusable` with a `reason` such as
  another model, `missing`), `source` (`cache`, `artifact`, `none`), `age-days`, `items`, `chunks`.
- `actions/publish-index` saves the index and raw store to the cache under a run-scoped key and
  uploads them as artifacts with 30 day retention; it refuses an unusable index.
- After a successful publish, `build-index.yml` runs the test split of the consumer's eval cases
  (`evalCases` in the config) against the new index, writes the summary to the job summary and
  uploads the run as the `eval-<slug>` artifact. A consumer without cases skips this with a line in
  the log.
- `actions/report-index-status` writes the job summary and maintains the tracking issue.
- `build-index.yml` ties them together; `append-on-close.yml` upserts one item in place;
  `selfcheck.yml` validates a config, for pull requests that touch it.

How a build decides what to read: with a usable restored index, the build is incremental. It starts
from a copy of that index and asks each source only for what changed since the index was started
(one hour of overlap): issues through the API's `since`, pull requests, discussions, releases and
forum categories listed newest first until the first older item. Docs, code and files are re-read
from the checkouts every time, which takes seconds and is how a deleted page or file leaves the
index. A listed item that no longer qualifies (an issue reopened when only closed ones are indexed,
a forum topic that lost its tag) is removed. What the sources cannot report incrementally waits for
the full rebuild: a deleted or transferred issue, a reopened pull request, a topic or discussion
moved out of its category, a forum answer accepted without a new post. The full rebuild happens
when the last one is 7 or more days old, when the config changed, when no usable index exists, or
when the `full` input of `build-index.yml` is set (the android caller exposes it on
`workflow_dispatch`). Releases are listed in commit order, so the incremental build reads the whole
list and keeps those published since; that is a handful of requests.

First fill of a large repository: the android fill is about 11 000 API requests and the workflow
token allows 1000 per hour, so the first nightly runs stop on the rate limit before the index is
written. Each run keeps its raw store (the build is stopped 20 minutes before the job timeout and
the raw store is published even when the build failed), and the next run continues from it, so the
fill converges in two to three runs. A manual `workflow_dispatch` run between nights speeds it up.
The tracking issue reports `missing` until the first index is published.

The pipeline self-test (`ci-pipeline.yml`) runs on every push to `main` and every pull request: it
validates `examples/selfcheck/knowledge-bot.yaml`, builds an index of this repository's own issues
and docs through the reusable workflow, restores it in a second job and runs one query.
