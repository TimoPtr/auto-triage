# auto-triage

Shared code for the Home Assistant knowledge bot: index builders, retrieval, composite actions and
the agentic triage workflow. A consumer repository holds a `.github/knowledge-bot.yaml` and three
thin caller workflows; everything else runs from here, pinned by release. Design: the knowledge bot
spec in `home-assistant/android`, `docs/superpowers/specs/2026-10-15-knowledge-bot-design.md`.

How it fits together:

- **Index.** A nightly workflow reads the consumer's issues, pull requests, discussions, releases,
  docs, code and forum topics into one SQLite file (FTS5 plus sqlite-vec, embeddings computed
  locally, no API key) and publishes it to the Actions cache. A second workflow appends an issue or
  pull request as it closes.
- **Triage.** A new issue is searched against the index. When something close enough exists, a
  Copilot agent reads the excerpts and a deterministic job posts one comment with the closest
  earlier reports, discussions and docs, and an answer when the agent is confident. Nothing else
  is posted or labeled.
- **Quality loop.** The nightly build collects the reactions and outcomes of the bot's comments
  into a digest issue, suppresses what was downvoted, and scores retrieval against cases mined
  from the repository's own history.

Contents: [Set up a repository](#set-up-a-repository) · [Configuration](#configuration) ·
[Workflows](#workflows) · [Sizing and limits](#sizing-and-limits) · [Local use](#local-use) ·
[Benchmark](#benchmark) · [Quality loop](#quality-loop) · [Contributing](#contributing)

## Set up a repository

Five steps, in this order; the index must exist before the triage workflow is worth installing.
Everything below is in place for `home-assistant/android` and can be copied from there.

1. **Write `.github/knowledge-bot.yaml`** ("Configuration"). A minimal config that indexes the
   repository's own issues and pull requests, its documentation from another repository and one
   forum category:

       # Knowledge bot configuration. Schema: https://github.com/TimoPtr/auto-triage/tree/main/schemas
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
         revision: ea104dacec62c0de699686887e3f920caeb4f3e3   # a commit of the model repository
         dtype: q8
         dimensions: 384
         pooling: cls

       triage:
         staged: true                 # comments go to the run summary until you flip this
         minSimilarity: 0.35
         suppressSimilarity: 0.8

   Check it locally with `cd bot-scripts && node src/cli/validate-config.ts --config <path>`, or
   add the `selfcheck.yml` reusable workflow to run that check on pull requests that touch the file.

2. **Add the index callers** from "Workflows": `knowledge-index.yml` (nightly, manual, and on
   pushes that touch the config) and `knowledge-append.yml` (on close). No secret is added:
   everything runs on the workflow token.

3. **Let the first fill converge.** A large repository needs more than one run before the first
   index is published; each run keeps what it fetched and embedded, and the next one resumes
   ("Sizing and limits"). A manual `workflow_dispatch` between nights speeds it up, the run summary
   shows the progress, and a tracking issue stays open until the first healthy run. After that a
   nightly run is incremental and takes minutes.

4. **Add the triage caller** `knowledge-triage.yml` once the index exists. Create the `ai-recheck`
   label once (`gh label create ai-recheck --description "Ask the knowledge bot to triage this
   issue again"`), since GitHub refuses to apply a label that does not exist, and make sure the
   repository has Copilot agentic workflows enabled; no gh-aw tooling is needed in the consumer.
   With `staged: true` every new issue produces a run whose summary holds the comment that would
   have been posted; read those for a week or two, then set `staged: false` (the config is read at
   run time).

5. **Optional: benchmark cases.** Point `evalCases` at a directory and run `mine-cases` once to
   seed it from the repository's own duplicates and fixes ("Benchmark"); the nightly build then
   scores the test split, compares it with the previous night and keeps a tracking issue open on a
   regression ("Quality loop"). Without cases the build skips the eval with one log line.

Callers pin a release by its commit SHA with the tag in a comment, the same way they pin any other
action, so Renovate can propose the next release:

    uses: TimoPtr/auto-triage/.github/workflows/triage.lock.yml@<sha> # vX.Y.Z

A test bed may follow `@main` instead. The reusable workflows check this repository out at the
ref the caller named (`job.workflow_repository` at `job.workflow_sha`), so one pin covers the
workflows, the composite actions, the scripts and the compiled triage lock together.

## Configuration

The schema is `schemas/config.base.json` plus one fragment per provider under `schemas/providers/`;
unknown keys fail the build, and defaults come from the schema.

### Sources

Under `providers.github.<owner/repo>`:

- `issues`: open and closed issues with their comments; the author role of every chunk comes from
  the API association, never from the text.
- `pulls`: closed pull requests, merged or not, with the review threads that have a maintainer
  reply (one chunk per comment with its own role), the issues they close (GitHub's closing
  references, read through GraphQL, plus closing keywords in the body) and the files touched; bot
  authors are skipped by default. Review chunks are indexed but never retrieved unless asked for
  (`--with-reviews` on the query CLI), since they talk about code rather than symptoms.
- `discussions`: the discussions of the named categories with their accepted answer, read through
  GraphQL.
- `releases`: published release notes chunked by section; prereleases are opt-in.
- `docs`: a markdown tree with front matter, read from a checkout and linked by slug or id when
  they stay on the docs site.
- `code`: Kotlin sources as one chunk per top-level declaration, with the string resource keys it
  uses; maintainer audience.
- `files`: Android string resources (`strings`) or markdown trees such as agent skills (`markdown`).

Under `providers.discourse.<host>`: the topics of the named categories (slug or id) with their
accepted answer, optionally filtered by tag. `solvedOnly` makes the site list only solved topics,
`closedWithinDays` ends the listing at the first page outside the window, and `requestsPerSecond`
(3 by default) throttles the client, which waits out a 429.

### Embedding

`embedding` names the model (a Hugging Face repository that transformers.js can load), the commit
of the model repository as `revision`, `dtype`, `dimensions` and `pooling`; `queryPrefix` and
`documentPrefix` serve models that expect one. The model is downloaded once (about 35 MB for the
default) and cached. Any config change triggers a full rebuild; a different model makes the
restored index unusable, so that build starts over.

### Triage settings

- `staged`: the comment goes to the run summary instead of the issue.
- `minSimilarity`: the gate; an issue whose best match scores below it never reaches the agent.
- `confidence.answer` (default 75) and `confidence.links` (default 45): the agent's confidence at
  which the comment carries an answer, or only links; below `links` nothing is posted.
- `suppressSimilarity` (default 0.8): similarity to an issue whose earlier bot comment was
  downvoted or dismissed from which the verdict drops one tier ("Quality loop").
- `evalCases`: directory of the benchmark cases, relative to the config file ("Benchmark").

## Workflows

A consumer calls three reusable workflows of this repository. They check this repository out at the
commit the caller references, so the actions and scripts always match the workflow version. The
pipeline self-test `ci-pipeline.yml` runs on every push to `main` and every pull request: it
validates `examples/selfcheck/knowledge-bot.yaml`, builds an index of this repository's own issues
and docs through the reusable workflow, restores it in a second job and runs one query.

### Index build

`build-index.yml` builds or updates the index. Inputs: `slug` (prefix of the cache keys and
artifact names), `config` (default `.github/knowledge-bot.yaml`), `checkouts` (the repositories
read from a checkout, one `owner/repo` per line), `timeout-minutes` (default 350), `tracking`
(default true) and `full`. Nightly rebuild, manual run, and a run on every push that touches the
config:

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
        uses: TimoPtr/auto-triage/.github/workflows/build-index.yml@<sha> # vX.Y.Z
        permissions:
          contents: read
          actions: read
          issues: write
        with:
          slug: android
          checkouts: |
            home-assistant/companion.home-assistant
            home-assistant/contributors.home-assistant.io

`actions: read` is for the artifact fallback, `issues: write` for the tracking and digest issues
(label `knowledge-bot`, created on first use; `tracking: false` turns them off).

The pieces, in order:

- `actions/setup-bot` installs `bot-scripts` with Node 26 and caches the embedding model.
- `actions/restore-index` restores the index and the raw store from the Actions cache by key prefix
  (`<slug>-index-v<format>-`, `<slug>-raw-v<schema>-`), validates the index against the config,
  and falls back to the newest `<slug>-index` artifact produced by a default-branch run. Outputs:
  `found`, `usable`, `status` (`fresh` under two days, `stale`, `unusable` with a `reason` such as
  another model, `missing`), `source` (`cache`, `artifact`, `none`), `age-days`, `items`, `chunks`.
- The build itself, stopped 20 minutes before the job timeout so that its raw store is published
  even when it is killed.
- `actions/publish-index` saves the index and raw store to the cache under a run-scoped key and
  uploads them as artifacts with 30 day retention; it refuses an unusable index.
- After a successful publish, the test split of the consumer's eval cases runs against the new
  index, with the summary in the job summary and the run uploaded as the `eval-<slug>` artifact;
  then the feedback collection of the "Quality loop".
- `actions/report-index-status` writes the job summary and maintains the tracking issue, which
  reports `missing` until the first index is published.

**Incremental or full.** With a usable restored index, the build is incremental: it starts from a
copy of that index and asks each source only for what changed since the index was started (one hour
of overlap): issues through the API's `since`, pull requests, discussions, releases and forum
categories listed newest first until the first older item. Docs, code and files are re-read from
the checkouts every time, which takes seconds and is how a deleted page or file leaves the index. A
listed item that no longer qualifies (an issue reopened when only closed ones are indexed, a forum
topic that lost its tag) is removed. What the sources cannot report incrementally waits for the
full rebuild: a deleted or transferred issue, a reopened pull request, a topic or discussion moved
out of its category, a forum answer accepted without a new post, a forum topic that lost its
accepted answer under `solvedOnly`. The full rebuild happens when the last one is 7 or more days
old, when the config changed, when no usable index exists, or when the `full` input is set (the
android caller exposes it on `workflow_dispatch`).

### Append on close

`append-on-close.yml` upserts one item in place, so a resolution is searchable shortly after the
issue or pull request closes. Inputs: `slug`, `config` and `item` (`issue:<n>` or `pull:<n>`).

    name: Knowledge index append

    on: # yamllint disable-line rule:truthy
      issues:
        types: [closed]
      pull_request_target:
        types: [closed]

    permissions: {}

    jobs:
      append:
        uses: TimoPtr/auto-triage/.github/workflows/append-on-close.yml@<sha> # vX.Y.Z
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
code; it reads the API with the workflow token only.

### Triage

`.github/workflows/triage.md` is a gh-aw workflow (Copilot engine) that comments on a new issue
with the closest earlier reports, discussions and docs, and a short answer when it is confident.
Its compiled `triage.lock.yml` is committed here (the `lock` job of the test workflow recompiles
it with the gh-aw version named in its first line and fails on a difference; regenerate with
`gh aw compile triage`). Inputs: `config`, `issue-number`, `event-action` and `label`. A consumer
calls it from a thin workflow that owns the triggers:

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

    jobs:
      triage:
        # An issue created with a label fires opened and labeled at once; only ai-recheck starts a run.
        if: github.event_name != 'issues' || github.event.action != 'labeled' || github.event.label.name == 'ai-recheck'
        concurrency:
          group: knowledge-triage-${{ github.event.issue.number || inputs.issue-number }}
          cancel-in-progress: false
        uses: TimoPtr/auto-triage/.github/workflows/triage.lock.yml@<sha> # vX.Y.Z
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

Every permission a generated job asks for must be granted by the caller or GitHub refuses the call
at start-up (hence `pull-requests: read` for gh-aw's conclusion jobs, and no reaction on the
issue). The Copilot engine runs on the workflow token with `copilot-requests: write`; no secret is
added. A `labeled` event runs only for `ai-recheck`, which is removed again so it can be
re-applied; a manual run passes `dispatch`. The caller's `if` matters: a run that the called
workflow refused would still be created by the caller's trigger and wait in its concurrency group.
Who may trigger a run is the caller's choice of events; the template sets `roles: all` because
gh-aw otherwise activates only for actors with write access and an outsider's issue would stop
after pre-activation. Issues from anyone are triaged, so the issue text is treated as data
everywhere.

What happens, in three jobs:

1. **Pre-activation (no model).** Fetches the issue with `gh api` before anything is installed,
   checks out the consumer and this repository, restores the index and runs `prepare-triage` from
   the saved payload, so the step that loads the model and the rest of the dependencies holds no
   token. The body is cleaned like an indexed issue, embedded, and searched (dense + lexical, with
   fenced logs lifted into the lexical query + a live forum search on the cleaned text), excluding
   the issue itself when the index already holds it. The gate stops the run for pull requests, bot
   authors, empty issues, a missing or unusable index, and a best similarity under
   `triage.minSimilarity`. Otherwise it writes the handoff (`schemas/handoff.json`: the cleaned
   issue, up to ten excerpts with ids, source, url, date, audience, outcome and scores, and the
   confidence thresholds) and uploads it as the `triage-handoff` artifact. A stopped run spends no
   agent time and posts nothing. This job holds `issues: write` to remove the `ai-recheck` label;
   that is the one write scope outside the posting job, and no dependency code runs with its token
   (the index restore uses it for the read-only artifact fallback).
2. **Agent.** `claude-sonnet-5` on the Copilot engine, five turns, no network, no GitHub tools,
   `bash` limited to `cat`, `jq`, `head`, `wc` plus gh-aw's defaults (`ls`, `grep`, `sort`, `yq`
   and the like, and its file `write` tool on any path of the sandbox). It reads
   `/tmp/gh-aw/agent/handoff.json` and calls `post_triage_verdict` once with `confidence` (0 to
   100), `duplicates` and `related` (excerpt ids), an optional `answer` and `component`. It never
   sees the index; what it writes inside the sandbox reaches nothing downstream, since the post
   job reads the handoff artifact uploaded before the agent ran. gh-aw's diagnostic outputs
   (`report-missing-tool`, `report-missing-data`, `report-incomplete`), which would open issues
   with the agent's own text, are disabled: the verdict is the only output.
3. **post-triage-verdict (no model).** `render-verdict` validates the verdict against the handoff
   (unknown ids are dropped with a note, an unparsable confidence fails the job), picks the tier
   (`high` from `triage.confidence.answer`, `medium` from `triage.confidence.links`, `low` below)
   and renders the comment: a marker `<!-- knowledge-bot v<release> run=<id> tier=<tier>
   issue=<n> -->`, "Possibly related to earlier reports", "Discussions and docs", the answer on
   the high tier, and a feedback footer. Links come only from the handoff; titles are escaped and
   mentions removed; developer-audience excerpts appear only when the issue talks about building,
   maintainer-audience ones never (`component` goes to the run summary). A low tier posts
   nothing. The job minimizes earlier bot comments as outdated and posts the new one with `gh api`
   under its own `issues: write`; the `duplicate` label is never applied.

The pre-activation job writes the gate outcome to the job summary and the post-triage-verdict job
the tier, the verdict and the comment (or why none was posted), so a run that posts nothing is
still readable. One case is only in gh-aw's own agent summary: an agent that ends without calling
the tool, since gh-aw skips the custom job then.

A failed run is reported by gh-aw's conclusion job as an issue in the consumer repository (label
`agentic-workflows`, one per failure class and day, never auto-closed; the body is gh-aw's own
diagnostics, sanitized). Since anyone's issue reaches the model, the failure classes an issue
author can provoke with the issue text (the turn or time budget, a run without the verdict tool, a
denied tool, the per-run credit cap) are excluded and show only in the run summary; engine,
billing and configuration failures still open an issue. Decide who in the consumer watches that
label.

Cost: one model run per triaged issue, bounded by five turns and fifteen minutes; the gate keeps
pull requests, bot issues and low-similarity issues from reaching the model.

Two things about a called gh-aw workflow, learned on the first runs: its prompt must be embedded
in the lock (`inlined-imports: true`), since gh-aw otherwise reads the markdown from the caller's
workspace at run time; and `GH_AW_AGENT_OUTPUT` is read from the step's shell, not through `env.`
in the same step.

## Sizing and limits

**What a fill costs.** One listing request per 100 issues or pull requests, one comments request
per issue, one review-comments and one files request per pull request; discussions and closing
references go through GraphQL in batches; releases are listed in commit order, a handful of
requests. A `docs`, `code` or `files` provider reads a checkout and costs no request. A Discourse
category costs one listing request per 30 topics plus one request per kept topic. The android fill
is about 11 000 GitHub requests.

**What the limits are.** The Actions `GITHUB_TOKEN` has 1000 requests per hour on a personal
repository and 15 000 on one that belongs to a GitHub Enterprise Cloud account; a user token, for a
local build, has 5000. The client keeps up to four requests in flight (the comments of several
issues, the reviews and files of several pull requests) and paces their starts to the quota GitHub
announces in every response, so it follows whatever limit the token has without being configured:
about four requests per second on the enterprise quota, and a wait for the next window instead of a
refused request on a small one. The forum allows about 200 requests a minute per address
(Discourse's default, measured on community.home-assistant.io on 2026-11-04: a 429 from the 173rd
request of a burst at eight a second), so `requestsPerSecond` defaults to 3, a 429 is waited out,
and more concurrency would not help.

**What that means for a large consumer.** The GitHub fetch is bound by the token's quota: a
repository the size of `home-assistant/core` (about 100 000 requests for two years of history) is
about seven hours on the enterprise quota. The forum is bound by the category size:

| Category of community.home-assistant.io, 2026-11-04 | Topics | At 3 a second |
|---|---|---|
| `android-companion` | 1 853 | 10 min |
| `ios` | 2 217 | 12 min |
| `configuration` | 122 243 | 11 h |

`solvedOnly` makes the site list only topics with an accepted answer (about one in five in
`configuration`, so neither a listing page nor a topic request for the rest) and `closedWithinDays`
ends the listing at the first page outside the window; with both, the `configuration` category is
an hour or two. Docs are a few minutes of embedding for the whole home-assistant.io tree (about
1 600 pages, 12 MB of markdown). Embedding runs at about 24 chunks a second on a GitHub runner.

**The first fill converges over runs.** The build stops 20 minutes before the job timeout
(`timeout-minutes`, default 350) and the raw store is published even then, so each run keeps its
fetched payloads and, through the vector checkpoint, its embedded vectors; the next run resumes
instead of starting over. The android fill on a 1000 per hour token converges in two to three
nightly runs, core in about two on the enterprise quota. A manual `workflow_dispatch` between
nights speeds it up, or tighten the schedule for the fill; runs of one slug queue behind each
other. After that the nightly job is incremental and its cost follows the number of changed items,
not the size of the repository. A release that changes the embedding model, the chunk schema or
anything else in the config hash makes the next build start over, with the raw store and the
checkpoint to resume from.

**Measured on android.** On 2026-10-19, for the android config (every issue since 2019, every
closed pull request, three discussion categories, stable releases, two docs sites, the Kotlin
sources, two string files, the agent skills and the whole Android forum category), on an Apple M4
Pro with Node 26, a 1 Gbit/s connection and the vectors of a previous issues-and-docs index to
reuse, starting from a raw store that already held every issue and 2084 of the pull requests:

| Stage | Items | Wall time |
|---|---|---|
| GitHub sources (issues, pull requests, discussions, releases, docs, code, files) | 7367 | 24.6 min |
| Forum (Discourse, 4 requests per second, the default then) | 1847 | 9.7 min |
| Whole build, embedding included | 9214 items, 41440 chunks (18685 embedded, 22755 reused) | 34.3 min |

The resulting index is 91 MB and the raw store 43 MB (7974 records). On 2026-10-20 with the same
setup, a full raw store and the previous index to reuse:

| Build | What it read | Wall time |
|---|---|---|
| Full rebuild (`--full`, or every 7 days) | every listing, every checkout; 24 chunks embedded, 41 433 reused | 3 min 16 s |
| Incremental (the nightly default) | issues, pull requests, discussions, releases and forum topics changed since the previous build (none that morning), the checkouts in full; 0 chunks embedded, 6376 reused | 17 s |

### Raw store

With `--raw`, every fetched payload is kept verbatim (gzip JSON per item) in a second SQLite file
next to the index, gitignored like the index. It serves three purposes:

- A rebuild with the same store skips the comment, review and topic requests of items whose change
  marker (`updated_at`, `last_posted_at`) did not move.
- It holds the vector checkpoint of a full build: every batch of embedded chunks is written to its
  `vectors` table (keyed by chunk hash under the model that produced it) as the build runs, and a
  full build reads it for every chunk the previous index cannot supply. A finished build prunes the
  table to the chunks its index holds; the vectors of another model are dropped with it. The table
  is created on open, so an older store needs no migration.
- The benchmark mines its ground truth (duplicate links, close reasons, `fixes #N`, docs links in
  maintainer replies) from the original material rather than from cleaned chunks.

With `--offline`, the build replays the raw store instead of the network: issues, pull requests,
discussions, releases and forum topics come from the stored payloads, docs, code and files from the
checkouts as usual, and no token is needed. It is always a full build; `--previous` still reuses
the vectors of unchanged chunks. The benchmark's bake-off builds one index per candidate model this
way. Two things do not replay: an accepted forum answer that the stored topic neither carries (a
current discourse-solved sends it in the payload) nor has on its first page of posts, and the
GraphQL links the case mining fetches (those are stored by `mine-cases --github`, see "Benchmark").
On the android store, an offline rebuild with every vector reused takes 22 s.

## Local use

### Build and query an index

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

The first run downloads the embedding model into `.model-cache/`. Pass `--previous <older index>`
to reuse the vectors of unchanged chunks, `--full` to force a full build, `--offline` to replay the
raw store ("Raw store"). Add `--live-forum community.home-assistant.io/android-companion` to a
query to fuse a live forum search into the ranking, for topics newer than the index. The index is
a single SQLite file that `sqlite3` can open directly.

### Triage dry run

From `bot-scripts/` with a built index; the agent step is replaced by a hand-written verdict:

    GH_TOKEN=$(gh auth token) npm run -s prepare-triage -- --config ../../android/.github/knowledge-bot.yaml \
      --index knowledge-android.sqlite --index-status fresh --repo home-assistant/android --issue 7654 \
      --out eval-out/triage/handoff.json
    echo '{"items":[{"type":"post_triage_verdict","confidence":"80","duplicates":"4","related":"0,2","answer":"..."}]}' \
      > eval-out/triage/agent_output.json
    npm run -s render-verdict -- --config ../../android/.github/knowledge-bot.yaml --handoff eval-out/triage/handoff.json \
      --agent-output eval-out/triage/agent_output.json --out-dir eval-out/triage --run-id local
    cat eval-out/triage/comment.md

### Feedback dry run

From `bot-scripts/` with a raw store:

    npm run -s collect-feedback -- --config ../../android/.github/knowledge-bot.yaml \
      --raw knowledge-android.raw.sqlite --repo home-assistant/android --out eval-out/feedback
    cat eval-out/feedback/digest.md   # only once a bot comment exists

Add `--github` with `GH_TOKEN` to refresh the reactions, as the nightly step does.

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
issues, of the same repository, at or above `triage.suppressSimilarity`, the handoff marks a
demotion and `render-verdict` lowers the tier by one: high becomes medium, medium becomes low. The
run summary names the suppressed issue.

**Eval regression.** When the build evaluated the test split, it restores the previous nightly
`eval-<slug>` artifact (directory mode of `restore-artifact.sh`: default-branch runs only, plain
regular files only), runs `compare-eval` on the two `cases.jsonl` and `report-eval-status` writes
the paired delta of recall at 5 with its interval to the summary. A regression (drop above 5 points
with the interval excluding zero) opens or comments the tracking issue `Knowledge eval <slug>:
regression`; a clean comparison closes it. A build without a previous artifact or without eval
cases says so and stays green.

## Contributing

### Layout

- `bot-scripts/` TypeScript run natively by Node 26 (type stripping, no build step): providers,
  index writer, retrieval, CLIs. `npm ci --ignore-scripts --omit=dev` installs the runtime;
  `tsc --noEmit` is a dev-only check. Imports keep the `.ts` extension, and no syntax that needs
  transformation (enums, parameter properties, decorators) is used.
- `bot-scripts/src/triage/` the deterministic halves of the triage workflow: the gate and handoff
  builder, the verdict parser and the comment renderer.
- `bot-scripts/src/feedback/` the quality loop: reactions, replies and outcomes of the bot
  comments, the suppression list and the digest.
- `actions/` the composite actions the reusable workflows are made of.
- `.github/workflows/` the reusable workflows consumers call: `build-index.yml`,
  `append-on-close.yml`, `selfcheck.yml`, and the gh-aw workflow `triage.md` with its compiled
  `triage.lock.yml`; plus `test.yml` and the pipeline self-test `ci-pipeline.yml`.
- `schemas/` JSON Schema for the config, the eval cases, the handoff and the index metadata.
- `benchmarks/` the kept outputs of the benchmark runs, one dated directory each.
- `examples/selfcheck/` the config the pipeline self-test indexes this repository with.
- `docs/superpowers/plans/` implementation plans, one per phase.

### Development

    cd bot-scripts
    npm ci --ignore-scripts
    npm test          # tsc --noEmit on src (strict) and tests, then node --test

After a change to `triage.md`, recompile the lock with `gh aw compile triage`; the test workflow
fails on a lock that does not match. Renovate (`renovate.json`, the android presets) keeps the npm
packages and the action pins in the hand-written workflows and composite actions current;
`triage.lock.yml` and `.github/aw/` are excluded because `gh aw compile` owns their pins. An update
of the embedding stack carries a note in its pull request: check the eval on a rebuilt index first,
and announce the rebuild in the release notes.

### Releases

Releases are semver tags on `main`. During `0.x` a change to the config schema, the handoff or the
comment format bumps the minor version; anything else bumps the patch. Each bot comment starts
with a hidden marker naming the release that produced it (`<!-- knowledge-bot vX.Y.Z ... -->`),
read from `bot-scripts/package.json`, so the feedback digest can compare releases.

To cut one: the tests and the lock check are green on `main`, bump `version` in
`bot-scripts/package.json` in the last commit, then

    git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z   # tags are signed, so they must be annotated
    gh release create vX.Y.Z --generate-notes

Say in the notes when the release forces a full index rebuild: a new embedding model, a chunk
schema change, or anything that enters the config hash makes the next nightly build start over
("Sizing and limits"), and consumers with a large corpus should expect that run to take longer.
