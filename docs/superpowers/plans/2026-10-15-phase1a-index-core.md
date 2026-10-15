# Knowledge bot phase 1a: index core implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, from a YAML config, a SQLite knowledge index over the companion docs, the contributor docs and the android issues, and query it with hybrid retrieval from the command line.

**Architecture:** Plain ESM JavaScript in `bot-scripts/`, no build step. Providers turn a config section into a stream of items with chunks; the index writer embeds new chunks with a local ONNX model and writes one SQLite file with FTS5 and sqlite-vec; retrieval fuses a vector KNN and an FTS5 query with reciprocal rank fusion. Two CLIs, `build` and `query`, wrap it.

**Tech Stack:** Node 24, `node:sqlite` + `sqlite-vec` 0.1.9, `@huggingface/transformers` 4.x (ONNX runtime, model `Xenova/bge-small-en-v1.5` q8), `yaml` 2.x, `ajv` 8.x, `node:test`.

**Spec:** `/Users/timo/Documents/ha/android/docs/superpowers/specs/2026-10-15-knowledge-bot-design.md` (sections 3.1, 4, 5, 6, 11). Phase 1 is split into four plans; this is the first. Later plans: 1b the remaining providers (pulls, discussions, code, files, discourse), 1c the CI actions and workflows, 1d case mining, the eval harness and the model bake-off.

## Global Constraints

- Node floor `>=24`; `node:sqlite` is the driver, `better-sqlite3` only if the Task 2 smoke test fails on Node 24 in CI.
- Dependencies limited to `sqlite-vec` (pinned `0.1.9`), `@huggingface/transformers`, `yaml`, `ajv`. Everything else is Node built-ins. Model license must be Apache-2.0 or MIT.
- `bot-scripts` installs with `npm ci --ignore-scripts` from a committed lockfile.
- Config is YAML keyed by provider, validated strictly: unknown or missing keys fail the job with the key path in the message.
- The index is one SQLite file; vectors are int8; integers bound to vec0 statements are BigInt (`node:sqlite` binds JavaScript numbers as REAL).
- No network in tests. Every network call goes through an injectable `fetchImpl`; the embedding pipeline is injectable.
- The index is never committed to git. `knowledge*.sqlite` is in `.gitignore`.
- Commits are made by Timo. A task's final step hands the staged diff over; the executor never runs `git commit` or `git add`.
- All code, comments and messages in English. Files stay under about 300 lines; functions under 50.

## Review Focus

1. An issue body consisting only of template labels and an empty log fence yields an empty text chunk; the writer must skip empty chunks instead of embedding an empty string (Task 10 test `skips chunks with empty text`).
2. A GitHub list page that returns a pull request in the issues endpoint must be dropped, not indexed as an issue (Task 8 test `drops pull requests`).
3. A docs file whose front matter has a `slug` starting with `/` must override the directory path entirely (Task 9 test `absolute slug overrides path`).
4. A previous index built with another model key must not have its vectors reused (Task 10 test `does not reuse vectors from another model`).
5. A question with only stopwords or punctuation must not raise an FTS5 syntax error; the lexical side returns nothing and the dense side still runs (Task 12 test `question without indexable tokens`).

---

### Task 1: Repository scaffold

**Files:**
- Create: `bot-scripts/package.json`
- Create: `bot-scripts/.gitignore`
- Create: `.node-version`
- Create: `README.md`
- Create: `.github/workflows/test.yml`
- Create: `bot-scripts/test/smoke.test.js`

**Interfaces:**
- Produces: the `npm test` command (`node --test`), the dependency set every later task imports.

- [ ] **Step 1: Write the failing smoke test**

`bot-scripts/test/smoke.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('node version is 24 or newer', () => {
  const major = Number(process.versions.node.split('.')[0]);
  assert.ok(major >= 24, `expected Node >= 24, got ${process.versions.node}`);
});
```

- [ ] **Step 2: Run it to verify it fails for the right reason**

Run: `cd bot-scripts && node --test`
Expected: FAIL with `ENOENT` or "no test files" because `package.json` does not exist yet, or PASS if Node already satisfies the floor. Either way the next step creates the project.

- [ ] **Step 3: Create the project files**

`bot-scripts/package.json`:

```json
{
  "name": "@home-assistant/auto-triage-scripts",
  "private": true,
  "type": "module",
  "description": "Knowledge index builder and retrieval for the Home Assistant triage bot. Installed with npm ci --ignore-scripts by the composite actions.",
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "node --test",
    "build-index": "node src/cli/build.js",
    "query": "node src/cli/query.js"
  },
  "dependencies": {
    "@huggingface/transformers": "^4.2.0",
    "ajv": "^8.17.1",
    "sqlite-vec": "0.1.9",
    "yaml": "^2.8.0"
  }
}
```

`bot-scripts/.gitignore`:

```
node_modules/
knowledge*.sqlite
knowledge*.sqlite.tmp
.model-cache/
```

`.node-version`:

```
24
```

`README.md`:

```markdown
# auto-triage

Shared code for the Home Assistant knowledge bot: index builders, retrieval, actions and
agentic workflow templates. Consumer repositories hold a `.github/knowledge-bot.yaml` and thin
callers. Design: the knowledge bot spec in `home-assistant/android`,
`docs/superpowers/specs/2026-10-15-knowledge-bot-design.md`.

## Layout

- `bot-scripts/` Node 24 scripts: providers, index writer, retrieval, CLIs. `npm ci --ignore-scripts`.
- `schemas/` JSON Schema for the config and the index metadata.

## Development

    cd bot-scripts
    npm ci --ignore-scripts
    npm test
```

`.github/workflows/test.yml`:

```yaml
name: Test

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: actions/setup-node@v6
        with:
          node-version-file: .node-version
          cache: npm
          cache-dependency-path: bot-scripts/package-lock.json
      - run: npm ci --ignore-scripts
        working-directory: bot-scripts
      - run: npm test
        working-directory: bot-scripts
```

- [ ] **Step 4: Install and run the test**

Run: `cd bot-scripts && npm install --ignore-scripts && node --test`
Expected: PASS, and `package-lock.json` is created. Check that `node_modules/sqlite-vec/` contains a `.dylib`/`.so` for the platform (`node -p "require('sqlite-vec').getLoadablePath()"` prints a path).

- [ ] **Step 5: Hand over for commit**

Files to stage: `bot-scripts/package.json`, `bot-scripts/package-lock.json`, `bot-scripts/.gitignore`, `bot-scripts/test/smoke.test.js`, `.node-version`, `README.md`, `.github/workflows/test.yml`. Suggested message: `Scaffold bot-scripts with Node 24 test workflow`.

---

### Task 2: SQLite store with FTS5 and sqlite-vec

**Files:**
- Create: `bot-scripts/src/store/schema.sql`
- Create: `bot-scripts/src/store/db.js`
- Create: `bot-scripts/src/store/vectors.js`
- Test: `bot-scripts/test/store/db.test.js`
- Test: `bot-scripts/test/store/vectors.test.js`

**Interfaces:**
- Produces:
  - `openDatabase(path, { readOnly = false } = {}) => DatabaseSync` with `sqlite-vec` loaded and extension loading disabled again.
  - `createSchema(db, { dimensions }) => void` applies `schema.sql` with the `vec_chunks` dimension substituted.
  - `SCHEMA_VERSION = 1`, `FORMAT_VERSION = 1` constants.
  - `quantizeInt8(Float32Array | number[]) => Int8Array` for unit vectors, `toBlob(Int8Array) => Buffer`, `fromBlob(Buffer) => Int8Array`, `cosineFromL2(distance, dimensionsScale = 127) => number`.

- [ ] **Step 1: Write the failing store test**

`bot-scripts/test/store/db.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, createSchema, SCHEMA_VERSION } from '../../src/store/db.js';
import { toBlob } from '../../src/store/vectors.js';

const tmp = mkdtempSync(join(tmpdir(), 'kb-db-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

test('creates the schema, stores chunks, vectors and FTS rows, then reads them back read-only', () => {
  const path = join(tmp, 'knowledge.sqlite');
  const db = openDatabase(path);
  createSchema(db, { dimensions: 4 });

  db.prepare(`INSERT INTO items (id, source, provider, origin, source_id, url, title, audience, created_at)
              VALUES (1, 'issue', 'github', 'o/r', '1', 'https://x/1', 'Widget stops', 'user', '2025-01-01T00:00:00Z')`).run();
  db.prepare(`INSERT INTO chunks (id, item_id, seq, kind, text, created_at, hash)
              VALUES (1, 1, 0, 'body', 'binary_sensor.motion_detected stops updating after reboot', '2025-01-01T00:00:00Z', 'h1')`).run();
  db.prepare(`INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, vec_int8(?))`)
    .run(1n, toBlob(Int8Array.from([127, 0, 0, 0])));
  db.exec(`INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')`);
  db.close();

  const ro = openDatabase(path, { readOnly: true });
  const fts = ro.prepare(`SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?`).all('"binary_sensor.motion_detected"');
  assert.deepEqual(fts.map((r) => r.rowid), [1]);

  const knn = ro.prepare(`SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH vec_int8(?) AND k = ?`)
    .all(toBlob(Int8Array.from([120, 10, 0, 0])), 1n);
  assert.equal(knn[0].chunk_id, 1);

  assert.equal(ro.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get().value, String(SCHEMA_VERSION));
  assert.throws(() => ro.exec(`INSERT INTO meta VALUES ('x', 'y')`), /readonly/);
  ro.close();
});
```

`bot-scripts/test/store/vectors.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quantizeInt8, toBlob, fromBlob, cosineFromL2 } from '../../src/store/vectors.js';

test('quantizeInt8 maps a unit vector to the int8 range and clamps', () => {
  const q = quantizeInt8(Float32Array.from([1, -1, 0.5, 0]));
  assert.deepEqual(Array.from(q), [127, -127, 64, 0]);
  assert.deepEqual(Array.from(quantizeInt8([1.2])), [127]);
});

test('toBlob and fromBlob round-trip', () => {
  const q = Int8Array.from([3, -3, 127, -127]);
  assert.deepEqual(Array.from(fromBlob(toBlob(q))), Array.from(q));
});

