# auto-triage

Shared code for the Home Assistant knowledge bot: index builders, retrieval, actions and
agentic workflow templates. Consumer repositories hold a `.github/knowledge-bot.yaml` and thin
callers. Design: the knowledge bot spec in `home-assistant/android`,
`docs/superpowers/specs/2026-10-15-knowledge-bot-design.md`.

## Set up a repository

Five steps, in this order; the index must exist before the triage workflow is worth installing.
Everything below is already in place for `home-assistant/android` and can be copied from there.

1. **Write `.github/knowledge-bot.yaml`.** The schema is `schemas/config.base.json` plus one
   fragment per provider under `schemas/providers/`; unknown keys fail the build. A minimal config
   that indexes the repository's own issues and pull requests, its documentation from another
   repository and one forum category:

       # Knowledge bot configuration. Schema: https://github.com/home-assistant/auto-triage/tree/main/schemas
       version: 1

       product:
         name: My Product
         slug: my-product            # prefix of the cache keys and artifact names

       providers:
         github:
           my-org/my-product:
             issues:
               states: [open, closed]
               comments: true
             pulls:
               states: [merged, closed]
           my-org/my-product-docs:
             docs:
               path: docs
               baseUrl: https://docs.example.org/
         discourse:
           community.example.org:
             categories: [my-product]

       embedding:
         model: Xenova/bge-small-en-v1.5
         revision: ea104dacec62c0de699686887e3f920caeb4f3e3
         dtype: q8
         dimensions: 384
         pooling: cls

       triage:
         staged: true                 # comments go to the run summary until you flip this
         minSimilarity: 0.35
         suppressSimilarity: 0.8

   Every source kind and its options are described under "Sources"; `releases`, `discussions`,
   `code` and `files` are the other kinds. Check it locally before committing:
   `cd bot-scripts && node src/cli/validate-config.ts --config <path>`, or add the `selfcheck.yml`
   reusable workflow to run that check on pull requests that touch the file.

2. **Add the two caller workflows** from "Run it in GitHub Actions": `knowledge-index.yml`
   (nightly, manual, and on pushes that touch the config; `checkouts:` lists the repositories read
   from a checkout, here `my-org/my-product-docs`) and `knowledge-append.yml` (`issues: closed`,
   `pull_request_target: closed`). They need `contents: read`, `actions: read` (the artifact
   fallback) and, for the build, `issues: write` (the tracking and digest issues, label
   `knowledge-bot`, created on first use; `tracking: false` turns them off). No secret is added:
   everything runs on the workflow token.

3. **Let the first fill converge.** The workflow token allows 1000 API requests per hour, so a
   large repository needs two or three nightly runs before the first index is published; a manual
   `workflow_dispatch` between nights speeds it up, and the run summary shows the progress. A
   tracking issue stays open while the index is missing or stale and closes on the first healthy
   run. After that, a nightly run is incremental and takes a few minutes (see "Build time").

4. **Add the triage caller** once the index exists: `knowledge-triage.yml` from "Triage
   workflow", on `issues: [opened, labeled]` and `workflow_dispatch`, calling
   `.github/workflows/triage.lock.yml` of this repository with `contents: read`, `actions: read`,
   `issues: write`, `pull-requests: read` and `copilot-requests: write` (GitHub refuses the call at
   start-up when a job of the called workflow asks for more than the caller grants). No gh-aw tooling is needed in the consumer; the
   repository must have Copilot agentic workflows enabled. With `staged: true` every new issue
   produces a run whose summary holds the comment that would have been posted; read those for a
   week or two, then set `staged: false` (the config is read at run time). "Triage workflow"
   explains the three jobs and `ai-recheck`.

5. **Optional: benchmark cases.** Point `evalCases` at a directory and run `mine-cases` once to
   seed it from the repository's own duplicates and fixes ("Benchmark"); the nightly build then
   scores the test split, compares it with the previous night and keeps a tracking issue open on a
   regression ("Quality loop"). Without cases the build skips the eval with one log line.

Until this repository moves to the `home-assistant` organization and tags `v1`, callers reference
`@main`; after that, pin by SHA with a version comment, as the android callers note in a `TODO`.

## Layout

- `bot-scripts/` TypeScript run natively by Node 24 (type stripping, no build step): providers, index
  writer, retrieval, CLIs. `npm ci --ignore-scripts --omit=dev` installs the runtime; `tsc --noEmit` is a
  dev-only check. Imports keep the `.ts` extension, and no syntax that needs transformation (enums,
  parameter properties, decorators) is used.
