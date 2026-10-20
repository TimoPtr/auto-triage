# Android benchmark, 2026-10-20

The first benchmark run of the android consumer, kept so later runs have a baseline to pair
against. Index of 2026-10-20 (bge-small-en-v1.5 q8, 9214 items, 41 440 chunks); cases mined the
same day (1925: 324 docs, 259 duplicate, 743 fixed-by, 8 forum, 591 negatives, see
`mining-report.json`), after the hand check of 30 labels and the three rule fixes it led to. The
harness ages candidates as of each case's own date. The headline numbers are in the main README
under "Benchmark".

- `runs/<name>/summary.json`, `summary.md`, `errors.jsonl`: every run of the day. `production-*`
  are the production index on the test and validation splits; `oracle-all` and `null-all` are the
  bounds; `validation-<model>` and `test-<model>` are the bake-off indexes.
- `runs/<name>/cases.jsonl`: the per-case ranked lists, kept for the four runs a comparison needs
  (production test and validation, arctic-embed-s test and validation). Pair a new run against one
  with `npm run compare-eval -- benchmarks/android/2026-10-20/runs/production-test/cases.jsonl <new>/cases.jsonl`
  from `bot-scripts`.
- `bake-off.md`, `bake-off.json`: the five-model bake-off on the validation split (build times are
  from a MacBook CPU; the recall columns predate the age-decay fix, the corrected per-model numbers
  are the `validation-<model>` runs).

Add a new dated directory for the next run rather than overwriting this one.
