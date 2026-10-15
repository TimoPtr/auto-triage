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
