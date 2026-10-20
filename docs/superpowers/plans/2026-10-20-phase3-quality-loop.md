# Knowledge bot phase 3: quality loop implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loop on the triage comments: collect reactions, replies and outcomes for every bot comment nightly, publish them as `feedback.json` with a digest issue, demote a new issue that resembles a suppressed one, and keep a tracking issue open while the nightly retrieval eval has regressed.

**Architecture:** `src/feedback/` reads the raw store (issues with their comments, the `links` records of the benchmark) and finds the bot's comments by their marker; outcomes are deterministic rules over the issue's later state. A nightly step of `build-index.yml` runs `collect-feedback`, refreshes reactions through the API (reactions do not bump an issue's `updated_at`), saves `feedback.json` to the Actions cache and an artifact, and `report-feedback` keeps one digest issue. The triage template restores that file in pre-activation; `prepareTriage` marks a demotion in the handoff when a retrieved excerpt is a suppressed issue above a similarity floor, and `render-verdict` lowers the tier. The eval regression check restores the previous `eval-<slug>` artifact (directory mode of `restore-artifact.sh`), runs `compare-eval`, and `report-eval-status` keeps a tracking issue like `report-index-status` does.

**Tech Stack:** TypeScript on Node 24, `node:sqlite`, GitHub REST through the phase 1 client, `gh` in composite actions, GitHub Actions cache and artifacts.

**Spec:** `/Users/timo/Documents/ha/android/docs/superpowers/specs/2026-10-15-knowledge-bot-design.md` sections 8 (feedback), 14 (observability), 15 phase 3, 13 (security). Plans 1a to 2 next to this file define the modules this plan extends.

## Global Constraints

- Node floor `>=24`, type stripping, imports keep `.ts`, `npm test` exits 0. No new runtime dependency. No network in unit tests; a fake `RawStore` (in-memory `Map`) and a fake client stand in; the shell script test puts a fake `gh` on `PATH`.
- Constants: `FEEDBACK_VERSION = 1`, `FEEDBACK_WINDOW_DAYS = 90` (reactions refreshed through the API for comments younger than this), `ANSWERED_WINDOW_DAYS = 7`, `REPLY_MAX_CHARS = 500`, `DIGEST_RECENT = 20`, `DEFAULT_SUPPRESS_SIMILARITY = 0.8` (config `triage.suppressSimilarity`, 0 to 1).
- Bot comments are recognised only by a body that starts with `MARKER_PREFIX` (`parseMarker` from `src/triage/render.ts`); a quoted copy in a reply starts with `>` and never counts. Suggested duplicates are parsed from the bot's own comment, from the `#n` bullets under the duplicates heading. Author roles come from the API association and the reporter login, never from text (as `src/providers/github/issues.ts`).
- Outcome rules (spec 8): `recheck` when a later bot comment exists on the issue; `duplicateOf` from `state_reason === 'duplicate'` or the `duplicate` label, with the numbers from the raw store's `links` record (`duplicateOf`) when present, else from maintainer comments after the bot comment matching the benchmark's `DUPLICATE_OF` pattern; `hit` when `duplicateOf` meets `suggested`; `miss` when the issue is a duplicate and no suggestion matches; `answered` when `closed_by` is the reporter within `ANSWERED_WINDOW_DAYS` of the comment and the reason is not duplicate; `dismissed` when `down > 0` or (`miss` and `suggested` non-empty). Suppressed issues are those with `down > 0` (`downvoted`) or `dismissed`.
- `feedback.json`: `{ version: 1, repository, generatedAt, comments: FeedbackComment[], suppressed: { issue, reason, at }[] }`. Never committed; saved to the cache under `<slug>-feedback-v1-<run id>-<attempt>` and restored by prefix; uploaded as the `feedback-<slug>` artifact, 30 days.
- Tracking issues follow `report-index-status`: label `knowledge-bot`, title prefix `Knowledge eval <slug>:` (open or comment on regression, close on a clean comparison) and `Knowledge bot <slug>: feedback digest` (body replaced with `gh issue edit --body-file`, created only once a bot comment exists, never closed). Issue bodies are built from numbers and the bot's own data; reply text goes into `feedback.json`, not into issues.
- Workflow steps: inputs reach `run:` through `env:`; `compare-eval`'s exit code 3 never fails the build; the regression check and the feedback step run only after a successful publish; a consumer without eval cases or without bot comments gets a log line, not a failure. Actions pinned by SHA with version comments.
- Files under about 300 lines, functions under 50. YAML files here start with `---`; android files follow android's `.yamllint`. Commits on `main` in `auto-triage`; android is only edited (template copy and lock, config, spec).

## Review Focus

1. A corrupt, truncated or older-version `feedback.json` restored from the cache must not stop a triage run; it is logged and ignored (Task 4 test `ignores an unreadable or older feedback file`).
2. A reply that quotes the bot's comment, or a user comment that pastes a marker in the middle of its text, must never be read as a bot comment or as suggestions (Task 1 test `recognises bot comments only by a leading marker`).
3. A restored eval artifact that holds a symlink, a subdirectory or an entry escaping the destination must be discarded whole, never partially extracted (Task 5 test `discards an artifact with a symlink, a directory or an escaping entry`).
4. The nightly build must stay green when there is no previous eval artifact, no eval cases, or no bot comment yet; the digest issue is not created for an empty feedback (Task 3 test `writes an empty feedback without a digest when no bot comment exists`, Task 5 workflow steps).
5. A demotion must apply only to a suppressed issue of the same repository above the floor, never to an issue of another origin that happens to share a number (Task 4 test `demotes one tier when a suppressed issue of the repository is retrieved above the floor`).

---

### Task 1: Feedback collection from the raw store

**Files:**
- Create: `bot-scripts/src/feedback/collect.ts`
- Test: `bot-scripts/test/feedback/collect.test.ts`, helper `bot-scripts/test/feedback/fake-raw.ts`

**Interfaces:**
- Consumes: `RawStore`, `RawRecord` (`src/store/raw.ts`), `StoredIssue`, `ApiIssue`, `ApiComment` (`src/providers/github/issues.ts`, `ApiComment` gains `id?: number; reactions?: Record<string, number>` and `ApiIssue` gains `closed_by?: ApiUser | null`), `StoredLinks`, `linksOf` (`src/eval/github-links.ts`), `parseMarker`, `MARKER_PREFIX` (`src/triage/render.ts`), `DUPLICATE_OF` (export it from `src/eval/mine.ts`).
- Produces:

```ts
export const FEEDBACK_VERSION = 1; export const ANSWERED_WINDOW_DAYS = 7; export const REPLY_MAX_CHARS = 500;
export type ReplyRole = 'reporter' | 'maintainer' | 'user';
export interface FeedbackOutcome { recheck: boolean; closedAt: string | null; stateReason: string | null; duplicateOf: number[]; hit: boolean; miss: boolean; answered: boolean; dismissed: boolean }
export interface FeedbackComment { issue: number; runId: string; tier: string; commentId: number | null; commentAt: string; suggested: number[]; up: number; down: number; reply: { role: ReplyRole; at: string; text: string } | null; outcome: FeedbackOutcome }
export interface Suppressed { issue: number; reason: 'downvoted' | 'dismissed'; at: string }
export interface Feedback { version: 1; repository: string; generatedAt: string; comments: FeedbackComment[]; suppressed: Suppressed[] }
export function parseSuggested(body: string): number[]
export function collectFeedback({ raw, repository, now }: { raw: RawStore; repository: string; now?: Date }): Feedback
export function suppressedOf(comments: FeedbackComment[]): Suppressed[]
```

`collectFeedback` iterates `raw.each<StoredIssue>('github', repository, 'issue')`, keeps comments whose body `startsWith(MARKER_PREFIX)` and parse, sorted by `created_at`; `reply` is the first later comment by a non-bot login (not ending in `[bot]`) cut to `REPLY_MAX_CHARS`; `comments` sorted by `commentAt` descending; `suppressed` from `suppressedOf`, one entry per issue (latest comment wins).

- [ ] **Step 1: Write the failing tests**

`fake-raw.ts` exports `fakeRaw(records: RawRecord[]): RawStore` (Map keyed by `provider/origin/kind/id`). Fixtures: issue 10 with a bot comment (marker run 1, tier high, suggested `#5`, `#7`; reactions `+1: 2`, `-1: 0`), a reply by a maintainer (`author_association: MEMBER`), then closed with `state_reason: 'duplicate'` and a `links` record `{ version: 2, kind: 'issue', duplicateOf: [7], ... }`; issue 11 with a bot comment downvoted (`-1: 1`) and closed by the reporter two days later as `completed`; issue 12 with two bot comments (run 2 then run 3); issue 13 whose only comment is a user reply quoting the marker after `> `; issue 14 closed as duplicate of #99 with suggestions `#5` and no links record but a maintainer comment "Duplicate of #99".

```ts
test('parses the suggested duplicates from the bot comment', () => {
  assert.deepEqual(parseSuggested('<!-- knowledge-bot v1 run=1 tier=high issue=10 -->\n\n**Possibly related to earlier reports**\n- #5 One (closed, Jan 2025)\n- #7 Two\n\n**Discussions and docs**\n- #8 Not a duplicate\n'), [5, 7]);
  assert.deepEqual(parseSuggested('no sections'), []);
});
test('collects reactions, the reply and a duplicate hit', () => {
  const f = collectFeedback({ raw, repository: 'o/r', now });
  const c = f.comments.find((x) => x.issue === 10);
  assert.deepEqual({ up: c.up, down: c.down, suggested: c.suggested, tier: c.tier, runId: c.runId }, { up: 2, down: 0, suggested: [5, 7], tier: 'high', runId: '1' });
  assert.equal(c.reply.role, 'maintainer');
  assert.deepEqual(c.outcome, { recheck: false, closedAt: '2026-10-12T00:00:00Z', stateReason: 'duplicate', duplicateOf: [7], hit: true, miss: false, answered: false, dismissed: false });
});
test('marks a downvoted comment and a reporter close as answered and suppresses it', () => { ... issue 11: down 1, answered true, dismissed true; suppressed contains { issue: 11, reason: 'downvoted' } ... });
test('marks a recheck and a miss from a maintainer duplicate comment', () => { ... issue 12: first comment recheck true, second false; issue 14: duplicateOf [99], miss true, dismissed true, hit false ... });
test('recognises bot comments only by a leading marker', () => { ... issue 13 yields no FeedbackComment; a bot comment body with the marker preceded by text is ignored ... });
```

- [ ] **Step 2: Run to verify they fail** — Run: `cd bot-scripts && node --test test/feedback/collect.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `collect.ts`**, export `DUPLICATE_OF` from `mine.ts`, extend the two API interfaces.
- [ ] **Step 4: Run the tests and the suite** — Run: `cd bot-scripts && npm test 2>&1 | tail -4`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add bot-scripts/src/feedback/collect.ts bot-scripts/src/eval/mine.ts bot-scripts/src/providers/github/issues.ts bot-scripts/test/feedback/
git commit -m "Collect reactions, replies and outcomes of the bot comments"
```

### Task 2: Reaction refresh and digest

**Files:**
- Create: `bot-scripts/src/feedback/refresh.ts`, `bot-scripts/src/feedback/digest.ts`
- Test: `bot-scripts/test/feedback/refresh.test.ts`, `bot-scripts/test/feedback/digest.test.ts`

**Interfaces:**
- Consumes: `Feedback`, `FeedbackComment` (Task 1), `GitHubClient.getJson`.
- Produces: `export const FEEDBACK_WINDOW_DAYS = 90; export async function refreshReactions(client: Pick<GitHubClient, 'getJson'>, feedback: Feedback, { now, windowDays, log }): Promise<{ refreshed: number }>` reading `repos/<repository>/issues/comments/<commentId>` for every comment with a `commentId` younger than the window, replacing `up`/`down` and recomputing `dismissed` and `suppressed` (reuse `suppressedOf`); a 404 is logged and skipped, any other error propagates. `export const DIGEST_RECENT = 20; export function digestMarkdown(feedback: Feedback): string` with totals per tier, reactions, outcome counts (hit, miss, answered, dismissed, recheck), suppressed count, and a table of the `DIGEST_RECENT` newest comments (issue as `#n`, tier, 👍/👎, outcome word, reply role or none); no reply text, no titles.

- [ ] **Step 1: Write the failing tests**

```ts
test('refreshes reactions of recent comments and recomputes the suppression', async () => { ... fake client returns { reactions: { '+1': 0, '-1': 3 } } for comment 501 only; the comment older than the window keeps its counts; feedback.suppressed gains the issue ... });
test('skips a deleted comment and propagates other errors', async () => { ... 404 Error('GitHub 404 ...') → skipped; Error('GitHub 500') → rejects ... });
test('renders the digest with totals and the recent table', () => { ... matches /\| #10 \| high \| 2 \/ 0 \| hit \| maintainer \|/ and /suppressed: 1/ ... });
```

- [ ] **Step 2: Run to verify they fail** — Run: `cd bot-scripts && node --test test/feedback/refresh.test.ts test/feedback/digest.test.ts`. Expected: FAIL, modules not found.
- [ ] **Step 3: Implement both modules**
- [ ] **Step 4: Run the tests and the suite** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Refresh reactions through the API and render the feedback digest"`

### Task 3: `collect-feedback` CLI, digest action and the nightly step

**Files:**
- Create: `bot-scripts/src/cli/collect-feedback.ts`, `actions/report-feedback/action.yml`
- Modify: `bot-scripts/package.json` (script `collect-feedback`), `.github/workflows/build-index.yml`
- Test: `bot-scripts/test/cli/collect-feedback.test.ts`

**Interfaces:**
- Consumes: `collectFeedback`, `refreshReactions`, `digestMarkdown`, `openRawStore`, `createGitHubClient`, `writeOutputs`, `appendSummary`.
- Produces: CLI `collect-feedback --config <yaml> --raw <raw.sqlite> --repo <owner/repo> --out <dir> [--github] [--window-days 90]`; writes `<out>/feedback.json` and `<out>/digest.md` (the digest only when `comments.length > 0`); `--github` refreshes reactions with `GH_TOKEN`/`GITHUB_TOKEN`; prints `{ comments, suppressed, refreshed }`; `writeOutputs({ comments, suppressed, digest: 'true'|'false' })`; summary line. A missing raw store exits 0 with `no raw store, no feedback`. Action `report-feedback` (inputs `slug`, `digest-path`, `comments`): appends a summary line, and when `comments > 0` creates or edits the digest issue (`gh issue edit --body-file`), needs `GH_TOKEN` with issues write.

`build-index.yml`, after the eval upload and before the failure publish: step `feedback` (`if: success() && hashFiles(raw) != ''`), `GITHUB_TOKEN` in env, `--github`; `actions/cache/save` of `.knowledge-bot/feedback/feedback.json` under `${{ inputs.slug }}-feedback-v1-${{ github.run_id }}-${{ github.run_attempt }}`; `upload-artifact` `feedback-${{ inputs.slug }}` 30 days; `report-feedback` with `tracking` gating as for the status issue (`if: inputs.tracking`).

- [ ] **Step 1: Write the failing test** — build a temp raw store with `openRawStore` holding the Task 1 fixtures (issue 10 and an issue without bot comment); run the CLI without `--github`: `feedback.json` has one comment, `digest.md` exists, outputs `comments=1`. Second test `writes an empty feedback without a digest when no bot comment exists`: a raw store with only plain issues → `feedback.json` with `comments: []`, no `digest.md`, outputs `digest=false`, exit 0. Third: missing raw store path → exit 0, message.
- [ ] **Step 2: Run to verify it fails** — Expected: FAIL, the CLI does not exist.
- [ ] **Step 3: Implement the CLI, the action, the workflow steps.** Run `yamllint .github/workflows/build-index.yml actions/report-feedback/action.yml`. Expected: silent.
- [ ] **Step 4: Run the tests and the suite** — Expected: PASS.
- [ ] **Step 5: Run it against the android raw store** — `cd bot-scripts && npm run -s collect-feedback -- --config /Users/timo/Documents/ha/android/.github/knowledge-bot.yaml --raw knowledge-android.raw.sqlite --repo home-assistant/android --out eval-out/feedback`. Expected: `comments: 0` (no bot comment exists yet), `feedback.json` written, no digest, exit 0; record the wall time.
- [ ] **Step 6: Commit** — `git commit -m "Add the nightly feedback collection with its digest issue"`

### Task 4: Suppression in triage

**Files:**
- Modify: `schemas/config.base.json`, `bot-scripts/src/config/types.ts`, `bot-scripts/src/triage/settings.ts` (`suppressSimilarity`), `schemas/handoff.json` and `bot-scripts/src/triage/handoff.ts` (`retrieval.demote: { issue: number; similarity: number } | null`), `bot-scripts/src/triage/prepare.ts`, `bot-scripts/src/cli/prepare-triage.ts` (`--feedback <file>`), `bot-scripts/src/triage/verdict.ts` (`demote(tier)`), `bot-scripts/src/cli/render-verdict.ts`, `workflows/triage.md`
- Create: `bot-scripts/src/feedback/read.ts`
- Test: `bot-scripts/test/triage/settings.test.ts`, `bot-scripts/test/triage/prepare.test.ts`, `bot-scripts/test/triage/verdict.test.ts`, `bot-scripts/test/cli/render-verdict.test.ts`, `bot-scripts/test/feedback/read.test.ts`

**Interfaces:**
- Produces: `TriageSettings.suppressSimilarity: number` (default `DEFAULT_SUPPRESS_SIMILARITY = 0.8`); `export function readFeedback(path: string, log): Set<number>` in `read.ts` returning the suppressed issue numbers, or an empty set with a log line when the file is missing, unparsable or not `version === 1`; `PrepareInput.suppressed?: Set<number>`; `Handoff.retrieval.demote` set when an excerpt with `source === 'issue'`, `origin === repository` and number in `suppressed` has `scores.similarity >= settings.suppressSimilarity` (the first such excerpt by rank); `export function demote(tier: Tier): Tier` (`high → medium`, `medium → low`, `low → low`); `render-verdict` applies it when `handoff.retrieval.demote` is set, records `demoted: true` and the issue in `verdict.json`, writes a summary note. Template: `actions/cache/restore` of `.knowledge-bot/feedback/feedback.json` (the path the nightly build saves) with key `${{ steps.config.outputs.slug }}-feedback-v1-${{ github.run_id }}` and restore-keys prefix `<slug>-feedback-v1-`, before `prepare`; `prepare-triage` gets `--feedback .knowledge-bot/feedback/feedback.json` (the CLI tolerates its absence).

- [ ] **Step 1: Write the failing tests**

```ts
// settings: default 0.8; configured 0.9; rejects 1.5 through the schema
// read.test: 'ignores an unreadable or older feedback file' (missing, garbage, version 2 → empty set + log line); reads suppressed numbers
// prepare.test: 'demotes one tier when a suppressed issue of the repository is retrieved above the floor': suppressed {1} with the widget issue → handoff.retrieval.demote = { issue: 1, similarity: ≥0.9 }; suppressed {1} with repository 'other/repo' → null; suppressed {999} → null
// verdict.test: demote('high') === 'medium', demote('medium') === 'low', demote('low') === 'low'
// render-verdict.test: a handoff with demote and confidence 80 → tier=medium, verdict.json.demoted === true, summary mentions the suppressed issue
```

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL on the missing exports and schema keys.
- [ ] **Step 3: Implement**, then re-compile the template in a scratch consumer (`gh aw compile`). Expected: `1 succeeded, 0 warnings`.
- [ ] **Step 4: Run the suite** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Demote a triage verdict near a suppressed issue"`

### Task 5: Eval regression tracking

**Files:**
- Modify: `actions/restore-index/restore-artifact.sh` (directory mode), `.github/workflows/build-index.yml`
- Create: `actions/report-eval-status/action.yml`, `bot-scripts/test/actions/restore-artifact.test.ts`, fake `gh` at `bot-scripts/test/fixtures/bin/gh` (bash)

**Interfaces:**
- `restore-artifact.sh NAME DEST [dir]`: with the third argument `dir`, DEST is a directory; the extracted tree must contain only regular files directly under the root (no symlink, no subdirectory, no name starting with `.` or containing `/`), moved into DEST; anything else discards the whole artifact with the existing message and prints `0`. The single-file mode is unchanged.
- `build-index.yml`, after the eval step and before the eval upload: `previous-eval` (`if: success() && hashFiles('.knowledge-bot/eval/summary.json') != ''`, runs the script with `eval-<slug> .knowledge-bot/eval-previous dir`), `compare` (`if` the id is not `0`, runs `compare-eval previous/cases.jsonl current/cases.jsonl --json > .knowledge-bot/eval/comparison.json || status=$?`, exit 3 recorded as `regression=true`, any other non-zero fails), `report-eval-status` (inputs `slug`, `comparison-path`, `tracking`): summary line with the paired count, the delta and the interval; on regression create or comment the tracking issue `Knowledge eval <slug>:`; otherwise close an open one.
- The fake `gh` answers `api repos/<repo>` (`"1 main"`), `api repos/<repo>/actions/artifacts?...` with a JSON list from `FAKE_ARTIFACTS` env, and `api .../artifacts/<id>/zip` by copying the file named in `FAKE_ZIP`; the test builds zips with `zip` from the system (skip the test with a message when `zip` is absent).

- [ ] **Step 1: Write the failing tests**

```ts
test('restores a directory artifact of regular files', ...);            // two files → both present, prints the id
test('discards an artifact with a symlink, a directory or an escaping entry', ...);  // each case prints 0 and DEST stays empty
test('keeps the single-file mode', ...);                                  // existing behaviour: one file named like DEST
```

- [ ] **Step 2: Run to verify they fail** — Expected: the directory cases fail (the script treats DEST as a file).
- [ ] **Step 3: Implement the script mode, the action and the workflow steps.** `yamllint` on both. Expected: silent.
- [ ] **Step 4: Run the suite** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Track eval regressions against the previous nightly run"`

### Task 6: Documentation, android install and spec

**Files:**
- Modify: `README.md` (section "Quality loop" after "Triage workflow": feedback collection, the digest issue, suppression and its floor, the eval tracking issue, the artifacts and cache keys, what a consumer gets without changes since it calls `build-index.yml@main`), the android spec (sections 8, 14, 16: rules as implemented, `triage.suppressSimilarity`, decided 2026-10-20), the android template copy and lock (`cp` + `gh aw compile knowledge-triage`, revert the side effects of the compile on other files), the android config (`suppressSimilarity: 0.8` under `triage`, with a comment that it is a tuning item).

- [ ] **Step 1: Write the README section and the spec edits.**
- [ ] **Step 2: Re-install the template in android** — Expected: compile `1 succeeded`; `git status` in android shows only the knowledge-bot files.
- [ ] **Step 3: Final suite** — `cd bot-scripts && npm test 2>&1 | tail -3`. Expected: green.
- [ ] **Step 4: Commit** — `git commit -m "Document the quality loop"` (auto-triage only).