test('cosineFromL2 converts the distance between scaled unit vectors', () => {
  assert.ok(Math.abs(cosineFromL2(0) - 1) < 1e-9);
  // orthogonal unit vectors scaled by 127: L2 = 127 * sqrt(2)
  assert.ok(Math.abs(cosineFromL2(127 * Math.SQRT2) - 0) < 1e-6);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot-scripts && node --test test/store/`
Expected: FAIL with `Cannot find module '../../src/store/db.js'`.

- [ ] **Step 3: Write the schema and the store modules**

`bot-scripts/src/store/schema.sql`:

```sql
-- Knowledge index schema. Applied by createSchema() on a fresh file.
-- {{DIMENSIONS}} is replaced with the embedding dimension.

CREATE TABLE items (
  id          INTEGER PRIMARY KEY,
  source      TEXT NOT NULL,   -- docs | issue | pull | discussion | forum | code | file
  provider    TEXT NOT NULL,   -- github | discourse | ...
  origin      TEXT NOT NULL,   -- repository or host
  source_id   TEXT NOT NULL,   -- issue number, topic id, page slug, file path
  url         TEXT NOT NULL,
  title       TEXT NOT NULL,
  audience    TEXT NOT NULL DEFAULT 'user',
  created_at  TEXT NOT NULL,   -- ISO 8601
  updated_at  TEXT,
  outcome     TEXT,            -- JSON
  extra       TEXT             -- JSON
);
CREATE UNIQUE INDEX items_origin ON items (provider, origin, source, source_id);

CREATE TABLE chunks (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL,   -- body | comment | review | answer | section | symbol
  heading     TEXT,
  anchor      TEXT,
  text        TEXT NOT NULL,
  logs        TEXT,
  created_at  TEXT NOT NULL,
  hash        TEXT NOT NULL
);
CREATE INDEX chunks_item ON chunks (item_id, seq);
CREATE INDEX chunks_hash ON chunks (hash);
CREATE INDEX chunks_created ON chunks (created_at);

CREATE VIRTUAL TABLE chunks_fts USING fts5 (
  heading, text, logs,
  content='chunks', content_rowid='id',
  tokenize='porter unicode61 tokenchars ''-._:/'''
);

CREATE VIRTUAL TABLE vec_chunks USING vec0 (
  chunk_id INTEGER PRIMARY KEY,
  embedding int8[{{DIMENSIONS}}]
);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

`bot-scripts/src/store/db.js`:

```js
// @ts-check
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as sqliteVec from 'sqlite-vec';

export const SCHEMA_VERSION = 1;
export const FORMAT_VERSION = 1;

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));

/**
 * Opens the index database with sqlite-vec loaded. Extension loading is
 * switched off again right after, so SQL from the index can never load code.
 * @param {string} path
 * @param {{ readOnly?: boolean }} [options]
 * @returns {DatabaseSync}
 */
export function openDatabase(path, { readOnly = false } = {}) {
  const db = new DatabaseSync(path, { allowExtension: true, readOnly });
  db.enableLoadExtension(true);
  db.loadExtension(sqliteVec.getLoadablePath());
  db.enableLoadExtension(false);
  return db;
}

/**
 * Applies the schema to a fresh database and records the versions in meta.
 * @param {DatabaseSync} db
 * @param {{ dimensions: number }} options
 */
export function createSchema(db, { dimensions }) {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`createSchema: dimensions must be a positive integer, got ${dimensions}`);
  }
  const sql = readFileSync(SCHEMA_PATH, 'utf8').replaceAll('{{DIMENSIONS}}', String(dimensions));
  db.exec(sql);
  const put = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  put.run('schema_version', String(SCHEMA_VERSION));
  put.run('format_version', String(FORMAT_VERSION));
  put.run('dimensions', String(dimensions));
}

/**
 * Reads the whole meta table as an object.
 * @param {DatabaseSync} db
 * @returns {Record<string, string>}
 */
export function readMeta(db) {
  const rows = /** @type {{key: string, value: string}[]} */ (db.prepare('SELECT key, value FROM meta').all());
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
```

`bot-scripts/src/store/vectors.js`:

```js
// @ts-check

/** Scale applied to unit-vector components when quantizing to int8. */
export const INT8_SCALE = 127;

/**
 * Quantizes an L2-normalized vector to int8 by scaling to [-127, 127].
 * @param {ArrayLike<number>} vector
 * @returns {Int8Array}
 */
export function quantizeInt8(vector) {
  return Int8Array.from(vector, (v) => Math.max(-INT8_SCALE, Math.min(INT8_SCALE, Math.round(v * INT8_SCALE))));
}

/**
 * Wraps an int8 vector as the blob sqlite-vec expects behind vec_int8().
 * @param {Int8Array} vector
 * @returns {Buffer}
 */
export function toBlob(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/**
 * @param {Uint8Array} blob
 * @returns {Int8Array}
 */
export function fromBlob(blob) {
  return new Int8Array(blob.buffer, blob.byteOffset, blob.byteLength);
}

/**
 * Cosine similarity recovered from the L2 distance between two int8-scaled unit vectors:
 * cos = 1 - d^2 / (2 * scale^2).
 * @param {number} distance
 * @param {number} [scale]
 * @returns {number}
 */
export function cosineFromL2(distance, scale = INT8_SCALE) {
  return 1 - (distance * distance) / (2 * scale * scale);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && node --test test/store/`
Expected: PASS, 4 tests. If `loadExtension` fails on this platform, the error names the path from `getLoadablePath()`; that is the signal to open the `better-sqlite3` fallback discussion, not to patch around it.

- [ ] **Step 5: Hand over for commit**

Files to stage: `bot-scripts/src/store/schema.sql`, `bot-scripts/src/store/db.js`, `bot-scripts/src/store/vectors.js`, `bot-scripts/test/store/db.test.js`, `bot-scripts/test/store/vectors.test.js`. Suggested message: `Add SQLite store with FTS5 and sqlite-vec`.

---

### Task 3: Config loader with strict provider schemas

**Files:**
- Create: `schemas/config.base.json`
- Create: `schemas/providers/github.json`
- Create: `bot-scripts/src/config/load.js`
- Test: `bot-scripts/test/config/load.test.js`
- Test fixture: `bot-scripts/test/fixtures/config/android.yaml`

**Interfaces:**
- Produces: `loadConfig(path, { providerSchemas = defaultProviderSchemas() } = {}) => Config` and `validateConfig(object, providerSchemas) => Config`. A `Config` has `version`, `product: {name, slug}`, `providers: { github?: Record<repo, GithubRepoConfig> }`, `embedding: { model, revision, dtype, dimensions, pooling }`, optional `peers`, `triage`, `evalCases`.
- `GithubRepoConfig = { issues?: { states, closedWithinDays, comments }, docs?: { path, baseUrl, audience } }`. Later plans add `pulls`, `discussions`, `code`, `files` to `schemas/providers/github.json`.
- Errors are `ConfigError` with `message` listing every violation as `<instancePath>: <message>`.

- [ ] **Step 1: Write the failing tests**

`bot-scripts/test/fixtures/config/android.yaml`:

```yaml
version: 1

product:
  name: Home Assistant Companion for Android
  slug: android

providers:
  github:
    home-assistant/android:
      issues:
        states: [open, closed]
        closedWithinDays: 730
        comments: true
    home-assistant/companion.home-assistant:
      docs:
        path: docs
        baseUrl: https://companion.home-assistant.io/docs/
    home-assistant/contributors.home-assistant.io:
      docs:
        path: src/content/docs/companion
        baseUrl: https://contributors.home-assistant.io/companion/
        audience: developer

embedding:
  model: Xenova/bge-small-en-v1.5
  revision: main
  dtype: q8
  dimensions: 384
  pooling: cls
```

`bot-scripts/test/config/load.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateConfig, ConfigError } from '../../src/config/load.js';

const fixture = fileURLToPath(new URL('../fixtures/config/android.yaml', import.meta.url));

test('loads the android fixture and applies defaults', () => {
  const config = loadConfig(fixture);
  assert.equal(config.product.slug, 'android');
  const android = config.providers.github['home-assistant/android'];
  assert.deepEqual(android.issues, { states: ['open', 'closed'], closedWithinDays: 730, comments: true });
  const companion = config.providers.github['home-assistant/companion.home-assistant'];
  assert.equal(companion.docs.audience, 'user');
  assert.equal(config.embedding.dimensions, 384);
});

test('rejects an unknown key with its path', () => {
  const config = loadConfig(fixture);
  config.providers.github['home-assistant/android'].issues.includeBots = true;
  assert.throws(() => validateConfig(config), (e) => e instanceof ConfigError && /issues: .*includeBots/.test(e.message));
});

test('rejects an unknown provider', () => {
  const config = loadConfig(fixture);
  config.providers.gitlab = {};
  assert.throws(() => validateConfig(config), (e) => e instanceof ConfigError && /providers: .*gitlab/.test(e.message));
});

test('rejects a missing embedding section', () => {
  const config = loadConfig(fixture);
  delete config.embedding;
  assert.throws(() => validateConfig(config), (e) => e instanceof ConfigError && /embedding/.test(e.message));
});

test('rejects a repository key that is not owner/name', () => {
  const config = loadConfig(fixture);
  config.providers.github['not a repo'] = { issues: {} };
  assert.throws(() => validateConfig(config), ConfigError);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot-scripts && node --test test/config/`
Expected: FAIL with `Cannot find module '../../src/config/load.js'`.

- [ ] **Step 3: Write the schemas and the loader**

`schemas/config.base.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://home-assistant.io/auto-triage/config.base.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "product", "providers", "embedding"],
  "properties": {
    "version": { "type": "integer", "const": 1 },
    "product": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "slug"],
      "properties": {
        "name": { "type": "string", "minLength": 1 },
        "slug": { "type": "string", "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$" }
      }
    },
    "providers": {
      "type": "object",
      "additionalProperties": false,
      "minProperties": 1,
      "properties": {}
    },
    "embedding": {
      "type": "object",
      "additionalProperties": false,
      "required": ["model", "revision", "dtype", "dimensions"],
      "properties": {
        "model": { "type": "string", "minLength": 1 },
        "revision": { "type": "string", "minLength": 1 },
        "dtype": { "enum": ["fp32", "fp16", "q8"] },
        "dimensions": { "type": "integer", "minimum": 16 },
        "pooling": { "enum": ["cls", "mean"], "default": "cls" }
      }
    },
    "peers": {
      "type": "array",
      "default": [],
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["product", "repository"],
        "properties": {
          "product": { "type": "string" },
          "repository": { "type": "string", "pattern": "^[^/\\s]+/[^/\\s]+$" },
          "weight": { "type": "number", "exclusiveMinimum": 0, "maximum": 1, "default": 0.5 },
          "sources": { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    "triage": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "minSimilarity": { "type": "number", "minimum": 0, "maximum": 1, "default": 0.35 },
        "confidence": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "answer": { "type": "integer", "minimum": 0, "maximum": 100, "default": 75 },
            "links": { "type": "integer", "minimum": 0, "maximum": 100, "default": 45 }
          }
        },
        "recheckLabel": { "type": "string", "default": "ai-recheck" },
        "nextSteps": { "type": "object", "additionalProperties": { "type": "string", "format": "uri" } }
      }
    },
    "evalCases": { "type": "string" }
  }
}
```

`schemas/providers/github.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://home-assistant.io/auto-triage/providers/github.json",
  "type": "object",
  "minProperties": 1,
  "propertyNames": { "pattern": "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" },
  "additionalProperties": {
    "type": "object",
    "additionalProperties": false,
    "minProperties": 1,
    "properties": {
      "issues": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "states": { "type": "array", "items": { "enum": ["open", "closed"] }, "default": ["open", "closed"], "minItems": 1 },
          "closedWithinDays": { "type": "integer", "minimum": 1, "default": 730 },
          "comments": { "type": "boolean", "default": true }
        }
      },
      "docs": {
        "type": "object",
        "additionalProperties": false,
        "required": ["path", "baseUrl"],
        "properties": {
          "path": { "type": "string", "minLength": 1 },
          "baseUrl": { "type": "string", "format": "uri" },
          "audience": { "enum": ["user", "developer", "maintainer"], "default": "user" }
        }
      }
    }
  }
}
```

`bot-scripts/src/config/load.js`:

```js
// @ts-check
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import Ajv from 'ajv';

const SCHEMAS_DIR = new URL('../../../schemas/', import.meta.url);

export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** @param {string} relative */
function readSchema(relative) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relative, SCHEMAS_DIR)), 'utf8'));
}

/**
 * The provider schemas shipped with this repository, keyed by the top-level
 * key they validate under `providers`.
 * @returns {Record<string, object>}
 */
export function defaultProviderSchemas() {
  return { github: readSchema('providers/github.json') };
}

/**
 * @param {Record<string, object>} providerSchemas
 */
function buildValidator(providerSchemas) {
  const base = readSchema('config.base.json');
  base.properties.providers.properties = Object.fromEntries(
    Object.entries(providerSchemas).map(([key, schema]) => [key, { ...schema, $id: undefined }]),
  );
  const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: true, allowUnionTypes: true });
  ajv.addFormat('uri', /^https?:\/\/\S+$/);
  return ajv.compile(base);
}

/**
 * Validates a parsed config in place, applying schema defaults.
 * @param {unknown} config
 * @param {Record<string, object>} [providerSchemas]
 * @returns {import('./types.js').Config}
 */
export function validateConfig(config, providerSchemas = defaultProviderSchemas()) {
  const validate = buildValidator(providerSchemas);
  if (!validate(config)) {
    const lines = (validate.errors ?? []).map((e) => {
      const where = e.instancePath ? e.instancePath.slice(1).replaceAll('/', '.') : '(root)';
      const detail = e.params && 'additionalProperty' in e.params ? `${e.message} (${e.params.additionalProperty})` : e.message;
      return `${where}: ${detail}`;
    });
    throw new ConfigError(`Invalid knowledge-bot config:\n  ${lines.join('\n  ')}`);
  }
  return /** @type {import('./types.js').Config} */ (config);
}

/**
 * Reads and validates a YAML config file.
 * @param {string} path
 * @param {{ providerSchemas?: Record<string, object> }} [options]
 */
export function loadConfig(path, { providerSchemas } = {}) {
  const parsed = YAML.parse(readFileSync(path, 'utf8'));
  return validateConfig(parsed, providerSchemas);
}
```

`bot-scripts/src/config/types.js` (JSDoc only, no runtime code):

```js
// @ts-check
/**
 * @typedef {{ states: ('open'|'closed')[], closedWithinDays: number, comments: boolean }} IssuesConfig
 * @typedef {{ path: string, baseUrl: string, audience: 'user'|'developer'|'maintainer' }} DocsConfig
 * @typedef {{ issues?: IssuesConfig, docs?: DocsConfig }} GithubRepoConfig
 * @typedef {{ model: string, revision: string, dtype: 'fp32'|'fp16'|'q8', dimensions: number, pooling: 'cls'|'mean' }} EmbeddingConfig
 * @typedef {{
 *   version: 1,
 *   product: { name: string, slug: string },
 *   providers: { github?: Record<string, GithubRepoConfig> },
 *   embedding: EmbeddingConfig,
 *   peers: object[],
 *   triage?: object,
 *   evalCases?: string,
 * }} Config
 */
export {};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && node --test test/config/`
Expected: PASS, 5 tests. If Ajv complains in strict mode about `"default"` inside `additionalProperties`, keep `strict: true` and move the offending default to the loader rather than disabling strict mode.

- [ ] **Step 5: Hand over for commit**

Files to stage: `schemas/config.base.json`, `schemas/providers/github.json`, `bot-scripts/src/config/load.js`, `bot-scripts/src/config/types.js`, `bot-scripts/test/config/load.test.js`, `bot-scripts/test/fixtures/config/android.yaml`. Suggested message: `Add strict YAML config loader with provider schemas`.

---

### Task 4: Markdown chunker

**Files:**
- Create: `bot-scripts/src/text/chunk.js`
- Test: `bot-scripts/test/text/chunk.test.js`

**Interfaces:**
- Produces: `chunkMarkdown(markdown, { maxChars = 2000, minChars = 300 } = {}) => { heading: string | null, breadcrumbs: string[], anchor: string | null, text: string }[]` and `slugifyHeading(text) => string` (GitHub-style anchor).

- [ ] **Step 1: Write the failing tests**

`bot-scripts/test/text/chunk.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown, slugifyHeading } from '../../src/text/chunk.js';

test('slugifyHeading matches GitHub anchors', () => {
  assert.equal(slugifyHeading('Available Widgets'), 'available-widgets');
  assert.equal(slugifyHeading('Entity State Widget (Android 12+)'), 'entity-state-widget-android-12');
});

test('splits on headings and records breadcrumbs and anchors', () => {
  const md = `# Widgets\n\nIntro paragraph.\n\n## Entity state\n\nShows a state.\n\n### Refresh\n\nTap to refresh.\n`;
  const chunks = chunkMarkdown(md);
  assert.deepEqual(chunks.map((c) => c.anchor), [null, 'entity-state', 'refresh']);
  assert.deepEqual(chunks[2].breadcrumbs, ['Widgets', 'Entity state', 'Refresh']);
  assert.equal(chunks[0].text, 'Intro paragraph.');
});

test('never splits inside a fenced code block', () => {
  const md = '## Config\n\n```yaml\n# not a heading\nkey: value\n```\n\nAfter.\n';
  const chunks = chunkMarkdown(md);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].text.includes('# not a heading'));
});

test('packs paragraphs up to maxChars and merges tiny trailing chunks', () => {
  const para = 'x'.repeat(900);
  const md = `## A\n\n${para}\n\n${para}\n\n${para}\n\n## B\n\nshort\n`;
  const chunks = chunkMarkdown(md, { maxChars: 2000, minChars: 300 });
  assert.equal(chunks.filter((c) => c.heading === 'A').length, 2);
  // "short" under B is below minChars and is merged into the previous chunk
  assert.equal(chunks.at(-1).text.endsWith('short'), true);
});

