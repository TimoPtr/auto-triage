import { DatabaseSync } from 'node:sqlite';
import { renameSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

export const RAW_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS raw_items (
  provider   TEXT NOT NULL,
  origin     TEXT NOT NULL,
  kind       TEXT NOT NULL,   -- issue | pull | discussion | release | topic
  id         TEXT NOT NULL,
  updated_at TEXT,            -- the source's own change marker; equal means the payload is current
  fetched_at TEXT NOT NULL,
  payload    BLOB NOT NULL,   -- gzip JSON exactly as fetched
  PRIMARY KEY (provider, origin, kind, id)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta (key, value) VALUES ('raw_schema_version', '${RAW_SCHEMA_VERSION}');
`;

export interface RawRecord<T = unknown> {
  provider: string;
  origin: string;
  kind: string;
  id: string;
  updatedAt: string | null;
  payload: T;
}

/**
 * Fetched source payloads, kept next to the index: the benchmark mines its
 * ground truth from them, and a rebuild skips the requests of unchanged items.
 */
export interface RawStore {
  get<T = unknown>(provider: string, origin: string, kind: string, id: string): RawRecord<T> | null;
  put(record: RawRecord): void;
  each<T = unknown>(provider: string, origin: string, kind: string): Iterable<RawRecord<T>>;
  count(): number;
  close(): void;
}

interface Row { provider: string; origin: string; kind: string; id: string; updated_at: string | null; payload: Uint8Array }

function toRecord<T>(row: Row): RawRecord<T> {
  return {
    provider: row.provider, origin: row.origin, kind: row.kind, id: row.id, updatedAt: row.updated_at,
    payload: JSON.parse(gunzipSync(row.payload).toString('utf8')) as T,
  };
}

export interface OpenRawStoreOptions {
  /** Move a store with another schema version aside (`<path>.schema-v<n>`) and start fresh instead of throwing. */
  recreateOnMismatch?: boolean;
  log?: (line: string) => void;
}

/** The schema version recorded in a raw store file, after creating the tables when absent. */
function schemaVersionOf(db: DatabaseSync): string {
  db.exec(SCHEMA);
  return (db.prepare("SELECT value FROM meta WHERE key = 'raw_schema_version'").get() as { value: string }).value;
}

/** Opens a raw store file, creating it when absent. */
export function openRawStore(path: string, { recreateOnMismatch = false, log = () => {} }: OpenRawStoreOptions = {}): RawStore {
  let db = new DatabaseSync(path);
  let version = schemaVersionOf(db);
  if (version !== String(RAW_SCHEMA_VERSION)) {
    db.close();
    if (!recreateOnMismatch) throw new Error(`raw store schema ${version} at ${path} is not the supported ${RAW_SCHEMA_VERSION}`);
    const aside = `${path}.schema-v${version}`;
    renameSync(path, aside);
    log(`raw store schema ${version} at ${path} is not the supported ${RAW_SCHEMA_VERSION}; moved to ${aside} and starting fresh`);
    db = new DatabaseSync(path);
    version = schemaVersionOf(db);
  }
  const columns = 'provider, origin, kind, id, updated_at, payload';
  const select = db.prepare(`SELECT ${columns} FROM raw_items WHERE provider = ? AND origin = ? AND kind = ? AND id = ?`);
  const upsert = db.prepare(`INSERT INTO raw_items (provider, origin, kind, id, updated_at, fetched_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (provider, origin, kind, id) DO UPDATE SET updated_at = excluded.updated_at, fetched_at = excluded.fetched_at, payload = excluded.payload`);
  const list = db.prepare(`SELECT ${columns} FROM raw_items WHERE provider = ? AND origin = ? AND kind = ? ORDER BY id`);
  const total = db.prepare('SELECT count(*) AS n FROM raw_items');
  return {
    get<T>(provider: string, origin: string, kind: string, id: string) {
      const row = select.get(provider, origin, kind, id) as unknown as Row | undefined;
      return row ? toRecord<T>(row) : null;
    },
    put({ provider, origin, kind, id, updatedAt, payload }) {
      upsert.run(provider, origin, kind, id, updatedAt, new Date().toISOString(), gzipSync(Buffer.from(JSON.stringify(payload))));
    },
    *each<T>(provider: string, origin: string, kind: string) {
      for (const row of list.iterate(provider, origin, kind)) yield toRecord<T>(row as unknown as Row);
    },
    count() {
      return Number((total.get() as { n: number }).n);
    },
    close() {
      db.close();
    },
  };
}
