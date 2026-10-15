import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as sqliteVec from 'sqlite-vec';

export const SCHEMA_VERSION = 2;
export const FORMAT_VERSION = 1;

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));

/**
 * Opens the index database with sqlite-vec loaded. Extension loading is
 * switched off again right after, so SQL from the index can never load code.
 */
export function openDatabase(path: string, { readOnly = false }: { readOnly?: boolean } = {}): DatabaseSync {
  const db = new DatabaseSync(path, { allowExtension: true, readOnly });
  db.enableLoadExtension(true);
  db.loadExtension(sqliteVec.getLoadablePath());
  db.enableLoadExtension(false);
  return db;
}

/** Applies the schema to a fresh database and records the versions in meta. */
export function createSchema(db: DatabaseSync, { dimensions }: { dimensions: number }): void {
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

/** Reads the whole meta table as an object. */
export function readMeta(db: DatabaseSync): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