- `bot-scripts/src/triage/` the deterministic halves of the triage workflow: the gate and handoff
  builder, the verdict parser and the comment renderer.
- `bot-scripts/src/feedback/` the quality loop: reactions, replies and outcomes of the bot comments,
  the suppression list and the digest.
- `.github/workflows/` the reusable workflows consumers call: `build-index.yml`, `append-on-close.yml`,
  `selfcheck.yml`, and the gh-aw workflow `triage.md` with its compiled `triage.lock.yml`.
- `schemas/` JSON Schema for the config, the eval cases, the handoff and the index metadata.
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
The harness ages candidates as of the case's own date, so an old case is scored as the bot would
have scored it then.

| run | split | positives | recall@5 | MRR | wall time |
| --- | --- | --- | --- | --- | --- |
| oracle (expected item's own text) | all | 1326 | 99.5 | 0.988 | 278 s |
| null (random ranking) | all | 1326 | 0.2 | 0.001 | 11 s |
| production | test | 282 | 32.6 | 0.212 | 87 s |
| production | validation | 255 | 30.6 | 0.213 | 80 s |

Production on the test split by relation: duplicate 52.7, docs 21.7, fixed-by 29.9 (recall at 5;
the one forum case hit). Errors: one docs page renamed since the maintainer linked it. The gate
sweep on the test split shows that every negative scores above 0.70 with this model, so the
config's `minSimilarity` of 0.35 filters nothing; the trade-off starts near 0.85 (precision 75,
specificity 76, sensitivity 28) and the threshold is a tuning item, not a benchmark one.

These are the baseline numbers the weekly tuning and the bake-off compare against; a change
that moves the test recall by less than 5 points is noise at this case count. The run outputs
(summaries, errors, the per-case ranked lists of the runs a comparison needs, the bake-off table)
are kept under `benchmarks/android/2026-10-20/`, one dated directory per benchmark run.

Bake-off of the same day on the validation split (255 positives, 130 negatives), each index built
offline from the raw store on a MacBook (CPU, q8), every chunk embedded:

| model | dims | build | chunks/s | recall@5 | MRR |
| --- | --- | --- | --- | --- | --- |
| all-MiniLM-L6-v2 | 384 | 5 min 6 s | 135 | 29.0 | 0.202 |
| bge-small-en-v1.5 (default) | 384 | 8 min 34 s | 81 | 30.6 | 0.213 |
| snowflake-arctic-embed-s | 384 | 8 min 57 s | 77 | 34.1 | 0.227 |
| nomic-embed-text-v1.5 | 768 | 31 min 23 s | 22 | 31.8 | 0.207 |
| embeddinggemma-300m | 768 | 30 min 34 s | 23 | 31.0 | 0.199 |

The two 768-dimension models cost four times the build for a point or less. Arctic-embed-s is the
only candidate clearly ahead of the default: paired against bge-small it gains 3.5 points on
validation (95 percent interval minus 0.8 to 7.8) and 5.7 on test (2.1 to 9.2; 38.7 against 33.0,
with docs 30.4 against 21.7 and duplicate 58.2 against 52.7). The validation interval includes
zero, so by the rule above the default stays bge-small; arctic-embed-s is the candidate to re-run
once the case set has grown, and the switch is one `embedding` block in the consumer config.

## Run it in GitHub Actions

A consumer holds its config at `.github/knowledge-bot.yaml` and two thin caller workflows. The
reusable workflows check out this repository at the commit the caller references
(`job.workflow_repository` at `job.workflow_sha`), so the actions and scripts always match the workflow version.

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

## Triage workflow

`.github/workflows/triage.md` is a gh-aw workflow (Copilot engine) that comments on a new issue
with the closest earlier reports, discussions and docs, and a short answer when it is confident. It
is a reusable workflow: its compiled `triage.lock.yml` is committed here (the `lock` job of the
test workflow recompiles it with the gh-aw version named in its first line and fails on a
difference; regenerate with `gh aw compile triage`) and a consumer calls
it from a thin workflow that owns the triggers:

    name: Knowledge triage

    on: # yamllint disable-line rule:truthy
      issues:
        types: [opened, labeled]
      workflow_dispatch:
        inputs:
          issue-number:
            description: Issue to triage
            required: true
            type: string

    permissions: {}

    concurrency:
      group: knowledge-triage-${{ github.event.issue.number || inputs.issue-number }}
      cancel-in-progress: false

    jobs:
      triage:
        uses: TimoPtr/auto-triage/.github/workflows/triage.lock.yml@main
        permissions:
          contents: read
          actions: read
          issues: write
          pull-requests: read     # gh-aw's own conclusion jobs ask for it
          copilot-requests: write
        with:
          issue-number: ${{ github.event.issue.number || inputs.issue-number }}
          event-action: ${{ github.event.action || 'dispatch' }}
          label: ${{ github.event.label.name || '' }}