test('returns no chunk for an empty document', () => {
  assert.deepEqual(chunkMarkdown('\n\n'), []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot-scripts && node --test test/text/chunk.test.js`
Expected: FAIL with `Cannot find module '../../src/text/chunk.js'`.

- [ ] **Step 3: Write the chunker**

`bot-scripts/src/text/chunk.js`:

```js
// @ts-check

/** @typedef {{ heading: string | null, breadcrumbs: string[], anchor: string | null, text: string }} MarkdownChunk */

const FENCE = /^(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * GitHub-style anchor for a heading: lowercase, punctuation removed, spaces to dashes.
 * @param {string} text
 */
export function slugifyHeading(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/**
 * Splits markdown into heading-scoped sections, fence-aware.
 * @param {string} markdown
 * @returns {{ level: number, heading: string | null, lines: string[] }[]}
 */
function splitSections(markdown) {
  const sections = [{ level: 0, heading: null, lines: /** @type {string[]} */ ([]) }];
  let inFence = false;
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (FENCE.test(line.trim())) inFence = !inFence;
    const match = inFence ? null : HEADING.exec(line);
    if (match) {
      sections.push({ level: match[1].length, heading: match[2], lines: [] });
    } else {
      sections.at(-1)?.lines.push(line);
    }
  }
  return sections;
}

/**
 * Splits section text into paragraphs, keeping fenced blocks whole.
 * @param {string[]} lines
 */
function paragraphs(lines) {
  const out = /** @type {string[]} */ ([]);
  let current = /** @type {string[]} */ ([]);
  let inFence = false;
  const flush = () => {
    const text = current.join('\n').trim();
    if (text) out.push(text);
    current = [];
  };
  for (const line of lines) {
    if (FENCE.test(line.trim())) inFence = !inFence;
    if (!inFence && line.trim() === '') flush();
    else current.push(line);
  }
  flush();
  return out;
}

/**
 * Packs paragraphs into pieces of at most maxChars, splitting an oversized paragraph on sentences.
 * @param {string[]} paras
 * @param {number} maxChars
 */
function pack(paras, maxChars) {
  const pieces = /** @type {string[]} */ ([]);
  let current = '';
  for (const para of paras) {
    const units = para.length > maxChars ? para.split(/(?<=[.!?])\s+/) : [para];
    for (const unit of units) {
      if (current && current.length + unit.length + 2 > maxChars) {
        pieces.push(current);
        current = '';
      }
      current = current ? `${current}\n\n${unit}` : unit;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * Heading-scoped chunks of a markdown document.
 * @param {string} markdown
 * @param {{ maxChars?: number, minChars?: number }} [options]
 * @returns {MarkdownChunk[]}
 */
export function chunkMarkdown(markdown, { maxChars = 2000, minChars = 300 } = {}) {
  const chunks = /** @type {MarkdownChunk[]} */ ([]);
  const trail = /** @type {{ level: number, heading: string }[]} */ ([]);
  for (const section of splitSections(markdown)) {
    if (section.heading !== null) {
      while (trail.length && trail.at(-1).level >= section.level) trail.pop();
      trail.push({ level: section.level, heading: section.heading });
    }
    const breadcrumbs = trail.map((t) => t.heading);
    const anchor = section.heading === null ? null : slugifyHeading(section.heading);
    for (const text of pack(paragraphs(section.lines), maxChars)) {
      const previous = chunks.at(-1);
      if (previous && text.length < minChars && previous.text.length + text.length + 2 <= maxChars) {
        previous.text = `${previous.text}\n\n${text}`;
      } else {
        chunks.push({ heading: section.heading, breadcrumbs, anchor, text });
      }
    }
  }
  return chunks;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && node --test test/text/chunk.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Hand over for commit**

Files to stage: `bot-scripts/src/text/chunk.js`, `bot-scripts/test/text/chunk.test.js`. Suggested message: `Add heading-scoped markdown chunker`.

---

### Task 5: Issue text cleaning

**Files:**
- Create: `bot-scripts/src/text/clean.js`
- Test: `bot-scripts/test/text/clean.test.js`

**Interfaces:**
- Produces: `cleanIssueText(markdown, { maxLogLines = 5 } = {}) => { text: string, logs: string | null }`. Strips HTML comments, images, template field labels, and moves fenced blocks longer than `maxLogLines` or that look like logs into `logs`.

- [ ] **Step 1: Write the failing tests**

`bot-scripts/test/text/clean.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanIssueText } from '../../src/text/clean.js';

test('strips HTML comments and images', () => {
  const { text } = cleanIssueText('<!-- READ THIS FIRST -->\nWidget ![shot](https://x/a.png) breaks <img src="x.png">.');
  assert.equal(text, 'Widget breaks .');
});

test('drops bold template labels but keeps their values', () => {
  const body = '**Home Assistant Android app version(s):**\n2026.9.1\n\n**Android version(s):**\n14\n\n**Description of problem:**\nWidget stops.';
  const { text } = cleanIssueText(body);
  assert.equal(text, '2026.9.1\n\n14\n\nWidget stops.');
});

test('moves long fenced blocks and log-like blocks to logs', () => {
  const log = Array.from({ length: 8 }, (_, i) => `10-12 09:15:${i} E/WidgetProvider: boom ${i}`).join('\n');
  const body = `Widget stops.\n\n\`\`\`\n${log}\n\`\`\`\n\nShort fence:\n\n\`\`\`yaml\nkey: value\n\`\`\``;
  const { text, logs } = cleanIssueText(body);
  assert.ok(text.includes('key: value'));
  assert.ok(!text.includes('boom 3'));
  assert.ok(logs.includes('boom 3'));
});

test('a three line block with a stack trace counts as a log', () => {
  const body = 'Crash:\n\n```\njava.lang.NullPointerException\n\tat io.homeassistant.companion.android.widgets.Foo.bar(Foo.kt:12)\n\tat android.os.Handler.handleCallback(Handler.java:1)\n```';
  const { text, logs } = cleanIssueText(body);
  assert.equal(text, 'Crash:');
  assert.ok(logs.includes('NullPointerException'));
});

test('returns empty text and null logs for a template-only body', () => {
  const { text, logs } = cleanIssueText('**Companion App Logs:**\n\n```\n\n```\n');
  assert.equal(text, '');
  assert.equal(logs, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot-scripts && node --test test/text/clean.test.js`
Expected: FAIL with `Cannot find module '../../src/text/clean.js'`.

- [ ] **Step 3: Write the cleaner**

`bot-scripts/src/text/clean.js`:

```js
// @ts-check

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const HTML_IMAGE = /<img\b[^>]*>/gi;
const TEMPLATE_LABEL = /^\s*\*\*[^*\n]+:\*\*\s*$/;
const FENCED_BLOCK = /```[^\n]*\n([\s\S]*?)```/g;
const LOG_LINE = /^\s*(at\s+[\w.$<>]+\(|\d{2}-\d{2}\s\d{2}:\d{2}|[VDIWEF]\/\w+|\w+(Exception|Error)\b)/m;

/**
 * Decides whether a fenced block is a log rather than configuration or a short snippet.
 * @param {string} body
 * @param {number} maxLogLines
 */
function looksLikeLog(body, maxLogLines) {
  const lines = body.split('\n').filter((l) => l.trim() !== '');
  return lines.length > maxLogLines || LOG_LINE.test(body);
}

/**
 * Removes template noise from an issue or comment body and separates logs for
 * the lexical index.
 * @param {string} markdown
 * @param {{ maxLogLines?: number }} [options]
 * @returns {{ text: string, logs: string | null }}
 */
export function cleanIssueText(markdown, { maxLogLines = 5 } = {}) {
  const logs = /** @type {string[]} */ ([]);
  let text = markdown
    .replace(/\r\n/g, '\n')
    .replace(HTML_COMMENT, '')
    .replace(MARKDOWN_IMAGE, '')
    .replace(HTML_IMAGE, '')
    .replace(FENCED_BLOCK, (whole, body) => {
      const trimmed = String(body).trim();
      if (trimmed === '') return '';
      if (!looksLikeLog(trimmed, maxLogLines)) return whole;
      logs.push(trimmed);
      return '';
    });
  text = text
    .split('\n')
    .filter((line) => !TEMPLATE_LABEL.test(line))
    .map((line) => line.replace(/[ \t]+$/g, '').replace(/[ \t]{2,}/g, ' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, logs: logs.length ? logs.join('\n\n') : null };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && node --test test/text/clean.test.js`
Expected: PASS, 5 tests. If the first test's expected string differs by a space (`Widget  breaks .`), the double-space collapse in the map step is the place to look, not the assertion.

- [ ] **Step 5: Hand over for commit**

Files to stage: `bot-scripts/src/text/clean.js`, `bot-scripts/test/text/clean.test.js`. Suggested message: `Add issue text cleaning with log separation`.

---

### Task 6: Local embedder

**Files:**
- Create: `bot-scripts/src/embed/embedder.js`
- Test: `bot-scripts/test/embed/embedder.test.js`

**Interfaces:**
- Produces: `createEmbedder(embeddingConfig, { pipelineFactory, cacheDir, batchSize = 32 } = {}) => Embedder` where `Embedder = { modelKey: string, dimensions: number, embed(texts: string[]) => Promise<Float32Array[]> }`. `modelKey` is `${model}@${revision}@${dtype}@${pooling}`.
- `pipelineFactory(task, model, options) => Promise<extractor>` defaults to `@huggingface/transformers` `pipeline`; tests inject a fake.

- [ ] **Step 1: Write the failing tests**

`bot-scripts/test/embed/embedder.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmbedder } from '../../src/embed/embedder.js';

const config = { model: 'fake/model', revision: 'abc', dtype: 'q8', dimensions: 3, pooling: 'cls' };

/** A fake extractor returning one-hot vectors by text length, batched like transformers.js. */
function fakeFactory(calls) {
  return async (task, model, options) => {
    calls.push({ task, model, options });
    return async (texts, runOptions) => {
      calls.push({ texts, runOptions });
      const rows = texts.map((t) => [t.length % 3 === 0 ? 1 : 0, t.length % 3 === 1 ? 1 : 0, t.length % 3 === 2 ? 1 : 0]);
      return { dims: [texts.length, 3], tolist: () => rows };
    };
  };
}

test('loads the pipeline once with the pinned model, revision and dtype', async () => {
  const calls = [];
  const embedder = createEmbedder(config, { pipelineFactory: fakeFactory(calls), cacheDir: '/tmp/x' });
  await embedder.embed(['a']);
  await embedder.embed(['bb']);
  const loads = calls.filter((c) => c.task);
  assert.equal(loads.length, 1);
  assert.deepEqual(loads[0], { task: 'feature-extraction', model: 'fake/model', options: { revision: 'abc', dtype: 'q8', cache_dir: '/tmp/x' } });
  assert.equal(embedder.modelKey, 'fake/model@abc@q8@cls');
});

test('returns vectors in input order and uses the configured pooling', async () => {
  const calls = [];
  const embedder = createEmbedder(config, { pipelineFactory: fakeFactory(calls), batchSize: 2 });
  const out = await embedder.embed(['a', 'bb', 'ccc']);
  assert.deepEqual(out.map((v) => Array.from(v)), [[0, 1, 0], [0, 0, 1], [1, 0, 0]]);
  const run = calls.find((c) => c.texts);
  assert.deepEqual(run.runOptions, { pooling: 'cls', normalize: true });
});

test('rejects a vector of the wrong dimension', async () => {
  const bad = async () => async (texts) => ({ dims: [texts.length, 2], tolist: () => texts.map(() => [1, 0]) });
  const embedder = createEmbedder(config, { pipelineFactory: bad });
  await assert.rejects(() => embedder.embed(['a']), /dimension/);
});

test('embeds nothing without loading the model', async () => {
  const calls = [];
  const embedder = createEmbedder(config, { pipelineFactory: fakeFactory(calls) });
  assert.deepEqual(await embedder.embed([]), []);
  assert.equal(calls.length, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot-scripts && node --test test/embed/`
Expected: FAIL with `Cannot find module '../../src/embed/embedder.js'`.

- [ ] **Step 3: Write the embedder**

`bot-scripts/src/embed/embedder.js`:

```js
// @ts-check

/**
 * @typedef {{ modelKey: string, dimensions: number, embed(texts: string[]): Promise<Float32Array[]> }} Embedder
 * @typedef {import('../config/types.js').EmbeddingConfig} EmbeddingConfig
 */

/**
 * Default factory: the transformers.js pipeline. Imported lazily because the
 * package is ESM-only and heavy, and tests never need it.
 * @param {string} task
 * @param {string} model
 * @param {object} options
 */
async function transformersPipeline(task, model, options) {
  const { pipeline } = await import('@huggingface/transformers');
  return pipeline(/** @type {any} */ (task), model, options);
}

/**
 * Builds the model key recorded in the index meta. Any part changing invalidates the index.
 * @param {EmbeddingConfig} config
 */
export function modelKeyOf(config) {
  return `${config.model}@${config.revision}@${config.dtype}@${config.pooling}`;
}

/**
 * Creates an embedder over a local ONNX model. The pipeline is loaded on first use.
 * @param {EmbeddingConfig} config
 * @param {{ pipelineFactory?: typeof transformersPipeline, cacheDir?: string, batchSize?: number }} [options]
 * @returns {Embedder}
 */
export function createEmbedder(config, { pipelineFactory = transformersPipeline, cacheDir, batchSize = 32 } = {}) {
  /** @type {Promise<any> | undefined} */
  let extractorPromise;
  const load = () => {
    extractorPromise ??= pipelineFactory('feature-extraction', config.model, {
      revision: config.revision,
      dtype: config.dtype,
      cache_dir: cacheDir,
    });
    return extractorPromise;
  };

  return {
    modelKey: modelKeyOf(config),
    dimensions: config.dimensions,
    async embed(texts) {
      if (texts.length === 0) return [];
      const extractor = await load();
      const order = texts.map((_, i) => i).sort((a, b) => texts[a].length - texts[b].length);
      const results = /** @type {Float32Array[]} */ (new Array(texts.length));
      for (let start = 0; start < order.length; start += batchSize) {
        const batch = order.slice(start, start + batchSize);
        const output = await extractor(batch.map((i) => texts[i]), { pooling: config.pooling, normalize: true });
        if (output.dims?.length !== 2 || output.dims[1] !== config.dimensions) {
          throw new Error(`Embedding dimension mismatch: expected [n, ${config.dimensions}], got [${output.dims}]`);
        }
        const rows = output.tolist();
        batch.forEach((i, k) => {
          results[i] = Float32Array.from(rows[k]);
        });
      }
      return results;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && node --test test/embed/`
Expected: PASS, 4 tests.

- [ ] **Step 5: Verify the real model once, outside the test suite**

Run: `cd bot-scripts && node -e "import('./src/embed/embedder.js').then(async (m) => { const e = m.createEmbedder({ model: 'Xenova/bge-small-en-v1.5', revision: 'main', dtype: 'q8', dimensions: 384, pooling: 'cls' }, { cacheDir: '.model-cache' }); const [a, b, c] = await e.embed(['widget not updating', 'widget stops refreshing', 'how to set up ESPHome']); const dot = (x, y) => x.reduce((s, v, i) => s + v * y[i], 0); console.log('similar', dot(a, b).toFixed(3), 'different', dot(a, c).toFixed(3)); })"`
Expected: a download of about 35 MB into `.model-cache/`, then `similar` clearly above `different` (for example 0.85 versus 0.45). If `pooling: 'cls'` errors or gives poor separation, switch the fixture and the android config to `pooling: mean` and note it in the task hand-over. Pin `revision` in the android config to the commit printed by `git ls-remote https://huggingface.co/Xenova/bge-small-en-v1.5 HEAD`.

- [ ] **Step 6: Hand over for commit**

Files to stage: `bot-scripts/src/embed/embedder.js`, `bot-scripts/test/embed/embedder.test.js`. Suggested message: `Add local ONNX embedder`.

---

### Task 7: GitHub REST client with pagination

**Files:**
- Create: `bot-scripts/src/providers/github/client.js`
- Test: `bot-scripts/test/providers/github/client.test.js`

**Interfaces:**
- Produces: `createGitHubClient({ token, fetchImpl = fetch, baseUrl = 'https://api.github.com' }) => { getJson(path, params?) => Promise<any>, paginate(path, params?) => AsyncGenerator<any> }`. `paginate` follows `Link: <...>; rel="next"` headers and yields array elements one by one. Errors carry the status and the first 200 characters of the body. A `403` or `429` with `retry-after` or `x-ratelimit-reset` waits and retries once.

- [ ] **Step 1: Write the failing tests**

`bot-scripts/test/providers/github/client.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubClient } from '../../../src/providers/github/client.js';

/** @param {Record<string, { status?: number, headers?: Record<string,string>, body: unknown }>} routes */
function fakeFetch(routes, log = []) {
  return async (url, init) => {
    log.push({ url: String(url), headers: init?.headers });
    const route = routes[String(url)];
    if (!route) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { 'content-type': 'application/json', ...route.headers } });
  };
}

test('getJson sends the token and parses JSON', async () => {
  const log = [];
  const client = createGitHubClient({ token: 't', fetchImpl: fakeFetch({ 'https://api.github.com/repos/o/r/issues/1': { body: { number: 1 } } }, log) });
  assert.deepEqual(await client.getJson('/repos/o/r/issues/1'), { number: 1 });
  assert.equal(log[0].headers.authorization, 'Bearer t');
  assert.equal(log[0].headers.accept, 'application/vnd.github+json');
});

test('paginate follows the Link header and yields elements', async () => {
  const routes = {
    'https://api.github.com/repos/o/r/issues?state=all&per_page=2': { body: [{ number: 1 }, { number: 2 }], headers: { link: '<https://api.github.com/repositories/1/issues?state=all&per_page=2&page=2>; rel="next", <https://api.github.com/x>; rel="last"' } },
    'https://api.github.com/repositories/1/issues?state=all&per_page=2&page=2': { body: [{ number: 3 }] },
  };
  const client = createGitHubClient({ token: 't', fetchImpl: fakeFetch(routes) });
  const numbers = [];
  for await (const issue of client.paginate('/repos/o/r/issues', { state: 'all', per_page: 2 })) numbers.push(issue.number);
  assert.deepEqual(numbers, [1, 2, 3]);
});

test('throws with status and body excerpt on errors', async () => {
  const client = createGitHubClient({ token: 't', fetchImpl: fakeFetch({ 'https://api.github.com/repos/o/r': { status: 500, body: { message: 'boom' } } }) });
  await assert.rejects(() => client.getJson('/repos/o/r'), /500.*boom/);
});

test('retries once after a rate limit with retry-after', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return calls === 1
      ? new Response('{"message":"rate"}', { status: 403, headers: { 'retry-after': '0' } })
      : new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = createGitHubClient({ token: 't', fetchImpl });
  assert.deepEqual(await client.getJson('/x'), { ok: true });
  assert.equal(calls, 2);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot-scripts && node --test test/providers/github/client.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Write the client**

`bot-scripts/src/providers/github/client.js`:

```js
// @ts-check
import { setTimeout as sleep } from 'node:timers/promises';

const NEXT_LINK = /<([^>]+)>;\s*rel="next"/;

/**
 * @param {string} path
 * @param {Record<string, string | number | boolean> | undefined} params
 * @param {string} baseUrl
 */
function buildUrl(path, params, baseUrl) {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, String(value));
  return url.toString();
}

/**
 * Seconds to wait before retrying a rate-limited response, or null when it is not one.
 * @param {Response} response
 */
function retryDelaySeconds(response) {
  if (response.status !== 403 && response.status !== 429) return null;
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null) return Number(retryAfter);
  const reset = response.headers.get('x-ratelimit-reset');
  if (reset !== null) return Math.max(0, Number(reset) - Math.floor(Date.now() / 1000));
  return null;
}

/**
 * Minimal GitHub REST client: JSON requests with the token, Link pagination,
 * one retry on a rate limit.
 * @param {{ token: string, fetchImpl?: typeof fetch, baseUrl?: string }} options
 */
export function createGitHubClient({ token, fetchImpl = fetch, baseUrl = 'https://api.github.com' }) {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'home-assistant-auto-triage',
  };

  /** @param {string} url */
  async function request(url) {
    let response = await fetchImpl(url, { headers });
    const delay = retryDelaySeconds(response);
    if (delay !== null) {
      await sleep(delay * 1000);
      response = await fetchImpl(url, { headers });
    }
    if (!response.ok) {
      const body = (await response.text()).slice(0, 200);
      throw new Error(`GitHub ${response.status} for ${url}: ${body}`);
    }
    return response;
  }

  return {
    /**
     * @param {string} path
     * @param {Record<string, string | number | boolean>} [params]
     */
    async getJson(path, params) {
      const response = await request(buildUrl(path, params, baseUrl));
      return response.json();
    },
    /**
     * @param {string} path
     * @param {Record<string, string | number | boolean>} [params]
     */
    async *paginate(path, params) {
      /** @type {string | null} */
      let url = buildUrl(path, params, baseUrl);
      while (url) {
        const response = await request(url);
        const page = /** @type {unknown[]} */ (await response.json());
        for (const element of page) yield element;
        const link = response.headers.get('link');
        url = link ? (NEXT_LINK.exec(link)?.[1] ?? null) : null;
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && node --test test/providers/github/client.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Hand over for commit**

Files to stage: `bot-scripts/src/providers/github/client.js`, `bot-scripts/test/providers/github/client.test.js`. Suggested message: `Add GitHub REST client with pagination and rate-limit retry`.

---

### Task 8: GitHub issues reader

**Files:**
- Create: `bot-scripts/src/providers/types.js`
- Create: `bot-scripts/src/providers/github/issues.js`
- Test: `bot-scripts/test/providers/github/issues.test.js`
- Test fixtures: `bot-scripts/test/fixtures/github/issues-page.json`, `bot-scripts/test/fixtures/github/issue-12-comments.json`

**Interfaces:**
- Consumes: `cleanIssueText` (Task 5), a client with `paginate` (Task 7).
- Produces: `readIssues({ client, repo, options, now }) => AsyncGenerator<IndexItem>` where

```js
/**
 * @typedef {{ seq: number, kind: 'body'|'comment'|'review'|'answer'|'section'|'symbol', heading?: string|null, anchor?: string|null, text: string, logs?: string|null, createdAt: string }} IndexChunk
 * @typedef {{ source: 'docs'|'issue'|'pull'|'discussion'|'forum'|'code'|'file', provider: string, origin: string, sourceId: string, url: string, title: string, audience: 'user'|'developer'|'maintainer', createdAt: string, updatedAt?: string|null, outcome?: object|null, extra?: object|null, chunks: IndexChunk[] }} IndexItem
 */
```

- [ ] **Step 1: Write the fixtures and the failing tests**

`bot-scripts/test/fixtures/github/issues-page.json`:

```json
[
  {
    "number": 12,
    "title": "Widget stops updating after reboot",
    "state": "closed",
    "state_reason": "completed",
    "html_url": "https://github.com/o/r/issues/12",
    "user": { "login": "reporter" },
    "author_association": "NONE",
    "labels": [{ "name": "widget" }, { "name": "bug" }],
    "comments": 2,
    "created_at": "2025-03-01T10:00:00Z",
    "updated_at": "2025-03-05T10:00:00Z",
    "closed_at": "2025-03-05T10:00:00Z",
    "reactions": { "+1": 3, "-1": 0 },
    "body": "<!-- READ THIS FIRST -->\n**Home Assistant Android app version(s):**\n2025.2.1\n\n**Description of problem:**\nThe entity widget stops updating after a reboot.\n\n**Companion App Logs:**\n\n```\n03-01 09:59:01 E/EntityWidget: refresh failed\n03-01 09:59:02 E/EntityWidget: refresh failed\n03-01 09:59:03 E/EntityWidget: refresh failed\n03-01 09:59:04 E/EntityWidget: refresh failed\n03-01 09:59:05 E/EntityWidget: refresh failed\n03-01 09:59:06 E/EntityWidget: refresh failed\n```"
  },
  {
    "number": 13,
    "title": "Bump something",
    "state": "closed",
    "state_reason": null,
    "html_url": "https://github.com/o/r/pull/13",
    "pull_request": { "url": "https://api.github.com/repos/o/r/pulls/13" },
    "user": { "login": "renovate[bot]" },
    "author_association": "CONTRIBUTOR",
    "labels": [],
    "comments": 0,
    "created_at": "2025-03-02T10:00:00Z",
    "updated_at": "2025-03-02T10:00:00Z",
    "closed_at": "2025-03-02T11:00:00Z",
    "reactions": { "+1": 0, "-1": 0 },
    "body": "renovate"
  },
  {
    "number": 7,
    "title": "Old closed issue",
    "state": "closed",
    "state_reason": "not_planned",
    "html_url": "https://github.com/o/r/issues/7",
    "user": { "login": "someone" },
    "author_association": "NONE",
    "labels": [],
    "comments": 0,
    "created_at": "2022-01-01T10:00:00Z",
    "updated_at": "2025-03-04T10:00:00Z",
    "closed_at": "2022-02-01T10:00:00Z",
    "reactions": { "+1": 0, "-1": 0 },
    "body": "Too old to index"
  }
]
```

`bot-scripts/test/fixtures/github/issue-12-comments.json`:

```json
[
  {
    "id": 501,
    "user": { "login": "maintainer" },
    "author_association": "MEMBER",
    "created_at": "2025-03-02T10:00:00Z",
    "reactions": { "+1": 2, "-1": 0 },
    "body": "Fixed in #40, widgets now re-register on BOOT_COMPLETED."
  },
  {
    "id": 502,
    "user": { "login": "reporter" },
    "author_association": "NONE",
    "created_at": "2025-03-05T09:00:00Z",
    "reactions": { "+1": 0, "-1": 0 },
    "body": "Confirmed, thanks!"
  }
]
```

`bot-scripts/test/providers/github/issues.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readIssues } from '../../../src/providers/github/issues.js';

const page = JSON.parse(readFileSync(new URL('../../fixtures/github/issues-page.json', import.meta.url), 'utf8'));
const comments = JSON.parse(readFileSync(new URL('../../fixtures/github/issue-12-comments.json', import.meta.url), 'utf8'));

function fakeClient(log = []) {
  return {
    async *paginate(path, params) {
      log.push({ path, params });
      if (path === '/repos/o/r/issues') yield* page;
      else if (path === '/repos/o/r/issues/12/comments') yield* comments;
      else yield* [];
    },
  };
}

const options = { states: ['open', 'closed'], closedWithinDays: 730, comments: true };
const now = new Date('2026-10-15T00:00:00Z');

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

test('yields issues with cleaned body, logs, comments and outcome', async () => {
  const items = await collect(readIssues({ client: fakeClient(), repo: 'o/r', options, now }));
  assert.equal(items.length, 1);
  const [issue] = items;
  assert.equal(issue.source, 'issue');
  assert.equal(issue.sourceId, '12');
  assert.equal(issue.origin, 'o/r');
  assert.equal(issue.url, 'https://github.com/o/r/issues/12');
  assert.deepEqual(issue.outcome, { state: 'closed', stateReason: 'completed', labels: ['widget', 'bug'], closedAt: '2025-03-05T10:00:00Z', reactions: { up: 3, down: 0 } });
  assert.equal(issue.chunks[0].kind, 'body');
  assert.equal(issue.chunks[0].text, 'Widget stops updating after reboot\n\n2025.2.1\n\nThe entity widget stops updating after a reboot.');
  assert.ok(issue.chunks[0].logs.includes('refresh failed'));
  assert.equal(issue.chunks[1].kind, 'comment');
  assert.equal(issue.chunks[1].text, 'Comment by a maintainer:\nFixed in #40, widgets now re-register on BOOT_COMPLETED.');
  assert.equal(issue.chunks[1].createdAt, '2025-03-02T10:00:00Z');
  assert.equal(issue.chunks[2].text, 'Comment by the reporter:\nConfirmed, thanks!');
});

test('drops pull requests', async () => {
  const items = await collect(readIssues({ client: fakeClient(), repo: 'o/r', options, now }));
  assert.ok(items.every((i) => i.sourceId !== '13'));
});

test('drops issues closed before the window', async () => {
  const items = await collect(readIssues({ client: fakeClient(), repo: 'o/r', options, now }));
  assert.ok(items.every((i) => i.sourceId !== '7'));
});

test('asks for comments only when enabled and only for issues with comments', async () => {
  const log = [];
  await collect(readIssues({ client: fakeClient(log), repo: 'o/r', options: { ...options, comments: false }, now }));
  assert.ok(log.every((c) => !c.path.endsWith('/comments')));
});

test('requests the list with state=all, since the window start, sorted by updated', async () => {
  const log = [];
  await collect(readIssues({ client: fakeClient(log), repo: 'o/r', options, now }));
  assert.deepEqual(log[0].params, { state: 'all', since: '2024-10-15T00:00:00.000Z', per_page: 100, sort: 'updated', direction: 'asc' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot-scripts && node --test test/providers/github/issues.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Write the types and the reader**

`bot-scripts/src/providers/types.js`:

```js
// @ts-check
/**
 * @typedef {'docs'|'issue'|'pull'|'discussion'|'forum'|'code'|'file'} SourceKind
 * @typedef {'user'|'developer'|'maintainer'} Audience
 * @typedef {{ seq: number, kind: 'body'|'comment'|'review'|'answer'|'section'|'symbol', heading?: string|null, anchor?: string|null, text: string, logs?: string|null, createdAt: string }} IndexChunk
 * @typedef {{ source: SourceKind, provider: string, origin: string, sourceId: string, url: string, title: string, audience: Audience, createdAt: string, updatedAt?: string|null, outcome?: object|null, extra?: object|null, chunks: IndexChunk[] }} IndexItem
 * @typedef {{ name: string, items(): AsyncGenerator<IndexItem> }} Provider
 */
export {};
```

`bot-scripts/src/providers/github/issues.js`:

```js
// @ts-check
import { cleanIssueText } from '../../text/clean.js';

/** @typedef {import('../types.js').IndexItem} IndexItem */
/** @typedef {import('../types.js').IndexChunk} IndexChunk */

const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {string} association
 * @param {string} login
 * @param {string} reporterLogin
 */
function authorLabel(association, login, reporterLogin) {
  if (login === reporterLogin) return 'the reporter';
  if (MAINTAINER_ASSOCIATIONS.has(association)) return 'a maintainer';
  return 'a user';
}

/**
 * @param {any} comment
 * @param {number} seq
 * @param {string} reporterLogin
 * @returns {IndexChunk | null}
 */
function commentChunk(comment, seq, reporterLogin) {
  const { text, logs } = cleanIssueText(comment.body ?? '');
  if (!text && !logs) return null;
  const who = authorLabel(comment.author_association, comment.user?.login, reporterLogin);
  return { seq, kind: 'comment', text: `Comment by ${who}:\n${text}`.trim(), logs, createdAt: comment.created_at };
}

/**
 * Reads the issues of one repository as index items: one body chunk per issue,
 * one chunk per comment, and the outcome fields the renderer shows.
 * @param {{ client: { paginate(path: string, params?: object): AsyncIterable<any> }, repo: string, options: import('../../config/types.js').IssuesConfig, now?: Date }} input
 * @returns {AsyncGenerator<IndexItem>}
 */
export async function* readIssues({ client, repo, options, now = new Date() }) {
  const cutoff = new Date(now.getTime() - options.closedWithinDays * DAY_MS);
  const wanted = new Set(options.states);
  const params = { state: 'all', since: cutoff.toISOString(), per_page: 100, sort: 'updated', direction: 'asc' };

  for await (const issue of client.paginate(`/repos/${repo}/issues`, params)) {
    if (issue.pull_request) continue;
    if (!wanted.has(issue.state)) continue;
    if (issue.state === 'closed' && issue.closed_at && new Date(issue.closed_at) < cutoff) continue;

    const { text, logs } = cleanIssueText(issue.body ?? '');
    const reporter = issue.user?.login ?? '';
    const chunks = /** @type {IndexChunk[]} */ ([]);
    const bodyText = [issue.title, text].filter(Boolean).join('\n\n');
    chunks.push({ seq: 0, kind: 'body', text: bodyText, logs, createdAt: issue.created_at });

    if (options.comments && issue.comments > 0) {
      for await (const comment of client.paginate(`/repos/${repo}/issues/${issue.number}/comments`, { per_page: 100 })) {
        const chunk = commentChunk(comment, chunks.length, reporter);
        if (chunk) chunks.push(chunk);
      }
    }

    yield {
      source: 'issue',
      provider: 'github',
      origin: repo,
      sourceId: String(issue.number),
      url: issue.html_url,
      title: issue.title,
      audience: 'user',
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      outcome: {
        state: issue.state,
        stateReason: issue.state_reason ?? null,
        labels: (issue.labels ?? []).map((/** @type {any} */ l) => l.name),
        closedAt: issue.closed_at ?? null,
        reactions: { up: issue.reactions?.['+1'] ?? 0, down: issue.reactions?.['-1'] ?? 0 },
      },
      extra: { reporter },
      chunks,
    };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && node --test test/providers/github/issues.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Hand over for commit**

Files to stage: `bot-scripts/src/providers/types.js`, `bot-scripts/src/providers/github/issues.js`, the two fixtures, `bot-scripts/test/providers/github/issues.test.js`. Suggested message: `Add GitHub issues reader`.

---

### Task 9: Docs reader from a local checkout

**Files:**
- Create: `bot-scripts/src/providers/github/docs.js`
- Test: `bot-scripts/test/providers/github/docs.test.js`
- Test fixtures: `bot-scripts/test/fixtures/docs/widgets.md`, `bot-scripts/test/fixtures/docs/android/index.md`, `bot-scripts/test/fixtures/docs/android/debugging.md`, `bot-scripts/test/fixtures/docs/legal.mdx`

**Interfaces:**
- Consumes: `chunkMarkdown` (Task 4).
- Produces: `readDocs({ repo, checkoutPath, options }) => AsyncGenerator<IndexItem>` with `source: 'docs'`, one `section` chunk per markdown chunk, `createdAt` fixed to `DOCS_EPOCH = '1970-01-01T00:00:00Z'` (docs carry no date; retrieval never applies date decay to `docs`).
- URL rule: `baseUrl` + relative directory + page name, where page name is front matter `id` or `slug` when present, else the file name without extension; an `index` page maps to its directory; a `slug` starting with `/` replaces the whole path after the base origin.

- [ ] **Step 1: Write the fixtures and the failing tests**

`bot-scripts/test/fixtures/docs/widgets.md`:

```markdown
---
title: "Android Widgets"
id: 'android-widgets'
---

The Android app allows widgets on the home screen.

## Available widgets

Entity state, template, media player.
```

`bot-scripts/test/fixtures/docs/android/index.md`:

```markdown
---
title: Android overview
---

Overview text.
```

`bot-scripts/test/fixtures/docs/android/debugging.md`:

```markdown
---
title: Android debug tools
description: The developer playground and LeakCanary in debug builds.
slug: /tools/debugging
---

# Debug tools

Use the playground.
```

`bot-scripts/test/fixtures/docs/legal.mdx`:

```markdown
---
title: Legal
draft: true
---

Not indexed.
```

`bot-scripts/test/providers/github/docs.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readDocs, DOCS_EPOCH } from '../../../src/providers/github/docs.js';

const checkout = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const options = { path: 'docs', baseUrl: 'https://example.test/docs/', audience: 'developer' };

async function collect() {
  const out = [];
  for await (const item of readDocs({ repo: 'o/docs', checkoutPath: checkout, options })) out.push(item);
  return out.sort((a, b) => a.url.localeCompare(b.url));
}

test('derives URLs from id, directory index and absolute slug', async () => {
  const urls = (await collect()).map((i) => i.url);
  assert.deepEqual(urls, [
    'https://example.test/docs/android',
    'https://example.test/docs/android-widgets',
    'https://example.test/tools/debugging',
  ]);
});

test('absolute slug overrides path', async () => {
  const debug = (await collect()).find((i) => i.title === 'Android debug tools');
  assert.equal(debug.url, 'https://example.test/tools/debugging');
  assert.equal(debug.sourceId, 'docs/android/debugging.md');
});

test('chunks sections with anchors, title, audience and the docs epoch', async () => {
  const widgets = (await collect()).find((i) => i.sourceId === 'docs/widgets.md');
  assert.equal(widgets.source, 'docs');
  assert.equal(widgets.audience, 'developer');
  assert.equal(widgets.createdAt, DOCS_EPOCH);
  assert.equal(widgets.chunks.length, 2);
  assert.equal(widgets.chunks[1].anchor, 'available-widgets');
  assert.equal(widgets.chunks[1].heading, 'Available widgets');
  assert.equal(widgets.chunks[1].kind, 'section');
  assert.equal(widgets.extra.description, null);
});

test('skips drafts', async () => {
  assert.ok((await collect()).every((i) => i.title !== 'Legal'));
});

test('fails clearly when the checkout path is missing', async () => {
  await assert.rejects(async () => {
    for await (const _ of readDocs({ repo: 'o/docs', checkoutPath: '/nonexistent', options })) { /* drain */ }
  }, /checkout.*o\/docs/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot-scripts && node --test test/providers/github/docs.test.js`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Write the reader**

`bot-scripts/src/providers/github/docs.js`:

```js
// @ts-check
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep, basename, dirname, extname } from 'node:path';
import YAML from 'yaml';
import { chunkMarkdown } from '../../text/chunk.js';

/** @typedef {import('../types.js').IndexItem} IndexItem */

/** Docs carry no creation date; this sentinel keeps them eligible for every as-of query. */
export const DOCS_EPOCH = '1970-01-01T00:00:00Z';
const EXTENSIONS = new Set(['.md', '.mdx']);
const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n?/;

/**
 * @param {string} content
 * @returns {{ frontMatter: Record<string, any>, body: string }}
 */
export function splitFrontMatter(content) {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = FRONT_MATTER.exec(normalized);
  if (!match) return { frontMatter: {}, body: normalized };
  let frontMatter = {};
  try {
    frontMatter = YAML.parse(match[1]) ?? {};
  } catch {
    frontMatter = {};
  }
  return { frontMatter, body: normalized.slice(match[0].length) };
}

/**
 * @param {string} dir
 * @returns {AsyncGenerator<string>}
 */
async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (EXTENSIONS.has(extname(entry.name))) yield path;
  }
}

/**
 * @param {string} relativePath path relative to the docs root, POSIX separators
 * @param {Record<string, any>} frontMatter
 * @param {string} baseUrl
 */
export function docUrl(relativePath, frontMatter, baseUrl) {
  const base = new URL(baseUrl);
  if (typeof frontMatter.slug === 'string' && frontMatter.slug.startsWith('/')) {
    return new URL(frontMatter.slug, base.origin).toString();
  }
  const dir = dirname(relativePath) === '.' ? '' : `${dirname(relativePath)}/`;
  const file = basename(relativePath, extname(relativePath));
  const name = frontMatter.id ?? frontMatter.slug ?? file;
  const page = name === 'index' ? dir.replace(/\/$/, '') : `${dir}${name}`;
  return new URL(page, base).toString().replace(/\/$/, '');
}

/**
 * @param {string} body
 */
function firstHeading(body) {
  return /^#\s+(.+)$/m.exec(body)?.[1] ?? null;
}

/**
 * Reads markdown documentation from a local checkout as index items.
 * @param {{ repo: string, checkoutPath: string, options: import('../../config/types.js').DocsConfig }} input
 * @returns {AsyncGenerator<IndexItem>}
 */
export async function* readDocs({ repo, checkoutPath, options }) {
  const root = join(checkoutPath, options.path);
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new Error(`Docs checkout for ${repo} not found at ${root}; pass --checkout ${repo}=<path>`);
  }
  for await (const file of walk(root)) {
    const { frontMatter, body } = splitFrontMatter(await readFile(file, 'utf8'));
    if (frontMatter.draft === true || frontMatter.pagefind === false) continue;
    const rel = relative(root, file).split(sep).join('/');
    const title = frontMatter.title ?? firstHeading(body) ?? basename(file, extname(file));
    const chunks = chunkMarkdown(body).map((c, seq) => ({
      seq,
      kind: /** @type {const} */ ('section'),
      heading: c.heading,
      anchor: c.anchor,
      text: [...c.breadcrumbs, c.text].join('\n'),
      logs: null,
      createdAt: DOCS_EPOCH,
    }));
    if (chunks.length === 0) continue;
    yield {
      source: 'docs',
      provider: 'github',
      origin: repo,
      sourceId: `${options.path}/${rel}`,
      url: docUrl(rel, frontMatter, options.baseUrl),
      title: String(title),
      audience: options.audience,
      createdAt: DOCS_EPOCH,
      updatedAt: null,
      outcome: null,
      extra: { description: frontMatter.description ?? null },
      chunks,
    };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && node --test test/providers/github/docs.test.js`
Expected: PASS, 5 tests. If the URL for `android/index.md` comes out with a trailing slash, the `replace(/\/$/, '')` is the place to look.

- [ ] **Step 5: Hand over for commit**

Files to stage: `bot-scripts/src/providers/github/docs.js`, the four fixtures, `bot-scripts/test/providers/github/docs.test.js`. Suggested message: `Add docs reader for local checkouts`.

---

### Task 10: Index writer with vector reuse

**Files:**
- Create: `bot-scripts/src/store/writer.js`
- Test: `bot-scripts/test/store/writer.test.js`

**Interfaces:**
- Consumes: `openDatabase`, `createSchema`, `readMeta` (Task 2), `quantizeInt8`, `toBlob`, `fromBlob` (Task 2), `Embedder` (Task 6), `IndexItem` (Task 8).
- Produces: `writeIndex({ items, embedder, outPath, previousPath, meta, log }) => Promise<{ items: number, chunks: number, embedded: number, reused: number }>` where `items` is an `AsyncIterable<IndexItem>`. Builds `${outPath}.tmp`, renames on success. Chunk hash is `sha256(kind + heading + text + logs)`. Vectors for unchanged hashes come from `previousPath` when its `model_key` equals `embedder.modelKey`.
- Also `chunkHash(chunk) => string`.

- [ ] **Step 1: Write the failing tests**

`bot-scripts/test/store/writer.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeIndex, chunkHash } from '../../src/store/writer.js';
import { openDatabase, readMeta } from '../../src/store/db.js';

const tmp = mkdtempSync(join(tmpdir(), 'kb-writer-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

function fakeEmbedder(modelKey = 'fake@1@q8@cls', calls = []) {
  return {
    modelKey,
    dimensions: 4,
    async embed(texts) {
      calls.push(texts);
      return texts.map((t) => Float32Array.from([t.length % 2, (t.length + 1) % 2, 0, 0]));
    },
  };
}

function item(sourceId, text, extraChunks = []) {
  return {
    source: 'issue', provider: 'github', origin: 'o/r', sourceId, url: `https://x/${sourceId}`, title: `Issue ${sourceId}`,
    audience: 'user', createdAt: '2025-01-01T00:00:00Z', updatedAt: null, outcome: { state: 'open' }, extra: null,
    chunks: [{ seq: 0, kind: 'body', text, logs: null, createdAt: '2025-01-01T00:00:00Z' }, ...extraChunks],
  };
}

async function* of(...items) { yield* items; }

test('writes items, chunks, vectors, fts and meta atomically', async () => {
  const out = join(tmp, 'a.sqlite');
  const calls = [];
  const stats = await writeIndex({ items: of(item('1', 'widget stops'), item('2', 'notification fails')), embedder: fakeEmbedder(undefined, calls), outPath: out, meta: { product: 'android', config_hash: 'c1' } });
  assert.deepEqual(stats, { items: 2, chunks: 2, embedded: 2, reused: 0 });
  assert.ok(!existsSync(`${out}.tmp`));
  const db = openDatabase(out, { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) c FROM vec_chunks').get().c, 2);
  assert.deepEqual(db.prepare(`SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH '"notification"'`).all().map((r) => r.rowid), [2]);
  const meta = readMeta(db);
  assert.equal(meta.model_key, 'fake@1@q8@cls');
  assert.equal(meta.product, 'android');
  assert.equal(meta.chunk_count, '2');
  assert.ok(meta.built_at);
  db.close();
});

test('reuses vectors for unchanged chunks from the previous index', async () => {
  const previous = join(tmp, 'prev.sqlite');
  await writeIndex({ items: of(item('1', 'widget stops')), embedder: fakeEmbedder(), outPath: previous, meta: {} });
  const calls = [];
  const out = join(tmp, 'b.sqlite');
  const stats = await writeIndex({ items: of(item('1', 'widget stops'), item('3', 'new text')), embedder: fakeEmbedder(undefined, calls), outPath: out, previousPath: previous, meta: {} });
  assert.deepEqual(stats, { items: 2, chunks: 2, embedded: 1, reused: 1 });
  assert.deepEqual(calls.flat(), ['new text']);
});

test('does not reuse vectors from another model', async () => {
  const previous = join(tmp, 'prev-other.sqlite');
  await writeIndex({ items: of(item('1', 'widget stops')), embedder: fakeEmbedder('other@1@q8@cls'), outPath: previous, meta: {} });
  const calls = [];
  const stats = await writeIndex({ items: of(item('1', 'widget stops')), embedder: fakeEmbedder('fake@1@q8@cls', calls), outPath: join(tmp, 'c.sqlite'), previousPath: previous, meta: {} });
  assert.equal(stats.reused, 0);
  assert.equal(calls.flat().length, 1);
});

test('skips chunks with empty text', async () => {
  const calls = [];
  const stats = await writeIndex({ items: of(item('1', '', [{ seq: 1, kind: 'comment', text: 'real', logs: null, createdAt: '2025-01-02T00:00:00Z' }])), embedder: fakeEmbedder(undefined, calls), outPath: join(tmp, 'd.sqlite'), meta: {} });
  assert.equal(stats.chunks, 1);
  assert.deepEqual(calls.flat(), ['real']);
});

test('leaves no output when a provider throws', async () => {
  const out = join(tmp, 'e.sqlite');
  async function* failing() { yield item('1', 'x'); throw new Error('provider down'); }
  await assert.rejects(() => writeIndex({ items: failing(), embedder: fakeEmbedder(), outPath: out, meta: {} }), /provider down/);
  assert.ok(!existsSync(out));
  assert.ok(!existsSync(`${out}.tmp`));
});

test('chunkHash changes with text and kind only', () => {
  const a = chunkHash({ kind: 'body', heading: null, text: 'x', logs: null });
  assert.equal(a, chunkHash({ kind: 'body', heading: null, text: 'x', logs: null, createdAt: 'ignored' }));
  assert.notEqual(a, chunkHash({ kind: 'comment', heading: null, text: 'x', logs: null }));
  assert.notEqual(a, chunkHash({ kind: 'body', heading: null, text: 'y', logs: null }));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot-scripts && node --test test/store/writer.test.js`
Expected: FAIL with `Cannot find module '../../src/store/writer.js'`.

- [ ] **Step 3: Write the writer**

`bot-scripts/src/store/writer.js`:

```js
// @ts-check
import { createHash } from 'node:crypto';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { openDatabase, createSchema, readMeta } from './db.js';
import { quantizeInt8, toBlob } from './vectors.js';

/** @typedef {import('../providers/types.js').IndexItem} IndexItem */
/** @typedef {import('../providers/types.js').IndexChunk} IndexChunk */
/** @typedef {import('../embed/embedder.js').Embedder} Embedder */

const EMBED_BATCH = 256;

/**
 * Content hash of a chunk; vectors are reused across builds when it is unchanged.
 * @param {Pick<IndexChunk, 'kind'|'heading'|'text'|'logs'>} chunk
 */
export function chunkHash(chunk) {
  return createHash('sha256')
    .update(chunk.kind).update('\0')
    .update(chunk.heading ?? '').update('\0')
    .update(chunk.text).update('\0')
    .update(chunk.logs ?? '')
    .digest('hex');
}

/**
 * Loads hash -> vector blob from a previous index built with the same model.
 * @param {string | undefined} previousPath
 * @param {string} modelKey
 * @returns {Map<string, Uint8Array>}
 */
function loadPreviousVectors(previousPath, modelKey) {
  const vectors = new Map();
  if (!previousPath || !existsSync(previousPath)) return vectors;
  const db = openDatabase(previousPath, { readOnly: true });
  try {
    if (readMeta(db).model_key !== modelKey) return vectors;
    const rows = /** @type {{ hash: string, embedding: Uint8Array }[]} */ (
      db.prepare('SELECT c.hash, v.embedding FROM chunks c JOIN vec_chunks v ON v.chunk_id = c.id').all()
    );
    for (const row of rows) vectors.set(row.hash, row.embedding);
  } finally {
    db.close();
  }
  return vectors;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
function statements(db) {
  return {
    item: db.prepare(`INSERT INTO items (source, provider, origin, source_id, url, title, audience, created_at, updated_at, outcome, extra)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    chunk: db.prepare(`INSERT INTO chunks (item_id, seq, kind, heading, anchor, text, logs, created_at, hash)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    vector: db.prepare('INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, vec_int8(?))'),
    meta: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
  };
}

/**
 * Builds a new index file from a stream of items. Writes to `<outPath>.tmp` and
 * renames on success, so a failure never destroys the previous index.
 * @param {{ items: AsyncIterable<IndexItem>, embedder: Embedder, outPath: string, previousPath?: string, meta?: Record<string, string>, log?: (line: string) => void }} input
 */
export async function writeIndex({ items, embedder, outPath, previousPath, meta = {}, log = () => {} }) {
  const tmpPath = `${outPath}.tmp`;
  rmSync(tmpPath, { force: true });
  const previous = loadPreviousVectors(previousPath, embedder.modelKey);
  const db = openDatabase(tmpPath);
  const stats = { items: 0, chunks: 0, embedded: 0, reused: 0 };
  /** @type {{ chunkId: bigint, text: string }[]} */
  let pending = [];

  const flush = async () => {
    if (pending.length === 0) return;
    const vectors = await embedder.embed(pending.map((p) => p.text));
    db.exec('BEGIN');
    pending.forEach((p, i) => stmt.vector.run(p.chunkId, toBlob(quantizeInt8(vectors[i]))));
    db.exec('COMMIT');
    stats.embedded += pending.length;
    pending = [];
  };

  try {
    createSchema(db, { dimensions: embedder.dimensions });
    var stmt = statements(db);
    for await (const item of items) {
      db.exec('BEGIN');
      const itemId = stmt.item.run(item.source, item.provider, item.origin, item.sourceId, item.url, item.title, item.audience,
        item.createdAt, item.updatedAt ?? null, item.outcome ? JSON.stringify(item.outcome) : null,
        item.extra ? JSON.stringify(item.extra) : null).lastInsertRowid;
      stats.items += 1;
      for (const chunk of item.chunks) {
        if (!chunk.text.trim()) continue;
        const hash = chunkHash(chunk);
        const chunkId = BigInt(stmt.chunk.run(itemId, chunk.seq, chunk.kind, chunk.heading ?? null, chunk.anchor ?? null,
          chunk.text, chunk.logs ?? null, chunk.createdAt, hash).lastInsertRowid);
        stats.chunks += 1;
        const known = previous.get(hash);
        if (known) {
          stmt.vector.run(chunkId, known);
          stats.reused += 1;
        } else {
          pending.push({ chunkId, text: chunk.text });
        }
      }
      db.exec('COMMIT');
      if (pending.length >= EMBED_BATCH) await flush();
    }
    await flush();
    db.exec(`INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')`);
    const finalMeta = { ...meta, model_key: embedder.modelKey, built_at: new Date().toISOString(), item_count: String(stats.items), chunk_count: String(stats.chunks) };
    for (const [key, value] of Object.entries(finalMeta)) stmt.meta.run(key, value);
    db.exec('VACUUM');
    db.close();
    renameSync(tmpPath, outPath);
    log(`index written: ${stats.items} items, ${stats.chunks} chunks, ${stats.embedded} embedded, ${stats.reused} reused`);
    return stats;
  } catch (error) {
    try { db.close(); } catch { /* already closed */ }
    rmSync(tmpPath, { force: true });
    throw error;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && node --test test/store/writer.test.js`
Expected: PASS, 6 tests. Note the `var stmt` inside `try`: the `flush` closure needs it; if a linter later objects, hoist `stmt` to a `let` above `flush`.

- [ ] **Step 5: Hand over for commit**

Files to stage: `bot-scripts/src/store/writer.js`, `bot-scripts/test/store/writer.test.js`. Suggested message: `Add atomic index writer with vector reuse`.

---

### Task 11: Provider registry, build orchestrator and build CLI

**Files:**
- Create: `bot-scripts/src/providers/github/index.js`
- Create: `bot-scripts/src/providers/registry.js`
- Create: `bot-scripts/src/index/build.js`
- Create: `bot-scripts/src/cli/build.js`
- Test: `bot-scripts/test/index/build.test.js`

**Interfaces:**
- Consumes: `loadConfig` (Task 3), `createEmbedder` (Task 6), `createGitHubClient` (Task 7), `readIssues` (Task 8), `readDocs` (Task 9), `writeIndex` (Task 10).
- Produces:
  - `createGithubProvider(repoConfigs, { client, checkouts, now }) => Provider` yielding issues then docs per repository, in config order.
  - `createProviders(config, deps) => Provider[]` from the registry `{ github: createGithubProvider }`; `deps = { githubToken, fetchImpl, checkouts, now }`.
  - `buildIndex({ config, configHash, outPath, previousPath, embedder, providers, log }) => Promise<stats>` concatenating provider streams into `writeIndex` with `meta = { product, config_hash, format_version }`.
  - CLI: `node src/cli/build.js --config <yaml> --out <sqlite> [--previous <sqlite>] [--checkout owner/repo=<dir>]... [--model-cache <dir>]`, token from `GITHUB_TOKEN`.

- [ ] **Step 1: Write the failing test**

`bot-scripts/test/index/build.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config/load.js';
import { buildIndex } from '../../src/index/build.js';
import { createProviders } from '../../src/providers/registry.js';
import { openDatabase, readMeta } from '../../src/store/db.js';

const tmp = mkdtempSync(join(tmpdir(), 'kb-build-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));
const issuesPage = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(join(fixtures, 'github/issues-page.json'), 'utf8')));

const fakeFetch = async (url) => {
  const u = String(url);
  if (u.includes('/repos/home-assistant/android/issues?')) return Response.json(issuesPage);
  if (u.includes('/comments')) return Response.json([]);
  return new Response('nope', { status: 404 });
};

const embedder = { modelKey: 'fake@1@q8@cls', dimensions: 4, async embed(texts) { return texts.map(() => Float32Array.from([1, 0, 0, 0])); } };

test('builds an index from the android fixture config with issues and docs', async () => {
  const config = loadConfig(join(fixtures, 'config/android.yaml'));
  // point both docs repositories at the docs fixture directory
  const checkouts = { 'home-assistant/companion.home-assistant': fixtures, 'home-assistant/contributors.home-assistant.io': fixtures };
  config.providers.github['home-assistant/companion.home-assistant'].docs.path = 'docs';
  config.providers.github['home-assistant/contributors.home-assistant.io'].docs.path = 'docs/android';
  const providers = createProviders(config, { githubToken: 't', fetchImpl: fakeFetch, checkouts, now: new Date('2026-10-15T00:00:00Z') });
  const out = join(tmp, 'knowledge.sqlite');
  const stats = await buildIndex({ config, configHash: 'abc', outPath: out, embedder, providers });
  assert.equal(stats.items, 1 + 3 + 2);
  const db = openDatabase(out, { readOnly: true });
  const sources = db.prepare('SELECT source, count(*) c FROM items GROUP BY source ORDER BY source').all();
  assert.deepEqual(sources, [{ source: 'docs', c: 5 }, { source: 'issue', c: 1 }]);
  const meta = readMeta(db);
  assert.equal(meta.product, 'android');
  assert.equal(meta.config_hash, 'abc');
  db.close();
});

test('fails when a configured provider has no checkout for a docs repository', async () => {
  const config = loadConfig(join(fixtures, 'config/android.yaml'));
  const providers = createProviders(config, { githubToken: 't', fetchImpl: fakeFetch, checkouts: {}, now: new Date() });
  await assert.rejects(() => buildIndex({ config, configHash: 'x', outPath: join(tmp, 'never.sqlite'), embedder, providers }), /checkout/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd bot-scripts && node --test test/index/build.test.js`
Expected: FAIL with `Cannot find module '../../src/index/build.js'`.

- [ ] **Step 3: Write the provider, the registry, the orchestrator and the CLI**

`bot-scripts/src/providers/github/index.js`:

```js
// @ts-check
import { readIssues } from './issues.js';
import { readDocs } from './docs.js';

/** @typedef {import('../types.js').Provider} Provider */

/**
 * One provider for every repository under `providers.github`.
 * @param {Record<string, import('../../config/types.js').GithubRepoConfig>} repos
 * @param {{ client: { paginate(path: string, params?: object): AsyncIterable<any> }, checkouts: Record<string, string>, now: Date }} deps
 * @returns {Provider}
 */
export function createGithubProvider(repos, { client, checkouts, now }) {
  return {
    name: 'github',
    async *items() {
      for (const [repo, repoConfig] of Object.entries(repos)) {
        if (repoConfig.issues) yield* readIssues({ client, repo, options: repoConfig.issues, now });
        if (repoConfig.docs) {
          const checkoutPath = checkouts[repo];
          if (!checkoutPath) throw new Error(`No checkout for ${repo}; pass --checkout ${repo}=<path>`);
          yield* readDocs({ repo, checkoutPath, options: repoConfig.docs });
        }
      }
    },
  };
}
```

`bot-scripts/src/providers/registry.js`:

```js
// @ts-check
import { createGitHubClient } from './github/client.js';
import { createGithubProvider } from './github/index.js';

/** @typedef {import('./types.js').Provider} Provider */

/**
 * Builds the provider list for a config. The registry is the only place that
 * knows which top-level key maps to which factory.
 * @param {import('../config/types.js').Config} config
 * @param {{ githubToken?: string, fetchImpl?: typeof fetch, checkouts?: Record<string, string>, now?: Date }} deps
 * @returns {Provider[]}
 */
export function createProviders(config, { githubToken, fetchImpl, checkouts = {}, now = new Date() }) {
  const providers = /** @type {Provider[]} */ ([]);
  if (config.providers.github) {
    if (!githubToken) throw new Error('GITHUB_TOKEN is required for the github provider');
    const client = createGitHubClient({ token: githubToken, fetchImpl });
    providers.push(createGithubProvider(config.providers.github, { client, checkouts, now }));
  }
  return providers;
}
```

`bot-scripts/src/index/build.js`:

```js
// @ts-check
import { writeIndex } from '../store/writer.js';
import { FORMAT_VERSION } from '../store/db.js';

/**
 * @param {import('../providers/types.js').Provider[]} providers
 * @param {(line: string) => void} log
 */
async function* concat(providers, log) {
  for (const provider of providers) {
    let count = 0;
    for await (const item of provider.items()) {
      count += 1;
      yield item;
    }
    log(`${provider.name}: ${count} items`);
  }
}

/**
 * Builds the index file for a config from its providers.
 * @param {{ config: import('../config/types.js').Config, configHash: string, outPath: string, previousPath?: string, embedder: import('../embed/embedder.js').Embedder, providers: import('../providers/types.js').Provider[], log?: (line: string) => void }} input
 */
export function buildIndex({ config, configHash, outPath, previousPath, embedder, providers, log = () => {} }) {
  return writeIndex({
    items: concat(providers, log),
    embedder,
    outPath,
    previousPath,
    meta: { product: config.product.slug, config_hash: configHash, format_version: String(FORMAT_VERSION) },
    log,
  });
}
```

`bot-scripts/src/cli/build.js`:

```js
#!/usr/bin/env node
// @ts-check
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../config/load.js';
import { createEmbedder } from '../embed/embedder.js';
import { createProviders } from '../providers/registry.js';
import { buildIndex } from '../index/build.js';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    out: { type: 'string' },
    previous: { type: 'string' },
    checkout: { type: 'string', multiple: true, default: [] },
    'model-cache': { type: 'string', default: '.model-cache' },
  },
});

if (!values.config || !values.out) {
  console.error('usage: build --config <knowledge-bot.yaml> --out <knowledge.sqlite> [--previous <sqlite>] [--checkout owner/repo=<dir>]...');
  process.exit(2);
}

const checkouts = Object.fromEntries(values.checkout.map((pair) => {
  const [repo, dir] = pair.split('=');
  if (!repo || !dir) throw new Error(`--checkout expects owner/repo=<dir>, got ${pair}`);
  return [repo, dir];
}));

const config = loadConfig(values.config);
const configHash = createHash('sha256').update(readFileSync(values.config)).digest('hex').slice(0, 12);
const embedder = createEmbedder(config.embedding, { cacheDir: values['model-cache'] });
const providers = createProviders(config, { githubToken: process.env.GITHUB_TOKEN, checkouts });
const log = (/** @type {string} */ line) => console.log(line);

const stats = await buildIndex({ config, configHash, outPath: values.out, previousPath: values.previous, embedder, providers, log });
console.log(JSON.stringify(stats));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && node --test test/index/build.test.js`
Expected: PASS, 2 tests. `stats.items` is 6: one issue, three docs fixtures under `docs/` for the companion entry (widgets, android/index, android/debugging; legal is a draft) and two under `docs/android` for the contributors entry.

- [ ] **Step 5: Run the real build once against the android sources**

Run, from `bot-scripts` with `GITHUB_TOKEN=$(gh auth token)`:

```
GITHUB_TOKEN=$(gh auth token) node src/cli/build.js \
  --config ../../android/.github/knowledge-bot.yaml \
  --out ./knowledge-android.sqlite \
  --checkout home-assistant/companion.home-assistant=../../companion.home-assistant \
  --checkout home-assistant/contributors.home-assistant.io=../../contributors.home-assistant.io
```

The android config file is created in Task 13; run this step after Task 13 and record the numbers there. Expected on first run: a few minutes of API calls for about 1100 issues and their comments, a few minutes of embedding, and a `knowledge-android.sqlite` of a few tens of MB.

- [ ] **Step 6: Hand over for commit**

Files to stage: `bot-scripts/src/providers/github/index.js`, `bot-scripts/src/providers/registry.js`, `bot-scripts/src/index/build.js`, `bot-scripts/src/cli/build.js`, `bot-scripts/test/index/build.test.js`. Suggested message: `Add provider registry, build orchestrator and build CLI`.

---

### Task 12: Hybrid retrieval

**Files:**
- Create: `bot-scripts/src/retrieval/fts.js`
- Create: `bot-scripts/src/retrieval/rrf.js`
- Create: `bot-scripts/src/retrieval/retrieve.js`
- Test: `bot-scripts/test/retrieval/fts.test.js`
- Test: `bot-scripts/test/retrieval/rrf.test.js`
- Test: `bot-scripts/test/retrieval/retrieve.test.js`

**Interfaces:**
- Consumes: `openDatabase`, `readMeta` (Task 2), `quantizeInt8`, `toBlob`, `cosineFromL2` (Task 2), `Embedder` (Task 6), `writeIndex` for test fixtures (Task 10).
- Produces:
  - `toFtsQuery(question) => string | null`: every token of two or more characters quoted and joined with `OR`; `null` when nothing is indexable.
  - `fuse(lists, { k = 60 }) => Map<id, number>` where `lists = { weight, ids: (number|bigint)[] }[]`.
  - `retrieve(db, embedder, question, options) => Promise<RetrievalResult[]>` with `options = { k = 8, candidates = 50, sourceWeights = {}, decayAfterDays = 730, decayFactor = 0.7, asOf?: string, excludeItemId?: number, liveLists?: { weight, ids }[] }` and

```js
/** @typedef {{ itemId: number, chunkId: number, source: string, provider: string, origin: string, sourceId: string, url: string, title: string, heading: string|null, anchor: string|null, text: string, createdAt: string, audience: string, outcome: object|null, scores: { similarity: number|null, lexical: number|null, fused: number }, rank: number }} RetrievalResult */
```

  - `retrieve` also returns `results.bestSimilarity` (number, 0 when the dense list is empty) for the gate.

- [ ] **Step 1: Write the failing tests**

`bot-scripts/test/retrieval/fts.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toFtsQuery } from '../../src/retrieval/fts.js';

test('quotes tokens and joins them with OR', () => {
  assert.equal(toFtsQuery('Widget not updating: binary_sensor.motion_detected!'), '"widget" OR "not" OR "updating" OR "binary_sensor.motion_detected"');
});

test('returns null for a question without indexable tokens', () => {
  assert.equal(toFtsQuery('?? !! a'), null);
});

test('never emits unbalanced quotes', () => {
  assert.equal(toFtsQuery('say "hi" there'), '"say" OR "hi" OR "there"');
});
```

`bot-scripts/test/retrieval/rrf.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuse } from '../../src/retrieval/rrf.js';

test('an id present in both lists outranks one present in a single list', () => {
  const scores = fuse([{ weight: 1, ids: [1, 2, 3] }, { weight: 1, ids: [3, 4] }], { k: 60 });
  assert.ok(scores.get(3) > scores.get(1));
  assert.ok(scores.get(1) > scores.get(4));
});

test('weights scale a list contribution and bigint ids normalize to numbers', () => {
  const scores = fuse([{ weight: 0.5, ids: [1n] }, { weight: 1, ids: [2n] }]);
  assert.ok(scores.get(2) > scores.get(1));
  assert.equal(scores.has(1n), false);
});
```

`bot-scripts/test/retrieval/retrieve.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeIndex } from '../../src/store/writer.js';
import { openDatabase } from '../../src/store/db.js';
import { retrieve } from '../../src/retrieval/retrieve.js';

const tmp = mkdtempSync(join(tmpdir(), 'kb-retrieve-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

/** Vectors by keyword so tests control similarity: widget -> e1, notification -> e2, else e3. */
const vectorFor = (text) => {
  const t = text.toLowerCase();
  if (t.includes('widget')) return Float32Array.from([1, 0, 0, 0]);
  if (t.includes('notification')) return Float32Array.from([0, 1, 0, 0]);
  return Float32Array.from([0, 0, 1, 0]);
};
const embedder = { modelKey: 'fake@1@q8@cls', dimensions: 4, async embed(texts) { return texts.map(vectorFor); } };

const item = (sourceId, source, title, text, createdAt, extra = {}) => ({
  source, provider: 'github', origin: 'o/r', sourceId, url: `https://x/${source}/${sourceId}`, title, audience: 'user',
  createdAt, updatedAt: null, outcome: source === 'issue' ? { state: 'closed' } : null, extra: null,
  chunks: [{ seq: 0, kind: source === 'docs' ? 'section' : 'body', heading: extra.heading ?? null, anchor: null, text, logs: extra.logs ?? null, createdAt }],
});

const indexPath = join(tmp, 'knowledge.sqlite');
test.before(async () => {
  async function* items() {
    yield item('1', 'issue', 'Widget stops after reboot', 'Widget stops after reboot', '2025-03-01T00:00:00Z', { logs: 'E/EntityWidget: refresh failed' });
    yield item('2', 'issue', 'Notification sound missing', 'Notification sound missing', '2025-04-01T00:00:00Z');
    yield item('3', 'issue', 'Old widget bug', 'Widget stops on old phones', '2021-01-01T00:00:00Z');
    yield item('widgets', 'docs', 'Android Widgets', 'Widgets refresh on tap', '1970-01-01T00:00:00Z', { heading: 'Refresh' });
    yield item('4', 'issue', 'Future widget issue', 'Widget stops updating', '2026-01-01T00:00:00Z');
  }
  await writeIndex({ items: items(), embedder, outPath: indexPath, meta: {} });
});

test('ranks dense and lexical matches and reports scores', async () => {
  const db = openDatabase(indexPath, { readOnly: true });
  const results = await retrieve(db, embedder, 'widget stops updating', { k: 5, now: new Date('2026-10-15T00:00:00Z') });
  db.close();
  assert.ok(results.length >= 3);
  assert.ok(results.every((r) => r.source !== 'issue' || r.sourceId !== '2'));
  assert.equal(results[0].rank, 1);
  assert.ok(results[0].scores.similarity > 0.9);
  assert.ok(results.bestSimilarity > 0.9);
  const widget = results.find((r) => r.sourceId === '1');
  assert.deepEqual(widget.outcome, { state: 'closed' });
});

test('finds an error string through the logs column', async () => {
  const db = openDatabase(indexPath, { readOnly: true });
  const results = await retrieve(db, embedder, 'E/EntityWidget', { k: 3 });
  db.close();
  assert.equal(results[0].sourceId, '1');
  assert.ok(results[0].scores.lexical !== null);
});

test('as-of filter hides later items and the excluded item', async () => {
  const db = openDatabase(indexPath, { readOnly: true });
  const results = await retrieve(db, embedder, 'widget stops', { k: 10, asOf: '2025-06-01T00:00:00Z', excludeItemId: 1 });
  db.close();
  const ids = results.map((r) => r.sourceId);
  assert.ok(!ids.includes('4'), 'later item hidden');
  assert.ok(!ids.includes('1'), 'excluded item hidden');
  assert.ok(ids.includes('widgets'), 'docs always eligible');
});

test('date decay lowers an old issue below a recent equivalent, never docs', async () => {
  const db = openDatabase(indexPath, { readOnly: true });
  const results = await retrieve(db, embedder, 'widget stops', { k: 10, now: new Date('2026-10-15T00:00:00Z') });
  db.close();
  const pos = (id) => results.findIndex((r) => r.sourceId === id);
  assert.ok(pos('1') < pos('3'), 'recent before old');
});

test('question without indexable tokens still returns dense results', async () => {
  const db = openDatabase(indexPath, { readOnly: true });
  const results = await retrieve(db, embedder, '?? !!', { k: 3 });
  db.close();
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.scores.lexical === null));
});

test('source weights change the order', async () => {
  const db = openDatabase(indexPath, { readOnly: true });
  const plain = await retrieve(db, embedder, 'widget', { k: 10 });
  const docsFirst = await retrieve(db, embedder, 'widget', { k: 10, sourceWeights: { docs: 3, issue: 0.2 } });
  db.close();
  assert.notEqual(plain[0].sourceId, docsFirst[0].sourceId);
  assert.equal(docsFirst[0].source, 'docs');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot-scripts && node --test test/retrieval/`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Write the three modules**

`bot-scripts/src/retrieval/fts.js`:

```js
// @ts-check

const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}\-._:/]*/gu;

/**
 * FTS5 query for a free-text question: each token quoted, joined with OR, so
 * user text can never be parsed as FTS5 syntax.
 * @param {string} question
 * @returns {string | null}
 */
export function toFtsQuery(question) {
  const tokens = Array.from(question.toLowerCase().matchAll(TOKEN), (m) => m[0].replace(/"/g, '')).filter((t) => t.length >= 2);
  if (tokens.length === 0) return null;
  return Array.from(new Set(tokens), (t) => `"${t}"`).join(' OR ');
}
```

`bot-scripts/src/retrieval/rrf.js`:

```js
// @ts-check

/**
 * Reciprocal rank fusion over ranked id lists.
 * @param {{ weight: number, ids: (number|bigint)[] }[]} lists
 * @param {{ k?: number }} [options]
 * @returns {Map<number, number>}
 */
export function fuse(lists, { k = 60 } = {}) {
  const scores = new Map();
  for (const { weight, ids } of lists) {
    ids.forEach((raw, rank) => {
      const id = Number(raw);
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + rank + 1));
    });
  }
  return scores;
}
```

`bot-scripts/src/retrieval/retrieve.js`:

```js
// @ts-check
import { quantizeInt8, toBlob, cosineFromL2 } from '../store/vectors.js';
import { readMeta } from '../store/db.js';
import { toFtsQuery } from './fts.js';
import { fuse } from './rrf.js';

/** Sources whose entries age; docs and code never decay. */
const DATED_SOURCES = new Set(['issue', 'pull', 'discussion', 'forum']);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {{ itemId: number, chunkId: number, source: string, provider: string, origin: string, sourceId: string, url: string, title: string, heading: string|null, anchor: string|null, text: string, createdAt: string, audience: string, outcome: object|null, scores: { similarity: number|null, lexical: number|null, fused: number }, rank: number }} RetrievalResult
 */

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ asOf?: string, excludeItemId?: number }} options
 */
function filters({ asOf, excludeItemId }) {
  const clauses = [];
  const params = [];
  if (asOf) { clauses.push('c.created_at < ?'); params.push(asOf); }
  if (excludeItemId !== undefined) { clauses.push('c.item_id != ?'); params.push(excludeItemId); }
  return { where: clauses.length ? `AND ${clauses.join(' AND ')}` : '', params };
}

/**
 * Hybrid retrieval: vector KNN and FTS5 fused with reciprocal rank fusion,
 * weighted per source, decayed by age, collapsed to the best chunk per item.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {import('../embed/embedder.js').Embedder} embedder
 * @param {string} question
 * @param {{ k?: number, candidates?: number, sourceWeights?: Record<string, number>, decayAfterDays?: number, decayFactor?: number, asOf?: string, excludeItemId?: number, liveLists?: { weight: number, ids: number[] }[], now?: Date }} [options]
 * @returns {Promise<RetrievalResult[] & { bestSimilarity: number }>}
 */
export async function retrieve(db, embedder, question, options = {}) {
  const { k = 8, candidates = 50, sourceWeights = {}, decayAfterDays = 730, decayFactor = 0.7, liveLists = [], now = new Date() } = options;
  const meta = readMeta(db);
  if (meta.model_key !== embedder.modelKey) {
    throw new Error(`Index model ${meta.model_key} does not match configured ${embedder.modelKey}; rebuild the index`);
  }
  const { where, params } = filters(options);

  const [vector] = await embedder.embed([question]);
  const dense = /** @type {{ chunk_id: number, distance: number }[]} */ (db.prepare(
    `SELECT v.chunk_id, v.distance FROM vec_chunks v JOIN chunks c ON c.id = v.chunk_id
     WHERE v.embedding MATCH vec_int8(?) AND k = ? ${where} ORDER BY v.distance`,
  ).all(toBlob(quantizeInt8(vector)), BigInt(candidates * 4), ...params)).slice(0, candidates);
  const similarity = new Map(dense.map((r) => [Number(r.chunk_id), cosineFromL2(r.distance)]));

  const ftsQuery = toFtsQuery(question);
  const lexicalRows = ftsQuery === null ? [] : /** @type {{ id: number, score: number }[]} */ (db.prepare(
    `SELECT c.id, bm25(chunks_fts) AS score FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
     WHERE chunks_fts MATCH ? ${where} ORDER BY score LIMIT ?`,
  ).all(ftsQuery, ...params, candidates));
  const lexical = new Map(lexicalRows.map((r) => [Number(r.id), -r.score]));

  const fused = fuse([
    { weight: 1, ids: dense.map((r) => r.chunk_id) },
    { weight: 1, ids: lexicalRows.map((r) => r.id) },
    ...liveLists,
  ]);
  if (fused.size === 0) return Object.assign([], { bestSimilarity: 0 });

  const ids = Array.from(fused.keys());
  const rows = /** @type {any[]} */ (db.prepare(
    `SELECT c.id AS chunk_id, c.item_id, c.heading, c.anchor, c.text, c.created_at,
            i.source, i.provider, i.origin, i.source_id, i.url, i.title, i.audience, i.outcome
     FROM chunks c JOIN items i ON i.id = c.item_id WHERE c.id IN (${ids.map(() => '?').join(',')})`,
  ).all(...ids));

  const best = new Map();
  for (const row of rows) {
    const ageDays = (now.getTime() - Date.parse(row.created_at)) / DAY_MS;
    const decay = DATED_SOURCES.has(row.source) && ageDays > decayAfterDays ? decayFactor : 1;
    const score = (fused.get(row.chunk_id) ?? 0) * (sourceWeights[row.source] ?? 1) * decay;
    const current = best.get(row.item_id);
    if (!current || score > current.scores.fused) {
      best.set(row.item_id, {
        itemId: row.item_id, chunkId: row.chunk_id, source: row.source, provider: row.provider, origin: row.origin,
        sourceId: row.source_id, url: row.url, title: row.title, heading: row.heading, anchor: row.anchor, text: row.text,
        createdAt: row.created_at, audience: row.audience, outcome: row.outcome ? JSON.parse(row.outcome) : null,
        scores: { similarity: similarity.get(row.chunk_id) ?? null, lexical: lexical.get(row.chunk_id) ?? null, fused: score },
        rank: 0,
      });
    }
  }
  const results = Array.from(best.values()).sort((a, b) => b.scores.fused - a.scores.fused).slice(0, k)
    .map((r, i) => ({ ...r, rank: i + 1 }));
  const bestSimilarity = dense.length ? cosineFromL2(dense[0].distance) : 0;
  return Object.assign(results, { bestSimilarity });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bot-scripts && node --test test/retrieval/`
Expected: PASS, 11 tests. Two things to check if the KNN query errors: sqlite-vec needs `k` as a BigInt and only accepts the `MATCH ... AND k = ?` form in the `WHERE` of the vec0 table, so the extra `where` clauses must apply to the joined `chunks` table, as written. If filtering after the KNN loses too many rows for an as-of query, raise the `candidates * 4` multiplier; the benchmark in plan 1d will tell.

- [ ] **Step 5: Hand over for commit**

Files to stage: `bot-scripts/src/retrieval/fts.js`, `bot-scripts/src/retrieval/rrf.js`, `bot-scripts/src/retrieval/retrieve.js`, the three tests. Suggested message: `Add hybrid retrieval with RRF, source weights and as-of filter`.

---

### Task 13: Query CLI and the android config

**Files:**
- Create: `bot-scripts/src/cli/query.js`
- Create (android repository): `/Users/timo/Documents/ha/android/.github/knowledge-bot.yaml`
- Modify: `README.md` (usage section)
- Test: `bot-scripts/test/cli/query.test.js`

**Interfaces:**
- Consumes: `loadConfig` (Task 3), `createEmbedder` (Task 6), `openDatabase` (Task 2), `retrieve` (Task 12).
- Produces: `node src/cli/query.js --config <yaml> --index <sqlite> [--k 8] [--as-of <iso>] [--json] "<question>"` printing one block per result (rank, source, title, URL, date, scores, excerpt) or a JSON array with `--json`. Exit code 2 on usage errors, 1 on a model mismatch. `formatResults(results, { json }) => string` is exported for the test.

- [ ] **Step 1: Write the failing test**

`bot-scripts/test/cli/query.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatResults } from '../../src/cli/query.js';

const results = Object.assign([
  { rank: 1, source: 'issue', title: 'Widget stops', url: 'https://x/1', createdAt: '2025-03-01T00:00:00Z', heading: null, text: 'Widget stops after reboot', scores: { similarity: 0.91, lexical: 3.2, fused: 0.031 }, outcome: { state: 'closed', stateReason: 'completed' } },
  { rank: 2, source: 'docs', title: 'Android Widgets', url: 'https://x/docs', createdAt: '1970-01-01T00:00:00Z', heading: 'Refresh', text: 'Widgets refresh on tap', scores: { similarity: 0.8, lexical: null, fused: 0.02 }, outcome: null },
], { bestSimilarity: 0.91 });

test('formats a readable block per result', () => {
  const out = formatResults(results, { json: false });
  assert.match(out, /^best similarity 0\.91/m);
  assert.match(out, /1\. \[issue\] Widget stops \(closed, completed, 2025-03-01\)\n\s+https:\/\/x\/1\n\s+similarity 0\.91 · lexical 3\.20 · fused 0\.0310/);
  assert.match(out, /2\. \[docs\] Android Widgets › Refresh\n\s+https:\/\/x\/docs/);
  assert.ok(!out.includes('1970-01-01'));
});

test('json output includes bestSimilarity and the results', () => {
  const parsed = JSON.parse(formatResults(results, { json: true }));
  assert.equal(parsed.bestSimilarity, 0.91);
  assert.equal(parsed.results.length, 2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd bot-scripts && node --test test/cli/query.test.js`
Expected: FAIL with `Cannot find module '../../src/cli/query.js'`.

- [ ] **Step 3: Write the CLI, the android config and the README section**

`bot-scripts/src/cli/query.js`:

```js
#!/usr/bin/env node
// @ts-check
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/load.js';
import { createEmbedder } from '../embed/embedder.js';
import { openDatabase } from '../store/db.js';
import { retrieve } from '../retrieval/retrieve.js';

const DOCS_EPOCH_DATE = '1970-01-01';

/**
 * @param {import('../retrieval/retrieve.js').RetrievalResult[] & { bestSimilarity: number }} results
 * @param {{ json: boolean }} options
 */
export function formatResults(results, { json }) {
  if (json) return JSON.stringify({ bestSimilarity: results.bestSimilarity, results }, null, 2);
  const lines = [`best similarity ${results.bestSimilarity.toFixed(2)}`, ''];
  for (const r of results) {
    const date = r.createdAt.slice(0, 10);
    const meta = [r.outcome?.state, r.outcome?.stateReason, date === DOCS_EPOCH_DATE ? null : date].filter(Boolean).join(', ');
    const title = r.heading ? `${r.title} › ${r.heading}` : r.title;
    lines.push(`${r.rank}. [${r.source}] ${title}${meta ? ` (${meta})` : ''}`);
    lines.push(`   ${r.url}`);
    const lexical = r.scores.lexical === null ? 'none' : r.scores.lexical.toFixed(2);
    const similarity = r.scores.similarity === null ? 'none' : r.scores.similarity.toFixed(2);
    lines.push(`   similarity ${similarity} · lexical ${lexical} · fused ${r.scores.fused.toFixed(4)}`);
    lines.push(`   ${r.text.replace(/\s+/g, ' ').slice(0, 240)}`);
    lines.push('');
  }
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      index: { type: 'string' },
      k: { type: 'string', default: '8' },
      'as-of': { type: 'string' },
      json: { type: 'boolean', default: false },
      'model-cache': { type: 'string', default: '.model-cache' },
    },
  });
  const question = positionals.join(' ').trim();
  if (!values.config || !values.index || !question) {
    console.error('usage: query --config <knowledge-bot.yaml> --index <knowledge.sqlite> [--k 8] [--as-of <iso>] [--json] "<question>"');
    process.exit(2);
  }
  const config = loadConfig(values.config);
  const embedder = createEmbedder(config.embedding, { cacheDir: values['model-cache'] });
  const db = openDatabase(values.index, { readOnly: true });
  try {
    const results = await retrieve(db, embedder, question, { k: Number(values.k), asOf: values['as-of'] });
    console.log(formatResults(results, { json: values.json }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    db.close();
  }
}
```

`/Users/timo/Documents/ha/android/.github/knowledge-bot.yaml`:

```yaml
# Knowledge bot configuration. Schema: https://github.com/home-assistant/auto-triage/tree/main/schemas
version: 1

product:
  name: Home Assistant Companion for Android
  slug: android

providers:
  github:
    home-assistant/android:
      issues:
        states: [open, closed]
        closedWithinDays: 730
        comments: true
    home-assistant/companion.home-assistant:
      docs:
        path: docs
        baseUrl: https://companion.home-assistant.io/docs/
    home-assistant/contributors.home-assistant.io:
      docs:
        path: src/content/docs/companion
        baseUrl: https://contributors.home-assistant.io/companion/
        audience: developer

embedding:
  model: Xenova/bge-small-en-v1.5
  revision: <commit printed by git ls-remote in Task 6 step 5>
  dtype: q8
  dimensions: 384
  pooling: cls
```

README usage section, appended to `README.md`:

```markdown
## Build and query an index locally

    cd bot-scripts
    GITHUB_TOKEN=$(gh auth token) npm run build-index -- \
      --config ../../android/.github/knowledge-bot.yaml \
      --out ./knowledge-android.sqlite \
      --checkout home-assistant/companion.home-assistant=../../companion.home-assistant \
      --checkout home-assistant/contributors.home-assistant.io=../../contributors.home-assistant.io

    npm run query -- --config ../../android/.github/knowledge-bot.yaml \
      --index ./knowledge-android.sqlite "widget stops updating after reboot"

The first run downloads the embedding model (about 35 MB) into `.model-cache/`.
Pass `--previous <older index>` to reuse vectors of unchanged chunks.
```

- [ ] **Step 4: Run the unit tests, then the real build and a real query**

Run: `cd bot-scripts && node --test`
Expected: PASS, every test in the suite.

Then run the build command from the README with the real token and checkouts, and the query with these three questions, recording the top three results of each in the hand-over note:

1. `widget stops updating after reboot`
2. `notification with image not showing`
3. `how do I set up the E2E tests`

Expected: the first two return android issues and companion docs pages, the third returns contributor docs pages. `best similarity` well above 0.35 for all three. If a query returns mostly comment chunks of unrelated issues, lower `candidates` or adjust `sourceWeights` in a follow-up; do not tune inside this task.

- [ ] **Step 5: Hand over for commit**

Files to stage in `auto-triage`: `bot-scripts/src/cli/query.js`, `bot-scripts/test/cli/query.test.js`, `README.md`. Suggested message: `Add query CLI and local build instructions`. In the android repository: `.github/knowledge-bot.yaml` on a branch, suggested message `Add knowledge bot configuration`. Also `bot-scripts/.gitignore` already covers the generated index and the model cache; check `git status` shows neither.

---

## Self-review

**Spec coverage for this plan's scope.** Section 3.1 layout: `bot-scripts/` and `schemas/` created (Tasks 1, 3); `actions/`, `.github/workflows/` builders and `workflows/` templates belong to plan 1c. Section 4 config: Tasks 3 and 13, with `pulls`, `discussions`, `code`, `files`, `discourse` schemas deferred to plan 1b and `peers` accepted but unused. Section 5.1 sources: docs and issues here, the rest in 1b; cleaning and the `logs` column in Task 5; windows in Task 8; audience in Tasks 8 and 9. Section 5.2 model: Task 6 with the bake-off in 1d. Section 5.3 format: Tasks 2 and 10, including the atomic build and `meta`. Section 5.4: the nightly and on-close workflows are plan 1c; the hash-based reuse they need is Task 10. Section 6 retrieval: Task 12, with the live forum list accepted through `liveLists` and produced in 1b. Section 11 local use: the query CLI is Task 13; the artifact download, MCP server and skill are phase 4.

**Placeholders.** The only placeholder is the model `revision` in the android config, filled from the `git ls-remote` output in Task 6 step 5.

**Type consistency.** `IndexItem` and `IndexChunk` are defined once in Task 8 (`providers/types.js`) and consumed by Tasks 9, 10, 11. `Embedder` is defined in Task 6 and consumed by Tasks 10, 12, 13. `openDatabase`, `createSchema`, `readMeta` names match across Tasks 2, 10, 12, 13. The vec0 BigInt rule is applied in Tasks 2, 10 (`BigInt(lastInsertRowid)`) and 12 (`BigInt(candidates * 4)`).

**Review Focus coverage.** Item 1 is Task 10 `skips chunks with empty text`; item 2 is Task 8 `drops pull requests`; item 3 is Task 9 `absolute slug overrides path`; item 4 is Task 10 `does not reuse vectors from another model`; item 5 is Task 12 `question without indexable tokens still returns dense results`.
