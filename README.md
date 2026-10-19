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

The Actions `GITHUB_TOKEN` only has 1000 requests per hour, so the first fill of a large consumer
converges over a few nightly runs (see "Run it in GitHub Actions"); after that the nightly job stays
incremental.

### Raw store

With `--raw`, every fetched payload is kept verbatim (gzip JSON per item) in a second SQLite file
next to the index. It is gitignored like the index. It serves two purposes: the benchmark mines its
ground truth (duplicate links, close reasons, `fixes #N`, docs links in maintainer replies) from the
original material rather than from cleaned chunks, and a rebuild with the same store skips the
comment, review and topic requests of items whose change marker (`updated_at`, `last_posted_at`)
did not move.

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

Append on close, so a resolution is searchable minutes after the issue or pull request closes:

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
- `actions/report-index-status` writes the job summary and maintains the tracking issue.
- `build-index.yml` ties them together with a full rebuild (`--previous` reuses the vectors of
  unchanged chunks); `append-on-close.yml` upserts one item in place; `selfcheck.yml` validates a
  config, for pull requests that touch it.

First fill of a large repository: the android fill is about 11 000 API requests and the workflow
token allows 1000 per hour, so the first nightly runs stop on the rate limit before the index is
written. Each run keeps its raw store (the build is stopped 20 minutes before the job timeout and
the raw store is published even when the build failed), and the next run continues from it, so the
fill converges in two to three runs. A manual `workflow_dispatch` run between nights speeds it up,
and a locally built index uploaded once is the shortcut (`gh run download` and the artifact names
above). The tracking issue reports `missing` until the first index is published.

The pipeline self-test (`ci-pipeline.yml`) runs on every push to `main` and every pull request: it
validates `examples/selfcheck/knowledge-bot.yaml`, builds an index of this repository's own issues
and docs through the reusable workflow, restores it in a second job and runs one query.
