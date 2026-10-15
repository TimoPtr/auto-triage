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
