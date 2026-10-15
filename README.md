# auto-triage

Shared code for the Home Assistant knowledge bot: index builders, retrieval, actions and
agentic workflow templates. Consumer repositories hold a `.github/knowledge-bot.yaml` and thin
callers. Design: the knowledge bot spec in `home-assistant/android`,
`docs/superpowers/specs/2026-10-15-knowledge-bot-design.md`.

## Layout

- `bot-scripts/` Node 24 scripts: providers, index writer, retrieval, CLIs. `npm ci --ignore-scripts`.
- `schemas/` JSON Schema for the config and the index metadata.
- `docs/superpowers/plans/` implementation plans, one per phase.

## Development

    cd bot-scripts
    npm ci --ignore-scripts
    npm test

## Build and query an index locally

The consumer config (here the android one) names the sources. Docs repositories are read from
local checkouts passed with `--checkout`; issues are read through the GitHub API with `GITHUB_TOKEN`.

    cd bot-scripts
    GITHUB_TOKEN=$(gh auth token) npm run build-index -- \
      --config ../../android/.github/knowledge-bot.yaml \
      --out ./knowledge-android.sqlite \
      --checkout home-assistant/companion.home-assistant=../../companion.home-assistant \
      --checkout home-assistant/contributors.home-assistant.io=../../contributors.home-assistant.io

    npm run query -- --config ../../android/.github/knowledge-bot.yaml \
      --index ./knowledge-android.sqlite "widget stops updating after reboot"

The first run downloads the embedding model (about 35 MB) into `.model-cache/`.
Pass `--previous <older index>` to reuse the vectors of unchanged chunks. The index is a single
SQLite file (FTS5 plus sqlite-vec) that `sqlite3` can open directly.