The called workflow checks this repository out at the commit the caller references
(`job.workflow_repository` at `job.workflow_sha`), so the scripts match the workflow version; pin by SHA once `v1`
exists. Three things about a called gh-aw workflow, learned on the first runs: its prompt must be
embedded in the lock (`inlined-imports: true`), since gh-aw otherwise reads the markdown from the
caller's workspace at run time; every permission a generated job asks for must be granted by the
caller or GitHub refuses the call at start-up (hence no reaction on the issue, and
`pull-requests: read` for gh-aw's conclusion jobs); and `GH_AW_AGENT_OUTPUT` is read from the step's
shell, not through `env.` in the same step. The Copilot engine runs on the workflow token with `copilot-requests: write`; no secret is
added. A `labeled` event runs only for `ai-recheck` (removed again so it can be re-applied), a
manual run passes `dispatch`. Who may trigger a run is the caller's choice of events: issues from
anyone are triaged, so the issue text is treated as data everywhere.

What happens, in three jobs:

1. **Pre-activation (no model).** Fetches the issue with `gh api` before anything is installed,
   checks out the consumer and this repository, restores the index and runs `prepare-triage` from
   the saved payload, so the step that loads the model and the rest of the dependencies holds no
   token. The body is cleaned like an indexed issue, embedded, and searched (dense + lexical, with
   fenced logs lifted into the lexical query + a live forum search on the cleaned text), excluding
   the issue itself when the index already holds it. The gate stops the run for pull requests, bot authors,
   empty issues, a missing or unusable index, and a best similarity under `triage.minSimilarity`.
   Otherwise it writes the handoff (`schemas/handoff.json`: the cleaned issue, up to ten excerpts
   with ids, source, url, date, audience, outcome and scores, and the confidence thresholds) and
   uploads it as the `triage-handoff` artifact. A stopped run spends no agent time and posts nothing.
2. **Agent.** `claude-sonnet-5` on the Copilot engine, five turns, no network, no GitHub tools,
   `bash` limited to `cat`, `jq`, `head`, `wc` plus gh-aw's read-only defaults. It reads `/tmp/gh-aw/agent/handoff.json` and calls
   `post_triage_verdict` once with `confidence` (0 to 100), `duplicates` and `related` (excerpt ids),
   an optional `answer` and `component`. It never sees the index and cannot write anywhere.
3. **post-triage-verdict (no model).** `render-verdict` validates the verdict against the handoff
   (unknown ids are dropped with a note, an unparsable confidence fails the job), picks the tier
   (`high` from `triage.confidence.answer`, default 75; `medium` from `triage.confidence.links`,
   default 45; `low` below) and renders the comment: a marker
   `<!-- knowledge-bot v1 run=<id> tier=<tier> issue=<n> -->`, "Possibly related to earlier
   reports", "Discussions and docs", the answer on the high tier, and a feedback footer. Links come
   only from the handoff; titles are escaped and mentions removed; developer-audience excerpts
   appear only when the issue talks about building, maintainer-audience ones never (`component`
   goes to the run summary). A low tier posts nothing. The job minimizes earlier bot comments as
   outdated and posts the new one with `gh api` under its own `issues: write`; the `duplicate`
   label is never applied.

The pre-activation job writes the gate outcome to the job summary and the post-triage-verdict job
the tier, the verdict and the comment (or why none was posted), so a run that posts nothing is still
readable. One case is only in gh-aw's own agent summary: an agent that ends without calling the
tool, since gh-aw skips the custom job then.

The pre-activation job holds `issues: write` to remove the `ai-recheck` label; that is the one write
scope outside the posting job, and no dependency code runs with its token (the index restore uses it
for the read-only artifact fallback).

Staged rollout: with `triage.staged: true` in the config the comment goes to the run summary only.
Read the summaries for a while, then flip it.

    triage:
      staged: true
      minSimilarity: 0.35
      confidence:
        answer: 75
        links: 45

Local dry run, from `bot-scripts/` with a built index (the agent step is replaced by a hand-written
verdict):

    GH_TOKEN=$(gh auth token) npm run -s prepare-triage -- --config ../../android/.github/knowledge-bot.yaml \
      --index knowledge-android.sqlite --index-status fresh --repo home-assistant/android --issue 7654 \
      --out eval-out/triage/handoff.json
    echo '{"items":[{"type":"post_triage_verdict","confidence":"80","duplicates":"4","related":"0,2","answer":"..."}]}' \
      > eval-out/triage/agent_output.json
    npm run -s render-verdict -- --config ../../android/.github/knowledge-bot.yaml --handoff eval-out/triage/handoff.json \
      --agent-output eval-out/triage/agent_output.json --out-dir eval-out/triage --run-id local
    cat eval-out/triage/comment.md

Cost: one model run per triaged issue, bounded by five turns and fifteen minutes; the gate keeps
pull requests, bot issues and low-similarity issues from reaching the model. The `template` job of
the test workflow compiles the template with the pinned gh-aw version on every change.

## Quality loop

The nightly build closes the loop on the triage comments; a consumer that calls `build-index.yml`
gets all of it without changes.

**Feedback.** After a successful publish, `collect-feedback` reads the raw store and finds every
bot comment by its marker (posted by a Bot account, well-formed tier and run id). For each it keeps
the 👍 and 👎 counts, the first reply by a person (role from the API association: reporter,
maintainer or user; text cut to 500 characters) and the outcome rules of the spec:

- `recheck`: a later bot comment exists on the issue (the `ai-recheck` label was used);
- `hit` / `miss`: the issue was closed as a duplicate (state reason or label) and the target, taken
  from the benchmark's links record when present or else from a maintainer's "duplicate of #n"
  comment after the bot's, was or was not among the suggested duplicates;
- `answered`: the reporter closed the issue within 7 days of the comment, not as a duplicate;
- `dismissed`: a 👎, or a miss while duplicates were suggested.

Reactions do not bump an issue's `updated_at`, so the incremental build would only see them on the
weekly full rebuild; the step re-reads the reactions of every bot comment younger than 90 days
through the API with the workflow token. The result is `feedback.json`
(`{ version, repository, generatedAt, comments, suppressed }`), saved to the Actions cache under
`<slug>-feedback-v1-<run id>-<attempt>` and uploaded as the `feedback-<slug>` artifact (30 days).
`report-feedback` keeps one digest issue, `Knowledge bot <slug>: feedback digest` (label
`knowledge-bot`): totals per tier, reactions, outcomes, the suppressed count and a table of the
20 newest comments. It is created once a bot comment exists and its body is replaced every night;
reply text never reaches it. `tracking: false` on the caller turns the issue off.

**Suppression.** Issues whose bot comment was downvoted or dismissed are the suppression list. The
triage template restores the newest `feedback.json` from the cache in pre-activation (a missing,
unreadable or older file is ignored with a log line). When a retrieved excerpt is one of those
issues, of the same repository, at or above `triage.suppressSimilarity` (default 0.8, a tuning
item), the handoff marks a demotion and `render-verdict` lowers the tier by one: high becomes
medium, medium becomes low. The run summary names the suppressed issue.

**Eval regression.** When the build evaluated the test split, it restores the previous nightly
`eval-<slug>` artifact (directory mode of `restore-artifact.sh`: default-branch runs only, plain
regular files only), runs `compare-eval` on the two `cases.jsonl` and `report-eval-status` writes
the paired delta of recall at 5 with its interval to the summary. A regression (drop above 5 points
with the interval excluding zero) opens or comments the tracking issue `Knowledge eval <slug>:
regression`; a clean comparison closes it. A build without a previous artifact or without eval
cases says so and stays green.

Local dry run of the collection, from `bot-scripts/` with a raw store:

    npm run -s collect-feedback -- --config ../../android/.github/knowledge-bot.yaml \
      --raw knowledge-android.raw.sqlite --repo home-assistant/android --out eval-out/feedback
    cat eval-out/feedback/digest.md   # only once a bot comment exists

Add `--github` with `GH_TOKEN` to refresh the reactions, as the nightly step does.
